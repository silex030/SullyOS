/**
 * Worker 入口契约测试（集成卡 t_babca897）。
 *
 * 只测“路由/鉴权/开关/持久化缺失”这些接线层行为；平台解析由 service.test.ts 与
 * 父卡的适配器测试覆盖。这里把来源置空，强制走 SOURCE_NOT_CONFIGURED，**不访问网络**。
 */

import { describe, expect, it } from 'vitest';
import worker from './index';
import { openTestD1 } from './testDb';

function env(over: Record<string, unknown> = {}) {
  return {
    SOCIAL_CONTENT_DB: openTestD1(),
    SHARE_LINKS_ENABLED: 'true',
    SOCIAL_SERVICE_TOKEN: 'svc-token',
    SOCIAL_SOURCE_ID_BILIBILI: '',
    SOCIAL_SOURCE_ID_XIAOHONGSHU: '',
    SOCIAL_SOURCE_ID_DOUYIN: '',
    ...over,
  } as never;
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://social.local${path}`, init);
}

const AUTH = { 'x-social-service-token': 'svc-token', 'content-type': 'application/json' };

describe('social-content worker entry', () => {
  it('GET /health 不需要 token，但只回能力与开关（不含来源 id/token）', async () => {
    const res = await worker.fetch(req('/health'), env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.service).toBe('social-content');
    expect(body.feature.enabled).toBe(true);
    expect(JSON.stringify(body)).not.toContain('svc-token');
    expect(JSON.stringify(body)).not.toContain('public');
  });

  it('缺少服务令牌 → 403 fail-closed（配置了 token 时）', async () => {
    const res = await worker.fetch(req('/v1/social/shares?conversationId=c1&messageId=m1'), env());
    expect(res.status).toBe(403);
  });

  it('未配置 SOCIAL_SERVICE_TOKEN 且未允许匿名 → 403（不会退化成公开代理）', async () => {
    const res = await worker.fetch(
      req('/v1/social/shares?conversationId=c1&messageId=m1', { headers: AUTH }),
      env({ SOCIAL_SERVICE_TOKEN: '' }),
    );
    expect(res.status).toBe(403);
  });

  it('POST resolve：未配置来源时返回 202 + failed(SOURCE_NOT_CONFIGURED)，不联网', async () => {
    const res = await worker.fetch(
      req('/v1/social/shares/resolve', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({
          messageId: 'm1',
          conversationId: 'c1',
          text: '看这个 https://www.bilibili.com/video/BV1xx411c7mD',
        }),
      }),
      env(),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as any;
    expect(body.attachments[0].state).toBe('failed');
    expect(body.attachments[0].error.code).toBe('SOURCE_NOT_CONFIGURED');
    expect(body.pollAfterMs).toBeGreaterThan(0);
  });

  it('总开关关闭 → 503 SHARE_LINKS_DISABLED（读接口同样关）', async () => {
    const res = await worker.fetch(
      req('/v1/social/shares/resolve', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ messageId: 'm1', conversationId: 'c1', text: 'https://www.bilibili.com/video/BV1xx411c7mD' }),
      }),
      env({ SHARE_LINKS_ENABLED: 'false' }),
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error).toBe('SHARE_LINKS_DISABLED');
  });

  it('未绑定 DB → 503 PERSISTENCE_UNAVAILABLE（不拿内存冒充持久化）', async () => {
    const res = await worker.fetch(
      req('/v1/social/shares/resolve', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ messageId: 'm1', conversationId: 'c1', text: 'https://www.bilibili.com/video/BV1xx411c7mD' }),
      }),
      env({ SOCIAL_CONTENT_DB: undefined }),
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error).toBe('PERSISTENCE_UNAVAILABLE');
  });

  it('跨 scope / 未知 shareRef → 404；未知路由 → 404；CORS 预检 204', async () => {
    const notFound = await worker.fetch(req('/v1/social/shares/shr_nope', { headers: AUTH }), env());
    expect(notFound.status).toBe(404);
    const unknown = await worker.fetch(req('/v1/social/unknown', { headers: AUTH }), env());
    expect(unknown.status).toBe(404);
    const preflight = await worker.fetch(req('/v1/social/shares/resolve', { method: 'OPTIONS' }), env());
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('请求体不是 JSON / 太大 → 400 / 413', async () => {
    const bad = await worker.fetch(
      req('/v1/social/shares/resolve', { method: 'POST', headers: AUTH, body: '{oops' }),
      env(),
    );
    expect(bad.status).toBe(400);
    const huge = await worker.fetch(
      req('/v1/social/shares/resolve', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ messageId: 'm1', conversationId: 'c1', text: 'x'.repeat(300 * 1024) }),
      }),
      env(),
    );
    expect(huge.status).toBe(413);
  });
});
