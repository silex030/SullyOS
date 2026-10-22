/**
 * 本地 EmbeddingGemma2 适配层（浏览器侧）
 *
 * 服务的真实协议（容器内 /app/server.py，2026-10-22 核对）：
 *   POST /v1/embeddings  { model, input, encoding_format, task }
 *     task === 'query' → prompt "Retrieval-query"   → 前缀 `task: search result | query: `
 *     其它（默认 document）→ "Retrieval-document"   → 前缀 `title: none | text: `
 *   输出恒为 768 维、已 L2 归一；**不接受 dimensions**（MRL 要客户端自己切并重新归一）。
 *   GET /health 已改为轻量探活（不跑 encode）；/openapi.json、/docs 已关闭。
 *
 * 由此得三条硬约束，本文件就是它们的唯一实现：
 *   1. 前缀只由服务端按 task 加一次 —— 客户端绝不拼前缀，反而要把误加的前缀剥掉。
 *   2. 默认 768 维；要 MRL（512/256/128）必须切片后重新 L2 归一，否则分数静默变差。
 *   3. 维度不一致必须是显式错误，不能把别的模型的向量写进索引。
 *
 * 浏览器不持有本地服务的 EMB_API_KEY：这里的 baseUrl 指主代理的本地 embedding 路由
 * （同源、走既有 client token），真正的服务 key 只存在于 worker env。
 */

import type { EmbeddingConfig } from './types';

export type EmbeddingTask = 'query' | 'document';

/** 本地服务（google/embeddinggemma-2）的固定身份与边界。 */
export const LOCAL_GEMMA_PROFILE = {
    provider: 'local-gemma',
    model: 'google/embeddinggemma-2',
    /** HF revision 前 8 位（模型卷快照 914f7f89…），指纹里带上它，换权重即换空间。 */
    revision: '914f7f89',
    prefixScheme: 'eg2-retrieval-v1',
    normalization: 'l2',
    dimensions: 768,
    /** 官方卡的 Matryoshka 档位；128 对纯文本才合适，默认不用。 */
    mrlDimensions: [768, 512, 256, 128],
    maxItemChars: 4000,
    maxBatchItems: 10,
    batchCharBudget: 6000,
    timeoutMs: 30_000,
    /** 上游是 uvicorn 单 worker + Semaphore(1)，并发发出去只会排队。 */
    concurrency: 1,
} as const;

export const DOCUMENT_PREFIX = 'title: none | text: ';
export const QUERY_PREFIX = 'task: search result | query: ';

/** 调用方可能（历史遗留/手写）带进来的前缀 token，一律先剥掉再送服务端。 */
const PREFIX_TOKENS = [QUERY_PREFIX, DOCUMENT_PREFIX, 'task: search result | query:', 'title: none | text:'];

export interface LocalEmbeddingOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    maxBatchItems?: number;
    maxItemChars?: number;
}

export interface LocalEmbedResult {
    vectors: Float32Array[];
    /** 被单条长度上限截断的输入条数（截断会 console.error，让日志面板可见） */
    truncatedCount: number;
    /** 实际发起的上游请求数（可观测，便于发现批量被拆散） */
    requests: number;
}

/** 配置扩展字段：不改公共 types.ts，用可选字段 + 结构类型透传。 */
export interface LocalEmbeddingConfigExtras {
    provider?: string;
    prefixScheme?: string;
    modelRevision?: string;
    /** 想要 MRL 维度（默认 768；只允许官方档位） */
    mrlDimensions?: number;
    /** 本次调用的任务语义；缺省由入口函数决定（单条=query，批量=document） */
    task?: EmbeddingTask;
}

export type LocalAwareEmbeddingConfig = EmbeddingConfig & LocalEmbeddingConfigExtras;

export type LocalEmbeddingErrorCode =
    | 'invalid_config'
    | 'invalid_vector'
    | 'unsupported_mrl_dimension'
    | 'dimension_mismatch'
    | 'timeout'
    | 'cancelled'
    | 'http'
    | 'bad_response';

export class LocalEmbeddingError extends Error {
    code: LocalEmbeddingErrorCode;
    status?: number;
    constructor(code: LocalEmbeddingErrorCode, message: string, status?: number) {
        super(message);
        this.name = 'LocalEmbeddingError';
        this.code = code;
        this.status = status;
    }
}

