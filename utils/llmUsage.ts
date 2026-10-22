/**
 * LLM usage 保真结构（allowlist）—— P1-C1。
 *
 * 为什么要这一层：各家供应商的 `usage` 形状不同，OpenAI 把缓存命中塞在
 * `prompt_tokens_details.cached_tokens`，Anthropic 用 `cache_read_input_tokens` /
 * `cache_creation_input_tokens`，DeepSeek 用 `prompt_cache_hit_tokens`，Gemini 用
 * `cachedContentTokenCount`。以前的记录只挑三个普通数，缓存字段一路被丢掉；缺字段又被
 * 写成 0，看起来像"确实零消耗"。
 *
 * 这里的契约只有三条：
 *   1. 只认语义明确的数值字段（普通入/出/总 + 缓存读/写 + 思考明细）。未知供应商字段
 *      一律不进日志——不把上游原对象长期落库，也不猜语义。
 *   2. 缺失 ≠ 0。没到的字段既不出现在对象里，也不填 0；`reported/partial/missing`
 *      三个名单把"没提供"说清楚。
 *   3. 缓存命中的分母语义分开记：`cached_tokens` 是 prompt 的子集（可以直接算比例），
 *      Anthropic 的 `cache_read_input_tokens` 不在 `input_tokens` 里（不能算比例）。
 *      语义没确认时宁可只展示原始计数。
 *
 * 纯函数、零依赖：worker/main-agent（单文件 verbatim 部署，不能 import）里有一份逐字
 * 对齐的内联实现，由 worker/main-agent/src/usage.test.ts 的契约测试守着两边一致。
 */

export type LlmUsageFieldName =
    | 'promptTokens'
    | 'completionTokens'
    | 'totalTokens'
    | 'cachedTokens'
    | 'cacheReadTokens'
    | 'cacheWriteTokens'
    | 'reasoningTokens';

/** allowlist 的稳定顺序（名单输出按它排，测试/Diff 不受字段发现顺序影响）。 */
export const LLM_USAGE_FIELDS: readonly LlmUsageFieldName[] = [
    'promptTokens',
    'completionTokens',
    'totalTokens',
    'cachedTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
];

/**
 * - `reported`：普通输入与输出都拿到了（够判断这一次调用的规模）。
 * - `partial`：只拿到其中一部分数（例如只有输入没有输出）。
 * - `not-reported`：一个 allowlist 数值都没有——供应商没给，或者形状不认识。
 */
export type LlmUsageStatus = 'reported' | 'partial' | 'not-reported';

/**
 * 缓存读计数相对 prompt 的位置：
 * - `subset-of-prompt`：cached_tokens 形式的子集，比例 = cached / prompt；
 * - `exclusive-of-prompt`：Anthropic 形式，input_tokens 不含缓存读，不能拿它当分母；
 * - `unknown`：字段名通用或来源混杂，只展示原始值。
 */
export type LlmCacheReadSemantics = 'subset-of-prompt' | 'exclusive-of-prompt' | 'unknown';

export interface LlmUsage {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    /** OpenAI/DeepSeek/Gemini 的缓存命中数（prompt 子集） */
    cachedTokens?: number;
    /** Anthropic 等把缓存读单列的字段（不是 prompt 子集） */
    cacheReadTokens?: number;
    /** 缓存写入/创建数（Anthropic cache_creation_input_tokens 等） */
    cacheWriteTokens?: number;
    /** 思考 token 明细（completion_tokens_details.reasoning_tokens 等） */
    reasoningTokens?: number;
    /** 有值的字段名单 */
    reported: LlmUsageFieldName[];
    /** 多份 usage 求和时，只有一部分来源提供的字段（不含数值） */
    partial: LlmUsageFieldName[];
    /** 完全没提供的字段名单 */
    missing: LlmUsageFieldName[];
    status: LlmUsageStatus;
    /** usage 对象本身是否到达（与"到了但没有可识别字段"区分开） */
    usagePresent: boolean;
    cacheReadSemantics: LlmCacheReadSemantics;
    /** 数值来自哪个原始字段路径（排障用，只有字段名，没有值以外的内容） */
    fieldSources?: Partial<Record<LlmUsageFieldName, string>>;
}

/** 可选的缓存命中比例；语义不符/缺分母时返回 null（界面显示「未提供」，不是 0%）。 */
export interface LlmCacheHitRate {
    rate: number;
    numerator: number;
    denominator: number;
}

