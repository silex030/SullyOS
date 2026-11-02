/**
 * 3D 房间 + 万圣节活动 localStorage 备份收集 / 恢复薄适配器。
 *
 * - 两个模块的持久化都在 localStorage（与主 IndexedDB v81 零耦合）：
 *   `sully-home3d-{charId}`、`sully-seasonal-halloween-2026-{charId}`。
 * - 收集：localStorage 前缀扫描，原始字符串进 FullBackupData
 *  （`room3DStates` / `halloweenStates`，整 key → 整值，与 memoryPalaceFlags 同款）。
 * - 恢复：逐条用各模块实际 validator 校验（`validateRoomState` /
 *   `deserializeHalloween`，且要求 charId 与 key 后缀一致），非法 / 串槽 /
 *   版本不符一律跳过，绝不写坏旧档；跳过不抛错，不影响其它字段恢复。
 * - 不新增主 DB store，不改 schema / 通用恢复策略 / dateReadingStyle 预检。
 */
import { validateRoomState } from '../features/room3d/validate';
import { deserializeHalloween } from '../features/seasonal-events/halloween';

/** 3D 房间槽位 key 前缀（`sully-home3d-{charId}`）。 */
export const ROOM3D_BACKUP_PREFIX = 'sully-home3d-';
/** 万圣节活动槽位 key 前缀（`sully-seasonal-halloween-2026-{charId}`）。 */
export const HALLOWEEN_BACKUP_PREFIX = 'sully-seasonal-halloween-2026-';

/** 收集 / 恢复需要的最小 localStorage 端口（localStorage 本体即满足）。 */
export interface RoomSeasonalKeyStore {
    readonly length: number;
    key(i: number): string | null;
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
}

const scanPrefix = (
    store: RoomSeasonalKeyStore,
    prefix: string,
    out: Record<string, string>,
): void => {
    let n = 0;
    try {
        n = store.length;
    } catch {
        return;
    }
    for (let i = 0; i < n; i++) {
        let k: string | null = null;
        try {
            k = store.key(i);
        } catch {
            continue;
        }
        if (!k || !k.startsWith(prefix)) continue;
        let v: string | null = null;
        try {
            v = store.getItem(k);
        } catch {
            continue;
        }
        if (typeof v === 'string') out[k] = v;
    }
};

/**
 * 收集两个模块的全部槽位原始字符串（导出侧调用）。
 * 读失败的键直接跳过，不抛错、不中断其它键收集。
 */
export function collectRoomSeasonalBackup(store: RoomSeasonalKeyStore): {
    room3DStates?: Record<string, string>;
    halloweenStates?: Record<string, string>;
} {
    const room3DStates: Record<string, string> = {};
    const halloweenStates: Record<string, string> = {};
    scanPrefix(store, ROOM3D_BACKUP_PREFIX, room3DStates);
    scanPrefix(store, HALLOWEEN_BACKUP_PREFIX, halloweenStates);
    const out: { room3DStates?: Record<string, string>; halloweenStates?: Record<string, string> } = {};
    if (Object.keys(room3DStates).length > 0) out.room3DStates = room3DStates;
    if (Object.keys(halloweenStates).length > 0) out.halloweenStates = halloweenStates;
    return out;
}

export interface RoomSeasonalRestoreResult {
    roomRestored: number;
    roomSkipped: number;
    halloweenRestored: number;
    halloweenSkipped: number;
}

/**
 * 恢复两个模块的槽位（导入侧调用，必须在 importFullData 纯预检通过之后）。
 * 每条用实际 validator 校验角色归属 / 版本 / 结构；非法输入只计数跳过，
 * 绝不写入，旧档原样保留。
 */
export function restoreRoomSeasonalBackup(
    data: { room3DStates?: unknown; halloweenStates?: unknown },
    store: RoomSeasonalKeyStore,
): RoomSeasonalRestoreResult {
    const result: RoomSeasonalRestoreResult = {
        roomRestored: 0,
        roomSkipped: 0,
        halloweenRestored: 0,
        halloweenSkipped: 0,
    };
    const room = data.room3DStates;
    if (room && typeof room === 'object' && !Array.isArray(room)) {
        for (const [key, value] of Object.entries(room as Record<string, unknown>)) {
            if (!key.startsWith(ROOM3D_BACKUP_PREFIX) || typeof value !== 'string') {
                result.roomSkipped++;
                continue;
            }
            const charId = key.slice(ROOM3D_BACKUP_PREFIX.length);
            if (!charId) {
                result.roomSkipped++;
                continue;
            }
            let parsed: unknown = null;
            try {
                parsed = JSON.parse(value);
            } catch {
                result.roomSkipped++;
                continue;
            }
            const r = validateRoomState(parsed, charId);
            if (!r.ok) {
                result.roomSkipped++;
                continue;
            }
            try {
                store.setItem(key, value);
                result.roomRestored++;
            } catch {
                result.roomSkipped++;
            }
        }
    }
    const hw = data.halloweenStates;
    if (hw && typeof hw === 'object' && !Array.isArray(hw)) {
        for (const [key, value] of Object.entries(hw as Record<string, unknown>)) {
            if (!key.startsWith(HALLOWEEN_BACKUP_PREFIX) || typeof value !== 'string') {
                result.halloweenSkipped++;
                continue;
            }
            const charId = key.slice(HALLOWEEN_BACKUP_PREFIX.length);
            if (!charId) {
                result.halloweenSkipped++;
                continue;
            }
            const state = deserializeHalloween(value, charId);
            if (!state) {
                result.halloweenSkipped++;
                continue;
            }
            try {
                store.setItem(key, value);
                result.halloweenRestored++;
            } catch {
                result.halloweenSkipped++;
            }
        }
    }
    return result;
}
