/**
 * main-agent 通用 MCP 中转（worker/main-agent/src/index.js 的 /v1/mcp-relay）。
 *
 * 锁住：
 *   - 本机前缀映射照旧：改写成 127.0.0.1 + 服务端 MCP_SERVERS token 注入，
 *     现场携带的 X-Relay-Target-Authorization 在此路径被忽略；
 *   - 第三方公网 target 原样转发：目标 Authorization 来自携带头翻译，
 *     中转自身的鉴权头（X-Client-Token 等）不向目标透传；
 *   - SSRF：本机/私网/内网后缀/非 http(s) 一律 400 且一次上游都不发；
 *   - 预检放行携带头；缺 target 400。
 *
 * 全部 mock fetch，零真实网络请求。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
// @ts-expect-error main-agent 是纯 JS 单文件，仓库没开 allowJs
import worker from './index.js';

const AGENT = 'https://agent.test';
const RELAY_AUTH_HEADER = 'X-Relay-Target-Authorization';

const stubTarget = (status = 200, body = '{"jsonrpc":"2.0","id":1,"result":{}}') => {
    const calls: Array<{ url: string; init: { method?: string; headers?: Headers } }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; headers?: Headers }) => {
        calls.push({ url: String(url), init });
        return new Response(body, { status, headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-1' } });
    }));
    return calls;
};

const relayRequest = (
    target: string | null,
    opts: { method?: string; headers?: Record<string, string>; env?: Record<string, string> } = {},
) => {
    const url = target === null
        ? `${AGENT}/agent/v1/mcp-relay`
        : `${AGENT}/agent/v1/mcp-relay?target=${encodeURIComponent(target)}`;
    const method = opts.method || 'POST';
    return worker.fetch(
        new Request(url, {
            method,
            headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
            body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
        }),
        opts.env || {},
        { waitUntil: () => {} },
    );
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('/v1/mcp-relay 本机前缀', () => {
    const env = {
        AMSG_CLIENT_TOKEN: 'tok',
        MCP_SERVERS: JSON.stringify([{ name: 'theseus-brain', url: 'http://127.0.0.1:8787/mcp', token: 'srv-secret' }]),
    };

    it('改写成 127.0.0.1 并注入服务端 token，携带头被忽略', async () => {
        const calls = stubTarget();
        const res = await relayRequest('/theseus-brain/mcp', {
            env,
            headers: { 'X-Client-Token': 'tok', [RELAY_AUTH_HEADER]: 'Bearer evil' },
        });
        expect(res.status).toBe(200);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('http://127.0.0.1:8787/mcp');
        expect(calls[0].init.headers?.get('authorization')).toBe('Bearer srv-secret');
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(res.headers.get('Access-Control-Expose-Headers')).toContain('Mcp-Session-Id');
    });
});

describe('/v1/mcp-relay 第三方公网 target', () => {
    const env = { AMSG_CLIENT_TOKEN: 'tok' };

    it('原样转发，目标鉴权来自携带头翻译，中转头不透传', async () => {
        const calls = stubTarget();
        const res = await relayRequest('https://mcp.example.com/mcp', {
            env,
            headers: { 'X-Client-Token': 'tok', [RELAY_AUTH_HEADER]: 'Bearer abc' },
        });
        expect(res.status).toBe(200);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://mcp.example.com/mcp');
        const out = calls[0].init.headers as Headers;
        expect(out.get('authorization')).toBe('Bearer abc');
        expect(out.has('x-client-token')).toBe(false);
        expect(out.has('x-relay-target-authorization')).toBe(false);
        expect(out.has('origin')).toBe(false);
        expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    });

    it('SSRF：一律 400 且一次上游都不发', async () => {
        const calls = stubTarget();
        for (const target of [
            'http://127.0.0.1:9999/evil',
            'http://192.168.1.9/mcp',
            'http://nas.local/mcp',
            'ftp://files.example.com/mcp',
        ]) {
            const res = await relayRequest(target, { env: {} });
            expect(res.status).toBe(400);
        }
        expect(calls).toHaveLength(0);
    });

    it('缺 target → 400 bad_target', async () => {
        const calls = stubTarget();
        const res = await relayRequest(null, { env: {} });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'bad_target' });
        expect(calls).toHaveLength(0);
    });
});

describe('/v1/mcp-relay 预检', () => {
    it('OPTIONS 204 且回显携带头', async () => {
        const res = await worker.fetch(
            new Request(`${AGENT}/agent/v1/mcp-relay?target=https://mcp.example.com/mcp`, {
                method: 'OPTIONS',
                headers: {
                    'Access-Control-Request-Method': 'POST',
                    'Access-Control-Request-Headers': RELAY_AUTH_HEADER,
                },
            }),
            {},
            { waitUntil: () => {} },
        );
        expect(res.status).toBe(204);
        expect((res.headers.get('Access-Control-Allow-Headers') || '').toLowerCase()).toContain(RELAY_AUTH_HEADER.toLowerCase());
    });
});

describe('/v1/models 透传', () => {
    const env = { AMSG_CLIENT_TOKEN: 'tok' };
    const call = (qs: string | null, headers: Record<string, string> = {}) => {
        const calls: Array<{ url: string; init: { headers?: HeadersInit } }> = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers?: HeadersInit }) => {
            calls.push({ url: String(url), init });
            return new Response('{"data":[{"id":"m1"}]}', {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }));
        const url = qs === null
            ? `${AGENT}/agent/v1/models`
            : `${AGENT}/agent/v1/models?target=${encodeURIComponent(qs)}`;
        const res = worker.fetch(new Request(url, { method: 'GET', headers }), env, { waitUntil: () => {} });
        return { res, calls };
    };

    it('无 token → 403（checkAuth 门槛与其他 /v1 端点一致）', async () => {
        const { res, calls } = await call('https://opencode.ai/zen/go/v1/models');
        expect((await res).status).toBe(403);
        expect(calls).toHaveLength(0);
    });

    it('正常透传：上游收到目标 URL + 携带头翻译的 Authorization + 自标识头', async () => {
        const { res, calls } = await call('https://opencode.ai/zen/go/v1/models', {
            'X-Client-Token': 'tok',
            [RELAY_AUTH_HEADER]: 'Bearer sk-test',
        });
        const r = await res;
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ data: [{ id: 'm1' }] });
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://opencode.ai/zen/go/v1/models');
        const out = new Headers(calls[0].init.headers);
        expect(out.get('authorization')).toBe('Bearer sk-test');
        expect(out.get('user-agent')).toContain('SullyOS-MainAgent');
        expect(out.get('x-opencode-session')).toBeTruthy();
    });

    it('SSRF：本机地址 400 且一次上游都不发', async () => {
        const { res, calls } = await call('http://127.0.0.1:9/models', { 'X-Client-Token': 'tok' });
        expect((await res).status).toBe(400);
        expect(calls).toHaveLength(0);
    });

    it('缺 target → 400；非 opencode 上游不带自标识头', async () => {
        const { res, calls } = await call(null, { 'X-Client-Token': 'tok' });
        expect((await res).status).toBe(400);
        const { res: res2, calls: calls2 } = await call('https://api.example.com/v1/models', { 'X-Client-Token': 'tok' });
        expect((await res2).status).toBe(200);
        const out = new Headers(calls2[0].init.headers);
        expect(out.has('user-agent')).toBe(false);
        expect(out.has('x-opencode-session')).toBe(false);
        expect(calls).toHaveLength(0);
    });
});

describe('POST /v1/chat/completions 上游 LLM 自标识', () => {
    const chatBody = () => JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: false });
    const sseOk = 'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const llmEnv = (baseUrl: string) => ({
        LLM_BASE_URL: baseUrl, LLM_API_KEY: 'k', LLM_MODEL: 'm', LLM_TIMEOUT_MS: '5000',
    });
    const callChat = async (env: Record<string, string>) => {
        const calls: Array<{ url: string; init: { headers?: HeadersInit } }> = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers?: HeadersInit }) => {
            calls.push({ url: String(url), init });
            return new Response(sseOk, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }));
        const res = await worker.fetch(
            new Request(`${AGENT}/agent/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: chatBody(),
            }),
            env,
            { waitUntil: () => {} },
        );
        return { res, calls, json: await res.json() as any };
    };

    it('opencode.ai 上游带 UA + x-opencode-session', async () => {
        const { res, calls, json } = await callChat(llmEnv('https://opencode.ai/zen/go/v1'));
        expect(res.status).toBe(200);
        expect(json.choices[0].message.content).toBe('hi');
        expect(calls).toHaveLength(1);
        const out = new Headers(calls[0].init.headers);
        expect(out.get('user-agent')).toContain('SullyOS-MainAgent');
        expect(out.get('x-opencode-session')).toBeTruthy();
    });

    it('同一进程内 session 稳定（缓存亲和），非 opencode 上游不加', async () => {
        const first = await callChat(llmEnv('https://opencode.ai/zen/go/v1'));
        const second = await callChat(llmEnv('https://opencode.ai/zen/go/v1'));
        expect(new Headers(first.calls[0].init.headers).get('x-opencode-session'))
            .toBe(new Headers(second.calls[0].init.headers).get('x-opencode-session'));
        const other = await callChat(llmEnv('https://api.example.com/v1'));
        const out = new Headers(other.calls[0].init.headers);
        expect(out.has('user-agent')).toBe(false);
        expect(out.has('x-opencode-session')).toBe(false);
    });
});

describe('聊天 SSE 心跳（静默期保活）', () => {
    it('上游静默时每 15s 发一行 ": ping"，客户端解析器按 SSE 规范忽略', async () => {
        vi.useFakeTimers();
        try {
            vi.stubGlobal('fetch', vi.fn(async () => new Response(
                new ReadableStream({ start() { /* 永不产出：模拟模型思考/上游静默 */ } }),
                { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
            )));
            const res = await worker.fetch(
                new Request(`${AGENT}/agent/v1/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
                }),
                { LLM_BASE_URL: 'https://opencode.ai/zen/go/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm', LLM_TIMEOUT_MS: '120000' },
                { waitUntil: () => {} },
            );
            expect(res.status).toBe(200);

            const reader = (res.body as ReadableStream).getReader();
            const decoder = new TextDecoder();
            let chunks = '';
            const readUntilPing = (async () => {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) return chunks;
                    chunks += decoder.decode(value, { stream: true });
                    if (chunks.includes(': ping')) return chunks;
                }
            })();
            // 心跳间隔 15s：第一次触发就该有字节流动（上游全程静默也不影响）
            await vi.advanceTimersByTimeAsync(15_000);
            await vi.advanceTimersByTimeAsync(15_000);
            const seen = await readUntilPing;
            expect(seen).toContain(': ping');
            expect(seen).not.toContain('data: [DONE]');
        } finally {
            vi.useRealTimers();
            vi.unstubAllGlobals();
        }
    });
});

describe('上游发完终止事件但不关连接', () => {
    it('主代理在 [DONE]/finish_reason 处收口，不等待上游 socket 关闭', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            new ReadableStream({
                start(controller) {
                    const enc = new TextEncoder();
                    controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"收口"}}]}\n\n'));
                    controller.enqueue(enc.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
                    controller.enqueue(enc.encode('data: [DONE]\n\n'));
                    // 故意不 close：模拟保持连接的代理
                },
            }),
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        )));
        const res = await worker.fetch(
            new Request(`${AGENT}/agent/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
            }),
            { LLM_BASE_URL: 'https://api.example.com/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm', LLM_TIMEOUT_MS: '120000' },
            { waitUntil: () => {} },
        );
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('"content":"收口"');
        expect(text).toContain('data: [DONE]');
    });
});

