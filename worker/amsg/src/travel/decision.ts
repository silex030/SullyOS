/**
 * 出行 · 角色自己的选点决定（B3）
 *
 * 一条硬边界：**目的地由角色决定，用户没有遥控 API**。
 * - 输入只有「角色已存的候选」（真实 ID + 地名 + 距离），不接受任何请求体里的候选/目的地；
 * - 模型只能从这批 `id` 里挑，或说「换一批」「算了」「再等等」；
 * - 模型回了不存在的 id / 格式坏了 → 不猜、不就近兜底，wish 原样保留（下一轮可再来）；
 * - 没有任何模型端口（`decisionPort` 缺失或抛错）→ `wait`，愿望保留。失败 ≠ 角色不想出门。
 *
 * 换批有上限（`maxBatches`）：换批只是再查一次真实 POI，不是无限重试；每次搜索都走地图预算。
 */

import {
    MAX_CANDIDATES,
    type TravelCandidateView,
    type TravelWish,
} from '../../../../contracts/travel';
import { clampCandidates, sanitizeWishText } from '../../../../utils/travel/core';

/** 模型能看到的候选（**没有坐标**，只有地名语义与距离）。 */
export interface TravelDecisionCandidate {
    id: string;
    label: string;
    category?: string;
    distanceM: number | null;
}

export type TravelWishDecision =
    | { kind: 'choose'; candidateId: string; reason?: string }
    | { kind: 'reroll'; reason?: string }
    | { kind: 'drop'; reason?: string }
    | { kind: 'wait'; reason: TravelWishWaitReason };

export type TravelWishWaitReason =
    | 'no_candidates'
    | 'llm_unavailable'
    | 'invalid_model_output'
    | 'reroll_limit'
    | 'budget_blocked';

/** 注入的模型端口：真接线由 B6 提供（既有 chat 客户端 + 账本），测试用假实现。 */
export interface TravelDecisionPort {
    /** 返回模型原始意图；本层负责校验。抛错 = 本轮不决定。 */
    choose(input: {
        wishText: string;
        candidates: readonly TravelDecisionCandidate[];
        batchIndex: number;
        /** 已经换过几次批；模型可见，便于「别再无脑换」。 */
        rerollsUsed: number;
    }): Promise<unknown>;
    /**
     * 闲逛分段：走到一处、待够了，接下来做什么。可选——没有实现 = 这一轮没有分段能力，
     * tick 会把行程**留在原处**（不替角色决定回家）。
     */
    nextSegment?(input: TravelSegmentContext): Promise<unknown>;
    /**
     * 本次调用真实消耗的 token（供应商回了 usage 才有）。没有就是 undefined ——
     * 结算回落到预估值，不编一个看起来精确的数字。
     */
    lastUsageTokens?(): number | undefined;
    /**
     * 「要不要出门」：没有推送订阅、页面也没开的时候，靠这一句让角色自己想一想。
     * 可选——没有实现 = 不产生自主愿望（hud 置 no_wish），不伪造「想出去」。
     */
    proposeIntent?(input: {
        homeLabel: string | null;
        minutesSinceLastOuting: number | null;
    }): Promise<unknown>;
}

/* ------------------------------------------------------------------ *
 * 自主意愿（没有推送订阅、页面也没开的时候，角色自己想一想「要不要出去」）
 * ------------------------------------------------------------------ */

export type TravelIntentProposal =
    | { kind: 'none' }
    | { kind: 'go'; wishText: string; category: string | null }
    | { kind: 'wander'; wishText: string };

/**
 * 解析「要不要出门」的模型输出。与 `parseTravelIntent`（自主回合里的可选段）同口径：
 * - `none` / `stay` / 缺省 → 不出门（正常结果，不是失败）
 * - `go` 必须给一句话；`wander` 可以不给（随便走走）
 * - 形状坏 → null（这一轮没有结论，不写任何愿望）
 */
