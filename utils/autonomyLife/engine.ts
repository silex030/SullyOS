/**
 * 自主生活执行引擎：确定性调度 + 动作状态机 + 暂停/恢复 + 失败退避 + 预算门。
 *
 * 关键约束（契约 §3.3–§3.4、§4.2、§10）：
 *   1. 一次 tick 只推进**到期**的状态；未到期时模型调用数必须为 0（budget 不动）。
 *   2. 所有模型请求逐次过统一预算门；预算存储不可用 → fail closed，不发请求。
 *   3. 连续失败退避 30min → 2h → 8h，三次进 circuit_open；用户恢复或服务自检恢复只探测一次。
 *   4. 暂停返回 acknowledged（不再发新许可）/ quiesced（在途许可已全部完成或失效并已对账）；
 *      在途已获许可的本地事务可能先完成——不承诺撤销既成事实。
 *   5. 本地副作用只有拿到回执才算 succeeded；没有设备在线 → waiting_device。
 *   6. 重启读既有机会，不重新抽样、不重置额度；过期租约先对账，不直接重执行。
 *   7. 同类去重：同角色同一本地日同一 semanticPurpose 只产生一个主动动作。
 *
 * 存储端口与预算端口都由调用方注入：worker 用 D1，测试用内存实现（本文件尾部）。
 */

import {
  actionDedupeKey,
  hashArgs,
  isTerminalActionStatus,
  type ActivityKind,
  type ActivityRecord,
  type ActionSource,
  type ActionStatus,
  type AutonomyLifeErrorCode,
  type Capability,
  type CharacterLifeState,
  type EffectiveBoundaryV1,
  type LifeEvent,
  type LifePhase,
  type LifeReasonCode,
} from '../../contracts/autonomyLife';
import { describeCapabilities, type CapabilityProbeState } from './adapters';
import { checkIntentPolicy } from './policy';
import {
  projectBudgetUsage,
  reserveBudget,
  settleBudget,
  type BudgetGrant,
  type BudgetPort,
} from './budget';
import {
  alreadyProducedToday,
  applyActivitySuccess,
  buildRhythmProfile,
  chooseActivity,
  DEFAULT_MIN_GAP_MS,
  fingerprintOf,
  isProfileStale,
  MODEL_REQUEST_MIN_GAP_MS,
  needsAreLow,
  planNextOpportunity,
  resolvePhase,
  updateNeeds,
  withinKindCooldown,
  type Candidate,
  type NeedVector,
  type RecentActivity,
  type RhythmProfile,
} from './rhythm';
import { DAY_MS, HOUR_MS, createRng, localDateKey, systemClock, type Clock } from './time';

// ─── 存储行 ─────────────────────────────────────────────────────────────────

export interface CharacterLifeRow {
  charId: string;
  revision: number;
  lifePhase: LifePhase;
  availability: CharacterLifeState['availability'];
  reasonCodes: LifeReasonCode[];
  nextOpportunityAt: number | null;
  nextCheckAt: number | null;
  scheduleConfidence: 'fallback' | 'persona';
  activeActionId: string | null;
  pendingCount: number;
  budgetWindowId: string | null;
  /** 窗口开启时记录的时区：时区改了也不刷新已有窗口额度。 */
  windowTimezone: string;
  needs: NeedVector;
  lastEvaluatedAt: number;
  lastModelCallAt: number;
  lastGrantedAt: number;
  failStreak: number;
  circuitOpenedAt: number | null;
  /** 连续失败退避的下一次允许时间。 */
  retryAt: number | null;
  opportunityId: string | null;
  profile: RhythmProfile | null;
  /** 暂停请求（客户端可先本地停再请求云端）。 */
  pauseRequestedAt: number | null;
  lastInteractionAt: number;
  rngSeedVersion: number;
}

export interface ActionRow {
  id: string;
  charId: string;
  kind: ActivityKind;
  windowId: string;
  executionMode: 'cloud' | 'local';
  scope: 'os_simulation' | 'external_read';
  source: ActionSource;
  sourceRef: string | null;
  purposeKey: string;
  /** 语义目的原文（同日去重用；与 purposeKey 哈希一一对应，便于人读与对账）。 */
  semanticPurpose: string;
  args: Record<string, unknown>;
  argsHash: string;
  basis: 'virtual' | 'inference';
  reasonSummary: string;
  createdAt: number;
  notBefore: number;
  expiresAt: number;
  status: ActionStatus;
  revision: number;
  policyVersion: string;
  dedupeKey: string;
  reservationId: string | null;
  installationId: string | null;
  resultRef: string | null;
  errorCode: AutonomyLifeErrorCode | null;
  /** 执行许可与租约 */
  leaseEpoch: number;
  leaseExpiresAt: number | null;
  permitIssuedAt: number | null;
  notified: boolean;
}

