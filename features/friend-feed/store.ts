// features/friend-feed/store.ts
// Bibi 本地动态 store：纯函数（不可变更新）+ 可注入 StoragePort。
// 零 LLM 调用：打开/刷新/读取只做本地 JSON 读写，不触发任何模型或网络请求。
import { MAX_POSTS, SCHEMA_VERSION } from './limits.js';
import type { FriendFeedComment, FriendFeedIdentity, FriendFeedPost, FriendFeedState } from './types.js';
import { normalizeText, validateCommentText, validateImageRefs, validatePostText } from './validation.js';
import { cleanSnapshot } from './archive.js';

let idCounter = 0;

function newId(prefix: string, now: number): string {
    idCounter += 1;
    return `ff_${prefix}_${now.toString(36)}_${idCounter.toString(36)}`;
}

export function createState(): FriendFeedState {
    return { version: SCHEMA_VERSION, rev: 0, posts: [], lastSeenCommentAt: {} };
}

export interface CreatePostInput {
    author: FriendFeedIdentity;
    text: string;
    imageRefs: string[];
    now?: number;
    id?: string;
}

export function createPost(
    state: FriendFeedState,
    input: CreatePostInput,
): { state: FriendFeedState; post: FriendFeedPost } {
    if (state.posts.length >= MAX_POSTS) {
        throw new Error(`动态已达上限（${MAX_POSTS} 条），请删除旧动态后再发布`);
    }
    const textCheck = validatePostText(input.text);
    if (!textCheck.ok) throw new Error(textCheck.error);
    const refCheck = validateImageRefs(input.imageRefs);
    if (!refCheck.ok) throw new Error(refCheck.error);
    const now = input.now ?? Date.now();
    const post: FriendFeedPost = {
        id: input.id ?? newId('p', now),
        authorId: input.author.id,
        authorName: input.author.name,
        authorAvatar: input.author.avatar,
        text: normalizeText(input.text),
        imageRefs: [...input.imageRefs],
        createdAt: now,
        updatedAt: now,
        likedByMe: false,
        likeCount: 0,
        comments: [],
    };
    return { state: { ...state, posts: [post, ...state.posts] }, post };
}

export function addComment(
    state: FriendFeedState,
    postId: string,
    author: FriendFeedIdentity,
    text: string,
    now?: number,
): FriendFeedState {
    const check = validateCommentText(text);
    if (!check.ok) throw new Error(check.error);
    const at = now ?? Date.now();
    const found = state.posts.some((p) => p.id === postId);
    if (!found) throw new Error('动态不存在');
    const comment: FriendFeedComment = {
        id: newId('c', at),
        postId,
        authorId: author.id,
        authorName: author.name,
        authorAvatar: author.avatar,
        text: normalizeText(text),
        createdAt: at,
    };
    return {
        ...state,
        posts: state.posts.map((p) =>
            p.id === postId
                ? { ...p, comments: [...p.comments, comment], updatedAt: at }
                : p,
        ),
    };
}

export function toggleLike(state: FriendFeedState, postId: string): FriendFeedState {
    const found = state.posts.some((p) => p.id === postId);
    if (!found) throw new Error('动态不存在');
    return {
        ...state,
        posts: state.posts.map((p) => {
            if (p.id !== postId) return p;
            const likedByMe = !p.likedByMe;
            return { ...p, likedByMe, likeCount: Math.max(0, p.likeCount + (likedByMe ? 1 : -1)) };
        }),
    };
}

/** 删除：仅作者本人可删。返回被删帖的图片引用，供调用方做 Blob GC。 */
export function deletePost(
    state: FriendFeedState,
    postId: string,
    requesterId: string,
): { state: FriendFeedState; removedImageRefs: string[] } {
    const post = state.posts.find((p) => p.id === postId);
    if (!post) throw new Error('动态不存在');
    if (post.authorId !== requesterId) throw new Error('只能删除自己发布的动态');
    const rest = { ...state.lastSeenCommentAt };
    delete rest[postId];
    return {
        state: {
            ...state,
            posts: state.posts.filter((p) => p.id !== postId),
            lastSeenCommentAt: rest,
        },
        removedImageRefs: [...post.imageRefs],
    };
}

export function markPostSeen(state: FriendFeedState, postId: string, now?: number): FriendFeedState {
    return {
        ...state,
        lastSeenCommentAt: { ...state.lastSeenCommentAt, [postId]: now ?? Date.now() },
    };
}

/** 互动提醒：我发布的帖子下、别人留下的、水位线之后的新评论。 */
export function getUnread(state: FriendFeedState, myId: string): { count: number; postIds: string[] } {
    const postIds: string[] = [];
    let count = 0;
    for (const p of state.posts) {
        if (p.authorId !== myId) continue;
        const seen = state.lastSeenCommentAt[p.id] ?? 0;
        const fresh = p.comments.filter((c) => c.authorId !== myId && c.createdAt > seen);
        if (fresh.length > 0) {
            postIds.push(p.id);
            count += fresh.length;
        }
    }
    return { count, postIds };
}

// ─── 持久化（字符串端口：生产接 assets，测试用内存） ───

export interface StringStoragePort {
    load: () => Promise<string | null>;
    save: (raw: string) => Promise<void>;
}

export function serialize(state: FriendFeedState): string {
    return JSON.stringify({ version: SCHEMA_VERSION, rev: state.rev, posts: state.posts, lastSeenCommentAt: state.lastSeenCommentAt });
}

/**
 * 严格反序列化（见 archive.ts）：版本/形态/长度/引用/数量/id 唯一与关联
 * 任一项非法即抛错。调用方保留旧态，绝不反写覆盖。
 */
export function deserialize(raw: string): FriendFeedState {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('存档损坏：JSON 无法解析');
    }
    return cleanSnapshot(parsed);
}

/** 读取：空库返回空态；损坏抛错（调用方保留旧态，绝不反写覆盖）。 */
// 注意：本模块不提供直接整包保存 helper。
// 一切持久化写入必须走 FeedController.commit 统一提交协议（真实跨文档锁内
// 重读→严格校验→落盘），或 service.saveProductionFeed（内部同样走统一提交）。
// 历史 saveFeed 已移除，避免无锁/无校验的公开写口绕过写协议与 schema。
export async function loadFeed(port: StringStoragePort): Promise<FriendFeedState> {
    const raw = await port.load();
    if (raw === null || raw === '') return createState();
    return deserialize(raw);
}