export function parseInteyProposal(raw: unknown): TravelIntentProposal | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    const want = typeof obj.want === 'string' ? obj.want.trim().toLowerCase() : '';
    const text = typeof obj.wish === 'string' ? obj.wish.trim() : '';
    if (!want || want === 'none' || want === 'stay' || want === 'no') return { kind: 'none' };
    if (want === 'wander') return { kind: 'wander', wishText: text.slice(0, 80) };
    if (want === 'go') {
        if (!text) return null;
        const category = typeof obj.category === 'string' && obj.category.trim()
            ? obj.category.trim().slice(0, 24)
            : null;
        return { kind: 'go', wishText: text.slice(0, 80), category };
    }
    return null;
}

/**
 * 真·自主意愿出口。没有端口 → null（这一跳什么都不写）。
 * 与「选哪站」不同：这里不搜点、不花地图，只花一次模型。
 */
export async function proposeTravelIntent(input: {
    decisionPort?: TravelDecisionPort | null;
    homeLabel: string | null;
    minutesSinceLastOuting: number | null;
}): Promise<TravelIntentProposal | null> {
    const port = input.decisionPort;
    if (!port || typeof port.proposeIntent !== 'function') return null;
    let raw: unknown;
    try {
        raw = await port.proposeIntent({
            homeLabel: input.homeLabel,
            minutesSinceLastOuting: input.minutesSinceLastOuting,
        });
    } catch {
        return null;
    }
    return parseInteyProposal(raw);
}

/* ------------------------------------------------------------------ *
 * 闲逛分段（走到一站之后，由角色自己决定继续/换站/停留/回家/结束）
 * ------------------------------------------------------------------ */

export type TravelSegmentAction = 'next' | 'stay' | 'return' | 'stop';

/** 模型可见的分段上下文：**只有地名与时长语义**，没有坐标、没有住所细节。 */
export interface TravelSegmentContext {
    /** 这次出门的原话（角色自己说的）。 */
    wishText: string;
    /** 现在这一站的地名；还没到任何地方时是 null。 */
    hereLabel: string | null;
    /** 起点（住处）地名。 */
    homeLabel: string | null;
    /** 已经连续走了几段（服务端计数，模型不能改）。 */
    segmentsSoFar: number;
    /** 已经在外多少分钟（服务端按真实时间算）。 */
    minutesOut: number;
    /** 从这里走回家大概多少分钟；没有官方时长就是 null（提示词写「还不知道」）。 */
    minutesHome: number | null;
    /** 可以去的下一站候选（真实 POI，可为空）。 */
    candidates: readonly TravelDecisionCandidate[];
}

/**
 * 分段结论：
 * - `next` 从候选里挑一站（必须是真的候选 id）
 * - `stay` 就地再待一会儿（分钟数由模型给，服务端夹到护栏范围内）
 * - `return` 沿真实路线回家（回用户确认的锚点）
 * - `stop` 本次游逛到此结束，人就在这儿（不假装回到家）
 */
export type TravelSegmentDecision =
    | { kind: 'next'; candidateId: string; reason?: string }
    | { kind: 'stay'; minutes: number | null; reason?: string }
    | { kind: 'return'; reason?: string }
    | { kind: 'stop'; reason?: string }
    | { kind: 'wait'; reason: TravelWishWaitReason };

/** 停留时长护栏（分钟）：模型只能在这个区间里说，越界一律夹回来。 */
export const SEGMENT_STAY_BOUNDS = { min: 10, max: 180 } as const;

