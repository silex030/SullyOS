/**
 * 自主生活 v1 · HTTP 路由（挂在既有 amsg worker 上）
 *
 * 认证与归属（固定口径，不放宽）：
 *   1. `AMSG_SERVER_TOKEN` **必须配置**；请求必须带同值 `X-Client-Token`。没配置就直接
 *      503 —— 自主生活会签发执行许可、写用户数据，不能跑在「谁都能调」的默认档上。
 *   2. `X-User-Id` 只是**主体断言**（与 worker 其它端点同一信任级：单用户自部署 +
 *      共享口令）。ownerId 由它派生后立刻落到每个 SQL 的 `WHERE owner_id = ?`；
 *      请求体里的 ownerId / charId 一律不认。
 *   3. 角色归属：所有动作/状态/边界都按 (ownerId, charId) 取；动作行里的 charId 必须
 *      与本次路径/许可一致（引擎与执行器各校验一次）。
 *
 * 路由只做「解析 → 调 service → 回信封」，业务规则一律在 utils/autonomyLife/service.ts。
 */

import {
  AUTONOMY_LIFE_API_BASE,
  buildErrorBody,
  type ActivityKind,
} from '../../../../contracts/autonomyLife';
import type { CapabilityProbeState } from '../../../../utils/autonomyLife/adapters';
import { createAutonomyLifeRuntime, defaultCharacterBoundary, type AutonomyLifeRuntime } from './runtime';
import { ensureAutonomyLifeSchema, type LifeDb } from './store';
import {
  EXTERNAL_RESPONSE_FIELDS,
  consumeExternalQuota,
  handleExternalRead,
  insertTravelWish,
  isHostAllowed,
  parseAllowedHosts,
} from './external';
import { localDateKey } from '../../../../utils/autonomyLife/time';

export const AUTONOMY_LIFE_REQUIRED_TOKEN_ENV = 'AMSG_SERVER_TOKEN';

export interface AutonomyLifeRouteDeps {
  now: () => number;
  /** 从请求派生主体；null = 认证失败（路由回 401）。 */
  resolveOwner: (request: Request) => Promise<{ userId: string } | null>;
  /** 统一响应封装（index.ts 的 jsonWithCors：补 CORS 头）。 */
  respond: (status: number, body: unknown) => Response;
  /** 该角色是否有可用模型凭据（能力投影用；缺凭据 = 明确 unavailable，不假装能跑）。 */
  hasModelCredentials: (userId: string, charId: string) => Promise<boolean>;
  /** 该角色自己的时区（预算窗口/提示词）；缺省 UTC。 */
  timezoneFor?: (userId: string, charId: string) => Promise<string | null>;
  requestId?: () => string;
}

export interface AutonomyLifeEnv {
  DB: unknown;
  AMSG_SERVER_TOKEN?: string;
  /** 受控外部只读端点（运营配置；未配置 = 能力不可用，不用 fixture 冒充）。 */
  AUTONOMY_EXTERNAL_XHS_URL?: string;
  AUTONOMY_EXTERNAL_AMAP_URL?: string;
  /** 服务端出口主机白名单（逗号分隔，必须与用户 grant.allowedHosts 同时满足）。 */
  AUTONOMY_EXTERNAL_READ_HOSTS?: string;
}

interface RouteMatch {
  method: string;
  segments: string[];
  url: URL;
}

const matchRoute = (request: Request): RouteMatch | null => {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '');
  const index = pathname.indexOf(AUTONOMY_LIFE_API_BASE);
  if (index < 0) return null;
  const rest = pathname.slice(index + AUTONOMY_LIFE_API_BASE.length).replace(/^\/+/, '');
  return {
    method: request.method.toUpperCase(),
    segments: rest ? rest.split('/').map((part) => decodeURIComponent(part)) : [],
    url,
  };
};

