import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { safeGet, type SafeFetchDeps, type TransportResponse } from './safeFetch';
import { SocialError } from './errors';
import { fakeDeps, hangingTransport } from './testSupport';
import { nodePinningTransport } from './nodeTransport.js';

/**
 * 受控抓取的契约测试（t_2c2dba79，契约 7.1/5.7）。
 * 全部用假 DNS + 假 transport；最后一组用本机 http server 验证 node transport 的真实绑定能力。
 */

const HOSTS = ['www.bilibili.com', 'api.bilibili.com', 'b23.tv', 'evil.example'];

describe('正常读取', () => {
  it('返回正文、状态与跳数，并把解析过的地址记进审计', async () => {
    const { deps } = fakeDeps({ 'www.bilibili.com/video/BV1xx411c7mD': { body: '<html>ok</html>' } });
    const res = await safeGet('https://www.bilibili.com/video/BV1xx411c7mD', deps, { allowedHosts: HOSTS });
    expect(res.status).toBe(200);
    expect(res.text).toBe('<html>ok</html>');
    expect(res.hops).toBe(0);
    expect(res.audit[0].addresses).toEqual(['93.184.216.34']);
  });

  it('响应超过 maxBytes 时截断并显式标记', async () => {
    const big = 'x'.repeat(5000);
    const { deps } = fakeDeps({ 'www.bilibili.com/video/BV1xx411c7mD': { body: big } });
    const res = await safeGet('https://www.bilibili.com/video/BV1xx411c7mD', deps, {
      allowedHosts: HOSTS,
      maxBytes: 1024,
    });
    expect(res.truncated).toBe(true);
    expect(res.bytes).toBe(1024);
    expect(res.text.length).toBe(1024);
  });
});

