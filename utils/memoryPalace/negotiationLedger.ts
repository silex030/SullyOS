/**
 * Memory Palace — 记忆协商 · 候选账本（持久化）
 *
 * 为什么落在 localStorage 而不是新开 IndexedDB 表：
 * - 本轮不允许改 utils/db.ts（另一位代理正在修 wipe / vectorStore / db.ts），
 *   建新 store 会撞车；现有 db.ts 也没有可复用的通用 kv 表。
 * - 未决候选**不是记忆**，不能写进 memory_nodes——否则召回/消化/UI 会把
 *   「角色猜测」当成事实，正是本任务要防的事。
 * - 项目里已有同类先例：高水位线 mp_lastMsgId_* 就放在 localStorage。
 *
 * 因此：
 * - 账本按角色隔离（key 内嵌 charId），体积有硬上限，只存 ID / 说法 / 草稿，不存对话原文。
 * - 「一键清空记忆」需要同时清账本时，由 wipe 的负责人调用 clearNegotiationLedger(charId)
 *   / clearAllNegotiationLedgers()（见 negotiation.ts 的公开接口说明）。
 * - 备份不含账本：恢复后未决候选自然消失，不臆造证据；已落库事实的证据字段随
 *   memory_nodes 一起备份还原。
 */

import type {
    CandidateState,
    NegotiationCandidate,
    NegotiationLedger,
    NegotiationResolutionLog,
} from './negotiationTypes';
import {
    NEGOTIATION_PENDING_CAP,
    NEGOTIATION_RESOLUTION_LOG_CAP,
    NEGOTIATION_VERSION,
} from './negotiationTypes';

const KEY_PREFIX = 'mp_negotiation_v1_';

export function ledgerStorageKey(charId: string): string {
    return `${KEY_PREFIX}${charId}`;
}

export function emptyNegotiationLedger(charId: string, now = Date.now()): NegotiationLedger {
    return { version: NEGOTIATION_VERSION, charId, updatedAt: now, candidates: [], resolutions: [] };
}

function readStorage(key: string): string | null {
    try {
        return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    } catch {
        return null;
    }
}

function normalizeCandidate(raw: unknown, charId: string): NegotiationCandidate | null {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Partial<NegotiationCandidate>;
    if (typeof item.id !== 'string' || !item.id) return null;
    if (typeof item.claim !== 'string' || !item.claim) return null;
    if (!item.draft || typeof item.draft !== 'object') return null;
    const draft = item.draft as NegotiationCandidate['draft'];
    if (typeof draft.content !== 'string' || !draft.content) return null;

    const state: CandidateState = item.state === 'clarified' || item.state === 'rejected'
        || item.state === 'expired' || item.state === 'superseded'
        ? item.state
        : 'pending';

    return {
        id: item.id,
        charId,
        claim: item.claim,
        subject: item.subject && typeof item.subject === 'object'
            ? { kind: (item.subject.kind || 'unknown') as NegotiationCandidate['subject']['kind'], ...(item.subject.ref ? { ref: item.subject.ref } : {}) }
            : { kind: 'unknown' },
        topicId: typeof item.topicId === 'string' && item.topicId ? item.topicId : 'unscoped',
        ...(item.topicLabel ? { topicLabel: item.topicLabel } : {}),
        evidence: item.evidence === 'user_explicit' || item.evidence === 'character_inferred'
            || item.evidence === 'ambiguous' ? item.evidence : 'unrecorded',
        durability: item.durability === 'long_term' || item.durability === 'short_term'
            ? item.durability : 'unknown',
        ...(item.timeRange && typeof item.timeRange === 'object' ? { timeRange: item.timeRange } : {}),
        sourceMessageIds: Array.isArray(item.sourceMessageIds)
            ? item.sourceMessageIds.filter((id): id is number => typeof id === 'number' && Number.isFinite(id))
            : [],
        state,
        createdAt: Number.isFinite(item.createdAt) ? Number(item.createdAt) : Date.now(),
        updatedAt: Number.isFinite(item.updatedAt) ? Number(item.updatedAt) : Date.now(),
        attempts: Array.isArray(item.attempts)
            ? item.attempts
                .filter(attempt => attempt && typeof attempt === 'object')
                .map(attempt => ({
                    at: Number.isFinite(attempt.at) ? Number(attempt.at) : Date.now(),
                    messageIds: Array.isArray(attempt.messageIds) ? attempt.messageIds.filter((id: unknown): id is number => typeof id === 'number') : [],
                    outcome: (attempt.outcome || 'unclear') as NegotiationCandidate['attempts'][number]['outcome'],
                }))
            : [],
        ...(item.resolution && typeof item.resolution === 'object' ? { resolution: item.resolution } : {}),
        ...(item.appliedMemoryId ? { appliedMemoryId: item.appliedMemoryId } : {}),
        draft: {
            content: draft.content,
            room: draft.room,
            importance: Number.isFinite(draft.importance) ? Number(draft.importance) : 5,
            mood: typeof draft.mood === 'string' ? draft.mood : 'neutral',
            ...(Number.isFinite(draft.valence) ? { valence: Number(draft.valence) } : {}),
            ...(Number.isFinite(draft.arousal) ? { arousal: Number(draft.arousal) } : {}),
            tags: Array.isArray(draft.tags) ? draft.tags.filter((tag): tag is string => typeof tag === 'string') : [],
            ...(Array.isArray(draft.entities) ? { entities: draft.entities } : {}),
            createdAt: Number.isFinite(draft.createdAt) ? Number(draft.createdAt) : Date.now(),
        },
        ...(Array.isArray(item.supersedes) && item.supersedes.length > 0 ? { supersedes: item.supersedes.filter((id): id is string => typeof id === 'string') } : {}),
    };
}

