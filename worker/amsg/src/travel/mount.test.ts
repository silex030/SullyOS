/**
 * 出行 · 挂载回归（`worker/amsg/src/index.ts` 真的把 /travel/* 接上了）
 *
 * 为什么单独一条：路由文件自身全绿也可能**根本没挂**，或者被未知 fallback 先吃掉。
 * 这里直接打 worker 的 `fetch` 入口，断言：
 * - `/travel/state` 返回的是出行错误形状（不是上游 404 兜底）；
 * - `/travel/session` 在缺 owner 凭据时明确 400（不是没路由）；
 * - `/travel/staticmap` 带无签名参数时是我们自己的 no-store JSON；
 * - 配置门仍然优先：缺 DB/主密钥时照样 503 WORKER_CONFIG_MISSING。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import worker from '../index';
import { createSqliteD1, openTestSqlite, type TestSqlite } from '../test/d1-sqlite';

const SECRET = 'mount-test-session-secret-0123456789';

let sql: TestSqlite;
let env: Record<string, unknown>;

beforeEach(() => {
  sql = openTestSqlite();
  env = {
    DB: createSqliteD1(sql),
    AMSG_MASTER_KEY: 'a'.repeat(64),
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    VAPID_EMAIL: 'mailto:ops@example.com',
    TRAVEL_SESSION_SECRET: SECRET,
  };
});

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  worker.fetch(
    new Request(`https://worker.example${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env as never,
  );

describe('出行路由真的挂在 worker 入口上', () => {
  it('/travel/state 无会话 → 401，且是出行错误形状（不是上游兜底）', async () => {
    const res = await worker.fetch(
      new Request('https://worker.example/travel/state?charId=c1'),
      env as never,
    );
    expect(res.status).toBe(401);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('UNAUTHORIZED');
  });

  it('/travel/session 缺 userId/ownerKey → 400（说明这个端点已经由我们接管）', async () => {
    const res = await post('/travel/session', {});
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: { code?: string; detail?: string } };
    expect(body.error?.code).toBe('UNAUTHORIZED');
    expect(body.error?.detail).toBe('invalid-request');
  });

  it('/travel/session/exchange 未登记 owner → 401，且不回 token', async () => {
    const res = await post('/travel/session/exchange', {
      userId: '11111111-1111-4111-8111-111111111111',
      ownerKey: 'owner-key-not-registered-0001',
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { success?: boolean; session?: unknown };
    expect(body.success).toBe(false);
    expect(body.session).toBeUndefined();
  });

  it('/travel/staticmap 主体不可解 → 401 + no-store（不是图片占位）', async () => {
    const res = await worker.fetch(
      new Request('https://worker.example/travel/staticmap?u=x&c=c1'),
      env as never,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });

  it('/travel/staticmap 签名不对 → 403 + no-store（URL 里没有 Bearer）', async () => {
    const tag = Buffer.from('u:11111111-1111-4111-8111-111111111111').toString('base64url');
    const res = await worker.fetch(
      new Request(
        `https://worker.example/travel/staticmap?u=${tag}&c=c1&e=${Date.now() + 60_000}&w=480&h=240&s=forged`,
      ),
      env as never,
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    const body = await res.json() as { error?: { code?: string; detail?: string } };
    expect(body.error?.code).toBe('UNAUTHORIZED');
  });

  it('配置门优先：缺 DB 时 /travel/state 仍然是 503 WORKER_CONFIG_MISSING', async () => {
    const res = await worker.fetch(
      new Request('https://worker.example/travel/state?charId=c1'),
      { AMSG_MASTER_KEY: 'a'.repeat(64) } as never,
    );
    expect(res.status).toBe(503);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('WORKER_CONFIG_MISSING');
  });
});
