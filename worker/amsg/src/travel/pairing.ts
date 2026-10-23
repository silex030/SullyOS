/**
 * 角色自主出行 · 首次连接（配对申请 → 管理员批准 → 同浏览器认领）
 *
 * 为什么需要这一层：真实用户没有 owner 凭证，原先只能由运维「为某个 userId 直接签发
 * 一份 owner 密钥」。那条路要求用户先进 SSH/服务器找文件，而且没有「这次请求是谁发起的」
 * 的绑定。本模块把首次连接改成一次短码申请：
 *
 *   1. 浏览器 `POST /travel/pair/request` → 得到 requestId + 一次性短码 + clientSecret；
 *      **请求体里不接受 userId**，谁也不能自助注册到任意账号；
 *   2. 用户把短码告诉已授权管理员；管理员在本机用 ops 脚本 `approve <requestId> <userId>`
 *      批准（绑定由管理员确定，不是客户端自称）；
 *   3. 同一浏览器带 clientSecret + 短码 `POST /travel/pair/claim` → 服务端生成该用户的
 *      owner 密钥（库内只存 sha256），返回一次后即作废。
 *
 * 硬约束：
 * - 短码 / clientSecret 只存哈希，数据库泄漏不能直接认领；
 * - 短码 10 分钟过期、最多 5 次尝试；认领是一次性原子状态迁移（approved → claimed）；
 * - 未批准、过期、已认领、跨浏览器（clientSecret 不匹配）一律拒，不回「差一点成功」；
 * - owner 密钥只在 POST 响应体里出现一次，**绝不进 URL、日志或 GET 参数**；
 * - 公开侧没有任何接口能把请求绑定到 userId —— 只有本机 ops 脚本能 approve。
 */

export const TRAVEL_PAIR_REQUEST_TTL_MS = 10 * 60_000;
export const TRAVEL_PAIR_MAX_ATTEMPTS = 5;
export const TRAVEL_PAIR_RATE_WINDOW_MS = 10 * 60_000;
export const TRAVEL_PAIR_RATE_MAX = 5;

export const TRAVEL_PAIR_DDL = `CREATE TABLE IF NOT EXISTS travel_pair_requests (
  request_id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  client_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  user_id TEXT,
  ip_hash TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  claimed_at INTEGER
)`;

export type TravelPairStatus = 'pending' | 'approved' | 'claimed' | 'expired' | 'invalid';

export interface TravelPairRequestRow {
  requestId: string;
  codeHash: string;
  clientHash: string;
  status: 'pending' | 'approved' | 'claimed';
  userId: string | null;
  ipHash: string | null;
  attempts: number;
  createdAt: number;
  expiresAt: number;
  approvedAt: number | null;
  claimedAt: number | null;
}

/** 只有这些能力；生产接 D1，测试用内存实现。 */
export interface TravelPairStore {
  create(row: TravelPairRequestRow): Promise<void>;
  get(requestId: string): Promise<TravelPairRequestRow | null>;
  countRecentByIp(ipHash: string, sinceMs: number): Promise<number>;
  /** 失败尝试 +1；返回 true 表示仍可继续。 */
  bumpAttempt(requestId: string, attempts: number): Promise<void>;
  /** 管理员批准：只有 pending 且未过期才成功。 */
  approve(requestId: string, userId: string, nowMs: number): Promise<boolean>;
  /** 原子认领：只有 approved 才成功（一次）。 */
  claim(requestId: string, nowMs: number): Promise<boolean>;
}

/* ------------------------------------------------------------------ *
 * 纯函数
 * ------------------------------------------------------------------ */

const encoder = new TextEncoder();

export const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const base = typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(bytes).toString('base64');
  return base.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const randomToken = (byteLength = 24): string =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));

/** 人读短码：8 位去掉易混字符（无 0/O/1/I），显示成 XXXX-XXXX。 */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export const normalizePairCode = (raw: unknown): string => {
  if (typeof raw !== 'string') return '';
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
};

export const formatPairCode = (code: string): string =>
  code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;

export const generatePairCode = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
};

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** 短码哈希绑定 requestId，抄到别的请求里无效。 */
export const hashPairCode = (requestId: string, code: string): Promise<string> =>
  sha256Hex(`${requestId}\u0000code\u0000${normalizePairCode(code)}`);

/** 浏览器持有凭证的哈希：证明认领来自发起申请的同一个浏览器。 */
export const hashClientSecret = (requestId: string, clientSecret: string): Promise<string> =>
  sha256Hex(`${requestId}\u0000client\u0000${clientSecret}`);

