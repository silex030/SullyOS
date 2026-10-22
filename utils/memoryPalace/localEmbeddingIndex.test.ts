/**
 * 本地索引身份 / 迁移状态机契约测试（RED 先行）。
 *
 * 要点：
 *   - 换 embedding 身份后绝不隐式全量重建：只标记「待重建」，检索先降级到词法并告知。
 *   - 重建可中断、可恢复、有进度；取消后已完成的条目不重做。
 *   - 只覆盖每条记忆自己的向量，不删除任何节点/向量，失败保留旧向量。
 *   - 只有身份完全一致的向量才参与向量检索（新旧混用 = 静默错排序）。
 */
import { describe, expect, it, vi } from 'vitest';
import {
    IndexStatusStore,
    checkIndexIdentity,
    decideVectorUsage,
    describeIndexStatus,
    newIndexStatus,
    runIndexRebuild,
    surveyVectorIndex,
} from './localEmbeddingIndex';

const FP = 'provider:local-gemma|model:google/embeddinggemma-2|rev:914f7f89|dim:768|prefix:eg2-retrieval-v1|norm:l2';
const CLOUD_FP = 'provider:cloud|model:BAAI/bge-m3|rev:unknown|dim:1024|prefix:none|norm:provider';

function vecRow(memoryId: string, fingerprint: string | undefined, dims = 768) {
    return {
        memoryId,
        charId: 'c1',
        dimensions: dims,
        model: fingerprint?.includes('bge') ? 'BAAI/bge-m3' : 'google/embeddinggemma-2',
        fingerprint,
        vector: new Float32Array(dims).fill(0.1),
    } as any;
}

describe('surveyVectorIndex', () => {
    it('按指纹/维度统计，识别旧数据（无指纹）', () => {
        const survey = surveyVectorIndex(
            [
                vecRow('a', FP),
                vecRow('b', FP),
                vecRow('c', CLOUD_FP, 1024),
                vecRow('d', undefined, 1024),
            ],
            FP,
            768,
        );
        expect(survey.total).toBe(4);
        expect(survey.matches).toBe(2);
        expect(survey.mismatches).toBe(2);
        expect(survey.legacy).toBe(1);
        expect(survey.byFingerprint[FP]).toBe(2);
    });
});

describe('decideVectorUsage：混用禁止 + 词法降级', () => {
    it('全部匹配 ⇒ 可用向量，无需提示', () => {
        const d = decideVectorUsage(surveyVectorIndex([vecRow('a', FP)], FP, 768));
        expect(d.useVectors).toBe(true);
        expect(d.reason).toBe('ready');
        expect(d.notice).toBeUndefined();
    });

    it('部分匹配 ⇒ 只用匹配的子集，跳过条数进提示', () => {
        const d = decideVectorUsage(
            surveyVectorIndex([vecRow('a', FP), vecRow('b', CLOUD_FP, 1024)], FP, 768),
        );
        expect(d.useVectors).toBe(true);
        expect(d.reason).toBe('partial');
        expect(d.compatibleCount).toBe(1);
        expect(d.skippedCount).toBe(1);
        expect(d.notice).toContain('1');
        expect(d.notice).toMatch(/重建/);
    });

    it('全部不匹配 ⇒ 不用向量（词法兜底）并明确告知', () => {
        const d = decideVectorUsage(
            surveyVectorIndex([vecRow('b', CLOUD_FP, 1024), vecRow('c', undefined, 1024)], FP, 768),
        );
        expect(d.useVectors).toBe(false);
        expect(d.reason).toBe('pending_rebuild');
        expect(d.notice).toMatch(/词法|关键词/);
    });

    it('没有向量 ⇒ empty（不是错误）', () => {
        const d = decideVectorUsage(surveyVectorIndex([], FP, 768));
        expect(d.useVectors).toBe(false);
        expect(d.reason).toBe('empty');
    });
});

