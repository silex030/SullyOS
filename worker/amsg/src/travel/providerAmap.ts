/**
 * 角色自主出行 · 高德（国内）provider（B2）
 *
 * 只做三件事：步行路线 `/v3/direction/walking`、地点检索 `/v3/place/text`、
 * 地理编码 `/v3/geocode/geo`。出口 host 与 path 都是白名单，请求串里的 key
 * **从不进错误文案、从不进 console**（本文件没有一行日志）。
 *
 * 不持久化任何东西：不建缓存表、不写 DB、不落 localStorage；路线几何与许可元数据
 * 一并返回，是否写库由上层 tick 按 `license.geometryPersistence` 决定。
 *
 * 官方依据（字段形状照此构造）：
 * - https://lbs.amap.com/api/webservice/guide/api/direction （步行，≤100km，polyline `lon,lat;...`）
 * - https://lbs.amap.com/api/webservice/guide/api/search （place/text）
 * - https://lbs.amap.com/api/webservice/guide/api/georegeo （geocode/geo）
 * - https://lbs.amap.com/api/webservice/guide/tools/info （infocode 表）
 */
import type { TravelCoordSys, TravelErrorCode } from '../../../../contracts/travel';
import { metersBetween, routeDistanceMeters } from '../../../../utils/travel/core';
import { wgs84ToGcj02 } from '../../../../utils/amapCore';
import {
    TravelProviderError,
    assertGeoPoint,
    buildLicenseMeta,
    clampCandidateLimit,
    formatLonLat,
    joinRoutePoints,
    parsePolyline,
    requestJsonOnce,
    reserveMapBudget,
    toFiniteNumber,
    type TravelAnchorCandidate,
    type TravelAnchorQuery,
    type TravelCandidateHit,
    type TravelCandidateQuery,
    type TravelLicenseGrants,
    type TravelMapProvider,
    type TravelProviderDeps,
    type TravelProviderRegion,
    type TravelRouteRequest,
    type TravelRouteResult,
    type TravelRouteStep,
} from './provider';

export const AMAP_REST_BASE = 'https://restapi.amap.com';

/** 出口白名单：除此之外的 path 一律 bad-input（防止把 provider 当通用透传用）。 */
export const AMAP_ENDPOINTS = {
    walking: '/v3/direction/walking',
    placeText: '/v3/place/text',
    geocode: '/v3/geocode/geo',
} as const;

export type AmapEndpointPath = (typeof AMAP_ENDPOINTS)[keyof typeof AMAP_ENDPOINTS];

export const AMAP_ALLOWED_ENDPOINTS: readonly AmapEndpointPath[] = [
    AMAP_ENDPOINTS.walking,
    AMAP_ENDPOINTS.placeText,
    AMAP_ENDPOINTS.geocode,
];

/** 官方能力边界：步行路径规划最大 100km。超了当场拒，不花配额。 */
export const AMAP_MAX_WALKING_METERS = 100_000;

/** infocode → 失败分类（高德官方错误表）。未列出的按 bad-response 处理，不猜。 */
const AMAP_INFOCODE_KIND: Record<string, Parameters<typeof codeForKind>[0]> = {
    '10001': 'auth',
    '10002': 'auth',
    '10005': 'auth',
    '10007': 'auth',
    '10009': 'auth',
    '10010': 'auth',
    '10003': 'quota',
    '10044': 'quota',
    '10045': 'quota',
    '10004': 'rate-limit',
    '20011': 'unsupported-region',
    '20800': 'unsupported-region',
    '20801': 'no-route',
    '20802': 'no-route',
    '20803': 'too-far',
};

type AmapFailureKind =
    | 'not-configured'
    | 'auth'
    | 'quota'
    | 'rate-limit'
    | 'unsupported-region'
    | 'no-route'
    | 'too-far'
    | 'bad-input'
    | 'bad-response'
    | 'transient';

