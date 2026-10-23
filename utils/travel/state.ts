/**
 * 角色自主出行 · 客户端状态与轮询（B4）
 *
 * 这里是 UI 唯一的数据源（`components/travel/*` 只读这个 store）。它不管渲染，
 * 只负责「哪些数据可以拿出来用」：
 *
 * - **撤销先本地生效**：共享一关（或共享态读失败）立刻把 trip/坐标/路线/历史清掉，
 *   不等服务端回包。地名 + 时间窗口足以反查位置，所以 `trip` 也一起清。
 * - **重新打开不复活旧轨迹**：撤销会重置共享周期，之后只有「晚于本次开启」的服务端
 *   快照才接受 history；旧包即使带轨迹也不展示。
 * - **乱序/过期响应丢弃**：`serverNow` 单调，后到的旧包不能覆盖新包；但服务端撤销
 *   （`SHARE_REVOKED`）任何时候都接受 —— 安全优先于新鲜度。
 * - **服务端时间才是时间**：`clockSkewMs = serverNow - 本机时间`，阶段/ETA 一律用
 *   `serverNowAt()` 算，避免手机时钟偏差把「还在路上」显示成「已到达」。
 * - **轮询可取消、不重叠**：cancel 之后不再发请求，在途结果也丢弃。
 * - **失败不推进**：请求失败保留最后快照但标 `unconfirmed`（UI 显示「未确认·最后更新」），
 *   不拿本机时间插值当服务端事实。
 */
import type { TravelShareState } from '../../contracts/travel';
import type { TravelApiErrorCode, TravelApiResult } from './api';
import { tripProgress, type TravelPublicSnapshot, type TravelTripProgress } from './core';

export type TravelLoadStatus = 'idle' | 'ready' | 'unconfirmed';

export interface TravelStateView {
    view: TravelPublicSnapshot | null;
    status: TravelLoadStatus;
    error: TravelApiErrorCode | null;
    shareEnabled: boolean;
    /** 共享态是否读到可信值。读失败 → false（不默认活跃）。 */
    shareKnown: boolean;
    shareVersion: number;
    /** 本机收到快照的时间（ms）。 */
    receivedAt: number;
    /** 服务端给的时间（ms）。 */
    serverNow: number;
    /** serverNow - 本机时间；展示阶段/ETA 用它校正。 */
    clockSkewMs: number;
    /** 已确认快照的本地时间；0 = 当前展示的是未确认的旧快照。 */
    confirmedAt: number;
    staleDropCount: number;
}

/** 轮询只需要这一个读口（便于注入假实现，不绑死 api.ts）。 */
export interface TravelStateApi {
    readSharedView: (charId: string) => Promise<TravelApiResult<TravelPublicSnapshot>>;
}

export interface TravelStateStore {
    getState: () => TravelStateView;
    subscribe: (listener: (state: TravelStateView) => void) => () => void;
    applyShare: (share: TravelShareState) => void;
    applyShareUnavailable: () => void;
    applySnapshot: (snapshot: TravelPublicSnapshot) => boolean;
    markUnconfirmed: (error: TravelApiErrorCode) => void;
    startPolling: (args: { charId: string; api: TravelStateApi; intervalMs?: number }) => () => void;
    serverNowAt: (localNow: number) => number;
    getProgress: () => TravelTripProgress | null;
}

const revokedView = (serverNow: number, shareEnabled: boolean): TravelPublicSnapshot => ({
    code: 'SHARE_REVOKED',
    serverNow,
    trip: null,
    position: null,
    route: null,
    history: [],
    budget: { mapCallsUsed: 0, mapCallsLimit: 0 },
    shareEnabled,
});

/** 出参再兜一道：共享没开就一条位置信息都不留。 */
const sanitize = (snapshot: TravelPublicSnapshot, shareEnabled: boolean): TravelPublicSnapshot => {
    if (!shareEnabled || snapshot.code === 'SHARE_REVOKED') {
        return {
            code: 'SHARE_REVOKED',
            serverNow: snapshot.serverNow,
            trip: null,
            position: null,
            route: null,
            history: [],
            budget: snapshot.budget,
            shareEnabled,
        };
    }
    return snapshot;
};

