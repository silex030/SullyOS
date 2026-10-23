/**
 * 角色自主出行 · 共享契约（framework-free）
 *
 * 为什么放在仓库根的 `contracts/`：
 * - 这份契约同时被前端（`utils/travel/*`、`components/travel/*`）与后端
 *   （`worker/amsg/src/travel/*`，跑在 VPS/D1 上的 SQLite）引用；
 * - 仓内 `types.ts` 是公共入口（由集成执行者独占），把出行类型塞进去会让
 *   B0 契约批次与 TTS/其它改动在同一文件上打架；
 * - 本文件零 import、零运行时依赖（只有类型、常量与 DDL 字符串），两边都能直接吃，
 *   不需要 Vite alias，也不会把浏览器依赖带进 worker bundle。
 *
 * 硬约定（不可在本文件之外重新定义）：
 * - 坐标必须带 `coordSys`；坐标不进模型上下文、不进日志明文、不进备份导出；
 * - 固定地点只存白名单字段，**结构上没有 `address`**；
 * - 不存在地点/路线持久化缓存表（高德协议 3.5/7.3/4.12.3，见 docs/travel-contract.md）；
 * - 人格/情绪/亲密度：用户只提供初始设定、世界设定、能力授权、隐私与预算，
 *   角色的想法、情绪与人格发展由其自身经历与互动形成；系统不提供强制干预入口。
 *   情绪/亲密度系统缺失处留空接口，不生成分值、不随机心情。
 */

/** 坐标体系。跨 provider 只在边界转换（复用 `utils/amapCore` 的 wgs84/gcj02 转换）。 */
export type TravelCoordSys = 'gcj02' | 'wgs84';

export interface TravelLatLng {
    lat: number;
    lng: number;
}

export interface TravelGeoPoint extends TravelLatLng {
    coordSys: TravelCoordSys;
}

/** 行程相位（服务端权威；客户端没有任何推进接口）。 */
export type TravelTripStatus =
    | 'considering'
    | 'planned'
    | 'en_route'
    | 'dwelling'
    | 'returning'
    | 'returned'
    /** 闲逛在外正常结束（角色自己决定不回家、就地停下）：终态但与 returned 不同语义。 */
    | 'stopped'
    | 'aborted'
    | 'expired'
    /** provider 不可用（如国外未接入）：不是终态，接入后同一 wish 可重试。 */
    | 'unavailable';

export type TravelWishState =
    | 'open'
    | 'candidates_ready'
    | 'chosen'
    /** 这一趟走完了（含在外结束）：愿望闭环，不再每跳重排。 */
    | 'completed'
    | 'dropped'
    | 'expired';

/** 固定地点（用户住处 / 角色住处 / 选定的公共地点）。 */
export interface TravelPlaceRef {
    /** 小区名或公共地点名（`中山路100号` 这类公共门牌保留原样）。 */
    label: string;
    city: string;
    district?: string;
    lat: number;
    lng: number;
    coordSys?: TravelCoordSys;
    placeId?: string;
    kind?: 'home' | 'public' | 'anchor';
}

/**
 * 锚点落库形态：只有这些字段，没有 address。
 * `precision: 'area'` 表示小区质心级，不是门牌级定位。
 */
export interface TravelPlaceAnchor {
    label: string;
    city: string;
    district?: string;
    lat: number;
    lng: number;
    coordSys: TravelCoordSys;
    precision: 'area';
    confirmedAt: number;
    source: 'user';
}

export interface TravelTrip {
    id: string;
    userId: string;
    charId: string;
    status: TravelTripStatus;
    /** 改计划时 +1；旧行不原地改，标 aborted(reason:plan_changed)。 */
    planVersion: number;
    /** 乐观锁：任何写都要 CAS。 */
    revision: number;
    coordSys: TravelCoordSys;
    provider: TravelProviderId;
    origin: TravelPlaceRef;
    /** 闲逛分段时可为 null。 */
    dest: TravelPlaceRef | null;
    departAt: number | null;
    arriveAt: number | null;
    dwellUntil: number | null;
    returnAt: number | null;
}

export type TravelProviderId = 'amap' | 'noop' | 'world';

