/**
 * amapCore — 高德 Web 服务取数纯函数叶子（地理编码 / 逆地理 / 输入提示 / POI 检索 + 成段渲染）
 *
 * 整个手机地点真实化的地理底座：神经链接地点卡、MOVE_TO 验证、用户 GPS 回填、
 * 城市地点库（cityPlaces 的取数委托）都走这里。
 *
 * 调用链：浏览器经代理 worker（`worker/index.js` 的 /amap 端点）打 `restapi.amap.com`，
 * 高德无 CORS 头，直连浏览器会被拦。key 由调用方传（存在用户本地 realtimeConfig，
 * 代理只透传不存）。海外坐标高德直接报 20011（无海外权限）——抛 AmapApiError，
 * 调用方回落 Open-Meteo。
 *
 * 纯函数约束：只用全局 fetch，不 import 任何仓库内模块（db / proxyWorker / safeApi 一律不碰），
 * 方便单测，也避免将来进 worker bundle 时带进浏览器依赖。
 */

export interface AmapAuth {
    /** 取数根地址：REST 中转时为 `<base>/travel/map/rest`，旧直连时为代理 worker 根。 */
    proxyUrl: string;
    /** 高德 Web 服务 Key。**只有** legacy 直连通道才在浏览器持有；中转模式下恒为空。 */
    key: string;
    /**
     * true = 走本站鉴权 REST 中转（`/travel/map/rest`）：Web 服务 Key 只由服务端按用户读出，
     * 浏览器不见 Key，只需出行会话 Bearer。此时 `key` 必须为空串。
     */
    relay?: boolean;
    /** 中转请求头（`Authorization: Bearer <出行会话>`）；legacy 直连不传。 */
    headers?: Record<string, string>;
}

/**
 * 凭证是否可用：中转会话就绪，或（过渡期）确有旧的 Web 服务 Key。
 * 消费方统一用它判「未配置」，不要再直接看 `auth.key`。
 */
export const isAmapAuthReady = (auth: AmapAuth | null | undefined): boolean =>
    !!auth && (auth.relay === true || !!String(auth.key ?? '').trim());


/** 高德官方 REST 根（只出现在注释与测试里：真实请求一律走 proxyUrl + /amap 透传）。 */
export const AMAP_REST_HOST = 'https://restapi.amap.com';

/** 结构化地点：geocode / regeo 的归一化结果。坐标是 GCJ-02（高德系）。 */
export interface StructuredPlace {
    province?: string;
    city: string;
    district?: string;
    lat?: number;
    lng?: number;
    /** 高德 adcode（城市级，地点库缓存键用）。 */
    adcode?: string;
    citycode?: string;
}

/** 地点库里的一条真实 POI。 */
export interface CityPlace {
    name: string;
    /** 高德 type 原文，如 "风景名胜;公园广场;公园"。 */
    type: string;
    /** 展示用短类别，取 type 最后一段，如 "公园"。 */
    typeShort: string;
    category: PlaceCategory;
    address?: string;
    district?: string;
    lat: number;
    lng: number;
    adcode?: string;
}

export type PlaceCategory =
    | 'park' | 'mall' | 'cafe' | 'restaurant' | 'cinema'
    | 'spot' | 'bookstore' | 'school' | 'transit' | 'hospital' | 'gym';

/** 建城市地点库时按这些类别各拉一次关键字搜索。dating = 约会/出游相关（世界演绎与见面观测只附这部分）。 */
export const AMAP_PLACE_CATEGORIES: Array<{ key: PlaceCategory; keywords: string; dating: boolean }> = [
    { key: 'park', keywords: '公园', dating: true },
    { key: 'mall', keywords: '购物中心', dating: true },
    { key: 'cafe', keywords: '咖啡', dating: true },
    { key: 'restaurant', keywords: '餐厅', dating: true },
    { key: 'cinema', keywords: '电影院', dating: true },
    { key: 'spot', keywords: '风景名胜', dating: true },
    { key: 'bookstore', keywords: '书店', dating: true },
    { key: 'school', keywords: '大学', dating: false },
    { key: 'transit', keywords: '地铁站', dating: false },
    { key: 'hospital', keywords: '医院', dating: false },
    { key: 'gym', keywords: '健身房', dating: false },
];

