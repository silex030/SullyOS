import { describe, expect, it } from 'vitest';
import {
    DOCK_SLOTS,
    normalizeAppOrder,
    normalizeDockOrder,
    reorderIds,
    sameOrder,
    swapDockAndGrid,
} from './launcherLayout';

const AVAILABLE = ['chat', 'group', 'social', 'settings', 'music', 'gallery'];
const DEFAULTS = ['chat', 'group', 'social', 'settings'];

describe('launcherLayout', () => {
    it('Dock 固定 4 格', () => {
        expect(DOCK_SLOTS).toBe(4);
    });

    describe('normalizeDockOrder', () => {
        it('合法已存顺序保持原样', () => {
            expect(normalizeDockOrder(['music', 'chat', 'group', 'social'], AVAILABLE, DEFAULTS))
                .toEqual(['music', 'chat', 'group', 'social']);
        });

        it('丢弃非法 id 与重复项，用默认值补齐到 4 格', () => {
            expect(normalizeDockOrder(['nope', 'chat', 'chat', 'music'], AVAILABLE, DEFAULTS))
                .toEqual(['chat', 'music', 'group', 'social']);
        });

        it('超过 4 格时截断', () => {
            expect(normalizeDockOrder(['music', 'gallery', 'chat', 'group', 'social'], AVAILABLE, DEFAULTS))
                .toEqual(['music', 'gallery', 'chat', 'group']);
        });

        it('全非法时回落默认（仍不可用时按可用列表补）', () => {
            expect(normalizeDockOrder(['x', 'y'], AVAILABLE, DEFAULTS))
                .toEqual(['chat', 'group', 'social', 'settings']);
            expect(normalizeDockOrder(undefined, ['a', 'b', 'c', 'd', 'e'], ['x']))
                .toEqual(['a', 'b', 'c', 'd']);
        });
    });

    describe('normalizeAppOrder', () => {
        it('排除 Dock 成员，已存顺序优先', () => {
            expect(normalizeAppOrder(['gallery', 'music'], AVAILABLE, DEFAULTS))
                .toEqual(['gallery', 'music']);
        });

        it('丢弃 Dock 成员与非法 id，新 App 按原序补尾', () => {
            expect(normalizeAppOrder(['chat', 'zzz', 'music', 'music'], AVAILABLE, DEFAULTS))
                .toEqual(['music', 'gallery']);
            expect(normalizeAppOrder(['gallery'], AVAILABLE, DEFAULTS))
                .toEqual(['gallery', 'music']);
        });
    });

    describe('reorderIds', () => {
        it('后移与前移都按插入语义', () => {
            expect(reorderIds(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
            expect(reorderIds(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
        });

        it('id 不存在或同名时原样返回', () => {
            const items = ['a', 'b'];
            expect(reorderIds(items, 'a', 'z')).toBe(items);
            expect(reorderIds(items, 'a', 'a')).toBe(items);
        });
    });

    describe('swapDockAndGrid', () => {
        const appOrder = ['a', 'b', 'c', 'd'];
        const dockOrder = ['e', 'f', 'g', 'h'];

        it('网格图标拖到 Dock：两者对调各自的位置', () => {
            expect(swapDockAndGrid(appOrder, dockOrder, { id: 'a', kind: 'app' }, { id: 'e', kind: 'dock' }))
                .toEqual({ appOrder: ['e', 'b', 'c', 'd'], dockOrder: ['a', 'f', 'g', 'h'] });
        });

        it('Dock 图标拖到网格：反向对调', () => {
            expect(swapDockAndGrid(appOrder, dockOrder, { id: 'f', kind: 'dock' }, { id: 'c', kind: 'app' }))
                .toEqual({ appOrder: ['a', 'b', 'f', 'd'], dockOrder: ['e', 'c', 'g', 'h'] });
        });

        it('同类或单侧缺失时原样返回', () => {
            expect(swapDockAndGrid(appOrder, dockOrder, { id: 'a', kind: 'app' }, { id: 'b', kind: 'app' }))
                .toEqual({ appOrder, dockOrder });
            expect(swapDockAndGrid(appOrder, dockOrder, { id: 'z', kind: 'app' }, { id: 'e', kind: 'dock' }))
                .toEqual({ appOrder, dockOrder });
        });
    });

    describe('sameOrder', () => {
        it('逐项比较', () => {
            expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true);
            expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false);
            expect(sameOrder(['a'], ['a', 'b'])).toBe(false);
        });
    });

    // 终端 App（外部 agent 桥）退役后，老设备的 theme.launcher*Order 里可能还留着
    // 'terminal'。归一必须把它当未知 id 丢掉并补齐，而不是留空洞或抛错。
    describe('退役 App 残项归一（terminal）', () => {
        it('网格顺序里的 terminal 被丢弃，其余顺序不变', () => {
            // 已存顺序里的 terminal 当未知 id 丢弃；网格 = 可用 App − Dock 成员，
            // 所以这里只剩 music / gallery 两项，顺序按存档。
            expect(normalizeAppOrder(['terminal', 'gallery', 'music'], AVAILABLE, DEFAULTS))
                .toEqual(['gallery', 'music']);
            expect(normalizeAppOrder(['terminal', 'music'], AVAILABLE, DEFAULTS))
                .toEqual(['music', 'gallery']);
        });

        it('Dock 顺序里的 terminal 被丢弃并按默认值补满 4 格', () => {
            expect(normalizeDockOrder(['terminal', 'chat'], AVAILABLE, DEFAULTS))
                .toEqual(['chat', 'group', 'social', 'settings']);
        });

        it('只剩 terminal 的存档不会崩，两个方向都回落可用集合', () => {
            const dock = normalizeDockOrder(['terminal'], AVAILABLE, DEFAULTS);
            const grid = normalizeAppOrder(['terminal'], AVAILABLE, DEFAULTS);
            expect(dock).toEqual(['chat', 'group', 'social', 'settings']);
            expect(grid).toEqual(['music', 'gallery']);
            expect([...dock, ...grid].sort()).toEqual([...AVAILABLE].sort());
        });
    });
});
