// features/friend-feed/limits.ts
// Bibi 上界：图片二进制不进文本快照（生产走 blob_assets，preview 走本地图片仓）；
// 文本快照与备份只存可信引用令牌，拒绝任意远端/data/blob 引用。

/** 主 DB assets store 内存放本模块快照的 key（字符串 JSON，只含文本+令牌）。 */
export const STORAGE_ASSET_KEY = 'friend_feed_v1';

export const SCHEMA_VERSION = 1 as const;

/** 模块备份 kind（导入时校验，不接受整包 FullBackupData 或其他模块备份）。 */
export const BACKUP_KIND = 'sully-friend-feed-backup' as const;

export const MAX_TEXT_LENGTH = 2000;
export const MAX_COMMENT_LENGTH = 500;
export const MAX_IMAGES_PER_POST = 4;

/** 单图 5MB：手机拍照需先由调用方压缩/拒收，避免 IndexedDB 配额爆炸。 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const ACCEPTED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** preview 隔离图片仓的 IndexedDB 库名（只存图片二进制，与文本快照分开存放）。 */
export const PREVIEW_BLOB_DB = 'bibi-preview-blobs-v1';

/** 快照帖子数上界（防恶意存档撑爆内存）。 */
export const MAX_POSTS = 500;

/** 已读水位条目上界。 */
export const MAX_LAST_SEEN_ENTRIES = 1000;

/**
 * 持久化图片引用的唯一合法形态：
 * - `blobref:<id>`：生产 blob_assets 令牌；
 * - `localimg:<id>`：隔离 preview 本地图片仓令牌（重开可恢复）。
 * `blob:`（临时 objectURL）、`data:`、`http(s):`、`/` 一律不得写入快照或备份；
 * 它们只能作为渲染期瞬时值存在，加载/导入时直接拒绝。
 */
export const PERSISTED_IMAGE_REF_RE = /^(?:blobref|localimg):[A-Za-z0-9._-]{1,128}$/;

/** 存档/备份内 id 的合法形态（帖子/评论/身份）。 */
export const ARCHIVE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
