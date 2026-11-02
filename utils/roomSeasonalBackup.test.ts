/**
 * 本次接线新增单测（单 worker）：房间布局 / 活动进度 / 领取凭据随真实
 * writer → reader → restore 往返；重复 claim 不重复记奖；非法输入保留旧档。
 * - 日期全部用显式 todayKey（'2026-10-30' 窗口内），不冒充生产今天。
 * - 锁用共享 SharedMemoryMutex（与模块测试同款，不依赖浏览器 Web Locks）。
 */
import { describe, expect, it } from 'vitest';
import { createRoom3DStore, type StorageLike } from '../features/room3d/storage';
import { SharedMemoryMutex } from '../features/room3d/mutex';
import { createDefaultLayout } from '../features/room3d/furniture';
import { room3DStorageKey } from '../features/room3d/types';
import {
    createHalloweenState,
    loadHalloweenMeta,
    tryClaimPersisted,
    tryPersistCollect,
} from '../features/seasonal-events/halloween';
import { HALLOWEEN_SPOTS, halloweenStorageKey } from '../features/seasonal-events/types';
import { collectRoomSeasonalBackup, restoreRoomSeasonalBackup } from './roomSeasonalBackup';

class MemStore implements StorageLike {
    private m = new Map<string, string>();
    get length(): number {
        return this.m.size;
    }
    key(i: number): string | null {
        return Array.from(this.m.keys())[i] ?? null;
    }
    getItem(k: string): string | null {
        return this.m.has(k) ? this.m.get(k)! : null;
    }
    setItem(k: string, v: string): void {
        this.m.set(k, String(v));
    }
    removeItem(k: string): void {
        this.m.delete(k);
    }
    peek(k: string): string | undefined {
        return this.m.get(k);
    }
}

const WINDOW_DAY = '2026-10-30';

describe('room3d writer → reader → restore 往返（真实角色映射 / slot 不串）', () => {
    it('保存 → 重读 → 收集 → 恢复，布局逐字节一致，A/B 槽不串', async () => {
        const mem = new MemStore();
        const mutex = new SharedMemoryMutex();
        const store = createRoom3DStore(mem, { mutex });
        const itemsA = createDefaultLayout();
        const savedA = await store.save('charA', itemsA, {});
        expect(savedA.status).toBe('saved');

        // 移动一件家具后保存，重开读回坐标一致
        const rev = savedA.status === 'saved' ? savedA.rev : null;
        expect(rev).toBeTruthy();
        const moved = itemsA.map((it, idx) =>
            idx === 0 ? { ...it, pose: { ...it.pose, x: it.pose.x + 0.4, z: it.pose.z - 0.2 } } : it,
        );
        const savedA2 = await store.save('charA', moved, { expectedRev: rev });
        expect(savedA2.status).toBe('saved');

        const itemsB = createDefaultLayout().slice(0, 3);
        const savedB = await store.save('charB', itemsB, {});
        expect(savedB.status).toBe('saved');

        // 收集：只带走本模块前缀键
        mem.setItem('os_theme', '"light"');
        const backup = collectRoomSeasonalBackup(mem);
        expect(Object.keys(backup.room3DStates ?? {})).toEqual(
            expect.arrayContaining([room3DStorageKey('charA'), room3DStorageKey('charB')]),
        );
        expect(JSON.stringify(backup)).not.toContain('os_theme');

        // 恢复进空库：writer → restore → reader 往返
        const fresh = new MemStore();
        const r = restoreRoomSeasonalBackup(backup, fresh);
        expect(r.roomRestored).toBe(2);
        expect(r.roomSkipped).toBe(0);
        const freshStore = createRoom3DStore(fresh, { mutex: new SharedMemoryMutex() });
        const metaA = freshStore.loadMeta('charA');
        const metaB = freshStore.loadMeta('charB');
        expect(metaA.status).toBe('ok');
        expect(metaB.status).toBe('ok');
        expect(metaA.state!.items).toHaveLength(itemsA.length);
        expect(metaA.state!.items[0].pose.x).toBeCloseTo(itemsA[0].pose.x + 0.4);
        expect(metaA.state!.items[0].pose.z).toBeCloseTo(itemsA[0].pose.z - 0.2);
        // B 槽是自己的 3 件，不串 A 的布局
        expect(metaB.state!.items).toHaveLength(3);
        expect(metaB.state!.charId).toBe('charB');
    });

    it('非法输入保留旧档：串槽 / 坏 JSON / 非字符串一律跳过，好字节不动', () => {
        const mem = new MemStore();
        const good = JSON.stringify({
            version: 1,
            charId: 'charC',
            items: [],
            updatedAt: 1,
        });
        mem.setItem(room3DStorageKey('charC'), good);
        const r = restoreRoomSeasonalBackup(
            {
                room3DStates: {
                    // 串槽：charA 的合法字节写进 charB 的 key
                    [room3DStorageKey('charB')]: JSON.stringify({
                        version: 1,
                        charId: 'charA',
                        items: [],
                        updatedAt: 1,
                    }),
                    // 坏 JSON
                    [room3DStorageKey('charD')]: '{not json',
                    // 非字符串
                    [room3DStorageKey('charE')]: 42 as unknown as string,
                    // 覆盖好档的非法载荷（items 非法）
                    [room3DStorageKey('charC')]: JSON.stringify({
                        version: 1,
                        charId: 'charC',
                        items: [{ id: 'x' }],
                        updatedAt: 2,
                    }),
                },
            },
            mem,
        );
        expect(r.roomRestored).toBe(0);
        expect(r.roomSkipped).toBe(4);
        // 旧档原样保留
        expect(mem.peek(room3DStorageKey('charC'))).toBe(good);
        expect(mem.peek(room3DStorageKey('charB'))).toBeUndefined();
        expect(mem.peek(room3DStorageKey('charD'))).toBeUndefined();
    });
});

