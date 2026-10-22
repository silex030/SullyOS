import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DB } from '../db';
import { safeFetchJson } from '../safeApi';
import type { EmbeddingConfig } from './types';
import { MemoryNodeDB } from './db';
import { processMessageRange } from './pipeline';
import { clearAllNegotiationLedgers, countPendingCandidates, loadNegotiationLedger } from './negotiationLedger';
import { isNodeLongTermEligible } from './negotiationEvidence';
import { recordUserCorrection } from './negotiation';
import type { NegotiatedMemoryNode } from './negotiationTypes';

vi.mock('../safeApi', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../safeApi')>()),
    safeFetchJson: vi.fn(),
}));

const mockedSafeFetchJson = vi.mocked(safeFetchJson);
const originalFetch = global.fetch;

const embeddingConfig: EmbeddingConfig = {
    baseUrl: 'https://embedding.test/v1',
    apiKey: 'test-key',
    model: 'test-embedding',
    dimensions: 8,
};

const llmConfig = {
    baseUrl: 'https://memory.test/v1',
    apiKey: 'test-key',
    model: 'memory-model',
};

/** 每条文本一个确定性的伪向量：文本相同 → 向量相同（重放能被去重），不同文本 → 不同向量 */
function vectorFor(text: string): number[] {
    const out = new Array(8).fill(0);
    for (let i = 0; i < text.length; i += 1) {
        out[i % 8] += (text.charCodeAt(i) % 97) / 97;
    }
    const norm = Math.sqrt(out.reduce((sum, value) => sum + value * value, 0)) || 1;
    return out.map(value => value / norm);
}

function extractionReply(items: any[]) {
    return { choices: [{ message: { content: JSON.stringify(items) } }] };
}

async function seedMessages(charId: string, lines: { role: 'user' | 'assistant'; content: string }[]) {
    const ids: number[] = [];
    for (let index = 0; index < lines.length; index += 1) {
        const id = await DB.saveMessage({
            charId,
            role: lines[index].role,
            type: 'text',
            content: lines[index].content,
            timestamp: 1_760_000_000_000 + index * 60_000,
        } as any);
        ids.push(id);
    }
    return ids;
}

beforeEach(() => {
    localStorage.clear();
    clearAllNegotiationLedgers();
    mockedSafeFetchJson.mockReset();
    global.fetch = vi.fn(async (_url: any, init: any) => {
        const body = JSON.parse(String(init?.body || '{}'));
        const inputs: string[] = Array.isArray(body.input) ? body.input : [];
        return {
            ok: true,
            status: 200,
            json: async () => ({
                data: inputs.map((text, index) => ({ index, embedding: vectorFor(text) })),
            }),
        } as any;
    }) as any;
});

afterAll(() => {
    global.fetch = originalFetch;
});

