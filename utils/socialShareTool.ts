/**
 * read_share_excerpts —— 聊天工具循环里的「按需读片段」（执行卡 t_75dd49a5）。
 *
 * 背景：集成卡 t_babca897 已经做到「分享卡简介进上下文」，但 `POST /items/:id/excerpts`
 * 只有 HTTP 接口、没注册成模型工具（见 docs/social-content/integration-v1.md §8 第 2 条）。
 * 本模块把那一档补上：模型在真实工具循环里发现 `read_share_excerpts`，按需读正文/字幕/评论样本。
 *
 * 边界（与卡片接口决策一致）：
 *  - **只读**：本模块不写服务端、不落库、不改配置；唯一副作用是本轮的预算记账。
 *  - **不认地址**：模型只能给 shareRef / contentId，URL、baseUrl、token、scope 一律拒绝（FORMAT：
 *    命中即结构化拒绝且不发出任何请求）。授权 scope 由服务端决定，客户端不传。
 *  - **只认本轮可见的分享卡**：可读集合由「本轮真实投影进模型的消息 metadata.shares」推出，
 *    模型给出集合外的 shareRef/contentId 直接拒绝（不让它指定任意网络位置/别人的内容）。
 *  - **预算**：单次 ≤1200 token、一个用户轮次累计 ≤2400 token，整个工具循环共享同一份预算对象
 *    （并发调用通过「预留」避免超卖；不随 handler/模型迭代重置）。不信任模型传入的数值，也不
 *    信任服务端自报的 tokenEstimate —— 一律按仓库既有保守口径（每 Unicode 码点 ≈1 token）重算，
 *    并按自身重算值夹紧交给模型的文本。
 *  - **失败如实**：超限/失败都返回结构化结果，并明确要求「基于已有简介回答、说明片段不可用」，
 *    不让模型把没读到说成读过。
 *
 * 落历史：每次调用执行完**立刻**把 call（工具名/参数）与 result（状态/收费/文本）成对写进
 * 「本轮触发消息」（`contextMsgs` 的最后一条，发送前已落库、id 确定）的 metadata.shareExcerpts；
 * 这一步不依赖最终自然语言回复成功，模型失败/用户取消也不会丢。**本轮收到的每一次调用都保留**
 * （含拒绝/超限，不按条数截断——拒绝记录不能挤掉已成功的片段，返工第 4 轮 P1-1）。
 * 写库失败的批**留在待补偿队列**
 * （`ShareExcerptPairOutbox`），由下一次 dispatch / 收尾 flush 有界重试；重试仍失败就明确标为
 * 「未保存」并上报，不冒充已保存。下一轮投影由 messageFormat 读出这对记录
 * （成对渲染，不单独回放孤立片段，≤600 token）。落库器见 ShareExcerptPairRecorder。
 *
 * 无锚不读：拿不到本轮确定的持久化锚点时，生产路径在**读取前**就返回 `HISTORY_UNAVAILABLE`
 * （`dispatchShareExcerptToolCall`），避免「读过却没有记录」。
 *
 * 引用契约：模型可见标识 = **完整 shareRef**（投影里 `[分享 shr_...]`）；执行器精确匹配，
 * 并容忍 ≥8 字符的唯一前缀。前缀命中多张卡时返回 SHARE_REF_AMBIGUOUS 并列出候选，
 * 绝不按相似度猜一张（返工卡 t_38463abd P1）。
 */

import { SHARE_BUDGETS, type ShareAttachment, type ShareState } from './socialContent/types';
import {
  estimateShareTokens,
  fetchShareExcerpts,
  shareAttachmentsOf,
  type ExcerptsInput,
  type ExcerptsResult,
  type ShareCallResult,
  type ShareEndpoint,
} from './socialShare';

export const SHARE_EXCERPTS_TOOL_NAME = 'read_share_excerpts';

/** 模型能给、也必须只给这些字段。 */
export const SHARE_EXCERPT_FIELD_VALUES = ['text', 'transcript', 'comments'] as const;
export type ShareExcerptField = (typeof SHARE_EXCERPT_FIELD_VALUES)[number];

/**
 * 工具侧的硬上限。perCall/perTurn 直接引用契约 6.3 的预算常量（不在本模块另立一套数字）；
 * envelope 是结果文本的信封开销（标题/说明行），从本次额度里先扣掉，保证交给模型的正文
 * 不会因为信封把 1200 撑破；minGrant 是「一次调用还放不放得下一条切片」的下限，
 * 低于它就干脆拒绝，让模型基于已有简介回答，而不是拿一个读不出东西的额度白跑一趟。
 */
export const SHARE_EXCERPT_LIMITS = {
  perCallTokens: SHARE_BUDGETS.excerptsPerCallTokens,
  perTurnTokens: SHARE_BUDGETS.excerptsPerUserTurnTokens,
  envelopeTokens: 220,
  minGrantTokens: 320,
  /**
   * 模型把可见 shareRef 抄一半时能接受的最短前缀。低于它就当作「没这一张」，
   * 免得 4~7 个字符的公共前缀把多张卡糊到一张上（返工卡 t_38463abd P1）。
   */
  minRefPrefixChars: 8,
  /**
   * 服务端 excerpts 的契约是「至少返回一条切片，哪怕已经超出预算」，单条切片上限 400 字符
   * （worker/social-content/excerpts.ts 的 MAX_SEGMENT_CHARS）。请求时先把这段可能的溢出
   * 预留掉，客户端才不会为了砍掉一条溢出片段而丢掉 nextCursor（丢掉就等于只能读一屏）。
   */
  serverSegmentOvershootTokens: 400,
  maxToolCallsPerTurn: 8,
  shareRefChars: 200,
  contentIdChars: 320,
  queryChars: 200,
  cursorChars: 128,
  partKeyChars: 64,
} as const;

/**
 * 落历史**不做条数截断**（返工第 4 轮 P1-1）。
 *
 * 曾经这里有个 `SHARE_EXCERPT_RECORD_KEEP = 8`，`attachShareExcerptPairs` 每次写库
 * `pairs.slice(-8)`。后果是：一批 9 个不同 id 的调用（第 1 条真读到字幕，第 2–8 条同参被
 * `DUPLICATE_TOOL_CALL` 拒，第 9 条 `TOOL_CALL_LIMIT`）会把**唯一成功的证据**挤出历史；
 * 而 outbox 那边已 markWritten、`pending=0`，收尾 flush 也不会补回来 —— 健康 DB 下的静默丢证据。
 * 次数上限（`maxToolCallsPerTurn`）只挡「第 N+1 次网络读取」，不挡产生 call/result，所以不能靠它兜底。
 *
 * 现在的口径：**本轮收到的每一次调用都成对保留**，拒绝记录不能抹掉既有成功证据。
 * 体量本身有界，不需要条数上限来兜：
 *  - 每条消息的 metadata 只装**这一轮**的记录（锚点 = 本轮触发消息，不跨轮累积）；
 *  - 成功片段的正文合计受轮次预算 ≤2400 token 夹紧（`SHARE_BUDGETS.excerptsPerUserTurnTokens`）；
 *  - 失败/拒绝记录只有一行结构化说明（各自 ≤ 一次信封量级），条数由本轮 tool_calls 决定；
 *  - 「投影」（下一轮进模型的文本）另有 600 token 上限（`SHARE_EXCERPT_PROJECTION_TOKENS`），
 *    与「历史保留多少」是两件事：保留完整、投影有界。
 */
/** 下一轮投影里这些片段最多占多少 token（与「片段会占未来上下文」的说明一致，但仍要有界）。 */
export const SHARE_EXCERPT_PROJECTION_TOKENS = 600;

const FORBIDDEN_ARGUMENT_KEYS = new Set([
  'url',
  'baseurl',
  'base_url',
  'token',
  'scope',
  'endpoint',
  'headers',
  'cookie',
  'authorization',
  'contenturl',
  'content_url',
  'openurl',
  'originalurl',
]);

