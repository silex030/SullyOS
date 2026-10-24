/**
 * 自主生活 UI · 测试数据（fixture）。
 *
 * 硬规则：
 *   - 只能在**显式**传入 `fixtureScenario` 时使用（预览页 / 组件测试）；
 *     生产路径默认走 `createDefaultAutonomyLifeApi()`，没有任何自动回落。
 *   - 用 fixture 的界面必须显示 `FixtureBanner`（红色虚线框），
 *     不允许把 fixture 截图当联调验收证据（契约 §10.M）。
 *   - 这里的字段严格照 `contracts/autonomyLife.ts` 的形状写，便于发现契约漂移。
 */

import {
  AUTONOMY_LIFE_SCHEMA_VERSION,
  DEFAULT_ACCOUNT_LIMITS,
  MAXIMUM_ACCOUNT_LIMITS,
  type ActivityRecord,
  type BoundaryV1,
  type Capability,
  type CharacterLifeState,
  type EffectiveBoundaryV1,
  type LifeEvent,
} from '../../contracts/autonomyLife';
import type {
  ActivitiesPayload,
  AutonomyLifeApi,
  AutonomyLifeApiResult,
  EventsPayload,
  LifeBoundaryPayload,
  LifeStatePayload,
  PausePayload,
  AutonomyLifeApiErrorCode,
} from '../../utils/autonomyLife/api';

export const FIXTURE_SCENARIOS = [
  'ready',
  'empty',
  'paused',
  'budget_exhausted',
  'waiting_device',
  'pending_confirmation',
  'capability_unavailable',
  'load_error',
] as const;

export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number];

const CHAR_ID = 'fixture-char-1';
/** 演示数据的固定「现在」：截图与测试都必须传同一时刻，否则会出现「未来时间」的观感错误。 */
export const FIXTURE_NOW = 1_793_000_000_000;
const NOW = FIXTURE_NOW;

const baseState = (over: Partial<CharacterLifeState>): CharacterLifeState => ({
  schemaVersion: AUTONOMY_LIFE_SCHEMA_VERSION,
  charId: CHAR_ID,
  revision: 7,
  observedAt: NOW,
  lifePhase: 'idle',
  availability: 'ready',
  reasonCodes: [],
  nextOpportunityAt: NOW + 2 * 60 * 60 * 1000,
  nextCheckAt: NOW + 10 * 60 * 1000,
  scheduleConfidence: 'persona',
  activeActionId: null,
  pendingCount: 0,
  budgetWindowId: '2026-10-24',
  budget: [
    { dimension: 'model_calls', used: 1, reserved: 0, limit: 6 },
    { dimension: 'tokens', used: 4200, reserved: 0, limit: 100_000, unit: 'token' },
    { dimension: 'notifications', used: 0, reserved: 0, limit: 1 },
    { dimension: 'model_calls_account', used: 1, reserved: 0, limit: 24 },
    { dimension: 'virtual_spend', used: 2800, reserved: 0, limit: 20_000, unit: 'CNY_minor' },
  ],
  ...over,
});

const capabilities = (over: Partial<Record<Capability['kind'], Partial<Capability>>> = {}): Capability[] => {
  const base: Capability[] = [
    { kind: 'journal.write', appId: 'journal', available: true, enabled: true, executionMode: 'local', requiresForeground: true, requiresGrant: false },
    { kind: 'room.plan', appId: 'room', available: true, enabled: true, executionMode: 'local', requiresForeground: true, requiresGrant: false },
    { kind: 'room.note', appId: 'room', available: true, enabled: true, executionMode: 'local', requiresForeground: true, requiresGrant: false },
    { kind: 'phone.record', appId: 'check_phone', available: true, enabled: true, executionMode: 'local', requiresForeground: true, requiresGrant: false },
    { kind: 'takeout.order', appId: 'takeout', available: true, enabled: true, executionMode: 'local', requiresForeground: true, requiresGrant: false },
    { kind: 'shopping.order', appId: 'shopping', available: true, enabled: true, executionMode: 'local', requiresForeground: true, requiresGrant: false },
    { kind: 'interaction.message', appId: 'chat', available: true, enabled: true, executionMode: 'local', requiresForeground: true, requiresGrant: false },
    { kind: 'travel.wish', appId: 'travel', available: false, enabled: false, executionMode: 'local', requiresForeground: false, requiresGrant: true, unavailableReason: '地图服务未配置' },
    { kind: 'external.read', appId: 'xhs_free_roam', available: false, enabled: false, executionMode: 'local', requiresForeground: false, requiresGrant: true, unavailableReason: '未授予只读访问' },
  ];
  return base.map((cap) => ({ ...cap, ...(over[cap.kind] ?? {}) }));
};

