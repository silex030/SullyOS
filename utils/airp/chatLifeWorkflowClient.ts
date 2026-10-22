/**
 * P5：**普通聊天里提生活工作流**的前端一半（工具声明 + 执行）。
 *
 * 形状由 `./chatLifeWorkflow` 定死（那是前后端共用的契约叶子）。这里只做两件事：
 *   1. 把工具声明交给聊天主循环：参数只有「想做什么、为什么、什么时候做」这类白名单字段，
 *      **没有正文、没有网址、没有工具名、没有权限/预算**——正文一律留给后台那次独立请求，
 *      所以前台不会为此多生成一个字，也不会多叫一次模型来「确认」。
 *   2. 执行一次鉴权登记请求，然后把云端回执翻成一句工具结果。工具结果就是终点：
 *      模型接着把它该说的话说完即可，不需要、也不许在回复里宣布这件事。
 *
 * 失败一律**本地收口**成一句话：不走 throw、不重试、不打断这一轮聊天。
 */

import { ActiveMsgClient } from '../activeMsgClient';
import type { AutonomyWorkflowPlanRecord } from '../../types';
import {
  CHAT_LIFE_WORKFLOW_MAX_PROPOSALS,
  CHAT_LIFE_WORKFLOW_TOOL_NAME,
  CHAT_LIFE_WORKFLOW_REQUEST_VERSION,
  proposalFromChatToolArgs,
  summarizeChatLifeWorkflowResult,
} from './chatLifeWorkflow';

/**
 * 服务端回执 → 本地可查看记录（`airp_workflow_plans`）。
 *
 * 为什么聊天工具这条也要写：后台回合的提议走 `autonomyResultApply` 落记录，但聊天里
 * 提的那条只有一句工具回执。不写本地记录的话，下一轮既列不出「我还排着什么」，
 * 也拿不到可以撤销的编号（见 `pendingPlansPrompt`）。
 *
 * 全程 best-effort：记账失败不许影响这一轮聊天，也不许改变已经返回给模型的那句话。
 */
const LOCAL_PLAN_DEFAULT_TTL_MS = 24 * 3_600_000;

const readLocalPlans = async (charId: string): Promise<AutonomyWorkflowPlanRecord[]> => {
  try {
    const { DB } = await import('../db');
    return await DB.getWorkflowPlansByChar(charId, 200);
  } catch (e) {
    console.warn('[airp] 读本地生活工作流记录失败（不影响本轮）', e);
    return [];
  }
};

const saveLocalPlans = async (rows: AutonomyWorkflowPlanRecord[]): Promise<void> => {
  if (rows.length === 0) return;
  try {
    const { DB } = await import('../db');
    await DB.saveWorkflowPlans(rows);
  } catch (e) {
    console.warn('[airp] 写本地生活工作流记录失败（不影响本轮）', e);
  }
};

/** 提议成功后写一条 `proposed` 记录（同 id 已存在就就地更新，不重复建）。 */
const recordQueuedPlan = async (args: {
  charId: string;
  planId: string;
  sourceRef: string;
  scheduledAt?: number;
  proposal: {
    kind: AutonomyWorkflowPlanRecord['kind'];
    purpose: string;
    title: string;
    basis?: unknown;
    expiresAt?: unknown;
    predecessorId?: unknown;
  };
}): Promise<void> => {
  const now = Date.now();
  const rows = await readLocalPlans(args.charId);
  const prev = rows.find((row) => row.id === args.planId);
  const expiresAt = typeof args.proposal.expiresAt === 'number' && Number.isFinite(args.proposal.expiresAt)
    ? args.proposal.expiresAt
    : now + LOCAL_PLAN_DEFAULT_TTL_MS;
  const next: AutonomyWorkflowPlanRecord = {
    ...(prev ?? {}),
    id: args.planId,
    charId: args.charId,
    kind: args.proposal.kind,
    status: 'proposed',
    title: args.proposal.title,
    purpose: args.proposal.purpose,
    basis: args.proposal.basis === 'inference' ? 'inference' : 'virtual',
    source: 'chat_reply',
    sourceRef: args.sourceRef,
    scheduledAt: typeof args.scheduledAt === 'number' && Number.isFinite(args.scheduledAt)
      ? args.scheduledAt
      : now,
    expiresAt,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  } as AutonomyWorkflowPlanRecord;
  await saveLocalPlans([next]);

  // 替换前身：服务端在新计划落库后才撤旧计划；本地也把旧记录标成「被换掉」，
  // 否则面板会一直把它当「想做」，下一轮上下文还会劝角色去撤一条已经没了的。
  const predecessorId = typeof args.proposal.predecessorId === 'string' ? args.proposal.predecessorId : '';
  if (!predecessorId) return;
  const old = rows.find((row) => row.id === predecessorId);
  if (!old || (old.status !== 'proposed' && old.status !== 'scheduled')) return;
  await saveLocalPlans([{
    ...old,
    status: 'cancelled',
    lastError: 'superseded',
    updatedAt: now,
  }]);
};

