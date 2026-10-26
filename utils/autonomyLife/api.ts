/**
 * 自主生活（/autonomy-life/v1）· 前端 único HTTP 客户端。
 *
 * 为什么单独一层：
 *   - 契约要求「前端通过 activeMsgClient 新增封装，禁止各页面手拼 URL」；这里把
 *     §7 的每个端点收敛成方法，页面/组件只认类型，不认路径。
 *   - 认证必须来自既有通道（worker 的 X-Client-Token / 会话），页面自报 ownerId
 *     一律不作数；`resolveEndpoint()` 由运行期接线提供，未配置就是 fail-closed。
 *   - 服务端回什么都在这里先过形状校验：形状不符一律 MALFORMED_RESPONSE，
 *     宁可显示「状态暂无法确认」，也不半截渲染成真实活动。
 *
 * 刻意不做的事：
 *   - 不定义任何「频率 / 周期 / 活跃度 / 同类冷却」写入口。`DEPRECATED_BOUNDARY_FIELDS`
 *     是硬闸：一旦有调用方试图把它们塞进 PATCH，本地就拒绝并报错，不等服务端 422。
 *   - 不替 UI 造成功状态：所有写请求只在服务端回包校验通过后返回 ok。
 */

import {
  AUTONOMY_LIFE_API_BASE,
  AUTONOMY_LIFE_ERROR_CODES,
  AUTONOMY_LIFE_SCHEMA_VERSION,
  DEPRECATED_BOUNDARY_FIELDS,
  isActivityKind,
  type ActionScope,
  type ActionSource,
  type ActionStatus,
  type ActivityKind,
  type ActivityRecord,
  type AutonomyLimits,
  type BoundaryScope,
  type BoundaryV1,
  type BudgetUsage,
  type Capability,
  type CharacterLifeState,
  type ClientProposalInput,
  type EffectiveBoundaryV1,
  type ExternalGrant,
  type LifeAvailability,
  type LifeEvent,
  type LifeEventType,
  type LifePhase,
  type LifeReasonCode,
  type AutonomyLifeErrorCode,
  type ExecutionPermit,
} from '../../contracts/autonomyLife';

/** 逻辑基址之上的路径片段。集中一处，服务端路由若调整只改这里。 */
export const AUTONOMY_LIFE_PATHS = {
  state: (charId: string) => `${AUTONOMY_LIFE_API_BASE}/characters/${encodeURIComponent(charId)}/state`,
  boundaries: (charId?: string) =>
    charId
      ? `${AUTONOMY_LIFE_API_BASE}/boundaries?charId=${encodeURIComponent(charId)}`
      : `${AUTONOMY_LIFE_API_BASE}/boundaries`,
  pause: () => `${AUTONOMY_LIFE_API_BASE}/pause`,
  activities: () => `${AUTONOMY_LIFE_API_BASE}/activities`,
  events: () => `${AUTONOMY_LIFE_API_BASE}/events`,
  cancel: (id: string) => `${AUTONOMY_LIFE_API_BASE}/actions/${encodeURIComponent(id)}/cancel`,
  resolveConfirmation: (id: string) =>
    `${AUTONOMY_LIFE_API_BASE}/confirmations/${encodeURIComponent(id)}/resolve`,
  registerDevice: () => `${AUTONOMY_LIFE_API_BASE}/devices/register`,
  claim: () => `${AUTONOMY_LIFE_API_BASE}/execution/claim`,
  commitPermit: (id: string) => `${AUTONOMY_LIFE_API_BASE}/actions/${encodeURIComponent(id)}/commit-permit`,
  receipt: (id: string) => `${AUTONOMY_LIFE_API_BASE}/actions/${encodeURIComponent(id)}/receipt`,
  externalRead: () => `${AUTONOMY_LIFE_API_BASE}/external/read`,
  externalWish: () => `${AUTONOMY_LIFE_API_BASE}/external/wish`,
  proposals: () => `${AUTONOMY_LIFE_API_BASE}/proposals`,
} as const;

/** 客户端本地失败码（不是服务端错误码，永不发给服务端）。 */
export type AutonomyLifeClientErrorCode =
  | 'NOT_CONFIGURED'
  | 'NETWORK'
  | 'MALFORMED_RESPONSE'
  | 'DEPRECATED_FIELD_SENT';

export type AutonomyLifeApiErrorCode = AutonomyLifeErrorCode | AutonomyLifeClientErrorCode;

export type AutonomyLifeApiResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      code: AutonomyLifeApiErrorCode;
      status: number;
      retryable?: boolean;
      retryAt?: number | null;
      message?: string;
      requestId?: string;
    };

/** 运行期接线：worker 根地址 + 既有认证头。未能确定 → 不发请求。 */
export interface AutonomyLifeEndpoint {
  baseUrl: string;
  headers: Record<string, string>;
}

