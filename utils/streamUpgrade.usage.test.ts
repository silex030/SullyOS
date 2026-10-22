import { describe, it, expect, vi, afterEach } from 'vitest';
import { assembleUpgradedResponse, upgradeChatBodyToStream } from './streamUpgrade';

// P1-C3：透明流式升级这条路上的 usage 保真。
// 锁住：
//   - 升级请求体时 include_usage 要并进已有 stream_options，不整块覆盖；
//   - 已经自己开流的调用不重写（原契约）；
//   - [DONE] 之后尾随的 usage 仍能进拼装结果（有界宽限内），超时不无限等。

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const enc = new TextEncoder();

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

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('upgradeChatBodyToStream · stream_options 合并', () => {
    it('把 stream 升级为 true 并合并 include_usage，保留调用方已有的 stream_options', () => {
        const upgraded = upgradeChatBodyToStream(JSON.stringify({
            model: 'm',
            stream: false,
            stream_options: { foo: 1 },
        }));
        expect(upgraded).not.toBeNull();
        const body = JSON.parse(upgraded as string);
        expect(body.stream).toBe(true);
        expect(body.stream_options).toEqual({ foo: 1, include_usage: true });
    });

    it('已有 include_usage:false 时明确改成 true（usage 才能回来）', () => {
        const body = JSON.parse(upgradeChatBodyToStream(JSON.stringify({
            model: 'm',
            stream_options: { include_usage: false },
        })) as string);
        expect(body.stream_options.include_usage).toBe(true);
    });

    it('调用方自己 stream:true 的请求默认不碰（返回 null）', () => {
        expect(upgradeChatBodyToStream(JSON.stringify({ model: 'm', stream: true }))).toBeNull();
    });

    it('非 JSON / 非对象返回 null', () => {
        expect(upgradeChatBodyToStream('not json')).toBeNull();
        expect(upgradeChatBodyToStream('[1,2]')).toBeNull();
    });
});

describe('assembleUpgradedResponse · 尾随 usage', () => {
    it('[DONE] 之后到达的 usage 仍进拼装结果（有界宽限内）', async () => {
        const { response, stats } = timedSse([
            { text: 'data: {"id":"x","model":"m","choices":[{"delta":{"content":"正文"}}]}\n\n' },
            { text: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' },
            { text: 'data: [DONE]\n\n' },
            { delay: 40, text: 'data: {"choices":[],"usage":{"prompt_tokens":700,"completion_tokens":9,"total_tokens":709,"prompt_tokens_details":{"cached_tokens":512}}}\n\n' },
        ], { close: false });

        const startedAt = Date.now();
        const assembled = await assembleUpgradedResponse(response);
        const elapsed = Date.now() - startedAt;
        const body = await assembled.json();

        expect(body.choices[0].message.content).toBe('正文');
        expect(body.usage.prompt_tokens).toBe(700);
        expect(body.usage.prompt_tokens_details.cached_tokens).toBe(512);
        expect(elapsed).toBeLessThan(1200);
        expect(stats.cancelled).toBe(1);
    });

    it('没有 usage 时正常返回正文，不补 0', async () => {
        const { response } = timedSse([
            { text: 'data: {"choices":[{"delta":{"content":"只有字"}}]}\n\n' },
            { text: 'data: [DONE]\n\n' },
        ]);
        const assembled = await assembleUpgradedResponse(response);
        const body = await assembled.json();
        expect(body.choices[0].message.content).toBe('只有字');
        expect(body.usage).toBeUndefined();
    });
});