/** 撤销结果 → 本地记录状态。成功标 cancelled；「撤不了」标一句原因，但**不冒充**已取消。 */
const reconcileCancelledPlan = async (args: {
  charId: string;
  planId: string;
  cancelled: boolean;
}): Promise<void> => {
  const rows = await readLocalPlans(args.charId);
  const hit = rows.find((row) => row.id === args.planId);
  if (!hit) return;
  const now = Date.now();
  if (args.cancelled) {
    await saveLocalPlans([{ ...hit, status: 'cancelled', lastError: 'role-cancelled', updatedAt: now }]);
    return;
  }
  // 服务端明确说「撤不了」= 它已经不是待办了（在做或已结束）。本地保留真实状态，
  // 只加一条原因，让「还排着的事」不再把它列成可撤项；不写成 cancelled，也不写成 completed。
  await saveLocalPlans([{ ...hit, lastError: 'cannot-cancel', updatedAt: now }]);
};

/** 一个参数槽位的 JSON Schema 片段（只用到很小一部分关键字，够描述这个工具）。 */
export interface ChatLifeWorkflowParamSchema {
  type?: 'string' | 'number' | 'array' | 'object';
  enum?: string[];
  description?: string;
  items?: ChatLifeWorkflowParamSchema;
  properties?: Record<string, ChatLifeWorkflowParamSchema>;
  required?: string[];
  /** 只用于对象参数：false = 不接受未声明键（模型不能发明字段）。 */
  additionalProperties?: boolean;
}

/** 与 OpenAI tools 数组同形（前端聊天主循环直接拼进 tools）。 */
export interface ChatLifeWorkflowTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, ChatLifeWorkflowParamSchema>;
      required: string[];
      additionalProperties?: boolean;
    };
  };
}

const TOOL: ChatLifeWorkflowTool = {
  type: 'function',
  function: {
    name: CHAT_LIFE_WORKFLOW_TOOL_NAME,
    description:
      '给自己记一件之后想做的低风险小事（写点东西 / 调整自己的计划 / 记点兴趣笔记）。'
      + '这是你自己的安排，后台会另起一次请求去做，正文不要写在回复里。'
      + 'action=cancel 时只撤一条还没开始的安排，planId 必须用之前回执里给你的那个编号。'
      + '不要用它对外发布、不要写网址或工具名、不要替对方断言感受；'
      + '不要为了填而填，大多数时候不调用它。'
      + '调用之后不要在回复里提起这件事，也不要宣布「我记下了」。',
    parameters: {
      type: 'object',
      // 模型不能发明新参数（护栏/预算/权限都不在参数表里，多出来的键一律拒收）。
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['propose', 'cancel'],
          description: 'propose=记一条新安排（默认）；cancel=撤掉一条还没开始的安排。',
        },
        planId: { type: 'string', description: 'action=cancel 必填：之前回执里给你的安排编号。' },
        kind: {
          type: 'string',
          enum: ['diary', 'plan', 'interest_note'],
          description: 'diary=写点自己的东西；plan=调整自己的计划；interest_note=记点兴趣/在读的东西。',
        },
        purpose: { type: 'string', description: '为什么想做这件事（一句话，说给你自己听）。' },
        title: { type: 'string', description: '这件事的短标题，不超过 30 字。' },
        noteHint: { type: 'string', description: '想写的大致方向（可选，不要写成正文）。' },
        maxChars: { type: 'number', description: '产物长度上限（可选，80–1200，默认 400）。' },
        trigger: {
          type: 'object',
          additionalProperties: false,
          description: '什么时候做：{kind:"now"} / {kind:"idle",afterMinutes:30-1440} / {kind:"at_time",atLocalTime:"HH:mm"}。',
          properties: {
            kind: { type: 'string', enum: ['now', 'idle', 'at_time'] },
            afterMinutes: { type: 'number' },
            atLocalTime: { type: 'string' },
          },
          required: ['kind'],
        },
        expiresInHours: { type: 'number', description: '多久之内还有意义（1–168，默认 24）。' },
        basis: { type: 'string', enum: ['virtual', 'inference'], description: 'virtual=纯粹自己想做的；inference=从对话里推出来的（需 evidence）。' },
        evidence: { type: 'array', items: { type: 'string' }, description: 'basis=inference 时，支撑这条提议的原话（最多 3 条）。' },
      },
      required: ['kind', 'purpose', 'title', 'trigger'],
    },
  },
};

