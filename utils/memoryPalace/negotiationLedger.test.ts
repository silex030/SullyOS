import { beforeEach, describe, expect, it } from 'vitest';

import type { NegotiationCandidate } from './negotiationTypes';
import {
    NEGOTIATION_PENDING_CAP,
    NEGOTIATION_VERSION,
} from './negotiationTypes';
import {
    clearAllNegotiationLedgers,
    clearNegotiationLedger,
    countPendingCandidates,
    emptyNegotiationLedger,
    ledgerStorageKey,
    loadNegotiationLedger,
    pendingCandidates,
    recordResolution,
    saveNegotiationLedger,
    upsertCandidate,
} from './negotiationLedger';

function candidate(id: string, overrides: Partial<NegotiationCandidate> = {}): NegotiationCandidate {
    return {
        id,
        charId: 'char_ledger',
        claim: `说法 ${id}`,
        subject: { kind: 'user' },
        topicId: 'tp_x',
        evidence: 'ambiguous',
        durability: 'long_term',
        sourceMessageIds: [1, 2],
        state: 'pending',
        createdAt: 1_760_000_000_000,
        updatedAt: 1_760_000_000_000,
        attempts: [],
        draft: {
            content: `说法 ${id}`,
            room: 'user_room',
            importance: 5,
            mood: 'neutral',
            tags: [],
            createdAt: 1_760_000_000_000,
        },
        ...overrides,
    };
}

describe('记忆协商 · 候选账本', () => {
    beforeEach(() => {
        clearAllNegotiationLedgers();
    });

    it('读写往返：候选与决议都保留', () => {
        const ledger = emptyNegotiationLedger('char_ledger');
        upsertCandidate(ledger, candidate('nq_1'));
        recordResolution(ledger, { at: 1, candidateId: 'nq_1', outcome: 'unclear', messageIds: [3] });
        saveNegotiationLedger(ledger);

        const loaded = loadNegotiationLedger('char_ledger');
        expect(loaded.charId).toBe('char_ledger');
        expect(loaded.version).toBe(NEGOTIATION_VERSION);
        expect(loaded.candidates).toHaveLength(1);
        expect(loaded.candidates[0].sourceMessageIds).toEqual([1, 2]);
        expect(loaded.resolutions).toHaveLength(1);
    });

    it('重放同一候选：不产生第二条，来源合并、尝试去重', () => {
        const ledger = emptyNegotiationLedger('char_ledger');
        upsertCandidate(ledger, candidate('nq_1', {
            attempts: [{ at: 10, messageIds: [5], outcome: 'unclear' }],
        }));
        upsertCandidate(ledger, candidate('nq_1', {
            sourceMessageIds: [2, 3],
            attempts: [
                { at: 10, messageIds: [5], outcome: 'unclear' },
                { at: 20, messageIds: [6], outcome: 'not_explicit' },
            ],
        }));

        expect(ledger.candidates).toHaveLength(1);
        expect(ledger.candidates[0].sourceMessageIds.sort()).toEqual([1, 2, 3]);
        expect(ledger.candidates[0].attempts.map(attempt => attempt.at)).toEqual([10, 20]);
    });

    it('已确认的候选不会被重放打回未决', () => {
        const ledger = emptyNegotiationLedger('char_ledger');
        const clarified = candidate('nq_1', { state: 'clarified', appliedMemoryId: 'mn_1' });
        upsertCandidate(ledger, clarified);
        upsertCandidate(ledger, candidate('nq_1'));

        expect(ledger.candidates[0].state).toBe('clarified');
        expect(ledger.candidates[0].appliedMemoryId).toBe('mn_1');
    });

    it('按角色隔离：两个角色的账本互不可见', () => {
        const a = emptyNegotiationLedger('char_a');
        upsertCandidate(a, candidate('nq_a', { charId: 'char_a' }));
        saveNegotiationLedger(a);

        const b = emptyNegotiationLedger('char_b');
        upsertCandidate(b, candidate('nq_b', { charId: 'char_b' }));
        saveNegotiationLedger(b);

        expect(pendingCandidates(loadNegotiationLedger('char_a')).map(entry => entry.id)).toEqual(['nq_a']);
        expect(pendingCandidates(loadNegotiationLedger('char_b')).map(entry => entry.id)).toEqual(['nq_b']);
        expect(countPendingCandidates('char_c')).toBe(0);
    });

    it('超过上限时只让最老的未决候选过期，已澄清记录不动', () => {
        const ledger = emptyNegotiationLedger('char_ledger');
        for (let index = 0; index < NEGOTIATION_PENDING_CAP + 5; index += 1) {
            upsertCandidate(ledger, candidate(`nq_${index}`, { createdAt: 1_760_000_000_000 + index }));
        }
        upsertCandidate(ledger, candidate('nq_done', { state: 'clarified', createdAt: 1 }));
        saveNegotiationLedger(ledger);

        const loaded = loadNegotiationLedger('char_ledger');
        expect(pendingCandidates(loaded)).toHaveLength(NEGOTIATION_PENDING_CAP);
        expect(loaded.candidates.find(entry => entry.id === 'nq_0')?.state).toBe('expired');
        expect(loaded.candidates.find(entry => entry.id === 'nq_done')?.state).toBe('clarified');
    });

    it('损坏的 JSON / 缺字段的旧账本 / 未知字段都不会抛错', () => {
        localStorage.setItem(ledgerStorageKey('char_broken'), '{not json');
        expect(loadNegotiationLedger('char_broken').candidates).toHaveLength(0);

        localStorage.setItem(ledgerStorageKey('char_old'), JSON.stringify({
            version: 0,
            candidates: [
                { id: 'nq_old', claim: '旧结构里的候选', draft: { content: '旧结构里的候选' }, unknownField: 1 },
                { broken: true },
            ],
        }));
        const old = loadNegotiationLedger('char_old');
        expect(old.candidates).toHaveLength(1);
        expect(old.candidates[0]).toMatchObject({
            id: 'nq_old',
            state: 'pending',
            evidence: 'unrecorded',
            durability: 'unknown',
            sourceMessageIds: [],
        });
        // 不臆造证据：旧账本里没有来源就没有来源。
        expect(old.candidates[0].sourceMessageIds).toEqual([]);
    });

    it('清空单个角色 / 全部角色', () => {
        for (const id of ['char_a', 'char_b']) {
            const ledger = emptyNegotiationLedger(id);
            upsertCandidate(ledger, candidate(`nq_${id}`, { charId: id }));
            saveNegotiationLedger(ledger);
        }
        clearNegotiationLedger('char_a');
        expect(countPendingCandidates('char_a')).toBe(0);
        expect(countPendingCandidates('char_b')).toBe(1);

        expect(clearAllNegotiationLedgers()).toBe(1);
        expect(countPendingCandidates('char_b')).toBe(0);
    });
});
