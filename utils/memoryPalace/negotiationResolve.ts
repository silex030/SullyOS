/**
 * Memory Palace — 记忆协商 · 澄清绑定（M3）
 *
 * 核心防错：
 * - **只有模型显式输出 `{"resolve":"C0", ...}`** 才可能确认某条候选。
 *   不存在「下一句像是回答 → 当成确认」的路径：本文件不含任何按顺序 / 相邻性推断，
 *   也不解析中文关键词去猜「嗯 / 对 / 是的」。
 * - 确认必须同时满足：① 用户明确（evidence=explicit）② 来源消息 ID 可验证
 *   ③ 至少有一条来源消息**不在**原候选的来源集合里（不能拿当初那句断言自证）
 *   ④ 议题一致（两边都有议题且不同 → 判为 mismatch，保持未决）
 *   ⑤ 主体一致（模型给了 subject 就必须和候选一致）
 * - 拒答 / 说不清 → 候选保持未决，只记一条 attempt（不追问、不升级）。
 */

import type { Message } from '../../types';
import type {
    CandidateResolutionOutcome,
    NegotiationCandidate,
    NegotiationLedger,
    NegotiationParseContext,
} from './negotiationTypes';
import { normalizeSubject, normalizeTopicLabel, validateSourceMessageIds } from './negotiationEvidence';
import { findCandidate, recordResolution } from './negotiationLedger';
import { visiblePendingCandidates } from './negotiationPrompt';

type ResolutionIntent = 'confirm' | 'reject' | 'decline' | 'unclear';

const INTENT_TOKENS: Record<string, ResolutionIntent> = {
    confirm: 'confirm',
    confirmed: 'confirm',
    affirmation: 'confirm',
    resolves: 'confirm',
    reject: 'reject',
    rejected: 'reject',
    deny: 'reject',
    denied: 'reject',
    refute: 'reject',
    declined: 'decline',
    decline: 'decline',
    refused: 'decline',
    refused_to_answer: 'decline',
    no_answer: 'decline',
    unwilling: 'decline',
    unclear: 'unclear',
    ambiguous: 'unclear',
    maybe: 'unclear',
};

export interface ParsedResolutionDirective {
    /** C0..Cn 的下标；解析失败为 -1 */
    candidateIndex: number;
    /** 模型写出的原编号（诊断用） */
    rawRef: string;
    intent: ResolutionIntent;
    note?: string;
    sourceMessageIds: number[];
    /** 模型声明的证据等级（只有 explicit 才可能确认） */
    evidenceIsExplicit: boolean;
    /** 模型顺带给的议题 / 主体，用于一致性校验 */
    topicLabel?: string;
    subjectKind?: string;
    subjectRef?: string;
}

/** 从提取结果数组里挑出 resolve 指令。 */
export function parseResolutionDirectives(
    parsed: any[],
    ctx: NegotiationParseContext,
): ParsedResolutionDirective[] {
    const directives: ParsedResolutionDirective[] = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const rawRef = typeof item.resolve === 'string' ? item.resolve.trim() : '';
        if (!rawRef) continue;
        const candidateIndex = parseInt(rawRef.replace(/^C/i, ''), 10);
        const intent = INTENT_TOKENS[String(item.as ?? item.result ?? '').trim().toLocaleLowerCase()] || 'unclear';
        const { ids } = validateSourceMessageIds(item.sourceMsgIds ?? item.sourceMessageIds, ctx.allowedMessageIds);
        const subject = normalizeSubject(item.subject, item.subjectRef ?? item.subjectName, ctx);
        directives.push({
            candidateIndex: Number.isFinite(candidateIndex) ? candidateIndex : -1,
            rawRef,
            intent,
            ...(typeof item.note === 'string' && item.note.trim() ? { note: item.note.trim().slice(0, 120) } : {}),
            sourceMessageIds: ids,
            evidenceIsExplicit: String(item.evidence ?? '').trim().toLocaleLowerCase() === 'explicit',
            ...(typeof item.topic === 'string' && item.topic.trim() ? { topicLabel: item.topic.trim().slice(0, 24) } : {}),
            ...(subject.kind !== 'unknown' ? { subjectKind: subject.kind } : {}),
            ...(subject.ref ? { subjectRef: subject.ref } : {}),
        });
    }
    return directives;
}

