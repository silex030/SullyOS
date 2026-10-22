/**
 * Memory Palace — 记忆提取 (Memory Extraction)
 *
 * 从聊天消息缓冲区提取 MemoryNode 数组，供后续向量化和 EventBox 绑定。
 * 不同重要性对应不同的记忆详细程度。
 */

import type { Message } from '../../types';
import type { MemoryEntity, MemoryNode, MemoryRoom } from './types';
import type { LightLLMConfig } from './pipeline';
import { safeFetchJson } from '../safeApi';
import { safeParseJsonArray } from './jsonUtils';
import { formatMessageForPrompt } from '../messageFormat';
import { readRecallRuntimeSnapshot } from './trace';
import { getBuiltinContent, fillIdentity } from '../promptPresetCatalog';
import { resolveTechnicalPrompt } from '../promptPresetRuntime';
import type { NegotiationPlan } from './negotiationPlan';
import { planNegotiationBatch, persistNegotiationPlan } from './negotiationPlan';
import { isMemoryNegotiationEnabled, pendingCandidatesForPrompt } from './negotiation';
import { buildNegotiationPromptSuffix, NEGOTIATION_PROMPT_CANDIDATE_LIMIT } from './negotiationPrompt';
import { validateSourceMessageIds } from './negotiationEvidence';
// 内置默认（与提示词目录同源；测试经快照对拍防漂移）
const MEMORY_EXTRACTION_RULES_BUILTIN = getBuiltinContent('memory.extractionRules');
const MEMORY_EXTRACTION_ENTITY_RULE_BUILTIN = getBuiltinContent('memory.extractionEntityRule');
const MEMORY_EXTRACTION_MAIN_BUILTIN = getBuiltinContent('memory.extractionMain');

function generateId(): string {
    return `mn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── 共用的 prompt 规则部分 ──────────────────────────
//
// 设计决策（2026-04）：palace extraction 的提示词**完全固定**，不会被用户
// 在"记忆归档设置"里选的模板影响。那里的模板只作用于手动归档路径
// （Chat.tsx handleFullArchive / Character.tsx handleBatchSummarize /
// handleForceArchiveDate）。
// 理由：palace 产出的 memory.content 要参与向量检索，风格化（"末尾加喵"之类）
// 会让 embedding 语义轻微漂移。保持 palace 内置风格稳定，手动归档路径提供
// 风格化的自由度——职责分离。

async function buildRulesBlock(charName: string, userLabel: string, includeEntities: boolean): Promise<string> {
    // 实体规则碎片走提示词目录（memory.extractionEntityRule，技术模板：停用回退默认）。
    const entityFrag = await resolveTechnicalPrompt('memory.extractionEntityRule', MEMORY_EXTRACTION_ENTITY_RULE_BUILTIN);
    const entityRule = includeEntities
        ? '.\n   ' + entityFrag
        : '';
    // 规则主体走提示词目录（memory.extractionRules）：技术模板，停用回退默认。
    const rules = await resolveTechnicalPrompt('memory.extractionRules', MEMORY_EXTRACTION_RULES_BUILTIN);
    return fillIdentity(rules, charName, userLabel).replace(/__ENTITY_RULE__/g, () => entityRule);
}

function buildConversationText(
    messages: Message[], charName: string, userLabel: string, includeMessageIds = false,
): string {
    // 每行带 [YYYY-MM-DD HH:MM] 时间戳前缀。
    // 没有这个 LLM 完全看不到日期，多日 batch 提取出来的记忆全部会被压到一个时间点
    // （见 parseMemoryNodesFromBuffer 的 midTime 兜底），跨日时间线就乱了。
    // 协商开关打开时再补 [#消息ID]：模型输出的 sourceMsgIds 必须能校验回真实消息，
    // 否则「证据来源」就是模型编的（见 negotiationEvidence.validateSourceMessageIds）。
    const pad2 = (n: number) => String(n).padStart(2, '0');
    return messages
        .map(m => {
            const body = formatMessageForPrompt(m, charName, userLabel).slice(0, 600);
            const idTag = includeMessageIds && Number.isFinite(m.id) ? `[#${m.id}] ` : '';
            const ts = m.timestamp;
            if (!ts || ts <= 0) return `${idTag}${body}`;
            const d = new Date(ts);
            const stamp = `[${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}]`;
            return `${idTag}${stamp} ${body}`;
        })
        .join('\n');
}

