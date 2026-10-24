/**
 * 自主生活（autonomy life）v1 共享契约。
 *
 * 依据：autonomous-life-contract-v1.md（设计定稿）。本文件只放**前端与 worker 都要的**
 * 纯契约：种类、状态机、边界字段、错误码、信封与稳定哈希。不含任何 React / IDB / D1 依赖，
 * 因此前端 bundle、worker bundle 与 vitest 都能直接 import。
 *
 * 刻意不做的事：
 *   - 不定义「频率/周期/活跃度」字段。用户只能定边界（allowedKinds / limits / 禁止方向 /
 *     免打扰 / 外部授权），行动时机由 utils/autonomyLife/rhythm.ts 的人设节奏 + 情境决定。
 *   - 不定义真实支付、真实发帖、任意 URL 抓取这些能力。真实交易/外部写入一律
 *     CAPABILITY_UNAVAILABLE，UI 不得造出假确认按钮。
 */

/** 所有响应/对象都带这个版本号；改形状必须升版本并写迁移。 */
export const AUTONOMY_LIFE_SCHEMA_VERSION = 1 as const;

/** 逻辑基址（挂在既有 amsg worker 的认证路由前缀下）。 */
export const AUTONOMY_LIFE_API_BASE = '/autonomy-life/v1';

/** 首期核心内部活动（OS 内模拟或本地业务写入）。 */
export const CORE_ACTIVITY_KINDS = [
  'journal.write',
  'room.plan',
  'room.note',
  'phone.record',
  'takeout.order',
  'shopping.order',
  'interaction.message',
] as const;

/** 首期受控外部窗口（默认关闭，需要显式授权 + 能力探测通过）。 */
export const CONTROLLED_EXTERNAL_KINDS = ['travel.wish', 'external.read'] as const;

export const ACTIVITY_KINDS = [...CORE_ACTIVITY_KINDS, ...CONTROLLED_EXTERNAL_KINDS] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export type ExecutionMode = 'cloud' | 'local';
export type ActionScope = 'os_simulation' | 'external_read';
export type ActionBasis = 'virtual' | 'inference';
export type ActionSource = 'autonomy_round' | 'chat_reply' | 'rhythm' | 'user_request' | 'legacy';

export function isActivityKind(value: unknown): value is ActivityKind {
  return typeof value === 'string' && (ACTIVITY_KINDS as readonly string[]).includes(value);
}

/** kind → 执行位置。首期所有 kind 的副作用都在本地事务里完成。 */
export const KIND_EXECUTION_MODE: Record<ActivityKind, ExecutionMode> = {
  'journal.write': 'local',
  'room.plan': 'local',
  'room.note': 'local',
  'phone.record': 'local',
  'takeout.order': 'local',
  'shopping.order': 'local',
  'interaction.message': 'local',
  'travel.wish': 'local',
  'external.read': 'local',
};

export const KIND_SCOPE: Record<ActivityKind, ActionScope> = {
  'journal.write': 'os_simulation',
  'room.plan': 'os_simulation',
  'room.note': 'os_simulation',
  'phone.record': 'os_simulation',
  'takeout.order': 'os_simulation',
  'shopping.order': 'os_simulation',
  'interaction.message': 'os_simulation',
  'travel.wish': 'os_simulation',
  'external.read': 'external_read',
};

// ─── 动作状态机 ──────────────────────────────────────────────────────────────

