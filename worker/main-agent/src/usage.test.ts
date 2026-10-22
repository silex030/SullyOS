/**
 * main-agent 的 usage 保真（P1-C1/C2/C3）。
 *
 * 锁住：
 *   - 上游请求带 stream_options.include_usage；
 *   - usage 无论同块 / 后块 / [DONE] 之后到达都保留（含缓存读/写数）；
 *   - 逐 loop、逐 attempt 分开记账，末轮与总和不混用；
 *   - 缺失 usage 不写 0（非流式响应干脆不给 usage 字段），尾部有界退出；
 *   - fallback 后被记录的身份是实际 attempt 的 provider/model；
 *   - 内联实现与 utils/llmUsage.ts 同一契约（单文件 verbatim 部署，不能 import）。
 *
 * 全部 mock fetch，零真实网络请求。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
// @ts-expect-error main-agent 是纯 JS 单文件，仓库没开 allowJs
import worker, { normalizeUsageEnvelope, sumUsageEnvelopes } from './index.js';
import { normalizeLlmUsage, sumLlmUsage } from '../../../utils/llmUsage';

const AGENT = 'https://agent.test';
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const timedSse = (steps: Array<{ delay?: number; text?: string }>, opts: { close?: boolean } = {}) => {
    const stats = { cancelled: 0 };
    const response = new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
            for (const step of steps) {
                if (step.delay) await sleep(step.delay);
                try { controller.enqueue(enc.encode(step.text ?? '')); } catch { return; }
            }
            if (opts.close !== false) {
                try { controller.close(); } catch { /* 已关闭 */ }
            }
        },
        cancel() { stats.cancelled++; },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    return { response, stats };
};

interface UpstreamCall { url: string; body: any }

const stubUpstream = (handler: (url: string, callIndex: number) => Response) => {
    const calls: UpstreamCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
        return handler(String(url), calls.length);
    }));
    return calls;
};

const baseEnv = (extra: Record<string, string> = {}) => ({
    AMSG_CLIENT_TOKEN: 'tok',
    LLM_USAGE_TAIL_MS: '60',
    ...extra,
});