const readJson = async (request: Request): Promise<Record<string, unknown> | null> => {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
};

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const num = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** 能力探测：本地 store 是否就绪只能由客户端报告；没报告就按不可用（fail closed）。 */
const probesFor = (args: { deviceBound: boolean; hasModelCredentials: boolean }): CapabilityProbeState => ({
  localStoresReady: args.deviceBound,
  deviceBound: args.deviceBound,
  hasModelCredentials: args.hasModelCredentials,
  externalRead: { configured: false, reachable: false },
  map: { configured: false, reachable: false },
});

/**
 * 处理 `/autonomy-life/v1/*`。不是本前缀 → 返回 null（交给后面的路由）。
 */
export async function handleAutonomyLifeRequest(
  request: Request,
  env: AutonomyLifeEnv,
  deps: AutonomyLifeRouteDeps,
): Promise<Response | null> {
  const match = matchRoute(request);
  if (!match) return null;

  const owner = await deps.resolveOwner(request);
  if (!owner) {
    return deps.respond(401, buildErrorBody('UNAUTHENTICATED', 'client_token_invalid_or_missing', {
      requestId: deps.requestId?.() ?? 'auth',
      serverTime: deps.now(),
    }));
  }

  const db = env.DB as unknown as LifeDb | undefined;
  if (!db || typeof db.prepare !== 'function') {
    return deps.respond(503, buildErrorBody('SERVICE_UNAVAILABLE', 'd1_binding_missing', {
      requestId: deps.requestId?.() ?? 'db',
      serverTime: deps.now(),
    }));
  }
  await ensureAutonomyLifeSchema(db);

  const [first, second, third] = match.segments;
  const nowMs = deps.now();

  const runtimeFor = async (charId: string): Promise<AutonomyLifeRuntime> => {
    const [bound, hasModel, tz] = await Promise.all([
      // 通过公开端口读绑定设备（store 的账号行是懒建的）
      createRuntimeDeviceProbe(db, owner.userId),
      deps.hasModelCredentials(owner.userId, charId).catch(() => false),
      deps.timezoneFor ? deps.timezoneFor(owner.userId, charId).catch(() => null) : Promise.resolve(null),
    ]);
    const runtime = createAutonomyLifeRuntime({
      db,
      userId: owner.userId,
      charId,
      now: deps.now,
      probes: probesFor({ deviceBound: bound, hasModelCredentials: hasModel }),
      timezone: tz ?? 'UTC',
      requestId: deps.requestId,
    });
    return runtime;
  };

  // ── GET /characters/:charId/state ───────────────────────────────────────
  if (match.method === 'GET' && first === 'characters' && second && third === 'state') {
    const charId = second;
    const runtime = await runtimeFor(charId);
    await registerCharacter(runtime, charId, nowMs);
    const result = await runtime.service.getState(charId);
    return deps.respond(result.status, result.body);
  }

  // ── GET|PATCH /boundaries ───────────────────────────────────────────────
  if (first === 'boundaries' && !second) {
    if (match.method === 'GET') {
      const charId = str(match.url.searchParams.get('charId')) || null;
      const runtime = await runtimeFor(charId ?? '');
      if (charId) await registerCharacter(runtime, charId, nowMs);
      const result = await runtime.service.getBoundaries(charId);
      return deps.respond(result.status, result.body);
    }
    if (match.method === 'PATCH') {
      const body = await readJson(request);
      if (!body) return deps.respond(400, buildErrorBody('VALIDATION_FAILED', 'body_required', { requestId: 'patch', serverTime: nowMs }));
      const scope = body.scope === 'character' ? 'character' : 'account';
      const charId = str(body.charId) || null;
      const runtime = await runtimeFor(charId ?? '');
      if (scope === 'character' && charId) await registerCharacter(runtime, charId, nowMs);
      const result = await runtime.service.patchBoundaries({
        scope,
        charId,
        expectedRevision: num(body.expectedRevision) ?? 0,
        changes: body.changes,
      });
      return deps.respond(result.status, result.body);
    }
    return deps.respond(405, buildErrorBody('VALIDATION_FAILED', 'method_not_allowed', { requestId: 'method', serverTime: nowMs }));
  }

  // ── POST /pause ─────────────────────────────────────────────────────────
  if (match.method === 'POST' && first === 'pause' && !second) {
    const body = await readJson(request);
    if (!body) return deps.respond(400, buildErrorBody('VALIDATION_FAILED', 'body_required', { requestId: 'pause', serverTime: nowMs }));
    const scope = body.scope === 'character' ? 'character' : 'account';
    const charId = str(body.charId) || null;
    const runtime = await runtimeFor(charId ?? '');
    if (scope === 'character' && charId) await registerCharacter(runtime, charId, nowMs);
    const result = await runtime.service.pause({
      scope,
      charId,
      paused: body.paused === true,
      expectedRevision: num(body.expectedRevision) ?? undefined,
    });
    return deps.respond(result.status, result.body);
  }

  // ── GET /activities ─────────────────────────────────────────────────────
  if (match.method === 'GET' && first === 'activities' && !second) {
    const charId = str(match.url.searchParams.get('charId'));
    if (!charId) return deps.respond(400, buildErrorBody('VALIDATION_FAILED', 'charId_required', { requestId: 'activities', serverTime: nowMs }));
    const runtime = await runtimeFor(charId);
    const result = await runtime.service.activities({
      charId,
      status: str(match.url.searchParams.get('status')) || null,
      limit: num(match.url.searchParams.get('limit')) ?? 20,
      cursor: str(match.url.searchParams.get('cursor')) || null,
    });
    return deps.respond(result.status, result.body);
  }

  // ── GET /events?after= ──────────────────────────────────────────────────
  if (match.method === 'GET' && first === 'events' && !second) {
    const after = Math.max(0, num(match.url.searchParams.get('after')) ?? 0);
    const runtime = await runtimeFor('');
    const events = await readEvents(db, owner.userId, after);
    const page = runtime.service.eventPage(events, after);
    return deps.respond(200, {
      schemaVersion: 1,
      requestId: deps.requestId?.() ?? 'events',
      serverTime: nowMs,
      ...page,
      resyncRequired: false,
    });
  }

  // ── POST /external/read | /external/wish（受控只读窗口）─────────────────
  if (match.method === 'POST' && first === 'external' && (second === 'read' || second === 'wish')) {
    const body = await readJson(request);
    if (!body) return deps.respond(400, buildErrorBody('VALIDATION_FAILED', 'body_required', { requestId: 'external', serverTime: nowMs }));
    const charId = str(body.charId);
    if (!charId) return deps.respond(400, buildErrorBody('VALIDATION_FAILED', 'charId_required', { requestId: 'external', serverTime: nowMs }));
    const runtime = await runtimeFor(charId);
    const effective = await runtime.boundaryFor(charId);
    const provider = second === 'read' ? 'xhs' : 'amap';
    const grant = effective.externalGrants.find((item) => item.provider === provider && item.expiresAt > nowMs);
    if (!grant) {
      return deps.respond(403, buildErrorBody('GRANT_REQUIRED', 'grant_missing_or_expired', { requestId: 'external', serverTime: nowMs }));
    }

    if (second === 'read') {
      if (grant.scopes.length > 0 && !grant.scopes.includes('read:search')) {
        return deps.respond(403, buildErrorBody('POLICY_DENIED', 'scope_not_granted', { requestId: 'external', serverTime: nowMs }));
      }
      const query = str(body.query);
      if (!query || query.length > 80) {
        return deps.respond(422, buildErrorBody('VALIDATION_FAILED', 'query_invalid', { requestId: 'external', serverTime: nowMs }));
      }
      const requested = Array.isArray(body.fields)
        ? (body.fields as unknown[]).filter((item): item is string => typeof item === 'string')
        : [];
      const fields = (requested.length ? requested : [...EXTERNAL_RESPONSE_FIELDS[provider].slice(0, 4)])
        .filter((field) => (EXTERNAL_RESPONSE_FIELDS[provider] as readonly string[]).includes(field));
      if (fields.length === 0) {
        return deps.respond(422, buildErrorBody('VALIDATION_FAILED', 'fields_not_allowed', { requestId: 'external', serverTime: nowMs }));
      }
      const quotaOk = await consumeExternalQuota({
        db,
        ownerId: owner.userId,
        dayKey: localDateKey(nowMs, effective.timezone),
        provider,
        limit: grant.dailyQuota,
        nowMs,
      });
      if (!quotaOk) {
        return deps.respond(429, buildErrorBody('RATE_LIMITED', 'external_daily_quota_exhausted', { requestId: 'external', serverTime: nowMs }));
      }
      const endpoint = provider === 'xhs' ? env.AUTONOMY_EXTERNAL_XHS_URL : env.AUTONOMY_EXTERNAL_AMAP_URL;
      const envHosts = parseAllowedHosts(env.AUTONOMY_EXTERNAL_READ_HOSTS);
      // 两把锁同时成立才发请求：运营白名单 ∩ 用户授权的主机。
      const allowedHosts = envHosts.filter((host) => isHostAllowed(host, grant.allowedHosts));
      const read = await handleExternalRead({
        provider,
        query,
        fields,
        endpoint: endpoint ?? null,
        allowedHosts,
        nowMs,
      });
      if (!read.ok) {
        return deps.respond(read.code === 'POLICY_DENIED' ? 403 : 503, buildErrorBody(read.code, read.reason, { requestId: 'external', serverTime: nowMs }));
      }
      return deps.respond(200, {
        schemaVersion: 1,
        requestId: deps.requestId?.() ?? 'external',
        serverTime: nowMs,
        provider,
        fields,
        items: read.result.items,
        fetchedAt: read.result.fetchedAt,
      });
    }

    const text = str(body.text ?? body.wish);
    if (!text || text.length > 200) {
      return deps.respond(422, buildErrorBody('VALIDATION_FAILED', 'wish_invalid', { requestId: 'external', serverTime: nowMs }));
    }
    const wish = await insertTravelWish({ db, ownerId: owner.userId, charId, text, grantId: `${grant.provider}:${grant.expiresAt}`, nowMs });
    return deps.respond(200, {
      schemaVersion: 1,
      requestId: deps.requestId?.() ?? 'external',
      serverTime: nowMs,
      wishId: wish.wishId,
    });
  }

  // ── POST /devices/register ──────────────────────────────────────────────
  if (match.method === 'POST' && first === 'devices' && second === 'register') {
    const body = await readJson(request);
    if (!body) return deps.respond(400, buildErrorBody('VALIDATION_FAILED', 'body_required', { requestId: 'device', serverTime: nowMs }));
    const runtime = await runtimeFor('');
    const result = await runtime.service.registerDevice({
      installationId: str(body.installationId),
      capabilitiesVersion: str(body.capabilitiesVersion) || undefined,
    });
    return deps.respond(result.status, result.body);
  }

  // ── POST /execution/claim ───────────────────────────────────────────────
  if (match.method === 'POST' && first === 'execution' && second === 'claim') {
    const body = await readJson(request);
    if (!body) return deps.respond(400, buildErrorBody('VALIDATION_FAILED', 'body_required', { requestId: 'claim', serverTime: nowMs }));
    const charId = str(body.charId);
    const installationId = str(body.installationId);
    if (!charId || !installationId) {
      return deps.respond(400, buildErrorBody('VALIDATION_FAILED', 'charId_and_installationId_required', { requestId: 'claim', serverTime: nowMs }));
    }
    const runtime = await runtimeFor(charId);
    const result = await runtime.service.claim({ installationId, charId, leaseMs: num(body.leaseMs) ?? undefined });
    return deps.respond(result.status, result.body);
  }

  // ── POST /actions/:id/cancel|commit-permit|receipt ──────────────────────
  if (match.method === 'POST' && first === 'actions' && second && third) {
    const actionId = second;
    const body = await readJson(request);
    if (!body) return deps.respond(400, buildErrorBody('VALIDATION_FAILED', 'body_required', { requestId: 'action', serverTime: nowMs }));
    const runtime = await runtimeFor('');

    if (third === 'cancel') {
      const result = await runtime.service.cancel({ actionId, expectedRevision: num(body.expectedRevision) ?? 0 });
      return deps.respond(result.status, result.body);
    }
    if (third === 'commit-permit') {
      const result = await runtime.service.commitPermit({
        actionId,
        installationId: str(body.installationId),
        leaseEpoch: num(body.leaseEpoch) ?? -1,
        argsHash: str(body.argsHash),
        policyVersion: str(body.policyVersion),
      });
      return deps.respond(result.status, result.body);
    }
    if (third === 'receipt') {
      const status = body.status;
      if (status !== 'succeeded' && status !== 'failed' && status !== 'unknown') {
        return deps.respond(400, buildErrorBody('VALIDATION_FAILED', 'bad_receipt_status', { requestId: 'receipt', serverTime: nowMs }));
      }
      const result = await runtime.service.receipt({
        actionId,
        installationId: str(body.installationId),
        leaseEpoch: num(body.leaseEpoch) ?? -1,
        argsHash: str(body.argsHash),
        status,
        resultRef: typeof body.resultRef === 'string' ? body.resultRef : null,
        errorCode: typeof body.errorCode === 'string' ? (body.errorCode as never) : undefined,
      });
      return deps.respond(result.status, result.body);
    }
  }

  return deps.respond(404, buildErrorBody('NOT_FOUND', 'autonomy_life_route_not_found', {
    requestId: deps.requestId?.() ?? 'route',
    serverTime: nowMs,
  }));
}

