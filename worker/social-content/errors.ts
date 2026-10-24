/**
 * 解析流程的结构化错误（t_2c2dba79，契约 3.7）。
 *
 * 规则：所有对外错误必须是契约 error code 集合里的成员；reason 只做服务端诊断，
 * 不含原始 URL、签名参数、Cookie 或上游原文。不可重试的错误自动重试没有任何意义
 * （契约 7.2：认证/付费/地区/风控不换策略重试）。
 */

import type { ShareError, ShareErrorCode } from '../../utils/socialContent/types';

/** 这些错误码只允许在人工 retry 后重试，自动重试会直接放弃（契约 7.2）。 */
const NEVER_AUTO_RETRY: ReadonlySet<ShareErrorCode> = new Set<ShareErrorCode>([
  'AUTH_REQUIRED',
  'SOURCE_NOT_CONFIGURED',
  'ACCESS_DENIED',
  'PAYWALL',
  'REGION_RESTRICTED',
  'CONTENT_NOT_FOUND',
  'CONTENT_DELETED',
  'UNSUPPORTED_PLATFORM',
  'UNSUPPORTED_LINK_TYPE',
  'UNSUPPORTED_REGION_OR_PRODUCT',
  'INVALID_URL',
  'UNSAFE_URL',
  'SIZE_LIMIT',
  'PERSISTENCE_UNAVAILABLE',
  'CANCELLED',
]);

/** 默认用户文案：不出现上游细节、不出现内部地址，也不假装成功。 */
const USER_MESSAGE: Record<ShareErrorCode, string> = {
  INVALID_URL: '这个链接格式不合法，已跳过',
  UNSUPPORTED_PLATFORM: '暂不支持这个站点',
  UNSUPPORTED_LINK_TYPE: '这个链接不是可解析的内容页',
  UNSUPPORTED_REGION_OR_PRODUCT: '这个产品不在支持范围内',
  AUTH_REQUIRED: '该内容需要登录才能读取',
  SOURCE_NOT_CONFIGURED: '该来源尚未配置',
  ACCESS_DENIED: '来源拒绝访问该内容',
  PAYWALL: '该内容需要付费才能读取',
  REGION_RESTRICTED: '该内容在当前地区不可用',
  RATE_LIMITED: '来源限流，稍后再试',
  CONTENT_NOT_FOUND: '内容不存在或链接已失效',
  CONTENT_DELETED: '内容已被删除',
  TIMEOUT: '读取超时',
  NETWORK_ERROR: '网络错误，未能读取内容',
  UPSTREAM_CHANGED: '来源页面结构变化，暂时读不到',
  UNSAFE_URL: '链接未通过安全校验，已阻止访问',
  SIZE_LIMIT: '内容或链接数量超过上限',
  PERSISTENCE_UNAVAILABLE: '内容存储暂不可用',
  CANCELLED: '解析已取消',
};

export class SocialError extends Error {
  readonly code: ShareErrorCode;
  readonly reason: string;
  readonly retryAfterMs: number | null;
  readonly autoRetryable: boolean;

  constructor(code: ShareErrorCode, reason: string, opts: { retryAfterMs?: number | null; autoRetryable?: boolean } = {}) {
    super(`${code}:${reason}`);
    this.name = 'SocialError';
    this.code = code;
    this.reason = reason;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.autoRetryable = opts.autoRetryable ?? (!NEVER_AUTO_RETRY.has(code) && code !== 'CANCELLED');
  }

  /** 转成契约的 error 结构；safeDiagnosticId 由服务层补，避免这里编随机数。 */
  toShareError(safeDiagnosticId: string | null = null): ShareError {
    return {
      code: this.code,
      // retryable 表示"允许人工 retry"，自动重试看 autoRetryable
      retryable: !NEVER_AUTO_RETRY.has(this.code),
      retryAfterMs: this.retryAfterMs,
      userMessage: USER_MESSAGE[this.code],
      safeDiagnosticId,
    };
  }
}

/** HTTP 状态 → 契约错误码；不认识的状态统一按上游错误处理，不伪装成功。 */
export function mapHttpStatus(status: number, headers?: { retryAfter?: string | null }): SocialError | null {
  if (status >= 200 && status < 300) return null;
  switch (status) {
    case 401:
      return new SocialError('AUTH_REQUIRED', 'http_401');
    case 403:
      return new SocialError('ACCESS_DENIED', 'http_403');
    case 404:
      return new SocialError('CONTENT_NOT_FOUND', 'http_404');
    case 410:
      return new SocialError('CONTENT_DELETED', 'http_410');
    case 451:
      return new SocialError('REGION_RESTRICTED', 'http_451');
    case 402:
      return new SocialError('PAYWALL', 'http_402');
    case 412:
      // B 站等平台用 412 表达风控预检失败；不是"内容变了"，是拒绝了这次访问
      return new SocialError('ACCESS_DENIED', 'http_412');
    case 429: {
      const ms = parseRetryAfterMs(headers?.retryAfter ?? null);
      return new SocialError('RATE_LIMITED', 'http_429', { retryAfterMs: ms });
    }
    default:
      if (status >= 500) return new SocialError('NETWORK_ERROR', `http_${status}`, { autoRetryable: status === 502 || status === 503 || status === 504 });
      return new SocialError('UPSTREAM_CHANGED', `http_${status}`);
  }
}

/** Retry-After 支持秒数与 HTTP-date；无法解析返回 null，不瞎猜。 */
export function parseRetryAfterMs(raw: string | null, now: number = Date.now()): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d{1,6}$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/** 版本冲突（409）：retry 的 expectedRevision 与库中不一致，或摘录请求的 contentRevision 过期。 */
export class RevisionConflictError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`REVISION_CONFLICT:${reason}`);
    this.name = 'RevisionConflictError';
    this.reason = reason;
  }
}

/** 摘录版本不可用（契约 4.5 明确返回 VERSION_UNAVAILABLE，不混新正文）。 */
export class VersionUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`VERSION_UNAVAILABLE:${reason}`);
    this.name = 'VersionUnavailableError';
    this.reason = reason;
  }
}

/** 把任意异常收敛成 SocialError，避免把上游细节（URL/堆栈）泄给客户端。 */
export function asSocialError(err: unknown): SocialError {
  if (err instanceof SocialError) return err;
  const name = (err as { name?: string } | null)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return new SocialError('TIMEOUT', 'aborted');
  return new SocialError('NETWORK_ERROR', 'unexpected');
}
