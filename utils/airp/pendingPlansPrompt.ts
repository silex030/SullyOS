/**
 * 角色自己排着的生活安排 → 聊天上下文里的一小段（发布阻断项 4 · 最后一公里）。
 *
 * 为什么需要：聊天工具 `propose_life_workflow` 的 `action=cancel` 要求 `planId`，
 * 而 planId 只出现在 propose 成功的工具回执里。下一轮再想撤，模型手里没有任何
 * 可用的编号 —— 于是「角色能撤自己的安排」在真实对话里永远落不了地。
 *
 * 这里只做**渲染**：把客户端已经有的 `airp_workflow_plans` 记录（服务端 id、标题、
 * 状态、过期时间）压成几行。零网络、零 LLM 调用、不读服务端；数据来源是既有结果
 * 回程写下的本地记录（`autonomyResultApply` / 聊天工具回执），因此不会为它多花一次请求。
 *
 * 认知边界：
 * - `running` 如实标成「正在做，撤不了」——不假装可以取消；
 * - 过期的、已取消/已完成/失败的**一律不出现**（不能在「我还排着的事」里混进历史）；
 * - 只有列在这里的编号才允许模型使用（编号不许自己编，服务端也会按 charId 再验一次）。
 */

import type { AutonomyWorkflowPlanRecord } from '../../types';

/** 一段里最多列几条（再多模型也读不完，还会挤占真正要紧的上下文）。 */
export const PENDING_PLANS_PROMPT_MAX = 5;

const STATUS_PENDING = new Set(['proposed', 'scheduled']);
const STATUS_RUNNING = new Set(['running']);

/** 服务端明确回过「撤不了」的本地标记：说明它已经不是待办了，别再当作可撤项列出。 */
const CANNOT_CANCEL_MARK = 'cannot-cancel';

export interface PendingPlansPromptInput {
    plans: readonly AutonomyWorkflowPlanRecord[];
    nowMs: number;
    /** 覆盖默认上限（1..PENDING_PLANS_PROMPT_MAX*2），测试用。 */
    limit?: number;
}

/** 这一条现在还能不能撤（和服务端 `cancelAutonomyPlanById` 的条件 UPDATE 同口径）。 */
export const isPlanCancelableInPrompt = (plan: AutonomyWorkflowPlanRecord): boolean =>
    STATUS_PENDING.has(plan.status) && plan.lastError !== CANNOT_CANCEL_MARK;

const formatClock = (ms: number, nowMs: number): string => {
    const diffMinutes = Math.round((ms - nowMs) / 60_000);
    if (!Number.isFinite(diffMinutes)) return '';
    if (diffMinutes <= 0) return '就现在';
    if (diffMinutes < 60) return `${diffMinutes} 分钟后`;
    const hours = Math.round(diffMinutes / 60);
    if (hours < 24) return `${hours} 小时后`;
    return `${Math.round(hours / 24)} 天后`;
};

/**
 * 渲染「你自己排着的事」。没有可列的就回空串（不占位、不留一句「暂无」）。
 *
 * 输出只含：编号、标题、状态/能否撤、什么时候。不含 purpose 正文以外的原文，
 * 也不含任何用户内容（标题/目的都是角色自己写给自己的一句话）。
 */
export function buildPendingPlansBlock(input: PendingPlansPromptInput): string {
    const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
    const limit = Math.max(1, Math.min(
        PENDING_PLANS_PROMPT_MAX * 2,
        Math.trunc(input.limit ?? PENDING_PLANS_PROMPT_MAX),
    ));

    const rows = (input.plans || [])
        .filter((plan): plan is AutonomyWorkflowPlanRecord => !!plan && typeof plan.id === 'string' && plan.id.length > 0)
        .filter((plan) => STATUS_PENDING.has(plan.status) || STATUS_RUNNING.has(plan.status))
        .filter((plan) => plan.lastError !== CANNOT_CANCEL_MARK)
        // 过期的不算「还排着」：服务端下一跳就会把它标 failed，别让模型去撤一条已经没了的。
        .filter((plan) => !(typeof plan.expiresAt === 'number' && plan.expiresAt > 0 && plan.expiresAt <= nowMs))
        .sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0) || (a.createdAt || 0) - (b.createdAt || 0))
        .slice(0, limit);

    if (rows.length === 0) return '';

    const lines = rows.map((plan) => {
        const title = (plan.title || '').trim() || '（没写标题）';
        const when = typeof plan.scheduledAt === 'number' && plan.scheduledAt > 0
            ? ` · ${formatClock(plan.scheduledAt, nowMs)}`
            : '';
        if (STATUS_RUNNING.has(plan.status)) {
            return `- （编号 ${plan.id}）《${title}》${when} —— 正在做，撤不了`;
        }
        return `- （编号 ${plan.id}）《${title}》${when} —— 还没开始，可以撤`;
    });

    return [
        '### 你自己排着的事（私人、虚拟，不用向对方提）',
        '这些是你之前给自己记下的小事，不是对方的安排：',
        ...lines,
        '要撤掉其中一件还没开始的：调用 propose_life_workflow，action 填 cancel，planId 填上面那个编号。'
        + '只有这里列出来的编号能用，别自己编；标着「撤不了」的就别试了，也不要向对方解释。',
    ].join('\n');
}