export function isLocalGemmaModel(model: string | undefined | null): boolean {
    return /embeddinggemma/i.test(String(model || ''));
}

export function resolveEmbeddingProvider(config: LocalAwareEmbeddingConfig): 'local-gemma' | 'cloud' {
    if (config.provider === 'local-gemma') return 'local-gemma';
    if (config.provider === 'cloud') return 'cloud';
    return isLocalGemmaModel(config.model) ? 'local-gemma' : 'cloud';
}

/**
 * 向量身份指纹：模型 ID + revision + 维度 + 前缀方案 + 归一化规则。
 * 任一字段变化都意味着「另一个向量空间」，旧向量不能继续参与检索。
 */
export function buildEmbeddingFingerprint(
    config: LocalAwareEmbeddingConfig,
    /** 已知真实向量长度时传进来：老云端配置可能没写 `dimensions`，用它避免指纹写成 dim:0。 */
    opts: { dimensions?: number } = {},
): string {
    const override = Number(opts.dimensions || 0);
    const provider = resolveEmbeddingProvider(config);
    if (provider === 'local-gemma') {
        const dims = override > 0 ? override : resolveDimensions(config);
        return [
            'provider:local-gemma',
            `model:${LOCAL_GEMMA_PROFILE.model}`,
            `rev:${config.modelRevision || LOCAL_GEMMA_PROFILE.revision}`,
            `dim:${dims}`,
            `prefix:${config.prefixScheme || LOCAL_GEMMA_PROFILE.prefixScheme}`,
            'norm:l2',
        ].join('|');
    }
    return [
        'provider:cloud',
        `model:${String(config.model || '').trim().toLowerCase()}`,
        'rev:unknown',
        `dim:${override > 0 ? override : (Number(config.dimensions || 0) || 0)}`,
        'prefix:none',
        'norm:provider',
    ].join('|');
}

/** 期望维度：显式 mrlDimensions 优先，缺省 768。 */
export function resolveDimensions(config: LocalAwareEmbeddingConfig): number {
    const mrl = Number(config.mrlDimensions || 0);
    if (mrl > 0) return mrl;
    const configured = Number(config.dimensions || 0);
    if (providerUnsetOrLocal(config) && (!configured || configured > LOCAL_GEMMA_PROFILE.dimensions)) {
        return LOCAL_GEMMA_PROFILE.dimensions;
    }
    return configured || LOCAL_GEMMA_PROFILE.dimensions;
}

function providerUnsetOrLocal(config: LocalAwareEmbeddingConfig): boolean {
    return resolveEmbeddingProvider(config) === 'local-gemma';
}

/**
 * 剥掉调用方误加的任务前缀（可能重复多层）。返回是否剥过，方便调用方在日志里标注。
 * 注意：**本函数不添加任何前缀**——前缀是服务端按 task 字段加的。
 */
export function stripTaskPrefixes(text: string): { text: string; stripped: boolean } {
    let out = String(text ?? '').trim();
    let stripped = false;
    for (let guard = 0; guard < 4; guard++) {
        const hit = PREFIX_TOKENS.find(token => out.toLowerCase().startsWith(token.toLowerCase()));
        if (!hit) break;
        out = out.slice(hit.length).trim();
        stripped = true;
    }
    return { text: out, stripped };
}

export function prepareTaskInput(text: string): string {
    return stripTaskPrefixes(text).text;
}

export function l2Normalize(vec: ArrayLike<number>): Float32Array {
    const out = vec instanceof Float32Array ? vec : new Float32Array(Array.from(vec));
    if (out.length === 0) {
        throw new LocalEmbeddingError('invalid_vector', '零维向量不可归一化');
    }
    let sum = 0;
    for (let i = 0; i < out.length; i++) sum += out[i] * out[i];
    const norm = Math.sqrt(sum);
    if (!Number.isFinite(norm) || norm === 0) {
        throw new LocalEmbeddingError('invalid_vector', '向量范数为 0，无法归一化（上游可能返回了空向量）');
    }
    for (let i = 0; i < out.length; i++) out[i] = out[i] / norm;
    return out;
}

