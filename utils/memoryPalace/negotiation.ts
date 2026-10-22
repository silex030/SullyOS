/**
 * Memory Palace — 记忆协商（P3）统一入口
 *
 * ┌─ 给其它代理 / 调用方的接线清单（都是纯函数，无额外 LLM 调用）─────────────┐
 * │ 开关：isMemoryNegotiationEnabled()                                        │
 * │   读 os_memory_palace_config.featureFlags.epistemicState（既有预留位，     │
 * │   旧备份缺该字段时按关闭处理）；本地调试可用 mp_negotiation_dev = 'on'/'off'│
 * │                                                                          │
 * │ 提取（extraction.ts，已接）：                                              │
 * │   includeMessageIdsInExtraction = true  → 对话行首带 [#消息ID]             │
 * │   pendingCandidatesForPrompt(charId)    → 生成 C0..Cn 区块                │
 * │   planNegotiationBatch({...})           → 决策 / 候选 / 待补写节点         │
 * │   persistNegotiationPlan(plan)          → 落账本（唯一副作用）             │
 * │                                                                          │
 * │ 管线（pipeline.ts，已接）：                                                │
 * │   commitPromotedMemories(plan, [{candidateId, memoryId}])                 │
 * │                                                                          │
 * │ 清空（wipe.ts 负责人调用即可，本代理不改 wipe）：                          │
 * │   clearNegotiationLedger(charId) / clearAllNegotiationLedgers()           │
 * │                                                                          │
 * │ 长期事实闸门（消化 / 门牌候选）：                                          │
 * │   isNodeLongTermEligible(node) / isNodeShortTerm(node)                    │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

import type { MemoryNode } from './types';
import type {
    NegotiationLedger,
    NegotiationMeta,
    NegotiationSupersession,
    NegotiatedMemoryNode,
} from './negotiationTypes';
import {
    NEGOTIATION_HISTORY_CAP,
    NEGOTIATION_VERSION,
} from './negotiationTypes';
import { readNegotiationMeta } from './negotiationEvidence';
import { countPendingCandidates, loadNegotiationLedger, pendingCandidates } from './negotiationLedger';

/**
 * 开关**只有一把尺**：`utils/memoryNegotiation.ts` 的 `getMemoryNegotiationGate()`
 * （dev override > 正式 config `os_memory_palace_config.featureFlags.epistemicState`
 *  > 缺字段才兼容的旧 localkey > 默认关；config 读坏按关且不回落旧 key）。
 *
 * 这里以前自己实现了一遍「dev > 旧 localkey > 正式 config」，顺序与前台/设置页相反：
 * 设置页关掉 + 残留旧 key 时，前台关、后台仍开，而设置页文案说的是同一个字段。
 * 现在后台直接复用前台那一个实现，不再各读各的。
 *
 * 导入方向安全：`utils/memoryNegotiation.ts` 是零 import 的纯叶子，不 import
 * `memoryPalace/**`，所以这条依赖不会成环（`memoryNegotiation.wiring.test.ts` 钉住了）。
 */
import { getMemoryNegotiationGate } from '../../utils/memoryNegotiation';

export function isMemoryNegotiationEnabled(): boolean {
    return getMemoryNegotiationGate().enabled;
}

/**
 * 诊断用：为什么现在没开（回给设置页 / 日志，不含任何用户内容）。
 *
 * 对外只保留三态来源：`dev_override` / `feature_flag` / `default_off`。
 * - 正式 config 读到值（开或关）、旧 localkey 命中 → `feature_flag`（同一个字段口径）；
 * - config 读坏 → `default_off`（读不出来不许说成「开关开着」，也不许回落旧 key）；
 * - 默认关 → `default_off`。
 */
export function describeNegotiationGate(): { enabled: boolean; source: 'dev_override' | 'feature_flag' | 'default_off' } {
    const gate = getMemoryNegotiationGate();
    if (gate.source === 'dev_override') {
        return { enabled: gate.enabled, source: 'dev_override' };
    }
    if (gate.source === 'config' || gate.source === 'legacy_key') {
        return { enabled: gate.enabled, source: 'feature_flag' };
    }
    return { enabled: false, source: 'default_off' };
}

/**
 * 用户在 UI 里手动改写 / 纠正一条记忆时调用（人工事实来源）。
 *
 * 行为契约：
 * - **不抹掉历史**：原 content 由调用方决定是否追加说明，这里只追加一条 supersession 记录；
 * - 旧数据没有 negotiation 元数据时补一个 `evidence: 'unrecorded'` 的壳——不伪造当年的证据等级，
 *   只记录「这次是用户亲手改的」，并把它标成可用于长期事实。
 */