export interface LifeStorePort {
  getCharacterLife(charId: string): Promise<CharacterLifeRow | null>;
  putCharacterLife(row: CharacterLifeRow, expectedRevision: number): Promise<boolean>;
  getAction(actionId: string): Promise<ActionRow | null>;
  insertAction(row: ActionRow): Promise<boolean>;
  putAction(row: ActionRow, expectedRevision: number): Promise<boolean>;
  /** 已到期可领取的动作（status=scheduled/waiting_device 且 notBefore<=now）。 */
  dueActions(charId: string, nowMs: number, limit: number): Promise<ActionRow[]>;
  /**
   * 活动记录分页（§7 GET /activities）：按 occurredAt+id 稳定降序。
   * cursor 是不透明串（实现方决定编码），null 表示到头。
   */
  listActions?(args: {
    charId: string;
    status: string | null;
    limit: number;
    cursor: string | null;
  }): Promise<{ items: ActionRow[]; nextCursor: string | null }>;
  recentActivities(charId: string, sinceMs: number): Promise<RecentActivity[]>;
  appendEvent(event: LifeEvent): Promise<void>;
  /** 账号级暂停（含 quiesce 判定用的在途许可计数）。 */
  getAccountPause(accountId: string): Promise<{ paused: boolean; requestedAt: number | null }>;
  setAccountPause(accountId: string, paused: boolean, nowMs: number): Promise<void>;
  inflightPermits(accountId: string, nowMs: number): Promise<number>;
  /** 执行设备绑定：一个账号一个 installationId。 */
  getBoundInstallation(accountId: string): Promise<string | null>;
  bindInstallation(accountId: string, installationId: string, nowMs: number): Promise<boolean>;
}

export const DEFAULT_POLICY_VERSION = 'autonomy-life-v1';

export function emptyCharacterLife(charId: string, nowMs: number, windowTimezone: string): CharacterLifeRow {
  return {
    charId,
    revision: 0,
    lifePhase: 'idle',
    availability: 'ready',
    reasonCodes: [],
    nextOpportunityAt: null,
    nextCheckAt: null,
    scheduleConfidence: 'fallback',
    activeActionId: null,
    pendingCount: 0,
    budgetWindowId: null,
    windowTimezone,
    needs: { social: 0.3, record: 0.3, tidy: 0.25, food: 0.2, interest: 0.3 },
    lastEvaluatedAt: nowMs,
    lastModelCallAt: 0,
    lastGrantedAt: 0,
    failStreak: 0,
    circuitOpenedAt: null,
    retryAt: null,
    opportunityId: null,
    profile: null,
    pauseRequestedAt: null,
    lastInteractionAt: 0,
    rngSeedVersion: 0,
  };
}

// ─── 引擎依赖 ───────────────────────────────────────────────────────────────

export interface ModelProposal {
  candidates: Candidate[];
  tokensUsed?: number | null;
  usageUnknown?: boolean;
}

export interface ModelRequestPort {
  /**
   * 唯一受控模型出口：profile 提取、规划、生成、工具后总结都走这里（由调用方计费）。
   * 返回 null 表示模型失败（引擎负责退避/熔断）。
   */
  request(input: {
    charId: string;
    grant: BudgetGrant;
    kind: 'plan' | 'profile' | 'content';
    promptKey: string;
  }): Promise<ModelProposal | null>;
}

export interface EngineDeps {
  store: LifeStorePort;
  budget: BudgetPort;
  model: ModelRequestPort;
  /** 安装级种子（持久化）；随机源由它派生。 */
  seed: string;
  clock?: Clock;
  /** 每次模型调用的 token 预留上界（内部执行参数，不是用户频率设置）。 */
  reserveTokensPerRun?: number;
  /** 执行设备是否绑定 + 在线（本地副作用只能在绑定安装在线的设备上完成）。 */
  deviceOnline: (installationId: string | null) => Promise<boolean>;
  /** 能力探测（外部窗口默认关闭）。 */
  probes: (charId: string) => Promise<CapabilityProbeState>;
  /** 生效边界（账号层 + 角色层归并结果）。 */
  boundaryFor: (charId: string) => Promise<EffectiveBoundaryV1>;
  /** 允许的候选（由模型提议，引擎只做选择；测试可注入固定候选）。 */
  candidatesFor?: (charId: string) => Candidate[];
  policyVersion?: string;
  accountId?: string;
}

export const FAILURE_BACKOFF_MS = [30 * 60_000, 2 * HOUR_MS, 8 * HOUR_MS] as const;

export interface TickResult {
  charId: string;
  /** 本次 tick 实际发起的模型请求数（未到期必须为 0）。 */
  modelCalls: number;
  due: boolean;
  actionId: string | null;
  status: 'not_due' | 'paused' | 'no_candidate' | 'scheduled' | 'waiting_device' | 'budget_exhausted' | 'model_failed' | 'circuit_open' | 'resting' | 'skipped';
  reasonCodes: LifeReasonCode[];
  nextOpportunityAt: number | null;
  budgetDimension?: string;
}

const nextRevision = (row: CharacterLifeRow): CharacterLifeRow => ({ ...row, revision: row.revision + 1 });

function pauseCycleReason(circuitOpenedAt: number | null): LifeReasonCode[] {
  return circuitOpenedAt ? ['CIRCUIT_OPEN'] : [];
}

/**
 * 一次 tick。设计要点：
 *   - 未到期 → 直接返回 not_due，一条模型请求都不发；
 *   - 暂停 → paused（不发许可、不调模型）；
 *   - 熔断/退避未到 → circuit_open 且不发请求；
 *   - 需求太低 → resting，跳到下一阶段（不补「任务量」）。
 */
