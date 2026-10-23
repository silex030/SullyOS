/**
 * 角色自主出行 · 地图 provider 抽象（B2）
 *
 * 国内走高德、国外走 Mapbox，但**接口只有一套**：地区只换实现，不换签名。
 * 本文件只放与厂商无关的东西：类型、错误、坐标/折线的严格解析、预算闸、许可元数据。
 *
 * 硬约束（与 `docs/travel-contract.md` 一致）：
 * - 坐标必须带 `coordSys`，跨 provider 只在边界转换（`utils/amapCore` 的公开算法，只读复用）；
 * - 任何「拿不到可信数据」的路径都抛错，**不画直线、不编造 ETA、不返回城市中心**；
 * - 不落任何缓存、不写库、不读环境变量：需要的东西一律由调用方注入；
 * - 错误文案只由 `kind` 决定，绝不回显 URL / key / token / 上游原文 / 坐标；
 * - 几何持久化许可（G1b）与 JS 底图展示授权（G1a）是两条线，元数据里分开给。
 */
import {
  MAX_CANDIDATES,
  type TravelCoordSys,
  type TravelErrorCode,
  type TravelGeoPoint,
  type TravelLatLng,
  type TravelProviderId,
} from '../../../../contracts/travel';

/** 地区判定只在这里两档：国内（高德）/ 国外（Mapbox）。 */
export type TravelProviderRegion = 'CN' | 'overseas';

/** 失败分类。上层 tick 据此决定「等下一轮」还是「标 unavailable / 停用」。 */
export type TravelProviderFailureKind =
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

const KIND_MESSAGE: Record<TravelProviderFailureKind, string> = {
  'not-configured': '地图服务未配置',
  auth: '地图服务鉴权失败',
  quota: '地图服务额度已用尽',
  'rate-limit': '地图服务请求过于频繁',
  'unsupported-region': '该地区暂不支持路线规划',
  'no-route': '暂时拿不到路线',
  'too-far': '路程超出该地图服务的规划范围',
  'bad-input': '地点或坐标参数不合法',
  'bad-response': '地图服务返回的数据不可用',
  transient: '地图服务暂时不可用',
};

/** 这些 kind 值得上层下一轮再试；provider 自己**绝不**自动重试（每次出口都花钱）。 */
const RETRYABLE_KINDS: ReadonlySet<TravelProviderFailureKind> = new Set(['rate-limit', 'transient']);

export interface TravelProviderErrorInit {
  readonly kind: TravelProviderFailureKind;
  readonly code: TravelErrorCode;
  readonly provider: TravelProviderId;
  readonly retryable?: boolean;
  /** 只作为字段保留，绝不进 message（避免把上游诊断拼进日志）。 */
  readonly infocode?: string;
}

export class TravelProviderError extends Error {
  readonly kind: TravelProviderFailureKind;
  readonly code: TravelErrorCode;
  readonly provider: TravelProviderId;
  readonly retryable: boolean;
  readonly infocode?: string;

  constructor(init: TravelProviderErrorInit) {
    super(KIND_MESSAGE[init.kind]);
    this.name = 'TravelProviderError';
    this.kind = init.kind;
    this.code = init.code;
    this.provider = init.provider;
    this.retryable = init.retryable ?? RETRYABLE_KINDS.has(init.kind);
    if (init.infocode) this.infocode = init.infocode;
  }
}

/* ------------------------------------------------------------------ *
 * 坐标：范围、体系、格式化（高德与 Mapbox 都是 lon,lat）
 * ------------------------------------------------------------------ */

const isCoordSys = (value: unknown): value is TravelCoordSys => value === 'gcj02' || value === 'wgs84';

