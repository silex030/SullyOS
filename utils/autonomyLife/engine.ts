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
  hashString,
  isMarketProposalKind,
  isTerminalActionStatus,
  PERMIT_TTL_MS,
  type ActivityKind,
  type ActivityRecord,
  type ActionSource,
  type ActionStatus,
  type AutonomyLifeErrorCode,
  type Capability,
  type CharacterLifeState,
  type EffectiveBoundaryV1,
  type ExecutionPermit,
  type LifeEvent,
  type LifePhase,
  type LifeReasonCode,
  type MarketProposalKind,
} from '../../contracts/autonomyLife';
import { boundaryGate } from './boundary';
import { describeCapabilities, type CapabilityProbeState } from './adapters';
import { buildAmbientCandidates } from './ambientCandidates';
import { orderTotalMinorFromArgs } from './marketCatalog';
import { normalizePersonaSignal, personaHashOf, type PersonaSignal } from './personaSignal';
import { checkIntentPolicy } from './policy';
import {
  projectBudgetUsage,
  reserveBudget,
  settleBudget,
  verifyReservationHold,
  windowIdAt,
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
  /** 已签发的一次性许可令牌（只存一份；重复使用即重放）。null = 从未签发。 */
  permitNonce: string | null;
  /** 许可被本地事务消费的时刻。非 null = 该许可已用掉，永不再用。 */
  permitConsumedAt: number | null;
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
  /**
   * 一次性许可的**条件提交**：读账号暂停 + 读角色暂停 + 条件写动作行（running + 许可）
   * 必须在同一个事务里完成。任一条不满足 → 返回失败码，一个字节都不写。
   *
   * 为什么必须是端口方法而不是引擎里拼几个 await：这就是并发线性化点。D1 侧用单条
   * 条件 UPDATE（带 EXISTS 子查询）实现，内存实现用同步临界区；两边语义一致，
   * 引擎不各自近似「差不多原子」。
   */
  commitPermitAtomic(input: AtomicPermitCommit): Promise<AtomicPermitResult>;
}

/** 许可条件提交的输入：所有字段都是 CAS 条件的一部分。 */
export interface AtomicPermitCommit {
  accountId: string;
  actionId: string;
  charId: string;
  installationId: string;
  leaseEpoch: number;
  argsHash: string;
  policyVersion: string;
  nowMs: number;
  /** 许可到期时刻（短期一次性令牌）。 */
  expiresAt: number;
  nonce: string;
  /** claim 之后读到的动作 revision：并发领取代次已变就失败。 */
  expectedRevision: number;
  /** 发许可前读到的当前预算窗口（动作行里也必须是这个窗口）。 */
  expectedWindowId: string;
  /**
   * 读边界时看到的两层 revision。条件 UPDATE 里必须仍然相等——
   * 用户在「读完边界之后、写许可之前」撤销授权/改限额/改禁区会让 changes=0。
   * null/undefined = 证明不了边界仍有效 → 一样拒绝（fail closed）。
   */
  expectedAccountBoundaryRevision: number | null;
  expectedCharacterBoundaryRevision: number | null;
  /**
   * 发许可前读到的**预留凭据 revision**。同一条条件 UPDATE 里核：
   * 记录仍属于本动作、状态不是 released、未过期、revision 没变。
   * null/undefined = 证明不了凭据仍有效 → 拒绝（fail closed）。
   */
  expectedReservationRevision?: number | null;
}

