/**
 * P5：**在正常聊天里**提出生活工作流的共享契约叶子（W1/W2 的聊天那一半）。
 *
 * 自主回合（`autonomous_round`）里模型可以把 `workflows` 写在它自己的 JSON 产物里；而普通
 * 聊天里模型说的是人话。要让角色在聊天里也能顺带提一条「我之后想为自己做件小事」，只能
 * 走一个工具调用——工具参数就是提议本身，**不是脚本**：
 *
 *   - 这里只负责把工具参数收成提议的形状，判定交给 `lifeWorkflow` 的那一份校验器
 *     （白名单动作、禁 URL/代码/权限/预算键、禁情绪断言），前后端绝不能各写一套。
 *   - 前台不生成日记/笔记正文：工具只带「标题 + 为什么想做」，正文一律由后台那次独立
 *     请求生成（见 worker 的 autonomyFire.buildWorkflowExecutionPrompt）。所以这里的
 *     参数表里没有、也不该有 note/正文 字段。
 *   - 提议与关键词无关：不需要告别、不需要「晚安」，没有任何触发词表；用户说什么都可以
 *     提，也可以整轮什么都不提。
 *
 * 落库/排期/预算/取消**都不在这里**：云端 handler 落一条 `proposed` 计划后，到点排期、
 * 用户开口取消、次数与 token 双门禁全部复用 autonomyScheduler.runAutonomyPlanQueue
 * （chat_reply 与 autonomy_round 两类来源共用同一条队列）。这样「只有自主轮能提」这个
 * 缺口被补上，而没有第二套调度。
 */

import {
  AUTONOMY_WORKFLOW_KINDS,
  type AutonomyWorkflowKind,
} from './lifeWorkflow';
import { canRunPrivateLifeAction } from './lifeWorkflowPermissions';

/** 包装层的新路由（worker/amsg/src/index.ts 里挂）。 */
export const CHAT_LIFE_WORKFLOW_ROUTE = 'chat-life-workflow';
/** 模型看到的工具名。 */
export const CHAT_LIFE_WORKFLOW_TOOL_NAME = 'propose_life_workflow';
export const CHAT_LIFE_WORKFLOW_REQUEST_VERSION = 1;
/** 一次请求最多带几条：正常是一轮一条；模型偶尔重复调用，多的按 over-limit 丢掉。 */
export const CHAT_LIFE_WORKFLOW_MAX_PROPOSALS = 2;
/** 落库最多一条（与自主回合「最多一条」的口径一致）。 */
export const CHAT_LIFE_WORKFLOW_MAX_ACCEPTED = 1;
export const CHAT_LIFE_WORKFLOW_CHAR_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
export const CHAT_LIFE_WORKFLOW_SOURCE_REF_MAX_CHARS = 120;
export const CHAT_LIFE_WORKFLOW_PLAN_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * 同一个工具既提议也撤销：`propose`（默认）走原来的登记；`cancel` 只撤**已存在、属于这个
 * 角色、还没开始执行**的计划。撤销是真撤销（服务端条件 UPDATE），running 的撤不了——
 * 那种情况服务端会明确回 `NOT_CANCELLABLE`，模型必须照实说「撤不了」，不许假称已撤销。
 */
export type ChatLifeWorkflowAction = 'propose' | 'cancel';

// ─── 注入闸 ──────────────────────────────────────────────────────────────

export interface ChatLifeWorkflowAvailabilityInput {
  /** 自主功能有效开关（airp 总闸 × 自主开关 × 档位 >= 1，见 mergeAutonomySettings）。 */
  enabled?: boolean;
  /**
   * AIRP 的**真实世界**写入总闸。这里刻意不参与判定：
   * 三类动作（私人日记 / 个人计划调整 / 兴趣笔记）写的是角色自己的私账与 D1 计划行，
   * 不动用户真实数据、不调外部工具、不对外发布，所以不该被真实写入闸卡住
   * （与 `lifeWorkflowPermissions` 对后台执行侧的口径一致）。
   * 「对外真实写入」仍然一律要求 writable，那条闸在 MCP/发帖/下单那些路径上。
   */
  writable?: boolean;
  capabilityMode?: unknown;
  capabilities?: unknown;
}

