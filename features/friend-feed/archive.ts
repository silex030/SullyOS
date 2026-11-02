// features/friend-feed/archive.ts
// 存档/备份共用的严格 schema 校验与白名单投影。
// store.deserialize 与 backup.parseBackup 都走这里，保证同一边界。
// 规则：可信引用仅 blobref:/localimg:（拒绝 blob:/data:/http(s)://），
// 文本/评论长度、图数、帖子数、水位数、id 唯一与关联全部检查；
// 导出只投影声明字段，未知字段（含凭据类）一律丢弃。
import {
    ARCHIVE_ID_RE,
    MAX_COMMENT_LENGTH,
    MAX_IMAGES_PER_POST,
    MAX_LAST_SEEN_ENTRIES,
    MAX_POSTS,
    MAX_TEXT_LENGTH,
    PERSISTED_IMAGE_REF_RE,
    SCHEMA_VERSION,
} from './limits.js';
import type { FriendFeedComment, FriendFeedPost, FriendFeedState } from './types.js';

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null;
}

function reqId(o: Record<string, unknown>, k: string, where: string): string {
    const v = o[k];
    if (typeof v !== 'string' || !ARCHIVE_ID_RE.test(v)) {
        throw new Error(`存档损坏：${where}字段 ${k} 非法`);
    }
    return v;
}

function reqFinite(o: Record<string, unknown>, k: string, where: string): number {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new Error(`存档损坏：${where}字段 ${k} 非法`);
    }
    return v;
}

function reqName(o: Record<string, unknown>, k: string, where: string): string {
    const v = o[k];
    if (typeof v !== 'string' || !v.trim() || v.length > 64) {
        throw new Error(`存档损坏：${where}字段 ${k} 非法`);
    }
    return v;
}

function cleanAvatar(v: unknown, where: string): string {
    if (typeof v !== 'string') throw new Error(`存档损坏：${where}缺字段 authorAvatar`);
    // 头像与正文配图同一边界：只允许空或可信引用令牌。
    // 任意 https/data/blob 引用一律拒绝，不进持久化、不交 img 渲染、不带出备份。
    if (v === '' || PERSISTED_IMAGE_REF_RE.test(v)) return v;
    throw new Error(`存档损坏：${where}头像引用非法（仅允许空或 blobref:/localimg: 可信令牌）`);
}

function cleanComment(c: unknown, parentPostId: string): FriendFeedComment {
    if (!isRecord(c)) throw new Error('存档损坏：评论不是对象');
    const id = reqId(c, 'id', '评论');
    const postId = reqId(c, 'postId', '评论');
    if (postId !== parentPostId) throw new Error('存档损坏：评论 postId 与所属帖子不一致');
    const authorId = reqId(c, 'authorId', '评论');
    const authorName = reqName(c, 'authorName', '评论');
    const authorAvatar = cleanAvatar(c['authorAvatar'], '评论');
    if (typeof c['text'] !== 'string') throw new Error('存档损坏：评论缺字段 text');
    const text = c['text'] as string;
    if (!text.trim() || text.length > MAX_COMMENT_LENGTH) throw new Error('存档损坏：评论正文非法');
    const createdAt = reqFinite(c, 'createdAt', '评论');
    return {
        id,
        postId,
        authorId,
        authorName,
        authorAvatar,
        text,
        createdAt,
    };
}

