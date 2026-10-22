/**
 * 写入侧的空间隔离：去重只能在「同一个向量空间」里做。
 *
 * 现场：用户从云端 bge-m3（1024）切到本地 EmbeddingGemma2（768）时，库里还躺着旧向量。
 * 旧实现把新向量直接和**所有**已有向量算 cosine：
 *   - 维度不等 → `cosineSimilarity` throw，整条新记忆写入失败（用户看到"存不进记忆"）；
 *   - 若碰巧同维度 → 旧模型的相似度是噪声，可能把本该写入的新记忆判成重复而丢掉。
 *
 * 这里用 fake-indexeddb 的真实库验证：跨空间不比较、不丢写；同空间仍然正常去重；
 * 落库的向量带当前指纹（供检索侧严格匹配）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const embeddingMock = vi.hoisted(() => ({
    getEmbeddings: vi.fn<(texts: string[]) => Promise<Float32Array[]>>(),
}));

vi.mock('./embedding', () => ({
    getEmbeddings: embeddingMock.getEmbeddings,
    cosineSimilarity: (a: ArrayLike<number>, b: ArrayLike<number>) => {
        if (a.length !== b.length) throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
        let dot = 0;
        for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
        return dot;
    },
}));

import { openDB } from '../db';
import { MemoryNodeDB, MemoryVectorDB } from './db';
import { vectorizeAndStore } from './vectorStore';
import { buildEmbeddingFingerprint } from './localEmbedding';
import type { EmbeddingConfig, MemoryNode } from './types';

const CHAR_ID = 'fingerprint-dedupe-char';
const OLD_ID = 'fingerprint-old-node';
const NEW_ID = 'fingerprint-new-node';

const LOCAL_CFG: EmbeddingConfig = {
    baseUrl: 'https://agent.example/agent/v1/local-embedding',
    apiKey: 'agent-token',
    model: 'google/embeddinggemma-2',
    dimensions: 768,
    provider: 'local-gemma',
    prefixScheme: 'eg2-retrieval-v1',
};

const CLOUD_CFG: EmbeddingConfig = {
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: 'sk-test',
    model: 'BAAI/bge-m3',
    dimensions: 1024,
};

const LOCAL_FP = buildEmbeddingFingerprint(LOCAL_CFG);
const CLOUD_FP = buildEmbeddingFingerprint(CLOUD_CFG);

function unitVector(dims: number, first = 1): Float32Array {
    const v = new Float32Array(dims);
    v[0] = first;
    return v;
}

const NODE: MemoryNode = {
    id: NEW_ID,
    charId: CHAR_ID,
    content: '新记忆：换模型期间写入',
    room: 'living_room',
    tags: [],
    importance: 5,
    mood: 'neutral',
    embedded: true,
    createdAt: 1,
    lastAccessedAt: 1,
    accessCount: 0,
};

async function wipe(): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['memory_nodes', 'memory_vectors'], 'readwrite');
        for (const id of [OLD_ID, NEW_ID]) {
            tx.objectStore('memory_nodes').delete(id);
            tx.objectStore('memory_vectors').delete(id);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function seedOld(dims: number, model: string, fingerprint?: string): Promise<void> {
    await MemoryVectorDB.save({
        memoryId: OLD_ID,
        charId: CHAR_ID,
        vector: unitVector(dims),
        dimensions: dims,
        model,
        ...(fingerprint ? { fingerprint } : {}),
    });
}

beforeEach(async () => {
    await wipe();
    embeddingMock.getEmbeddings.mockReset();
    embeddingMock.getEmbeddings.mockImplementation(async (texts: string[]) =>
        texts.map(() => unitVector(768)),
    );
});

afterEach(async () => {
    await wipe();
});

describe('vectorizeAndStore — 去重只在同一向量空间内', () => {
    it('库里是旧云端 1024 维向量时，本地 768 维新记忆照常写入（不 throw、不误判重复）', async () => {
        await seedOld(1024, 'BAAI/bge-m3');
        const result = await vectorizeAndStore([{ ...NODE }], LOCAL_CFG);
        expect(result).toEqual({ stored: 1, skipped: 0 });
        const stored = await MemoryVectorDB.getByMemoryId(NEW_ID);
        expect(stored?.dimensions).toBe(768);
        expect(stored?.fingerprint).toBe(LOCAL_FP);
    });

    it('同维度但另一个模型（指纹不同）不参与去重比较', async () => {
        await seedOld(768, 'other/768-model', 'provider:local-gemma|model:other/768-model|rev:x|dim:768|prefix:other-v1|norm:l2');
        const result = await vectorizeAndStore([{ ...NODE }], LOCAL_CFG);
        expect(result).toEqual({ stored: 1, skipped: 0 });
    });

    it('同一身份向量仍然按 0.9 阈值去重（新记忆被判重复，保持旧行为）', async () => {
        await seedOld(768, 'google/embeddinggemma-2', LOCAL_FP);
        const result = await vectorizeAndStore([{ ...NODE }], LOCAL_CFG);
        expect(result).toEqual({ stored: 0, skipped: 1 });
    });

    it('云端配置缺 dimensions 时，指纹用向量真实长度（不会写成 dim:0 导致永远匹配不上）', async () => {
        embeddingMock.getEmbeddings.mockImplementation(async (texts: string[]) =>
            texts.map(() => unitVector(1024)),
        );
        // 老配置/角色级配置可能只有 baseUrl/key/model，没有 dimensions
        const cfgWithoutDims = { ...CLOUD_CFG, dimensions: undefined } as unknown as EmbeddingConfig;
        const result = await vectorizeAndStore([{ ...NODE }], cfgWithoutDims);
        expect(result).toEqual({ stored: 1, skipped: 0 });
        const stored = await MemoryVectorDB.getByMemoryId(NEW_ID);
        expect(stored?.fingerprint).toContain('dim:1024');
        expect(stored?.fingerprint).toBe(
            buildEmbeddingFingerprint(cfgWithoutDims, { dimensions: 1024 }),
        );

        // 同一配置再写一次同样的记忆：身份一致 ⇒ 仍然按 0.9 去重（证明读写两侧指纹同源）
        const second = await vectorizeAndStore([{ ...NODE }], cfgWithoutDims);
        expect(second).toEqual({ stored: 0, skipped: 1 });
    });

    it('云端新写入也带云端指纹（供检索侧严格匹配）', async () => {
        embeddingMock.getEmbeddings.mockImplementation(async (texts: string[]) =>
            texts.map(() => unitVector(1024)),
        );
        const result = await vectorizeAndStore([{ ...NODE }], CLOUD_CFG);
        expect(result).toEqual({ stored: 1, skipped: 0 });
        const stored = await MemoryVectorDB.getByMemoryId(NEW_ID);
        expect(stored?.fingerprint).toBe(CLOUD_FP);
    });
});
