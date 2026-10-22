/**
 * P5：角色自主生活工作流（life workflow）的纯契约叶子。
 *
 * 这条链路刻意做窄：
 *   模型只能在**已有的一轮生成**里顺带提一条「想做的低风险小事」（W1），提议不是脚本，
 *   必须经过本文件的规则校验器降成**固定白名单动作**（W2：私人日记 / 个人计划调整 /
 *   阅读·兴趣笔记），才允许落计划。任何 URL、HTTP 方法、代码、工具名、权限、预算字段
 *   一律拒收；模型也不能冒充「现实观测」。
 *
 * 排期、预算、取消、状态迁移都是确定性纯函数：调度器（autonomyScheduler）与到点执行
 * （autonomyFire）共用同一份判定，前后端不能各写一套。
 */

import {
  AUTONOMY_GUARDRAIL_CEILINGS,
  type AirpAutonomyGuardrails,
} from './autonomyGuardrails';

/** 首版只开放这三类动作（总计划的 W5）。 */
export const AUTONOMY_WORKFLOW_KINDS = ['diary', 'plan', 'interest_note'] as const;
export type AutonomyWorkflowKind = (typeof AUTONOMY_WORKFLOW_KINDS)[number];

/** 计划的全部状态（L3）。unknown 是终态：不自动重试，等下一次全新的提议。 */
export const AUTONOMY_PLAN_STATUSES = [
  'proposed', 'scheduled', 'running', 'completed', 'cancelled', 'failed', 'unknown',
] as const;
export type AutonomyPlanStatus = (typeof AUTONOMY_PLAN_STATUSES)[number];

export const AUTONOMY_PLAN_TERMINAL_STATUSES: readonly AutonomyPlanStatus[] =
  ['completed', 'cancelled', 'failed', 'unknown'];

export type AutonomyPlanBasis = 'inference' | 'virtual';

export interface AutonomyWorkflowTrigger {
  kind: 'now' | 'idle' | 'at_time';
  /** idle：用户安静多少分钟后可以开始（30–1440）。 */
  afterMinutes?: number;
  /** at_time：角色时区的 "HH:mm"（取下一次出现）。 */
  atLocalTime?: string;
}

export interface AutonomyWorkflowAction {
  kind: AutonomyWorkflowKind;
  title: string;
  noteHint?: string;
  maxChars: number;
}

export interface AutonomyWorkflowProposal {
  v: 1;
  kind: AutonomyWorkflowKind;
  purpose: string;
  trigger: AutonomyWorkflowTrigger;
  action: AutonomyWorkflowAction;
  source: 'autonomy_round' | 'chat_reply';
  sourceRef: string;
  /** 这条提议自己的认知档：虚拟生活 / 推断。不允许 observation。 */
  basis: AutonomyPlanBasis;
  evidence: string[];
  predecessorId?: string;
  dedupeKey: string;
  createdAt: number;
  expiresAt: number;
}

/** 落库/调度/执行共用的计划形状（store 负责 snake_case 映射）。 */
export interface AutonomyPlanRecord {
  id: string;
  charId: string;
  kind: AutonomyWorkflowKind;
  status: AutonomyPlanStatus;
  purpose: string;
  title: string;
  noteHint?: string;
  maxChars: number;
  trigger: AutonomyWorkflowTrigger;
  scheduledAt: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  source: 'autonomy_round' | 'chat_reply' | 'user';
  sourceRef: string;
  basis: AutonomyPlanBasis;
  evidence: string[];
  predecessorId?: string;
  dedupeKey: string;
  attempts: number;
  leaseUntil: number;
  lastError?: string;
}

export type WorkflowRejectReason =
  | 'not-object' | 'bad-version' | 'unknown-kind' | 'empty-purpose' | 'purpose-too-long'
  | 'bad-trigger' | 'bad-action' | 'action-kind-mismatch' | 'basis-overclaim'
  | 'bad-basis' | 'no-basis' | 'expired' | 'expiry-out-of-range'
  | 'forbidden-action-key' | 'forbidden-url' | 'forbidden-code' | 'forbidden-assertion';

