/**
 * 角色自主出行 · 国外（Mapbox）provider（B2）
 *
 * 正式商业服务，不是公共 demo：只打 `api.mapbox.com` 的
 * Directions v5（`mapbox/walking`）与 Geocoding v5。禁止 OSRM / Valhalla 公共实例、
 * 禁止 OSM 公共瓦片——那些「无 key 无条款」的端点不能当生产，也不能当「国外已接入」的证据。
 *
 * 未配置服务端 token 时**诚实 unsupported**：抛 `PROVIDER_UNSUPPORTED_REGION`，
 * 上层把行程标 `unavailable`（不是终态，接好后同一 wish 可重试），
 * **绝不**退化成城市中心或两点直线，也绝不编造 ETA。
 *
 * 权限说明（未实测，见 handoff）：Directions 与 Geocoding 是两个产品，
 * token 的 scope / 配额 / 价格都需在控制台核实；本实现遇到 401/403 一律按 auth 停用，
 * 不自动重试（重试花钱）。
 *
 * 官方依据：
 * - https://docs.mapbox.com/api/navigation/directions/ （geometries=geojson / polyline6，walking_speed 0.14~6.94）
 * - https://docs.mapbox.com/api/search/geocoding/ （/geocoding/v5/mapbox.places/{query}.json）
 */