export interface ResolutionEvaluation {
    outcome: CandidateResolutionOutcome;
    messageIds: number[];
    note?: string;
}

/**
 * 纯校验：给一条指令 + 一条候选，判断能不能改动状态。
 * 不做任何副作用；任何一项不满足都退回「保持未决」。
 */
export function evaluateResolution(
    directive: ParsedResolutionDirective,
    candidate: NegotiationCandidate,
): ResolutionEvaluation {
    const messageIds = directive.sourceMessageIds;
    if (directive.intent === 'unclear') {
        return { outcome: 'unclear', messageIds };
    }
    if (directive.intent === 'decline') {
        // 用户拒答：保留未决，只记录尝试过（不再追问同一个议题）。
        return { outcome: 'unclear', messageIds };
    }
    if (!directive.evidenceIsExplicit) {
        return { outcome: 'not_explicit', messageIds };
    }
    if (messageIds.length === 0) {
        return { outcome: 'not_explicit', messageIds };
    }
    // 确认 / 否认都必须带来新的消息证据：拿原断言那一句自证不算澄清。
    const original = new Set(candidate.sourceMessageIds);
    const hasNewEvidence = messageIds.some(id => !original.has(id));
    if (!hasNewEvidence) {
        return { outcome: 'no_new_evidence', messageIds };
    }
    if (directive.topicLabel && candidate.topicLabel) {
        if (normalizeTopicLabel(directive.topicLabel) !== normalizeTopicLabel(candidate.topicLabel)) {
            return { outcome: 'topic_mismatch', messageIds };
        }
    }
    if (directive.subjectKind && directive.subjectKind !== candidate.subject.kind) {
        return { outcome: 'subject_mismatch', messageIds };
    }
    if (directive.subjectRef && candidate.subject.ref) {
        if (normalizeTopicLabel(directive.subjectRef) !== normalizeTopicLabel(candidate.subject.ref)) {
            return { outcome: 'subject_mismatch', messageIds };
        }
    }
    if (directive.intent === 'reject') {
        return { outcome: 'rejected', messageIds, ...(directive.note ? { note: directive.note } : {}) };
    }
    return { outcome: 'clarified', messageIds, ...(directive.note ? { note: directive.note } : {}) };
}

export interface AppliedResolution {
    candidateId: string;
    outcome: CandidateResolutionOutcome;
    /** 本次是否有状态变化（用于统计与幂等断言） */
    changed: boolean;
    messageIds: number[];
}

/**
 * 把指令应用到账本（就地修改）。返回每条指令的结论。
 *
 * 幂等：已 clarified / rejected 的候选不会被重复处理（changed=false），
 * 所以同一批重放不会重复物化事实。
 */
