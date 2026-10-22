import { describe, it, expect } from 'vitest';
import {
    LLM_USAGE_FIELDS,
    cacheHitRate,
    emptyLlmUsage,
    normalizeLlmUsage,
    sumLlmUsage,
    toOpenAiUsage,
} from './llmUsage';

// P1-C1：usage 保真结构（allowlist）。
// 锁住三件事：
//   1. 只保留语义明确的数值字段（普通入/出/总 + 缓存读/写 + 思考明细），未知字段不进日志；
//   2. 缺失 ≠ 0：字段没到就别写 0，也别把 0 当「确实零消耗」；
//   3. 缓存命中的分母语义要分开（cached_tokens 是 prompt 子集；Anthropic
//      cache_read_input_tokens 不含在 input_tokens 里），不能混算比例。

describe('normalizeLlmUsage', () => {
    it('保留 OpenAI 普通数与嵌套 cached_tokens，缺失字段直接不存在', () => {
        const usage = normalizeLlmUsage({
            prompt_tokens: 1200,
            completion_tokens: 80,
            total_tokens: 1280,
            prompt_tokens_details: { cached_tokens: 1024 },
        });

        expect(usage.promptTokens).toBe(1200);
        expect(usage.completionTokens).toBe(80);
        expect(usage.totalTokens).toBe(1280);
        expect(usage.cachedTokens).toBe(1024);
        // Anthropic 风格的独立缓存读字段没到 → 必须留空，不能补 0
        expect(usage.cacheReadTokens).toBeUndefined();
        expect(usage.cacheWriteTokens).toBeUndefined();
        expect(Object.keys(usage)).not.toContain('cacheReadTokens');
        expect(usage.cacheReadSemantics).toBe('subset-of-prompt');
        expect(usage.reported).toEqual(expect.arrayContaining(['promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens']));
        expect(usage.missing).toEqual(expect.arrayContaining(['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']));
        expect(usage.status).toBe('reported');
        expect(usage.usagePresent).toBe(true);
        expect(usage.fieldSources?.cachedTokens).toBe('prompt_tokens_details.cached_tokens');
    });

    it('Anthropic 的 cache_read_input_tokens / cache_creation_input_tokens 单独保留且标记为非子集语义', () => {
        const usage = normalizeLlmUsage({
            input_tokens: 300,
            output_tokens: 40,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 120,
        });

        expect(usage.promptTokens).toBe(300);
        expect(usage.cacheReadTokens).toBe(900);
        expect(usage.cacheWriteTokens).toBe(120);
        // 900 不是 300 的子集，硬塞进 cachedTokens 会让命中率算成 300%
        expect(usage.cachedTokens).toBeUndefined();
        expect(usage.cacheReadSemantics).toBe('exclusive-of-prompt');
        expect(usage.fieldSources?.cacheReadTokens).toBe('cache_read_input_tokens');
    });

    it('DeepSeek 的 prompt_cache_hit_tokens 是 prompt 子集语义', () => {
        const usage = normalizeLlmUsage({
            prompt_tokens: 1000,
            completion_tokens: 10,
            prompt_cache_hit_tokens: 640,
        });
        expect(usage.cachedTokens).toBe(640);
        expect(usage.cacheReadSemantics).toBe('subset-of-prompt');
    });

    it('Gemini usageMetadata 的 cachedContentTokenCount 也按子集语义识别', () => {
        const usage = normalizeLlmUsage({
            promptTokenCount: 80,
            candidatesTokenCount: 10,
            totalTokenCount: 90,
            cachedContentTokenCount: 60,
        });
        expect(usage.promptTokens).toBe(80);
        expect(usage.completionTokens).toBe(10);
        expect(usage.cachedTokens).toBe(60);
    });

    it('usage 整个缺失 vs usage 到达但一个 allowlist 字段都没有：两种状态都可辨', () => {
        const absent = normalizeLlmUsage(undefined);
        expect(absent.usagePresent).toBe(false);
        expect(absent.status).toBe('not-reported');
        expect(absent.reported).toEqual([]);
        expect(absent.missing).toEqual([...LLM_USAGE_FIELDS]);

        const unknownShape = normalizeLlmUsage({ some_vendor_counter: 7 });
        expect(unknownShape.usagePresent).toBe(true);
        expect(unknownShape.status).toBe('not-reported');
        // 未知供应商字段既不落值也不落键
        expect(unknownShape.reported).toEqual([]);
        expect(Object.keys(unknownShape)).not.toContain('promptTokens');
    });

    it('字符串/负数/NaN/Infinity 不算数值（不能当 0）', () => {
        const usage = normalizeLlmUsage({
            prompt_tokens: '1234',
            completion_tokens: -5,
            total_tokens: Number.NaN,
            prompt_tokens_details: { cached_tokens: Number.POSITIVE_INFINITY },
        });
        expect(usage.promptTokens).toBeUndefined();
        expect(usage.completionTokens).toBeUndefined();
        expect(usage.totalTokens).toBeUndefined();
        expect(usage.cachedTokens).toBeUndefined();
        expect(usage.status).toBe('not-reported');

        const zero = normalizeLlmUsage({ prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } });
        expect(zero.cachedTokens).toBe(0);
        expect(zero.status).toBe('reported');
    });

    it('只有普通数没有缓存明细 → status 仍是 reported，缓存字段进 missing 而不是 0', () => {
        const usage = normalizeLlmUsage({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
        expect(usage.status).toBe('reported');
        expect(usage.missing).toEqual(expect.arrayContaining(['cachedTokens', 'cacheReadTokens', 'cacheWriteTokens']));
        expect(usage.cachedTokens).toBeUndefined();
    });
});

describe('sumLlmUsage', () => {
    it('每轮都有的字段才求和；有一轮缺就留空并标 partial', () => {
        const first = normalizeLlmUsage({
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
            prompt_tokens_details: { cached_tokens: 4 },
        });
        const second = normalizeLlmUsage({
            prompt_tokens: 20,
            completion_tokens: 3,
            total_tokens: 23,
            prompt_tokens_details: { cached_tokens: 6 },
        });

        const total = sumLlmUsage([first, second]);
        expect(total.promptTokens).toBe(30);
        expect(total.completionTokens).toBe(5);
        expect(total.totalTokens).toBe(35);
        expect(total.cachedTokens).toBe(10);
        expect(total.status).toBe('reported');
        expect(total.partial).toEqual([]);

        const shorter = normalizeLlmUsage({ prompt_tokens: 5, completion_tokens: 1 });
        const mixed = sumLlmUsage([first, shorter]);
        expect(mixed.promptTokens).toBe(15);
        expect(mixed.completionTokens).toBe(3);
        // 有一轮没报 total/cached → 合计不能拿半截充整份
        expect(mixed.totalTokens).toBeUndefined();
        expect(mixed.cachedTokens).toBeUndefined();
        expect(mixed.partial).toEqual(expect.arrayContaining(['totalTokens', 'cachedTokens']));
        expect(mixed.status).toBe('reported');
    });

    it('一轮都没报 → not-reported，不制造 0 总量', () => {
        const total = sumLlmUsage([normalizeLlmUsage(undefined), normalizeLlmUsage(null)]);
        expect(total.status).toBe('not-reported');
        expect(total.promptTokens).toBeUndefined();
        expect(total.totalTokens).toBeUndefined();
        expect(sumLlmUsage([]).status).toBe('not-reported');
    });

    it('混合语义的缓存读合计语义未知（不许算命中率）', () => {
        const openai = normalizeLlmUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 5 } });
        const anthropic = normalizeLlmUsage({ input_tokens: 10, cache_read_input_tokens: 90 });
        const total = sumLlmUsage([openai, anthropic]);
        expect(total.cacheReadSemantics).toBe('unknown');
        expect(cacheHitRate(total)).toBeNull();
    });
});

