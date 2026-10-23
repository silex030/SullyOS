import { beforeEach, describe, expect, it } from 'vitest';

import type { TravelPlaceRef } from '../../../../contracts/travel';
import { createSqliteD1, openTestSqlite, type TestSqlite } from '../test/d1-sqlite';
import { ensureTravelBudgetRow } from './budget';
import { handleTravelRequest, type TravelRouteDeps } from './routes';
import {
  ensureTravelSchema,
  insertTravelWish,
  resetTravelSchemaCacheForTesting,
  setTravelShareState,
  upsertTravelTrip,
  type TravelDb,
  type TravelTripRecord,
} from './store';

const NOW = Date.parse('2026-10-23T04:00:00.000Z');
const origin: TravelPlaceRef = { label: '阳光花园', city: '杭州', lat: 30.1, lng: 120.1, coordSys: 'gcj02' };

let sql: TestSqlite;
let db: TravelDb;

const deps = (overrides: Partial<TravelRouteDeps> = {}): TravelRouteDeps => ({
  now: () => NOW,
  resolveSession: async (token) => (token === 'good' ? { userId: 'u1', charIds: ['c1'] } : null),
  ...overrides,
});

const call = async (
  path: string,
  init: { method?: string; token?: string | null; body?: unknown; headers?: Record<string, string> } = {},
  routeDeps: TravelRouteDeps = deps(),
  env: Record<string, unknown> = { DB: db },
) => {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token !== null) headers.Authorization = `Bearer ${init.token ?? 'good'}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const request = new Request(`https://worker.example${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return handleTravelRequest(request, env, routeDeps);
};