export function applyResolutionDirectives(
    ledger: NegotiationLedger,
    directives: ParsedResolutionDirective[],
    ctx: NegotiationParseContext,
    /**
     * 提示词实际展示的那份候选快照（顺序即 C0..Cn）。
     * 本批新产生的候选会把「最后 N 条」窗口顶走，所以必须按快照绑定而不是按当下账本重算，
     * 否则 C0 会指到别的议题上（P3 review focus 第 3 条）。
     */
    promptSnapshot?: { id: string }[],
): AppliedResolution[] {
    const pending = promptSnapshot && promptSnapshot.length > 0
        ? promptSnapshot
            .map(entry => findCandidate(ledger, entry.id))
            .filter((candidate): candidate is NegotiationCandidate => Boolean(candidate) && candidate!.state === 'pending')
        : visiblePendingCandidates(ledger.candidates.filter(candidate => candidate.state === 'pending'));
    const applied: AppliedResolution[] = [];

    for (const directive of directives) {
        if (directive.candidateIndex < 0 || directive.candidateIndex >= pending.length) {
            applied.push({
                candidateId: '',
                outcome: 'unknown_candidate',
                changed: false,
                messageIds: directive.sourceMessageIds,
            });
            continue;
        }
        const candidate = findCandidate(ledger, pending[directive.candidateIndex].id);
        if (!candidate) {
            applied.push({
                candidateId: pending[directive.candidateIndex].id,
                outcome: 'unknown_candidate',
                changed: false,
                messageIds: directive.sourceMessageIds,
            });
            continue;
        }
        if (candidate.state !== 'pending') {
            applied.push({
                candidateId: candidate.id,
                outcome: candidate.state === 'rejected' ? 'rejected' : 'clarified',
                changed: false,
                messageIds: directive.sourceMessageIds,
            });
            continue;
        }

        const evaluation = evaluateResolution(directive, candidate);
        const now = ctx.now;
        if (evaluation.outcome === 'clarified') {
            candidate.state = 'clarified';
            candidate.updatedAt = now;
            candidate.resolution = {
                at: now,
                messageIds: evaluation.messageIds,
                via: 'model_resolution',
                ...(evaluation.note ? { note: evaluation.note } : {}),
            };
            recordResolution(ledger, {
                at: now,
                candidateId: candidate.id,
                outcome: 'clarified',
                messageIds: evaluation.messageIds,
            });
            applied.push({ candidateId: candidate.id, outcome: 'clarified', changed: true, messageIds: evaluation.messageIds });
            continue;
        }
        if (evaluation.outcome === 'rejected') {
            candidate.state = 'rejected';
            candidate.updatedAt = now;
            candidate.resolution = {
                at: now,
                messageIds: evaluation.messageIds,
                via: 'model_resolution',
                ...(evaluation.note ? { note: evaluation.note } : {}),
            };
            recordResolution(ledger, {
                at: now,
                candidateId: candidate.id,
                outcome: 'rejected',
                messageIds: evaluation.messageIds,
            });
            applied.push({ candidateId: candidate.id, outcome: 'rejected', changed: true, messageIds: evaluation.messageIds });
            continue;
        }

        // 其余全部保持未决，只留一条尝试记录（上限 4 条，避免反复追问刷账本）。
        candidate.attempts.push({
            at: now,
            messageIds: evaluation.messageIds,
            outcome: evaluation.outcome === 'topic_mismatch'
                ? 'topic_mismatch'
                : evaluation.outcome === 'subject_mismatch'
                    ? 'subject_mismatch'
                    : evaluation.outcome === 'not_explicit'
                        ? 'not_explicit'
                        : evaluation.outcome === 'no_new_evidence'
                            ? 'no_new_evidence'
                            : 'unclear',
        });
        candidate.attempts = candidate.attempts.slice(-4);
        candidate.updatedAt = now;
        recordResolution(ledger, {
            at: now,
            candidateId: candidate.id,
            outcome: 'unclear',
            reason: evaluation.outcome,
            messageIds: evaluation.messageIds,
        });
        applied.push({ candidateId: candidate.id, outcome: evaluation.outcome, changed: false, messageIds: evaluation.messageIds });
    }

    return applied;
}

/** 候选呈现给模型时使用的编号（C0..Cn），保证 prompt 与解析口径一致。 */
export function candidatePromptRef(index: number): string {
    return `C${index}`;
}

/** 本批消息里，是否有消息晚于候选断言时间（用于「昨日情绪」类时序断言）。 */
export function latestMessageTimestamp(messages: Message[]): number {
    let latest = 0;
    for (const message of messages) {
        if (message.timestamp > latest) latest = message.timestamp;
    }
    return latest;
}