/** 与 auth.ts 的 hashOwnerKey 同口径。 */
export const hashOwnerKey = (userId: string, ownerKey: string): Promise<string> =>
  sha256Hex(`${userId}\u0000${ownerKey}`);

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const isValidUserId = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return v.length > 0 && v.length <= 128 && !/[\s\u0000-\u001f\u007f]/.test(v);
};

export interface PairCreateResult {
  requestId: string;
  code: string;
  codeDisplay: string;
  clientSecret: string;
  expiresAt: number;
}

/**
 * 创建申请。`ipHash` 只用于限流与审计，不参与身份绑定；绝不接收 userId。
 */
export async function createPairRequest(args: {
  store: TravelPairStore;
  nowMs: number;
  ipHash?: string | null;
}): Promise<{ ok: true; request: PairCreateResult } | { ok: false; code: 'RATE_LIMITED' }> {
  const ipHash = typeof args.ipHash === 'string' && args.ipHash.trim() ? args.ipHash.trim() : null;
  if (ipHash) {
    const recent = await args.store.countRecentByIp(ipHash, args.nowMs - TRAVEL_PAIR_RATE_WINDOW_MS);
    if (recent >= TRAVEL_PAIR_RATE_MAX) return { ok: false, code: 'RATE_LIMITED' };
  }
  const requestId = randomToken(18);
  const code = generatePairCode();
  const clientSecret = randomToken(24);
  const expiresAt = args.nowMs + TRAVEL_PAIR_REQUEST_TTL_MS;
  await args.store.create({
    requestId,
    codeHash: await hashPairCode(requestId, code),
    clientHash: await hashClientSecret(requestId, clientSecret),
    status: 'pending',
    userId: null,
    ipHash,
    attempts: 0,
    createdAt: args.nowMs,
    expiresAt,
    approvedAt: null,
    claimedAt: null,
  });
  return { ok: true, request: { requestId, code, codeDisplay: formatPairCode(code), clientSecret, expiresAt } };
}

const expired = (row: TravelPairRequestRow, nowMs: number): boolean =>
  row.status !== 'claimed' && nowMs > row.expiresAt;

/**
 * 查询状态。必须带 clientSecret（防止拿到 requestId 就能窥探审批结果）。
 * 返回 invalid 时调用方应引导重新申请，而不是继续轮询。
 */
export async function readPairStatus(args: {
  store: TravelPairStore;
  nowMs: number;
  requestId: string;
  clientSecret: string;
}): Promise<{ status: TravelPairStatus; expiresAt?: number }> {
  const row = await args.store.get(args.requestId);
  if (!row) return { status: 'invalid' };
  if (!constantTimeEqual(row.clientHash, await hashClientSecret(row.requestId, args.clientSecret))) {
    return { status: 'invalid' };
  }
  if (row.status === 'claimed') return { status: 'claimed', expiresAt: row.expiresAt };
  if (expired(row, args.nowMs)) return { status: 'expired', expiresAt: row.expiresAt };
  return { status: row.status, expiresAt: row.expiresAt };
}

export type PairClaimFailure =
  | 'INVALID_REQUEST'
  | 'CODE_INVALID'
  | 'NOT_APPROVED'
  | 'EXPIRED'
  | 'ALREADY_CLAIMED'
  | 'TOO_MANY_ATTEMPTS';

/**
 * 认领：短码 + clientSecret 都对、已批准、未过期、未认领，才签发一次 owner 密钥。
 * 签发前后都不把 ownerKey 写进任何日志。
 */
export async function claimPairRequest(args: {
  store: TravelPairStore;
  nowMs: number;
  requestId: string;
  code: string;
  clientSecret: string;
}): Promise<
  | { ok: true; userId: string; ownerKey: string }
  | { ok: false; code: PairClaimFailure }
> {
  const row = await args.store.get(args.requestId);
  if (!row) return { ok: false, code: 'INVALID_REQUEST' };
  if (row.attempts >= TRAVEL_PAIR_MAX_ATTEMPTS) return { ok: false, code: 'TOO_MANY_ATTEMPTS' };
  if (!constantTimeEqual(row.clientHash, await hashClientSecret(row.requestId, args.clientSecret))) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  if (row.status === 'claimed') return { ok: false, code: 'ALREADY_CLAIMED' };
  if (expired(row, args.nowMs)) return { ok: false, code: 'EXPIRED' };
  if (row.status !== 'approved' || !row.userId) return { ok: false, code: 'NOT_APPROVED' };

  const codeOk = constantTimeEqual(row.codeHash, await hashPairCode(row.requestId, args.code));
  if (!codeOk) {
    await args.store.bumpAttempt(row.requestId, row.attempts + 1);
    return { ok: false, code: 'CODE_INVALID' };
  }

  const claimed = await args.store.claim(row.requestId, args.nowMs);
  if (!claimed) return { ok: false, code: 'ALREADY_CLAIMED' };

  const ownerKey = randomToken(32);
  return { ok: true, userId: row.userId, ownerKey };
}

