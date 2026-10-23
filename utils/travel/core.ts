/**
 * 角色自主出行 · 纯逻辑核心（B0）
 *
 * 只放确定性、无 IO 的规则：状态机、沿折线距离插值、脱敏白名单、
 * 主体绑定、预算 0/缺省语义、撤销共享快照。
 *
 * 约束：
 * - 不 import 任何仓库模块（保持叶子纯净，前端与 worker bundle 都能直接吃）；
 * - 不读时钟、不读 localStorage、不发请求 —— `now` 一律由调用方传入；
 * - 不返回、不拼装坐标以外的隐私字段（address / 门牌 / 楼栋）；
 * - 任何「拿不到可信数据」的路径都返回 null / 拒绝码，不返回编造值。
 */
import {
    MAX_CANDIDATES,
    TRAVEL_PLAN_CHANGEABLE_STATUSES,
    TRAVEL_TERMINAL_STATUSES,
    TRAVEL_TRANSITIONS,
    type TravelBudgetKind,
    type TravelBudgetState,
    type TravelCandidateView,
    type TravelCoordSys,
    type TravelErrorCode,
    type TravelGeoPoint,
    type TravelLatLng,
    type TravelPlaceAnchor,
    type TravelPlaceRef,
    type TravelShareState,
    type TravelStateSnapshot,
    type TravelTrip,
    type TravelTripStatus,
    type TravelWishState,
} from '../../contracts/travel';

const EARTH_RADIUS_M = 6_371_008.8;