export interface AutonomyLifeRequestInit extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>;
  route?: 'worker' | 'direct';
  purpose?: string;
}

/** 传输层可注入（单测/预览用假 transport，运行期默认走统一外部请求入口）。 */
export type AutonomyLifeTransport = (url: string, init: AutonomyLifeRequestInit) => Promise<Response>;

export interface AutonomyLifeApiDeps {
  /**
   * 解析后端地址与认证头。返回 null = 未配置（缺 worker 地址或凭据），
   * 调用方必须按「状态暂无法确认」处理，不能猜一个默认后端。
   */
  resolveEndpoint: () => Promise<AutonomyLifeEndpoint | null> | AutonomyLifeEndpoint | null;
  transport?: AutonomyLifeTransport;
  now?: () => number;
  newIdempotencyKey?: () => string;
}

export interface LifeStatePayload {
  state: CharacterLifeState;
  capabilities: Capability[];
}

export interface LifeBoundaryPayload {
  account: BoundaryV1;
  characterOverrides: BoundaryV1 | null;
  effective: EffectiveBoundaryV1;
  revision: number;
  defaults: AutonomyLimits;
  maximums: AutonomyLimits;
}

export interface PausePayload {
  acknowledged: boolean;
  quiesced: boolean;
  /** 账号级暂停且该角色还没有状态行时缺省（见 contracts PausePayload 注释）。 */
  state?: CharacterLifeState;
  revision: number;
}

export interface ActivitiesPayload {
  items: ActivityRecord[];
  nextCursor: string | null;
}

export interface EventsPayload {
  items: LifeEvent[];
  nextSequence: number;
  hasMore: boolean;
  resyncRequired: boolean;
}

export interface BoundaryPatchRequest {
  scope: BoundaryScope;
  charId?: string;
  expectedRevision: number;
  changes: Record<string, unknown>;
}

export interface PauseRequest {
  scope: BoundaryScope;
  charId?: string;
  paused: boolean;
  expectedRevision: number;
}

export interface ConfirmationDecision {
  id: string;
  decision: 'approve' | 'reject';
  payloadHash: string;
  nonce: string;
  expectedRevision: number;
}

/** 服务端动作行（执行器需要完整字段才能跑本地事务；只做结构校验，不做业务解释）。 */
export interface LifeActionWire {
  id: string;
  charId: string;
  kind: ActivityKind;
  status: ActionStatus;
  args: Record<string, unknown>;
  argsHash: string;
  policyVersion: string;
  leaseEpoch: number;
  leaseExpiresAt: number | null;
  permitIssuedAt: number | null;
  permitNonce: string | null;
  permitConsumedAt: number | null;
  installationId: string | null;
  revision: number;
  windowId: string;
  expiresAt: number;
  [key: string]: unknown;
}

export interface ClaimPayload {
  action: LifeActionWire | null;
  leaseEpoch: number;
  leaseExpiresAt: number | null;
}

export interface CommitPermitPayload {
  permit: ExecutionPermit;
  action: LifeActionWire;
}

export interface ReceiptPayload {
  action: LifeActionWire;
}

export interface ExternalReadPayload {
  provider: 'xhs' | 'amap';
  fields: string[];
  items: Array<Record<string, string | number>>;
  fetchedAt: number;
}

/** 外部窗口请求里的许可绑定（与 ExecutionPermit 的字段同名）。 */
export interface ExternalPermitWire {
  actionId: string;
  installationId: string;
  leaseEpoch: number;
  argsHash: string;
  nonce: string;
}

/** 上报真实目录候选的回执（只代表「已登记为候选」，不代表下单/扣款）。 */
export interface ProposalSubmitPayload {
  charId: string;
  accepted: number;
  expiresAt: number;
}