export async function tickCharacter(deps: EngineDeps, charId: string): Promise<TickResult> {
  const clock = deps.clock ?? systemClock;
  const nowMs = clock.now();
  const accountId = deps.accountId ?? 'account';
  const stored = await deps.store.getCharacterLife(charId);
  const boundaryRow = stored ?? emptyCharacterLife(charId, nowMs, 'UTC');
  const row = stored ?? boundaryRow;

  const accountPause = await deps.store.getAccountPause(accountId);
  const paused = accountPause.paused || row.pauseRequestedAt !== null;

  const baseResult = (status: TickResult['status'], reasonCodes: LifeReasonCode[], modelCalls = 0): TickResult => ({
    charId,
    modelCalls,
    due: false,
    actionId: null,
    status,
    reasonCodes,
    nextOpportunityAt: row.nextOpportunityAt,
  });

  if (paused) {
    const next = nextRevision({
      ...row,
      availability: 'paused',
      reasonCodes: ['GLOBAL_PAUSED'],
      lifePhase: 'waiting',
    });
    await deps.store.putCharacterLife(next, row.revision);
    return baseResult('paused', ['GLOBAL_PAUSED']);
  }

  if (row.circuitOpenedAt !== null) {
    const retryAt = row.retryAt ?? row.circuitOpenedAt + FAILURE_BACKOFF_MS[FAILURE_BACKOFF_MS.length - 1];
    if (nowMs < retryAt) {
      return { ...baseResult('circuit_open', pauseCycleReason(row.circuitOpenedAt)), nextOpportunityAt: retryAt };
    }
  }

  if (row.retryAt !== null && nowMs < row.retryAt) {
    return { ...baseResult('model_failed', ['MODEL_FAILED']), nextOpportunityAt: row.retryAt };
  }

  // 未到期：零模型调用。
  if (row.nextOpportunityAt !== null && nowMs < row.nextOpportunityAt) {
    return baseResult('not_due', row.reasonCodes);
  }

  const phase = resolvePhase(row.profile ?? fallbackProfile(charId, row, nowMs), nowMs);
  const needs = updateNeeds(row.needs, {
    elapsedMs: nowMs - row.lastEvaluatedAt,
    phase: phase.phase,
    traits: (row.profile ?? fallbackProfile(charId, row, nowMs)).traits,
    sinceInteractionMs: row.lastInteractionAt ? nowMs - row.lastInteractionAt : undefined,
  });

  const profile = ensureProfile(row, nowMs);
  if (needsAreLow(needs)) {
    const plan = planNextOpportunity({
      profile,
      needs,
      nowMs,
      seed: deps.seed,
      charId,
      minGapMs: DEFAULT_MIN_GAP_MS,
      lastOpportunityAt: row.lastModelCallAt || undefined,
    });
    const next = nextRevision({
      ...row,
      needs,
      lastEvaluatedAt: nowMs,
      lifePhase: 'resting',
      availability: 'ready',
      reasonCodes: ['RESTING'],
      nextOpportunityAt: plan.nextOpportunityAt,
      nextCheckAt: plan.nextCheckAt,
      opportunityId: plan.opportunityId,
      scheduleConfidence: profile.confidence,
      profile,
    });
    await deps.store.putCharacterLife(next, row.revision);
    return { ...baseResult('resting', ['RESTING']), nextOpportunityAt: plan.nextOpportunityAt };
  }

  // 睡眠优先休息：睡着时不发模型请求，也不「补任务量」；下一次机会落到醒来后的窗口。
  if (phase.phase === 'resting') {
    const plan = planNextOpportunity({
      profile,
      needs,
      nowMs,
      seed: deps.seed,
      charId,
      minGapMs: DEFAULT_MIN_GAP_MS,
      lastOpportunityAt: row.lastModelCallAt || undefined,
    });
    const next = nextRevision({
      ...row,
      needs,
      lastEvaluatedAt: nowMs,
      lifePhase: 'resting',
      availability: 'ready',
      reasonCodes: ['SLEEPING'],
      nextOpportunityAt: plan.nextOpportunityAt,
      nextCheckAt: plan.nextCheckAt,
      opportunityId: plan.opportunityId,
      scheduleConfidence: profile.confidence,
      profile,
    });
    await deps.store.putCharacterLife(next, row.revision);
    return { ...baseResult('resting', ['SLEEPING']), nextOpportunityAt: plan.nextOpportunityAt };
  }

  // 统一预算门：先预留，再调模型；预不了就明确 BUDGET_EXHAUSTED，不「先发后补账」。
  const reservation = await reserveBudget(deps.budget, {
    nowMs,
    windowTimezone: row.windowTimezone,
    accountId,
    charId,
    limits: (await deps.boundaryFor(charId)).limits,
    calls: 1,
    tokens: deps.reserveTokensPerRun ?? 1600,
  });
  if (!reservation.ok) {
    const next = nextRevision({
      ...row,
      needs,
      availability: 'limited',
      reasonCodes: [reservation.code === 'BUDGET_EXHAUSTED' ? 'BUDGET_EXHAUSTED' : 'MODEL_FAILED'],
      lastEvaluatedAt: nowMs,
      nextCheckAt: nowMs + 30 * 60_000,
    });
    await deps.store.putCharacterLife(next, row.revision);
    return {
      ...baseResult('budget_exhausted', [reservation.code === 'BUDGET_EXHAUSTED' ? 'BUDGET_EXHAUSTED' : 'MODEL_FAILED']),
      budgetDimension: reservation.dimension,
    };
  }

  const proposal = await deps.model.request({
    charId,
    grant: reservation.grant,
    kind: 'plan',
    promptKey: `rhythm-plan:${localDateKey(nowMs, row.windowTimezone)}`,
  });

  await settleBudget(deps.budget, reservation.grant, {
    actualTokens: proposal?.usageUnknown ? null : proposal?.tokensUsed ?? null,
    requestStarted: true,
  });

  if (!proposal) {
    const failStreak = row.failStreak + 1;
    const backoffIndex = Math.min(failStreak - 1, FAILURE_BACKOFF_MS.length - 1);
    const retryAt = nowMs + FAILURE_BACKOFF_MS[backoffIndex];
    const circuitOpenedAt = failStreak >= 3 ? (row.circuitOpenedAt ?? nowMs) : null;
    const next = nextRevision({
      ...row,
      needs,
      lastEvaluatedAt: nowMs,
      lastModelCallAt: nowMs,
      failStreak,
      retryAt,
      circuitOpenedAt,
      availability: circuitOpenedAt ? 'error' : 'limited',
      reasonCodes: circuitOpenedAt ? ['CIRCUIT_OPEN'] : ['MODEL_FAILED'],
      nextOpportunityAt: retryAt,
      nextCheckAt: retryAt,
      profile,
    });
    await deps.store.putCharacterLife(next, row.revision);
    return {
      ...baseResult(circuitOpenedAt ? 'circuit_open' : 'model_failed', circuitOpenedAt ? ['CIRCUIT_OPEN'] : ['MODEL_FAILED'], 1),
      nextOpportunityAt: retryAt,
    };
  }

  const candidates = deps.candidatesFor ? deps.candidatesFor(charId) : proposal.candidates;
  const recent = await deps.store.recentActivities(charId, nowMs - DAY_MS);
  const boundary = await deps.boundaryFor(charId);
  const rng = planRng(deps.seed, charId, profile, nowMs);
  const chosen = chooseActivity({
    candidates,
    allowedKinds: boundary.allowedKinds,
    profile,
    needs,
    phase: phase.phase,
    recent,
    nowMs,
    tz: boundary.timezone,
    interactionFit: row.lastInteractionAt && nowMs - row.lastInteractionAt < 15 * 60_000 ? 0.2 : 0.6,
    rng,
    recentFailurePenalty: Math.min(1, row.failStreak * 0.2),
  });

  const nextNeeds = chosen ? applyActivitySuccess(needs, chosen.kind) : needs;
  const plan = planNextOpportunity({
    profile,
    needs: nextNeeds,
    nowMs,
    seed: deps.seed,
    charId,
    minGapMs: MODEL_REQUEST_MIN_GAP_MS,
    lastOpportunityAt: row.lastModelCallAt || undefined,
  });

  if (!chosen) {
    const next = nextRevision({
      ...row,
      needs: nextNeeds,
      lastEvaluatedAt: nowMs,
      lastModelCallAt: nowMs,
      failStreak: 0,
      retryAt: null,
      circuitOpenedAt: null,
      availability: 'ready',
      lifePhase: 'resting',
      reasonCodes: ['NO_CANDIDATE'],
      nextOpportunityAt: plan.nextOpportunityAt,
      nextCheckAt: plan.nextCheckAt,
      opportunityId: plan.opportunityId,
      profile,
      scheduleConfidence: profile.confidence,
    });
    await deps.store.putCharacterLife(next, row.revision);
    return { ...baseResult('no_candidate', ['NO_CANDIDATE'], 1), nextOpportunityAt: plan.nextOpportunityAt };
  }

  // 第一道强校验（计划登记前）：禁止方向 / 参数封闭 / 越权键都在这里拦。
  // 执行前还会再跑一次同一份判定（localRunner），两道门都要过。
  const candidateArgs = chosen.candidate.args ?? {};
  const planDecision = checkIntentPolicy(
    {
      kind: chosen.kind,
      args: candidateArgs,
      purpose: chosen.semanticPurpose,
      boundary: {
        forbiddenCategories: boundary.forbiddenCategories,
        avoidTopics: boundary.avoidTopics,
        allowFictionalNpc: boundary.allowFictionalNpc,
        externalGrants: boundary.externalGrants,
      },
    },
    nowMs,
  );
  if (!planDecision.allowed) {
    const next = nextRevision({
      ...row,
      needs: nextNeeds,
      lastEvaluatedAt: nowMs,
      lastModelCallAt: nowMs,
      availability: 'ready',
      lifePhase: 'idle',
      reasonCodes: ['POLICY_DENIED'],
      nextOpportunityAt: plan.nextOpportunityAt,
      nextCheckAt: plan.nextCheckAt,
      opportunityId: plan.opportunityId,
      profile,
    });
    await deps.store.putCharacterLife(next, row.revision);
    return { ...baseResult('skipped', ['POLICY_DENIED'], 1), nextOpportunityAt: plan.nextOpportunityAt };
  }

  // 同类冷却 + 同日语义去重（硬闸，不受噪声影响）。
  const blockedByCooldown = withinKindCooldown(recent, chosen.kind, nowMs);
  const blockedByDedupe = alreadyProducedToday({
    recent,
    semanticPurpose: chosen.semanticPurpose,
    nowMs,
    tz: boundary.timezone,
  });
  if (blockedByCooldown || blockedByDedupe) {
    const next = nextRevision({
      ...row,
      needs: nextNeeds,
      lastEvaluatedAt: nowMs,
      lastModelCallAt: nowMs,
      availability: 'ready',
      lifePhase: 'idle',
      reasonCodes: ['NO_CANDIDATE'],
      nextOpportunityAt: plan.nextOpportunityAt,
      nextCheckAt: plan.nextCheckAt,
      opportunityId: plan.opportunityId,
      profile,
    });
    await deps.store.putCharacterLife(next, row.revision);
    return { ...baseResult('skipped', ['NO_CANDIDATE'], 1), nextOpportunityAt: plan.nextOpportunityAt };
  }

  const installation = await deps.store.getBoundInstallation(accountId);
  const online = await deps.deviceOnline(installation);
  const action = buildActionRow({
    charId,
    chosen,
    nowMs,
    budgetWindowId: reservation.grant.windowId,
    reservationId: reservation.grant.reservationId,
    policyVersion: deps.policyVersion ?? DEFAULT_POLICY_VERSION,
    tz: boundary.timezone,
    installationId: installation,
    online,
  });
  await deps.store.insertAction(action);

  const next = nextRevision({
    ...row,
    needs: nextNeeds,
    revision: row.revision,
    lastEvaluatedAt: nowMs,
    lastModelCallAt: nowMs,
    lastGrantedAt: nowMs,
    failStreak: 0,
    retryAt: null,
    circuitOpenedAt: null,
    availability: 'ready',
    lifePhase: online ? 'engaged' : 'waiting',
    reasonCodes: online ? [] : ['WAITING_DEVICE'],
    activeActionId: action.id,
    pendingCount: row.pendingCount + 1,
    nextOpportunityAt: plan.nextOpportunityAt,
    nextCheckAt: plan.nextCheckAt,
    opportunityId: plan.opportunityId,
    profile,
    scheduleConfidence: profile.confidence,
  });
  await deps.store.putCharacterLife(next, row.revision);

  return {
    charId,
    modelCalls: 1,
    due: true,
    actionId: action.id,
    status: online ? 'scheduled' : 'waiting_device',
    reasonCodes: online ? [] : ['WAITING_DEVICE'],
    nextOpportunityAt: plan.nextOpportunityAt,
  };
}

