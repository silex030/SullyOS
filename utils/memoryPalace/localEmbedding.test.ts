/**
 * 本地 EmbeddingGemma2 适配层契约测试（RED 先行）。
 *
 * 这组用例锁的是「语义正确性」而不是「HTTP 能通」：
 *   1. query / document 任务字段必须按调用语义下发，且客户端绝不再自己拼前缀
 *      （服务端按 task 加前缀，客户端再加就是双前缀、检索空间错位却不报错）。
 *   2. 维度：默认 768；MRL 降到 512/256/128 之后必须重新 L2 归一
 *      （官方卡：切片后单位长度不保持，跳过归一化会静默降低排序质量）。
 *   3. 服务端返回的维度与期望不一致 ⇒ 必须显式报错，不允许把不兼容向量写进索引。
 *   4. 长度 / 批量 / 超时 / 取消必须有上界，且取消要能被上层 abort。
 *   5. 指纹 = 模型 ID + revision + 维度 + 前缀方案 + 归一化规则，任一变化都要变。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    LOCAL_GEMMA_PROFILE,
    LocalEmbeddingError,
    buildEmbeddingFingerprint,
    embedTextsLocally,
    isLocalGemmaModel,
    l2Normalize,
    prepareTaskInput,
    sliceAndRenormalize,
    stripTaskPrefixes,
} from './localEmbedding';

const BASE_CFG = {
    baseUrl: 'https://agent.example/agent/v1/local-embedding',
    // 浏览器侧拿的是 agent 的 client token，不是本地服务的 EMB_API_KEY
    apiKey: 'agent-client-token',
    model: 'google/embeddinggemma-2',
    dimensions: 768,
};

/** 造一条 768 维向量：第 index 位放 identity，便于断言顺序与内容 */
function unitVec(identity: number, dims = 768): number[] {
    const v = new Array(dims).fill(0);
    v[identity % dims] = 1;
    return v;
}

let calls: { url: string; body: any; auth: string | null }[] = [];

function installFetch(handler?: (body: any, init: any) => any) {
    global.fetch = vi.fn(async (url: any, init: any) => {
        const body = JSON.parse(init.body as string);
        const auth = (init.headers?.Authorization ?? init.headers?.authorization ?? null) as string | null;
        calls.push({ url: String(url), body, auth });
        if (handler) return handler(body, init);
        return {
            ok: true,
            status: 200,
            json: async () => ({
                object: 'list',
                model: body.model,
                dimensions: 768,
                data: body.input.map((text: string, i: number) => ({
                    index: i,
                    embedding: unitVec(i),
                })),
            }),
        } as any;
    }) as any;
}