export interface AutonomyLifeApi {
  readLife: (charId: string) => Promise<AutonomyLifeApiResult<LifeStatePayload>>;
  readBoundaries: (charId?: string) => Promise<AutonomyLifeApiResult<LifeBoundaryPayload>>;
  writeBoundaries: (
    req: BoundaryPatchRequest,
  ) => Promise<AutonomyLifeApiResult<LifeBoundaryPayload>>;
  setPause: (req: PauseRequest) => Promise<AutonomyLifeApiResult<PausePayload>>;
  readActivities: (opts: {
    charId?: string;
    status?: ActionStatus;
    limit?: number;
    cursor?: string | null;
  }) => Promise<AutonomyLifeApiResult<ActivitiesPayload>>;
  readEvents: (after: number) => Promise<AutonomyLifeApiResult<EventsPayload>>;
  cancelAction: (
    id: string,
    expectedRevision: number,
  ) => Promise<AutonomyLifeApiResult<ActivityRecord>>;
  resolveConfirmation: (
    decision: ConfirmationDecision,
  ) => Promise<AutonomyLifeApiResult<ActivityRecord>>;
  /** 执行设备注册（幂等；换设备要显式，不自动抢占）。 */
  registerDevice: (installationId: string) => Promise<AutonomyLifeApiResult<{ bindingState: string }>>;
  /** 领取一个到点的动作（只登记，不产生副作用）。 */
  claim: (charId: string, installationId: string) => Promise<AutonomyLifeApiResult<ClaimPayload>>;
  /** 条件提交一次性许可：返回许可 + 提交后的动作行（执行器只能用这一份）。 */
  commitPermit: (input: {
    actionId: string;
    installationId: string;
    leaseEpoch: number;
    argsHash: string;
    policyVersion: string;
  }) => Promise<AutonomyLifeApiResult<CommitPermitPayload>>;
  /** 上报回执（成功/失败/未知都报；服务端按 argsHash + 安装校验）。 */
  receipt: (input: {
    actionId: string;
    installationId: string;
    leaseEpoch: number;
    argsHash: string;
    status: 'succeeded' | 'failed' | 'unknown';
    resultRef?: string | null;
    errorCode?: AutonomyLifeErrorCode;
  }) => Promise<AutonomyLifeApiResult<ReceiptPayload>>;
  /** 受控外部只读：服务端按白名单 fetch + 字段投影，客户端只拿投影后的结果。 */
  externalRead: (input: {
    charId: string;
    query: string;
    fields?: string[];
    /** 一次性许可绑定（服务端核销后才能出网）。 */
    permit: ExternalPermitWire;
  }) => Promise<AutonomyLifeApiResult<ExternalReadPayload>>;
  /** 出行愿望：落到出行状态机的待选池（不是外部写）。 */
  submitWish: (input: {
    charId: string;
    text: string;
    /** 一次性许可绑定（服务端核销后才能落库）。 */
    permit: ExternalPermitWire;
  }) => Promise<AutonomyLifeApiResult<{ wishId: string }>>;
  /**
   * 上报**真实目录候选**（外卖/购物）：参数由设备侧从既有目录 + 角色地址 + 模拟钱包
   * 选好（真实店/商品/单价），服务端只校验形状/类目/单笔上限后落库供 tick 打分。
   *
   * 注意：这不是「提交订单」——它不产生任何订单或扣款，也不签发许可；真正执行仍要
   * claim + commit-permit + 本地事务 + 回执。
   */
  submitProposals: (input: {
    charId: string;
    proposals: ClientProposalInput[];
  }) => Promise<AutonomyLifeApiResult<ProposalSubmitPayload>>;
}

// ── 形状校验 ────────────────────────────────────────────────────────────────

const ERROR_CODES = new Set<string>(AUTONOMY_LIFE_ERROR_CODES as readonly string[]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const isNullableNumber = (v: unknown): v is number | null => v === null || isFiniteNumber(v);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === 'string');

const LIFECYCLES: readonly LifePhase[] = ['resting', 'idle', 'engaged', 'waiting'];
const AVAILABILITIES: readonly LifeAvailability[] = [
  'ready', 'disabled', 'pausing', 'paused', 'limited', 'error',
];
const ACTION_STATUS_VALUES: readonly ActionStatus[] = [
  'proposed', 'scheduled', 'waiting_device', 'awaiting_confirmation', 'running',
  'succeeded', 'failed', 'unknown', 'blocked', 'expired', 'cancelled',
];
const EVENT_TYPES: readonly LifeEventType[] = [
  'life.state.changed', 'action.changed', 'boundary.changed',
  'budget.changed', 'grant.changed', 'capability.changed',
];
const SCOPES: readonly ActionScope[] = ['os_simulation', 'external_read'];
const SOURCES: readonly ActionSource[] = [
  'autonomy_round', 'chat_reply', 'rhythm', 'user_request', 'legacy',
];
const NOTIFICATION_STATES = ['none', 'queued', 'delivered', 'not_delivered'] as const;

/** 服务端账本维度白名单：不认识就整包拒收，别让 view.ts 的映射表拿到 undefined。 */
const BUDGET_DIMENSIONS: readonly BudgetUsage['dimension'][] = [
  'model_calls',
  'model_calls_account',
  'tokens',
  'notifications',
  'virtual_spend',
];

export const isBudgetUsage = (v: unknown): v is BudgetUsage =>
  isRecord(v) &&
  BUDGET_DIMENSIONS.includes(v.dimension as BudgetUsage['dimension']) &&
  isFiniteNumber(v.used) &&
  isFiniteNumber(v.reserved) &&
  isFiniteNumber(v.limit) &&
  (v.unit === undefined || typeof v.unit === 'string');

