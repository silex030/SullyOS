import { describe, expect, it } from 'vitest';

import type { TravelTrip } from '../../../../contracts/travel';
import { buildRoleTravelContext, buildTravelSnapshot, resolveTravelLicenses } from './state';

const NOW = Date.parse('2026-10-23T04:00:00.000Z');
const place = { label: '阳光花园', city: '杭州', district: '西湖区', lat: 30.1, lng: 120.1, coordSys: 'gcj02' as const };

const trip = (overrides: Partial<TravelTrip & { createdAt: number }> = {}): TravelTrip & { createdAt: number } => ({
  id: 't1', userId: 'u1', charId: 'c1', status: 'en_route', planVersion: 1, revision: 1,
  coordSys: 'gcj02', provider: 'amap', origin: place,
  dest: { ...place, label: '西湖公园', kind: 'public' as const },
  departAt: NOW - 300_000, arriveAt: NOW + 300_000, dwellUntil: null, returnAt: null,
  createdAt: NOW - 400_000,
  ...overrides,
});

describe('出行快照：共享关闭剥离、代际、几何许可', () => {
  it('共享关闭时连地名一起剥离（trip:null）', () => {
    const snap = buildTravelSnapshot({
      trip: trip(), share: { shareEnabled: false, version: 1, updatedAt: NOW - 86400_000 },
      budget: { mapCallsUsed: 1, mapCallsLimit: 10 }, nowMs: NOW, geometryPersistence: 'allowed',
    });
    expect(snap.code).toBe('SHARE_REVOKED');
    expect(snap.trip).toBeNull();
    expect(JSON.stringify(snap)).not.toContain('阳光花园');
  });

  it('共享重新打开不复活旧轨迹：代际之前的行程不出', () => {
    const snap = buildTravelSnapshot({
      trip: trip({ createdAt: NOW - 10_000 }),
      share: { shareEnabled: true, version: 2, updatedAt: NOW },
      budget: null, nowMs: NOW, geometryPersistence: 'allowed',
    });
    expect(snap.trip).toBeNull();
    expect(snap.history).toEqual([]);
  });

  it('几何未许可：有地名无坐标（route/position 全空）', () => {
    const withRoute = trip({ route: { points: [{ lat: 30.1, lng: 120.1 }, { lat: 30.2, lng: 120.2 }], distanceM: 900 } } as never);
    const snap = buildTravelSnapshot({
      trip: withRoute, share: { shareEnabled: true, version: 1, updatedAt: NOW - 86400_000 },
      budget: null, nowMs: NOW, geometryPersistence: 'not-licensed',
    });
    expect(snap.trip?.origin).toMatchObject({ label: '阳光花园', city: '杭州' });
    expect(JSON.stringify(snap.trip)).not.toContain('lat');
    expect(snap.route).toBeNull();
    expect(snap.position).toBeNull();
  });

  it('角色内部 context 与共享无关，且不含坐标', () => {
    const ctx = buildRoleTravelContext({ trip: trip(), nowMs: NOW });
    expect(ctx.hasTrip).toBe(true);
    expect(ctx.destLabel).toBe('西湖公园');
    expect(ctx.etaMinutes).toBe(5);
    expect(JSON.stringify(ctx)).not.toContain('30.1');
    expect(buildRoleTravelContext({ trip: null, nowMs: NOW }).hasTrip).toBe(false);
  });

  it('许可只认 env 的 allowed/licensed', () => {
    expect(resolveTravelLicenses({ TRAVEL_GEOMETRY_LICENSE: 'allowed' }).geometryPersistence).toBe('allowed');
    expect(resolveTravelLicenses({}).geometryPersistence).toBe('not-licensed');
    expect(resolveTravelLicenses({ TRAVEL_BASEMAP_LICENSE: 'licensed' }).basemapDisplay).toBe('licensed');
    expect(resolveTravelLicenses({ TRAVEL_BASEMAP_LICENSE: 'true' }).basemapDisplay).toBe('not-configured');
  });
});
