// features/friend-feed/types.ts
// Bibi（本地 FriendFeed）自有类型。不改根 types.ts，不复用 SocialPost（那是
// Moments/Mastodon/douban 遗留链路的类型），避免和朋友圈去重/可见性逻辑串味。

/** 发帖身份：用户本人或任一现有角色（由集成层从角色表传入，此处只存快照）。 */
export interface FriendFeedIdentity {
    id: string;
    name: string;
    avatar: string;
}

export interface FriendFeedComment {
    id: string;
    postId: string;
    authorId: string;
    authorName: string;
    authorAvatar: string;
    text: string;
    createdAt: number;
}

export interface FriendFeedPost {
    id: string;
    authorId: string;
    authorName: string;
    authorAvatar: string;
    text: string;
    /** 图片引用令牌：生产接线为 `blobref:<id>`（二进制存 blob_assets）；
     * 隔离 preview 为 `localimg:<id>`（二进制存隔离 IndexedDB 图片仓）。
     * 可信令牌是唯一允许持久化的形态：`blob:`（临时 objectURL）、`data:`、
     * `http(s):`、`/` 一律不得写入快照或备份，只能作为渲染期瞬时值；
     * 加载/导入时直接拒绝。头像字段同样只接受空或可信令牌。 */
    imageRefs: string[];
    createdAt: number;
    updatedAt: number;
    likedByMe: boolean;
    likeCount: number;
    comments: FriendFeedComment[];
}

/** 模块级 schema（与主 DB v81 无关，不新增主 store）。rev 为提交序号，用于合并保护。 */
export interface FriendFeedState {
    version: 1;
    rev: number;
    posts: FriendFeedPost[];
    /** postId -> 该帖评论区最后已读时间（互动提醒水位）。 */
    lastSeenCommentAt: Record<string, number>;
}

/** 可验证的模块备份体：只含本模块数据，供集成层接入，不写入 FullBackupData。 */
export interface FriendFeedBackup {
    kind: 'sully-friend-feed-backup';
    version: 1;
    exportedAt: number;
    posts: FriendFeedPost[];
}