/**
 * MRL 截断 + 重新归一。
 * 官方卡明确：切一段单位向量并不保持单位长度，跳过归一化会静默降低排序质量。
 */
export function sliceAndRenormalize(vec: ArrayLike<number>, dims: number): Float32Array {
    const size = vec.length;
    if (!LOCAL_GEMMA_PROFILE.mrlDimensions.includes(dims as 768 | 512 | 256 | 128)) {
        throw new LocalEmbeddingError(
            'unsupported_mrl_dimension',
            `不支持的 MRL 维度 ${dims}（只允许 ${LOCAL_GEMMA_PROFILE.mrlDimensions.join('/')}）`,
        );
    }
    if (dims > size) {
        throw new LocalEmbeddingError(
            'dimension_mismatch',
            `MRL 目标维度 ${dims} 大于上游返回维度 ${size}`,
        );
    }
    return l2Normalize(new Float32Array(Array.from({ length: dims }, (_, i) => vec[i])));
}

function assertDims(vec: Float32Array, expected: number, index: number): void {
    if (vec.length !== expected) {
        throw new LocalEmbeddingError(
            'dimension_mismatch',
            `本地 embedding 返回维度 ${vec.length} 与期望 ${expected} 不一致（第 ${index + 1} 条）。` +
            `已拒绝写入索引：不同维度的向量混库会让检索静默失真`,
        );
    }
}

interface PostBatchArgs {
    baseUrl: string;
    apiKey: string;
    model: string;
    task: EmbeddingTask;
    input: string[];
    signal?: AbortSignal;
    timeoutMs: number;
}