function fallbackProfile(charId: string, row: CharacterLifeRow, nowMs: number): RhythmProfile {
  return buildRhythmProfile({
    personaText: '',
    scheduleText: '',
    timezone: row.windowTimezone,
    personaHash: `${charId}:fallback`,
    nowMs,
  });
}

function ensureProfile(row: CharacterLifeRow, nowMs: number): RhythmProfile {
  if (row.profile && !isProfileStale(row.profile, {
    personaHash: row.profile.personaHash,
    timezone: row.windowTimezone,
    summaryHash: row.profile.summaryHash,
  })) {
    return row.profile;
  }
  return fallbackProfile(row.charId, row, nowMs);
}

function planRng(seed: string, charId: string, profile: RhythmProfile, nowMs: number) {
  // 运行时随机源：派生自 (安装种子, 角色, 日程 revision, 当日)；不落库也能复现。
  return createRng('choose', seed, charId, profile.scheduleRevision, localDateKey(nowMs, profile.timezone));
}

export interface BuildActionInput {
  charId: string;
  chosen: { kind: ActivityKind; semanticPurpose: string; purposeKey: string; args?: Record<string, unknown>; reasonSummary: string; candidate: Candidate };
  nowMs: number;
  budgetWindowId: string;
  reservationId: string;
  policyVersion: string;
  tz: string;
  installationId: string | null;
  online: boolean;
  source?: ActionSource;
  sourceRef?: string | null;
  argsHash?: string;
  args?: Record<string, unknown>;
}

