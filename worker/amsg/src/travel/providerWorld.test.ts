import { describe, expect, it, vi } from 'vitest';
import { TravelProviderError } from './provider';
import { MAPBOX_API_BASE, createWorldProvider } from './providerWorld';

/**
 * 注入 fetch 的**契约测试**：字段形状按 Mapbox Directions / Geocoding v5 官方文档构造，
 * 不代表真实 token / 真实 Mapbox 接口已通过（本轮没有也不需要新账号）。
 * 未配置 token 时必须是「诚实 unsupported」，不得退化成直线或城市中心。
 */

const TOKEN = 'TEST_ONLY_MAPBOX_TOKEN';

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const makeProvider = (
  fetchImpl: (url: string) => Promise<Response>,
  overrides: Partial<Parameters<typeof createWorldProvider>[0]> = {},
  reserve: () => { allowed: true } | { allowed: false; code: 'BUDGET_BLOCKED' | 'BUDGET_ZERO' } = () => ({
    allowed: true,
  }),
) => {
  const fetchMock = vi.fn(fetchImpl);
  const provider = createWorldProvider(
    { resolveToken: () => TOKEN, ...overrides },
    { fetch: fetchMock as unknown as typeof fetch, reserveMapCall: reserve },
  );
  return { provider, fetchMock, urls: () => fetchMock.mock.calls.map((call) => String(call[0])) };
};

const origin = { lat: 51.5007, lng: -0.1246, coordSys: 'wgs84' as const };
const destination = { lat: 51.5015, lng: -0.1201, coordSys: 'wgs84' as const };

const directionsPayload = (overrides: Record<string, unknown> = {}) => ({
  code: 'Ok',
  routes: [
    {
      distance: 420.4,
      duration: 300.2,
      geometry: {
        type: 'LineString',
        coordinates: [
          [-0.1246, 51.5007],
          [-0.1235, 51.5009],
          [-0.1201, 51.5015],
        ],
      },
      legs: [
        {
          steps: [
            {
              distance: 200.1,
              duration: 150.5,
              maneuver: { instruction: 'Head north on Whitehall', type: 'depart' },
            },
            {
              distance: 220.3,
              duration: 149.7,
              maneuver: { instruction: 'Turn right onto Bridge Street', type: 'turn' },
            },
          ],
        },
      ],
    },
  ],
  ...overrides,
});

describe('providerWorld · 步行路线（Directions v5 /mapbox/walking）', () => {
  it('解析官方字段：geometry 折线、distance/duration、steps，坐标显式 wgs84', async () => {
    const { provider, urls } = makeProvider(async () => jsonResponse(directionsPayload()));

    const result = await provider.route({ origin, destination });

    expect(result.provider).toBe('world');
    expect(result.coordSys).toBe('wgs84');
    expect(result.distanceM).toBe(420);
    expect(result.durationS).toBe(300);
    expect(result.points).toEqual([
      { lat: 51.5007, lng: -0.1246 },
      { lat: 51.5009, lng: -0.1235 },
      { lat: 51.5015, lng: -0.1201 },
    ]);
    expect(result.steps.map((step) => step.instruction)).toEqual([
      'Head north on Whitehall',
      'Turn right onto Bridge Street',
    ]);

    const url = new URL(urls()[0]);
    expect(url.origin).toBe(MAPBOX_API_BASE);
    expect(url.pathname).toBe('/directions/v5/mapbox/walking/-0.124600,51.500700;-0.120100,51.501500');
    expect(url.searchParams.get('geometries')).toBe('geojson');
    expect(url.searchParams.get('steps')).toBe('true');
    expect(url.searchParams.get('access_token')).toBe(TOKEN);
  });

  it('许可元数据：几何默认不可持久化；底图未配置（与几何许可互不顶替）', async () => {
    const { provider } = makeProvider(async () => jsonResponse(directionsPayload()));
    const result = await provider.route({ origin, destination });
    expect(result.license.geometryPersistence).toBe('not-licensed');
    expect(result.license.basemapDisplay).toBe('not-configured');
    expect(result.license.attribution).toContain('Mapbox');
  });

  it('GCJ-02 输入在边界转 WGS-84（不混存两套坐标）', async () => {
    const { provider, urls } = makeProvider(async () => jsonResponse(directionsPayload()));
    const gcjOrigin = { lat: 39.990704, lng: 116.481247, coordSys: 'gcj02' as const };
    const gcjDest = { lat: 39.981161, lng: 116.489864, coordSys: 'gcj02' as const };

    const result = await provider.route({ origin: gcjOrigin, destination: gcjDest });

    const sent = new URL(urls()[0]).pathname;
    // 国境内 GCJ-02 与 WGS-84 相差数百米：请求串绝不能原样带着 GCJ 值出去。
    expect(sent).not.toContain('116.481247,39.990704');
    expect(sent).toMatch(/\/directions\/v5\/mapbox\/walking\/\d+\.\d{6},\d+\.\d{6};\d+\.\d{6},\d+\.\d{6}$/);
    expect(result.coordSys).toBe('wgs84');
  });

  it('几何缺坐标 / 只有 1 个点 → ROUTE_UNAVAILABLE（绝不返回两点直线）', async () => {
    const payload = directionsPayload();
    (payload.routes[0].geometry as any).coordinates = [[-0.1246, 51.5007]];
    const { provider } = makeProvider(async () => jsonResponse(payload));

    await expect(provider.route({ origin, destination })).rejects.toMatchObject({
      kind: 'no-route',
      code: 'ROUTE_UNAVAILABLE',
    });
  });

  it('几何里混入非有限 / 越界坐标：坏点跳过，整条不足两点则失败', async () => {
    const payload = directionsPayload();
    (payload.routes[0].geometry as any).coordinates = [
      [-0.1246, 51.5007],
      ['x', 51.5],
      [-0.1201, 51.5015],
    ];
    const { provider } = makeProvider(async () => jsonResponse(payload));
    const result = await provider.route({ origin, destination });
    expect(result.points).toEqual([
      { lat: 51.5007, lng: -0.1246 },
      { lat: 51.5015, lng: -0.1201 },
    ]);
  });

  it('官方没给 duration → null（不按步行速度编造 ETA）', async () => {
    const payload = directionsPayload();
    delete (payload.routes[0] as any).duration;
    const { provider } = makeProvider(async () => jsonResponse(payload));
    const result = await provider.route({ origin, destination });
    expect(result.durationS).toBeNull();
  });
});