export const isCharacterLifeState = (v: unknown): v is CharacterLifeState =>
  isRecord(v) &&
  v.schemaVersion === AUTONOMY_LIFE_SCHEMA_VERSION &&
  typeof v.charId === 'string' &&
  isFiniteNumber(v.revision) &&
  isFiniteNumber(v.observedAt) &&
  LIFECYCLES.includes(v.lifePhase as LifePhase) &&
  AVAILABILITIES.includes(v.availability as LifeAvailability) &&
  Array.isArray(v.reasonCodes) &&
  v.reasonCodes.every((code) => typeof code === 'string') &&
  isNullableNumber(v.nextOpportunityAt) &&
  isNullableNumber(v.nextCheckAt) &&
  (v.scheduleConfidence === 'fallback' || v.scheduleConfidence === 'persona') &&
  (v.activeActionId === null || typeof v.activeActionId === 'string') &&
  isFiniteNumber(v.pendingCount) &&
  (v.budgetWindowId === null || typeof v.budgetWindowId === 'string') &&
  Array.isArray(v.budget) &&
  v.budget.every(isBudgetUsage);

export const isCapability = (v: unknown): v is Capability =>
  isRecord(v) &&
  isActivityKind(v.kind) &&
  typeof v.appId === 'string' &&
  typeof v.available === 'boolean' &&
  typeof v.enabled === 'boolean' &&
  (v.executionMode === 'cloud' || v.executionMode === 'local') &&
  typeof v.requiresForeground === 'boolean' &&
  typeof v.requiresGrant === 'boolean' &&
  (v.unavailableReason === undefined || typeof v.unavailableReason === 'string');

const isLimits = (v: unknown): v is AutonomyLimits =>
  isRecord(v) &&
  Object.keys(v).every((key) => isNullableNumber((v as Record<string, unknown>)[key]));

const isExternalGrant = (v: unknown): v is ExternalGrant =>
  isRecord(v) &&
  (v.provider === 'xhs' || v.provider === 'amap') &&
  isStringArray(v.scopes) &&
  isStringArray(v.allowedHosts) &&
  isStringArray(v.allowedMethods) &&
  isStringArray(v.allowedFieldKeys) &&
  typeof v.purpose === 'string' &&
  isFiniteNumber(v.expiresAt) &&
  isFiniteNumber(v.dailyQuota);

export const isBoundary = (v: unknown): v is BoundaryV1 =>
  isRecord(v) &&
  v.schemaVersion === AUTONOMY_LIFE_SCHEMA_VERSION &&
  isFiniteNumber(v.revision) &&
  (v.scope === 'account' || v.scope === 'character') &&
  (v.enabled === null || typeof v.enabled === 'boolean') &&
  (v.globalPaused === null || typeof v.globalPaused === 'boolean') &&
  (v.charEnabled === null || typeof v.charEnabled === 'boolean') &&
  (v.timezone === null || typeof v.timezone === 'string') &&
  (v.allowedKinds === null ||
    (Array.isArray(v.allowedKinds) && v.allowedKinds.every(isActivityKind))) &&
  isStringArray(v.forbiddenCategories) &&
  isStringArray(v.avoidTopics) &&
  (v.allowFictionalNpc === null || typeof v.allowFictionalNpc === 'boolean') &&
  (v.doNotDisturb === null ||
    (isRecord(v.doNotDisturb) &&
      typeof v.doNotDisturb.timezone === 'string' &&
      typeof v.doNotDisturb.start === 'string' &&
      typeof v.doNotDisturb.end === 'string')) &&
  isLimits(v.limits) &&
  Array.isArray(v.externalGrants) &&
  v.externalGrants.every(isExternalGrant);

export const isActivityRecord = (v: unknown): v is ActivityRecord =>
  isRecord(v) &&
  v.schemaVersion === AUTONOMY_LIFE_SCHEMA_VERSION &&
  typeof v.id === 'string' &&
  typeof v.charId === 'string' &&
  isActivityKind(v.kind) &&
  SCOPES.includes(v.scope as ActionScope) &&
  SOURCES.includes(v.source as ActionSource) &&
  (v.sourceRef === null || typeof v.sourceRef === 'string') &&
  ACTION_STATUS_VALUES.includes(v.status as ActionStatus) &&
  typeof v.reasonSummary === 'string' &&
  isFiniteNumber(v.occurredAt) &&
  isFiniteNumber(v.updatedAt) &&
  (v.resultRef === null || typeof v.resultRef === 'string') &&
  typeof v.effectVerified === 'boolean' &&
  (NOTIFICATION_STATES as readonly string[]).includes(v.notificationState as string) &&
  (v.errorCode === null || typeof v.errorCode === 'string') &&
  typeof v.canCancel === 'boolean';

export const isLifeEvent = (v: unknown): v is LifeEvent =>
  isRecord(v) &&
  typeof v.eventId === 'string' &&
  isFiniteNumber(v.sequence) &&
  EVENT_TYPES.includes(v.type as LifeEventType) &&
  (v.charId === null || typeof v.charId === 'string') &&
  (v.actionId === null || typeof v.actionId === 'string') &&
  isFiniteNumber(v.revision) &&
  isFiniteNumber(v.occurredAt) &&
  isRecord(v.data);