/** 输入提示（联想框）的一条。 */
export interface AmapInputTip {
    name: string;
    district?: string;
    adcode?: string;
    address?: string;
    lat?: number;
    lng?: number;
}

/** 高德返回 status != '1'（业务失败）时抛这个。配额/ key 类错误调用方可据 code 给 UI 提示。 */
export class AmapApiError extends Error {
    code?: string;
    constructor(message: string, code?: string) {
        super(message);
        this.name = 'AmapApiError';
        this.code = code;
    }
}

/** 配额类 infocode：10003 日超限 / 10044 账号维度日超限。 */
export const isQuotaErrorCode = (code?: string): boolean =>
    code === '10003' || code === '10044';
/** key/签名类 infocode：10001~10009（key 无效/过期/无权限等）。 */
export const isAuthErrorCode = (code?: string): boolean =>
    !!code && ['10001', '10002', '10004', '10005', '10006', '10007', '10008', '10009'].includes(code);
/** 海外无权限：20011。调用方看到这个回落 Open-Meteo。 */
export const isAbroadErrorCode = (code?: string): boolean => code === '20011';

// ==================== 底层 ====================

/**
 * 拼取数地址。
 * - legacy 直连：`<proxy>/amap` + 高德 path + query（含 key，代理只透传）；
 * - REST 中转：`<base>/travel/map/rest` + 高德 path + query（**不带** key，服务端按用户注入）。
 */
export const buildAmapUrl = (
    proxyUrl: string,
    path: string,
    params: Record<string, string | number | undefined>,
    key: string,
    relay = false,
): string => {
    const base = proxyUrl.replace(/\/+$/, '');
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    if (key && !relay) qs.set('key', key);
    const prefix = relay ? '' : '/amap';
    const query = qs.toString();
    return `${base}${prefix}${path}${query ? `?${query}` : ''}`;
};

const fetchWithTimeout = async (
    url: string,
    ms: number,
    headers?: Record<string, string>,
): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        return await fetch(url, { signal: ctrl.signal, ...(headers ? { headers } : {}) });
    } finally {
        clearTimeout(timer);
    }
};

/** 读 JSON + 高德 status 断言。status != '1' 抛 AmapApiError；网络/HTTP 层失败直接抛。 */
export const fetchAmap = async (
    proxyUrl: string,
    path: string,
    params: Record<string, string | number | undefined>,
    key: string,
    label: string,
    timeoutMs = 8000,
    opts?: { relay?: boolean; headers?: Record<string, string> },
): Promise<any> => {
    const url = buildAmapUrl(proxyUrl, path, params, key, opts?.relay === true);
    let res: Response;
    try {
        res = await fetchWithTimeout(url, timeoutMs, opts?.headers);
    } catch (e: any) {
        throw new Error(`高德${label}请求失败（代理不可达或超时）: ${e?.message || e}`);
    }
    if (!res.ok) {
        throw new Error(`高德${label} HTTP ${res.status}`);
    }
    const text = await res.text();
    let data: any;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error(`高德${label}响应不是 JSON：${text.slice(0, 120)}`);
    }
    if (data?.status !== '1') {
        throw new AmapApiError(
            `高德${label}失败：${data?.info || '未知错误'}`,
            data?.infocode ? String(data.infocode) : undefined,
        );
    }
    return data;
};

/** 单次取数（带凭证通道选择）：消费方只传 AmapAuth，不再自己拼 proxyUrl/key。 */
export const fetchAmapFor = async (
    auth: AmapAuth,
    path: string,
    params: Record<string, string | number | undefined>,
    label: string,
    timeoutMs = 8000,
): Promise<any> =>
    fetchAmap(auth.proxyUrl, path, params, auth.key, label, timeoutMs, {
        relay: auth.relay === true,
        headers: auth.headers,
    });

/** 高德 location 串 "lng,lat"（经度在前）→ 数字。解析不出返回 undefined。 */
export const parseAmapLocation = (loc: unknown): { lat: number; lng: number } | undefined => {
    if (typeof loc !== 'string') return undefined;
    const [lng, lat] = loc.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
    return { lat, lng };
};

/** 直辖市时高德 city 可能是空数组：退回 province。 */
const pickCity = (province: unknown, city: unknown): string => {
    if (typeof city === 'string' && city.trim()) return city.trim();
    if (typeof province === 'string' && province.trim()) return province.trim();
    return '';
};

