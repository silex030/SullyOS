/**
 * 出行 · 高德 JS API 安全代理（官方 `_AMapService` 前缀）
 *
 * 官方做法是让浏览器把请求发到 `serviceHost`，由服务端补 `securityJsCode` 再转发到
 * `restapi.amap.com`。这里保留同一前缀与同一语义，但加了三道约束：
 *
 * 1. **短期签名会话**：SDK 的请求是跨 `<script>` 的，带不了 Bearer。所以 serviceHost
 *    形如 `/_AMapService/t/<token>`，token 由已签名出行会话换取，绑定 userId 与过期时间，
 *    HMAC 签名钥复用 `TRAVEL_SESSION_SECRET`（域分隔标签不同）。URL 里没有 userId 参数
 *    可自报，改了签名就对不上。
 * 2. **严格 allowlist**：只有白名单路径（地点检索 / 地理编码 / 步行与驾车路径）能转发，
 *    上游 host 固定 `restapi.amap.com`，不接受任何 URL 参数指定目标。`key` 一律覆盖成
 *    **该用户自己保存的 JS Key**，`jscode` 由服务端注入 —— 这个端点不能当开放代理用。
 * 3. **限流 + 租户绑定**：按 userId 的固定窗口限流；读不到该用户的 jscode/jsKey 直接
 *    503，不回退到别人的凭据或环境变量。
 *
 * 安全边界：jscode 与 Web 服务 Key 永远不出现在响应体、日志或错误文案里；上游错误只回
 * 状态码与通用错误码。
 */
import { resolveTravelMapCredentialValues, type TravelMapCredentialDb } from './mapCredentials';

export const AMAP_SERVICE_PREFIX = '/_AMapService';
export const AMAP_PROXY_UPSTREAM = 'https://restapi.amap.com';
/** 短期代理会话 TTL：远短于出行会话，刷新面板时重新签发。 */
export const AMAP_PROXY_TOKEN_TTL_MS = 30 * 60_000;
export const AMAP_PROXY_MAX_TTL_MS = 60 * 60_000;

/** 只转发 JS API 真实会用到的只读端点（不放任意路径，也不放 POST）。 */
export const AMAP_PROXY_ALLOWED_PATHS: readonly string[] = [
  '/v3/place/text',
  '/v3/place/around',
  '/v3/geocode/geo',
  '/v3/geocode/regeo',
  '/v3/direction/walking',
  '/v3/direction/driving',
  '/v3/distance',
];

const SIGN_LABEL = 'sullyos-travel-amap-proxy-v1';
const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (text: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  try {
    const binary = atob(padded + pad);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};

const encodeUserTag = (userId: string): string => toBase64Url(encoder.encode(`u:${userId}`));
const decodeUserTag = (tag: string): string | null => {
  const bytes = fromBase64Url(tag);
  if (!bytes) return null;
  const text = new TextDecoder().decode(bytes);
  if (!text.startsWith('u:')) return null;
  const userId = text.slice(2).trim();
  return userId && userId.length <= 128 && !/[\u0000-\u001f]/.test(userId) ? userId : null;
};

const hmacKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

const sign = async (secret: string, payload: string): Promise<string> =>
  toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload))));

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export interface MintServiceHostInput {
  userId: string;
  secret: string;
  nowMs: number;
  ttlMs?: number;
}

/**
 * 签发短期 serviceHost。secret 太短 / userId 空 → null（前端显式显示「代理未配置」，
 * 不退回明文 securityJsCode）。
 */
export async function mintTravelMapServiceHost(
  input: MintServiceHostInput,
): Promise<{ serviceHost: string; expiresAt: number } | null> {
  const secret = (input.secret ?? '').trim();
  const userId = String(input.userId ?? '').trim();
  if (secret.length < 32 || !userId) return null;
  const ttl = Math.min(
    Math.max(Math.trunc(input.ttlMs ?? AMAP_PROXY_TOKEN_TTL_MS), 30_000),
    AMAP_PROXY_MAX_TTL_MS,
  );
  const exp = Math.trunc(input.nowMs) + ttl;
  const tag = encodeUserTag(userId);
  const signature = await sign(secret, `${SIGN_LABEL}.${tag}.${exp}`);
  const token = `${tag}.${exp}.${signature}`;
  return { serviceHost: `${AMAP_SERVICE_PREFIX}/t/${token}`, expiresAt: exp };
}

export interface VerifiedProxyToken {
  userId: string;
  exp: number;
}

export async function verifyTravelMapProxyToken(
  token: string,
  input: { secret: string; nowMs: number },
): Promise<{ ok: true; value: VerifiedProxyToken } | { ok: false; reason: string }> {
  const secret = (input.secret ?? '').trim();
  if (secret.length < 32) return { ok: false, reason: 'proxy-secret-unconfigured' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'proxy-token-malformed' };
  const [tag, expRaw, signature] = parts as [string, string, string];
  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'proxy-token-malformed' };
  if (exp <= input.nowMs) return { ok: false, reason: 'proxy-token-expired' };
  if (exp - input.nowMs > AMAP_PROXY_MAX_TTL_MS + 60_000) return { ok: false, reason: 'proxy-token-ttl-invalid' };
  const expected = await sign(secret, `${SIGN_LABEL}.${tag}.${Math.trunc(exp)}`);
  if (!constantTimeEqual(expected, signature)) return { ok: false, reason: 'proxy-token-signature-invalid' };
  const userId = decodeUserTag(tag);
  if (!userId) return { ok: false, reason: 'proxy-token-user-invalid' };
  return { ok: true, value: { userId, exp: Math.trunc(exp) } };
}