/** 回包信封：schemaVersion / requestId / serverTime 缺一不可（§7）。 */
const hasEnvelope = (v: unknown): v is Record<string, unknown> =>
  isRecord(v) &&
  v.schemaVersion === AUTONOMY_LIFE_SCHEMA_VERSION &&
  typeof v.requestId === 'string' &&
  isFiniteNumber(v.serverTime);

/** 拒绝任何弃用字段：UI 里不该存在频率入口，塞进来就是接线错误。 */
export function findDeprecatedFields(changes: unknown): string[] {
  if (!isRecord(changes)) return [];
  const banned = new Set<string>(DEPRECATED_BOUNDARY_FIELDS as readonly string[]);
  return Object.keys(changes).filter((key) => banned.has(key));
}

const joinUrl = (base: string, path: string): string => `${base.replace(/\/+$/, '')}${path}`;

const readErrorCode = (body: unknown): AutonomyLifeErrorCode | null => {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const code = body.error.code;
  return typeof code === 'string' && ERROR_CODES.has(code) ? (code as AutonomyLifeErrorCode) : null;
};

const readErrorMessage = (body: unknown): string | undefined => {
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  return typeof body.error.message === 'string' ? body.error.message : undefined;
};

const readRetryAt = (body: unknown): number | undefined => {
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  const retryAt = body.error.retryAt;
  return isFiniteNumber(retryAt) ? retryAt : undefined;
};


/** 动作行的最小结构校验：执行器要拿它跑本地事务，形状不对一律 MALFORMED。 */
const isLifeActionWire = (v: unknown): v is LifeActionWire => {
  if (!isRecord(v)) return false;
  if (typeof v.id !== 'string' || !v.id) return false;
  if (typeof v.charId !== 'string' || !v.charId) return false;
  if (!isActivityKind(v.kind)) return false;
  if (typeof v.status !== 'string' || !(ACTION_STATUS_VALUES as readonly string[]).includes(v.status)) return false;
  if (!isRecord(v.args)) return false;
  if (typeof v.argsHash !== 'string' || !v.argsHash) return false;
  if (typeof v.policyVersion !== 'string' || !v.policyVersion) return false;
  if (!isFiniteNumber(v.leaseEpoch) || !isFiniteNumber(v.revision)) return false;
  if (!isNullableNumber(v.leaseExpiresAt) || !isNullableNumber(v.permitIssuedAt)) return false;
  if (!isNullableNumber(v.permitConsumedAt) || !isFiniteNumber(v.expiresAt)) return false;
  if (typeof v.windowId !== 'string') return false;
  if (v.permitNonce !== null && typeof v.permitNonce !== 'string') return false;
  if (v.installationId !== null && typeof v.installationId !== 'string') return false;
  return true;
};

const isExecutionPermit = (v: unknown): v is ExecutionPermit => {
  if (!isRecord(v)) return false;
  return typeof v.actionId === 'string' && v.actionId.length > 0
    && typeof v.charId === 'string' && v.charId.length > 0
    && typeof v.installationId === 'string' && v.installationId.length > 0
    && typeof v.argsHash === 'string' && v.argsHash.length > 0
    && typeof v.policyVersion === 'string' && v.policyVersion.length > 0
    && typeof v.nonce === 'string' && v.nonce.length > 0
    && isFiniteNumber(v.leaseEpoch)
    && isFiniteNumber(v.issuedAt)
    && isFiniteNumber(v.expiresAt)
    && (v.reservationId === null || typeof v.reservationId === 'string');
};

