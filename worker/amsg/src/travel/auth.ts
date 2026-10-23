/**
 * 角色自主出行 · 会话身份（安全 lane）
 *
 * 为什么需要这一层：amsg 包装层现有的身份口径是「共享口令 + `X-User-Id` 头」，而
 * `X-User-Id` 是客户端**自称**——谁拿到共享口令，就能把它填成任意 user id。把那种
 * 请求当成「已登录用户」等于把多租户隔离交给调用方自觉。本模块只做一件事：
 * 把身份换成**服务端签发、带签名/有效期/用途**的会话，并明确什么情况下不能签发。
 *
 * 口径（不要放宽）：
 * - **`X-User-Id` 只做一致性断言**：会话主体与它不一致 → `PRINCIPAL_MISMATCH`；
 *   没有会话时它一律不算身份（哪怕同时带着正确共享口令）。
 * - **共享口令不是 owner 凭证**：`AMSG_CLIENT_TOKEN` 是全网一份的共享密钥，能伪造
 *   任意 user id，因此 exchange 永不拿它当凭据；owner 凭证是**每用户随机密钥**，
 *   库里只存 `sha256(userId \\0 key)`。
 * - **bootstrap 只走已鉴权的服务端 owner 通道**：需要独立的
 *   `TRAVEL_OWNER_BOOTSTRAP_SECRET`（与共享口令不同的服务端密钥）+ 注入的
 *   `TravelOwnerStore`。缺任何一项就 503 回「缺前置」，不开放自助注册。
 *   本模块**不挂路由、不暴露登录入口**：接线由集成执行者决定。
 * - **fail-closed**：签名密钥缺失/过短、owner 仓库缺失、owner 未登记 → 拒，不降级。
 *
 * 签名密钥优先级：`TRAVEL_SESSION_SECRET`（≥32 字符，独立密钥）→ 用
 * `AMSG_MASTER_KEY` 派生的域分隔密钥（主密钥是服务端独有，不下发客户端；共享口令
 * 绝不参与派生）。两者都没有 → `session-secret-unconfigured`。
 */
import type { TravelErrorCode } from '../../../../contracts/travel';

/* ------------------------------------------------------------------ *
 * 常量与类型
 * ------------------------------------------------------------------ */

/** 会话用途。别的用途（如 amsg）签出来的 token 在这里一律不认。 */
export const TRAVEL_SESSION_AUDIENCE = 'travel';

/** 认证方案（Authorization 头）。 */
export const TRAVEL_SESSION_SCHEME = 'Bearer';

/** 会话交换端点（B6 接线用；本模块不注册路由）。 */
export const TRAVEL_AUTH_ENDPOINT = '/travel/session/exchange';

/** owner 凭证 bootstrap 端点（只允许从已鉴权服务端通道调用）。 */
export const TRAVEL_OWNER_BOOTSTRAP_ENDPOINT = '/travel/owner/bootstrap';

export const TRAVEL_DEFAULT_SESSION_TTL_MS = 60 * 60_000;
/** 会话最长有效期：签发时夹紧，避免「一次签发、长期有效」。 */
export const TRAVEL_MAX_SESSION_TTL_MS = 12 * 60 * 60_000;
/** 允许的时钟漂移（签发时间在未来一点点不算攻击，但 10 分钟就是）。 */
export const TRAVEL_SESSION_CLOCK_SKEW_MS = 60_000;
/** 独立会话密钥的最小长度。短于此视为未配置（不拿弱密钥硬签）。 */
export const TRAVEL_MIN_SESSION_SECRET_LEN = 32;

/**
 * owner 凭证表（additive）：只存哈希，不存明文密钥。
 * 与 `contracts/travel.ts` 的 7 张业务表无关，故不写进那份 DDL 字符串。
 */
export const TRAVEL_OWNER_CREDENTIALS_DDL = `CREATE TABLE IF NOT EXISTS travel_owner_credentials (
  user_id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER
)`;

