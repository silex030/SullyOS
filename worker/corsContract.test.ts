import { describe, expect, it } from 'vitest';
// @ts-expect-error 本地代理脚本无类型声明，仓库没开 allowJs（同 worker/*/worker.test.ts 惯例）
import { corsHeadersFor as mcpProxyCors } from '../scripts/mcp-proxy.mjs';
// @ts-expect-error 同上
import { corsHeadersFor as xhsBridgeCors } from '../scripts/xhs-bridge.mjs';

export interface CorsTestableHandler {
  fetch(request: Request, env?: any, ctx?: any): Promise<Response>;
}

export function assertCorsContract(
  name: string,
  load: () => Promise<{ default: CorsTestableHandler }> | { default: CorsTestableHandler },
  opts: { expose?: string; env?: any } = {},
) {
  describe(`CORS contract: ${name}`, () => {
    const run = async (headers: Record<string, string>, url = 'https://probe.invalid/any/path') => {
      const mod = await load();
      return mod.default.fetch(
        new Request(url, { method: 'OPTIONS', headers: { Origin: 'https://sully.test', ...headers } }),
        opts.env ?? {},
        { waitUntil() {} },
      );
    };

    it('echoes arbitrary custom request headers', async () => {
      const res = await run({
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-future-feature, x-another-header',
      });
      expect(res.status).toBe(204);
      const allow = (res.headers.get('Access-Control-Allow-Headers') || '').toLowerCase();
      expect(allow).toContain('x-future-feature');
      expect(allow).toContain('x-another-header');
      expect(res.headers.get('Access-Control-Allow-Methods') || '').toContain('POST');
      const acao = res.headers.get('Access-Control-Allow-Origin');
      expect(acao === '*' || acao === 'https://sully.test').toBe(true);
      expect(res.headers.get('Access-Control-Max-Age')).toBeTruthy();
      if (opts.expose) expect(res.headers.get('Access-Control-Expose-Headers') || '').toContain(opts.expose);
    });

    it('echoes arbitrary method and drops malformed ones', async () => {
      const ok = await run({ 'Access-Control-Request-Method': 'PROPFIND' });
      expect(ok.headers.get('Access-Control-Allow-Methods') || '').toContain('PROPFIND');
      const bad = await run({ 'Access-Control-Request-Method': 'POST; DROP' });
      expect(bad.headers.get('Access-Control-Allow-Methods') || '').not.toContain('DROP');
    });

    it('drops malformed request headers but keeps base list', async () => {
      const res = await run({
        'Access-Control-Request-Headers': 'x-ok-header, bad header!, ' + 'a'.repeat(80),
      });
      const allow = res.headers.get('Access-Control-Allow-Headers') || '';
      expect(allow.toLowerCase()).toContain('x-ok-header');
      expect(allow).not.toContain('bad header!');
      expect(allow).not.toContain('a'.repeat(80));
      expect(allow).toContain('Content-Type');
    });

    it('answers preflight without auth', async () => {
      const res = await run({ 'Access-Control-Request-Method': 'GET' });
      expect(res.status).toBe(204);
    });
  });
}

// 中心 worker
// @ts-expect-error 纯 JS worker 无类型声明
assertCorsContract('center worker/index.js', async () => (await import('./index.js')) as any, {
  expose: 'Mcp-Session-Id',
});

// amsg（入口统一预检）
assertCorsContract('amsg worker', async () => (await import('./amsg/src/index.ts')) as any, {});

// instant-push（入口统一预检；gzip 上行头 X-Amsg-Request-Encoding 随回显放行）
assertCorsContract('instant-push worker', async () => (await import('./instant-push/src/index.ts')) as any, {});

// main-agent（VPS 主代理；mcp-relay 携带头 X-Relay-Target-Authorization 随回显放行）
// @ts-expect-error 纯 JS worker 无类型声明
assertCorsContract('main-agent worker', async () => (await import('./main-agent/src/index.js')) as any, {});

// mcp-proxy（用户自部署 CF；Expose Mcp-Session-Id）
// @ts-expect-error 纯 JS worker 无类型声明
assertCorsContract('mcp-proxy worker', async () => (await import('./mcp-proxy/worker.js')) as any, {
  expose: 'Mcp-Session-Id',
});

// post-office（esbuild worker）
assertCorsContract('post-office worker', async () => (await import('./post-office/src/index.ts')) as any, {});

// proactive-push（esbuild worker）
assertCorsContract('proactive-push worker', async () => (await import('./proactive-push/src/index.ts')) as any, {});

// heartbeat（VPS 单文件）
// @ts-expect-error 纯 JS worker 无类型声明
assertCorsContract('heartbeat worker', async () => (await import('./heartbeat/src/index.js')) as any, {});

// wake-bridge（VPS 单文件）
// @ts-expect-error 纯 JS worker 无类型声明
assertCorsContract('wake-bridge worker', async () => (await import('./wake-bridge/src/index.js')) as any, {});

// scripts/ 本地代理：export 的纯函数（Node IncomingMessage 形态）
describe('CORS contract: local proxy scripts', () => {
  const fakeReq = (headers: Record<string, string>) => ({ headers }) as any;
  const assertScriptContract = (corsHeadersFor: (req: any) => Record<string, string>, expose?: string) => {
    const headers = corsHeadersFor(fakeReq({
      'access-control-request-headers': 'x-future-feature, bad header!',
      'access-control-request-method': 'POST',
    }));
    const allow = String(headers['Access-Control-Allow-Headers'] || '').toLowerCase();
    expect(allow).toContain('x-future-feature');
    expect(allow).not.toContain('bad header!');
    expect(String(headers['Access-Control-Allow-Methods'] || '')).toContain('POST');
    expect(headers['Access-Control-Allow-Origin']).toBe('*');
    expect(String(headers['Access-Control-Max-Age'])).toBe('86400');
    if (expose) expect(String(headers['Access-Control-Expose-Headers'] || '')).toContain(expose);
  };

  it('mcp-proxy 脚本', () => assertScriptContract(mcpProxyCors, 'Mcp-Session-Id'));
  it('xhs-bridge 脚本', () => assertScriptContract(xhsBridgeCors));
});