const VALID_ROOMS: MemoryRoom[] = [
    'living_room', 'bedroom', 'study', 'user_room',
    'self_room', 'attic', 'windowsill',
];

/** 从消息缓冲区直接解析记忆节点（不依赖 TopicBox） */
function parseMemoryNodesFromBuffer(
    parsed: any[], charId: string, messages: Message[], _batchLabel: string, includeEntities: boolean,
): MemoryNode[] {
    if (parsed.length === 0) return [];

    const msgTimestamps = messages.map(m => m.timestamp).filter(t => t > 0);
    const firstTs = msgTimestamps[0] ?? Date.now();
    const lastTs = msgTimestamps[msgTimestamps.length - 1] ?? firstTs;
    const midTime = Math.round((firstTs + lastTs) / 2);

    // 允许 LLM 写出的 date 略微越界（夜聊跨零点等），但要挡住完全不合理的（写错年月）
    const dayMs = 24 * 60 * 60 * 1000;
    const minTs = firstTs - dayMs;
    const maxTs = lastTs + dayMs;

    /** 解析 LLM 写的 date 字段 → 该日 12:00 本地时间。失败 / 越界则回到 midTime。 */
    const resolveCreatedAt = (raw: unknown): number => {
        if (typeof raw !== 'string') return midTime;
        const s = raw.trim();
        if (!s) return midTime;
        // 接受 "YYYY-MM-DD" / "YYYY/M/D" / "YYYY年M月D日" 等
        const norm = s.replace(/[年\/]/g, '-').replace(/[月日]/g, '');
        const parts = norm.split('-').map(p => parseInt(p, 10));
        if (parts.length < 3 || parts.some(n => Number.isNaN(n))) return midTime;
        const [y, m, d] = parts;
        if (y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return midTime;
        // 用消息时间戳的本地时区表征"该日中午"——避免 UTC 解析跨日漂移
        const dt = new Date(y, m - 1, d, 12, 0, 0, 0);
        const ts = dt.getTime();
        if (Number.isNaN(ts)) return midTime;
        if (ts < minTs || ts > maxTs) return midTime;
        return ts;
    };

    const parseEntities = (value: unknown): MemoryEntity[] => {
        if (!Array.isArray(value)) return [];
        const validTypes = new Set<NonNullable<MemoryEntity['type']>>([
            'person', 'place', 'organization', 'project', 'product', 'account', 'domain', 'other',
        ]);
        const seen = new Set<string>();
        const result: MemoryEntity[] = [];
        for (const raw of value) {
            if (!raw || typeof raw !== 'object') continue;
            const item = raw as Record<string, unknown>;
            const name = typeof item.name === 'string' ? item.name.trim().slice(0, 80) : '';
            const key = name.normalize('NFKC').toLocaleLowerCase();
            if (name.length < 2 || !key || seen.has(key)) continue;
            seen.add(key);
            const entity: MemoryEntity = { name };
            if (validTypes.has(item.type as NonNullable<MemoryEntity['type']>)) {
                entity.type = item.type as NonNullable<MemoryEntity['type']>;
            }
            result.push(entity);
            if (result.length >= 12) break;
        }
        return result;
    };

    return parsed
        .filter(item => item.content && item.room)
        .map((item): MemoryNode => {
            const createdAt = resolveCreatedAt(item.date);
            const pinDays = parseInt(item.pinDays, 10);
            // 置顶 deadline 跟着 per-memory createdAt 算，否则"今天感冒 pinDays 5"
            // 会从 batch 中点起算，跨日 batch 里就直接少算/多算。
            const pinnedUntil = (pinDays > 0 && pinDays <= 30)
                ? createdAt + pinDays * 24 * 60 * 60 * 1000
                : null;
            // (v, a) 非必需：LLM 没给就不写，下游 getEmotionVA 查表兜底
            const v = typeof item.valence === 'number' ? clampVA(item.valence) : undefined;
            const a = typeof item.arousal === 'number' ? clampVA(item.arousal) : undefined;
            const memory: MemoryNode = {
                id: generateId(),
                charId,
                content: item.content,
                room: (VALID_ROOMS.includes(item.room as MemoryRoom) ? item.room : 'living_room') as MemoryRoom,
                tags: Array.isArray(item.tags) ? item.tags : [],
                importance: Math.max(1, Math.min(10, Math.round(item.importance || 5))),
                mood: item.mood || 'neutral',
                valence: v,
                arousal: a,
                embedded: false,
                createdAt,
                lastAccessedAt: createdAt,
                accessCount: 0,
                pinnedUntil,
                eventBoxId: null,  // 由 pipeline 在 binding 阶段设置
                origin: 'extraction',
            };
            if (includeEntities) memory.entities = parseEntities(item.entities);
            return memory;
        });
}

/** 把 LLM 吐的 v/a 夹到 [-1, 1]，防止它写成 1.5 / -2 之类 */
function clampVA(x: number): number {
    if (Number.isNaN(x)) return 0;
    if (x > 1) return 1;
    if (x < -1) return -1;
    return x;
}

// ─── EventBox 绑定相关 prompt + 解析 helper（buffer / migration 共用） ──

/**
 * 构造"已有记忆"的 prompt 区块，带 O-编号供 LLM 引用。
 */
export function buildRelatedMemoriesBlock(relatedMemories: RelatedMemoryRef[]): string {
    if (relatedMemories.length === 0) return '';
    return `\n## 已有记忆（如果新记忆与某条旧记忆描述的是同一件事或直接相关，请在 relatedTo 中标注编号，并给出 eventName / eventTags 用于建/合并事件盒）\n${
        relatedMemories.map((r, i) => `O${i}. [${r.room}] ${r.content}`).join('\n')
    }\n`;
}

/**
 * 构造"事件关联 + 事件盒命名"的规则文本，追加到 buildRulesBlock 之后。
 */
export function buildRelatedToRule(): string {
    return `\n9. **事件盒关联**（relatedTo / sameAs + eventName + eventTags）：
   **与旧记忆同事件** → 在 relatedTo 中写对应 O 编号（如 ["O0", "O3"]）。
   **与本次输出的其它新记忆同事件** → 在 sameAs 中写它们在本次 JSON 数组里的**0 基索引**（只能指向前面已输出的项，例如写 ["0"] 表示和数组第一条是同一件事）。
   注意：只标注真正同一件事的（同一事件的后续/结局/复现/直接因果），不要勉强（仅"主题相似"不算）。
   只要 relatedTo 或 sameAs 任一非空，必须同时写：
   - eventName：这件事的名字（5-12 字，名词短语，如"买衣服的话题"、"和领导的冲突"）
   - eventTags：3-6 个详细搜索 tag（具体名词、人物、地点、动作，便于日后召回）
   都没关联就不写 relatedTo / sameAs / eventName / eventTags 四个字段。
10. **不重复绑定**：一条新记忆和多条已有/新记忆都相关时，把编号都写全；eventName / eventTags 只写一份（描述这件事整体）。
11. **纠正旧记忆**（corrects，可选，独立于上面的记忆条目，作为 JSON 数组的额外项）：
   仅在对话中**用户明确指出某条已有记忆记错了 / 已过时 / 不准确**时使用。识别信号：用户用"不对/不是/我说错了/已经不是了/搞错了/那是XX不是YY"之类的反驳句式，明确指向你刚才的某个说法。
   如果命中，在输出的 JSON 数组**末尾**追加一项，格式为：
   {"correct": "O编号", "note": "新版本的事实（不带语气，简短陈述句）"}
   note 写"实情是什么"，不是"为什么错"。例：用户纠正"我已经搬家了，不在朝阳"→ note: "已经搬家，不再住朝阳"。
   反例（**不要**用 corrects）：
   - 仅事件后续 / 状态发展 → 用 relatedTo
   - 仅追加细节 / 补充信息 → 不要标
   - 你自己想到的歧义 / 自我修正 → 不要标
   一条对话最多 corrects 1-2 项，不要乱用。`;
}

/**
 * 输出格式中的字段示例（如果有 relatedMemories 才注入）。
 */
export function buildRelatedToFormatHint(): string {
    return `,
    "relatedTo": ["O0"],
    "sameAs": ["0"],
    "eventName": "买衣服的话题",
    "eventTags": ["衣服", "购物", "退货", "流行款"]`;
}

/**
 * 从 LLM 输出（已解析 JSON）和提取出的 memories 中，
 * 解析出：
 *  - crossTimeLinks（newMemoryId → existingMemoryId）
 *  - eventBoxHints（newMemoryId → eventName / eventTags）
 *
 * 注意：parsed 数组顺序应该与 memories 顺序对齐（同源 LLM 输出）。
 */
export function parseRelatedToAndHints(
    parsed: any[],
    memories: MemoryNode[],
    relatedMemories: RelatedMemoryRef[],
): { crossTimeLinks: { newMemoryId: string; existingMemoryId: string }[]; eventBoxHints: EventBoxHint[] } {
    const crossTimeLinks: { newMemoryId: string; existingMemoryId: string }[] = [];
    const eventBoxHints: EventBoxHint[] = [];

    if (memories.length === 0) {
        return { crossTimeLinks, eventBoxHints };
    }

    // parsed 包含的不只是 memory（还可能有 unpin 指令等），按 memory 顺序对齐：
    // memories 是 parsed.filter(item => item.content && item.room) 的结果，
    // 用同样的过滤遍历 parsed，按位次匹配 memories。
    let memIdx = 0;
    for (const item of parsed) {
        if (!item || !item.content || !item.room) continue;
        const mem = memories[memIdx++];
        if (!mem) break;

        let hasAnyLink = false;

        // (a) relatedTo → O 索引指向已有记忆
        if (relatedMemories.length > 0 && Array.isArray(item.relatedTo) && item.relatedTo.length > 0) {
            for (const ref of item.relatedTo) {
                const idx = parseInt(String(ref).replace(/^O/i, ''), 10);
                if (idx >= 0 && idx < relatedMemories.length) {
                    crossTimeLinks.push({
                        newMemoryId: mem.id,
                        existingMemoryId: relatedMemories[idx].id,
                    });
                    hasAnyLink = true;
                }
            }
        }

        // (b) sameAs → N 索引指向本批次之前的新记忆（靠数组 0-base index 索引）
        //     memIdx 已经 ++，当前这条在 memories 中的位置是 memIdx-1；允许引用 0..memIdx-2
        if (Array.isArray(item.sameAs) && item.sameAs.length > 0) {
            const currentPos = memIdx - 1;
            for (const ref of item.sameAs) {
                const idx = parseInt(String(ref).replace(/^N/i, ''), 10);
                if (idx >= 0 && idx < currentPos && memories[idx]) {
                    crossTimeLinks.push({
                        newMemoryId: mem.id,
                        existingMemoryId: memories[idx].id, // 此时 memories[idx] 的 id 已经生成
                    });
                    hasAnyLink = true;
                }
            }
        }

        // (c) 如果任一关联成立，收集 eventName/eventTags 作为 hints
        if (hasAnyLink) {
            const name = typeof item.eventName === 'string' ? item.eventName.trim() : '';
            const tags = Array.isArray(item.eventTags)
                ? item.eventTags.map((t: any) => String(t).trim()).filter(Boolean)
                : [];
            if (name || tags.length > 0) {
                eventBoxHints.push({
                    newMemoryId: mem.id,
                    eventName: name,
                    eventTags: tags,
                });
            }
        }
    }

    if (crossTimeLinks.length > 0) {
        console.log(`🔗 [Extraction] 发现 ${crossTimeLinks.length} 条同事件关联（含跨批次 relatedTo 与同批 sameAs），${eventBoxHints.length} 条带命名提示`);
    }
    return { crossTimeLinks, eventBoxHints };
}

// ─── 跨时间关联：传入向量检索命中的旧记忆供 LLM 关联 ───

/** 向量检索命中的已有记忆引用，用于跨时间事件关联 */
export interface RelatedMemoryRef {
    id: string;       // MemoryNode.id
    room: string;
    content: string;  // 截断的内容摘要
}

/** 当前生效的便利贴引用 */
export interface PinnedMemoryRef {
    id: string;
    content: string;
}

/**
 * EventBox 创建/合并提示。
 * 当 LLM 把新记忆 N 标记为 relatedTo 旧记忆 O 时，附带的盒名/标签提示。
 * pipeline 在 binding 时使用：若需要新建 EventBox，用此名/tags 初始化。
 */
export interface EventBoxHint {
    /** 触发该 hint 的新记忆 ID */
    newMemoryId: string;
    /** LLM 建议的事件盒名（如"买衣服"） */
    eventName: string;
    /** LLM 建议的详细 tag */
    eventTags: string[];
}

/** 缓冲区提取结果，包含跨时间关联信息 */
export interface BufferExtractionResult {
    memories: MemoryNode[];
    /** 新记忆 → 关联的已有记忆 ID 映射（用于 EventBox 绑定） */
    crossTimeLinks: { newMemoryId: string; existingMemoryId: string }[];
    /** EventBox 名/tag 提示（仅 relatedTo 非空的新记忆才有） */
    eventBoxHints: EventBoxHint[];
    /** 应提前摘除的便利贴 ID */
    unpinIds: string[];
    /** 纠正：把对应已有记忆的 content 追加一行"YYYY-MM-DD 纠正：note"，并重新向量化 */
    corrections: { targetId: string; note: string; sourceMessageIds?: number[] }[];
    /**
     * 记忆协商计划（开关打开时才有）。
     * memories 仍是**完整**列表；调用方必须按 plan.keptMemoryIds 过滤后才落库，
     * 否则「角色猜测 / 否定 / 引用」还是会被当成事实写进记忆宫殿。
     */
    negotiation?: NegotiationPlan;
}

// ─── 缓冲区提取：直接从消息提取记忆，不依赖 TopicBox ───

/**
 * 从消息缓冲区直接提取记忆节点。
 * 用于缓冲区机制：积累的聊天消息达到阈值后，一次 LLM 调用提取记忆。
 *
 * @param relatedMemories 向量检索命中的已有记忆，供 LLM 判断跨时间事件关联（搭便车，不额外调用）
 * @param pinnedMemories 当前生效的便利贴，供 LLM 判断是否应提前摘除（搭便车）
 */
export async function extractMemoriesFromBuffer(
    messages: Message[],
    charId: string,
    charName: string,
    llmConfig: LightLLMConfig,
    charContext?: string,
    userName?: string,
    relatedMemories?: RelatedMemoryRef[],
    pinnedMemories?: PinnedMemoryRef[],
): Promise<BufferExtractionResult> {
    if (messages.length === 0) return { memories: [], crossTimeLinks: [], eventBoxHints: [], unpinIds: [], corrections: [] };

    const includeEntities = readRecallRuntimeSnapshot().featureFlagsSnapshot.recallRouter;
    // 协商开关：打开后这次**同一次**调用既产出记忆也产出证据字段与澄清指令（零额外请求）。
    const negotiationEnabled = isMemoryNegotiationEnabled();
    const userLabel = userName || '用户';
    const conversationText = buildConversationText(messages, charName, userLabel, negotiationEnabled);

    const contextBlock = charContext
        ? `\n## 你的人设（供参考，帮助你理解对话中的关系和角色定位）\n${charContext}\n`
        : '';

    // 构建已有记忆引用块（带 O-编号，供 LLM 输出 relatedTo）
    const hasRelated = relatedMemories && relatedMemories.length > 0;
    const relatedBlock = hasRelated
        ? buildRelatedMemoriesBlock(relatedMemories!)
        : '';
    const relatedToRule = hasRelated ? buildRelatedToRule() : '';
    const relatedToFormat = hasRelated ? buildRelatedToFormatHint() : '';

    // 便利贴摘除判断
    const hasPinned = pinnedMemories && pinnedMemories.length > 0;
    const pinnedBlock = hasPinned
        ? `\n## 当前便利贴（如果对话内容表明某条便利贴已失效，在输出末尾用 unpin 标注）\n${
            pinnedMemories!.map((p, i) => `P${i}. ${p.content}`).join('\n')
          }\n`
        : '';

    const unpinRule = hasPinned
        ? `\n12. **便利贴摘除**（unpin，可选）：如果对话中明确提到某条便利贴描述的状态已结束（如"感冒好了""提前回来了""考试考完了"），在输出的 JSON 数组末尾加一条 {"unpin": "P0"} 来摘除它。只在对话明确提及时才摘除，不要猜测。`
        : '';

    // 记忆提取主模板走提示词目录（memory.extractionMain，技术模板：停用回退默认）；
    // 动态数据段（上下文 / 已有记忆 / 便利贴 / 规则块 / 实体行）按 token 回填。
    const mainTpl = await resolveTechnicalPrompt('memory.extractionMain', MEMORY_EXTRACTION_MAIN_BUILTIN);
    const rulesBlock = await buildRulesBlock(charName, userLabel, includeEntities);
    let systemPrompt = fillIdentity(mainTpl, charName, userLabel)
        .replace(/__CONTEXT_BLOCK__/g, () => contextBlock)
        .replace(/__RELATED_BLOCK__/g, () => relatedBlock)
        .replace(/__PINNED_BLOCK__/g, () => pinnedBlock)
        .replace(/__RULES_BLOCK__/g, () => rulesBlock)
        .replace(/__RELATED_TO_RULE__/g, () => relatedToRule)
        .replace(/__UNPIN_RULE__/g, () => unpinRule)
        .replace(/__RELATED_TO_FORMAT__/g, () => relatedToFormat)
        .replace(/__ENTITIES_LINE__/g, () => includeEntities ? '\n    "entities": [{"name": "明确出现的专名", "type": "person"}],' : '');

    // 证据字段 + 未决候选 + 澄清写法：只在开关打开时追加，模板本体不动。
    // pendingSnapshot 是「提示词实际展示的那几条」的快照：C0..Cn 的编号必须按它解析，
    // 否则本批新增候选会把窗口顶走，澄清会绑到另一个议题上。
    let pendingSnapshot: { id: string }[] = [];
    if (negotiationEnabled) {
        let pendingForPrompt: ReturnType<typeof pendingCandidatesForPrompt> = [];
        try {
            pendingForPrompt = pendingCandidatesForPrompt(charId);
        } catch { /* 账本读失败就当没有未决事项 */ }
        systemPrompt += buildNegotiationPromptSuffix(pendingForPrompt);
        pendingSnapshot = pendingForPrompt.slice(-NEGOTIATION_PROMPT_CANDIDATE_LIMIT).map(candidate => ({ id: candidate.id }));
    }

    try {
        try {
            const { captureCall } = await import('../promptCallCapture');
            captureCall('memory-extract', [{ role: 'system', content: systemPrompt }, { role: 'user', content: `对话内容：\n${conversationText}` }], { charId: charId ?? '', label: '记忆提取' });
        } catch { /* 抓取永不挡主链路 */ }
        const data = await safeFetchJson(
            `${llmConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${llmConfig.apiKey}`,
                },
                body: JSON.stringify({
                    model: llmConfig.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: `对话内容：\n${conversationText}` },
                    ],
                    temperature: 0.4,
                    // 12000 比 16000 留余量：避免 LLM 顶满 cap 导致 JSON 输出被 truncate
                    // buffer 路径 pipeline 上层 CHUNK_SIZE=250 已经在切分 → 单 call 输出可控
                    max_tokens: 12000,
                    stream: false,
                }),
            },
            2, 180_000, { appName: '记忆宫殿', purpose: '记忆提取' }
        );

        const reply = data.choices?.[0]?.message?.content || '';
        const parsed = safeParseJsonArray(reply);

        if (parsed.length === 0 && reply.trim().length > 0) {
            console.warn(`🏰 [Extraction] LLM 返回了内容但 JSON 解析为空数组，可能格式异常。原始回复前200字: ${reply.slice(0, 200)}`);
        }

        console.log(`🏰 [Extraction] 缓冲区提取完成：从 ${messages.length} 条消息中提取 ${parsed.length} 条记忆`);

        // 生成日期标签
        const firstTs = messages[0]?.timestamp;
        const lastTs = messages[messages.length - 1]?.timestamp;
        const d1 = (firstTs != null && firstTs > 0) ? new Date(firstTs) : new Date();
        const d2 = (lastTs != null && lastTs > 0) ? new Date(lastTs) : d1;
        const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
        const batchLabel = fmt(d1) === fmt(d2) ? fmt(d1) : `${fmt(d1)}-${fmt(d2)}`;

        const memories = parseMemoryNodesFromBuffer(parsed, charId, messages, batchLabel, includeEntities);

        // 解析跨时间关联（→ EventBox 绑定信号）+ eventName/eventTags 提示
        const { crossTimeLinks, eventBoxHints } = parseRelatedToAndHints(
            parsed, memories, hasRelated ? relatedMemories! : [],
        );

        // 解析便利贴摘除指令：{ "unpin": "P0" } → 真实 ID
        const unpinIds: string[] = [];
        if (hasPinned) {
            for (const item of parsed) {
                if (item.unpin && typeof item.unpin === 'string') {
                    const idx = parseInt(item.unpin.replace(/^P/i, ''), 10);
                    if (idx >= 0 && idx < pinnedMemories!.length) {
                        unpinIds.push(pinnedMemories![idx].id);
                    }
                }
            }
            if (unpinIds.length > 0) {
                console.log(`📌 [Extraction] LLM 建议摘除 ${unpinIds.length} 条便利贴`);
            }
        }

        // 解析纠正指令：{ "correct": "O0", "note": "实情是..." } → 真实 ID
        // 仅在有 relatedMemories 时才有意义（O 编号必须能解析回真节点 id）
        const corrections: { targetId: string; note: string; sourceMessageIds?: number[] }[] = [];
        const allowedMessageIds = new Set(messages.map(m => m.id).filter(id => Number.isFinite(id)));
        if (hasRelated) {
            for (const item of parsed) {
                if (!item || typeof item.correct !== 'string') continue;
                const note = typeof item.note === 'string' ? item.note.trim() : '';
                if (!note) continue;
                const idx = parseInt(item.correct.replace(/^O/i, ''), 10);
                if (idx >= 0 && idx < relatedMemories!.length) {
                    const correction: { targetId: string; note: string; sourceMessageIds?: number[] } = {
                        targetId: relatedMemories![idx].id,
                        note,
                    };
                    // 协商开启时给纠正也带上可核对的来源消息，落库时写进 supersession 记录。
                    if (negotiationEnabled) {
                        const { ids } = validateSourceMessageIds(
                            item.sourceMsgIds ?? item.sourceMessageIds,
                            allowedMessageIds,
                        );
                        if (ids.length > 0) correction.sourceMessageIds = ids;
                    }
                    corrections.push(correction);
                }
            }
            if (corrections.length > 0) {
                console.log(`✏️ [Extraction] LLM 标记 ${corrections.length} 条纠正：${corrections.map(c => c.targetId.slice(0, 12) + '…').join(', ')}`);
            }
        }

        // 证据分级 / 未决候选 / 澄清绑定：纯本地计算，复用这一次 LLM 的输出。
        let negotiation: NegotiationPlan | undefined;
        if (negotiationEnabled && parsed.length > 0) {
            try {
                const firstId = messages[0]?.id ?? 0;
                const lastId = messages[messages.length - 1]?.id ?? 0;
                negotiation = planNegotiationBatch({
                    charId,
                    charName,
                    userName: userLabel,
                    messages,
                    parsed,
                    memories,
                    batchId: `mpx_${charId}_${firstId}_${lastId}_${messages.length}`,
                    promptCandidates: pendingSnapshot,
                });
                // 账本先落盘：即使后续向量化失败，「这条只是猜测/未决」的状态也不会丢。
                persistNegotiationPlan(negotiation);
                console.log(
                    `🗣️ [Extraction] 记忆协商：允许落库 ${negotiation.summary.applied} 条，`
                    + `未决 ${negotiation.summary.deferred} 条，澄清指令 ${negotiation.summary.resolutionDirectives} 条，`
                    + `待补写 ${negotiation.summary.promoted} 条`,
                );
            } catch (e: any) {
                console.warn(`🗣️ [Extraction] 记忆协商计划失败（本次按原行为落库）: ${e?.message || e}`);
                negotiation = undefined;
            }
        }

        return { memories, crossTimeLinks, eventBoxHints, unpinIds, corrections, ...(negotiation ? { negotiation } : {}) };

    } catch (err: any) {
        console.error(`❌ [Extraction] 缓冲区提取失败 (${messages.length} 条消息):`, err.message);
        return { memories: [], crossTimeLinks: [], eventBoxHints: [], unpinIds: [], corrections: [] };
    }
}