/** 建表（additive、幂等）：集成执行者挂路由时调一次，与 B1 的 ensureTravelSchema 并列。 */
export const ensureTravelOwnerSchema = async (db: TravelDb): Promise<void> => {
  await db.prepare(TRAVEL_OWNER_CREDENTIALS_DDL).run();
};

/** 会话载荷（不透明给客户端，但字段名固定，便于排查）。 */
export interface TravelSessionPayload {
  v: 1;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}

/** 环境片段：只读注入，不在这里读 `.env`、不落任何默认口令。 */
export interface TravelAuthEnv {
  TRAVEL_SESSION_SECRET?: string;
  AMSG_MASTER_KEY?: string;
  AMSG_CLIENT_TOKEN?: string;
  TRAVEL_OWNER_BOOTSTRAP_SECRET?: string;
}

export type TravelSessionFailureReason =
  | 'session-secret-unconfigured'
  | 'session-missing'
  | 'session-malformed'
  | 'session-signature-invalid'
  | 'session-audience-mismatch'
  | 'session-expired'
  | 'session-issued-in-future'
  | 'session-subject-invalid'
  | 'principal-mismatch';

export type TravelSessionResult =
  | { ok: true; userId: string; session: TravelSessionPayload }
  | {
      ok: false;
      status: number;
      code: Extract<TravelErrorCode, 'UNAUTHORIZED' | 'PRINCIPAL_MISMATCH'>;
      reason: TravelSessionFailureReason;
      message: string;
    };

export type TravelSessionIssueResult =
  | { ok: true; token: string; payload: TravelSessionPayload }
  | { ok: false; status: number; code: 'UNAUTHORIZED'; reason: 'session-secret-unconfigured'; message: string };

/** owner 凭证仓库：只暴露「按 user 读写哈希」，测试用内存实现，生产接 D1。 */
export interface TravelOwnerStore {
  getKeyHash(userId: string): Promise<string | null>;
  putKeyHash(userId: string, keyHash: string, nowMs: number): Promise<void>;
}

/** D1 结构子集（与 `store.ts` / `autonomyStore` 同一手法，不引未声明的 D1Database）。 */
export interface TravelStatement {
  bind(...args: unknown[]): TravelStatement;
  run(): Promise<unknown>;
  first(): Promise<Record<string, unknown> | null>;
  all(): Promise<{ results?: Array<Record<string, unknown>> }>;
}

export interface TravelDb {
  prepare(sql: string): TravelStatement;
}

export interface TravelAuthDeps {
  ownerStore?: TravelOwnerStore;
  nowMs?: number;
}

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (text: string): Uint8Array | null => {
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const out = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};

/** 定长比较（两边先各做一次随机钥 HMAC，再逐字节比），长度和内容都不从耗时泄漏。 */
export const constantTimeEqualString = async (a: string, b: string): Promise<boolean> => {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const da = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(a)));
  const db = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(b)));
  let diff = 0;
  for (let i = 0; i < da.length; i += 1) diff |= da[i] ^ db[i];
  return diff === 0;
};