const accountBoundary = (over: Partial<BoundaryV1> = {}): BoundaryV1 => ({
  schemaVersion: AUTONOMY_LIFE_SCHEMA_VERSION,
  revision: 11,
  scope: 'account',
  enabled: true,
  globalPaused: false,
  charEnabled: null,
  timezone: 'Asia/Shanghai',
  allowedKinds: null,
  forbiddenCategories: ['gambling', 'betting_promotion', 'real_finance', 'illegal_trade', 'credential_theft'],
  avoidTopics: [],
  allowFictionalNpc: true,
  doNotDisturb: { timezone: 'Asia/Shanghai', start: '23:00', end: '08:00' },
  limits: { ...DEFAULT_ACCOUNT_LIMITS },
  externalGrants: [],
  ...over,
});

const characterBoundary = (over: Partial<BoundaryV1> = {}): BoundaryV1 => ({
  ...accountBoundary(over),
  revision: 3,
  scope: 'character',
  globalPaused: null,
  charEnabled: true,
  timezone: null,
  allowedKinds: null,
  doNotDisturb: null,
  limits: Object.fromEntries(Object.keys(DEFAULT_ACCOUNT_LIMITS).map((key) => [key, null])) as unknown as BoundaryV1['limits'],
  ...over,
});

const effectiveBoundary = (account: BoundaryV1, over: Partial<EffectiveBoundaryV1> = {}): EffectiveBoundaryV1 => ({
  ...accountBoundary(),
  revision: Math.max(account.revision, 3),
  scope: 'account',
  enabled: Boolean(account.enabled),
  globalPaused: Boolean(account.globalPaused),
  charEnabled: true,
  timezone: account.timezone ?? 'Asia/Shanghai',
  allowedKinds: [
    'journal.write', 'room.plan', 'room.note', 'phone.record',
    'takeout.order', 'shopping.order', 'interaction.message',
  ],
  allowFictionalNpc: Boolean(account.allowFictionalNpc),
  limits: { ...account.limits },
  ...over,
});

const activity = (over: Partial<ActivityRecord> & Pick<ActivityRecord, 'id' | 'kind' | 'reasonSummary'>): ActivityRecord => ({
  schemaVersion: AUTONOMY_LIFE_SCHEMA_VERSION,
  charId: CHAR_ID,
  scope: over.kind === 'external.read' ? 'external_read' : 'os_simulation',
  source: 'rhythm',
  sourceRef: null,
  status: 'succeeded',
  occurredAt: NOW - 60 * 60 * 1000,
  updatedAt: NOW - 60 * 60 * 1000,
  resultRef: 'journal:entry-1',
  effectVerified: true,
  notificationState: 'none',
  errorCode: null,
  canCancel: false,
  ...over,
});

const readyActivities: ActivityRecord[] = [
  activity({ id: 'a-4', kind: 'journal.write', reasonSummary: '想起今天看到的那家店，写了几句', occurredAt: NOW - 40 * 60 * 1000, status: 'running', effectVerified: false, resultRef: null, canCancel: true }),
  // 结果不明的一条：用来验证时间线敢说「待核对」，且不给盲重试（契约 §5 unknown 不自动重放）。
  activity({ id: 'a-6', kind: 'phone.record', reasonSummary: '翻手机时看到一条没回的消息，试着记了一笔', occurredAt: NOW - 2 * 60 * 60 * 1000, status: 'unknown', effectVerified: false, resultRef: null }),
  activity({ id: 'a-3', kind: 'interaction.message', reasonSummary: '你说在加班，TA 留了一条不打扰的消息', occurredAt: NOW - 3 * 60 * 60 * 1000, notificationState: 'not_delivered' }),
  activity({ id: 'a-2', kind: 'takeout.order', reasonSummary: '给自己点了一份番茄牛腩饭（OS 内模拟）', occurredAt: NOW - 26 * 60 * 60 * 1000, source: 'autonomy_round' }),
  activity({ id: 'a-1', kind: 'room.note', reasonSummary: '把明天想做的事记在便签上', occurredAt: NOW - 28 * 60 * 60 * 1000 }),
];

const boundaryPayload = (account: BoundaryV1): LifeBoundaryPayload => ({
  account,
  characterOverrides: characterBoundary(),
  effective: effectiveBoundary(account),
  revision: Math.max(account.revision, 3),
  defaults: { ...DEFAULT_ACCOUNT_LIMITS },
  maximums: { ...MAXIMUM_ACCOUNT_LIMITS },
});

const ok = <T,>(data: T): AutonomyLifeApiResult<T> => ({ ok: true, data });
const fail = (
  code: AutonomyLifeApiErrorCode,
  status = 0,
): AutonomyLifeApiResult<never> => ({
  ok: false,
  code,
  status,
  message: 'fixture',
});

/**
 * 演示用 API：全部在内存里，不发请求；写操作只更新本对象的 revision，
 * 用来验证「保存后才显示已保存」「冲突后重新读取」这些交互，而不是伪造后端语义。
 */
