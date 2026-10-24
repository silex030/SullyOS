/**
 * 地图（真实地点）就绪 · 单一快照
 *
 * 为什么单独一份：设置页宫格以前只读 `RealtimeConfig`，而地图凭据早已搬到服务端
 * 按账号加密（`/travel/map/credentials`）。两边各读一份就会出现「宫格已配置、卡片
 * 未配置」两份权威。这里把「后端存在性读回」收敛成一份快照 + 订阅：
 * - 父宫格与地图服务卡订阅同一份，**只打一次**后端读回（单飞去重）；
 * - 分级就绪：REST 侧只认 Web 服务 Key；底图侧要 JS Key **与** jscode 成对，
 *   任一单把 Key 都不等于全就绪；
 * - 旧 `RealtimeConfig.amapApiKey` **不参与判定**：它只是「迁移本机旧 Key」的输入；
 * - 失败/未读到就落 `error`，不把读不到伪装成已就绪。
 */
import { getTravelRuntime, type TravelMapCredentialView } from './runtime';
import { readTravelOwnerCredential, travelSessionState } from './session';

export interface MapCredentialPresenceLike {
    amapWebKey: boolean;
    amapJsKey: boolean;
    amapJsCode: boolean;
    mapboxToken: boolean;
}

export type MapReadinessPhase =
    | 'pending-approval'
    | 'unconnected'
    | 'error'
    | 'unconfigured'
    | 'partial'
    | 'ready';

export interface MapReadinessInput {
    /** 本机有没有可用会话/owner 凭据（没有就读不到服务端）。 */
    paired: boolean;
    /** 是否正等实例本机批准（申请连接已提交）。 */
    pairPending: boolean;
    /** 后端存在性是否读到了（known:false = 读不到，不等于未配置）。 */
    known: boolean;
    error: string | null;
    has: MapCredentialPresenceLike | null;
    /** 服务端有记录但解不开（主密钥变更过）。 */
    unreadable?: boolean;
}

export interface MapReadinessSnapshot {
    phase: MapReadinessPhase;
    /** 一句话中文说明（宫格 title 与卡片共用，不得两处各写一句）。 */
    detail: string;
    known: boolean;
    error: string | null;
    paired: boolean;
    pairPending: boolean;
    /** REST 侧（地点搜索/地理编码/路线/静态图）就绪。 */
    restReady: boolean;
    /** 底图侧（JS Key + jscode 成对）就绪。 */
    basemapReady: boolean;
    /** 国外底图（Mapbox 公钥）就绪——可选，不参与国内就绪判定。 */
    intlReady: boolean;
    fullyReady: boolean;
    /** 后端原样视图（卡片填「已保存/未保存」用；不含任何服务端秘密）。 */
    credentials: TravelMapCredentialView | null;
    /** 上次读回时间（0=还没读过）。卡片据此避免父层刚读过又重复打一次。 */
    refreshedAt: number;
}

const EMPTY: MapReadinessInput = { paired: false, pairPending: false, known: false, error: null, has: null };

/** 纯函数：把「后端存在性 + 连接状态」映射成可见状态。旧 Key 不是入参，结构上无法参与。 */
export const deriveMapReadiness = (input: MapReadinessInput): MapReadinessSnapshot => {
    const paired = input.paired === true;
    const pairPending = input.pairPending === true && !paired;
    const known = input.known === true;
    const has = input.has ?? null;
    const restReady = known && has?.amapWebKey === true;
    const basemapReady = known && has?.amapJsKey === true && has?.amapJsCode === true;
    const intlReady = known && has?.mapboxToken === true;

    let phase: MapReadinessPhase;
    let detail: string;
    if (pairPending) {
        phase = 'pending-approval';
        detail = '等待实例本机批准：批准后本页会自动连接';
    } else if (!paired) {
        phase = 'unconnected';
        detail = '未连接：本机还没有出行会话，也未读到服务端凭据';
    } else if (!known || input.unreadable === true) {
        phase = 'error';
        detail = input.unreadable
            ? '读取失败：服务端有记录但解不开（主密钥变更过），保存会被拒绝'
            : `读取失败（${input.error ?? '未知原因'}）：现在不能确认服务端凭据，可重试`;
    } else if (restReady && basemapReady) {
        phase = 'ready';
        detail = '已就绪：地点搜索与地图底图凭据都在服务端';
    } else if (restReady) {
        phase = 'partial';
        detail = '部分就绪：地点搜索/路线可用，还缺 JS API Key + jscode（底图不出图）';
    } else if (basemapReady) {
        phase = 'partial';
        detail = '部分就绪：底图凭据在，还缺 Web 服务 Key（地点搜索/路线不可用）';
    } else {
        phase = 'unconfigured';
        detail = '未配置：服务端没有地图凭据（填 Key 只写入，不发地图请求）';
    }

    return {
        phase,
        detail,
        known,
        error: input.error,
        paired,
        pairPending,
        restReady,
        basemapReady,
        intlReady,
        fullyReady: restReady && basemapReady,
        credentials: null,
        refreshedAt: 0,
    };
};

let snapshot: MapReadinessSnapshot = deriveMapReadiness(EMPTY);
let pairPendingFlag = false;
let inflight: Promise<MapReadinessSnapshot> | null = null;
const listeners = new Set<(s: MapReadinessSnapshot) => void>();

const commit = (next: MapReadinessSnapshot) => {
    snapshot = next;
    for (const fn of listeners) fn(snapshot);
};

export const getMapReadinessSnapshot = (): MapReadinessSnapshot => snapshot;

export const subscribeMapReadiness = (fn: (s: MapReadinessSnapshot) => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
};

/** 「申请连接」已提交 / 已结束时标记（批准中不该显示成已连接，也不该假装未申请）。 */
export const setMapPairPending = (pending: boolean): void => {
    if (pairPendingFlag === pending) return;
    pairPendingFlag = pending;
    commit({ ...snapshot, pairPending: pending && !snapshot.paired, phase: pending && !snapshot.paired ? 'pending-approval' : snapshot.phase,
        detail: pending && !snapshot.paired ? '等待实例本机批准：批准后本页会自动连接' : snapshot.detail });
};

/** 单飞：同一时刻只发一次后端读回；父与卡同时挂载也只算一次。 */
export async function refreshMapReadiness(
    runtime: { readMapCredentials: () => Promise<{ known: boolean; credentials: TravelMapCredentialView | null; error: string | null }> } = getTravelRuntime(),
): Promise<MapReadinessSnapshot> {
    if (inflight) return inflight;
    inflight = (async () => {
        const paired = !!readTravelOwnerCredential() || travelSessionState() !== 'unconfigured';
        let res: { known: boolean; credentials: TravelMapCredentialView | null; error: string | null };
        try {
            res = await runtime.readMapCredentials();
        } catch {
            res = { known: false, credentials: null, error: 'NETWORK' };
        }
        const base = deriveMapReadiness({
            paired,
            pairPending: pairPendingFlag,
            known: res.known === true,
            error: res.error ?? null,
            has: res.credentials?.has ?? null,
            unreadable: res.credentials?.unreadable === true,
        });
        commit({ ...base, credentials: res.known ? res.credentials : null, refreshedAt: Date.now() });
        return snapshot;
    })();
    try {
        return await inflight;
    } finally {
        inflight = null;
    }
}

/** 仅测试：回到初始快照（订阅者清空）。 */
export function __resetMapReadinessForTests(): void {
    snapshot = deriveMapReadiness(EMPTY);
    pairPendingFlag = false;
    inflight = null;
    listeners.clear();
}