const sha256Hex = async (text: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
  return Array.from(digest).map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** owner 密钥的落库形态：绑定 user_id，库泄漏也无法拿去给别的账号换会话。 */
export const hashOwnerKey = (userId: string, ownerKey: string): Promise<string> =>
  sha256Hex(`${userId}\u0000${ownerKey}`);

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const fail = (status: number, code: string, detail: string, message: string): Response =>
  json(status, { success: false, error: { code, detail, message } });

const readBearer = (request: Request): string | null => {
  const header = (request.headers.get('Authorization') ?? '').trim();
  if (!header) return null;
  const lowered = header.toLowerCase();
  const scheme = TRAVEL_SESSION_SCHEME.toLowerCase();
  if (!lowered.startsWith(`${scheme} `)) return '';
  return header.slice(scheme.length + 1).trim();
};

/* ------------------------------------------------------------------ *
 * 签名密钥
 * ------------------------------------------------------------------ */

const importHmacKey = (raw: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', raw as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

/**
 * 解析签名钥。返回 null = 没有可用的服务端密钥（调用方必须 fail-closed）。
 * 派生路径带域分隔标签，主密钥换了/共享口令换了都不会串用途。
 */
const resolveSigningKey = async (env: TravelAuthEnv): Promise<CryptoKey | null> => {
  const explicit = (env.TRAVEL_SESSION_SECRET ?? '').trim();
  if (explicit.length >= TRAVEL_MIN_SESSION_SECRET_LEN) {
    return importHmacKey(encoder.encode(explicit));
  }
  const master = (env.AMSG_MASTER_KEY ?? '').trim();
  if (master.length >= TRAVEL_MIN_SESSION_SECRET_LEN) {
    const masterKey = await importHmacKey(encoder.encode(master));
    const derived = new Uint8Array(
      await crypto.subtle.sign('HMAC', masterKey, encoder.encode('sullyos-travel-session-signing-v1')),
    );
    return importHmacKey(derived);
  }
  return null;
};

/**
 * 导出「签名用字符串」给同一批服务端签名器（静态图短链、地点令牌）复用。
 * 两处都带自己的域分隔标签，所以不会串用途；都没有就返回 null（fail-closed）。
 */
export const resolveTravelSecretString = (env: TravelAuthEnv): string | null => {
  const explicit = (env.TRAVEL_SESSION_SECRET ?? '').trim();
  if (explicit.length >= TRAVEL_MIN_SESSION_SECRET_LEN) return explicit;
  const master = (env.AMSG_MASTER_KEY ?? '').trim();
  if (master.length >= TRAVEL_MIN_SESSION_SECRET_LEN) return master;
  return null;
};

const signSegment = async (key: CryptoKey, input: string): Promise<string> =>
  toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(input))));

/* ------------------------------------------------------------------ *
 * 签发 / 验证
 * ------------------------------------------------------------------ */

export interface IssueTravelSessionInput {
  userId: string;
  env: TravelAuthEnv;
  nowMs?: number;
  ttlMs?: number;
  /** 仅测试/其它用途才需要改；默认 travel。 */
  audience?: string;
}

export const issueTravelSession = async (input: IssueTravelSessionInput): Promise<TravelSessionIssueResult> => {
  const key = await resolveSigningKey(input.env);
  if (!key) {
    return {
      ok: false,
      status: 503,
      code: 'UNAUTHORIZED',
      reason: 'session-secret-unconfigured',
      message: '出行会话签名密钥未配置（缺 TRAVEL_SESSION_SECRET / AMSG_MASTER_KEY），已拒绝签发',
    };
  }
  const userId = String(input.userId ?? '').trim();
  if (!userId) {
    // 调用方只应在已验证主体后签发；空主体是调用方 bug，按未授权处理。
    return {
      ok: false,
      status: 503,
      code: 'UNAUTHORIZED',
      reason: 'session-secret-unconfigured',
      message: '缺少已验证主体，拒绝签发会话',
    };
  }
  const nowMs = Number.isFinite(input.nowMs) ? Math.floor(input.nowMs as number) : Date.now();
  const requested = Number.isFinite(input.ttlMs) ? Math.floor(input.ttlMs as number) : TRAVEL_DEFAULT_SESSION_TTL_MS;
  const ttl = Math.min(Math.max(requested, 1_000), TRAVEL_MAX_SESSION_TTL_MS);
  const jtiBytes = crypto.getRandomValues(new Uint8Array(16));
  const payload: TravelSessionPayload = {
    v: 1,
    sub: userId,
    aud: input.audience ?? TRAVEL_SESSION_AUDIENCE,
    iat: nowMs,
    exp: nowMs + ttl,
    jti: toBase64Url(jtiBytes),
  };
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const head = 'tv1';
  const sig = await signSegment(key, `${head}.${body}`);
  return { ok: true, token: `${head}.${body}.${sig}`, payload };
};

export interface ResolveTravelSessionInput {
  request: Request;
  env: TravelAuthEnv;
  nowMs?: number;
  audience?: string;
}

type TravelSessionErrorCode = Extract<TravelErrorCode, 'UNAUTHORIZED' | 'PRINCIPAL_MISMATCH'>;