export function cleanPost(p: unknown): FriendFeedPost {
    if (!isRecord(p)) throw new Error('存档损坏：帖子不是对象');
    const id = reqId(p, 'id', '帖子');
    const authorId = reqId(p, 'authorId', '帖子');
    const authorName = reqName(p, 'authorName', '帖子');
    const authorAvatar = cleanAvatar(p['authorAvatar'], '帖子');
    if (typeof p['text'] !== 'string') throw new Error('存档损坏：帖子缺字段 text');
    const text = p['text'] as string;
    if (!text.trim() || text.length > MAX_TEXT_LENGTH) throw new Error('存档损坏：帖子正文非法');
    if (!Array.isArray(p['imageRefs'])) throw new Error('存档损坏：帖子 imageRefs 不是数组');
    const refs = p['imageRefs'] as unknown[];
    if (refs.length > MAX_IMAGES_PER_POST) throw new Error('存档损坏：帖子图片超量');
    for (const r of refs) {
        if (typeof r !== 'string' || !PERSISTED_IMAGE_REF_RE.test(r)) {
            throw new Error('存档损坏：帖子图片引用非法（仅 blobref:/localimg: 可信令牌）');
        }
    }
    const createdAt = reqFinite(p, 'createdAt', '帖子');
    const updatedAt = reqFinite(p, 'updatedAt', '帖子');
    if (typeof p['likedByMe'] !== 'boolean') throw new Error('存档损坏：帖子缺字段 likedByMe');
    if (typeof p['likeCount'] !== 'number' || !Number.isInteger(p['likeCount']) || (p['likeCount'] as number) < 0) {
        throw new Error('存档损坏：帖子 likeCount 非法');
    }
    if (!Array.isArray(p['comments'])) throw new Error('存档损坏：帖子 comments 不是数组');
    const comments = (p['comments'] as unknown[]).map((c) => cleanComment(c, id));
    return {
        id,
        authorId,
        authorName,
        authorAvatar,
        text,
        imageRefs: refs as string[],
        createdAt,
        updatedAt,
        likedByMe: p['likedByMe'] as boolean,
        likeCount: p['likeCount'] as number,
        comments,
    };
}

/** 白名单投影：只保留声明字段，未知字段（含凭据类）一律丢弃。 */
export function projectPost(p: FriendFeedPost): FriendFeedPost {
    return {
        id: p.id,
        authorId: p.authorId,
        authorName: p.authorName,
        authorAvatar: p.authorAvatar,
        text: p.text,
        imageRefs: [...p.imageRefs],
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        likedByMe: p.likedByMe,
        likeCount: p.likeCount,
        comments: p.comments.map((c) => ({
            id: c.id,
            postId: c.postId,
            authorId: c.authorId,
            authorName: c.authorName,
            authorAvatar: c.authorAvatar,
            text: c.text,
            createdAt: c.createdAt,
        })),
    };
}

function cleanLastSeen(v: unknown): Record<string, number> {
    if (v === undefined) return {};
    if (!isRecord(v)) throw new Error('存档损坏：lastSeenCommentAt 非法');
    const keys = Object.keys(v);
    if (keys.length > MAX_LAST_SEEN_ENTRIES) throw new Error('存档损坏：已读水位条目超量');
    const out: Record<string, number> = {};
    for (const k of keys) {
        const n = v[k];
        if (!ARCHIVE_ID_RE.test(k) || typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
            throw new Error('存档损坏：已读水位条目非法');
        }
        out[k] = n;
    }
    return out;
}

/** 严格校验帖子数组：数量上界、id 唯一（帖子间、评论全局）。 */
export function cleanPosts(input: unknown): FriendFeedPost[] {
    if (!Array.isArray(input)) throw new Error('存档损坏：posts 不是数组');
    if (input.length > MAX_POSTS) throw new Error('存档损坏：帖子数超量');
    const posts = input.map(cleanPost);
    const postIds = new Set<string>();
    for (const p of posts) {
        if (postIds.has(p.id)) throw new Error('存档损坏：帖子 id 重复');
        postIds.add(p.id);
    }
    const commentIds = new Set<string>();
    for (const p of posts) {
        for (const c of p.comments) {
            if (commentIds.has(c.id)) throw new Error('存档损坏：评论 id 重复');
            commentIds.add(c.id);
        }
    }
    return posts;
}

/** 顶层快照校验（version/posts/lastSeen/rev），返回白名单重建后的干净 state。 */
export function cleanSnapshot(input: unknown): FriendFeedState {
    if (!isRecord(input)) throw new Error('存档损坏：顶层不是对象');
    if (input['version'] !== SCHEMA_VERSION) {
        throw new Error(`存档版本不支持：${String(input['version'])}（需要 v${SCHEMA_VERSION}）`);
    }
    const revRaw = input['rev'];
    const rev = revRaw === undefined ? 0 : revRaw;
    if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0) {
        throw new Error('存档损坏：rev 非法');
    }
    return {
        version: SCHEMA_VERSION,
        rev,
        posts: cleanPosts(input['posts']).map(projectPost),
        lastSeenCommentAt: cleanLastSeen(input['lastSeenCommentAt']),
    };
}
