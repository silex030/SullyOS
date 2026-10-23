import { describe, expect, it } from 'vitest';

import { createTravelMapProviders, resolveTravelMapProviderKeys } from './mapProviders';

const ENV = { AMAP_WEB_KEY: 'env-web-key', MAPBOX_TOKEN: 'pk.env-token-0123456789abcdef' };

describe('travel map providers · 用户凭据优先与注入', () => {
  it('用户保存的 Key 优先；env 默认不参与（清除后不会神秘复活）', () => {
    const keys = resolveTravelMapProviderKeys({
      userCredentials: { amapWebKey: 'user-web-key', mapboxToken: '' },
      env: ENV,
    });
    expect(keys.amapWebKey).toBe('user-web-key');
    expect(keys.mapboxToken).toBe('');
  });

  it('只有 TRAVEL_MAP_ENV_FALLBACK=allow 时才把 env 当兜底', () => {
    const off = resolveTravelMapProviderKeys({ userCredentials: null, env: ENV });
    expect(off).toEqual({ amapWebKey: '', mapboxToken: '' });
    const on = resolveTravelMapProviderKeys({
      userCredentials: null,
      env: { ...ENV, TRAVEL_MAP_ENV_FALLBACK: 'allow' },
    });
    expect(on.amapWebKey).toBe('env-web-key');
    expect(on.mapboxToken).toBe('pk.env-token-0123456789abcdef');
  });

  it('provider 出口的 fetch 真的收到服务端解析出的 Key', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          status: '1',
          geocodes: [{ city: '杭州', district: '西湖区', location: '120.100000,30.100000' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;

    const providers = createTravelMapProviders(
      { amapWebKey: 'resolved-web-key-xyz', mapboxToken: '' },
      {
        fetch: fetchImpl,
        reserveMapCall: () => ({ allowed: true }),
        now: () => 1_700_000_000_000,
      },
    );
    const amap = providers.find((p) => p.id === 'amap');
    expect(amap).toBeTruthy();
    const anchor = await amap!.geocodeAnchor({ label: '西湖', city: '杭州' });
    expect(anchor.city).toBe('杭州');
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!);
    expect(url.searchParams.get('key')).toBe('resolved-web-key-xyz');
  });

  it('没有 Key 时不发请求（honest not-configured）', async () => {
    let called = 0;
    const providers = createTravelMapProviders(
      { amapWebKey: '', mapboxToken: '' },
      {
        fetch: (async () => {
          called += 1;
          return new Response('{}');
        }) as unknown as typeof globalThis.fetch,
        reserveMapCall: () => ({ allowed: true }),
      },
    );
    const amap = providers.find((p) => p.id === 'amap')!;
    await expect(amap.geocodeAnchor({ label: '西湖', city: '杭州' })).rejects.toMatchObject({
      kind: 'not-configured',
    });
    expect(called).toBe(0);
  });
});