// ==================== 地理编码 / 逆地理 ====================

/**
 * 城市名 → 结构化地点（含 adcode / citycode / 城市中心坐标）。
 * 查无结果返回 null（高德无匹配时 count=0 但 status 仍为 1）。
 */
export const geocodeCity = async (
    city: string,
    auth: AmapAuth,
    timeoutMs = 8000,
): Promise<(StructuredPlace & { citycode?: string }) | null> => {
    const name = city.trim();
    if (!name || !isAmapAuthReady(auth)) return null;
    const data = await fetchAmapFor(auth, '/v3/geocode/geo', { address: name }, '地理编码', timeoutMs);
    const hit = data?.geocodes?.[0];
    if (!hit) return null;
    const place: StructuredPlace & { citycode?: string } = {
        province: typeof hit.province === 'string' ? hit.province : undefined,
        city: pickCity(hit.province, hit.city),
        district: typeof hit.district === 'string' && hit.district ? hit.district : undefined,
        adcode: typeof hit.adcode === 'string' ? hit.adcode : undefined,
        citycode: typeof hit.citycode === 'string' ? hit.citycode : undefined,
    };
    const ll = parseAmapLocation(hit.location);
    if (ll) {
        place.lat = ll.lat;
        place.lng = ll.lng;
    }
    if (!place.city) return null;
    return place;
};

/**
 * GPS 坐标（WGS-84，getCurrentPositionSmart 拿到的就是这个）→ 结构化地点。
 * 只取省/市/adcode：district 原样返回，由调用方按隐私边界决定存不存
 * （用户档案只存省市，街道级直接丢弃）。
 */
export const regeoCity = async (
    latWgs: number,
    lngWgs: number,
    auth: AmapAuth,
    timeoutMs = 8000,
): Promise<StructuredPlace | null> => {
    if (!Number.isFinite(latWgs) || !Number.isFinite(lngWgs) || !isAmapAuthReady(auth)) return null;
    const gcj = wgs84ToGcj02(latWgs, lngWgs);
    const data = await fetchAmapFor(
        auth, '/v3/geocode/regeo',
        { location: `${gcj.lng},${gcj.lat}`, extensions: 'base' },
        '逆地理编码', timeoutMs,
    );
    const comp = data?.regeocode?.addressComponent;
    if (!comp) return null;
    const place: StructuredPlace = {
        province: typeof comp.province === 'string' ? comp.province : undefined,
        city: pickCity(comp.province, comp.city),
        district: typeof comp.district === 'string' && comp.district ? comp.district : undefined,
        adcode: typeof comp.adcode === 'string' ? comp.adcode : undefined,
        citycode: undefined,
        lat: gcj.lat,
        lng: gcj.lng,
    };
    if (!place.city) return null;
    return place;
};

// ==================== 输入提示（联想） ====================

/** 城市名 / 地点关键字联想（神经链接地点卡与用户档案手填共用）。 */
export const fetchInputTips = async (
    keywords: string,
    auth: AmapAuth,
    city?: string,
    timeoutMs = 8000,
): Promise<AmapInputTip[]> => {
    const kw = keywords.trim();
    if (!kw || !isAmapAuthReady(auth)) return [];
    const data = await fetchAmapFor(auth, '/v3/assistant/inputtips', {
        keywords: kw,
        city,
        citylimit: city ? 'true' : 'false',
        datatype: 'poi',
    }, '输入提示', timeoutMs);
    const tips: any[] = Array.isArray(data?.tips) ? data.tips : [];
    return tips
        .filter((t) => t && typeof t.name === 'string' && t.name)
        .map((t) => {
            const tip: AmapInputTip = { name: String(t.name) };
            if (typeof t.district === 'string' && t.district) tip.district = t.district;
            if (typeof t.adcode === 'string' && t.adcode) tip.adcode = t.adcode;
            if (typeof t.address === 'string' && t.address) tip.address = t.address;
            const ll = parseAmapLocation(t.location);
            if (ll) {
                tip.lat = ll.lat;
                tip.lng = ll.lng;
            }
            return tip;
        });
};

// ==================== POI 检索 / 城市地点库 ====================