/** 首个请求即登记角色（只建一行全 null 的角色边界：继承账号层，不扩权）。 */
async function registerCharacter(runtime: AutonomyLifeRuntime, charId: string, nowMs: number): Promise<void> {
  if (!charId) return;
  const existing = await runtime.boundaries.getCharacter(charId);
  if (existing) return;
  await runtime.boundaries.put({ scope: 'character', charId }, defaultCharacterBoundary(nowMs), 0);
}

async function createRuntimeDeviceProbe(db: LifeDb, userId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT bound_installation_id FROM autonomy_life_accounts WHERE owner_id = ?')
    .bind(userId)
    .first()
    .catch(() => null);
  return typeof row?.bound_installation_id === 'string' && row.bound_installation_id.length > 0;
}

async function readEvents(db: LifeDb, userId: string, after: number): Promise<import('../../../../contracts/autonomyLife').LifeEvent[]> {
  const result = await db
    .prepare('SELECT payload FROM autonomy_life_events WHERE owner_id = ? AND seq > ? ORDER BY seq ASC LIMIT 100')
    .bind(userId, after)
    .all();
  return (result?.results ?? [])
    .map((row) => {
      try {
        return JSON.parse(String(row.payload)) as import('../../../../contracts/autonomyLife').LifeEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is import('../../../../contracts/autonomyLife').LifeEvent => !!event);
}

/**
 * 定长比较：先各自 SHA-256 再逐字节比，避免长度/前缀差异从耗时上泄露口令。
 * 没有 crypto.subtle 的环境（Node 测试）退回字节比较——测试不承担时序安全。
 */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return a === b;
  const encoder = new TextEncoder();
  const [da, db] = await Promise.all([
    subtle.digest('SHA-256', encoder.encode(a)),
    subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  if (va.length !== vb.length) return false;
  let diff = 0;
  for (let index = 0; index < va.length; index += 1) diff |= va[index] ^ vb[index];
  return diff === 0;
}

/** 供 index.ts：把 AMSG_SERVER_TOKEN 校验 + X-User-Id 断言收敛成 resolver。 */
export async function resolveOwnerFromSharedToken(
  request: Request,
  env: AutonomyLifeEnv,
): Promise<{ userId: string } | null> {
  const expected = str(env.AMSG_SERVER_TOKEN);
  if (!expected) return null;
  const token = request.headers.get('X-Client-Token') ?? '';
  if (!token || !(await safeEqual(token, expected))) return null;
  const userId = str(request.headers.get('X-User-Id'));
  if (!userId) return null;
  return { userId };
}

export type { ActivityKind };