/** 结构化失败码（本模块自己的 + 服务端透传的）。 */
export type ShareExcerptToolCode =
  | 'OK'
  | 'INVALID_ARGUMENTS'
  | 'ARGUMENT_NOT_ALLOWED'
  | 'MISSING_TARGET'
  | 'HISTORY_UNAVAILABLE'
  | 'SHARE_REF_INVALID'
  | 'SHARE_REF_AMBIGUOUS'
  | 'SHARE_TARGET_MISMATCH'
  | 'SHARE_NOT_IN_CONTEXT'
  | 'SHARE_CONTENT_NOT_READY'
  | 'INVALID_CURSOR'
  | 'TURN_BUDGET_EXHAUSTED'
  | 'TOOL_CALL_LIMIT'
  | 'DUPLICATE_TOOL_CALL'
  | 'ENDPOINT_NOT_CONFIGURED'
  | 'TRANSPORT_ERROR'
  | string; // 服务端错误码（VERSION_UNAVAILABLE / CONTENT_NOT_FOUND / TIMEOUT ...）

export interface ShareExcerptTarget {
  shareRef: string;
  contentId: string | null;
  contentRevision: number | null;
  partKey: string | null;
  platform: string;
  messageId: string;
  state: ShareState;
  title: string | null;
  /** 有 contentId + contentRevision 且状态是 ready/partial 才能读片段。 */
  readable: boolean;
}

export interface ShareExcerptToolCallLike {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown } | null;
  arguments?: unknown;
}

export interface ShareExcerptCallRecord {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  code: ShareExcerptToolCode;
  chargedTokens: number;
  at: number;
  resultText: string;
}

/** 工具声明（OpenAI function-calling 形状；键序固定，便于前缀缓存稳定）。 */
export function buildShareExcerptsTool() {
  return {
    type: 'function' as const,
    function: {
      name: SHARE_EXCERPTS_TOOL_NAME,
      description: [
        '读取本轮对话里已出现的分享卡（小红书 / 抖音 / B站等）的原始片段：正文、字幕、评论样本。',
        '只能用 shareRef 或 contentId 指定卡片；shareRef 就照抄上下文里 [分享 shr_xxx] 括号里的完整值（抄短了会被拒绝或提示歧义）。',
        '不能传 URL、域名、baseUrl、token、scope —— 地址与授权由系统与服务端决定。',
        '单次最多 1200 token，一个用户轮次里所有调用合计最多 2400 token；超限或失败的返回是结构化的，',
        '这时请基于卡片里已有的简介回答，并说明片段没读到，不要声称读过。',
        '卡片简介已经够回答时不要调用；只有确实需要引用原文/字幕/评论细节时才读。',
      ].join(''),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          shareRef: {
            type: 'string',
            description: '卡片引用：照抄上下文里 [分享 shr_...] 括号内的完整值（允许唯一前缀，但不要自己改写）。',
          },
          contentId: {
            type: 'string',
            description: '内容 ID，形如 bilibili:public:BV1xx411c7mD；只能用上下文卡片里给出的值。',
          },
          query: {
            type: 'string',
            description: '可选：只取包含该词的片段（服务端按原文匹配）。',
          },
          fields: {
            type: 'array',
            items: { type: 'string', enum: [...SHARE_EXCERPT_FIELD_VALUES] },
            description: '可选：要读的字段，默认 text。视频要台词用 transcript，要评论用 comments。',
          },
          partKey: {
            type: 'string',
            description: '可选：分 P / 分轨标识（只有卡片标注了分 P 时才需要）。',
          },
          cursor: {
            type: 'string',
            description: '可选：上一次结果里的 nextCursor，用来接着往后读。',
          },
          maxTokens: {
            type: 'number',
            description: '可选：希望本次返回的 token 上限；系统会夹紧到 1200 与本轮剩余额度。',
          },
          contentRevision: {
            type: 'number',
            description: '可选：仅作提示，实际使用当前卡片的内容版本（模型给的数字不参与校验）。',
          },
        },
      },
    },
  };
}

// ─── 预算 ─────────────────────────────────────────────────────────────

export interface ShareExcerptBudgetSnapshot {
  perCall: number;
  perTurn: number;
  spent: number;
  reserved: number;
  remaining: number;
  calls: number;
}

export type ShareExcerptReservation =
  | { ok: true; grant: number }
  | { ok: false; reason: 'TURN_BUDGET_EXHAUSTED'; remaining: number; snapshot: ShareExcerptBudgetSnapshot };

const positiveInt = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
};

/**
 * 一个用户轮次一份预算。reserve 在**发请求之前**同步扣减可售额度，
 * 因此同一批 tool_calls 并发进来也不会各自按「剩余」算出全额（不会超卖）。
 * settle 用自己重算的 charged 入账（charged ≤ grant），并把预留释放。
 */
export class ShareExcerptBudget {
  readonly perCall: number;
  readonly perTurn: number;
  private spent = 0;
  private reserved = 0;
  private calls = 0;

  constructor(opts: { perCallTokens?: number; perTurnTokens?: number } = {}) {
    // 只允许往下调（测试用），不允许绕过契约上限往上调。
    this.perCall = Math.min(positiveInt(opts.perCallTokens) ?? SHARE_EXCERPT_LIMITS.perCallTokens, SHARE_EXCERPT_LIMITS.perCallTokens);
    this.perTurn = Math.min(positiveInt(opts.perTurnTokens) ?? SHARE_EXCERPT_LIMITS.perTurnTokens, SHARE_EXCERPT_LIMITS.perTurnTokens);
  }

  get remaining(): number {
    return Math.max(0, this.perTurn - this.spent - this.reserved);
  }

  snapshot(): ShareExcerptBudgetSnapshot {
    return {
      perCall: this.perCall,
      perTurn: this.perTurn,
      spent: this.spent,
      reserved: this.reserved,
      remaining: this.remaining,
      calls: this.calls,
    };
  }

  reserve(wantTokens?: number): ShareExcerptReservation {
    const want = Math.min(this.perCall, positiveInt(wantTokens) ?? this.perCall);
    const grant = Math.min(want, this.remaining);
    if (grant < SHARE_EXCERPT_LIMITS.minGrantTokens) {
      return { ok: false, reason: 'TURN_BUDGET_EXHAUSTED', remaining: this.remaining, snapshot: this.snapshot() };
    }
    this.reserved += grant;
    return { ok: true, grant };
  }

  settle(grant: number, charged: number): void {
    this.reserved = Math.max(0, this.reserved - Math.max(0, Math.floor(grant)));
    const spend = Math.min(Math.max(0, Math.floor(charged)), Math.max(0, Math.floor(grant)));
    this.spent = Math.min(this.perTurn, this.spent + spend);
    this.calls += 1;
  }
}

// ─── 可读集合（只认本轮真实投影进模型的分享卡） ──────────────────

export interface ShareExcerptTurnOptions {
  budget?: ShareExcerptBudget;
  endpoint?: ShareEndpoint | null;
  now?: () => number;
  fetchExcerpts?: typeof fetchShareExcerpts;
  timeoutMs?: number;
  messages?: readonly { metadata?: any }[];
}

export interface ShareExcerptTurn {
  targets: Map<string, ShareExcerptTarget>;
  byContentId: Map<string, ShareExcerptTarget>;
  budget: ShareExcerptBudget;
  endpoint: ShareEndpoint | null;
  now: () => number;
  fetchExcerpts: typeof fetchShareExcerpts;
  timeoutMs: number;
  calls: ShareExcerptCallRecord[];
  seenSignatures: Set<string>;
}

function toTarget(att: ShareAttachment): ShareExcerptTarget | null {
  if (!att || typeof att.shareRef !== 'string' || !att.shareRef.trim()) return null;
  const contentId = typeof att.contentId === 'string' && att.contentId.trim() ? att.contentId : null;
  // 版本只在冻结的 contextProjection 里（契约 3.5/6.2）：excerpts 服务端按它做 VERSION_UNAVAILABLE 校验，
  // 所以这里也必须用同一份，别去读 attachment 上不存在的字段。
  const contentRevision = att.contextProjection && typeof att.contextProjection.contentRevision === 'number'
    ? att.contextProjection.contentRevision
    : null;
  const state = (att.state ?? 'queued') as ShareState;
  const readable = !!contentId && contentRevision != null && (state === 'ready' || state === 'partial');
  return {
    shareRef: att.shareRef,
    contentId,
    contentRevision,
    partKey: att.partKey ?? null,
    platform: att.preview?.platformName || String(att.platform ?? '链接'),
    messageId: String(att.messageId ?? ''),
    state,
    title: att.preview?.title ?? null,
    readable,
  };
}

/**
 * 从「本轮真正发给模型的消息」推出可读集合：只有这些消息 metadata.shares 里的卡片能被读。
 * 返回 null 表示本轮没有任何分享卡（调用方不要注入工具，旧行为不变）。
 */
