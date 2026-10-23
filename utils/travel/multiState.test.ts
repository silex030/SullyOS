/**
 * 多角色实时感知（每角色独立 store / 独立取消句柄）回归：
 * - 切角色（setActiveChar）不停别人的轮询；
 * - 撤销只清该角色的 trip/坐标/路线/历史；
 * - 共享关掉只停这一个角色；
 * - 聚合视图按代码路径取「各自 store 的数据」，不共享别人的快照。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { createTravelMultiStateStore } from './state';
import type { TravelPublicSnapshot } from './core';

const NOW = Date.parse('2026-10-24T04:00:00.000Z');

const snapshotFor = (label: string, serverNow: number): TravelPublicSnapshot =>
    ({
        code: 'OK',
        serverNow,
        trip: {
            status: 'en_route',
            origin: { label: '家', city: '杭州' },
            dest: { label, city: '杭州' },
        },
        position: { lat: 30.1, lng: 120.1 },
        route: { points: [[120.1, 30.1], [120.2, 30.2]], distanceM: 900 },
        history: [],
        budget: { mapCallsUsed: 1, mapCallsLimit: 30 },
        shareEnabled: true,
    }) as unknown as TravelPublicSnapshot;

const makeApi = () => {
    const calls: string[] = [];
    return {
        calls,
        api: {
            readSharedView: async (charId: string) => {
                calls.push(charId);
                return {
                    ok: true as const,
                    data: snapshotFor(charId === 'a' ? 'A 的去处' : 'B 的去处', NOW + calls.length * 1000),
                };
            },
        },
    };
};

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('createTravelMultiStateStore', () => {
    it('两个角色各自轮询：后启动的角色不会取消先启动的角色', async () => {
        const { api, calls } = makeApi();
        const store = createTravelMultiStateStore({ now: () => NOW });
        store.applyShareFor('a', { shareEnabled: true, version: 1 } as never);
        store.applyShareFor('b', { shareEnabled: true, version: 1 } as never);

        store.startPolling({ charId: 'a', api, intervalMs: 1000 });
        store.startPolling({ charId: 'b', api, intervalMs: 1000 });
        await vi.advanceTimersByTimeAsync(10);

        const view = store.getMultiState();
        expect(view.byChar.a?.view?.trip?.dest?.label).toBe('A 的去处');
        expect(view.byChar.b?.view?.trip?.dest?.label).toBe('B 的去处');

        // 再走一轮：两个人都在继续，而不是只剩最后一个。
        await vi.advanceTimersByTimeAsync(1100);
        expect(calls.filter((c) => c === 'a').length).toBeGreaterThanOrEqual(2);
        expect(calls.filter((c) => c === 'b').length).toBeGreaterThanOrEqual(2);
    });

    it('切换聚焦角色只改 active，不停别人的轮询、不串数据', async () => {
        const { api, calls } = makeApi();
        const store = createTravelMultiStateStore({ now: () => NOW });
        store.applyShareFor('a', { shareEnabled: true, version: 1 } as never);
        store.applyShareFor('b', { shareEnabled: true, version: 1 } as never);
        store.startPolling({ charId: 'a', api, intervalMs: 1000 });
        store.startPolling({ charId: 'b', api, intervalMs: 1000 });
        await vi.advanceTimersByTimeAsync(10);

        store.setActiveChar('b');
        expect(store.getState().view?.trip?.dest?.label).toBe('B 的去处');
        const before = calls.length;
        await vi.advanceTimersByTimeAsync(1100);
        expect(calls.length).toBeGreaterThan(before);
        expect(store.getMultiState().byChar.a?.view?.trip?.dest?.label).toBe('A 的去处');
    });

    it('撤销只清该角色：另一个人的行程与轮询继续', async () => {
        const { api, calls } = makeApi();
        const store = createTravelMultiStateStore({ now: () => NOW });
        store.applyShareFor('a', { shareEnabled: true, version: 1 } as never);
        store.applyShareFor('b', { shareEnabled: true, version: 1 } as never);
        store.startPolling({ charId: 'a', api, intervalMs: 1000 });
        store.startPolling({ charId: 'b', api, intervalMs: 1000 });
        await vi.advanceTimersByTimeAsync(10);

        store.revokeChar('a');

        const after = store.getMultiState();
        // a：立刻没有 trip/坐标/路线/历史
        expect(after.byChar.a?.view?.trip ?? null).toBeNull();
        expect(after.byChar.a?.view?.position ?? null).toBeNull();
        expect(after.byChar.a?.view?.route ?? null).toBeNull();
        expect(after.byChar.a?.shareEnabled).toBe(false);
        // b：原样保留
        expect(after.byChar.b?.view?.trip?.dest?.label).toBe('B 的去处');
        expect(after.byChar.b?.shareEnabled).toBe(true);

        const beforeB = calls.filter((c) => c === 'b').length;
        await vi.advanceTimersByTimeAsync(1100);
        expect(calls.filter((c) => c === 'b').length).toBeGreaterThan(beforeB);
        // a 已停：撤销后不再发请求
        expect(calls.filter((c) => c === 'a').length).toBe(1);
    });

    it('共享关掉只停这一个角色；聚合视图包含两条真实条目', async () => {
        const { api, calls } = makeApi();
        const store = createTravelMultiStateStore({ now: () => NOW });
        store.applyShareFor('a', { shareEnabled: true, version: 1 } as never);
        store.applyShareFor('b', { shareEnabled: true, version: 1 } as never);
        store.startPolling({ charId: 'a', api, intervalMs: 1000 });
        store.startPolling({ charId: 'b', api, intervalMs: 1000 });
        await vi.advanceTimersByTimeAsync(10);

        store.applyShareFor('a', { shareEnabled: false, version: 2 } as never);
        store.stopChar('a');
        const view = store.getMultiState();
        expect(view.byChar.a?.shareEnabled).toBe(false);
        expect(view.byChar.b?.shareEnabled).toBe(true);

        const beforeB = calls.filter((c) => c === 'b').length;
        await vi.advanceTimersByTimeAsync(1100);
        expect(calls.filter((c) => c === 'b').length).toBeGreaterThan(beforeB);
    });

    it('共享位读失败只影响该角色（fail-closed，不默认活跃）', async () => {
        const store = createTravelMultiStateStore({ now: () => NOW });
        store.applyShareFor('a', { shareEnabled: true, version: 1 } as never);
        store.applyShareFor('b', { shareEnabled: true, version: 1 } as never);
        store.applyShareUnavailableFor('a');
        const view = store.getMultiState();
        expect(view.byChar.a?.shareKnown).toBe(false);
        expect(view.byChar.a?.shareEnabled).toBe(false);
        expect(view.byChar.b?.shareKnown).toBe(true);
    });
});