interface Hit { value?: number; source?: string }

const asNumber = (value: unknown): number | undefined =>
    (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);

const readPath = (source: unknown, path: readonly string[]): unknown => {
    let current: any = source;
    for (const key of path) {
        if (!current || typeof current !== 'object') return undefined;
        current = current[key];
    }
    return current;
};

const pick = (source: unknown, paths: ReadonlyArray<readonly string[]>): Hit => {
    for (const path of paths) {
        const value = asNumber(readPath(source, path));
        if (value !== undefined) return { value, source: path.join('.') };
    }
    return {};
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * 把任意供应商的 usage 对象归一成 allowlist 结构。传 undefined / null / 非对象都安全，
 * 返回 `usagePresent:false` 的空账（不 throw，不写 0）。
 */
export function normalizeLlmUsage(raw: unknown): LlmUsage {
    const usagePresent = isRecord(raw);
    const values: Partial<Record<LlmUsageFieldName, number>> = {};
    const fieldSources: Partial<Record<LlmUsageFieldName, string>> = {};
    let cacheReadSource = '';

    const take = (field: LlmUsageFieldName, hit: Hit) => {
        if (hit.value === undefined) return;
        values[field] = hit.value;
        fieldSources[field] = hit.source || '';
    };

    if (usagePresent) {
        const source = raw as Record<string, unknown>;
        take('promptTokens', pick(source, [
            ['prompt_tokens'], ['input_tokens'], ['promptTokenCount'],
        ]));
        take('completionTokens', pick(source, [
            ['completion_tokens'], ['output_tokens'], ['candidatesTokenCount'],
        ]));
        take('totalTokens', pick(source, [
            ['total_tokens'], ['totalTokenCount'],
        ]));
        take('cachedTokens', pick(source, [
            ['prompt_tokens_details', 'cached_tokens'],
            ['input_tokens_details', 'cached_tokens'],
            ['prompt_cache_hit_tokens'],
            ['cachedContentTokenCount'],
        ]));
        const cacheRead = pick(source, [
            ['cache_read_input_tokens'],
            ['cache_read_tokens'],
        ]);
        take('cacheReadTokens', cacheRead);
        if (cacheRead.source) cacheReadSource = cacheRead.source;
        take('cacheWriteTokens', pick(source, [
            ['cache_creation_input_tokens'],
            ['cache_creation_tokens'],
            ['cache_write_tokens'],
        ]));
        take('reasoningTokens', pick(source, [
            ['completion_tokens_details', 'reasoning_tokens'],
            ['output_tokens_details', 'reasoning_tokens'],
            ['reasoning_tokens'],
        ]));
    }

    const reported = LLM_USAGE_FIELDS.filter(field => values[field] !== undefined);
    const missing = LLM_USAGE_FIELDS.filter(field => values[field] === undefined);
    const status: LlmUsageStatus = reported.length === 0
        ? 'not-reported'
        : (values.promptTokens !== undefined && values.completionTokens !== undefined ? 'reported' : 'partial');

    let cacheReadSemantics: LlmCacheReadSemantics = 'unknown';
    if (values.cachedTokens !== undefined) cacheReadSemantics = 'subset-of-prompt';
    else if (cacheReadSource === 'cache_read_input_tokens') cacheReadSemantics = 'exclusive-of-prompt';

    const usage: LlmUsage = {
        reported,
        partial: [],
        missing,
        status,
        usagePresent,
        cacheReadSemantics,
    };
    for (const field of LLM_USAGE_FIELDS) {
        const value = values[field];
        if (value !== undefined) usage[field] = value;
    }
    if (Object.keys(fieldSources).length > 0) usage.fieldSources = fieldSources;
    return usage;
}

/** 空账（usage 未到）。 */
export function emptyLlmUsage(): LlmUsage {
    return normalizeLlmUsage(undefined);
}

/**
 * 多轮/多次求和的保真规则：**每一份都有**的字段才相加，否则留空并标 `partial`
 * ——拿半截数当总量比不报更糟（对账时看起来像少扣了钱）。
 */
export function sumLlmUsage(parts: readonly LlmUsage[]): LlmUsage {
    const list = parts.filter((part): part is LlmUsage => !!part);
    const values: Partial<Record<LlmUsageFieldName, number>> = {};
    const reported: LlmUsageFieldName[] = [];
    const partial: LlmUsageFieldName[] = [];
    const missing: LlmUsageFieldName[] = [];

    for (const field of LLM_USAGE_FIELDS) {
        let sum = 0;
        let provided = 0;
        for (const part of list) {
            const value = part[field];
            if (typeof value === 'number' && Number.isFinite(value)) {
                sum += value;
                provided++;
            }
        }
        if (list.length > 0 && provided === list.length) {
            values[field] = sum;
            reported.push(field);
        } else if (provided > 0) {
            partial.push(field);
        } else {
            missing.push(field);
        }
    }

    const status: LlmUsageStatus = reported.length === 0
        ? 'not-reported'
        : (values.promptTokens !== undefined && values.completionTokens !== undefined ? 'reported' : 'partial');

    const semantics = new Set<LlmCacheReadSemantics>();
    for (const part of list) {
        if (part.cachedTokens !== undefined || part.cacheReadTokens !== undefined) {
            semantics.add(part.cacheReadSemantics);
        }
    }

    const usage: LlmUsage = {
        reported,
        partial,
        missing,
        status,
        usagePresent: list.some(part => part.usagePresent),
        cacheReadSemantics: semantics.size === 1 ? [...semantics][0] : 'unknown',
    };
    for (const field of LLM_USAGE_FIELDS) {
        const value = values[field];
        if (value !== undefined) usage[field] = value;
    }
    return usage;
}

/**
 * 缓存命中比例。只有"缓存读是 prompt 子集"的语义、且分母存在且为正时才算；
 * 其余一律 null —— 界面据此显示「未提供」，绝不显示 0%。
 */
export function cacheHitRate(usage: LlmUsage | undefined | null): LlmCacheHitRate | null {
    if (!usage || usage.cacheReadSemantics !== 'subset-of-prompt') return null;
    const numerator = usage.cachedTokens;
    const denominator = usage.promptTokens;
    if (numerator === undefined || denominator === undefined || denominator <= 0) return null;
    return { rate: numerator / denominator, numerator, denominator };
}

/**
 * 摊成 OpenAI 兼容的 usage 字段（供 main-agent 的响应/SSE 末块、以及需要塞回
 * completion.usage 的调用点使用）。一个数值都没有时返回 undefined — 宁可缺字段。
 */
export function toOpenAiUsage(usage: LlmUsage | undefined | null): Record<string, unknown> | undefined {
    if (!usage) return undefined;
    const out: Record<string, unknown> = {};
    if (usage.promptTokens !== undefined) out.prompt_tokens = usage.promptTokens;
    if (usage.completionTokens !== undefined) out.completion_tokens = usage.completionTokens;
    if (usage.totalTokens !== undefined) out.total_tokens = usage.totalTokens;
    if (usage.cachedTokens !== undefined) out.prompt_tokens_details = { cached_tokens: usage.cachedTokens };
    if (usage.cacheReadTokens !== undefined) out.cache_read_input_tokens = usage.cacheReadTokens;
    if (usage.cacheWriteTokens !== undefined) out.cache_creation_input_tokens = usage.cacheWriteTokens;
    if (usage.reasoningTokens !== undefined) out.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens };
    return Object.keys(out).length > 0 ? out : undefined;
}

/** 展示用中文名（「API 调用记录」/抓包 TXT 共用，避免各处自造词）。 */
export const LLM_USAGE_FIELD_LABELS: Record<LlmUsageFieldName, string> = {
    promptTokens: '输入 Token',
    completionTokens: '输出 Token',
    totalTokens: '总 Token',
    cachedTokens: '缓存命中 Token',
    cacheReadTokens: '缓存读取 Token',
    cacheWriteTokens: '缓存写入 Token',
    reasoningTokens: '思考 Token',
};

/** 缓存读的展示口径（原文，不换算成比例）。 */
export function describeCacheReadSemantics(usage: LlmUsage | undefined | null): string {
    if (!usage) return '未提供';
    if (usage.cachedTokens === undefined && usage.cacheReadTokens === undefined) return '未提供';
    if (usage.cacheReadSemantics === 'subset-of-prompt') return '缓存命中（prompt 子集）';
    if (usage.cacheReadSemantics === 'exclusive-of-prompt') return '缓存读取（不含在输入 Token 内）';
    return '缓存读取（供应商语义未确认）';
}