export function createAutonomyLifeApi(deps: AutonomyLifeApiDeps): AutonomyLifeApi {
  const now = deps.now ?? (() => Date.now());
  const newKey = deps.newIdempotencyKey ?? (() => {
    const cryptoApi = typeof crypto !== 'undefined' ? crypto : undefined;
    if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
    return `autonomy-${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  });
  const transport: AutonomyLifeTransport =
    deps.transport ?? ((url, init) => externalFetchAdapter(url, init));

  const request = async (
    path: string,
    init: {
      method: 'GET' | 'PATCH' | 'POST';
      body?: unknown;
      purpose: string;
      idempotent?: boolean;
      query?: Record<string, string>;
    },
  ): Promise<AutonomyLifeApiResult<Record<string, unknown>>> => {
    let endpoint: AutonomyLifeEndpoint | null;
    try {
      endpoint = await deps.resolveEndpoint();
    } catch {
      endpoint = null;
    }
    const base = String(endpoint?.baseUrl ?? '').trim();
    if (!endpoint || !base) {
      return { ok: false, code: 'NOT_CONFIGURED', status: 0 };
    }

    const url = joinUrl(base, path);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(endpoint.headers ?? {}),
    };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    if (init.idempotent) headers['Idempotency-Key'] = newKey();

    let res: Response;
    try {
      res = await transport(url, {
        method: init.method,
        headers,
        body,
        route: 'worker',
        purpose: init.purpose,
      });
    } catch {
      return { ok: false, code: 'NETWORK', status: 0 };
    }

    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }

    if (!res.ok) {
      const code = readErrorCode(parsed) ?? (res.status === 401 ? 'UNAUTHENTICATED' : 'SERVICE_UNAVAILABLE');
      const retryAt = readRetryAt(parsed);
      return {
        ok: false,
        code,
        status: res.status,
        retryAt: retryAt ?? null,
        ...(isRecord(parsed) && isRecord(parsed.error) && parsed.error.retryable === true
          ? { retryable: true }
          : {}),
        message: readErrorMessage(parsed),
        requestId: isRecord(parsed) && typeof parsed.requestId === 'string' ? parsed.requestId : undefined,
      };
    }

    if (!hasEnvelope(parsed)) {
      return { ok: false, code: 'MALFORMED_RESPONSE', status: res.status };
    }
    return { ok: true, data: parsed };
  };

  const malformed = (status = 200): AutonomyLifeApiResult<never> => ({
    ok: false,
    code: 'MALFORMED_RESPONSE',
    status,
  });

  return {
    readLife: async (charId) => {
      const id = String(charId ?? '').trim();
      if (!id) return { ok: false, code: 'NOT_CONFIGURED', status: 0 };
      const raw = await request(AUTONOMY_LIFE_PATHS.state(id), {
        method: 'GET',
        purpose: '读取角色自主生活状态',
      });
      if (!raw.ok) return raw;
      const { state, capabilities } = raw.data;
      if (!isCharacterLifeState(state)) return malformed();
      if (!Array.isArray(capabilities) || !capabilities.every(isCapability)) return malformed();
      // 角色状态必须属于请求的角色，防止服务端/代理串号时把别的角色显示成本角色。
      if (state.charId !== id) return malformed();
      return { ok: true, data: { state, capabilities } };
    },

    readBoundaries: async (charId) => {
      const raw = await request(AUTONOMY_LIFE_PATHS.boundaries(charId), {
        method: 'GET',
        purpose: '读取自主生活边界',
      });
      if (!raw.ok) return raw;
      const { account, characterOverrides, effective, revision, defaults, maximums } = raw.data;
      if (!isBoundary(account) || !isBoundary(effective)) return malformed();
      if (characterOverrides !== null && !isBoundary(characterOverrides)) return malformed();
      if (!isFiniteNumber(revision)) return malformed();
      if (!isLimits(defaults) || !isLimits(maximums)) return malformed();
      return {
        ok: true,
        data: {
          account,
          characterOverrides: characterOverrides as BoundaryV1 | null,
          effective: effective as EffectiveBoundaryV1,
          revision,
          defaults,
          maximums,
        },
      };
    },

    writeBoundaries: async (req) => {
      const banned = findDeprecatedFields(req.changes);
      if (banned.length > 0) {
        return {
          ok: false,
          code: 'DEPRECATED_FIELD_SENT',
          status: 0,
          message: `界面不得提交频率字段：${banned.join(', ')}`,
        };
      }
      if (req.scope === 'character' && !String(req.charId ?? '').trim()) {
        return { ok: false, code: 'NOT_CONFIGURED', status: 0, message: '角色层写入缺少 charId' };
      }
      const raw = await request(AUTONOMY_LIFE_PATHS.boundaries(), {
        method: 'PATCH',
        body: {
          scope: req.scope,
          ...(req.charId ? { charId: req.charId } : {}),
          expectedRevision: req.expectedRevision,
          changes: req.changes,
        },
        purpose: '保存自主生活边界',
        idempotent: true,
      });
      if (!raw.ok) return raw;
      const { account, characterOverrides, effective, revision, defaults, maximums } = raw.data;
      if (!isBoundary(account) || !isBoundary(effective)) return malformed();
      if (characterOverrides !== null && !isBoundary(characterOverrides)) return malformed();
      if (!isFiniteNumber(revision) || !isLimits(defaults) || !isLimits(maximums)) return malformed();
      return {
        ok: true,
        data: {
          account,
          characterOverrides: characterOverrides as BoundaryV1 | null,
          effective: effective as EffectiveBoundaryV1,
          revision,
          defaults,
          maximums,
        },
      };
    },

    setPause: async (req) => {
      const raw = await request(AUTONOMY_LIFE_PATHS.pause(), {
        method: 'POST',
        body: {
          scope: req.scope,
          ...(req.charId ? { charId: req.charId } : {}),
          paused: req.paused,
          expectedRevision: req.expectedRevision,
        },
        purpose: req.paused ? '暂停自主生活' : '恢复自主生活',
        idempotent: true,
      });
      if (!raw.ok) return raw;
      const { acknowledged, quiesced, state, revision } = raw.data;
      if (typeof acknowledged !== 'boolean' || typeof quiesced !== 'boolean') return malformed();
      if (!isFiniteNumber(revision)) return malformed();
      // state 可以缺省（账号级暂停且该角色还没有状态行）；给了就必须是合法形状。
      if (state !== undefined && state !== null && !isCharacterLifeState(state)) return malformed();
      const payload: PausePayload = { acknowledged, quiesced, ...(state ? { state } : {}), revision };
      return { ok: true, data: payload };
    },

    readActivities: async (opts) => {
      const params = new URLSearchParams();
      if (opts.charId) params.set('charId', opts.charId);
      if (opts.status) params.set('status', opts.status);
      params.set('limit', String(Math.min(100, Math.max(1, Math.round(opts.limit ?? 20)))));
      if (opts.cursor) params.set('cursor', opts.cursor);
      const raw = await request(`${AUTONOMY_LIFE_PATHS.activities()}?${params.toString()}`, {
        method: 'GET',
        purpose: '读取自主生活记录',
      });
      if (!raw.ok) return raw;
      const { items, nextCursor } = raw.data;
      if (!Array.isArray(items) || !items.every(isActivityRecord)) return malformed();
      if (!(nextCursor === null || typeof nextCursor === 'string')) return malformed();
      return { ok: true, data: { items, nextCursor } };
    },

    readEvents: async (after) => {
      const seq = Number.isFinite(after) && after > 0 ? Math.floor(after) : 0;
      const raw = await request(`${AUTONOMY_LIFE_PATHS.events()}?after=${seq}`, {
        method: 'GET',
        purpose: '轮询自主生活事件',
      });
      if (!raw.ok) return raw;
      const { items, nextSequence, hasMore, resyncRequired } = raw.data;
      if (!Array.isArray(items) || !items.every(isLifeEvent)) return malformed();
      if (!isFiniteNumber(nextSequence) || typeof hasMore !== 'boolean' || typeof resyncRequired !== 'boolean') {
        return malformed();
      }
      return { ok: true, data: { items, nextSequence, hasMore, resyncRequired } };
    },

    cancelAction: async (id, expectedRevision) => {
      const raw = await request(AUTONOMY_LIFE_PATHS.cancel(id), {
        method: 'POST',
        body: { expectedRevision },
        purpose: '取消自主动作',
        idempotent: true,
      });
      if (!raw.ok) return raw;
      const action = raw.data.action ?? raw.data;
      if (!isActivityRecord(action)) return malformed();
      return { ok: true, data: action };
    },

    resolveConfirmation: async (decision) => {
      const raw = await request(AUTONOMY_LIFE_PATHS.resolveConfirmation(decision.id), {
        method: 'POST',
        body: {
          decision: decision.decision,
          payloadHash: decision.payloadHash,
          nonce: decision.nonce,
          expectedRevision: decision.expectedRevision,
        },
        purpose: decision.decision === 'approve' ? '批准外部数据外传' : '拒绝外部数据外传',
        idempotent: true,
      });
      if (!raw.ok) return raw;
      const action = raw.data.action ?? raw.data;
      if (!isActivityRecord(action)) return malformed();
      return { ok: true, data: action };
    },

    registerDevice: async (installationId) => {
      const id = String(installationId ?? '').trim();
      if (!id) return { ok: false, code: 'NOT_CONFIGURED', status: 0, message: 'installationId_required' };
      const raw = await request(AUTONOMY_LIFE_PATHS.registerDevice(), {
        method: 'POST',
        body: { installationId: id, capabilitiesVersion: 'autonomy-local-v1' },
        purpose: '注册自主生活执行设备',
        idempotent: true,
      });
      if (!raw.ok) return raw;
      const bindingState = raw.data.bindingState;
      if (typeof bindingState !== 'string') return malformed();
      return { ok: true, data: { bindingState } };
    },

    claim: async (charId, installationId) => {
      const id = String(charId ?? '').trim();
      const device = String(installationId ?? '').trim();
      if (!id || !device) return { ok: false, code: 'NOT_CONFIGURED', status: 0, message: 'charId_and_installationId_required' };
      const raw = await request(AUTONOMY_LIFE_PATHS.claim(), {
        method: 'POST',
        body: { charId: id, installationId: device, limit: 1 },
        purpose: '领取一个自主动作',
      });
      if (!raw.ok) return raw;
      const action = raw.data.action;
      if (action === null) {
        return { ok: true, data: { action: null, leaseEpoch: 0, leaseExpiresAt: null } };
      }
      if (!isLifeActionWire(action)) return malformed();
      if (action.charId !== id) return malformed();
      return {
        ok: true,
        data: {
          action,
          leaseEpoch: isFiniteNumber(raw.data.leaseEpoch) ? raw.data.leaseEpoch : action.leaseEpoch,
          leaseExpiresAt: isNullableNumber(raw.data.leaseExpiresAt) ? raw.data.leaseExpiresAt : action.leaseExpiresAt,
        },
      };
    },

    commitPermit: async (input) => {
      const raw = await request(AUTONOMY_LIFE_PATHS.commitPermit(input.actionId), {
        method: 'POST',
        body: {
          installationId: input.installationId,
          leaseEpoch: input.leaseEpoch,
          argsHash: input.argsHash,
          policyVersion: input.policyVersion,
        },
        purpose: '提交一次性执行许可',
      });
      if (!raw.ok) return raw;
      const { permit, action } = raw.data;
      if (!isExecutionPermit(permit) || !isLifeActionWire(action)) return malformed();
      if (permit.actionId !== input.actionId || action.id !== input.actionId) return malformed();
      if (permit.argsHash !== input.argsHash) return malformed();
      return { ok: true, data: { permit, action } };
    },

    receipt: async (input) => {
      const raw = await request(AUTONOMY_LIFE_PATHS.receipt(input.actionId), {
        method: 'POST',
        body: {
          installationId: input.installationId,
          leaseEpoch: input.leaseEpoch,
          argsHash: input.argsHash,
          status: input.status,
          ...(input.resultRef !== undefined ? { resultRef: input.resultRef } : {}),
          ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        },
        purpose: '上报自主动作回执',
        idempotent: true,
      });
      if (!raw.ok) return raw;
      const action = raw.data.action;
      if (!isLifeActionWire(action)) return malformed();
      if (action.id !== input.actionId) return malformed();
      return { ok: true, data: { action } };
    },

    externalRead: async (input) => {
      const charId = String(input.charId ?? '').trim();
      const query = String(input.query ?? '').trim();
      if (!charId || !query) return { ok: false, code: 'NOT_CONFIGURED', status: 0, message: 'charId_and_query_required' };
      if (!input.permit) return { ok: false, code: 'NOT_CONFIGURED', status: 0, message: 'permit_required' };
      const raw = await request(AUTONOMY_LIFE_PATHS.externalRead(), {
        method: 'POST',
        body: {
          charId,
          query,
          ...(input.fields ? { fields: input.fields } : {}),
          ...input.permit,
        },
        purpose: '外部只读检索',
      });
      if (!raw.ok) return raw;
      const provider = raw.data.provider;
      const items = raw.data.items;
      const fields = raw.data.fields;
      if (provider !== 'xhs' && provider !== 'amap') return malformed();
      if (!Array.isArray(items) || !items.every(isRecord)) return malformed();
      if (!Array.isArray(fields) || !fields.every((field) => typeof field === 'string')) return malformed();
      if (!isFiniteNumber(raw.data.fetchedAt)) return malformed();
      return {
        ok: true,
        data: {
          provider,
          fields: fields as string[],
          items: items as Array<Record<string, string | number>>,
          fetchedAt: raw.data.fetchedAt,
        },
      };
    },

    submitWish: async (input) => {
      const charId = String(input.charId ?? '').trim();
      const text = String(input.text ?? '').trim();
      if (!charId || !text) return { ok: false, code: 'NOT_CONFIGURED', status: 0, message: 'charId_and_text_required' };
      if (!input.permit) return { ok: false, code: 'NOT_CONFIGURED', status: 0, message: 'permit_required' };
      const raw = await request(AUTONOMY_LIFE_PATHS.externalWish(), {
        method: 'POST',
        body: { charId, text, ...input.permit },
        purpose: '提交出行愿望',
      });
      if (!raw.ok) return raw;
      const wishId = raw.data.wishId;
      if (typeof wishId !== 'string' || !wishId) return malformed();
      return { ok: true, data: { wishId } };
    },

    submitProposals: async (input) => {
      const charId = String(input.charId ?? '').trim();
      if (!charId) return { ok: false, code: 'NOT_CONFIGURED', status: 0, message: 'charId_required' };
      if (!Array.isArray(input.proposals) || input.proposals.length === 0) {
        return { ok: false, code: 'NOT_CONFIGURED', status: 0, message: 'proposals_required' };
      }
      const raw = await request(AUTONOMY_LIFE_PATHS.proposals(), {
        method: 'POST',
        body: { charId, proposals: input.proposals },
        purpose: '上报真实目录候选',
      });
      if (!raw.ok) return raw;
      const accepted = raw.data.accepted;
      const expiresAt = raw.data.expiresAt;
      if (!isFiniteNumber(accepted) || !isFiniteNumber(expiresAt)) return malformed();
      return { ok: true, data: { charId, accepted, expiresAt } };
    },
  };
}

/**
 * 运行期默认传输：走既有 `externalFetch`（统一通道 + 失败诊断），
 * 不自开裸 fetch。`route: 'worker'` 与旅游/社交等既有模块一致。
 */
async function externalFetchAdapter(url: string, init: AutonomyLifeRequestInit): Promise<Response> {
  const { externalFetch } = await import('../externalRequest');
  return externalFetch(url, init as never);
}