export function recordUserCorrection(
    node: MemoryNode,
    input: {
        note: string;
        sourceMessageIds?: number[];
        at?: number;
        byMemoryId?: string;
        byClaimId?: string;
    },
): MemoryNode {
    const at = input.at ?? Date.now();
    const note = (input.note || '').trim().slice(0, 200);
    if (!note) return node;

    const target = node as NegotiatedMemoryNode;
    const existing = readNegotiationMeta(node);
    const meta: NegotiationMeta = existing
        ? { ...existing }
        : {
            version: NEGOTIATION_VERSION,
            claimId: `legacy_${node.id}`,
            evidence: 'unrecorded',
            subject: { kind: 'unknown' },
            durability: 'unknown',
            topicId: 'unscoped',
            sourceMessageIds: [],
            assertedAt: node.createdAt,
            batchId: 'manual_correction',
            longTermEligible: true,
        };

    const entry: NegotiationSupersession = {
        at,
        note,
        sourceMessageIds: (input.sourceMessageIds || []).filter(id => Number.isFinite(id)),
        ...(input.byMemoryId ? { byMemoryId: input.byMemoryId } : {}),
        ...(input.byClaimId ? { byClaimId: input.byClaimId } : {}),
    };
    meta.supersessions = [...(meta.supersessions || []), entry].slice(-NEGOTIATION_HISTORY_CAP);
    // 用户亲手确认过的事实可以进长期事实；这是「人工事实来源」，不是模型推测。
    meta.longTermEligible = true;
    target.negotiation = meta;
    return node;
}

/**
 * 提取链路里的「用户纠正」（模型输出的 correct: O0 + note）。
 *
 * 与 recordUserCorrection 的区别：这里**不**改 longTermEligible——纠正本身是用户说的，
 * 但这条记忆原来的证据等级是什么就还是什么。只追加一条带来源消息的失效关系，
 * 原 content 由调用方保留（既有实现是末尾追加，不抹掉历史）。
 */
export function recordExtractionCorrection(
    node: MemoryNode,
    input: { note: string; sourceMessageIds?: number[]; at?: number; byMemoryId?: string; byClaimId?: string },
): MemoryNode {
    const at = input.at ?? Date.now();
    const note = (input.note || '').trim().slice(0, 200);
    if (!note) return node;

    const target = node as NegotiatedMemoryNode;
    const existing = readNegotiationMeta(node);
    const meta: NegotiationMeta = existing
        ? { ...existing }
        : {
            version: NEGOTIATION_VERSION,
            claimId: `legacy_${node.id}`,
            evidence: 'unrecorded',
            subject: { kind: 'unknown' },
            durability: 'unknown',
            topicId: 'unscoped',
            sourceMessageIds: [],
            assertedAt: node.createdAt,
            batchId: 'extraction_correction',
            // 旧节点原本就没有证据等级：不因为「被纠正过」就升格成长期事实。
            longTermEligible: false,
        };

    meta.supersessions = [
        ...(meta.supersessions || []),
        {
            at,
            note,
            sourceMessageIds: (input.sourceMessageIds || []).filter(id => Number.isFinite(id)),
            ...(input.byMemoryId ? { byMemoryId: input.byMemoryId } : {}),
            ...(input.byClaimId ? { byClaimId: input.byClaimId } : {}),
        },
    ].slice(-NEGOTIATION_HISTORY_CAP);
    target.negotiation = meta;
    return node;
}

/** 供 UI / 诊断查看：这个角色还有哪些未决说法（不含对话原文以外的敏感内容）。 */
export function describeNegotiationState(charId: string): {
    enabled: boolean;
    pending: number;
    candidates: { id: string; topic?: string; claim: string; evidence: string; sourceMessageIds: number[] }[];
} {
    const ledger: NegotiationLedger = loadNegotiationLedger(charId);
    return {
        enabled: isMemoryNegotiationEnabled(),
        pending: countPendingCandidates(charId),
        candidates: pendingCandidates(ledger).map(candidate => ({
            id: candidate.id,
            ...(candidate.topicLabel ? { topic: candidate.topicLabel } : {}),
            claim: candidate.claim,
            evidence: candidate.evidence,
            sourceMessageIds: candidate.sourceMessageIds,
        })),
    };
}

/** 给提取提示词用：当前未决候选（已按时间排序，最近的在最后）。 */
export function pendingCandidatesForPrompt(charId: string) {
    return pendingCandidates(loadNegotiationLedger(charId));
}

export { planNegotiationBatch, persistNegotiationPlan, commitPromotedMemories } from './negotiationPlan';
export { clearNegotiationLedger, clearAllNegotiationLedgers } from './negotiationLedger';
export { isNodeLongTermEligible, isNodeShortTerm, readNegotiationMeta, claimIdFor } from './negotiationEvidence';
export type {
    NegotiationCandidate,
    NegotiationLedger,
    NegotiationMeta,
    NegotiationDecision,
    NegotiatedMemoryNode,
} from './negotiationTypes';
