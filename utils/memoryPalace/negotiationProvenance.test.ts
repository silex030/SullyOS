import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { MemoryNode } from './types';
import type { NegotiatedMemoryNode } from './negotiationTypes';
import { NEGOTIATION_HISTORY_CAP } from './negotiationTypes';
import { describeNegotiationGate, isMemoryNegotiationEnabled, recordExtractionCorrection, recordUserCorrection } from './negotiation';
import { isNodeLongTermEligible } from './negotiationEvidence';

function node(overrides: Partial<MemoryNode> = {}): MemoryNode {
    return {
        id: 'mn_prov_1',
        charId: 'char_prov',
        content: '林岸住在朝阳。',
        room: 'user_room',
        tags: [],
        importance: 5,
        mood: 'neutral',
        embedded: true,
        createdAt: 1_700_000_000_000,
        lastAccessedAt: 1_700_000_000_000,
        accessCount: 0,
        ...overrides,
    };
}

describe('记忆协商 · 纠正与失效关系（M4）', () => {
    it('用户纠正：原正文不动，追加一条带来源消息的失效关系', () => {
        const memory = node();
        recordUserCorrection(memory, { note: '已经搬到杭州', sourceMessageIds: [88, 89], at: 1_760_000_000_000 });
        recordUserCorrection(memory, { note: '不是朝阳，是西湖区', sourceMessageIds: [90], at: 1_760_000_100_000 });

        expect(memory.content).toBe('林岸住在朝阳。');
        const meta = (memory as NegotiatedMemoryNode).negotiation;
        expect(meta?.supersessions).toHaveLength(2);
        expect(meta?.supersessions?.[1]).toMatchObject({
            note: '不是朝阳，是西湖区',
            sourceMessageIds: [90],
        });
        // 人工事实来源：用户亲手改过的可以进长期事实。
        expect(meta?.longTermEligible).toBe(true);
        expect(isNodeLongTermEligible(memory)).toBe(true);
    });

    it('提取链路的纠正：不因为被纠正就把旧节点升格成长期事实', () => {
        const memory = node({ id: 'mn_prov_legacy' });
        recordExtractionCorrection(memory, { note: '已经搬家', sourceMessageIds: [77] });

        const meta = (memory as NegotiatedMemoryNode).negotiation;
        expect(meta).toMatchObject({ evidence: 'unrecorded', longTermEligible: false });
        expect(meta?.sourceMessageIds).toEqual([]);
        expect(meta?.supersessions?.[0]).toMatchObject({ note: '已经搬家', sourceMessageIds: [77] });
        expect(memory.content).toBe('林岸住在朝阳。');
    });

    it('已带证据的节点被纠正时保留原证据等级与来源', () => {
        const memory = node({ id: 'mn_prov_explicit' });
        (memory as NegotiatedMemoryNode).negotiation = {
            version: 1,
            claimId: 'nq_x',
            evidence: 'user_explicit',
            subject: { kind: 'user' },
            durability: 'long_term',
            topicId: 'tp_x',
            sourceMessageIds: [12],
            assertedAt: 1_700_000_000_000,
            batchId: 'b1',
            longTermEligible: true,
        };
        recordExtractionCorrection(memory, { note: '改到西湖区', sourceMessageIds: [91] });

        const meta = (memory as NegotiatedMemoryNode).negotiation;
        expect(meta).toMatchObject({ evidence: 'user_explicit', sourceMessageIds: [12], longTermEligible: true });
        expect(meta?.supersessions).toHaveLength(1);
    });

    it('失效历史有上限，不会被无限追加', () => {
        const memory = node();
        for (let index = 0; index < NEGOTIATION_HISTORY_CAP + 5; index += 1) {
            recordUserCorrection(memory, { note: `第 ${index} 次纠正`, at: 1_760_000_000_000 + index });
        }
        const meta = (memory as NegotiatedMemoryNode).negotiation;
        expect(meta?.supersessions).toHaveLength(NEGOTIATION_HISTORY_CAP);
        expect(meta?.supersessions?.at(-1)?.note).toBe(`第 ${NEGOTIATION_HISTORY_CAP + 4} 次纠正`);
    });

    it('空 note 不产生垃圾记录', () => {
        const memory = node();
        recordUserCorrection(memory, { note: '   ' });
        expect((memory as NegotiatedMemoryNode).negotiation).toBeUndefined();
    });
});

describe('记忆协商 · 开关', () => {
    const reset = () => {
        localStorage.removeItem('mp_negotiation_dev');
        localStorage.removeItem('sullyos.memoryNegotiation.v1');
        localStorage.removeItem('os_memory_palace_config');
    };

    it('默认关闭（升级后行为不突变）', () => {
        reset();
        expect(isMemoryNegotiationEnabled()).toBe(false);
        // 统一 gate 之后语义更诚实：根本没有这一项配置 = default_off，不再冒充 feature_flag。
        expect(describeNegotiationGate()).toEqual({ enabled: false, source: 'default_off' });
    });

    it('既有 featureFlags.epistemicState 可以打开', () => {
        reset();
        localStorage.setItem('os_memory_palace_config', JSON.stringify({ featureFlags: { epistemicState: true } }));
        expect(isMemoryNegotiationEnabled()).toBe(true);
    });

    it('前台策略的开关也能同时打开数据闭环；显式 off 优先', () => {
        reset();
        localStorage.setItem('sullyos.memoryNegotiation.v1', 'true');
        expect(isMemoryNegotiationEnabled()).toBe(true);

        localStorage.setItem('mp_negotiation_dev', 'off');
        expect(isMemoryNegotiationEnabled()).toBe(false);
        expect(describeNegotiationGate()).toEqual({ enabled: false, source: 'dev_override' });
        reset();
    });
});

describe('记忆协商 · 接线约束（源码级回归）', () => {
    const pipelineSource = readFileSync(path.resolve(__dirname, './pipeline.ts'), 'utf8');
    const extractionSource = readFileSync(path.resolve(__dirname, './extraction.ts'), 'utf8');

    it('管线按 keptMemoryIds 过滤后才向量化，不把未决条目写进记忆库', () => {
        expect(pipelineSource).toContain('plan.keptMemoryIds');
        expect(pipelineSource).toContain('keptMemoryIds.has(memory.id)');
        expect(pipelineSource).toContain('commitPromotedMemories(');
        expect(pipelineSource).toContain('recordExtractionCorrection(');
    });

    it('提取侧只在开关打开时追加协商片段，并复用同一次调用', () => {
        expect(extractionSource).toContain('isMemoryNegotiationEnabled()');
        expect(extractionSource).toContain('buildNegotiationPromptSuffix(');
        expect(extractionSource).toContain('planNegotiationBatch(');
        // 关键：不得为协商额外发一次提取请求
        expect(extractionSource.match(/safeFetchJson\(/g)?.length ?? 0).toBe(1);
    });

    it('管线的澄清确认只在拿到 resolve 指令后发生，不存在「下一句即确认」的启发式', () => {
        const resolveSource = readFileSync(path.resolve(__dirname, './negotiationResolve.ts'), 'utf8');
        expect(resolveSource).toContain('parseResolutionDirectives');
        expect(resolveSource).not.toContain('nextMessageAsConfirmation');
        // 任何按消息顺序推断确认的写法都不允许：不能出现「取最后一条 user 消息当确认」
        expect(resolveSource).not.toMatch(/messages\s*\[\s*messages\.length\s*-\s*1\s*\]\s*\)?\s*;?\s*\/\/\s*confirm/i);
    });
});
