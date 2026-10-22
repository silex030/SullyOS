/**
 * Memory Palace — 记忆协商 · 证据解析
 *
 * 职责边界（很重要）：
 * - 这里**不做中文语义判断**。否定、引用、假设、转述、昨日情绪等等，全部由现有提取模型
 *   在它本来就要跑的那一次调用里，用 `evidence` / `durability` / `timeRange` 字段标注；
 *   本文件只把模型给的固定英文枚举**映射**成内部等级，并做**校验**（消息 ID 是否真实、
 *   主体是否可落地、短期是否被当成长期）。
 * - 校验失败一律 fail-closed：证据不可验证 → 降级为 ambiguous → 不写事实，保留候选。
 * - 旧数据 / 模型没给字段 → unrecorded：不臆造证据，按兼容模式处理（见 decideApply）。
 */

import type { MemoryNode } from './types';
import type {
    Durability,
    EvidenceLevel,
    NegotiatedMemoryNode,
    NegotiationDecision,
    NegotiationMeta,
    NegotiationParseContext,
    NegotiationSubject,
    NegotiationTimeRange,
    SubjectKind,
    TimeRangeKind,
} from './negotiationTypes';
import {
    NEGOTIATION_CLAIM_MAX_CHARS,
    NEGOTIATION_VERSION,
} from './negotiationTypes';

// ─── 确定性 ID ─────────────────────────────────────────