/** kind → 契约错误码。额度/鉴权/网络都算 PROVIDER_FAILED，地区不支持有独立码。 */
const codeForKind = (kind: AmapFailureKind): TravelErrorCode => {
    if (kind === 'unsupported-region') return 'PROVIDER_UNSUPPORTED_REGION';
    if (kind === 'no-route' || kind === 'too-far') return 'ROUTE_UNAVAILABLE';
    return 'PROVIDER_FAILED';
};

export interface AmapProviderConfig {
    /**
     * 只读取值：每次请求前调用一次。缺 Key 返回 null / 抛错 → not-configured（不发请求）。
     * 不读环境变量、不缓存 Key、不把 Key 写进任何返回结构。
     */
    readonly resolveKey: () => string | null;
    /** REST 根：默认官方 host；自建反代时传自己的前缀（路径仍须落在白名单内）。 */
    readonly restBase?: string;
    /** G1b / G1a 两项授权状态由上层注入，默认都不放行。 */
    readonly license?: TravelLicenseGrants;
    /** 覆盖步行上限（默认 100km，官方能力边界）。 */
    readonly maxWalkingMeters?: number;
}

const fail = (kind: AmapFailureKind, infocode?: string, provider: 'amap' = 'amap') =>
    new TravelProviderError({ kind, code: codeForKind(kind), provider, infocode });

const readKey = (config: AmapProviderConfig): string => {
    let raw: string | null = null;
    try {
        raw = config.resolveKey();
    } catch {
        raw = null;
    }
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!key) throw fail('not-configured');
    return key;
};

