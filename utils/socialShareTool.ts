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
 * 落历史：每次调用的 call（工具名/参数）与 result（状态/收费/文本）成对记进本轮记录，
 * 由 useChatAI 在回复落库后挂到该条助手消息的 metadata.shareExcerpts 上；下一轮投影由
 * messageFormat 读出这对记录（成对渲染，不单独回放孤立片段）。
 */

import { SHARE_BUDGETS, type ShareAttachment, type ShareState } from './socialContent/types';
import {
  estimateShareTokens,
  fetchShareExcerpts,
  shareAttachmentsOf,
  shortShareRef,
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

/** 落历史时给每条助手消息保留的调用记录上限（同一轮最多 4 次调用，留点余量）。 */
export const SHARE_EXCERPT_RECORD_KEEP = 8;
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
        '只能用 shareRef 或 contentId 指定卡片；不能传 URL、域名、baseUrl、token、scope —— 地址与授权由系统与服务端决定。',
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
            description: '卡片引用，形如 shr_...（上下文里 [分享 shr_xxx] 中的那个）。',
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
  if (args.shareRef && args.contentId) {
    const byRef = turn.targets.get(args.shareRef);
    if (!byRef) {
      return finish(false, 'SHARE_NOT_IN_CONTEXT', failureText('SHARE_NOT_IN_CONTEXT', `shareRef=${shortShareRef(args.shareRef)} 不在本轮上下文里`), 0, recordArgs);
    }
    if (byRef.contentId !== args.contentId) {
      return finish(false, 'SHARE_TARGET_MISMATCH', failureText('SHARE_TARGET_MISMATCH', 'shareRef 与 contentId 不是同一张卡'), 0, recordArgs);
    }
    target = byRef;
  } else if (args.shareRef) {
    target = turn.targets.get(args.shareRef);
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
          `[read_share_excerpts · 无匹配片段] ${shortShareRef(target.shareRef)} contentRevision=${target.contentRevision} 字段=${args.fields.join('/')}${args.query ? ` query=${args.query}` : ''}`,
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
      `[read_share_excerpts · OK] ${shortShareRef(target.shareRef)}`,
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
 * 把本轮 call/result 成对挂到助手消息 metadata 上（只增不改已有键）。
 * 成对存的意义：下一轮投影能还原「模型问了什么 → 系统回了什么」，不会只回放一段孤立片段，
 * 也不会因为片段没落历史而让模型下一轮「记得自己读过」却拿不出依据。
 */
export function attachShareExcerptPairs(prev: any, records: readonly ShareExcerptCallRecord[]): any {
  const base = prev && typeof prev === 'object' ? prev : {};
  const existing: ShareExcerptPairRecord | null = base[SHARE_EXCERPT_META_KEY] ?? null;
  const pairs = Array.isArray(existing?.pairs) ? [...existing!.pairs] : [];
  for (const record of records ?? []) {
    pairs.push({
      call: { toolCallId: record.toolCallId, name: record.name, args: record.args, at: record.at },
      result: { ok: record.ok, code: record.code, chargedTokens: record.chargedTokens, text: record.resultText },
    });
  }
  if (pairs.length === 0) return base;
  return {
    ...base,
    [SHARE_EXCERPT_META_KEY]: {
      version: 1,
      pairs: pairs.slice(-SHARE_EXCERPT_RECORD_KEEP),
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
 * 只对助手消息生效（用户消息不背工具记录）。
 */
export function renderShareExcerptPairProjection(
  metadata: any,
  role: string | null | undefined,
  opts: { maxTokens?: number } = {},
): string | null {
  if (role !== 'assistant') return null;
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
    `[上轮 read_share_excerpts 记录 · ${chunks.length} 次调用]`,
    ...chunks,
    '（这是上一轮真实读到的片段；它们只覆盖当时请求的部分，不代表完整内容）',
  ].join('\n');
}

/**
 * 找本轮回复该挂记录的那条助手消息：本次生成开始之后落库的最后一条 assistant。
 * 抽成纯函数便于测试；找不到就返回 null（不强行挂到别的消息上）。
 */
export function pickShareExcerptAnchor(
  messages: readonly { id: number; role: string; timestamp?: number }[] | null | undefined,
  sinceMs: number,
): number | null {
  let found: number | null = null;
  for (const msg of messages ?? []) {
    if (msg.role !== 'assistant') continue;
    if (typeof msg.timestamp === 'number' && msg.timestamp >= sinceMs) found = msg.id;
  }
  return found;
}
