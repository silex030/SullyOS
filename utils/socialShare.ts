/**
 * 链接分享（小红书 / 抖音 / B站）客户端接线（集成卡 t_babca897）。
 *
 * 职责边界：
 *  - 发送前：识别混合文本里的平台链接（复用父卡 utils/socialContent/links 的纯识别器）；
 *  - 发送后：调用主代理反代的 /agent/v1/social/shares/resolve，把卡状态合并进消息 metadata；
 *  - 后续轮次：把每个链接替换成 shareRef + 冻结简介（有界投影），保留用户问题；
 *  - 按需检索：调 /items/:contentId/excerpts 拿有预算的片段。
 *
 * 开关：localStorage 的 os_social_share_config.enabled（默认 false）。服务端还有一道
 * SHARE_LINKS_ENABLED；两边都开才生效，服务端关时 resolve 返回 503 SHARE_LINKS_DISABLED，
 * 本模块把错误如实带回，不伪装成功。
 *
 * 失败语义：网络/超时/未配置 → 返回 { ok:false, reason }，调用方保留原消息、不建假卡；
 * 平台受限 → ok:true 但附件 state=failed + error.code（这是“读过了但被平台挡住”的真实结果）。
 */

import { SHARE_BUDGETS, SHARE_REQUEST_LIMITS, type ShareAttachment } from './socialContent/types';
import { extractShareLinks } from './socialContent/links';
import { readAgentRoutingConfig } from './agentRouting';

export const SOCIAL_SHARE_CONFIG_KEY = 'os_social_share_config';

export interface SocialShareConfig {
  enabled: boolean;
  /** 显式覆盖主代理地址（缺省用 os_api_config.agentUrl）。 */
  baseUrl: string;
  token: string;
}

export function readSocialShareConfig(): SocialShareConfig {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SOCIAL_SHARE_CONFIG_KEY) : null;
    if (!raw) return { enabled: false, baseUrl: '', token: '' };
    const cfg = JSON.parse(raw);
    return {
      enabled: cfg?.enabled === true,
      baseUrl: String(cfg?.baseUrl || '').trim(),
      token: String(cfg?.token || '').trim(),
    };
  } catch {
    return { enabled: false, baseUrl: '', token: '' };
  }
}

export interface ShareEndpoint {
  base: string;
  token: string;
}

/** 解析出可用的反代地址：没配主代理就不算可用（不能直连社交平台）。 */
export function resolveShareEndpoint(cfg: SocialShareConfig = readSocialShareConfig()): ShareEndpoint | null {
  const routing = readAgentRoutingConfig();
  const rawBase = (cfg.baseUrl || routing.agentUrl || '').trim().replace(/\/+$/, '');
  const token = (cfg.token || routing.agentToken || '').trim();
  if (!rawBase) return null;
  // 用户可能把 /agent 或 /agent/v1 一起粘进设置：统一剥到站点根
  const base = rawBase.replace(/\/agent(\/v1)?$/, '');
  return { base, token };
}

export function isSocialShareEnabled(cfg: SocialShareConfig = readSocialShareConfig()): boolean {
  return cfg.enabled === true && resolveShareEndpoint(cfg) != null;
}

export interface SharePlan {
  linkCount: number;
  platforms: string[];
  overLimit: boolean;
}

/**
 * 发送前快速判定：只在“确实有支持的平台链接”时才走新链路。
 * 返回 null 表示这次发送与分享无关（调用方保持原有行为）。
 */
export function planShareText(text: string): SharePlan | null {
  if (!text || text.length > SHARE_REQUEST_LIMITS.maxTextUtf16Units) return null;
  const extracted = extractShareLinks(text, { maxLinks: SHARE_REQUEST_LIMITS.maxLinksPerMessage });
  if (!extracted.ok) return null;
  const supported = extracted.candidates.filter((c) => c.platform && !c.overLimit);
  if (supported.length === 0) return null;
  return {
    linkCount: extracted.candidates.length,
    platforms: Array.from(new Set(supported.map((c) => String(c.platform)))),
    overLimit: extracted.droppedOverLimit > 0 || extracted.candidates.some((c) => c.overLimit),
  };
}

export type ShareCallResult<T> =
  | { ok: true; value: T }
  /** payload 只用于 503 这类“失败但带诊断体”的响应（如 PERSISTENCE_UNAVAILABLE 附件）。 */
  | { ok: false; status: number; error: string; payload?: any };

