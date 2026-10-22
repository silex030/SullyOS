import { describe, expect, it } from 'vitest';

import type { Message } from '../../types';
import type { NegotiationParseContext } from './negotiationTypes';
import {
    decideApply,
    isNodeLongTermEligible,
    isNodeShortTerm,
    promotedMemoryIdFor,
    readNegotiationFields,
    toNegotiationMeta,
    validateSourceMessageIds,
    claimIdFor,
    annotateMemoryNode,
} from './negotiationEvidence';
import type { MemoryNode } from './types';

const messages: Message[] = [
    { id: 11, charId: 'c1', role: 'user', type: 'text', content: '我搬到杭州了。', timestamp: 1_760_000_000_000 },
    { id: 12, charId: 'c1', role: 'user', type: 'text', content: '我不是讨厌他，我只是累了。', timestamp: 1_760_000_060_000 },
    { id: 13, charId: 'c1', role: 'assistant', type: 'text', content: '她大概是累了。', timestamp: 1_760_000_120_000 },
];

function ctx(): NegotiationParseContext {
    return {
        charId: 'c1',
        charName: '苏栗',
        userName: '林岸',
        allowedMessageIds: new Set(messages.map(message => message.id)),
        messageTimestamps: new Map(messages.map(message => [message.id, message.timestamp])),
        batchId: 'b1',
        now: 1_760_000_200_000,
    };
}

function makeNode(content: string): MemoryNode {
    return {
        id: 'mn_x',
        charId: 'c1',
        content,
        room: 'user_room',
        tags: [],
        importance: 5,
        mood: 'neutral',
        embedded: true,
        createdAt: 1,
        lastAccessedAt: 1,
        accessCount: 0,
    };
}

