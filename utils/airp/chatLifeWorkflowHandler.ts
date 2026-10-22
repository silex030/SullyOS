/**
 * P5：聊天里提生活工作流的**云端一半**（worker/amsg 的 `/chat-life-workflow` 路由）。
 *
 * 判定全部注入，这个文件自己不做网络/时钟/D1：调用方（index.ts）把「谁、什么时候、
 * 从哪读包、往哪写」都传进来，所以可以在 vitest 里确定性地钉住每道闸。
 *
 * 五道闸，顺序不能换（越靠前越便宜、越不该被绕过）：
 *   1. 身份只认鉴权头：没有 userId → 401，**连包都不读**；
 *   2. 信封形状：`{v,charId,sourceRef,proposals[]}`，超条数/空提议 → 400；
 *   3. 用户级总暂停 → 409（不动库）；
 *   4. 包必须按「用户 + 角色」查得到：查不到就是别人的角色 → 409，绝不跨用户落计划；
 *   5. 权限终值（fire_pack 里的 autonomy）：没开自主 409 / 白名单一类都不含 403 ——
 *      模型说的话不参与这个判定。私人虚拟生活不受真实写入总闸（writable）限制。
 *
 * 落库只落一条 `proposed`（与自主回合「最多一条」同口径）；排期、预算、取消、到点执行
 * 全部复用 autonomyScheduler.runAutonomyPlanQueue + autonomyFire，**没有第二套调度**。
 */

import type { AmsgFirePack } from '../amsgFirePack';
import {
  validateAutonomyWorkflowProposal,
  computeScheduledAt,
  type AutonomyPlanRecord,
  type AutonomyWorkflowProposal,
  type WorkflowValidateContext,
} from './lifeWorkflow';
import { canRunPrivateLifeAction } from './lifeWorkflowPermissions';
import {
  CHAT_LIFE_WORKFLOW_MAX_ACCEPTED,
  parseChatLifeWorkflowBody,
  proposalFromChatToolArgs,
  type ChatLifeWorkflowRequestBody,
} from './chatLifeWorkflow';

export interface ChatLifeWorkflowDeps {
  /** 只来自鉴权头；null = 没登录。 */
  userId: string | null;
  nowMs: number;
  rawBody: unknown;
  /** 按「用户 + 角色」读 fire_pack；读不到回 null（不区分「没有」和「不是你的」）。 */
  loadPack: (args: { userId: string; charId: string }) => Promise<AmsgFirePack | null>;
  /** 用户级总暂停（共享护栏行）。 */
  isUserPaused: (userId: string) => Promise<boolean>;
  /** 落一条 proposed 计划；false = 同日同目的已经有了（去重，不算错）。 */
  insertPlan: (plan: AutonomyPlanRecord) => Promise<boolean>;
  /** 按 id 读一条计划（撤销用；调用方必须再校验 charId 归属）。 */
  loadPlan: (planId: string) => Promise<AutonomyPlanRecord | null>;
  /** 撤销一条 pending 计划；false = 已经在跑/已结束（绝不当成撤销成功）。 */
  cancelPlan: (args: { planId: string; charId: string; reason: string }) => Promise<boolean>;
  /** 新提议顶掉前身：**新计划落库之后**才调用，只动同角色 pending。 */
  cancelPredecessor: (args: { charId: string; predecessorId: string }) => Promise<boolean>;
  newPlanId: () => string;
}

export interface ChatLifeWorkflowQueued {
  planId: string;
  kind: AutonomyWorkflowProposal['kind'];
  scheduledAt: number;
}

export interface ChatLifeWorkflowResponseBody {
  success: boolean;
  data?: {
    queued: ChatLifeWorkflowQueued[];
    rejected: Array<{ reason: string }>;
    deduped: number;
    /** 撤销请求的结局：true=真撤了；false/缺省=没撤（running/已结束）。 */
    cancelled?: boolean;
  };
  error?: { code: string; message: string };
}

export interface ChatLifeWorkflowHandlerResult {
  status: number;
  body: ChatLifeWorkflowResponseBody;
}

const fail = (status: number, code: string, message: string): ChatLifeWorkflowHandlerResult => ({
  status,
  body: { success: false, error: { code, message } },
});

/** 计划记录：提议 → 落库形状。所有字段都由服务端重算，客户端带什么都不采信。 */
const toPlanRecord = (
  proposal: AutonomyWorkflowProposal,
  args: {
    planId: string;
    charId: string;
    body: ChatLifeWorkflowRequestBody;
    pack: AmsgFirePack;
    nowMs: number;
  },
): AutonomyPlanRecord => ({
  id: args.planId,
  charId: args.charId,
  kind: proposal.kind,
  status: 'proposed',
  purpose: proposal.purpose,
  title: proposal.action.title,
  ...(proposal.action.noteHint ? { noteHint: proposal.action.noteHint } : {}),
  maxChars: proposal.action.maxChars,
  trigger: proposal.trigger,
  scheduledAt: computeScheduledAt(proposal, {
    nowMs: args.nowMs,
    tzId: args.pack.tzId,
    lastUserMessageAt: typeof args.pack.lastUserMessageAt === 'number' ? args.pack.lastUserMessageAt : null,
  }),
  expiresAt: proposal.expiresAt,
  createdAt: args.nowMs,
  updatedAt: args.nowMs,
  source: 'chat_reply',
  sourceRef: args.body.sourceRef,
  basis: proposal.basis,
  evidence: [...proposal.evidence],
  ...(proposal.predecessorId ? { predecessorId: proposal.predecessorId } : {}),
  dedupeKey: proposal.dedupeKey,
  attempts: 0,
  leaseUntil: 0,
});

