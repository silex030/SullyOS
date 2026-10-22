/**
 * 主代理内的本地 embedding 路由（独立 handler，挂载由集成代理完成）。
 *
 * 这层是浏览器唯一能碰到的入口，因此这里锁死四件事：
 *   1. 鉴权走主代理现有的 client token（fail-closed），本地服务 key 只存在于 worker env。
 *   2. 输入校验在上游之前：批量条数 / 单条长度 / body 体积 / task 白名单 / 模型白名单。
 *   3. 任务前缀只由上游按 task 加一次；客户端带来的前缀在这里再剥一次，杜绝双前缀。
 *   4. 超时 / 取消 / 排队上限都有明确状态码，上游错误不回显原文（避免把凭据或内部地址带回浏览器）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error 主代理是纯 JS，仓库没开 allowJs
import { createLocalEmbeddingHandler } from './main-agent/src/local-embedding-route.js';

const BASE = 'https://agent.example';
const TOKEN = 'agent-client-token-for-test';

function env(overrides: Record<string, string | undefined> = {}) {
    return {
        AMSG_CLIENT_TOKEN: TOKEN,
        LOCAL_EMBEDDING_API_KEY: 'server-side-secret',
        LOCAL_EMBEDDING_URL: 'http://127.0.0.1:8850',
        ...overrides,
    };
}

function post(body: unknown, opts: { token?: string | null; path?: string } = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.token !== null) headers['X-Client-Token'] = opts.token ?? TOKEN;
    return new Request(`${BASE}/agent/v1/local-embedding${opts.path ?? ''}`, {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

function okUpstream(dims = 768) {
    return vi.fn(async (_url: string, init: any) => {
        const body = JSON.parse(init.body);
        return new Response(JSON.stringify({
            object: 'list',
            model: body.model,
            dimensions: dims,
            data: body.input.map((_t: string, i: number) => ({
                object: 'embedding',
                index: i,
                embedding: new Array(dims).fill(0).map((_, k) => (k === i ? 1 : 0)),
            })),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
}

let fetchSpy: any;
function useFetch(impl: any) {
    fetchSpy = vi.fn(impl);
    (globalThis as any).fetch = fetchSpy;
    return fetchSpy;
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('路由形状与鉴权', () => {
    it('未知路径 404，GET 打 embeddings 405，GET health 不碰上游', async () => {
        useFetch(okUpstream());
        const handler = createLocalEmbeddingHandler();
        const e = env();

        const notFound = await handler(new Request(`${BASE}/agent/v1/local-embedding/garbage`), e);
        expect(notFound.status).toBe(404);

        const wrongMethod = await handler(new Request(`${BASE}/agent/v1/local-embedding`, {
            method: 'GET',
            headers: { 'X-Client-Token': TOKEN },
        }), e);
        expect(wrongMethod.status).toBe(405);

        // 健康检查同样走既有 client token（不新增匿名端点）
        const health = await handler(new Request(`${BASE}/agent/v1/local-embedding/health`, {
            headers: { 'X-Client-Token': TOKEN },
        }), e);
        expect(health.status).toBe(200);
        const payload = await health.json();
        expect(payload.ok).toBe(true);
        expect(payload.dimensions).toBe(768);
        expect(payload.configured).toBe(true);
        // 安全字段保留，但绝不回显上游内网地址
        expect(String(payload.fingerprint)).toContain('provider:local-gemma');
        expect(payload.upstream).toBeUndefined();
        expect(JSON.stringify(payload)).not.toContain('127.0.0.1');
        expect(JSON.stringify(payload)).not.toContain('http');
        // 健康检查本身不能变成一次推理（旧服务 /health 内部跑 encode 就是算力放大器）
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('没配 client token ⇒ fail-closed 403；token 错 403；token 对放行', async () => {
        useFetch(okUpstream());
        const handler = createLocalEmbeddingHandler();

        const noTokenConfigured = await handler(post({ input: ['x'] }), env({ AMSG_CLIENT_TOKEN: undefined }));
        expect(noTokenConfigured.status).toBe(403);

        const badToken = await handler(post({ input: ['x'] }, { token: 'wrong' }), env());
        expect(badToken.status).toBe(403);

        const noHeader = await handler(post({ input: ['x'] }, { token: null }), env());
        expect(noHeader.status).toBe(403);

        const ok = await handler(post({ input: ['x'] }), env());
        expect(ok.status).toBe(200);
    });

    it('可注入 authorize（父代理复用自身 checkAuth，避免两套鉴权漂移）', async () => {
        useFetch(okUpstream());
        const authorize = vi.fn(() => new Response(JSON.stringify({ error: 'nope' }), { status: 401 }));
        const handler = createLocalEmbeddingHandler({ authorize });
        const res = await handler(post({ input: ['x'] }), env());
        expect(res.status).toBe(401);
        expect(authorize).toHaveBeenCalledTimes(1);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

describe('输入校验（全部在上游之前）', () => {
    async function expectReject(body: unknown, status: number, code: string) {
        const f = useFetch(okUpstream());
        const handler = createLocalEmbeddingHandler();
        const res = await handler(post(body), env());
        expect(res.status).toBe(status);
        const payload = await res.json();
        expect(payload.error).toBe(code);
        expect(f).not.toHaveBeenCalled();
    }

    it('非法 JSON / task 白名单 / dimensions 不支持 / 模型不在白名单', async () => {
        await expectReject('{not json', 400, 'invalid_json');
        await expectReject({ input: ['x'], task: 'passage' }, 400, 'invalid_task');
        await expectReject({ input: ['x'], dimensions: 512 }, 400, 'dimensions_not_supported');
        await expectReject({ input: ['x'], model: 'BAAI/bge-m3' }, 400, 'model_not_allowed');
        await expectReject({ input: [] }, 400, 'invalid_input');
        await expectReject({ input: [123] }, 400, 'invalid_input');
    });

    it('批量条数上限 / 单条字符上限 / body 体积上限', async () => {
        const handlerCfg = { maxBatch: 4, maxItemChars: 32, maxBodyBytes: 512 };
        const f = useFetch(okUpstream());

        const handler = createLocalEmbeddingHandler(handlerCfg);
        const tooMany = await handler(post({ input: ['a', 'b', 'c', 'd', 'e'] }), env());
        expect(tooMany.status).toBe(413);
        expect((await tooMany.json()).error).toBe('payload_too_large');

        const tooLong = await handler(post({ input: ['y'.repeat(33)] }), env());
        expect(tooLong.status).toBe(413);

        const tooBig = await handler(post({ input: ['z'.repeat(600)] }), env());
        expect(tooBig.status).toBe(413);
        expect(f).not.toHaveBeenCalled();
    });

    it('服务端 key 未配置 ⇒ 503，且不发起上游请求', async () => {
        const f = useFetch(okUpstream());
        const handler = createLocalEmbeddingHandler();
        const res = await handler(post({ input: ['x'] }), env({ LOCAL_EMBEDDING_API_KEY: undefined }));
        expect(res.status).toBe(503);
        expect((await res.json()).error).toBe('local_embedding_unconfigured');
        expect(f).not.toHaveBeenCalled();
    });
});

describe('转发语义：task / 前缀 / key 不外泄', () => {
    it('task 透传、前缀只加一次、上游 Authorization 用服务端 key、响应不回显 key', async () => {
        const f = useFetch(okUpstream());
        const handler = createLocalEmbeddingHandler();
        const res = await handler(
            post({ input: ['task: search result | query: 合成探针文本'], task: 'query' }),
            env(),
        );

        expect(res.status).toBe(200);
        const [url, init] = f.mock.calls[0];
        expect(url).toBe('http://127.0.0.1:8850/v1/embeddings');
        const upstreamBody = JSON.parse(init.body);
        expect(upstreamBody.task).toBe('query');
        expect(upstreamBody.input).toEqual(['合成探针文本']);
        expect('dimensions' in upstreamBody).toBe(false);
        expect(init.headers.Authorization).toBe('Bearer server-side-secret');
        // 浏览器侧的 client token 绝不能作为上游凭据
        expect(init.headers.Authorization).not.toContain(TOKEN);

        const text = await res.text();
        expect(text).not.toContain('server-side-secret');
        const payload = JSON.parse(text);
        expect(payload.dimensions).toBe(768);
        expect(payload.fingerprint).toContain('google/embeddinggemma-2');
        expect(payload.fingerprint).toContain('dim:768');
        expect(payload.data).toHaveLength(1);
        expect(payload.data[0].embedding).toHaveLength(768);
        expect(res.headers.get('Cache-Control')).toContain('no-store');
        expect(res.headers.get('Access-Control-Allow-Origin')).toBeTruthy();
    });

    it('缺省 task=document（与服务端默认一致，但由本层显式下发）', async () => {
        const f = useFetch(okUpstream());
        const handler = createLocalEmbeddingHandler();
        await handler(post({ input: ['普通文本'] }), env());
        expect(JSON.parse(f.mock.calls[0][1].body).task).toBe('document');
    });
});

describe('上游故障分类（可预测降级）', () => {
    it('上游 401 ⇒ 502 upstream_auth_failed，不回显上游原文', async () => {
        useFetch(async () => new Response('invalid api key local-secret=abc', { status: 401 }));
        const handler = createLocalEmbeddingHandler();
        const res = await handler(post({ input: ['x'] }), env());
        expect(res.status).toBe(502);
        const text = await res.text();
        expect(JSON.parse(text).error).toBe('upstream_auth_failed');
        expect(text).not.toContain('local-secret');
    });

    it('上游 5xx ⇒ 502 upstream_error；连不上 ⇒ 503 upstream_unavailable', async () => {
        useFetch(async () => new Response('boom', { status: 500 }));
        let res = await createLocalEmbeddingHandler()(post({ input: ['x'] }), env());
        expect(res.status).toBe(502);
        expect((await res.json()).error).toBe('upstream_error');

        useFetch(async () => { throw new TypeError('fetch failed'); });
        res = await createLocalEmbeddingHandler()(post({ input: ['x'] }), env());
        expect(res.status).toBe(503);
        expect((await res.json()).error).toBe('upstream_unavailable');
    });

    it('上游返回条数/维度不符 ⇒ 502 upstream_bad_response（绝不写坏索引）', async () => {
        useFetch(async () => new Response(JSON.stringify({
            data: [{ index: 0, embedding: new Array(1024).fill(0.1) }],
        }), { status: 200 }));
        const res = await createLocalEmbeddingHandler()(post({ input: ['x'] }), env());
        expect(res.status).toBe(502);
        expect((await res.json()).error).toBe('upstream_bad_response');

        useFetch(async () => new Response(JSON.stringify({
            data: [{ index: 0, embedding: new Array(768).fill(0.1) }],
        }), { status: 200 }));
        const res2 = await createLocalEmbeddingHandler()(post({ input: ['a', 'b'] }), env());
        expect(res2.status).toBe(502);
        expect((await res2.json()).error).toBe('upstream_bad_response');
    });

    it('上游超时 ⇒ 504 upstream_timeout', async () => {
        useFetch((_url: string, init: any) => new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }));
        const handler = createLocalEmbeddingHandler({ timeoutMs: 20 });
        const res = await handler(post({ input: ['x'] }), env());
        expect(res.status).toBe(504);
        expect((await res.json()).error).toBe('upstream_timeout');
    });

    it('客户端中断 ⇒ 499 client_cancelled 且上游请求被 abort', async () => {
        let aborted = false;
        useFetch((_url: string, init: any) => new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
        }));
        const ac = new AbortController();
        const req = new Request(`${BASE}/agent/v1/local-embedding`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Client-Token': TOKEN },
            body: JSON.stringify({ input: ['x'] }),
            signal: ac.signal,
        });
        const handler = createLocalEmbeddingHandler();
        const p = handler(req, env());
        // 等请求真正进到上游（body 读取 + 排队是异步的），再模拟用户中断
        await new Promise(r => setTimeout(r, 10));
        ac.abort();
        const res = await p;
        expect(res.status).toBe(499);
        expect((await res.json()).error).toBe('client_cancelled');
        expect(aborted).toBe(true);
    });
});

describe('并发闸门：上游是 Semaphore(1)，这里不能把它压成无界队列', () => {
    it('并发请求串行化，同时在途上游请求 ≤ 1', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        let release: (() => void) | null = null;
        const gate = new Promise<void>(r => { release = r; });
        const f = useFetch(async (_url: string, init: any) => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await gate;
            inFlight--;
            const body = JSON.parse(init.body);
            return new Response(JSON.stringify({
                data: body.input.map((_t: string, i: number) => ({ index: i, embedding: new Array(768).fill(0.1) })),
            }), { status: 200 });
        });
        const handler = createLocalEmbeddingHandler();
        const p1 = handler(post({ input: ['a'] }), env());
        const p2 = handler(post({ input: ['b'] }), env());

        await new Promise(r => setTimeout(r, 20));
        expect(f).toHaveBeenCalledTimes(1); // 第二个还在排队，没有同时打上游

        release!();
        const [r1, r2] = await Promise.all([p1, p2]);
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        expect(f).toHaveBeenCalledTimes(2);
        expect(maxInFlight).toBe(1);
    });

    it('排队超上限 ⇒ 429 queue_full', async () => {
        useFetch((_url: string, init: any) => new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }));
        const handler = createLocalEmbeddingHandler({ maxQueue: 1, timeoutMs: 60 });
        const p1 = handler(post({ input: ['a'] }), env());
        const p2 = handler(post({ input: ['b'] }), env());
        const r3 = await handler(post({ input: ['c'] }), env());
        expect(r3.status).toBe(429);
        expect((await r3.json()).error).toBe('queue_full');
        await p1;
        await p2;
    });
});