/** 两点球面距离（米）。故意不引 utils/amapCore，保证本文件零依赖。 */
export const metersBetween = (a: TravelLatLng, b: TravelLatLng): number => {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** 折线总长（米）。 */
export const routeDistanceMeters = (points: readonly TravelLatLng[]): number => {
    let total = 0;
    for (let i = 1; i < points.length; i += 1) total += metersBetween(points[i - 1], points[i]);
    return total;
};

/**
 * 沿折线按累计距离插值。
 * @param ratio 0..1 的行程比例（按距离，不按顶点序号；越界夹紧）
 * @returns 折线上的点；空折线返回 null（无几何就不给点，不编造）
 */
export const positionAt = (
    points: readonly TravelLatLng[],
    ratio: number,
): TravelLatLng | null => {
    if (!points.length) return null;
    if (points.length === 1) return { lat: points[0].lat, lng: points[0].lng };

    const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
    const total = routeDistanceMeters(points);
    if (!(total > 0)) return { lat: points[0].lat, lng: points[0].lng };

    const target = total * clamped;
    let walked = 0;
    for (let i = 1; i < points.length; i += 1) {
        const leg = metersBetween(points[i - 1], points[i]);
        if (leg <= 0) continue;
        if (walked + leg >= target) {
            const t = (target - walked) / leg;
            return {
                lat: points[i - 1].lat + (points[i].lat - points[i - 1].lat) * t,
                lng: points[i - 1].lng + (points[i].lng - points[i - 1].lng) * t,
            };
        }
        walked += leg;
    }
    const last = points[points.length - 1];
    return { lat: last.lat, lng: last.lng };
};

export interface TravelTripProgress {
    /** 与 `travel_trips.phase` 同源；UI 只读。 */
    phase: TravelTripStatus;
    outboundRatio: number;
    returnRatio: number;
    /** 只有 `arriveAt` 可信时才给；没有就是 null（UI 显示「未知」，不估算）。 */
    etaMs: number | null;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

const ratioBetween = (from: number | null, to: number | null, now: number): number => {
    if (from === null || to === null || to <= from) return 0;
    return clamp01((now - from) / (to - from));
};

/**
 * 按服务端时间戳推相位（纯函数，客户端不得据此「推进」服务端状态，只用于展示）。
 * 时间戳缺失时保守回到上一相位，不跳到终态。
 */
export const tripProgress = (trip: TravelTrip, now: number): TravelTripProgress => {
    const { departAt, arriveAt, dwellUntil, returnAt } = trip;
    const base = {
        outboundRatio: ratioBetween(departAt, arriveAt, now),
        returnRatio: ratioBetween(dwellUntil, returnAt, now),
    };

    if (departAt === null || now < departAt) {
        return { phase: 'planned', ...base, outboundRatio: 0, returnRatio: 0, etaMs: null };
    }
    if (arriveAt !== null && now >= arriveAt) {
        const etaMs = null;
        if (dwellUntil !== null && now < dwellUntil) {
            return { phase: 'dwelling', ...base, etaMs };
        }
        if (returnAt !== null && now < returnAt) return { phase: 'returning', ...base, etaMs };
        if (returnAt !== null) return { phase: 'returned', ...base, etaMs };
        // 没有返程计划：到点即视为停留结束但仍留在目的地
        return { phase: 'dwelling', ...base, etaMs };
    }
    const etaMs = arriveAt !== null ? Math.max(0, arriveAt - now) : null;
    return { phase: 'en_route', ...base, etaMs };
};

export const isTerminalStatus = (status: TravelTripStatus): boolean =>
    (TRAVEL_TERMINAL_STATUSES as readonly TravelTripStatus[]).includes(status);

/** 服务端 tick 的合法相位边。客户端没有这个入口。 */
export const canTransition = (from: TravelTripStatus, to: TravelTripStatus): boolean =>
    TRAVEL_TRANSITIONS[from].includes(to);

/** 改计划在任何非终态允许；实现上插入新代 + 旧行 aborted(plan_changed)，不原地改。 */
export const canChangePlan = (status: TravelTripStatus): boolean =>
    (TRAVEL_PLAN_CHANGEABLE_STATUSES as readonly TravelTripStatus[]).includes(status);

/* ------------------------------------------------------------------ *
 * 脱敏：结构性白名单，不靠宽泛「数字＋号」正则
 * ------------------------------------------------------------------ */

/** 住户级细节：栋/幢/单元/层/室/房/户 + 「N号楼M」+ 「门牌」。公共门牌（中山路100号、3号门）不在内。 */
const HOUSEHOLD_PATTERN = /\d+\s*(栋|幢|单元|层|室|房|户)|\d+\s*号楼\s*\d+|门牌/;

/** 小数坐标对（3 位以上小数）：任何进提示词/日志的文本都要拦。 */
const COORDINATE_PATTERN = /-?\d{1,3}\.\d{3,}\s*[,，]\s*-?\d{1,3}\.\d{3,}/;

export type PlaceRejectionCode = 'HOUSEHOLD_DETAIL';

export type SanitizeResult =
    | { ok: true; label: string }
    | { ok: false; code: PlaceRejectionCode; message: string };

const HOUSEHOLD_MESSAGE = '只填到小区/楼群或公共地点名，不要门牌、楼栋、单元、楼层或房号';

/** 固定地点名入口：只拒住户级组合，不误杀「中山路100号」「XX社区3号门」。 */
export const sanitizeAnchorLabel = (raw: string): SanitizeResult => {
    const label = typeof raw === 'string' ? raw.trim() : '';
    if (!label) return { ok: false, code: 'HOUSEHOLD_DETAIL', message: HOUSEHOLD_MESSAGE };
    if (HOUSEHOLD_PATTERN.test(label) || COORDINATE_PATTERN.test(label)) {
        return { ok: false, code: 'HOUSEHOLD_DETAIL', message: HOUSEHOLD_MESSAGE };
    }
    return { ok: true, label };
};

/** 提示词/日志/备份统一走这里：只出地名 + 城市 + 区，坐标与原始 address 永不出。 */
export interface MaskedPlace {
    label: string;
    city: string;
    district?: string;
}

export const maskPlace = (place: {
    label?: string;
    name?: string;
    city?: string;
    district?: string;
    address?: string;
    lat?: number;
    lng?: number;
}): MaskedPlace => {
    const label = String(place.label ?? place.name ?? '').trim();
    const city = String(place.city ?? '').trim();
    const district = String(place.district ?? '').trim();
    const out: MaskedPlace = { label, city };
    if (district) out.district = district;
    return out;
};

export interface AnchorPickInput {
    name?: string;
    label?: string;
    city?: string;
    district?: string;
    address?: string;
    lat?: number;
    lng?: number;
    coordSys?: TravelCoordSys | string;
    placeId?: string;
}

const isCoordSys = (v: unknown): v is TravelCoordSys => v === 'gcj02' || v === 'wgs84';

/**
 * POI / 手填地点 → 锚点白名单字段。缺 coordSys、缺坐标、或名字是住户级细节 → null。
 * 返回对象**没有 address**：地址文本从不入库。
 */
export const pickAnchorFields = (
    poi: AnchorPickInput,
    confirmedAt: number,
): TravelPlaceAnchor | null => {
    if (!isCoordSys(poi.coordSys)) return null;
    if (typeof poi.lat !== 'number' || typeof poi.lng !== 'number') return null;
    if (!Number.isFinite(poi.lat) || !Number.isFinite(poi.lng)) return null;
    const sanitized = sanitizeAnchorLabel(String(poi.label ?? poi.name ?? ''));
    if (!sanitized.ok) return null;
    const city = String(poi.city ?? '').trim();
    if (!city) return null;
    const district = String(poi.district ?? '').trim();
    const anchor: TravelPlaceAnchor = {
        label: sanitized.label,
        city,
        lat: poi.lat,
        lng: poi.lng,
        coordSys: poi.coordSys,
        precision: 'area',
        confirmedAt,
        source: 'user',
    };
    if (district) anchor.district = district;
    return anchor;
};

export type WishTextResult =
    | { ok: true; text: string }
    | { ok: false; code: 'EMPTY' | PlaceRejectionCode; message: string };

/** 愿望文本：角色原话可以自由，但不得夹带坐标或住户门牌。 */
export const sanitizeWishText = (raw: string): WishTextResult => {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return { ok: false, code: 'EMPTY', message: '愿望为空' };
    if (COORDINATE_PATTERN.test(text)) {
        return { ok: false, code: 'HOUSEHOLD_DETAIL', message: '不要给坐标，说想去哪类地方就行' };
    }
    if (HOUSEHOLD_PATTERN.test(text)) {
        return { ok: false, code: 'HOUSEHOLD_DETAIL', message: HOUSEHOLD_MESSAGE };
    }
    return { ok: true, text };
};

/* ------------------------------------------------------------------ *
 * 身份：user_id 只来自已验证主体
 * ------------------------------------------------------------------ */

export interface PrincipalInput {
    /** 由现有认证主体派生的用户 id（客户端会话 / 后端签发）。null = 未授权。 */
    principalUserId: string | null | undefined;
    /** `X-User-Id` 头：只作为一致性断言，绝不作为身份来源。 */
    headerUserId: string | null | undefined;
}

export type PrincipalResult =
    | { ok: true; userId: string }
    | { ok: false; code: Extract<TravelErrorCode, 'UNAUTHORIZED' | 'PRINCIPAL_MISMATCH'> };

export const resolvePrincipal = (input: PrincipalInput): PrincipalResult => {
    const principal = (input.principalUserId ?? '').trim();
    if (!principal) return { ok: false, code: 'UNAUTHORIZED' };
    const header = (input.headerUserId ?? '').trim();
    if (header && header !== principal) return { ok: false, code: 'PRINCIPAL_MISMATCH' };
    return { ok: true, userId: principal };
};

/* ------------------------------------------------------------------ *
 * 预算：0 / 缺省 / 读失败语义
 * ------------------------------------------------------------------ */

export type BudgetGate =
    | { allowed: true }
    | { allowed: false; code: Extract<TravelErrorCode, 'BUDGET_BLOCKED' | 'BUDGET_ZERO'> };

/**
 * 账号级单一账本。`state === null` 表示读不到账本（缺行或读失败）→ **fail-closed**，
 * 不用任何正数默认值补。`limit === 0` 是硬零（BUDGET_ZERO），暂停优先于额度。
 */
export const resolveBudgetGate = (
    state: TravelBudgetState | null | undefined,
    kind: TravelBudgetKind,
): BudgetGate => {
    if (!state) return { allowed: false, code: 'BUDGET_BLOCKED' };
    if (state.paused) return { allowed: false, code: 'BUDGET_BLOCKED' };
    const limit = kind === 'map' ? state.mapCallsLimit : state.llmTokensLimit;
    const used = kind === 'map' ? state.mapCallsUsed : state.llmTokensUsed;
    if (!Number.isFinite(limit) || limit < 0) return { allowed: false, code: 'BUDGET_BLOCKED' };
    if (limit === 0) return { allowed: false, code: 'BUDGET_ZERO' };
    // 负数 / NaN / Infinity 的 used 不是「还没用」，是被写坏的账本 —— fail-closed，
    // 不能因为 `-1 >= 30` 为 false 就放行。
    if (!Number.isFinite(used) || used < 0 || used >= limit) {
        return { allowed: false, code: 'BUDGET_BLOCKED' };
    }
    return { allowed: true };
};

/** 账号固定时区的日键（YYYY-MM-DD）。跨日只清 used，limit 与 paused 原样保留。 */
export const dayKey = (nowMs: number, timeZone: string): string => {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timeZone || 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date(nowMs));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
};

/* ------------------------------------------------------------------ *
 * 愿望结局：角色放弃 ≠ 接口失败 ≠ 角色不想出门
 * ------------------------------------------------------------------ */

export type WishOutcomeInput = 'provider_failed' | 'budget_blocked' | 'none' | 'chosen';

export interface WishOutcome {
    state: TravelWishState;
    event: 'provider_failed' | 'budget_blocked' | 'dropped' | 'chosen';
}

/**
 * `provider_failed` / `budget_blocked`：wish 保持 open 待重试，**不写成「不想出门」**。
 * `none`：角色主动放弃（允许），wish → dropped 并记事件。
 */
export const resolveWishOutcome = (outcome: WishOutcomeInput): WishOutcome => {
    switch (outcome) {
        case 'chosen':
            return { state: 'chosen', event: 'chosen' };
        case 'none':
            return { state: 'dropped', event: 'dropped' };
        case 'budget_blocked':
            return { state: 'open', event: 'budget_blocked' };
        default:
            return { state: 'open', event: 'provider_failed' };
    }
};

/** 候选上限 + 按 id 去重（服务端冻结前最后一道闸）。 */
export const clampCandidates = <T extends Pick<TravelCandidateView, 'id'>>(
    candidates: readonly T[],
): T[] => {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const c of candidates) {
        if (!c || typeof c.id !== 'string' || seen.has(c.id)) continue;
        seen.add(c.id);
        out.push(c);
        if (out.length >= MAX_CANDIDATES) break;
    }
    return out;
};