/** 单点合法性：必须带 coordSys、必须是有限数、必须在经纬度范围内。不合法直接抛 bad-input。 */
export const assertGeoPoint = (point: TravelGeoPoint, provider: TravelProviderId = 'amap'): void => {
  const fail = () => {
    throw new TravelProviderError({ kind: 'bad-input', code: 'PROVIDER_FAILED', provider });
  };
  if (!point || typeof point !== 'object') fail();
  if (!isCoordSys(point.coordSys)) fail();
  if (typeof point.lat !== 'number' || typeof point.lng !== 'number') fail();
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) fail();
  if (point.lat < -90 || point.lat > 90) fail();
  if (point.lng < -180 || point.lng > 180) fail();
};

/** 六位小数的 `lon,lat`（高德 REST 硬上限就是 6 位，超位当非法参数）。 */
export const formatLonLat = (point: TravelGeoPoint, provider: TravelProviderId = 'amap'): string => {
  assertGeoPoint(point, provider);
  return `${point.lng.toFixed(6)},${point.lat.toFixed(6)}`;
};

/* ------------------------------------------------------------------ *
 * 折线解析：严格、有限、lon 在前
 * ------------------------------------------------------------------ */

export interface ParsedPoint extends TravelLatLng {}

const samePoint = (a: TravelLatLng, b: TravelLatLng): boolean => a.lat === b.lat && a.lng === b.lng;

/**
 * 高德坐标串（`116.481247,39.990704;116.481270,39.990726`）→ 点数组。
 *
 * 规则：按 `;` 切点、按 `,` 切分量；**恰好两段**且都是有限数、经纬度在范围内才算点，
 * 其余（缺分量、多分量、`abc`、越界）整点跳过 —— 宁可少一个点，也不猜位。
 * 相邻重复点去重（各 step 端点常重复）。非字符串 / 全坏返回空数组，由调用方报无路线。
 */
export const parsePolyline = (raw: unknown): TravelLatLng[] => {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const out: TravelLatLng[] = [];
  for (const chunk of raw.split(';')) {
    const parts = chunk.split(',');
    if (parts.length !== 2) continue;
    const lng = Number(parts[0].trim());
    const lat = Number(parts[1].trim());
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    const point = { lat, lng };
    const last = out[out.length - 1];
    if (last && samePoint(last, point)) continue;
    out.push(point);
  }
  return out;
};

/**
 * 拼接多段折线并去掉接缝重复点。少于 2 个点即**没有几何**：
 * 抛 `ROUTE_UNAVAILABLE`，绝不返回两点直线。
 */
export const joinRoutePoints = (
  segments: readonly (readonly TravelLatLng[])[],
  provider: TravelProviderId,
): TravelLatLng[] => {
  const out: TravelLatLng[] = [];
  for (const segment of segments) {
    for (const point of segment) {
      const last = out[out.length - 1];
      if (last && samePoint(last, point)) continue;
      out.push({ lat: point.lat, lng: point.lng });
    }
  }
  if (out.length < 2) {
    throw new TravelProviderError({ kind: 'no-route', code: 'ROUTE_UNAVAILABLE', provider });
  }
  return out;
};

/** 正数化：字符串里带单位 / `[]` / `null` 一律 NaN，交由调用方判缺失。 */
export const toFiniteNumber = (raw: unknown): number | null => {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
};

/* ------------------------------------------------------------------ *
 * 许可元数据：G1b（几何能否跨会话落库）与 G1a（底图展示授权）分开
 * ------------------------------------------------------------------ */

export interface TravelLicenseMeta {
  /** 折线 / 距离 / 时长能否写库跨会话复用。未取得书面许可前恒为 not-licensed。 */
  readonly geometryPersistence: 'allowed' | 'not-licensed';
  /** JS 底图（高德 JS API / Mapbox GL）展示授权是否已配置。与几何许可无关。 */
  readonly basemapDisplay: 'licensed' | 'not-configured';
  /** 结果只在本次调用 / 本次 tick 的内存作用域内有效。 */
  readonly memoryOnly: true;
  readonly attribution: string;
  readonly termsRef: string;
}