/** 管理员批准（仅本机 ops 脚本调用，不挂 HTTP）。 */
export async function approvePairRequest(args: {
  store: TravelPairStore;
  nowMs: number;
  requestId: string;
  userId: string;
}): Promise<{ ok: true; userId: string } | { ok: false; code: 'INVALID_REQUEST' | 'INVALID_USER' | 'EXPIRED' | 'NOT_PENDING' }> {
  if (!isValidUserId(args.userId)) return { ok: false, code: 'INVALID_USER' };
  const row = await args.store.get(args.requestId);
  if (!row) return { ok: false, code: 'INVALID_REQUEST' };
  if (row.status !== 'pending') return { ok: false, code: 'NOT_PENDING' };
  if (args.nowMs > row.expiresAt) return { ok: false, code: 'EXPIRED' };
  const ok = await args.store.approve(args.requestId, args.userId.trim(), args.nowMs);
  return ok ? { ok: true, userId: args.userId.trim() } : { ok: false, code: 'NOT_PENDING' };
}

/* ------------------------------------------------------------------ *
 * HTTP 入口（公开、未登录；不接收 userId）
 * ------------------------------------------------------------------ */

const PAIR_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const pairJson = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...PAIR_CORS },
  });

const readJson = async (request: Request): Promise<Record<string, unknown> | null> => {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const readStr = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export interface TravelPairHttpDeps {
  store: TravelPairStore;
  /** 认领成功后的落库：只写哈希，不写明文。 */
  putOwnerKeyHash: (userId: string, keyHash: string, nowMs: number) => Promise<void>;
  nowMs?: number;
  /** 客户端来源（用于限流）；由调用方从受信头读取，不接受请求体。 */
  clientIp?: string | null;
  /** IP 哈希盐（会话密钥），不落日志。 */
  ipSalt?: string | null;
}

/**
 * `/travel/pair/request|status|claim`。返回 null = 不是配对路由。
 * 公开侧没有 approve 路由：批准只走本机 ops 脚本（见 scripts/travel-pair-admin.mjs）。
 */
export async function handleTravelPairRequest(
  request: Request,
  deps: TravelPairHttpDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '');
  const match = /\/travel\/pair\/(request|status|claim)$/.exec(pathname);
  if (!match) return null;
  const action = match[1];
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: PAIR_CORS });
  if (method !== 'POST') return pairJson(405, { error: { code: 'METHOD_NOT_ALLOWED' } });

  const nowMs = Number.isFinite(deps.nowMs) ? Math.floor(deps.nowMs as number) : Date.now();
  const clientIp = readStr(deps.clientIp ?? '');
  let ipHash: string | null = null;
  if (clientIp) {
    ipHash = await sha256Hex(`${readStr(deps.ipSalt ?? '')}\u0000ip\u0000${clientIp}`);
  }

  if (action === 'request') {
    const created = await createPairRequest({ store: deps.store, nowMs, ipHash });
    if (!created.ok) {
      return pairJson(429, { error: { code: 'RATE_LIMITED', retryAfterSeconds: 600 } });
    }
    return pairJson(201, {
      success: true,
      request: {
        requestId: created.request.requestId,
        code: created.request.codeDisplay,
        clientSecret: created.request.clientSecret,
        expiresAt: created.request.expiresAt,
      },
      next: '把短码交给已授权管理员批准；批准后本浏览器自动完成连接',
    });
  }

  const body = await readJson(request);
  if (!body) return pairJson(400, { error: { code: 'INVALID_REQUEST' } });
  const requestId = readStr(body.requestId);
  const clientSecret = readStr(body.clientSecret);
  if (!requestId || !clientSecret) return pairJson(400, { error: { code: 'INVALID_REQUEST' } });

  if (action === 'status') {
    const status = await readPairStatus({ store: deps.store, nowMs, requestId, clientSecret });
    return pairJson(200, status);
  }

  const claim = await claimPairRequest({
    store: deps.store,
    nowMs,
    requestId,
    code: readStr(body.code),
    clientSecret,
  });
  if (!claim.ok) {
    const statusCode = claim.code === 'TOO_MANY_ATTEMPTS' || claim.code === 'CODE_INVALID' ? 401 : 409;
    return pairJson(statusCode, { error: { code: claim.code } });
  }
  const keyHash = await hashOwnerKey(claim.userId, claim.ownerKey);
  await deps.putOwnerKeyHash(claim.userId, keyHash, nowMs);
  return pairJson(200, {
    success: true,
    credential: { userId: claim.userId, ownerKey: claim.ownerKey },
    warning: '只显示这一次：保存后服务端只保留哈希',
  });
}

