/**
 * Memory Palace — 记忆协商 · 批次计划（纯函数）
 *
 * 输入 = 现有一次提取调用的产物（parsed JSON + 已构造的 MemoryNode[]），
 * 输出 = 这一批哪些能落库、哪些进未决账本、哪些候选已被澄清需要补写。
 *
 * 不对存储做任何写入（由调用方 persistNegotiationPlan / commitPromotedMemories 完成），
 * 这样「重放同一批」在测试里可以被直接断言：同样的输入 → 同样的账本与同样的节点 ID。
 */

import type { Message } from '../../types';
import type { MemoryNode } from './types';
import type {
    NegotiationCandidate,
    NegotiationDecision,
    NegotiationDraft,
    NegotiationLedger,
    NegotiationParseContext,
} from './negotiationTypes';
import {
    NEGOTIATION_CLAIM_MAX_CHARS,
    NEGOTIATION_DRAFT_CONTENT_MAX_CHARS,
} from './negotiationTypes';
import {
    annotateMemoryNode,
    decideApply,
    promotedMemoryIdFor,
    readNegotiationFields,
    toNegotiationMeta,
} from './negotiationEvidence';
import {
    emptyNegotiationLedger,
    loadNegotiationLedger,
    saveNegotiationLedger,
    upsertCandidate,
} from './negotiationLedger';
import {
    applyResolutionDirectives,
    parseResolutionDirectives,
    type AppliedResolution,
} from './negotiationResolve';

export interface NegotiationPlanInput {
    charId: string;
    charName: string;
    userName: string;
    /** 本批送给模型的消息（来源消息 ID 的合法集合） */
    messages: Message[];
    /** 模型原始 JSON 数组（含非记忆指令项） */
    parsed: any[];
    /** 与 parsed 中「有 content 且有 room」的项**同序**的已构造节点 */
    memories: MemoryNode[];
    batchId?: string;
    now?: number;
    /** 测试或同进程连续批次可直接注入，省一次读盘 */
    ledger?: NegotiationLedger;
    /**
     * 本批提示词里实际展示的未决候选（顺序 = C0..Cn）。
     * 提取侧在拼 prompt 时抓一份快照传进来，避免本批新增候选把 C 编号挤错位。
     */
    promptCandidates?: { id: string }[];
}

export interface NegotiationPlanSummary {
    /** 允许落库的记忆条数 */
    applied: number;
    /** 转为未决候选的条数 */
    deferred: number;
    /** 本轮新澄清、需要补写库的候选条数 */
    promoted: number;
    /** 本轮被用户明确否认的候选条数 */
    rejected: number;
    /** 澄清指令总数 / 未能改动状态的条数 */
    resolutionDirectives: number;
    unresolvedDirectives: number;
}

export interface NegotiationPlan {
    charId: string;
    batchId: string;
    decisions: NegotiationDecision[];
    /** 允许落库的 memoryId（其余必须从落库列表里剔除） */
    keptMemoryIds: string[];
    /** 本轮新产生 / 更新的未决候选 */
    candidates: NegotiationCandidate[];
    /** 已被确认、需要补写进记忆库的节点（确定性 ID，重放不重复） */
    promotions: { candidateId: string; node: MemoryNode }[];
    ledger: NegotiationLedger;
    resolutions: AppliedResolution[];
    summary: NegotiationPlanSummary;
}

export function buildNegotiationParseContext(input: {
    charId: string;
    charName: string;
    userName: string;
    messages: Message[];
    batchId: string;
    now: number;
}): NegotiationParseContext {
    const allowedMessageIds = new Set<number>();
    const messageTimestamps = new Map<number, number>();
    for (const message of input.messages) {
        if (typeof message.id === 'number' && Number.isFinite(message.id)) {
            allowedMessageIds.add(message.id);
            messageTimestamps.set(message.id, message.timestamp);
        }
    }
    return {
        charId: input.charId,
        charName: input.charName,
        userName: input.userName,
        allowedMessageIds,
        messageTimestamps,
        batchId: input.batchId,
        now: input.now,
    };
}

/** 与 extraction 侧的过滤口径保持一致（parseMemoryNodesFromBuffer / parseRelatedToAndHints 都用它）。 */
export function isMemoryBearingItem(item: any): boolean {
    return Boolean(item && item.content && item.room);
}

