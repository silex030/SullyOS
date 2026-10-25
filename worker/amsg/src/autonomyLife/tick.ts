/**
 * 自主生活 v1 · cron 调度（每分钟一跳）
 *
 * 与既有 AIRP 自主回合的区别（刻意不同）：
 *   - **不建上游任务、不发推送**：这里只推进状态机，到点产生一个「可领取的动作」；
 *     真正的副作用要等绑定设备上线后 claim + commit-permit + 本地事务 + 回执，
 *     云端永远不声称「已经做了」；
 *   - 每跳先看边界：账号总开关/暂停/角色暂停/窗口白名单不过 → 这条角色整跳不调模型
 *     （engine.tickCharacter 内部也会再判一次，两处都 fail closed）；
 *   - 模型凭据走**用户自己的** `llm_credentials`（`char:<charId>/chat`），没凭据就
 *     skip `missing_credentials`，不用 worker 级 env 冒充；
 *   - 角色是否参与调度由「客户端打开过该角色的自主生活」决定（首次读状态会登记一行
 *     角色边界）；没登记就不 tick —— 不替用户给全部角色开生活。
 *
 * 本卡整改后新增的三条**真实信号**（都不改变上面的硬门）：
 *   1. 人设/日程：fire_pack 模板 + **当天**日程（scene）→ RhythmProfile（改了才重建）；
 *   2. 真实目录候选：绑定设备经 `/proposals` 上报的外卖/购物（真实店/商品/单价/地址）；
 *   3. 外部能力：按 `AUTONOMY_EXTERNAL_*` 配置 + 用户授权 + 有限期可达性探测给能力值，
 *      不再写死 false。
 */

import type { ActivityKind, ExternalGrant } from '../../../../contracts/autonomyLife';
import { tickCharacter } from '../../../../utils/autonomyLife/engine';
import { localDateKey } from '../../../../utils/autonomyLife/time';
import { scheduleTextFromScene, sleepWindowFromScene } from '../../../../utils/autonomyLife/personaSignal';
import type { CapabilityProbeState } from '../../../../utils/autonomyLife/adapters';
import { createAutonomyLifeModelPort, isUsableLifeCredentials, type LifeModelCredentials } from './model';
import { ensureCharacterLife, createAutonomyLifeRuntime } from './runtime';
import type { AutonomyTickPack } from '../autonomyScheduler';
import { resolveTravelModelCredentialsForUser } from '../travel/credentials';
import { changesOf, ensureAutonomyLifeSchema, type LifeDb } from './store';
import {
  listClientProposals,
  deleteClientProposals,
  proposalToCandidate,
} from './proposals';
import {
  authorizeProbe,
  externalConfigFromInput,
  isEndpointConfigured,
  defaultReachabilityProbe,
  type ExternalConfigInput,
  type ExternalRuntimeConfig,
  type ReachabilityProbe,
} from './capabilityProbes';

/** 每次 tick 最多推进多少个角色（防止某次 cron 超时拖垮整轮）。 */
export const AUTONOMY_LIFE_MAX_SUBJECTS_PER_TICK = 12;

export interface AutonomyLifeScheduledInput {
  db: LifeDb;
  packs: readonly AutonomyTickPack[];
  nowMs: number;
  masterKey?: string | null;
  fetch?: typeof globalThis.fetch;
  /** 测试注入：替换凭据解析（生产走 per-user llm_credentials）。 */
  credentialsFor?: (userId: string, charId: string) => Promise<LifeModelCredentials | null>;
  /** 外部窗口的真实配置（运营端点 + 出口白名单）；缺省 = 未配置。 */
  external?: ExternalConfigInput | ExternalRuntimeConfig | null;
  /** 测试注入：外部端点可达性探测；缺省为带 10 分钟缓存的真实 HTTP 探测。 */
  reachability?: ReachabilityProbe;
}

export type AutonomyLifeTickOutcome =
  | { charId: string; status: 'ticked'; tick: Awaited<ReturnType<typeof tickCharacter>>['status'] }
  | { charId: string; status: 'skipped'; reason: 'not_registered' | 'account_disabled' | 'char_disabled' | 'missing_credentials' };

