/**
 * 受控外部只读窗口（服务端唯一出口）
 *
 * 设计原则（安全 lane，别放宽）：
 *   1. **没有任意 URL**：请求体只带 provider + query + fields；目标地址来自运营配置
 *      （`AUTONOMY_EXTERNAL_<PROVIDER>_URL`），并必须同时出现在
 *      `AUTONOMY_EXTERNAL_READ_HOSTS` 与用户授权 grant.allowedHosts 里。三者缺一就拒。
 *   2. **SSRF 硬拦**：只允许 https、默认端口，禁止 URL 内凭据、IP 字面量、localhost /
 *      .local / .internal / 云元数据地址；重定向一律不跟（3xx 即失败），避免被 302 带到内网。
 *   3. **外传内容只有 query**：字段投影只在**响应**侧发生（白名单字段 + 截断），原始响应
 *      不入库、不回包。
 *   4. **配额**：按 (owner, 角色日, provider) 原子自增，超过 `grant.dailyQuota` 直接拒。
 *   5. 未配置端点 = 明确 `CAPABILITY_UNAVAILABLE`，不拿 fixture/假数据冒充「读到了」。
 */

import type { AutonomyLifeErrorCode } from '../../../../contracts/autonomyLife';

export interface ExternalEnv {
  AUTONOMY_EXTERNAL_XHS_URL?: string;
  AUTONOMY_EXTERNAL_AMAP_URL?: string;
  AUTONOMY_EXTERNAL_READ_HOSTS?: string;
}

export type ExternalProvider = 'xhs' | 'amap';

/** 平台侧响应字段白名单（与服务端投影共用；超出即丢弃）。 */
export const EXTERNAL_RESPONSE_FIELDS: Record<ExternalProvider, readonly string[]> = {
  xhs: ['title', 'excerpt', 'author', 'likes', 'url'],
  amap: ['name', 'address', 'distanceM', 'category'],
};

export const EXTERNAL_TIMEOUT_MS = 8_000;
export const EXTERNAL_MAX_BYTES = 256 * 1024;
export const EXTERNAL_MAX_ITEMS = 5;
export const EXTERNAL_MAX_FIELD_CHARS = 200;

export const parseAllowedHosts = (raw: string | undefined, fallback: string[] = []): string[] => {
  const fromEnv = String(raw ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : fallback.map((item) => item.toLowerCase());
};

/** 精确匹配或 `*.` 后缀匹配；不接受通配中间段。 */
export function isHostAllowed(host: string, allowlist: readonly string[]): boolean {
  const target = host.trim().toLowerCase();
  if (!target) return false;
  return allowlist.some((entry) => {
    const rule = entry.toLowerCase();
    if (!rule) return false;
    if (rule.startsWith('*.')) return target === rule.slice(2) || target.endsWith(rule.slice(1));
    return target === rule;
  });
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.localhost', '.home', '.lan'];
const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

/**
 * 目标 URL 的结构性安全校验（不联网）。allowlist 校验在调用方（需要 grant）。
 * 返回 null = 通过；否则返回拒绝原因。
 */
export function assertFetchableUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'https_required' };
  if (url.username || url.password) return { ok: false, reason: 'credentials_in_url_forbidden' };
  if (url.port && url.port !== '443') return { ok: false, reason: 'port_forbidden' };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: 'host_required' };
  if (BLOCKED_HOSTS.has(host)) return { ok: false, reason: 'host_forbidden' };
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return { ok: false, reason: 'host_forbidden' };
  if (IPV4.test(host)) return { ok: false, reason: 'ip_literal_forbidden' };
  if (host.includes(':')) return { ok: false, reason: 'ip_literal_forbidden' };
  return { ok: true, url };
}

/** 单条结果字段投影：白名单 + 标量 + 截断。 */
export function projectItem(
  raw: unknown,
  fields: readonly string[],
  allow: readonly string[],
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const field of fields.slice(0, EXTERNAL_MAX_ITEMS)) {
    if (!allow.includes(field)) continue;
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[field] = value;
    } else if (typeof value === 'string') {
      out[field] = value.length > EXTERNAL_MAX_FIELD_CHARS ? `${value.slice(0, EXTERNAL_MAX_FIELD_CHARS)}…` : value;
    }
  }
  return out;
}

const ITEM_ARRAY_KEYS = ['items', 'data', 'results', 'pois'];

export function extractItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ITEM_ARRAY_KEYS) {
    const value = (payload as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

export interface ExternalReadResult {
  items: Array<Record<string, string | number>>;
  fetchedAt: number;
}

/** 提前拒绝时把响应体关掉，不让慢流继续占着连接与内存。 */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* 已经消费/已关闭：没有可清理的 */
  }
}

/**
 * 流式读响应体，按**字节**计数（不是 JS 字符数）。
 *
 * 为什么不用 `response.text()`：那是一次性全量缓冲，Content-Length 缺失（chunked）时
 * 攻击者/异常上游可以用一个超大响应先把内存吃满，事后再判断长度已经来不及。这里每次
 * `read()` 累加 `byteLength`，一超上限立刻 cancel reader 并拒绝。
 *
 * 超时由调用方的 AbortController 覆盖整个 fetch + body（计时器在读完 body 之后才清），
 * 所以「响应头立刻回来、body 永远不来」也会在 EXTERNAL_TIMEOUT_MS 内被 abort。
 */