export interface TravelStateStoreOptions {
    now?: () => number;
    /** 共享态未知时是否允许轮询。默认 false：读失败不默认活跃。 */
    pollWhenShareUnknown?: boolean;
}

export function createTravelStateStore(options: TravelStateStoreOptions = {}): TravelStateStore {
    const now = options.now ?? (() => Date.now());

    let state: TravelStateView = {
        view: null,
        status: 'idle',
        error: null,
        shareEnabled: false,
        shareKnown: false,
        shareVersion: 0,
        receivedAt: 0,
        serverNow: 0,
        clockSkewMs: 0,
        confirmedAt: 0,
        staleDropCount: 0,
    };

    /** 本次共享周期开启时的服务端时间；history 早于它就不展示。 */
    let shareEnabledAtServer: number | null = null;
    const listeners = new Set<(s: TravelStateView) => void>();

    const emit = () => {
        for (const fn of listeners) fn(state);
    };

    const setState = (patch: Partial<TravelStateView>) => {
        state = { ...state, ...patch };
        emit();
    };

    const applyShare = (share: TravelShareState) => {
        const version = Number.isFinite(share?.version) ? share.version : 0;
        // 版本回退 = 多设备/乱序的旧响应，丢弃。
        if (version < state.shareVersion) return;

        const enabled = !!share?.shareEnabled;
        const prevEnabled = state.shareEnabled;
        if (enabled && !prevEnabled) {
            // 新共享周期：以「已知的服务端时间」为界，早于它的轨迹不认。
            // 还没有任何快照时留 null（首包就是本周期基线），不拿本机时间冒充服务端时间。
            shareEnabledAtServer = state.serverNow > 0 ? state.serverNow : null;
        }
        if (!enabled) shareEnabledAtServer = null;

        setState({
            shareVersion: version,
            shareEnabled: enabled,
            shareKnown: true,
        });

        if (!enabled) {
            // 关共享：不等服务端，本地立刻清空（下次拿到的快照也不会带位置）。
            setState({ view: revokedView(state.serverNow, false), status: 'ready', error: null });
        }
    };

    const applyShareUnavailable = () => {
        shareEnabledAtServer = null;
        setState({
            shareKnown: false,
            shareEnabled: false,
            view: revokedView(state.serverNow, false),
            status: 'ready',
            error: null,
        });
    };

    const applySnapshot = (snapshot: TravelPublicSnapshot): boolean => {
        if (!snapshot || typeof snapshot.serverNow !== 'number' || !Number.isFinite(snapshot.serverNow)) {
            return false;
        }
        const localNow = now();
        const skew = snapshot.serverNow - localNow;

        // 服务端撤销：任何时候都接受（fail-closed 优先），并同步本地共享位。
        if (snapshot.code === 'SHARE_REVOKED') {
            shareEnabledAtServer = null;
            setState({
                view: sanitize(snapshot, false),
                status: 'ready',
                error: null,
                shareEnabled: false,
                shareKnown: true,
                serverNow: snapshot.serverNow,
                clockSkewMs: skew,
                receivedAt: localNow,
                confirmedAt: localNow,
            });
            return true;
        }

        if (!state.shareEnabled) {
            // 本地共享是关的，服务端就算回了 OK 快照也不渲染内容。
            setState({
                view: revokedView(snapshot.serverNow, false),
                status: 'ready',
                error: null,
                serverNow: snapshot.serverNow,
                clockSkewMs: skew,
                receivedAt: localNow,
                confirmedAt: localNow,
            });
            return true;
        }

        if (state.serverNow > 0 && snapshot.serverNow < state.serverNow) {
            // 后到的旧包：丢弃，并让调用方知道「这次不算新鲜」。
            setState({ staleDropCount: state.staleDropCount + 1 });
            return false;
        }

        const fresh = shareEnabledAtServer === null || snapshot.serverNow >= shareEnabledAtServer;
        const view = sanitize(
            {
                ...snapshot,
                history: fresh ? snapshot.history : [],
            },
            true,
        );

        setState({
            view,
            status: 'ready',
            error: null,
            serverNow: snapshot.serverNow,
            clockSkewMs: skew,
            receivedAt: localNow,
            confirmedAt: localNow,
        });
        return true;
    };

    const markUnconfirmed = (error: TravelApiErrorCode) => {
        setState({ status: 'unconfirmed', error, confirmedAt: 0 });
    };

    const serverNowAt = (localNow: number): number => localNow + state.clockSkewMs;

    const getProgress = (): TravelTripProgress | null => {
        const trip = state.view?.trip;
        if (!trip || state.view?.code !== 'OK') return null;
        // TravelTripView 只有展示需要的字段；tripProgress 只读时间戳，其余字段不参与。
        return tripProgress(trip as never, serverNowAt(now()));
    };

    const startPolling = (args: { charId: string; api: TravelStateApi; intervalMs?: number }): (() => void) => {
        const intervalMs = Math.max(1_000, args.intervalMs ?? 15_000);
        let cancelled = false;
        let inFlight = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const tick = async () => {
            if (cancelled || inFlight) return;
            if (!state.shareEnabled && !options.pollWhenShareUnknown) return;
            inFlight = true;
            let result: TravelApiResult<TravelPublicSnapshot>;
            try {
                result = await args.api.readSharedView(args.charId);
            } catch {
                result = { ok: false, code: 'NETWORK', status: 0 };
            } finally {
                inFlight = false;
            }
            // 取消之后，在途结果一律丢弃（不再写状态、不再排下一轮）。
            if (cancelled) return;
            if (result.ok) applySnapshot(result.data);
            else markUnconfirmed(result.code);

            if (cancelled || !state.shareEnabled) return;
            timer = setTimeout(() => void tick(), intervalMs);
        };

        void tick();

        return () => {
            cancelled = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        };
    };

    return {
        getState: () => state,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        applyShare,
        applyShareUnavailable,
        applySnapshot,
        markUnconfirmed,
        startPolling,
        serverNowAt,
        getProgress,
    };
}