export async function handleChatLifeWorkflow(
  deps: ChatLifeWorkflowDeps,
): Promise<ChatLifeWorkflowHandlerResult> {
  // 1. 身份：只认鉴权头。这里先挡，没登录连包都不读。
  const userId = deps.userId;
  if (!userId) return fail(401, 'UNAUTHORIZED', '缺少用户身份');

  // 2. 信封形状。
  const parsed = parseChatLifeWorkflowBody(deps.rawBody);
  if (!parsed.ok) return fail(400, 'INVALID_REQUEST', `请求体不合法（${parsed.reason}）`);
  const body = parsed.body;

  // 3. 用户级总暂停：服务端说话，客户端自报不算。
  if (await deps.isUserPaused(userId)) {
    return fail(409, 'AUTONOMY_PAUSED', '自主生活已暂停');
  }

  // 4. 包必须按「用户 + 角色」查得到。
  const pack = await deps.loadPack({ userId, charId: body.charId });
  if (!pack) return fail(409, 'FIRE_PACK_MISSING', '这个角色没有可用的自主配置');

  // 3.5 撤销：只撤这个角色自己的、还没开始的计划。
  // 计划 id 必须真实存在且 charId 对得上（跨角色一律 PLAN_NOT_FOUND）；
  // running/终态由 store 的条件 UPDATE 挡下 → 明确 409，不假称撤销成功。
  if (body.action === 'cancel') {
    const planId = body.planId ?? '';
    const plan = await deps.loadPlan(planId);
    if (!plan || plan.charId !== body.charId) {
      return fail(404, 'PLAN_NOT_FOUND', '没有这条安排');
    }
    const cancelled = await deps.cancelPlan({ planId, charId: body.charId, reason: 'role-cancelled' });
    if (!cancelled) {
      return fail(409, 'PLAN_NOT_CANCELLABLE', '这条安排已经在做或者已经结束，撤不回来');
    }
    return {
      status: 200,
      body: { success: true, data: { queued: [], rejected: [], deduped: 0, cancelled: true } },
    };
  }

  // 5. 权限终值：开关 + 能力白名单。
  //
  // **刻意不查 writable**：那是「真实世界写入」的总闸（MCP 写、发帖、下单、动真实资料）。
  // 三类私人动作只写角色自己的账本与计划行，与后台执行侧（autonomyFire 的
  // canRunPrivateLifeAction）口径一致——否则默认关着 writable 的用户在聊天里永远提不了，
  // 而后台回合却能提，同一条链两套标准。
  const autonomy = pack.autonomy;
  if (autonomy?.enabled !== true) {
    return fail(409, 'AUTONOMY_DISABLED', '这个角色没开自主生活');
  }

  const ctx: WorkflowValidateContext = {
    nowMs: deps.nowMs,
    source: 'chat_reply',
    sourceRef: body.sourceRef,
    tzId: pack.tzId,
  };

  const queued: ChatLifeWorkflowQueued[] = [];
  const rejected: Array<{ reason: string }> = [];
  let deduped = 0;
  let capabilityDenied = 0;

  for (const raw of body.proposals) {
    // 先补形状（聊天工具参数是「标题 + 为什么」的扁平形状，action 由契约叶子重建；
    // 危险键原样留着，交给下面共用的校验器明确拒收——不在这里偷偷洗掉）。
    const shaped = proposalFromChatToolArgs(raw);
    if (!shaped.ok) {
      rejected.push({ reason: shaped.reason });
      continue;
    }
    const validated = validateAutonomyWorkflowProposal(shaped.proposal, ctx);
    if (!validated.ok) {
      rejected.push({ reason: validated.reason });
      continue;
    }
    const proposal = validated.proposal;

    // 能力闸在「条数闸」之前：被权限拒的条目不占这一轮唯一的那个名额。
    if (!canRunPrivateLifeAction(autonomy, proposal.kind)) {
      capabilityDenied += 1;
      rejected.push({ reason: 'capability' });
      continue;
    }
    if (queued.length >= CHAT_LIFE_WORKFLOW_MAX_ACCEPTED) {
      rejected.push({ reason: 'over-limit' });
      continue;
    }

    const plan = toPlanRecord(proposal, {
      planId: deps.newPlanId(),
      charId: body.charId,
      body,
      pack,
      nowMs: deps.nowMs,
    });
    const inserted = await deps.insertPlan(plan);
    if (!inserted) {
      deduped += 1;
      continue;
    }
    // 先落新计划、再撤前身：新提议没通过校验/没落库时，旧计划毫发无损。
    if (plan.predecessorId) {
      try {
        await deps.cancelPredecessor({ charId: body.charId, predecessorId: plan.predecessorId });
      } catch {
        /* 撤不掉前身不影响新计划；下一跳用户开口也会取消 */
      }
    }
    queued.push({ planId: plan.id, kind: plan.kind, scheduledAt: plan.scheduledAt });
  }

  // 一条都没落、而且是被权限挡下的：整批 403（不是「成功但 0 条」）。
  if (queued.length === 0 && deduped === 0 && capabilityDenied > 0) {
    return fail(403, 'CAPABILITY_MISSING', '这个角色现在没有这类写入权限');
  }

  return {
    status: 200,
    body: { success: true, data: { queued, rejected, deduped } },
  };
}
