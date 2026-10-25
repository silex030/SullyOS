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

import { assertFetchableUrl, isHostAllowed, parseAllowedHosts } from './external';
import { hashString } from '../../../../contracts/autonomyLife';

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

/** 端点配置完整才算 configured：URL 存在 + 主机白名单非空 + URL 结构安全 + **目标主机真的在白名单里**。 */
export function isEndpointConfigured(url: string, hosts: readonly string[]): boolean {
  const raw = String(url ?? '').trim();
  if (!raw || hosts.length === 0) return false;
  const safe = assertFetchableUrl(raw);
  if (!safe.ok) return false;
  // 只判断「白名单非空」是不够的：端点可以指向白名单外的主机，下面的探测就成了绕过
  // 运营白名单的新出网口。结构安全 + 主机在白名单里，两者都成立才算配好。
  return isHostAllowed(safe.url.hostname, hosts);
}

/**
 * 探测授权判定（**任何网络请求之前**必须过这一关，与正式 `/external/read` 同一套边界）：
 *   - 暂停 / kind 未开 → 不探；
 *   - 运营白名单（`AUTONOMY_EXTERNAL_READ_HOSTS`）为空或不含目标主机 → 不探；
 *   - 用户授权缺失 / 过期 / 没授权这个主机 / read 模式没有 `read:search` scope → 不探。
 *
 * 通过的返回值里带一个 `signature`：缓存必须按「端点 + 这份授权」分键，
 * 撤权/换授权/改主机之后不会命中上一次的「可达」结果。
 */
export type ProbeDenyReason =
  | 'paused'
  | 'kind_not_allowed'
  | 'unconfigured'
  | 'unsafe_url'
  | 'operator_host_not_allowed'
  | 'grant_missing'
  | 'grant_expired'
  | 'grant_host_not_allowed'
  | 'scope_not_granted';

export interface ProbeGrantLike {
  provider?: string;
  scopes?: readonly string[];
  allowedHosts?: readonly string[];
  expiresAt?: number;
}

export interface ProbeAuthorizationInput {
  endpoint: string;
  /** 运营白名单（`AUTONOMY_EXTERNAL_READ_HOSTS`）。 */
  readHosts: readonly string[];
  grant: ProbeGrantLike | null | undefined;
  provider: 'xhs' | 'amap';
  /** read = external.read；wish = travel.wish（后者只落愿望，不出网读）。 */
  mode: 'read' | 'wish';
  kind: 'external.read' | 'travel.wish';
  allowedKinds: readonly string[];
  paused: boolean;
  nowMs: number;
}

export type ProbeAuthorization =
  | { ok: true; url: string; host: string; signature: string }
  | { ok: false; reason: ProbeDenyReason };

export function authorizeProbe(input: ProbeAuthorizationInput): ProbeAuthorization {
  if (input.paused) return { ok: false, reason: 'paused' };
  if (!input.allowedKinds.includes(input.kind)) return { ok: false, reason: 'kind_not_allowed' };

  const endpoint = String(input.endpoint ?? '').trim();
  if (!endpoint || input.readHosts.length === 0) return { ok: false, reason: 'unconfigured' };
  const safe = assertFetchableUrl(endpoint);
  if (!safe.ok) return { ok: false, reason: 'unsafe_url' };
  const host = safe.url.hostname.toLowerCase();
  if (!isHostAllowed(host, input.readHosts)) return { ok: false, reason: 'operator_host_not_allowed' };

  const grant = input.grant;
  if (!grant || (grant.provider !== undefined && grant.provider !== input.provider)) {
    return { ok: false, reason: 'grant_missing' };
  }
  const expiresAt = typeof grant.expiresAt === 'number' ? grant.expiresAt : Number.NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= input.nowMs) return { ok: false, reason: 'grant_expired' };

  const grantHosts = Array.isArray(grant.allowedHosts) ? grant.allowedHosts : [];
  if (!isHostAllowed(host, grantHosts)) return { ok: false, reason: 'grant_host_not_allowed' };

  const scopes = Array.isArray(grant.scopes) ? grant.scopes : [];
  // 与正式 read 出口同一口径：scopes 为空视为「未细化」，非空必须含 read:search。
  if (input.mode === 'read' && scopes.length > 0 && !scopes.includes('read:search')) {
    return { ok: false, reason: 'scope_not_granted' };
  }

  return {
    ok: true,
    url: safe.url.toString(),
    host,
    signature: hashString(`${host}|${expiresAt}|${grantHosts.join(',')}|${scopes.join(',')}|${input.mode}`),
  };
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
  /**
   * 探测端点是否可达。`authKey` 是**授权指纹**（authorizeProbe 的 signature）：
   * 缓存按「端点 + 授权指纹」分键，撤权/换授权后不会命中旧结果。
   */
  (url: string, authKey?: string): Promise<boolean>;
}

/**
 * 带 TTL 缓存的探测：同一「端点 + 授权指纹」10 分钟内只探一次（含失败结果）。
 *
 * 调用上限（为什么不计量：这是健康检查，不是一次角色外部读取）
 *   - 只发 GET、不跟随重定向、不读 body、不带 query，不落任何内容；
 *   - 每端点每授权最多 10 分钟 1 次（TTL），每次 3 秒超时；
 *   - 每跳 cron 最多两个端点（一个 provider 一个，见 resolveProbes），且只在
 *     「未暂停 + kind 允许 + 运营白名单 + 用户授权都成立」时才调用；
 *   - 因此它不消耗 `external_usage` 的每日读取额度，也不进入模型预算。
 * 换句话说：**未授权/撤销/暂停时零网络请求**，授权成立时才是有界的健康检查。
 */
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

  return async (url: string, authKey?: string): Promise<boolean> => {
    const key = String(url ?? '').trim();
    if (!key) return false;
    const cacheKey = `${key}|${authKey ?? ''}`;
    const hit = cache.get(cacheKey);
    const at = now();
    if (hit && at - hit.at < ttl) return hit.reachable;
    const reachable = await probeEndpointOnce(key, { fetch: options?.fetch, timeoutMs: options?.timeoutMs });
    cache.set(cacheKey, { at, reachable });
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
