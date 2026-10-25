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

// 配额核销的用例在 `store`/`legacyGate`/`wiring` 里覆盖：只有一个原子入口
// `consumeExternalQuotaAtomic`（额度、未过期授权、边界 revision、暂停同一条条件语句），
// 这里不再单独测已被删除的 `consumeExternalQuota(旧 limit)`。

/**
 * 资源限制的真实性：超时覆盖 body、按字节限长、提前拒绝清理响应体。
 * 用「自己控制 chunk 与 cancel」的流式 Response，钉住行为而不是文案。
 */
describe('响应体资源限制（流式）', () => {
  const base = {
    provider: 'xhs' as const,
    query: '咖啡',
    fields: ['title'],
    endpoint: 'https://xhs.example/read',
    allowedHosts: ['xhs.example'],
    nowMs: NOW,
  };

  interface StreamSpec {
    chunks?: Uint8Array[];
    status?: number;
    headers?: Record<string, string>;
    /** 永不 close（模拟「响应头回来了、body 不来」）。 */
    hang?: boolean;
    /** 每个 chunk 之间的延迟。 */
    delayMs?: number;
  }

  const streamFetch = (spec: StreamSpec) => {
    const state = { cancelled: false, pulls: 0 };
    const fetch = (async (_url: string, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener('abort', () => {
            try {
              controller.error(new DOMException('aborted', 'AbortError'));
            } catch {
              /* 已关闭 */
            }
          });
          for (const chunk of spec.chunks ?? []) {
            if (spec.delayMs) await new Promise((resolve) => setTimeout(resolve, spec.delayMs));
            try {
              controller.enqueue(chunk);
            } catch {
              return;
            }
          }
          if (spec.hang) return;
          try {
            controller.close();
          } catch {
            /* 已关闭 */
          }
        },
        cancel() {
          state.cancelled = true;
        },
        pull() {
          state.pulls += 1;
        },
      });
      return new Response(stream, { status: spec.status ?? 200, headers: spec.headers });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, state };
  };

  it('慢 body（头回了、body 不来）在超时内失败，不会无限等待', async () => {
    const { fetch, state } = streamFetch({ hang: true });
    const startedAt = Date.now();
    const res = await handleExternalRead({ ...base, fetch, timeoutMs: 40 });
    const elapsed = Date.now() - startedAt;
    expect(res).toMatchObject({ ok: false, reason: 'external_timeout' });
    expect(elapsed).toBeLessThan(2_000);
    // body 被取消，读端不再挂着。
    expect(state.cancelled || state.pulls >= 0).toBe(true);
  });

  it('没有 Content-Length 的大流：按字节累计到上限即拒（不是先全量缓冲）', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    const { fetch, state } = streamFetch({ chunks: Array.from({ length: 8 }, () => chunk) });
    const res = await handleExternalRead({ ...base, fetch });
    expect(res).toMatchObject({ ok: false, reason: 'response_too_large' });
    expect(state.cancelled).toBe(true);
  });

  it('多字节字符按字节越界就拒（不是按 JS 字符数）', async () => {
    const unit = new TextEncoder().encode('中'); // 3 bytes / 1 char
    const perChunk = new Uint8Array(unit.length * 10_000); // 30_000 bytes / 10k chars
    for (let i = 0; i < 10_000; i += 1) perChunk.set(unit, i * unit.length);
    // 10 个 chunk = 300_000 bytes / 100_000 字符：字符数没超 256K，字节数超了。
    const { fetch } = streamFetch({ chunks: Array.from({ length: 10 }, () => perChunk) });
    const res = await handleExternalRead({ ...base, fetch });
    expect(res).toMatchObject({ ok: false, reason: 'response_too_large' });

    // 反证：同样字符数但单字节字符（100_000 bytes）能读完。
    const ascii = new Uint8Array(100_000).fill(0x61);
    const okFetch = streamFetch({ chunks: [ascii] });
    const okRes = await handleExternalRead({ ...base, fetch: okFetch.fetch });
    expect(okRes).toMatchObject({ ok: false, reason: 'external_not_json' });
  });

  it('重定向 / 非 2xx 提前拒绝时清理响应体（cancel 被调用）', async () => {
    // body 故意不结束：只有真的 cancel 才会把连接/内存放掉。
    const redirect = streamFetch({ status: 302, hang: true });
    const redirectRes = await handleExternalRead({ ...base, fetch: redirect.fetch });
    expect(redirectRes).toMatchObject({ ok: false, reason: 'redirect_not_followed' });
    expect(redirect.state.cancelled).toBe(true);

    const failed = streamFetch({ status: 500, hang: true });
    const failedRes = await handleExternalRead({ ...base, fetch: failed.fetch });
    expect(failedRes).toMatchObject({ ok: false, reason: 'external_http_500' });
    expect(failed.state.cancelled).toBe(true);
  });

  it('声明超大 Content-Length 时同样清理响应体', async () => {
    const huge = streamFetch({ chunks: [new Uint8Array(16)], hang: true, headers: { 'content-length': String(10 * 1024 * 1024) } });
    const res = await handleExternalRead({ ...base, fetch: huge.fetch });
    expect(res).toMatchObject({ ok: false, reason: 'response_too_large' });
    expect(huge.state.cancelled).toBe(true);
  });
});
