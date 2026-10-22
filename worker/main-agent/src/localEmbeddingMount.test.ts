/**
 * 本地 embedding 路由的「挂载契约」——锁的是 index.js 这一层，不是 handler 内部。
 *
 * 挂载错了不会报错，只会静默 404，所以这里逐条钉死：
 *   - 只有三个路径命中（/v1/local-embedding、…/embeddings、…/health），
 *     带不带 `/agent` 前缀都行（Caddy 剥前缀 + 裸路径兼容）；
 *   - 全部在 checkAuth 之后：无 token 一律 403，health 也不例外（不做匿名探活）；
 *   - 上游地址与 key 只从 env 取，浏览器传的 Authorization 不会透传；
 *   - 浏览器永远拿不到 LOCAL_EMBEDDING_API_KEY（响应体任何位置都不含它）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error main-agent 是纯 JS 单文件，仓库没开 allowJs
import worker from './index.js';
import { buildEmbeddingFingerprint, LOCAL_GEMMA_PROFILE } from '../../../utils/memoryPalace/localEmbedding';

const AGENT = 'https://agent.test';
const CLIENT_TOKEN = 'client-token-xyz';
const LOCAL_KEY = 'local-embedding-secret-key-abc';
const UPSTREAM = 'http://127.0.0.1:8850';

const ENV = {
    AMSG_CLIENT_TOKEN: CLIENT_TOKEN,
    LOCAL_EMBEDDING_API_KEY: LOCAL_KEY,
    LOCAL_EMBEDDING_URL: UPSTREAM,
    LOCAL_EMBEDDING_MODEL: 'google/embeddinggemma-2',
};

function req(path: string, init: { method?: string; token?: string | null; body?: unknown; auth?: string } = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (init.token !== null) headers['X-Client-Token'] = init.token ?? CLIENT_TOKEN;
    if (init.auth) headers.Authorization = init.auth;
    const method = init.method || 'GET';
    return worker.fetch(
        new Request(`${AGENT}${path}`, {
            method,
            headers,
            body: method === 'POST' ? JSON.stringify(init.body ?? { input: '你好' }) : undefined,
        }),
        ENV,
        { waitUntil: () => {} },
    );
}

function stubUpstream(dims = 768) {
    const calls: Array<{ url: string; headers: Headers; body: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
        calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(init?.body || '{}') });
        return new Response(JSON.stringify({
            object: 'list',
            data: [{ object: 'embedding', index: 0, embedding: new Array(dims).fill(0.1) }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    return calls;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('main-agent 挂载 /v1/local-embedding（精确 3 路径 + 继承鉴权）', () => {
    it('health（带 /agent 前缀）需要 token，且响应里不含本地服务 key', async () => {
        const okRes = await req('/agent/v1/local-embedding/health');
        expect(okRes.status).toBe(200);
        const okBody = await okRes.json() as any;
        expect(okBody.ok).toBe(true);
        expect(okBody.configured).toBe(true);
        expect(okBody.dimensions).toBe(768);

        const raw = JSON.stringify(okBody);
        expect(raw.includes(LOCAL_KEY)).toBe(false);

        const noToken = await req('/v1/local-embedding/health', { token: null });
        expect(noToken.status).toBe(403);
    });

    it('health 是轻量的：不打上游推理', async () => {
        const calls = stubUpstream();
        const res = await req('/agent/v1/local-embedding/health');
        expect(res.status).toBe(200);
        expect(calls).toHaveLength(0);
    });

    it('health 不回显上游内网地址，只给模型/维度/指纹/configured', async () => {
        const res = await req('/agent/v1/local-embedding/health');
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        const raw = JSON.stringify(body);
        // 内网拓扑不外泄：host/port/scheme 任何形态都不该出现
        expect('upstream' in body).toBe(false);
        expect(raw).not.toContain('127.0.0.1');
        expect(raw).not.toContain('8850');
        expect(raw).not.toContain('http://');
        expect(raw).not.toContain('https://');
        // 安全身份字段保留，且与前端指纹逐字一致（两端同一函数口径）
        expect(body.model).toBe('google/embeddinggemma-2');
        expect(body.dimensions).toBe(768);
        expect(body.configured).toBe(true);
        expect(body.fingerprint).toBe(buildEmbeddingFingerprint({
            baseUrl: 'http://127.0.0.1:8850/v1',
            apiKey: 'dummy-not-used-for-fingerprint',
            provider: 'local-gemma',
            model: 'google/embeddinggemma-2',
            modelRevision: LOCAL_GEMMA_PROFILE.revision,
            prefixScheme: LOCAL_GEMMA_PROFILE.prefixScheme,
            dimensions: 768,
        }));
    });

    it('health 未配置 key 时 configured=false，仍不回显上游地址', async () => {
        const res = await worker.fetch(
            new Request(`${AGENT}/v1/local-embedding/health`, {
                method: 'GET',
                headers: { 'X-Client-Token': CLIENT_TOKEN },
            }),
            { ...ENV, LOCAL_EMBEDDING_API_KEY: '' },
            { waitUntil: () => {} },
        );
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.configured).toBe(false);
        expect(JSON.stringify(body)).not.toContain('127.0.0.1');
    });

    it('POST /embeddings 转发到 env 指定的上游，并返回 fingerprint', async () => {
        const calls = stubUpstream();
        const res = await req('/agent/v1/local-embedding/embeddings', {
            method: 'POST',
            auth: 'Bearer browser-supplied-token-should-not-be-forwarded',
            body: { input: ['查询文本'], task: 'query' },
        });
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.fingerprint).toContain('model:google/embeddinggemma-2');
        expect(body.dimensions).toBe(768);
        expect(body.task).toBe('query');
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(`${UPSTREAM}/v1/embeddings`);
        // 上游只认服务端 key；浏览器带进来的 Authorization 不得透传
        expect(calls[0].headers.get('authorization')).not.toContain('browser-supplied');
        expect(calls[0].body.task).toBe('query');
    });

    it('路由返回的 fingerprint 与前端 buildEmbeddingFingerprint 逐字一致', async () => {
        // 不一致的后果不是报错，而是「检索永远跳过全部向量」——静默变哑巴。
        stubUpstream();
        const res = await req('/agent/v1/local-embedding/embeddings', { method: 'POST', body: { input: 'x' } });
        const body = await res.json() as any;
        const clientSide = buildEmbeddingFingerprint({
            baseUrl: 'https://agent.test/agent/v1/local-embedding',
            apiKey: 'agent-token',
            model: LOCAL_GEMMA_PROFILE.model,
            dimensions: LOCAL_GEMMA_PROFILE.dimensions,
            provider: 'local-gemma',
            prefixScheme: LOCAL_GEMMA_PROFILE.prefixScheme,
        });
        expect(body.fingerprint).toBe(clientSide);
    });

    it('POST /v1/local-embedding（不带 /embeddings 后缀）同样可用', async () => {
        stubUpstream();
        const res = await req('/agent/v1/local-embedding', { method: 'POST' });
        expect(res.status).toBe(200);
    });

    it('无 token 的 POST 直接 403，且一次上游都不打', async () => {
        const calls = stubUpstream();
        const res = await req('/agent/v1/local-embedding/embeddings', { method: 'POST', token: null });
        expect(res.status).toBe(403);
        expect(calls).toHaveLength(0);
    });

    it('三个路径之外的子路径不挂载（404，不能变成万能代理）', async () => {
        stubUpstream();
        const res = await req('/agent/v1/local-embedding/anything-else', { method: 'POST' });
        expect(res.status).toBe(404);
    });

    it('不允许浏览器自定义上游地址（body 里的 url 被忽略）', async () => {
        const calls = stubUpstream();
        const res = await req('/agent/v1/local-embedding/embeddings', {
            method: 'POST',
            body: { input: ['x'], url: 'http://169.254.169.254/latest/meta-data', baseUrl: 'http://evil.example' },
        });
        expect(res.status).toBe(200);
        expect(calls[0].url).toBe(`${UPSTREAM}/v1/embeddings`);
    });
});