const sessionFailure = (
  status: number,
  code: TravelSessionErrorCode,
  reason: TravelSessionFailureReason,
  message: string,
): TravelSessionResult => ({ ok: false, status, code, reason, message });

export const resolveTravelSession = async (input: ResolveTravelSessionInput): Promise<TravelSessionResult> => {
  const key = await resolveSigningKey(input.env);
  if (!key) {
    return sessionFailure(
      503,
      'UNAUTHORIZED',
      'session-secret-unconfigured',
      '出行会话签名密钥未配置，暂时无法验证身份',
    );
  }

  const token = readBearer(input.request);
  if (token === null) {
    return sessionFailure(401, 'UNAUTHORIZED', 'session-missing', '缺少登录会话，请重新登录后再看 TA 的行程');
  }
  if (!token) {
    return sessionFailure(401, 'UNAUTHORIZED', 'session-malformed', '登录会话格式不正确');
  }

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'tv1') {
    return sessionFailure(401, 'UNAUTHORIZED', 'session-malformed', '登录会话格式不正确');
  }
  const [head, body, sig] = parts;
  const expectedSig = await signSegment(key, `${head}.${body}`);
  if (!(await constantTimeEqualString(sig, expectedSig))) {
    return sessionFailure(401, 'UNAUTHORIZED', 'session-signature-invalid', '登录会话校验失败，请重新登录');
  }

  const rawPayload = fromBase64Url(body);
  if (!rawPayload) {
    return sessionFailure(401, 'UNAUTHORIZED', 'session-malformed', '登录会话内容损坏');
  }
  let payload: TravelSessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawPayload)) as TravelSessionPayload;
  } catch {
    return sessionFailure(401, 'UNAUTHORIZED', 'session-malformed', '登录会话内容损坏');
  }

  const nowMs = Number.isFinite(input.nowMs) ? Math.floor(input.nowMs as number) : Date.now();
  const audience = input.audience ?? TRAVEL_SESSION_AUDIENCE;
  if (payload?.v !== 1 || typeof payload.sub !== 'string' || !Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) {
    return sessionFailure(401, 'UNAUTHORIZED', 'session-malformed', '登录会话内容不完整');
  }
  if (payload.aud !== audience) {
    return sessionFailure(401, 'UNAUTHORIZED', 'session-audience-mismatch', '登录会话用途不匹配');
  }
  if (payload.exp <= nowMs) {
    return sessionFailure(401, 'UNAUTHORIZED', 'session-expired', '登录状态已失效，重新登录后再看 TA 的行程');
  }
  if (payload.iat > nowMs + TRAVEL_SESSION_CLOCK_SKEW_MS) {
    return sessionFailure(401, 'UNAUTHORIZED', 'session-issued-in-future', '登录会话时间异常');
  }
  if (payload.exp - payload.iat > TRAVEL_MAX_SESSION_TTL_MS + TRAVEL_SESSION_CLOCK_SKEW_MS) {
    return sessionFailure(401, 'UNAUTHORIZED', 'session-malformed', '登录会话有效期异常');
  }
  const userId = payload.sub.trim();
  if (!userId || userId.length > 128 || /[\u0000-\u001f\u007f]/.test(userId)) {
    return sessionFailure(401, 'UNAUTHORIZED', 'session-subject-invalid', '登录会话主体无效');
  }

  // 一致性断言：头只用来对账，永远不改写身份来源。
  const headerUserId = (input.request.headers.get('X-User-Id') ?? '').trim();
  if (headerUserId && headerUserId !== userId) {
    return sessionFailure(403, 'PRINCIPAL_MISMATCH', 'principal-mismatch', '身份信息不一致，已拒绝本次请求');
  }

  return { ok: true, userId, session: payload };
};

/**
 * B3 的 `deps.resolveSession` 直接可用：`createTravelSessionResolver(env)` 返回
 * `(request) => Promise<TravelSessionResult>`，错误码/状态码与上面完全一致。
 */
export const createTravelSessionResolver = (env: TravelAuthEnv, now?: () => number) =>
  (request: Request): Promise<TravelSessionResult> =>
    resolveTravelSession({ request, env, nowMs: now ? now() : undefined });