export function buildActionRow(input: BuildActionInput): ActionRow {
  const args = input.args ?? input.chosen.args ?? input.chosen.candidate.args ?? { semanticPurpose: input.chosen.semanticPurpose };
  const dedupeKey = actionDedupeKey({
    charId: input.charId,
    kind: input.chosen.kind,
    purposeKey: input.chosen.purposeKey,
    localDateKey: localDateKey(input.nowMs, input.tz),
  });
  return {
    id: `act_${dedupeKey}_${input.nowMs.toString(36)}`,
    charId: input.charId,
    kind: input.chosen.kind,
    windowId: input.budgetWindowId,
    executionMode: 'local',
    scope: input.chosen.kind === 'external.read' ? 'external_read' : 'os_simulation',
    source: input.source ?? 'rhythm',
    sourceRef: input.sourceRef ?? null,
    purposeKey: input.chosen.purposeKey,
    args,
    argsHash: input.argsHash ?? hashArgs(args),
    basis: 'virtual',
    reasonSummary: input.chosen.reasonSummary,
    semanticPurpose: input.chosen.semanticPurpose,
    createdAt: input.nowMs,
    notBefore: input.nowMs,
    expiresAt: input.nowMs + 6 * HOUR_MS,
    status: input.online ? 'scheduled' : 'waiting_device',
    revision: 0,
    policyVersion: input.policyVersion,
    dedupeKey,
    reservationId: input.reservationId,
    installationId: input.installationId,
    resultRef: null,
    errorCode: null,
    leaseEpoch: 0,
    leaseExpiresAt: null,
    permitIssuedAt: null,
    notified: false,
  };
}

// ─── 动作生命周期（claim / permit / receipt / cancel） ──────────────────────

export interface ClaimResult {
  action: ActionRow | null;
  leaseEpoch: number;
  leaseExpiresAt: number | null;
}

/** 只有到期且已预留的动作可领；绑定设备在线才领得到。 */
export async function claimAction(deps: EngineDeps, args: {
  accountId: string;
  installationId: string;
  charId: string;
  leaseMs?: number;
}): Promise<ClaimResult> {
  const nowMs = (deps.clock ?? systemClock).now();
  const bound = await deps.store.getBoundInstallation(args.accountId);
  if (bound && bound !== args.installationId) return { action: null, leaseEpoch: 0, leaseExpiresAt: null };
  const due = await deps.store.dueActions(args.charId, nowMs, 1);
  const candidate = due.find((action) => action.status === 'scheduled' || action.status === 'waiting_device');
  if (!candidate) return { action: null, leaseEpoch: 0, leaseExpiresAt: null };
  const leaseMs = args.leaseMs ?? 5 * 60_000;
  const next: ActionRow = {
    ...candidate,
    status: 'scheduled',
    installationId: args.installationId,
    leaseEpoch: candidate.leaseEpoch + 1,
    leaseExpiresAt: nowMs + leaseMs,
    revision: candidate.revision + 1,
  };
  const saved = await deps.store.putAction(next, candidate.revision);
  if (!saved) return { action: null, leaseEpoch: 0, leaseExpiresAt: null };
  return { action: next, leaseEpoch: next.leaseEpoch, leaseExpiresAt: next.leaseExpiresAt };
}

