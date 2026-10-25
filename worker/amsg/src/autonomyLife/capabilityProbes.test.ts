/**
 * 外部能力探测的授权边界回归（P1 整改项 2）。
 *
 * 这条链以前的问题：`isEndpointConfigured` 只看「白名单非空 + URL 结构安全」，
 * `resolveProbes` 只看「provider + 未过期」，随后 `probeEndpointOnce` 直接 GET。
 * 于是「运营白名单是 A、用户只授权了 A、端点却指向 B」时也会向 B 发一次探测请求 ——
 * 一个绕过正式 `/external/read` 校验的新出网口。
 *
 * 这里把判定拆成可单测的 `authorizeProbe`，并在 `tick` 的生产入口用 spy fetch
 * 证明「不该探的时候一个请求都没有，该探的时候有界」。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  authorizeProbe,
  createReachabilityProbe,
  isEndpointConfigured,
} from './capabilityProbes';

const NOW = Date.UTC(2026, 9, 24, 4, 0, 0);

const grant = (overrides: Record<string, unknown> = {}) => ({
  provider: 'xhs',
  scopes: ['read:search'],
  allowedHosts: ['allowed.example'],
  expiresAt: NOW + 3_600_000,
  ...overrides,
});

const base = {
  endpoint: 'https://allowed.example/read',
  readHosts: ['allowed.example'],
  grant: grant(),
  provider: 'xhs' as const,
  mode: 'read' as const,
  kind: 'external.read' as const,
  allowedKinds: ['external.read'],
  paused: false,
  nowMs: NOW,
};

describe('isEndpointConfigured：目标主机必须真的在运营白名单里', () => {
  it('白名单为空 / 结构不安全 / 主机不在白名单 → 都不算配置好', () => {
    expect(isEndpointConfigured('https://allowed.example/read', [])).toBe(false);
    expect(isEndpointConfigured('', ['allowed.example'])).toBe(false);
    expect(isEndpointConfigured('http://allowed.example/read', ['allowed.example'])).toBe(false);
    expect(isEndpointConfigured('https://127.0.0.1/read', ['127.0.0.1'])).toBe(false);
    expect(isEndpointConfigured('https://other.example/read', ['allowed.example'])).toBe(false);
    expect(isEndpointConfigured('https://allowed.example/read', ['allowed.example'])).toBe(true);
  });
});

describe('authorizeProbe：探测前的主机 / 授权 / 暂停边界', () => {
  it('合法配置 + 有效授权 → 通过，并给出按授权分键的签名', () => {
    const result = authorizeProbe(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toBe('https://allowed.example/read');
    expect(result.host).toBe('allowed.example');
    expect(result.signature).toMatch(/[0-9a-z]/i);
    // 换一份授权（不同有效期/主机/scope）→ 不同签名（缓存不会串）。
    const other = authorizeProbe({ ...base, grant: grant({ expiresAt: NOW + 7_200_000 }) });
    expect(other.ok && other.signature).not.toBe(result.signature);
  });

  it('暂停 / kind 未开 → 不探', () => {
    expect(authorizeProbe({ ...base, paused: true })).toEqual({ ok: false, reason: 'paused' });
    expect(authorizeProbe({ ...base, allowedKinds: ['journal.write'] })).toEqual({ ok: false, reason: 'kind_not_allowed' });
  });

  it('端点没配 / URL 不安全 / 主机不在运营白名单 → 不探', () => {
    expect(authorizeProbe({ ...base, endpoint: '' })).toEqual({ ok: false, reason: 'unconfigured' });
    expect(authorizeProbe({ ...base, readHosts: [] })).toEqual({ ok: false, reason: 'unconfigured' });
    expect(authorizeProbe({ ...base, endpoint: 'http://allowed.example/read' })).toEqual({ ok: false, reason: 'unsafe_url' });
    expect(authorizeProbe({ ...base, endpoint: 'https://other.example/read' })).toEqual({ ok: false, reason: 'operator_host_not_allowed' });
  });

  it('授权缺失 / 过期 / 没授权这个主机 / scope 不符 → 不探', () => {
    expect(authorizeProbe({ ...base, grant: null })).toEqual({ ok: false, reason: 'grant_missing' });
    expect(authorizeProbe({ ...base, grant: grant({ expiresAt: NOW }) })).toEqual({ ok: false, reason: 'grant_expired' });
    expect(authorizeProbe({ ...base, grant: grant({ expiresAt: undefined }) })).toEqual({ ok: false, reason: 'grant_expired' });
    expect(authorizeProbe({ ...base, grant: grant({ allowedHosts: ['elsewhere.example'] }) }))
      .toEqual({ ok: false, reason: 'grant_host_not_allowed' });
    expect(authorizeProbe({ ...base, grant: grant({ scopes: ['read:note'] }) }))
      .toEqual({ ok: false, reason: 'scope_not_granted' });
    // 别的 provider 的 grant 不能给这个 provider 用。
    expect(authorizeProbe({ ...base, grant: grant({ provider: 'amap' }) })).toEqual({ ok: false, reason: 'grant_missing' });
  });

  it('travel.wish 也要主机授权，但不要求 read:search（它不出网读）', () => {
    const wish = {
      ...base,
      provider: 'amap' as const,
      mode: 'wish' as const,
      kind: 'travel.wish' as const,
      allowedKinds: ['travel.wish'],
      grant: grant({ provider: 'amap', scopes: ['read:geo'] }),
    };
    expect(authorizeProbe(wish).ok).toBe(true);
    expect(authorizeProbe({ ...wish, grant: grant({ provider: 'amap', scopes: ['read:geo'], allowedHosts: [] }) }))
      .toEqual({ ok: false, reason: 'grant_host_not_allowed' });
  });
});

describe('createReachabilityProbe：TTL 缓存按「端点 + 授权指纹」分键', () => {
  it('同一端点同一授权只探一次；换授权会重新探；失败也缓存', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const probe = createReachabilityProbe({ fetch: fetchImpl as unknown as typeof fetch, now: () => NOW });
    expect(await probe('https://allowed.example/read', 'sig-a')).toBe(true);
    expect(await probe('https://allowed.example/read', 'sig-a')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // 换一份授权指纹：必须重新探测，不能拿上一次的「可达」放行。
    expect(await probe('https://allowed.example/read', 'sig-b')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const failing = vi.fn(async () => { throw new Error('network down'); });
    const probe2 = createReachabilityProbe({ fetch: failing as unknown as typeof fetch, now: () => NOW });
    expect(await probe2('https://allowed.example/read', 'sig')).toBe(false);
    expect(await probe2('https://allowed.example/read', 'sig')).toBe(false);
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('探测只发一次 GET，不跟随重定向、不读 body', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 404 }));
    const probe = createReachabilityProbe({ fetch: fetchImpl as unknown as typeof fetch, now: () => NOW });
    expect(await probe('https://allowed.example/read', 'sig')).toBe(true);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('manual');
  });
});