export function createShareExcerptTurn(
  messages: readonly { metadata?: any }[] | null | undefined,
  opts: ShareExcerptTurnOptions = {},
): ShareExcerptTurn | null {
  const targets = new Map<string, ShareExcerptTarget>();
  const byContentId = new Map<string, ShareExcerptTarget>();
  for (const msg of messages ?? []) {
    for (const att of shareAttachmentsOf(msg?.metadata)) {
      const target = toTarget(att);
      if (!target) continue;
      // 同一 shareRef 多张（同一链接被发过多次）：先出现的算数，保证跨轮判定稳定。
      if (!targets.has(target.shareRef)) targets.set(target.shareRef, target);
      if (target.contentId && !byContentId.has(target.contentId)) byContentId.set(target.contentId, target);
    }
  }
  if (targets.size === 0) return null;
  return {
    targets,
    byContentId,
    budget: opts.budget ?? new ShareExcerptBudget(),
    endpoint: opts.endpoint ?? null,
    now: opts.now ?? (() => Date.now()),
    fetchExcerpts: opts.fetchExcerpts ?? fetchShareExcerpts,
    timeoutMs: opts.timeoutMs ?? 15000,
    calls: [],
    seenSignatures: new Set<string>(),
  };
}

/**
 * 本轮是否至少有一张**真能读**的卡。全是不 ready/失败的卡时不要注入工具：
 * 一个只能返回 SHARE_CONTENT_NOT_READY 的工具，只会让模型白试一次并浪费 schema token。
 */
export function hasReadableShareExcerptTarget(turn: ShareExcerptTurn | null | undefined): boolean {
  if (!turn) return false;
  for (const target of turn.targets.values()) {
    if (target.readable) return true;
  }
  return false;
}

// ─── 引用解析（可见标识 = 完整 shareRef；容忍唯一前缀，歧义必须拒绝） ──────

/** 分享引用的形状：`shr_` + 1~64 位字母数字（服务端随机 32 位 hex）。 */
export const SHARE_REF_PATTERN = /^shr_[0-9A-Za-z]{1,64}$/;

export type ShareRefResolution =
  | { ok: true; target: ShareExcerptTarget; matched: 'exact' | 'prefix' }
  | {
      ok: false;
      code: 'SHARE_REF_INVALID' | 'SHARE_REF_AMBIGUOUS' | 'SHARE_NOT_IN_CONTEXT';
      detail: string;
      /** 歧义时的候选完整引用（供模型改抄完整值；不含其它卡的内容）。 */
      candidates: string[];
    };

/**
 * 把模型给的 shareRef 解析成「本轮可读集合」里的一张卡。规则只有三条，宁拒绝不猜：
 *  1. 完整引用精确命中 → 就用它（正常路径，投影里给的就是完整值）；
 *  2. 否则按**前缀**找（只允许 >= minRefPrefixChars），唯一命中才接受 —— 这是对模型抄短的容错；
 *  3. 命中多张 = 歧义，直接拒绝并列出候选完整引用；**绝不**按相似度/长度挑一个，
 *     否则会把 A 卡的内容当成 B 卡的回答（返工卡 t_38463abd P1 的核心要求）。
 * 不在此集合里 → SHARE_NOT_IN_CONTEXT（模型不能指向本轮没出现过的内容）。
 */
export function resolveShareExcerptTarget(
  turn: ShareExcerptTurn,
  rawRef: unknown,
): ShareRefResolution {
  const ref = typeof rawRef === 'string' ? rawRef.trim() : '';
  if (!ref) {
    return { ok: false, code: 'SHARE_REF_INVALID', detail: 'shareRef 为空', candidates: [] };
  }
  const exact = turn.targets.get(ref);
  if (exact) return { ok: true, target: exact, matched: 'exact' };

  if (!SHARE_REF_PATTERN.test(ref)) {
    return {
      ok: false,
      code: 'SHARE_REF_INVALID',
      detail: `shareRef=${clipCodepoints(ref, 48)} 形状不对，应形如 shr_...（照抄上下文里的完整值）`,
      candidates: [],
    };
  }

  if (Array.from(ref).length < SHARE_EXCERPT_LIMITS.minRefPrefixChars) {
    return {
      ok: false,
      code: 'SHARE_NOT_IN_CONTEXT',
      detail: `shareRef=${ref} 不在本轮上下文里（前缀至少 ${SHARE_EXCERPT_LIMITS.minRefPrefixChars} 个字符才能认出是哪张卡）`,
      candidates: [],
    };
  }

  const needle = ref.toLowerCase();
  const hits = [...turn.targets.values()].filter((t) => t.shareRef.toLowerCase().startsWith(needle));
  if (hits.length === 1) return { ok: true, target: hits[0], matched: 'prefix' };
  if (hits.length > 1) {
    return {
      ok: false,
      code: 'SHARE_REF_AMBIGUOUS',
      detail: `前缀 ${ref} 命中 ${hits.length} 张卡，无法确定要读哪一张`,
      candidates: hits.map((t) => t.shareRef),
    };
  }
  return {
    ok: false,
    code: 'SHARE_NOT_IN_CONTEXT',
    detail: '这张卡不在本轮上下文里（只能读本轮对话里出现过的分享卡）',
    candidates: [],
  };
}

// ─── 入参清洗 ────────────────────────────────────────────────────────

interface ParsedArgs {
  shareRef: string | null;
  contentId: string | null;
  query: string | null;
  fields: ShareExcerptField[];
  partKey: string | null;
  cursor: string | null;
  maxTokens: number | null;
  /** 仅作提示：实际版本用卡片自己的 contentRevision。 */
  advisoryRevision: number | null;
}

type ParseOutcome =
  | { ok: true; args: ParsedArgs }
  | { ok: false; code: ShareExcerptToolCode; detail: string };

const stripControl = (value: string): string => value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

const clipCodepoints = (value: string, max: number): string => {
  const cps = Array.from(value);
  return cps.length <= max ? value : cps.slice(0, max).join('');
};

function parseArgs(raw: unknown): ParseOutcome {
  if (raw == null) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'INVALID_ARGUMENTS', detail: '参数必须是一个对象' };
  }
  const src = raw as Record<string, unknown>;

  // 模型不许指定网络位置/凭据/授权范围：命中就拒绝，且一次请求都不发。
  for (const key of Object.keys(src)) {
    const value = (src as any)[key];
    const hasValue = value != null && !(typeof value === 'string' && !value.trim());
    if (hasValue && FORBIDDEN_ARGUMENT_KEYS.has(key.toLowerCase())) {
      return {
        ok: false,
        code: 'ARGUMENT_NOT_ALLOWED',
        detail: `不接受参数 ${key}，只能用 shareRef / contentId 指定本轮上下文里的分享卡`,
      };
    }
  }

  const str = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  };

  const shareRef = str(src.shareRef);
  const contentId = str(src.contentId);
  if (shareRef && Array.from(shareRef).length > SHARE_EXCERPT_LIMITS.shareRefChars) {
    return { ok: false, code: 'INVALID_ARGUMENTS', detail: 'shareRef 过长' };
  }
  if (contentId && Array.from(contentId).length > SHARE_EXCERPT_LIMITS.contentIdChars) {
    return { ok: false, code: 'INVALID_ARGUMENTS', detail: 'contentId 过长' };
  }

  const rawQuery = str(src.query);
  const query = rawQuery ? clipCodepoints(stripControl(rawQuery), SHARE_EXCERPT_LIMITS.queryChars) || null : null;

  let fields: ShareExcerptField[] = ['text'];
  if (src.fields !== undefined && src.fields !== null) {
    if (!Array.isArray(src.fields)) return { ok: false, code: 'INVALID_ARGUMENTS', detail: 'fields 必须是数组' };
    const picked = (src.fields as unknown[])
      .filter((f): f is string => typeof f === 'string')
      .map((f) => f.trim())
      .filter((f, i, arr) => arr.indexOf(f) === i)
      .filter((f): f is ShareExcerptField => (SHARE_EXCERPT_FIELD_VALUES as readonly string[]).includes(f));
    if (picked.length === 0) {
      return { ok: false, code: 'INVALID_ARGUMENTS', detail: `fields 只能取 ${SHARE_EXCERPT_FIELD_VALUES.join('/')}` };
    }
    fields = picked.slice(0, SHARE_EXCERPT_FIELD_VALUES.length);
  }

  const rawPartKey = str(src.partKey);
  const partKey = rawPartKey ? clipCodepoints(stripControl(rawPartKey), SHARE_EXCERPT_LIMITS.partKeyChars) || null : null;

  const rawCursor = str(src.cursor);
  let cursor: string | null = null;
  if (rawCursor) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(rawCursor)) {
      return { ok: false, code: 'INVALID_CURSOR', detail: 'cursor 只能原样使用上一次结果里的 nextCursor' };
    }
    cursor = rawCursor;
  }

  const maxTokens = positiveInt(src.maxTokens);
  const advisoryRevision = typeof src.contentRevision === 'number' && Number.isFinite(src.contentRevision)
    ? Math.floor(src.contentRevision)
    : null;

  return {
    ok: true,
    args: { shareRef, contentId, query, fields, partKey, cursor, maxTokens, advisoryRevision },
  };
}

