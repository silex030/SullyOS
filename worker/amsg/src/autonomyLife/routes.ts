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
import { boundaryGate } from '../../../../utils/autonomyLife/boundary';
import { verifyReservationHold, windowIdAt } from '../../../../utils/autonomyLife/budget';
import { checkIntentPolicy } from '../../../../utils/autonomyLife/policy';
import { hashArgs } from '../../../../contracts/autonomyLife';
import type { ActionRow } from '../../../../utils/autonomyLife/engine';
import { createAutonomyLifeRuntime, defaultCharacterBoundary, type AutonomyLifeRuntime } from './runtime';
import { ensureAutonomyLifeSchema, type LifeDb } from './store';
import {
  EXTERNAL_RESPONSE_FIELDS,
  handleExternalRead,
  insertTravelWish,
  isHostAllowed,
  parseAllowedHosts,
} from './external';
import { localDateKey } from '../../../../utils/autonomyLife/time';
import { consumeExternalPermitAtomic, consumeExternalQuotaAtomic } from './store';

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
  // 这是**唯一的出网/落库副作用入口**：必须绑定一个已 claim、已签一次性许可的动作。
  // 只带 grant 的裸调用一律拒（以前就是这条绕过线）。
  if (match.method === 'POST' && first === 'external' && (second === 'read' || second === 'wish')) {
    const body = await readJson(request);
    if (!body) return deps.respond(400, buildErrorBody('VALIDATION_FAILED', 'body_required', { requestId: 'external', serverTime: nowMs }));
    return handleExternalWindowAction({
      db,
      env,
      deps,
      ownerId: owner.userId,
      mode: second,
      body,
      nowMs,
      runtimeFor,
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


/** 外部窗口动作 ↔ provider / kind 的固定映射（请求体不能改）。 */
const EXTERNAL_MODE = {
  read: { kind: 'external.read' as const, provider: 'xhs' as const },
  wish: { kind: 'travel.wish' as const, provider: 'amap' as const },
} as const;

type ExternalMode = keyof typeof EXTERNAL_MODE;

const isExternalMode = (value: string | undefined): value is ExternalMode => value === 'read' || value === 'wish';

/**
 * 受控外部窗口：服务端唯一副作用入口。
 *
 * 旧实现只校验 grant，于是任何人都能直接 POST /external/read 出网、/external/wish 落愿望。
 * 现在请求必须带「已 claim 动作 + 已签发一次性许可」的完整绑定，并且在**出网/落库之前**
 * 逐层校验：动作归属与终态、设备/租约/epoch、argsHash 与动作参数、nonce、当前生效边界
 * （暂停/开关/角色禁用/allowedKinds）、授权与到期、请求参数必须等于被批准的参数、
 * 预算窗口与预留依据、每日配额；最后用一条条件 UPDATE 在服务端核销许可（重放不会再
 * 出网或落第二行）。
 */
async function handleExternalWindowAction(args: {
  db: LifeDb;
  env: AutonomyLifeEnv;
  deps: AutonomyLifeRouteDeps;
  ownerId: string;
  mode: string | undefined;
  body: Record<string, unknown>;
  nowMs: number;
  runtimeFor: (charId: string) => Promise<AutonomyLifeRuntime>;
}): Promise<Response> {
  const { db, deps, ownerId, body, nowMs, runtimeFor } = args;
  if (!isExternalMode(args.mode)) {
    return deps.respond(404, buildErrorBody('NOT_FOUND', 'external_route_not_found', { requestId: 'external', serverTime: nowMs }));
  }
  const mode = args.mode;
  const { kind, provider } = EXTERNAL_MODE[mode];

  const charId = str(body.charId);
  const actionId = str(body.actionId);
  const installationId = str(body.installationId);
  const leaseEpoch = num(body.leaseEpoch);
  const argsHash = str(body.argsHash);
  const nonce = str(body.nonce);
  if (!charId || !actionId || !installationId || leaseEpoch === null || !argsHash || !nonce) {
    return deps.respond(400, buildErrorBody('VALIDATION_FAILED', 'permit_binding_required', { requestId: 'external', serverTime: nowMs }));
  }
  if (body.provider !== undefined && str(body.provider) !== provider) {
    return deps.respond(422, buildErrorBody('VALIDATION_FAILED', 'provider_mismatch', { requestId: 'external', serverTime: nowMs }));
  }

  const runtime = await runtimeFor(charId);
  const action = await runtime.store.getAction(actionId);
  if (!action) {
    return deps.respond(404, buildErrorBody('NOT_FOUND', 'action_not_found', { requestId: 'external', serverTime: nowMs }));
  }
  const conflict = (reason: string, code: 'FORBIDDEN' | 'STATE_CONFLICT' = 'STATE_CONFLICT') =>
    deps.respond(code === 'FORBIDDEN' ? 403 : 409, buildErrorBody(code, reason, { requestId: 'external', serverTime: nowMs }));

  // 动作归属与执行状态：必须是这个角色、这个 kind、已领到、已签许可、未消费、未过期。
  if (action.charId !== charId || action.kind !== kind) return conflict('action_scope_mismatch', 'FORBIDDEN');
  if (!action.installationId || action.installationId !== installationId) return conflict('device_mismatch', 'FORBIDDEN');
  if (action.status !== 'running' || action.permitIssuedAt === null) return conflict('action_not_permitted');
  if (action.permitConsumedAt !== null) return conflict('permit_consumed');
  if (action.leaseEpoch !== leaseEpoch) return conflict('lease_epoch_mismatch');
  if (action.leaseExpiresAt === null || nowMs > action.leaseExpiresAt) return conflict('permit_expired');
  if (!action.permitNonce || action.permitNonce !== nonce) return conflict('permit_nonce_mismatch');
  if (action.argsHash !== argsHash || hashArgs(action.args) !== argsHash) return conflict('args_hash_mismatch');

  // 当前生效边界（现读）：暂停/关总开关/角色禁用/kind 白名单都算拒绝。
  const effective = await runtime.boundaryFor(charId);
  if (effective.globalPaused || effective.enabled === false) {
    return deps.respond(409, buildErrorBody('GLOBAL_PAUSED', 'paused', { requestId: 'external', serverTime: nowMs }));
  }
  if (effective.charEnabled === false) {
    return deps.respond(403, buildErrorBody('CHAR_DISABLED', 'character_disabled', { requestId: 'external', serverTime: nowMs }));
  }
  const gate = boundaryGate(effective, kind);
  if (!gate.ok) return deps.respond(403, buildErrorBody(gate.code, 'kind_not_allowed', { requestId: 'external', serverTime: nowMs }));

  const grant = effective.externalGrants.find((item) => item.provider === provider && item.expiresAt > nowMs);
  if (!grant) {
    return deps.respond(403, buildErrorBody('GRANT_REQUIRED', 'grant_missing_or_expired', { requestId: 'external', serverTime: nowMs }));
  }
  if (mode === 'read' && grant.scopes.length > 0 && !grant.scopes.includes('read:search')) {
    return deps.respond(403, buildErrorBody('POLICY_DENIED', 'scope_not_granted', { requestId: 'external', serverTime: nowMs }));
  }

  // 请求参数必须**就是**被批准的那一组（不能拿一个许可换 query/正文）。
  let query = '';
  let fields: string[] = [];
  let wishText = '';
  if (mode === 'read') {
    query = str(body.query);
    const approved = String((action.args as Record<string, unknown>).query ?? '').trim();
    if (!query || query !== approved) {
      return deps.respond(422, buildErrorBody('VALIDATION_FAILED', 'query_not_approved', { requestId: 'external', serverTime: nowMs }));
    }
    const approvedFields = Array.isArray((action.args as Record<string, unknown>).fields)
      ? ((action.args as Record<string, unknown>).fields as unknown[]).filter((item): item is string => typeof item === 'string')
      : [];
    const requested = Array.isArray(body.fields)
      ? (body.fields as unknown[]).filter((item): item is string => typeof item === 'string')
      : [];
    const source = requested.length ? requested : (approvedFields.length
      ? approvedFields
      : [...EXTERNAL_RESPONSE_FIELDS[provider].slice(0, 4)]);
    fields = source.filter((field) => (EXTERNAL_RESPONSE_FIELDS[provider] as readonly string[]).includes(field));
    // 只能在被批准字段范围内取子集；越界字段直接拒（不是悄悄丢掉）。
    if (requested.some((field) => !(EXTERNAL_RESPONSE_FIELDS[provider] as readonly string[]).includes(field))) {
      return deps.respond(422, buildErrorBody('VALIDATION_FAILED', 'fields_not_allowed', { requestId: 'external', serverTime: nowMs }));
    }
    if (approvedFields.length && requested.some((field) => !approvedFields.includes(field))) {
      return deps.respond(422, buildErrorBody('VALIDATION_FAILED', 'fields_not_approved', { requestId: 'external', serverTime: nowMs }));
    }
    if (fields.length === 0) {
      return deps.respond(422, buildErrorBody('VALIDATION_FAILED', 'fields_not_allowed', { requestId: 'external', serverTime: nowMs }));
    }
  } else {
    const text = str(body.text ?? body.wish);
    const approved = String((action.args as Record<string, unknown>).wishText ?? '').trim();
    if (!text || text !== approved) {
      return deps.respond(422, buildErrorBody('VALIDATION_FAILED', 'wish_not_approved', { requestId: 'external', serverTime: nowMs }));
    }
    wishText = text;
  }

  // 许可签发之后用户可能又加了禁区/回避话题、收紧了限额：副作用之前必须按**当前生效边界**
  // 重跑完整的内容/参数策略（不能只查开关与 kind）。这里拒绝后不会走到核销与出网。
  const policyDecision = checkIntentPolicy(
    {
      kind: action.kind,
      args: action.args,
      purpose: action.semanticPurpose,
      boundary: {
        forbiddenCategories: effective.forbiddenCategories,
        avoidTopics: effective.avoidTopics,
        allowFictionalNpc: effective.allowFictionalNpc,
        externalGrants: effective.externalGrants,
      },
    },
    nowMs,
  );
  if (!policyDecision.allowed) {
    return deps.respond(
      policyDecision.reasonCode === 'grant_missing' ? 403 : 403,
      buildErrorBody(
        policyDecision.reasonCode === 'grant_missing' ? 'GRANT_REQUIRED' : 'POLICY_DENIED',
        policyDecision.reasonCode === 'grant_missing' ? 'grant_missing_or_expired' : 'current_policy_denied',
        { requestId: 'external', serverTime: nowMs },
      ),
    );
  }

  // 适用限额（同一窗口内同类动作数）也要按当前 limits 重验；0 = 明确禁止。
  const perKindLimit = effective.limits.perKindActionsPerDay;
  if (perKindLimit !== null && perKindLimit <= 0) {
    return deps.respond(429, buildErrorBody('RATE_LIMITED', 'kind_actions_exhausted', { requestId: 'external', serverTime: nowMs }));
  }

  // 预算窗口 + 预留凭据（按 id 查真实记录、绑定本动作，不是「本窗口有过用量」）。
  const windowId = windowIdAt({ now: () => nowMs }, effective.timezone);
  if (action.windowId !== windowId) return conflict('window_mismatch');
  const hold = await verifyReservationHold(runtime.budget, {
    reservationId: action.reservationId,
    ownerId,
    windowId,
    charId,
    actionId: action.id,
    nowMs,
    timezone: effective.timezone,
  });
  if (!hold.ok) return conflict(hold.reason ?? 'reservation_not_held');

  // 一次性许可在服务端核销：重放会在这里被拒，后面的出网/落库都不会发生。
  const consumed = await consumeExternalPermitAtomic({ db: args.db, ownerId }, {
    actionId,
    charId,
    installationId,
    leaseEpoch,
    argsHash,
    nonce,
    kind,
    nowMs,
    expectedRevision: action.revision,
    expectedWindowId: windowId,
    expectedAccountBoundaryRevision: effective.accountRevision ?? null,
    expectedCharacterBoundaryRevision: effective.characterRevision ?? null,
    expectedReservationRevision: hold.revision ?? null,
    maxKindActions: perKindLimit,
  });
  if (!consumed.ok) {
    const status = consumed.code === 'NOT_FOUND' ? 404 : consumed.code === 'FORBIDDEN' ? 403 : consumed.code === 'GLOBAL_PAUSED' ? 409 : 409;
    return deps.respond(status, buildErrorBody(consumed.code, 'permit_not_consumable', { requestId: 'external', serverTime: nowMs }));
  }

  // 每日授权额度：**与许可核销同一口径**的原子核销。
  // 以前这里传的是「读边界时拿到的 grant.dailyQuota」，语句里也只有 used < 旧 limit ——
  // 于是在「许可 CAS 成功 → 额度语句执行前」把额度收紧到 0 / 撤权 / 暂停（bump revision）
  // 仍会按旧值放行并出网/落库。现在额度、授权有效期、账号/角色 revision 与暂停/开关全在
  // `consumeExternalQuotaAtomic` 的同一条条件语句里按**执行那一刻**的边界判。
  // 许可已经消费掉、这一步拒绝 → 本轮无出网/无落库（fail closed，执行器按失败回执）。
  const quota = await consumeExternalQuotaAtomic({
    db: args.db,
    ownerId,
    charId,
    dayKey: localDateKey(nowMs, effective.timezone),
    provider,
    nowMs,
    expectedAccountRevision: effective.accountRevision ?? null,
    expectedCharacterRevision: effective.characterRevision ?? null,
  });
  if (!quota.ok) {
    if (quota.reason === 'boundary_changed') {
      return deps.respond(409, buildErrorBody('STATE_CONFLICT', 'boundary_changed', { requestId: 'external', serverTime: nowMs }));
    }
    if (quota.reason === 'store_unavailable') {
      return deps.respond(503, buildErrorBody('SERVICE_UNAVAILABLE', 'external_quota_store_unavailable', { requestId: 'external', serverTime: nowMs }));
    }
    return deps.respond(429, buildErrorBody('RATE_LIMITED', 'external_daily_quota_exhausted', { requestId: 'external', serverTime: nowMs }));
  }

  if (mode === 'wish') {
    const wish = await insertTravelWish({
      db: args.db,
      ownerId,
      charId,
      text: wishText,
      grantId: `${grant.provider}:${grant.expiresAt}`,
      nowMs,
    });
    return deps.respond(200, {
      schemaVersion: 1,
      requestId: deps.requestId?.() ?? 'external',
      serverTime: nowMs,
      provider,
      wishId: wish.wishId,
    });
  }

  const endpoint = provider === 'xhs' ? args.env.AUTONOMY_EXTERNAL_XHS_URL : args.env.AUTONOMY_EXTERNAL_AMAP_URL;
  const envHosts = parseAllowedHosts(args.env.AUTONOMY_EXTERNAL_READ_HOSTS);
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