beforeEach(() => {
    calls = [];
    installFetch();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('本地 EmbeddingGemma2 · 身份与指纹', () => {
    it('识别本地模型 ID，云端模型不误判', () => {
        expect(isLocalGemmaModel('google/embeddinggemma-2')).toBe(true);
        expect(isLocalGemmaModel('Google/EmbeddingGemma-2')).toBe(true);
        expect(isLocalGemmaModel('BAAI/bge-m3')).toBe(false);
        expect(isLocalGemmaModel('')).toBe(false);
        expect(isLocalGemmaModel(undefined)).toBe(false);
    });

    it('指纹包含模型 ID / revision / 维度 / 前缀方案 / 归一化', () => {
        const fp = buildEmbeddingFingerprint(BASE_CFG);
        expect(fp).toContain(LOCAL_GEMMA_PROFILE.model);
        expect(fp).toContain(LOCAL_GEMMA_PROFILE.revision);
        expect(fp).toContain('dim:768');
        expect(fp).toContain(`prefix:${LOCAL_GEMMA_PROFILE.prefixScheme}`);
        expect(fp).toContain('norm:l2');

        // 维度不同 ⇒ 指纹必须不同（旧实现只比模型名，768/512 会被当成同一个）
        expect(buildEmbeddingFingerprint({ ...BASE_CFG, dimensions: 512 })).not.toBe(fp);
        // 前缀方案不同 ⇒ 指纹不同（同一模型换前缀策略 = 另一个向量空间）
        expect(buildEmbeddingFingerprint({ ...BASE_CFG, prefixScheme: 'none-v1' })).not.toBe(fp);
        // 云端模型走独立指纹，不冒充本地
        const cloud = buildEmbeddingFingerprint({ ...BASE_CFG, model: 'BAAI/bge-m3', dimensions: 1024 });
        expect(cloud).not.toBe(fp);
        expect(cloud).toContain('provider:cloud');
        expect(fp).toContain('provider:local-gemma');
    });
});

describe('本地 EmbeddingGemma2 · 任务前缀（不双加）', () => {
    it('剥掉调用方误加的前缀，客户端自己绝不加前缀', () => {
        expect(stripTaskPrefixes('task: search result | query: 明天开会')).toEqual({
            text: '明天开会',
            stripped: true,
        });
        expect(stripTaskPrefixes('title: none | text: 明天开会')).toEqual({
            text: '明天开会',
            stripped: true,
        });
        expect(stripTaskPrefixes('  正常文本，没有前缀  ')).toEqual({
            text: '正常文本，没有前缀',
            stripped: false,
        });
        expect(prepareTaskInput('task: search result | query: task: search result | query: 双前缀'))
            .toBe('双前缀');
    });

    it('task=query 下发 query，缺省 task 下发 document，且 body 不含 dimensions', async () => {
        await embedTextsLocally(['查询文本'], { ...BASE_CFG, task: 'query' });
        await embedTextsLocally(['文档文本'], BASE_CFG);

        expect(calls).toHaveLength(2);
        expect(calls[0].body.task).toBe('query');
        expect(calls[0].body.input).toEqual(['查询文本']);
        expect(calls[1].body.task).toBe('document');
        // 服务端只暴露 768，传 dimensions 会被忽略；显式断言不发，避免误以为支持 MRL 入参
        expect('dimensions' in calls[0].body).toBe(false);
    });

    it('输入里已带前缀时，请求体里只剩一份前缀语义（客户端剥掉）', async () => {
        await embedTextsLocally(['task: search result | query: 合成文本'], { ...BASE_CFG, task: 'query' });
        expect(calls[0].body.input).toEqual(['合成文本']);
        expect(calls[0].body.task).toBe('query');
    });
});

describe('本地 EmbeddingGemma2 · 维度与 MRL', () => {
    it('默认 768 维原样返回 Float32Array', async () => {
        const out = await embedTextsLocally(['a'], BASE_CFG);
        expect(out.vectors).toHaveLength(1);
        expect(out.vectors[0]).toBeInstanceOf(Float32Array);
        expect(out.vectors[0].length).toBe(768);
    });

    it('MRL 截断到 256 维后重新归一（切片不保持单位长度）', async () => {
        installFetch(() => ({
            ok: true,
            status: 200,
            json: async () => ({
                data: [{ index: 0, embedding: new Array(768).fill(1) }],
            }),
        }) as any);
        const out = await embedTextsLocally(['a'], { ...BASE_CFG, mrlDimensions: 256 });
        const v = out.vectors[0];
        expect(v.length).toBe(256);
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
        expect(norm).toBeCloseTo(1, 5);
    });

    it('不支持的 MRL 维度直接拒绝（不做质量猜测）', () => {
        expect(() => sliceAndRenormalize(new Float32Array(768).fill(1), 300)).toThrow(LocalEmbeddingError);
        expect(() => l2Normalize(new Float32Array(0))).toThrow(LocalEmbeddingError);
    });

    it('服务端返回维度与期望不一致 ⇒ 显式报错，不写坏索引', async () => {
        installFetch(() => ({
            ok: true,
            status: 200,
            json: async () => ({ data: [{ index: 0, embedding: new Array(1024).fill(0.01) }] }),
        }) as any);
        await expect(embedTextsLocally(['a'], BASE_CFG)).rejects.toMatchObject({
            name: 'LocalEmbeddingError',
            code: 'dimension_mismatch',
        });
    });
});

describe('本地 EmbeddingGemma2 · 长度 / 批量 / 超时 / 取消', () => {
    it('单条超上限被截断并计数，批量不超过条数与字符预算', async () => {
        const long = 'x'.repeat(LOCAL_GEMMA_PROFILE.maxItemChars + 500);
        const many = Array.from({ length: 23 }, (_, i) => `短文本${i}`);
        const out = await embedTextsLocally([long, ...many], BASE_CFG);

        expect(out.truncatedCount).toBe(1);
        expect(out.vectors).toHaveLength(24);
        for (const call of calls) {
            expect(call.body.input.length).toBeLessThanOrEqual(LOCAL_GEMMA_PROFILE.maxBatchItems);
            const chars = call.body.input.reduce((s: number, t: string) => s + t.length, 0);
            expect(chars).toBeLessThanOrEqual(LOCAL_GEMMA_PROFILE.batchCharBudget);
        }
        // 顺序必须与输入严格对应（调用方按下标取向量）
        expect(calls[0].body.input[0].length).toBe(LOCAL_GEMMA_PROFILE.maxItemChars);
    });

    it('超时抛 timeout 且不再无限等', async () => {
        installFetch((_b, init) => new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }));
        await expect(embedTextsLocally(['a'], BASE_CFG, { timeoutMs: 30 })).rejects.toMatchObject({
            code: 'timeout',
        });
    });

    it('外部 signal 取消 ⇒ cancelled，已在途请求被 abort', async () => {
        const ac = new AbortController();
        installFetch((_b, init) => new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }));
        const p = embedTextsLocally(['a'], BASE_CFG, { signal: ac.signal, timeoutMs: 5000 });
        ac.abort();
        await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    });

    it('已取消的 signal 立即拒绝，不发请求', async () => {
        const ac = new AbortController();
        ac.abort();
        await expect(embedTextsLocally(['a'], BASE_CFG, { signal: ac.signal })).rejects.toMatchObject({
            code: 'cancelled',
        });
        expect(calls).toHaveLength(0);
    });

    it('5xx 重试一次，4xx 不重试（参数错重试无用）', async () => {
        let n = 0;
        installFetch((body) => {
            n++;
            if (n === 1) return { ok: false, status: 503, text: async () => 'upstream down' } as any;
            return {
                ok: true,
                status: 200,
                json: async () => ({ data: body.input.map((_t: string, i: number) => ({ index: i, embedding: unitVec(i) })) }),
            } as any;
        });
        const out = await embedTextsLocally(['a'], BASE_CFG);
        expect(out.vectors).toHaveLength(1);
        expect(calls).toHaveLength(2);

        calls = [];
        installFetch(() => ({ ok: false, status: 400, text: async () => 'bad request' }) as any);
        await expect(embedTextsLocally(['a'], BASE_CFG)).rejects.toMatchObject({ code: 'http', status: 400 });
        expect(calls).toHaveLength(1);
    });
});
