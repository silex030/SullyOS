import { describe, expect, it, vi } from 'vitest';
import {
  TravelProviderError,
  assertGeoPoint,
  buildLicenseMeta,
  formatLonLat,
  parsePolyline,
  providerForRegion,
  reserveMapBudget,
  type TravelMapProvider,
} from './provider';

/**
 * 只有注入的假数据在这里跑：这些用例证明**契约形状**，不代表真实高德/Mapbox 接口已通过。
 */

const geo = (lat: number, lng: number, coordSys: 'gcj02' | 'wgs84' = 'gcj02') => ({ lat, lng, coordSys });

const stubProvider = (id: 'amap' | 'world', regions: Array<'CN' | 'overseas'>): TravelMapProvider => ({
  id,
  coordSys: id === 'amap' ? 'gcj02' : 'wgs84',
  regions,
  supports: (region) => regions.includes(region),
  searchCandidates: vi.fn(async () => []),
  route: vi.fn(async () => {
    throw new TravelProviderError({ kind: 'no-route', code: 'ROUTE_UNAVAILABLE', provider: id });
  }),
  geocodeAnchor: vi.fn(async () => {
    throw new TravelProviderError({ kind: 'no-route', code: 'ANCHOR_NOT_CONFIRMED', provider: id });
  }),
});

