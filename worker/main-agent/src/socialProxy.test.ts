/**
 * main-agent ↔ social-content 反代测试（集成卡 t_babca897）。
 *
 * 真实起一个本地 http 服务当上游（不是 mock fetch），验证：
 *   - 外部契约仍是 /agent/v1/social/*，鉴权复用 main-agent 的 X-Client-Token；
 *   - 反代把 /agent 前缀剥掉后打到 SOCIAL_CONTENT_URL，并注入 X-Social-Service-Token；
 *   - query 与 body 原样透传，状态码/响应体如实回传（不把 4xx/5xx 伪装成 200）；
 *   - 上游不可用 → 502；超时 → 504（这里只测不可用，超时靠 25s 常量，不拖慢用例）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
// @ts-expect-error main-agent 是纯 JS 单文件，仓库没开 allowJs
import worker from './index.js';

const AGENT = 'https://agent.test';
const TOKEN = 'client-token';

let server: Server;
let port = 0;
let lastRequest: { url?: string; method?: string; headers?: Record<string, unknown>; body?: string } = {};
let upstreamStatus = 202;
let upstreamBody = '{"attachments":[],"pollAfterMs":1000}';

function listen(): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    lastRequest = {
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    res.writeHead(upstreamStatus, { 'content-type': 'application/json' });
    res.end(upstreamBody);
  });
  await listen();
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  lastRequest = {};
  upstreamStatus = 202;
  upstreamBody = '{"attachments":[],"pollAfterMs":1000}';
});

const env = (over: Record<string, string> = {}) => ({
  AMSG_CLIENT_TOKEN: TOKEN,
  SOCIAL_CONTENT_URL: `http://127.0.0.1:${port}`,
  SOCIAL_SERVICE_TOKEN: 'svc-secret',
  SHARE_LINKS_ENABLED: 'true',
  ...over,
});

const call = (path: string, init: RequestInit = {}, envOver: Record<string, string> = {}) =>
  worker.fetch(
    new Request(`${AGENT}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', 'x-client-token': TOKEN, ...(init.headers as Record<string, string>) },
      body: init.body,
    }),
    env(envOver),
    { waitUntil: () => {} },
  );

describe('/v1/social 反代', () => {
  it('缺 token → 403，且一次上游都不打', async () => {
    const res = await worker.fetch(
      new Request(`${AGENT}/agent/v1/social/shares?conversationId=c1&messageId=m1`),
      env(),
      { waitUntil: () => {} },
    );
    expect(res.status).toBe(403);
    expect(lastRequest.url).toBeUndefined();
  });

  it('POST resolve：前缀剥离、注入服务令牌、body 与状态原样透传', async () => {
    const res = await call('/agent/v1/social/shares/resolve', {
      method: 'POST',
      body: JSON.stringify({ messageId: 'm1', conversationId: 'c1', text: 'https://www.bilibili.com/video/BV1xx411c7mD' }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ pollAfterMs: 1000 });
    expect(lastRequest.url).toBe('/v1/social/shares/resolve');
    expect(lastRequest.method).toBe('POST');
    expect(lastRequest.headers?.['x-social-service-token']).toBe('svc-secret');
    // 客户端 token 不透传给内部服务（内部只认自己的服务令牌）
    expect(lastRequest.headers?.['x-client-token']).toBeUndefined();
    expect(JSON.parse(String(lastRequest.body)).messageId).toBe('m1');
  });

  it('GET 列表：query 保留', async () => {
    upstreamStatus = 200;
    upstreamBody = '{"attachments":[]}';
    const res = await call('/agent/v1/social/shares?conversationId=c1&messageId=m9');
    expect(res.status).toBe(200);
    expect(lastRequest.url).toBe('/v1/social/shares?conversationId=c1&messageId=m9');
    expect(lastRequest.method).toBe('GET');
    expect(lastRequest.body).toBe('');
  });

  it('上游 4xx/5xx 如实回传（不伪装成功）', async () => {
    upstreamStatus = 503;
    upstreamBody = JSON.stringify({ error: 'SHARE_LINKS_DISABLED' });
    const res = await call('/agent/v1/social/shares/resolve', { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'SHARE_LINKS_DISABLED' });
  });

  it('未配置 SOCIAL_CONTENT_URL → 503，不去猜地址', async () => {
    const res = await call('/agent/v1/social/shares/resolve', { method: 'POST', body: '{}' }, { SOCIAL_CONTENT_URL: '' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'social_content_unavailable' });
  });

  it('上游连不上 → 502，不挂住', async () => {
    const res = await call('/agent/v1/social/shares/resolve', { method: 'POST', body: '{}' }, {
      SOCIAL_CONTENT_URL: 'http://127.0.0.1:1',
    });
    expect(res.status).toBe(502);
  });

  it('健康检查暴露分享开关（不含 token）', async () => {
    const res = await worker.fetch(new Request(`${AGENT}/agent/health`), env(), { waitUntil: () => {} });
    const body = (await res.json()) as Record<string, any>;
    expect(body.shareLinks).toEqual({ configured: true, enabled: true });
    expect(JSON.stringify(body)).not.toContain('svc-secret');
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });
});