export function parseSegmentOutput(raw: unknown): Exclude<TravelSegmentDecision, { kind: 'wait' }> | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    const kind = typeof obj.kind === 'string' ? obj.kind.trim() : '';
    const reason = typeof obj.reason === 'string' && obj.reason.trim()
        ? obj.reason.trim().slice(0, 120)
        : undefined;
    switch (kind) {
        case 'next': {
            const id = typeof obj.candidateId === 'string' ? obj.candidateId.trim() : '';
            return id ? { kind: 'next', candidateId: id, ...(reason ? { reason } : {}) } : null;
        }
        case 'stay': {
            const rawMinutes = Number(obj.minutes);
            const minutes = Number.isFinite(rawMinutes) ? Math.trunc(rawMinutes) : null;
            return { kind: 'stay', minutes, ...(reason ? { reason } : {}) };
        }
        case 'return':
            return { kind: 'return', ...(reason ? { reason } : {}) };
        case 'stop':
            return { kind: 'stop', ...(reason ? { reason } : {}) };
        default:
            return null;
    }
}

/** 停留分钟数夹到护栏内；模型没给就用默认停留时长（不无限延长）。 */
export function clampStayMinutes(minutes: number | null, fallback: number): number {
    const base = minutes === null ? fallback : minutes;
    const n = Number.isFinite(base) ? Math.trunc(base) : fallback;
    return Math.min(SEGMENT_STAY_BOUNDS.max, Math.max(SEGMENT_STAY_BOUNDS.min, n));
}

/**
 * 分段决策。硬边界与 `decideWishAction` 一致：
 * - 没有端口 → `wait(llm_unavailable)`：行程留在原地，愿望保留，不写「角色想回家」；
 * - 模型说要换站但没有候选（预算/地图没给）→ `wait(no_candidates)`，不编一个地点；
 * - 换站的 id 不在这一批真实候选里 → `wait(invalid_model_output)`；
 * - 其余原样返回，任何状态写入由调用方 CAS 完成。
 */
export async function decideWanderSegment(input: {
    context: TravelSegmentContext;
    decisionPort?: TravelDecisionPort | null;
    fallbackStayMinutes?: number;
}): Promise<TravelSegmentDecision> {
    const port = input.decisionPort;
    if (!port || typeof port.nextSegment !== 'function') return { kind: 'wait', reason: 'llm_unavailable' };

    let raw: unknown;
    try {
        raw = await port.nextSegment(input.context);
    } catch {
        return { kind: 'wait', reason: 'llm_unavailable' };
    }

    const parsed = parseSegmentOutput(raw);
    if (!parsed) return { kind: 'wait', reason: 'invalid_model_output' };

    if (parsed.kind === 'next') {
        if (input.context.candidates.length === 0) return { kind: 'wait', reason: 'no_candidates' };
        const hit = input.context.candidates.find((c) => c.id === parsed.candidateId);
        if (!hit) return { kind: 'wait', reason: 'invalid_model_output' };
        return { kind: 'next', candidateId: hit.id, ...(parsed.reason ? { reason: parsed.reason } : {}) };
    }
    if (parsed.kind === 'stay') {
        return {
            kind: 'stay',
            minutes: clampStayMinutes(parsed.minutes, Math.max(1, Math.trunc(input.fallbackStayMinutes ?? 45))),
            ...(parsed.reason ? { reason: parsed.reason } : {}),
        };
    }
    return parsed;
}

export const MAX_TRAVEL_WISH_BATCHES = 2;

/** 候选 → 模型可见视图。坐标字段在这里被**结构性**丢掉（不是过滤字符串）。 */
export function toDecisionCandidates(
    candidates: readonly (TravelCandidateView & { lat?: number; lng?: number })[],
): TravelDecisionCandidate[] {
    return clampCandidates(candidates).map((c) => ({
        id: c.id,
        label: c.label,
        ...(c.category ? { category: c.category } : {}),
        distanceM: typeof c.distanceM === 'number' && Number.isFinite(c.distanceM) ? c.distanceM : null,
    }));
}

