/**
 * 适配器公共接口与共享小工具（t_2c2dba79）。
 *
 * 每个平台一个独立适配器文件，互不 import；共享的只有这里的接口和安全抓取注入。
 * 适配器只做"读取 + 归一化"，不做写操作（不点赞/收藏/评论/发布，契约 7.2）。
 */

import type {
  ContentRecord,
  ShareError,
  SocialPlatform,
  Transcript,
  CommentsSample,
} from '../../utils/socialContent/types';
import type { SafeFetchDeps, SafeFetchPolicy } from './safeFetch';

export interface SourcePolicy {
  /** false 时不持久正文/摘录/摘要，只能用请求内有界内存（契约 5.6）。 */
  cacheAllowed: boolean;
  ttlMs: number;
  staleMs: number;
  mediaStorageAllowed: boolean;
  publicRedistributionAllowed: boolean;
  maxPageSize: number;
  minIntervalMs: number;
  requestTimeoutMs: number;
}

/** 默认来源策略：保守值，真实来源配置由部署端覆盖（不硬编码实例地址/账号）。 */
export const DEFAULT_SOURCE_POLICY: SourcePolicy = {
  cacheAllowed: false,
  ttlMs: 60 * 60 * 1000,
  staleMs: 0,
  mediaStorageAllowed: false,
  publicRedistributionAllowed: false,
  maxPageSize: 20,
  minIntervalMs: 1000,
  requestTimeoutMs: 8000,
};

export interface AdapterContext {
  /** 服务端确定的 scope（部署共享 public 或可信 owner 域），不来自 body/query。 */
  scope: string;
  /** 整个解析的截止时间（毫秒时间戳），适配器不得越过。 */
  deadline: number;
  now?: () => number;
  signal?: AbortSignal;
}

export interface SourceTarget {
  platform: SocialPlatform;
  externalId: string;
  partKey: string | null;
  canonicalUrl: string;
  /** 展开后的最终 URL（短链解析结果）；没有短链时为 canonicalUrl。 */
  resolvedUrl: string;
}

export interface AdapterDeps {
  safeFetch: SafeFetchDeps;
  /** 允许访问的 host（通常 = 平台主站 + 必要 API + 该平台 CDN）。 */
  allowedHosts: readonly string[];
  policy?: Partial<SourcePolicy>;
}

export interface AdapterHealth {
  status: 'configured' | 'auth_required' | 'disabled' | 'degraded';
  note: string;
}

export interface ContentAdapter {
  id: string;
  platform: SocialPlatform;
  version: string;
  capabilities: { detail: boolean; comments: boolean; shortLink: boolean; transcript: boolean };
  health(): Promise<AdapterHealth>;
  /** 受控展开短链；失败抛 SocialError（INVALID_URL/UNSAFE_URL/TIMEOUT/...）。 */
  expandShortLink(url: string, ctx: AdapterContext): Promise<SourceTarget>;
  /** 拉取详情。拿不到材料必须抛 SocialError，不允许返回空壳冒充 ready。 */
  fetchContent(target: SourceTarget, ctx: AdapterContext): Promise<ContentRecord>;
}

/** 适配器返回：内容 + 本次覆盖情况（哪些字段真的拿到了）。 */
export interface AdapterOutcome {
  content: ContentRecord | null;
  coverage: string[];
  error: ShareError | null;
}

export function fetchPolicy(deps: AdapterDeps, extraHosts: readonly string[] = []): SafeFetchPolicy {
  return {
    allowedHosts: [...deps.allowedHosts, ...extraHosts],
    perRequestTimeoutMs: deps.policy?.requestTimeoutMs ?? DEFAULT_SOURCE_POLICY.requestTimeoutMs,
  };
}

/** 把平台给的时间戳（秒/毫秒/字符串）规范成 UTC 毫秒；无法判定返回 null，不用采集时间冒充。 */
export function toUtcMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && /^\d{9,13}$/.test(value)) {
    const n = Number(value);
    return n < 1e12 ? n * 1000 : n;
  }
  return null;
}

/** 纯文本化：去掉标签、还原常见实体、压缩空白；不保留任何 HTML/脚本（契约 7.1）。 */
export function toPlainText(raw: unknown, maxChars = 200000): { text: string; truncated: boolean; originalLength: number } {
  if (typeof raw !== 'string') return { text: '', truncated: false, originalLength: 0 };
  const originalLength = raw.length;
  const noTags = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const decoded = noTags
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
  const text = decoded.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const truncated = text.length > maxChars;
  return { text: truncated ? text.slice(0, maxChars) : text, truncated, originalLength };
}

/** 原生字幕可用性：没有就是 not_available，不声称看过视频。 */
export function emptyTranscript(partKey: string | null, kind: 'native_caption' | 'speech_transcription', sourceRef: string): Transcript {
  return {
    id: `${kind}:${partKey ?? 'main'}`,
    partKey,
    kind,
    language: null,
    provider: null,
    availability: 'not_available',
    segments: [],
    plainText: '',
    truncated: false,
    originalLength: null,
    fetchedAt: 0,
    sourceRef,
  };
}

/** 默认不取评论时的样本结构：not_requested，绝不补虚构评论。 */
export function emptyComments(sourceRef: string, requestedLimit: number): CommentsSample {
  return {
    availability: 'not_requested',
    items: [],
    selection: 'unknown',
    requestedLimit,
    returnedCount: 0,
    pagesFetched: 0,
    totalAvailable: null,
    hasMore: null,
    fetchedAt: 0,
    truncated: false,
    scopeDescription: sourceRef,
  };
}
