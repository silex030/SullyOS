/**
 * 自主生活 v1 · 单用户运行期装配（D1 端口 + 引擎 + 服务层）。
 *
 * 这里是「定义」和「真的跑起来」之间唯一的一层：
 *   - worker 路由每次请求按 ownerId 装配一次（短生命周期，不缓存用户数据）；
 *   - cron 调度每个角色装配一次（模型端口换成真实调用）；
 *   - 测试直接调它，验证「同一份策略在 D1 上也是同一结果」。
 *
 * 归属校验：ownerId 由调用方从会话派生后传入，本文件所有读写都只经 owner-scoped
 * 的 store/boundary/budget；charId 永远来自路径/动作行，不来自请求体里的 owner 概念。
 */

import type { ActivityKind, EffectiveBoundaryV1 } from '../../../../contracts/autonomyLife';
import { mergeEffectiveBoundary, normalizeBoundary } from '../../../../utils/autonomyLife/boundary';
import type { BudgetPort } from '../../../../utils/autonomyLife/budget';
import {
  DEFAULT_POLICY_VERSION,
  emptyCharacterLife,
  type EngineDeps,
  type LifeStorePort,
  type ModelRequestPort,
} from '../../../../utils/autonomyLife/engine';
import { createAutonomyLifeService, type AutonomyLifeServiceDeps, type BoundaryRepo } from '../../../../utils/autonomyLife/service';
import { windowIdAt } from '../../../../utils/autonomyLife/budget';
import type { CapabilityProbeState } from '../../../../utils/autonomyLife/adapters';
import {
  createD1BoundaryRepo,
  createD1BudgetPort,
  createD1LifeStore,
  readBudgetRows,
  type LifeDb,
} from './store';

/** 引擎的默认种子在没有账号行时使用；账号行里有持久化种子就用它。 */
const fallbackSeed = (userId: string): string => `seed_${userId}`;

/**
 * 账号层默认边界：**默认关闭**。新建用户不会因为「装了 App」就被自动安排生活，
 * 必须自己打开总开关；角色层默认全 null（继承账号层），不额外授权任何 kind。
 */
export function defaultAccountBoundary(nowMs: number, timezone: string) {
  return normalizeBoundary(
    {
      enabled: false,
      globalPaused: false,
      timezone,
      allowedKinds: [],
      forbiddenCategories: [],
      avoidTopics: [],
      allowFictionalNpc: false,
      doNotDisturb: null,
      limits: {},
      externalGrants: [],
    },
    { scope: 'account', nowMs, revision: 0 },
  );
}

/** 角色层默认边界：全 null（继承账号层），只为「这个角色参与调度」留一行。 */
export function defaultCharacterBoundary(nowMs: number) {
  return normalizeBoundary({}, { scope: 'character', nowMs, revision: 0 });
}

export interface RuntimeOptions {
  db: LifeDb;
  userId: string;
  charId: string;
  now: () => number;
  /** 真实模型端口（cron 装配）；缺省 = 没有凭据，tick 会按模型失败退避。 */
  model?: ModelRequestPort | null;
  /** 能力探测（路由层据设备绑定/凭据给值）。 */
  probes?: CapabilityProbeState;
  /** 角色时区（用于预算窗口与提示词）；缺省取账号边界时区。 */
  timezone?: string;
  requestId?: () => string;
}

export interface AutonomyLifeRuntime {
  store: ReturnType<typeof createD1LifeStore>;
  budget: BudgetPort;
  boundaries: BoundaryRepo;
  engine: EngineDeps;
  service: ReturnType<typeof createAutonomyLifeService>;
  /** 生效边界（现读）。 */
  boundaryFor(charId: string): Promise<EffectiveBoundaryV1>;
}

export function createAutonomyLifeRuntime(options: RuntimeOptions): AutonomyLifeRuntime {
  const { db, userId, charId } = options;
  const now = options.now;
  const timezone = options.timezone ?? 'UTC';
  const store = createD1LifeStore({ db, ownerId: userId, now });
  const budget = createD1BudgetPort({ db, ownerId: userId });
  const boundaries = createD1BoundaryRepo({
    db,
    ownerId: userId,
    defaultBoundary: defaultAccountBoundary(now(), timezone),
  });

  const boundaryFor = async (targetCharId: string): Promise<EffectiveBoundaryV1> => {
    const account = await boundaries.getAccount();
    const character = await boundaries.getCharacter(targetCharId);
    const merged = mergeEffectiveBoundary({ account, character, charId: targetCharId, nowMs: now() });
    /*
     * 真实暂停的权威来源是 `/pause` 写入的两处：`autonomy_life_accounts.paused` 与
     * `autonomy_life_characters.payload.pauseRequestedAt`。它们**不写** boundaries，
     * 所以只 merge 边界会得到「没暂停」。整条链路（引擎 tick 的候选生成、路由侧的
     * 当前边界预检、旧 AIRP / 出行闸）都走这里，暂停才能只有一个口径。
     */
    const [pause, life] = await Promise.all([
      store.getAccountPause(userId),
      store.getCharacterLife(targetCharId),
    ]);
    const realPause = pause.paused || life?.pauseRequestedAt != null;
    return realPause ? { ...merged, globalPaused: true } : merged;
  };

  const probes: CapabilityProbeState = options.probes ?? {
    localStoresReady: false,
    deviceBound: false,
    hasModelCredentials: false,
    externalRead: { configured: false, reachable: false },
    map: { configured: false, reachable: false },
  };

  const engine: EngineDeps = {
    store: store as LifeStorePort,
    budget,
    // 没有模型端口时返回 null（引擎按模型失败退避），绝不退回「本地随便挑」。
    model: options.model ?? { request: async () => null },
    seed: fallbackSeed(userId),
    clock: { now },
    accountId: userId,
    deviceOnline: async (installationId) => {
      if (!installationId) return false;
      const bound = await store.getBoundInstallation(userId);
      return bound === installationId;
    },
    probes: async () => probes,
    boundaryFor,
    policyVersion: DEFAULT_POLICY_VERSION,
  };

  const serviceDeps: AutonomyLifeServiceDeps = {
    engine,
    store: store as LifeStorePort,
    budget,
    boundaries,
    probes: async () => probes,
    budgetRows: async (targetCharId, nowMs) => {
      const effective = await boundaryFor(targetCharId);
      const windowId = windowIdAt({ now: () => nowMs }, effective.timezone ?? timezone);
      return readBudgetRows({ db, ownerId: userId, charId: targetCharId, windowId });
    },
    now,
    requestId: options.requestId ?? (() => `al_${Math.random().toString(36).slice(2, 10)}`),
  };

  const service = createAutonomyLifeService(serviceDeps);

  return {
    store: store as ReturnType<typeof createD1LifeStore>,
    budget,
    boundaries,
    engine,
    service,
    boundaryFor,
  };
}

/**
 * 引擎 tick 前的角色状态需要一行「存在」的 life（否则每次 tick 都从空状态重新抽样，
 * 虽然确定性 seed 会兜住，但活动指针/待办计数会丢）。角色行不存在时先建一行空状态。
 */
export async function ensureCharacterLife(
  runtime: AutonomyLifeRuntime,
  charId: string,
  nowMs: number,
  timezone: string,
): Promise<void> {
  const existing = await runtime.store.getCharacterLife(charId);
  if (existing) return;
  await runtime.store.putCharacterLife(emptyCharacterLife(charId, nowMs, timezone), 0);
}

export type { ActivityKind };