describe('坐标与折线解析（严格、有限、lon,lat 顺序）', () => {
  describe('assertGeoPoint', () => {
    it('接受带 coordSys 的合法点', () => {
      expect(() => assertGeoPoint(geo(39.990704, 116.481247))).not.toThrow();
    });

    it('缺 coordSys 拒绝（旧数据不得用于路线）', () => {
      expect(() => assertGeoPoint({ lat: 39.9, lng: 116.4 } as never)).toThrow(TravelProviderError);
    });

    it.each([
      ['纬度越界', { lat: 91, lng: 116.4, coordSys: 'gcj02' }],
      ['经度越界', { lat: 39.9, lng: 181, coordSys: 'gcj02' }],
      ['NaN', { lat: Number.NaN, lng: 116.4, coordSys: 'gcj02' }],
      ['Infinity', { lat: 39.9, lng: Number.POSITIVE_INFINITY, coordSys: 'gcj02' }],
      ['字符串坐标', { lat: '39.9', lng: '116.4', coordSys: 'gcj02' }],
    ])('%s → bad-input，不进入请求', (_label, point) => {
      let error: unknown;
      try {
        assertGeoPoint(point as never);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(TravelProviderError);
      expect((error as TravelProviderError).kind).toBe('bad-input');
      expect((error as TravelProviderError).code).toBe('PROVIDER_FAILED');
    });
  });

  describe('formatLonLat', () => {
    it('输出 lon,lat 且小数不超过 6 位（高德 REST 硬要求）', () => {
      expect(formatLonLat(geo(39.99070449, 116.4812471))).toBe('116.481247,39.990704');
    });

    it('拒绝非有限坐标', () => {
      expect(() => formatLonLat(geo(Number.NaN, 116.4))).toThrow(TravelProviderError);
    });
  });

  describe('parsePolyline', () => {
    it('按 ; 切点、按 , 切 lon,lat，lon 在前', () => {
      expect(parsePolyline('116.481247,39.990704;116.481270,39.990726')).toEqual([
        { lat: 39.990704, lng: 116.481247 },
        { lat: 39.990726, lng: 116.48127 },
      ]);
    });

    it('坏点跳过、绝不猜位（缺一个分量 / 多一个分量 / 非数字 / 越界）', () => {
      const raw = '116.1,39.1;abc;116.2;116.3,39.3,0;181,39.4;116.5,39.5';
      expect(parsePolyline(raw)).toEqual([
        { lat: 39.1, lng: 116.1 },
        { lat: 39.5, lng: 116.5 },
      ]);
    });

    it('相邻重复点去重（相邻 step 端点常重复）', () => {
      expect(parsePolyline('116.1,39.1;116.1,39.1;116.2,39.2;116.2,39.2')).toEqual([
        { lat: 39.1, lng: 116.1 },
        { lat: 39.2, lng: 116.2 },
      ]);
    });

    it('空串 / 非字符串 / 全坏返回空数组（调用方据此报无路线，不画直线）', () => {
      expect(parsePolyline('')).toEqual([]);
      expect(parsePolyline(undefined)).toEqual([]);
      expect(parsePolyline({})).toEqual([]);
      expect(parsePolyline(';;;')).toEqual([]);
    });
  });
});

describe('ProvisionError：固定文案，不回显上游文本 / infocode / key', () => {
  it('message 只由 kind 决定，infocode 只在字段里', () => {
    const error = new TravelProviderError({
      kind: 'auth',
      code: 'PROVIDER_FAILED',
      provider: 'amap',
      infocode: '10001',
    });
    expect(error.kind).toBe('auth');
    expect(error.code).toBe('PROVIDER_FAILED');
    expect(error.infocode).toBe('10001');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('鉴权');
    expect(error.message).not.toContain('10001');
  });

  it('rate-limit 标可重试，但仍不自动重试（重试由上层 tick 决定）', () => {
    const error = new TravelProviderError({ kind: 'rate-limit', code: 'PROVIDER_FAILED', provider: 'amap' });
    expect(error.retryable).toBe(true);
  });

  it('unsupported-region 用契约错误码', () => {
    const error = new TravelProviderError({
      kind: 'unsupported-region',
      code: 'PROVIDER_UNSUPPORTED_REGION',
      provider: 'amap',
    });
    expect(error.code).toBe('PROVIDER_UNSUPPORTED_REGION');
  });
});

describe('许可元数据：几何许可与底图展示授权是两条线', () => {
  it('默认两项都不放行（未取得 G1b / 未配置 G1a）', () => {
    const meta = buildLicenseMeta('amap', {});
    expect(meta.geometryPersistence).toBe('not-licensed');
    expect(meta.basemapDisplay).toBe('not-configured');
    expect(meta.memoryOnly).toBe(true);
    expect(meta.attribution).toContain('高德');
  });

  it('只有几何许可时底图仍是未配置（不互相顶替）', () => {
    const meta = buildLicenseMeta('amap', { geometryPersistenceLicensed: true });
    expect(meta.geometryPersistence).toBe('allowed');
    expect(meta.basemapDisplay).toBe('not-configured');
  });

  it('只有底图授权时几何仍不可持久化', () => {
    const meta = buildLicenseMeta('world', { basemapDisplayLicensed: true });
    expect(meta.geometryPersistence).toBe('not-licensed');
    expect(meta.basemapDisplay).toBe('licensed');
    expect(meta.attribution).toContain('Mapbox');
  });
});

describe('预算闸：发请求前先扣账，读失败 fail-closed', () => {
  it('允许时放行', async () => {
    await expect(reserveMapBudget({ reserveMapCall: () => ({ allowed: true }) }, 'amap')).resolves.toBeUndefined();
  });

  it('额度为 0 → BUDGET_ZERO', async () => {
    const run = reserveMapBudget({ reserveMapCall: () => ({ allowed: false, code: 'BUDGET_ZERO' }) }, 'amap');
    await expect(run).rejects.toMatchObject({ code: 'BUDGET_ZERO', kind: 'quota' });
  });

  it('账本读失败（回调抛错）→ BUDGET_BLOCKED，不放行', async () => {
    const dying = reserveMapBudget(
      {
        reserveMapCall: () => {
          throw new Error('ledger read failed');
        },
      },
      'world',
    );
    await expect(dying).rejects.toMatchObject({ code: 'BUDGET_BLOCKED' });
  });
});

describe('providerForRegion：地区只换实现，不换接口', () => {
  const amap = stubProvider('amap', ['CN']);
  const world = stubProvider('world', ['overseas']);

  it('国内走 amap，国外走 world', () => {
    expect(providerForRegion('CN', [amap, world])?.id).toBe('amap');
    expect(providerForRegion('overseas', [amap, world])?.id).toBe('world');
  });

  it('没有可用实现返回 null（上层标 unavailable，不画直线）', () => {
    expect(providerForRegion('overseas', [amap])).toBeNull();
  });
});