describe('万圣节领取凭据：幂等 claim + 错角色零写入', () => {
    it('集齐 6 点 → 一次领取 → 重放不重复记奖', async () => {
        const mem = new MemStore();
        const mutex = new SharedMemoryMutex();
        let state = createHalloweenState('charH', 1);
        for (const spot of HALLOWEEN_SPOTS) {
            const r = await tryPersistCollect(mem, 'charH', state, spot, WINDOW_DAY, 2, mutex);
            expect(r.ok).toBe(true);
            if (r.ok) state = r.state;
        }
        expect(loadHalloweenMeta(mem, 'charH').status).toBe('ok');

        const first = await tryClaimPersisted(mem, 'charH', state, WINDOW_DAY, 3, mutex);
        expect(first.status).toBe('claimed');
        if (first.status !== 'claimed') throw new Error('unreachable');
        expect(first.intent).toMatchObject({
            kind: 'halloween-candy',
            eventId: 'halloween-2026',
            charId: 'charH',
            claimId: 'hw2026-charH',
            collectedCount: 6,
        });

        // 重放 / 刷新后重领：不产生第二个 intent
        const replay = await tryClaimPersisted(mem, 'charH', first.state, WINDOW_DAY, 4, mutex);
        expect(replay.status).toBe('already-claimed');
        const expiredLocal = { ...createHalloweenState('charH', 0), collected: [] as typeof state.collected };
        const stale = await tryClaimPersisted(mem, 'charH', expiredLocal, WINDOW_DAY, 5, mutex);
        expect(stale.status).toBe('already-claimed');

        // 领取凭据进备份收集与恢复
        const backup = collectRoomSeasonalBackup(mem);
        expect(backup.halloweenStates?.[halloweenStorageKey('charH')]).toBeTruthy();
        const fresh = new MemStore();
        const rr = restoreRoomSeasonalBackup(backup, fresh);
        expect(rr.halloweenRestored).toBe(1);
        const meta = loadHalloweenMeta(fresh, 'charH');
        expect(meta.status).toBe('ok');
        expect(meta.state?.claimed).toBe(true);
        expect(meta.state?.claimId).toBe('hw2026-charH');
    });

    it('错角色本地态在触及锁与存储之前拒绝，零写入、零 intent', async () => {
        const mem = new MemStore();
        const mutex = new SharedMemoryMutex();
        const foreign = createHalloweenState('charX', 1);
        const r = await tryClaimPersisted(mem, 'charY', foreign, WINDOW_DAY, 1, mutex);
        expect(r.status).toBe('persist-failed');
        if (r.status === 'persist-failed') expect(r.error).toBe('owner-mismatch');
        expect(mem.peek(halloweenStorageKey('charY'))).toBeUndefined();
        expect(mem.peek(halloweenStorageKey('charX'))).toBeUndefined();

        const c = await tryPersistCollect(mem, 'charY', foreign, 'pumpkin', WINDOW_DAY, 1, mutex);
        expect(c.ok).toBe(false);
        if (!c.ok) expect(c.error).toBe('owner-mismatch');
        expect(mem.peek(halloweenStorageKey('charY'))).toBeUndefined();
    });

    it('串槽备份恢复被 validator 拦下，旧档不动', () => {
        const mem = new MemStore();
        const goodH = JSON.stringify({
            version: 1,
            eventId: 'halloween-2026',
            charId: 'charH',
            collected: ['pumpkin'],
            claimed: false,
            claimId: null,
            updatedAt: 1,
        });
        mem.setItem(halloweenStorageKey('charH'), goodH);
        const r = restoreRoomSeasonalBackup(
            {
                halloweenStates: {
                    // charX 的字节冒充 charH
                    [halloweenStorageKey('charH')]: JSON.stringify({
                        version: 1,
                        eventId: 'halloween-2026',
                        charId: 'charX',
                        collected: ['pumpkin'],
                        claimed: false,
                        claimId: null,
                        updatedAt: 2,
                    }),
                },
            },
            mem,
        );
        expect(r.halloweenRestored).toBe(0);
        expect(r.halloweenSkipped).toBe(1);
        expect(mem.peek(halloweenStorageKey('charH'))).toBe(goodH);
    });
});
