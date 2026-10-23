/**
 * 出行 · 服务端快照 / 角色内部上下文（B3）
 *
 * 两条**不同**的出口，别混用：
 *
 * 1. `buildTravelSnapshot()` —— 对外（前端面板/悬浮球）只读快照，形状严格是契约
 *    `TravelStateSnapshot`。共享关闭时整份行程剥离（`trip: null`，不回地名、不回时间）；
 *    共享**重新打开**也不复活旧轨迹：只看 `share.updatedAt` 之后新建的行程。
 * 2. `buildRoleTravelContext()` —— 角色自己的内部上下文（写愿望、决定要不要改计划时用）。
 *    它不依赖共享位（共享是给用户看的，不影响角色知不知道自己在哪），但**不含坐标**，
 *    只有地名、相位与「要不要多久」的语义。任何 HTTP 公开读都不许调它。
 *
 * 几何（路线点/位置）只在 `geometryPersistence === 'allowed'` 时出现；许可来自 env，
 * 用户请求体不能解锁（`resolveTravelLicenses` 只读 env）。
 */

import {
    type TravelBudgetState,
    type TravelPlaceRef,
    type TravelShareState,
    type TravelStateSnapshot,
    type TravelTrip,
    type TravelTripStatus,
    TRAVEL_RETENTION_DEFAULTS,
} from '../../../../contracts/travel';
import {
    isTerminalStatus,
    positionAt,
    tripProgress,
    type TravelTripProgress,
} from '../../../../utils/travel/core';

export type TravelGeometryLicense = 'allowed' | 'not-licensed';
export type TravelBasemapLicense = 'licensed' | 'not-configured';

export interface TravelLicenseView {
    geometryPersistence: TravelGeometryLicense;
    basemapDisplay: TravelBasemapLicense;
}

/**
 * 许可**只**从环境读（书面授权落地后由运维改 env，不能由前端/用户请求体解锁）。
 * 认的变量名写死在这里，避免各处自己拼。
 */
export const TRAVEL_LICENSE_ENV = {
    geometry: 'TRAVEL_GEOMETRY_LICENSE',
    basemap: 'TRAVEL_BASEMAP_LICENSE',
} as const;

export function resolveTravelLicenses(env: Record<string, unknown> | null | undefined): TravelLicenseView {
    const geometry = String(env?.[TRAVEL_LICENSE_ENV.geometry] ?? '').trim().toLowerCase();
    const basemap = String(env?.[TRAVEL_LICENSE_ENV.basemap] ?? '').trim().toLowerCase();
    return {
        geometryPersistence: geometry === 'allowed' ? 'allowed' : 'not-licensed',
        basemapDisplay: basemap === 'licensed' ? 'licensed' : 'not-configured',
    };
}

/** 库里比契约多出的两列（路线只在取得许可后才存在；createdAt 用来判共享代际）。 */
export type TravelSnapshotTrip = TravelTrip & {
    route?: { points: readonly { lat: number; lng: number }[]; distanceM: number } | null;
    createdAt?: number;
};

export interface TravelSnapshotInput {
    trip: TravelSnapshotTrip | null;
    share: Pick<TravelShareState, 'shareEnabled' | 'version'> & { updatedAt?: number };
    budget: Pick<TravelBudgetState, 'mapCallsUsed' | 'mapCallsLimit'> | null;
    nowMs: number;
    geometryPersistence: TravelGeometryLicense;
    /**
     * 本次共享代际内的位置采样（调用方用 `listTravelPositions(minShareGeneration)` 取，
     * 已按代数过滤）。几何未许可 / 没有真实采样时传空 —— 不插值、不伪造轨迹。
     */
    history?: readonly { lat: number; lng: number }[];
}

const budgetView = (
    budget: Pick<TravelBudgetState, 'mapCallsUsed' | 'mapCallsLimit'> | null,
): { mapCallsUsed: number; mapCallsLimit: number } => ({
    mapCallsUsed: Math.max(0, Math.trunc(Number(budget?.mapCallsUsed ?? 0)) || 0),
    mapCallsLimit: Math.max(0, Math.trunc(Number(budget?.mapCallsLimit ?? 0)) || 0),
});

/** 地名语义视图：只有 label/city/district/kind，结构性没有坐标字段。 */
const placeView = (place: TravelPlaceRef): {
    label: string;
    city: string;
    district?: string;
    kind?: string;
} => ({
    label: place.label,
    city: place.city,
    ...(place.district ? { district: place.district } : {}),
    ...(place.kind ? { kind: place.kind } : {}),
});

/**
 * 共享代（generation）：`share.updatedAt` 是最后一次开关共享的服务端时间。
 * 行程在这之后**创建**才算本代；之前的一律不出（重新打开不复活旧轨迹）。
 */
export function shareGenerationStartMs(share: { shareEnabled: boolean; updatedAt?: number }): number {
    const at = Number(share.updatedAt ?? 0);
    return Number.isFinite(at) && at > 0 ? at : 0;
}

