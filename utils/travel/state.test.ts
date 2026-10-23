/**
 * 前端出行数据 · 客户端状态与轮询（B4）
 *
 * 关注点全是「不可信输入下怎么保守」：
 * - 共享关闭 / 未知 → 立即清缓存，trip 为 null（地名+时间能反查位置）；
 * - 重新打开共享不复活旧轨迹；
 * - 过期/乱序快照丢弃（serverNow 单调）；
 * - 用服务端时间校正本机时钟，展示阶段不被本机时间带跑；
 * - 轮询可取消，取消后不再发请求、也不接受在途结果。
 */
import { describe, expect, it, vi } from 'vitest';
import type { TravelPublicSnapshot, TravelTripView } from './core';
import type { TravelShareState } from '../../contracts/travel';
import { createTravelStateStore } from './state';

const view = (over: Partial<TravelPublicSnapshot> = {}): TravelPublicSnapshot => {
    const trip: TravelTripView = {
        id: 't1',
        status: 'en_route',
        planVersion: 1,
        revision: 1,
        origin: { label: '阳光花园', city: '杭州', district: '西湖区', kind: 'home' },
        dest: { label: '西湖公园', city: '杭州', district: '西湖区', kind: 'public' },
        departAt: 1_000,
        arriveAt: 2_000,
        dwellUntil: 3_000,
        returnAt: 4_000,
    };
    return {
        code: 'OK',
        serverNow: 1_500,
        trip,
        position: { lat: 30.255, lng: 120.14, coordSys: 'gcj02' },
        route: { points: [{ lat: 30.26, lng: 120.13 }, { lat: 30.25, lng: 120.15 }], distanceM: 200 },
        history: [{ lat: 30.26, lng: 120.13 }],
        budget: { mapCallsUsed: 1, mapCallsLimit: 30 },
        shareEnabled: true,
        ...over,
    };
};

const share = (enabled: boolean, version = 1): TravelShareState => ({
    userId: 'u_1',
    charId: 'c_1',
    shareEnabled: enabled,
    version,
});

describe('共享态与缓存撤销', () => {
    it('共享关闭：立即清空 trip/坐标，地名与时间都不留在状态里', () => {
        const store = createTravelStateStore({ now: () => 10_000 });
        store.applyShare(share(true, 1));
        store.applySnapshot(view());
        expect(store.getState().view?.trip?.dest?.label).toBe('西湖公园');

        store.applyShare(share(false, 2));
        const s = store.getState();
        expect(s.shareEnabled).toBe(false);
        expect(s.view?.code).toBe('SHARE_REVOKED');
        expect(s.view?.trip).toBeNull();
        expect(s.view?.position).toBeNull();
        expect(s.view?.route).toBeNull();
        expect(s.view?.history).toEqual([]);
        expect(JSON.stringify(s.view)).not.toContain('西湖公园');
        expect(JSON.stringify(s.view)).not.toContain('阳光花园');
    });

    it('重新打开共享不显示旧轨迹：撤销前的 history 不再回来', () => {
        const store = createTravelStateStore({ now: () => 10_000 });
        store.applyShare(share(true, 1));
        store.applySnapshot(view({ serverNow: 1_500 }));
        expect(store.getState().view?.history.length).toBe(1);

        store.applyShare(share(false, 2));
        expect(store.getState().view?.history).toEqual([]);

        // 重新打开：共享版本 +1，且此刻是「新的共享周期」
        store.applyShare(share(true, 3));
        expect(store.getState().view?.history).toEqual([]);

        // 服务端旧快照（serverNow 早于本次开启）里就算带 history 也不展示
        store.applySnapshot(view({ serverNow: 1_400 }));
        expect(store.getState().view?.history).toEqual([]);

        // 新的、晚于本次开启的快照才接受轨迹
        store.applySnapshot(view({ serverNow: 9_000, history: [{ lat: 30.25, lng: 120.14 }] }));
        expect(store.getState().view?.history.length).toBe(1);
    });

    it('共享版本回退（多设备旧响应）被丢弃，不把关闭覆盖成开启', () => {
        const store = createTravelStateStore({ now: () => 10_000 });
        store.applyShare(share(false, 5));
        store.applyShare(share(true, 4));
        expect(store.getState().shareEnabled).toBe(false);
    });

    it('共享态读失败 → 不当成「默认开启」，按未知 fail-closed', () => {
        const store = createTravelStateStore({ now: () => 10_000 });
        store.applyShare(share(true, 1));
        store.applySnapshot(view());
        store.applyShareUnavailable();
        const s = store.getState();
        expect(s.shareKnown).toBe(false);
        expect(s.shareEnabled).toBe(false);
        expect(s.view?.trip).toBeNull();
        expect(s.view?.position).toBeNull();
    });
});