export interface WorkflowValidateContext {
  nowMs: number;
  source: 'autonomy_round' | 'chat_reply';
  sourceRef: string;
  tzId: string;
  predecessorId?: string;
}

export type WorkflowValidateResult =
  | { ok: true; proposal: AutonomyWorkflowProposal }
  | { ok: false; reason: WorkflowRejectReason };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_EXPIRY_HOURS = 7 * 24;
const MAX_PURPOSE_CHARS = 120;
const MAX_TITLE_CHARS = 80;
const MAX_NOTE_HINT_CHARS = 200;
const MIN_ACTION_CHARS = 80;
const MAX_ACTION_CHARS = 1200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textOf = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * 这些键一出现就直接拒：模型文本不是脚本，也不是权限声明。
 * 检查是递归的（trigger/action 里塞一个 url 一样拒）。
 */
const FORBIDDEN_KEYS = new Set([
  'url', 'uri', 'href', 'endpoint', 'method', 'headers', 'body', 'payload',
  'script', 'code', 'exec', 'shell', 'command', 'cmd', 'argv', 'spawn', 'eval',
  'tool', 'tools', 'toolname', 'mcp', 'function', 'call',
  'permission', 'permissions', 'capabilities', 'writable', 'autonomyLevel',
  'budget', 'budgets', 'limit', 'limits', 'quota', 'token', 'tokens', 'apikey', 'key',
]);

const hasForbiddenKey = (value: unknown, depth = 0): boolean => {
  if (depth > 4 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasForbiddenKey(item, depth + 1));
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''))) return true;
    if (hasForbiddenKey(child, depth + 1)) return true;
  }
  return false;
};

const collectStrings = (value: unknown, out: string[] = [], depth = 0): string[] => {
  if (depth > 4) return out;
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) collectStrings(child, out, depth + 1);
  }
  return out;
};