async function postBatch(args: PostBatchArgs, signal: AbortSignal): Promise<Float32Array[]> {
    const url = `${args.baseUrl.replace(/\/+$/, '')}/embeddings`;
    const body = JSON.stringify({
        model: args.model,
        input: args.input,
        encoding_format: 'float',
        // 关键：前缀由服务端按 task 选，客户端不再拼前缀
        task: args.task,
    });

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${args.apiKey}`,
        },
        body,
        signal,
    });

    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new LocalEmbeddingError(
            'http',
            `本地 embedding 请求失败 ${res.status}${detail ? `：${detail.slice(0, 200)}` : ''}`,
            res.status,
        );
    }

    const data = await res.json().catch(() => null) as any;
    if (!data || !Array.isArray(data.data)) {
        throw new LocalEmbeddingError('bad_response', '本地 embedding 返回格式异常（缺少 data 数组）');
    }
    const sorted = [...data.data].sort((a: any, b: any) => (a?.index ?? 0) - (b?.index ?? 0));
    if (sorted.length !== args.input.length) {
        throw new LocalEmbeddingError(
            'bad_response',
            `本地 embedding 返回条数 ${sorted.length} 与请求 ${args.input.length} 不一致`,
        );
    }
    return sorted.map((item: any) => {
        const arr = item?.embedding;
        if (!Array.isArray(arr) || arr.length === 0) {
            throw new LocalEmbeddingError('bad_response', '本地 embedding 返回了空向量');
        }
        return new Float32Array(arr);
    });
}

/**
 * 批量向量化（本地 EmbeddingGemma2）。
 *
 * - 条数 / 字符预算切批，顺序严格保持（调用方按下标取向量）。
 * - 请求级超时 + 外部取消（signal）；超时 !== 取消，错误码分开，便于上层决定是否降级。
 * - 网络 / 5xx 重试一次；4xx 不重试（参数错重试无用）。
 */
export async function embedTextsLocally(
    texts: string[],
    config: LocalAwareEmbeddingConfig,
    options: LocalEmbeddingOptions = {},
): Promise<LocalEmbedResult> {
    if (!config?.baseUrl || !config?.apiKey) {
        throw new LocalEmbeddingError('invalid_config', '本地 embedding 需要 baseUrl 与 apiKey（agent 侧鉴权令牌）');
    }
    if (options.signal?.aborted) {
        throw new LocalEmbeddingError('cancelled', '已取消');
    }
    if (texts.length === 0) return { vectors: [], truncatedCount: 0, requests: 0 };

    const maxItemChars = options.maxItemChars ?? LOCAL_GEMMA_PROFILE.maxItemChars;
    const maxBatchItems = options.maxBatchItems ?? LOCAL_GEMMA_PROFILE.maxBatchItems;
    const timeoutMs = options.timeoutMs ?? LOCAL_GEMMA_PROFILE.timeoutMs;
    const expected = resolveDimensions(config);
    const task: EmbeddingTask = config.task === 'query' ? 'query' : 'document';

    const truncated: string[] = [];
    const prepared = texts.map((raw, i) => {
        let text = prepareTaskInput(raw);
        if (text.length > maxItemChars) {
            truncated.push(`第${i + 1}条(${text.length}字)`);
            text = text.slice(0, maxItemChars);
        }
        return text;
    });
    if (truncated.length > 0) {
        console.error(
            `⚠️ [LocalEmbedding] ${truncated.length} 条输入超 ${maxItemChars} 字上限，已截断建索引（正文不受影响）：${truncated.join('；')}`,
        );
    }

    // 按顺序切块：条数 ≤ maxBatchItems 且批内字符 ≤ batchCharBudget
    const chunks: string[][] = [];
    let current: string[] = [];
    let chars = 0;
    for (const text of prepared) {
        if (current.length > 0 && (current.length >= maxBatchItems || chars + text.length > LOCAL_GEMMA_PROFILE.batchCharBudget)) {
            chunks.push(current);
            current = [];
            chars = 0;
        }
        current.push(text);
        chars += text.length;
    }
    if (current.length > 0) chunks.push(current);

    const results: Float32Array[] = [];
    let requests = 0;

    for (const chunk of chunks) {
        if (options.signal?.aborted) throw new LocalEmbeddingError('cancelled', '已取消');

        const controller = new AbortController();
        let timedOut = false;
        const onOuterAbort = () => controller.abort();
        options.signal?.addEventListener('abort', onOuterAbort, { once: true });
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, timeoutMs));

        try {
            let attempt = 0;
            for (;;) {
                try {
                    requests++;
                    const vecs = await postBatch(
                        {
                            baseUrl: config.baseUrl,
                            apiKey: config.apiKey,
                            model: config.model || LOCAL_GEMMA_PROFILE.model,
                            task,
                            input: chunk,
                            signal: controller.signal,
                            timeoutMs,
                        },
                        controller.signal,
                    );
                    // 上游恒返回原生 768 维：先校验它，再决定是否按 MRL 切片
                    vecs.forEach((vec, i) => assertDims(vec, LOCAL_GEMMA_PROFILE.dimensions, results.length + i));
                    for (const vec of vecs) {
                        results.push(expected === LOCAL_GEMMA_PROFILE.dimensions ? vec : sliceAndRenormalize(vec, expected));
                    }
                    break;
                } catch (err: any) {
                    const isAbort = err?.name === 'AbortError' || controller.signal.aborted;
                    if (isAbort) {
                        if (timedOut) {
                            throw new LocalEmbeddingError('timeout', `本地 embedding 超时（>${timeoutMs}ms，${chunk.length} 条）`);
                        }
                        throw new LocalEmbeddingError('cancelled', '已取消');
                    }
                    if (err instanceof LocalEmbeddingError) {
                        const retryable = err.code === 'http' && (err.status === undefined || err.status >= 500 || err.status === 429);
                        if (retryable && attempt < 1) {
                            attempt++;
                            await new Promise(r => setTimeout(r, 500));
                            continue;
                        }
                        throw err;
                    }
                    // 网络层错误（fetch failed）：重试一次
                    if (attempt < 1) {
                        attempt++;
                        await new Promise(r => setTimeout(r, 500));
                        continue;
                    }
                    throw new LocalEmbeddingError('http', `本地 embedding 网络请求失败：${err?.message || err}`);
                }
            }
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onOuterAbort);
        }
    }

    return { vectors: results, truncatedCount: truncated.length, requests };
}

export async function embedOneLocally(
    text: string,
    config: LocalAwareEmbeddingConfig,
    options: LocalEmbeddingOptions = {},
): Promise<Float32Array> {
    const task: EmbeddingTask = config.task === 'query' ? 'query' : 'document';
    const out = await embedTextsLocally([text], { ...config, task }, options);
    return out.vectors[0];
}