describe('cacheHitRate', () => {
    it('子集语义才给比例，分母是 prompt_tokens', () => {
        const usage = normalizeLlmUsage({ prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 400 } });
        expect(cacheHitRate(usage)).toEqual({ rate: 0.4, numerator: 400, denominator: 1000 });
    });

    it('缓存读数缺失 → null（界面显示「未提供」，不是 0%）', () => {
        const usage = normalizeLlmUsage({ prompt_tokens: 1000, completion_tokens: 10 });
        expect(cacheHitRate(usage)).toBeNull();
    });

    it('prompt 缺失或为 0 → null，不做除零', () => {
        expect(cacheHitRate(normalizeLlmUsage({ prompt_tokens_details: { cached_tokens: 10 } }))).toBeNull();
        expect(cacheHitRate(normalizeLlmUsage({ prompt_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } }))).toBeNull();
    });

    it('Anthropic 独占语义不给比例（缓存读不在 input_tokens 里）', () => {
        const usage = normalizeLlmUsage({ input_tokens: 100, cache_read_input_tokens: 900 });
        expect(usage.cacheReadTokens).toBe(900);
        expect(cacheHitRate(usage)).toBeNull();
    });
});

describe('toOpenAiUsage', () => {
    it('只把已知数值摊成 OpenAI 兼容字段，未知字段不出现', () => {
        const usage = normalizeLlmUsage({
            prompt_tokens: 100,
            completion_tokens: 5,
            total_tokens: 105,
            prompt_tokens_details: { cached_tokens: 80 },
        });
        expect(toOpenAiUsage(usage)).toEqual({
            prompt_tokens: 100,
            completion_tokens: 5,
            total_tokens: 105,
            prompt_tokens_details: { cached_tokens: 80 },
        });
    });

    it('缓存读走独占语义时用 cache_read_input_tokens，不伪造 prompt_tokens_details', () => {
        const usage = normalizeLlmUsage({ input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 20 });
        expect(toOpenAiUsage(usage)).toEqual({
            prompt_tokens: 100,
            completion_tokens: 5,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 20,
        });
    });

    it('一个数值都没有 → undefined（宁可「未提供」，不写 0 usage）', () => {
        expect(toOpenAiUsage(normalizeLlmUsage(undefined))).toBeUndefined();
        expect(toOpenAiUsage(emptyLlmUsage())).toBeUndefined();
    });
});