export interface PermitResult {
  ok: boolean;
  code?: AutonomyLifeErrorCode;
  permit?: {
    actionId: string;
    installationId: string;
    leaseEpoch: number;
    argsHash: string;
    policyVersion: string;
    reservationId: string | null;
    expiresAt: number;
    nonce: string;
  };
}

/**
 * commit-permit：暂停/策略/租约/预留的**服务端条件提交**是并发线性化点。
 * 暂停之后不再发新许可；在途许可（已发出）不回收，如实显示「正在停止」。
 */
export async function commitPermit(deps: EngineDeps, args: {
  accountId: string;
  actionId: string;
  installationId: string;
  leaseEpoch: number;
  argsHash: string;
  policyVersion: string;
  nowMs?: number;
}): Promise<PermitResult> {
  const nowMs = args.nowMs ?? (deps.clock ?? systemClock).now();
  const pause = await deps.store.getAccountPause(args.accountId);
  if (pause.paused) return { ok: false, code: 'GLOBAL_PAUSED' };
  const action = await deps.store.getAction(args.actionId);
  if (!action) return { ok: false, code: 'NOT_FOUND' };
  if (action.status === 'unknown') return { ok: false, code: 'UNKNOWN_EFFECT' };
  if (isTerminalActionStatus(action.status)) return { ok: false, code: 'STATE_CONFLICT' };
  if (action.installationId && action.installationId !== args.installationId) return { ok: false, code: 'FORBIDDEN' };
  if (action.leaseEpoch !== args.leaseEpoch) return { ok: false, code: 'STATE_CONFLICT' };
  if (action.leaseExpiresAt !== null && nowMs > action.leaseExpiresAt) return { ok: false, code: 'STATE_CONFLICT' };
  if (action.argsHash !== args.argsHash && action.argsHash !== 'pending') return { ok: false, code: 'STATE_CONFLICT' };
  if (action.policyVersion !== args.policyVersion) return { ok: false, code: 'STATE_CONFLICT' };

  const next: ActionRow = {
    ...action,
    status: 'running',
    argsHash: args.argsHash,
    permitIssuedAt: nowMs,
    leaseExpiresAt: nowMs + 60_000, // 短期一次性 token：60 秒
    revision: action.revision + 1,
  };
  const saved = await deps.store.putAction(next, action.revision);
  if (!saved) return { ok: false, code: 'STATE_CONFLICT' };
  return {
    ok: true,
    permit: {
      actionId: next.id,
      installationId: args.installationId,
      leaseEpoch: next.leaseEpoch,
      argsHash: args.argsHash,
      policyVersion: next.policyVersion,
      reservationId: next.reservationId,
      expiresAt: next.leaseExpiresAt!,
      nonce: `nonce_${next.id}_${next.leaseEpoch}_${nowMs.toString(36)}`,
    },
  };
}

export interface ReceiptReport {
  accountId: string;
  actionId: string;
  installationId: string;
  leaseEpoch: number;
  argsHash: string;
  status: 'succeeded' | 'failed' | 'unknown';
  resultRef?: string | null;
  errorCode?: AutonomyLifeErrorCode;
  nowMs?: number;
}

/** 回执上报：只有 succeeded 才写 resultRef + effectVerified 依据。 */
export async function reportReceipt(deps: EngineDeps, report: ReceiptReport): Promise<{ ok: boolean; code?: AutonomyLifeErrorCode; action?: ActionRow }> {
  const nowMs = report.nowMs ?? (deps.clock ?? systemClock).now();
  const action = await deps.store.getAction(report.actionId);
  if (!action) return { ok: false, code: 'NOT_FOUND' };
  if (action.installationId && action.installationId !== report.installationId) return { ok: false, code: 'FORBIDDEN' };
  if (action.leaseEpoch !== report.leaseEpoch) return { ok: false, code: 'STATE_CONFLICT' };
  if (isTerminalActionStatus(action.status) && action.status !== 'unknown') {
    // 回执幂等：同一结果重复上报返回原动作。
    if (action.resultRef === (report.resultRef ?? action.resultRef)) return { ok: true, action };
    return { ok: false, code: 'STATE_CONFLICT' };
  }
  const status: ActionStatus = report.status === 'succeeded' ? 'succeeded' : report.status === 'unknown' ? 'unknown' : 'failed';
  const next: ActionRow = {
    ...action,
    status,
    resultRef: report.status === 'succeeded' ? report.resultRef ?? null : action.resultRef,
    errorCode: report.status === 'succeeded' ? null : report.errorCode ?? (report.status === 'unknown' ? 'UNKNOWN_EFFECT' : 'MODEL_FAILED'),
    leaseExpiresAt: null,
    revision: action.revision + 1,
  };
  const saved = await deps.store.putAction(next, action.revision);
  if (!saved) return { ok: false, code: 'STATE_CONFLICT' };
  if (status !== 'unknown') {
    const life = await deps.store.getCharacterLife(action.charId);
    if (life) {
      await deps.store.putCharacterLife(
        {
          ...life,
          revision: life.revision + 1,
          activeActionId: null,
          pendingCount: Math.max(0, life.pendingCount - 1),
        },
        life.revision,
      );
    }
  }
  await deps.store.appendEvent({
    eventId: `evt_${next.id}_${next.revision}_${nowMs.toString(36)}`,
    sequence: 0,
    type: 'action.changed',
    charId: next.charId,
    actionId: next.id,
    revision: next.revision,
    occurredAt: nowMs,
    data: { status: next.status },
  });
  return { ok: true, action: next };
}