/** 每个用户的固定窗口限流（进程级；测试可重置）。 */
const rateBuckets = new Map<string, { windowStart: number; count: number }>();
export const DEFAULT_AMAP_PROXY_RPM = 40;
export const resetAmapProxyRateLimitForTesting = (): void => {
  rateBuckets.clear();
};

/**
 * 按用户固定窗口限流（进程级；测试可重置）。
 * 导出给 REST 中转（`mapRest.ts`）共用同一本账：一次外部出口、一份额度。
 */
export const takeAmapRateLimit = (userId: string, nowMs: number, rpm: number): boolean => {
  const windowMs = 60_000;
  const bucket = rateBuckets.get(userId);
  if (!bucket || nowMs - bucket.windowStart >= windowMs) {
    rateBuckets.set(userId, { windowStart: nowMs, count: 1 });
    return true;
  }
  if (bucket.count >= rpm) return false;
  bucket.count += 1;
  return true;
};

export interface MapProxyDeps {
  db: TravelMapCredentialDb;
  masterKey: string | null | undefined;
  secret: string;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  upstreamBase?: string;
  /** 每分钟每用户上限；默认 40。 */
  rpm?: number;
  timeoutMs?: number;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
  Vary: 'Origin',
};

const json = (status: number, body: unknown, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
      ...extra,
    },
  });

/** 是否归本代理处理（供 index.ts 在 travel 分支之前判断；兼容挂 `/amsg` 前缀）。 */
export const isAmapServiceProxyPath = (pathname: string): boolean =>
  pathname.includes(AMAP_SERVICE_PREFIX);

const parseProxyPath = (pathname: string): { token: string; endpoint: string } | null => {
  const start = pathname.indexOf(AMAP_SERVICE_PREFIX);
  if (start < 0) return null;
  const prefix = `${AMAP_SERVICE_PREFIX}/t/`;
  const scoped = pathname.slice(start);
  if (!scoped.startsWith(prefix)) return null;
  const rest = scoped.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const token = rest.slice(0, slash);
  const endpoint = rest.slice(slash);
  if (!token || !endpoint) return null;
  return { token, endpoint };
};

/**
 * 处理 `/_AMapService/t/<token>/v3/...`。
 * 返回 null = 不是本端点（调用方继续原有路由）。
 */
export async function handleAmapServiceProxy(
  request: Request,
  deps: MapProxyDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (!isAmapServiceProxyPath(pathname)) return null;

  if (request.method.toUpperCase() === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method.toUpperCase() !== 'GET') return json(405, { error: { code: 'METHOD_NOT_ALLOWED' } });

  const parsed = parseProxyPath(pathname);
  if (!parsed) return json(400, { error: { code: 'BAD_REQUEST' } });

  const nowMs = (deps.now ?? (() => Date.now()))();
  const verified = await verifyTravelMapProxyToken(parsed.token, { secret: deps.secret, nowMs });
  if (!verified.ok) {
    const status = verified.reason.includes('secret') ? 503 : 403;
    return json(status, { error: { code: status === 503 ? 'UNAUTHORIZED' : 'INVALID_CLIENT_TOKEN' } });
  }
  const userId = verified.value.userId;

  if (!AMAP_PROXY_ALLOWED_PATHS.includes(parsed.endpoint)) {
    return json(403, { error: { code: 'ENDPOINT_NOT_ALLOWED' } });
  }

  const rpm = Number.isFinite(deps.rpm ?? NaN) ? Math.max(1, Math.trunc(deps.rpm as number)) : DEFAULT_AMAP_PROXY_RPM;
  if (!takeAmapRateLimit(userId, nowMs, rpm)) {
    return json(429, { error: { code: 'TOO_MANY_REQUESTS' } }, { 'Retry-After': '30' });
  }

  const credentials = await resolveTravelMapCredentialValues({
    db: deps.db,
    userId,
    masterKey: deps.masterKey,
  });
  const jsKey = credentials?.amapJsKey ?? '';
  const jsCode = credentials?.amapJsCode ?? '';
  if (!jsKey || !jsCode) return json(503, { error: { code: 'MAP_NOT_CONFIGURED' } });

  // 参数只允许原样转发（丢客户端自带的 jscode / key），总长度有上限。
  const search = url.search.slice(1);
  if (search.length > 2048) return json(400, { error: { code: 'BAD_REQUEST' } });
  const params = new URLSearchParams(search);
  params.delete('jscode');
  params.set('key', jsKey);
  params.set('jscode', jsCode);

  const base = (deps.upstreamBase ?? AMAP_PROXY_UPSTREAM).replace(/\/+$/, '');
  const controller = new AbortController();
  const timeoutMs = deps.timeoutMs ?? 8000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let upstream: Response;
  try {
    upstream = await (deps.fetch ?? globalThis.fetch)(`${base}${parsed.endpoint}?${params.toString()}`, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
  } catch {
    return json(502, { error: { code: 'PROVIDER_FAILED' } });
  } finally {
    clearTimeout(timer);
  }

  const text = await upstream.text().catch(() => '');
  // 上游回什么就回什么，但**绝不**回显请求参数（key/jscode 不在响应里，也不做拼接）。
  return new Response(text, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}