export function draftFromMemory(memory: MemoryNode): NegotiationDraft {
    return {
        content: memory.content.slice(0, NEGOTIATION_DRAFT_CONTENT_MAX_CHARS),
        room: memory.room,
        importance: memory.importance,
        mood: memory.mood,
        ...(typeof memory.valence === 'number' ? { valence: memory.valence } : {}),
        ...(typeof memory.arousal === 'number' ? { arousal: memory.arousal } : {}),
        tags: Array.isArray(memory.tags) ? [...memory.tags] : [],
        ...(Array.isArray(memory.entities) && memory.entities.length > 0 ? { entities: memory.entities } : {}),
        createdAt: memory.createdAt,
    };
}

function candidateFromMemory(
    memory: MemoryNode,
    fields: ReturnType<typeof readNegotiationFields>,
    now: number,
): NegotiationCandidate {
    return {
        id: fields.claimId,
        charId: memory.charId,
        claim: memory.content.slice(0, NEGOTIATION_CLAIM_MAX_CHARS),
        subject: fields.subject,
        topicId: fields.topicId,
        ...(fields.topicLabel ? { topicLabel: fields.topicLabel } : {}),
        evidence: fields.evidence,
        durability: fields.durability,
        ...(fields.timeRange ? { timeRange: fields.timeRange } : {}),
        sourceMessageIds: [...fields.sourceMessageIds],
        state: 'pending',
        createdAt: now,
        updatedAt: now,
        attempts: [],
        draft: draftFromMemory(memory),
        ...(memory.sourceId ? { supersedes: [memory.sourceId] } : {}),
    };
}

function promotionNode(candidate: NegotiationCandidate, now: number): MemoryNode {
    const draft = candidate.draft;
    // 来源 = 当初那句 + 明确澄清的那几句：两段都要留，才能回看出「谁在哪一句确认的」。
    const sourceMessageIds = Array.from(new Set([
        ...candidate.sourceMessageIds,
        ...(candidate.resolution?.messageIds || []),
    ]));
    const node: MemoryNode = {
        id: promotedMemoryIdFor(candidate.id),
        charId: candidate.charId,
        content: draft.content,
        room: draft.room,
        tags: Array.from(new Set([...draft.tags, '协商确认'])),
        ...(draft.entities ? { entities: draft.entities } : {}),
        importance: draft.importance,
        mood: draft.mood,
        ...(typeof draft.valence === 'number' ? { valence: draft.valence } : {}),
        ...(typeof draft.arousal === 'number' ? { arousal: draft.arousal } : {}),
        embedded: false,
        createdAt: draft.createdAt,
        lastAccessedAt: now,
        accessCount: 0,
        eventBoxId: null,
        origin: 'extraction',
    };
    annotateMemoryNode(node, {
        version: 1,
        claimId: candidate.id,
        evidence: 'user_explicit',
        subject: candidate.subject,
        durability: candidate.durability,
        ...(candidate.timeRange ? { timeRange: candidate.timeRange } : {}),
        topicId: candidate.topicId,
        ...(candidate.topicLabel ? { topicLabel: candidate.topicLabel } : {}),
        sourceMessageIds,
        confirmedByMessageIds: [...(candidate.resolution?.messageIds || [])],
        assertedAt: candidate.createdAt,
        batchId: `promote:${candidate.id}`,
        longTermEligible: candidate.durability === 'long_term'
            && candidate.subject.kind !== 'unknown'
            && candidate.subject.kind !== 'relationship',
        fromCandidateId: candidate.id,
        ...(candidate.supersedes ? { supersedes: candidate.supersedes } : {}),
    });
    return node;
}

/**
 * 计算一批提取结果的协商计划。纯函数：只读入账本（或调用方注入），不改存储。
 */