// ─── 文本组装 ────────────────────────────────────────────────────────

const clockLabel = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

function segmentLine(index: number, seg: ExcerptsResult['segments'][number]): string {
  const time = seg.startMs != null && seg.endMs != null ? ` ${clockLabel(seg.startMs)}-${clockLabel(seg.endMs)}` : '';
  return `${index}. ${seg.field}${time}：${seg.text}`;
}

function failureText(code: string, detail: string, extra?: string): string {
  return [
    `[read_share_excerpts · 未读取] code=${code}: ${detail}`,
    extra || '',
    '片段没有读到。请基于这张分享卡里已有的简介回答，并如实说明片段不可用，不要声称自己读过原文/字幕/评论。',
  ]
    .filter(Boolean)
    .join('\n');
}

function budgetExhaustedText(remaining: number, snapshot: ShareExcerptBudgetSnapshot): string {
  return failureText(
    'TURN_BUDGET_EXHAUSTED',
    `本轮片段预算已用尽（已用≈${snapshot.spent}t / 上限 ${snapshot.perTurn}t，剩余≈${remaining}t，单次上限 ${snapshot.perCall}t）`,
  );
}

// ─── 执行 ────────────────────────────────────────────────────────────

export interface ExecuteShareExcerptInput {
  toolCall?: ShareExcerptToolCallLike | null;
  args?: unknown;
  turn: ShareExcerptTurn;
  endpoint?: ShareEndpoint | null;
  /**
   * 本轮拿不到确定的持久化锚点时为 true：**不读**，直接返回 `HISTORY_UNAVAILABLE`。
   * 生产路径由 `dispatchShareExcerptToolCall` 依据 recorder.anchorId 设置，
   * 保证「返回给模型的片段」一定有成对落库的去处（卡片第 3 条）。
   */
  historyUnavailable?: boolean;
}

export interface ExecuteShareExcerptResult {
  text: string;
  ok: boolean;
  code: ShareExcerptToolCode;
  chargedTokens: number;
  record: ShareExcerptCallRecord;
}

function toolCallIdOf(toolCall: ShareExcerptToolCallLike | null | undefined, index: number): string {
  const raw = toolCall?.id;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : `call_${SHARE_EXCERPTS_TOOL_NAME}_${index}`;
}

function argsOf(toolCall: ShareExcerptToolCallLike | null | undefined, explicit: unknown): unknown {
  if (explicit !== undefined) return explicit;
  const raw = toolCall?.function?.arguments ?? toolCall?.arguments;
  if (typeof raw === 'string') {
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return raw; // 交给 parseArgs 判 INVALID_ARGUMENTS
    }
  }
  return raw;
}

/**
 * 执行一次 read_share_excerpts 调用。永远返回结构化结果（不抛），
 * 记录（call+result）同时塞进 turn.calls，供落历史/测试断言。
 */
