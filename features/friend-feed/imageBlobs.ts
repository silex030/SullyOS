// features/friend-feed/imageBlobs.ts
// 隔离 preview 专用二进制图片仓：IndexedDB 独立库，只存 Blob 二进制。
// - 文本快照（localStorage）只存 `localimg:<id>` 令牌，绝不混入 base64；
// - 不新增主 DB store、不动 DB v81、不碰共享依赖；
// - 生产环境用 service.makeBlobAssetImagePort（blob_assets），不用此实现。
// 零 LLM 调用，零网络请求。
import type { ImageStorePort } from './controller.js';
import { PREVIEW_BLOB_DB } from './limits.js';

const STORE_NAME = 'blobs';
const REF_RE = /^localimg:([A-Za-z0-9._-]{1,128})$/;

function getIDB(): IDBFactory {
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!idb) throw new Error('当前环境不支持 IndexedDB，图片仓不可用');
    return idb;
}

function openDb(dbName: string = PREVIEW_BLOB_DB): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        let req: IDBOpenDBRequest;
        try {
            req = getIDB().open(dbName, 1);
        } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
            return;
        }
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('图片仓打开失败'));
        req.onblocked = () => reject(new Error('图片仓被旧连接阻塞，请关闭其他标签页后重试'));
    });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        let transaction: IDBTransaction;
        try {
            transaction = db.transaction(STORE_NAME, mode);
        } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
            return;
        }
        let out: T | undefined;
        let done = false;
        transaction.oncomplete = () => {
            if (done) resolve(out as T);
        };
        transaction.onerror = () => reject(transaction.error ?? new Error('图片仓事务失败'));
        transaction.onabort = () => reject(transaction.error ?? new Error('图片仓事务中止'));
        let req: IDBRequest<T>;
        try {
            req = fn(transaction.objectStore(STORE_NAME));
        } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
            return;
        }
        req.onsuccess = () => {
            out = req.result;
            done = true;
        };
        req.onerror = () => reject(req.error ?? new Error('图片仓读写失败'));
    });
}

/**
 * 隔离 preview 图片仓：二进制进 IndexedDB，返回 `localimg:<id>` 令牌。
 * 配额/失败时抛错且旧图不动（不截断、不清空已有记录）。
 * id 每次新建唯一且不可猜测：未提交前不可能被其他写入者引用，
 * 故 discardUncommitted 删除本批 id 即为独占回滚。正式删帖不调用本方法。
 */
export function makeIndexedDbImagePort(dbName: string = PREVIEW_BLOB_DB): ImageStorePort {
    let dbPromise: Promise<IDBDatabase> | null = null;
    const db = () => {
        if (!dbPromise) dbPromise = openDb(dbName);
        return dbPromise;
    };
    let counter = 0;
    return {
        saveImage: async (file) => {
            counter += 1;
            const id = `li_${Date.now().toString(36)}_${counter.toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
            const database = await db();
            try {
                await tx(database, 'readwrite', (store) => store.put({ id, blob: file, type: file.type }));
            } catch (e) {
                throw e instanceof Error ? e : new Error(`图片保存失败：${String(e)}`);
            }
            return `localimg:${id}`;
        },
        loadImage: async (ref) => {
            const m = REF_RE.exec(ref);
            if (!m) return null;
            const database = await db();
            const rec = await tx<{ blob?: Blob } | undefined>(database, 'readonly', (store) => store.get(m[1]));
            const blob = rec?.blob;
            return blob instanceof Blob ? blob : null;
        },
        // 失败批次独占回滚：ref 系本批新建、未提交（见上）；正式删帖不调用。
        // 注意：本端口不提供已发布图片的删除能力（保守回收，交全局 GC）。
        discardUncommitted: async (refs) => {
            const database = await db();
            for (const ref of refs) {
                const m = REF_RE.exec(ref);
                if (!m) continue;
                try {
                    await tx(database, 'readwrite', (store) => store.delete(m[1]));
                } catch {
                    /* 回滚失败则保留，不影响错误本身 */
                }
            }
        },
    };
}