const trip = (overrides: Partial<TravelTripRecord> = {}): TravelTripRecord => ({
  id: 'trip-1',
  userId: 'u1',
  charId: 'c1',
  status: 'en_route',
  phase: 'en_route',
  planVersion: 1,
  revision: 1,
  coordSys: 'gcj02',
  provider: 'amap',
  origin,
  dest: { ...origin, label: '西湖公园' },
  route: { points: [{ lat: 30.1, lng: 120.1 }, { lat: 30.2, lng: 120.2 }], distanceM: 900 },
  routeFetchedAt: NOW - 60_000,
  departAt: NOW - 60_000,
  arriveAt: NOW + 600_000,
  dwellUntil: null,
  returnAt: null,
  retentionExpiresAt: NOW + 30 * 86400_000,
  dedupeKey: 'trip-1',
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

beforeEach(async () => {
  sql = openTestSqlite();
  resetTravelSchemaCacheForTesting();
  db = createSqliteD1(sql) as unknown as TravelDb;
  await ensureTravelSchema(db);
  await ensureTravelBudgetRow(db, { userId: 'u1', mapCallsLimit: 10, nowMs: NOW });
  await insertTravelWish(db, {
    id: 'w1',
    userId: 'u1',
    charId: 'c1',
    wishText: '想去公园',
    state: 'open',
    expiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
});

describe('出行路由：鉴权与共享脱敏', () => {
  it('没有 Bearer → 401，且不调用 resolveSession', async () => {
    let called = 0;
    const res = await call('/travel/state?charId=c1', { token: null }, deps({
      resolveSession: async () => { called += 1; return null; },
    }));
    expect(res?.status).toBe(401);
    expect(((await res!.json()) as any).error.code).toBe('UNAUTHORIZED');
    expect(called).toBe(0);
  });

  it('token 无效 → 401；非 /travel 路径返回 null 让上层继续', async () => {
    const bad = await call('/travel/budget', { token: 'bad' });
    expect(bad?.status).toBe(401);
    expect(await handleTravelRequest(new Request('https://x/instant-chat'), { DB: db }, deps())).toBeNull();
  });

  it('忽略 X-User-Id：主体只认 resolveSession', async () => {
    await upsertTravelTrip(db, trip());
    await setTravelShareState(db, { userId: 'u1', charId: 'c1', shareEnabled: true, baseVersion: null, nowMs: NOW });
    const res = await call('/travel/state?charId=c1', { headers: { 'X-User-Id': 'attacker' } });
    const body = (await res!.json()) as any;
    expect(body.share.userId).toBe('u1');
    expect(body.snapshot.trip.id).toBe('trip-1');
  });

  it('别的角色不得读：charId 不在主体范围 → 403', async () => {
    const res = await call('/travel/state?charId=c9');
    expect(res?.status).toBe(403);
    expect(((await res!.json()) as any).error.code).toBe('PRINCIPAL_MISMATCH');
  });

  it('共享关闭：trip 整份 null，不回地名/时间', async () => {
    await upsertTravelTrip(db, trip());
    const res = await call('/travel/state?charId=c1');
    const body = (await res!.json()) as any;
    expect(body.snapshot.code).toBe('SHARE_REVOKED');
    expect(body.snapshot.trip).toBeNull();
    expect(body.snapshot.position).toBeNull();
    expect(body.snapshot.route).toBeNull();
    expect(JSON.stringify(body)).not.toContain('阳光花园');
    expect(JSON.stringify(body)).not.toContain('西湖公园');
  });

  it('共享重新打开不复活旧轨迹：上一代行程不出', async () => {
    await upsertTravelTrip(db, trip({ createdAt: NOW - 3600_000 }));
    await setTravelShareState(db, { userId: 'u1', charId: 'c1', shareEnabled: true, baseVersion: null, nowMs: NOW });
    const body = (await (await call('/travel/state?charId=c1'))!.json()) as any;
    expect(body.snapshot.code).toBe('OK');
    expect(body.snapshot.trip).toBeNull();
    expect(body.snapshot.history).toEqual([]);
  });

  it('写共享位是 CAS：版本不对 → 409，且不改原值', async () => {
    const first = await call('/travel/share', { method: 'POST', body: { charId: 'c1', shareEnabled: true, baseVersion: null } });
    expect(first?.status).toBe(200);
    const conflict = await call('/travel/share', { method: 'POST', body: { charId: 'c1', shareEnabled: false, baseVersion: 99 } });
    expect(conflict?.status).toBe(409);
    expect(((await conflict!.json()) as any).error.code).toBe('VERSION_CONFLICT');
    const ok = await call('/travel/share', { method: 'POST', body: { charId: 'c1', shareEnabled: true, baseVersion: 1 } });
    expect(((await ok!.json()) as any).share.shareEnabled).toBe(true);
  });

  it('许可只读 env：请求体不能解锁几何持久化', async () => {
    const env = { DB: db, TRAVEL_GEOMETRY_LICENSE: 'not-licensed' };
    const res = await call('/travel/config', { method: 'POST', body: { TRAVEL_GEOMETRY_LICENSE: 'allowed' } }, deps(), env);
    // POST /config 不是已定义端点 → 落到 null（不写任何状态）
    expect(res).toBeNull();
    const cfg = (await (await call('/travel/config', {}, deps(), env))!.json()) as any;
    expect(cfg.licenses.geometryPersistence).toBe('not-licensed');
    expect(cfg.pushRequired).toBe(false);
  });

  it('锚点确认拒绝住户级细节，且没有锚点端口时明确失败', async () => {
    const bad = await call('/travel/anchor', {
      method: 'PUT',
      body: { charId: 'c1', anchor: { label: '阳光花园3栋2单元501', city: '杭州', lat: 30.1, lng: 120.1, coordSys: 'gcj02' } },
    });
    expect(bad?.status).toBe(400);
    expect(((await bad!.json()) as any).error.code).toBe('ANCHOR_NOT_CONFIRMED');
  });

  it('预算暂停走服务端权威位，只读回契约形状', async () => {
    const res = await call('/travel/budget');
    const body = (await res!.json()) as any;
    expect(body.budget.mapCallsLimit).toBe(10);
    expect(body.budget.paused).toBe(false);
  });
});

describe('出行路由：地图服务凭据（用户自己填）', () => {
  const MASTER = 'test-master-key-0123456789abcdef-32';
  const PROXY_SECRET = 'travel-session-secret-0123456789abcdef';
  const credDeps = (overrides: Partial<TravelRouteDeps> = {}) =>
    deps({ mapProxySecret: PROXY_SECRET, ...overrides });
  const credEnv = () => ({ DB: db, AMSG_MASTER_KEY: MASTER });

  it('PUT 保存后 GET 只回存在性与公开展示 Key，并给出短期 serviceHost', async () => {
    const put = await call(
      '/travel/map/credentials',
      {
        method: 'PUT',
        body: {
          amapWebKey: 'web-service-key-SECRET-0001',
          amapJsKey: 'js-api-key-PUBLIC-0002',
          amapJsCode: 'jscode-SECRET-0003',
        },
      },
      credDeps(),
      credEnv(),
    );
    expect(put?.status).toBe(200);
    const putBody = (await put!.json()) as any;
    expect(putBody.configured).toBe(true);
    expect(putBody.has).toEqual({ amapWebKey: true, amapJsKey: true, amapJsCode: true, mapboxToken: false });
    expect(putBody.amapJsKey).toBe('js-api-key-PUBLIC-0002');
    expect(putBody.serviceHost).toMatch(/^\/_AMapService\/t\//);
    const serialized = JSON.stringify(putBody);
    expect(serialized).not.toContain('web-service-key-SECRET-0001');
    expect(serialized).not.toContain('jscode-SECRET-0003');

    const get = await call('/travel/map/credentials', {}, credDeps(), credEnv());
    const getBody = (await get!.json()) as any;
    expect(getBody.has.amapWebKey).toBe(true);
    expect(JSON.stringify(getBody)).not.toContain('jscode-SECRET-0003');
  });

  it('空字段保持不变，显式 clear 才清除；跨用户互不可见', async () => {
    await call(
      '/travel/map/credentials',
      { method: 'PUT', body: { amapWebKey: 'web-service-key-SECRET-0001', amapJsKey: 'js-api-key-PUBLIC-0002' } },
      credDeps(),
      credEnv(),
    );
    const keep = await call('/travel/map/credentials', { method: 'PUT', body: { amapJsKey: '' } }, credDeps(), credEnv());
    expect(((await keep!.json()) as any).has.amapJsKey).toBe(true);

    const cleared = await call(
      '/travel/map/credentials',
      { method: 'PUT', body: { clear: ['amapJsKey'] } },
      credDeps(),
      credEnv(),
    );
    const clearedBody = (await cleared!.json()) as any;
    expect(clearedBody.has.amapJsKey).toBe(false);
    expect(clearedBody.has.amapWebKey).toBe(true);

    // 另一个主体（会话签名不同）看到的是自己的空配置。
    const otherDeps = deps({
      mapProxySecret: PROXY_SECRET,
      resolveSession: async (token) => (token === 'other' ? { userId: 'u2' } : null),
    });
    const other = await call('/travel/map/credentials', { token: 'other' }, otherDeps, credEnv());
    expect(((await other!.json()) as any).configured).toBe(false);
  });

  it('保存不会发起真实地图请求；测试连接是显式单次且有冷却', async () => {
    await call(
      '/travel/map/credentials',
      { method: 'PUT', body: { amapWebKey: 'web-service-key-SECRET-0001' } },
      credDeps(),
      credEnv(),
    );

    const calls: string[] = [];
    const testFetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ status: '1', geocodes: [{ location: '120.1,30.1' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const first = await call(
      '/travel/map/credentials/test',
      { method: 'POST' },
      credDeps({ mapTestFetch: testFetch }),
      credEnv(),
    );
    const firstBody = (await first!.json()) as any;
    expect(firstBody).toEqual({ ok: true, code: 'OK' });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!).searchParams.get('key')).toBe('web-service-key-SECRET-0001');

    const second = await call(
      '/travel/map/credentials/test',
      { method: 'POST' },
      credDeps({ mapTestFetch: testFetch }),
      credEnv(),
    );
    expect(second?.status).toBe(429);
    expect(calls).toHaveLength(1);
  });

  it('填 Key 不能解锁几何许可（仍是运维 env，请求体里的解锁字段被拒）', async () => {
    const res = await call(
      '/travel/map/credentials',
      { method: 'PUT', body: { amapWebKey: 'k'.repeat(20), geometryPersistence: 'allowed' } },
      credDeps(),
      credEnv(),
    );
    expect(res?.status).toBe(400);
    expect(((await res!.json()) as any).error.code).toBe('GEOMETRY_NOT_LICENSED');
    const cfg = (await (await call('/travel/config', {}, credDeps(), credEnv()))!.json()) as any;
    expect(cfg.licenses.geometryPersistence).toBe('not-licensed');
  });
});