/* ------------------------------------------------------------------ *
 * 共享：撤销即服务端权威位，快照脱敏
 * ------------------------------------------------------------------ */

/** 行程的对外视图：只有地名与时间，没有任何 lat/lng/coordSys。 */
export interface TravelTripView {
    id: string;
    status: TravelTripStatus;
    planVersion: number;
    revision: number;
    origin: MaskedPlace & { kind?: string };
    dest: (MaskedPlace & { kind?: string }) | null;
    departAt: number | null;
    arriveAt: number | null;
    dwellUntil: number | null;
    returnAt: number | null;
}

export interface TravelPublicSnapshot {
    code: 'OK' | 'SHARE_REVOKED';
    serverNow: number;
    trip: TravelTripView | null;
    position: TravelGeoPoint | null;
    route: { points: TravelLatLng[]; distanceM: number } | null;
    history: TravelLatLng[];
    budget: { mapCallsUsed: number; mapCallsLimit: number };
    shareEnabled: boolean;
}

const toTripView = (trip: TravelTrip): TravelTripView => ({
    id: trip.id,
    status: trip.status,
    planVersion: trip.planVersion,
    revision: trip.revision,
    origin: { ...maskPlace(trip.origin), ...(trip.origin.kind ? { kind: trip.origin.kind } : {}) },
    dest: trip.dest
        ? { ...maskPlace(trip.dest), ...(trip.dest.kind ? { kind: trip.dest.kind } : {}) }
        : null,
    departAt: trip.departAt,
    arriveAt: trip.arriveAt,
    dwellUntil: trip.dwellUntil,
    returnAt: trip.returnAt,
});

