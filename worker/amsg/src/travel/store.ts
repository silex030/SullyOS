/**
 * 角色自主出行 · 存储层（B1）
 *
 * 表结构**直接吃契约里的 `TRAVEL_SCHEMA_SQL`**（`contracts/travel.ts`），这里不另抄一份
 * DDL：契约是唯一来源，抄一份就一定会漂。7 张表：settings / wishes / candidates /
 * trips / trip_events / budget_state / share_state；**没有** place/route 缓存表。
 *
 * 这一层只做「真库上成立」的事，规则判断留给 `utils/travel/core.ts`：
 * - 所有读写都带 `user_id`（租户键），跨租户的行等于不存在，不靠调用方自觉；
 * - 唯一索引是契约原文（`(user_id, char_id, dedupe_key)`、`(user_id, trip_id, seq)`、
 *   share 的 `(user_id, char_id)` 主键），所以幂等靠 `INSERT OR IGNORE` + changes，
 *   不靠先查后插（那样并发下会双写）；
 * - 行程改写一律走 `casUpdateTravelTrip`：读一次拿 revision，再 `UPDATE ... WHERE
 *   revision = ?`，0 行就是 `VERSION_CONFLICT`。**不允许无条件 UPDATE**；
 * - 坐标留在 `origin_json` / `dest_json` / `route_json` / candidates 表里，不进日志；
 *   对外视图由 core 的 `redactSharedSnapshot` 负责剥离。
 *
 * 约定：`phase` 列跟 `status` 同源（服务端 tick 只推进 status，phase 是展示镜像）。
 */

import {
  TRAVEL_RETENTION_DEFAULTS,
  TRAVEL_SCHEMA_SQL,
  TRAVEL_TERMINAL_STATUSES,
  DEFAULT_BUDGET_TZ,
  type TravelCandidateView,
  type TravelBudgetState,
  type TravelCoordSys,
  type TravelLatLng,
  type TravelPlaceRef,
  type TravelProviderId,
  type TravelShareState,
  type TravelTripStatus,
  type TravelWishState,
} from '../../../../contracts/travel';

/** D1 结构子集（与 autonomyStore 的 AutonomyDb 同一手法，不引未声明的 D1Database）。 */
export interface TravelStatement {
  bind(...args: unknown[]): TravelStatement;
  run(): Promise<unknown>;
  first(): Promise<Record<string, unknown> | null>;
  all(): Promise<{ results?: Array<Record<string, unknown>> }>;
}

export interface TravelDb {
  prepare(sql: string): TravelStatement;
}

/**
 * 终态清单的 SQL 片段：**从契约常量生成**，不再各处手抄一份。
 * 新增终态（如 `stopped`）时，「当前在途」查询、静态图判定、快照剥离会一起跟上，
 * 不会出现「新终态只改了一半、被当成在途永远不再规划」。
 */
export const TERMINAL_STATUS_SQL = TRAVEL_TERMINAL_STATUSES.map((status) => `'${status}'`).join(', ');

