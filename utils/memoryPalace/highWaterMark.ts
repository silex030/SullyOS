import { DB, openDB } from '../db';

const LOCAL_KEY = (charId: string) => `mp_lastMsgId_${charId}`;
const MIRROR_KEY = (charId: string) => `mp_hwm_v1_${charId}`;

/**
 * 两份水位的键前缀。
 *
 * 清空逻辑必须同时认这两个前缀：只清 localStorage 的话，`getReliable…` 会从
 * IndexedDB 镜像把旧水位读回来，历史聊天永远进不了下一轮处理。
 */
const LOCAL_KEY_PREFIX = 'mp_lastMsgId_';
const MIRROR_KEY_PREFIX = 'mp_hwm_v1_';
const ASSET_STORE = 'assets';

interface HighWaterMarkMirror {
    version: 1;
    charId: string;
    msgId: number;
    updatedAt: number;
}

function normalizeMessageId(value: unknown): number {
    const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

/** 同步读取供聊天上下文过滤使用；后台管线会再用 IndexedDB 镜像校准。 */
export function getLocalMemoryPalaceHighWaterMark(charId: string): number {
    try {
        return normalizeMessageId(localStorage.getItem(LOCAL_KEY(charId)));
    } catch {
        return 0;
    }
}

/**
 * 读取 localStorage 与 IndexedDB 中较新的水位线。
 *
 * 部分第三方移动浏览器会只清理/隔离 localStorage，却保留 IndexedDB 中的消息。
 * 水位线是单调递增值，因此取两者最大值既能修复这种驱逐，也不会覆盖更新的数据。
 */
export async function getReliableMemoryPalaceHighWaterMark(charId: string): Promise<number> {
    const localValue = getLocalMemoryPalaceHighWaterMark(charId);
    let mirroredValue = 0;

    try {
        const mirror = await DB.getAssetRaw(MIRROR_KEY(charId)) as Partial<HighWaterMarkMirror> | number | null;
        mirroredValue = normalizeMessageId(typeof mirror === 'number' ? mirror : mirror?.msgId);
    } catch {
        // IndexedDB 本身不可用时仍可使用 localStorage，不扩大故障范围。
        return localValue;
    }

    const reliableValue = Math.max(localValue, mirroredValue);

    if (reliableValue > localValue) {
        try {
            localStorage.setItem(LOCAL_KEY(charId), String(reliableValue));
        } catch {
            // 第三方浏览器可能禁止 localStorage 写入；IndexedDB 镜像仍可继续工作。
        }
    }

    if (reliableValue > mirroredValue) {
        try {
            await DB.saveAssetRaw(MIRROR_KEY(charId), {
                version: 1,
                charId,
                msgId: reliableValue,
                updatedAt: Date.now(),
            } satisfies HighWaterMarkMirror);
        } catch {
            // 镜像失败不阻断原有 localStorage 路径。
        }
    }

    return reliableValue;
}

/** 成功处理消息后同时写两份；任意一份幸存即可避免旧消息被整批重复提取。 */
export async function setReliableMemoryPalaceHighWaterMark(charId: string, msgId: number): Promise<void> {
    const normalized = normalizeMessageId(msgId);

    try {
        localStorage.setItem(LOCAL_KEY(charId), String(normalized));
    } catch {
        // 继续尝试 IndexedDB。
    }

    try {
        await DB.saveAssetRaw(MIRROR_KEY(charId), {
            version: 1,
            charId,
            msgId: normalized,
            updatedAt: Date.now(),
        } satisfies HighWaterMarkMirror);
    } catch {
        // 与旧行为一致：持久化故障不抹掉已经成功写入的记忆。
    }
}

/**
 * 清掉 assets 表里所有以 `prefix` 开头的键（只动这个前缀，别的资产一条不碰）。
 *
 * 清空操作必须「说到做到」：删除失败要抛出去，不能静默跳过——静默跳过会让
 * 界面显示「高水位已清」而镜像里还躺着旧值，用户以为旧聊天能重新处理，其实不能。
 */
async function deleteAssetsByPrefix(prefix: string): Promise<number> {
    const db = await openDB();
    if (!db.objectStoreNames.contains(ASSET_STORE)) return 0;

    return await new Promise<number>((resolve, reject) => {
        const tx = db.transaction(ASSET_STORE, 'readwrite');
        const store = tx.objectStore(ASSET_STORE);
        let removed = 0;
        const req = store.getAllKeys();
        req.onsuccess = () => {
            const keys = (req.result || []).filter(
                (key): key is string => typeof key === 'string' && key.startsWith(prefix),
            );
            for (const key of keys) store.delete(key);
            removed = keys.length;
        };
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => resolve(removed);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('clear memory palace high-water mirrors aborted'));
    });
}

/**
 * 清空所有角色 / 所有前缀的两份水位（localStorage + IndexedDB 资产镜像）。
 *
 * @returns 实际清掉的条目数（localStorage 键 + assets 镜像行）
 */
export async function clearAllMemoryPalaceHighWaterMarks(): Promise<number> {
    let localRemoved = 0;
    try {
        const toRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(LOCAL_KEY_PREFIX)) toRemove.push(key);
        }
        for (const key of toRemove) {
            localStorage.removeItem(key);
            localRemoved++;
        }
    } catch {
        // localStorage 被禁用时镜像仍要清；计数只统计真正清掉的。
        localRemoved = 0;
    }

    const mirrorRemoved = await deleteAssetsByPrefix(MIRROR_KEY_PREFIX);
    return localRemoved + mirrorRemoved;
}
