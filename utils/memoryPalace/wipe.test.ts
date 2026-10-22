/**
 * 一键清空的 P0 回归：
 *  - B1 两份水位都要清（localStorage + IndexedDB 资产镜像），旧聊天才会被重新处理；
 *    只清与记忆宫殿相关的前缀，别的 assets 一条不动。
 *  - B2 远端清空必须显式区分 成功 / 失败 / 跳过；失败不许伪装成「0 行成功」；
 *    本地已完成 + 云端失败时，云端可以单独重试。
 *
 * 全程 fake-indexeddb + fake fetch，不碰真实数据、不发真实请求。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB, openDB } from '../db';
import {
    getLocalMemoryPalaceHighWaterMark,
    getReliableMemoryPalaceHighWaterMark,
} from './highWaterMark';
import { retryRemoteWipe, wipeAllMemoryPalace } from './wipe';
import type { RemoteVectorConfig } from './types';

const CHAR_ID = 'wipe-test-character';
const LOCAL_KEY = `mp_lastMsgId_${CHAR_ID}`;
const MIRROR_KEY = `mp_hwm_v1_${CHAR_ID}`;
const UNRELATED_ASSET = 'wipe-test-unrelated-asset';

const REMOTE: RemoteVectorConfig = {
    enabled: true,
    initialized: true,
    supabaseUrl: 'https://wipe-test.supabase.co',
    supabaseAnonKey: 'anon-test-key-must-not-leak',
};

const MP_STORES = [
    'memory_nodes',
    'memory_vectors',
    'memory_links',
    'memory_batches',
    'topic_boxes',
    'anticipations',
    'event_boxes',
    'room_plates',
    'digest_reports',
];

async function rawPut(storeName: string, value: any): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(value);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function rawCount(storeName: string): Promise<number> {
    const db = await openDB();
    return await new Promise<number>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).count();
        req.onsuccess = () => resolve(req.result || 0);
        req.onerror = () => reject(req.error);
    });
}

async function clearStores(): Promise<void> {
    const db = await openDB();
    const present = MP_STORES.filter((name) => db.objectStoreNames.contains(name));
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(present, 'readwrite');
        for (const name of present) tx.objectStore(name).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** 造一份「已处理过聊天」的状态：内存里两条记忆 + 两份水位 + 一条无关资产。 */
async function seedWipedState(): Promise<void> {
    await rawPut('memory_nodes', { id: 'wipe-node-1', charId: CHAR_ID, content: '旧记忆一', embedded: false });
    await rawPut('memory_nodes', { id: 'wipe-node-2', charId: CHAR_ID, content: '旧记忆二', embedded: false });
    await rawPut('memory_vectors', { memoryId: 'wipe-node-1', charId: CHAR_ID, vector: new Uint8Array(16), dimensions: 4 });
    await rawPut('anticipations', { id: 'wipe-ant-1', charId: CHAR_ID, status: 'active' });

    localStorage.setItem(LOCAL_KEY, '999');
    await DB.saveAssetRaw(MIRROR_KEY, { version: 1, charId: CHAR_ID, msgId: 999, updatedAt: 1 });
    await DB.saveAssetRaw(UNRELATED_ASSET, { keep: 'me' });
}

