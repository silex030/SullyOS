/**
 * 出行 · 端到端集成回归（真实 SQLite + 真实路由 + 真实 provider 契约）
 *
 * 这条测试要回答的不是「模块都在」，而是：
 * 1. 路由真的挂在 Bearer 主体上（伪造 `X-User-Id` 拿不到任何东西）；
 * 2. 设置/锚点真的落进 SQLite，CAS 真的会冲突，许可真的不能由请求体解锁；
 * 3. tick 用**真实 provider 实现**打真实出口时，**每个实际请求只扣一格**，tick 不另扣；
 * 4. 共享关闭后公开读里没有地名/坐标/历史，静态图短链也立即失效；
 * 5. 轨迹只在「几何许可 + 本次共享代际」时出现，没有真实几何就是空。
 *
 * 注意：网络由注入的 fetch 桩代替（离线，不谎称真实高德调用），但 provider 的
 * 请求构造、响应解析、预算回调、错误映射都是生产代码。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { TRAVEL_SCHEMA_SQL } from '../../../../contracts/travel';
import { createSqliteD1, openTestSqlite, type TestSqlite } from '../test/d1-sqlite';
import { issueTravelSession } from './auth';
import { ensureTravelBudgetRow, getTravelBudget } from './budget';
import { createAnchorSearchPort } from './anchorSearch';
import { createAmapProvider } from './providerAmap';
import { handleTravelRequest, type TravelRouteDeps } from './routes';
import { handleTravelStaticMap, buildStaticMapUrl } from './staticmap';
import { runTravelTickForSubject } from './tick';
import {
  ensureTravelSchema,
  getActiveTravelTrip,
  getTravelAnchor,
  getTravelSettings,
  insertTravelWish,
  resetTravelSchemaCacheForTesting,
  setTravelCharEnabled,
  setTravelShareState,
  upsertTravelSettings,
  type TravelDb,
} from './store';

const NOW = Date.parse('2026-10-23T04:00:00.000Z');
const SECRET = 'travel-integration-secret-0123456789abcdef';
const USER = '11111111-1111-4111-8111-111111111111';
const CHAR = 'char-a';
const env = { DB: null as unknown, TRAVEL_SESSION_SECRET: SECRET, AMAP_WEB_KEY: 'test-web-key' };

let sql: TestSqlite;
let db: TravelDb;

/** 离线高德桩：只覆盖本次用到的两个端点，响应形状按官方字段。 */
const amapFetch = (calls: string[]) => (async (input: RequestInfo | URL) => {
  const url = String(input);
  calls.push(url);
  if (url.includes('/v3/place/text')) {
    return new Response(JSON.stringify({
      status: '1',
      infocode: '10000',
      pois: [
        {
          id: 'B0FFPOI1',
          name: '西湖文化广场',
          type: '风景名胜',
          cityname: '杭州市',
          adname: '拱墅区',
          location: '120.163000,30.279000',
          distance: '880',
        },
        {
          id: 'B0FFPOI2',
          name: '孤山公园',
          type: '公园',
          cityname: '杭州市',
          adname: '西湖区',
          location: '120.140000,30.250000',
          distance: '1500',
        },
      ],
    }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (url.includes('/v3/direction/walking')) {
    return new Response(JSON.stringify({
      status: '1',
      infocode: '10000',
      route: {
        paths: [{
          distance: '900',
          duration: '600',
          steps: [{ instruction: '向东步行', polyline: '120.100000,30.100000;120.163000,30.279000', distance: '900', duration: '600' }],
        }],
      },
    }), { headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`unexpected amap url ${url}`);
}) as unknown as typeof globalThis.fetch;

const token = async (): Promise<string> => {
  const issued = await issueTravelSession({ userId: USER, env: env as never, nowMs: NOW });
  if (!issued.ok) throw new Error('issue failed');
  return issued.token;
};

const travelDeps = (overrides: Partial<TravelRouteDeps> = {}): TravelRouteDeps => ({
  resolveSession: async (_token, request) => {
    const { resolveTravelSession } = await import('./auth');
    const res = await resolveTravelSession({
      request: request ?? new Request('https://x/travel/state'),
      env: env as never,
      nowMs: NOW,
    });
    if (res.ok) return { userId: res.userId };
    return { ok: false, status: res.status, code: res.code, detail: res.reason };
  },
  now: () => NOW,
  staticMapSecret: SECRET,
  ...overrides,
});

const call = async (
  path: string,
  init: { method?: string; body?: unknown; bearer?: string | null; headers?: Record<string, string>; deps?: Partial<TravelRouteDeps> } = {},
) => {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  const bearer = init.bearer === undefined ? await token() : init.bearer;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const request = new Request(`https://worker.example/amsg${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const response = await handleTravelRequest(request, env as never, travelDeps(init.deps));
  return response;
};

beforeEach(async () => {
  sql = openTestSqlite();
  resetTravelSchemaCacheForTesting();
  db = createSqliteD1(sql) as unknown as TravelDb;
  env.DB = db;
  await ensureTravelSchema(db);
  if (!sql.prepare("SELECT name FROM sqlite_master WHERE name = 'travel_budget_state'").get()) {
    sql.exec(TRAVEL_SCHEMA_SQL);
  }
  await ensureTravelBudgetRow(db, { userId: USER, mapCallsLimit: 10, nowMs: NOW });
});

describe('出行端到端：会话主体 / 设置 / 锚点', () => {
  it('没有 Bearer 或伪造 X-User-Id → 401（共享口令/自报身份都不是身份）', async () => {
    const noAuth = await call('/travel/state?charId=char-a', { bearer: null });
    expect(noAuth?.status).toBe(401);

    const forged = await call('/travel/state?charId=char-a', {
      bearer: null,
      headers: { 'X-User-Id': USER, 'X-Client-Token': SECRET },
    });
    expect(forged?.status).toBe(401);

    const fakeToken = await call('/travel/state?charId=char-a', { bearer: 'not-a-session' });
    expect(fakeToken?.status).toBe(401);
  });

  it('会话主体与 X-User-Id 不一致 → 403 PRINCIPAL_MISMATCH', async () => {
    const res = await call('/travel/settings', { headers: { 'X-User-Id': 'another-user' } });
    expect(res?.status).toBe(403);
    expect(await res!.json()).toMatchObject({ error: { code: 'PRINCIPAL_MISMATCH' } });
  });

  it('设置缺行 → null（不默认开启）；PUT 后落库并 +1；旧版本再写 → 409', async () => {
    const before = await call('/travel/settings');
    expect(await before!.json()).toMatchObject({ settings: null });

    const created = await call('/travel/settings', {
      method: 'PUT',
      body: { enabled: true, baseVersion: null, budgetTz: 'Asia/Shanghai' },
    });
    expect(created?.status).toBe(200);
    const createdBody = await created!.json() as { settings: { enabled: boolean; version: number } };
    expect(createdBody.settings.enabled).toBe(true);
    expect(createdBody.settings.version).toBe(1);

    const stored = await getTravelSettings(db, USER);
    expect(stored?.enabled).toBe(true);

    const conflict = await call('/travel/settings', {
      method: 'PUT',
      body: { enabled: false, baseVersion: 0 },
    });
    expect(conflict?.status).toBe(409);
    expect((await getTravelSettings(db, USER))?.enabled).toBe(true);
  });

  it('合规许可不能由请求体解锁', async () => {
    await upsertTravelSettings(db, { userId: USER, nowMs: NOW, baseVersion: null, enabled: true });
    const res = await call('/travel/settings', {
      method: 'PUT',
      body: { enabled: true, baseVersion: 1, geometryPersistence: 'allowed' },
    });
    expect(res?.status).toBe(400);
    expect(await res!.json()).toMatchObject({ error: { code: 'GEOMETRY_NOT_LICENSED' } });
  });

  it('锚点：搜索只回地名 + 不透明 placeId，确认后落库，读回来没有坐标', async () => {
    const calls: string[] = [];
    const provider = createAmapProvider(
      { resolveKey: () => 'test-web-key' },
      { fetch: amapFetch(calls), reserveMapCall: () => ({ allowed: true }), now: () => NOW },
    );
    const port = createAnchorSearchPort({ provider, secret: SECRET, now: () => NOW });
    const deps = { anchorSearchFor: () => port };

    const search = await call(
      `/travel/anchor/search?q=${encodeURIComponent('西湖文化广场')}&city=${encodeURIComponent('杭州')}`,
      { deps },
    );
    expect(search?.status).toBe(200);
    const body = await search!.json() as { results: Array<Record<string, unknown>> };
    expect(body.results).toHaveLength(2);
    expect(body.results[0].label).toBe('西湖文化广场');
    expect(body.results[0].lat).toBeUndefined();
    expect(body.results[0].lng).toBeUndefined();
    expect(typeof body.results[0].placeId).toBe('string');

    const placeId = String(body.results[0].placeId);
    const confirmed = await call('/travel/anchor', {
      method: 'POST',
      body: { charId: CHAR, placeId },
      deps,
    });
    expect(confirmed?.status).toBe(200);

    const row = await getTravelAnchor(db, { userId: USER, charId: CHAR });
    expect(row?.label).toBe('西湖文化广场');
    expect(row?.city).toContain('杭州');

    const read = await call(`/travel/anchor?charId=${CHAR}`);
    const readBody = await read!.json() as { anchor: Record<string, unknown> };
    expect(readBody.anchor.label).toBe('西湖文化广场');
    expect(readBody.anchor.lat).toBeUndefined();
    expect(readBody.anchor.lng).toBeUndefined();
    expect(readBody.anchor.confirmedAt).toBe(NOW);
  });

  it('锚点搜索：假的/被改过的 placeId 不会被落库', async () => {
    const provider = createAmapProvider(
      { resolveKey: () => 'test-web-key' },
      { fetch: amapFetch([]), reserveMapCall: () => ({ allowed: true }), now: () => NOW },
    );
    const port = createAnchorSearchPort({ provider, secret: SECRET, now: () => NOW });
    const res = await call('/travel/anchor', {
      method: 'POST',
      body: { charId: CHAR, placeId: 'forged.deadbeef' },
      deps: { anchorSearchFor: () => port },
    });
    expect(res?.status).toBe(400);
    expect(await getTravelAnchor(db, { userId: USER, charId: CHAR })).toBeNull();
  });
});

describe('出行端到端：tick 真正打地图出口，且每个请求只扣一格', () => {
  const seedEnabled = async () => {
    await upsertTravelSettings(db, { userId: USER, nowMs: NOW, baseVersion: null, enabled: true });
    await setTravelCharEnabled(db, { userId: USER, charId: CHAR, enabled: true, nowMs: NOW });
    await insertTravelWish(db, {
      id: 'w1', userId: USER, charId: CHAR, wishText: '想去个安静的地方', state: 'open',
      expiresAt: null, createdAt: NOW, updatedAt: NOW,
    });
  };

  const anchor = {
    label: '阳光花园', city: '杭州', lat: 30.1, lng: 120.1,
    coordSys: 'gcj02' as const, precision: 'area' as const,
    confirmedAt: NOW - 86_400_000, source: 'user' as const,
  };

  const wiring = (calls: string[], licensed: boolean) => {
    const fetchImpl = amapFetch(calls);
    const reserve = async () => {
      const { reserveMapCall } = await import('./budget');
      const result = await reserveMapCall(db, { userId: USER, nowMs: NOW });
      return result.ok ? { allowed: true as const } : { allowed: false as const, code: result.code };
    };
    const providers = [createAmapProvider(
      { resolveKey: () => 'test-web-key' },
      { fetch: fetchImpl, reserveMapCall: reserve, now: () => NOW },
    )];
    return {
      now: () => NOW,
      fetch: fetchImpl,
      providers,
      region: 'CN' as const,
      readAnchor: async () => anchor,
      licensedGeometry: licensed,
      dwellMinutes: 30,
    };
  };

  it('搜索 + 路线 = 2 次真实请求 = 2 格额度（不双扣），无几何许可不落路线', async () => {
    await seedEnabled();
    const calls: string[] = [];
    const out = await runTravelTickForSubject(db, { userId: USER, charId: CHAR }, wiring(calls, false));

    expect(out.searched).toBe(true);
    // 第一跳只搜候选：1 个真实请求 = 1 格（tick 自己不再预留，避免双扣）。
    expect(calls.filter((u) => u.includes('/v3/place/text'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('/v3/direction/walking'))).toHaveLength(0);

    const budget = await getTravelBudget(db, { userId: USER, nowMs: NOW });
    expect(budget?.mapCallsUsed).toBe(1);
    expect(budget?.mapAttemptsUsed).toBe(1);

    expect(await getActiveTravelTrip(db, { userId: USER, charId: CHAR })).toBeNull();

    // 第二轮：模型选了候选（这里直接给一个端口），路线请求让行程落 planned。
    const { listTravelCandidates } = await import('./store');
    const candidates = await listTravelCandidates(db, { userId: USER, wishId: 'w1', nowMs: NOW });
    expect(candidates.length).toBeGreaterThan(0);
    const decisionPort = { choose: async () => ({ kind: 'choose', candidateId: candidates[0].id }) };
    const calls2: string[] = [];
    const out2 = await runTravelTickForSubject(
      db,
      { userId: USER, charId: CHAR },
      { ...wiring(calls2, false), decisionPort },
    );
    expect(out2.planned).toBe(true);

    const planned = await getActiveTravelTrip(db, { userId: USER, charId: CHAR });
    expect(planned?.status).toBe('planned');
    // 几何未许可 → 路线不落库（memory-only）
    expect(planned?.route).toBeNull();
    expect(planned?.routeFetchedAt).toBeNull();
    // 第二个真实请求（路线）只再扣一格：总共 2，不是 3。
    expect(calls2.filter((u) => u.includes('/v3/direction/walking'))).toHaveLength(1);
    const budget2 = await getTravelBudget(db, { userId: USER, nowMs: NOW });
    expect(budget2?.mapCallsUsed).toBe(2);
  });

  it('几何许可时路线落库，en_route 相位会写入真实采样（不是插值轨迹）', async () => {
    await seedEnabled();
    const calls: string[] = [];
    const { listTravelCandidates } = await import('./store');
    await runTravelTickForSubject(db, { userId: USER, charId: CHAR }, wiring(calls, true));
    const candidates = await listTravelCandidates(db, { userId: USER, wishId: 'w1', nowMs: NOW });
    const decisionPort = { choose: async () => ({ kind: 'choose', candidateId: candidates[0].id }) };
    await runTravelTickForSubject(
      db,
      { userId: USER, charId: CHAR },
      { ...wiring(calls, true), decisionPort },
    );

    const trip = await getActiveTravelTrip(db, { userId: USER, charId: CHAR });
    expect(trip?.route?.points.length).toBe(2);

    // 到了出发时间 → en_route，然后写一个采样点。
    const later = (trip!.departAt ?? NOW) + 60_000;
    const advance = await runTravelTickForSubject(
      db,
      { userId: USER, charId: CHAR },
      { ...wiring([], true), now: () => later },
    );
    expect(advance.advanced).toContain('en_route');

    const { listTravelPositions } = await import('./store');
    const positions = await listTravelPositions(db, { userId: USER, tripId: trip!.id });
    expect(positions.length).toBeGreaterThan(0);
    expect(positions[0].coordSys).toBe('gcj02');
  });

  it('账号总开关关闭 / 角色未启用 → 一次请求都不发', async () => {
    await insertTravelWish(db, {
      id: 'w1', userId: USER, charId: CHAR, wishText: '想出门', state: 'open',
      expiresAt: null, createdAt: NOW, updatedAt: NOW,
    });
    const calls: string[] = [];
    const out = await runTravelTickForSubject(db, { userId: USER, charId: CHAR }, wiring(calls, false));
    expect(out.skipped).toContain('disabled');
    expect(calls).toHaveLength(0);

    await upsertTravelSettings(db, { userId: USER, nowMs: NOW, baseVersion: null, enabled: true });
    const out2 = await runTravelTickForSubject(db, { userId: USER, charId: CHAR }, wiring(calls, false));
    expect(out2.skipped).toContain('char_disabled');
    expect(calls).toHaveLength(0);
  });
});

describe('出行端到端：角色自己的选择权威（P1-6）与许可收口（P2-8）', () => {
  const seed = async () => {
    await upsertTravelSettings(db, { userId: USER, nowMs: NOW, baseVersion: null, enabled: true });
    await setTravelCharEnabled(db, { userId: USER, charId: CHAR, enabled: true, nowMs: NOW });
    await insertTravelWish(db, {
      id: 'w1', userId: USER, charId: CHAR, wishText: '想找个安静的地方', state: 'open',
      expiresAt: null, createdAt: NOW, updatedAt: NOW,
    });
  };
  const anchor = {
    label: '阳光花园', city: '杭州', lat: 30.1, lng: 120.1,
    coordSys: 'gcj02' as const, precision: 'area' as const,
    confirmedAt: NOW - 86_400_000, source: 'user' as const,
  };
  const buildWiring = (opts: { failRouteTimes?: number; licensed?: boolean } = {}) => {
    const calls: string[] = [];
    let routeFails = opts.failRouteTimes ?? 0;
    const inner = amapFetch(calls);
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v3/direction/walking') && routeFails > 0) {
        routeFails -= 1;
        throw new Error('network down');
      }
      return inner(input as never);
    }) as unknown as typeof globalThis.fetch;
    const reserve = async () => {
      const { reserveMapCall } = await import('./budget');
      const result = await reserveMapCall(db, { userId: USER, nowMs: NOW });
      return result.ok ? { allowed: true as const } : { allowed: false as const, code: result.code };
    };
    const providers = [createAmapProvider(
      { resolveKey: () => 'test-web-key' },
      { fetch: fetchImpl, reserveMapCall: reserve, now: () => NOW },
    )];
    return {
      calls,
      wiring: {
        now: () => NOW,
        fetch: fetchImpl,
        providers,
        region: 'CN' as const,
        readAnchor: async () => anchor,
        licensedGeometry: opts.licensed === true,
        dwellMinutes: 30,
      },
    };
  };

  it('模型选第二个候选后路线失败：下一跳仍然去同一个，不退回列表第一个；重试能建新一代', async () => {
    await seed();
    const first = buildWiring({ failRouteTimes: 1 });
    await runTravelTickForSubject(db, { userId: USER, charId: CHAR }, first.wiring);
    const { listTravelCandidates, getTravelWish, listTripEvents } = await import('./store');
    const candidates = await listTravelCandidates(db, { userId: USER, wishId: 'w1', nowMs: NOW });
    expect(candidates.length).toBe(2);
    const secondLabel = candidates[1].label;
    expect(candidates[0].label).not.toBe(secondLabel);

    const decisionPort = { choose: async () => ({ kind: 'choose', candidateId: candidates[1].id }) };
    const failed = await runTravelTickForSubject(
      db,
      { userId: USER, charId: CHAR },
      { ...first.wiring, decisionPort },
    );
    expect(failed.planned).toBe(false);

    // 选择已经落库；失败的一代是终态（不会一直占着 active），愿望回到可重试。
    const wish = await getTravelWish(db, { userId: USER, wishId: 'w1' });
    expect(wish?.selectedCandidateId).toBe(candidates[1].id);
    // 角色已经决定：技术失败不把愿望打回「重新选」（重选=再一次真实模型开销）
    expect(wish?.state).toBe('chosen');
    const aborted = await getActiveTravelTrip(db, { userId: USER, charId: CHAR });
    expect(aborted).toBeNull();
    const events = await listTripEvents(db, {
      userId: USER,
      tripId: (await import('./store').then(async (m) => {
        const row = await db.prepare('SELECT id FROM travel_trips ORDER BY plan_version DESC LIMIT 1')
          .bind().first();
        return String(row?.id ?? '');
      })),
    });
    expect(events.some((e) => e.kind === 'provider_failed')).toBe(true);

    // 下一跳：不再调用模型（没有新决策），直接用已落库的选择建新一代 → planned 且目的地是同一个。
    const retry = buildWiring({});
    const second = await runTravelTickForSubject(
      db,
      { userId: USER, charId: CHAR },
      { ...retry.wiring, decisionPort: { choose: async () => { throw new Error('不该再问模型'); } } },
    );
    expect(second.planned).toBe(true);
    const trip = await getActiveTravelTrip(db, { userId: USER, charId: CHAR });
    expect(trip?.status).toBe('planned');
    expect(trip?.dest?.label).toBe(secondLabel);
    expect(trip?.planVersion).toBe(2);
  });

  it('cron 入口以 env 许可为准：wiring 传 true 也不能把几何写进库', async () => {
    await seed();
    const { runTravelTick } = await import('./tick');
    const w = buildWiring({ licensed: true });
    await runTravelTick(
      { DB: db, TRAVEL_GEOMETRY_LICENSE: 'not-allowed' } as never,
      {
        ...w.wiring,
        licensedGeometry: true,
        wiringForSubject: () => ({ licensedGeometry: true }),
      },
    );
    // 先搜候选；再手动给一次决策后的排路线机会
    const { listTravelCandidates } = await import('./store');
    const candidates = await listTravelCandidates(db, { userId: USER, wishId: 'w1', nowMs: NOW });
    if (candidates.length > 0) {
      await runTravelTick(
        { DB: db, TRAVEL_GEOMETRY_LICENSE: 'not-allowed' } as never,
        {
          ...w.wiring,
          licensedGeometry: true,
          decisionPort: { choose: async () => ({ kind: 'choose', candidateId: candidates[0].id }) },
          wiringForSubject: () => ({
            licensedGeometry: true,
            decisionPort: { choose: async () => ({ kind: 'choose', candidateId: candidates[0].id }) },
          }),
        },
      );
    }
    const trip = await getActiveTravelTrip(db, { userId: USER, charId: CHAR });
    expect(trip?.route ?? null).toBeNull();
  });
});

describe('出行端到端：共享撤销 / 静态图 / 角色上下文', () => {
  it('共享关闭：公开快照没有任何地名，历史为空；/travel/context 仍给角色自知（无坐标）', async () => {
    await setTravelShareState(db, { userId: USER, charId: CHAR, shareEnabled: false, baseVersion: null, nowMs: NOW });
    const state = await call(`/travel/state?charId=${CHAR}`);
    const body = await state!.json() as {
      snapshot: { code: string; trip: unknown; position: unknown; route: unknown; history: unknown[] };
      share: { shareEnabled: boolean };
    };
    expect(body.snapshot.code).toBe('SHARE_REVOKED');
    expect(body.snapshot.trip).toBeNull();
    expect(body.snapshot.position).toBeNull();
    expect(body.snapshot.route).toBeNull();
    expect(body.snapshot.history).toEqual([]);

    const context = await call(`/travel/context?charId=${CHAR}`);
    const contextBody = await context!.json() as Record<string, unknown>;
    expect(contextBody.shareEnabled).toBe(false);
    expect(contextBody.shareKnown).toBe(true);
    expect(JSON.stringify(contextBody)).not.toMatch(/"lat"|"lng"|30\.1|120\.1/);
  });

  it('静态图：共享关闭 → 403 SHARE_REVOKED 且 no-store；签名过期 → 403', async () => {
    const url = await buildStaticMapUrl({ userId: USER, charId: CHAR, secret: SECRET, nowMs: NOW });
    expect(url).toBeTruthy();
    const absolute = `https://worker.example/amsg${url}`;

    const revoked = await handleTravelStaticMap(
      new Request(absolute),
      { DB: db, AMAP_WEB_KEY: 'test-web-key' } as never,
      { sessionSecret: SECRET, userId: null, now: () => NOW, fetch: amapFetch([]) },
    );
    expect(revoked.status).toBe(403);
    expect(revoked.headers.get('Cache-Control')).toContain('no-store');
    expect(await revoked.json()).toMatchObject({ error: { code: 'SHARE_REVOKED' } });

    const expired = await handleTravelStaticMap(
      new Request(absolute),
      { DB: db, AMAP_WEB_KEY: 'test-web-key' } as never,
      { sessionSecret: SECRET, userId: null, now: () => NOW + 60 * 60_000, fetch: amapFetch([]) },
    );
    expect(expired.status).toBe(403);
    const expiredBody = await expired.json() as { error: { detail?: string } };
    expect(expiredBody.error.detail).toBe('staticmap-expired');
  });

  it('静态图：共享开着但没有高德 Web Key → 503，不伪造图片', async () => {
    await setTravelShareState(db, { userId: USER, charId: CHAR, shareEnabled: true, baseVersion: null, nowMs: NOW });
    const url = await buildStaticMapUrl({ userId: USER, charId: CHAR, secret: SECRET, nowMs: NOW });
    const res = await handleTravelStaticMap(
      new Request(`https://worker.example/amsg${url}`),
      { DB: db } as never,
      { sessionSecret: SECRET, userId: null, now: () => NOW, fetch: amapFetch([]) },
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });
});
