// features/friend-feed/service.ts
// 生产接线层（由唯一后续集成者调用）：把 store.ts 的 StringStoragePort 接到
// 主 DB assets（key=STORAGE_ASSET_KEY，不新增 store、不动 DB v81），
// 图片二进制走 blob_assets（putImageBlob），文本 JSON 只存令牌。
// 全部真实导入都用函数内动态 import：单测只测纯逻辑时不会拖入 DB/Blob 链。
import { MAX_IMAGES_PER_POST, STORAGE_ASSET_KEY } from './limits.js';
import type { FriendFeedState } from './types.js';
import { deserialize, serialize, type StringStoragePort } from './store.js';
import type { CasTextPort, ImageStorePort, WriteLockProvider } from './controller.js';
import { validateImageFile, type ImageFileLike } from './validation.js';

/** assets store 的最小读写面（与 utils/db.ts 的 getAsset/saveAsset 同形）。 */
export interface AssetPort {
    getAsset: (id: string) => Promise<string | null>;
    saveAsset: (id: string, data: string) => Promise<void>;
}

async function realAssetPort(): Promise<AssetPort> {
    const { DB } = await import('../../utils/db.js');
    return {
        getAsset: (id) => DB.getAsset(id),
        saveAsset: (id, data) => DB.saveAsset(id, data),
    };
}

export function makeAssetStoragePort(asset: AssetPort): CasTextPort {
    return {
        resourceKey: `bibi-asset/${STORAGE_ASSET_KEY}`,
        load: () => asset.getAsset(STORAGE_ASSET_KEY),
        save: (raw) => asset.saveAsset(STORAGE_ASSET_KEY, raw),
    };
}

/** 集成入口：读生产快照（损坏时抛错由调用方保留旧态，见 store.loadFeed 语义）。 */
export async function loadProductionFeed(asset?: AssetPort): Promise<FriendFeedState> {
    const port = makeAssetStoragePort(asset ?? (await realAssetPort()));
    const raw = await port.load();
    if (raw === null || raw === '') {
        const { createState } = await import('./store.js');
        return createState();
    }
    return deserialize(raw);
}

/**
 * 全量替换导入（备份恢复语义）：先严格校验，再走 FeedController 统一提交协议
 * （跨文档锁内重读→校验→落盘）。无写能力或校验失败时抛错，远端旧字节不动。
 * 增量变更（发帖/评论/点赞/已读/删除）必须使用 FeedController 方法，不得调本函数
 * 做整包覆盖。
 */
export async function saveProductionFeed(state: FriendFeedState, asset?: AssetPort, locks?: WriteLockProvider | null): Promise<void> {
    const { FeedController } = await import('./controller.js');
    const { cleanSnapshot } = await import('./archive.js');
    const text = makeAssetStoragePort(asset ?? (await realAssetPort()));
    const c = new FeedController(text, makeBlobAssetImagePort(), locks);
    await c.load();
    // 先校验再进提交：恶意/超限输入在锁外即被拒，不占用临界区、不动远端。
    const validated = cleanSnapshot(JSON.parse(serialize(state)));
    await c.commit(() => ({ ...validated, rev: 0 }));
}

/**
 * 图片入库：数量/类型/体积全部先验，再逐个进 blob_assets，返回 `blobref:` 令牌。
 * 任一步失败抛错；已入库的半批应当由调用方按返回清理——此处入库失败即停，
 * 调用方（controller.submitPost 走 ImageStorePort；旧直调路径见 handoff）负责 GC。
 */
export type UploadableImage = Blob & { name: string };

export async function savePostImages(files: UploadableImage[]): Promise<string[]> {
    if (files.length > MAX_IMAGES_PER_POST) throw new Error(`图片最多 ${MAX_IMAGES_PER_POST} 张`);
    for (const f of files) {
        const check = validateImageFile({ name: f.name, type: f.type, size: f.size });
        if (!check.ok) throw new Error(check.error);
    }
    const { putImageBlob } = await import('../../utils/blobRef.js');
    const refs: string[] = [];
    for (const f of files) {
        refs.push(await putImageBlob(f));
    }
    return refs;
}

/**
 * 生产图片仓：二进制进 blob_assets（IndexedDB 原生 Blob），返回 `blobref:` 令牌；
 * 文本快照只存令牌。保守回收：不提供 discardUncommitted——生产 Blob 池无法证明
 * 独占（内容去重/跨面共享），失败批次与删帖的残留一律保留，交已有全局 GC 处理。
 * 由唯一后续集成者按 handoff §2 接入，preview 不用此实现。
 */
export function makeBlobAssetImagePort(): ImageStorePort {
    return {
        saveImage: async (f) => {
            const { putImageBlob } = await import('../../utils/blobRef.js');
            return putImageBlob(f as Blob);
        },
        loadImage: async (ref) => {
            const { getBlobForRef } = await import('../../utils/blobRef.js');
            return getBlobForRef(ref);
        },
    };
}

/**
 * 令牌解析为可渲染 URL（仅 blobref:→objectURL；其他一律返回空并过滤）。
 * 跨站/data:/blob: 瞬时值不得经此渲染。调用方负责撤销 objectURL。
 */
export async function resolveImageRefs(refs: string[]): Promise<string[]> {
    const { getBlobForRef } = await import('../../utils/blobRef.js');
    const out: string[] = [];
    for (const r of refs) {
        if (!r.startsWith('blobref:')) continue;
        const blob = await getBlobForRef(r);
        out.push(blob ? URL.createObjectURL(blob) : '');
    }
    return out.filter((u) => u !== '');
}