/** 拼高德 REST URL：白名单校验 + 六位小数 + `output=JSON`；key 只出现在 query。 */
export const buildAmapUrl = (
    endpoint: AmapEndpointPath,
    params: Readonly<Record<string, string | undefined>>,
    key: string,
    restBase: string = AMAP_REST_BASE,
): string => {
    if (!AMAP_ALLOWED_ENDPOINTS.includes(endpoint)) throw fail('bad-input');
    const base = (restBase || AMAP_REST_BASE).replace(/\/+$/, '');
    let url: URL;
    try {
        url = new URL(`${base}${endpoint}`);
    } catch {
        throw fail('bad-input');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw fail('bad-input');
    if (!url.pathname.endsWith(endpoint)) throw fail('bad-input');
    for (const [name, value] of Object.entries(params)) {
        if (value === undefined || value === '') continue;
        url.searchParams.set(name, value);
    }
    url.searchParams.set('output', 'JSON');
    url.searchParams.set('key', key);
    return url.toString();
};

/** 入参点 → GCJ-02（跨体系只在边界转换一次）。 */
const toGcj02 = (point: { lat: number; lng: number; coordSys: TravelCoordSys }) => {
    assertGeoPoint(point, 'amap');
    if (point.coordSys === 'gcj02') return { lat: point.lat, lng: point.lng, coordSys: 'gcj02' as const };
    const converted = wgs84ToGcj02(point.lat, point.lng);
    return { lat: converted.lat, lng: converted.lng, coordSys: 'gcj02' as const };
};

/** 高德单点 `lng,lat`（严格两段、有限、范围内），坏点返回 null。 */
const parseAmapPoint = (raw: unknown): { lat: number; lng: number } | null => {
    if (typeof raw !== 'string') return null;
    const parts = raw.split(',');
    if (parts.length !== 2) return null;
    const lng = Number(parts[0].trim());
    const lat = Number(parts[1].trim());
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
};

/** 单次出口：扣一次预算 → 发一次请求（不重试）→ 断言 `status==='1'`。 */
const requestAmap = async (
    deps: TravelProviderDeps,
    config: AmapProviderConfig,
    endpoint: AmapEndpointPath,
    params: Readonly<Record<string, string | undefined>>,
): Promise<Record<string, unknown>> => {
    const key = readKey(config);
    const url = buildAmapUrl(endpoint, params, key, config.restBase);
    await reserveMapBudget(deps, 'amap');
    const result = await requestJsonOnce(deps, 'amap', url);
    if (result.status === 429) throw fail('rate-limit');
    if (!result.ok) throw fail(result.status >= 500 ? 'transient' : 'bad-response');
    const body = result.body;
    if (!body || typeof body !== 'object') throw fail('bad-response');
    const payload = body as Record<string, unknown>;
    if (payload.status !== '1') {
        const infocode = payload.infocode === undefined || payload.infocode === null ? '' : String(payload.infocode);
        const kind = (infocode && AMAP_INFOCODE_KIND[infocode]) || 'bad-response';
        throw fail(kind, infocode || undefined);
    }
    return payload;
};

/** pois → 有界候选。缺坐标的条目直接丢，不猜位置。 */
const toCandidateHits = (
    payload: Record<string, unknown>,
    query: TravelCandidateQuery,
    center: { lat: number; lng: number } | null,
): TravelCandidateHit[] => {
    const raw = Array.isArray(payload.pois) ? payload.pois : [];
    const limit = clampCandidateLimit(query.limit);
    const out: TravelCandidateHit[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const poi = entry as Record<string, unknown>;
        const point = parseAmapPoint(poi.location);
        if (!point) continue;
        const id = typeof poi.id === 'string' ? poi.id.trim() : '';
        const label = typeof poi.name === 'string' ? poi.name.trim() : '';
        if (!id || !label) continue;
        const rawType = typeof poi.type === 'string' ? poi.type : '';
        const category = rawType.split(';').map((part) => part.trim()).filter(Boolean).pop();
        const city = pickText(poi.cityname) || pickText(poi.province) || query.city.trim();
        const district = pickText(poi.adname);
        const officialDistance = toFiniteNumber(poi.distance);
        const distanceM = officialDistance !== null
            ? Math.round(officialDistance)
            : center
                ? Math.round(metersBetween(center, point))
                : null;
        out.push({
            id,
            label,
            city,
            location: { lat: point.lat, lng: point.lng, coordSys: 'gcj02' },
            distanceM,
            provider: 'amap',
            ...(category ? { category } : {}),
            ...(district ? { district } : {}),
        });
        if (out.length >= limit) break;
    }
    return out;
};

/** 高德 `cityname` 等字段可能是 string，也可能是空数组（直辖市）。 */
const pickText = (value: unknown): string => {
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) {
        const first = value.find((item) => typeof item === 'string' && item.trim());
        return typeof first === 'string' ? first.trim() : '';
    }
    return '';
};

