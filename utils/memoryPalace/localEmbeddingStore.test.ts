/**
 * 落库侧的索引身份回归：
 *   - 写进 memory_vectors 的 dimensions 必须是向量实际长度（MRL/换维度后不能还写配置值）；
 *   - 每条向量都要带指纹，否则「同维度不同模型」会让检索静默失真；
 *   - 重建可取消：取消后已写入的保留，不删除、不回滚。
 *
 * 故障/取消都只发生在内存 fake-indexeddb 上，不碰真实用户库。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const embeddingMock = vi.hoisted(() => ({
    getEmbeddings: vi.fn<(texts: string[], config?: unknown) => Promise<Float32Array[]>>(),
}));

vi.mock('./embedding', () => ({
    getEmbeddings: embeddingMock.getEmbeddings,
    cosineSimilarity: () => 0,
}));

import { MemoryVectorDB, MemoryNodeDB } from './db';
import { rebuildAllVectors, vectorizeAndStore } from './vectorStore';
import type { EmbeddingConfig, MemoryNode } from './types';

const CHAR = 'local-emb-index-character';

function node(id: string): MemoryNode {
    return {
        id,
        charId: CHAR,
        content: `记忆正文 ${id}`,
        room: 'living_room',
        tags: [],
        importance: 5,
        mood: 'neutral',
        embedded: true,
        createdAt: 1,
        lastAccessedAt: 1,
        accessCount: 0,
    } as MemoryNode;
}

const CFG: EmbeddingConfig = {
    baseUrl: 'https://agent.example/agent/v1/local-embedding',
    apiKey: 'agent-client-token',
    model: 'google/embeddinggemma-2',
    dimensions: 768,
};

beforeEach(async () => {
    embeddingMock.getEmbeddings.mockReset();
    // 同一进程里多个用例共用 fake-indexeddb：节点和向量都要清，否则重建会捎带上
    // 上一个用例的节点，进度/条数断言就变成随机失败
    for (const v of await MemoryVectorDB.getAllByCharId(CHAR)) {
        await MemoryVectorDB.delete(v.memoryId);
    }
    for (const n of await MemoryNodeDB.getByCharId(CHAR)) {
        await MemoryNodeDB.delete(n.id);
    }
});

describe('memory_vectors 落库身份', () => {
    it('dimensions 校正为实际长度（配置写 768、实际 4 维时以实际为准）', async () => {
        await MemoryVectorDB.save({
            memoryId: 'dim-probe',
            charId: CHAR,
            vector: new Float32Array([1, 0, 0, 0]),
            dimensions: 768,
            model: 'google/embeddinggemma-2',
        } as any);
        const stored = await MemoryVectorDB.getByMemoryId('dim-probe');
        expect(stored?.dimensions).toBe(4);
        expect((stored?.vector as Float32Array).length).toBe(4);
    });

    it('vectorizeAndStore 写入指纹 + 实际维度（MRL 512 时不能写 768）', async () => {
        embeddingMock.getEmbeddings.mockImplementation(async (texts: string[]) =>
            texts.map(() => new Float32Array(512).fill(0.01)),
        );
        const n = node('fp-probe');
        await MemoryNodeDB.save(n);
        await vectorizeAndStore([n], { ...CFG, mrlDimensions: 512 } as any);

        const stored = await MemoryVectorDB.getByMemoryId('fp-probe');
        expect(stored?.dimensions).toBe(512);
        expect((stored as any)?.fingerprint).toContain('provider:local-gemma');
        expect((stored as any)?.fingerprint).toContain('dim:512');
        // 建索引必须是 document 语义
        expect((embeddingMock.getEmbeddings.mock.calls[0][1] as any)?.task).toBe('document');
    });

    it('rebuildAllVectors 取消后保留已写入的向量，且报告真实进度', async () => {
        embeddingMock.getEmbeddings.mockImplementation(async (texts: string[]) =>
            texts.map(() => new Float32Array(768).fill(0.02)),
        );
        const nodes = [node('rb-1'), node('rb-2'), node('rb-3')];
        for (const n of nodes) await MemoryNodeDB.save(n);

        const ac = new AbortController();
        const progress: number[] = [];
        const out = await rebuildAllVectors(CHAR, CFG as any, undefined, {
            signal: ac.signal,
            onProgress: (done) => {
                progress.push(done);
                if (done >= 2) ac.abort();
            },
        });

        expect(out.rebuilt).toBe(2);
        expect(progress).toEqual([1, 2]);
        const stored = await MemoryVectorDB.getAllByCharId(CHAR);
        const ids = stored.filter(v => v.memoryId.startsWith('rb-')).map(v => v.memoryId).sort();
        expect(ids).toEqual(['rb-1', 'rb-2']);
        // 节点本身一条都不能少
        const allNodes = await MemoryNodeDB.getByCharId(CHAR);
        expect(allNodes.filter(n => n.id.startsWith('rb-'))).toHaveLength(3);
    });
});