export function createFixtureAutonomyLifeApi(
  scenario: FixtureScenario,
  opts: { now?: () => number } = {},
): AutonomyLifeApi {
  const now = opts.now ?? (() => NOW);
  let account = accountBoundary();
  let state = baseState({});

  if (scenario === 'paused') {
    account = accountBoundary({ globalPaused: true, revision: 12 });
    state = baseState({ availability: 'paused', reasonCodes: ['GLOBAL_PAUSED', 'RESTING'], lifePhase: 'resting' });
  }
  if (scenario === 'budget_exhausted') {
    state = baseState({
      availability: 'limited',
      reasonCodes: ['BUDGET_EXHAUSTED', 'RESTING'],
      lifePhase: 'resting',
      budget: [
        { dimension: 'model_calls', used: 6, reserved: 0, limit: 6 },
        { dimension: 'tokens', used: 100_000, reserved: 0, limit: 100_000, unit: 'token' },
      ],
    });
  }
  if (scenario === 'waiting_device') {
    state = baseState({
      availability: 'limited',
      reasonCodes: ['WAITING_DEVICE'],
      lifePhase: 'waiting',
      pendingCount: 1,
    });
  }

  const events: LifeEvent[] = scenario === 'pending_confirmation'
    ? [
        {
          eventId: 'e-1',
          sequence: 9,
          type: 'action.changed',
          charId: CHAR_ID,
          actionId: 'a-5',
          revision: 8,
          occurredAt: NOW,
          data: {
            status: 'awaiting_confirmation',
            confirmation: {
              id: 'c-1',
              payloadHash: 'hash-fixture',
              nonce: 'nonce-fixture',
              purpose: '为写日记查一条公开店铺信息',
              host: 'www.xiaohongshu.com',
              fields: ['兴趣词：咖啡', '城市：上海'],
              expiresAt: NOW + 10 * 60 * 1000,
              expectedRevision: 8,
            },
          },
        },
      ]
    : [];

  return {
    readLife: async (): Promise<AutonomyLifeApiResult<LifeStatePayload>> => {
      if (scenario === 'load_error') return fail('NETWORK', 0);
      return ok({ state, capabilities: capabilities(scenario === 'capability_unavailable' ? {} : {}) });
    },
    readBoundaries: async (): Promise<AutonomyLifeApiResult<LifeBoundaryPayload>> => {
      if (scenario === 'load_error') return fail('NETWORK', 0);
      const payload = boundaryPayload(account);
      if (scenario === 'capability_unavailable') {
        return ok({
          ...payload,
          account: { ...payload.account, externalGrants: [] },
          effective: { ...payload.effective, externalGrants: [] },
        });
      }
      return ok(payload);
    },
    writeBoundaries: async (req): Promise<AutonomyLifeApiResult<LifeBoundaryPayload>> => {
      if (req.expectedRevision !== Math.max(account.revision, 3)) return fail('REVISION_CONFLICT', 409);
      if (req.scope === 'account') {
        account = { ...account, ...(req.changes as Partial<BoundaryV1>), revision: account.revision + 1 };
      }
      const payload = boundaryPayload(account);
      return ok({ ...payload, characterOverrides: payload.characterOverrides, revision: payload.revision + 1 });
    },
    setPause: async (req): Promise<AutonomyLifeApiResult<PausePayload>> => {
      account = { ...account, globalPaused: req.paused, revision: account.revision + 1 };
      state = baseState({
        availability: req.paused ? 'paused' : 'ready',
        reasonCodes: req.paused ? ['GLOBAL_PAUSED'] : [],
      });
      return ok({ acknowledged: true, quiesced: req.paused ? false : true, state, revision: account.revision + 1 });
    },
    readActivities: async (o): Promise<AutonomyLifeApiResult<ActivitiesPayload>> => {
      if (scenario === 'load_error') return fail('NETWORK', 0);
      let items = scenario === 'empty' ? [] : readyActivities;
      if (o.status) items = items.filter((item) => item.status === o.status);
      return ok({ items, nextCursor: null });
    },
    readEvents: async (): Promise<AutonomyLifeApiResult<EventsPayload>> =>
      ok({ items: events, nextSequence: events.length > 0 ? 9 : 0, hasMore: false, resyncRequired: false }),
    cancelAction: async () => fail('CAPABILITY_UNAVAILABLE', 503),
    resolveConfirmation: async (decision): Promise<AutonomyLifeApiResult<ActivityRecord>> => {
      if (decision.decision === 'approve') {
        return ok(activity({ id: 'a-5', kind: 'external.read', reasonSummary: '读到一条公开店铺信息', occurredAt: now() }));
      }
      return ok(activity({ id: 'a-5', kind: 'external.read', status: 'cancelled', reasonSummary: '你拒绝了这次外传', occurredAt: now(), effectVerified: false, resultRef: null }));
    },
  };
}
