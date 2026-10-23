/**
 * 出行 · 同源静态图端点（`GET /travel/staticmap`）
 *
 * 为什么要有它：聊天卡里的缩略图不能直接把高德 Web 服务 Key 拼进 `<img src>`——
 * URL 会进浏览器历史、进日志、进 referer，而且 Bearer 绝不能出现在 URL 里。
 * 所以这里做三件事：
 *
 * 1. **短期签名，不放 Bearer**：URL 只带 `u`（用户作用域的不透明摘要）、`c`、`e`（过期时间）
 *    与 `s`（HMAC）。签名钥复用 `TRAVEL_SESSION_SECRET`（域分隔标签不同）。URL 泄露最多
 *    在 TTL 内看到**仍然开着共享**的那一趟行程缩略图，且换不了别的角色。
 * 2. **每次都回查共享位**：签名有效不等于共享还开着。共享撤销后同一个 URL 立即失效
 *    （403 + `SHARE_REVOKED`），不靠 CDN/浏览器缓存兜底 —— 响应固定 `Cache-Control: no-store`。
 * 3. **计量**：一次静态图 = 一次真实地图请求，走 `reserveMapCall` 扣同一本账；
 *    没额度就不请求上游（返回 429/`BUDGET_ZERO`），失败不退款（请求已经发出去了）。
 *
 * 边界：本模块只做「显示」。几何落库与否仍只看 `TRAVEL_GEOMETRY_LICENSE`，
 * 两条授权线互不顶替（见 docs/travel-contract.md）。
 */

import type { TravelCoordSys } from '../../../../contracts/travel';
import { reserveMapCall, resolveTravelBudgetGate } from './budget';
import {
  getTravelAnchor,
  getTravelShareState,
  getActiveTravelTrip,
  type TravelDb,
} from './store';

export const TRAVEL_STATICMAP_PATH = '/travel/staticmap';
export const TRAVEL_STATICMAP_TTL_MS = 5 * 60_000;
export const TRAVEL_STATICMAP_MAX_TTL_MS = 15 * 60_000;

const encoder = new TextEncoder();
const SIGN_LABEL = 'sullyos-travel-staticmap-v1';

export interface StaticMapDeps {
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  /** 上游地址（测试注入；生产固定官方 restapi）。 */
  upstreamBase?: string;
}

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

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** URL 里的用户作用域：不透明编码（不是凭据，凭据只有 Bearer/ownerKey，永不进 URL）。 */
export const encodeStaticMapUser = (userId: string): string =>
  toBase64Url(encoder.encode(`u:${userId}`));

export const decodeStaticMapUser = (encoded: string): string | null => {
  const bytes = fromBase64Url(encoded);
  if (!bytes) return null;
  const text = new TextDecoder().decode(bytes);
  if (!text.startsWith('u:')) return null;
  const userId = text.slice(2).trim();
  return userId && userId.length <= 128 && !/[\u0000-\u001f]/.test(userId) ? userId : null;
};

/** 旧形状的用户作用域摘要（保留给回归用；新 URL 用 {@link encodeStaticMapUser}）。 */
export const staticMapUserTag = (userId: string): Promise<string> => sha256Hex(`${SIGN_LABEL}:u:${userId}`);

const hmacKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);

const sign = async (secret: string, payload: string): Promise<string> =>
  toBase64Url(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload)),
    ),
  );

export interface StaticMapUrlInput {
  userId: string;
  charId: string;
  secret: string;
  nowMs: number;
  ttlMs?: number;
  width?: number;
  height?: number;
  coordSys?: TravelCoordSys;
}

/**
 * 生成同源缩略图 URL（相对路径 + 短期签名）。密钥缺失 → null（调用方就别给 URL，
 * 组件会自动降级成文字卡，不画假地图）。
 */
