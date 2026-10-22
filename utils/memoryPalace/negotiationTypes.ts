/**
 * Memory Palace — 记忆协商（P3）独立类型扩展
 *
 * 这里放的是「自然记忆协商」需要的全部类型，**不改全局 types.ts**：
 * MemoryNode 通过交叉类型拿到一个可选 negotiation 字段（见 NegotiatedMemoryNode），
 * IndexedDB 是 schemaless 的，旧数据没有该字段时可以安全读取。
 *
 * 术语分层（与 P3 任务 M1–M4 一一对应）：
 * - 证据等级 evidence：user_explicit（用户明确说过） / character_inferred（角色推测）
 *   / ambiguous（否定、引用、假设、反问、转述等不可当作事实） / unrecorded（旧数据或模型没给）
 * - 主体范围 subject：这条说法是「关于谁的」。只有主体范围匹配的明确来源才允许自动落库。
 * - 时间范围 timeRange + 持久性 durability：短期状态（今天累了）不得晋升成长期偏好。
 * - 议题 topic：候选与后续澄清按消息 ID + 议题双重绑定，多议题/指代不清保持未决。
 *
 * 所有「语义判断」都由现有提取模型在既有的那次调用里输出（零额外 LLM 调用），
 * 这里只做**校验、绑定、状态机**——不解析中文关键词去猜否定/引用。
 */

import type { MemoryNode, MemoryRoom } from './types';

/** 账本结构版本。字段变化时递增；旧版本按缺省值兼容，不臆造证据。 */
export const NEGOTIATION_VERSION = 1;

/** 账本 / 候选 / 决议的硬上限（localStorage 体积可控） */
export const NEGOTIATION_PENDING_CAP = 40;
export const NEGOTIATION_RESOLUTION_LOG_CAP = 60;
export const NEGOTIATION_HISTORY_CAP = 12;
export const NEGOTIATION_DRAFT_CONTENT_MAX_CHARS = 400;
export const NEGOTIATION_CLAIM_MAX_CHARS = 200;

/**
 * 证据等级。注意：这是**模型自己标注的语义标签**映射来的，不是我们就文本猜的。
 * - user_explicit：用户在第一人称明确陈述（模型给出 explicit/stated/confirmed 一类标签）
 * - character_inferred：角色/模型的推测（inferred/assumed/guess）
 * - ambiguous：否定、引用、转述他人、假设、反问、玩笑、非当前时间（negated/quoted/hypothetical/unclear/not_current）
 * - unrecorded：没有该字段（旧提示词 / 用户自定义模板 / 旧备份数据）
 */
export type EvidenceLevel = 'user_explicit' | 'character_inferred' | 'ambiguous' | 'unrecorded';

/** 这条说法能维持多久。short_term 永远不进长期事实与门牌。 */
export type Durability = 'short_term' | 'long_term' | 'unknown';

/** 主体范围。relationship / unknown 一律不自动落成事实。 */
export type SubjectKind = 'user' | 'character' | 'third_party' | 'relationship' | 'unknown';

export interface NegotiationSubject {
    kind: SubjectKind;
    /** 主体专名（仅在模型明确给出时记录；不推断别名） */
    ref?: string;
}

export type TimeRangeKind = 'point' | 'day' | 'range' | 'recurring' | 'unknown';

export interface NegotiationTimeRange {
    kind: TimeRangeKind;
    /** epoch ms；解析失败时缺省 */
    fromMs?: number;
    toMs?: number;
    /** 模型给的原始表述（仅用于审计展示，不参与判断） */
    label?: string;
}

/** 一条候选后续被处理（澄清 / 拒答 / 议题不符）的尝试记录 */
export interface NegotiationAttempt {
    at: number;
    messageIds: number[];
    outcome: 'unclear' | 'topic_mismatch' | 'subject_mismatch' | 'not_explicit' | 'no_new_evidence';
}

/** 候选状态机：pending → clarified | rejected | expired | superseded */
export type CandidateState = 'pending' | 'clarified' | 'rejected' | 'expired' | 'superseded';

/**
 * 候选的「如果被确认，应该写成什么」草稿。
 * 确认后才物化成 MemoryNode；未确认前**绝不入记忆库**（否则召回就会把它当事实）。
 */
export interface NegotiationDraft {
    content: string;
    room: MemoryRoom;
    importance: number;
    mood: string;
    valence?: number;
    arousal?: number;
    tags: string[];
    entities?: MemoryNode['entities'];
    createdAt: number;
}