// ==================== 多角色（每角色独立 store + 独立取消句柄） ====================

/** 多角色聚合视图：一次渲染拿到所有角色的脱敏快照（不跨角色复用别人的数据）。 */
export interface TravelMultiStateView {
    /** 面板/预算当前聚焦的角色（不改变其它角色是否在轮询）。 */
    activeCharId: string | null;
    byChar: Record<string, TravelStateView>;
}

/**
 * 多角色 store：每个 char 一个独立 store 与独立轮询取消句柄。
 *
 * 旧实现（单 store）在切角色时会 `stop` 上一个角色的轮询，导致顶部只剩一个人；
 * 这里的硬约定：
 * - `startPolling` 只影响传入的 charId，切角色不停别人的轮询；
 * - `stopChar` / `revokeChar` 只清该角色（共享关掉不会抹掉另一个人的在途行程）；
 * - 聚合视图只暴露各角色自己 store 里已经过 `sanitize` 的数据，不共享快照、不串数据；
 * - `getState()` 返回当前聚焦角色的视图（面板/预算沿用单角色读法）。
 */
export interface TravelMultiStateStore extends TravelStateStore {
    getMultiState: () => TravelMultiStateView;
    subscribeMulti: (listener: (state: TravelMultiStateView) => void) => () => void;
    setActiveChar: (charId: string | null) => void;
    getStateFor: (charId: string) => TravelStateView;
    /** 只改这个角色的共享位（别的角色不受影响）。 */
    applyShareFor: (charId: string, share: TravelShareState) => void;
    /** 只把这个角色的共享位标成「读不到可信值」。 */
    applyShareUnavailableFor: (charId: string) => void;
    getCharIds: () => string[];
    stopChar: (charId: string) => void;
    stopAll: () => void;
    /** 撤销：立刻清掉该角色的 trip/坐标/路线/历史（不停别人）。 */
    revokeChar: (charId: string) => void;
}

/**
 * 空视图必须是**同一个对象**：`getState` 要喂给 useSyncExternalStore，
 * 每次返回新字面量会被 React 判成「快照一直在变」而无限重渲染。
 */