export interface TravelLicenseGrants {
  /** G1b：高德 3.5 末句书面答复 / Mapbox 条款许可。缺省 = 未取得。 */
  readonly geometryPersistenceLicensed?: boolean;
  /** G1a：独立 JS Key + jscode 反代 + 域名白名单是否已配。缺省 = 未配置。 */
  readonly basemapDisplayLicensed?: boolean;
}

const ATTRIBUTION: Record<TravelProviderId, string> = {
  amap: '高德地图',
  world: '© Mapbox © OpenStreetMap',
  noop: '',
};

const TERMS_REF: Record<TravelProviderId, string> = {
  amap: 'https://lbs.amap.com/home/terms/ §3.5/§7.3',
  world: 'https://www.mapbox.com/legal/tos',
  noop: '',
};

export const buildLicenseMeta = (
  provider: TravelProviderId,
  grants: TravelLicenseGrants = {},
): TravelLicenseMeta => ({
  geometryPersistence: grants.geometryPersistenceLicensed === true ? 'allowed' : 'not-licensed',
  basemapDisplay: grants.basemapDisplayLicensed === true ? 'licensed' : 'not-configured',
  memoryOnly: true,
  attribution: ATTRIBUTION[provider],
  termsRef: TERMS_REF[provider],
});

/* ------------------------------------------------------------------ *
 * 预算闸：每次真实出口请求前扣一次，读失败 fail-closed
 * ------------------------------------------------------------------ */

export type MapBudgetDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: 'BUDGET_BLOCKED' | 'BUDGET_ZERO' };

export interface TravelProviderDeps {
  /** 注入 fetch（测试用假实现；生产传全局 fetch）。provider 自己不碰全局。 */
  readonly fetch: typeof globalThis.fetch;
  /** 地图预算回调：每次出口请求调用一次。抛错 / 未放行都不发请求。 */
  readonly reserveMapCall: (provider: TravelProviderId) => MapBudgetDecision | Promise<MapBudgetDecision>;
  /** 仅用于日志/事件时间戳（provider 自身不发时间，缺省不读时钟）。 */
  readonly now?: () => number;
  /** 单次请求超时。 */
  readonly timeoutMs?: number;
}

type BudgetPort = Pick<TravelProviderDeps, 'reserveMapCall'>;

/** 预算不足或账本读失败 → 直接抛，**请求根本不会发出**；上层不得为此循环重试。 */
export const reserveMapBudget = async (port: BudgetPort, provider: TravelProviderId): Promise<void> => {
  let decision: MapBudgetDecision;
  try {
    decision = await port.reserveMapCall(provider);
  } catch {
    throw new TravelProviderError({ kind: 'quota', code: 'BUDGET_BLOCKED', provider });
  }
  if (!decision || decision.allowed !== true) {
    const code = decision && decision.code === 'BUDGET_ZERO' ? 'BUDGET_ZERO' : 'BUDGET_BLOCKED';
    throw new TravelProviderError({ kind: 'quota', code, provider });
  }
};

/* ------------------------------------------------------------------ *
 * 单次出口请求（无重试）
 * ------------------------------------------------------------------ */

export interface ProviderHttpResult {
  readonly status: number;
  readonly ok: boolean;
  /** 已解析的 JSON；不是 JSON 时为 null（由调用方按 bad-response 处理）。 */
  readonly body: unknown;
}

/**
 * 发一次 GET（**恰好一次**：不重试、不循环）。网络错误 / 超时 → transient。
 * 非 2xx 不在这里抛：各家的错误码语义不同（高德还看 body.status），交由实现判定。
 */
export const requestJsonOnce = async (
  deps: TravelProviderDeps,
  provider: TravelProviderId,
  url: string,
): Promise<ProviderHttpResult> => {
  const controller = new AbortController();
  const timeoutMs = deps.timeoutMs ?? 8000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await deps.fetch(url, { method: 'GET', signal: controller.signal });
  } catch {
    throw new TravelProviderError({ kind: 'transient', code: 'PROVIDER_FAILED', provider });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text().catch(() => '');
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: response.status, ok: response.ok, body };
};