describe('快照新鲜度与乱序响应', () => {
    it('serverNow 更旧的在途响应被丢弃（后到的旧包不能覆盖新包）', () => {
        const store = createTravelStateStore({ now: () => 10_000 });
        store.applyShare(share(true, 1));
        expect(store.applySnapshot(view({ serverNow: 5_000, budget: { mapCallsUsed: 5, mapCallsLimit: 30 } }))).toBe(true);
        expect(store.applySnapshot(view({ serverNow: 4_000, budget: { mapCallsUsed: 1, mapCallsLimit: 30 } }))).toBe(false);
        expect(store.getState().view?.budget.mapCallsUsed).toBe(5);
        expect(store.getState().staleDropCount).toBe(1);
    });

    it('服务端撤销任何时候都接受（fail-closed 优先于「新鲜度」）', () => {
        const store = createTravelStateStore({ now: () => 10_000 });
        store.applyShare(share(true, 1));
        store.applySnapshot(view({ serverNow: 5_000 }));
        expect(store.applySnapshot(view({ serverNow: 1_000, code: 'SHARE_REVOKED', trip: null, position: null, route: null, history: [] }))).toBe(true);
        expect(store.getState().view?.trip).toBeNull();
    });
});

describe('服务端时间偏差', () => {
    it('按服务端时间校正本机时钟，再算阶段与 ETA', () => {
        let localNow = 100_000;
        const store = createTravelStateStore({ now: () => localNow });
        store.applyShare(share(true, 1));
        // 服务端比本机慢 98_500ms
        store.applySnapshot(view({ serverNow: 1_500, trip: { ...view().trip!, departAt: 1_000, arriveAt: 2_000 } }));
        expect(store.getState().clockSkewMs).toBe(1_500 - 100_000);
        expect(store.serverNowAt(100_500)).toBe(2_000);
        // 本机走到 100_500（= 服务端 2_000）→ 已到达（dwelling），不被本机时间带成 en_route
        localNow = 100_500;
        expect(store.getProgress()!.phase).toBe('dwelling');
    });

    it('丢包/离线时保留最后快照但标记未确认，不用本机时间推进位置', () => {
        const store = createTravelStateStore({ now: () => 100_000 });
        store.applyShare(share(true, 1));
        store.applySnapshot(view({ serverNow: 1_500 }));
        const before = store.getState().view?.position;
        store.markUnconfirmed('NETWORK');
        const s = store.getState();
        expect(s.status).toBe('unconfirmed');
        expect(s.error).toBe('NETWORK');
        expect(s.view?.position).toEqual(before);
        expect(s.confirmedAt).toBe(0); // 未确认：调用方显示「未确认·最后更新 HH:mm」
    });
});

describe('轮询可取消', () => {
    const deferred = <T>() => {
        let resolve!: (v: T) => void;
        const promise = new Promise<T>((r) => {
            resolve = r;
        });
        return { promise, resolve };
    };

    it('取消后不再发请求，也不接受在途结果', async () => {
        const pending = deferred<{ ok: true; data: TravelPublicSnapshot }>();
        const readSharedView = vi.fn(() => pending.promise);
        vi.useFakeTimers();
        try {
            const store = createTravelStateStore({ now: () => 10_000 });
            store.applyShare(share(true, 1));
            const stop = store.startPolling({ charId: 'c_1', api: { readSharedView }, intervalMs: 1_000 });
            expect(readSharedView).toHaveBeenCalledTimes(1);

            stop();
            pending.resolve({ ok: true, data: view({ serverNow: 9_000 }) });
            await Promise.resolve();
            await Promise.resolve();
            expect(store.getState().view).toBeNull();

            await vi.advanceTimersByTimeAsync(5_000);
            expect(readSharedView).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('轮询不会重叠：上一轮没回来就不发下一轮', async () => {
        const pending = deferred<{ ok: true; data: TravelPublicSnapshot }>();
        const readSharedView = vi.fn(() => pending.promise);
        vi.useFakeTimers();
        try {
            const store = createTravelStateStore({ now: () => 10_000 });
            store.applyShare(share(true, 1));
            const stop = store.startPolling({ charId: 'c_1', api: { readSharedView }, intervalMs: 1_000 });
            await vi.advanceTimersByTimeAsync(3_500);
            expect(readSharedView).toHaveBeenCalledTimes(1);
            pending.resolve({ ok: true, data: view({ serverNow: 9_500 }) });
            await vi.advanceTimersByTimeAsync(1_000);
            expect(readSharedView).toHaveBeenCalledTimes(2);
            stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('共享关闭时轮询自己停掉，不再请求位置', async () => {
        const readSharedView = vi.fn(async () => ({ ok: true as const, data: view() }));
        vi.useFakeTimers();
        try {
            const store = createTravelStateStore({ now: () => 10_000 });
            store.applyShare(share(true, 1));
            const stop = store.startPolling({ charId: 'c_1', api: { readSharedView }, intervalMs: 1_000 });
            await vi.advanceTimersByTimeAsync(0);
            const callsAfterFirst = readSharedView.mock.calls.length;
            store.applyShare(share(false, 2));
            await vi.advanceTimersByTimeAsync(5_000);
            expect(readSharedView.mock.calls.length).toBe(callsAfterFirst);
            stop();
        } finally {
            vi.useRealTimers();
        }
    });
});
