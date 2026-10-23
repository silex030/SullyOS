import { describe, expect, it, vi } from 'vitest';
import { TravelProviderError } from './provider';
import { AMAP_ALLOWED_ENDPOINTS, AMAP_REST_BASE, createAmapProvider } from './providerAmap';

/**
 * 注入 fetch 的**契约测试**：请求/响应字段形状按高德官方文档构造，
 * 不代表真实 Key / 真实高德接口已通过（本轮禁真实调用）。
 */

const KEY = 'TEST_ONLY_AMAP_KEY';

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const makeDeps = (
  fetchImpl: (url: string) => Promise<Response>,
  reserveMapCall: () => { allowed: true } | { allowed: false; code: 'BUDGET_BLOCKED' | 'BUDGET_ZERO' } = () => ({
    allowed: true,
  }),
) => {
  const fetchMock = vi.fn(fetchImpl);
  return {
    fetchMock,
    deps: { fetch: fetchMock as unknown as typeof fetch, reserveMapCall },
    urls: () => fetchMock.mock.calls.map((call) => String(call[0])),
  };
};

const makeProvider = (
  fetchImpl: (url: string) => Promise<Response>,
  overrides: Partial<Parameters<typeof createAmapProvider>[0]> = {},
  reserve?: () => { allowed: true } | { allowed: false; code: 'BUDGET_BLOCKED' | 'BUDGET_ZERO' },
) => {
  const { deps, fetchMock, urls } = makeDeps(fetchImpl, reserve);
  const provider = createAmapProvider({ resolveKey: () => KEY, ...overrides }, deps);
  return { provider, fetchMock, urls };
};

const origin = { lat: 39.990704, lng: 116.481247, coordSys: 'gcj02' as const };
const destination = { lat: 39.981161, lng: 116.489864, coordSys: 'gcj02' as const };

const walkingPayload = (overrides: Record<string, unknown> = {}) => ({
  status: '1',
  info: 'OK',
  infocode: '10000',
  count: '1',
  route: {
    origin: '116.481247,39.990704',
    destination: '116.489864,39.981161',
    paths: [
      {
        distance: '1200',
        duration: '960',
        steps: [
          {
            instruction: '向东步行 300 米',
            road: '中关村大街',
            distance: '300',
            duration: '240',
            polyline: '116.481247,39.990704;116.484000,39.990704',
            action: '直行',
            walk_type: '0',
          },
          {
            instruction: '向南步行 900 米',
            road: '海淀南路',
            distance: '900',
            duration: '720',
            // 接缝点与上一段末点重复：拼接后必须去重
            polyline: '116.484000,39.990704;116.489864,39.981161',
            action: '左转',
            walk_type: '1',
          },
        ],
      },
    ],
  },
  ...overrides,
});