export const ACTION_STATUSES = [
  'proposed',
  'scheduled',
  'waiting_device',
  'awaiting_confirmation',
  'running',
  'succeeded',
  'failed',
  'unknown',
  'blocked',
  'expired',
  'cancelled',
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const TERMINAL_ACTION_STATUSES = ['succeeded', 'failed', 'unknown', 'expired', 'cancelled'] as const;
export type TerminalActionStatus = (typeof TERMINAL_ACTION_STATUSES)[number];

export function isTerminalActionStatus(status: ActionStatus): status is TerminalActionStatus {
  return (TERMINAL_ACTION_STATUSES as readonly string[]).includes(status);
}

/**
 * 合法迁移表。终态不倒退：succeeded/failed/expired/cancelled 没有任何出边；
 * unknown 只能经「对账」落到 succeeded 或 confirmed_no_effect（后者用 failed + 
 * errorCode=CONFIRMED_NO_EFFECT 表达），再由用户决定是否重新提出新动作。
 */
export const ACTION_TRANSITIONS: Record<ActionStatus, readonly ActionStatus[]> = {
  proposed: ['scheduled', 'blocked', 'expired', 'cancelled', 'awaiting_confirmation'],
  scheduled: ['waiting_device', 'running', 'blocked', 'expired', 'cancelled', 'awaiting_confirmation'],
  waiting_device: ['scheduled', 'blocked', 'expired', 'cancelled'],
  awaiting_confirmation: ['scheduled', 'blocked', 'expired', 'cancelled'],
  running: ['succeeded', 'failed', 'unknown'],
  succeeded: [],
  failed: [],
  unknown: ['succeeded', 'failed'],
  blocked: ['scheduled', 'expired', 'cancelled'],
  expired: [],
  cancelled: [],
};

export function canTransitionAction(from: ActionStatus, to: ActionStatus): boolean {
  if (from === to) return true;
  return ACTION_TRANSITIONS[from].includes(to);
}

/** 有副作用许可之后仍在跑的 running：取消不承诺成功，返回 CANNOT_CANCEL。 */
export const CANCELLABLE_STATUSES: readonly ActionStatus[] = [
  'proposed', 'scheduled', 'waiting_device', 'awaiting_confirmation', 'blocked',
];

// ─── 错误码（服务端与前端共用；不得造新码给 UI 猜） ─────────────────────────

export const AUTONOMY_LIFE_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'REVISION_CONFLICT',
  'STATE_CONFLICT',
  'VALIDATION_FAILED',
  'DEPRECATED_FIELD',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'IDEMPOTENCY_CONFLICT',
  'AUTONOMY_UPGRADE_REQUIRED',
  'GLOBAL_PAUSED',
  'CHAR_DISABLED',
  'BUDGET_EXHAUSTED',
  'POLICY_DENIED',
  'MISSING_CREDENTIALS',
  'WAITING_DEVICE',
  'CAPABILITY_UNAVAILABLE',
  'MODEL_FAILED',
  'CIRCUIT_OPEN',
  'GRANT_REQUIRED',
  'GRANT_EXPIRED',
  'UNKNOWN_EFFECT',
  'CANNOT_CANCEL',
] as const;
export type AutonomyLifeErrorCode = (typeof AUTONOMY_LIFE_ERROR_CODES)[number];

/** 前端 reasonCodes（CharacterLifeState.reasonCodes）使用的稳定值。 */
export const LIFE_REASON_CODES = [
  'GLOBAL_PAUSED',
  'CHAR_DISABLED',
  'PAUSING',
  'BUDGET_EXHAUSTED',
  'TOKEN_BUDGET_EXHAUSTED',
  'QUIET_HOURS',
  'SLEEPING',
  'WAITING_DEVICE',
  'MISSING_CREDENTIALS',
  'CAPABILITY_UNAVAILABLE',
  'CIRCUIT_OPEN',
  'MODEL_FAILED',
  'POLICY_DENIED',
  'GRANT_REQUIRED',
  'NO_CANDIDATE',
  'RESTING',
] as const;
export type LifeReasonCode = (typeof LIFE_REASON_CODES)[number];

// ─── 边界 v1 ─────────────────────────────────────────────────────────────────

export type BoundaryScope = 'account' | 'character';

/**
 * 用户可设的上限。全部非负整数；0 = 明确禁止；null = 继承（只允许出现在角色层）。
 * 没有「无限制」取值，也没有任何「频率」字段。
 */
export interface AutonomyLimits {
  accountModelCallsPerDay: number | null;
  charModelCallsPerDay: number | null;
  accountTokensPerDay: number | null;
  charTokensPerDay: number | null;
  notificationsPerDay: number | null;
  perKindActionsPerDay: number | null;
  virtualSpendPerDayMinor: number | null;
  virtualOrderMaxMinor: number | null;
}