export async function executeShareExcerptToolCall(input: ExecuteShareExcerptInput): Promise<ExecuteShareExcerptResult> {
  const { turn } = input;
  const argsRaw = argsOf(input.toolCall, input.args);
  const recordIndex = turn.calls.length;
  const toolCallId = toolCallIdOf(input.toolCall, recordIndex);
  const name = typeof input.toolCall?.function?.name === 'string' && input.toolCall.function.name.trim()
    ? input.toolCall.function.name.trim()
    : SHARE_EXCERPTS_TOOL_NAME;

  const finish = (ok: boolean, code: ShareExcerptToolCode, text: string, chargedTokens: number, argsForRecord: Record<string, unknown>): ExecuteShareExcerptResult => {
    const record: ShareExcerptCallRecord = {
      toolCallId,
      name,
      args: argsForRecord,
      ok,
      code,
      chargedTokens,
      at: turn.now(),
      resultText: text,
    };
    turn.calls.push(record);
    return { text, ok, code, chargedTokens, record };
  };

  if (name !== SHARE_EXCERPTS_TOOL_NAME) {
    const text = failureText('UNKNOWN_TOOL', `本模块只处理 ${SHARE_EXCERPTS_TOOL_NAME}`);
    return finish(false, 'UNKNOWN_TOOL', text, 0, {});
  }

  // 历史必须成对留存（卡片第 3 条）：拿不到本轮确定的持久化锚点时**不读**。
  // 读到了却写不进任何消息的 metadata，就成了「读过却没有记录」——下一轮既回放不出来，
  // 模型只能凭记忆复述片段（等于给了它一个无法追溯的来源）。宁可不给片段，也不给不留痕的片段。
  // 这个判定在预算/网络之前，所以拒绝时一次请求都不发。
  if (input.historyUnavailable) {
    return finish(
      false,
      'HISTORY_UNAVAILABLE',
      failureText('HISTORY_UNAVAILABLE', '这一轮没有可确定的持久化位置（拿不到本轮消息 id），读到的片段无法成对记进历史，所以这次不读取'),
      0,
      {},
    );
  }

  // 每轮调用次数硬顶：预算用完前先把「模型开始复读」这种情况挡住。
  if (turn.calls.length >= SHARE_EXCERPT_LIMITS.maxToolCallsPerTurn) {
    return finish(false, 'TOOL_CALL_LIMIT', failureText('TOOL_CALL_LIMIT', `本轮调用次数已达上限 ${SHARE_EXCERPT_LIMITS.maxToolCallsPerTurn} 次`), 0, {});
  }

  const parsed = parseArgs(argsRaw);
  if (!parsed.ok) {
    return finish(false, parsed.code, failureText(parsed.code, parsed.detail), 0, {
      raw: typeof argsRaw === 'object' && argsRaw ? JSON.parse(JSON.stringify(argsRaw)) : {},
    });
  }
  const args = parsed.args;
  const recordArgs: Record<string, unknown> = {};
  if (args.shareRef) recordArgs.shareRef = args.shareRef;
  if (args.contentId) recordArgs.contentId = args.contentId;
  if (args.query) recordArgs.query = args.query;
  if (args.fields) recordArgs.fields = args.fields;
  if (args.partKey) recordArgs.partKey = args.partKey;
  if (args.cursor) recordArgs.cursor = args.cursor;
  if (args.maxTokens) recordArgs.maxTokens = args.maxTokens;

  // 目标解析：只在本轮可见卡片里找，绝不按模型给的名字去猜内容。
  let target: ShareExcerptTarget | undefined;
  if (args.shareRef) {
    const resolved = resolveShareExcerptTarget(turn, args.shareRef);
    if (!resolved.ok) {
      const extra = resolved.candidates.length
        ? `候选（请照抄其中一个完整值）：${resolved.candidates.join(', ')}`
        : '';
      return finish(false, resolved.code, failureText(resolved.code, resolved.detail, extra), 0, recordArgs);
    }
    target = resolved.target;
    if (args.contentId && target.contentId !== args.contentId) {
      return finish(false, 'SHARE_TARGET_MISMATCH', failureText('SHARE_TARGET_MISMATCH', 'shareRef 与 contentId 不是同一张卡'), 0, recordArgs);
    }
  } else if (args.contentId) {
    target = turn.byContentId.get(args.contentId);
  }

  if (!target) {
    const code: ShareExcerptToolCode = args.shareRef || args.contentId ? 'SHARE_NOT_IN_CONTEXT' : 'MISSING_TARGET';
    const detail = code === 'MISSING_TARGET'
      ? '需要 shareRef 或 contentId 之一'
      : '这张卡不在本轮上下文里（只能读本轮对话里出现过的分享卡）';
    return finish(false, code, failureText(code, detail), 0, recordArgs);
  }
  if (!target.readable || !target.contentId || target.contentRevision == null) {
    return finish(
      false,
      'SHARE_CONTENT_NOT_READY',
      failureText('SHARE_CONTENT_NOT_READY', `这张卡当前状态是 ${target.state}，内容还没读到，没有片段可给`),
      0,
      recordArgs,
    );
  }

  const endpoint = input.endpoint ?? turn.endpoint;
  if (!endpoint) {
    return finish(false, 'ENDPOINT_NOT_CONFIGURED', failureText('ENDPOINT_NOT_CONFIGURED', '没有配置主代理地址，读不了片段'), 0, recordArgs);
  }

  // 同一组参数重复调用：不重复花钱，也不再打一次网络。
  // 只对**成功读过**的组合去重：失败（超时/网络）时允许模型用同参重试一次，
  // 否则一次抖动就把这张卡这一轮锁死。重复次数仍受 maxToolCallsPerTurn 兜底。
  const signature = JSON.stringify([target.shareRef, args.fields, args.query, args.partKey, args.cursor, args.maxTokens]);
  if (turn.seenSignatures.has(signature)) {
    return finish(
      false,
      'DUPLICATE_TOOL_CALL',
      failureText('DUPLICATE_TOOL_CALL', '这组参数刚刚已经读过，结果就在上一条工具结果里，请直接使用，不要原地重复'),
      0,
      recordArgs,
    );
  }

  const reservation = turn.budget.reserve(args.maxTokens ?? undefined);
  if (!reservation.ok) {
    return finish(false, 'TURN_BUDGET_EXHAUSTED', budgetExhaustedText(reservation.remaining, reservation.snapshot), 0, recordArgs);
  }
  const grant = reservation.grant;
  // 服务端拿到的 maxTokens 要预留「信封 + 可能溢出的那一条切片」，剩下的才是正文额度。
  const requestedMaxTokens = Math.max(
    1,
    grant - SHARE_EXCERPT_LIMITS.envelopeTokens - SHARE_EXCERPT_LIMITS.serverSegmentOvershootTokens,
  );
  let charged = 0;
  try {
    const response: ShareCallResult<ExcerptsResult> = await turn.fetchExcerpts(
      {
        contentId: target.contentId,
        // 版本只认卡片（服务端权威值）；模型给的 contentRevision 仅作提示，不参与校验。
        contentRevision: target.contentRevision,
        query: args.query,
        fields: args.fields,
        partKey: args.partKey ?? target.partKey,
        cursor: args.cursor,
        maxTokens: requestedMaxTokens,
      } satisfies ExcerptsInput,
      { endpoint, timeoutMs: turn.timeoutMs },
    );

    if (!response.ok) {
      const code = String(response.error || `HTTP_${response.status || 0}`);
      return finish(false, code, failureText(code, `服务端没有返回片段（HTTP ${response.status || 0}）`), 0, recordArgs);
    }

    const body = response.value;
    if (!body.segments || body.segments.length === 0) {
      return finish(
        true,
        'NO_SEGMENTS',
        [
          `[read_share_excerpts · 无匹配片段] ${target.shareRef} contentRevision=${target.contentRevision} 字段=${args.fields.join('/')}${args.query ? ` query=${args.query}` : ''}`,
          '这次请求成功了，但上述字段/关键词下没有可返回的片段。别把「没匹配到」说成「读过了」，需要就换个 query 或字段再试。',
        ].join('\n'),
        0,
        recordArgs,
      );
    }
    const bodyAllowance = Math.max(1, grant - SHARE_EXCERPT_LIMITS.envelopeTokens);
    const lines: string[] = [];
    let bodyEstimate = 0;
    let clientTruncated = false;
    for (const seg of body.segments ?? []) {
      const line = segmentLine(lines.length + 1, seg);
      const cost = estimateShareTokens(line);
      if (lines.length > 0 && bodyEstimate + cost > bodyAllowance) {
        clientTruncated = true;
        break;
      }
      if (lines.length === 0 && cost > bodyAllowance) {
        // 单条就超：按码点硬切，绝不把整段塞进去撑破预算。
        const head = Array.from(line).slice(0, Math.max(0, bodyAllowance - 1)).join('') + '…';
        lines.push(head);
        bodyEstimate += estimateShareTokens(head);
        clientTruncated = true;
        break;
      }
      lines.push(line);
      bodyEstimate += cost;
    }

    const remainingBefore = turn.budget.remaining;
    const budgetAfterHint = Math.max(0, remainingBefore - Math.min(grant, bodyEstimate + SHARE_EXCERPT_LIMITS.envelopeTokens));
    const header = [
      `[read_share_excerpts · OK] ${target.shareRef}`,
      `contentRevision=${target.contentRevision}`,
      `字段=${args.fields.join('/')}`,
      args.query ? `query=${args.query}` : '',
      `段数=${lines.length}`,
      `预算剩余≈${budgetAfterHint}t`,
    ].filter(Boolean).join(' · ');

    let footer = '';
    if (clientTruncated) {
      footer = '（本次额度只够到这里，后面的片段没返回；想读更靠后的内容就换更精确的 query，或先基于已有内容回答）';
    } else if (body.nextCursor != null) {
      footer = `（可续读：cursor=${body.nextCursor}）`;
    }

    const text = [header, ...lines, footer].filter(Boolean).join('\n');
    turn.seenSignatures.add(signature);
    charged = estimateShareTokens(text);
    if (charged > grant) {
      // 理论上信封预留保证不会走到这里；真走到了就按额度硬切，宁可少给也不超卖。
      const clipped = Array.from(text).slice(0, Math.max(0, grant - 1)).join('') + '…';
      charged = estimateShareTokens(clipped);
      return finish(true, 'OK', clipped, charged, recordArgs);
    }
    return finish(true, 'OK', text, charged, recordArgs);
  } catch (err: any) {
    const code = err?.name === 'AbortError' || err?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR';
    return finish(false, code, failureText(code, String(err?.message || err)), 0, recordArgs);
  } finally {
    turn.budget.settle(grant, charged);
  }
}

// ─── 落历史 / 下一轮投影 ─────────────────────────────────────────────

export const SHARE_EXCERPT_META_KEY = 'shareExcerpts';

export interface ShareExcerptPairRecord {
  version: 1;
  pairs: Array<{
    call: { toolCallId: string; name: string; args: Record<string, unknown>; at: number };
    result: { ok: boolean; code: ShareExcerptToolCode; chargedTokens: number; text: string };
  }>;
}

/**
 * 把本轮 call/result 成对挂到消息 metadata 上（只增不改已有键）。
 * 成对存的意义：下一轮投影能还原「模型问了什么 → 系统回了什么」，不会只回放一段孤立片段，
 * 也不会因为片段没落历史而让模型下一轮「记得自己读过」却拿不出依据。
 *
 * 幂等：同一 toolCallId 只保留一条。逐次落库（每执行完一次工具就写）与收尾 flush 会重复
 * 提交同一批记录，DB 侧重试也可能重放，这里必须按 id 去重，否则历史里会出现重复对。
 *
 * 不截断（返工第 4 轮 P1-1）：本轮收到的每一次调用都留着，**拒绝记录不能挤掉成功证据**。
 * 曾经 `pairs.slice(-8)` 会让一批 9 个 id 的调用把第 1 条成功记录挤出历史（见文件头注释）。
 * 体量有界来自「一条消息 = 一轮」+ 轮次预算 2400 token + 失败记录只有一行；投影另有 600 token 上限。
 */
export function attachShareExcerptPairs(prev: any, records: readonly ShareExcerptCallRecord[]): any {
  const base = prev && typeof prev === 'object' ? prev : {};
  const existing: ShareExcerptPairRecord | null = base[SHARE_EXCERPT_META_KEY] ?? null;
  const pairs = Array.isArray(existing?.pairs) ? [...existing!.pairs] : [];
  const seen = new Set<string>();
  for (const pair of pairs) {
    const id = pair?.call?.toolCallId;
    if (typeof id === 'string' && id) seen.add(id);
  }
  for (const record of records ?? []) {
    const id = typeof record?.toolCallId === 'string' ? record.toolCallId.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    pairs.push({
      call: { toolCallId: id, name: record.name, args: record.args, at: record.at },
      result: { ok: record.ok, code: record.code, chargedTokens: record.chargedTokens, text: record.resultText },
    });
  }
  if (pairs.length === 0) return base;
  return {
    ...base,
    [SHARE_EXCERPT_META_KEY]: {
      version: 1,
      // 全部保留（不 slice）：拒绝/超限记录不能把已成功的片段挤出历史。
      pairs,
    } satisfies ShareExcerptPairRecord,
  };
}

