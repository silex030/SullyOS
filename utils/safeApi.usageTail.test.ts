import { describe, it, expect, vi, afterEach } from 'vitest';
import { TERMINAL_USAGE_GRACE_MS, safeFetchJson } from './safeApi';

// P1-C3 / C5：流式正文与 usage 收尾分开。
// 锁住：
//   - usage 与终止事件同块 / 后块 / [DONE] 之后到达，都要保留（含 cached_tokens）；
//   - 正文增量不等 usage（onDelta 先到），只做有界尾捕，不无限等；
//   - 完全没 usage 时不写 0，且有界退出；
//   - 聊天补全路径不因 usage 缺失而自动重试（重复计费）。

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface StreamStep {
    /** 相对上一步的等待毫秒 */
    delay?: number;
    text?: string;
}

const timedSse = (steps: StreamStep[], opts: { close?: boolean } = {}) => {
    const stats = { cancelled: 0, enqueued: 0 };
    const enc = new TextEncoder();
    const response = new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
            for (const step of steps) {
                if (step.delay) await sleep(step.delay);
                try {
                    controller.enqueue(enc.encode(step.text ?? ''));
                } catch {
                    return; // 已被调用方 cancel
                }
                stats.enqueued++;
            }
            if (opts.close !== false) {
                try { controller.close(); } catch { /* 已关闭 */ }
            }
        },
        cancel() { stats.cancelled++; },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    return { response, stats };
};

const chatUrl = 'https://api.test/v1/chat/completions';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('safeFetchJson 流式 usage 尾捕', () => {
    it('usage 与终止事件同块：原样保留嵌套 cached_tokens，立即收口', async () => {
        const { response, stats } = timedSse([
            { text: 'data: {"choices":[{"delta":{"content":"好的"}}]}\n\n' },
            { text: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105,"prompt_tokens_details":{"cached_tokens":80}}}\n\n' },
            { text: 'data: [DONE]\n\n' },
        ]);
        vi.stubGlobal('fetch', vi.fn(async () => response));

        const startedAt = Date.now();
        const data = await safeFetchJson(chatUrl, { method: 'POST', body: '{"stream":true}' }, 0, 0, undefined, {});
        const elapsed = Date.now() - startedAt;

        expect(data.choices[0].message.content).toBe('好的');
        expect(data.usage.prompt_tokens).toBe(100);
        expect(data.usage.prompt_tokens_details.cached_tokens).toBe(80);
        expect(stats.cancelled).toBe(1);
        expect(elapsed).toBeLessThan(300);
    });

    it('usage 在终止事件之后的下一个网络块到达：正文已回调，尾捕仍拿到 usage', async () => {
        const { response, stats } = timedSse([
            { text: 'data: {"choices":[{"delta":{"content":"正文先到"}}]}\n\n' },
            { text: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":null}\n\n' },
            { text: 'data: [DONE]\n\n' },
            { delay: 40, text: 'data: {"choices":[],"usage":{"prompt_tokens":500,"completion_tokens":20,"total_tokens":520,"prompt_tokens_details":{"cached_tokens":300}}}\n\n' },
        ], { close: false });
        vi.stubGlobal('fetch', vi.fn(async () => response));

        let firstDeltaAt = 0;
        const startedAt = Date.now();
        const data = await safeFetchJson(chatUrl, { method: 'POST', body: '{"stream":true}' }, 0, 0, undefined, {
            onFirstDelta: () => { firstDeltaAt = Date.now(); },
            usageGraceMs: 400,
        });
        const elapsed = Date.now() - startedAt;

        expect(data.choices[0].message.content).toBe('正文先到');
        expect(data.usage.prompt_tokens).toBe(500);
        expect(data.usage.prompt_tokens_details.cached_tokens).toBe(300);
        // 正文没有等 usage：首个增量在尾捕窗口之前就交付了
        expect(firstDeltaAt - startedAt).toBeLessThan(40);
        expect(elapsed).toBeGreaterThanOrEqual(35);
        expect(stats.cancelled).toBe(1);
    });

    it('完全没有 usage：不写 0、不无限等，宽限到期就取消连接', async () => {
        const { response, stats } = timedSse([
            { text: 'data: {"choices":[{"delta":{"content":"只有正文"}}]}\n\n' },
            { text: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' },
        ], { close: false });
        vi.stubGlobal('fetch', vi.fn(async () => response));

        const startedAt = Date.now();
        const data = await safeFetchJson(chatUrl, { method: 'POST', body: '{"stream":true}' }, 0, 0, undefined, {
            usageGraceMs: 120,
        });
        const elapsed = Date.now() - startedAt;

        expect(data.choices[0].message.content).toBe('只有正文');
        expect(data.usage).toBeUndefined();
        expect(data.usage?.prompt_tokens).toBeUndefined();
        expect(stats.cancelled).toBe(1);
        expect(elapsed).toBeGreaterThanOrEqual(100);
        expect(elapsed).toBeLessThan(120 + 700);
        // 默认常量可不小，但必须是有界值而不是无限等待
        expect(TERMINAL_USAGE_GRACE_MS).toBeGreaterThan(0);
        expect(TERMINAL_USAGE_GRACE_MS).toBeLessThanOrEqual(3000);
    });

    it('usage 缺失也不自动重试聊天补全（不重复计费）', async () => {
        const fetchSpy = vi.fn(async () => timedSse([
            { text: 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n' },
            { text: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' },
        ], { close: false }).response);
        vi.stubGlobal('fetch', fetchSpy);

        await safeFetchJson(chatUrl, { method: 'POST', body: '{"stream":true}' }, 3, 0, undefined, { usageGraceMs: 30 });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('[DONE] 后立刻 EOF 且没有 usage：正常收口，不合成 0', async () => {
        const { response, stats } = timedSse([
            { text: 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' },
            { text: 'data: [DONE]\n\n' },
        ]);
        vi.stubGlobal('fetch', vi.fn(async () => response));

        const data = await safeFetchJson(chatUrl, { method: 'POST', body: '{"stream":true}' }, 0, 0, undefined, { usageGraceMs: 200 });

        expect(data.usage).toBeUndefined();
        expect(data.choices[0].message.content).toBe('hi');
        expect(stats.cancelled).toBeLessThanOrEqual(1);
    });

    it('多轮 usage 分块：取最后一个非空 usage（末轮），不把中途值当总量', async () => {
        const { response } = timedSse([
            { text: 'data: {"choices":[{"delta":{"content":"a"}}],"usage":{"prompt_tokens":10,"completion_tokens":1}}\n\n' },
            { text: 'data: {"choices":[{"delta":{"content":"b"}}]}\n\n' },
            { text: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":30,"completion_tokens":3,"total_tokens":33,"prompt_tokens_details":{"cached_tokens":20}}}\n\n' },
            { text: 'data: [DONE]\n\n' },
        ]);
        vi.stubGlobal('fetch', vi.fn(async () => response));

        const data = await safeFetchJson(chatUrl, { method: 'POST', body: '{"stream":true}' }, 0, 0, undefined, {});
        expect(data.choices[0].message.content).toBe('ab');
        expect(data.usage.prompt_tokens).toBe(30);
        expect(data.usage.total_tokens).toBe(33);
        expect(data.usage.prompt_tokens_details.cached_tokens).toBe(20);
    });
});