describe('providerAmap · 步行路线（/v3/direction/walking）', () => {
  it('解析官方字段：distance/duration/steps，拼接去重，坐标体系显式 gcj02', async () => {
    const { provider, urls } = makeProvider(async () => jsonResponse(walkingPayload()));

    const result = await provider.route({ origin, destination });

    expect(result.provider).toBe('amap');
    expect(result.coordSys).toBe('gcj02');
    expect(result.distanceM).toBe(1200);
    expect(result.durationS).toBe(960);
    expect(result.steps.map((s) => s.instruction)).toEqual(['向东步行 300 米', '向南步行 900 米']);
    expect(result.points).toEqual([
      { lat: 39.990704, lng: 116.481247 },
      { lat: 39.990704, lng: 116.484 },
      { lat: 39.981161, lng: 116.489864 },
    ]);

    const url = new URL(urls()[0]);
    expect(url.origin).toBe(AMAP_REST_BASE);
    expect(url.pathname).toBe('/v3/direction/walking');
    expect(url.searchParams.get('origin')).toBe('116.481247,39.990704');
    expect(url.searchParams.get('destination')).toBe('116.489864,39.981161');
    expect(url.searchParams.get('key')).toBe(KEY);
    expect(url.searchParams.get('output')).toBe('JSON');
  });

  it('许可元数据：几何默认不可持久化、底图默认未配置（两条线分开）', async () => {
    const { provider } = makeProvider(async () => jsonResponse(walkingPayload()));
    const result = await provider.route({ origin, destination });
    expect(result.license.geometryPersistence).toBe('not-licensed');
    expect(result.license.basemapDisplay).toBe('not-configured');
    expect(result.license.memoryOnly).toBe(true);
    expect(result.license.attribution).toContain('高德');
  });

  it('WGS-84 输入在边界转 GCJ-02（请求串不再是原值），输出仍标 gcj02', async () => {
    const { provider, urls } = makeProvider(async () => jsonResponse(walkingPayload()));
    const wgsOrigin = { ...origin, coordSys: 'wgs84' as const };

    const result = await provider.route({ origin: wgsOrigin, destination });

    const sent = new URL(urls()[0]).searchParams.get('origin')!;
    expect(sent).not.toBe('116.481247,39.990704');
    expect(sent).toMatch(/^\d+\.\d{1,6},\d+\.\d{1,6}$/);
    expect(result.coordSys).toBe('gcj02');
  });

  it('坏折线点整点跳过；全坏 → ROUTE_UNAVAILABLE（不返回两点直线）', async () => {
    const partial = walkingPayload();
    const path = (partial.route as any).paths[0];
    path.steps[0].polyline = '116.481247,39.990704;abc;116.484,39.9907';
    path.steps[1].polyline = '116.484,39.9907';
    const { provider } = makeProvider(async () => jsonResponse(partial));

    const result = await provider.route({ origin, destination });
    expect(result.points).toEqual([
      { lat: 39.990704, lng: 116.481247 },
      { lat: 39.9907, lng: 116.484 },
    ]);

    const broken = walkingPayload();
    const brokenPath = (broken.route as any).paths[0];
    brokenPath.steps[0].polyline = 'abc;def';
    brokenPath.steps[1].polyline = '116.4';
    const { provider: provider2 } = makeProvider(async () => jsonResponse(broken));

    await expect(provider2.route({ origin, destination })).rejects.toMatchObject({
      kind: 'no-route',
      code: 'ROUTE_UNAVAILABLE',
    });
  });

  it('官方没给 duration 时保持 null（不按速度编造 ETA）', async () => {
    const payload = walkingPayload();
    delete (payload.route as any).paths[0].duration;
    const { provider } = makeProvider(async () => jsonResponse(payload));

    const result = await provider.route({ origin, destination });
    expect(result.durationS).toBeNull();
    expect(result.distanceM).toBe(1200);
  });

  it('步行 >100km 在发请求前就拒（不花钱）', async () => {
    const { provider, fetchMock } = makeProvider(async () => jsonResponse(walkingPayload()));
    const far = { lat: 31.2304, lng: 121.4737, coordSys: 'gcj02' as const };

    await expect(provider.route({ origin, destination: far })).rejects.toMatchObject({
      kind: 'too-far',
      code: 'ROUTE_UNAVAILABLE',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('坐标异常（NaN / 越界 / 缺 coordSys）→ bad-input，不发请求', async () => {
    const { provider, fetchMock } = makeProvider(async () => jsonResponse(walkingPayload()));

    await expect(
      provider.route({ origin: { lat: Number.NaN, lng: 116.4, coordSys: 'gcj02' }, destination }),
    ).rejects.toMatchObject({ kind: 'bad-input' });
    await expect(
      provider.route({ origin: { lat: 39.9, lng: 116.4 } as never, destination }),
    ).rejects.toMatchObject({ kind: 'bad-input' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('providerAmap · 错误分支（每个都是单次请求，不循环重试）', () => {
  it('缺少 Key → not-configured，不请求', async () => {
    const { provider, fetchMock } = makeProvider(async () => jsonResponse(walkingPayload()), {
      resolveKey: () => null,
    });

    await expect(provider.route({ origin, destination })).rejects.toMatchObject({
      kind: 'not-configured',
      code: 'PROVIDER_FAILED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('20011（海外无权限）→ PROVIDER_UNSUPPORTED_REGION', async () => {
    const { provider } = makeProvider(async () =>
      jsonResponse({ status: '0', info: 'INSUFFICIENT_ABROAD_PRIVILEGES', infocode: '20011' }),
    );

    await expect(provider.route({ origin, destination })).rejects.toMatchObject({
      kind: 'unsupported-region',
      code: 'PROVIDER_UNSUPPORTED_REGION',
    });
  });

  it('10003（日配额超限）→ quota，只请求一次', async () => {
    const { provider, fetchMock } = makeProvider(async () =>
      jsonResponse({ status: '0', info: 'DAILY_QUERY_OVER_LIMIT', infocode: '10003' }),
    );

    await expect(provider.route({ origin, destination })).rejects.toMatchObject({ kind: 'quota' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('10004（QPS 超限）→ rate-limit、可重试标记，但 provider 不重试', async () => {
    const { provider, fetchMock } = makeProvider(async () =>
      jsonResponse({ status: '0', info: 'ACCESS_TOO_FREQUENT', infocode: '10004' }),
    );

    const error = (await provider.route({ origin, destination }).catch((e) => e)) as TravelProviderError;
    expect(error.kind).toBe('rate-limit');
    expect(error.retryable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['20801', 'no-route'],
    ['20802', 'no-route'],
    ['20803', 'too-far'],
  ])('%s → %s，无几何不返回点', async (infocode, kind) => {
    const { provider } = makeProvider(async () => jsonResponse({ status: '0', info: 'FAIL', infocode }));
    const error = (await provider.route({ origin, destination }).catch((e) => e)) as TravelProviderError;
    expect(error.kind).toBe(kind);
    expect(error.code).toBe('ROUTE_UNAVAILABLE');
  });

  it('HTTP 500 → transient；错误文案不回显 Key，也不打 console', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { provider } = makeProvider(async () => jsonResponse({ message: KEY }, 500));

    const error = (await provider.route({ origin, destination }).catch((e) => e)) as TravelProviderError;
    expect(error.kind).toBe('transient');
    expect(error.message).not.toContain(KEY);
    expect([errorSpy, warnSpy, logSpy].every((spy) => spy.mock.calls.length === 0)).toBe(true);
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('预算不放行 → BUDGET_ZERO，且请求根本没发出', async () => {
    const { provider, fetchMock } = makeProvider(
      async () => jsonResponse(walkingPayload()),
      {},
      () => ({ allowed: false, code: 'BUDGET_ZERO' }),
    );
    await expect(provider.route({ origin, destination })).rejects.toMatchObject({ code: 'BUDGET_ZERO' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('每次出口恰扣一次预算（三次调用三次扣账）', async () => {
    const reserve = vi.fn(() => ({ allowed: true as const }));
    const { provider } = makeProvider(
      async () =>
        jsonResponse({
          status: '1',
          pois: [],
          geocodes: [],
          route: { paths: [] },
        }),
      {},
      reserve,
    );

    await provider.route({ origin, destination }).catch(() => {});
    await provider.searchCandidates({ wishText: '公园', city: '北京' }).catch(() => {});
    await provider.geocodeAnchor({ label: '阳光花园', city: '北京' }).catch(() => {});
    expect(reserve).toHaveBeenCalledTimes(3);
  });
});

describe('providerAmap · 地点检索（/v3/place/text）', () => {
  const placePayload = (count: number) => ({
    status: '1',
    info: 'OK',
    infocode: '10000',
    count: String(count),
    pois: Array.from({ length: count }, (_, i) => ({
      id: `B${String(i).padStart(8, '0')}`,
      name: `公园${i}`,
      type: '风景名胜;公园广场;公园',
      typecode: '110101',
      cityname: ['北京市'],
      adname: '海淀区',
      address: '某某路1号',
      location: `116.48${String(i).padStart(4, '0')},39.99${String(i).padStart(4, '0')}`,
      distance: '320',
    })),
  });

  it('解析 pois：名称/类别/城市（数组回落）/距离，不含 address', async () => {
    const { provider, urls } = makeProvider(async () => jsonResponse(placePayload(3)));
    const hits = await provider.searchCandidates({
      wishText: '公园',
      city: '北京',
      center: origin,
      limit: 2,
    });

    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      id: 'B00000000',
      label: '公园0',
      category: '公园',
      city: '北京市',
      district: '海淀区',
      distanceM: 320,
      provider: 'amap',
    });
    expect(hits[0].location.coordSys).toBe('gcj02');
    expect(JSON.stringify(hits)).not.toContain('某某路1号');
    expect('address' in hits[0]).toBe(false);

    const url = new URL(urls()[0]);
    expect(url.pathname).toBe('/v3/place/text');
    expect(url.searchParams.get('keywords')).toBe('公园');
    expect(url.searchParams.get('city')).toBe('北京');
  });

  it('上限夹到 8；官方没给 distance 才用中心点自算，没中心就是 null', async () => {
    const { provider } = makeProvider(async () => jsonResponse(placePayload(12)));
    const hits = await provider.searchCandidates({ wishText: '公园', city: '北京', limit: 99 });
    expect(hits).toHaveLength(8);

    const payload = placePayload(1);
    delete (payload.pois[0] as any).distance;
    const { provider: p2 } = makeProvider(async () => jsonResponse(payload));
    const withCenter = await p2.searchCandidates({ wishText: '公园', city: '北京', center: origin });
    expect(withCenter[0].distanceM).toBeGreaterThan(0);
    const { provider: p3 } = makeProvider(async () => jsonResponse(payload));
    const noCenter = await p3.searchCandidates({ wishText: '公园', city: '北京' });
    expect(noCenter[0].distanceM).toBeNull();
  });

  it('空结果返回空数组（不是错误，也不编造候选）', async () => {
    const { provider } = makeProvider(async () => jsonResponse(placePayload(0)));
    await expect(provider.searchCandidates({ wishText: '不存在的词', city: '北京' })).resolves.toEqual([]);
  });
});

describe('providerAmap · 锚点地理编码（/v3/geocode/geo）', () => {
  it('返回小区级候选：无 address、precision=area、坐标带 gcj02', async () => {
    const { provider, urls } = makeProvider(async () =>
      jsonResponse({
        status: '1',
        info: 'OK',
        infocode: '10000',
        geocodes: [
          {
            formatted_address: '北京市海淀区阳光花园5号楼2单元',
            province: '北京市',
            city: '北京市',
            district: '海淀区',
            location: '116.481247,39.990704',
            level: '兴趣点',
            adcode: '110108',
          },
        ],
      }),
    );

    const anchor = await provider.geocodeAnchor({ label: '阳光花园', city: '北京' });
    expect(anchor).toMatchObject({
      label: '阳光花园',
      city: '北京市',
      district: '海淀区',
      precision: 'area',
      provider: 'amap',
    });
    expect(anchor.location).toEqual({ lat: 39.990704, lng: 116.481247, coordSys: 'gcj02' });
    expect(JSON.stringify(anchor)).not.toContain('5号楼');
    expect('address' in anchor).toBe(false);

    const url = new URL(urls()[0]);
    expect(url.pathname).toBe('/v3/geocode/geo');
    expect(url.searchParams.get('address')).toBe('阳光花园');
    expect(url.searchParams.get('city')).toBe('北京');
  });

  it('地理编码空结果 → ANCHOR_NOT_CONFIRMED（不用城市中心兜底）', async () => {
    const { provider } = makeProvider(async () =>
      jsonResponse({ status: '1', info: 'OK', infocode: '10000', geocodes: [] }),
    );
    await expect(provider.geocodeAnchor({ label: '不存在的地方', city: '北京' })).rejects.toMatchObject({
      kind: 'no-route',
      code: 'ANCHOR_NOT_CONFIRMED',
    });
  });
});

describe('providerAmap · 出口白名单', () => {
  it('只打官方 host 的 /v3/ 白名单路径', async () => {
    const { provider, urls } = makeProvider(async () =>
      jsonResponse({ status: '1', pois: [], geocodes: [], route: { paths: [] } }),
    );
    await provider.route({ origin, destination }).catch(() => {});
    await provider.searchCandidates({ wishText: '公园', city: '北京' }).catch(() => {});
    await provider.geocodeAnchor({ label: '阳光花园', city: '北京' }).catch(() => {});

    for (const raw of urls()) {
      const url = new URL(raw);
      expect(url.origin).toBe(AMAP_REST_BASE);
      expect(AMAP_ALLOWED_ENDPOINTS).toContain(url.pathname);
    }
    expect(AMAP_ALLOWED_ENDPOINTS).toEqual(['/v3/direction/walking', '/v3/place/text', '/v3/geocode/geo']);
  });

  it('地区声明：只支持国内', () => {
    const { provider } = makeProvider(async () => jsonResponse(walkingPayload()));
    expect(provider.supports('CN')).toBe(true);
    expect(provider.supports('overseas')).toBe(false);
  });
});