/* ------------------------------------------------------------------ *
 * D1 实现（生产）
 * ------------------------------------------------------------------ */

interface PairDbStatement {
  bind(...args: unknown[]): PairDbStatement;
  run(): Promise<unknown>;
  first(): Promise<Record<string, unknown> | null>;
  all(): Promise<{ results?: Record<string, unknown>[] }>;
}

interface PairDb {
  prepare(sql: string): PairDbStatement;
}

export const createD1PairStore = (db: PairDb): TravelPairStore => ({
  async create(row) {
    await db
      .prepare(
        'INSERT INTO travel_pair_requests (request_id, code_hash, client_hash, status, user_id, ip_hash, attempts, created_at, expires_at, approved_at, claimed_at) ' +
          'VALUES (?, ?, ?, ?, NULL, ?, 0, ?, ?, NULL, NULL)',
      )
      .bind(row.requestId, row.codeHash, row.clientHash, row.status, row.ipHash, row.createdAt, row.expiresAt)
      .run();
  },
  async get(requestId) {
    const row = await db.prepare('SELECT * FROM travel_pair_requests WHERE request_id = ?').bind(requestId).first();
    if (!row) return null;
    return {
      requestId: String(row.request_id),
      codeHash: String(row.code_hash),
      clientHash: String(row.client_hash),
      status: row.status === 'approved' || row.status === 'claimed' ? row.status : 'pending',
      userId: typeof row.user_id === 'string' ? row.user_id : null,
      ipHash: typeof row.ip_hash === 'string' ? row.ip_hash : null,
      attempts: Number(row.attempts ?? 0),
      createdAt: Number(row.created_at ?? 0),
      expiresAt: Number(row.expires_at ?? 0),
      approvedAt: row.approved_at == null ? null : Number(row.approved_at),
      claimedAt: row.claimed_at == null ? null : Number(row.claimed_at),
    };
  },
  async countRecentByIp(ipHash, sinceMs) {
    const row = await db
      .prepare('SELECT COUNT(*) AS n FROM travel_pair_requests WHERE ip_hash = ? AND created_at >= ?')
      .bind(ipHash, sinceMs)
      .first();
    return Number(row?.n ?? 0);
  },
  async bumpAttempt(requestId, attempts) {
    await db.prepare('UPDATE travel_pair_requests SET attempts = ? WHERE request_id = ?').bind(attempts, requestId).run();
  },
  async approve(requestId, userId, nowMs) {
    const res = (await db
      .prepare("UPDATE travel_pair_requests SET status = 'approved', user_id = ?, approved_at = ? WHERE request_id = ? AND status = 'pending'")
      .bind(userId, nowMs, requestId)
      .run()) as { changes?: number; meta?: { changes?: number } } | undefined;
    const changes = res?.meta?.changes ?? res?.changes;
    return changes === 1;
  },
  async claim(requestId, nowMs) {
    const res = (await db
      .prepare("UPDATE travel_pair_requests SET status = 'claimed', claimed_at = ? WHERE request_id = ? AND status = 'approved'")
      .bind(nowMs, requestId)
      .run()) as { changes?: number; meta?: { changes?: number } } | undefined;
    const changes = res?.meta?.changes ?? res?.changes;
    return changes === 1;
  },
});

/* ------------------------------------------------------------------ *
 * 内存实现（单测 / 本地脚本）
 * ------------------------------------------------------------------ */

export const createMemoryPairStore = (): TravelPairStore & { rows: Map<string, TravelPairRequestRow> } => {
  const rows = new Map<string, TravelPairRequestRow>();
  return {
    rows,
    async create(row) {
      rows.set(row.requestId, { ...row });
    },
    async get(requestId) {
      const row = rows.get(requestId);
      return row ? { ...row } : null;
    },
    async countRecentByIp(ipHash, sinceMs) {
      let n = 0;
      for (const row of rows.values()) if (row.ipHash === ipHash && row.createdAt >= sinceMs) n += 1;
      return n;
    },
    async bumpAttempt(requestId, attempts) {
      const row = rows.get(requestId);
      if (row) row.attempts = attempts;
    },
    async approve(requestId, userId, nowMs) {
      const row = rows.get(requestId);
      if (!row || row.status !== 'pending') return false;
      row.status = 'approved';
      row.userId = userId;
      row.approvedAt = nowMs;
      return true;
    },
    async claim(requestId, nowMs) {
      const row = rows.get(requestId);
      if (!row || row.status !== 'approved') return false;
      row.status = 'claimed';
      row.claimedAt = nowMs;
      return true;
    },
  };
};
