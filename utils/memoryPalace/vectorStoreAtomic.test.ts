/**
 * B3 回归：记忆正文与向量必须同一个事务提交。
 *
 * 故障注入只发生在内存里的 fake-indexeddb 上（临时库），不碰真实数据：
 * 把 `memory_vectors` 的 put 打成抛错，验证事务回滚后
 *   ① 旧正文 / 旧向量同时保留；
 *   ② 不会留下「embedded=true 但向量还是旧的」这种假完成；
 * 去掉故障后再跑一次，验证新正文 / 新向量同时生效。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const embeddingMock = vi.hoisted(() => ({
    getEmbeddings: vi.fn<(texts: string[]) => Promise<Float32Array[]>>(),
}));

vi.mock('./embedding', () => ({
    getEmbeddings: embeddingMock.getEmbeddings,
    cosineSimilarity: () => 0,
}));

import { openDB } from '../db';
import { MemoryNodeDB, MemoryVectorDB } from './db';
import { updateStoredMemoryNode, vectorizeAndStore } from './vectorStore';
import type { EmbeddingConfig, MemoryNode } from './types';

const CHAR_ID = 'atomic-test-character';
const NODE_ID = 'atomic-test-node';

const CFG: EmbeddingConfig = {
    baseUrl: 'http://embed-test.local/v1',
    apiKey: 'embed-test-key',
    model: 'test-embed',
    dimensions: 4,
};

const OLD_VECTOR = [0, 1, 0, 0];
const NEW_VECTOR = [1, 0, 0, 0];

const NODE: MemoryNode = {
    id: NODE_ID,
    charId: CHAR_ID,
    content: '旧正文',
    room: 'living_room',
    tags: [],
    importance: 5,
    mood: 'neutral',
    embedded: true,
    createdAt: 1,
    lastAccessedAt: 1,
    accessCount: 0,
};

const originalPut = IDBObjectStore.prototype.put;
let vectorFaultArmed = false;

function armVectorPutFault(): void {
    vectorFaultArmed = true;
    (IDBObjectStore.prototype as any).put = function patchedPut(this: IDBObjectStore, ...args: any[]) {
        if (vectorFaultArmed && this.name === 'memory_vectors') {
            // 模拟配额不足 / 磁盘错误：真正写盘那一刻失败。
            throw new Error('injected vector write failure');
        }
        return (originalPut as any).apply(this, args);
    };
}

function disarmVectorPutFault(): void {
    vectorFaultArmed = false;
    (IDBObjectStore.prototype as any).put = originalPut;
}

async function resetNode(): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['memory_nodes', 'memory_vectors'], 'readwrite');
        tx.objectStore('memory_nodes').delete(NODE_ID);
        tx.objectStore('memory_vectors').delete(NODE_ID);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function seedOldPair(): Promise<void> {
    await MemoryNodeDB.save({ ...NODE });
    await MemoryVectorDB.save({
        memoryId: NODE_ID,
        charId: CHAR_ID,
        vector: new Float32Array(OLD_VECTOR),
        dimensions: 4,
        model: 'test-embed',
    });
}

async function readVector(): Promise<number[] | null> {
    const vec = await MemoryVectorDB.getByMemoryId(NODE_ID);
    return vec ? Array.from(vec.vector as Float32Array) : null;
}

beforeEach(async () => {
    await resetNode();
    disarmVectorPutFault();
    embeddingMock.getEmbeddings.mockReset();
    embeddingMock.getEmbeddings.mockImplementation(async (texts: string[]) =>
        texts.map(() => new Float32Array(NEW_VECTOR)),
    );
});

afterEach(async () => {
    disarmVectorPutFault();
    await resetNode();
});

describe('updateStoredMemoryNode · 正文 + 向量原子提交', () => {
    it('向量写盘失败时，旧正文与旧向量同时保留，不留假 embedded 完成态', async () => {
        await seedOldPair();
        armVectorPutFault();

        await expect(
            updateStoredMemoryNode(NODE_ID, { content: '新正文' }, CFG),
        ).rejects.toThrow(/injected vector write failure|vector/i);

        const node = await MemoryNodeDB.getById(NODE_ID);
        expect(node?.content).toBe('旧正文');
        expect(node?.embedded).toBe(true);
        await expect(readVector()).resolves.toEqual(OLD_VECTOR);
    });

    it('成功时新正文与新向量同时生效', async () => {
        await seedOldPair();

        const result = await updateStoredMemoryNode(NODE_ID, { content: '新正文' }, CFG);

        expect(result.reembedded).toBe(true);
        expect(result.node.embedded).toBe(true);
        const node = await MemoryNodeDB.getById(NODE_ID);
        expect(node?.content).toBe('新正文');
        expect(node?.embedded).toBe(true);
        await expect(readVector()).resolves.toEqual(NEW_VECTOR);
    });

    it('故障修好后重试一次即可补齐（不留半截状态）', async () => {
        await seedOldPair();
        armVectorPutFault();
        await expect(updateStoredMemoryNode(NODE_ID, { content: '新正文' }, CFG)).rejects.toThrow();

        disarmVectorPutFault();
        await updateStoredMemoryNode(NODE_ID, { content: '新正文' }, CFG);

        const node = await MemoryNodeDB.getById(NODE_ID);
        expect(node?.content).toBe('新正文');
        expect(node?.embedded).toBe(true);
        await expect(readVector()).resolves.toEqual(NEW_VECTOR);
    });
});

describe('vectorizeAndStore · 首写也不许假完成', () => {
    it('向量写盘失败时，新节点的 embedded 仍是 false（正文留在库里可重试）', async () => {
        const fresh: MemoryNode = { ...NODE, id: 'atomic-fresh-node', content: '第一次写入', embedded: false };
        armVectorPutFault();

        await expect(vectorizeAndStore([fresh], CFG)).rejects.toThrow();

        const stored = await MemoryNodeDB.getById('atomic-fresh-node');
        // 关键：要么整条没留下，要么留下了也必须是 embedded=false；不许 embedded=true 却没有向量。
        if (stored) expect(stored.embedded).toBe(false);
        await expect(MemoryVectorDB.getByMemoryId('atomic-fresh-node')).resolves.toBeUndefined();
        expect(fresh.embedded).toBe(false);

        // 清理这条临时记录
        disarmVectorPutFault();
        await MemoryNodeDB.delete('atomic-fresh-node');
    });

    it('正常写入时正文与向量同时落库', async () => {
        const fresh: MemoryNode = { ...NODE, id: 'atomic-fresh-node-2', content: '第一次写入', embedded: false };

        const outcome = await vectorizeAndStore([fresh], CFG);

        expect(outcome.stored).toBe(1);
        const stored = await MemoryNodeDB.getById('atomic-fresh-node-2');
        expect(stored?.embedded).toBe(true);
        await expect(
            MemoryVectorDB.getByMemoryId('atomic-fresh-node-2').then((v) => (v ? Array.from(v.vector as Float32Array) : null)),
        ).resolves.toEqual(NEW_VECTOR);

        await MemoryNodeDB.delete('atomic-fresh-node-2');
        await MemoryVectorDB.delete('atomic-fresh-node-2');
    });
});
