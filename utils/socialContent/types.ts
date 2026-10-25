/**
 * 链接分享统一契约 v1 —— 共享纯类型（t_2c2dba79）。
 *
 * 来源：/root/.hermes/kanban/attachments/t_6bca2291/share-contract-v1.txt 第 3 节。
 * 本文件只有类型与常量，零运行时依赖、零副作用：前端、worker/main-agent、测试共用同一份，
 * 避免三处各自定义 ShareAttachment 后在集成时字段打架。
 *
 * 约定（契约 3.1）：
 *  - schemaVersion 恒为 1；时间一律 UTC 毫秒；未知字段 null，不用 0/空串冒充；
 *  - 文本是纯文本，不携带 HTML；ID 是不透明字符串，大小写敏感，不做归一化；
 *  - 本文件不引入任何平台实现，平台细节见 worker/social-content/adapters/*。
 */

/** 契约第 3 节冻结的 schema 版本；字段增删必须升版本，不能原地漂移。 */
export const SHARE_SCHEMA_VERSION = 1 as const;

/** 共享内容平台。bilibili 为契约新增；douban/import 兼容既有实现。 */
export type SocialPlatform = 'xiaohongshu' | 'douyin' | 'bilibili' | 'douban' | 'import';

/**
 * 分享卡状态机（契约 3.4）：
 *   queued → resolving → ready | partial | failed | cancelled
 * 终态只有显式 retry 才会进入新 attempt 的 queued。
 */
export type ShareState = 'queued' | 'resolving' | 'ready' | 'partial' | 'failed' | 'cancelled';

/** 内容可用性。deleted/restricted 不得回放旧缓存正文（契约 5.6）。 */
export type ContentAvailability = 'available' | 'deleted' | 'unavailable' | 'restricted';

/** 契约 3.7 冻结的错误码集合；不在集合内的错误不允许外泄给客户端。 */
export type ShareErrorCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_PLATFORM'
  | 'UNSUPPORTED_LINK_TYPE'
  | 'UNSUPPORTED_REGION_OR_PRODUCT'
  | 'AUTH_REQUIRED'
  | 'SOURCE_NOT_CONFIGURED'
  | 'ACCESS_DENIED'
  | 'PAYWALL'
  | 'REGION_RESTRICTED'
  | 'RATE_LIMITED'
  | 'CONTENT_NOT_FOUND'
  | 'CONTENT_DELETED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'UPSTREAM_CHANGED'
  | 'UNSAFE_URL'
  | 'SIZE_LIMIT'
  | 'PERSISTENCE_UNAVAILABLE'
  | 'CANCELLED';

/** 错误可重试性由 service 决定：认证/付费/地区/风控一律不自动重试（契约 7.2）。 */
export interface ShareError {
  code: ShareErrorCode;
  retryable: boolean;
  retryAfterMs: number | null;
  userMessage: string;
  /** 安全诊断号：只含随机后缀，不含 URL、签名参数或上游原文。 */
  safeDiagnosticId: string | null;
}

/** 原文中的出现位置，UTF-16 单元、半开区间 [start, end)。 */
export interface OccurrenceSpan {
  start: number;
  end: number;
}

/** 卡片轻量预览；正文在内容库，主消息只留引用/预览/简介（契约 5.1）。 */
export interface SharePreview {
  title: string | null;
  authorName: string | null;
  platformName: string;
  siteName: string | null;
  /** 仅安全可用的封面；失效/未验证一律 null，不生图补位。 */
  coverUrl: string | null;
  excerpt: string | null;
}

/** 冻结的模型投影（契约 6.2）。一经冻结，后续历史不重复更新摘要。 */
export interface ContextProjection {
  projectionVersion: number;
  shareRef: string;
  contentId: string | null;
  contentRevision: number | null;
  stateAtFreeze: ShareState;
  summaryText: string;
  evidenceCoverage: string[];
  reason: string | null;
  frozenAt: number;
  /**
   * 原生字幕/转写的真实状态（契约 3.9「字幕缺失不得静默」）。
   * available=拿到了；failed=请求失败；not_available=平台没有；not_requested=未开启 ASR；
   * absent=内容记录里根本没有字幕轨（适配器未声明）。缺省视为 absent。
   */
  transcriptState?: TranscriptState;
}

export type TranscriptState = 'available' | 'failed' | 'not_available' | 'not_requested' | 'absent';

