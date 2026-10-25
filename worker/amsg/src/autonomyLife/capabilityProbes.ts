/**
 * 能力探测的生产口径：外部窗口「配没配 / 通不通」不再写死 false。
 *
 * 以前 `tick.ts` 把 `externalRead/map` 的 configured/reachable 硬编码成 false，
 * 结果就是「运营配好了端点、用户也授权了，角色仍然永远看不到外部窗口」。这里把它
 * 改成读**真实配置**（`AUTONOMY_EXTERNAL_*` 环境变量）+ 一次**有界、带缓存**的
 * 可达性探测：
 *   - 只有该角色当前**允许**这个 kind 且**授权未过期**时才探测（没授权就别去敲别人的门）；
 *   - 探测只判断「对方有没有 HTTP 响应」（任何状态码都算可达，3xx/404 也算——可达性
 *     不等于业务成功）；网络错误/超时/结构性不安全 URL → 不可达；
 *   - 缓存 10 分钟、最多 16 条，避免每分钟 cron 对外部端点刷请求。
 *
 * 真正的读取仍在 `/external/read` 服务端出口做（白名单 + 配额 + 一次性许可）；
 * 这里的结果只用于「能不能把外部窗口放进候选」。
 */

import { assertFetchableUrl, parseAllowedHosts } from './external';

export interface ExternalRuntimeConfig {
  /** 小红书式只读端点（运营配置）。 */
  xhsUrl: string;
  /** 地图端点（出行愿望）。 */
  amapUrl: string;
  /** 服务端出口主机白名单。 */
  readHosts: string[];
}

export const EMPTY_EXTERNAL_CONFIG: ExternalRuntimeConfig = { xhsUrl: '', amapUrl: '', readHosts: [] };

export interface ExternalEnvLike {
  AUTONOMY_EXTERNAL_XHS_URL?: string;
  AUTONOMY_EXTERNAL_AMAP_URL?: string;
  AUTONOMY_EXTERNAL_READ_HOSTS?: string;
}

export function externalConfigFromEnv(env: ExternalEnvLike | null | undefined): ExternalRuntimeConfig {
  return {
    xhsUrl: String(env?.AUTONOMY_EXTERNAL_XHS_URL ?? '').trim(),
    amapUrl: String(env?.AUTONOMY_EXTERNAL_AMAP_URL ?? '').trim(),
    readHosts: parseAllowedHosts(env?.AUTONOMY_EXTERNAL_READ_HOSTS),
  };
}

export interface ExternalConfigInput {
  xhsUrl?: string;
  amapUrl?: string;
  readHosts?: string[] | string;
}

export function externalConfigFromInput(input: ExternalConfigInput | null | undefined): ExternalRuntimeConfig {
  const hosts = Array.isArray(input?.readHosts)
    ? input!.readHosts.map((host) => String(host).trim().toLowerCase()).filter(Boolean)
    : parseAllowedHosts(typeof input?.readHosts === 'string' ? input.readHosts : undefined);
  return {
    xhsUrl: String(input?.xhsUrl ?? '').trim(),
    amapUrl: String(input?.amapUrl ?? '').trim(),
    readHosts: hosts,
  };
}

/** 端点配置完整才算 configured：URL 存在 + 主机白名单非空 + URL 结构安全。 */
export function isEndpointConfigured(url: string, hosts: readonly string[]): boolean {
  const raw = String(url ?? '').trim();
  if (!raw || hosts.length === 0) return false;
  return assertFetchableUrl(raw).ok;
}

export const REACHABILITY_TIMEOUT_MS = 3_000;
export const REACHABILITY_TTL_MS = 10 * 60_000;

const nowMsDefault = (): number => Date.now();

/**
 * 真实可达性探测：一次 GET，只要拿到 HTTP 响应就算可达。
 * 不跟随重定向、不读 body（避免把探测变成一次完整读取），失败一律 false。
 */
export async function probeEndpointOnce(
  url: string,
  options?: { fetch?: typeof globalThis.fetch; timeoutMs?: number },
): Promise<boolean> {
  const safe = assertFetchableUrl(url);
  if (!safe.ok) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, options?.timeoutMs ?? REACHABILITY_TIMEOUT_MS));
  try {
    const response = await (options?.fetch ?? globalThis.fetch)(safe.url.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    try {
      await response.body?.cancel();
    } catch {
      /* 已消费/已关闭：探测不关心 body */
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface ReachabilityProbe {
  (url: string): Promise<boolean>;
}

/** 带 TTL 缓存的探测：同一端点 10 分钟内只探一次（含失败结果，避免每分钟重试）。 */
export function createReachabilityProbe(options?: {
  fetch?: typeof globalThis.fetch;
  ttlMs?: number;
  now?: () => number;
  timeoutMs?: number;
  maxEntries?: number;
}): ReachabilityProbe {
  const ttl = Math.max(1_000, options?.ttlMs ?? REACHABILITY_TTL_MS);
  const now = options?.now ?? nowMsDefault;
  const maxEntries = Math.max(1, options?.maxEntries ?? 16);
  const cache = new Map<string, { at: number; reachable: boolean }>();

  return async (url: string): Promise<boolean> => {
    const key = String(url ?? '').trim();
    if (!key) return false;
    const hit = cache.get(key);
    const at = now();
    if (hit && at - hit.at < ttl) return hit.reachable;
    const reachable = await probeEndpointOnce(key, { fetch: options?.fetch, timeoutMs: options?.timeoutMs });
    cache.set(key, { at, reachable });
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return reachable;
  };
}

/** 进程级默认探测（cron 每跳共用一份缓存）。 */
export const defaultReachabilityProbe: ReachabilityProbe = createReachabilityProbe();
