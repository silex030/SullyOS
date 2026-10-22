// worker/main-agent/auth.test.ts
// B7：未配置 AMSG_CLIENT_TOKEN 的生产路径必须 fail-closed；只有显式开发开关才允许匿名。
// 只测鉴权函数行为，不触网、不调用供应商。
import { describe, expect, it } from 'vitest';
// @ts-ignore 单文件 worker（手写 ESM，无类型声明）
import mainAgent from './src/index.js';

type Env = Record<string, string>;

const call = async (path: string, headers: Env = {}, env: Env = {}) => {
  const request = new Request(`http://127.0.0.1:8830${path}`, { headers });
  return mainAgent.fetch(request, env);
};

describe('main-agent 鉴权：缺 token 时 fail-closed', () => {
  it('未设置 token 且未开开发开关：受保护端点一律 403', async () => {
    const res = await call('/v1/chat/completions', {}, {});
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('unauthorized');

    expect((await call('/webdav/whatever', {}, {})).status).toBe(403);
    expect((await call('/v1/tts', {}, {})).status).toBe(403);
    expect((await call('/v1/mcp-relay', {}, {})).status).toBe(403);
  });

  it('空白 token（只有空格）同样按未配置处理，仍然 403', async () => {
    const res = await call('/v1/chat/completions', {}, { AMSG_CLIENT_TOKEN: '   ' });
    expect(res.status).toBe(403);
  });

  it('显式开发开关 MAIN_AGENT_ALLOW_ANONYMOUS=true 才放行匿名', async () => {
    const res = await call('/v1/not-a-real-route', {}, { MAIN_AGENT_ALLOW_ANONYMOUS: 'true' });
    expect(res.status).toBe(404); // 过了鉴权，落到 404
    // 非 true 的值不算开关
    expect((await call('/v1/not-a-real-route', {}, { MAIN_AGENT_ALLOW_ANONYMOUS: '1' })).status).toBe(403);
    expect((await call('/v1/not-a-real-route', {}, { MAIN_AGENT_ALLOW_ANONYMOUS: 'yes' })).status).toBe(403);
  });

  it('配置了 token 时：缺失/错误凭据 403，正确凭据放行；开发开关不能绕过', async () => {
    const env: Env = { AMSG_CLIENT_TOKEN: 'secret-token', MAIN_AGENT_ALLOW_ANONYMOUS: 'true' };
    expect((await call('/v1/not-a-real-route', {}, env)).status).toBe(403);
    expect((await call('/v1/not-a-real-route', { 'x-client-token': 'nope' }, env)).status).toBe(403);
    expect((await call('/v1/not-a-real-route', { authorization: 'Bearer nope' }, env)).status).toBe(403);
    expect((await call('/v1/not-a-real-route', { 'x-client-token': 'secret-token' }, env)).status).toBe(404);
    expect((await call('/v1/not-a-real-route', { authorization: 'Bearer secret-token' }, env)).status).toBe(404);
  });

  it('/health 仍免鉴权（运维探活不能被锁死）', async () => {
    const res = await call('/health', {}, { AMSG_CLIENT_TOKEN: 'secret-token' });
    expect(res.status).toBe(200);
  });
});
