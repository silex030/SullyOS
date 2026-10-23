/**
 * 出行 · HTTP 路由（集成版）
 *
 * 挂法（`worker/amsg/src/index.ts`，配置门之后、未知 fallback 之前）：
 *
 *   const travel = await handleTravelRequest(request, env, { resolveSession, ... });
 *   if (travel) return travel;
 *
 * 硬边界：
 * - **主体只从 `deps.resolveSession(token, request)` 来**（服务端签名的短期会话）。
 *   绝不读 `X-User-Id` 当身份、也不看请求体/查询串里的 userId。没有 token → 401。
 * - **没有任何「遥控角色」端点**：无法改目的地、改愿望、推进相位。写操作只有用户自己的
 *   设置类（总开关、角色启用、共享位、预算上限、时区/保留期、固定地点），全部 CAS 或
 *   单值显式。
 * - **共享关闭时公开读里行程整份为 null**（不出地名/时间/坐标/历史）；角色自己的上下文
 *   走 `/travel/context`（`buildRoleTravelContext`），它不依赖共享位、也**不含坐标**。
 * - `/travel/config` 与许可只读 env；请求体不能解锁合规。
 * - 端点命名与前端一致：`/travel/anchor`（单数，GET/POST）、`/travel/anchor/search`、
 *   `/travel/context`、`/travel/settings`、`/travel/char`、`/travel/budget`、`/travel/share`、
 *   `/travel/state`、`/travel/config`。路由用**后缀匹配**，挂在 `/amsg` 前缀下也能命中。
 */

import {
  TRAVEL_ERROR_CODES,
  type TravelCandidateView,
  type TravelErrorCode,
  type TravelPlaceRef,
  type TravelShareState,
} from '../../../../contracts/travel';
import {
  ensureTravelSchema,
  getActiveTravelTrip,
  getTravelAnchor,
  getTravelCharSettings,
  getTravelShareState,
  getTravelSettings,
  listTravelPositions,
  listTravelWishes,
  putTravelAnchor,
  setTravelCharEnabled,
  setTravelShareState,
  upsertTravelSettings,
  type TravelDb,
} from './store';
import { getTravelBudget, setTravelBudgetPaused, setTravelMapCallsLimit } from './budget';
import {
  buildRoleTravelContext,
  buildTravelSnapshot,
  resolveTravelLicenses,
  shareGenerationStartMs,
} from './state';
import { buildStaticMapUrl } from './staticmap';
import {
  getTravelMapCredentialStatus,
  resolveTravelMapCredentialValues,
  saveTravelMapCredentials,
  TRAVEL_MAP_CREDENTIAL_FIELDS,
  type SaveFailureCode,
  type TravelMapCredentialField,
  type TravelMapCredentialPatch,
} from './mapCredentials';
import { mintTravelMapServiceHost } from './mapProxy';

import { isTerminalStatus, pickAnchorFields, sanitizeAnchorLabel } from '../../../../utils/travel/core';

export interface TravelPrincipal {
  userId: string;
  /** 允许访问的角色集合；缺省 = 不限制（主体本身已经是账号级）。 */
  charIds?: readonly string[];
}

/** 会话解析失败（保留 401/403 的区分，不再一律折成 401）。 */
export interface TravelSessionFailure {
  ok: false;
  status: number;
  code: TravelErrorCode;
  detail?: string;
}

export interface TravelAnchorHit {
  placeId: string;
  label: string;
  city: string;
  district?: string;
}

export interface TravelAnchorSearchPort {
  /** 关键词检索公共地点；返回结构**没有坐标**，坐标留在 placeId 签名里。 */
  search(query: { q: string; city?: string; charId: string }): Promise<TravelAnchorHit[]>;
  /** 把（已验签的）placeId 解回坐标；null = 无效/过期。 */
  resolve(placeId: string): Promise<TravelPlaceRef | null>;
}

