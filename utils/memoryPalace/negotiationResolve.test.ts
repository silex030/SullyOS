import { beforeEach, describe, expect, it } from 'vitest';

import type { Message } from '../../types';
import type { MemoryNode } from './types';
import type { NegotiatedMemoryNode } from './negotiationTypes';
import { clearAllNegotiationLedgers, loadNegotiationLedger, pendingCandidates } from './negotiationLedger';
import { commitPromotedMemories, planNegotiationBatch, persistNegotiationPlan } from './negotiationPlan';
import { claimIdFor } from './negotiationEvidence';
import { buildPendingCandidatesBlock } from './negotiationPrompt';

const charId = 'char_resolve';

function message(id: number, role: 'user' | 'assistant', content: string): Message {
    return { id, charId, role, type: 'text', content, timestamp: 1_760_000_000_000 + id * 1000 };
}

function memory(id: string, content: string, createdAt = 1_760_000_000_000): MemoryNode {
    return {
        id,
        charId,
        content,
        room: 'user_room',
        tags: [],
        importance: 5,
        mood: 'neutral',
        embedded: false,
        createdAt,
        lastAccessedAt: createdAt,
        accessCount: 0,
    };
}

/** 第一批：一条角色猜测（未决） */
const guessMessages = [message(11, 'user', '最近没怎么聊家里的事。')];
const guessItem = {
    content: '林岸可能搬到杭州了。',
    room: 'user_room',
    evidence: 'inferred',
    subject: 'user',
    scope: 'long_term',
    topic: '搬家',
    sourceMsgIds: [11],
};

function runBatch(input: {
    messages: Message[];
    parsed: any[];
    memories: MemoryNode[];
    batchId: string;
    now?: number;
}) {
    const plan = planNegotiationBatch({
        charId,
        charName: '苏栗',
        userName: '林岸',
        messages: input.messages,
        parsed: input.parsed,
        memories: input.memories,
        batchId: input.batchId,
        now: input.now ?? 1_760_000_500_000,
    });
    persistNegotiationPlan(plan);
    return plan;
}

function seedPendingCandidate(): string {
    const plan = runBatch({
        messages: guessMessages,
        parsed: [guessItem],
        memories: [memory('mn_guess_1', guessItem.content)],
        batchId: 'b1',
    });
    expect(plan.summary.deferred).toBe(1);
    const [candidate] = pendingCandidates(loadNegotiationLedger(charId));
    expect(candidate).toBeTruthy();
    return candidate.id;
}

