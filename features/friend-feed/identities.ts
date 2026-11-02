// features/friend-feed/identities.ts
// 身份 adapter：把“现有角色对象 + 用户本人”映射为发帖身份。
// 生产集成层从角色表取 {id,name,avatar} 传入此处，不在此处直连角色库；
// preview 注入同一路径，保证映射可验证。
import type { FriendFeedIdentity } from './types.js';
import { PERSISTED_IMAGE_REF_RE } from './limits.js';

export interface RoleLike {
    id: string;
    name?: string;
    avatar?: string;
}

/**
 * 单个角色/用户对象 → 发帖身份。缺 name/avatar 时兜底，缺 id 直接拒绝。
 * 头像只接受空或可信引用令牌：现有角色的 http/data 外链头像在此清洗为空
 * （界面显示首字占位），绝不把不可信引用写进存档/备份或交 img 渲染。
 */
export function toFeedIdentity(role: RoleLike): FriendFeedIdentity {
    if (!role || typeof role.id !== 'string' || !role.id.trim()) {
        throw new Error('身份非法：缺少 id');
    }
    const id = role.id;
    const name = typeof role.name === 'string' && role.name.trim() ? role.name : id;
    const rawAvatar = typeof role.avatar === 'string' ? role.avatar : '';
    const avatar = rawAvatar === '' || PERSISTED_IMAGE_REF_RE.test(rawAvatar) ? rawAvatar : '';
    return { id, name, avatar };
}

/** 组装身份列表：用户本人固定首位 + 现有角色依次排列。 */
export function buildIdentityList(input: { user: RoleLike; characters: RoleLike[] }): FriendFeedIdentity[] {
    const list = [toFeedIdentity(input.user)];
    for (const c of input.characters ?? []) {
        if (c.id === input.user.id) continue;
        list.push(toFeedIdentity(c));
    }
    return list;
}