describe('POST /v1/tts', () => {
    // checkAuth 读 env.AMSG_CLIENT_TOKEN（index.js:61-68）
    const ttsEnv = { AMSG_CLIENT_TOKEN: 'tok' };
    const postTts = (
        body: unknown,
        headers: Record<string, string> = { 'x-client-token': 'tok' },
    ) => worker.fetch(
        new Request(`${AGENT}/agent/v1/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
        }),
        ttsEnv,
        { waitUntil: () => {} },
    );

    it('鉴权失败时拒绝', async () => {
        const res = await postTts({ text: 'hi' }, {});
        expect(res.status).toBe(403);
    });

    it('把 text/demo/seed/帧数组成 multipart 并把 base64 解回 wav', async () => {
        const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]).buffer;
        const audioB64 = Buffer.from(wav).toString('base64');
        const calls: Array<{ url: string; init: any }> = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
            calls.push({ url: String(url), init });
            return new Response(JSON.stringify({ audio_base64: audioB64 }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        }));
        const res = await postTts({ text: '你好', emotion: 'happy' });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('audio/wav');
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        expect(res.headers.get('x-genie-resolved-emotion')).toBeNull();
        expect(calls[0].url).toBe('http://127.0.0.1:18083/api/generate');
        const body = calls[0].init.body as FormData;
        expect(body.get('text')).toBe('你好');
        expect(body.get('demo_id')).toBe('demo-30');
        expect(body.get('seed')).toBe('7');
        expect(body.get('max_new_frames')).toBe('200');
        const out = new Uint8Array(await res.arrayBuffer());
        expect(out[0]).toBe(0x52);
    });

    it.each([
        [400, 502, 'synth_failed'],
        [500, 502, 'synth_failed'],
        [503, 502, 'synth_failed'],
    ])('上游非 200 一律 502 synth_failed（Nano 用 status 表达失败）', async (status, want, code) => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status })));
        const res = await postTts({ text: 'x' });
        expect(res.status).toBe(want);
        expect(await res.json()).toEqual({ error: code });
    });

    it('空文本直接 400 empty，不打上游', async () => {
        const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const res = await postTts({ text: '  ' });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'empty' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('适配层不可达时返回 502 而不是抛异常', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
        const res = await postTts({ text: 'x' });
        expect(res.status).toBe(502);
    });

    it('超长音频被时长守卫拒收（12 秒/6 字）', async () => {
        const big = new Uint8Array(44 + 192000 * 12);
        big.set([0x52, 0x49, 0x46, 0x46], 0);
        new DataView(big.buffer).setUint32(28, 192000, true);
        new DataView(big.buffer).setUint32(40, 192000 * 12, true);
        const audioB64 = Buffer.from(big).toString('base64');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ audio_base64: audioB64 }), { status: 200 })));
        const res = await postTts({ text: '干一行爱一行' });
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: 'synth_failed' });
    });

    it('正常长句放行（6.3 秒/34 字）', async () => {
        const ok = new Uint8Array(44 + Math.floor(192000 * 6.3));
        ok.set([0x52, 0x49, 0x46, 0x46], 0);
        new DataView(ok.buffer).setUint32(28, 192000, true);
        new DataView(ok.buffer).setUint32(40, Math.floor(192000 * 6.3), true);
        const audioB64 = Buffer.from(ok).toString('base64');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ audio_base64: audioB64 }), { status: 200 })));
        const longText = '今天过得怎么样，想不想听我讲讲今天遇到的事？周末要不要一起出去走走？';
        const res = await postTts({ text: longText });
        expect(res.status).toBe(200);
    });
});

