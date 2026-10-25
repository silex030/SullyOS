/**
 * /autonomy-life/v1 客户端的行为测试。
 *
 * 这一层的职责只有两件：**没配好就不发请求**、**回包不像样就不当成功**。
 * 所以这里全部用假 transport，断言的是「失败时返回什么码、写请求发没发出去」，
 * 而不是后端语义 —— 真实联调仍以引擎卡的 D1/worker 接线为准。
 */
import { describe, expect, it, vi } from 'vitest';
import { createAutonomyLifeApi, findDeprecatedFields, AUTONOMY_LIFE_PATHS } from './api';
import { AUTONOMY_LIFE_SCHEMA_VERSION } from '../../contracts/autonomyLife';

const ENDPOINT = { baseUrl: 'https://worker.example.com/', headers: { 'X-Client-Token': 't' } };

const budget = [
  { dimension: 'model_calls' as const, used: 1, reserved: 0, limit: 6 },
  { dimension: 'tokens' as const, used: 10, reserved: 0, limit: 1000 },
];

const validState = (over: Record<string, unknown> = {}) => ({
  schemaVersion: AUTONOMY_LIFE_SCHEMA_VERSION,
  charId: 'char-1',
  revision: 3,
  observedAt: 1_793_000_000_000,
  lifePhase: 'idle',
  availability: 'ready',
  reasonCodes: [],
  nextOpportunityAt: null,
  nextCheckAt: 1_793_000_600_000,
  scheduleConfidence: 'persona',
  activeActionId: null,
  pendingCount: 0,
  budgetWindowId: '2026-10-24',
  budget,
  ...over,
});

const envelope = (payload: Record<string, unknown>) => ({
  schemaVersion: AUTONOMY_LIFE_SCHEMA_VERSION,
  requestId: 'req-1',
  serverTime: 1_793_000_000_000,
  ...payload,
});

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const makeApi = (responder: (url: string, init: unknown) => Response | Promise<Response>, endpoint: unknown = ENDPOINT) => {
  const transport = vi.fn(async (url: string, init: unknown) => responder(url, init));
  const api = createAutonomyLifeApi({
    resolveEndpoint: () => endpoint as never,
    transport,
    now: () => 1_793_000_000_000,
    newIdempotencyKey: () => 'idem-fixed',
  });
  return { api, transport };
};