const chat = async (env: Record<string, string>, body: any) => {
    const response = await worker.fetch(
        new Request(`${AGENT}/agent/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Client-Token': env.AMSG_CLIENT_TOKEN },
            body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }], ...body }),
        }),
        env,
        { waitUntil: () => {} },
    );
    return response;
};

const sseJson = (text: string) => text
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(payload => payload && payload !== '[DONE]')
    .map(payload => JSON.parse(payload));

const doneEvent = (text: string) => {
    const lines = text.split(/\r?\n/);
    const index = lines.findIndex(line => line.trim() === 'event: done');
    if (index < 0) throw new Error(`没有 done 事件：${text.slice(0, 400)}`);
    const dataLine = lines[index + 1] || '';
    return JSON.parse(dataLine.replace(/^data:\s*/, ''));
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('main-agent 上游请求 usage 能力声明', () => {
    it('请求体带 stream:true + stream_options.include_usage', async () => {
        const calls = stubUpstream(() => timedSse([
            { text: 'data: {"model":"m-1","choices":[{"delta":{"content":"ok"}}]}\n\n' },
            { text: 'data: {"model":"m-1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n' },
            { text: 'data: [DONE]\n\n' },
        ]).response);

        const env = baseEnv();
        await (await chat(env, { stream: false, llm: { baseUrl: 'https://relay.test/v1', model: 'm-1' } })).json();

        expect(calls).toHaveLength(1);
        expect(calls[0].body.stream).toBe(true);
        expect(calls[0].body.stream_options).toEqual({ include_usage: true });
    });
});

describe('main-agent usage 捕获', () => {
    it('usage 与终止块同块：SSE 末尾给出 OpenAI 兼容 usage（含 cached_tokens），统计逐 loop 可追溯', async () => {
        stubUpstream(() => timedSse([
            { text: 'data: {"model":"deepseek-v4.1-flash","choices":[{"delta":{"content":"你好"}}]}\n\n' },
            { text: 'data: {"model":"deepseek-v4.1-flash","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1200,"completion_tokens":80,"total_tokens":1280,"prompt_tokens_details":{"cached_tokens":1024}}}\n\n' },
            { text: 'data: [DONE]\n\n' },
        ]).response);

        const env = baseEnv();
        const response = await chat(env, { llm: { baseUrl: 'https://relay.test/v1', model: 'deepseek-v4.1-flash' } });
        const text = await response.text();
        const chunks = sseJson(text).filter(chunk => chunk.usage);

        expect(chunks.length).toBeGreaterThanOrEqual(1);
        const usageChunk = chunks[chunks.length - 1];
        expect(usageChunk.choices).toEqual([]);
        expect(usageChunk.usage.prompt_tokens).toBe(1200);
        expect(usageChunk.usage.completion_tokens).toBe(80);
        expect(usageChunk.usage.total_tokens).toBe(1280);
        expect(usageChunk.usage.prompt_tokens_details.cached_tokens).toBe(1024);
        // 身份：实际被请求的 model 与响应自报 model 都记
        expect(usageChunk.model).toBe('deepseek-v4.1-flash');

        const done = doneEvent(text);
        expect(done.stats.usage.status).toBe('reported');
        expect(done.stats.usage.totals.cachedTokens).toBe(1024);
        expect(done.stats.usage.last.promptTokens).toBe(1200);
        expect(done.stats.usage.loops).toHaveLength(1);
        expect(done.stats.usage.loops[0].usage.promptTokens).toBe(1200);
        expect(done.stats.usage.loops[0].usageExit).toBe('in-chunk');
        expect(done.stats.identity.providerId).toBe('relay.test');
        expect(done.stats.identity.requestModel).toBe('deepseek-v4.1-flash');
        expect(done.stats.identity.responseModel).toBe('deepseek-v4.1-flash');
        expect(done.stats.identity.modelSource).toBe('request');

        // 下游正文没有被 usage 影响
        expect(chunks.some(chunk => chunk.choices?.length)).toBe(false);
        expect(sseJson(text).filter(chunk => chunk.choices?.[0]?.delta?.content).map(chunk => chunk.choices[0].delta.content).join('')).toBe('你好');
    });

    it('两轮工具循环：每轮各自记账，总数是两轮之和，末轮单列', async () => {
        stubUpstream((_url, callIndex) => {
            if (callIndex === 1) {
                return timedSse([
                    { text: 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"time_now","arguments":"{}"}}]}}]}\n\n' },
                    { text: 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1000,"completion_tokens":10,"total_tokens":1010,"prompt_tokens_details":{"cached_tokens":600}}}\n\n' },
                    { text: 'data: [DONE]\n\n' },
                ]).response;
            }
            return timedSse([
                { text: 'data: {"choices":[{"delta":{"content":"现在三点"}}]}\n\n' },
                { text: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1100,"completion_tokens":20,"total_tokens":1120,"prompt_tokens_details":{"cached_tokens":900}}}\n\n' },
                { text: 'data: [DONE]\n\n' },
            ]).response;
        });

        const env = baseEnv();
        const text = await (await chat(env, { llm: { baseUrl: 'https://relay.test/v1', model: 'm-2' } })).text();
        const done = doneEvent(text);

        expect(done.stats.usage.loops).toHaveLength(2);
        expect(done.stats.usage.loops[0].usage.promptTokens).toBe(1000);
        expect(done.stats.usage.loops[1].usage.promptTokens).toBe(1100);
        expect(done.stats.usage.totals.promptTokens).toBe(2100);
        expect(done.stats.usage.totals.completionTokens).toBe(30);
        expect(done.stats.usage.totals.totalTokens).toBe(2130);
        expect(done.stats.usage.totals.cachedTokens).toBe(1500);
        expect(done.stats.usage.last.promptTokens).toBe(1100);

        const usageChunk = sseJson(text).filter(chunk => chunk.usage).pop();
        expect(usageChunk.usage.prompt_tokens).toBe(2100);
        expect(usageChunk.usage.prompt_tokens_details.cached_tokens).toBe(1500);
    });

    it('[DONE] 之后才到的 usage 也被尾捕（有界），正文不等待', async () => {
        stubUpstream(() => timedSse([
            { text: 'data: {"choices":[{"delta":{"content":"正文"}}]}\n\n' },
            { text: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' },
            { text: 'data: [DONE]\n\n' },
            { delay: 40, text: 'data: {"choices":[],"usage":{"prompt_tokens":700,"completion_tokens":7,"total_tokens":707,"cache_read_input_tokens":500,"cache_creation_input_tokens":60}}\n\n' },
        ], { close: false }).response);

        const env = baseEnv({ LLM_USAGE_TAIL_MS: '400' });
        const startedAt = Date.now();
        const text = await (await chat(env, { llm: { baseUrl: 'https://relay.test/v1', model: 'm-3' } })).text();
        const elapsed = Date.now() - startedAt;
        const done = doneEvent(text);

        expect(done.stats.usage.loops[0].usageExit).toBe('tail');
        expect(done.stats.usage.last.cacheReadTokens).toBe(500);
        expect(done.stats.usage.last.cacheWriteTokens).toBe(60);
        expect(done.stats.usage.last.promptTokens).toBe(700);
        // Anthropic 独占语义：不许算进 prompt 子集
        expect(done.stats.usage.last.cachedTokens).toBeUndefined();
        expect(done.stats.usage.last.cacheReadSemantics).toBe('exclusive-of-prompt');
        expect(elapsed).toBeGreaterThanOrEqual(30);
        expect(elapsed).toBeLessThan(1200);
    });

    it('上游从不给 usage 且不关连接：有界退出，不写 0', async () => {
        stubUpstream(() => timedSse([
            { text: 'data: {"choices":[{"delta":{"content":"没有usage"}}]}\n\n' },
            { text: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' },
        ], { close: false }).response);

        const env = baseEnv({ LLM_USAGE_TAIL_MS: '100' });
        const startedAt = Date.now();
        const text = await (await chat(env, { llm: { baseUrl: 'https://relay.test/v1', model: 'm-4' } })).text();
        const elapsed = Date.now() - startedAt;
        const done = doneEvent(text);

        expect(done.stats.usage.status).toBe('not-reported');
        expect(done.stats.usage.loops[0].usageExit).toBe('timeout');
        expect(done.stats.usage.loops[0].usage.promptTokens).toBeUndefined();
        expect(elapsed).toBeGreaterThanOrEqual(80);
        expect(elapsed).toBeLessThan(1500);
        // 没有 usage 就不发 usage 块（宁可缺，不伪造）
        expect(sseJson(text).some(chunk => chunk.usage)).toBe(false);
    });

    it('非流式响应没有真实 usage 时不给 usage 字段（不再硬编码 0）', async () => {
        stubUpstream(() => timedSse([
            { text: 'data: {"choices":[{"delta":{"content":"回答"}}]}\n\n' },
            { text: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' },
            { text: 'data: [DONE]\n\n' },
        ]).response);

        const env = baseEnv();
        const data = await (await chat(env, { stream: false, llm: { baseUrl: 'https://relay.test/v1', model: 'm-5' } })).json();

        expect(data.choices[0].message.content).toBe('回答');
        expect('usage' in data).toBe(false);
        expect(data._meta.stats.usage.status).toBe('not-reported');
        expect('promptTokens' in data._meta.stats.usage.loops[0].usage).toBe(false);
    });
});

describe('main-agent fallback 身份与用量', () => {
    it('第一个供应商 5xx → 记录失败的 attempt，用量与身份来自真正成功的那次', async () => {
        const calls = stubUpstream((url) => {
            if (url.includes('primary.test')) {
                return new Response('{"error":"upstream down"}', { status: 502, headers: { 'Content-Type': 'application/json' } });
            }
            return timedSse([
                { text: 'data: {"model":"m-backend-real","choices":[{"delta":{"content":"备胎回答"}}]}\n\n' },
                { text: 'data: {"model":"m-backend-real","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":42,"completion_tokens":4,"total_tokens":46}}\n\n' },
                { text: 'data: [DONE]\n\n' },
            ]).response;
        });

        const env = baseEnv();
        const text = await (await chat(env, {
            stream: false,
            llm: {
                baseUrl: 'https://primary.test/v1',
                model: 'm-primary',
                fallbacks: [{ baseUrl: 'https://secondary.test/v1', model: 'm-secondary', apiKey: 'k' }],
            },
        })).json();

        expect(calls).toHaveLength(2);
        expect(calls[1].url).toContain('secondary.test');
        expect(calls[1].body.model).toBe('m-secondary');

        const stats = text._meta.stats;
        expect(stats.attempts).toHaveLength(2);
        expect(stats.attempts[0]).toMatchObject({ ok: false, providerId: 'primary.test', requestModel: 'm-primary' });
        expect(stats.attempts[0].usage.status).toBe('not-reported');
        expect(stats.attempts[1]).toMatchObject({ ok: true, providerId: 'secondary.test', requestModel: 'm-secondary' });
        expect(stats.identity.providerId).toBe('secondary.test');
        expect(stats.identity.requestModel).toBe('m-secondary');
        expect(stats.identity.responseModel).toBe('m-backend-real');
        expect(stats.usage.totals.promptTokens).toBe(42);
        expect(text.model).toBe('m-backend-real');
        expect(text.usage.prompt_tokens).toBe(42);
    });
});

describe('契约对齐：内联实现 ≡ utils/llmUsage', () => {
    const fixtures: Array<[string, unknown]> = [
        ['openai 全量', { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280, prompt_tokens_details: { cached_tokens: 1024 }, completion_tokens_details: { reasoning_tokens: 12 } }],
        ['anthropic', { input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 120 }],
        ['deepseek', { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 640 }],
        ['gemini', { promptTokenCount: 80, candidatesTokenCount: 10, totalTokenCount: 90, cachedContentTokenCount: 60 }],
        ['缺失', undefined],
        ['空对象', {}],
        ['脏值', { prompt_tokens: '5', completion_tokens: -1, total_tokens: Number.NaN }],
        ['真的零', { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } }],
    ];

    it('normalize 输出逐字段一致', () => {
        for (const [label, raw] of fixtures) {
            expect({ label, ...normalizeUsageEnvelope(raw) }).toEqual({ label, ...normalizeLlmUsage(raw) });
        }
    });

    it('求和语义一致（含部分缺失时的 partial）', () => {
        const parts = fixtures.map(([, raw]) => raw);
        const mine = sumUsageEnvelopes(parts.map(raw => normalizeUsageEnvelope(raw)));
        const theirs = sumLlmUsage(parts.map(raw => normalizeLlmUsage(raw)));
        expect(mine).toEqual(theirs);
    });
});