/** 高德 type 原文 "大类;中类;小类" → 展示用短类别取最后一段。 */
export const shortType = (type: unknown): string => {
    if (typeof type !== 'string' || !type) return '';
    const segs = type.split(';').map((s) => s.trim()).filter(Boolean);
    return segs.length > 0 ? segs[segs.length - 1] : '';
};

/** 单类别关键字搜索（city 传 citycode 或 adcode，citylimit 锁城）。 */
export const searchPlaces = async (
    keywords: string,
    city: string,
    category: PlaceCategory,
    auth: AmapAuth,
    opts?: { pageSize?: number; timeoutMs?: number },
): Promise<CityPlace[]> => {
    if (!keywords.trim() || !city.trim() || !isAmapAuthReady(auth)) return [];
    const data = await fetchAmapFor(auth, '/v3/place/text', {
        keywords: keywords.trim(),
        city: city.trim(),
        citylimit: 'true',
        extensions: 'base',
        page_size: opts?.pageSize ?? 8,
        page: 1,
    }, 'POI 检索', opts?.timeoutMs ?? 10000);
    const pois: any[] = Array.isArray(data?.pois) ? data.pois : [];
    const out: CityPlace[] = [];
    for (const p of pois) {
        if (!p || typeof p.name !== 'string' || !p.name) continue;
        const ll = parseAmapLocation(p.location);
        if (!ll) continue;
        out.push({
            name: String(p.name),
            type: typeof p.type === 'string' ? p.type : '',
            typeShort: shortType(p.type),
            category,
            address: typeof p.address === 'string' ? p.address : undefined,
            district: typeof p.adname === 'string' ? p.adname : undefined,
            lat: ll.lat,
            lng: ll.lng,
            adcode: typeof p.adcode === 'string' ? p.adcode : undefined,
        });
    }
    return out;
};

export interface CityPlaceLibrary {
    adcode: string;
    city: string;
    province?: string;
    /** 城市中心（geocode 结果，GCJ-02）：距离展示的基准点。 */
    centerLat: number;
    centerLng: number;
    fetchedAt: number;
    places: CityPlace[];
}

/**
 * 建一个城市的地点库：先地理编码定 adcode，再按类别表逐类检索，合并去重。
 * 一类失败不影响其他类（配额/超时都内部吞掉记 warn）；geocode 失败（或海外 20011）
 * 直接返回 null，调用方回落 Open-Meteo 城市级。
 */
export const fetchCityLibrary = async (
    cityName: string,
    auth: AmapAuth,
    opts?: { perCategory?: number; timeoutMs?: number },
): Promise<CityPlaceLibrary | null> => {
    if (!cityName.trim() || !auth.key) return null;
    const geo = await geocodeCity(cityName, auth, opts?.timeoutMs);
    if (!geo?.adcode || geo.lat == null || geo.lng == null) return null;
    const cityKey = geo.citycode || geo.adcode;
    const perCategory = opts?.perCategory ?? 8;

    const settled = await Promise.all(AMAP_PLACE_CATEGORIES.map(async (c) => {
        try {
            return await searchPlaces(c.keywords, cityKey, c.key, auth, {
                pageSize: perCategory,
                timeoutMs: opts?.timeoutMs,
            });
        } catch (e) {
            console.warn(`[amap] ${geo.city} ${c.keywords} 检索失败:`, e instanceof Error ? e.message : e);
            return [] as CityPlace[];
        }
    }));

    const seen = new Set<string>();
    const places: CityPlace[] = [];
    for (const list of settled) {
        for (const p of list) {
            const k = `${p.name}|${p.district || ''}`;
            if (seen.has(k)) continue;
            seen.add(k);
            places.push(p);
        }
    }
    if (places.length === 0) return null;
    return {
        adcode: geo.adcode,
        city: geo.city,
        province: geo.province,
        centerLat: geo.lat,
        centerLng: geo.lng,
        fetchedAt: Date.now(),
        places,
    };
};

// ==================== 坐标系 / 距离 ====================

const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;
const outOfChina = (lat: number, lng: number): boolean =>
    lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;

const transformLat = (x: number, y: number): number => {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
    return ret;
};

const transformLng = (x: number, y: number): number => {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
    return ret;
};

/**
 * WGS-84（GPS/浏览器定位）→ GCJ-02（高德系）。国境外原样返回。
 * 公开算法实现，与 gcj02ToWgs84 互逆（精度约 1e-6 量级，POI 距离展示够用）。
 */