describe('记忆协商 · 证据解析', () => {
    it('用户明确 + 来源可核对 + 长期 → 允许落库且进长期事实', () => {
        const fields = readNegotiationFields({
            content: '林岸搬到了杭州。',
            evidence: 'explicit',
            subject: 'user',
            scope: 'long_term',
            topic: '搬家',
            sourceMsgIds: [11],
        }, ctx());
        const decision = decideApply(fields);

        expect(decision).toEqual({ apply: true, reason: 'explicit_user_fact' });
        expect(fields.longTermEligible).toBe(true);
        expect(fields.sourceMessageIds).toEqual([11]);
    });

    it('否定句（模型标 ambiguous）不写当前事实', () => {
        const fields = readNegotiationFields({
            content: '林岸讨厌他。',
            evidence: 'negated',
            subject: 'user',
            scope: 'long_term',
            topic: '和同事的关系',
            sourceMsgIds: [12],
        }, ctx());

        expect(fields.evidence).toBe('ambiguous');
        expect(decideApply(fields)).toEqual({ apply: false, reason: 'ambiguous_not_a_fact' });
    });

    it('引用别人的话不当作本事实（third_person 标签 → ambiguous）', () => {
        const fields = readNegotiationFields({
            content: '有人告诉林岸他升职了。',
            evidence: 'third_person',
            subject: 'user',
            scope: 'long_term',
            sourceMsgIds: [12],
        }, ctx());

        expect(fields.evidence).toBe('ambiguous');
        expect(decideApply(fields).apply).toBe(false);
    });

    it('「昨日情绪」是短期状态：可以留作经历，但不能进长期事实', () => {
        const fields = readNegotiationFields({
            content: '林岸昨天心情很差。',
            evidence: 'explicit',
            subject: 'user',
            scope: 'short_term',
            timeRange: { kind: 'day', from: '2025-10-10', to: '2025-10-10' },
            topic: '昨天的心情',
            sourceMsgIds: [12],
        }, ctx());

        expect(decideApply(fields).apply).toBe(true);
        expect(fields.durability).toBe('short_term');
        expect(fields.longTermEligible).toBe(false);
        expect(fields.timeRange?.kind).toBe('day');
    });

    it('角色对用户的推测不落成用户事实', () => {
        const fields = readNegotiationFields({
            content: '林岸大概是被领导骂了。',
            evidence: 'inferred',
            subject: 'user',
            scope: 'long_term',
            topic: '工作',
            sourceMsgIds: [13],
        }, ctx());

        expect(decideApply(fields)).toEqual({ apply: false, reason: 'inferred_about_other' });
        expect(fields.longTermEligible).toBe(false);
    });

    it('角色对自己的推测可以留（主观印象），但不进长期事实', () => {
        const fields = readNegotiationFields({
            content: '我觉得自己有点过于在意这件事。',
            evidence: 'inferred',
            subject: 'character',
            scope: 'long_term',
            topic: '自我观察',
            sourceMsgIds: [13],
        }, ctx());

        expect(decideApply(fields)).toEqual({ apply: true, reason: 'inferred_about_character' });
        expect(fields.longTermEligible).toBe(false);
    });

    it('编造或越界的来源消息 ID 不能当证据（降级为未决）', () => {
        const fields = readNegotiationFields({
            content: '林岸是一名外科医生。',
            evidence: 'explicit',
            subject: 'user',
            scope: 'long_term',
            topic: '职业',
            sourceMsgIds: [999, 1000],
        }, ctx());

        expect(fields.sourceMessageIds).toEqual([]);
        expect(fields.invalidSourceIds).toBe(2);
        expect(fields.evidence).toBe('ambiguous');
        expect(decideApply(fields).apply).toBe(false);
    });

    it('主体不明 / 关系类说法不自动落库', () => {
        const relationship = readNegotiationFields({
            content: '我们的关系比以前近了很多。',
            evidence: 'explicit',
            subject: 'relationship',
            scope: 'long_term',
            topic: '关系',
            sourceMsgIds: [12],
        }, ctx());
        expect(decideApply(relationship)).toEqual({ apply: false, reason: 'unscoped_subject' });

        const thirdPartyWithoutName = readNegotiationFields({
            content: '那个同事最近离婚了。',
            evidence: 'explicit',
            subject: 'third_party',
            scope: 'long_term',
            topic: '同事',
            sourceMsgIds: [12],
        }, ctx());
        expect(decideApply(thirdPartyWithoutName)).toEqual({ apply: false, reason: 'unscoped_subject' });
    });

    it('模型没给协商字段（旧模板 / 旧数据）按兼容处理，但不进长期事实', () => {
        const fields = readNegotiationFields({
            content: '林岸喜欢喝冰美式。',
            room: 'user_room',
        }, ctx());

        expect(fields.evidence).toBe('unrecorded');
        expect(decideApply(fields)).toEqual({ apply: true, reason: 'legacy_unrecorded' });
        expect(fields.longTermEligible).toBe(false);
    });

    it('主体专名与角色名/用户名严格相等时才纠正 kind', () => {
        const asCharacter = readNegotiationFields({
            content: '苏栗今天睡过头了。',
            evidence: 'explicit',
            subject: 'user',
            subjectRef: '苏栗',
            scope: 'short_term',
            sourceMsgIds: [13],
        }, ctx());
        expect(asCharacter.subject.kind).toBe('character');
    });

    it('确定性 claimId：同角色同议题同主体同说法重放得到同一 ID', () => {
        const a = claimIdFor('c1', { kind: 'user' }, 'tp_1', '林岸搬到了杭州。');
        const b = claimIdFor('c1', { kind: 'user' }, 'tp_1', ' 林岸搬到了杭州。 ');
        const other = claimIdFor('c2', { kind: 'user' }, 'tp_1', '林岸搬到了杭州。');
        expect(a).toBe(b);
        expect(a).not.toBe(other);
    });

    it('旧节点没有协商元数据时按长期可用处理（备份兼容）', () => {
        const legacy = makeNode('旧记忆');
        expect(isNodeLongTermEligible(legacy)).toBe(true);
        expect(isNodeShortTerm(legacy)).toBe(false);

        const shortTerm = annotateMemoryNode(makeNode('今天很累'), {
            ...toNegotiationMeta(readNegotiationFields({
                content: '今天很累',
                evidence: 'explicit',
                subject: 'user',
                scope: 'short_term',
                sourceMsgIds: [12],
            }, ctx())),
        });
        expect(isNodeLongTermEligible(shortTerm)).toBe(false);
        expect(isNodeShortTerm(shortTerm)).toBe(true);
    });

    it('来源消息 ID 校验：数字字符串与 # 前缀都能识别，重复去重', () => {
        const { ids, invalid } = validateSourceMessageIds(['#11', '12', 11, 42], ctx().allowedMessageIds);
        expect(ids).toEqual([11, 12]);
        expect(invalid).toBe(1);
    });

    it('确认后的节点 ID 是确定性的，重放不会写出第二条', () => {
        expect(promotedMemoryIdFor('nq_deadbeef')).toBe('mn_nq_deadbeef');
    });
});