describe('状态持久化与身份检查', () => {
    function memStore() {
        const map = new Map<string, string>();
        const storage = {
            getItem: (k: string) => map.get(k) ?? null,
            setItem: (k: string, v: string) => { map.set(k, v); },
            removeItem: (k: string) => { map.delete(k); },
        };
        return new IndexStatusStore(storage as any);
    }

    it('只标记待重建，不触发任何重建动作', async () => {
        const store = memStore();
        const res = await checkIndexIdentity({
            charId: 'c1',
            expectedFingerprint: FP,
            expectedDimensions: 768,
            vectors: [vecRow('a', CLOUD_FP, 1024)],
            store,
        });
        expect(res.status).toBe('pending_rebuild');
        expect(res.decision.useVectors).toBe(false);
        const status = store.get('c1');
        expect(status?.state).toBe('pending_rebuild');
        expect(status?.expectedFingerprint).toBe(FP);
        expect(status?.notice).toMatch(/重建/);
    });

    it('身份一致 ⇒ ready，并清掉旧的待重建标记', async () => {
        const store = memStore();
        store.set('c1', { ...newIndexStatus('c1', FP, 768), state: 'pending_rebuild', total: 1 });
        const res = await checkIndexIdentity({
            charId: 'c1',
            expectedFingerprint: FP,
            expectedDimensions: 768,
            vectors: [vecRow('a', FP)],
            store,
        });
        expect(res.status).toBe('ready');
        expect(store.get('c1')?.state).toBe('ready');
    });

    it('describeIndexStatus 给出人话进度（含待重建条数）', () => {
        const s = {
            ...newIndexStatus('c1', FP, 768),
            state: 'rebuilding' as const,
            total: 10,
            done: 4,
            failed: 1,
        };
        const text = describeIndexStatus(s);
        expect(text).toContain('4');
        expect(text).toContain('10');
        expect(text).toMatch(/重建/);
    });
});

describe('runIndexRebuild：可中断 / 可恢复 / 不删除', () => {
    const nodes = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, charId: 'c1', content: `正文${i}` }));

    function deps(overrides: Partial<{ save: any; embed: any }> = {}) {
        return {
            listNodes: async () => nodes,
            embed: overrides.embed ?? (async (texts: string[]) => texts.map(() => new Float32Array(768).fill(0.01))),
            save: overrides.save ?? vi.fn(async () => undefined),
            now: () => 1_000,
        };
    }

    it('全部成功 ⇒ ready，逐条写入指纹与实际维度', async () => {
        const store = new IndexStatusStore({ getItem: () => null, setItem: () => {}, removeItem: () => {} } as any);
        const d = deps();
        const out = await runIndexRebuild({
            charId: 'c1',
            expectedFingerprint: FP,
            expectedDimensions: 768,
            store,
            deps: d,
            batchSize: 2,
        });
        expect(out.state).toBe('ready');
        expect(d.save).toHaveBeenCalledTimes(6);
        const firstCall = (d.save as any).mock.calls[0];
        expect(firstCall[0].id).toBe('n0');
        expect(firstCall[1].length).toBe(768);
        expect(firstCall[2]).toBe(FP);
        expect(store.get('c1')?.state).toBe('ready');
    });

    it('中途取消 ⇒ cancelled 且进度保留；恢复时跳过已完成条目', async () => {
        const ac = new AbortController();
        const store = new IndexStatusStore({ getItem: () => null, setItem: () => {}, removeItem: () => {} } as any);
        const save = vi.fn(async () => undefined);
        const d = deps({ save });

        const out = await runIndexRebuild({
            charId: 'c1',
            expectedFingerprint: FP,
            expectedDimensions: 768,
            store,
            deps: d,
            batchSize: 1,
            signal: ac.signal,
            onProgress: (p) => {
                if (p.done >= 2) ac.abort();
            },
        });
        expect(out.state).toBe('cancelled');
        expect(out.done).toBe(2);
        expect(save).toHaveBeenCalledTimes(2);
        expect(store.get('c1')?.state).toBe('cancelled');

        const resumed = await runIndexRebuild({
            charId: 'c1',
            expectedFingerprint: FP,
            expectedDimensions: 768,
            store,
            deps: d,
            batchSize: 1,
            resume: true,
        });
        expect(resumed.state).toBe('ready');
        // 恢复只补剩下的 4 条
        expect(save).toHaveBeenCalledTimes(6);
    });

    it('单条失败不中断其它条目，状态记 failed 并保留进度', async () => {
        const store = new IndexStatusStore({ getItem: () => null, setItem: () => {}, removeItem: () => {} } as any);
        let n = 0;
        const save = vi.fn(async () => {
            n++;
            if (n === 3) throw new Error('quota exceeded');
        });
        const out = await runIndexRebuild({
            charId: 'c1',
            expectedFingerprint: FP,
            expectedDimensions: 768,
            store,
            deps: deps({ save }),
            batchSize: 1,
        });
        expect(out.state).toBe('failed');
        expect(out.failed).toBe(1);
        expect(out.done).toBe(5);
        expect(store.get('c1')?.lastError).toContain('quota');
    });
});
