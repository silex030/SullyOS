// features/friend-feed/backup.ts
// Bibi 模块级 export/import：只进出本模块数据，供集成层接入备份菜单。
// 不碰 FullBackupData、不读写其他 store、无凭据字段。
import { BACKUP_KIND, SCHEMA_VERSION } from './limits.js';
import type { FriendFeedBackup, FriendFeedState } from './types.js';
import { cleanPosts, projectPost } from './archive.js';

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null;
}

/** 导出：白名单投影，只含声明字段；未知字段（含凭据类）绝不带出。 */
export function exportBackup(state: FriendFeedState, now?: number): FriendFeedBackup {
    return {
        kind: BACKUP_KIND,
        version: SCHEMA_VERSION,
        exportedAt: now ?? Date.now(),
        posts: state.posts.map(projectPost),
    };
}

/** 校验并导入：版本/kind 不符、字段缺失一律抛错；只返回本模块 state，不触碰其他数据。 */
export function parseBackup(input: unknown): FriendFeedState {
    if (!isRecord(input)) throw new Error('备份损坏：顶层不是对象');
    if (input['kind'] !== BACKUP_KIND) throw new Error(`不是哔哔模块备份（kind=${String(input['kind'])})`);
    if (input['version'] !== SCHEMA_VERSION) {
        throw new Error(`备份版本不支持：${String(input['version'])}（需要 v${SCHEMA_VERSION}）`);
    }
    if (typeof input['exportedAt'] !== 'number' || !Number.isFinite(input['exportedAt']) || (input['exportedAt'] as number) < 0) {
        throw new Error('备份损坏：exportedAt 非法');
    }
    return {
        version: SCHEMA_VERSION,
        rev: 0,
        posts: cleanPosts(input['posts']).map(projectPost),
        lastSeenCommentAt: {},
    };
}