/** 取消：只对还没拿到副作用的动作可用；running 已获许可 → CANNOT_CANCEL。 */
export async function cancelAction(deps: EngineDeps, args: {
  accountId: string;
  actionId: string;
  expectedRevision: number;
  nowMs?: number;
}): Promise<{ ok: boolean; code?: AutonomyLifeErrorCode; action?: ActionRow }> {
  const nowMs = args.nowMs ?? (deps.clock ?? systemClock).now();
  const action = await deps.store.getAction(args.actionId);
  if (!action) return { ok: false, code: 'NOT_FOUND' };
  if (action.revision !== args.expectedRevision) return { ok: false, code: 'REVISION_CONFLICT' };
  if (action.status === 'running' || action.permitIssuedAt !== null) return { ok: false, code: 'CANNOT_CANCEL' };
  if (!['proposed', 'scheduled', 'waiting_device', 'awaiting_confirmation', 'blocked'].includes(action.status)) {
    return { ok: false, code: 'CANNOT_CANCEL' };
  }
  const next: ActionRow = { ...action, status: 'cancelled', revision: action.revision + 1 };
  const saved = await deps.store.putAction(next, action.revision);
  if (!saved) return { ok: false, code: 'STATE_CONFLICT' };
  return { ok: true, action: next };
}

export interface PauseResult {
  acknowledged: true;
  quiesced: boolean;
  paused: boolean;
  revision: number;
}

/**
 * 暂停：
 *   - paused=true → acknowledged 立刻为真（不再发新许可）；
 *     quiesced 只有在「没有在途许可」时才为真；
 *   - paused=false → 解除暂停，但**不补跑**所有过期计划。
 */
export async function requestPause(deps: EngineDeps, args: {
  accountId: string;
  paused: boolean;
  nowMs?: number;
}): Promise<PauseResult> {
  const nowMs = args.nowMs ?? (deps.clock ?? systemClock).now();
  await deps.store.setAccountPause(args.accountId, args.paused, nowMs);
  const inflight = args.paused ? await deps.store.inflightPermits(args.accountId, nowMs) : 0;
  return {
    acknowledged: true,
    quiesced: args.paused ? inflight === 0 : true,
    paused: args.paused,
    revision: nowMs,
  };
}

/** 设备绑定：换设备必须没有 running/awaiting_receipt 的动作，否则拒绝（不跨本地库执行同一订单）。 */
export async function bindDevice(deps: EngineDeps, args: {
  accountId: string;
  installationId: string;
  pendingActionIds?: string[];
}): Promise<{ ok: boolean; code?: AutonomyLifeErrorCode; bindingState: 'bound' | 'already_bound' | 'rejected' }> {
  const current = await deps.store.getBoundInstallation(args.accountId);
  if (current === args.installationId) return { ok: true, bindingState: 'already_bound' };
  if (current) {
    const pending = args.pendingActionIds ?? [];
    const inflight = await deps.store.inflightPermits(args.accountId, (deps.clock ?? systemClock).now());
    if (inflight > 0 || pending.length > 0) {
      return { ok: false, code: 'UNKNOWN_EFFECT', bindingState: 'rejected' };
    }
  }
  const bound = await deps.store.bindInstallation(args.accountId, args.installationId, (deps.clock ?? systemClock).now());
  return bound ? { ok: true, bindingState: 'bound' } : { ok: false, code: 'STATE_CONFLICT', bindingState: 'rejected' };
}

// ─── 投影（UI 读的 state / activities） ─────────────────────────────────────

export function projectCharacterState(input: {
  row: CharacterLifeRow;
  capabilities: Capability[];
  budgetRows: { account: Parameters<typeof projectBudgetUsage>[0]; char: Parameters<typeof projectBudgetUsage>[1] };
  limits: EffectiveBoundaryV1['limits'];
  nowMs: number;
}): CharacterLifeState {
  return {
    schemaVersion: 1,
    charId: input.row.charId,
    revision: input.row.revision,
    observedAt: input.nowMs,
    lifePhase: input.row.lifePhase,
    availability: input.row.availability,
    reasonCodes: input.row.reasonCodes,
    nextOpportunityAt: input.row.nextOpportunityAt,
    nextCheckAt: input.row.nextCheckAt,
    scheduleConfidence: input.row.scheduleConfidence,
    activeActionId: input.row.activeActionId,
    pendingCount: input.row.pendingCount,
    budgetWindowId: input.row.budgetWindowId,
    budget: projectBudgetUsage(input.budgetRows.account, input.budgetRows.char, input.limits),
  };
}

/** 动作行 → ActivityRecord（succeeded 必须有 resultRef 才算 effectVerified）。 */
export function projectActivity(action: ActionRow): ActivityRecord {
  const verified = action.status === 'succeeded' && typeof action.resultRef === 'string' && action.resultRef.length > 0;
  return {
    schemaVersion: 1,
    id: action.id,
    charId: action.charId,
    kind: action.kind,
    scope: action.scope,
    source: action.source,
    sourceRef: action.sourceRef,
    status: action.status,
    reasonSummary: action.reasonSummary,
    occurredAt: action.createdAt,
    updatedAt: action.createdAt,
    resultRef: action.resultRef,
    effectVerified: verified,
    notificationState: action.notified ? 'delivered' : 'none',
    errorCode: action.errorCode,
    canCancel: ['proposed', 'scheduled', 'waiting_device', 'blocked'].includes(action.status),
  };
}