describe('wipeAllMemoryPalace · B1 两份水位一起清', () => {
    beforeEach(async () => {
        await clearStores();
        localStorage.clear();
        localStorage.removeItem(LOCAL_KEY);
        await DB.deleteAsset(MIRROR_KEY).catch(() => {});
        await DB.deleteAsset(UNRELATED_ASSET).catch(() => {});
        await seedWipedState();
    });

    it('清空后 localStorage 与 IndexedDB 镜像都归零，旧聊天能重新进入处理范围', async () => {
        // 前置：镜像让水位即便 localStorage 丢了也能恢复（这是清空前必须一起清掉的原因）。
        localStorage.removeItem(LOCAL_KEY);
        await expect(getReliableMemoryPalaceHighWaterMark(CHAR_ID)).resolves.toBe(999);
        localStorage.setItem(LOCAL_KEY, '999');

        const result = await wipeAllMemoryPalace({ skipRemote: true });

        expect(localStorage.getItem(LOCAL_KEY)).toBeNull();
        expect(getLocalMemoryPalaceHighWaterMark(CHAR_ID)).toBe(0);
        await expect(DB.getAssetRaw(MIRROR_KEY)).resolves.toBeNull();
        // 关键回归：以前镜像还在，这里会拿回 999，旧聊天永远不再被提取。
        await expect(getReliableMemoryPalaceHighWaterMark(CHAR_ID)).resolves.toBe(0);
        expect(result.highWatermarks).toBeGreaterThanOrEqual(2);
    });

    it('只有镜像、localStorage 已被浏览器清掉时，镜像也要被清干净', async () => {
        // 真实故障场景：第三方浏览器清了 localStorage，只剩 IndexedDB 镜像。
        localStorage.removeItem(LOCAL_KEY);
        await expect(getReliableMemoryPalaceHighWaterMark(CHAR_ID)).resolves.toBe(999);

        const result = await wipeAllMemoryPalace({ skipRemote: true });

        expect(result.highWatermarks).toBeGreaterThanOrEqual(1);
        await expect(DB.getAssetRaw(MIRROR_KEY)).resolves.toBeNull();
        await expect(getReliableMemoryPalaceHighWaterMark(CHAR_ID)).resolves.toBe(0);
    });

    it('本地记忆表被清空，但不相干的 assets 原样保留', async () => {
        const result = await wipeAllMemoryPalace({ skipRemote: true });

        expect(await rawCount('memory_nodes')).toBe(0);
        expect(await rawCount('memory_vectors')).toBe(0);
        expect(await rawCount('anticipations')).toBe(0);
        expect(result.localRowsTotal).toBeGreaterThanOrEqual(4);
        await expect(DB.getAssetRaw(UNRELATED_ASSET)).resolves.toEqual({ keep: 'me' });
    });

    it('不传 remoteConfig 时云端一律记为 skipped，且不是 0 行删除', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        const result = await wipeAllMemoryPalace({ skipRemote: true });

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(result.remote.status).toBe('skipped');
        expect(result.remote.deleted).toBeNull();
        expect(result.remoteAttempted).toBe(false);
    });
});

describe('wipeAllMemoryPalace · B2 远端清空结果显式化', () => {
    beforeEach(async () => {
        await clearStores();
        localStorage.clear();
        await DB.deleteAsset(MIRROR_KEY).catch(() => {});
        await seedWipedState();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('DELETE 成功且带回行数 → success + 行数', async () => {
        const fetchMock = vi.fn(async () =>
            new Response(null, { status: 200, headers: { 'content-range': '0-2/3' } }),
        );
        vi.stubGlobal('fetch', fetchMock);

        const result = await wipeAllMemoryPalace({ remoteConfig: REMOTE });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.remote.status).toBe('success');
        expect(result.remote.deleted).toBe(3);
        expect(result.remoteAttempted).toBe(true);
        expect(result.remote.httpStatus).toBe(200);
    });

    it('服务端回 4xx/5xx → failed + 原因，绝不显示成 0 行成功；本地仍然算清干净', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('permission denied', { status: 403 })));

        const result = await wipeAllMemoryPalace({ remoteConfig: REMOTE });

        expect(result.remote.status).toBe('failed');
        expect(result.remote.deleted).toBeNull();
        expect(result.remote.httpStatus).toBe(403);
        expect(result.remote.error).toContain('403');
        // key 不许出现在给用户看的错误里。
        expect(JSON.stringify(result.remote)).not.toContain(REMOTE.supabaseAnonKey);
        expect(result.localRowsTotal).toBeGreaterThan(0);
        await expect(getReliableMemoryPalaceHighWaterMark(CHAR_ID)).resolves.toBe(0);
    });

    it('网络异常 → failed（不是 0 行成功），wipe 本身不抛', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('network down');
        }));

        const result = await wipeAllMemoryPalace({ remoteConfig: REMOTE });

        expect(result.remote.status).toBe('failed');
        expect(result.remote.deleted).toBeNull();
        expect(result.remote.error).toContain('network down');
    });

    it('2xx 但没给 content-range → 行数未知（null），不能填 0', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));

        const result = await wipeAllMemoryPalace({ remoteConfig: REMOTE });

        expect(result.remote.status).toBe('success');
        expect(result.remote.deleted).toBeNull();
    });

    it('本地已完成、云端失败 → retryRemoteWipe 只重试云端并拿到结果', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
        const first = await wipeAllMemoryPalace({ remoteConfig: REMOTE });
        expect(first.remote.status).toBe('failed');
        expect(first.localRowsTotal).toBeGreaterThan(0);

        // 本地不会被再清一遍：重试入口只碰云端。
        const okMock = vi.fn(async () =>
            new Response(null, { status: 200, headers: { 'content-range': '0-4/5' } }),
        );
        vi.stubGlobal('fetch', okMock);
        const retry = await retryRemoteWipe(REMOTE);

        expect(okMock).toHaveBeenCalledTimes(1);
        expect(retry.status).toBe('success');
        expect(retry.deleted).toBe(5);
    });

    it('未启用 / 未初始化的远端配置走 skipped，不发请求', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        const result = await retryRemoteWipe({ ...REMOTE, initialized: false });

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(result.status).toBe('skipped');
    });
});
