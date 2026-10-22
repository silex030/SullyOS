import { describe, it, expect, vi, afterEach } from 'vitest';
import { DB } from './db';
import {
    buildApiCallLogEntry,
    extractApiTokenUsage,
    extractLlmUsage,
    recordApiCall,
    settleCloudApiCall,
    updateApiRequestCaptureUsage,
} from './apiCallLog';

// P1-C2：API 调用记录保留 usage 保真字段。
// 锁住：
//   - 普通字段向后兼容（prompt/completion/total 原样）；
//   - 缓存读/写数值可选保留，缺失时键不存在（不是 0）；
//   - usage 是否完整/缺失可辨（usageStatus），并保留缺了哪些字段的名字；
//   - 云端回程补写（settleCloudApiCall）也能带缓存数。

const chatUrl = 'https://relay.test/v1/chat/completions';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('extractApiTokenUsage · 缓存字段保真', () => {
    it('OpenAI 嵌套 cached_tokens 与总字段都保留', () => {
        const usage = extractApiTokenUsage({
            usage: {
                prompt_tokens: 1200,
                completion_tokens: 80,
                total_tokens: 1280,
                prompt_tokens_details: { cached_tokens: 1024 },
                completion_tokens_details: { reasoning_tokens: 12 },
            },
        });
        expect(usage.prompt).toBe(1200);
        expect(usage.completion).toBe(80);
        expect(usage.total).toBe(1280);
        expect(usage.cached).toBe(1024);
        expect(usage.reasoning).toBe(12);
        expect(extractLlmUsage({ usage: { prompt_tokens: 1200, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 1024 } } }).status).toBe('reported');
    });

    it('Anthropic 风格 cache_read_input_tokens / cache_creation_input_tokens 不丢也不混', () => {
        const usage = extractApiTokenUsage({
            usage: {
                input_tokens: 300,
                output_tokens: 40,
                cache_read_input_tokens: 900,
                cache_creation_input_tokens: 120,
            },
        });
        expect(usage.prompt).toBe(300);
        expect(usage.cached).toBeUndefined();
        expect(usage.cacheRead).toBe(900);
        expect(usage.cacheWrite).toBe(120);
        expect(extractLlmUsage({ usage: { input_tokens: 300, cache_read_input_tokens: 900 } }).cacheReadSemantics).toBe('exclusive-of-prompt');
    });

    it('usage 缺失 → 全部 undefined，不写 0', () => {
        const usage = extractApiTokenUsage({ choices: [] });
        expect(usage.prompt).toBeUndefined();
        expect(usage.completion).toBeUndefined();
        expect(usage.total).toBeUndefined();
        expect(usage.cached).toBeUndefined();
        const envelope = extractLlmUsage({ choices: [] });
        expect(envelope.status).toBe('not-reported');
        expect(envelope.usagePresent).toBe(false);
    });
});

describe('buildApiCallLogEntry', () => {
    it('缓存字段可选保留，缺失即无键；识别结果与缺失名单一起落库', () => {
        const entry = buildApiCallLogEntry({
            requestId: 'req-1',
            url: chatUrl,
            body: JSON.stringify({ model: 'deepseek-v4.1-flash' }),
            status: 200,
            ok: true,
            response: {
                model: 'deepseek-v4.1-flash-actual',
                usage: {
                    prompt_tokens: 2000,
                    completion_tokens: 100,
                    total_tokens: 2100,
                    prompt_tokens_details: { cached_tokens: 1500 },
                },
            },
            durationMs: 4321,
            headersMs: 210,
            firstDeltaMs: 640,
        });

        expect(entry.id).toBe('req-1');
        expect(entry.model).toBe('deepseek-v4.1-flash');
        expect(entry.backendModel).toBe('deepseek-v4.1-flash-actual');
        expect(entry.promptTokens).toBe(2000);
        expect(entry.cachedTokens).toBe(1500);
        expect(entry.usageStatus).toBe('reported');
        expect(entry.usageMissing).toEqual(expect.arrayContaining(['cacheReadTokens', 'cacheWriteTokens']));
        expect(entry.headersMs).toBe(210);
        expect(entry.firstDeltaMs).toBe(640);
        expect(entry.durationMs).toBe(4321);
        // 缓存写数没到 → 键不存在（不是 0）
        expect('cacheWriteTokens' in entry).toBe(false);
    });

    it('流式文本响应走 SSE 兜底：末块 usage 的缓存字段也保真', () => {
        const sse = [
            'data: {"model":"kimi-k2","choices":[{"delta":{"content":"a"}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":800,"completion_tokens":20,"total_tokens":820,"prompt_tokens_details":{"cached_tokens":600}}}',
            'data: [DONE]',
        ].join('\n');

        const entry = buildApiCallLogEntry({
            url: chatUrl,
            body: JSON.stringify({ model: 'kimi-k2' }),
            status: 200,
            ok: true,
            responseText: sse,
        });
        expect(entry.backendModel).toBe('kimi-k2');
        expect(entry.cachedTokens).toBe(600);
        expect(entry.promptTokens).toBe(800);
        expect(entry.usageStatus).toBe('reported');
    });

    it('没有任何 usage → usageStatus=not-reported，普通与缓存字段都没有键', () => {
        const entry = buildApiCallLogEntry({
            url: chatUrl,
            body: JSON.stringify({ model: 'm' }),
            status: 200,
            ok: true,
            response: { model: 'm', choices: [{ message: { content: 'hi' } }] },
        });
        expect(entry.ok).toBe(true);
        expect(entry.usageStatus).toBe('not-reported');
        for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
            expect(key in entry).toBe(false);
        }
    });

    it('失败记录也计入调用次数（ok:false 仍生成一条带状态与耗时的记录）', () => {
        const entry = buildApiCallLogEntry({
            url: chatUrl,
            body: JSON.stringify({ model: 'm' }),
            status: 502,
            ok: false,
            durationMs: 900,
            meta: { appName: '消息', purpose: '聊天回复' },
        });
        expect(entry.ok).toBe(false);
        expect(entry.appName).toBe('消息');
        expect(entry.purpose).toBe('聊天回复');
        expect(entry.durationMs).toBe(900);
        expect(entry.promptTokens).toBeUndefined();
    });
});