export type AtomicPermitResult =
  | { ok: true; action: ActionRow }
  | { ok: false; code: AutonomyLifeErrorCode; detail?: string };

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
  /**
   * 真实人设/日程来源（worker 从 fire_pack 模板 + 当天日程读出）。
   * 缺省 / 返回 null / 读失败 → 没有信号，profile 按「暂用基础作息」确定性回退。
   * 这是一条**只读信号**：引擎只拿它建 profile，不把它当成内容候选。
   */
  personaFor?: (charId: string) => Promise<Partial<PersonaSignal> | null>;
  /**
   * 绑定设备上报的**真实目录候选**（外卖/购物：真实店/商品/单价/收货地址，来自
   * `/autonomy-life/v1/proposals`）。它们与模型候选一起参与打分，但绝不因此放宽
   * 边界/额度/许可；读到空列表 = 这一轮没有本地候选，不是错误。
   */
  localCandidatesFor?: (charId: string) => Promise<Candidate[]>;
  /** 已经排上动作后回收对应的本地候选（避免同一份候选在 TTL 内再被排一次）。 */
  consumeLocalCandidates?: (charId: string, kind: MarketProposalKind) => Promise<void>;
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
  let row = stored ?? boundaryRow;

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

  // 人设/日程是 profile 的唯一来源。真实人设改了就重建并立刻落库（不等下一次
  // 到期），这样「同一天改了角色设定」不会拖到下一轮机会才生效。没有信号 → 基础作息。
  const personaSignal = await readPersonaSignal(deps, charId);
  const resolved = resolveProfile(row, charId, nowMs, personaSignal);
  const profile = resolved.profile;
  if (resolved.rebuilt) {
    const next = nextRevision({ ...row, profile, scheduleConfidence: profile.confidence });
    if (await deps.store.putCharacterLife(next, row.revision)) row = next;
  }

  // 未到期：零模型调用。
  if (row.nextOpportunityAt !== null && nowMs < row.nextOpportunityAt) {
    return baseResult('not_due', row.reasonCodes);
  }

  const phase = resolvePhase(profile, nowMs);
  const needs = updateNeeds(row.needs, {
    elapsedMs: nowMs - row.lastEvaluatedAt,
    phase: phase.phase,
    traits: profile.traits,
    sinceInteractionMs: row.lastInteractionAt ? nowMs - row.lastInteractionAt : undefined,
  });

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

  // 真实目录候选（外卖/购物）不依赖模型：设备侧目录/价格/余额先备好，这边只是读。
  // 读失败 = 这一轮没有本地候选（不是模型失败，也不放宽任何门）。
  const localCandidates = deps.localCandidatesFor
    ? await deps.localCandidatesFor(charId).catch(() => [] as Candidate[])
    : [];

  const boundary = await deps.boundaryFor(charId);

  /*
   * 能力门（不只是 UI 文案）：外部窗口/外部只读是否**现在真的可用**由能力探测给出
   * （端点在 + 主机白名单在 + 授权未过期 + 可达）。探测不可用/读不到 → 只保留
   * 本地窗口，绝不让一个「配了但连不上」的外部能力进入候选打分。
   */
  const probes = await deps.probes(charId).catch(() => null);
  const capabilities = probes ? describeCapabilities({ boundary, probes, nowMs }) : null;
  const capabilityReady = (kind: ActivityKind): boolean =>
    capabilities === null ? boundary.allowedKinds.includes(kind) : capabilities.some((cap) => cap.kind === kind && cap.available);

  // 受控外部窗口的自主候选：来自人设兴趣 + 真实城市，只在「配置 + 授权 + 可达」都成立时
  // 才生成；它和模型/设备候选一起打分，没有任何额外放行。
  const ambient = buildAmbientCandidates({
    profile,
    externalReadAvailable: capabilityReady('external.read'),
    travelAvailable: capabilityReady('travel.wish'),
    city: personaSignal.city,
  });

  // 统一预算门：先预留，再调模型；预不了就明确 BUDGET_EXHAUSTED，不「先发后补账」。
  const reservation = await reserveBudget(deps.budget, {
    nowMs,
    windowTimezone: row.windowTimezone,
    accountId,
    charId,
    limits: boundary.limits,
    calls: 1,
    tokens: deps.reserveTokensPerRun ?? 1600,
    planRef: `rhythm-plan:${charId}:${localDateKey(nowMs, row.windowTimezone)}`,
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

  let proposal = await deps.model.request({
    charId,
    grant: reservation.grant,
    kind: 'plan',
    promptKey: `rhythm-plan:${localDateKey(nowMs, row.windowTimezone)}`,
  });

  await settleBudget(deps.budget, reservation.grant, {
    actualTokens: proposal?.usageUnknown ? null : proposal?.tokensUsed ?? null,
    requestStarted: true,
  });

  // 模型失败但手里有**真实候选**（设备上报的目录候选 / 人设兴趣推出的外部只读）：
  // 不把整轮判死（真实店/真实价格的生活不需要模型点头），照常进入选择；
  // 模型失败本身仍按一次调用计入用量。
  if (!proposal && (localCandidates.length > 0 || ambient.length > 0)) {
    proposal = { candidates: [...localCandidates, ...ambient] };
  }

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

  const modelCandidates = deps.candidatesFor ? deps.candidatesFor(charId) : proposal.candidates;
  const recent = await deps.store.recentActivities(charId, nowMs - DAY_MS);
  const rng = planRng(deps.seed, charId, profile, nowMs);
  const schedulableKinds = capabilities
    ? boundary.allowedKinds.filter((kind) => capabilities.some((cap) => cap.kind === kind && cap.available))
    : boundary.allowedKinds;
  const candidates = dedupeCandidates([...modelCandidates, ...localCandidates, ...ambient]);

  const chosen = chooseActivity({
    candidates,
    allowedKinds: schedulableKinds,
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

  /*
   * 消费类动作（外卖/购物）：计划期就核销**这次消费**的额度与同类计数。
   *
   * 为什么必须在计划期：`virtualOrderMaxMinor` / `virtualSpendPerDayMinor` /
   * `perKindActionsPerDay` 是用户设的硬上限。以前只有模型调用过预算门，订单金额
   * 从来没进过账本——「上限」写在界面上却管不住钱。这里用同一次原子预留把
   * (kind 计数 + 消费金额) 一起占住；预不了就明确 BUDGET_EXHAUSTED，不落动作。
   * 金额口径与执行侧一致：Σ 单价×数量 + 配送费（都是目录里的真实价格）。
   */
  if (isMarketProposalKind(chosen.kind)) {
    const totalMinor = orderTotalMinorFromArgs(candidateArgs);
    if (totalMinor === null) {
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
      return { ...baseResult('skipped', ['NO_CANDIDATE'], 1), nextOpportunityAt: plan.nextOpportunityAt, budgetDimension: 'bad_order_args' };
    }
    const spend = await reserveBudget(deps.budget, {
      nowMs,
      windowTimezone: row.windowTimezone,
      accountId,
      charId,
      limits: boundary.limits,
      calls: 0,
      tokens: 0,
      kind: chosen.kind,
      spendMinor: totalMinor,
      planRef: `rhythm-order:${charId}:${localDateKey(nowMs, row.windowTimezone)}`,
    });
    if (!spend.ok) {
      const next = nextRevision({
        ...row,
        needs: nextNeeds,
        lastEvaluatedAt: nowMs,
        lastModelCallAt: nowMs,
        availability: 'limited',
        reasonCodes: ['BUDGET_EXHAUSTED'],
        nextOpportunityAt: plan.nextOpportunityAt,
        nextCheckAt: plan.nextCheckAt,
        opportunityId: plan.opportunityId,
        profile,
      });
      await deps.store.putCharacterLife(next, row.revision);
      return { ...baseResult('budget_exhausted', ['BUDGET_EXHAUSTED'], 1), nextOpportunityAt: plan.nextOpportunityAt, budgetDimension: spend.dimension };
    }
    // 金额在预留时已计入消费行（不是「预留待还」）；把这张 0/0 凭据结清，
    // 免得它在 TTL 里被当成「在途许可」。
    await settleBudget(deps.budget, spend.grant, { requestStarted: true, actualTokens: 0 });
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
  // 预留凭据必须绑定到这条动作：没有绑定的记录不能给许可背书（防「借别人的凭据」）。
  // 绑定失败 = 账本与凭据对不上，宁可不落动作（fail closed），也不签一张无依据的许可。
  const bound = await deps.budget
    .bindReservation({
      reservationId: reservation.grant.reservationId,
      actionId: action.id,
      charId,
      windowId: action.windowId,
      nowMs,
    })
    .catch(() => false);
  if (!bound) {
    const next = nextRevision({
      ...row,
      needs: nextNeeds,
      lastEvaluatedAt: nowMs,
      availability: 'limited',
      reasonCodes: ['MODEL_FAILED'],
      nextCheckAt: nowMs + 30 * 60_000,
    });
    await deps.store.putCharacterLife(next, row.revision);
    return { ...baseResult('model_failed', ['MODEL_FAILED'], 1), budgetDimension: 'reservation_not_bound' };
  }
  await deps.store.insertAction(action);
  // 这份本地候选已经变成动作：回收掉，别在 TTL 内被下一轮再排一次（同一笔钱）。
  if (isMarketProposalKind(chosen.kind) && deps.consumeLocalCandidates) {
    await deps.consumeLocalCandidates(charId, chosen.kind).catch(() => undefined);
  }

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

/** 读真实人设信号：读失败/没配 = 没有信号（不把「读不到」当成「人设没变」）。 */
async function readPersonaSignal(deps: EngineDeps, charId: string): Promise<PersonaSignal> {
  if (!deps.personaFor) return normalizePersonaSignal(null);
  const raw = await deps.personaFor(charId).catch(() => null);
  return normalizePersonaSignal(raw);
}

/**
 * profile 的失效比较必须拿**当前真实信号**的哈希比，而不是拿旧 profile 自己的哈希
 * 跟自己比（那样人设改了也永远「没变」）。三方比较：人设身份哈希 / 时区 / 摘要哈希。
 */
function resolveProfile(
  row: CharacterLifeRow,
  charId: string,
  nowMs: number,
  signal: PersonaSignal,
): { profile: RhythmProfile; rebuilt: boolean } {
  const identity = {
    personaHash: personaHashOf(charId, signal),
    timezone: row.windowTimezone,
    summaryHash: hashString(`${signal.personaText}\n${signal.scheduleText}`),
  };
  if (row.profile && !isProfileStale(row.profile, identity)) {
    return { profile: row.profile, rebuilt: false };
  }
  return {
    profile: buildRhythmProfile({
      personaText: signal.personaText,
      scheduleText: signal.scheduleText,
      // 结构化睡眠窗优先：文本里的普通时段（上班/起床/午休）不会被当成整段睡眠。
      scheduleSleepWindow: signal.sleepWindow,
      timezone: row.windowTimezone,
      personaHash: identity.personaHash,
      nowMs,
    }),
    rebuilt: true,
  };
}

/** 同类同语义候选只留第一条：模型与设备候选撞车时不重复计分。 */
function dedupeCandidates(list: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const candidate of list) {
    const key = `${candidate.kind}|${candidate.semanticPurpose}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
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
    permitNonce: null,
    permitConsumedAt: null,
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
  permit?: ExecutionPermit;
  /** 条件提交后的动作行（status=running + 许可字段）。执行器必须用这一份，不能用 claim 时的旧快照。 */
  action?: ActionRow;
  /** 精确的拒绝原因（window_mismatch / reservation_* 等），只用于诊断，不参与判定。 */
  detail?: string;
}

/**
 * commit-permit：暂停/策略/租约/参数/预算的**服务端条件提交**是并发线性化点。
 *
 * 这里做两件事，顺序不能换：
 *   1. 先用当前读到的状态给出精确失败原因（哪个门拒的），非破坏性、无写入；
 *   2. 把最终写入交给 `store.commitPermitAtomic`——它在同一个事务里再读一次账号暂停、
 *      角色暂停，并对动作行做 CAS；期间用户按了暂停就整笔失败，不会出现
 *      「看着没暂停就发了许可、发完才发现刚暂停」的时序洞。
 *
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
  const action = await deps.store.getAction(args.actionId);
  if (!action) return { ok: false, code: 'NOT_FOUND' };
  if (!args.installationId) return { ok: false, code: 'FORBIDDEN' };
  if (action.status === 'unknown') return { ok: false, code: 'UNKNOWN_EFFECT' };
  if (isTerminalActionStatus(action.status)) return { ok: false, code: 'STATE_CONFLICT' };
  if (!action.charId) return { ok: false, code: 'FORBIDDEN' };
  if (!action.installationId) return { ok: false, code: 'FORBIDDEN' };
  if (action.installationId !== args.installationId) return { ok: false, code: 'FORBIDDEN' };
  // 暂停优先于其它原因报出来：已经按下暂停的动作不该再说「状态冲突」。
  const pause = await deps.store.getAccountPause(args.accountId);
  if (pause.paused) return { ok: false, code: 'GLOBAL_PAUSED' };
  const life = await deps.store.getCharacterLife(action.charId);
  if (life?.pauseRequestedAt != null) return { ok: false, code: 'GLOBAL_PAUSED' };

  // 只有「真的被设备领到、租约仍在、还没发过许可」的动作能签许可。
  // 裸的 scheduled 行（没 claim）没有 installationId / leaseEpoch=0 / leaseExpiresAt=null，
  // 一律拒——否则「跳过 claim 直接 commit」就是一条绕过线。
  if (action.status !== 'scheduled') return { ok: false, code: 'STATE_CONFLICT' };
  if (!Number.isInteger(action.leaseEpoch) || action.leaseEpoch < 1) return { ok: false, code: 'STATE_CONFLICT' };
  if (action.leaseExpiresAt === null) return { ok: false, code: 'STATE_CONFLICT' };
  if (nowMs > action.leaseExpiresAt) return { ok: false, code: 'STATE_CONFLICT' };
  if (nowMs > action.expiresAt) return { ok: false, code: 'STATE_CONFLICT' };
  if (action.argsHash !== args.argsHash) return { ok: false, code: 'STATE_CONFLICT' };
  // 参数自证：动作行里的参数与被批准的 hash 必须一致（防止只换参数不换 hash）。
  if (hashArgs(action.args) !== args.argsHash) return { ok: false, code: 'STATE_CONFLICT' };
  if (action.policyVersion !== args.policyVersion) return { ok: false, code: 'STATE_CONFLICT' };
  // 许可不许「转发式复用」：已被别的租约/已消费过的许可不能再发；
  // 已发过许可的动作也不再签第二张（一次动作一张许可）。
  if (action.permitIssuedAt !== null || action.permitConsumedAt !== null) {
    return { ok: false, code: 'STATE_CONFLICT' };
  }

  // 边界：暂停/关闭/角色禁用/kind 白名单。
  const boundary = await deps.boundaryFor(action.charId);
  if (boundary.globalPaused || boundary.enabled === false) return { ok: false, code: 'GLOBAL_PAUSED' };
  if (boundary.charEnabled === false) return { ok: false, code: 'CHAR_DISABLED' };
  const kindGate = boundaryGate(boundary, action.kind);
  if (!kindGate.ok) return { ok: false, code: kindGate.code };

  // 策略：签发前再跑一次第一道判定（禁止方向 / PII / 外部授权）。
  const decision = checkIntentPolicy(
    {
      kind: action.kind,
      args: action.args,
      purpose: action.semanticPurpose,
      boundary: {
        forbiddenCategories: boundary.forbiddenCategories,
        avoidTopics: boundary.avoidTopics,
        allowFictionalNpc: boundary.allowFictionalNpc,
        externalGrants: boundary.externalGrants,
      },
    },
    nowMs,
  );
  if (!decision.allowed) {
    return { ok: false, code: decision.reasonCode === 'grant_missing' ? 'GRANT_REQUIRED' : 'POLICY_DENIED' };
  }

  // 预算：端口不可用 → fail closed；预留凭据必须能按 id 查到真实记录、绑定本动作、
  // 未释放未过期（不是「本窗口有过任意用量」）。
  if (!deps.budget.available()) return { ok: false, code: 'SERVICE_UNAVAILABLE' };
  const windowTimezone = life?.windowTimezone ?? boundary.timezone;
  const currentWindow = windowIdAt({ now: () => nowMs }, windowTimezone);
  if (action.windowId !== currentWindow) return { ok: false, code: 'STATE_CONFLICT', detail: 'window_mismatch' };

  const hold = await verifyReservationHold(deps.budget, {
    reservationId: action.reservationId,
    ownerId: args.accountId,
    windowId: currentWindow,
    charId: action.charId,
    actionId: action.id,
    nowMs,
    timezone: windowTimezone,
  });
  if (!hold.ok) return { ok: false, code: 'STATE_CONFLICT', detail: hold.reason };

  const expiresAt = nowMs + PERMIT_TTL_MS;
  const nonce = `nonce_${action.id}_${action.leaseEpoch}_${nowMs.toString(36)}_${hashString(`${action.argsHash}|${action.leaseEpoch}|${nowMs}`)}`;
  const committed = await deps.store.commitPermitAtomic({
    accountId: args.accountId,
    actionId: action.id,
    charId: action.charId,
    installationId: args.installationId,
    leaseEpoch: args.leaseEpoch,
    argsHash: args.argsHash,
    policyVersion: args.policyVersion,
    nowMs,
    expiresAt,
    nonce,
    expectedRevision: action.revision,
    expectedWindowId: currentWindow,
    expectedAccountBoundaryRevision: boundary.accountRevision ?? null,
    expectedCharacterBoundaryRevision: boundary.characterRevision ?? null,
    expectedReservationRevision: hold.revision ?? null,
  });
  if (!committed.ok) return { ok: false, code: committed.code };
  const next = committed.action;
  return {
    ok: true,
    action: next,
    permit: {
      actionId: next.id,
      charId: next.charId,
      installationId: args.installationId,
      leaseEpoch: next.leaseEpoch,
      argsHash: next.argsHash,
      policyVersion: next.policyVersion,
      reservationId: next.reservationId,
      issuedAt: nowMs,
      expiresAt: next.leaseExpiresAt ?? expiresAt,
      nonce: next.permitNonce ?? nonce,
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

/**
 * 回执上报：只有「已发许可 + 同一个 argsHash + 同一安装」的回执才被接受。
 *
 * 三条硬条件，缺一条就整笔拒绝（一个字节都不写）：
 *   1. `action.permitIssuedAt !== null` 且 `action.status === 'running'`：没发过许可的动作
 *      不存在「已完成」，先报 succeeded 的一律当伪造；
 *   2. `report.argsHash === action.argsHash`：回执必须对齐**已发许可的那组参数**，
 *      不然就是拿另一个动作的结果来顶账；
 *   3. 安装 id 与动作行一致：换了设备不能替别人收尾。
 * succeeded 还要求非空 resultRef —— 没有本地回执就别声称效果已验证。
 */
export async function reportReceipt(deps: EngineDeps, report: ReceiptReport): Promise<{ ok: boolean; code?: AutonomyLifeErrorCode; action?: ActionRow }> {
  const nowMs = report.nowMs ?? (deps.clock ?? systemClock).now();
  const action = await deps.store.getAction(report.actionId);
  if (!action) return { ok: false, code: 'NOT_FOUND' };
  if (action.installationId && action.installationId !== report.installationId) return { ok: false, code: 'FORBIDDEN' };
  if (action.leaseEpoch !== report.leaseEpoch) return { ok: false, code: 'STATE_CONFLICT' };
  if (report.argsHash !== action.argsHash) return { ok: false, code: 'STATE_CONFLICT' };
  if (report.status === 'succeeded' && !(typeof report.resultRef === 'string' && report.resultRef.length > 0)) {
    return { ok: false, code: 'VALIDATION_FAILED' };
  }
  if (isTerminalActionStatus(action.status) && action.status !== 'unknown') {
    // 回执幂等：同一结果重复上报返回原动作。
    if (action.resultRef === (report.resultRef ?? action.resultRef)) return { ok: true, action };
    return { ok: false, code: 'STATE_CONFLICT' };
  }
  if (action.permitIssuedAt === null || (action.status !== 'running' && action.status !== 'unknown')) {
    // 没有许可就不存在「执行过」：这是伪造回执，不是晚到的回执。
    return { ok: false, code: 'STATE_CONFLICT' };
  }
  const status: ActionStatus = report.status === 'succeeded' ? 'succeeded' : report.status === 'unknown' ? 'unknown' : 'failed';
  const next: ActionRow = {
    ...action,
    status,
    resultRef: report.status === 'succeeded' ? report.resultRef ?? null : action.resultRef,
    errorCode: report.status === 'succeeded' ? null : report.errorCode ?? (report.status === 'unknown' ? 'UNKNOWN_EFFECT' : 'MODEL_FAILED'),
    leaseExpiresAt: null,
    permitConsumedAt: action.permitConsumedAt ?? nowMs,
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
    /**
     * 内存实现的「原子」许可提交：JS 单线程 + 这里没有任何 await 夹在读与写之间，
     * 因此检查与写入不会被别的 tick 插进来（与 D1 的条件 UPDATE 语义一致）。
     */
    async commitPermitAtomic(input) {
      const pause = accountPause.get(input.accountId) ?? { paused: false, requestedAt: null };
      if (pause.paused) return { ok: false, code: 'GLOBAL_PAUSED' as const };
      const life = characters.get(input.charId);
      if (life && life.pauseRequestedAt !== null) return { ok: false, code: 'GLOBAL_PAUSED' as const };
      const current = actions.get(input.actionId);
      if (!current) return { ok: false, code: 'NOT_FOUND' as const };
      if (current.revision !== input.expectedRevision) return { ok: false, code: 'STATE_CONFLICT' as const };
      if (current.charId !== input.charId) return { ok: false, code: 'FORBIDDEN' as const };
      if (!input.installationId || !current.installationId || current.installationId !== input.installationId) {
        return { ok: false, code: 'FORBIDDEN' as const };
      }
      if (isTerminalActionStatus(current.status)) return { ok: false, code: 'STATE_CONFLICT' as const };
      // 只有「已 claim 且未发许可」的动作能发许可。
      if (current.status !== 'scheduled') return { ok: false, code: 'STATE_CONFLICT' as const };
      if (current.permitIssuedAt !== null) return { ok: false, code: 'STATE_CONFLICT' as const };
      if (current.leaseEpoch !== input.leaseEpoch || current.leaseEpoch < 1) return { ok: false, code: 'STATE_CONFLICT' as const };
      if (current.leaseExpiresAt === null || input.nowMs > current.leaseExpiresAt) {
        return { ok: false, code: 'STATE_CONFLICT' as const };
      }
      if (input.nowMs > current.expiresAt) return { ok: false, code: 'STATE_CONFLICT' as const };
      if (current.windowId !== input.expectedWindowId) return { ok: false, code: 'STATE_CONFLICT' as const };
      if (current.argsHash !== input.argsHash) return { ok: false, code: 'STATE_CONFLICT' as const };
      if (current.policyVersion !== input.policyVersion) return { ok: false, code: 'STATE_CONFLICT' as const };
      if (current.permitConsumedAt !== null) return { ok: false, code: 'STATE_CONFLICT' as const };
      const next: ActionRow = {
        ...current,
        status: 'running',
        permitIssuedAt: input.nowMs,
        permitNonce: input.nonce,
        permitConsumedAt: null,
        leaseExpiresAt: input.expiresAt,
        revision: current.revision + 1,
      };
      actions.set(next.id, next);
      return { ok: true, action: { ...next } };
    },
  };
}

/** 供 worker 侧复用的指纹助手（去重记录的补充指纹）。 */
export function recentFingerprint(candidate: Candidate): string {
  return fingerprintOf(candidate);
}