/** 模型输出解析：只认四种 kind；其余一律 null（交给调用方按「无效」处理）。 */
export function parseDecisionOutput(raw: unknown): TravelWishDecision | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    const kind = typeof obj.kind === 'string' ? obj.kind : '';
    const reason = typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim().slice(0, 120) : undefined;
    switch (kind) {
        case 'choose': {
            const id = typeof obj.candidateId === 'string' ? obj.candidateId.trim() : '';
            return id ? { kind: 'choose', candidateId: id, ...(reason ? { reason } : {}) } : null;
        }
        case 'reroll':
            return { kind: 'reroll', ...(reason ? { reason } : {}) };
        case 'drop':
            return { kind: 'drop', ...(reason ? { reason } : {}) };
        case 'wait':
            return { kind: 'wait', reason: 'no_candidates' };
        default:
            return null;
    }
}

/**
 * 决定这一轮对某个 wish 做什么。
 *
 * @param candidates 已落库的真实候选（`listTravelCandidates`）
 * @param rerollsUsed 已经换过几次批（调用方按候选批次记录）
 */
export async function decideWishAction(input: {
    wish: Pick<TravelWish, 'wishText' | 'category'>;
    candidates: readonly (TravelCandidateView & { lat?: number; lng?: number })[];
    decisionPort?: TravelDecisionPort | null;
    rerollsUsed?: number;
    maxBatches?: number;
}): Promise<TravelWishDecision> {
    const candidates = toDecisionCandidates(input.candidates);
    const rerollsUsed = Math.max(0, Math.trunc(input.rerollsUsed ?? 0));
    const maxRerolls = Math.max(0, Math.trunc((input.maxBatches ?? MAX_TRAVEL_WISH_BATCHES) - 1));

    if (candidates.length === 0) {
        // 候选空了：能换批就换，换不成就等（不是放弃，也不是就近编一个）。
        return rerollsUsed < maxRerolls ? { kind: 'reroll', reason: 'no_candidates' } : { kind: 'wait', reason: 'no_candidates' };
    }

    const port = input.decisionPort;
    if (!port) return { kind: 'wait', reason: 'llm_unavailable' };

    const sanitized = sanitizeWishText(String(input.wish.wishText ?? ''));
    const wishText = sanitized.ok ? sanitized.text : '';

    let raw: unknown;
    try {
        raw = await port.choose({
            wishText,
            candidates,
            batchIndex: rerollsUsed + 1,
            rerollsUsed,
        });
    } catch {
        return { kind: 'wait', reason: 'llm_unavailable' };
    }

    const parsed = parseDecisionOutput(raw);
    if (!parsed) return { kind: 'wait', reason: 'invalid_model_output' };
    if (parsed.kind === 'choose') {
        // 只认这批候选里的真实 ID：模型编一个/记错一个都不算数。
        const hit = candidates.find((c) => c.id === parsed.candidateId);
        if (!hit) return { kind: 'wait', reason: 'invalid_model_output' };
        return { kind: 'choose', candidateId: hit.id, ...(parsed.reason ? { reason: parsed.reason } : {}) };
    }
    if (parsed.kind === 'reroll' && rerollsUsed >= maxRerolls) {
        return { kind: 'wait', reason: 'reroll_limit' };
    }
    return parsed;
}

/** 换批用的查询词：保留角色原话；有类别就带上，别把愿望改写成用户口吻的目的地。 */
export function rerollQueryFor(
    wish: Pick<TravelWish, 'wishText' | 'category'>,
    batchIndex: number,
): { wishText: string; category?: string } {
    const sanitized = sanitizeWishText(String(wish.wishText ?? ''));
    const base = sanitized.ok ? sanitized.text : '';
    const category = wish.category?.trim() || undefined;
    const suffix = batchIndex > 1 ? category ?? '' : '';
    const text = [base, suffix].filter(Boolean).join(' ').trim().slice(0, 60);
    return { wishText: text || base || '附近走走', ...(category ? { category } : {}) };
}

export const DECISION_CANDIDATE_LIMIT = MAX_CANDIDATES;