/* ------------------------------------------------------------------ *
 * owner 仓库
 * ------------------------------------------------------------------ */

export const createMemoryOwnerStore = (): TravelOwnerStore & { size(): number } => {
  const rows = new Map<string, string>();
  return {
    getKeyHash: async (userId) => rows.get(userId) ?? null,
    putKeyHash: async (userId, keyHash) => {
      rows.set(userId, keyHash);
    },
    size: () => rows.size,
  };
};

export const createD1OwnerStore = (db: TravelDb): TravelOwnerStore => ({
  getKeyHash: async (userId) => {
    const row = await db
      .prepare('SELECT key_hash FROM travel_owner_credentials WHERE user_id = ?')
      .bind(userId)
      .first();
    const value = row?.key_hash;
    return typeof value === 'string' && value ? value : null;
  },
  putKeyHash: async (userId, keyHash, nowMs) => {
    await db
      .prepare(
        'INSERT INTO travel_owner_credentials (user_id, key_hash, created_at, rotated_at) ' +
          'VALUES (?, ?, ?, NULL) ON CONFLICT(user_id) DO UPDATE SET key_hash = excluded.key_hash, rotated_at = excluded.created_at',
      )
      .bind(userId, keyHash, nowMs)
      .run();
  },
});

/* ------------------------------------------------------------------ *
 * HTTP handlers（不注册路由，由集成执行者接线）
 * ------------------------------------------------------------------ */

const readJsonObject = async (request: Request): Promise<Record<string, unknown> | null> => {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
};

const isValidUserId = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return v.length > 0 && v.length <= 128 && !/[\s\u0000-\u001f\u007f]/.test(v);
};

const bootstrapSecretProblem = (env: TravelAuthEnv): string => {
  const secret = (env.TRAVEL_OWNER_BOOTSTRAP_SECRET ?? '').trim();
  if (secret.length < TRAVEL_MIN_SESSION_SECRET_LEN) return 'bootstrap-secret-unconfigured';
  const shared = (env.AMSG_CLIENT_TOKEN ?? '').trim();
  if (shared && shared === secret) return 'bootstrap-secret-is-shared-client-token';
  return '';
};

/**
 * owner 凭证 bootstrap：**只**给已鉴权的服务端 owner 通道用。
 *
 * 需要注入 `ownerStore`（生产接 `createD1OwnerStore(env.DB)`），凭据是
 * `TRAVEL_OWNER_BOOTSTRAP_SECRET`（≥32 字符，且不得与共享口令同值）。
 * 成功返回一次性的每用户随机密钥；之后用户用它调 exchange 换会话。
 * 缺前置（密钥/仓库）→ 503，绝不退化成「共享口令也能注册」。
 */
export const handleTravelOwnerBootstrap = async (
  request: Request,
  env: TravelAuthEnv,
  deps: TravelAuthDeps = {},
): Promise<Response> => {
  const problem = bootstrapSecretProblem(env);
  if (problem) {
    return fail(
      503,
      'UNAUTHORIZED',
      problem,
      'owner 凭证 bootstrap 通道未配置（需要独立的服务端密钥），暂不签发任何 owner 密钥',
    );
  }
  const provided = readBearer(request);
  const bootstrapSecret = (env.TRAVEL_OWNER_BOOTSTRAP_SECRET ?? '').trim();
  if (!provided) {
    return fail(401, 'UNAUTHORIZED', 'bootstrap-credential-invalid', '调用方不是已鉴权的服务端 owner 通道');
  }
  if (!(await constantTimeEqualString(provided, bootstrapSecret))) {
    return fail(401, 'UNAUTHORIZED', 'bootstrap-credential-invalid', '调用方不是已鉴权的服务端 owner 通道');
  }
  const store = deps.ownerStore;
  if (!store) {
    return fail(503, 'UNAUTHORIZED', 'owner-store-unconfigured', 'owner 凭证仓库未接入，拒绝签发密钥');
  }
  const body = await readJsonObject(request);
  const userId = body?.userId;
  if (!isValidUserId(userId)) {
    return fail(400, 'UNAUTHORIZED', 'invalid-request', '需要合法的 userId');
  }
  const nowMs = Number.isFinite(deps.nowMs) ? Math.floor(deps.nowMs as number) : Date.now();
  const ownerKey = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  await store.putKeyHash(userId.trim(), await hashOwnerKey(userId.trim(), ownerKey), nowMs);
  return json(201, {
    success: true,
    credential: { userId: userId.trim(), ownerKey, createdAt: nowMs },
    warning: '只显示这一次：请把它存进调用方自己的密钥保管处，服务端只保留哈希',
  });
};