export async function readBodyLimited(args: {
  response: Response;
  signal: AbortSignal;
  maxBytes: number;
}): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const body = args.response.body;
  if (!body) return { ok: false, reason: 'external_body_unreadable' };
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let text = '';
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > args.maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'response_too_large' };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    await reader.cancel().catch(() => undefined);
    return {
      ok: false,
      reason: args.signal.aborted ? 'external_timeout' : 'external_body_unreadable',
    };
  }
  return { ok: true, text };
}

export async function handleExternalRead(args: {
  provider: ExternalProvider;
  query: string;
  fields: readonly string[];
  endpoint: string | null;
  allowedHosts: readonly string[];
  fetch?: typeof globalThis.fetch;
  nowMs: number;
  /** 测试可覆盖；默认 EXTERNAL_TIMEOUT_MS。 */
  timeoutMs?: number;
}): Promise<{ ok: true; result: ExternalReadResult } | { ok: false; code: AutonomyLifeErrorCode; reason: string }> {
  const endpoint = String(args.endpoint ?? '').trim();
  if (!endpoint) return { ok: false, code: 'CAPABILITY_UNAVAILABLE', reason: 'external_endpoint_unconfigured' };

  const safe = assertFetchableUrl(endpoint);
  if (!safe.ok) return { ok: false, code: 'POLICY_DENIED', reason: safe.reason };
  if (!isHostAllowed(safe.url.hostname, args.allowedHosts)) {
    return { ok: false, code: 'POLICY_DENIED', reason: 'host_not_allowed' };
  }

  const url = new URL(safe.url.toString());
  url.searchParams.set('q', args.query);

  // 计时器覆盖 fetch + body 全程（只在整段结束后清），否则「头到了 body 不来」会挂死。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? EXTERNAL_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (args.fetch ?? globalThis.fetch)(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return { ok: false, code: 'SERVICE_UNAVAILABLE', reason: 'external_fetch_failed' };
  }

  try {
    // 3xx 一律不跟：重定向是绕过 allowlist 的经典手法。
    if (response.status >= 300 && response.status < 400) {
      await discardBody(response);
      return { ok: false, code: 'POLICY_DENIED', reason: 'redirect_not_followed' };
    }
    if (!response.ok) {
      await discardBody(response);
      return { ok: false, code: 'SERVICE_UNAVAILABLE', reason: `external_http_${response.status}` };
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > EXTERNAL_MAX_BYTES) {
      await discardBody(response);
      return { ok: false, code: 'SERVICE_UNAVAILABLE', reason: 'response_too_large' };
    }
    const limited = await readBodyLimited({
      response,
      signal: controller.signal,
      maxBytes: EXTERNAL_MAX_BYTES,
    });
    if (!limited.ok) {
      return { ok: false, code: 'SERVICE_UNAVAILABLE', reason: limited.reason };
    }
    return finishRead({ text: limited.text, provider: args.provider, fields: args.fields, nowMs: args.nowMs });
  } finally {
    clearTimeout(timer);
  }
}

function finishRead(args: {
  text: string;
  provider: ExternalProvider;
  fields: readonly string[];
  nowMs: number;
}): { ok: true; result: ExternalReadResult } | { ok: false; code: AutonomyLifeErrorCode; reason: string } {
  const text = args.text;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, code: 'SERVICE_UNAVAILABLE', reason: 'external_not_json' };
  }
  const allow = EXTERNAL_RESPONSE_FIELDS[args.provider];
  const fields = args.fields.filter((field) => allow.includes(field));
  const items = extractItems(payload)
    .slice(0, EXTERNAL_MAX_ITEMS)
    .map((row) => projectItem(row, fields, allow))
    .filter((row) => Object.keys(row).length > 0);
  return { ok: true, result: { items, fetchedAt: args.nowMs } };
}

/*
 * 配额核销**只**有 `store.consumeExternalQuotaAtomic` 一个入口（`/external/*` 与旧链路共用）。
 * 早先这里还有一个 `consumeExternalQuota({ limit })`：额度由调用方读边界时的旧
 * `grant.dailyQuota` 传入，语句里既没有边界 revision 也没有「未过期授权」条件，
 * 于是「许可核销之后、额度语句执行之前」收紧额度/撤权/暂停仍会按旧值放行。
 * 该函数已删除，不留第二套不安全入口。
 */

export async function insertTravelWish(args: {
  db: { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } } };
  ownerId: string;
  charId: string;
  text: string;
  grantId: string;
  nowMs: number;
}): Promise<{ wishId: string }> {
  const wishId = `wish_${args.nowMs.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await args.db
    .prepare('INSERT INTO autonomy_life_wishes (owner_id, id, char_id, text, grant_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(args.ownerId, wishId, args.charId, args.text, args.grantId, args.nowMs)
    .run();
  return { wishId };
}