export function readShareExcerptPairs(metadata: any): ShareExcerptPairRecord | null {
  const raw = metadata?.[SHARE_EXCERPT_META_KEY];
  if (!raw || !Array.isArray(raw.pairs) || raw.pairs.length === 0) return null;
  return raw as ShareExcerptPairRecord;
}

/**
 * 下一轮投影：把本轮记录的 call/result 成对渲染成有界文本。
 * 只接受带 tool_call_id 的成对记录；budget 默认 600 token，超了按顺序截断（稳定、不抖动）。
 *
 * 角色：assistant（兜底锚点）与 user（正常锚点——记录挂在本轮触发消息上）都要投影；
 * 其它角色（system/tool）不背工具记录。
 */
export function renderShareExcerptPairProjection(
  metadata: any,
  role: string | null | undefined,
  opts: { maxTokens?: number } = {},
): string | null {
  if (role !== 'assistant' && role !== 'user') return null;
  const record = readShareExcerptPairs(metadata);
  if (!record) return null;
  const budget = Math.max(1, Math.min(opts.maxTokens ?? SHARE_EXCERPT_PROJECTION_TOKENS, SHARE_EXCERPT_PROJECTION_TOKENS));
  const chunks: string[] = [];
  let used = 0;
  for (const pair of record.pairs) {
    if (!pair?.call?.toolCallId || !pair?.result) continue;
    const args = pair.call.args && Object.keys(pair.call.args).length ? JSON.stringify(pair.call.args) : '{}';
    const head = `- ${pair.call.name}(${args}) #${pair.call.toolCallId} → ${pair.result.ok ? 'OK' : pair.result.code} · ≈${pair.result.chargedTokens}t`;
    const body = String(pair.result.text || '').split('\n').filter(Boolean).slice(1).join('\n'); // 去掉重复的标题行
    const block = body ? `${head}\n${body}` : head;
    const remaining = budget - used;
    if (remaining <= 40) break;
    const clipped = Array.from(block).length <= remaining
      ? block
      : Array.from(block).slice(0, Math.max(0, remaining - 1)).join('') + '…';
    chunks.push(clipped);
    used += estimateShareTokens(clipped);
  }
  if (chunks.length === 0) return null;
  return [
    `[read_share_excerpts 记录 · ${chunks.length} 次调用]`,
    ...chunks,
    '（这是此前真实读到的片段；它们只覆盖当时请求的部分，不代表完整内容）',
  ].join('\n');
}

/**
 * 找本轮该挂记录的那条消息：**本轮请求上下文里的最后一条消息**（触发本轮的那条）。
 *
 * 为什么不用「本次生成开始后落库的助手消息」当锚点：那要求最终自然语言回复成功落库，
 * 模型失败/用户取消/后处理异常时就无锚可挂，记录直接丢（返工卡 t_38463abd P1 第 2 条）。
 * 触发消息在发请求前就已经在库里、id 确定，逐次落库不依赖后续任何一步成功，
 * 也不可能挂到并发的其它轮次上（id 来自本轮 contextMsgs 快照，不是时间戳扫库）。
 *
 * 反向扫描的边界（返工第 5 轮 P1）：**只认最后一条非背景消息本身**。
 *  - 尾部 `system` 背景项（本轮拼进去的提示块）不是触发消息，可以跳过；
 *  - 跳过之后遇到的那条就是触发消息，它的 id 必须可持久化；**不合法就返回 null**，
 *    绝不继续往前找「上一条有 id 的 user/assistant」——那会把本轮记录健康地写进
 *    另一个轮次的消息（committed saver 会成功、unsaved=false，门形同虚设）。
 *  - `tool` 等中间态角色不是触发消息，同样返回 null（不是跳到更早的消息）。
 */
export function pickShareExcerptTurnAnchor(
  messages: readonly { id?: unknown; role?: unknown }[] | null | undefined,
): number | null {
  const list = messages ?? [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const msg = list[i] as { id?: unknown; role?: unknown } | null | undefined;
    const role = msg?.role;
    // 尾部系统提示（本轮拼的背景块）不是触发消息，可跳过。
    if (role === 'system') continue;
    // 触发消息只可能是 user/assistant；无 role 的裸对象（旧导入/测试）按触发消息处理。
    if (role !== undefined && role !== 'user' && role !== 'assistant') return null;
    const id = msg?.id;
    return typeof id === 'number' && Number.isFinite(id) && Number.isInteger(id) && id > 0 ? id : null;
  }
  return null;
}

/**
 * 一轮「分享片段工具」的准备结果：可注入的 turn + 确定的本轮锚点。
 *
 * 单独抽出来是为了让 hook 与测试走**同一口径**：卡片集合、可读性、触发消息 id 三道门
 * 都在这里判定，任何一道不过就 `turn: null`（不注入工具）+ `anchorId: null`
 * （dispatch 侧还会再拒一次 `HISTORY_UNAVAILABLE`）。
 */
export interface ShareExcerptTurnPrep {
  turn: ShareExcerptTurn | null;
  anchorId: number | null;
  reason: 'ok' | 'no_target' | 'no_readable_target' | 'no_anchor';
}

export function prepareShareExcerptTurn(
  messages: readonly { id?: unknown; role?: unknown; metadata?: any }[] | null | undefined,
  opts: ShareExcerptTurnOptions = {},
): ShareExcerptTurnPrep {
  const turn = createShareExcerptTurn(messages, opts);
  if (!turn) return { turn: null, anchorId: null, reason: 'no_target' };
  // 一张能读的卡都没有（全是解析中/失败）时不注入：只给一个注定报错的工具没有意义。
  if (!hasReadableShareExcerptTarget(turn)) return { turn: null, anchorId: null, reason: 'no_readable_target' };
  // 历史必须成对留存：拿不到本轮触发消息的持久化 id 就**不读**（连工具都不注入）。
  const anchorId = pickShareExcerptTurnAnchor(messages);
  if (anchorId == null) return { turn: null, anchorId: null, reason: 'no_anchor' };
  return { turn, anchorId, reason: 'ok' };
}

/** 成对记录写库的回调（测试注入；生产是 DB.updateMessageMetadata + attachShareExcerptPairs）。 */
export type ShareExcerptPairSaver = (messageId: number, records: readonly ShareExcerptCallRecord[]) => Promise<void>;

/**
 * 待补偿队列与重试的上界（不是无限重试，也不会无限堆内存）。
 *  - perAnchorRecords / anchors：失败批次最多留多少（本轮 + 最近几轮），超了丢最旧的并明确报错。
 *    `perAnchorRecords` 必须**明显高于一轮可能产生的记录数**（返工第 4 轮 P1-1）：次数上限只挡
 *    「第 N+1 次网络读取」，一批 tool_calls 里被拒的每一条仍会产生记录；16 太近，一批 17+ 条的
 *    失败批次会从队列里挤掉最旧的未落库记录。256 是内存安全阀，真实一轮远到不了。
 *  - flushAttempts：每次 flush 最多再尝试几轮写库；hook 有两个收尾点（成功尾部 + finally），
 *    所以一整轮的尝试次数上界是 `2 × flushAttempts`，再加每次 dispatch 自带的那一次。
 */
export const SHARE_EXCERPT_OUTBOX_LIMITS = {
  perAnchorRecords: 256,
  anchors: 8,
  flushAttempts: 3,
  /** 「已写成功」这一事实最多记多少条（跨轮共享；只增不去重写，容量只防无界增长）。 */
  writtenKeys: 512,
} as const;

export interface ShareExcerptOutboxEntry {
  anchorId: number;
  records: readonly ShareExcerptCallRecord[];
}