/* ------------------------------------------------------------------ *
 * 接口：三个能力 + 地区声明
 * ------------------------------------------------------------------ */

export interface TravelRouteRequest {
  readonly origin: TravelGeoPoint;
  readonly destination: TravelGeoPoint;
  /** 起点/终点是 POI 时带上，提升路线贴合度（高德 origin_id / destination_id）。 */
  readonly originPlaceId?: string;
  readonly destinationPlaceId?: string;
}

export interface TravelRouteStep {
  readonly instruction: string;
  readonly distanceM: number | null;
  readonly durationS: number | null;
}

export interface TravelRouteResult {
  readonly provider: TravelProviderId;
  /** 输出点所在坐标体系（显式；跨 provider 只在边界转换）。 */
  readonly coordSys: TravelCoordSys;
  readonly points: readonly TravelLatLng[];
  readonly distanceM: number;
  /** 官方没给就是 null：UI 显示「未知」，不按默认速度编造。 */
  readonly durationS: number | null;
  readonly steps: readonly TravelRouteStep[];
  /**
   * 许可与归属元数据。**是否写库由上层 tick 按 `geometryPersistence` 决定**，
   * provider 只如实标注，从不自己落盘。
   */
  readonly license: TravelLicenseMeta;
}

export interface TravelCandidateQuery {
  /** 已由上层脱敏（无坐标 / 无住户门牌）的愿望文本或类别词。 */
  readonly wishText: string;
  readonly city: string;
  /** 可选的偏置中心（同体系坐标）；给了才派生 distanceM。 */
  readonly center?: TravelGeoPoint;
  readonly limit?: number;
}

export interface TravelCandidateHit {
  readonly id: string;
  readonly label: string;
  readonly category?: string;
  readonly city: string;
  readonly district?: string;
  /** 坐标只留在服务端与地图渲染层，不进模型上下文。 */
  readonly location: TravelGeoPoint;
  readonly distanceM: number | null;
  readonly provider: TravelProviderId;
}

export interface TravelAnchorQuery {
  readonly label: string;
  readonly city: string;
  readonly district?: string;
}

/**
 * 地理编码出的锚点候选。**没有 address 字段**（结构性约束），
 * 也不带 `confirmedAt` —— 确认是用户动作，落库时由上层 `pickAnchorFields()` 盖章。
 */
export interface TravelAnchorCandidate {
  readonly label: string;
  readonly city: string;
  readonly district?: string;
  readonly location: TravelGeoPoint;
  readonly placeId?: string;
  readonly provider: TravelProviderId;
  readonly precision: 'area';
}

export interface TravelMapProvider {
  readonly id: TravelProviderId;
  /** 本实现输出的坐标体系（高德 gcj02 / Mapbox wgs84）。 */
  readonly coordSys: TravelCoordSys;
  readonly regions: readonly TravelProviderRegion[];
  supports(region: TravelProviderRegion): boolean;
  searchCandidates(query: TravelCandidateQuery): Promise<readonly TravelCandidateHit[]>;
  route(request: TravelRouteRequest): Promise<TravelRouteResult>;
  geocodeAnchor(query: TravelAnchorQuery): Promise<TravelAnchorCandidate>;
}

/** 地区 → 实现。没有实现返回 null：上层把行程标 `unavailable`，不画直线。 */
export const providerForRegion = (
  region: TravelProviderRegion,
  providers: readonly TravelMapProvider[],
): TravelMapProvider | null => providers.find((provider) => provider.supports(region)) ?? null;

/** 候选条数闸（契约上限 8）。 */
export const clampCandidateLimit = (limit: number | undefined): number => {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return MAX_CANDIDATES;
  return Math.min(MAX_CANDIDATES, Math.max(1, Math.floor(limit)));
};