function normalizeResolutionLog(raw: unknown): NegotiationResolutionLog | null {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Partial<NegotiationResolutionLog>;
    if (typeof item.candidateId !== 'string' || !item.candidateId) return null;
    const outcome = item.outcome === 'clarified' || item.outcome === 'rejected'
        || item.outcome === 'rejected_by_policy' || item.outcome === 'unclear'
        ? item.outcome : 'unclear';
    return {
        at: Number.isFinite(item.at) ? Number(item.at) : Date.now(),
        candidateId: item.candidateId,
        outcome,
        ...(typeof item.reason === 'string' ? { reason: item.reason } : {}),
        messageIds: Array.isArray(item.messageIds)
            ? item.messageIds.filter((id): id is number => typeof id === 'number')
            : [],
    };
}

/**
 * 读取账本。任何损坏 / 旧版本 / 未知字段都降级处理，绝不抛错、绝不补造候选。
 */
export function loadNegotiationLedger(charId: string, now = Date.now()): NegotiationLedger {
    if (!charId) return emptyNegotiationLedger(charId, now);
    const raw = readStorage(ledgerStorageKey(charId));
    if (!raw) return emptyNegotiationLedger(charId, now);
    let parsed: any;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return emptyNegotiationLedger(charId, now);
    }
    if (!parsed || typeof parsed !== 'object') return emptyNegotiationLedger(charId, now);

    const candidates = Array.isArray(parsed.candidates)
        ? parsed.candidates.map((entry: unknown) => normalizeCandidate(entry, charId)).filter(Boolean) as NegotiationCandidate[]
        : [];
    const resolutions = Array.isArray(parsed.resolutions)
        ? parsed.resolutions.map(normalizeResolutionLog).filter(Boolean) as NegotiationResolutionLog[]
        : [];

    return {
        version: NEGOTIATION_VERSION,
        charId,
        updatedAt: Number.isFinite(parsed.updatedAt) ? Number(parsed.updatedAt) : now,
        candidates: candidates.slice(-NEGOTIATION_PENDING_CAP * 2),
        resolutions: resolutions.slice(-NEGOTIATION_RESOLUTION_LOG_CAP),
    };
}

/**
 * 写账本：先按 pending 上限裁剪（最老的未决候选过期），再落盘。
 * pending 超限只丢最老的候选，不动已澄清/已拒绝记录。
 */