/** FNV-1a 32bit → 8 位 hex。与 trace.ts 的实现一致，避免额外依赖。 */
export function fnv1aHex(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 议题标签归一：只做 NFKC + 去空白 + 小写，不做任何语义变形。 */
export function normalizeTopicLabel(label: string): string {
    return label.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
}

export function topicIdFor(charId: string, label: string | undefined): string {
    const normalized = normalizeTopicLabel(label || '');
    if (!normalized) return 'unscoped';
    return `tp_${fnv1aHex(`${charId}|${normalized}`)}`;
}

export function claimIdFor(
    charId: string,
    subject: NegotiationSubject,
    topicId: string,
    claim: string,
): string {
    const subjectKey = `${subject.kind}:${normalizeTopicLabel(subject.ref || '')}`;
    const claimKey = normalizeTopicLabel(claim).slice(0, NEGOTIATION_CLAIM_MAX_CHARS);
    return `nq_${fnv1aHex(`${charId}|${subjectKey}|${topicId}|${claimKey}`)}`;
}

/** 候选被确认后物化的节点 ID：确定性，重放同一批不会写出第二条。 */
export function promotedMemoryIdFor(claimId: string): string {
    return `mn_${claimId}`;
}

// ─── 模型枚举映射（固定词表，不是文本分析） ─────────────

const EVIDENCE_TOKENS: Record<string, EvidenceLevel> = {
    explicit: 'user_explicit',
    user_explicit: 'user_explicit',
    user_stated: 'user_explicit',
    stated: 'user_explicit',
    confirmed: 'user_explicit',
    direct: 'user_explicit',
    inferred: 'character_inferred',
    character_inferred: 'character_inferred',
    model_inferred: 'character_inferred',
    guess: 'character_inferred',
    guessed: 'character_inferred',
    assumed: 'character_inferred',
    speculation: 'character_inferred',
    ambiguous: 'ambiguous',
    negated: 'ambiguous',
    negation: 'ambiguous',
    quoted: 'ambiguous',
    quote: 'ambiguous',
    reported: 'ambiguous',
    hypothetical: 'ambiguous',
    hypothetical_scenario: 'ambiguous',
    question: 'ambiguous',
    rhetorical: 'ambiguous',
    uncertain: 'ambiguous',
    unclear: 'ambiguous',
    joke: 'ambiguous',
    sarcasm: 'ambiguous',
    not_current: 'ambiguous',
    other_time: 'ambiguous',
    third_person: 'ambiguous',
};

const DURABILITY_TOKENS: Record<string, Durability> = {
    long_term: 'long_term',
    long: 'long_term',
    stable: 'long_term',
    trait: 'long_term',
    preference: 'long_term',
    permanent: 'long_term',
    short_term: 'short_term',
    short: 'short_term',
    momentary: 'short_term',
    temporary: 'short_term',
    state: 'short_term',
    mood_today: 'short_term',
    today: 'short_term',
};

const SUBJECT_TOKENS: Record<string, SubjectKind> = {
    user: 'user',
    the_user: 'user',
    user_self: 'user',
    character: 'character',
    self: 'character',
    assistant: 'character',
    ai: 'character',
    third_party: 'third_party',
    other: 'third_party',
    someone_else: 'third_party',
    relationship: 'relationship',
    between: 'relationship',
    us: 'relationship',
    unknown: 'unknown',
    unclear: 'unknown',
};

const TIME_KIND_TOKENS: Record<string, TimeRangeKind> = {
    point: 'point',
    day: 'day',
    date: 'day',
    range: 'range',
    span: 'range',
    recurring: 'recurring',
    habit: 'recurring',
    unknown: 'unknown',
};

function asToken(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    return raw.trim().toLocaleLowerCase().replace(/[\s-]+/g, '_');
}

export function normalizeEvidence(raw: unknown): EvidenceLevel {
    const token = asToken(raw);
    if (!token) return 'unrecorded';
    return EVIDENCE_TOKENS[token] || 'ambiguous';
}

export function normalizeDurability(raw: unknown): Durability {
    const token = asToken(raw);
    if (!token) return 'unknown';
    return DURABILITY_TOKENS[token] || 'unknown';
}

/**
 * 主体：模型给 kind，可选给 ref（专名）。
 * ref 与角色名 / 用户名做**严格相等比较**（不是模糊匹配）：相等时纠正 kind，
 * 因为模型经常把「我」写成 user 但内容其实是角色自己。
 */
export function normalizeSubject(
    rawKind: unknown,
    rawRef: unknown,
    ctx: Pick<NegotiationParseContext, 'charName' | 'userName'>,
): NegotiationSubject {
    const kind = SUBJECT_TOKENS[asToken(rawKind)] || 'unknown';
    const ref = typeof rawRef === 'string' ? rawRef.trim().slice(0, 60) : '';
    const subject: NegotiationSubject = { kind };
    if (ref) subject.ref = ref;

    const compact = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
    const refKey = ref ? compact(ref) : '';
    const charKey = ctx.charName ? compact(ctx.charName) : '';
    const userKey = ctx.userName ? compact(ctx.userName) : '';

    if (refKey && charKey && refKey === charKey) subject.kind = 'character';
    else if (refKey && userKey && refKey === userKey) subject.kind = 'user';

    return subject;
}

/** 只接受 "YYYY-MM-DD" / 纯数字时间戳 / ISO；一切解析失败都回 unknown（不猜）。 */
function parseDateish(raw: unknown): number | undefined {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
    if (typeof raw !== 'string') return undefined;
    const value = raw.trim();
    if (!value) return undefined;
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(value)) {
        const [y, m, d] = value.split('-').map(part => parseInt(part, 10));
        if (y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
        return new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
}

export function normalizeTimeRange(raw: unknown): NegotiationTimeRange | undefined {
    if (!raw) return undefined;
    if (typeof raw === 'string') {
        const fromMs = parseDateish(raw);
        return fromMs ? { kind: 'day', fromMs, toMs: fromMs, label: raw.slice(0, 40) } : undefined;
    }
    if (typeof raw !== 'object') return undefined;
    const item = raw as Record<string, unknown>;
    const kind = TIME_KIND_TOKENS[asToken(item.kind)] || (item.from || item.to ? 'range' : 'unknown');
    const fromMs = parseDateish(item.from);
    const toMs = parseDateish(item.to) ?? fromMs;
    const label = typeof item.label === 'string' ? item.label.trim().slice(0, 40) : undefined;
    if (!fromMs && !toMs && !label) return undefined;
    return { kind, ...(fromMs ? { fromMs } : {}), ...(toMs ? { toMs } : {}), ...(label ? { label } : {}) };
}

/**
 * 校验模型引用的来源消息 ID：必须落在本批真实消息集合里。
 * 编造 / 越界 ID 一律丢弃并计入 invalid——不能拿来当证据。
 */
export function validateSourceMessageIds(
    raw: unknown,
    allowed: Set<number>,
): { ids: number[]; invalid: number } {
    if (!Array.isArray(raw)) return { ids: [], invalid: 0 };
    const ids: number[] = [];
    let invalid = 0;
    const seen = new Set<number>();
    for (const entry of raw) {
        const id = typeof entry === 'number' ? entry : parseInt(String(entry).replace(/^#/, ''), 10);
        if (!Number.isFinite(id)) { invalid += 1; continue; }
        if (!allowed.has(id)) { invalid += 1; continue; }
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    return { ids, invalid };
}

// ─── 从提取结果里读协商字段 ───────────────────────────

export interface ParsedNegotiationFields {
    claimId: string;
    evidence: EvidenceLevel;
    subject: NegotiationSubject;
    durability: Durability;
    timeRange?: NegotiationTimeRange;
    topicId: string;
    topicLabel?: string;
    sourceMessageIds: number[];
    invalidSourceIds: number;
    assertedAt: number;
    batchId: string;
    longTermEligible: boolean;
}

/**
 * 读取一条提取结果的协商字段。
 *
 * 字段缺失（旧模板 / 自定义模板 / 旧数据）→ evidence=unrecorded，不臆造来源。
 * 声明了证据等级但来源消息 ID 一个都验证不过 → 降级 ambiguous（fail-closed）。
 */
export function readNegotiationFields(
    item: Record<string, unknown>,
    ctx: NegotiationParseContext,
): ParsedNegotiationFields {
    const declaredEvidence = normalizeEvidence(item.evidence ?? item.evidenceLevel);
    const subject = normalizeSubject(item.subject, item.subjectRef ?? item.subjectName, ctx);
    const durability = normalizeDurability(item.scope ?? item.durability);
    const timeRange = normalizeTimeRange(item.timeRange ?? item.when);
    const rawTopic = typeof item.topic === 'string' ? item.topic.trim().slice(0, 24) : '';
    const topicLabel = rawTopic || undefined;
    const topicId = topicIdFor(ctx.charId, topicLabel);

    const content = typeof item.content === 'string' ? item.content.trim() : '';
    const { ids, invalid } = validateSourceMessageIds(
        item.sourceMsgIds ?? item.sourceMessageIds,
        ctx.allowedMessageIds,
    );

    let evidence: EvidenceLevel = declaredEvidence;
    // 明确声称「用户说过」却没有一条可验证来源 → 不可信，降级为未决候选。
    if ((evidence === 'user_explicit' || evidence === 'character_inferred') && ids.length === 0) {
        evidence = 'ambiguous';
    }

    const claimId = claimIdFor(
        ctx.charId,
        subject,
        topicId,
        content.slice(0, NEGOTIATION_CLAIM_MAX_CHARS),
    );

    return {
        claimId,
        evidence,
        subject,
        durability,
        timeRange,
        topicId,
        topicLabel,
        sourceMessageIds: ids,
        invalidSourceIds: invalid,
        assertedAt: ctx.now,
        batchId: ctx.batchId,
        longTermEligible: evidence === 'user_explicit'
            && durability === 'long_term'
            && subject.kind !== 'unknown'
            && subject.kind !== 'relationship',
    };
}

// ─── 落库决策 ──────────────────────────────────────────

/**
 * 决定一条提取结果能不能作为事实落库。
 *
 * 规则（对应 M1 + M4 的「主体范围匹配」）：
 * - ambiguous（否定/引用/假设/反问/转述/非当前）→ 永不落库，留候选
 * - character_inferred → 只有「关于角色自己」的推测可以留（作为角色的主观印象），
 *   关于用户/他人的猜测一律留候选，不能变成用户事实
 * - user_explicit → 主体必须可落地（user / character / 带专名的 third_party）；
 *   relationship / unknown / 无专名的 third_party → 留候选
 * - unrecorded（旧模板或模型没给字段）→ 兼容：按老行为落库，但标记为未记录证据、不进长期事实
 */
export function decideApply(fields: ParsedNegotiationFields): {
    apply: boolean;
    reason: NegotiationDecision['reason'];
} {
    if (fields.evidence === 'ambiguous') {
        return { apply: false, reason: 'ambiguous_not_a_fact' };
    }
    if (fields.evidence === 'unrecorded') {
        return { apply: true, reason: 'legacy_unrecorded' };
    }
    if (fields.evidence === 'character_inferred') {
        if (fields.subject.kind === 'character') {
            return { apply: true, reason: 'inferred_about_character' };
        }
        return { apply: false, reason: 'inferred_about_other' };
    }
    // user_explicit
    if (fields.subject.kind === 'user') return { apply: true, reason: 'explicit_user_fact' };
    if (fields.subject.kind === 'character') return { apply: true, reason: 'explicit_character_fact' };
    if (fields.subject.kind === 'third_party') {
        return fields.subject.ref
            ? { apply: true, reason: 'explicit_user_fact' }
            : { apply: false, reason: 'unscoped_subject' };
    }
    return { apply: false, reason: 'unscoped_subject' };
}

/** 把解析结果转成挂在 MemoryNode 上的元数据。 */
export function toNegotiationMeta(fields: ParsedNegotiationFields): NegotiationMeta {
    return {
        version: NEGOTIATION_VERSION,
        claimId: fields.claimId,
        evidence: fields.evidence,
        subject: fields.subject,
        durability: fields.durability,
        ...(fields.timeRange ? { timeRange: fields.timeRange } : {}),
        topicId: fields.topicId,
        ...(fields.topicLabel ? { topicLabel: fields.topicLabel } : {}),
        sourceMessageIds: [...fields.sourceMessageIds],
        assertedAt: fields.assertedAt,
        batchId: fields.batchId,
        longTermEligible: fields.longTermEligible,
    };
}

export function annotateMemoryNode(node: MemoryNode, meta: NegotiationMeta): MemoryNode {
    (node as NegotiatedMemoryNode).negotiation = meta;
    return node;
}

export function readNegotiationMeta(node: MemoryNode | null | undefined): NegotiationMeta | undefined {
    if (!node) return undefined;
    const meta = (node as NegotiatedMemoryNode).negotiation;
    if (!meta || typeof meta !== 'object') return undefined;
    if (Array.isArray((meta as any).sourceMessageIds) === false) return undefined;
    return meta;
}

/**
 * 是否允许进入长期事实（门牌 / 长期画像 / 消化材料）。
 * **旧数据没有元数据 → true**，保证升级后既有行为不变（备份兼容）。
 */
export function isNodeLongTermEligible(node: MemoryNode): boolean {
    const meta = readNegotiationMeta(node);
    if (!meta) return true;
    return meta.longTermEligible === true;
}

/** 短期状态的节点：只当此刻的经历，不能蒸成性格。旧数据 → false。 */
export function isNodeShortTerm(node: MemoryNode): boolean {
    const meta = readNegotiationMeta(node);
    return meta?.durability === 'short_term';
}