/** 遗留记录用稳定 legacy:<store>:<id>，不能编造新 actionId。 */
export function legacyActivityRecord(input: {
  store: string;
  id: string;
  charId: string;
  kind: ActivityKind;
  occurredAt: number;
  reasonSummary: string;
}): ActivityRecord {
  return {
    schemaVersion: 1,
    id: `legacy:${input.store}:${input.id}`,
    charId: input.charId,
    kind: input.kind,
    scope: 'os_simulation',
    source: 'legacy',
    sourceRef: null,
    status: 'succeeded',
    reasonSummary: input.reasonSummary,
    occurredAt: input.occurredAt,
    updatedAt: input.occurredAt,
    resultRef: `${input.store}:${input.id}`,
    effectVerified: true,
    notificationState: 'none',
    errorCode: null,
    canCancel: false,
  };
}

export { describeCapabilities };

// ─── 分页游标（§7 GET /activities） ─────────────────────────────────────────

interface ActionCursor {
  at: number;
  id: string;
}

function encodeCursor(row: ActionRow): string {
  return `${row.createdAt}.${row.id}`;
}

/** 供服务层拼分页游标：永远是「这一条之后」。 */
export function actionCursor(row: ActionRow): string {
  return encodeCursor(row);
}

function decodeCursor(raw: string): ActionCursor | null {
  const index = raw.indexOf('.');
  if (index <= 0) return null;
  const at = Number(raw.slice(0, index));
  const id = raw.slice(index + 1);
  if (!Number.isFinite(at) || !id) return null;
  return { at, id };
}

/** 稳定降序下的「在这一条之后」：时间更早，或同时间但 id 更小。 */
function isAfterCursor(row: ActionRow, cursor: ActionCursor): boolean {
  if (row.createdAt !== cursor.at) return row.createdAt < cursor.at;
  return row.id < cursor.id;
}

// ─── 内存实现（测试 / 单进程降级） ──────────────────────────────────────────

export function createInMemoryLifeStore(): LifeStorePort & {
  actions: Map<string, ActionRow>;
  characters: Map<string, CharacterLifeRow>;
  events: LifeEvent[];
  accountPause: Map<string, { paused: boolean; requestedAt: number | null }>;
  bound: Map<string, string>;
} {
  const actions = new Map<string, ActionRow>();
  const characters = new Map<string, CharacterLifeRow>();
  const events: LifeEvent[] = [];
  const accountPause = new Map<string, { paused: boolean; requestedAt: number | null }>();
  const bound = new Map<string, string>();
  return {
    actions,
    characters,
    events,
    accountPause,
    bound,
    async getCharacterLife(charId) {
      const row = characters.get(charId);
      return row ? { ...row, reasonCodes: [...row.reasonCodes] } : null;
    },
    async putCharacterLife(row, expectedRevision) {
      const current = characters.get(row.charId);
      const currentRevision = current?.revision ?? 0;
      if (expectedRevision !== currentRevision) return false;
      characters.set(row.charId, { ...row, reasonCodes: [...row.reasonCodes] });
      return true;
    },
    async getAction(actionId) {
      const row = actions.get(actionId);
      return row ? { ...row } : null;
    },
    async insertAction(row) {
      if (actions.has(row.id)) return false;
      actions.set(row.id, { ...row });
      return true;
    },
    async putAction(row, expectedRevision) {
      const current = actions.get(row.id);
      if (!current || current.revision !== expectedRevision) return false;
      actions.set(row.id, { ...row });
      return true;
    },
    async dueActions(charId, nowMs, limit) {
      return [...actions.values()]
        .filter((row) => row.charId === charId && row.notBefore <= nowMs
          && (row.status === 'scheduled' || row.status === 'waiting_device'))
        .sort((a, b) => a.notBefore - b.notBefore)
        .slice(0, limit)
        .map((row) => ({ ...row }));
    },
    async recentActivities(charId, sinceMs) {
      return [...actions.values()]
        .filter((row) => row.charId === charId && row.createdAt >= sinceMs)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((row) => ({
          kind: row.kind,
          semanticPurpose: row.semanticPurpose,
          contentFingerprint: row.purposeKey,
          occurredAt: row.createdAt,
          success: row.status === 'succeeded',
        }));
    },
    async listActions(args) {
      const cursor = args.cursor ? decodeCursor(args.cursor) : null;
      const filtered = [...actions.values()]
        .filter((row) => row.charId === args.charId && (!args.status || row.status === args.status))
        // occurredAt + id 稳定降序（同毫秒也不会跳条/重复）。
        .sort((a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        .filter((row) => !cursor || isAfterCursor(row, cursor));
      const items = filtered.slice(0, args.limit);
      const last = items[items.length - 1];
      return { items, nextCursor: last ? encodeCursor(last) : null };
    },
    async appendEvent(event) {
      events.push({ ...event, sequence: events.length + 1 });
    },
    async getAccountPause(accountId) {
      return accountPause.get(accountId) ?? { paused: false, requestedAt: null };
    },
    async setAccountPause(accountId, paused, nowMs) {
      accountPause.set(accountId, { paused, requestedAt: paused ? nowMs : null });
    },
    async inflightPermits(accountId, nowMs) {
      void accountId;
      return [...actions.values()].filter(
        (row) => row.permitIssuedAt !== null && row.status === 'running'
          && (row.leaseExpiresAt === null || row.leaseExpiresAt > nowMs),
      ).length;
    },
    async getBoundInstallation(accountId) {
      return bound.get(accountId) ?? null;
    },
    async bindInstallation(accountId, installationId) {
      bound.set(accountId, installationId);
      return true;
    },
  };
}

/** 供 worker 侧复用的指纹助手（去重记录的补充指纹）。 */
export function recentFingerprint(candidate: Candidate): string {
  return fingerprintOf(candidate);
}