export interface NegotiationCandidate {
    /** 确定性 ID：同一角色 + 同一议题 + 同一主体 + 同一说法 → 同一 ID（重放幂等） */
    id: string;
    charId: string;
    /** 规范化后的说法（来自模型输出的 content，截断） */
    claim: string;
    subject: NegotiationSubject;
    topicId: string;
    topicLabel?: string;
    evidence: EvidenceLevel;
    durability: Durability;
    timeRange?: NegotiationTimeRange;
    /** 断言这条说法的消息 ID（模型引用对话行首 [#id]，已校验必须是本批真实消息） */
    sourceMessageIds: number[];
    state: CandidateState;
    createdAt: number;
    updatedAt: number;
    attempts: NegotiationAttempt[];
    /** 由哪次澄清解决的（消息 ID 与时间）；只有模型显式 resolve 才会写入 */
    resolution?: {
        at: number;
        messageIds: number[];
        via: 'model_resolution' | 'user_manual';
        note?: string;
    };
    /** 确认后真正落库的记忆节点 ID（确定性 ID，重放不重复） */
    appliedMemoryId?: string;
    draft: NegotiationDraft;
    /** 取代了哪些旧说法（claimId / memoryId），保留关系不抹历史 */
    supersedes?: string[];
}

/** 一次决议的可回看记录（只记 ID 与结果，不存对话原文） */
export interface NegotiationResolutionLog {
    at: number;
    candidateId: string;
    outcome: 'clarified' | 'rejected' | 'unclear' | 'rejected_by_policy';
    reason?: string;
    messageIds: number[];
}

export interface NegotiationLedger {
    version: number;
    charId: string;
    updatedAt: number;
    candidates: NegotiationCandidate[];
    resolutions: NegotiationResolutionLog[];
}

/** 挂在 MemoryNode 上的协商元数据（旧节点没有 = 未记录证据） */
export interface NegotiationMeta {
    version: number;
    claimId: string;
    evidence: EvidenceLevel;
    subject: NegotiationSubject;
    durability: Durability;
    timeRange?: NegotiationTimeRange;
    topicId: string;
    topicLabel?: string;
    /** 断言来源消息 ID（用户明确说法必须非空） */
    sourceMessageIds: number[];
    /** 后来被哪条消息确认（候选被澄清后晋级为事实时才有） */
    confirmedByMessageIds?: number[];
    assertedAt: number;
    batchId: string;
    /** 是否允许进入长期事实（门牌 / 长期画像） */
    longTermEligible: boolean;
    /** 这条事实取代了哪些旧说法（claimId / memoryId） */
    supersedes?: string[];
    /** 后续被纠正 / 失效的关系，追加不覆盖原内容 */
    supersessions?: NegotiationSupersession[];
    /** 从候选晋级而来时的候选 ID */
    fromCandidateId?: string;
}

export interface NegotiationSupersession {
    at: number;
    note: string;
    sourceMessageIds: number[];
    /** 取代它的新节点 ID（若当轮物化了新节点） */
    byMemoryId?: string;
    byClaimId?: string;
}

/** MemoryNode 的可选扩展视图——不修改全局 types.ts */
export type NegotiatedMemoryNode = MemoryNode & { negotiation?: NegotiationMeta };

/** 解析阶段需要的最小上下文 */
export interface NegotiationParseContext {
    charId: string;
    charName: string;
    userName: string;
    /** 本批真实消息 ID（模型引用的 [#id] 必须落在这个集合里） */
    allowedMessageIds: Set<number>;
    /** 本批消息 ID → 时间戳（用于校验时间范围是否属于「当前」） */
    messageTimestamps?: Map<number, number>;
    batchId: string;
    now: number;
}

/** 单条提取结果的处理结论 */
export interface NegotiationDecision {
    memoryId: string;
    claimId: string;
    /** false = 不落库，转为未决候选 */
    apply: boolean;
    reason:
        | 'explicit_user_fact'
        | 'explicit_character_fact'
        | 'inferred_about_character'
        | 'ambiguous_not_a_fact'
        | 'inferred_about_other'
        | 'unscoped_subject'
        | 'missing_provenance'
        | 'legacy_unrecorded';
    evidence: EvidenceLevel;
}

export type CandidateResolutionOutcome =
    | 'clarified'
    | 'rejected'
    | 'unclear'
    | 'topic_mismatch'
    | 'subject_mismatch'
    | 'not_explicit'
    | 'no_new_evidence'
    | 'unknown_candidate';
