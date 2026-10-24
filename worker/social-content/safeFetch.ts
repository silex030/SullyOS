/**
 * 受控抓取：每跳复验 + 解析结果绑定 + 大小/超时/重定向上限（t_2c2dba79，契约 7.1、5.7）。
 *
 * 为什么不用裸 fetch：
 *  1. 裸 fetch 自动跟随重定向，会把"验证过的 URL"换成"没验证的 URL"，是典型 SSRF 绕过；
 *     这里 redirect:'manual' 逐跳验证，最多 5 跳。
 *  2. 裸 fetch 只校验域名，不校验 DNS 解析结果；本模块要求 transport 把连接绑定到
 *     **已验证的公网地址**（防 DNS 重绑定）。环境做不到绑定时必须拒绝该路径，
 *     不能假装安全——见 resolvePinnedTransport()。
 *  3. 裸 fetch 没有响应大小上限，压缩炸弹可以打爆内存；这里边读边截断并显式标记。
 *
 * 依赖注入（resolve/transport/now）让全部行为可离线测试，测试不碰真实网络。
 */

import { SHARE_CONTENT_LIMITS, SHARE_REQUEST_LIMITS } from '../../utils/socialContent/types';
import { assertUrlAllowed, checkResolvedAddresses, SsrfError, type Allowlist } from './security';
import { mapHttpStatus, SocialError } from './errors';

export interface TransportRequest {
  url: string;
  method: 'GET' | 'HEAD';
  headers: Record<string, string>;
  /** 已验证的公网地址；transport 必须绑定其中之一，不得重新解析域名。 */
  pinnedAddresses: string[];
  signal: AbortSignal;
  maxBytes: number;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  readBody: (limitBytes: number) => Promise<{ text: string; bytes: number; truncated: boolean }>;
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export interface SafeFetchDeps {
  /** DNS 解析（每跳都调）。返回全部 A/AAAA 结果。 */
  resolve: (host: string) => Promise<string[]>;
  /** 实际发送请求；必须使用 pinnedAddresses。 */
  transport: Transport;
  now?: () => number;
}

export interface SafeFetchPolicy {
  allowedHosts: Allowlist;
  maxRedirects?: number;
  perRequestTimeoutMs?: number;
  /** 默认按 HTML 上限 2MiB；JSON 接口可传更小值。 */
  maxBytes?: number;
  /** 允许随跳转透传的请求头白名单（Cookie/Authorization 永不跨站转发）。 */
  headers?: Record<string, string>;
}

export interface SafeFetchResult {
  status: number;
  headers: Record<string, string>;
  text: string;
  bytes: number;
  truncated: boolean;
  finalUrl: string;
  hops: number;
  /** 每跳验证过的地址，仅用于内部审计，不返回给客户端。 */
  audit: Array<{ host: string; addresses: string[]; status: number }>;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
/** 跨站跳转禁止携带的敏感头（契约 7.1）。 */
const SENSITIVE_HEADERS = ['cookie', 'authorization', 'x-client-token'];

function withoutSensitive(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.includes(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function isSameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname.toLowerCase() === b.hostname.toLowerCase() && a.port === b.port;
}

function headerValue(headers: Record<string, string>, name: string): string | null {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : null;
}

/**
 * 受控 GET。任何一跳不通过验证即抛出 SocialError；状态码非 2xx 也抛（携带映射后的错误码），
 * 调用方据 error.code 决定状态，不能自行把失败当成功。
 */
export async function safeGet(rawUrl: string, deps: SafeFetchDeps, policy: SafeFetchPolicy): Promise<SafeFetchResult> {
  const maxRedirects = policy.maxRedirects ?? SHARE_REQUEST_LIMITS.maxRedirects;
  const timeoutMs = policy.perRequestTimeoutMs ?? SHARE_REQUEST_LIMITS.perRequestTimeoutMs;
  const maxBytes = policy.maxBytes ?? SHARE_CONTENT_LIMITS.maxHtmlBytes;
  const audit: SafeFetchResult['audit'] = [];

  let current = rawUrl;
  let hops = 0;
  let headers: Record<string, string> = { ...(policy.headers ?? {}), accept: 'text/html,application/json;q=0.9,*/*;q=0.5' };

  for (;;) {
    // 每跳都重新过 URL 策略（域名/协议/端口/白名单）
    let hopUrl: { url: URL; host: string };
    try {
      hopUrl = assertUrlAllowed(current, { allowedHosts: policy.allowedHosts });
    } catch (err) {
      if (err instanceof SsrfError) throw new SocialError(err.code, err.reason);
      throw new SocialError('UNSAFE_URL', 'url_policy_failed');
    }
    const { url, host } = hopUrl;

    let addresses: string[];
    try {
      addresses = await deps.resolve(host);
    } catch {
      throw new SocialError('NETWORK_ERROR', 'dns_failed', { autoRetryable: true });
    }
    const ipCheck = checkResolvedAddresses(addresses);
    if (!ipCheck.ok) throw new SocialError('UNSAFE_URL', `dns_${ipCheck.reason}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: TransportResponse;
    try {
      res = await deps.transport({
        url: url.toString(),
        method: 'GET',
        headers,
        pinnedAddresses: addresses,
        signal: controller.signal,
        maxBytes,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new SocialError('TIMEOUT', 'upstream_timeout', { autoRetryable: true });
      void err;
      throw new SocialError('NETWORK_ERROR', 'transport_failed', { autoRetryable: true });
    } finally {
      clearTimeout(timer);
    }

    audit.push({ host, addresses, status: res.status });

    if (REDIRECT_STATUS.has(res.status)) {
      const location = headerValue(res.headers, 'location');
      if (!location) throw new SocialError('UPSTREAM_CHANGED', 'redirect_without_location');
      hops += 1;
      if (hops > maxRedirects) throw new SocialError('UNSAFE_URL', 'too_many_redirects');
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new SocialError('UNSAFE_URL', 'bad_redirect_location');
      }
      // 跳转目标必须自己再过白名单；原型降级（https→http）直接拒
      if (url.protocol === 'https:' && next.protocol !== 'https:') throw new SocialError('UNSAFE_URL', 'redirect_protocol_downgrade');
      if (!isSameOrigin(url, next)) headers = withoutSensitive(headers);
      current = next.toString();
      continue;
    }

    const mapped = mapHttpStatus(res.status, { retryAfter: headerValue(res.headers, 'retry-after') });
    if (mapped) throw mapped;

    const body = await res.readBody(maxBytes);
    return {
      status: res.status,
      headers: res.headers,
      text: body.text,
      bytes: body.bytes,
      truncated: body.truncated,
      finalUrl: url.toString(),
      hops,
      audit,
    };
  }
}

/**
 * 环境能力探测：只有能把连接绑定到已验证地址的运行时才算"可安全抓取"。
 * 拿不到绑定时返回 null，调用方必须拒绝该路径并返回 SOURCE_NOT_CONFIGURED/UNSAFE_URL，
 * 而不是退回裸 fetch 假装安全（契约 7.1 最后一句）。
 */
export function assertPinningSupported(pinningSupported: boolean): void {
  if (!pinningSupported) throw new SocialError('UNSAFE_URL', 'dns_pinning_unsupported');
}
