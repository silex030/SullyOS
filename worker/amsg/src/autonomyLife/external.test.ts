/**
 * 受控外部只读窗口（服务端出口）：白名单 / SSRF / 重定向 / 投影 / 配额。
 *
 * 全部用假 fetch，钉的是「什么情况下**不发请求**、发了之后能回什么」：
 *   - 端点未配置、非 https、带凭据、默认端口外、IP 字面量、localhost/.internal、
 *     不在运营白名单、不在用户授权主机里 → 一律不发；
 *   - 3xx 不跟、超大响应拒收、非 JSON 拒收；
 *   - 回包只投影白名单字段并截断，原始响应不进结果；
 *   - 配额按 (owner, 日, provider) 原子自增，超限拒绝。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { createSqliteD1, openTestSqlite, type TestSqlite } from '../test/d1-sqlite';
import {
  consumeExternalQuota,
  handleExternalRead,
  isHostAllowed,
  parseAllowedHosts,
  projectItem,
} from './external';
import { ensureAutonomyLifeSchema, resetAutonomyLifeSchemaCacheForTesting, type LifeDb } from './store';

const NOW = Date.parse('2026-10-24T04:00:00.000Z');

let sql: TestSqlite;
let db: LifeDb;

beforeEach(async () => {
  sql = openTestSqlite();
  db = createSqliteD1(sql) as unknown as LifeDb;
  resetAutonomyLifeSchemaCacheForTesting();
  await ensureAutonomyLifeSchema(db);
});

const jsonFetch = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) =>
  (async () => new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })) as unknown as typeof globalThis.fetch;

describe('主机白名单', () => {
  it('精确与 *. 后缀匹配；中间通配不算', () => {
    expect(isHostAllowed('xhs.example', ['xhs.example'])).toBe(true);
    expect(isHostAllowed('api.xhs.example', ['*.xhs.example'])).toBe(true);
    expect(isHostAllowed('xhs.example', ['*.xhs.example'])).toBe(true);
    expect(isHostAllowed('evil-xhs.example', ['*.xhs.example'])).toBe(false);
    expect(isHostAllowed('xhs.example.evil.com', ['xhs.example'])).toBe(false);
  });

  it('环境变量解析：去空格、小写、空串回落', () => {
    expect(parseAllowedHosts(' A.example, b.example ,', ['c.example'])).toEqual(['a.example', 'b.example']);
    expect(parseAllowedHosts(undefined, ['C.example'])).toEqual(['c.example']);
  });
});

describe('URL 结构校验（SSRF 防线）', () => {
  const base = { query: '咖啡', fields: ['title'], allowedHosts: ['xhs.example'], nowMs: NOW };
  const reject = async (endpoint: string, expected: string) => {
    let called = false;
    const fetch = (async () => { called = true; return new Response('{}'); }) as unknown as typeof globalThis.fetch;
    const res = await handleExternalRead({ ...base, provider: 'xhs', endpoint, fetch });
    expect(res).toMatchObject({ ok: false, reason: expected });
    expect(called).toBe(false);
  };

  it('非 https / 带凭据 / 非默认端口 / IP / localhost / .internal 全部不发请求', async () => {
    await reject('http://xhs.example/read', 'https_required');
    await reject('https://user:pass@xhs.example/read', 'credentials_in_url_forbidden');
    await reject('https://xhs.example:8080/read', 'port_forbidden');
    await reject('https://127.0.0.1/read', 'ip_literal_forbidden');
    await reject('https://169.254.169.254/latest/meta-data', 'ip_literal_forbidden');
    await reject('https://[::1]/read', 'ip_literal_forbidden');
    await reject('https://localhost/read', 'host_forbidden');
    await reject('https://metadata.google.internal/computeMetadata', 'host_forbidden');
    await reject('https://printer.local/read', 'host_forbidden');
  });

  it('不在运营白名单 / 不在用户授权主机 → 不发请求', async () => {
    await reject('https://other.example/read', 'host_not_allowed');
    const res = await handleExternalRead({
      provider: 'xhs', query: '咖啡', fields: ['title'], endpoint: 'https://xhs.example/read',
      allowedHosts: [], nowMs: NOW, fetch: async () => { throw new Error('should not fetch'); },
    });
    expect(res).toMatchObject({ ok: false, reason: 'host_not_allowed' });
  });

  it('端点未配置 → CAPABILITY_UNAVAILABLE（不是 fixture 假装读到）', async () => {
    const res = await handleExternalRead({
      provider: 'xhs', query: '咖啡', fields: ['title'], endpoint: null, allowedHosts: ['xhs.example'], nowMs: NOW,
      fetch: async () => { throw new Error('should not fetch'); },
    });
    expect(res).toMatchObject({ ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  });
});

describe('响应处理', () => {
  const base = { provider: 'xhs' as const, query: '咖啡', fields: ['title', 'excerpt', 'author', 'likes'], endpoint: 'https://xhs.example/read', allowedHosts: ['xhs.example'], nowMs: NOW };

  it('只投影白名单字段、截断长文本，原始响应不外泄', async () => {
    const res = await handleExternalRead({
      ...base,
      fetch: jsonFetch({ items: [{ title: 'x'.repeat(500), excerpt: '短', author: 'a', likes: 9, phone: '13800000000', secret: 'token' }] }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const item = res.result.items[0];
    expect(Object.keys(item).sort()).toEqual(['author', 'excerpt', 'likes', 'title']);
    expect(String(item.title).length).toBeLessThanOrEqual(201);
    expect(JSON.stringify(item)).not.toContain('13800000000');
    expect(JSON.stringify(item)).not.toContain('token');
  });

  it('3xx 不跟；超大响应 / 非 JSON 拒收', async () => {
    const redirect = await handleExternalRead({
      ...base,
      fetch: (async () => new Response('', { status: 302, headers: { Location: 'https://internal.example/' } })) as unknown as typeof globalThis.fetch,
    });
    expect(redirect).toMatchObject({ ok: false, reason: 'redirect_not_followed' });

    const huge = await handleExternalRead({
      ...base,
      fetch: jsonFetch({ items: [] }, { headers: { 'content-length': String(10 * 1024 * 1024) } }),
    });
    expect(huge).toMatchObject({ ok: false, reason: 'response_too_large' });

    const notJson = await handleExternalRead({
      ...base,
      fetch: (async () => new Response('<html>nope</html>', { status: 200 })) as unknown as typeof globalThis.fetch,
    });
    expect(notJson).toMatchObject({ ok: false, reason: 'external_not_json' });
  });

  it('projectItem 丢掉非标量与白名单外字段', () => {
    expect(projectItem({ title: 't', tags: ['x'], n: 3 }, ['title', 'tags', 'n'], ['title', 'tags', 'n'])).toEqual({ title: 't', n: 3 });
  });
});

describe('配额', () => {
  it('按 (owner, 日, provider) 原子自增，超过上限拒绝', async () => {
    const args = { db, ownerId: 'u1', dayKey: '2026-10-24', provider: 'xhs' as const, limit: 2, nowMs: NOW };
    expect(await consumeExternalQuota(args)).toBe(true);
    expect(await consumeExternalQuota(args)).toBe(true);
    expect(await consumeExternalQuota(args)).toBe(false);
    // 其他用户 / 其他天的额度不受影响。
    expect(await consumeExternalQuota({ ...args, ownerId: 'u2' })).toBe(true);
    expect(await consumeExternalQuota({ ...args, dayKey: '2026-10-25' })).toBe(true);
    // limit=0 是硬零。
    expect(await consumeExternalQuota({ ...args, ownerId: 'u3', limit: 0 })).toBe(false);
  });
});