export async function buildStaticMapUrl(input: StaticMapUrlInput): Promise<string | null> {
  const secret = (input.secret ?? '').trim();
  if (secret.length < 32) return null;
  const ttl = Math.min(Math.max(Math.trunc(input.ttlMs ?? TRAVEL_STATICMAP_TTL_MS), 30_000), TRAVEL_STATICMAP_MAX_TTL_MS);
  const exp = Math.trunc(input.nowMs) + ttl;
  const width = Math.min(Math.max(Math.trunc(input.width ?? 480), 120), 720);
  const height = Math.min(Math.max(Math.trunc(input.height ?? 240), 120), 720);
  const tag = encodeStaticMapUser(input.userId);
  const payload = `${tag}.${input.charId}.${exp}.${width}.${height}`;
  const signature = await sign(secret, payload);
  const query = new URLSearchParams({
    u: tag,
    c: input.charId,
    e: String(exp),
    w: String(width),
    h: String(height),
    s: signature,
  });
  return `${TRAVEL_STATICMAP_PATH}?${query.toString()}`;
}

export interface StaticMapVerifyResult {
  ok: boolean;
  status?: number;
  code?: string;
  reason?: string;
  charId?: string;
  userTag?: string;
  width?: number;
  height?: number;
}

/** 校验签名与过期时间。域分隔标签不同 → 会话 token 不能拿来当图片签名。 */
export async function verifyStaticMapRequest(
  url: URL,
  input: { secret: string; userId: string; nowMs: number },
): Promise<StaticMapVerifyResult> {
  const secret = (input.secret ?? '').trim();
  if (secret.length < 32) return { ok: false, status: 503, code: 'UNAUTHORIZED', reason: 'staticmap-secret-unconfigured' };
  const tag = url.searchParams.get('u') ?? '';
  const charId = url.searchParams.get('c') ?? '';
  const exp = Number(url.searchParams.get('e'));
  const width = Number(url.searchParams.get('w'));
  const height = Number(url.searchParams.get('h'));
  const signature = url.searchParams.get('s') ?? '';
  if (!tag || !charId || !Number.isFinite(exp) || !Number.isFinite(width) || !Number.isFinite(height) || !signature) {
    return { ok: false, status: 400, code: 'UNAUTHORIZED', reason: 'staticmap-malformed' };
  }
  if (exp <= input.nowMs) return { ok: false, status: 403, code: 'UNAUTHORIZED', reason: 'staticmap-expired' };
  if (exp - input.nowMs > TRAVEL_STATICMAP_MAX_TTL_MS + 60_000) {
    return { ok: false, status: 400, code: 'UNAUTHORIZED', reason: 'staticmap-ttl-invalid' };
  }
  const expected = await sign(secret, `${tag}.${charId}.${Math.trunc(exp)}.${Math.trunc(width)}.${Math.trunc(height)}`);
  if (expected.length !== signature.length) {
    return { ok: false, status: 403, code: 'UNAUTHORIZED', reason: 'staticmap-signature-invalid' };
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (diff !== 0) return { ok: false, status: 403, code: 'UNAUTHORIZED', reason: 'staticmap-signature-invalid' };
  const signedUser = decodeStaticMapUser(tag);
  if (!signedUser || signedUser !== input.userId) {
    return { ok: false, status: 403, code: 'UNAUTHORIZED', reason: 'staticmap-user-mismatch' };
  }
  return {
    ok: true,
    charId,
    userTag: tag,
    width: Math.min(Math.max(Math.trunc(width), 120), 720),
    height: Math.min(Math.max(Math.trunc(height), 120), 720),
  };
}

const NO_STORE: Record<string, string> = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
  'Content-Type': 'application/json; charset=utf-8',
};

const jsonNoStore = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: NO_STORE });

/**
 * 真正的端点实现。`buildStaticMapUrl` 产出的 URL 打回这里。
 * 顺序刻意是「验签 → 回查共享 → 查预算 → 取几何 → 请求上游」：任何一步不过都不花额度。
 */
