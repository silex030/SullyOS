/**
 * 出行 · 高德 Web 服务 REST 中转（鉴权 allowlist，按用户读 **Web 服务** Key）
 *
 * 为什么不是 `_AMapService`：那条通道注入的是 **JS API Key + jscode**，供浏览器 SDK 用；
 * Web 服务 Key 是另一种 Key 类型，混用会拿错凭证去打地理编码/地点检索。两条通道分开，
 * 各自只读自己那类凭证：
 *
 * - `/_AMapService/t/<token>/…` → JS Key + jscode（浏览器 SDK，跨 <script> 带不了 Bearer）
 * - `/travel/map/rest/v3/…`    → Web 服务 Key（本站普通 fetch，带出行会话 Bearer）
 *
 * 安全边界（与 `mapProxy` 同一套思路，不新造信任模型）：
 * 1. **必须已鉴权**：路由层用已签名出行会话解出 userId，这里只按该 userId 读凭证；
 *    请求体/查询里的 `userId` 一律不看，也没有任何「公开中转」形态。
 * 2. **严格 allowlist**：只转发只读的检索/地理编码端点，上游 host 固定 `restapi.amap.com`，
 *    不接受参数指定目标，不用它当开放代理。
 * 3. **Key 只出现在服务端 → 厂商的那一跳**：客户端带来的 `key` / `jscode` 一律丢弃并覆盖，
 *    响应体原样回传（上游不回显 Key），日志/错误文案里没有 Key 片段。
 * 4. **共用限流**：与 JS 代理同一本按用户固定窗口账（同一次外部出口、同一额度的语义）。
 */
import { resolveTravelMapCredentialValues, type TravelMapCredentialDb } from './mapCredentials';
import {
  AMAP_PROXY_ALLOWED_PATHS,
  AMAP_PROXY_UPSTREAM,
  DEFAULT_AMAP_PROXY_RPM,
  takeAmapRateLimit,
} from './mapProxy';

/** 本站 REST 中转前缀（与 travel 路由同源，前端相对路径即可）。 */
export const MAP_REST_PREFIX = '/travel/map/rest';

/**
 * 允许转发的只读端点：JS 代理的白名单 + 输入提示（神经链接地点卡 / 用户档案城市联想）。
 * 不含路径规划（路线由服务端 provider 走预算账本），也不含任何写接口。
 */
export const MAP_REST_ALLOWED_PATHS: readonly string[] = [
  ...AMAP_PROXY_ALLOWED_PATHS,
  '/v3/assistant/inputtips',
];

export interface MapRestDeps {
  db: TravelMapCredentialDb;
  masterKey: string | null | undefined;
  /** 已由路由层验签解出的主体；不存在「客户端自报 userId」的入口。 */
  userId: string;
  nowMs: number;
  fetch?: typeof globalThis.fetch;
  upstreamBase?: string;
  /** 每分钟每用户上限（与 JS 代理共用计数器）。 */
  rpm?: number;
  timeoutMs?: number;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/** 从完整 pathname 里取 `…/travel/map/rest` 之后的端点（兼容挂 `/amsg` 前缀）。 */
export const parseMapRestEndpoint = (pathname: string): string | null => {
  const start = pathname.indexOf(MAP_REST_PREFIX);
  if (start < 0) return null;
  const rest = pathname.slice(start + MAP_REST_PREFIX.length).replace(/\/+$/, '');
  if (!rest.startsWith('/v3/')) return null;
  return rest;
};

/**
 * 处理 `/travel/map/rest/v3/...`。返回 null = 不是本端点（调用方继续原有路由）。
 * 调用方必须**先**完成会话鉴权并把 userId 传进来；这里不会自己去认请求里的身份。
 */
export async function handleMapRestRelay(
  request: Request,
  deps: MapRestDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (!pathname.includes(MAP_REST_PREFIX)) return null;
  if (request.method.toUpperCase() !== 'GET') return json(405, { error: { code: 'METHOD_NOT_ALLOWED' } });

  const endpoint = parseMapRestEndpoint(pathname);
  if (!endpoint) return json(400, { error: { code: 'BAD_REQUEST' } });
  if (!MAP_REST_ALLOWED_PATHS.includes(endpoint)) {
    return json(403, { error: { code: 'ENDPOINT_NOT_ALLOWED' } });
  }

  const rpm = Number.isFinite(deps.rpm ?? NaN)
    ? Math.max(1, Math.trunc(deps.rpm as number))
    : DEFAULT_AMAP_PROXY_RPM;
  if (!takeAmapRateLimit(deps.userId, deps.nowMs, rpm)) {
    return new Response(JSON.stringify({ error: { code: 'TOO_MANY_REQUESTS' } }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Retry-After': '30',
      },
    });
  }

  const credentials = await resolveTravelMapCredentialValues({
    db: deps.db,
    userId: deps.userId,
    masterKey: deps.masterKey,
  });
  const webKey = (credentials?.amapWebKey ?? '').trim();
  if (!webKey) return json(503, { error: { code: 'MAP_NOT_CONFIGURED' } });

  const search = url.search.slice(1);
  if (search.length > 2048) return json(400, { error: { code: 'BAD_REQUEST' } });
  const params = new URLSearchParams(search);
  // 客户端带来的凭证一概丢弃：这条通道只认服务端读到的 Web 服务 Key。
  params.delete('jscode');
  params.delete('key');
  params.set('key', webKey);

  const base = (deps.upstreamBase ?? AMAP_PROXY_UPSTREAM).replace(/\/+$/, '');
  const controller = new AbortController();
  const timeoutMs = deps.timeoutMs ?? 8000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let upstream: Response;
  try {
    upstream = await (deps.fetch ?? globalThis.fetch)(`${base}${endpoint}?${params.toString()}`, {
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
  return new Response(text, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
