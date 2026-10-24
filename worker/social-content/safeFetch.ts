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
 * 期限语义（缺陷 2 的修法）：
 *  - policy.deadline 是**整条链路**的绝对截止时间（DNS + 连接 + 每跳 + 读完正文）。
 *    旧实现只给 transport 挂定时器，DNS 解析和 readBody 完全在预算之外，一个慢 DNS
 *    或慢速滴流的正文就能把 20s 的 resolve 拖过期限。
 *  - 同一笔预算按阶段扣减：DNS 花掉的时间从连接预算里扣掉（连接 timer 只拿剩余），
 *    正文再扣掉 DNS+响应头的时间；任何一段到期都 abort 并释放底层连接，
 *    不会出现“DNS 慢 + 响应头慢”两段各自领满预算、加起来越过 deadline 的情况。
 *  - 到期来源只有一个：响应头一到，连接 timer 立刻 `clearTimeout` 并把剩余预算**移交**给
 *    正文 helper。若两个 timer 同时活着，连接 timer（先注册）通常先触发，它只会 abort 而
 *    不设正文 helper 的 `timedOut`，正文因 abort 拒绝时就会被误判成 NETWORK_ERROR；
 *    因此不允许两段 timer 重叠。
 *  - 没有 deadline 时退化为 perRequestTimeoutMs 的逐跳预算（行为与旧版大致等价，
 *    但正文读取也被预算约束，不再无限等待）。
 *  - 所有分支（重定向、非 2xx、超时、正文读取异步拒绝或同步抛出）都在 try/finally 里清定时器；
 *    需要丢弃响应体时显式 abort + discard，避免 keep-alive 连接被未读响应占住。
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
  /** 可选：主动释放底层连接（不读正文的重定向/错误响应必须调用，避免连接泄漏）。 */
  discard?: () => void;
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
  /** 整条链路（DNS + 连接 + 每跳 + 正文）的绝对截止时间（epoch ms）。 */
  deadline?: number;
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

type BodyChunk = { text: string; bytes: number; truncated: boolean };

/**
 * 错误映射（与旧实现保持一致）：已到期 → TIMEOUT body_timeout；调用方自带的 SocialError 原样透传；
 * 其余一律 NETWORK_ERROR body_read_failed。先判到期，再判 SocialError，顺序不能反。
 */
function mapBodyError(err: unknown, timedOut: boolean): SocialError {
  if (timedOut) return new SocialError('TIMEOUT', 'body_timeout', { autoRetryable: true });
  if (err instanceof SocialError) return err;
  return new SocialError('NETWORK_ERROR', 'body_read_failed', { autoRetryable: true });
}

/**
 * 在预算内读完正文，并保证**任何**退出路径都清掉正文定时器、释放响应（原卡第 2 项「所有路径 finally 释放」）：
 *  - 到期：abort 底层连接 + discard，抛 TIMEOUT body_timeout；
 *  - readBody 异步拒绝：先 abort + discard 再抛错（旧实现只 clearTimeout，socket 留给 GC）；
 *  - readBody **同步**抛出：Promise executor 只会自动 reject，不会走任何清理分支——旧实现此时
 *    bodyTimer 会一直活到期限才触发，等于给一个已失败的调用留下延迟副作用。这里显式 catch。
 *  - 读取成功：不 discard（正文已读完，连接可复用）。
 * 定时器与释放都收在同一个 try/finally 里，失败路径额外做一次释放，两次释放是幂等的（见 released 标记）。
 *
 * 调用约定：进入本函数时**连接阶段的 timer 必须已经清掉**（safeGet 在响应头到达后做移交），
 * 因此这里自己的 timer 是本阶段唯一的到期来源——`timedOut` 不会因为别的 timer abort 而漏设。
 */
async function readBodyWithinBudget(
  res: TransportResponse,
  maxBytes: number,
  budgetMs: number,
  controller: AbortController,
): Promise<BodyChunk> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let released = false;
  // 释放：先 abort（transport 未必理会 signal），再 discard（释放 keep-alive socket）。均幂等。
  const release = () => {
    if (released) return;
    released = true;
    try {
      controller.abort();
    } catch {
      /* 已 abort 或不可 abort 都不影响错误语义 */
    }
    try {
      res.discard?.();
    } catch {
      /* 释放失败不影响错误语义 */
    }
  };

  try {
    return await new Promise<BodyChunk>((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        release();
        reject(new SocialError('TIMEOUT', 'body_timeout', { autoRetryable: true }));
      }, budgetMs);

      let pending: Promise<BodyChunk>;
      try {
        pending = res.readBody(maxBytes);
      } catch (err) {
        // 同步抛出：自己映射并释放，不能指望 executor 的自动 reject 清定时器
        release();
        reject(mapBodyError(err, timedOut));
        return;
      }

      pending.then(
        (value) => resolve(value),
        (err) => {
          // 异步拒绝：即时 abort + discard，避免半读的 socket 活到进程退出
          release();
          reject(mapBodyError(err, timedOut));
        },
      );
    });
  } finally {
    // 成功、失败、到期三种路径都在这里清定时器：不会出现「已失败但定时器还在」的延迟副作用
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 给任意 promise 套一个预算；超时抛 TIMEOUT（调用方按 reason 区分 DNS/正文）。 */
async function withBudget<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SocialError('TIMEOUT', reason, { autoRetryable: true })), Math.max(0, ms));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 受控 GET。任何一跳不通过验证即抛出 SocialError；状态码非 2xx 也抛（携带映射后的错误码），
 * 调用方据 error.code 决定状态，不能自行把失败当成功。
 */