export async function handleTravelStaticMap(
  request: Request,
  env: { DB?: unknown; AMAP_WEB_KEY?: string; [key: string]: unknown } | null | undefined,
  deps: StaticMapDeps & { userId: string | null; sessionSecret: string },
): Promise<Response> {
  const nowMs = (deps.now ?? (() => Date.now()))();
  const db = env?.DB as TravelDb | undefined;
  if (!db) return jsonNoStore(503, { error: { code: 'PROVIDER_FAILED' } });

  // 图片 URL 不带 Bearer：主体从签名里的不透明用户段解出来，再由 HMAC 绑定。
  const url = new URL(request.url);
  const userId = deps.userId ?? decodeStaticMapUser(url.searchParams.get('u') ?? '');
  if (!userId) return jsonNoStore(401, { error: { code: 'UNAUTHORIZED' } });

  const verified = await verifyStaticMapRequest(url, {
    secret: deps.sessionSecret,
    userId,
    nowMs,
  });
  if (!verified.ok || !verified.charId) {
    return jsonNoStore(verified.status ?? 403, {
      error: { code: 'UNAUTHORIZED', detail: verified.reason ?? 'staticmap-invalid' },
    });
  }
  const charId = verified.charId;

  // 共享撤销立即生效：签名还没到期也不给图。
  const share = await getTravelShareState(db, { userId, charId });
  if (!share?.shareEnabled) {
    return jsonNoStore(403, { error: { code: 'SHARE_REVOKED' } });
  }

  // 配置缺口先报：缺 Web 服务 Key 是「没配」，不是「没有行程」。
  const key = String(env?.AMAP_WEB_KEY ?? '').trim();
  if (!key) return jsonNoStore(503, { error: { code: 'PROVIDER_FAILED' } });

  const trip = await getActiveTravelTrip(db, { userId, charId });
  if (!trip) return jsonNoStore(404, { error: { code: 'ROUTE_UNAVAILABLE' } });

  // 静态图 = 一次真实地图请求，先过闸门再扣档；失败不退款。
  const gate = await resolveTravelBudgetGate(db, { userId, nowMs, kind: 'map' });
  if (!gate.allowed) {
    return jsonNoStore(429, { error: { code: gate.code } });
  }

  // 中心点：优先目的地（缩略图看「TA 要去哪」），其次锚点；都没有就不出图。
  const anchor = await getTravelAnchor(db, { userId, charId });
  const center = trip.dest ?? (anchor ? { lat: anchor.lat, lng: anchor.lng } : null);
  if (!center) return jsonNoStore(404, { error: { code: 'ANCHOR_NOT_CONFIRMED' } });

  const reserved = await reserveMapCall(db, { userId, nowMs });
  if (!reserved.ok) return jsonNoStore(429, { error: { code: reserved.code } });

  const base = (deps.upstreamBase ?? 'https://restapi.amap.com').replace(/\/+$/, '');
  const params = new URLSearchParams({
    location: `${center.lng.toFixed(6)},${center.lat.toFixed(6)}`,
    zoom: '15',
    size: `${verified.width ?? 480}*${verified.height ?? 240}`,
    scale: '2',
    key,
  });
  try {
    const upstream = await (deps.fetch ?? globalThis.fetch)(
      `${base}/v3/staticmap?${params.toString()}`,
      { method: 'GET' },
    );
    if (!upstream.ok) return jsonNoStore(502, { error: { code: 'PROVIDER_FAILED' } });
    const contentType = upstream.headers.get('Content-Type') ?? '';
    if (!contentType.startsWith('image/')) {
      // 高德在 Key/权限不对时会回 JSON 200；不能把那段 JSON 当图片塞给前端。
      return jsonNoStore(502, { error: { code: 'PROVIDER_FAILED' } });
    }
    const bytes = await upstream.arrayBuffer();
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        Pragma: 'no-cache',
      },
    });
  } catch {
    return jsonNoStore(502, { error: { code: 'PROVIDER_FAILED' } });
  }
}