describe('记忆协商 · 真实管线接入', () => {
    it('明确事实落库并带来源；角色推测只进未决账本，不写记忆库', async () => {
        localStorage.setItem('mp_negotiation_dev', 'on');
        const charId = 'char_pipeline_1';
        const [factMsgId, guessMsgId] = await seedMessages(charId, [
            { role: 'user', content: '我上个月搬到杭州了，工作也换了。' },
            { role: 'assistant', content: '新公司还习惯吗？你听着有点累。' },
        ]);

        mockedSafeFetchJson.mockResolvedValue(extractionReply([
            {
                content: '林岸上个月搬到了杭州，也换了工作。',
                room: 'user_room',
                importance: 7,
                mood: 'neutral',
                tags: ['搬家', '杭州', '工作'],
                evidence: 'explicit',
                subject: 'user',
                subjectRef: '林岸',
                scope: 'long_term',
                topic: '搬家',
                sourceMsgIds: [factMsgId],
            },
            {
                content: '林岸可能在新公司不太顺。',
                room: 'user_room',
                importance: 4,
                mood: 'sad',
                tags: ['工作'],
                evidence: 'inferred',
                subject: 'user',
                scope: 'long_term',
                topic: '工作',
                sourceMsgIds: [factMsgId, guessMsgId],
            },
        ]) as any);

        const result = await processMessageRange(
            charId, '苏栗', embeddingConfig, llmConfig, factMsgId, guessMsgId, '林岸',
        );

        expect(result.stored).toBe(1);
        expect(result.deferred).toBe(1);
        expect(result.memories.map(memory => memory.content)).toEqual(['林岸上个月搬到了杭州，也换了工作。']);

        const nodes = await MemoryNodeDB.getByCharId(charId);
        expect(nodes).toHaveLength(1);
        const stored = nodes[0] as NegotiatedMemoryNode;
        expect(stored.content).toBe('林岸上个月搬到了杭州，也换了工作。');
        expect(stored.embedded).toBe(true);
        expect(stored.negotiation).toMatchObject({
            evidence: 'user_explicit',
            durability: 'long_term',
            longTermEligible: true,
            sourceMessageIds: [factMsgId],
        });

        const ledger = loadNegotiationLedger(charId);
        expect(ledger.candidates).toHaveLength(1);
        expect(ledger.candidates[0]).toMatchObject({
            claim: '林岸可能在新公司不太顺。',
            state: 'pending',
            evidence: 'character_inferred',
        });
        // 候选没有被写进记忆库：仓库里只有那条明确事实。
        expect(nodes.some(node => node.content.includes('可能在新公司不太顺'))).toBe(false);
    });

    it('第二轮明确澄清：候选经管线物化成事实，重放不重复写', async () => {
        localStorage.setItem('mp_negotiation_dev', 'on');
        const charId = 'char_pipeline_confirm';
        const [m1, m2] = await seedMessages(charId, [
            { role: 'user', content: '最近东西都收起来了。' },
            { role: 'assistant', content: '是要搬家吗？' },
        ]);

        mockedSafeFetchJson.mockResolvedValue(extractionReply([
            {
                content: '林岸可能准备搬到杭州。',
                room: 'user_room',
                importance: 5,
                mood: 'neutral',
                tags: ['搬家'],
                evidence: 'inferred',
                subject: 'user',
                scope: 'long_term',
                topic: '搬家',
                sourceMsgIds: [m2],
            },
        ]) as any);
        const firstRun = await processMessageRange(charId, '苏栗', embeddingConfig, llmConfig, m1, m2, '林岸');
        expect(firstRun.stored).toBe(0);
        expect(firstRun.deferred).toBe(1);
        expect(await MemoryNodeDB.getByCharId(charId)).toHaveLength(0);

        // 第二轮：用户明确确认。模型在同一次调用里输出 resolve，不额外发请求。
        const [m3] = await seedMessages(charId, [{ role: 'user', content: '对，我确实要搬到杭州了。' }]);
        const secondPrompt = extractionReply([
            {
                resolve: 'C0',
                as: 'confirm',
                evidence: 'explicit',
                topic: '搬家',
                sourceMsgIds: [m3],
                note: '用户确认将搬到杭州',
            },
        ]);
        mockedSafeFetchJson.mockReset();
        mockedSafeFetchJson.mockResolvedValue(secondPrompt as any);

        await processMessageRange(charId, '苏栗', embeddingConfig, llmConfig, m3, m3, '林岸');

        // 一轮只发一次提取请求；证据字段与 C 编号都在这同一次提示词里。
        expect(mockedSafeFetchJson).toHaveBeenCalledTimes(1);
        const body = JSON.parse(String((mockedSafeFetchJson.mock.calls[0][1] as RequestInit).body));
        expect(body.messages[0].content).toContain('C0.');
        expect(body.messages[1].content).toContain(`[#${m3}]`);

        const nodes = await MemoryNodeDB.getByCharId(charId);
        expect(nodes).toHaveLength(1);
        const promoted = nodes[0] as NegotiatedMemoryNode;
        expect(promoted.content).toBe('林岸可能准备搬到杭州。');
        expect(promoted.embedded).toBe(true);
        expect(promoted.negotiation).toMatchObject({
            evidence: 'user_explicit',
            sourceMessageIds: [m2, m3],
            confirmedByMessageIds: [m3],
        });

        const ledger = loadNegotiationLedger(charId);
        expect(ledger.candidates[0].state).toBe('clarified');
        expect(ledger.candidates[0].appliedMemoryId).toBe(promoted.id);
        expect(countPendingCandidates(charId)).toBe(0);

        // 重放同一轮澄清：候选已 applied，不重复物化。
        await processMessageRange(charId, '苏栗', embeddingConfig, llmConfig, m3, m3, '林岸');
        expect(await MemoryNodeDB.getByCharId(charId)).toHaveLength(1);
    });

    it('重放同一区间：不重复写记忆、不重复记候选', async () => {
        localStorage.setItem('mp_negotiation_dev', 'on');
        const charId = 'char_pipeline_replay';
        const [factMsgId, guessMsgId] = await seedMessages(charId, [
            { role: 'user', content: '我把猫接回家了。' },
            { role: 'assistant', content: '它适应得怎么样？' },
        ]);

        mockedSafeFetchJson.mockResolvedValue(extractionReply([
            {
                content: '林岸把猫接回家了。',
                room: 'user_room',
                importance: 6,
                mood: 'happy',
                tags: ['猫'],
                evidence: 'explicit',
                subject: 'user',
                scope: 'long_term',
                topic: '养猫',
                sourceMsgIds: [factMsgId],
            },
            {
                content: '林岸可能有点手忙脚乱。',
                room: 'living_room',
                importance: 3,
                mood: 'neutral',
                tags: ['猫'],
                evidence: 'inferred',
                subject: 'user',
                scope: 'short_term',
                topic: '养猫',
                sourceMsgIds: [guessMsgId],
            },
        ]) as any);

        const first = await processMessageRange(charId, '苏栗', embeddingConfig, llmConfig, factMsgId, guessMsgId, '林岸');
        expect(first.stored).toBe(1);
        const second = await processMessageRange(charId, '苏栗', embeddingConfig, llmConfig, factMsgId, guessMsgId, '林岸');

        expect(second.stored).toBe(0);
        const nodes = await MemoryNodeDB.getByCharId(charId);
        expect(nodes).toHaveLength(1);
        expect(countPendingCandidates(charId)).toBe(1);
        const ledger = loadNegotiationLedger(charId);
        expect(ledger.candidates.filter(entry => entry.state === 'pending')).toHaveLength(1);
    });

    it('多角色隔离：两个角色的记忆与未决候选互不串台', async () => {
        localStorage.setItem('mp_negotiation_dev', 'on');
        const charA = 'char_iso_a';
        const charB = 'char_iso_b';
        const [aFact, aGuess] = await seedMessages(charA, [
            { role: 'user', content: '我搬到南京了。' },
            { role: 'assistant', content: '南京怎么样？' },
        ]);
        const [bFact, bGuess] = await seedMessages(charB, [
            { role: 'user', content: '我还在原来的公司。' },
            { role: 'assistant', content: '那就好。' },
        ]);

        mockedSafeFetchJson.mockResolvedValue(extractionReply([
            {
                content: '林岸可能搬到了杭州。',
                room: 'user_room',
                importance: 5,
                mood: 'neutral',
                tags: [],
                evidence: 'inferred',
                subject: 'user',
                scope: 'long_term',
                topic: '搬家',
                sourceMsgIds: [aFact],
            },
        ]) as any);
        await processMessageRange(charA, '苏栗', embeddingConfig, llmConfig, aFact, aGuess, '林岸');

        mockedSafeFetchJson.mockResolvedValue(extractionReply([
            {
                content: '林岸还在原来的公司。',
                room: 'user_room',
                importance: 5,
                mood: 'neutral',
                tags: [],
                evidence: 'explicit',
                subject: 'user',
                scope: 'long_term',
                topic: '工作',
                sourceMsgIds: [bFact],
            },
        ]) as any);
        await processMessageRange(charB, '苏栗', embeddingConfig, llmConfig, bFact, bGuess, '林岸');

        expect(countPendingCandidates(charA)).toBe(1);
        expect(countPendingCandidates(charB)).toBe(0);
        const nodesA = await MemoryNodeDB.getByCharId(charA);
        const nodesB = await MemoryNodeDB.getByCharId(charB);
        expect(nodesA).toHaveLength(0);
        expect(nodesB).toHaveLength(1);
        expect(nodesB[0].charId).toBe(charB);
    });

    it('开关关闭时行为与升级前一致（同一条猜测照旧落库、不建账本）', async () => {
        localStorage.setItem('mp_negotiation_dev', 'off');
        const charId = 'char_pipeline_off';
        const [factMsgId, guessMsgId] = await seedMessages(charId, [
            { role: 'user', content: '我最近睡得很少。' },
            { role: 'assistant', content: '是不是压力太大了。' },
        ]);

        mockedSafeFetchJson.mockResolvedValue(extractionReply([
            {
                content: '林岸最近睡得很少。',
                room: 'user_room',
                importance: 5,
                mood: 'tired',
                tags: [],
                evidence: 'explicit',
                subject: 'user',
                scope: 'long_term',
                topic: '睡眠',
                sourceMsgIds: [factMsgId],
            },
            {
                content: '林岸可能压力很大。',
                room: 'attic',
                importance: 4,
                mood: 'anxious',
                tags: [],
                evidence: 'inferred',
                subject: 'user',
                scope: 'long_term',
                topic: '压力',
                sourceMsgIds: [guessMsgId],
            },
        ]) as any);

        const result = await processMessageRange(charId, '苏栗', embeddingConfig, llmConfig, factMsgId, guessMsgId, '林岸');

        expect(result.stored).toBe(2);
        const nodes = await MemoryNodeDB.getByCharId(charId);
        expect(nodes).toHaveLength(2);
        expect((nodes[0] as NegotiatedMemoryNode).negotiation).toBeUndefined();
        expect(countPendingCandidates(charId)).toBe(0);
    });

    it('旧数据 / 旧备份：没有协商字段的节点照常算长期事实，手工纠正保留历史', async () => {
        const charId = 'char_pipeline_legacy';
        const legacyNode = {
            id: 'mn_legacy_1',
            charId,
            content: '林岸以前住在朝阳。',
            room: 'user_room' as const,
            tags: [],
            importance: 5,
            mood: 'neutral',
            embedded: true,
            createdAt: 1_700_000_000_000,
            lastAccessedAt: 1_700_000_000_000,
            accessCount: 1,
        };
        await MemoryNodeDB.save(legacyNode);

        expect(isNodeLongTermEligible(legacyNode as any)).toBe(true);
        expect(loadNegotiationLedger(charId).candidates).toHaveLength(0);

        const corrected = recordUserCorrection(legacyNode as any, {
            note: '已经搬到杭州',
            sourceMessageIds: [501],
            at: 1_760_000_000_000,
        }) as NegotiatedMemoryNode;

        expect(corrected.content).toBe('林岸以前住在朝阳。');
        expect(corrected.negotiation).toMatchObject({
            evidence: 'unrecorded',
            longTermEligible: true,
        });
        expect(corrected.negotiation?.supersessions).toEqual([
            expect.objectContaining({ note: '已经搬到杭州', sourceMessageIds: [501] }),
        ]);
    });
});