/** 有界候选：模型/前端只看这些字段，坐标只在服务端。 */
export interface TravelCandidateView {
    id: string;
    label: string;
    category?: string;
    distanceM?: number | null;
    provider?: TravelProviderId;
}

export interface TravelWish {
    id: string;
    userId: string;
    charId: string;
    /** 角色原话/类别，已过 maskPlace 与 sanitizeWishText。 */
    wishText: string;
    category?: string;
    state: TravelWishState;
    expiresAt: number | null;
    createdAt: number;
    updatedAt: number;
}

export interface TravelShareState {
    userId: string;
    charId: string;
    shareEnabled: boolean;
    version: number;
}

export interface TravelBudgetState {
    userId: string;
    /** 由 `travel_settings.budget_tz` + 服务端时间计算；账号级固定时区。 */
    dayKey: string;
    mapCallsUsed: number;
    mapCallsLimit: number;
    llmTokensUsed: number;
    llmTokensLimit: number;
    paused: boolean;
    version: number;
}

export type TravelBudgetKind = 'map' | 'llm';

/** 前端只读快照。共享关闭时服务端必须返回 `SHARE_REVOKED` 且剥离坐标/路线/历史点。 */
export interface TravelStateSnapshot {
    code: 'OK' | 'SHARE_REVOKED';
    serverNow: number;
    trip: TravelTrip | null;
    position: TravelGeoPoint | null;
    route: { points: TravelLatLng[]; distanceM: number } | null;
    history: TravelLatLng[];
    budget: { mapCallsUsed: number; mapCallsLimit: number };
    shareEnabled?: boolean;
}

export type TravelErrorCode =
    | 'UNAUTHORIZED'
    | 'INVALID_CLIENT_TOKEN'
    | 'PRINCIPAL_MISMATCH'
    | 'SHARE_REVOKED'
    | 'UNKNOWN_CANDIDATE'
    | 'WISH_EXPIRED'
    | 'PROVIDER_UNSUPPORTED_REGION'
    | 'PROVIDER_FAILED'
    | 'BUDGET_BLOCKED'
    | 'BUDGET_ZERO'
    | 'VERSION_CONFLICT'
    | 'ANCHOR_NOT_CONFIRMED'
    | 'ROUTE_UNAVAILABLE'
    | 'GEOMETRY_NOT_LICENSED'
    | 'RETENTION_EXPIRED';

export const TRAVEL_ERROR_CODES = [
    'UNAUTHORIZED',
    'INVALID_CLIENT_TOKEN',
    'PRINCIPAL_MISMATCH',
    'SHARE_REVOKED',
    'UNKNOWN_CANDIDATE',
    'WISH_EXPIRED',
    'PROVIDER_UNSUPPORTED_REGION',
    'PROVIDER_FAILED',
    'BUDGET_BLOCKED',
    'BUDGET_ZERO',
    'VERSION_CONFLICT',
    'ANCHOR_NOT_CONFIRMED',
    'ROUTE_UNAVAILABLE',
    'GEOMETRY_NOT_LICENSED',
    'RETENTION_EXPIRED',
] as const satisfies readonly TravelErrorCode[];

/** 状态机：只列允许的边；其余一律非法（含终态自环）。 */
export const TRAVEL_TRANSITIONS: Record<TravelTripStatus, readonly TravelTripStatus[]> = {
    considering: ['planned', 'aborted', 'expired', 'unavailable'],
    planned: ['en_route', 'aborted', 'expired', 'unavailable'],
    en_route: ['dwelling', 'aborted', 'expired'],
    // 闲逛在外正常结束（角色自己决定就地停下）→ stopped，与「回家」是同层终态但语义不同。
    dwelling: ['returning', 'stopped', 'en_route', 'aborted', 'expired'],
    returning: ['returned', 'aborted', 'expired'],
    returned: [],
    stopped: [],
    aborted: [],
    expired: [],
    unavailable: ['considering', 'planned', 'aborted', 'expired'],
};

export const TRAVEL_TERMINAL_STATUSES = ['returned', 'stopped', 'aborted', 'expired'] as const;

/** 可改计划的相位（任何非终态；改计划插入新代，旧行 aborted(plan_changed)）。 */
export const TRAVEL_PLAN_CHANGEABLE_STATUSES = [
    'considering',
    'planned',
    'en_route',
    'dwelling',
    'returning',
] as const;