/** 0 = 行不存在/冲突；D1 回 `meta.changes`，本仓测试替身回顶层 `changes`，两边都认。 */
const changesOf = (result: unknown): number => {
  const raw = result as { meta?: { changes?: unknown }; changes?: unknown } | null;
  const value = raw?.meta?.changes ?? raw?.changes ?? 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
const asNumber = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const asNullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : asNumber(value);
const asBool = (value: unknown): boolean => Number(value) === 1 || value === true;

const parseJson = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const toJson = (value: unknown): string | null => (value === null || value === undefined ? null : JSON.stringify(value));

/* ------------------------------------------------------------------ *
 * schema
 * ------------------------------------------------------------------ */

let schemaReady = false;

/** 只给测试用：模块级 ready 短路会让第二个用例连到空库。 */
/** 老库补列（幂等；失败只可能是「列已存在」）。 */
const TRAVEL_SCHEMA_ALTERS: readonly string[] = [
  'ALTER TABLE travel_wishes ADD COLUMN selected_candidate_id TEXT',
  'ALTER TABLE travel_settings ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0',
];

export function resetTravelSchemaCacheForTesting(): void {
  schemaReady = false;
}

/**
 * 按 `;` 切契约脚本，**不复制 DDL**（D1 的 `prepare()` 与 node:sqlite 一样只吃单语句，
 * 整段脚本直接 prepare 只会执行第一条 —— 踩过）。引号内的分号不切。
 */
export function splitTravelStatements(sql: string): string[] {
  const out: string[] = [];
  let buffer = '';
  let quote: string | null = null;
  for (const char of sql) {
    if (quote) {
      buffer += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      buffer += char;
      continue;
    }
    if (char === ';') {
      if (buffer.trim()) out.push(buffer.trim());
      buffer = '';
      continue;
    }
    buffer += char;
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}

/**
 * 懒建表（照 worker/post-office 与 autonomyStore 的做法）。
 * 语句全部 `IF NOT EXISTS`，重复调用安全；真实 D1 上首次请求付一次代价。
 */
export async function ensureTravelSchema(db: TravelDb): Promise<void> {
  if (schemaReady) return;
  for (const statement of splitTravelStatements(TRAVEL_SCHEMA_SQL)) {
    await db.prepare(statement).run();
  }
  // 已存在的库补列（CREATE IF NOT EXISTS 不会给老表加列）。失败说明列已在，忽略。
  for (const alter of TRAVEL_SCHEMA_ALTERS) {
    try {
      await db.prepare(alter).run();
    } catch {
      /* duplicate column / 已迁移 */
    }
  }
  schemaReady = true;
}

/* ------------------------------------------------------------------ *
 * settings
 * ------------------------------------------------------------------ */

export interface TravelSettings {
  userId: string;
  budgetTz: string;
  tripRetentionDays: number;
  eventRetentionDays: number;
  /** 账号级总开关。缺行/缺字段一律 false（未开启），不做正整数默认化。 */
  enabled: boolean;
  version: number;
  updatedAt: number;
}

export interface UpsertSettingsInput {
  userId: string;
  nowMs: number;
  /** null = 期待不存在（首次创建）；数字 = 必须与当前 version 相等。 */
  baseVersion: number | null;
  budgetTz?: string;
  tripRetentionDays?: number;
  eventRetentionDays?: number;
  /** 只有用户显式传布尔才改；不传沿用旧值。 */
  enabled?: boolean;
}

export type SettingsWriteResult =
  | { ok: true; settings: TravelSettings }
  | { ok: false; code: 'VERSION_CONFLICT' };

const SETTINGS_COLUMNS = 'user_id, budget_tz, trip_retention_days, event_retention_days, enabled, version, updated_at';

const readSettingsRow = (row: Record<string, unknown>): TravelSettings => ({
  userId: asString(row.user_id),
  budgetTz: asString(row.budget_tz) || DEFAULT_BUDGET_TZ,
  tripRetentionDays: asNumber(row.trip_retention_days),
  eventRetentionDays: asNumber(row.event_retention_days),
  enabled: asBool(row.enabled),
  version: asNumber(row.version),
  updatedAt: asNumber(row.updated_at),
});

export async function getTravelSettings(db: TravelDb, userId: string): Promise<TravelSettings | null> {
  const row = await db
    .prepare(`SELECT ${SETTINGS_COLUMNS} FROM travel_settings WHERE user_id = ?`)
    .bind(userId)
    .first();
  return row ? readSettingsRow(row) : null;
}

/**
 * 建/改账号策略。改动必须带版本（CAS），防止两台设备互相把 `budget_tz` 或保留期盖回去。
 * 未传的字段沿用旧值；首次创建用契约默认值（30 天 / 7 天 / Asia/Shanghai）。
 */
export async function upsertTravelSettings(
  db: TravelDb,
  input: UpsertSettingsInput,
): Promise<SettingsWriteResult> {
  const current = await getTravelSettings(db, input.userId);
  if (!current) {
    if (input.baseVersion !== null) return { ok: false, code: 'VERSION_CONFLICT' };
    const settings: TravelSettings = {
      userId: input.userId,
      budgetTz: input.budgetTz?.trim() || DEFAULT_BUDGET_TZ,
      tripRetentionDays: input.tripRetentionDays ?? TRAVEL_RETENTION_DEFAULTS.tripDays,
      eventRetentionDays: input.eventRetentionDays ?? TRAVEL_RETENTION_DEFAULTS.eventDays,
      enabled: input.enabled === true,
      version: 1,
      updatedAt: input.nowMs,
    };
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO travel_settings (${SETTINGS_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        settings.userId,
        settings.budgetTz,
        settings.tripRetentionDays,
        settings.eventRetentionDays,
        settings.enabled ? 1 : 0,
        settings.version,
        settings.updatedAt,
      )
      .run();
    // 并发创建：别人先插了 → 视为版本冲突，让调用方重读，不覆盖。
    if (changesOf(result) !== 1) return { ok: false, code: 'VERSION_CONFLICT' };
    return { ok: true, settings };
  }

  if (input.baseVersion !== current.version) return { ok: false, code: 'VERSION_CONFLICT' };
  const next: TravelSettings = {
    userId: current.userId,
    budgetTz: input.budgetTz?.trim() || current.budgetTz,
    tripRetentionDays: input.tripRetentionDays ?? current.tripRetentionDays,
    eventRetentionDays: input.eventRetentionDays ?? current.eventRetentionDays,
    enabled: input.enabled === undefined ? current.enabled : input.enabled === true,
    version: current.version + 1,
    updatedAt: input.nowMs,
  };
  const result = await db
    .prepare(
      `UPDATE travel_settings
       SET budget_tz = ?, trip_retention_days = ?, event_retention_days = ?, enabled = ?,
           version = ?, updated_at = ?
       WHERE user_id = ? AND version = ?`,
    )
    .bind(
      next.budgetTz,
      next.tripRetentionDays,
      next.eventRetentionDays,
      next.enabled ? 1 : 0,
      next.version,
      next.updatedAt,
      next.userId,
      current.version,
    )
    .run();
  if (changesOf(result) !== 1) return { ok: false, code: 'VERSION_CONFLICT' };
  return { ok: true, settings: next };
}

/* ------------------------------------------------------------------ *
 * wishes
 * ------------------------------------------------------------------ */

export interface TravelWishRecord {
  id: string;
  userId: string;
  charId: string;
  wishText: string;
  category?: string | null;
  /**
   * 模型真正选中的候选 id（决策成功即落库）。**这是「角色选了哪」的唯一权威**：
   * 下一跳/重试只能用它，绝不能退回「列表第一个」替角色做决定。
   */
  selectedCandidateId?: string | null;
  state: TravelWishState;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

const WISH_COLUMNS =
  'id, user_id, char_id, wish_text, category, selected_candidate_id, state, expires_at, created_at, updated_at';

const readWishRow = (row: Record<string, unknown>): TravelWishRecord => ({
  id: asString(row.id),
  userId: asString(row.user_id),
  charId: asString(row.char_id),
  wishText: asString(row.wish_text),
  category: typeof row.category === 'string' ? row.category : null,
  selectedCandidateId: typeof row.selected_candidate_id === 'string' ? row.selected_candidate_id : null,
  state: asString(row.state) as TravelWishState,
  expiresAt: asNullableNumber(row.expires_at),
  createdAt: asNumber(row.created_at),
  updatedAt: asNumber(row.updated_at),
});

/**
 * 幂等插入。同 id 已存在 → false（不覆盖正文/状态）。
 * id 已被**别的租户**占用 → 也返回 false（主键全局唯一，绝不允许改写成别人的行）。
 */
export async function insertTravelWish(db: TravelDb, wish: TravelWishRecord): Promise<boolean> {
  const result = await db
    .prepare(`INSERT OR IGNORE INTO travel_wishes (${WISH_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      wish.id,
      wish.userId,
      wish.charId,
      wish.wishText,
      wish.category ?? null,
      wish.selectedCandidateId ?? null,
      wish.state,
      wish.expiresAt,
      wish.createdAt,
      wish.updatedAt,
    )
    .run();
  return changesOf(result) === 1;
}

export async function getTravelWish(
  db: TravelDb,
  args: { userId: string; wishId: string },
): Promise<TravelWishRecord | null> {
  const row = await db
    .prepare(`SELECT ${WISH_COLUMNS} FROM travel_wishes WHERE user_id = ? AND id = ?`)
    .bind(args.userId, args.wishId)
    .first();
  return row ? readWishRow(row) : null;
}

/** 未过期愿望（含 candidates_ready / chosen 这类还会被推进的状态）。 */
export async function listTravelWishes(
  db: TravelDb,
  args: { userId: string; charId: string; nowMs: number; states?: readonly TravelWishState[] },
): Promise<TravelWishRecord[]> {
  const states = args.states?.length ? [...args.states] : null;
  const filter = states ? ` AND state IN (${states.map(() => '?').join(', ')})` : '';
  const rows = await db
    .prepare(
      `SELECT ${WISH_COLUMNS} FROM travel_wishes
       WHERE user_id = ? AND char_id = ? AND (expires_at IS NULL OR expires_at > ?)${filter}
       ORDER BY created_at ASC, id ASC`,
    )
    .bind(args.userId, args.charId, args.nowMs, ...(states ?? []))
    .all();
  return (rows.results ?? []).map(readWishRow);
}

/** 条件改状态（带租户）：返回 false = 行不存在或不属于该租户。 */
export async function setTravelWishState(
  db: TravelDb,
  args: { userId: string; wishId: string; state: TravelWishState; nowMs: number },
): Promise<boolean> {
  const result = await db
    .prepare('UPDATE travel_wishes SET state = ?, updated_at = ? WHERE user_id = ? AND id = ?')
    .bind(args.state, args.nowMs, args.userId, args.wishId)
    .run();
  return changesOf(result) === 1;
}

/* ------------------------------------------------------------------ *
 * candidates
 * ------------------------------------------------------------------ */

export interface TravelCandidateRecord extends TravelCandidateView {
  userId: string;
  wishId: string;
  placeId?: string;
  city?: string;
  district?: string;
  lat: number;
  lng: number;
  coordSys: TravelCoordSys;
  expiresAt: number;
  createdAt: number;
}

const CANDIDATE_COLUMNS =
  'id, user_id, wish_id, provider, place_id, label, category, city, district, lat, lng, coord_sys, distance_m, expires_at, created_at';

const readCandidateRow = (row: Record<string, unknown>): TravelCandidateRecord => ({
  id: asString(row.id),
  userId: asString(row.user_id),
  wishId: asString(row.wish_id),
  provider: asString(row.provider) as TravelProviderId,
  placeId: typeof row.place_id === 'string' ? row.place_id : undefined,
  label: asString(row.label),
  category: typeof row.category === 'string' ? row.category : undefined,
  city: typeof row.city === 'string' ? row.city : undefined,
  district: typeof row.district === 'string' ? row.district : undefined,
  lat: asNumber(row.lat),
  lng: asNumber(row.lng),
  coordSys: asString(row.coord_sys) as TravelCoordSys,
  distanceM: asNullableNumber(row.distance_m),
  expiresAt: asNumber(row.expires_at),
  createdAt: asNumber(row.created_at),
});

/**
 * 冻结一批候选（`clampCandidates` 之后调用，这里不再扩数量）。
 * 幂等：同 id 已存在就跳过（不覆盖已展示给角色的那一份）。
 */
export async function saveTravelCandidates(
  db: TravelDb,
  args: { userId: string; wishId: string; candidates: readonly TravelCandidateRecord[]; nowMs: number },
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  for (const candidate of args.candidates) {
    if (candidate.userId !== args.userId || candidate.wishId !== args.wishId) {
      // 归属不符的候选一律不写：这是防串租户的第一道，别指望 SQL 兜。
      skipped += 1;
      continue;
    }
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO travel_candidates (${CANDIDATE_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        candidate.id,
        candidate.userId,
        candidate.wishId,
        candidate.provider,
        candidate.placeId ?? null,
        candidate.label,
        candidate.category ?? null,
        candidate.city ?? null,
        candidate.district ?? null,
        candidate.lat,
        candidate.lng,
        candidate.coordSys,
        candidate.distanceM ?? null,
        candidate.expiresAt,
        candidate.createdAt,
      )
      .run();
    if (changesOf(result) === 1) inserted += 1;
    else skipped += 1;
  }
  return { inserted, skipped };
}

export async function listTravelCandidates(
  db: TravelDb,
  args: { userId: string; wishId: string; nowMs: number },
): Promise<TravelCandidateRecord[]> {
  const rows = await db
    .prepare(
      `SELECT ${CANDIDATE_COLUMNS} FROM travel_candidates
       WHERE user_id = ? AND wish_id = ? AND expires_at > ?
       ORDER BY created_at ASC, id ASC`,
    )
    .bind(args.userId, args.wishId, args.nowMs)
    .all();
  return (rows.results ?? []).map(readCandidateRow);
}

/** 选点前的归属校验：不属于该 wish / 不属于该租户 / 已过期 → null（上游回 UNKNOWN_CANDIDATE）。 */
export async function getTravelCandidate(
  db: TravelDb,
  args: { userId: string; wishId: string; candidateId: string; nowMs: number },
): Promise<TravelCandidateRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${CANDIDATE_COLUMNS} FROM travel_candidates
       WHERE user_id = ? AND wish_id = ? AND id = ? AND expires_at > ?`,
    )
    .bind(args.userId, args.wishId, args.candidateId, args.nowMs)
    .first();
  return row ? readCandidateRow(row) : null;
}

/* ------------------------------------------------------------------ *
 * trips
 * ------------------------------------------------------------------ */

export interface TravelRouteRecord {
  points: TravelLatLng[];
  distanceM: number;
}

export interface TravelTripRecord {
  id: string;
  userId: string;
  charId: string;
  status: TravelTripStatus;
  /** 与 status 同源（展示镜像）；CAS 改 status 时一起写。 */
  phase: TravelTripStatus;
  planVersion: number;
  revision: number;
  coordSys: TravelCoordSys;
  provider: TravelProviderId;
  origin: TravelPlaceRef;
  dest: TravelPlaceRef | null;
  /** 只在取得几何许可（G1b）后才写；无许可必须为 null。 */
  route: TravelRouteRecord | null;
  routeFetchedAt: number | null;
  departAt: number | null;
  arriveAt: number | null;
  dwellUntil: number | null;
  returnAt: number | null;
  retentionExpiresAt: number | null;
  dedupeKey: string;
  createdAt: number;
  updatedAt: number;
}

const TRIP_COLUMNS = `id, user_id, char_id, status, phase, plan_version, revision, coord_sys, provider,
  origin_json, dest_json, route_json, route_fetched_at, depart_at, arrive_at, dwell_until, return_at,
  retention_expires_at, dedupe_key, created_at, updated_at`;

const readTripRow = (row: Record<string, unknown>): TravelTripRecord => ({
  id: asString(row.id),
  userId: asString(row.user_id),
  charId: asString(row.char_id),
  status: asString(row.status) as TravelTripStatus,
  phase: asString(row.phase) as TravelTripStatus,
  planVersion: asNumber(row.plan_version),
  revision: asNumber(row.revision),
  coordSys: asString(row.coord_sys) as TravelCoordSys,
  provider: asString(row.provider) as TravelProviderId,
  origin: parseJson<TravelPlaceRef>(row.origin_json, { label: '', city: '', lat: 0, lng: 0 }),
  dest: parseJson<TravelPlaceRef | null>(row.dest_json, null),
  route: parseJson<TravelRouteRecord | null>(row.route_json, null),
  routeFetchedAt: asNullableNumber(row.route_fetched_at),
  departAt: asNullableNumber(row.depart_at),
  arriveAt: asNullableNumber(row.arrive_at),
  dwellUntil: asNullableNumber(row.dwell_until),
  returnAt: asNullableNumber(row.return_at),
  retentionExpiresAt: asNullableNumber(row.retention_expires_at),
  dedupeKey: asString(row.dedupe_key),
  createdAt: asNumber(row.created_at),
  updatedAt: asNumber(row.updated_at),
});

/**
 * 幂等建行程：唯一索引 `(user_id, char_id, dedupe_key)` 是权威，
 * 第二次（重试 / 多设备重复提交）不改行、回同一行。
 * 主键被别的租户占住时**不覆盖**，直接抛（这是 id 生成出了 bug，不该静默）。
 */
export async function upsertTravelTrip(
  db: TravelDb,
  trip: TravelTripRecord,
): Promise<{ inserted: boolean; trip: TravelTripRecord }> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO travel_trips (${TRIP_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      trip.id,
      trip.userId,
      trip.charId,
      trip.status,
      trip.status,
      trip.planVersion,
      trip.revision,
      trip.coordSys,
      trip.provider,
      JSON.stringify(trip.origin),
      toJson(trip.dest),
      toJson(trip.route),
      trip.routeFetchedAt,
      trip.departAt,
      trip.arriveAt,
      trip.dwellUntil,
      trip.returnAt,
      trip.retentionExpiresAt,
      trip.dedupeKey,
      trip.createdAt,
      trip.updatedAt,
    )
    .run();
  const inserted = changesOf(result) === 1;

  const byDedupe = await db
    .prepare(`SELECT ${TRIP_COLUMNS} FROM travel_trips WHERE user_id = ? AND char_id = ? AND dedupe_key = ?`)
    .bind(trip.userId, trip.charId, trip.dedupeKey)
    .first();
  if (byDedupe) return { inserted, trip: readTripRow(byDedupe) };

  const byId = await db
    .prepare(`SELECT ${TRIP_COLUMNS} FROM travel_trips WHERE user_id = ? AND id = ?`)
    .bind(trip.userId, trip.id)
    .first();
  if (byId) return { inserted, trip: readTripRow(byId) };

  throw new Error(`travel_trips id ${trip.id} 已被其它租户占用（拒绝跨租户改写）`);
}

export async function getTravelTrip(
  db: TravelDb,
  args: { userId: string; tripId: string },
): Promise<TravelTripRecord | null> {
  const row = await db
    .prepare(`SELECT ${TRIP_COLUMNS} FROM travel_trips WHERE user_id = ? AND id = ?`)
    .bind(args.userId, args.tripId)
    .first();
  return row ? readTripRow(row) : null;
}

/** 该角色当前未终结的行程（B3 tick 用；终态返回 null）。 */
export async function getActiveTravelTrip(
  db: TravelDb,
  args: { userId: string; charId: string },
): Promise<TravelTripRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${TRIP_COLUMNS} FROM travel_trips
       WHERE user_id = ? AND char_id = ?
         AND status NOT IN (${TERMINAL_STATUS_SQL})
       ORDER BY plan_version DESC, updated_at DESC, id DESC
       LIMIT 1`,
    )
    .bind(args.userId, args.charId)
    .first();
  return row ? readTripRow(row) : null;
}

export interface TravelTripPatch {
  status?: TravelTripStatus;
  coordSys?: TravelCoordSys;
  provider?: TravelProviderId;
  origin?: TravelPlaceRef;
  dest?: TravelPlaceRef | null;
  route?: TravelRouteRecord | null;
  routeFetchedAt?: number | null;
  departAt?: number | null;
  arriveAt?: number | null;
  dwellUntil?: number | null;
  returnAt?: number | null;
  retentionExpiresAt?: number | null;
}

export type TravelTripCasResult =
  | { ok: true; trip: TravelTripRecord }
  | { ok: false; code: 'VERSION_CONFLICT' };

/**
 * 真 CAS：`baseRevision` 必须等于库里当前的 revision，`UPDATE ... WHERE revision = ?`
 * 拿 0 行就是冲突（被别的 tick / 设备抢先改了）。冲突时**不写任何字段**。
 *
 * 行不存在、或行属于别的租户，同样回 `VERSION_CONFLICT`：不区分是为了不泄露
 * 「这个 id 在别人那里存在」。
 */
export async function casUpdateTravelTrip(
  db: TravelDb,
  args: {
    userId: string;
    tripId: string;
    baseRevision: number;
    patch: TravelTripPatch;
    nowMs: number;
  },
): Promise<TravelTripCasResult> {
  const current = await getTravelTrip(db, { userId: args.userId, tripId: args.tripId });
  if (!current || current.revision !== args.baseRevision) {
    return { ok: false, code: 'VERSION_CONFLICT' };
  }

  const nextStatus = args.patch.status ?? current.status;
  const next: TravelTripRecord = {
    ...current,
    status: nextStatus,
    phase: nextStatus,
    coordSys: args.patch.coordSys ?? current.coordSys,
    provider: args.patch.provider ?? current.provider,
    origin: args.patch.origin ?? current.origin,
    dest: 'dest' in args.patch ? args.patch.dest ?? null : current.dest,
    route: 'route' in args.patch ? args.patch.route ?? null : current.route,
    routeFetchedAt:
      'routeFetchedAt' in args.patch ? args.patch.routeFetchedAt ?? null : current.routeFetchedAt,
    departAt: 'departAt' in args.patch ? args.patch.departAt ?? null : current.departAt,
    arriveAt: 'arriveAt' in args.patch ? args.patch.arriveAt ?? null : current.arriveAt,
    dwellUntil: 'dwellUntil' in args.patch ? args.patch.dwellUntil ?? null : current.dwellUntil,
    returnAt: 'returnAt' in args.patch ? args.patch.returnAt ?? null : current.returnAt,
    retentionExpiresAt:
      'retentionExpiresAt' in args.patch
        ? args.patch.retentionExpiresAt ?? null
        : current.retentionExpiresAt,
    revision: current.revision + 1,
    updatedAt: args.nowMs,
  };

  const result = await db
    .prepare(
      `UPDATE travel_trips
       SET status = ?, phase = ?, coord_sys = ?, provider = ?, origin_json = ?, dest_json = ?,
           route_json = ?, route_fetched_at = ?, depart_at = ?, arrive_at = ?, dwell_until = ?,
           return_at = ?, retention_expires_at = ?, revision = ?, updated_at = ?
       WHERE user_id = ? AND id = ? AND revision = ?`,
    )
    .bind(
      next.status,
      next.phase,
      next.coordSys,
      next.provider,
      JSON.stringify(next.origin),
      toJson(next.dest),
      toJson(next.route),
      next.routeFetchedAt,
      next.departAt,
      next.arriveAt,
      next.dwellUntil,
      next.returnAt,
      next.retentionExpiresAt,
      next.revision,
      next.updatedAt,
      next.userId,
      next.id,
      current.revision,
    )
    .run();
  if (changesOf(result) !== 1) return { ok: false, code: 'VERSION_CONFLICT' };
  return { ok: true, trip: next };
}

/* ------------------------------------------------------------------ *
 * trip events
 * ------------------------------------------------------------------ */

export interface TravelTripEventRecord {
  id: string;
  userId: string;
  tripId: string;
  seq: number;
  kind: string;
  at: number;
  payload: unknown;
  source: string;
  expiresAt: number;
}

const EVENT_COLUMNS = 'id, user_id, trip_id, seq, kind, at, payload_json, source, expires_at';

const readEventRow = (row: Record<string, unknown>): TravelTripEventRecord => ({
  id: asString(row.id),
  userId: asString(row.user_id),
  tripId: asString(row.trip_id),
  seq: asNumber(row.seq),
  kind: asString(row.kind),
  at: asNumber(row.at),
  payload: parseJson<unknown>(row.payload_json, null),
  source: asString(row.source),
  expiresAt: asNumber(row.expires_at),
});

/**
 * 追加一条事件。`seq` 由**同一条 INSERT ... SELECT** 算出来（`MAX(seq)+1`），
 * 单语句原子，不需要先查后插；`(user_id, trip_id, seq)` 唯一索引兜并发的重复 seq。
 * 调用方拿到 `VERSION_CONFLICT` 时就是撞了并发追加 —— 重试一次即可（事件是追加写，不丢语义）。
 */
export async function appendTravelTripEvent(
  db: TravelDb,
  args: {
    id?: string;
    userId: string;
    tripId: string;
    kind: string;
    at: number;
    payload?: unknown;
    source: string;
    nowMs: number;
    expiresAt: number;
  },
): Promise<TravelTripEventRecord> {
  const id = args.id ?? `${args.tripId}:${args.kind}:${args.at}:${Math.random().toString(36).slice(2, 10)}`;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await db
        .prepare(
          `INSERT INTO travel_trip_events (${EVENT_COLUMNS})
           SELECT ?, ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?
           FROM travel_trip_events WHERE user_id = ? AND trip_id = ?`,
        )
        .bind(
          id,
          args.userId,
          args.tripId,
          args.kind,
          args.at,
          toJson(args.payload ?? null),
          args.source,
          args.expiresAt,
          args.userId,
          args.tripId,
        )
        .run();
      lastError = null;
      break;
    } catch (error) {
      // 唯一索引 (user_id, trip_id, seq) 撞了：换一个 seq 再试（最多 3 次）。
      lastError = error;
    }
  }
  if (lastError) throw lastError;

  const row = await db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM travel_trip_events WHERE user_id = ? AND id = ?`)
    .bind(args.userId, id)
    .first();
  if (!row) throw new Error(`travel_trip_events 写入后读不回（${args.tripId}/${args.kind}）`);
  return readEventRow(row);
}

export async function listTripEvents(
  db: TravelDb,
  args: { userId: string; tripId: string; nowMs?: number },
): Promise<TravelTripEventRecord[]> {
  const whereNow = args.nowMs === undefined ? '' : ' AND expires_at > ?';
  const rows = await db
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM travel_trip_events
       WHERE user_id = ? AND trip_id = ?${whereNow}
       ORDER BY seq ASC`,
    )
    .bind(args.userId, args.tripId, ...(args.nowMs === undefined ? [] : [args.nowMs]))
    .all();
  return (rows.results ?? []).map(readEventRow);
}

/* ------------------------------------------------------------------ *
 * budget_state 的行形状（读写逻辑在 budget.ts，类型放这里让两边共用）
 * ------------------------------------------------------------------ */

/** 契约 `TravelBudgetState` + DDL 里的 `map_attempts_used` / `updated_at`。 */
export interface TravelBudgetRecord extends TravelBudgetState {
  /** 调用尝试数（含失败）：失败退 `map_calls_used` 但不退这个，重试风暴要看得见。 */
  mapAttemptsUsed: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ *
 * share
 * ------------------------------------------------------------------ */

export type ShareWriteResult =
  | { ok: true; state: TravelShareState & { updatedAt: number } }
  | { ok: false; code: 'VERSION_CONFLICT' };

export async function getTravelShareState(
  db: TravelDb,
  args: { userId: string; charId: string },
): Promise<(TravelShareState & { updatedAt: number }) | null> {
  const row = await db
    .prepare(
      'SELECT user_id, char_id, share_enabled, version, updated_at FROM travel_share_state WHERE user_id = ? AND char_id = ?',
    )
    .bind(args.userId, args.charId)
    .first();
  if (!row) return null;
  return {
    userId: asString(row.user_id),
    charId: asString(row.char_id),
    shareEnabled: asBool(row.share_enabled),
    version: asNumber(row.version),
    updatedAt: asNumber(row.updated_at),
  };
}

/**
 * 开关共享位（服务端权威）。带版本 CAS：撤销共享必须是「我知道现在是第几版」的写，
 * 否则两台设备的旧面板会互相翻回去。**不碰 trip**：共享与出行是两条独立的态。
 */
export async function setTravelShareState(
  db: TravelDb,
  args: {
    userId: string;
    charId: string;
    shareEnabled: boolean;
    baseVersion: number | null;
    nowMs: number;
  },
): Promise<ShareWriteResult> {
  const current = await getTravelShareState(db, { userId: args.userId, charId: args.charId });
  const flag = args.shareEnabled ? 1 : 0;

  if (!current) {
    if (args.baseVersion !== null) return { ok: false, code: 'VERSION_CONFLICT' };
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO travel_share_state (user_id, char_id, share_enabled, version, updated_at)
         VALUES (?, ?, ?, 1, ?)`,
      )
      .bind(args.userId, args.charId, flag, args.nowMs)
      .run();
    if (changesOf(result) !== 1) return { ok: false, code: 'VERSION_CONFLICT' };
    return {
      ok: true,
      state: {
        userId: args.userId,
        charId: args.charId,
        shareEnabled: args.shareEnabled,
        version: 1,
        updatedAt: args.nowMs,
      },
    };
  }

  if (args.baseVersion !== current.version) return { ok: false, code: 'VERSION_CONFLICT' };
  const nextVersion = current.version + 1;
  const result = await db
    .prepare(
      `UPDATE travel_share_state SET share_enabled = ?, version = ?, updated_at = ?
       WHERE user_id = ? AND char_id = ? AND version = ?`,
    )
    .bind(flag, nextVersion, args.nowMs, args.userId, args.charId, current.version)
    .run();
  if (changesOf(result) !== 1) return { ok: false, code: 'VERSION_CONFLICT' };
  return {
    ok: true,
    state: {
      userId: args.userId,
      charId: args.charId,
      shareEnabled: args.shareEnabled,
      version: nextVersion,
      updatedAt: args.nowMs,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 保留期清理
 * ------------------------------------------------------------------ */

export interface TravelPruneCounts {
  trips: number;
  events: number;
  candidates: number;
  wishes: number;
}

/**
 * 保留期清理（append-only ≠ 永久保留）。
 * - 行程：只删 `retention_expires_at` 已过的（NULL = 在途，永不删）；
 * - 事件 / 候选：按 `expires_at`；
 * - 愿望：只删已结束（dropped / expired / completed）且过期的。
 * 传 `userId` 就只清这个租户（前端/单账号 tick），不传给 cron 做全局清扫。
 */
export async function pruneTravelRetention(
  db: TravelDb,
  args: { nowMs: number; userId?: string },
): Promise<TravelPruneCounts> {
  const scoped = typeof args.userId === 'string' && args.userId.length > 0;
  const tenant = (column = 'user_id') => (scoped ? ` AND ${column} = ?` : '');
  const tenantParams = scoped ? [args.userId] : [];

  const trips = await db
    .prepare(
      `DELETE FROM travel_trips WHERE retention_expires_at IS NOT NULL AND retention_expires_at <= ?${tenant()}`,
    )
    .bind(args.nowMs, ...tenantParams)
    .run();
  const events = await db
    .prepare(`DELETE FROM travel_trip_events WHERE expires_at <= ?${tenant()}`)
    .bind(args.nowMs, ...tenantParams)
    .run();
  const candidates = await db
    .prepare(`DELETE FROM travel_candidates WHERE expires_at <= ?${tenant()}`)
    .bind(args.nowMs, ...tenantParams)
    .run();
  const wishes = await db
    .prepare(
      `DELETE FROM travel_wishes
       WHERE state IN ('dropped', 'expired', 'completed') AND expires_at IS NOT NULL AND expires_at <= ?${tenant()}`,
    )
    .bind(args.nowMs, ...tenantParams)
    .run();

  return {
    trips: changesOf(trips),
    events: changesOf(events),
    candidates: changesOf(candidates),
    wishes: changesOf(wishes),
  };
}

/* ------------------------------------------------------------------ *
 * 角色级开关（总开关之外的第二道闸）
 * ------------------------------------------------------------------ */

export interface TravelCharSettings {
  userId: string;
  charId: string;
  enabled: boolean;
  updatedAt: number;
}

export async function getTravelCharSettings(
  db: TravelDb,
  args: { userId: string; charId: string },
): Promise<TravelCharSettings | null> {
  const row = await db
    .prepare('SELECT user_id, char_id, enabled, updated_at FROM travel_char_settings WHERE user_id = ? AND char_id = ?')
    .bind(args.userId, args.charId)
    .first();
  if (!row) return null;
  return {
    userId: asString(row.user_id),
    charId: asString(row.char_id),
    enabled: asBool(row.enabled),
    updatedAt: asNumber(row.updated_at),
  };
}

/**
 * 角色级启用位。**缺行 = 未启用**（不默认开启），也不因为账号总开关打开就顺带打开。
 * 无 CAS：这是单值开关，last-write-wins 不会像暂停那样被误解除（暂停在 budget 里另有 CAS）。
 */
export async function setTravelCharEnabled(
  db: TravelDb,
  args: { userId: string; charId: string; enabled: boolean; nowMs: number },
): Promise<TravelCharSettings> {
  await db
    .prepare(
      `INSERT INTO travel_char_settings (user_id, char_id, enabled, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, char_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    )
    .bind(args.userId, args.charId, args.enabled ? 1 : 0, args.nowMs)
    .run();
  return {
    userId: args.userId,
    charId: args.charId,
    enabled: args.enabled === true,
    updatedAt: args.nowMs,
  };
}

/* ------------------------------------------------------------------ *
 * 固定地点（锚点）——坐标只在服务端，读出去时剥掉
 * ------------------------------------------------------------------ */

export interface TravelAnchorRecord {
  userId: string;
  charId: string;
  label: string;
  city: string;
  district?: string | null;
  lat: number;
  lng: number;
  coordSys: string;
  precision: 'area';
  confirmedAt: number;
  updatedAt: number;
}

export async function getTravelAnchor(
  db: TravelDb,
  args: { userId: string; charId: string },
): Promise<TravelAnchorRecord | null> {
  const row = await db
    .prepare(
      'SELECT user_id, char_id, label, city, district, lat, lng, coord_sys, precision, confirmed_at, updated_at ' +
        'FROM travel_anchors WHERE user_id = ? AND char_id = ?',
    )
    .bind(args.userId, args.charId)
    .first();
  if (!row) return null;
  const lat = asNumber(row.lat);
  const lng = asNumber(row.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    userId: asString(row.user_id),
    charId: asString(row.char_id),
    label: asString(row.label),
    city: asString(row.city),
    district: asString(row.district) || null,
    lat,
    lng,
    coordSys: asString(row.coord_sys) || 'gcj02',
    precision: 'area',
    confirmedAt: asNumber(row.confirmed_at),
    updatedAt: asNumber(row.updated_at),
  };
}

export async function putTravelAnchor(
  db: TravelDb,
  record: TravelAnchorRecord,
): Promise<TravelAnchorRecord> {
  await db
    .prepare(
      `INSERT INTO travel_anchors (user_id, char_id, label, city, district, lat, lng, coord_sys, precision, confirmed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'area', ?, ?)
       ON CONFLICT(user_id, char_id) DO UPDATE SET
         label = excluded.label, city = excluded.city, district = excluded.district,
         lat = excluded.lat, lng = excluded.lng, coord_sys = excluded.coord_sys,
         confirmed_at = excluded.confirmed_at, updated_at = excluded.updated_at`,
    )
    .bind(
      record.userId,
      record.charId,
      record.label,
      record.city,
      record.district ?? null,
      record.lat,
      record.lng,
      record.coordSys,
      record.confirmedAt,
      record.updatedAt,
    )
    .run();
  return record;
}

/* ------------------------------------------------------------------ *
 * 位置历史（只有取得几何许可时才写；读的时候按共享代际过滤）
 * ------------------------------------------------------------------ */

export interface TravelPositionRow {
  at: number;
  lat: number;
  lng: number;
  coordSys: string;
  shareGeneration: number;
}

/**
 * 追加一个采样点。`shareGeneration` 记下写入当时的共享版本号：共享重新开启时版本号 +1，
 * 于是上一代写下的点不会被当成「这次共享的轨迹」再放出去。
 */
export async function appendTravelPosition(
  db: TravelDb,
  args: {
    userId: string;
    tripId: string;
    at: number;
    lat: number;
    lng: number;
    coordSys: string;
    shareGeneration: number;
    nowMs: number;
  },
): Promise<void> {
  const id = `tp:${args.userId}:${args.tripId}:${args.at}:${Math.round(args.lat * 1e5)}:${Math.round(args.lng * 1e5)}`;
  await db
    .prepare(
      `INSERT OR IGNORE INTO travel_trip_positions
        (id, user_id, trip_id, at, lat, lng, coord_sys, share_generation, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      args.userId,
      args.tripId,
      args.at,
      args.lat,
      args.lng,
      args.coordSys,
      args.shareGeneration,
      args.nowMs,
    )
    .run();
}

/**
 * 读某趟行程的位置历史。`minShareGeneration` 给出「本次共享代际」的下界：
 * 共享关闭过再打开，旧代际的点一律不返回（不复活旧轨迹）。
 * 没有任何记录时返回空数组 —— 调用方必须如实呈现「没有轨迹」，不得用直线或插值补。
 */
export async function listTravelPositions(
  db: TravelDb,
  args: { userId: string; tripId: string; minShareGeneration?: number; limit?: number },
): Promise<TravelPositionRow[]> {
  const limit = Math.min(Math.max(Math.trunc(args.limit ?? 120), 1), 480);
  const minGen = Number.isFinite(args.minShareGeneration as number)
    ? Math.trunc(args.minShareGeneration as number)
    : 0;
  const rows = await db
    .prepare(
      `SELECT at, lat, lng, coord_sys, share_generation FROM travel_trip_positions
       WHERE user_id = ? AND trip_id = ? AND share_generation >= ?
       ORDER BY at ASC LIMIT ?`,
    )
    .bind(args.userId, args.tripId, minGen, limit)
    .all();
  const results = Array.isArray(rows?.results) ? rows.results : [];
  return results
    .map((row) => ({
      at: asNumber(row.at),
      lat: asNumber(row.lat),
      lng: asNumber(row.lng),
      coordSys: asString(row.coord_sys) || 'gcj02',
      shareGeneration: asNumber(row.share_generation),
    }))
    .filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng));
}

/* ------------------------------------------------------------------ *
 * 决策落库 / 重试（角色选中的候选是唯一权威）
 * ------------------------------------------------------------------ */

/** 记下模型选中的候选；不存在的行返回 false（调用方必须当失败处理）。 */
export async function setTravelWishSelectedCandidate(
  db: TravelDb,
  args: { userId: string; wishId: string; candidateId: string; nowMs: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      'UPDATE travel_wishes SET selected_candidate_id = ?, updated_at = ? WHERE user_id = ? AND id = ?',
    )
    .bind(args.candidateId, args.nowMs, args.userId, args.wishId)
    .run();
  return changesOf(result) === 1;
}

/**
 * 这趟愿望最近一代行程（含已终态的）。用来算下一代 `plan_version`：
 * 失败重试必须换 dedupe 键，否则 `(user,char,dedupe)` 唯一索引会把重试永远挡在门外。
 */
export async function getLatestTripForWish(
  db: TravelDb,
  args: { userId: string; charId: string; wishId: string },
): Promise<TravelTripRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${TRIP_COLUMNS} FROM travel_trips
       WHERE user_id = ? AND char_id = ? AND dedupe_key LIKE ?
       ORDER BY plan_version DESC LIMIT 1`,
    )
    .bind(args.userId, args.charId, `wish:${args.wishId}:plan:%`)
    .first();
  return row ? readTripRow(row) : null;
}