async function shareRequest<T>(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number; endpoint?: ShareEndpoint } = {},
): Promise<ShareCallResult<T>> {
  const endpoint = init.endpoint ?? resolveShareEndpoint();
  if (!endpoint) return { ok: false, status: 0, error: 'SHARE_ENDPOINT_NOT_CONFIGURED' };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (endpoint.token) headers['X-Client-Token'] = endpoint.token;
  const timeoutMs = init.timeoutMs ?? 25000;
  try {
    const res = await fetch(`${endpoint.base}/agent/v1/social${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    const textBody = await res.text();
    let parsed: any = null;
    try {
      parsed = textBody ? JSON.parse(textBody) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      // 503 PERSISTENCE_UNAVAILABLE 会带 attachments：调用方可以展示但必须标明未持久化
      return { ok: false, status: res.status, error: String(parsed?.error || `HTTP_${res.status}`), payload: parsed ?? undefined };
    }
    return { ok: true, value: parsed as T };
  } catch (err) {
    const aborted = (err as { name?: string })?.name === 'AbortError' || (err as { name?: string })?.name === 'TimeoutError';
    return { ok: false, status: aborted ? 504 : 0, error: aborted ? 'TIMEOUT' : 'NETWORK_ERROR' };
  }
}

export interface ResolveResponse {
  attachments: ShareAttachment[];
  pollAfterMs: number;
  droppedOverLimit?: number;
}

export interface ResolveInput {
  conversationId: string;
  messageId: string;
  characterId?: string | null;
  text: string;
  timeoutMs?: number;
  endpoint?: ShareEndpoint;
}

/** POST /shares/resolve。messageId 用本地消息 id（字符串化）做幂等键。 */
export async function resolveSharesForMessage(input: ResolveInput): Promise<ShareCallResult<ResolveResponse>> {
  const result = await shareRequest<ResolveResponse>('/shares/resolve', {
    method: 'POST',
    timeoutMs: input.timeoutMs,
    endpoint: input.endpoint,
    body: {
      schemaVersion: 1,
      messageId: input.messageId,
      conversationId: input.conversationId,
      characterId: input.characterId ?? null,
      text: input.text,
      idempotencyKey: `${input.messageId}`,
    },
  });
  if (!result.ok) return result;
  const value = result.value as ResolveResponse;
  return {
    ok: true,
    value: {
      attachments: Array.isArray(value?.attachments) ? value.attachments : [],
      pollAfterMs: Number(value?.pollAfterMs) || 1000,
      droppedOverLimit: value?.droppedOverLimit,
    },
  };
}

/** GET /shares —— 历史恢复/晚到轮询用。 */
export async function fetchSharesForMessage(
  conversationId: string,
  messageId: string,
  opts: { endpoint?: ShareEndpoint; timeoutMs?: number } = {},
): Promise<ShareCallResult<{ attachments: ShareAttachment[] }>> {
  const qs = `?conversationId=${encodeURIComponent(conversationId)}&messageId=${encodeURIComponent(messageId)}`;
  return shareRequest<{ attachments: ShareAttachment[] }>(`/shares${qs}`, { endpoint: opts.endpoint, timeoutMs: opts.timeoutMs });
}

/** POST /shares/:ref/retry —— 失败卡手动重试。 */
export async function retryShare(
  shareRef: string,
  expectedRevision: number,
  opts: { endpoint?: ShareEndpoint; timeoutMs?: number } = {},
): Promise<ShareCallResult<{ attachment: ShareAttachment }>> {
  return shareRequest<{ attachment: ShareAttachment }>(`/shares/${encodeURIComponent(shareRef)}/retry`, {
    method: 'POST',
    body: { expectedRevision, idempotencyKey: `retry-${shareRef}-${expectedRevision}` },
    endpoint: opts.endpoint,
    timeoutMs: opts.timeoutMs,
  });
}

export interface ExcerptsInput {
  contentId: string;
  contentRevision: number;
  query?: string | null;
  fields?: Array<'title' | 'text' | 'transcript' | 'comments' | 'images'>;
  partKey?: string | null;
  cursor?: string | null;
  maxTokens?: number;
}

export interface ExcerptsResult {
  contentId: string;
  contentRevision: number;
  segments: Array<{ id: string; field: string; text: string; startMs?: number | null; endMs?: number | null; sourceRef?: string }>;
  nextCursor: string | null;
  truncated: boolean;
  tokenEstimate: number;
}

/** POST /items/:id/excerpts —— 按需检索（服务端夹紧字段与预算）。 */
export async function fetchShareExcerpts(
  input: ExcerptsInput,
  opts: { endpoint?: ShareEndpoint; timeoutMs?: number } = {},
): Promise<ShareCallResult<ExcerptsResult>> {
  return shareRequest<ExcerptsResult>(`/items/${encodeURIComponent(input.contentId)}/excerpts`, {
    method: 'POST',
    endpoint: opts.endpoint,
    timeoutMs: opts.timeoutMs,
    body: {
      contentRevision: input.contentRevision,
      query: input.query ?? null,
      fields: input.fields ?? ['text'],
      partKey: input.partKey ?? null,
      cursor: input.cursor ?? null,
      maxTokens: Math.min(input.maxTokens ?? SHARE_BUDGETS.excerptsPerCallTokens, SHARE_BUDGETS.excerptsPerCallTokens),
    },
  });
}

/** 事件/轮询合并：旧 attempt 或同 attempt 下更旧 revision 一律丢弃（契约 4.6）。 */
export function mergeShareAttachments(
  current: readonly ShareAttachment[] | null | undefined,
  incoming: readonly ShareAttachment[] | null | undefined,
): ShareAttachment[] {
  const byRef = new Map<string, ShareAttachment>();
  for (const a of current ?? []) byRef.set(a.shareRef, a);
  for (const next of incoming ?? []) {
    const prev = byRef.get(next.shareRef);
    if (!prev) {
      byRef.set(next.shareRef, next);
      continue;
    }
    if (next.attempt < prev.attempt) continue;
    if (next.attempt === prev.attempt && next.revision <= prev.revision) continue;
    byRef.set(next.shareRef, next);
  }
  return Array.from(byRef.values());
}

/** 保守 token 估算：每 Unicode 码点 ≈1 token（契约 6.3；不声称精确）。 */
export function estimateShareTokens(text: string): number {
  return Array.from(text ?? '').length;
}

function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const cps = Array.from(text ?? '');
  if (cps.length <= maxTokens) return { text: cps.join(''), truncated: false };
  return { text: cps.slice(0, Math.max(0, maxTokens - 1)).join('') + '…', truncated: true };
}

/** 对外展示/工具调用用的短引用（完整 shareRef 仍在 metadata 里）。 */
export function shortShareRef(shareRef: string): string {
  return shareRef.length > 12 ? shareRef.slice(0, 12) : shareRef;
}

const STATE_LABEL: Record<string, string> = {
  queued: '排队解析',
  resolving: '解析中',
  ready: '已读取',
  partial: '部分读取',
  failed: '未读取',
  cancelled: '已取消',
};

/**
 * 单卡投影文本（进模型的那段）。只含标题/作者/简介与覆盖说明，不含完整正文与原始链接。
 * 每卡 ≤ summaryPerCardTokens；调用方再按整条消息上限二次夹紧。
 */
export function renderShareCardProjection(share: ShareAttachment): string {
  const label = STATE_LABEL[share.state] ?? share.state;
  const ref = shortShareRef(share.shareRef);
  const platform = share.preview?.platformName || share.platform || '链接';
  const head = `[分享 ${ref}] ${platform} · ${label}`;
  if (share.state === 'failed' || share.state === 'cancelled') {
    const code = share.error?.code ?? 'UNKNOWN';
    const hint = failureHint(code);
    return truncateToTokens(`${head}\n未读取原因：${code}${hint ? `（${hint}）` : ''}`, SHARE_BUDGETS.summaryPerCardTokens).text;
  }
  const proj = share.contextProjection;
  const title = share.preview?.title ? `标题：${share.preview.title}` : '';
  const author = share.preview?.authorName ? `作者：${share.preview.authorName}` : '';
  const summary = proj?.summaryText ? `简介：${proj.summaryText}` : '简介：（解析中，尚未读取内容）';
  const coverage = proj?.evidenceCoverage?.length ? `已获取：${proj.evidenceCoverage.join('/')}` : '';
  const missing = proj?.reason?.startsWith('missing:') ? `缺失：${proj.reason.slice('missing:'.length)}` : '';
  const note = share.state === 'partial' ? '（部分材料未取得，按已获取部分讨论，不要补全没拿到的内容）' : '';
  return truncateToTokens(
    [head, title, author, summary, coverage, missing, note].filter(Boolean).join('\n'),
    SHARE_BUDGETS.summaryPerCardTokens,
  ).text;
}

function failureHint(code: string): string {
  switch (code) {
    case 'AUTH_REQUIRED':
      return '需要登录，未提供正文';
    case 'ACCESS_DENIED':
      return '平台拒绝访问';
    case 'REGION_RESTRICTED':
      return '地区受限';
    case 'PAYWALL':
      return '需要付费';
    case 'CONTENT_NOT_FOUND':
    case 'CONTENT_DELETED':
      return '内容不存在或已删除';
    case 'TIMEOUT':
      return '解析超时，可重试';
    case 'NETWORK_ERROR':
      return '网络错误，可重试';
    case 'SOURCE_NOT_CONFIGURED':
      return '该平台未配置来源';
    case 'SIZE_LIMIT':
      return '超出单条消息的链接数量上限';
    case 'UNSAFE_URL':
      return '链接未通过安全校验';
    case 'UNSUPPORTED_PLATFORM':
    case 'UNSUPPORTED_LINK_TYPE':
      return '不支持这种链接';
    default:
      return '';
  }
}

/**
 * 把消息原文里的链接替换成 shareRef，并追加卡片简介（契约 6.1：首次就给投影，不先发长 URL）。
 * 返回 null 表示这条消息没有分享元数据（调用方继续走原有渲染）。
 */
export function buildShareMessageProjection(
  content: string,
  attachments: readonly ShareAttachment[] | null | undefined,
  opts: { userName?: string; perMessageTokens?: number } = {},
): string | null {
  if (!attachments || attachments.length === 0) return null;
  const budget = opts.perMessageTokens ?? SHARE_BUDGETS.summaryPerMessageTokens;
  // 按原顺序替换原始链接（span 是 UTF-16，从后往前替换避免偏移错乱）
  const ordered = [...attachments].sort((a, b) => (b.occurrenceSpans[0]?.start ?? 0) - (a.occurrenceSpans[0]?.start ?? 0));
  let text = content ?? '';
  for (const att of ordered) {
    const token = `[分享 ${shortShareRef(att.shareRef)}]`;
    for (const span of [...(att.occurrenceSpans ?? [])].sort((a, b) => b.start - a.start)) {
      if (typeof span.start === 'number' && typeof span.end === 'number' && span.start >= 0 && span.end <= text.length) {
        text = `${text.slice(0, span.start)}${token}${text.slice(span.end)}`;
      }
    }
  }

  const cards: string[] = [];
  let used = 0;
  for (const att of attachments) {
    const remaining = Math.max(0, budget - used);
    if (remaining <= 40) break;
    const card = truncateToTokens(renderShareCardProjection(att), Math.min(SHARE_BUDGETS.summaryPerCardTokens, remaining)).text;
    cards.push(card);
    used += estimateShareTokens(card);
  }
  return [text.trim(), ...cards].filter(Boolean).join('\n\n');
}

/** 跳转入口：只放行 https 且通过基本校验的地址；不安全就只展示文本。 */
export function safeOpenUrl(share: ShareAttachment): string | null {
  const raw = share.openUrl || share.resolvedUrl || share.canonicalUrl || null;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** 读取消息 metadata 里的分享附件（兼容未初始化）。 */
export function shareAttachmentsOf(metadata: any): ShareAttachment[] {
  const list = metadata?.shares?.attachments;
  return Array.isArray(list) ? (list as ShareAttachment[]) : [];
}

// ─── 历史恢复 / 晚到补齐 ────────────────────────────────────────────────

export interface ShareDbLike {
  updateMessageMetadata(id: number, updater: (prev: any) => any): Promise<void>;
}

/**
 * 打开会话时补齐“上次没跑完”的卡（queued/resolving 超过 staleMs），以及轮询期间
 * 只在内存里更新、没来得及落库的晚到结果。只读 GET，不重新触发解析、不触发模型调用。
 *
 * 为什么需要：服务端 resolve 是请求内 20s 完成，但用户可能中途关页面；重开时
 * 消息 metadata 仍是 queued/resolving，不恢复就永远停在“解析中”。
 */
export async function recoverPendingShares(
  messages: readonly { id: number; metadata?: any }[],
  db: ShareDbLike,
  opts: { conversationId: string; now?: number; staleMs?: number; max?: number; endpoint?: ShareEndpoint; timeoutMs?: number },
): Promise<{ checked: number; updated: number }> {
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? 5000;
  const max = opts.max ?? 3;
  let checked = 0;
  let updated = 0;
  for (const msg of messages) {
    if (checked >= max) break;
    const attachments = shareAttachmentsOf(msg.metadata);
    if (attachments.length === 0) continue;
    const pending = attachments.some(
      (a) => (a.state === 'queued' || a.state === 'resolving') && now - (a.updatedAt || 0) > staleMs,
    );
    if (!pending) continue;
    checked += 1;
    const res = await fetchSharesForMessage(opts.conversationId, String(msg.id), {
      endpoint: opts.endpoint,
      timeoutMs: opts.timeoutMs,
    });
    if (!res.ok || res.value.attachments.length === 0) continue;
    await db.updateMessageMetadata(msg.id, (prev: any) => ({
      ...(prev || {}),
      shares: {
        ...(prev?.shares || {}),
        version: 1,
        attachments: mergeShareAttachments(shareAttachmentsOf(prev), res.value.attachments),
        refreshedAt: now,
      },
    }));
    updated += 1;
  }
  return { checked, updated };
}