export const LIMIT_KEYS = [
  'accountModelCallsPerDay',
  'charModelCallsPerDay',
  'accountTokensPerDay',
  'charTokensPerDay',
  'notificationsPerDay',
  'perKindActionsPerDay',
  'virtualSpendPerDayMinor',
  'virtualOrderMaxMinor',
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

/** 账号层默认值（= 既有护栏的更严终值；新字段没设置也不能偷偷放宽旧用户预算）。 */
export const DEFAULT_ACCOUNT_LIMITS: Record<LimitKey, number> = {
  accountModelCallsPerDay: 6,
  charModelCallsPerDay: 2,
  accountTokensPerDay: 100_000,
  charTokensPerDay: 40_000,
  notificationsPerDay: 1,
  perKindActionsPerDay: 3,
  virtualSpendPerDayMinor: 20_000,
  virtualOrderMaxMinor: 5_000,
};

/** 结构天花板：再怎么配也不能超过。UI 只读展示。 */
export const MAXIMUM_ACCOUNT_LIMITS: Record<LimitKey, number> = {
  accountModelCallsPerDay: 24,
  charModelCallsPerDay: 12,
  accountTokensPerDay: 1_000_000,
  charTokensPerDay: 400_000,
  notificationsPerDay: 8,
  perKindActionsPerDay: 12,
  virtualSpendPerDayMinor: 500_000,
  virtualOrderMaxMinor: 100_000,
};

export const CURRENCY_DEFAULT = 'CNY';

export interface DoNotDisturb {
  timezone: string;
  start: string; // HH:mm
  end: string;   // HH:mm
}

export interface ExternalGrant {
  provider: 'xhs' | 'amap';
  scopes: string[];        // 只读 scope：read:search / read:note / read:geo …
  allowedHosts: string[];
  allowedMethods: string[];
  allowedFieldKeys: string[]; // 允许发出的字段白名单（不发聊天全文/地址/联系人）
  purpose: string;
  expiresAt: number;       // UTC ms
  dailyQuota: number;
}

export interface BoundaryV1 {
  schemaVersion: typeof AUTONOMY_LIFE_SCHEMA_VERSION;
  revision: number;
  scope: BoundaryScope;
  /** 账号层：自主总开关；角色层：该角色是否参与。null = 继承。 */
  enabled: boolean | null;
  globalPaused: boolean | null;
  charEnabled: boolean | null;
  timezone: string | null;
  allowedKinds: ActivityKind[] | null;
  forbiddenCategories: string[];
  avoidTopics: string[];
  allowFictionalNpc: boolean | null;
  doNotDisturb: DoNotDisturb | null;
  limits: AutonomyLimits;
  externalGrants: ExternalGrant[];
}

/** 生效后的边界：所有 null 都已落成具体值。 */
export interface EffectiveBoundaryV1 extends BoundaryV1 {
  scope: 'account';
  enabled: boolean;
  globalPaused: boolean;
  charEnabled: boolean;
  timezone: string;
  allowedKinds: ActivityKind[];
  allowFictionalNpc: boolean;
}

/** 用户改这些字段一律 422 DEPRECATED_FIELD —— 频率/周期不是边界。 */
export const DEPRECATED_BOUNDARY_FIELDS = [
  'frequency',
  'cadence',
  'cadenceMinHours',
  'cadenceMaxHours',
  'minHours',
  'maxHours',
  'sameKindMinGap',
  'sameKindMinGapMinutes',
  'perCharPerDay',
  'globalPerDay',
  'maxRoundsPerDay',
  'dailyRounds',
  'intervalMinutes',
  'activeLevel',
  'activityLevel',
  'templateId',
  'reserveTokensPerRun',
  'autonomyLevel',
] as const;

/** 首期平台硬禁（用户不能取消，只能追加）。 */
export const PLATFORM_FORBIDDEN_CATEGORIES = [
  'gambling',
  'betting_promotion',
  'real_finance',
  'illegal_trade',
  'credential_theft',
] as const;
export type ForbiddenCategory = (typeof PLATFORM_FORBIDDEN_CATEGORIES)[number] | (string & {});

// ─── 状态 / 活动记录 / 事件 ──────────────────────────────────────────────────

export type LifePhase = 'resting' | 'idle' | 'engaged' | 'waiting';
export type LifeAvailability = 'ready' | 'disabled' | 'pausing' | 'paused' | 'limited' | 'error';

export interface BudgetUsage {
  /**
   * model_calls / tokens / virtual_spend 是**角色层**用量；model_calls_account 是账号层
   * 合计（多角色公平轮转看这个），别把两个层级的数混成一格。
   */
  dimension: 'model_calls' | 'model_calls_account' | 'tokens' | 'notifications' | 'virtual_spend';
  used: number;
  reserved: number;
  limit: number;
  unit?: string;
}

export interface Capability {
  kind: ActivityKind;
  appId: string;
  available: boolean;
  enabled: boolean;
  executionMode: ExecutionMode;
  requiresForeground: boolean;
  requiresGrant: boolean;
  unavailableReason?: string;
}

export interface CharacterLifeState {
  schemaVersion: typeof AUTONOMY_LIFE_SCHEMA_VERSION;
  charId: string;
  revision: number;
  observedAt: number;
  lifePhase: LifePhase;
  availability: LifeAvailability;
  reasonCodes: LifeReasonCode[];
  nextOpportunityAt: number | null;
  nextCheckAt: number | null;
  scheduleConfidence: 'fallback' | 'persona';
  activeActionId: string | null;
  pendingCount: number;
  budgetWindowId: string | null;
  budget: BudgetUsage[];
}

export interface ActivityRecord {
  schemaVersion: typeof AUTONOMY_LIFE_SCHEMA_VERSION;
  id: string;
  charId: string;
  kind: ActivityKind;
  scope: ActionScope;
  source: ActionSource;
  sourceRef: string | null;
  status: ActionStatus;
  reasonSummary: string;
  occurredAt: number;
  updatedAt: number;
  resultRef: string | null;
  effectVerified: boolean;
  notificationState: 'none' | 'queued' | 'delivered' | 'not_delivered';
  errorCode: AutonomyLifeErrorCode | null;
  canCancel: boolean;
}

export const LIFE_EVENT_TYPES = [
  'life.state.changed',
  'action.changed',
  'boundary.changed',
  'budget.changed',
  'grant.changed',
  'capability.changed',
] as const;
export type LifeEventType = (typeof LIFE_EVENT_TYPES)[number];

export interface LifeEvent {
  eventId: string;
  sequence: number;
  type: LifeEventType;
  charId: string | null;
  actionId: string | null;
  revision: number;
  occurredAt: number;
  /** 最小补丁/资源引用；不含正文、地址、密钥。 */
  data: Record<string, unknown>;
}

// ─── 适配器契约 ─────────────────────────────────────────────────────────────

export interface AdapterIntent {
  kind: ActivityKind;
  charId: string;
  args: Record<string, unknown>;
}

export type ValidateIntentResult =
  | { ok: true; args: Record<string, unknown>; argsHash: string }
  | { ok: false; code: AutonomyLifeErrorCode; reason: string };

export interface PreparedEffect {
  /** 人可读的结果摘要（UI 展示），不含地址等隐私正文。 */
  summary: string;
  /** 只读预计算：本地事务里要写的关键数字，用于预算/额度预检。 */
  spendMinor?: number;
  resourceHints?: Record<string, string>;
}

export interface ExecuteContext {
  actionId: string;
  charId: string;
  kind: ActivityKind;
  args: Record<string, unknown>;
  argsHash: string;
  policyVersion: string;
  installationId: string;
  /** 本地事务提交后写入的 action receipt 主键 = actionId。 */
  nowMs: number;
}

export interface ExecuteResult {
  status: 'succeeded' | 'failed' | 'unknown';
  resultRef?: string | null;
  errorCode?: AutonomyLifeErrorCode;
  /** 只有拿到可信本地回执/记录才算 effectVerified。 */
  effectVerified: boolean;
}

// ─── 信封 / 错误 / 工具 ─────────────────────────────────────────────────────

export interface ApiErrorBody {
  error: {
    code: AutonomyLifeErrorCode;
    message: string;
    retryable: boolean;
    retryAt?: number;
    details?: Record<string, unknown>;
  };
  requestId: string;
  serverTime: number;
  schemaVersion: typeof AUTONOMY_LIFE_SCHEMA_VERSION;
}

export const RETRYABLE_ERROR_CODES: readonly AutonomyLifeErrorCode[] = [
  'SERVICE_UNAVAILABLE', 'RATE_LIMITED', 'MODEL_FAILED', 'CIRCUIT_OPEN', 'WAITING_DEVICE',
];

export function buildErrorBody(
  code: AutonomyLifeErrorCode,
  message: string,
  opts: { requestId: string; serverTime: number; retryAt?: number; details?: Record<string, unknown> },
): ApiErrorBody {
  const retryable = RETRYABLE_ERROR_CODES.includes(code);
  return {
    error: {
      code,
      message,
      retryable,
      ...(opts.retryAt !== undefined ? { retryAt: opts.retryAt } : {}),
      ...(opts.details ? { details: opts.details } : {}),
    },
    requestId: opts.requestId,
    serverTime: opts.serverTime,
    schemaVersion: AUTONOMY_LIFE_SCHEMA_VERSION,
  };
}

/** 错误码 → HTTP 状态。业务「已登记但受限」用 200 + status/reason，不进这张表。 */
export function httpStatusForError(code: AutonomyLifeErrorCode): number {
  switch (code) {
    case 'UNAUTHENTICATED':
      return 401;
    case 'FORBIDDEN':
    case 'POLICY_DENIED':
    case 'CHAR_DISABLED':
    case 'GLOBAL_PAUSED':
    case 'GRANT_REQUIRED':
    case 'GRANT_EXPIRED':
    case 'CIRCUIT_OPEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'REVISION_CONFLICT':
    case 'STATE_CONFLICT':
    case 'IDEMPOTENCY_CONFLICT':
    case 'CANNOT_CANCEL':
    case 'UNKNOWN_EFFECT':
      return 409;
    case 'VALIDATION_FAILED':
    case 'DEPRECATED_FIELD':
      return 422;
    case 'AUTONOMY_UPGRADE_REQUIRED':
      return 426;
    case 'RATE_LIMITED':
    case 'BUDGET_EXHAUSTED':
      return 429;
    case 'SERVICE_UNAVAILABLE':
    case 'MISSING_CREDENTIALS':
    case 'MODEL_FAILED':
    case 'CAPABILITY_UNAVAILABLE':
      return 503;
    case 'WAITING_DEVICE':
      return 409;
    default:
      return 400;
  }
}

/** 稳定序列化：键排序、跳过 undefined，保证 argsHash 跨端一致。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/** FNV-1a 32 位；只用于哈希/去重键，不做安全用途。 */
export function hashString(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function hashArgs(args: unknown): string {
  return hashString(stableStringify(args));
}

/** 稳定去重键：同角色 + 同 kind + 同语义目的 + 同一本地日只允许一个主动动作。 */
export function actionDedupeKey(args: {
  charId: string;
  kind: ActivityKind;
  purposeKey: string;
  localDateKey: string;
}): string {
  return hashString(`${args.charId}|${args.kind}|${args.purposeKey}|${args.localDateKey}`);
}

/** 契约版本比较：服务端发现旧客户端时返回 426（旧频率客户端不得继续制造副作用）。 */
export function requiresUpgrade(clientSchemaVersion: number | null | undefined): boolean {
  return typeof clientSchemaVersion !== 'number' || clientSchemaVersion < AUTONOMY_LIFE_SCHEMA_VERSION;
}