export async function handleAutonomyLifeScheduled(
  input: AutonomyLifeScheduledInput,
): Promise<{ outcomes: AutonomyLifeTickOutcome[] }> {
  const { db, packs, nowMs } = input;
  await ensureAutonomyLifeSchema(db);
  const outcomes: AutonomyLifeTickOutcome[] = [];

  const credentialsFor = input.credentialsFor ?? ((userId: string, charId: string) =>
    resolveTravelModelCredentialsForUser({
      db: db as never,
      userId,
      charId,
      masterKey: input.masterKey,
    }));

  const externalConfig = externalConfigFromInput(input.external ?? null);
  const reachability = input.reachability ?? defaultReachabilityProbe;

  for (const pack of packs.slice(0, AUTONOMY_LIFE_MAX_SUBJECTS_PER_TICK)) {
    const { userId, charId } = pack;
    // 参与调度 = 有过角色边界行（客户端读过该角色的自主生活）。
    const registered = await db
      .prepare("SELECT 1 AS ok FROM autonomy_life_boundaries WHERE owner_id = ? AND scope = 'character' AND char_id = ?")
      .bind(userId, charId)
      .first()
      .catch(() => null);
    if (!registered) {
      outcomes.push({ charId, status: 'skipped', reason: 'not_registered' });
      continue;
    }

    const timezone = typeof pack.pack?.tzId === 'string' && pack.pack.tzId.trim() ? pack.pack.tzId : 'UTC';

    // 人设/日程（真实信号）：模板 = 角色设定；scene = **当天**日程（跨天整段不用）。
    // 睡眠窗从 slots 结构化推导（普通上班/起床/午休不会被当成整夜睡眠）。
    const persona = {
      personaText: typeof pack.pack?.template === 'string' ? pack.pack.template : '',
      scheduleText: scheduleTextFromScene(pack.pack?.scene ?? null, localDateKey(nowMs, timezone)),
      city: typeof pack.pack?.scene?.charCity === 'string' ? pack.pack.scene.charCity : '',
      sleepWindow: sleepWindowFromScene(pack.pack?.scene ?? null, localDateKey(nowMs, timezone)),
    };

    const baseRuntime = createAutonomyLifeRuntime({
      db,
      userId,
      charId,
      now: () => nowMs,
      timezone,
      persona,
      probes: emptyProbes(),
    });

    // 边界门：账号总开关 / 暂停 / 角色开关任一关着就不发模型请求。
    // 用 runtime.boundaryFor 而不是在这里自己 merge：真实暂停（`POST /pause` 写的
    // accounts.paused / characters.pauseRequestedAt）不在 boundaries 里，必须走统一读法，
    // 否则「用户按了暂停，cron 仍拿 allowedKinds 去建模型端口」。
    const effective = await baseRuntime.boundaryFor(charId);
    if (!effective.enabled || effective.globalPaused) {
      outcomes.push({ charId, status: 'skipped', reason: 'account_disabled' });
      continue;
    }
    if (!effective.charEnabled) {
      outcomes.push({ charId, status: 'skipped', reason: 'char_disabled' });
      continue;
    }

    const credentials = await credentialsFor(userId, charId).catch(() => null);
    if (!isUsableLifeCredentials(credentials)) {
      outcomes.push({ charId, status: 'skipped', reason: 'missing_credentials' });
      continue;
    }

    const boundInstallation = await baseRuntime.store.getBoundInstallation(userId).catch(() => null);
    const probes = await resolveProbes({
      external: externalConfig,
      grants: effective.externalGrants,
      allowedKinds: effective.allowedKinds,
      nowMs,
      deviceBound: !!boundInstallation,
      // 暂停是硬门：暂停中一个外部探测都不发（即便调用方已判过，这里再显式传一次）。
      // 账号关闭/角色关闭在更上面已经 continue，这里只剩暂停这一种「停」。
      paused: effective.globalPaused,
      reachability,
    });

    const model = createAutonomyLifeModelPort({
      credentials,
      persona: persona.personaText,
      charName: pack.charName,
      allowedKinds: effective.allowedKinds as ActivityKind[],
      timezone,
      nowMs,
      fetch: input.fetch,
    });

    const withModel = createAutonomyLifeRuntime({
      db,
      userId,
      charId,
      now: () => nowMs,
      timezone,
      model,
      persona,
      probes,
      localCandidates: async (targetCharId: string) => {
        const rows = await listClientProposals({ db, ownerId: userId, charId: targetCharId, nowMs });
        return rows.map(proposalToCandidate);
      },
      consumeLocalCandidates: async (targetCharId: string, kind: string) => {
        await deleteClientProposals({ db, ownerId: userId, charId: targetCharId, kind });
      },
    });

    await ensureCharacterLife(withModel, charId, nowMs, timezone);
    const tick = await tickCharacter(withModel.engine, charId);
    outcomes.push({ charId, status: 'ticked', tick: tick.status });
  }

  return { outcomes };
}