export const CHAT_LIFE_WORKFLOW_TOOLS: ChatLifeWorkflowTool[] = [TOOL];
export const CHAT_LIFE_WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set([TOOL.function.name]);

/** 工具结果里的几句话（与契约叶子的措辞同一口径：只报「登记了没有」）。 */
const LOCAL_REJECT_TEXT =
  '这一次没有登记（参数不完整）。不要向对方解释这条系统提示，也不要重试，继续正常聊天。';
const LOCAL_FAILED_TEXT =
  '这一次没有登记成功。不要向对方提起这件事，也不要重试，继续正常聊天。';
const LOCAL_UNKNOWN_TEXT =
  '这一次没等到云端的确认（可能已经记上、也可能没有）。不要向对方提起，也不要重试，继续正常聊天。';
const LOCAL_CANCEL_REJECT_TEXT =
  '这次撤销没有生效（参数不完整）。不要向对方解释这条系统提示，也不要重试，继续正常聊天。';

export interface ChatLifeWorkflowExecuteContext {
  charId: string;
  /** 这一轮的消息锚（消息 id / 会话 id），服务端用它做去重与溯源。 */
  sourceRef: string;
}

/**
 * 执行一次工具调用，返回**直接喂回模型的那句话**。
 *
 * 参数不合法就在本地打回（一个请求都不发）；网络/服务端失败也只回一句话，
 * 不抛给聊天主循环——这条支线坏了不该让用户这句话发不出去。
 */
export async function executeChatLifeWorkflowTool(
  toolArgs: unknown,
  ctx: ChatLifeWorkflowExecuteContext,
): Promise<string> {
  // 撤销分支：不给模型「编 planId」的空间——形状不对就本地打回，一个请求都不发。
  const raw = (typeof toolArgs === 'object' && toolArgs !== null && !Array.isArray(toolArgs))
    ? toolArgs as Record<string, unknown>
    : null;
  if (raw?.action === 'cancel') {
    const planId = typeof raw.planId === 'string' ? raw.planId.trim() : '';
    if (!planId) return LOCAL_CANCEL_REJECT_TEXT;
    try {
      const { status, body } = await ActiveMsgClient.submitChatLifeWorkflow({
        v: CHAT_LIFE_WORKFLOW_REQUEST_VERSION,
        action: 'cancel',
        charId: ctx.charId,
        sourceRef: ctx.sourceRef,
        planId,
      });
      const summary = summarizeChatLifeWorkflowResult(status, body);
      // 只在**收到真实回执**时对账：成功 → cancelled；明确撤不了 → 标原因。超时那条路
      // 属于「不知道撤没撤」，什么都不改（不能假装已经撤了）。
      if (summary.cancelled === true || summary.cancelFailure === 'not-cancellable') {
        await reconcileCancelledPlan({
          charId: ctx.charId,
          planId,
          cancelled: summary.cancelled === true,
        });
      }
      return summary.text;
    } catch {
      // 超时 = 送达未知：明确说「没等到确认」，不声称撤回成功、也不重试。
      return LOCAL_UNKNOWN_TEXT;
    }
  }
  const parsed = proposalFromChatToolArgs(toolArgs);
  if (!parsed.ok) return LOCAL_REJECT_TEXT;

  try {
    const { status, body } = await ActiveMsgClient.submitChatLifeWorkflow({
      v: CHAT_LIFE_WORKFLOW_REQUEST_VERSION,
      charId: ctx.charId,
      sourceRef: ctx.sourceRef,
      proposals: [parsed.proposal].slice(0, CHAT_LIFE_WORKFLOW_MAX_PROPOSALS),
    });
    const summary = summarizeChatLifeWorkflowResult(status, body);
    if (summary.ok && summary.planId) {
      await recordQueuedPlan({
        charId: ctx.charId,
        planId: summary.planId,
        sourceRef: ctx.sourceRef,
        scheduledAt: summary.scheduledAt,
        proposal: {
          kind: parsed.proposal.kind as AutonomyWorkflowPlanRecord['kind'],
          purpose: parsed.proposal.purpose as string,
          title: (parsed.proposal.action as { title?: string })?.title ?? (parsed.proposal.title as string),
          basis: parsed.proposal.basis,
          expiresAt: (parsed.proposal as { expiresAt?: unknown }).expiresAt,
          predecessorId: (parsed.proposal as { predecessorId?: unknown }).predecessorId,
        },
      });
    }
    return summary.text;
  } catch {
    // 请求没回来（超时/断网）：登记结果未知。说「没等到确认」，不说失败也不说成功，更不重试。
    return LOCAL_UNKNOWN_TEXT;
  }
}