/**
 * 未落库记录的**待补偿队列**。
 *
 * 语义（返工卡 t_38463abd P1 第 2 条）：写库失败的批次**留在这里**——不标成已保存，
 * 也不靠 `console.warn` 就算完；之后的 `record`（下一次工具调用）与 `flush`（收尾路径）
 * 会在 `SHARE_EXCERPT_OUTBOX_LIMITS` 的上界内重试同一批，成功后才移除。
 * 于是「第一次失败、第二次会成功」的瞬时故障由**真实生产收尾路径**补上，而不是只有测试里
 * 手动再调一次 `record` 才补。
 *
 * 每条记录带自己的 `anchorId`（原始触发消息 id），所以跨轮重试仍然写回同一条消息，
 * 不会挂到后来的轮次上。容量有界：超限时丢最旧的锚点并 `console.error` 明确说丢了多少。
 *
 * 去重状态（哪些「锚点 + toolCallId」已经真正写成功）也放在这里，而不是每个记录器各存一份：
 * 队列是跨轮共享的，写成功也可能由**另一个**记录器（下一次 dispatch / 收尾 flush）完成；
 * 若各存一份，A 轮的记录器永远不知道自己那批已被 B 轮写下，统计会失真（返工第 3 轮 P1-1）。
 */
export class ShareExcerptPairOutbox {
  private readonly bins = new Map<number, Map<string, ShareExcerptCallRecord>>();
  private readonly written = new Set<string>();

  /** 去重键 = 锚点 + toolCallId；中间夹 NUL 防止拼接歧义。 */
  private static key(anchorId: number, toolCallId: string): string {
    return `${anchorId}\u0000${toolCallId}`;
  }

  add(anchorId: number, records: readonly ShareExcerptCallRecord[]): void {
    if (!Number.isFinite(anchorId)) return;
    let bin = this.bins.get(anchorId);
    if (!bin) {
      bin = new Map();
      this.bins.set(anchorId, bin);
    }
    for (const record of records ?? []) {
      const id = typeof record?.toolCallId === 'string' ? record.toolCallId.trim() : '';
      if (!id) continue;
      if (!bin.has(id)) bin.set(id, record);
    }
    while (bin.size > SHARE_EXCERPT_OUTBOX_LIMITS.perAnchorRecords) {
      const oldest = bin.keys().next().value as string | undefined;
      if (oldest == null) break;
      bin.delete(oldest);
      console.error('[share-excerpt] 待补偿队列超过单消息上限，丢弃最旧的一条未落库记录:', oldest);
    }
    while (this.bins.size > SHARE_EXCERPT_OUTBOX_LIMITS.anchors) {
      const oldestAnchor = this.bins.keys().next().value as number | undefined;
      if (oldestAnchor == null) break;
      this.bins.delete(oldestAnchor);
      console.error('[share-excerpt] 待补偿队列超过消息数上限，丢弃最旧消息的未落库记录:', oldestAnchor);
    }
  }

  /** 按锚点分组的待写批次（锚点顺序 = 加入顺序，便于日志与测试断言稳定）。 */
  entries(): ShareExcerptOutboxEntry[] {
    const out: ShareExcerptOutboxEntry[] = [];
    for (const [anchorId, bin] of this.bins) {
      if (bin.size === 0) continue;
      out.push({ anchorId, records: [...bin.values()] });
    }
    return out;
  }

  clear(anchorId: number, toolCallIds: readonly string[]): void {
    const bin = this.bins.get(anchorId);
    if (!bin) return;
    for (const id of toolCallIds) bin.delete(id);
    if (bin.size === 0) this.bins.delete(anchorId);
  }

  /** 未落库条数：给绝对值就是某个锚点，不给就是全部（含往轮遗留）。 */
  pendingCount(anchorId?: number): number {
    if (typeof anchorId === 'number') return this.bins.get(anchorId)?.size ?? 0;
    let total = 0;
    for (const bin of this.bins.values()) total += bin.size;
    return total;
  }

  /** 这条（锚点, toolCallId）是否已经**真正写成功**（事务提交过；跨轮共享这一事实）。 */
  hasWritten(anchorId: number, toolCallId: string): boolean {
    if (!Number.isFinite(anchorId) || !toolCallId) return false;
    return this.written.has(ShareExcerptPairOutbox.key(anchorId, toolCallId));
  }

  /** 标记（锚点, toolCallId）已写成功；容量有界，超限丢最旧的（只影响统计精度，不影响正确性）。 */
  markWritten(anchorId: number, toolCallId: string): void {
    if (!Number.isFinite(anchorId) || !toolCallId) return;
    const key = ShareExcerptPairOutbox.key(anchorId, toolCallId);
    if (this.written.has(key)) return;
    this.written.add(key);
    while (this.written.size > SHARE_EXCERPT_OUTBOX_LIMITS.writtenKeys) {
      const oldest = this.written.values().next().value as string | undefined;
      if (oldest == null) break;
      this.written.delete(oldest);
    }
  }

  /** 已写成功的条数：给锚点算这个锚点，不给算全部。 */
  writtenCount(anchorId?: number): number {
    if (typeof anchorId !== 'number') return this.written.size;
    const prefix = `${anchorId}\u0000`;
    let count = 0;
    for (const key of this.written) if (key.startsWith(prefix)) count += 1;
    return count;
  }
}

/** 生产用的进程内待补偿队列（hook 显式传入；测试默认每个 recorder 私有，互不污染）。 */
export const SHARE_EXCERPT_OUTBOX = new ShareExcerptPairOutbox();

export interface ShareExcerptRecorderSnapshot {
  anchorId: number | null;
  /** 本锚点已成功写库的条数（共享队列里的事实；可能是别的轮次补偿写下的）。 */
  recorded: number;
  /** 共享待补偿队列里已知写成功的（锚点, toolCallId）总数（含往轮）。 */
  recordedAll: number;
  /** 写库失败次数（每轮失败计一次；失败批次留在待补偿队列，不会被标成已写）。 */
  failures: number;
  /** 当前排队的写操作数（>0 表示还有没落地的写入）。 */
  pendingWrites: number;
  /** **本锚点**还没落库的记录条数（失败后在这里等 dispatch/flush 有界重试）。 */
  pendingRecords: number;
  /** 待补偿队列里所有锚点的未落库记录总数（含往轮遗留）。 */
  outboxPending: number;
  /** 待补偿队列里还有任何未落库记录（含往轮遗留）→ true。这时**不能对外声称已保存**。 */
  unsaved: boolean;
  lastError: string | null;
}

export interface ShareExcerptPairRecorderOptions {
  anchorId: number | null;
  savePairs: ShareExcerptPairSaver;
  /** 跨轮共享的待补偿队列（生产传 SHARE_EXCERPT_OUTBOX；不传则本记录器私有）。 */
  outbox?: ShareExcerptPairOutbox;
  /** 每次 flush 最多再尝试几轮（默认且上限 SHARE_EXCERPT_OUTBOX_LIMITS.flushAttempts）。 */
  maxAttemptsPerFlush?: number;
  /** 两轮重试之间的等待（默认 0；本地 IDB 失败通常是即时的，不需要退避）。 */
  retryDelayMs?: number;
  /** 持续失败的可见上报（默认 console.error；测试可注入断言）。 */
  reportUnsaved?: (info: { anchorId: number | null; pending: number; lastError: string }) => void;
}

/**
 * 本轮工具记录的持久化器：**每执行完一次工具就成对写库**，而不是等整轮回复写完。
 *
 * 保证（对应契约「工具 call/result 必须成对保留在历史里」）：
 *  - 成对：call 与 result 在同一批、同一次 metadata 写入里落盘，不存在只有一半。
 *  - 及时：读成功/失败/超限/取消都会立刻落，后续模型请求失败或用户中断都不影响已读过的调用。
 *  - 幂等：同一 **（锚点, toolCallId）** 只写一次（内存去重键带锚点 + attachShareExcerptPairs
 *    落库侧按 id 去重）。光用裸 toolCallId 去重会出事：共享待补偿队列里，上一轮（消息 101）
 *    与这一轮（消息 404）完全可能都叫 `call_1`；先写成功 101 就按 id 把 404 当成「已写」清掉，
 *    404 的片段根本没落库却被报成 pending=0 —— 见返工第 3 轮 P1。
 *  - 串行：同一记录器内的写入排在同一条 promise 链上，避免并发 read-modify-write 互相覆盖。
 *  - **不丢**：写库失败只记账并把批次留在待补偿队列（`ShareExcerptPairOutbox`），
 *    下一次 `record`/`flush` 有界重试；重试后仍失败 → `snapshot().unsaved === true` +
 *    `console.error`，明确「没保存、在待补偿」，不再承诺已保存。
 *  - 无锚不猜：anchorId 为空时既不写也不猜别的消息；生产路径在读取前就拒绝（见 dispatch）。
 */
