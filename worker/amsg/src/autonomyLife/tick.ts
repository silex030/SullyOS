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
 */

import type { ActivityKind } from '../../../../contracts/autonomyLife';
import { mergeEffectiveBoundary } from '../../../../utils/autonomyLife/boundary';
import { tickCharacter } from '../../../../utils/autonomyLife/engine';
import { createAutonomyLifeModelPort, isUsableLifeCredentials } from './model';
import { ensureCharacterLife, createAutonomyLifeRuntime } from './runtime';
import type { AutonomyTickPack } from '../autonomyScheduler';
import { resolveTravelModelCredentialsForUser } from '../travel/credentials';
import { changesOf, ensureAutonomyLifeSchema, type LifeDb } from './store';

/** 每次 tick 最多推进多少个角色（防止某次 cron 超时拖垮整轮）。 */
export const AUTONOMY_LIFE_MAX_SUBJECTS_PER_TICK = 12;

export interface AutonomyLifeScheduledInput {
  db: LifeDb;
  packs: readonly AutonomyTickPack[];
  nowMs: number;
  masterKey?: string | null;
  fetch?: typeof globalThis.fetch;
  /** 测试注入：替换凭据解析（生产走 per-user llm_credentials）。 */
  credentialsFor?: (userId: string, charId: string) => Promise<{ baseUrl: string; apiKey: string; model: string } | null>;
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
    const runtime = createAutonomyLifeRuntime({
      db,
      userId,
      charId,
      now: () => nowMs,
      timezone,
      probes: {
        localStoresReady: true,
        deviceBound: true,
        hasModelCredentials: true,
        externalRead: { configured: false, reachable: false },
        map: { configured: false, reachable: false },
      },
    });

    // 边界门：账号总开关 / 暂停 / 角色开关任一关着就不发模型请求。
    const account = await runtime.boundaries.getAccount();
    const effective = mergeEffectiveBoundary({
      account,
      character: await runtime.boundaries.getCharacter(charId),
      charId,
      nowMs,
    });
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

    const model = createAutonomyLifeModelPort({
      credentials,
      persona: pack.pack?.template,
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
      probes: {
        localStoresReady: true,
        deviceBound: true,
        hasModelCredentials: true,
        externalRead: { configured: false, reachable: false },
        map: { configured: false, reachable: false },
      },
    });

    await ensureCharacterLife(withModel, charId, nowMs, timezone);
    const tick = await tickCharacter(withModel.engine, charId);
    outcomes.push({ charId, status: 'ticked', tick: tick.status });
  }

  return { outcomes };
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