describe('providerWorld · 未配置与错误分支（诚实 unsupported、单次请求）', () => {
  it('服务端没有 token → 诚实 unsupported，不发请求、不画直线', async () => {
    const { provider, fetchMock } = makeProvider(async () => jsonResponse(directionsPayload()), {
      resolveToken: () => null,
    });

    await expect(provider.route({ origin, destination })).rejects.toMatchObject({
      kind: 'not-configured',
      code: 'PROVIDER_UNSUPPORTED_REGION',
    });
    await expect(provider.searchCandidates({ wishText: 'museum', city: 'London' })).rejects.toMatchObject({
      kind: 'not-configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('401 → auth，不重试，错误文案不含 token', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { provider, fetchMock } = makeProvider(async () =>
      jsonResponse({ code: 'TokenNotAuthorized', message: `bad token ${TOKEN}` }, 401),
    );

    const error = (await provider.route({ origin, destination }).catch((e) => e)) as TravelProviderError;
    expect(error.kind).toBe('auth');
    expect(error.code).toBe('PROVIDER_FAILED');
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain(TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('422 NoRoute → ROUTE_UNAVAILABLE，不伪造路线', async () => {
    const { provider } = makeProvider(async () => jsonResponse({ code: 'NoRoute', message: 'No route found' }, 422));
    await expect(provider.route({ origin, destination })).rejects.toMatchObject({
      kind: 'no-route',
      code: 'ROUTE_UNAVAILABLE',
    });
  });

  it('429 → rate-limit、可重试标记，但只请求一次（费用不循环重试）', async () => {
    const { provider, fetchMock } = makeProvider(async () => jsonResponse({ code: 'RateLimited' }, 429));
    const error = (await provider.route({ origin, destination }).catch((e) => e)) as TravelProviderError;
    expect(error.kind).toBe('rate-limit');
    expect(error.retryable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('预算不放行 → BUDGET_BLOCKED，请求不发出', async () => {
    const { provider, fetchMock } = makeProvider(
      async () => jsonResponse(directionsPayload()),
      {},
      () => ({ allowed: false, code: 'BUDGET_BLOCKED' }),
    );
    await expect(provider.route({ origin, destination })).rejects.toMatchObject({ code: 'BUDGET_BLOCKED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('坐标异常 → bad-input，不发请求', async () => {
    const { provider, fetchMock } = makeProvider(async () => jsonResponse(directionsPayload()));
    await expect(
      provider.route({ origin: { lat: 91, lng: -0.1246, coordSys: 'wgs84' }, destination }),
    ).rejects.toMatchObject({ kind: 'bad-input' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const geocodingPayload = (features: unknown[]) => ({ type: 'FeatureCollection', features });

describe('providerWorld · 地点检索与锚点（Geocoding v5）', () => {
  const feature = (overrides: Record<string, unknown> = {}) => ({
    id: 'poi.123456',
    type: 'Feature',
    text: 'British Museum',
    place_name: 'British Museum, Great Russell Street, London',
    place_type: ['poi'],
    center: [-0.1278, 51.5194],
    properties: { category: 'museum' },
    context: [
      { id: 'neighborhood.1', text: 'Bloomsbury' },
      { id: 'district.2', text: 'Camden' },
      { id: 'place.3', text: 'London' },
    ],
    ...overrides,
  });

  it('features → 候选：label/category/city/district，不含完整地址', async () => {
    const { provider, urls } = makeProvider(async () => jsonResponse(geocodingPayload([feature()])));

    const hits = await provider.searchCandidates({
      wishText: 'museum',
      city: 'London',
      center: origin,
      limit: 3,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      id: 'poi.123456',
      label: 'British Museum',
      category: 'museum',
      city: 'London',
      district: 'Camden',
      provider: 'world',
    });
    expect(hits[0].location).toEqual({ lat: 51.5194, lng: -0.1278, coordSys: 'wgs84' });
    expect(hits[0].distanceM).toBeGreaterThan(0);
    expect(JSON.stringify(hits)).not.toContain('Great Russell Street');

    const url = new URL(urls()[0]);
    expect(url.origin).toBe(MAPBOX_API_BASE);
    expect(url.pathname).toBe('/geocoding/v5/mapbox.places/museum.json');
    expect(url.searchParams.get('access_token')).toBe(TOKEN);
    expect(url.searchParams.get('proximity')).toBe('-0.124600,51.500700');
    expect(url.pathname).not.toContain(TOKEN);
  });

  it('没有 center 时 distanceM 为 null（不自造距离）', async () => {
    const { provider } = makeProvider(async () => jsonResponse(geocodingPayload([feature()])));
    const hits = await provider.searchCandidates({ wishText: 'museum', city: 'London' });
    expect(hits[0].distanceM).toBeNull();
  });

  it('空 features → 空数组', async () => {
    const { provider } = makeProvider(async () => jsonResponse(geocodingPayload([])));
    await expect(provider.searchCandidates({ wishText: 'nothing', city: 'London' })).resolves.toEqual([]);
  });

  it('锚点地理编码：只取 area 级、无 address、坐标 wgs84', async () => {
    const { provider, urls } = makeProvider(async () =>
      jsonResponse(
        geocodingPayload([
          feature({
            id: 'place.3',
            text: 'London',
            place_type: ['place'],
            center: [-0.1276, 51.5072],
            properties: {},
          }),
        ]),
      ),
    );

    const anchor = await provider.geocodeAnchor({ label: 'London', city: 'London' });
    expect(anchor).toMatchObject({ label: 'London', city: 'London', provider: 'world', precision: 'area' });
    expect(anchor.location).toEqual({ lat: 51.5072, lng: -0.1276, coordSys: 'wgs84' });
    expect('address' in anchor).toBe(false);
    expect(JSON.stringify(anchor)).not.toContain('Great Russell Street');

    const url = new URL(urls()[0]);
    expect(url.searchParams.get('types')).toBe('place,locality,neighborhood');
  });

  it('锚点空结果 → ANCHOR_NOT_CONFIRMED（不用城市中心兜底）', async () => {
    const { provider } = makeProvider(async () => jsonResponse(geocodingPayload([])));
    await expect(provider.geocodeAnchor({ label: 'Nowhere', city: 'London' })).rejects.toMatchObject({
      kind: 'no-route',
      code: 'ANCHOR_NOT_CONFIRMED',
    });
  });
});

describe('providerWorld · 能力声明与出口白名单', () => {
  it('只声明海外；国内不接（国内走高德）', () => {
    const { provider } = makeProvider(async () => jsonResponse(directionsPayload()));
    expect(provider.supports('overseas')).toBe(true);
    expect(provider.supports('CN')).toBe(false);
  });

  it('只打 api.mapbox.com 的 Directions / Geocoding 路径，不用公共 demo 实例', async () => {
    const { provider, urls } = makeProvider(async (url) =>
      url.includes('/directions/')
        ? jsonResponse(directionsPayload())
        : jsonResponse(geocodingPayload([{ id: 'poi.1', text: 'X', center: [-0.1, 51.5], place_type: ['poi'] }])),
    );

    await provider.route({ origin, destination });
    await provider.searchCandidates({ wishText: 'museum', city: 'London' });
    await provider.geocodeAnchor({ label: 'London', city: 'London' });

    for (const raw of urls()) {
      const url = new URL(raw);
      expect(url.origin).toBe('https://api.mapbox.com');
      expect(
        url.pathname.startsWith('/directions/v5/mapbox/walking/') || url.pathname.startsWith('/geocoding/v5/mapbox.places/'),
      ).toBe(true);
      expect(url.host).not.toMatch(/osrm|valhalla|tile/i);
    }
  });
});
