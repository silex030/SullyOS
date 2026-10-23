import { beforeEach, describe, expect, it } from 'vitest';

import { TRAVEL_SCHEMA_SQL } from '../../../../contracts/travel';
import { createSqliteD1, openTestSqlite, type TestSqlite } from '../test/d1-sqlite';
import { ensureTravelBudgetRow, getTravelBudget, setTravelBudgetPaused } from './budget';
import { runTravelTickForSubject, nextPhaseFor } from './tick';
import { TravelProviderError, type TravelMapProvider } from './provider';
import {
  ensureTravelSchema,
  getActiveTravelTrip,
  getTravelWish,
  insertTravelWish,
  resetTravelSchemaCacheForTesting,
  saveTravelCandidates,
  setTravelCharEnabled,
  upsertTravelSettings,
  upsertTravelTrip,
  type TravelDb,
} from './store';
import { buildTravelSnapshot } from './state';

const NOW = Date.parse('2026-10-23T04:00:00.000Z');
const subject = { userId: 'u1', charId: 'c1' };
const anchor = {
  label: '阳光花园',
  city: '杭州',
  lat: 30.1,
  lng: 120.1,
  coordSys: 'gcj02' as const,
  precision: 'area' as const,
  confirmedAt: NOW - 86400_000,
  source: 'user' as const,
};

let sql: TestSqlite;
let db: TravelDb;

const provider = (overrides: Partial<TravelMapProvider> = {}): TravelMapProvider & { routeCalls: number; searchCalls: number } => {
  const p = {
    routeCalls: 0,
    searchCalls: 0,
    id: 'amap' as const,
    coordSys: 'gcj02' as const,
    regions: ['CN' as const],
    supports: (region: 'CN' | 'overseas') => region === 'CN',
    async searchCandidates() {
      p.searchCalls += 1;
      return [{
        id: 'poi-1', label: '西湖公园', category: '公园', city: '杭州',
        location: { lat: 30.2, lng: 120.2, coordSys: 'gcj02' as const }, distanceM: 900, provider: 'amap' as const,
      }];
    },
    async route() {
      p.routeCalls += 1;
      return {
        provider: 'amap' as const,
        coordSys: 'gcj02' as const,
        points: [{ lat: 30.1, lng: 120.1 }, { lat: 30.2, lng: 120.2 }],
        distanceM: 900,
        durationS: 600,
        steps: [],
        license: {
          geometryPersistence: 'not-licensed' as const,
          basemapDisplay: 'not-configured' as const,
          memoryOnly: true as const,
          attribution: '高德地图',
          termsRef: 'terms',
        },
      };
    },
    async geocodeAnchor() { throw new Error('unused'); },
    ...overrides,
  };
  return p as TravelMapProvider & { routeCalls: number; searchCalls: number };
};

const baseWiring = (overrides: Record<string, unknown> = {}) => ({
  now: () => NOW,
  fetch: (async () => { throw new Error('no network in test'); }) as unknown as typeof globalThis.fetch,
  providers: [provider()],
  region: 'CN' as const,
  readAnchor: async () => anchor,
  dwellMinutes: 30,
  ...overrides,
});

beforeEach(async () => {
  sql = openTestSqlite();
  resetTravelSchemaCacheForTesting();
  db = createSqliteD1(sql) as unknown as TravelDb;
  await ensureTravelSchema(db);
  if (!sql.prepare("SELECT name FROM sqlite_master WHERE name = 'travel_budget_state'").get()) {
    sql.exec(TRAVEL_SCHEMA_SQL);
  }
  await ensureTravelBudgetRow(db, { userId: 'u1', mapCallsLimit: 10, nowMs: NOW });
  // 授权边界：账号总开关 + 角色级开关都必须显式打开（缺行 = 不允许）。
  const created = await upsertTravelSettings(db, { userId: 'u1', nowMs: NOW, baseVersion: null, enabled: true });
  if (!created.ok) throw new Error('settings seed failed');
  await setTravelCharEnabled(db, { userId: 'u1', charId: 'c1', enabled: true, nowMs: NOW });
});