const EMPTY_VIEW: TravelStateView = Object.freeze({
    view: null,
    status: 'idle',
    error: null,
    shareEnabled: false,
    shareKnown: false,
    shareVersion: 0,
    receivedAt: 0,
    serverNow: 0,
    clockSkewMs: 0,
    confirmedAt: 0,
    staleDropCount: 0,
});

const emptyView = (): TravelStateView => EMPTY_VIEW;

export function createTravelMultiStateStore(
    options: TravelStateStoreOptions = {},
): TravelMultiStateStore {
    const perChar = new Map<string, TravelStateStore>();
    const cancels = new Map<string, () => void>();
    const listeners = new Set<(state: TravelMultiStateView) => void>();
    let active: string | null = null;
    let snapshot: TravelMultiStateView = { activeCharId: null, byChar: {} };

    const rebuild = () => {
        const byChar: Record<string, TravelStateView> = {};
        for (const [id, store] of perChar) byChar[id] = store.getState();
        snapshot = { activeCharId: active, byChar };
        for (const fn of listeners) fn(snapshot);
    };

    const storeFor = (charId: string): TravelStateStore => {
        const existing = perChar.get(charId);
        if (existing) return existing;
        const created = createTravelStateStore(options);
        perChar.set(charId, created);
        created.subscribe(() => rebuild());
        rebuild();
        return created;
    };

    const getStateFor = (charId: string): TravelStateView =>
        perChar.get(charId)?.getState() ?? emptyView();

    const current = (): TravelStateView => {
        if (active) return getStateFor(active);
        const ids = [...perChar.keys()];
        return ids.length === 1 ? getStateFor(ids[0]!) : emptyView();
    };

    return {
        getState: current,
        getStateFor,
        subscribe: (listener) => {
            const wrapped = () => listener(current());
            listeners.add(wrapped);
            return () => listeners.delete(wrapped);
        },
        getMultiState: () => snapshot,
        subscribeMulti: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        setActiveChar: (charId) => {
            const next = charId && charId.trim() ? charId.trim() : null;
            if (next === active) return;
            if (next) storeFor(next);
            active = next;
            rebuild();
        },
        getCharIds: () => [...perChar.keys()],
        startPolling: (args) => {
            const store = storeFor(args.charId);
            cancels.get(args.charId)?.();
            const stop = store.startPolling(args);
            cancels.set(args.charId, stop);
            return () => {
                cancels.get(args.charId)?.();
                cancels.delete(args.charId);
            };
        },
        stopChar: (charId) => {
            cancels.get(charId)?.();
            cancels.delete(charId);
        },
        stopAll: () => {
            for (const stop of cancels.values()) stop();
            cancels.clear();
        },
        revokeChar: (charId) => {
            cancels.get(charId)?.();
            cancels.delete(charId);
            const store = perChar.get(charId);
            if (!store) return;
            const prev = store.getState();
            // 立刻本地撤销：按「本周期共享已关」清 trip/坐标/路线/历史，把版本推进一格，
            // 避免紧跟着到达的旧包把内容又贴回来；只影响这个角色。
            store.applyShare({
                shareEnabled: false,
                version: prev.shareVersion + 1,
            } as TravelShareState);
        },
        applyShareFor: (charId, share) => {
            storeFor(charId).applyShare(share);
        },
        applyShareUnavailableFor: (charId) => {
            storeFor(charId).applyShareUnavailable();
        },
        applyShare: (share) => {
            if (active) storeFor(active).applyShare(share);
        },
        applyShareUnavailable: () => {
            if (active) storeFor(active).applyShareUnavailable();
        },
        applySnapshot: (snapshotValue) => (active ? storeFor(active).applySnapshot(snapshotValue) : false),
        markUnconfirmed: (error) => {
            if (active) storeFor(active).markUnconfirmed(error);
        },
        serverNowAt: (localNow) => current().confirmedAt ? localNow + current().clockSkewMs : localNow,
        getProgress: () => (active ? perChar.get(active)?.getProgress() ?? null : null),
    };
}
