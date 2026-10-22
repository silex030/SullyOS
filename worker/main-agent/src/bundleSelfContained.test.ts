/**
 * 入库的 `worker/main-agent/worker.bundle.js` 必须能在 **data: URL** 下加载。
 *
 * 这不是理论洁癖：VPS 的加载器 `vps-backend/src/shim/bundle-loader.js` 会把整份源码
 * base64 成 `data:text/javascript;base64,…` 再 `import()`。data: URL 没有 base，
 * bundle 里**任何相对 import** 都会 `ERR_UNSUPPORTED_RESOLVE_REQUEST` ——
 * 2026-10-23 发布轮实测过：`import './local-embedding-route.js'` 让线上 8830 起不来，
 * Caddy 全 502，而所有源码级单测（直接 import src/index.js）全绿。
 *
 * 所以这里用子进程按 VPS 的方式加载**入库产物**，锁住两件事：
 *   1. 产物自包含（没有相对 import）；
 *   2. 加载后 local-embedding 三条路由仍然通（health 200、无 token 403）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const BUNDLE = path.resolve(__dirname, '../worker.bundle.js');

function runInDataUrl(body: string): string {
    const script = `
const { readFileSync } = require('node:fs');
(async () => {
  const src = readFileSync(${JSON.stringify(BUNDLE)}, 'utf8');
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
  const worker = mod.default;
  const env = {
    AMSG_CLIENT_TOKEN: 'bundle-probe-token',
    LOCAL_EMBEDDING_API_KEY: 'bundle-probe-key',
    LOCAL_EMBEDDING_URL: 'http://127.0.0.1:8850',
    LOCAL_EMBEDDING_MODEL: 'google/embeddinggemma-2',
  };
  ${body}
})().catch((e) => { console.error('LOAD_FAIL: ' + e.message); process.exit(3); });
`;
    return execFileSync(process.execPath, ['--input-type=commonjs', '-e', script], {
        encoding: 'utf8',
        timeout: 30000,
    });
}

describe('入库 main-agent bundle 可在 data: URL 下加载（VPS 加载器同构）', () => {
    it('产物里没有真实的相对 import（注释里的示例不算）', () => {
        const src = readFileSync(BUNDLE, 'utf8');
        const code = src
            .split('\n')
            .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
            .join('\n');
        expect(code).not.toMatch(/^\s*import\s[^\n]*from\s+['"]\.{1,2}\//m);
        expect(code).not.toMatch(/^\s*export\s+.*\s+from\s+['"]/m);
        expect(code).toContain('handleLocalEmbedding');
    });

    it('data: URL 加载后 health 200、不泄露上游地址、无 token 403', () => {
        const out = runInDataUrl(`
  const withTok = await worker.fetch(new Request('https://agent.test/agent/v1/local-embedding/health', {
    headers: { 'X-Client-Token': 'bundle-probe-token' },
  }), env, { waitUntil() {} });
  const body = await withTok.text();
  const noTok = await worker.fetch(new Request('https://agent.test/agent/v1/local-embedding/health'), env, { waitUntil() {} });
  const plain = await worker.fetch(new Request('https://agent.test/agent/health'), env, { waitUntil() {} });
  console.log(JSON.stringify({ healthStatus: withTok.status, body, noTokenStatus: noTok.status, agentHealth: plain.status }));
`);
        const parsed = JSON.parse(out.trim().split('\n').pop() as string);
        expect(parsed.healthStatus).toBe(200);
        expect(parsed.noTokenStatus).toBe(403);
        expect(parsed.agentHealth).toBe(200);
        expect(parsed.body).toContain('"dimensions":768');
        expect(parsed.body).not.toContain('127.0.0.1');
        expect(parsed.body).not.toContain('http');
    });
});