export interface ChatLifeWorkflowAvailability {
  allowed: boolean;
  /** 这三类里当前权限真正放行的那些；空 = 一个都做不了。 */
  kinds: AutonomyWorkflowKind[];
}

/**
 * 能不能把提议工具交给模型。两件事同时成立：自主开着、至少一类白名单动作被权限放行。
 * **权限与开关都只读设置终值**，模型说的话不参与这个判定。
 */
export function chatLifeWorkflowAvailability(
  input: ChatLifeWorkflowAvailabilityInput | null | undefined,
): ChatLifeWorkflowAvailability {
  if (!input || input.enabled !== true) {
    return { allowed: false, kinds: [] };
  }
  const config = {
    // writable 不传下去：私人虚拟生活不受真实写入总闸限制（理由见类型注释）。
    capabilityMode: input.capabilityMode,
    capabilities: input.capabilities,
  };
  const kinds = AUTONOMY_WORKFLOW_KINDS.filter((kind) => canRunPrivateLifeAction(config, kind));
  return { allowed: kinds.length > 0, kinds };
}

// ─── 工具参数 → 提议 ─────────────────────────────────────────────────────

export type ChatLifeWorkflowToolArgsResult =
  | { ok: true; proposal: Record<string, unknown> }
  | { ok: false; reason: 'not-object' | 'unknown-kind' | 'empty-purpose' | 'empty-title' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textOf = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * 工具参数 → 提议对象。只做「补形状」，不做语义放行：
 *   - 危险键（url / tool / permission / budget…）**原样留着**，让共用校验器明确拒收，
 *     而不是在这里悄悄洗掉（悄悄洗掉会让模型以为它提的东西被接受了）。
 *   - `action` 由 title/noteHint/maxChars 重建，kind 强制等于外层 kind，免得模型自相矛盾。
 */
export function proposalFromChatToolArgs(raw: unknown): ChatLifeWorkflowToolArgsResult {
  if (!isRecord(raw)) return { ok: false, reason: 'not-object' };
  const kind = textOf(raw.kind) as AutonomyWorkflowKind;
  if (!AUTONOMY_WORKFLOW_KINDS.includes(kind)) return { ok: false, reason: 'unknown-kind' };
  const purpose = textOf(raw.purpose);
  if (!purpose) return { ok: false, reason: 'empty-purpose' };
  const title = textOf(raw.title);
  if (!title) return { ok: false, reason: 'empty-title' };
  const noteHint = textOf(raw.noteHint);
  const maxChars = raw.maxChars;

  return {
    ok: true,
    proposal: {
      ...raw,
      v: CHAT_LIFE_WORKFLOW_REQUEST_VERSION,
      kind,
      purpose,
      ...(raw.basis === undefined ? { basis: 'virtual' } : {}),
      action: {
        kind,
        title,
        ...(noteHint ? { noteHint } : {}),
        ...(typeof maxChars === 'number' && Number.isFinite(maxChars) ? { maxChars } : {}),
      },
    },
  };
}

// ─── 请求体解析（worker 侧第一道闸） ──────────────────────────────────────

export type ChatLifeWorkflowBodyReason =
  | 'bad-body' | 'bad-version' | 'bad-char-id'
  | 'missing-source-ref' | 'bad-source-ref'
  | 'no-proposals' | 'too-many-proposals'
  | 'bad-action' | 'missing-plan-id' | 'bad-plan-id';

export interface ChatLifeWorkflowRequestBody {
  action: ChatLifeWorkflowAction;
  charId: string;
  sourceRef: string;
  /** 只有 action='cancel' 时有意义：要撤的计划 id（由服务端回执下发过的那一个）。 */
  planId?: string;
  proposals: unknown[];
}

/**
 * 只接受最小信封：`{ v, charId, sourceRef, proposals[] }`。
 * 身份（userId）**只认鉴权头**，body 里带什么都不看——伪造别人的计划从这里就进不来。
 */
export function parseChatLifeWorkflowBody(
  raw: unknown,
): { ok: true; body: ChatLifeWorkflowRequestBody } | { ok: false; reason: ChatLifeWorkflowBodyReason } {
  if (!isRecord(raw)) return { ok: false, reason: 'bad-body' };
  if (raw.v !== CHAT_LIFE_WORKFLOW_REQUEST_VERSION) return { ok: false, reason: 'bad-version' };
  const charId = textOf(raw.charId);
  if (!CHAT_LIFE_WORKFLOW_CHAR_ID_RE.test(charId)) return { ok: false, reason: 'bad-char-id' };
  const sourceRef = textOf(raw.sourceRef);
  if (!sourceRef) return { ok: false, reason: 'missing-source-ref' };
  if (sourceRef.length > CHAT_LIFE_WORKFLOW_SOURCE_REF_MAX_CHARS) return { ok: false, reason: 'bad-source-ref' };
  const actionRaw = raw.action === undefined ? 'propose' : raw.action;
  if (actionRaw !== 'propose' && actionRaw !== 'cancel') return { ok: false, reason: 'bad-action' };
  if (actionRaw === 'cancel') {
    const planId = textOf(raw.planId);
    if (!planId) return { ok: false, reason: 'missing-plan-id' };
    if (!CHAT_LIFE_WORKFLOW_PLAN_ID_RE.test(planId)) return { ok: false, reason: 'bad-plan-id' };
    return {
      ok: true,
      body: { action: 'cancel', charId, sourceRef, planId, proposals: [] },
    };
  }
  if (!Array.isArray(raw.proposals) || raw.proposals.length === 0) return { ok: false, reason: 'no-proposals' };
  if (raw.proposals.length > CHAT_LIFE_WORKFLOW_MAX_PROPOSALS) return { ok: false, reason: 'too-many-proposals' };
  return { ok: true, body: { action: 'propose', charId, sourceRef, proposals: raw.proposals } };
}

// ─── 工具回话 ────────────────────────────────────────────────────────────

export interface ChatLifeWorkflowSummary {
  ok: boolean;
  queued: number;
  /** 直接作为工具结果喂回模型的那句话。 */
  text: string;
  /** 服务端落库后的真实计划 id（只有 queued>0 才有）：客户端据此写本地可查看记录。 */
  planId?: string;
  /** 服务端算出的排期（毫秒）；缺省时客户端按触发条件自己估。 */
  scheduledAt?: number;
  /** 撤销成功 = true；服务端明确说撤不了 = false（不是失败，是「本来就不能撤」）。 */
  cancelled?: boolean;
  /** 撤销失败的原因码，供客户端把本地记录标成「撤不了」而不是继续当可撤项。 */
  cancelFailure?: 'not-cancellable' | 'not-found';
}

const REJECT_TEXT: Record<string, string> = {
  capability: '你现在没有这类写入权限',
  'over-limit': '一轮只记一条',
  'forbidden-url': '里面夹了链接',
  'forbidden-code': '里面夹了代码',
  'forbidden-action-key': '里面夹了工具/权限这类字段',
  'forbidden-assertion': '里面替对方断言了感受',
  'basis-overclaim': '把想做的事说成了已经发生的事',
};

const QUEUED_TEXT =
  '这件事已经记进你自己的安排，之后由你在后台单独做，不用现在动手。'
  + '现在不要向对方提起、不要宣布，也不要把它写进这一轮回复；照常把话说完就行。';
const DUPLICATE_TEXT =
  '这件事今天已经记过了，不用再记一遍，也不用向对方提起。照常把话说完就行。';
const CANCELLED_TEXT =
  '那条安排已经撤掉了，之后不会再去做。现在不用向对方提起这件事，照常把话说完就行。';
const CANNOT_CANCEL_TEXT =
  '这条安排已经在做了或者已经结束，撤不回来（也别假装撤掉了）。不要向对方解释这条系统提示，继续正常聊天。';
const CANCEL_NOT_FOUND_TEXT =
  '没有找到那条安排（可能已经结束了）。不要向对方提起，也不要重试，继续正常聊天。';
const SKIPPED_TEXT = (reason: string) =>
  `这一次没有登记（${reason}）。不要向对方解释这条系统提示，也不要重试，继续正常聊天。`;
const FAILED_TEXT =
  '这一次没有登记成功。不要向对方提起这件事，也不要重试，继续正常聊天。';

/**
 * 把云端回执翻成一句工具结果。
 *
 * 刻意只报「登记了没有」，**不回传任何日记/笔记的正文或标题细节**（正文压根没在前台生成），
 * 也不要求模型再确认一遍：工具结果就是终点，模型接着把它该说的话说完即可。
 */
export function summarizeChatLifeWorkflowResult(status: number, body: unknown): ChatLifeWorkflowSummary {
  const errorCode = isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string'
    ? body.error.code
    : '';
  // 撤销失败要说实话：running / 已结束撤不了，没有「假装成功」的分支。
  if (errorCode === 'PLAN_NOT_CANCELLABLE') {
    return { ok: false, queued: 0, text: CANNOT_CANCEL_TEXT, cancelled: false, cancelFailure: 'not-cancellable' };
  }
  if (errorCode === 'PLAN_NOT_FOUND') {
    return { ok: false, queued: 0, text: CANCEL_NOT_FOUND_TEXT, cancelled: false, cancelFailure: 'not-found' };
  }
  const ok = status >= 200 && status < 300 && isRecord(body) && body.success === true;
  if (!ok) return { ok: false, queued: 0, text: FAILED_TEXT };

  const data = isRecord((body as { data?: unknown }).data) ? (body as { data: Record<string, unknown> }).data : {};
  if (data.cancelled === true) return { ok: true, queued: 0, text: CANCELLED_TEXT, cancelled: true };
  if (data.cancelled === false) {
    return { ok: false, queued: 0, text: CANNOT_CANCEL_TEXT, cancelled: false, cancelFailure: 'not-cancellable' };
  }

  const queued = Array.isArray(data.queued) ? data.queued.length : 0;
  if (queued > 0) {
    // 把服务端下发的计划 id 一起回给模型：它之后要撤/改，只能用这个真实 id，
    // 不许自己编。只给短 id，不出正文、不出标题。
    const first = Array.isArray(data.queued) ? data.queued[0] : null;
    const planId = isRecord(first) && typeof first.planId === 'string' ? first.planId : '';
    const scheduledAt = isRecord(first) && typeof first.scheduledAt === 'number' ? first.scheduledAt : undefined;
    return {
      ok: true,
      queued,
      text: planId ? `${QUEUED_TEXT}（编号 ${planId}）` : QUEUED_TEXT,
      ...(planId ? { planId } : {}),
      ...(scheduledAt !== undefined ? { scheduledAt } : {}),
    };
  }
  const rejected = Array.isArray(data.rejected) ? data.rejected : [];
  const firstReason = rejected
    .map((entry) => (isRecord(entry) && typeof entry.reason === 'string' ? entry.reason : ''))
    .find(Boolean);
  if (firstReason) return { ok: false, queued: 0, text: SKIPPED_TEXT(REJECT_TEXT[firstReason] ?? '这条提议不合规矩') };

  const deduped = typeof data.deduped === 'number' ? data.deduped : 0;
  if (deduped > 0) return { ok: true, queued: 0, text: DUPLICATE_TEXT };
  return { ok: false, queued: 0, text: SKIPPED_TEXT('云端没有接受') };
}