export const createAmapProvider = (
    config: AmapProviderConfig,
    deps: TravelProviderDeps,
): TravelMapProvider => {
    const license = () => buildLicenseMeta('amap', config.license ?? {});
    const maxWalkingMeters = config.maxWalkingMeters ?? AMAP_MAX_WALKING_METERS;

    const route = async (request: TravelRouteRequest): Promise<TravelRouteResult> => {
        const origin = toGcj02(request.origin);
        const destination = toGcj02(request.destination);

        // 官方能力边界先判：超 100km 必失败，别花一次配额。
        if (metersBetween(origin, destination) > maxWalkingMeters) throw fail('too-far');

        const params: Record<string, string | undefined> = {
            origin: formatLonLat(origin, 'amap'),
            destination: formatLonLat(destination, 'amap'),
        };
        if (request.originPlaceId) params.origin_id = request.originPlaceId;
        if (request.destinationPlaceId) params.destination_id = request.destinationPlaceId;

        const payload = await requestAmap(deps, config, AMAP_ENDPOINTS.walking, params);
        const routePayload = payload.route;
        const paths = routePayload && typeof routePayload === 'object'
            ? (routePayload as Record<string, unknown>).paths
            : undefined;
        const path = Array.isArray(paths) && paths.length ? paths[0] : null;
        if (!path || typeof path !== 'object') throw fail('no-route');

        const pathRecord = path as Record<string, unknown>;
        const rawSteps = Array.isArray(pathRecord.steps) ? pathRecord.steps : [];
        const segments = rawSteps.map((step) =>
            parsePolyline(step && typeof step === 'object' ? (step as Record<string, unknown>).polyline : undefined),
        );
        // 少于两点 = 没有几何：抛 ROUTE_UNAVAILABLE，绝不返回两点直线。
        const points = joinRoutePoints(segments, 'amap');

        const officialDistance = toFiniteNumber(pathRecord.distance);
        const distanceM = officialDistance !== null && officialDistance > 0
            ? Math.round(officialDistance)
            : Math.round(routeDistanceMeters(points));
        const durationS = toFiniteNumber(pathRecord.duration);

        const steps: TravelRouteStep[] = rawSteps.map((step) => {
            const record = step && typeof step === 'object' ? (step as Record<string, unknown>) : {};
            const instruction = typeof record.instruction === 'string' ? record.instruction.trim() : '';
            return {
                instruction,
                distanceM: toFiniteNumber(record.distance),
                durationS: toFiniteNumber(record.duration),
            };
        });

        return {
            provider: 'amap',
            coordSys: 'gcj02',
            points,
            distanceM,
            durationS: durationS !== null && durationS >= 0 ? durationS : null,
            steps,
            license: license(),
        };
    };

    const searchCandidates = async (query: TravelCandidateQuery): Promise<readonly TravelCandidateHit[]> => {
        const wishText = typeof query.wishText === 'string' ? query.wishText.trim() : '';
        const city = typeof query.city === 'string' ? query.city.trim() : '';
        if (!wishText || !city) throw fail('bad-input');

        const center = query.center ? toGcj02(query.center) : null;
        const params: Record<string, string | undefined> = {
            keywords: wishText,
            city,
            citylimit: 'true',
            offset: String(clampCandidateLimit(query.limit)),
            page: '1',
            extensions: 'base',
        };
        if (center) {
            params.location = formatLonLat(center, 'amap');
            params.sortrule = 'distance';
        }

        const payload = await requestAmap(deps, config, AMAP_ENDPOINTS.placeText, params);
        return toCandidateHits(payload, query, center);
    };

    const geocodeAnchor = async (query: TravelAnchorQuery): Promise<TravelAnchorCandidate> => {
        const label = typeof query.label === 'string' ? query.label.trim() : '';
        const city = typeof query.city === 'string' ? query.city.trim() : '';
        if (!label || !city) throw fail('bad-input');

        const payload = await requestAmap(deps, config, AMAP_ENDPOINTS.geocode, {
            address: label,
            city,
        });
        const raw = Array.isArray(payload.geocodes) ? payload.geocodes : [];
        for (const entry of raw) {
            if (!entry || typeof entry !== 'object') continue;
            const record = entry as Record<string, unknown>;
            const point = parseAmapPoint(record.location);
            if (!point) continue;
            // 只取白名单字段：上游的 formatted_address（含门牌/楼栋）一律不带走。
            const resolvedCity = pickText(record.city) || pickText(record.province) || city;
            const district = pickText(record.district);
            return {
                label,
                city: resolvedCity,
                location: { lat: point.lat, lng: point.lng, coordSys: 'gcj02' },
                provider: 'amap',
                precision: 'area',
                ...(district ? { district } : {}),
            };
        }
        // 编码不出就别用城市中心兜底。
        throw new TravelProviderError({
            kind: 'no-route',
            code: 'ANCHOR_NOT_CONFIRMED',
            provider: 'amap',
        });
    };

    return Object.freeze({
        id: 'amap' as const,
        coordSys: 'gcj02' as const,
        regions: ['CN'] as readonly TravelProviderRegion[],
        supports: (region: TravelProviderRegion) => region === 'CN',
        searchCandidates,
        route,
        geocodeAnchor,
    });
};