export interface TravelRouteDeps {
  /** **唯一**鉴权入口：token → 可信主体（或带状态码的失败）。返回 null = 无会话。 */
  resolveSession: (
    token: string,
    request?: Request,
  ) => Promise<TravelPrincipal | TravelSessionFailure | null>;
  now?: () => number;
  /**
   * 锚点检索 / placeId 解析。按 userId 构造：地图预算是一账号一本账，
   * 端口必须知道这次请求花的是谁的额度（不能共用一个匿名端口）。
   */
  anchorSearchFor?: ((userId: string) => TravelAnchorSearchPort | null | Promise<TravelAnchorSearchPort | null>) | null;
  /** 静态图签名钥；缺 → 不给缩略图 URL（组件文字降级），不伪造图片。 */
  staticMapSecret?: string;
  /** 地图代理短期会话签名钥（与 session secret 同源但域分隔）；缺 → 不回 serviceHost。 */
  mapProxySecret?: string;
  /** 「测试连接」的注入 fetch（测试用）；生产传 globalThis.fetch。 */
  mapTestFetch?: typeof globalThis.fetch;
  /** 「测试连接」的上游地址（测试注入；生产固定官方 restapi）。 */
  mapTestUpstreamBase?: string;
}

export interface TravelRouteEnv {
  DB?: unknown;
  [key: string]: unknown;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '600',
  Vary: 'Origin',
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });

const fail = (status: number, code: TravelErrorCode): Response => json(status, { error: { code } });

const ERROR_SET = new Set<string>(TRAVEL_ERROR_CODES as readonly string[]);

const readToken = (request: Request): string => {
  const raw = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1].trim() : '';
};

const readJsonBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  try {
    const text = await request.text();
    if (!text || text.length > 16_000) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const readString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const readNumberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const shareView = (
  row: (TravelShareState & { updatedAt: number }) | null,
  charId: string,
  userId: string,
): TravelShareState => ({
  userId,
  charId,
  shareEnabled: !!row?.shareEnabled,
  version: row?.version ?? 0,
});

const budgetViewOf = (budget: Awaited<ReturnType<typeof getTravelBudget>>) =>
  budget
    ? {
        userId: budget.userId,
        dayKey: budget.dayKey,
        mapCallsUsed: budget.mapCallsUsed,
        mapCallsLimit: budget.mapCallsLimit,
        llmTokensUsed: budget.llmTokensUsed,
        llmTokensLimit: budget.llmTokensLimit,
        paused: budget.paused,
        version: budget.version,
      }
    : null;

/** 锚点对外形状：**只有地名语义**，没有 lat/lng/address。 */
const anchorView = (row: Awaited<ReturnType<typeof getTravelAnchor>>) =>
  row
    ? {
        label: row.label,
        city: row.city,
        ...(row.district ? { district: row.district } : {}),
        precision: row.precision,
        confirmedAt: row.confirmedAt,
      }
    : null;

const isSessionFailure = (value: unknown): value is TravelSessionFailure =>
  !!value && typeof value === 'object' && (value as TravelSessionFailure).ok === false;

/** 「测试连接」30 秒冷却（显式点击才允许一次真实请求）。 */
const MAP_TEST_COOLDOWN_MS = 30_000;
const mapTestLastAt = new Map<string, number>();
/** 仅供单测重置，不进生产路径。 */
export const resetMapTestCooldownForTesting = (): void => {
  mapTestLastAt.clear();
};

const readMapMasterKey = (env: TravelRouteEnv | null | undefined): string => {
  const raw = (env as { AMSG_MASTER_KEY?: unknown } | null | undefined)?.AMSG_MASTER_KEY;
  return typeof raw === 'string' ? raw.trim() : '';
};

const readCredentialField = (value: unknown): string => (typeof value === 'string' ? value : '');

/** 凭据视图：**只**含存在性与公开展示 Key（Web 服务 Key / jscode 永不回前端）。 */
const mapCredentialView = async (args: {
  db: TravelDb;
  userId: string;
  masterKey: string;
  proxySecret?: string;
  nowMs: number;
}) => {
  const status = await getTravelMapCredentialStatus({
    db: args.db as never,
    userId: args.userId,
    masterKey: args.masterKey,
  });
  let serviceHost: string | null = null;
  let serviceHostExpiresAt: number | null = null;
  if (status.configured && status.has.amapJsKey && status.has.amapJsCode && args.proxySecret) {
    const minted = await mintTravelMapServiceHost({
      userId: args.userId,
      secret: args.proxySecret,
      nowMs: args.nowMs,
    });
    if (minted) {
      serviceHost = minted.serviceHost;
      serviceHostExpiresAt = minted.expiresAt;
    }
  }
  return {
    configured: status.configured,
    unreadable: status.unreadable,
    has: status.has,
    amapJsKey: status.amapJsKey,
    mapboxToken: status.mapboxToken,
    mapboxStyleUrl: status.mapboxStyleUrl,
    updatedAt: status.updatedAt,
    serviceHost,
    serviceHostExpiresAt,
  };
};

/** 路由入口。返回 null = 不是本层认的 `/travel/*`，调用方继续原有分支。 */
export async function handleTravelRequest(
  request: Request,
  env: TravelRouteEnv | null | undefined,
  deps: TravelRouteDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();
  if (!/\/travel\/(state|share|budget|settings|config|char|anchor|context)$/.test(pathname)
    && !/\/travel\/anchor\/search$/.test(pathname)
    && !/\/travel\/map\/credentials(\/test)?$/.test(pathname)) {
    return null;
  }

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const nowMs = (deps.now ?? (() => Date.now()))();
  const licenses = resolveTravelLicenses(env as Record<string, unknown> | null | undefined);
  const suffix = /\/travel\/([a-z/]+)$/.exec(pathname)?.[1] ?? '';
  const db = env?.DB as TravelDb | undefined;

  const token = readToken(request);
  if (!token) return fail(401, 'UNAUTHORIZED');

  let resolved: TravelPrincipal | TravelSessionFailure | null = null;
  try {
    resolved = await deps.resolveSession(token, request);
  } catch {
    resolved = null;
  }
  if (isSessionFailure(resolved)) {
    const code = ERROR_SET.has(resolved.code) ? resolved.code : 'UNAUTHORIZED';
    return json(resolved.status || 401, {
      error: { code, ...(resolved.detail ? { detail: resolved.detail } : {}) },
    });
  }
  if (!resolved || !resolved.userId) return fail(401, 'INVALID_CLIENT_TOKEN');
  const userId = resolved.userId;

  if (!db) return fail(503, 'PROVIDER_FAILED');

  const charAllowed = (charId: string): boolean => {
    if (!charId) return false;
    const allowed = resolved && !isSessionFailure(resolved) ? resolved.charIds : undefined;
    return !allowed || allowed.includes(charId);
  };

  try {
    await ensureTravelSchema(db);

    if (suffix === 'config' && method === 'GET') {
      const [budget, settings] = await Promise.all([
        getTravelBudget(db, { userId, nowMs }),
        getTravelSettings(db, userId),
      ]);
      return json(200, {
        serverNow: nowMs,
        licenses,
        /** 页面关着也能推进；推送订阅只是通知通道，不是前置条件。 */
        pushRequired: false,
        autonomous: true,
        enabled: settings?.enabled === true,
        budgetConfigured: !!budget,
        budget: budget
          ? {
              mapCallsUsed: budget.mapCallsUsed,
              mapCallsLimit: budget.mapCallsLimit,
              paused: budget.paused,
            }
          : null,
        retention: {
          tripDays: settings?.tripRetentionDays ?? 30,
          eventDays: settings?.eventRetentionDays ?? 7,
        },
      });
    }

    if (suffix === 'state' && method === 'GET') {
      const charId = readString(url.searchParams.get('charId'));
      if (!charId) return fail(400, 'UNAUTHORIZED');
      if (!charAllowed(charId)) return fail(403, 'PRINCIPAL_MISMATCH');

      const [shareRow, trip, budget] = await Promise.all([
        getTravelShareStateSafe(db, userId, charId),
        getActiveTravelTrip(db, { userId, charId }),
        getTravelBudget(db, { userId, nowMs }),
      ]);
      const share = shareView(shareRow, charId, userId);
      const shareEnabled = !!shareRow?.shareEnabled;

      // 历史只在本代共享内、且几何许可时取；没有真实采样就是空数组（不画假轨迹）。
      let history: { lat: number; lng: number }[] = [];
      if (shareEnabled && trip && licenses.geometryPersistence === 'allowed') {
        const rows = await listTravelPositions(db, {
          userId,
          tripId: trip.id,
          minShareGeneration: shareRow?.version ?? 0,
        });
        history = rows.map((row) => ({ lat: row.lat, lng: row.lng }));
      }

      const snapshot = buildTravelSnapshot({
        trip,
        share: shareRow ?? { shareEnabled: false, version: 0 },
        budget,
        nowMs,
        geometryPersistence: licenses.geometryPersistence,
        history,
      });

      // 聊天卡缩略图：同源短期签名 URL，只有共享开着 + 底图授权才给，拿不到就不给。
      let staticMapUrl: string | null = null;
      if (
        shareEnabled
        && licenses.basemapDisplay === 'licensed'
        && deps.staticMapSecret
        && trip
        && !isTerminalStatus(trip.status)
      ) {
        staticMapUrl = await buildStaticMapUrl({
          userId,
          charId,
          secret: deps.staticMapSecret,
          nowMs,
          width: 480,
          height: 240,
        });
      }

      return json(200, {
        snapshot,
        share,
        ...(staticMapUrl ? { staticMapUrl } : {}),
      });
    }

    if (suffix === 'share' && method === 'POST') {
      const body = await readJsonBody(request);
      if (!body) return fail(400, 'UNAUTHORIZED');
      const charId = readString(body.charId);
      if (!charAllowed(charId)) return fail(403, 'PRINCIPAL_MISMATCH');
      if (typeof body.shareEnabled !== 'boolean') return fail(400, 'UNAUTHORIZED');
      const baseVersion = readNumberOrNull(body.baseVersion);

      const result = await setTravelShareState(db, {
        userId,
        charId,
        shareEnabled: body.shareEnabled,
        baseVersion,
        nowMs,
      });
      if (!result.ok) return fail(409, 'VERSION_CONFLICT');
      return json(200, { share: shareView(result.state, charId, userId) });
    }

    if (suffix === 'budget' && method === 'GET') {
      const budget = await getTravelBudget(db, { userId, nowMs });
      if (!budget) return fail(404, 'BUDGET_BLOCKED');
      return json(200, { budget: budgetViewOf(budget) });
    }

    if (suffix === 'budget' && method === 'PUT') {
      const body = await readJsonBody(request);
      if (!body) return fail(400, 'UNAUTHORIZED');
      if (body.paused !== undefined) {
        if (typeof body.paused !== 'boolean') return fail(400, 'UNAUTHORIZED');
        await setTravelBudgetPaused(db, { userId, paused: body.paused, nowMs });
      }
      if (body.mapCallsLimit !== undefined) {
        const limit = readNumberOrNull(body.mapCallsLimit);
        if (limit === null) return fail(400, 'UNAUTHORIZED');
        const result = await setTravelMapCallsLimit(db, { userId, limit, nowMs });
        if (!result.ok) return fail(400, 'BUDGET_ZERO');
      }
      const budget = await getTravelBudget(db, { userId, nowMs });
      if (!budget) return fail(404, 'BUDGET_BLOCKED');
      return json(200, { budget: budgetViewOf(budget) });
    }

    if (suffix === 'settings' && method === 'GET') {
      const settings = await getTravelSettings(db, userId);
      return json(200, {
        // 缺行 = 未开启（不回默认正数，也不假装已确认）。
        settings: settings
          ? {
              userId: settings.userId,
              enabled: settings.enabled,
              budgetTz: settings.budgetTz,
              tripRetentionDays: settings.tripRetentionDays,
              eventRetentionDays: settings.eventRetentionDays,
              version: settings.version,
              updatedAt: settings.updatedAt,
            }
          : null,
        licenses,
      });
    }

    if (suffix === 'settings' && method === 'PUT') {
      const body = await readJsonBody(request);
      if (!body) return fail(400, 'UNAUTHORIZED');
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return fail(400, 'UNAUTHORIZED');
      // 合规许可是运维 env，不接受请求体里的任何「解锁」字段。
      if (body.geometryPersistence !== undefined || body.basemapDisplay !== undefined) {
        return fail(400, 'GEOMETRY_NOT_LICENSED');
      }
      const baseVersion = readNumberOrNull(body.baseVersion);
      const result = await upsertTravelSettings(db, {
        userId,
        nowMs,
        baseVersion,
        // 时区与保留期**不再接受用户输入**：账号预算固定用账号时区（服务端已有值或默认），
        // 保留策略由服务端按用途/终态/共享代际 bounded prune。字段仍保留在读取响应里
        // 以兼容旧客户端，但写请求里的这些字段会被忽略（不是报错）。
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      });
      if (!result.ok) return fail(409, 'VERSION_CONFLICT');
      return json(200, {
        settings: {
          userId: result.settings.userId,
          enabled: result.settings.enabled,
          budgetTz: result.settings.budgetTz,
          tripRetentionDays: result.settings.tripRetentionDays,
          eventRetentionDays: result.settings.eventRetentionDays,
          version: result.settings.version,
          updatedAt: result.settings.updatedAt,
        },
      });
    }

    // 地图服务凭据：用户自己填，服务端按主体加密保存。保存本身不发任何收费请求。
    if (suffix === 'map/credentials' && method === 'GET') {
      return json(200, await mapCredentialView({
        db,
        userId,
        masterKey: readMapMasterKey(env),
        proxySecret: deps.mapProxySecret,
        nowMs,
      }));
    }

    if (suffix === 'map/credentials' && method === 'PUT') {
      const body = await readJsonBody(request);
      if (!body) return fail(400, 'UNAUTHORIZED');
      const masterKey = readMapMasterKey(env);
      if (!masterKey) return fail(503, 'PROVIDER_FAILED');
      // 合规许可仍是运维 env：填 Key 不能顺手解锁几何落库。
      if (body.geometryPersistence !== undefined || body.basemapDisplay !== undefined || body.licensedGeometry !== undefined) {
        return fail(400, 'GEOMETRY_NOT_LICENSED');
      }
      const patch: TravelMapCredentialPatch = {};
      for (const field of TRAVEL_MAP_CREDENTIAL_FIELDS) {
        if (body[field] !== undefined) patch[field] = readCredentialField(body[field]);
      }
      const clear = Array.isArray(body.clear)
        ? body.clear.filter((item): item is TravelMapCredentialField =>
          typeof item === 'string' && (TRAVEL_MAP_CREDENTIAL_FIELDS as readonly string[]).includes(item))
        : [];
      const result = await saveTravelMapCredentials({
        db: db as never,
        userId,
        masterKey,
        patch,
        clear,
        nowMs,
      });
      if (!result.ok) {
        const status = result.code === 'UNAUTHORIZED' ? 401 : result.code === 'INVALID_FIELD' ? 400 : 409;
        return json(status, { error: { code: result.code satisfies SaveFailureCode } });
      }
      return json(200, await mapCredentialView({
        db,
        userId,
        masterKey,
        proxySecret: deps.mapProxySecret,
        nowMs,
      }));
    }

    // 显式「测试连接」：单次、有冷却、不扣自主出行预算；失败只回布尔与错误码。
    if (suffix === 'map/credentials/test' && method === 'POST') {
      const last = mapTestLastAt.get(userId) ?? 0;
      if (nowMs - last < MAP_TEST_COOLDOWN_MS) {
        return json(429, { ok: false, code: 'TOO_MANY_REQUESTS' });
      }
      mapTestLastAt.set(userId, nowMs);
      const credentials = await resolveTravelMapCredentialValues({
        db: db as never,
        userId,
        masterKey: readMapMasterKey(env),
      });
      const webKey = credentials?.amapWebKey ?? '';
      if (!webKey) return json(200, { ok: false, code: 'MAP_NOT_CONFIGURED' });

      const base = (deps.mapTestUpstreamBase ?? 'https://restapi.amap.com').replace(/\/+$/, '');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      let ok = false;
      let code = 'PROVIDER_FAILED';
      try {
        const params = new URLSearchParams({ address: '北京市', key: webKey });
        const res = await (deps.mapTestFetch ?? globalThis.fetch)(
          `${base}/v3/geocode/geo?${params.toString()}`,
          { method: 'GET', signal: controller.signal, headers: { Accept: 'application/json' } },
        );
        if (res.ok) {
          const body = await res.json().catch(() => null) as { status?: unknown; geocodes?: unknown } | null;
          ok = String(body?.status ?? '') === '1' && Array.isArray(body?.geocodes) && body.geocodes.length > 0;
          code = ok ? 'OK' : 'PROVIDER_FAILED';
        }
      } catch {
        ok = false;
        code = 'PROVIDER_FAILED';
      } finally {
        clearTimeout(timer);
      }
      return json(200, { ok, code });
    }

    if (suffix === 'char' && method === 'GET') {
      const charId = readString(url.searchParams.get('charId'));
      if (!charAllowed(charId)) return fail(403, 'PRINCIPAL_MISMATCH');
      const row = await getTravelCharSettings(db, { userId, charId });
      return json(200, { char: { charId, enabled: row?.enabled === true } });
    }

    if (suffix === 'char' && method === 'PUT') {
      const body = await readJsonBody(request);
      if (!body) return fail(400, 'UNAUTHORIZED');
      const charId = readString(body.charId);
      if (!charAllowed(charId)) return fail(403, 'PRINCIPAL_MISMATCH');
      if (typeof body.enabled !== 'boolean') return fail(400, 'UNAUTHORIZED');
      const row = await setTravelCharEnabled(db, { userId, charId, enabled: body.enabled, nowMs });
      return json(200, { char: { charId: row.charId, enabled: row.enabled, updatedAt: row.updatedAt } });
    }

    /**
     * 角色内部上下文：给聊天提示词用（**不是**公开共享读）。
     * - 不依赖共享开关（共享是给用户看的）；
     * - 只有地名语义与相位，**没有坐标**；
     * - 情绪/关系字段不存在，这里也不生成。
     */
    if (suffix === 'context' && method === 'GET') {
      const charId = readString(url.searchParams.get('charId'));
      if (!charId) return fail(400, 'UNAUTHORIZED');
      if (!charAllowed(charId)) return fail(403, 'PRINCIPAL_MISMATCH');
      const [trip, shareRow, budget, wishes] = await Promise.all([
        getActiveTravelTrip(db, { userId, charId }),
        getTravelShareStateSafe(db, userId, charId),
        getTravelBudget(db, { userId, nowMs }),
        listTravelWishes(db, { userId, charId, nowMs, states: ['open', 'candidates_ready', 'chosen'] }),
      ]);
      const role = buildRoleTravelContext({ trip, nowMs });
      return json(200, {
        serverNow: nowMs,
        shareEnabled: !!shareRow?.shareEnabled,
        shareKnown: shareRow !== null,
        trip: role.hasTrip
          ? {
              phase: role.phase,
              originLabel: role.originLabel,
              destinationLabel: role.destLabel,
              etaMinutes: role.etaMinutes,
              paused: budget?.paused === true,
            }
          : null,
        wishText: wishes[0]?.wishText ?? null,
        budget: budget
          ? { mapCallsUsed: budget.mapCallsUsed, mapCallsLimit: budget.mapCallsLimit, paused: budget.paused }
          : null,
      });
    }

    if (suffix === 'anchor/search' && method === 'GET') {
      // 搜索是账号级地点检索，不读某个角色的数据；带了 charId 就必须在这个主体名下。
      const scopedCharId = readString(url.searchParams.get('charId'));
      if (scopedCharId && !charAllowed(scopedCharId)) return fail(403, 'PRINCIPAL_MISMATCH');
      const charId = scopedCharId;
      const q = readString(url.searchParams.get('q'));
      if (q.length < 2) return json(200, { results: [] });
      const port = (await deps.anchorSearchFor?.(userId)) ?? null;
      if (!port) return json(200, { results: [], provider: 'unavailable' });
      // 高德文本检索是「城市内检索」，没有城市就不发请求（也不拿城市中心猜）。
      let city = readString(url.searchParams.get('city'));
      if (!city && charId) {
        const existing = await getTravelAnchor(db, { userId, charId });
        city = existing?.city ?? '';
      }
      if (!city) return json(200, { results: [], reason: 'city_required' });
      try {
        const results = await port.search({ q: q.slice(0, 40), ...(city ? { city } : {}), charId });
        return json(200, { results });
      } catch {
        // 上游失败不伪造候选：空结果 + 明确 reason。
        return json(200, { results: [], reason: 'provider_failed' });
      }
    }

    if (suffix === 'anchor' && method === 'GET') {
      const charId = readString(url.searchParams.get('charId'));
      if (!charAllowed(charId)) return fail(403, 'PRINCIPAL_MISMATCH');
      const row = await getTravelAnchor(db, { userId, charId });
      return json(200, { anchor: anchorView(row), configured: row !== null });
    }

    // 确认锚点是幂等 upsert，POST/PUT 都收（前端用 POST，运维脚本常用 PUT）。
    if (suffix === 'anchor' && (method === 'POST' || method === 'PUT')) {
      const body = await readJsonBody(request);
      if (!body) return fail(400, 'UNAUTHORIZED');
      const charId = readString(body.charId);
      if (!charAllowed(charId)) return fail(403, 'PRINCIPAL_MISMATCH');

      // 两条路径：前端只传不透明 placeId（服务端解析坐标），或显式 anchor 对象。
      let picked: ReturnType<typeof pickAnchorFields> = null;
      const placeId = readString(body.placeId);
      if (placeId) {
        const port = (await deps.anchorSearchFor?.(userId)) ?? null;
        if (!port) return fail(503, 'ANCHOR_NOT_CONFIRMED');
        const place = await port.resolve(placeId);
        if (!place) return fail(400, 'ANCHOR_NOT_CONFIRMED');
        picked = pickAnchorFields(
          {
            label: place.label,
            city: place.city,
            ...(place.district ? { district: place.district } : {}),
            lat: place.lat,
            lng: place.lng,
            ...(place.coordSys ? { coordSys: place.coordSys } : {}),
          },
          nowMs,
        );
      } else if (body.anchor && typeof body.anchor === 'object') {
        const anchorInput = body.anchor as Record<string, unknown>;
        const label = readString(anchorInput.label);
        // 住户级文本在这里再拦一次（前端拦是一道，服务端拦截是最终一道）。
        const labelCheck = sanitizeAnchorLabel(label);
        if (!labelCheck.ok) return fail(400, 'ANCHOR_NOT_CONFIRMED');
        picked = pickAnchorFields(
          {
            label,
            ...(typeof anchorInput.city === 'string' ? { city: anchorInput.city } : {}),
            ...(typeof anchorInput.district === 'string' ? { district: anchorInput.district } : {}),
            ...(typeof anchorInput.lat === 'number' ? { lat: anchorInput.lat } : {}),
            ...(typeof anchorInput.lng === 'number' ? { lng: anchorInput.lng } : {}),
            ...(typeof anchorInput.coordSys === 'string' ? { coordSys: anchorInput.coordSys } : {}),
          },
          nowMs,
        );
      }
      if (!picked) return fail(400, 'ANCHOR_NOT_CONFIRMED');

      const saved = await putTravelAnchor(db, {
        userId,
        charId,
        label: picked.label,
        city: picked.city,
        ...(picked.district ? { district: picked.district } : {}),
        lat: picked.lat,
        lng: picked.lng,
        coordSys: picked.coordSys,
        precision: 'area',
        confirmedAt: picked.confirmedAt,
        updatedAt: nowMs,
      });
      return json(200, { anchor: anchorView(saved), configured: true });
    }

    return null;
  } catch {
    // 不把内部错误文本回给前端（可能带 SQL/上游细节）。
    return fail(500, 'PROVIDER_FAILED');
  }
}

/** 共享行读失败必须与「确实没有共享行」区分开（前者 fail-closed 但不谎称关闭）。 */
async function getTravelShareStateSafe(
  db: TravelDb,
  userId: string,
  charId: string,
): Promise<(TravelShareState & { updatedAt: number }) | null> {
  try {
    return await getTravelShareState(db, { userId, charId });
  } catch {
    return null;
  }
}

/** 供 index.ts 生成聊天卡缩略图以外的地方复用（例如未来推送）。 */
export { shareGenerationStartMs };