export const wgs84ToGcj02 = (lat: number, lng: number): { lat: number; lng: number } => {
    if (outOfChina(lat, lng)) return { lat, lng };
    const x = lng - 105.0;
    const y = lat - 35.0;
    let dLat = transformLat(x, y);
    let dLng = transformLng(x, y);
    const radLat = (lat / 180.0) * Math.PI;
    const magic = 1 - GCJ_EE * Math.sin(radLat) ** 2;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI);
    dLng = (dLng * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI);
    return { lat: lat + dLat, lng: lng + dLng };
};

/** GCJ-02 → WGS-84 近似逆变换（二分迭代，默认 1e-7 精度）。国境外原样返回。 */
export const gcj02ToWgs84 = (lat: number, lng: number): { lat: number; lng: number } => {
    if (outOfChina(lat, lng)) return { lat, lng };
    let minLat = lat - 0.5;
    let maxLat = lat + 0.5;
    let minLng = lng - 0.5;
    let maxLng = lng + 0.5;
    let wgsLat = lat;
    let wgsLng = lng;
    for (let i = 0; i < 30; i++) {
        wgsLat = (minLat + maxLat) / 2;
        wgsLng = (minLng + maxLng) / 2;
        const tmp = wgs84ToGcj02(wgsLat, wgsLng);
        if (Math.abs(tmp.lat - lat) < 1e-7 && Math.abs(tmp.lng - lng) < 1e-7) break;
        if (tmp.lat > lat) maxLat = wgsLat; else minLat = wgsLat;
        if (tmp.lng > lng) maxLng = wgsLng; else minLng = wgsLng;
    }
    return { lat: wgsLat, lng: wgsLng };
};

/** haversine 大地距离（km）。同系坐标内相对距离可比，跨系别混用。 */
export const haversineKm = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLng = (lng2 - lng1) * rad;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
};

/** 距离展示：<1km 显示米，否则一位小数 km。 */
export const formatDistance = (km: number): string =>
    km < 1 ? `约${Math.max(50, Math.round(km * 1000 / 50) * 50)}米` : `约${km.toFixed(1)}公里`;

// ==================== 成段渲染（prompt 用） ====================

const placeLine = (p: CityPlace, lib: CityPlaceLibrary): string => {
    const dist = formatDistance(haversineKm(lib.centerLat, lib.centerLng, p.lat, p.lng));
    const district = p.district ? `·${p.district}` : '';
    const addr = p.address ? `（${p.address}）` : '';
    return `- ${p.name}（${p.typeShort}${district}·距市中心${dist}）${addr}`;
};

/**
 * 全量清单（日程生成 prompt 用，约 50-80 行）：
 * 按类别分组，组内保留检索顺序（高德已按综合排序）。
 */
export const renderPlaceLibraryFull = (
    lib: CityPlaceLibrary,
    opts?: { maxPerCategory?: number },
): string => {
    const max = opts?.maxPerCategory ?? 8;
    const lines: string[] = [`【${lib.city}真实地点参考】（以下都是真实存在的地方，安排行程时优先从中选）`];
    for (const c of AMAP_PLACE_CATEGORIES) {
        const group = lib.places.filter((p) => p.category === c.key).slice(0, max);
        if (group.length === 0) continue;
        lines.push(` ${c.keywords}：`);
        for (const p of group) lines.push(` ${placeLine(p, lib)}`);
    }
    return lines.join('\n');
};

/**
 * 约会子集（世界演绎 / 见面观测 prompt 用，约 20 行）：
 * 只含 dating 类别，每类取前几条。
 */
export const renderPlaceLibraryDating = (
    lib: CityPlaceLibrary,
    opts?: { maxPerCategory?: number },
): string => {
    const max = opts?.maxPerCategory ?? 3;
    const lines: string[] = [`【${lib.city}真实地点参考】（约会/出游优先从中选，都是真实存在的地方）`];
    for (const c of AMAP_PLACE_CATEGORIES) {
        if (!c.dating) continue;
        const group = lib.places.filter((p) => p.category === c.key).slice(0, max);
        if (group.length === 0) continue;
        lines.push(` ${c.keywords}：${group.map((p) => p.name).join('、')}`);
    }
    return lines.join('\n');
};