import type { TravelCoordSys, TravelErrorCode } from '../../../../contracts/travel';
import { metersBetween, routeDistanceMeters } from '../../../../utils/travel/core';
import { gcj02ToWgs84 } from '../../../../utils/amapCore';
import {
    TravelProviderError,
    assertGeoPoint,
    buildLicenseMeta,
    clampCandidateLimit,
    formatLonLat,
    joinRoutePoints,
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

export const MAPBOX_API_BASE = 'https://api.mapbox.com';

/** 出口 path 前缀白名单。 */
export const MAPBOX_PATHS = {
    directions: '/directions/v5/mapbox/walking/',
    geocoding: '/geocoding/v5/mapbox.places/',
} as const;

/** 官方 walking_speed 区间（m/s）。 */
const MIN_WALKING_SPEED = 0.14;
const MAX_WALKING_SPEED = 6.94;

type WorldFailureKind =
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

/** Mapbox 错误 `code` → 分类。只认 code，不读 message（避免回显上游文本）。 */
const MAPBOX_CODE_KIND: Record<string, WorldFailureKind> = {
    NoRoute: 'no-route',
    NoSegment: 'no-route',
    NoTrips: 'no-route',
    TooManyCoordinates: 'bad-input',
    InvalidInput: 'bad-input',
    TokenNotAuthorized: 'auth',
    Forbidden: 'auth',
    RateLimited: 'rate-limit',
};

const codeForKind = (kind: WorldFailureKind): TravelErrorCode => {
    // 没配 token 也是「该地区暂不支持」：上层标 unavailable，wish 保留待接好再试。
    if (kind === 'unsupported-region' || kind === 'not-configured') return 'PROVIDER_UNSUPPORTED_REGION';
    if (kind === 'no-route' || kind === 'too-far') return 'ROUTE_UNAVAILABLE';
    return 'PROVIDER_FAILED';
};

const fail = (kind: WorldFailureKind) =>
    new TravelProviderError({ kind, code: codeForKind(kind), provider: 'world' });

export interface WorldProviderConfig {
    /**
     * 只读取值：每次请求前调用一次。没配 token 返回 null / 抛错 → 诚实 unsupported。
     * token 只出现在 query，不进 path、不进错误文案、不进 console。
     */
    readonly resolveToken: () => string | null;
    /** 覆盖 API 根（默认官方 host；其余 host 一律拒绝，防止误接公共 demo）。 */
    readonly apiBase?: string;
    /** G1b / G1a 两项授权状态由上层注入，默认都不放行。 */
    readonly license?: TravelLicenseGrants;
    /** 角色步行速度（m/s，官方 0.14~6.94）。不传就用 Mapbox 默认。 */
    readonly walkingSpeedMps?: number;
    /** 语言（如 `zh-Hans`）。不传则不发送该参数。 */
    readonly language?: string;
}

const readToken = (config: WorldProviderConfig): string => {
    let raw: string | null = null;
    try {
        raw = config.resolveToken();
    } catch {
        raw = null;
    }
    const token = typeof raw === 'string' ? raw.trim() : '';
    // 没配 token = 该地区暂不支持（unavailable），不是「角色不想出门」，也不是直线。
    if (!token) throw fail('not-configured');
    return token;
};

const isAllowedPath = (pathname: string): boolean =>
    pathname.startsWith(MAPBOX_PATHS.directions) || pathname.startsWith(MAPBOX_PATHS.geocoding);

/** 入参点 → WGS-84（Mapbox 体系）。 */
const toWgs84 = (point: { lat: number; lng: number; coordSys: TravelCoordSys }) => {
    assertGeoPoint(point, 'world');
    if (point.coordSys === 'wgs84') return { lat: point.lat, lng: point.lng, coordSys: 'wgs84' as const };
    const converted = gcj02ToWgs84(point.lat, point.lng);
    return { lat: converted.lat, lng: converted.lng, coordSys: 'wgs84' as const };
};

/** GeoJSON LineString 坐标 → 点数组（严格有限、`[lng,lat]`、去重、坏点跳过）。 */
export const parseLineString = (raw: unknown): { lat: number; lng: number }[] => {
    if (!Array.isArray(raw)) return [];
    const out: { lat: number; lng: number }[] = [];
    for (const pair of raw) {
        if (!Array.isArray(pair) || pair.length < 2) continue;
        const lng = typeof pair[0] === 'number' ? pair[0] : Number.NaN;
        const lat = typeof pair[1] === 'number' ? pair[1] : Number.NaN;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
        const last = out[out.length - 1];
        if (last && last.lat === lat && last.lng === lng) continue;
        out.push({ lat, lng });
    }
    return out;
};

const requestWorld = async (
    deps: TravelProviderDeps,
    config: WorldProviderConfig,
    pathname: string,
    params: Readonly<Record<string, string | undefined>>,
): Promise<Record<string, unknown>> => {
    const token = readToken(config);
    const base = (config.apiBase || MAPBOX_API_BASE).replace(/\/+$/, '');
    let url: URL;
    try {
        url = new URL(`${base}${pathname}`);
    } catch {
        throw fail('bad-input');
    }
    if (url.origin !== base) throw fail('bad-input');
    if (!isAllowedPath(url.pathname)) throw fail('bad-input');
    for (const [name, value] of Object.entries(params)) {
        if (value === undefined || value === '') continue;
        url.searchParams.set(name, value);
    }
    url.searchParams.set('access_token', token);

    await reserveMapBudget(deps, 'world');
    const result = await requestJsonOnce(deps, 'world', url.toString());

    const body = result.body && typeof result.body === 'object' ? (result.body as Record<string, unknown>) : null;
    if (!result.ok) {
        if (result.status === 401 || result.status === 403) throw fail('auth');
        if (result.status === 429) throw fail('rate-limit');
        if (result.status === 400) throw fail('bad-input');
        if (result.status === 422) {
            const mapped = body && typeof body.code === 'string' ? MAPBOX_CODE_KIND[body.code] : undefined;
            throw fail(mapped ?? 'no-route');
        }
        if (result.status >= 500) throw fail('transient');
        throw fail('bad-response');
    }
    if (!body) throw fail('bad-response');
    if (typeof body.code === 'string' && body.code !== 'Ok') {
        throw fail(MAPBOX_CODE_KIND[body.code] ?? 'bad-response');
    }
    return body;
};

const contextText = (feature: Record<string, unknown>, prefixes: readonly string[]): string => {
    const context = Array.isArray(feature.context) ? feature.context : [];
    for (const prefix of prefixes) {
        for (const entry of context) {
            if (!entry || typeof entry !== 'object') continue;
            const record = entry as Record<string, unknown>;
            const id = typeof record.id === 'string' ? record.id : '';
            const text = typeof record.text === 'string' ? record.text.trim() : '';
            if (id.startsWith(`${prefix}.`) && text) return text;
        }
    }
    return '';
};

const featurePoint = (feature: Record<string, unknown>): { lat: number; lng: number } | null => {
    const center = feature.center;
    if (!Array.isArray(center) || center.length < 2) return null;
    const lng = Number(center[0]);
    const lat = Number(center[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
};

const featureLabel = (feature: Record<string, unknown>): string => {
    if (typeof feature.text === 'string' && feature.text.trim()) return feature.text.trim();
    if (typeof feature.place_name === 'string' && feature.place_name.trim()) return feature.place_name.trim();
    return '';
};

const featureCity = (feature: Record<string, unknown>, fallback: string): string => {
    const fromContext = contextText(feature, ['place']);
    if (fromContext) return fromContext;
    const types = Array.isArray(feature.place_type) ? feature.place_type : [];
    if (types.includes('place') || types.includes('locality')) return featureLabel(feature) || fallback;
    return fallback;
};

export const createWorldProvider = (
    config: WorldProviderConfig,
    deps: TravelProviderDeps,
): TravelMapProvider => {
    const license = () => buildLicenseMeta('world', config.license ?? {});
    const language = typeof config.language === 'string' && config.language.trim()
        ? config.language.trim()
        : undefined;

    if (config.walkingSpeedMps !== undefined) {
        const speed = config.walkingSpeedMps;
        if (!Number.isFinite(speed) || speed < MIN_WALKING_SPEED || speed > MAX_WALKING_SPEED) {
            throw fail('bad-input');
        }
    }

    const route = async (request: TravelRouteRequest): Promise<TravelRouteResult> => {
        const origin = toWgs84(request.origin);
        const destination = toWgs84(request.destination);
        const coordinates = `${formatLonLat(origin, 'world')};${formatLonLat(destination, 'world')}`;
        const params: Record<string, string | undefined> = {
            geometries: 'geojson',
            overview: 'full',
            steps: 'true',
            alternatives: 'false',
            language,
        };
        if (config.walkingSpeedMps !== undefined) params.walking_speed = String(config.walkingSpeedMps);

        const payload = await requestWorld(deps, config, `${MAPBOX_PATHS.directions}${coordinates}`, params);
        const routes = Array.isArray(payload.routes) ? payload.routes : [];
        const primary = routes.length ? routes[0] : null;
        if (!primary || typeof primary !== 'object') throw fail('no-route');
        const routeRecord = primary as Record<string, unknown>;

        const geometry = routeRecord.geometry && typeof routeRecord.geometry === 'object'
            ? (routeRecord.geometry as Record<string, unknown>)
            : null;
        const points = parseLineString(geometry?.coordinates);
        // 少于两点 = 没有几何。抛错，绝不补一条直线。
        const joined = joinRoutePoints([points], 'world');

        const officialDistance = toFiniteNumber(routeRecord.distance);
        const distanceM = officialDistance !== null && officialDistance > 0
            ? Math.round(officialDistance)
            : Math.round(routeDistanceMeters(joined));
        const durationS = toFiniteNumber(routeRecord.duration);

        const legs = Array.isArray(routeRecord.legs) ? routeRecord.legs : [];
        const steps: TravelRouteStep[] = [];
        for (const leg of legs) {
            if (!leg || typeof leg !== 'object') continue;
            const legSteps = (leg as Record<string, unknown>).steps;
            if (!Array.isArray(legSteps)) continue;
            for (const step of legSteps) {
                if (!step || typeof step !== 'object') continue;
                const stepRecord = step as Record<string, unknown>;
                const maneuver = stepRecord.maneuver && typeof stepRecord.maneuver === 'object'
                    ? (stepRecord.maneuver as Record<string, unknown>)
                    : {};
                steps.push({
                    instruction: typeof maneuver.instruction === 'string' ? maneuver.instruction.trim() : '',
                    distanceM: toFiniteNumber(stepRecord.distance),
                    durationS: toFiniteNumber(stepRecord.duration),
                });
            }
        }

        return {
            provider: 'world',
            coordSys: 'wgs84',
            points: joined,
            distanceM,
            durationS: durationS !== null && durationS >= 0 ? Math.round(durationS) : null,
            steps,
            license: license(),
        };
    };

    const searchCandidates = async (query: TravelCandidateQuery): Promise<readonly TravelCandidateHit[]> => {
        const wishText = typeof query.wishText === 'string' ? query.wishText.trim() : '';
        const city = typeof query.city === 'string' ? query.city.trim() : '';
        if (!wishText || !city) throw fail('bad-input');
        const center = query.center ? toWgs84(query.center) : null;
        const limit = clampCandidateLimit(query.limit);

        const params: Record<string, string | undefined> = {
            limit: String(limit),
            types: 'poi,address,place',
            language,
            proximity: center ? formatLonLat(center, 'world') : undefined,
        };
        const payload = await requestWorld(
            deps,
            config,
            `${MAPBOX_PATHS.geocoding}${encodeURIComponent(wishText)}.json`,
            params,
        );

        const features = Array.isArray(payload.features) ? payload.features : [];
        const hits: TravelCandidateHit[] = [];
        for (const entry of features) {
            if (!entry || typeof entry !== 'object') continue;
            const feature = entry as Record<string, unknown>;
            const point = featurePoint(feature);
            const label = featureLabel(feature);
            const id = typeof feature.id === 'string' ? feature.id.trim() : '';
            if (!point || !label || !id) continue;
            const props = feature.properties && typeof feature.properties === 'object'
                ? (feature.properties as Record<string, unknown>)
                : {};
            const placeTypes = Array.isArray(feature.place_type) ? feature.place_type : [];
            const category = typeof props.category === 'string' && props.category.trim()
                ? props.category.trim()
                : typeof placeTypes[0] === 'string'
                    ? placeTypes[0]
                    : '';
            const district = contextText(feature, ['district', 'locality', 'neighborhood']);
            hits.push({
                id,
                label,
                city: featureCity(feature, city),
                location: { lat: point.lat, lng: point.lng, coordSys: 'wgs84' },
                distanceM: center ? Math.round(metersBetween(center, point)) : null,
                provider: 'world',
                ...(category ? { category } : {}),
                ...(district ? { district } : {}),
            });
            if (hits.length >= limit) break;
        }
        return hits;
    };

    const geocodeAnchor = async (query: TravelAnchorQuery): Promise<TravelAnchorCandidate> => {
        const label = typeof query.label === 'string' ? query.label.trim() : '';
        const city = typeof query.city === 'string' ? query.city.trim() : '';
        if (!label || !city) throw fail('bad-input');

        const payload = await requestWorld(
            deps,
            config,
            `${MAPBOX_PATHS.geocoding}${encodeURIComponent(label)}.json`,
            { limit: '1', types: 'place,locality,neighborhood', language },
        );
        const features = Array.isArray(payload.features) ? payload.features : [];
        for (const entry of features) {
            if (!entry || typeof entry !== 'object') continue;
            const feature = entry as Record<string, unknown>;
            const point = featurePoint(feature);
            if (!point) continue;
            const district = contextText(feature, ['district', 'locality', 'neighborhood']);
            const id = typeof feature.id === 'string' ? feature.id.trim() : '';
            // 只取白名单字段：place_name 里的完整地址不带走。
            return {
                label,
                city: featureCity(feature, city),
                location: { lat: point.lat, lng: point.lng, coordSys: 'wgs84' },
                provider: 'world',
                precision: 'area',
                ...(id ? { placeId: id } : {}),
                ...(district ? { district } : {}),
            };
        }
        throw new TravelProviderError({
            kind: 'no-route',
            code: 'ANCHOR_NOT_CONFIRMED',
            provider: 'world',
        });
    };

    return Object.freeze({
        id: 'world' as const,
        coordSys: 'wgs84' as const,
        regions: ['overseas'] as readonly TravelProviderRegion[],
        supports: (region: TravelProviderRegion) => region === 'overseas',
        searchCandidates,
        route,
        geocodeAnchor,
    });
};