describe('重定向逐跳校验', () => {
  it('短链 302 到目标站：跟随且重新验证', async () => {
    const { deps, calls } = fakeDeps({
      'b23.tv/XyZ123': { status: 302, headers: { location: 'https://www.bilibili.com/video/BV1xx411c7mD' }, body: '' },
      'www.bilibili.com/video/BV1xx411c7mD': { body: 'final' },
    });
    const res = await safeGet('https://b23.tv/XyZ123', deps, { allowedHosts: HOSTS });
    expect(res.text).toBe('final');
    expect(res.hops).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('跳到私网地址 → UNSAFE_URL（模拟 DNS 重绑定/内网探测）', async () => {
    const { deps } = fakeDeps(
      {
        'www.bilibili.com/video/BV1xx411c7mD': {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
          body: '',
        },
      },
      {
        resolver: (host) => (host === '169.254.169.254' ? ['169.254.169.254'] : ['93.184.216.34']),
      },
    );
    await expect(
      safeGet('https://www.bilibili.com/video/BV1xx411c7mD', deps, { allowedHosts: HOSTS }),
    ).rejects.toMatchObject({ code: 'UNSAFE_URL' });
  });

  it('跳到白名单外域名 → UNSAFE_URL host_not_allowlisted', async () => {
    const { deps } = fakeDeps({
      'www.bilibili.com/video/BV1xx411c7mD': {
        status: 302,
        headers: { location: 'https://attacker.example/steal' },
        body: '',
      },
    });
    await expect(
      safeGet('https://www.bilibili.com/video/BV1xx411c7mD', deps, { allowedHosts: HOSTS }),
    ).rejects.toMatchObject({ code: 'UNSAFE_URL' });
  });

  it('跨站跳转不转发 Cookie/Authorization', async () => {
    const { deps, calls } = fakeDeps({
      'b23.tv/XyZ123': { status: 302, headers: { location: 'https://www.bilibili.com/video/BV1xx411c7mD' }, body: '' },
      'www.bilibili.com/video/BV1xx411c7mD': { body: 'final' },
    });
    await safeGet('https://b23.tv/XyZ123', deps, {
      allowedHosts: HOSTS,
      headers: { cookie: 'SESSDATA=secret', authorization: 'Bearer x', 'user-agent': 'test' },
    });
    expect(calls[0].headers.cookie).toBe('SESSDATA=secret');
    expect(calls[1].headers.cookie).toBeUndefined();
    expect(calls[1].headers.authorization).toBeUndefined();
    expect(calls[1].headers['user-agent']).toBe('test');
  });

  it('超过 5 跳 → too_many_redirects', async () => {
    const routes: Record<string, { status: number; headers: Record<string, string>; body: string }> = {};
    for (let i = 0; i < 8; i += 1) {
      routes[`www.bilibili.com/hop${i}`] = { status: 302, headers: { location: `/hop${i + 1}` }, body: '' };
    }
    const { deps } = fakeDeps(routes);
    await expect(safeGet('https://www.bilibili.com/hop0', deps, { allowedHosts: HOSTS })).rejects.toMatchObject({
      code: 'UNSAFE_URL',
      reason: 'too_many_redirects',
    });
  });

  it('https 降级到 http 的重定向直接拒绝', async () => {
    const { deps } = fakeDeps({
      'www.bilibili.com/video/BV1xx411c7mD': {
        status: 302,
        headers: { location: 'http://www.bilibili.com/video/BV1xx411c7mD' },
        body: '',
      },
    });
    await expect(
      safeGet('https://www.bilibili.com/video/BV1xx411c7mD', deps, { allowedHosts: HOSTS }),
    ).rejects.toMatchObject({ reason: 'redirect_protocol_downgrade' });
  });

  it('无 Location 的 3xx → UPSTREAM_CHANGED', async () => {
    const { deps } = fakeDeps({ 'www.bilibili.com/x': { status: 302, body: '' } });
    await expect(safeGet('https://www.bilibili.com/x', deps, { allowedHosts: HOSTS })).rejects.toMatchObject({
      code: 'UPSTREAM_CHANGED',
    });
  });
});

describe('状态码与错误映射', () => {
  const cases: Array<[number, string, Record<string, string>?]> = [
    [401, 'AUTH_REQUIRED'],
    [403, 'ACCESS_DENIED'],
    [404, 'CONTENT_NOT_FOUND'],
    [410, 'CONTENT_DELETED'],
    [451, 'REGION_RESTRICTED'],
    [402, 'PAYWALL'],
    // B 站等平台用 412 表达风控预检失败（真实探测命中过）
    [412, 'ACCESS_DENIED'],
  ];
  for (const [status, code, headers] of cases) {
    it(`${status} → ${code}`, async () => {
      const { deps } = fakeDeps({ 'www.bilibili.com/x': { status, body: 'nope', headers } });
      await expect(safeGet('https://www.bilibili.com/x', deps, { allowedHosts: HOSTS })).rejects.toMatchObject({ code });
    });
  }

  it('429 读取 Retry-After 秒数', async () => {
    const { deps } = fakeDeps({
      'www.bilibili.com/x': { status: 429, body: '', headers: { 'retry-after': '30' } },
    });
    try {
      await safeGet('https://www.bilibili.com/x', deps, { allowedHosts: HOSTS });
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SocialError);
      expect((err as SocialError).code).toBe('RATE_LIMITED');
      expect((err as SocialError).retryAfterMs).toBe(30000);
    }
  });

  it('DNS 解析失败 → NETWORK_ERROR（可重试）', async () => {
    const deps = {
      resolve: async () => {
        throw new Error('dns down');
      },
      transport: async () => {
        throw new Error('unreachable');
      },
    };
    await expect(safeGet('https://www.bilibili.com/x', deps, { allowedHosts: HOSTS })).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      autoRetryable: true,
    });
  });

  it('超时 → TIMEOUT', async () => {
    const deps = { resolve: async () => ['93.184.216.34'], transport: hangingTransport(new Promise<never>(() => {})) };
    await expect(
      safeGet('https://www.bilibili.com/x', deps, { allowedHosts: HOSTS, perRequestTimeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('nodePinningTransport（真实连接，本机回环）', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  it('把连接绑定到 pinnedAddresses 并读回正文', async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, pinned: true }));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;

    const res = await nodePinningTransport({
      url: `http://127.0.0.1:${port}/probe?x=1`,
      method: 'GET',
      headers: { accept: 'application/json' },
      pinnedAddresses: ['127.0.0.1'],
      signal: new AbortController().signal,
      maxBytes: 4096,
    });
    expect(res.status).toBe(200);
    const body = await res.readBody(4096);
    expect(JSON.parse(body.text)).toEqual({ path: '/probe?x=1', pinned: true });
    expect(body.truncated).toBe(false);
  });

  it('没有 pinnedAddresses 时直接拒绝（不允许退化成重新解析）', async () => {
    await expect(
      nodePinningTransport({
        url: 'http://127.0.0.1:1/x',
        method: 'GET',
        headers: {},
        pinnedAddresses: [],
        signal: new AbortController().signal,
        maxBytes: 1024,
      }),
    ).rejects.toThrow('pinned_address_required');
  });
});


/**
 * 缺陷 2 的回归：期限必须覆盖**整条链路**（DNS + 连接 + 每跳 + 读完正文），
 * 而不是只罩住 transport 拿到响应头的那一下。下面用“卡住 DNS / 卡住正文 / 慢重定向链”
 * 三种在旧实现里会无限等待的形态验证。
 */
describe('全链路期限（DNS + 连接 + 正文）', () => {
  it('DNS 卡住时也被总期限打断（不会拖穿 resolve 的 20s）', async () => {
    const deps = {
      resolve: () => new Promise<string[]>(() => {}),
      transport: async () => {
        throw new Error('must not be called');
      },
    };
    const started = Date.now();
    await expect(
      safeGet('https://www.bilibili.com/x', deps, {
        allowedHosts: HOSTS,
        perRequestTimeoutMs: 5000,
        deadline: started + 60,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('正文读取卡住时被总期限打断（旧实现已 clearTimeout，正文可无限等）', async () => {
    const deps = {
      resolve: async () => ['93.184.216.34'],
      transport: async () => ({
        status: 200,
        headers: { 'content-type': 'text/html' },
        readBody: () => new Promise<{ text: string; bytes: number; truncated: boolean }>(() => {}),
      }),
    };
    const started = Date.now();
    await expect(
      safeGet('https://www.bilibili.com/x', deps, {
        allowedHosts: HOSTS,
        perRequestTimeoutMs: 5000,
        deadline: started + 60,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('慢重定向链按“总期限”截断，而不是 跳数 × 单跳超时 累加', async () => {
    let hops = 0;
    const deps = {
      resolve: async () => ['93.184.216.34'],
      transport: async () => {
        hops += 1;
        await new Promise((r) => setTimeout(r, 30));
        return {
          status: 302,
          headers: { location: `https://www.bilibili.com/video/BV1xx411c7mD?p=${hops}` },
          readBody: async () => ({ text: '', bytes: 0, truncated: false }),
          discard: () => {},
        };
      },
    };
    const started = Date.now();
    await expect(
      safeGet('https://b23.tv/XyZ123', deps, {
        allowedHosts: HOSTS,
        perRequestTimeoutMs: 5000,
        deadline: started + 70,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(400);
    expect(hops).toBeLessThan(5);
  });

  it('不读正文的分支（重定向/非 2xx）显式 discard，避免连接泄漏', async () => {
    const discarded: number[] = [];
    let step = 0;
    const deps: SafeFetchDeps = {
      resolve: async () => ['93.184.216.34'],
      transport: async (): Promise<TransportResponse> => {
        step += 1;
        if (step === 1) {
          return {
            status: 302,
            headers: { location: 'https://www.bilibili.com/video/BV1xx411c7mD' },
            readBody: async () => ({ text: '', bytes: 0, truncated: false }),
            discard: () => {
              discarded.push(302);
            },
          };
        }
        if (step === 2) {
          return {
            status: 404,
            headers: {},
            readBody: async () => ({ text: 'nope', bytes: 4, truncated: false }),
            discard: () => {
              discarded.push(404);
            },
          };
        }
        throw new Error('unexpected hop');
      },
    };
    await expect(
      safeGet('https://b23.tv/XyZ123', deps, { allowedHosts: HOSTS, perRequestTimeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'CONTENT_NOT_FOUND' });
    expect(discarded).toEqual([302, 404]);
  });

  it('预算充足时整条链路正常完成（deadline 不误杀）', async () => {
    const { deps } = fakeDeps({ 'www.bilibili.com/video/BV1xx411c7mD': { body: 'ok' } });
    const res = await safeGet('https://www.bilibili.com/video/BV1xx411c7mD', deps, {
      allowedHosts: HOSTS,
      deadline: Date.now() + 5000,
    });
    expect(res.text).toBe('ok');
  });

  /**
   * 返工 P1 的组合慢路径：旧实现先给 DNS 一份 hopBudget，DNS 之后再给 transport
   * 一份**完整**的 hopBudget，两段各自合法、加起来越过 absolute deadline。
   * 现在连接阶段的 timer 只拿 DNS 之后的剩余预算，到期 abort（释放底层连接）。
   */
  it('慢 DNS + 慢响应头：连接阶段只用剩余预算，总耗时在 absolute deadline 附近 TIMEOUT', async () => {
    const TOTAL = 400;
    const DNS_MS = 300;
    const started = Date.now();
    let abortedAt = 0;
    let transportCalls = 0;
    const deps: SafeFetchDeps = {
      resolve: async () => {
        await new Promise((r) => setTimeout(r, DNS_MS));
        return ['93.184.216.34'];
      },
      transport: (req) =>
        new Promise<TransportResponse>((_resolve, reject) => {
          transportCalls += 1;
          req.signal.addEventListener('abort', () => {
            abortedAt = Date.now();
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
          // 永远不返回响应头：旧实现会在这里再等满一个 hopBudget（300ms）
        }),
    };

    await expect(
      safeGet('https://www.bilibili.com/x', deps, {
        allowedHosts: HOSTS,
        perRequestTimeoutMs: TOTAL,
        deadline: started + TOTAL,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });

    const elapsed = Date.now() - started;
    expect(transportCalls).toBe(1);
    // 到期真的 abort 了底层连接（不是只 reject 外层 Promise 把 socket 留着）
    expect(abortedAt).toBeGreaterThan(0);
    // 新实现 ≈ DNS(300) + 剩余连接预算(100) = 400ms；旧实现 ≈ 700ms（300 + 完整 400）
    expect(abortedAt - started).toBeLessThan(TOTAL + 120);
    expect(elapsed).toBeLessThan(TOTAL + 120);
    // 也不能提前误杀：必须给到接近 deadline 的时间
    expect(elapsed).toBeGreaterThanOrEqual(TOTAL - 70);
  });

  it('正文到期中止并显式 discard，释放底层连接', async () => {
    const discarded: string[] = [];
    const deps: SafeFetchDeps = {
      resolve: async () => ['93.184.216.34'],
      transport: async (): Promise<TransportResponse> => ({
        status: 200,
        headers: { 'content-type': 'text/html' },
        discard: () => {
          discarded.push('200');
        },
        // 正文永远读不完（慢速滴流的极端形态）
        readBody: () => new Promise<{ text: string; bytes: number; truncated: boolean }>(() => {}),
      }),
    };
    const started = Date.now();
    await expect(
      safeGet('https://www.bilibili.com/x', deps, { allowedHosts: HOSTS, deadline: started + 60 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT', reason: 'body_timeout' });
    expect(discarded).toEqual(['200']);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