export class ShareExcerptPairRecorder {
  readonly anchorId: number | null;
  private readonly savePairs: ShareExcerptPairSaver;
  private readonly outbox: ShareExcerptPairOutbox;
  private readonly maxAttemptsPerFlush: number;
  private readonly retryDelayMs: number;
  private readonly reportUnsaved: (info: { anchorId: number | null; pending: number; lastError: string }) => void;
  private queue: Promise<void> = Promise.resolve();
  private failures = 0;
  private writes = 0;
  private queued = 0;
  private lastError: string | null = null;
  private unsavedReported = false;

  constructor(opts: ShareExcerptPairRecorderOptions) {
    this.anchorId = typeof opts.anchorId === 'number' && Number.isFinite(opts.anchorId) ? opts.anchorId : null;
    this.savePairs = opts.savePairs;
    this.outbox = opts.outbox ?? new ShareExcerptPairOutbox();
    const wanted = Math.floor(opts.maxAttemptsPerFlush ?? SHARE_EXCERPT_OUTBOX_LIMITS.flushAttempts);
    this.maxAttemptsPerFlush = Math.max(1, Math.min(Number.isFinite(wanted) ? wanted : 1, SHARE_EXCERPT_OUTBOX_LIMITS.flushAttempts));
    this.retryDelayMs = Math.max(0, Math.floor(opts.retryDelayMs ?? 0));
    this.reportUnsaved = opts.reportUnsaved ?? ((info) => {
      console.error(
        `[share-excerpt] 工具记录未能写入历史（待补偿）：still-unpersisted=${info.pending} anchor=${info.anchorId ?? 'none'} lastError=${info.lastError}`,
      );
    });
  }

  /**
   * 落一批记录。可重复调用；返回的 promise 在**这一轮**写库尝试结束后 resolve（永不 reject）。
   * 同一批里已经写成功过的 id 会被跳过；失败的留在待补偿队列里等 flush / 下一次 dispatch 重试。
   */
  record(records: readonly ShareExcerptCallRecord[] | null | undefined): Promise<void> {
    const anchor = this.anchorId;
    if (anchor == null) return this.queue;
    // 只按**本锚点**的（锚点, id）判断是否已写：别的轮次同 id 的批次不能被当成本轮已写。
    const fresh = (records ?? []).filter((r) => {
      if (typeof r?.toolCallId !== 'string' || !r.toolCallId) return false;
      return !this.outbox.hasWritten(anchor, r.toolCallId);
    });
    if (fresh.length === 0) return this.queue;
    this.outbox.add(anchor, fresh);
    return this.enqueueAttempt();
  }

  private enqueueAttempt(): Promise<void> {
    this.queued += 1;
    this.queue = this.queue.then(async () => {
      try {
        await this.writePending();
      } finally {
        this.queued = Math.max(0, this.queued - 1);
      }
    });
    return this.queue;
  }

  /**
   * 写一轮：待补偿队列里的**所有**批次（本轮 pending + 之前失败留下的），按锚点合并成一次写。
   * 所以后续的新调用不会遗漏旧的失败批次——它们还在同一个队列里按原始锚点重试。
   */
  private async writePending(): Promise<void> {
    for (const entry of this.outbox.entries()) {
      // 按（锚点, toolCallId）判断：别的锚点写成功过同 id 的记录，不代表这一条也写过了。
      const still = entry.records.filter((r) => !this.outbox.hasWritten(entry.anchorId, r.toolCallId));
      if (still.length === 0) {
        // 该锚点的这批都已是「本队列确认写成功」的（只可能来自同一队列重复入队 / 别的记录器已写）：
        // 只清这个锚点自己的这些 id，绝不碰别的锚点。
        this.outbox.clear(entry.anchorId, entry.records.map((r) => r.toolCallId));
        continue;
      }
      try {
        await this.savePairs(entry.anchorId, still);
        for (const r of still) this.outbox.markWritten(entry.anchorId, r.toolCallId);
        this.outbox.clear(entry.anchorId, still.map((r) => r.toolCallId));
        this.writes += 1;
        this.unsavedReported = false;
      } catch (e: any) {
        this.failures += 1;
        this.lastError = String(e?.message || e);
        // 失败批次留在待补偿队列里（不丢、也不标成已写）。一个锚点失败不挡其它锚点继续写。
        console.warn('[share-excerpt] 工具记录落历史失败（保留在待补偿队列，收尾 flush 有界重试）:', e);
      }
    }
  }

  /**
   * 收尾：等已排队的写入落地，再对仍留在待补偿队列里的批次做**有界重试**。
   * 重试次数用尽还失败 → `snapshot().unsaved === true`，并按 `reportUnsaved` 明确上报
   * 「没保存、在待补偿」（默认 console.error）。flush 永不 reject。
   */
  async flush(): Promise<void> {
    await this.queue;
    for (let round = 0; round < this.maxAttemptsPerFlush; round++) {
      if (this.outbox.pendingCount() === 0) return;
      if (round > 0 && this.retryDelayMs > 0) await new Promise((r) => setTimeout(r, this.retryDelayMs));
      await this.enqueueAttempt();
    }
    if (this.outbox.pendingCount() > 0) this.reportIfUnsaved();
  }

  private reportIfUnsaved(): void {
    if (this.unsavedReported) return;
    this.unsavedReported = true;
    try {
      this.reportUnsaved({
        anchorId: this.anchorId,
        pending: this.outbox.pendingCount(),
        lastError: this.lastError ?? 'unknown',
      });
    } catch (e) {
      // 上报本身不能把 flush 变成 reject（收尾路径不允许抛）。
      console.error('[share-excerpt] 上报「未保存」失败:', e);
    }
  }

  /**
   * 某个 toolCallId 是否已写成功。
   * 默认问**本记录器的锚点**；要问别的轮次必须显式给 `anchorId`（共享队列里同 id 不同锚点
   * 是两回事，裸 id 无法区分）。
   */
  has(toolCallId: string, anchorId?: number | null): boolean {
    const anchor = typeof anchorId === 'number' ? anchorId : this.anchorId;
    if (anchor == null || !toolCallId) return false;
    return this.outbox.hasWritten(anchor, toolCallId);
  }

  snapshot(): ShareExcerptRecorderSnapshot {
    const anchor = this.anchorId;
    const ownPending = anchor == null ? 0 : this.outbox.pendingCount(anchor);
    const outboxPending = this.outbox.pendingCount();
    return {
      anchorId: anchor,
      recorded: anchor == null ? 0 : this.outbox.writtenCount(anchor),
      recordedAll: this.outbox.writtenCount(),
      failures: this.failures,
      pendingWrites: this.queued,
      pendingRecords: ownPending,
      outboxPending,
      unsaved: outboxPending > 0,
      lastError: this.lastError,
    };
  }
}

/**
 * 工具循环里的一处接线：执行一次 read_share_excerpts，**立刻**把这条 call/result 成对写库，
 * 再把结果文本交给调用方回填给模型。useChatAI 与测试都走这个函数，避免「hook 里另写一遍」分叉。
 *
 * 两件事都在这里收口（返工卡 t_38463abd P1 第 2 条）：
 *  1. **没有确定的本轮持久化锚点 → 不读**。历史必须成对留存；若读到了却没地方落库，
 *     就等于给模型一个无法追溯的来源。所以 `recorder` 缺失或 `anchorId == null` 时
 *     直接返回 `HISTORY_UNAVAILABLE`，预算与网络都不碰。
 *  2. 落库失败不影响工具结果（recorder 内部吞掉异常、留在待补偿队列里重试）。
 */
export async function dispatchShareExcerptToolCall(input: {
  toolCall: ShareExcerptToolCallLike | null | undefined;
  turn: ShareExcerptTurn;
  recorder?: ShareExcerptPairRecorder | null;
}): Promise<ExecuteShareExcerptResult> {
  const anchorId = input.recorder?.anchorId ?? null;
  const outcome = await executeShareExcerptToolCall({
    toolCall: input.toolCall,
    turn: input.turn,
    historyUnavailable: anchorId == null,
  });
  if (input.recorder && anchorId != null) await input.recorder.record([outcome.record]);
  return outcome;
}