/**
 * 共享关闭（或服务端已判 `SHARE_REVOKED`）时：**整份行程一起剥离** ——
 * trip / position / route / history 全为 null/[]，不出地名、目的地、时间。
 *
 * 为什么 trip 也不能留：`origin`/`dest` 的 label 是可反查位置的语义信息
 * （「阳光花园」「西湖公园」+ 时间窗口足以定位），留着等于关着共享还在泄露。
 * 调用方要展示「TA 今天有没有出门」这类信息时，必须走独立的非位置接口，
 * 不能从这里捞。不改入参，也不写 trip（共享与出行是两条独立的态）。
 */
export const redactSharedSnapshot = (
    snapshot: TravelStateSnapshot,
    share: TravelShareState,
): TravelPublicSnapshot => {
    const shareEnabled = !!share.shareEnabled;
    // 服务端已经撤销时，本地 share=true 不作数（撤销是服务端权威位）。
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
    return {
        code: 'OK',
        serverNow: snapshot.serverNow,
        trip: snapshot.trip ? toTripView(snapshot.trip) : null,
        position: snapshot.position ?? null,
        route: snapshot.route ? { points: [...snapshot.route.points], distanceM: snapshot.route.distanceM } : null,
        history: snapshot.history.map((p) => ({ lat: p.lat, lng: p.lng })),
        budget: snapshot.budget,
        shareEnabled,
    };
};

/** 几何许可：只有取得 G1b 书面许可才允许落路线/展示道路位置；否则 403 码。 */
export const geometryGate = (licensed: boolean): { ok: true } | { ok: false; code: 'GEOMETRY_NOT_LICENSED' } =>
    licensed ? { ok: true } : { ok: false, code: 'GEOMETRY_NOT_LICENSED' };

/** 无许可时不返回任何坐标点（不是返回城市中心，也不是返回直线插值）。 */
export const licensedPositionAt = (
    points: readonly TravelLatLng[] | null | undefined,
    ratio: number,
    licensed: boolean,
): TravelLatLng | null => (licensed && points ? positionAt(points, ratio) : null);

/** 固定地点不存在/未确认时不出门（不用城市中心当住处）。 */
export const requireAnchor = (anchor: TravelPlaceAnchor | null | undefined) =>
    anchor && anchor.confirmedAt > 0
        ? ({ ok: true, anchor } as const)
        : ({ ok: false, code: 'ANCHOR_NOT_CONFIRMED' } as const);