const URL_RE = /https?:\/\/|www\./i;
const CODE_RE = /\b(eval|exec|fetch|require|import)\s*\(|`[^`]*`|\$\(/i;

/**
 * 「用天气/空闲断言对方情绪」的启发式禁区。它不是语义理解，只是一道便宜的护栏：
 * 命中就整条提议拒收，让模型换一种说法（而不是悄悄改写它的文本）。
 */
const FORBIDDEN_ASSERTIONS: RegExp[] = [
  /(用户|对方|你)(一定|肯定|明显|看来)[^。！？]{0,8}(开心|难过|生气|孤独|寂寞|累|无聊|有空|闲着)/,
  /(天气|下雨|晴天|降温)[^。！？]{0,16}(所以|肯定|一定|说明)[^。！？]{0,10}(心情|开心|难过|高兴|低落)/,
  /(没有|没)[^。！？]{0,6}(安排|日程|计划)[^。！？]{0,10}(所以|说明|就是)[^。！？]{0,6}(有空|很闲|闲着)/,
];

const hasForbiddenAssertion = (text: string): boolean =>
  FORBIDDEN_ASSERTIONS.some((re) => re.test(text));

/** 稳定小哈希（去重键用；不做安全用途）。 */
const stableHash = (text: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
};

const zonedDateKey = (nowMs: number, tzId: string): string => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tzId, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(nowMs));
    const map: Record<string, string> = {};
    for (const part of parts) map[part.type] = part.value;
    return `${map.year}-${map.month}-${map.day}`;
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10);
  }
};

/** 去重键：同一角色同一天、同类、同目的+同标题只允许一条（跨天自动换键）。 */
export function planDedupeKey(args: {
  kind: AutonomyWorkflowKind;
  title: string;
  dateKey: string;
  purpose?: string;
}): string {
  return `wf:${args.kind}:${stableHash(`${args.purpose ?? ''}\u0000${args.title.trim()}\u0000${args.dateKey}`)}`;
}

const parseHHMM = (value: unknown): { hour: number; minute: number } | null => {
  if (typeof value !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
};

const normalizeTrigger = (raw: unknown): AutonomyWorkflowTrigger | null => {
  if (!isRecord(raw)) return null;
  const kind = raw.kind;
  if (kind === 'now') return { kind: 'now' };
  if (kind === 'idle') {
    const rawMinutes = raw.afterMinutes;
    const afterMinutes = typeof rawMinutes === 'number' && Number.isFinite(rawMinutes)
      ? Math.trunc(rawMinutes) : 180;
    if (afterMinutes < 30 || afterMinutes > 1440) return null;
    return { kind: 'idle', afterMinutes };
  }
  if (kind === 'at_time') {
    const at = parseHHMM(raw.atLocalTime);
    if (!at) return null;
    return { kind: 'at_time', atLocalTime: `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}` };
  }
  return null;
};

const normalizeAction = (raw: unknown, proposalKind: AutonomyWorkflowKind): AutonomyWorkflowAction | null => {
  if (!isRecord(raw)) return null;
  if (raw.kind !== proposalKind) return null;
  const title = textOf(raw.title);
  if (!title || title.length > MAX_TITLE_CHARS) return null;
  const noteHintRaw = textOf(raw.noteHint);
  const noteHint = noteHintRaw ? noteHintRaw.slice(0, MAX_NOTE_HINT_CHARS) : undefined;
  const rawChars = raw.maxChars;
  const maxChars = typeof rawChars === 'number' && Number.isFinite(rawChars)
    ? Math.min(MAX_ACTION_CHARS, Math.max(MIN_ACTION_CHARS, Math.trunc(rawChars)))
    : 400;
  return { kind: proposalKind, title, ...(noteHint ? { noteHint } : {}), maxChars };
};

/**
 * 模型提议 → 类型化动作。任何不合法都返回明确原因（不抛、不猜、不偷偷改写）。
 */
export function validateAutonomyWorkflowProposal(
  raw: unknown,
  ctx: WorkflowValidateContext,
): WorkflowValidateResult {
  if (!isRecord(raw)) return { ok: false, reason: 'not-object' };
  if (raw.v !== undefined && raw.v !== 1) return { ok: false, reason: 'bad-version' };

  const kind = textOf(raw.kind) as AutonomyWorkflowKind;
  if (!AUTONOMY_WORKFLOW_KINDS.includes(kind)) return { ok: false, reason: 'unknown-kind' };

  const purpose = textOf(raw.purpose);
  if (!purpose) return { ok: false, reason: 'empty-purpose' };
  if (purpose.length > MAX_PURPOSE_CHARS) return { ok: false, reason: 'purpose-too-long' };

  // 先看**文本**再看**键名**：夹了链接/代码/替人断言感受时，报出更具体的那一句
  // （「里面夹了链接」比「夹了工具/权限字段」有用）；纯键名违规再落到 key 闸。
  const strings = collectStrings(raw);
  if (strings.some((text) => URL_RE.test(text))) return { ok: false, reason: 'forbidden-url' };
  if (strings.some((text) => CODE_RE.test(text))) return { ok: false, reason: 'forbidden-code' };
  if (strings.some((text) => hasForbiddenAssertion(text))) return { ok: false, reason: 'forbidden-assertion' };
  if (hasForbiddenKey(raw)) return { ok: false, reason: 'forbidden-action-key' };

  const trigger = normalizeTrigger(raw.trigger);
  if (!trigger) return { ok: false, reason: 'bad-trigger' };

  const action = normalizeAction(raw.action, kind);
  if (!action) {
    if (isRecord(raw.action) && raw.action.kind !== undefined && raw.action.kind !== kind) {
      return { ok: false, reason: 'action-kind-mismatch' };
    }
    return { ok: false, reason: 'bad-action' };
  }

  const basisRaw = raw.basis === undefined ? 'virtual' : raw.basis;
  if (basisRaw === 'observation') return { ok: false, reason: 'basis-overclaim' };
  if (basisRaw !== 'virtual' && basisRaw !== 'inference') return { ok: false, reason: 'bad-basis' };
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 3)
    : [];
  if (basisRaw === 'inference' && evidence.length === 0) return { ok: false, reason: 'no-basis' };

  const rawHours = raw.expiresInHours;
  const expiresInHours = typeof rawHours === 'number' && Number.isFinite(rawHours) ? Math.trunc(rawHours) : 24;
  if (expiresInHours < 1 || expiresInHours > MAX_EXPIRY_HOURS) {
    return { ok: false, reason: 'expiry-out-of-range' };
  }

  const dateKey = zonedDateKey(ctx.nowMs, ctx.tzId);
  const predecessorId = textOf(raw.predecessorId) || ctx.predecessorId;

  return {
    ok: true,
    proposal: {
      v: 1,
      kind,
      purpose,
      trigger,
      action,
      source: ctx.source,
      sourceRef: ctx.sourceRef,
      basis: basisRaw,
      evidence,
      ...(predecessorId ? { predecessorId } : {}),
      dedupeKey: planDedupeKey({ kind, title: action.title, purpose, dateKey }),
      createdAt: ctx.nowMs,
      expiresAt: ctx.nowMs + expiresInHours * HOUR_MS,
    },
  };
}

export interface WorkflowBatchResult {
  accepted: AutonomyWorkflowProposal[];
  rejected: Array<{ index: number; reason: WorkflowRejectReason }>;
}

/** 批量版：一条坏提议只丢一条，绝不整批抛/整批丢。 */
export function validateAutonomyWorkflowProposals(
  raw: unknown,
  ctx: WorkflowValidateContext,
): WorkflowBatchResult {
  if (!Array.isArray(raw)) return { accepted: [], rejected: [] };
  const accepted: AutonomyWorkflowProposal[] = [];
  const rejected: WorkflowBatchResult['rejected'] = [];
  raw.forEach((item, index) => {
    const result = validateAutonomyWorkflowProposal(item, ctx);
    if (result.ok) accepted.push(result.proposal);
    else rejected.push({ index, reason: result.reason });
  });
  return { accepted, rejected };
}

// ─── 排期 ────────────────────────────────────────────────────────────────

const zonedParts = (nowMs: number, tzId: string): {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
} => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tzId, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(nowMs));
    const map: Record<string, string> = {};
    for (const part of parts) map[part.type] = part.value;
    let hour = Number(map.hour);
    if (hour === 24) hour = 0;
    return {
      year: Number(map.year), month: Number(map.month), day: Number(map.day),
      hour, minute: Number(map.minute), second: Number(map.second),
    };
  } catch {
    const d = new Date(nowMs);
    return {
      year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
      hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
    };
  }
};

/** 角色时区「下一次 HH:mm」的绝对时刻（跨天时取次日）。 */
export function nextLocalTimeMs(nowMs: number, tzId: string, atLocalTime: string): number {
  const target = parseHHMM(atLocalTime);
  if (!target) return nowMs;
  const p = zonedParts(nowMs, tzId);
  // 用「本地墙上时间当成 UTC」反推偏移，再折回绝对时刻；分钟级精度足够排期。
  const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offset = localAsUtc - Math.floor(nowMs / 1000) * 1000;
  let candidate = Date.UTC(p.year, p.month - 1, p.day, target.hour, target.minute, 0) - offset;
  if (candidate <= nowMs) candidate += 24 * HOUR_MS;
  return candidate;
}

/**
 * 提议 → 该在什么时候执行。
 * idle 的语义是「用户安静够久之后」：同时满足「提议后过了 N 分钟」和「最后一条用户消息后 N 分钟」，
 * 所以用户一直说话时它不会偷偷跑起来。
 */
export function computeScheduledAt(
  proposal: Pick<AutonomyWorkflowProposal, 'trigger' | 'createdAt'>,
  args: { nowMs: number; tzId: string; lastUserMessageAt?: number | null },
): number {
  const trigger = proposal.trigger;
  if (trigger.kind === 'now') return args.nowMs;
  if (trigger.kind === 'at_time') {
    return nextLocalTimeMs(args.nowMs, args.tzId, trigger.atLocalTime ?? '21:00');
  }
  const afterMinutes = trigger.afterMinutes ?? 180;
  const byCreated = proposal.createdAt + afterMinutes * MINUTE_MS;
  const last = typeof args.lastUserMessageAt === 'number' && Number.isFinite(args.lastUserMessageAt)
    ? args.lastUserMessageAt : 0;
  return Math.max(byCreated, last + afterMinutes * MINUTE_MS, args.nowMs);
}

/** proposed 且到点、未过期才该被调度器排出去；scheduled 表示已经建过任务，绝不重排。 */
export function isPlanDue(plan: Pick<AutonomyPlanRecord, 'status' | 'scheduledAt' | 'expiresAt'>, nowMs: number): boolean {
  return plan.status === 'proposed' && nowMs >= plan.scheduledAt && nowMs < plan.expiresAt;
}

// ─── 状态机 ──────────────────────────────────────────────────────────────

const TRANSITIONS: Record<AutonomyPlanStatus, readonly AutonomyPlanStatus[]> = {
  proposed: ['scheduled', 'cancelled', 'failed'],
  scheduled: ['running', 'cancelled', 'failed', 'unknown'],
  running: ['completed', 'failed', 'unknown'],
  completed: [],
  cancelled: [],
  failed: [],
  unknown: [],
};

/** 未知/失败都是终态：unknown 绝不自动重试（总计划 review focus 第 2 条）。 */
export function canTransitionPlan(from: AutonomyPlanStatus, to: AutonomyPlanStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export const AUTONOMY_UNKNOWN_RETRY_ALLOWED = false;

/** 聊天里某条用户消息的稳定引用（计划 sourceRef 与 fire_pack 的 lastUserMessageId 同一格式）。 */
export function chatUserMessageRef(charId: string, messageId: number): string {
  return `chat:${charId}:m${messageId}`;
}

/**
 * 用户重新开口 → 取消还没开始的收尾；已经在跑的只标结果不再适用，不假装能退款。
 *
 * 两个输入必须一起看：
 *   - `lastUserMessageAt`：只知道「用户上次开口的时间」，拿它比 `createdAt` 就能判断
 *     「之后又说过话」；
 *   - `lastUserMessageRef`（可选）：那一条用户消息的**真实 id**。有了它才分得清
 *     「用户又开口了」和「这条计划就是回复这一条消息时提的」。
 *
 * 为什么必须有第二样：消息时间戳来自客户端、计划的 `createdAt` 来自服务端，两边时钟
 * 差几秒（或消息时间戳在计划落库之后才写定）时，同一句话刚提的计划会在下一跳被
 * 「用户又开口了」立刻撤掉 —— 用户眼看着角色刚答应的事一秒就没了。
 */
export function isCancelableByUserSpeech(
  plan: Pick<AutonomyPlanRecord, 'status' | 'createdAt'> & { sourceRef?: string },
  lastUserMessageAt: number | null | undefined,
  options?: { lastUserMessageRef?: string | null },
): boolean {
  if (plan.status !== 'proposed' && plan.status !== 'scheduled') return false;
  if (typeof lastUserMessageAt !== 'number' || !Number.isFinite(lastUserMessageAt)) return false;
  const currentRef = (options?.lastUserMessageRef ?? '').trim();
  if (currentRef && typeof plan.sourceRef === 'string' && plan.sourceRef === currentRef) {
    // 这条计划就是这一条用户消息催出来的：同一条消息不算「又开口」。
    return false;
  }
  return lastUserMessageAt > plan.createdAt;
}

// ─── 预算门（次数 + token 双门禁） ────────────────────────────────────────

export type WorkflowBudgetReason =
  | 'paused' | 'char-daily-limit' | 'kind-gap' | 'global-daily-limit' | 'token-budget';

export interface WorkflowBudgetUsage {
  /** 该角色今天已经排出去几次工作流（含 running/completed/unknown/failed）。 */
  charUsedToday: number;
  /** 同类动作最近一次的执行时刻（0 = 没有）。 */
  lastSameKindAt: number;
  /** 共享计数：该用户今天已经排出去几次。 */
  globalUsedToday: number;
  tokensToday: number;
  reservedTokensToday: number;
  dailyTokenBudget: number;
}

export function evaluateWorkflowBudget(input: {
  nowMs: number;
  limits: AirpAutonomyGuardrails;
  usage: WorkflowBudgetUsage;
}): { allowed: true } | { allowed: false; reason: WorkflowBudgetReason } {
  const { limits, usage } = input;
  if (limits.paused) return { allowed: false, reason: 'paused' };

  const perChar = Math.min(limits.perCharPerDay, AUTONOMY_GUARDRAIL_CEILINGS.perCharPerDay);
  // 0 / 负数 = 用户把每角色额度关到零：直接不放行（别用 `used >= 0` 这种隐式判定）。
  if (!(perChar > 0) || usage.charUsedToday >= perChar) {
    return { allowed: false, reason: 'char-daily-limit' };
  }

  const gapMs = Math.max(0, limits.sameKindMinGapMinutes) * MINUTE_MS;
  if (gapMs > 0 && usage.lastSameKindAt > 0 && input.nowMs - usage.lastSameKindAt < gapMs) {
    return { allowed: false, reason: 'kind-gap' };
  }

  // 全局额度 <=0 必须是「一次都不放」，跨日也不能例外（认领口另有一道同样的闸）。
  if (!(limits.globalPerDay > 0) || usage.globalUsedToday >= limits.globalPerDay) {
    return { allowed: false, reason: 'global-daily-limit' };
  }

  if (usage.dailyTokenBudget > 0) {
    const reserved = Math.max(0, usage.reservedTokensToday);
    if (usage.tokensToday + reserved + limits.reserveTokensPerRun > usage.dailyTokenBudget) {
      return { allowed: false, reason: 'token-budget' };
    }
  }

  return { allowed: true };
}

// ─── 到点执行输出 ────────────────────────────────────────────────────────

export type WorkflowOutputReason = 'empty' | 'bad-shape' | 'wrong-kind';

export type WorkflowExecutionOutput =
  | { ok: true; text: string; plans: string[] }
  | { ok: false; reason: WorkflowOutputReason };

const fullStop = (text: string, cap: number): string => {
  if (text.length <= cap) return text;
  const head = text.slice(0, cap);
  let lastEnd = -1;
  for (const mark of ['。', '！', '？', '…', '!', '?', '.']) {
    lastEnd = Math.max(lastEnd, head.lastIndexOf(mark));
  }
  if (lastEnd >= 0) return head.slice(0, lastEnd + 1);
  return head.replace(/[，,、；;\s]+$/u, '');
};

/**
 * 后台执行这一轮的产物解析（不是提议，是「事情做完了」的记录）。
 * 日记/兴趣笔记允许纯文本；计划调整必须有结构化条目——散文不能冒充计划。
 */
export function parseWorkflowExecutionOutput(
  raw: string,
  kind: AutonomyWorkflowKind,
  maxChars: number,
): WorkflowExecutionOutput {
  const trimmed = (raw ?? '').toString().trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  let parsed: unknown = null;
  if (candidate.startsWith('{')) {
    try {
      parsed = JSON.parse(candidate);
    } catch {
      parsed = null;
    }
  }

  const plans: string[] = [];
  let text = '';
  if (isRecord(parsed)) {
    if (parsed.v !== undefined && parsed.v !== 1) return { ok: false, reason: 'bad-shape' };
    text = textOf(parsed.text);
    if (Array.isArray(parsed.plans)) {
      for (const item of parsed.plans) {
        const title = typeof item === 'string' ? textOf(item) : (isRecord(item) ? textOf(item.title) : '');
        if (title) plans.push(title.slice(0, MAX_TITLE_CHARS));
      }
    }
    if (!text && plans.length === 0) return { ok: false, reason: 'empty' };
  } else {
    text = trimmed;
  }

  if (kind === 'plan' && plans.length === 0) return { ok: false, reason: 'bad-shape' };
  if (!text && kind !== 'plan') return { ok: false, reason: 'empty' };

  return { ok: true, text: fullStop(text, Math.max(1, maxChars)).trim(), plans };
}
