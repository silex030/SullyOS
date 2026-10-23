import { beforeEach, describe, expect, it } from 'vitest';

import { createSqliteD1, openTestSqlite, type TestSqlite } from '../test/d1-sqlite';
import { ensureTravelSchema, resetTravelSchemaCacheForTesting, type TravelDb } from './store';
import { saveTravelMapCredentials } from './mapCredentials';
import {
  handleAmapServiceProxy,
  mintTravelMapServiceHost,
  resetAmapProxyRateLimitForTesting,
  verifyTravelMapProxyToken,
} from './mapProxy';

const NOW = Date.parse('2026-10-23T04:00:00.000Z');
const MASTER = 'test-master-key-0123456789abcdef-32';
const SECRET = 'travel-session-secret-0123456789abcdef-32';
const USER = 'u1';

const WEB_KEY = 'web-service-key-SECRET-0001';
const JS_KEY = 'js-api-key-PUBLIC-0002';
const JS_CODE = 'jscode-SECRET-0003';

let sql: TestSqlite;
let db: TravelDb;

const seed = async (userId = USER) => {
  const saved = await saveTravelMapCredentials({
    db: db as never,
    userId,
    masterKey: MASTER,
    patch: { amapWebKey: WEB_KEY, amapJsKey: JS_KEY, amapJsCode: JS_CODE },
    nowMs: NOW,
  });
  expect(saved.ok).toBe(true);
};

const proxy = async (
  serviceHostTail: string,
  opts: { query?: string; method?: string; nowMs?: number; rpm?: number } = {},
) => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ status: '1', count: '0', geocodes: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  const res = await handleAmapServiceProxy(
    new Request(`https://site.example${serviceHostTail}${opts.query ?? '?keywords=%E5%85%AC%E5%9B%AD'}`, {
      method: opts.method ?? 'GET',
    }),
    {
      db: db as never,
      masterKey: MASTER,
      secret: SECRET,
      now: () => opts.nowMs ?? NOW,
      fetch: fetchImpl,
      rpm: opts.rpm,
    },
  );
  return { res: res as Response, calls };
};

beforeEach(async () => {
  resetTravelSchemaCacheForTesting();
  resetAmapProxyRateLimitForTesting();
  sql = openTestSqlite();
  db = createSqliteD1(sql) as unknown as TravelDb;
  await ensureTravelSchema(db);
});

describe('travel map proxy · 官方 _AMapService 前缀 + 短期签名会话', () => {
  it('serviceHost 绑定 userId 与过期时间；改一个字符即失效', async () => {
    const minted = await mintTravelMapServiceHost({ userId: USER, secret: SECRET, nowMs: NOW });
    expect(minted?.serviceHost.startsWith('/_AMapService/t/')).toBe(true);
    const token = minted!.serviceHost.slice('/_AMapService/t/'.length);
    const ok = await verifyTravelMapProxyToken(token, { secret: SECRET, nowMs: NOW });
    expect(ok.ok).toBe(true);
    expect(ok.ok ? ok.value.userId : '').toBe(USER);

    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect((await verifyTravelMapProxyToken(tampered, { secret: SECRET, nowMs: NOW })).ok).toBe(false);
  });

  it('只注入服务端保存的 jscode 与 JS Key：前端传的 jscode 被丢弃，响应里看不到密钥', async () => {
    await seed();
    const minted = await mintTravelMapServiceHost({ userId: USER, secret: SECRET, nowMs: NOW });
    const tail = `${minted!.serviceHost}/v3/place/text`;
    const { res, calls } = await proxy(`${tail}`, { query: '?keywords=%E5%85%AC%E5%9B%AD&jscode=client-forged&key=client-forged' });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!);
    expect(url.origin).toBe('https://restapi.amap.com');
    expect(url.pathname).toBe('/v3/place/text');
    expect(url.searchParams.get('jscode')).toBe(JS_CODE);
    expect(url.searchParams.get('key')).toBe(JS_KEY);

    const body = await res.text();
    expect(body).not.toContain(JS_CODE);
    expect(body).not.toContain(WEB_KEY);
    expect(body).not.toContain(JS_KEY);
  });

  it('非白名单端点 / 非 GET / 过期会话一律拒绝，且不向上游发请求', async () => {
    await seed();
    const minted = await mintTravelMapServiceHost({ userId: USER, secret: SECRET, nowMs: NOW });

    const disallowed = await proxy(`${minted!.serviceHost}/v3/place/detail`);
    expect(disallowed.res.status).toBe(403);
    expect(disallowed.calls).toHaveLength(0);

    const post = await proxy(`${minted!.serviceHost}/v3/place/text`, { method: 'POST' });
    expect(post.res.status).toBe(405);
    expect(post.calls).toHaveLength(0);

    const expired = await proxy(`${minted!.serviceHost}/v3/place/text`, { nowMs: NOW + 31 * 60_000 });
    expect(expired.res.status).toBe(403);
    expect(expired.calls).toHaveLength(0);
  });

  it('跨用户不能借用别人的凭据：u2 的 token 在 u2 没配时 503，不会落到 u1', async () => {
    await seed(USER);
    const minted = await mintTravelMapServiceHost({ userId: 'u2', secret: SECRET, nowMs: NOW });
    const { res, calls } = await proxy(`${minted!.serviceHost}/v3/place/text`);
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('限流按用户计：超过每分钟额度直接 429，不转发', async () => {
    await seed();
    const minted = await mintTravelMapServiceHost({ userId: USER, secret: SECRET, nowMs: NOW });
    const tail = `${minted!.serviceHost}/v3/place/text`;
    expect((await proxy(tail, { rpm: 2 })).res.status).toBe(200);
    expect((await proxy(tail, { rpm: 2 })).res.status).toBe(200);
    const third = await proxy(tail, { rpm: 2 });
    expect(third.res.status).toBe(429);
    expect(third.calls).toHaveLength(0);
  });

  it('没有 jscode / JS Key 时不发请求（不退回环境变量或别人的密钥）', async () => {
    await saveTravelMapCredentials({
      db: db as never,
      userId: USER,
      masterKey: MASTER,
      patch: { amapWebKey: WEB_KEY },
      nowMs: NOW,
    });
    const minted = await mintTravelMapServiceHost({ userId: USER, secret: SECRET, nowMs: NOW });
    const { res, calls } = await proxy(`${minted!.serviceHost}/v3/place/text`);
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});