export async function safeGet(rawUrl: string, deps: SafeFetchDeps, policy: SafeFetchPolicy): Promise<SafeFetchResult> {
  const maxRedirects = policy.maxRedirects ?? SHARE_REQUEST_LIMITS.maxRedirects;
  const timeoutMs = policy.perRequestTimeoutMs ?? SHARE_REQUEST_LIMITS.perRequestTimeoutMs;
  const maxBytes = policy.maxBytes ?? SHARE_CONTENT_LIMITS.maxHtmlBytes;
  const now = deps.now ?? (() => Date.now());
  const deadline = typeof policy.deadline === 'number' && Number.isFinite(policy.deadline) ? policy.deadline : null;
  const audit: SafeFetchResult['audit'] = [];

  let current = rawUrl;
  let hops = 0;
  let headers: Record<string, string> = { ...(policy.headers ?? {}), accept: 'text/html,application/json;q=0.9,*/*;q=0.5' };

  for (;;) {
    // 每跳先结算总预算：整条链路（含 DNS/正文）都不能越过 deadline
    const remainingTotal = deadline == null ? Number.POSITIVE_INFINITY : deadline - now();
    if (remainingTotal <= 0) throw new SocialError('TIMEOUT', 'fetch_deadline_exceeded', { autoRetryable: true });
    const hopBudget = Math.min(timeoutMs, remainingTotal);
    const hopStart = now();

    // 每跳都重新过 URL 策略（域名/协议/端口/白名单）
    let hopUrl: { url: URL; host: string };
    try {
      hopUrl = assertUrlAllowed(current, { allowedHosts: policy.allowedHosts });
    } catch (err) {
      if (err instanceof SsrfError) throw new SocialError(err.code, err.reason);
      throw new SocialError('UNSAFE_URL', 'url_policy_failed');
    }
    const { url, host } = hopUrl;

    // DNS 解析也在本跳预算内（旧实现这里完全不设限，慢 DNS 直接拖穿 20s 期限）
    let addresses: string[];
    try {
      addresses = await withBudget(deps.resolve(host), hopBudget, 'dns_timeout');
    } catch (err) {
      if (err instanceof SocialError) throw err;
      throw new SocialError('NETWORK_ERROR', 'dns_failed', { autoRetryable: true });
    }
    const ipCheck = checkResolvedAddresses(addresses);
    if (!ipCheck.ok) throw new SocialError('UNSAFE_URL', `dns_${ipCheck.reason}`);

    const controller = new AbortController();
    // 连接/响应头阶段只能花 DNS 之后**剩余**的预算：不能重新领一份 hopBudget。
    // 旧实现这里又给了一个完整 hopBudget 的 timer，慢 DNS（比如 12s）+ 慢响应头（8s）
    // 就能越过 absolute deadline，而外层 resolver 的 Promise 竞速并不会取消这条连接。
    const afterDns = now();
    const connectBudget = Math.max(
      1,
      Math.min(hopBudget - (afterDns - hopStart), deadline == null ? Number.POSITIVE_INFINITY : deadline - afterDns),
    );
    let connectTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => controller.abort(), connectBudget);
    try {
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
      } catch {
        if (controller.signal.aborted) throw new SocialError('TIMEOUT', 'upstream_timeout', { autoRetryable: true });
        throw new SocialError('NETWORK_ERROR', 'transport_failed', { autoRetryable: true });
      }

      // transport 若忽略 signal 在到期后才把响应头交出来，也不能再读正文：按到期处理并释放。
      if (controller.signal.aborted) {
        res.discard?.();
        throw new SocialError('TIMEOUT', 'upstream_timeout', { autoRetryable: true });
      }

      audit.push({ host, addresses, status: res.status });

      if (REDIRECT_STATUS.has(res.status)) {
        // 不读正文：必须先释放连接，再决定下一跳
        res.discard?.();
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
        // 跳转目标必须自己再过白名单；协议降级（https→http）直接拒
        if (url.protocol === 'https:' && next.protocol !== 'https:') {
          throw new SocialError('UNSAFE_URL', 'redirect_protocol_downgrade');
        }
        if (!isSameOrigin(url, next)) headers = withoutSensitive(headers);
        current = next.toString();
        continue;
      }

      const mapped = mapHttpStatus(res.status, { retryAfter: headerValue(res.headers, 'retry-after') });
      if (mapped) {
        res.discard?.();
        throw mapped;
      }

      // 正文读取仍受同一预算约束：读出前算一次“这跳还剩多少”，不再无限等待
      const consumed = now() - hopStart;
      const bodyBudget = Math.max(
        1,
        Math.min(hopBudget - consumed, deadline == null ? Number.POSITIVE_INFINITY : deadline - now()),
      );
      // 交接：响应头已到，连接 timer 的职责结束，剩余预算交给正文 helper 自己的 timer。
      // 留着它（旧实现）它会先于正文 timer 触发，只 abort、不设 helper 的 `timedOut`；
      // 凡是「正文响应 AbortSignal 并同步/异步拒绝」的 transport（合法实现）就会让真正的
      // 期限到期被 mapBodyError 判成 NETWORK_ERROR/body_read_failed，或透传 transport 自己的码。
      clearTimeout(connectTimer);
      connectTimer = undefined;
      const body = await readBodyWithinBudget(res, maxBytes, bodyBudget, controller);

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
    } finally {
      if (connectTimer !== undefined) clearTimeout(connectTimer);
    }
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