/** 一条消息里的一个链接 = 一张分享卡（契约 3.2）。 */
export interface ShareAttachment {
  schemaVersion: typeof SHARE_SCHEMA_VERSION;
  shareRef: string;
  messageId: string;
  conversationId: string;
  characterId: string | null;
  /** 同消息同链接合并一张卡、保留多个 span。 */
  occurrenceSpans: OccurrenceSpan[];
  /** 用户原样发出的链接（含包裹标点以外的最小保留）。 */
  originalUrl: string;
  platform: SocialPlatform | null;
  sourceId: string | null;
  /** 受控展开后的地址（短链解析结果），未展开为 null。 */
  resolvedUrl: string | null;
  /** 稳定的官方内容页，不含跟踪参数。 */
  canonicalUrl: string | null;
  /** 保留必要访问参数、且通过安全校验的跳转入口；未验证为 null。 */
  openUrl: string | null;
  contentId: string | null;
  partKey: string | null;
  state: ShareState;
  /** 同一 shareRef 单调递增；旧事件不得覆盖更大的 revision。 */
  revision: number;
  /** 人工 retry 才递增；自动重试不递增。 */
  attempt: number;
  createdAt: number;
  updatedAt: number;
  /** 解析租约到期时间（仅 queued/resolving 有值）：别的持有者据此判断“在途作业”。 */
  leaseUntil?: number | null;
  error: ShareError | null;
  preview: SharePreview | null;
  contextProjection: ContextProjection | null;
}

/** 共享作者块；未知用 null，不编造。 */
export interface ContentAuthor {
  id: string | null;
  name: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
}

/** 媒体引用。图片同一资源只存一次（media 与 images 引用同一条，不双存字节，契约 3.3）。 */
export interface ContentMedia {
  id: string;
  type: 'image' | 'video';
  /** 原始地址；CDN 签名地址按 expiresAt 失效，不循环续签。 */
  safeUrl: string | null;
  alt: string | null;
  width: number | null;
  height: number | null;
  expiresAt: number | null;
  availability: ContentAvailability;
}

/** 正文兼容视图：text 与 body.text 是同一正文（契约 3.3）。 */
export interface ContentBody {
  availability: ContentAvailability;
  text: string;
  truncated: boolean;
  originalLength: number | null;
}

export type TranscriptAvailability =
  | 'available'
  | 'not_available'
  | 'not_requested'
  | 'restricted'
  | 'failed';

export interface TranscriptSegment {
  id: string;
  startMs: number | null;
  endMs: number | null;
  text: string;
}

/**
 * 字幕轨。原生字幕与 ASR 分开记录；分 P、语种分轨（契约 3.4）。
 * ASR 默认关闭：没有已启用能力时 availability='not_requested'，不得声称看过视频。
 */
export interface Transcript {
  id: string;
  partKey: string | null;
  kind: 'native_caption' | 'speech_transcription';
  language: string | null;
  provider: string | null;
  availability: TranscriptAvailability;
  segments: TranscriptSegment[];
  plainText: string;
  truncated: boolean;
  originalLength: number | null;
  fetchedAt: number;
  sourceRef: string;
}

/** 评论样本：默认一页最多 5 条，样本内排序必须如实标注（契约 3.5）。 */
export interface CommentsSample {
  availability: 'available' | 'not_requested' | 'restricted' | 'not_available' | 'failed';
  items: Array<{
    id: string;
    author: { name: string | null };
    text: string;
    likes: number | null;
    publishedAt: number | null;
    sourceRef: string;
  }>;
  selection: 'platform_hot' | 'likes_desc_within_sample' | 'chronological' | 'unknown';
  requestedLimit: number;
  returnedCount: number;
  pagesFetched: number;
  totalAvailable: number | null;
  hasMore: boolean | null;
  fetchedAt: number;
  truncated: boolean;
  scopeDescription: string;
}

/** 默认本地摘录，不另起 LLM 总结（契约 3.6/6.4）。 */
export interface ContentSummary {
  text: string;
  method: 'extractive' | 'main_reply_derived';
  basedOnContentRevision: number;
  coverage: string[];
  truncated: boolean;
  createdAt: number;
}

/** 字段溯源（契约 3.6）；sourceRef 为安全引用，不带凭据。 */
export interface FieldProvenance {
  sourceRef: string;
  retrievalMethod: string;
  fetchedAt: number;
  availability: ContentAvailability;
}

export type ProvenanceField = 'title' | 'text' | 'images' | 'transcript' | 'comments';

/** 本次请求的限额与截断说明（契约 5.7）。 */
export interface ContentLimits {
  maxTextChars: number;
  maxResponseBytes: number;
  truncated: boolean;
  notes: string[];
}