export const MAX_CANDIDATES = 8;

export const DEFAULT_BUDGET_TZ = 'Asia/Shanghai';

/** 保留期默认值；0 = 只留当前行程 / 不保留事件。append-only ≠ 永久保留。 */
export const TRAVEL_RETENTION_DEFAULTS = { tripDays: 30, eventDays: 7 } as const;

/** 步行默认速度（m/s），只用于阶段推进的粗校验，不做 ETA 编造。 */
export const TRAVEL_WALK_SPEED_MPS = 1.15;

/** 超过 `depart_at + 4h` 仍未推进 → expired。 */
export const TRAVEL_STALE_TRIP_MS = 4 * 60 * 60 * 1000;

/**
 * 冻结 DDL（SQLite / D1 同构）。7 张表，全部 additive。
 * **没有** travel_place_cache / travel_route_cache：条款未定时不做默认持久化缓存。
 * 所有唯一索引含 `user_id`，防跨租户 dedupe 碰撞。
 */
export const TRAVEL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS travel_settings (
  user_id TEXT PRIMARY KEY,
  budget_tz TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  trip_retention_days INTEGER NOT NULL DEFAULT 30,
  event_retention_days INTEGER NOT NULL DEFAULT 7,
  enabled INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS travel_char_settings (
  user_id TEXT NOT NULL,
  char_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, char_id)
);

CREATE TABLE IF NOT EXISTS travel_anchors (
  user_id TEXT NOT NULL,
  char_id TEXT NOT NULL,
  label TEXT NOT NULL,
  city TEXT NOT NULL,
  district TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  coord_sys TEXT NOT NULL,
  precision TEXT NOT NULL DEFAULT 'area',
  confirmed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, char_id)
);

CREATE TABLE IF NOT EXISTS travel_trip_positions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  coord_sys TEXT NOT NULL,
  share_generation INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS travel_positions_trip ON travel_trip_positions (user_id, trip_id, at);

CREATE TABLE IF NOT EXISTS travel_wishes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  char_id TEXT NOT NULL,
  wish_text TEXT NOT NULL,
  category TEXT,
  selected_candidate_id TEXT,
  state TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS travel_wishes_open ON travel_wishes (user_id, char_id, state, expires_at);

CREATE TABLE IF NOT EXISTS travel_candidates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  wish_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  place_id TEXT,
  label TEXT NOT NULL,
  category TEXT,
  city TEXT,
  district TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  coord_sys TEXT NOT NULL,
  distance_m INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS travel_candidates_wish ON travel_candidates (user_id, wish_id, expires_at);

CREATE TABLE IF NOT EXISTS travel_trips (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  char_id TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  plan_version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  coord_sys TEXT NOT NULL,
  provider TEXT NOT NULL,
  origin_json TEXT NOT NULL,
  dest_json TEXT,
  route_json TEXT,
  route_fetched_at INTEGER,
  depart_at INTEGER,
  arrive_at INTEGER,
  dwell_until INTEGER,
  return_at INTEGER,
  retention_expires_at INTEGER,
  dedupe_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS travel_trips_dedupe ON travel_trips (user_id, char_id, dedupe_key);
CREATE INDEX IF NOT EXISTS travel_trips_due ON travel_trips (user_id, status, dwell_until, return_at);
CREATE INDEX IF NOT EXISTS travel_trips_retention ON travel_trips (retention_expires_at);

CREATE TABLE IF NOT EXISTS travel_trip_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  payload_json TEXT,
  source TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS travel_events_seq ON travel_trip_events (user_id, trip_id, seq);
CREATE INDEX IF NOT EXISTS travel_events_retention ON travel_trip_events (expires_at);

CREATE TABLE IF NOT EXISTS travel_budget_state (
  user_id TEXT PRIMARY KEY,
  map_calls_used INTEGER NOT NULL DEFAULT 0,
  map_calls_limit INTEGER NOT NULL,
  map_attempts_used INTEGER NOT NULL DEFAULT 0,
  llm_tokens_used INTEGER NOT NULL DEFAULT 0,
  llm_tokens_limit INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS travel_share_state (
  user_id TEXT NOT NULL,
  char_id TEXT NOT NULL,
  share_enabled INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, char_id)
);
`.trim();