export function isTripInShareGeneration(
    trip: Pick<TravelTrip, 'id'> & { createdAt?: number },
    share: { shareEnabled: boolean; updatedAt?: number },
): boolean {
    const start = shareGenerationStartMs(share);
    if (start <= 0) return true;
    const createdAt = Number(trip.createdAt ?? 0);
    return Number.isFinite(createdAt) && createdAt >= start;
}

/**
 * 对外快照。规则（全部有回归）：
 * - 共享关闭 / 无共享行 → `SHARE_REVOKED`，`trip/position/route` 全 null、`history: []`；
 * - 共用开但行程属于上一代 → 不出这一趟（不是把几何摘掉还把地名留着）；
 * - 几何未许可 → 只出地名与时间，`route/position/history` 一律空；
 * - 位置只在 `en_route/returning` 且有时间窗时按折线插值；没有可信时间就给 null。
 */
export function buildTravelSnapshot(input: TravelSnapshotInput): TravelStateSnapshot {
    const { trip, share, budget, nowMs } = input;
    const shareEnabled = !!share.shareEnabled;
    const base = {
        serverNow: nowMs,
        budget: budgetView(budget),
        shareEnabled,
    };

    if (!shareEnabled) {
        return {
            code: 'SHARE_REVOKED',
            ...base,
            trip: null,
            position: null,
            route: null,
            history: [],
        };
    }

    const geometryAllowed = input.geometryPersistence === 'allowed';
    if (!trip || isTerminalStatus(trip.status) || !isTripInShareGeneration(trip, share)) {
        return {
            code: 'OK',
            ...base,
            trip: null,
            position: null,
            route: null,
            history: [],
        };
    }

    const progress = tripProgress(trip, nowMs);
    const routePoints = geometryAllowed && trip.route ? trip.route.points : null;
    const ratio = trip.status === 'returning' ? progress.returnRatio : progress.outboundRatio;
    const position =
        routePoints && (trip.status === 'en_route' || trip.status === 'returning')
            ? positionAt(routePoints, ratio)
            : null;

    return {
        code: 'OK',
        ...base,
        trip: {
            ...tripViewBase(trip),
            origin: placeView(trip.origin),
            dest: trip.dest ? placeView(trip.dest) : null,
        } as unknown as TravelStateSnapshot['trip'],
        position: position ? { ...position, coordSys: trip.coordSys } : null,
        route: routePoints
            ? {
                  points: routePoints.map((p: { lat: number; lng: number }) => ({ lat: p.lat, lng: p.lng })),
                  distanceM: trip.route?.distanceM ?? 0,
              }
            : null,
        history: geometryAllowed ? (input.history ?? []).map((p) => ({ lat: p.lat, lng: p.lng })) : [],
    };
}

/** 契约 `TravelTrip` 对外需要的字段（不含坐标）。 */
function tripViewBase(trip: TravelTrip): Record<string, unknown> {
    return {
        id: trip.id,
        userId: trip.userId,
        charId: trip.charId,
        status: trip.status,
        planVersion: trip.planVersion,
        revision: trip.revision,
        coordSys: trip.coordSys,
        provider: trip.provider,
        departAt: trip.departAt,
        arriveAt: trip.arriveAt,
        dwellUntil: trip.dwellUntil,
        returnAt: trip.returnAt,
    };
}

/* ------------------------------------------------------------------ *
 * 角色内部上下文（不是共享读）
 * ------------------------------------------------------------------ */

export interface RoleTravelContext {
    hasTrip: boolean;
    phase: TravelTripStatus | null;
    /** 只有地名，没有坐标。 */
    originLabel: string | null;
    destLabel: string | null;
    progress: TravelTripProgress | null;
    /** 有官方时长才给；没有就是 null（提示词写「还不知道」）。 */
    etaMinutes: number | null;
    /** 角色自己上一趟是否失败（provider/预算），用于「要不要再试」的措辞。 */
    lastOutcome: 'provider_failed' | 'budget_blocked' | null;
}

export function buildRoleTravelContext(input: {
    trip: TravelTrip | null;
    nowMs: number;
    lastOutcome?: RoleTravelContext['lastOutcome'];
}): RoleTravelContext {
    const trip = input.trip;
    if (!trip || isTerminalStatus(trip.status)) {
        return {
            hasTrip: false,
            phase: null,
            originLabel: null,
            destLabel: null,
            progress: null,
            etaMinutes: null,
            lastOutcome: input.lastOutcome ?? null,
        };
    }
    const progress = tripProgress(trip, input.nowMs);
    const etaMs = progress.etaMs;
    return {
        hasTrip: true,
        phase: progress.phase,
        originLabel: trip.origin.label,
        destLabel: trip.dest?.label ?? null,
        progress,
        etaMinutes: etaMs === null ? null : Math.max(0, Math.round(etaMs / 60000)),
        lastOutcome: input.lastOutcome ?? null,
    };
}

/** 保留期到期时间（`tripDays = 0` 表示只留当前行程，交给 tick/prune 的 NULL 语义）。 */
export function retentionExpiryFor(nowMs: number, tripDays: number = TRAVEL_RETENTION_DEFAULTS.tripDays): number | null {
    const days = Math.trunc(Number(tripDays));
    if (!Number.isFinite(days) || days <= 0) return null;
    return nowMs + days * 24 * 60 * 60 * 1000;
}