describe('自主生活客户端 · 未配置即停', () => {
  it('没有 worker 地址时不发请求，返回 NOT_CONFIGURED', async () => {
    const { api, transport } = makeApi(() => jsonResponse({}));
    const unconfigured = createAutonomyLifeApi({ resolveEndpoint: () => null, transport: vi.fn() as never });
    const res = await unconfigured.readLife('char-1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('NOT_CONFIGURED');
    expect(transport).not.toHaveBeenCalled();
    // 半配置（只有空 baseUrl）同样拦住
    const blank = createAutonomyLifeApi({
      resolveEndpoint: () => ({ baseUrl: '   ', headers: {} }),
      transport: vi.fn() as never,
    });
    const blankRes = await blank.readLife('char-1');
    expect(blankRes.ok).toBe(false);
    if (!blankRes.ok) expect(blankRes.code).toBe('NOT_CONFIGURED');
    void api;
  });

  it('resolveEndpoint 抛异常也按未配置处理', async () => {
    const api = createAutonomyLifeApi({
      resolveEndpoint: () => {
        throw new Error('boom');
      },
      transport: vi.fn() as never,
    });
    const res = await api.readLife('char-1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('NOT_CONFIGURED');
  });
});

describe('自主生活客户端 · 回包校验', () => {
  it('合法回包被接受，并复用既有认证头', async () => {
    const { api, transport } = makeApi(() =>
      jsonResponse(envelope({ state: validState(), capabilities: [] })),
    );
    const res = await api.readLife('char-1');
    expect(res.ok).toBe(true);
    const [url, init] = transport.mock.calls[0] as [string, { headers: Record<string, string>; route: string }];
    expect(url).toBe(`https://worker.example.com${AUTONOMY_LIFE_PATHS.state('char-1')}`);
    expect(init.headers['X-Client-Token']).toBe('t');
    expect(init.route).toBe('worker');
  });

  it('回包缺信封字段 → MALFORMED_RESPONSE，不当成功', async () => {
    const { api } = makeApi(() => jsonResponse({ state: validState(), capabilities: [] }));
    const res = await api.readLife('char-1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('MALFORMED_RESPONSE');
  });

  it('state 字段不合法 → MALFORMED_RESPONSE', async () => {
    const { api } = makeApi(() =>
      jsonResponse(envelope({ state: validState({ availability: 'sleeping' }), capabilities: [] })),
    );
    const res = await api.readLife('char-1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('MALFORMED_RESPONSE');
  });

  it('服务端串号（回的是别的角色）→ MALFORMED_RESPONSE', async () => {
    const { api } = makeApi(() =>
      jsonResponse(envelope({ state: validState({ charId: 'char-2' }), capabilities: [] })),
    );
    const res = await api.readLife('char-1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('MALFORMED_RESPONSE');
  });

  it('budget 维度不认识时整包拒收，不半截渲染', async () => {
    const { api } = makeApi(() =>
      jsonResponse(
        envelope({
          state: validState({ budget: [{ dimension: 'frequency', used: 1, reserved: 0, limit: 2 }] }),
          capabilities: [],
        }),
      ),
    );
    const res = await api.readLife('char-1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('MALFORMED_RESPONSE');
  });

  it('网络异常 → NETWORK', async () => {
    const api = createAutonomyLifeApi({
      resolveEndpoint: () => ENDPOINT,
      transport: async () => {
        throw new Error('offline');
      },
    });
    const res = await api.readLife('char-1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('NETWORK');
  });

  it('401 无错误体 → UNAUTHENTICATED；429 带 retryAt → 原样透传', async () => {
    const unauthorized = makeApi(() => jsonResponse({}, 401));
    const res1 = await unauthorized.api.readLife('char-1');
    expect(res1.ok).toBe(false);
    if (!res1.ok) expect(res1.code).toBe('UNAUTHENTICATED');

    const quota = makeApi(() =>
      jsonResponse(
        {
          schemaVersion: AUTONOMY_LIFE_SCHEMA_VERSION,
          requestId: 'req-2',
          serverTime: 1,
          error: { code: 'BUDGET_EXHAUSTED', message: '今天额度用完', retryable: true, retryAt: 1_793_000_900_000 },
        },
        429,
      ),
    );
    const res2 = await quota.api.readLife('char-1');
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.code).toBe('BUDGET_EXHAUSTED');
      expect(res2.status).toBe(429);
      expect(res2.retryAt).toBe(1_793_000_900_000);
      expect(res2.retryable).toBe(true);
    }
  });
});

describe('自主生活客户端 · 写请求', () => {
  const boundaryPayload = {
    account: {
      schemaVersion: AUTONOMY_LIFE_SCHEMA_VERSION,
      revision: 3,
      scope: 'account',
      enabled: true,
      globalPaused: false,
      charEnabled: null,
      timezone: 'Asia/Shanghai',
      allowedKinds: null,
      forbiddenCategories: [],
      avoidTopics: [],
      allowFictionalNpc: null,
      doNotDisturb: null,
      limits: {
        accountModelCallsPerDay: 6,
        charModelCallsPerDay: null,
        accountTokensPerDay: null,
        charTokensPerDay: null,
        notificationsPerDay: 1,
        perKindActionsPerDay: 3,
        virtualSpendPerDayMinor: null,
        virtualOrderMaxMinor: null,
      },
      externalGrants: [],
    },
    characterOverrides: null,
    effective: null,
    revision: 4,
    defaults: {
      accountModelCallsPerDay: 6,
      charModelCallsPerDay: 2,
      accountTokensPerDay: 1000,
      charTokensPerDay: 400,
      notificationsPerDay: 1,
      perKindActionsPerDay: 3,
      virtualSpendPerDayMinor: 200,
      virtualOrderMaxMinor: 50,
    },
    maximums: {
      accountModelCallsPerDay: 24,
      charModelCallsPerDay: 12,
      accountTokensPerDay: 1_000_000,
      charTokensPerDay: 400_000,
      notificationsPerDay: 8,
      perKindActionsPerDay: 12,
      virtualSpendPerDayMinor: 5000,
      virtualOrderMaxMinor: 1000,
    },
  };

  it('旧频率字段在本地就被拒，连请求都不发', async () => {
    const { api, transport } = makeApi(() => jsonResponse(envelope({})));
    const res = await api.writeBoundaries({
      scope: 'account',
      expectedRevision: 3,
      changes: { frequency: 'daily', cadenceMinHours: 2, notificationsPerDay: 2 },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('DEPRECATED_FIELD_SENT');
      expect(res.message).toContain('frequency');
      expect(res.message).toContain('cadenceMinHours');
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('findDeprecatedFields 只认契约里的旧字段', () => {
    expect(findDeprecatedFields({ notificationsPerDay: 2 })).toEqual([]);
    expect(findDeprecatedFields({ reserveTokensPerRun: 100 })).toEqual(['reserveTokensPerRun']);
    expect(findDeprecatedFields(null)).toEqual([]);
  });

  it('合法 PATCH 带 expectedRevision 与幂等键', async () => {
    const payload = { ...boundaryPayload, effective: { ...boundaryPayload.account, revision: 4 } };
    const { api, transport } = makeApi(() => jsonResponse(envelope(payload)));
    const res = await api.writeBoundaries({
      scope: 'account',
      expectedRevision: 3,
      changes: { notificationsPerDay: 2 },
    });
    expect(res.ok).toBe(true);
    const [, init] = transport.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(init.method).toBe('PATCH');
    expect(init.headers['Idempotency-Key']).toBe('idem-fixed');
    expect(JSON.parse(init.body)).toMatchObject({ scope: 'account', expectedRevision: 3, changes: { notificationsPerDay: 2 } });
  });

  it('200 但 effective 不合法 → MALFORMED_RESPONSE，不显示已保存', async () => {
    const { api } = makeApi(() => jsonResponse(envelope({ ...boundaryPayload, effective: { nope: true } })));
    const res = await api.writeBoundaries({ scope: 'account', expectedRevision: 3, changes: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('MALFORMED_RESPONSE');
  });

  it('角色层缺少 charId 时不发请求', async () => {
    const { api, transport } = makeApi(() => jsonResponse(envelope({})));
    const res = await api.writeBoundaries({ scope: 'character', expectedRevision: 1, changes: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('NOT_CONFIGURED');
    expect(transport).not.toHaveBeenCalled();
  });

  it('暂停回包区分 acknowledged 与 quiesced', async () => {
    const { api } = makeApi(() =>
      jsonResponse(
        envelope({ acknowledged: true, quiesced: false, state: validState({ availability: 'pausing' }), revision: 5 }),
      ),
    );
    const res = await api.setPause({ scope: 'account', paused: true, expectedRevision: 4 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.acknowledged).toBe(true);
      expect(res.data.quiesced).toBe(false);
      expect(res.data.state?.availability).toBe('pausing');
    }
  });
});

describe('自主生活客户端 · 查询参数', () => {
  it('activity limit 被夹到 1..100，cursor 与 status 原样带上', async () => {
    const { api, transport } = makeApi(() => jsonResponse(envelope({ items: [], nextCursor: null })));
    await api.readActivities({ charId: 'char-1', status: 'unknown', limit: 500, cursor: 'c1' });
    const [url] = transport.mock.calls[0] as unknown as [string, unknown];
    const q = new URL(url).searchParams;
    expect(q.get('limit')).toBe('100');
    expect(q.get('status')).toBe('unknown');
    expect(q.get('cursor')).toBe('c1');
    expect(q.get('charId')).toBe('char-1');
  });
});

describe('自主生活客户端 · 执行链（claim / permit / receipt）', () => {
  const wireAction = (over: Record<string, unknown> = {}) => ({
    id: 'act-1',
    charId: 'char-1',
    kind: 'journal.write',
    status: 'running',
    args: { title: '今天', body: '雨停了。' },
    argsHash: 'hash-1',
    policyVersion: 'autonomy-life-v1',
    leaseEpoch: 2,
    leaseExpiresAt: 1_793_000_060_000,
    permitIssuedAt: 1_793_000_000_000,
    permitNonce: 'nonce-1',
    permitConsumedAt: null,
    installationId: 'inst-1',
    revision: 3,
    windowId: 'w:2026-10-24',
    expiresAt: 1_793_021_600_000,
    ...over,
  });
  const permit = {
    actionId: 'act-1',
    charId: 'char-1',
    installationId: 'inst-1',
    leaseEpoch: 2,
    argsHash: 'hash-1',
    policyVersion: 'autonomy-life-v1',
    reservationId: 'rsv-1',
    nonce: 'nonce-1',
    issuedAt: 1_793_000_000_000,
    expiresAt: 1_793_000_060_000,
  };

  it('claim 带上 installationId；没有动作时返回 null 而不是报错', async () => {
    const { api, transport } = makeApi(() => jsonResponse(envelope({ action: null, leaseEpoch: 0, leaseExpiresAt: null })));
    const res = await api.claim('char-1', 'inst-1');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.action).toBeNull();
    const [url, init] = transport.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toContain('/execution/claim');
    expect(JSON.parse(init.body)).toMatchObject({ charId: 'char-1', installationId: 'inst-1' });
  });

  it('claim 回一个别的角色的动作 → MALFORMED（不能替别人执行）', async () => {
    const { api } = makeApi(() => jsonResponse(envelope({ action: wireAction({ charId: 'char-2' }), leaseEpoch: 2 })));
    const res = await api.claim('char-1', 'inst-1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('MALFORMED_RESPONSE');
  });

  it('commit-permit 只接受同一个 actionId / argsHash 的回包', async () => {
    const ok = makeApi(() => jsonResponse(envelope({ permit, action: wireAction() })));
    expect((await ok.api.commitPermit({ actionId: 'act-1', installationId: 'inst-1', leaseEpoch: 2, argsHash: 'hash-1', policyVersion: 'autonomy-life-v1' })).ok).toBe(true);

    const wrongHash = makeApi(() => jsonResponse(envelope({ permit: { ...permit, argsHash: 'other' }, action: wireAction() })));
    const res = await wrongHash.api.commitPermit({ actionId: 'act-1', installationId: 'inst-1', leaseEpoch: 2, argsHash: 'hash-1', policyVersion: 'autonomy-life-v1' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('MALFORMED_RESPONSE');
  });

  it('receipt 自动带 Idempotency-Key，且只收本动作的回执', async () => {
    const { api, transport } = makeApi(() => jsonResponse(envelope({ action: wireAction({ status: 'succeeded', permitConsumedAt: 1_793_000_010_000 }) })));
    const res = await api.receipt({
      actionId: 'act-1', installationId: 'inst-1', leaseEpoch: 2, argsHash: 'hash-1', status: 'succeeded', resultRef: 'diaries:1',
    });
    expect(res.ok).toBe(true);
    const [, init] = transport.mock.calls[0] as unknown as [string, { headers?: Record<string, string>; body: string }];
    expect(init.headers?.['Idempotency-Key']).toBeTruthy();
    expect(JSON.parse(init.body)).toMatchObject({ installationId: 'inst-1', argsHash: 'hash-1', resultRef: 'diaries:1' });

    const mismatch = makeApi(() => jsonResponse(envelope({ action: wireAction({ id: 'act-other' }) })));
    const bad = await mismatch.api.receipt({ actionId: 'act-1', installationId: 'inst-1', leaseEpoch: 2, argsHash: 'hash-1', status: 'succeeded', resultRef: 'x' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('MALFORMED_RESPONSE');
  });

  it('设备注册缺 installationId 时不发请求', async () => {
    const { api, transport } = makeApi(() => jsonResponse(envelope({ bindingState: 'bound' })));
    const res = await api.registerDevice('   ');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('NOT_CONFIGURED');
    expect(transport).not.toHaveBeenCalled();
  });
});