describe('记忆协商 · 澄清绑定（M3）', () => {
    beforeEach(() => {
        clearAllNegotiationLedgers();
    });

    it('用户明确澄清（带新消息、议题一致）→ 候选转为已确认并物化成确定性节点', () => {
        const candidateId = seedPendingCandidate();
        const clarifyMessages = [message(21, 'user', '对，我上个月搬到杭州了。')];

        const plan = runBatch({
            messages: clarifyMessages,
            parsed: [{
                resolve: 'C0',
                as: 'confirm',
                evidence: 'explicit',
                topic: '搬家',
                sourceMsgIds: [21],
                note: '用户确认已搬到杭州',
            }],
            memories: [],
            batchId: 'b2',
        });

        expect(plan.summary.promoted).toBe(1);
        expect(plan.promotions).toHaveLength(1);
        const promoted = plan.promotions[0];
        expect(promoted.candidateId).toBe(candidateId);
        expect(promoted.node.id).toBe(`mn_${candidateId}`);
        expect(promoted.node.content).toBe(guessItem.content);
        expect((promoted.node as NegotiatedMemoryNode).negotiation).toMatchObject({
            evidence: 'user_explicit',
            fromCandidateId: candidateId,
            confirmedByMessageIds: [21],
            sourceMessageIds: [11, 21],
        });

        const ledger = loadNegotiationLedger(charId);
        expect(pendingCandidates(ledger)).toHaveLength(0);
        expect(ledger.candidates[0].state).toBe('clarified');
        expect(ledger.resolutions.at(-1)).toMatchObject({ outcome: 'clarified', messageIds: [21] });
    });

    it('同一批里只引用当初那句当「确认」不算澄清：候选保持未决', () => {
        const messages = [message(11, 'user', '最近没怎么聊家里的事。'), message(22, 'user', '嗯。')];
        const plan = runBatch({
            messages,
            parsed: [
                guessItem,
                {
                    resolve: 'C0',
                    as: 'confirm',
                    evidence: 'explicit',
                    topic: '搬家',
                    sourceMsgIds: [11],
                },
            ],
            memories: [memory('mn_guess_inline', guessItem.content)],
            batchId: 'b3',
        });

        expect(plan.promotions).toHaveLength(0);
        expect(plan.resolutions[0].outcome).toBe('no_new_evidence');
        expect(pendingCandidates(loadNegotiationLedger(charId))).toHaveLength(1);
    });

    it('跨批次澄清时，引用不在本批的消息 ID 同样不算证据', () => {
        seedPendingCandidate();

        const plan = runBatch({
            messages: [message(22, 'user', '嗯。')],
            parsed: [{
                resolve: 'C0',
                as: 'confirm',
                evidence: 'explicit',
                topic: '搬家',
                sourceMsgIds: [11],
            }],
            memories: [],
            batchId: 'b3b',
        });

        expect(plan.resolutions[0].outcome).toBe('not_explicit');
        expect(pendingCandidates(loadNegotiationLedger(charId))).toHaveLength(1);
    });

    it('没有明确证据的确认不生效（用户含糊其辞）', () => {
        seedPendingCandidate();

        const plan = runBatch({
            messages: [message(23, 'user', '嗯……也许吧。')],
            parsed: [{
                resolve: 'C0',
                as: 'confirm',
                evidence: 'ambiguous',
                topic: '搬家',
                sourceMsgIds: [23],
            }],
            memories: [],
            batchId: 'b4',
        });

        expect(plan.resolutions[0].outcome).toBe('not_explicit');
        expect(pendingCandidates(loadNegotiationLedger(charId))).toHaveLength(1);
    });

    it('议题对不上时保持未决（多议题 / 指代不清）', () => {
        seedPendingCandidate();

        const plan = runBatch({
            messages: [message(24, 'user', '对，我确实换了工作。')],
            parsed: [{
                resolve: 'C0',
                as: 'confirm',
                evidence: 'explicit',
                topic: '换工作',
                sourceMsgIds: [24],
            }],
            memories: [],
            batchId: 'b5',
        });

        expect(plan.resolutions[0].outcome).toBe('topic_mismatch');
        expect(plan.promotions).toHaveLength(0);
        expect(pendingCandidates(loadNegotiationLedger(charId))).toHaveLength(1);
    });

    it('两个议题各一条候选时，按 C 编号绑定，不会串台', () => {
        const messages = [message(31, 'user', '最近挺忙的。'), message(32, 'user', '房子还在看。')];
        const parsed = [
            { content: '林岸可能很累。', room: 'user_room', evidence: 'inferred', subject: 'user', scope: 'short_term', topic: '状态', sourceMsgIds: [31] },
            { content: '林岸可能在看房。', room: 'user_room', evidence: 'inferred', subject: 'user', scope: 'long_term', topic: '买房', sourceMsgIds: [32] },
        ];
        runBatch({
            messages,
            parsed,
            memories: [memory('mn_a', parsed[0].content), memory('mn_b', parsed[1].content)],
            batchId: 'b6',
        });
        const pending = pendingCandidates(loadNegotiationLedger(charId));
        expect(pending).toHaveLength(2);

        const plan = runBatch({
            messages: [message(33, 'user', '对，我最近在杭州看房。')],
            parsed: [{
                resolve: 'C1',
                as: 'confirm',
                evidence: 'explicit',
                topic: '买房',
                sourceMsgIds: [33],
            }],
            memories: [],
            batchId: 'b7',
        });

        expect(plan.promotions).toHaveLength(1);
        expect(plan.promotions[0].candidateId).toBe(
            claimIdFor(charId, { kind: 'user' }, pending[1].topicId, parsed[1].content),
        );
        const remaining = pendingCandidates(loadNegotiationLedger(charId));
        expect(remaining.map(candidate => candidate.claim)).toEqual(['林岸可能很累。']);
    });

    it('用户明确否认 → 候选作废且不落库', () => {
        seedPendingCandidate();

        const plan = runBatch({
            messages: [message(25, 'user', '没有，我没搬家。')],
            parsed: [{
                resolve: 'C0',
                as: 'reject',
                evidence: 'explicit',
                topic: '搬家',
                sourceMsgIds: [25],
                note: '用户否认搬家',
            }],
            memories: [],
            batchId: 'b8',
        });

        expect(plan.summary.rejected).toBe(1);
        expect(plan.promotions).toHaveLength(0);
        const ledger = loadNegotiationLedger(charId);
        expect(ledger.candidates[0].state).toBe('rejected');
        expect(pendingCandidates(ledger)).toHaveLength(0);
    });

    it('用户拒答 → 保留未决，只记一条尝试（不追问、不升级）', () => {
        seedPendingCandidate();

        const plan = runBatch({
            messages: [message(26, 'user', '不想说这个。')],
            parsed: [{
                resolve: 'C0',
                as: 'decline',
                evidence: 'explicit',
                topic: '搬家',
                sourceMsgIds: [26],
            }],
            memories: [],
            batchId: 'b9',
        });

        expect(plan.promotions).toHaveLength(0);
        const [candidate] = pendingCandidates(loadNegotiationLedger(charId));
        expect(candidate.state).toBe('pending');
        expect(candidate.attempts).toHaveLength(1);
        expect(candidate.attempts[0].outcome).toBe('unclear');
    });

    it('下一句只是普通回答（模型没输出 resolve）→ 候选绝不被自动确认', () => {
        seedPendingCandidate();

        const plan = runBatch({
            messages: [message(27, 'user', '杭州比北京舒服一点吧。')],
            parsed: [{
                content: '林岸觉得杭州更舒服。',
                room: 'living_room',
                evidence: 'ambiguous',
                subject: 'user',
                scope: 'long_term',
                topic: '搬家',
                sourceMsgIds: [27],
            }],
            memories: [memory('mn_amb', '林岸觉得杭州更舒服。')],
            batchId: 'b10',
        });

        expect(plan.summary.promoted).toBe(0);
        expect(plan.summary.resolutionDirectives).toBe(0);
        // 原来那条候选动都没动；新的一句含糊话只是又生成了一条新的未决候选。
        const pending = pendingCandidates(loadNegotiationLedger(charId));
        expect(pending).toHaveLength(2);
        expect(pending[0].claim).toBe(guessItem.content);
        expect(pending[0].state).toBe('pending');
        expect(plan.decisions.find(decision => decision.memoryId === 'mn_amb')?.apply).toBe(false);
    });

    it('模型没给协商字段时（旧模板）照旧落库，但标记为未记录证据、不进长期事实', () => {
        const legacyMemory = memory('mn_legacy_shape', '林岸养了一只猫。');
        const plan = runBatch({
            messages: [message(41, 'user', '我养了一只猫。')],
            parsed: [{ content: '林岸养了一只猫。', room: 'user_room', importance: 5, mood: 'happy', tags: ['猫'] }],
            memories: [legacyMemory],
            batchId: 'b13',
        });

        expect(plan.summary.applied).toBe(1);
        expect(plan.summary.deferred).toBe(0);
        expect(plan.decisions[0]).toMatchObject({ apply: true, reason: 'legacy_unrecorded', evidence: 'unrecorded' });
        expect((legacyMemory as NegotiatedMemoryNode).negotiation).toMatchObject({
            evidence: 'unrecorded',
            longTermEligible: false,
            sourceMessageIds: [],
        });
        const pending = pendingCandidates(loadNegotiationLedger(charId));
        expect(pending).toHaveLength(0);
    });

    it('候选超过提示词上限时，C 编号与解析共用同一截断口径（不会错位到别的议题）', () => {
        const messages: Message[] = [];
        const parsed: any[] = [];
        const memories: MemoryNode[] = [];
        for (let index = 0; index < 8; index += 1) {
            const id = 100 + index;
            messages.push(message(id, 'user', `第 ${index} 件事`));
            parsed.push({
                content: `第 ${index} 件事可能是真的。`,
                room: 'user_room',
                evidence: 'inferred',
                subject: 'user',
                scope: 'long_term',
                topic: `议题${index}`,
                sourceMsgIds: [id],
            });
            memories.push(memory(`mn_${index}`, `第 ${index} 件事可能是真的。`));
        }
        runBatch({ messages, parsed, memories, batchId: 'b_many' });
        const pending = pendingCandidates(loadNegotiationLedger(charId));
        expect(pending).toHaveLength(8);

        // 提示词只展示最后 6 条 → C0 必须是第 3 条（index=2），不是最老的 index=0。
        const block = buildPendingCandidatesBlock(pending);
        expect(block).toContain('C0.');
        expect(block).toContain('议题2');
        expect(block).not.toContain('议题0');

        // 解析侧同样按这个口径：C0 + 议题2 → 只确认 index=2，其余 7 条仍待定。
        const plan = runBatch({
            messages: [message(200, 'user', '对，第二件事是真的。')],
            parsed: [{
                resolve: 'C0',
                as: 'confirm',
                evidence: 'explicit',
                topic: '议题2',
                sourceMsgIds: [200],
            }],
            memories: [],
            batchId: 'b_many_2',
        });
        expect(plan.promotions).toHaveLength(1);
        expect(plan.promotions[0].node.content).toBe('第 2 件事可能是真的。');
        expect(pendingCandidates(loadNegotiationLedger(charId))).toHaveLength(7);
    });

    it('同一批里新增候选不会把 C 编号挤错位（按提示词快照绑定）', () => {
        const messages: Message[] = [];
        const parsed: any[] = [];
        const memories: MemoryNode[] = [];
        for (let index = 0; index < 6; index += 1) {
            const id = 300 + index;
            messages.push(message(id, 'user', `旧事 ${index}`));
            parsed.push({
                content: `旧事 ${index} 可能是真的。`,
                room: 'user_room',
                evidence: 'inferred',
                subject: 'user',
                scope: 'long_term',
                topic: `旧议题${index}`,
                sourceMsgIds: [id],
            });
            memories.push(memory(`mn_old_${index}`, `旧事 ${index} 可能是真的。`));
        }
        runBatch({ messages, parsed, memories, batchId: 'b_snap_1' });
        const snapshot = pendingCandidates(loadNegotiationLedger(charId)).map(candidate => ({ id: candidate.id }));
        expect(snapshot).toHaveLength(6);

        // 新一批：又冒出一条猜测（会把窗口顶走）+ 用户明确确认 C0（旧议题0）
        const newMessages = [message(400, 'user', '还有件事。'), message(401, 'user', '对，旧事 0 是真的。')];
        const newParsed = [
            {
                content: '还有别的事可能是真的。',
                room: 'user_room',
                evidence: 'inferred',
                subject: 'user',
                scope: 'long_term',
                topic: '新议题',
                sourceMsgIds: [400],
            },
            {
                resolve: 'C0', as: 'confirm', evidence: 'explicit', topic: '旧议题0', sourceMsgIds: [401],
            },
        ];
        const plan = planNegotiationBatch({
            charId,
            charName: '苏栗',
            userName: '林岸',
            messages: newMessages,
            parsed: newParsed,
            memories: [memory('mn_new_guess', newParsed[0].content!)],
            batchId: 'b_snap_2',
            promptCandidates: snapshot,
        });

        expect(plan.promotions).toHaveLength(1);
        expect(plan.promotions[0].node.content).toBe('旧事 0 可能是真的。');
    });

    it('指向不存在的 C 编号时不动任何候选', () => {
        seedPendingCandidate();

        const plan = runBatch({
            messages: [message(28, 'user', '对。')],
            parsed: [{ resolve: 'C7', as: 'confirm', evidence: 'explicit', sourceMsgIds: [28] }],
            memories: [],
            batchId: 'b11',
        });

        expect(plan.resolutions[0].outcome).toBe('unknown_candidate');
        expect(pendingCandidates(loadNegotiationLedger(charId))).toHaveLength(1);
    });

    it('重放同一批澄清：不会重复物化第二条记忆', () => {
        const candidateId = seedPendingCandidate();
        const clarifyMessages = [message(29, 'user', '对，我真的搬到杭州了。')];
        const parsed = [{
            resolve: 'C0',
            as: 'confirm',
            evidence: 'explicit',
            topic: '搬家',
            sourceMsgIds: [29],
        }];

        const first = runBatch({ messages: clarifyMessages, parsed, memories: [], batchId: 'b12' });
        expect(first.promotions).toHaveLength(1);
        // 模拟管线物化成功后的回填（真实路径里由 commitPromotedMemories 做）
        commitPromotedMemories(first, [{
            candidateId: first.promotions[0].candidateId,
            memoryId: first.promotions[0].node.id,
        }]);

        const second = runBatch({ messages: clarifyMessages, parsed, memories: [], batchId: 'b12' });
        expect(second.promotions).toHaveLength(0);
        const ledger = loadNegotiationLedger(charId);
        const candidate = ledger.candidates.find(entry => entry.id === candidateId);
        expect(candidate?.state).toBe('clarified');
        expect(ledger.resolutions.filter(entry => entry.candidateId === candidateId && entry.outcome === 'clarified')).toHaveLength(1);
    });
});