describe('recordApiCall 落库', () => {
    it('走全局兜底时 usage 与耗时字段一并入库', async () => {
        const logged: any[] = [];
        vi.spyOn(DB, 'appendApiCallLog').mockImplementation(async (entry: any) => { logged.push(entry); });

        recordApiCall({
            requestId: 'req-record',
            url: chatUrl,
            body: JSON.stringify({ model: 'm' }),
            status: 200,
            ok: true,
            response: { usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 7 } } },
            durationMs: 100,
            headersMs: 30,
            firstDeltaMs: 60,
        });

        await vi.waitFor(() => expect(logged).toHaveLength(1));
        expect(logged[0]).toMatchObject({
            id: 'req-record',
            promptTokens: 10,
            cachedTokens: 7,
            usageStatus: 'reported',
            headersMs: 30,
            firstDeltaMs: 60,
        });
    });
});

describe('settleCloudApiCall · 云端回程用量', () => {
    it('云端带回缓存数时一并补写，缺失的仍留空', async () => {
        const logged: any[] = [];
        vi.spyOn(DB, 'appendApiCallLog').mockImplementation(async (entry: any) => { logged.push(entry); });

        settleCloudApiCall({
            id: 'cloud-uuid-1',
            ok: true,
            promptTokens: 1200,
            completionTokens: 80,
            cachedTokens: 1000,
            usageStatus: 'reported',
        });

        await vi.waitFor(() => expect(logged).toHaveLength(1));
        expect(logged[0]).toMatchObject({
            id: 'cloud-uuid-1',
            pending: false,
            promptTokens: 1200,
            completionTokens: 80,
            totalTokens: 1280,
            cachedTokens: 1000,
            usageStatus: 'reported',
        });
        expect('cacheReadTokens' in logged[0]).toBe(false);
    });
});

describe('updateApiRequestCaptureUsage · 一次性抓包', () => {
    it('回填缓存字段与缺失名单，缺失时不写 0', async () => {
        await DB.clearApiRequestCapture();
        await DB.saveApiRequestCapture({
            version: 1,
            id: 'cap-usage',
            capturedAt: Date.now(),
            baseUrl: 'https://relay.test/v1',
            presetName: 'test',
            model: 'm',
            meta: {},
            payload: null,
            totalChars: 0,
            usageStatus: 'pending',
            messageCount: 0,
            binaryPlaceholders: 0,
            sections: [],
        });

        updateApiRequestCaptureUsage({
            captureId: 'cap-usage',
            ok: true,
            response: {
                usage: {
                    prompt_tokens: 900,
                    completion_tokens: 40,
                    total_tokens: 940,
                    prompt_tokens_details: { cached_tokens: 700 },
                },
            },
        });

        await vi.waitFor(async () => {
            expect(await DB.getApiRequestCapture()).toMatchObject({
                id: 'cap-usage',
                promptTokens: 900,
                cachedTokens: 700,
                usageStatus: 'reported',
            });
        });
        const capture: any = await DB.getApiRequestCapture();
        expect('cacheWriteTokens' in capture).toBe(false);
        expect(capture.usageMissing).toContain('cacheWriteTokens');
    });
});