export function saveNegotiationLedger(ledger: NegotiationLedger): NegotiationLedger {
    const now = Date.now();
    const pending = ledger.candidates.filter(candidate => candidate.state === 'pending');
    const overflow = pending.length - NEGOTIATION_PENDING_CAP;
    if (overflow > 0) {
        const dropIds = new Set(
            pending
                .slice()
                .sort((a, b) => a.createdAt - b.createdAt)
                .slice(0, overflow)
                .map(candidate => candidate.id),
        );
        for (const candidate of ledger.candidates) {
            if (dropIds.has(candidate.id)) {
                candidate.state = 'expired';
                candidate.updatedAt = now;
            }
        }
    }

    const trimmed: NegotiationLedger = {
        version: NEGOTIATION_VERSION,
        charId: ledger.charId,
        updatedAt: now,
        candidates: ledger.candidates
            .slice()
            .sort((a, b) => a.createdAt - b.createdAt)
            .slice(-NEGOTIATION_PENDING_CAP * 2),
        resolutions: ledger.resolutions.slice(-NEGOTIATION_RESOLUTION_LOG_CAP),
    };
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(ledgerStorageKey(ledger.charId), JSON.stringify(trimmed));
        }
    } catch {
        /* 配额不足 / 隐私模式：账本丢失只是少一次机会，不能让提取链路失败 */
    }
    return trimmed;
}

/**
 * 幂等插入 / 更新候选。
 * 同一 claimId 重放：保留 createdAt 与已有 attempts，不产生第二条；
 * 已不是 pending 的候选不会再被新的 pending 覆盖（防重放把已确认候选打回未决）。
 */
export function upsertCandidate(
    ledger: NegotiationLedger,
    candidate: NegotiationCandidate,
): { ledger: NegotiationLedger; inserted: boolean } {
    const index = ledger.candidates.findIndex(entry => entry.id === candidate.id);
    if (index < 0) {
        ledger.candidates.push(candidate);
        return { ledger, inserted: true };
    }
    const existing = ledger.candidates[index];
    if (existing.state !== 'pending') {
        return { ledger, inserted: false };
    }
    const attemptKey = (attempt: { at: number; messageIds: number[] }) =>
        `${attempt.at}|${attempt.messageIds.join(',')}`;
    const seenAttempts = new Set(existing.attempts.map(attemptKey));
    const mergedAttempts = [
        ...existing.attempts,
        ...candidate.attempts.filter(attempt => !seenAttempts.has(attemptKey(attempt))),
    ];
    ledger.candidates[index] = {
        ...existing,
        claim: candidate.claim || existing.claim,
        evidence: candidate.evidence,
        durability: candidate.durability,
        ...(candidate.timeRange ? { timeRange: candidate.timeRange } : {}),
        topicId: candidate.topicId,
        ...(candidate.topicLabel ? { topicLabel: candidate.topicLabel } : {}),
        sourceMessageIds: Array.from(new Set([...existing.sourceMessageIds, ...candidate.sourceMessageIds])),
        attempts: mergedAttempts.slice(-4),
        draft: candidate.draft,
        updatedAt: Date.now(),
    };
    return { ledger, inserted: false };
}

export function pendingCandidates(ledger: NegotiationLedger): NegotiationCandidate[] {
    return ledger.candidates.filter(candidate => candidate.state === 'pending');
}

export function findCandidate(ledger: NegotiationLedger, id: string): NegotiationCandidate | undefined {
    return ledger.candidates.find(candidate => candidate.id === id);
}

export function recordResolution(ledger: NegotiationLedger, entry: NegotiationResolutionLog): void {
    ledger.resolutions.push(entry);
    if (ledger.resolutions.length > NEGOTIATION_RESOLUTION_LOG_CAP) {
        ledger.resolutions = ledger.resolutions.slice(-NEGOTIATION_RESOLUTION_LOG_CAP);
    }
}

/** 清空单个角色的账本（wipe 钩子用）。 */
export function clearNegotiationLedger(charId: string): void {
    try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(ledgerStorageKey(charId));
    } catch { /* ignore */ }
}

/** 清空全部角色的账本（全局重置 / 测试用）。 */
export function clearAllNegotiationLedgers(): number {
    let removed = 0;
    try {
        if (typeof localStorage === 'undefined') return 0;
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i);
            if (key && key.startsWith(KEY_PREFIX)) keys.push(key);
        }
        for (const key of keys) {
            localStorage.removeItem(key);
            removed += 1;
        }
    } catch { /* ignore */ }
    return removed;
}

/** 测试 / 诊断用：每个角色还剩多少未决候选。 */
export function countPendingCandidates(charId: string): number {
    return pendingCandidates(loadNegotiationLedger(charId)).length;
}