/** 共享内容记录：继承 ContentItem，并叠加契约 3.3 的扩展字段。 */
export interface ContentRecord {
  schemaVersion: typeof SHARE_SCHEMA_VERSION;
  /** contentId：platform:encoded(sourceId):encoded(externalId)，不另起 UUID 取代共享 ID。 */
  id: string;
  platform: SocialPlatform;
  sourceId: string;
  externalId: string;
  author: ContentAuthor;
  title: string | null;
  text: string;
  media: ContentMedia[];
  canonicalUrl: string;
  publishedAt: number | null;
  fetchedAt: number;
  updatedAt: number | null;
  attribution: {
    platformName: string;
    authorName: string | null;
    sourceUrl: string;
    retrievalMethod: string;
    license: string | null;
  };
  status: ContentAvailability;
  visibility: 'public' | 'private';
  counts: { likes: number | null; comments: number | null };
  contentRevision: number;
  body: ContentBody;
  images: ContentMedia[];
  transcripts: Transcript[];
  commentsSample: CommentsSample | null;
  summary: ContentSummary | null;
  fieldProvenance: Partial<Record<ProvenanceField, FieldProvenance>>;
  limits: ContentLimits;
}

/** 摘录请求/响应（契约 4.5）。服务端夹紧字段与预算，不接受任意 URL。 */
export interface ExcerptSegment {
  id: string;
  field: 'text' | 'transcript' | 'comments';
  text: string;
  startMs: number | null;
  endMs: number | null;
  sourceRef: string;
}

export interface ExcerptsRequest {
  contentRevision: number;
  query: string | null;
  fields: Array<'text' | 'transcript' | 'comments'>;
  partKey: string | null;
  cursor: string | null;
  maxTokens: number;
}

export interface ExcerptsResponse {
  contentId: string;
  contentRevision: number;
  segments: ExcerptSegment[];
  nextCursor: string | null;
  truncated: boolean;
  tokenEstimate: number;
  estimateMethod: 'codepoint_approx' | 'tokenizer';
}

/**
 * 契约 6.3 的投影预算，单位 token。无 tokenizer 时按每 Unicode 码点约 1 token 保守估算。
 * 这些是上限而非目标，分配时按原顺序给，其他卡至少保留来源标识/状态。
 */
export const SHARE_BUDGETS = {
  summaryPerCardTokens: 350,
  summaryPerMessageTokens: 1200,
  excerptsPerCallTokens: 1200,
  excerptsPerUserTurnTokens: 2400,
} as const;

/** 契约 4.1 的请求上限。 */
export const SHARE_REQUEST_LIMITS = {
  maxTextUtf16Units: 16000,
  maxLinksPerMessage: 5,
  maxConcurrentPerScope: 2,
  resolveDeadlineMs: 20000,
  perRequestTimeoutMs: 8000,
  maxRedirects: 5,
  maxAttempts: 2,
} as const;

/**
 * 契约 7.2 的开关默认值：新安装总开关必须关闭；ASR 与 XHS 实验评论默认关闭。
 * 只给默认值，实际读取 env/配置由部署端与集成人做（不在模块里读全局配置）。
 */
export const SHARE_FEATURE_DEFAULTS = {
  SHARE_LINKS_ENABLED: false,
  MAX_LINKS_PER_MESSAGE: 5,
  MAX_CONCURRENT_PER_SCOPE: 2,
  RESOLVE_DEADLINE_MS: 20000,
  PER_REQUEST_TIMEOUT_MS: 8000,
  MAX_REDIRECTS: 5,
  MAX_ATTEMPTS: 2,
  TRANSCRIPTION_ENABLED: false,
  EXPERIMENTAL_XHS_COMMENTS: false,
  REDNOTE_INDEPENDENT_SESSION: false,
} as const;

/** 唯一 UI 事件（契约 4.6）：按 shareRef/messageId/attempt/revision 消费，旧事件不覆盖新状态。 */
export interface ShareUpdateEvent {
  schemaVersion: typeof SHARE_SCHEMA_VERSION;
  event: 'social-share.updated';
  shareRef: string;
  messageId: string;
  attempt: number;
  revision: number;
  state: ShareState;
  attachment: ShareAttachment;
}

/** 契约 5.7 的响应/文本上限。 */
export const SHARE_CONTENT_LIMITS = {
  maxTextChars: 200000,
  maxDetailResponseBytes: 256 * 1024,
  maxHtmlBytes: 2 * 1024 * 1024,
} as const;