export function planNegotiationBatch(input: NegotiationPlanInput): NegotiationPlan {
    const now = input.now ?? Date.now();
    const batchId = input.batchId || `batch_${now}`;
    const ctx = buildNegotiationParseContext({
        charId: input.charId,
        charName: input.charName,
        userName: input.userName,
        messages: input.messages,
        batchId,
        now,
    });
    const ledger = input.ledger ?? loadNegotiationLedger(input.charId, now);

    const memoryItems = (Array.isArray(input.parsed) ? input.parsed : [])
        .filter(isMemoryBearingItem) as Record<string, unknown>[];

    const decisions: NegotiationDecision[] = [];
    const keptMemoryIds: string[] = [];
    const candidates: NegotiationCandidate[] = [];
    const keptClaimIds = new Map<string, string>();

    const count = Math.min(memoryItems.length, input.memories.length);
    for (let index = 0; index < count; index += 1) {
        const memory = input.memories[index];
        const item = memoryItems[index];
        const fields = readNegotiationFields(item, ctx);
        const { apply, reason } = decideApply(fields);
        decisions.push({
            memoryId: memory.id,
            claimId: fields.claimId,
            apply,
            reason,
            evidence: fields.evidence,
        });

        if (apply) {
            annotateMemoryNode(memory, {
                ...toNegotiationMeta(fields),
                // 兼容路径（模型没给协商字段）不进长期事实，避免把「不知道证据等级」的说法
                // 直接蒸成长期画像。
                longTermEligible: fields.evidence === 'unrecorded' ? false : fields.longTermEligible,
            });
            keptMemoryIds.push(memory.id);
            keptClaimIds.set(fields.claimId, memory.id);
            continue;
        }

        upsertCandidate(ledger, candidateFromMemory(memory, fields, now));
        const stored = ledger.candidates.find(entry => entry.id === fields.claimId);
        if (stored) candidates.push(stored);
    }

    // 澄清指令：必须在候选入账之后处理，这样同一批里「先猜测、后澄清」也能绑定。
    const directives = parseResolutionDirectives(
        Array.isArray(input.parsed) ? input.parsed : [],
        ctx,
    );
    const resolutions = directives.length > 0
        ? applyResolutionDirectives(ledger, directives, ctx, input.promptCandidates)
        : [];

    // 已澄清候选：如果本批自己也产出了同一说法的明确记忆，直接复用，不再物化重复节点。
    for (const candidate of ledger.candidates) {
        if (candidate.state !== 'clarified' || candidate.appliedMemoryId) continue;
        const matchedMemoryId = keptClaimIds.get(candidate.id);
        if (matchedMemoryId) candidate.appliedMemoryId = matchedMemoryId;
    }

    // 需要补写的候选：已澄清但没有落库节点 → 用确定性 ID 物化，重放只会覆盖同一条。
    const promotions: NegotiationPlan['promotions'] = [];
    for (const candidate of ledger.candidates) {
        if (candidate.state !== 'clarified' || candidate.appliedMemoryId) continue;
        promotions.push({ candidateId: candidate.id, node: promotionNode(candidate, now) });
    }

    const summary: NegotiationPlanSummary = {
        applied: keptMemoryIds.length,
        deferred: decisions.filter(decision => !decision.apply).length,
        promoted: promotions.length,
        rejected: resolutions.filter(resolution => resolution.outcome === 'rejected' && resolution.changed).length,
        resolutionDirectives: directives.length,
        unresolvedDirectives: resolutions.filter(resolution => !resolution.changed).length,
    };

    return {
        charId: input.charId,
        batchId,
        decisions,
        keptMemoryIds,
        candidates,
        promotions,
        ledger,
        resolutions,
        summary,
    };
}

/** 落账本（唯一副作用）。失败不影响已保存的记忆。 */
export function persistNegotiationPlan(plan: NegotiationPlan): void {
    try {
        saveNegotiationLedger(plan.ledger);
    } catch {
        /* 账本写失败：候选下次重新生成，不阻断记忆落库 */
    }
}

/**
 * 物化成功后回填 appliedMemoryId，避免下一轮重复补写。
 * 由管线在 vectorizeAndStore 成功之后调用。
 */
export function commitPromotedMemories(
    plan: NegotiationPlan,
    promoted: { candidateId: string; memoryId: string }[],
): void {
    if (promoted.length === 0) return;
    const byId = new Map(promoted.map(entry => [entry.candidateId, entry.memoryId]));
    for (const candidate of plan.ledger.candidates) {
        const memoryId = byId.get(candidate.id);
        if (memoryId) candidate.appliedMemoryId = memoryId;
    }
    persistNegotiationPlan(plan);
}

/** 测试 / 诊断：给一个不落盘的空白账本。 */
export function blankLedger(charId: string, now = Date.now()): NegotiationLedger {
    return emptyNegotiationLedger(charId, now);
}