function emptyProbes(): CapabilityProbeState {
  return {
    localStoresReady: false,
    deviceBound: false,
    hasModelCredentials: false,
    externalRead: { configured: false, reachable: false },
    map: { configured: false, reachable: false },
  };
}

/**
 * 真实能力值 = 配置（端点 + 运营白名单）∧ 授权（用户 grant 的主机/scope/有效期）∧ 可达性探测。
 *
 * 关键：**探测前先过 authorizeProbe**——与正式 `/external/read` 同一套主机/scope/暂停边界。
 * 任何一项不成立就一个网络请求都不发（不是「先探一下再说」）；显式传 paused，避免依赖调用方
 * 已经判过暂停这件事。探测本身是有界健康检查（见 capabilityProbes 的调用上限说明），
 * 不消耗外部读取额度，也不写入任何内容。
 */
export async function resolveProbes(args: {
  external: ExternalRuntimeConfig;
  grants: readonly ExternalGrant[];
  allowedKinds: readonly string[];
  nowMs: number;
  deviceBound: boolean;
  /** 当前生效的暂停状态（账号总暂停/角色暂停）；true = 一个探测都不做。 */
  paused?: boolean;
  reachability: ReachabilityProbe;
}): Promise<CapabilityProbeState> {
  const { external, grants, allowedKinds, nowMs, deviceBound, reachability } = args;
  const paused = args.paused === true;
  const externalConfigured = isEndpointConfigured(external.xhsUrl, external.readHosts);
  const mapConfigured = isEndpointConfigured(external.amapUrl, external.readHosts);

  const xhsGrant = grants.find((grant) => grant.provider === 'xhs');
  const amapGrant = grants.find((grant) => grant.provider === 'amap');

  const externalAuth = authorizeProbe({
    endpoint: external.xhsUrl,
    readHosts: external.readHosts,
    grant: xhsGrant,
    provider: 'xhs',
    mode: 'read',
    kind: 'external.read',
    allowedKinds,
    paused,
    nowMs,
  });
  const mapAuth = authorizeProbe({
    endpoint: external.amapUrl,
    readHosts: external.readHosts,
    grant: amapGrant,
    provider: 'amap',
    mode: 'read',
    kind: 'travel.wish',
    allowedKinds,
    paused,
    nowMs,
  });

  const externalReachable = externalAuth.ok
    ? await reachability(externalAuth.url, externalAuth.signature).catch(() => false)
    : false;
  const mapReachable = mapAuth.ok
    ? await reachability(mapAuth.url, mapAuth.signature).catch(() => false)
    : false;

  return {
    localStoresReady: true,
    deviceBound,
    hasModelCredentials: true,
    externalRead: {
      configured: externalConfigured,
      reachable: externalReachable,
      ...(externalAuth.ok || !externalConfigured ? {} : { reason: externalAuth.reason }),
    },
    map: {
      configured: mapConfigured,
      reachable: mapReachable,
      ...(mapAuth.ok || !mapConfigured ? {} : { reason: mapAuth.reason }),
    },
  };
}

/** 供调度日志：这一跳真的产生动作了吗（不打印每一条 skipped，避免每分钟刷屏）。 */
export function summariseAutonomyLifeOutcomes(outcomes: readonly AutonomyLifeTickOutcome[]) {
  return {
    ticked: outcomes.filter((item) => item.status === 'ticked').length,
    scheduled: outcomes.filter((item) => item.status === 'ticked' && item.tick === 'scheduled').length,
    skipped: outcomes.filter((item) => item.status === 'skipped')
      .map((item) => ({ charId: item.charId, reason: (item as { reason: string }).reason })),
  };
}

/** 供 index.ts 的「本轮是否被认领」判定复用（与 AIRP 的 claim-first 同一手法）。 */
export { changesOf };