/**
 * 会话交换：`POST {userId, ownerKey}` → 签名会话。
 *
 * 只认**已登记** owner 的每用户随机密钥；共享口令（以及 bootstrap 密钥）永远不能
 * 当 owner 凭证。未登记 / 密钥不对 / 仓库缺失 / 签名钥缺失一律明确拒绝。
 */
export const handleTravelSessionExchange = async (
  request: Request,
  env: TravelAuthEnv,
  deps: TravelAuthDeps = {},
): Promise<Response> => {
  const body = await readJsonObject(request);
  const userId = body?.userId;
  const ownerKey = body?.ownerKey;
  if (!isValidUserId(userId) || typeof ownerKey !== 'string' || !ownerKey.trim()) {
    return fail(400, 'UNAUTHORIZED', 'invalid-request', '需要合法的 userId 与 ownerKey');
  }
  const trimmedUser = userId.trim();
  const trimmedKey = ownerKey.trim();

  // 共享口令 = 全网一份、可伪造任意 user id，因此**不构成身份**。先挡这一条，
  // 免得有人把共享密钥写进 owner 表后绕回「共享口令即身份」。
  const shared = (env.AMSG_CLIENT_TOKEN ?? '').trim();
  const bootstrap = (env.TRAVEL_OWNER_BOOTSTRAP_SECRET ?? '').trim();
  if ((shared && trimmedKey === shared) || (bootstrap && trimmedKey === bootstrap)) {
    return fail(
      401,
      'UNAUTHORIZED',
      'owner-credential-must-not-be-shared-secret',
      '共享口令/服务端通道密钥不能当 owner 凭证，请用 bootstrap 签发的每用户密钥',
    );
  }

  const store = deps.ownerStore;
  if (!store) {
    return fail(503, 'UNAUTHORIZED', 'owner-store-unconfigured', 'owner 凭证仓库未接入，无法校验身份');
  }
  const storedHash = await store.getKeyHash(trimmedUser);
  if (!storedHash) {
    return fail(
      401,
      'UNAUTHORIZED',
      'owner-credential-not-registered',
      '该账号还没有登记 owner 凭证（需先在已鉴权服务端通道完成 bootstrap），暂不能签发会话',
    );
  }
  const presentedHash = await hashOwnerKey(trimmedUser, trimmedKey);
  if (!(await constantTimeEqualString(presentedHash, storedHash))) {
    return fail(401, 'UNAUTHORIZED', 'owner-credential-invalid', 'owner 凭证不正确');
  }

  const nowMs = Number.isFinite(deps.nowMs) ? Math.floor(deps.nowMs as number) : Date.now();
  const issued = await issueTravelSession({ userId: trimmedUser, env, nowMs });
  if (!issued.ok) {
    return fail(issued.status, issued.code, issued.reason, issued.message);
  }
  return json(200, {
    success: true,
    session: {
      token: issued.token,
      userId: trimmedUser,
      audience: issued.payload.aud,
      issuedAt: issued.payload.iat,
      expiresAt: issued.payload.exp,
    },
  });
};

/** B3 接线时可直接用来把会话失败映射成响应（错误码集合与契约一致）。 */
export const sessionFailureResponse = (result: TravelSessionResult): Response => {
  if (result.ok) throw new Error('sessionFailureResponse 只接受失败结果');
  return fail(result.status, result.code, result.reason, result.message);
};