describe('后台 tick：并发、暂停、断网、无 ETA', () => {
  it('两个并发 tick 只有一方调模型、只有一方排路线', async () => {
    const p = provider();
    let modelCalls = 0;
    const decisionPort = {
      async choose() {
        modelCalls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return { kind: 'choose', candidateId: 'cand-1' };
      },
    };
    await insertTravelWish(db, {
      id: 'w1', userId: 'u1', charId: 'c1', wishText: '想去公园', state: 'candidates_ready',
      expiresAt: null, createdAt: NOW, updatedAt: NOW,
    });
    await saveTravelCandidates(db, {
      userId: 'u1', wishId: 'w1', nowMs: NOW,
      candidates: [{
        id: 'cand-1', userId: 'u1', wishId: 'w1', provider: 'amap', label: '西湖公园',
        city: '杭州', lat: 30.2, lng: 120.2, coordSys: 'gcj02', distanceM: 900,
        expiresAt: NOW + 3600_000, createdAt: NOW,
      }],
    });

    const [a, b] = await Promise.all([
      runTravelTickForSubject(db, subject, baseWiring({ providers: [p], decisionPort, licensedGeometry: false })),
      runTravelTickForSubject(db, subject, baseWiring({ providers: [p], decisionPort, licensedGeometry: false })),
    ]);

    expect(modelCalls).toBe(1);
    expect(p.routeCalls).toBe(1);
    const trips = sql.prepare('SELECT id FROM travel_trips').all();
    expect(trips.length).toBe(1);
    const losers = [a, b].filter((o) => o.skipped.includes('cas_conflict'));
    expect(losers.length).toBe(1);
  });

  it('暂停在真正执行前复核：不再起模型/地图请求', async () => {
    const p = provider();
    let modelCalls = 0;
    await setTravelBudgetPaused(db, { userId: 'u1', paused: true, nowMs: NOW });
    await insertTravelWish(db, {
      id: 'w1', userId: 'u1', charId: 'c1', wishText: '想去公园', state: 'open',
      expiresAt: null, createdAt: NOW, updatedAt: NOW,
    });
    const out = await runTravelTickForSubject(db, subject, baseWiring({
      providers: [p],
      decisionPort: { async choose() { modelCalls += 1; return { kind: 'wait' }; } },
    }));
    expect(out.skipped).toContain('paused');
    expect(modelCalls).toBe(0);
    expect(p.searchCalls).toBe(0);
    expect(p.routeCalls).toBe(0);
  });

  it('页面关着也推进：只靠时钟与库，不依赖任何订阅/前端请求', async () => {
    await upsertTravelTrip(db, {
      id: 't1', userId: 'u1', charId: 'c1', status: 'planned', phase: 'planned', planVersion: 1,
      revision: 1, coordSys: 'gcj02', provider: 'amap', origin: anchor, dest: { ...anchor, label: '西湖公园' },
      route: null, routeFetchedAt: null, departAt: NOW - 1000, arriveAt: NOW + 600_000,
      dwellUntil: NOW + 2_400_000, returnAt: NOW + 3_000_000,
      retentionExpiresAt: NOW + 86400_000, dedupeKey: 'd1', createdAt: NOW - 5000, updatedAt: NOW - 5000,
    });
    const out = await runTravelTickForSubject(db, subject, { now: () => NOW });
    expect(out.advanced).toEqual(['en_route']);
    const trip = await getActiveTravelTrip(db, { userId: 'u1', charId: 'c1' });
    expect(trip?.status).toBe('en_route');
    expect(nextPhaseFor({ ...trip!, arriveAt: NOW - 1 }, NOW)).toEqual({ kind: 'advance', to: 'dwelling' });
  });

  it('搜索失败：愿望保留 open，不清成「不想出门」；tick 自己不扣费（扣费只在 provider 出口）', async () => {
    const p = provider({ async searchCandidates() { throw new TravelProviderError({ kind: 'transient', code: 'PROVIDER_FAILED', provider: 'amap' }); } });
    await insertTravelWish(db, {
      id: 'w1', userId: 'u1', charId: 'c1', wishText: '想去公园', state: 'open',
      expiresAt: null, createdAt: NOW, updatedAt: NOW,
    });
    const out = await runTravelTickForSubject(db, subject, baseWiring({ providers: [p] }));
    expect(out.skipped).toContain('provider_failed');
    // 手写的假 provider 不经过真实 provider 边界，所以这里恰好证明「tick 自己不预留」：
    // 真实请求的计量由 providerAmap/providerWorld 在出口调用一次（见 integration.test.ts）。
    expect(out.mapReserved).toBe(false);
    const wish = await getTravelWish(db, { userId: 'u1', wishId: 'w1' });
    expect(wish?.state).toBe('open');
    const budget = await getTravelBudget(db, { userId: 'u1', nowMs: NOW });
    expect(budget?.mapCallsUsed).toBe(0);
    expect(budget?.mapAttemptsUsed).toBe(0);
  });

  it('没有官方时长就不编 ETA：arriveAt 为 null，几何未许可不落库', async () => {
    const p = provider({
      async route() {
        return {
          provider: 'amap' as const, coordSys: 'gcj02' as const,
          points: [{ lat: 30.1, lng: 120.1 }, { lat: 30.2, lng: 120.2 }],
          distanceM: 900, durationS: null, steps: [],
          license: {
            geometryPersistence: 'not-licensed' as const, basemapDisplay: 'not-configured' as const,
            memoryOnly: true as const, attribution: '高德地图', termsRef: 'terms',
          },
        };
      },
    });
    // 角色**已经选过**（落库的 selectedCandidateId）：这条路径不替角色挑，也不再问模型。
    await insertTravelWish(db, {
      id: 'w1', userId: 'u1', charId: 'c1', wishText: '想去公园', state: 'chosen',
      selectedCandidateId: 'cand-1',
      expiresAt: null, createdAt: NOW, updatedAt: NOW,
    });
    await saveTravelCandidates(db, {
      userId: 'u1', wishId: 'w1', nowMs: NOW,
      candidates: [{
        id: 'cand-1', userId: 'u1', wishId: 'w1', provider: 'amap', label: '西湖公园',
        city: '杭州', lat: 30.2, lng: 120.2, coordSys: 'gcj02', distanceM: 900,
        expiresAt: NOW + 3600_000, createdAt: NOW,
      }],
    });
    const out = await runTravelTickForSubject(db, subject, baseWiring({ providers: [p], licensedGeometry: false }));
    expect(out.planned).toBe(true);
    const trip = await getActiveTravelTrip(db, { userId: 'u1', charId: 'c1' });
    expect(trip?.status).toBe('planned');
    expect(trip?.arriveAt).toBeNull();
    expect(trip?.route).toBeNull();
    const snap = buildTravelSnapshot({
      trip, share: { shareEnabled: true, version: 1, updatedAt: NOW - 1 },
      budget: { mapCallsUsed: 1, mapCallsLimit: 10 }, nowMs: NOW, geometryPersistence: 'not-licensed',
    });
    expect(snap.route).toBeNull();
    expect(snap.position).toBeNull();
  });
});
