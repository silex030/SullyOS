/**
 * 地图 REST 中转（`/travel/map/rest`）回归：
 * - 只认已鉴权主体（调用方必须先把 userId 解出来，这里没有「公开中转」形态）；
 * - allowlist 之外一律拒绝，不接受参数指定上游；
 * - 只按该用户的 **Web 服务 Key** 取数，客户端带来的 key/jscode 一律丢弃；
 * - 响应体与错误文案里不出现 Key。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { createSqliteD1, openTestSqlite, type TestSqlite } from '../test/d1-sqlite';
import { ensureTravelSchema, resetTravelSchemaCacheForTesting, type TravelDb } from './store';
import { saveTravelMapCredentials } from './mapCredentials';
import { resetAmapProxyRateLimitForTesting } from './mapProxy';
import { handleMapRestRelay, parseMapRestEndpoint } from './mapRest';

const NOW = Date.parse('2026-10-24T04:00:00.000Z');
const MASTER = 'test-master-key-0123456789abcdef-32';
const USER = 'u1';

const WEB_KEY = 'web-service-key-SECRET-0001';
const JS_KEY = 'js-api-key-PUBLIC-0002';
const JS_CODE = 'jscode-SECRET-0003';

let sql: TestSqlite;
let db: TravelDb;

const seed = async (userId = USER, patch: { amapWebKey?: string } = { amapWebKey: WEB_KEY }) => {
  const saved = await saveTravelMapCredentials({
    db: db as never,
    userId,
    masterKey: MASTER,
    patch: { ...patch, amapJsKey: JS_KEY, amapJsCode: JS_CODE },
    nowMs: NOW,
  });
  expect(saved.ok).toBe(true);
};

const relay = async (
  path: string,
  opts: { query?: string; method?: string; userId?: string; rpm?: number } = {},
) => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ status: '1', count: '0', geocodes: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  const res = await handleMapRestRelay(
    new Request(`https://site.example${path}${opts.query ?? '?address=%E6%9D%AD%E5%B7%9E'}`, {
      method: opts.method ?? 'GET',
    }),
    {
      db: db as never,
      masterKey: MASTER,
      userId: opts.userId ?? USER,
      nowMs: NOW,
      fetch: fetchImpl,
      rpm: opts.rpm,
      upstreamBase: 'https://restapi.amap.com',
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

describe('map REST relay', () => {
  it('地理编码：用该用户的 Web 服务 Key 转发，客户端 key/jscode 被丢弃', async () => {
    await seed();
    const { res, calls } = await relay('/travel/map/rest/v3/geocode/geo', {
      query: '?address=杭州&key=CLIENT-KEY&jscode=CLIENT-JSCODE',
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const upstream = new URL(calls[0]!);
    expect(upstream.origin + upstream.pathname).toBe('https://restapi.amap.com/v3/geocode/geo');
    expect(upstream.searchParams.get('key')).toBe(WEB_KEY);
    expect(upstream.searchParams.get('jscode')).toBeNull();
    expect(upstream.searchParams.get('address')).toBe('杭州');
    // 响应体不回显 Key。
    const body = await res.text();
    expect(body.includes(WEB_KEY)).toBe(false);
    expect(body.includes(JS_CODE)).toBe(false);
  });

  it('JS 代理通道与 REST 通道凭证分工：REST 不漏 JS Key / jscode', async () => {
    await seed();
    const { calls } = await relay('/travel/map/rest/v3/place/text', { query: '?keywords=公园&city=330100' });
    const upstream = new URL(calls[0]!);
    expect(upstream.searchParams.get('key')).toBe(WEB_KEY);
    expect(upstream.searchParams.has('jscode')).toBe(false);
  });

  it('没有该用户的 Web 服务 Key：503 MAP_NOT_CONFIGURED，不打上游', async () => {
    await seed(USER, { amapWebKey: '' });
    const { res, calls } = await relay('/travel/map/rest/v3/geocode/geo');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('MAP_NOT_CONFIGURED');
    expect(calls).toHaveLength(0);
  });

  it('另一个用户没配 Key：不会借用别人的凭证', async () => {
    await seed();
    const { res, calls } = await relay('/travel/map/rest/v3/geocode/geo', { userId: 'u2' });
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('allowlist 之外：403，且不发请求（不能当开放代理）', async () => {
    await seed();
    const { res, calls } = await relay('/travel/map/rest/v3/direction/transit/integrated');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ENDPOINT_NOT_ALLOWED');
    expect(calls).toHaveLength(0);

    const foreign = await relay('/travel/map/rest/https://evil.example/steal');
    expect(foreign.res.status).toBe(400);
    expect(foreign.calls).toHaveLength(0);
  });

  it('只接受 GET；路径形态非法回 400，白名单外的 /v3 路径回 403', async () => {
    await seed();
    expect((await relay('/travel/map/rest/v3/geocode/geo', { method: 'POST' })).res.status).toBe(405);
    expect((await relay('/travel/map/rest/not-v3/geo')).res.status).toBe(400);
    expect((await relay('/travel/map/rest/v3/geocode')).res.status).toBe(403);
  });

  it('按用户限流（与 JS 代理共用同一本账）', async () => {
    await seed();
    const first = await relay('/travel/map/rest/v3/geocode/geo', { rpm: 1 });
    expect(first.res.status).toBe(200);
    const second = await relay('/travel/map/rest/v3/geocode/geo', { rpm: 1 });
    expect(second.res.status).toBe(429);
    expect(second.calls).toHaveLength(0);
  });

  it('endpoint 解析只认 /v3/ 前缀', () => {
    expect(parseMapRestEndpoint('/travel/map/rest/v3/geocode/geo')).toBe('/v3/geocode/geo');
    expect(parseMapRestEndpoint('/amsg/travel/map/rest/v3/place/text')).toBe('/v3/place/text');
    expect(parseMapRestEndpoint('/travel/map/rest/v2/geocode')).toBeNull();
    expect(parseMapRestEndpoint('/travel/map/credentials')).toBeNull();
  });
});
