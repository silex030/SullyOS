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
