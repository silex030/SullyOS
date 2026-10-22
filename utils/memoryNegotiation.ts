/**
 * memoryNegotiation —— P3「自然记忆协商」的前台策略叶子（纯函数，零网络、零额外 LLM 调用）。
 *
 * 两件事：
 * 1. `buildMemoryNegotiationBlock()`：一段固定的协商纪律，进稳定前缀（不是每轮生成）。
 *    它只约束「怎么说」，**不新增任何长期记忆写入指令**（没有 [[MEMORY:...]] 之类的捷径，
 *    也没有前置分析请求）。写不写、写什么，仍由既有记忆管线按正常对话判断。
 * 2. `resolveClarification()`：把「上一轮角色的疑问」与「用户这一句回答」按消息 id + 议题
 *    绑定起来。证据不足一律保持未决 —— 多议题、引用旧话、隔了几条、含糊应答都不算确认。
 *
 * 开关：默认关闭（总体计划 P6：记忆协商独立开关、默认关）。正式开关是记忆宫殿的
 * `os_memory_palace_config.featureFlags.epistemicState`，与后台数据闭环同一个值；
 * 本机调试值（`mp_negotiation_dev` / 收集期的 `sullyos.memoryNegotiation.v1`）仍兼容，
 * 但设置页明确关闭优先，避免残留调试值把功能又拉起来。本模块不写记忆、不改角色数据。
 */

export type MemoryEvidenceLevel = 'user_stated' | 'char_guess' | 'undecided';
export type MemoryScope = 'moment' | 'ongoing' | 'durable';

export interface MemoryNegotiationCandidate {
    id: string;
    charId: string;
    /** 'user' / 'char' / 具体他人名字——协商只对主体明确的候选生效。 */
    subject: string;
    /** 议题关键词（用于把回答绑回具体议题，避免「对」被当万能被确认）。 */
    topic: string;
    evidence: MemoryEvidenceLevel;
    scope: MemoryScope;
    /** 触发这条候选的消息 id。 */
    sourceMessageId?: number;
    /** 角色发出澄清问题的那条消息 id；没有发问过的候选不参与解析。 */
    askedAtMessageId?: number;
    createdAt: number;
}

export type ClarificationOutcome = 'confirmed' | 'denied' | 'declined' | 'still_pending' | 'new_topic';

export type ClarificationReason =
    | 'adjacent-affirmation'
    | 'adjacent-denial'
    | 'refusal'
    | 'weak-affirmation'
    | 'non-adjacent'
    | 'not-user-reply'
    | 'ambiguous-multi-topic'
    | 'topic-mismatch'
    | 'topic-changed'
    | 'no-pending-question';

export interface ClarificationDecision {
    outcome: ClarificationOutcome;
    candidateId: string | null;
    reason: ClarificationReason;
}

export interface ResolveClarificationInput {
    candidates: MemoryNegotiationCandidate[];
    reply: { messageId: number; content: string; role?: string };
    /** 只处理这个角色名下的候选（多角色同屏时不串台）。 */
    charId?: string;
}

export const MEMORY_NEGOTIATION_STORAGE_KEY = 'sullyos.memoryNegotiation.v1';
/**
 * 调试覆盖：显式 on / off 都优先于正式开关（临时验证用，设置页会把它标出来）。
 * 与 utils/memoryPalace/negotiation.ts 读的是同一个 key，避免两层开关各说各话。
 */
export const MEMORY_NEGOTIATION_DEV_OVERRIDE_KEY = 'mp_negotiation_dev';
/** 记忆宫殿全局配置（OSContext 持久化的正式开关所在）。这里只读，写由设置页走 updateMemoryPalaceConfig。 */
export const MEMORY_NEGOTIATION_CONFIG_STORAGE_KEY = 'os_memory_palace_config';

const TRUTHY = new Set(['1', 'true', 'on', 'yes', 'enabled']);
const FALSY = new Set(['0', 'false', 'off', 'no', 'disabled']);

const readRaw = (key: string): string | null => {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    } catch {
        return null;
    }
};

const parseTriState = (raw: string | null): boolean | null => {
    if (raw == null) return null;
    const value = String(raw).trim().toLowerCase();
    if (TRUTHY.has(value)) return true;
    if (FALSY.has(value)) return false;
    return null;
};

/** 正式开关的三态：有值 / 缺字段 / 读不出来（读不出来 ≠ 缺字段）。 */
type OfficialFlagRead =
    | { kind: 'value'; value: boolean }
    | { kind: 'missing' }
    | { kind: 'unreadable' };

/**
 * 正式开关：os_memory_palace_config.featureFlags.epistemicState。
 * - 配置整体不存在，或对象里确实没有这个字段 → `missing`（旧备份，允许兼容旧 key）；
 * - JSON 坏掉、或字段存在但不是布尔 → `unreadable`（按关闭，且**不**回落到旧 key）。
 */
const readOfficialConfigFlag = (): OfficialFlagRead => {
    const raw = readRaw(MEMORY_NEGOTIATION_CONFIG_STORAGE_KEY);
    if (raw == null) return { kind: 'missing' };
    try {
        const parsed = JSON.parse(raw) as { featureFlags?: { epistemicState?: unknown } } | null;
        if (typeof parsed !== 'object' || parsed === null) return { kind: 'unreadable' };
        const flag = parsed.featureFlags?.epistemicState;
        if (flag === undefined) return { kind: 'missing' };
        return typeof flag === 'boolean' ? { kind: 'value', value: flag } : { kind: 'unreadable' };
    } catch {
        return { kind: 'unreadable' };
    }
};

export type MemoryNegotiationGateSource =
    | 'dev_override'
    | 'config'
    | 'config_unreadable'
    | 'legacy_key'
    | 'default_off';

/**
 * 当前开关状态 + 它从哪来（设置页据此如实显示，不含任何用户内容）。
 *
 * 优先级：本机调试值（显式 on/off） > 正式 config > 旧版本地调试 key > 默认关闭。
 * - 「正式 config 明确关闭」压过旧 key 的 on —— 设置页把开关关掉就必须真的关掉；
 * - 旧 key 只在正式 config **确实缺这个字段**时才生效（旧备份 / 老版本）；
 * - 正式 config 读不出来时按关闭处理，且不回落到旧 key（读不出来 ≠ 缺字段）。
 */
export function getMemoryNegotiationGate(): { enabled: boolean; source: MemoryNegotiationGateSource } {
    const dev = parseTriState(readRaw(MEMORY_NEGOTIATION_DEV_OVERRIDE_KEY));
    if (dev !== null) return { enabled: dev, source: 'dev_override' };

    const official = readOfficialConfigFlag();
    if (official.kind === 'value') return { enabled: official.value, source: 'config' };
    if (official.kind === 'unreadable') return { enabled: false, source: 'config_unreadable' };

    const legacy = parseTriState(readRaw(MEMORY_NEGOTIATION_STORAGE_KEY));
    if (legacy !== null) return { enabled: legacy, source: 'legacy_key' };

    return { enabled: false, source: 'default_off' };
}

/** 存储/正式开关：默认关闭（P6：记忆协商独立开关、默认关；旧备份缺字段同样关闭）。 */
export const isMemoryNegotiationEnabled = (): boolean => getMemoryNegotiationGate().enabled;

/**
 * 组装提示词时用的开关判定：**父层显式传值优先**（这一轮已经定过的口径，例如设置页
 * 刚改完、或调用方拿到的是本轮快照），否则回落到正式 config / 旧 key / 默认关。
 *
 * 显式 false 一律真的关（用户关掉就是关掉，不许被残留调试值重新拉起来）；
 * 显式 true 也不越过「正式 config 明确关闭」——那条压过旧 key 的规则仍在 getMemoryNegotiationGate 里。
 */
export function resolveMemoryNegotiationEnabled(explicit?: unknown): boolean {
    const gate = getMemoryNegotiationGate();
    // 「正式 config 明确关闭」压过一切：设置页关掉之后，任何陈旧快照 / 旧 key /
    // 调用方传来的 explicit=true 都不能把它重新拉起来。
    if (gate.source === 'config' && gate.enabled === false) return false;
    if (gate.source === 'config_unreadable') return false;
    if (typeof explicit === 'boolean') return explicit;
    return gate.enabled;
}

/**
 * 设置页手动切换后调用：把和「新状态」冲突的调试值删掉，别让它们压过用户刚做的选择。
 * 只删明确写了相反值的 key，与开关一致的调试值保留。
 */
export function clearConflictingMemoryNegotiationDebugOverrides(enabled: boolean): void {
    for (const key of [MEMORY_NEGOTIATION_DEV_OVERRIDE_KEY, MEMORY_NEGOTIATION_STORAGE_KEY]) {
        const value = parseTriState(readRaw(key));
        if (value === null || value === enabled) continue;
        try {
            localStorage.removeItem(key);
        } catch { /* ignore */ }
    }
}

/** 设置页「清除调试值」：两个调试 key 都删，之后完全以正式 config 为准。 */
export function clearMemoryNegotiationDebugOverrides(): void {
    for (const key of [MEMORY_NEGOTIATION_DEV_OVERRIDE_KEY, MEMORY_NEGOTIATION_STORAGE_KEY]) {
        try {
            localStorage.removeItem(key);
        } catch { /* ignore */ }
    }
}

/**
 * 固定的协商纪律文本。写成「在心里怎么判断」，不给任何输出指令，
 * 避免变成新的记忆写入通道或固定问卷。空开关由调用方控制，本函数总是返回文本。
 */
export const buildMemoryNegotiationBlock = (): string => `### 记忆协商（在正常对话里自然进行）

- 你掌握的信息分三类，别混：① 对方明确说过的 = 可以当事实用；② 你自己猜出来的 = 只能说成猜测；③ 当下短期状态 = 只是此刻（今天累 ≠ 一直累），不要升级成性格、偏好或长期结论。
- 需要确认时，就在回复里顺口问一句（「你是说……？」），一次只问一件；对方没接、岔开话题或说不想说，就停，不要追问。
- 对方纠正你时，接受并记成「之前理解错了」，保留这段经过，不要抹掉，也不要反复道歉。
- 对方引用自己以前的话，不等于确认了你的新猜测；一条回复里聊了好几件事、分不清你问的是哪件时，先别下结论。
- 不要为了记住而打断聊天，不要输出记忆指令或表格；这些判断只在心里做。
`;

const REFUSAL = /(不想说|不想聊|别问了|不聊这个|不说这个|换个话题|别提了|算了不说|不方便说)/;
const DENIAL = /(不是|并没有|没有啊|没有这回事|才不|并没|不对|弄错|搞错|错了|我没(?:有)?)/;
// 肯定词：强词可出现在句中；单独的「对」只在句末/标点前算，避免「对话」「绝对」这类误判。
const AFFIRM = /(是的|是啊|对的|对啊|对呀|没错|确实|就是|嗯对|差不多|算是)|对(?=[，,。.!！?？\s]|$)/;
const WEAK = /^(嗯+|哦+|啊+|昂+|好+|行+|ok|okay|是)[。.!！?？~～…]*$/i;

/** 去掉引用外壳与双语标签，只留用户真正说的那句。 */
const userSaid = (content: string): string => {
    let text = (content || '').trim();
    // buildMessageHistory 的引用格式：[用户引用了…，并回复了 ↓]\n<回复正文>
    const marker = text.indexOf('↓]');
    if (marker >= 0) text = text.slice(marker + 2);
    // 双语消息：只取原文侧，避免译文里出现肯定词被误判
    if (/%%BILINGUAL%%/i.test(text)) {
        const sides = text.split(/%%BILINGUAL%%/i).map(s => s.trim()).filter(Boolean);
        text = sides[0] || '';
    }
    text = text.replace(/<翻译>[\s\S]*?<原文>([\s\S]*?)<\/原文>[\s\S]*?<\/翻译>/g, '$1');
    return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
};

const mentionsTopic = (text: string, topic: string): boolean => {
    const t = (topic || '').trim();
    if (!t) return false;
    if (text.includes(t)) return true;
    // 议题是短语时，按两字片段做宽松匹配（「换工作」→「工作」）
    const grams: string[] = [];
    for (let i = 0; i + 1 < t.length; i += 1) grams.push(t.slice(i, i + 2));
    return grams.some(g => g.length === 2 && text.includes(g));
};

/**
 * 把「用户这一句」解析成对候选的确认/否认/拒答/未决。**目前没有任何生产调用方**：
 * 它只是措辞层的演示/单测对象，命中关键词也**绝不**写记忆、不改证据等级、不进账本
 * （真正的绑定在 `memoryPalace/negotiationResolve.ts`：要求显式表态 + 新消息 id + 议题一致）。
 * 保留它是为了讲清「什么算含糊」，不是让关键词变成事实来源；`memoryNegotiation.wiring.test.ts`
 * 会扫描源码钉住「没人把它接进写路径」。
 *
 * 判定顺序：id 邻接 → 拒答 → 否定 → 肯定（需唯一议题）→ 未决/新话题。
 * 重复回调幂等：同一输入永远得到同一结论。
 */
export function resolveClarification(input: ResolveClarificationInput): ClarificationDecision {
    const pending = (input.candidates || []).filter(candidate =>
        candidate.evidence === 'undecided'
        && typeof candidate.askedAtMessageId === 'number'
        && (input.charId == null || candidate.charId === input.charId),
    );
    if (pending.length === 0) {
        return { outcome: 'new_topic', candidateId: null, reason: 'no-pending-question' };
    }
    if (input.reply.role && input.reply.role !== 'user') {
        return { outcome: 'still_pending', candidateId: null, reason: 'not-user-reply' };
    }

    const text = userSaid(input.reply.content);
    if (!text) return { outcome: 'still_pending', candidateId: null, reason: 'topic-mismatch' };

    // 1) 消息 id 必须紧接角色提问那条：页面刷新、隔了几条都不算回答
    const adjacent = pending.filter(candidate => candidate.askedAtMessageId === input.reply.messageId - 1);
    if (adjacent.length === 0) {
        return { outcome: 'still_pending', candidateId: null, reason: 'non-adjacent' };
    }

    const scoped = adjacent.length === 1 ? adjacent : adjacent;
    // 2) 拒答：允许用户不谈，候选保持未决但不再追问
    if (REFUSAL.test(text)) {
        return { outcome: 'declined', candidateId: scoped.length === 1 ? scoped[0].id : null, reason: 'refusal' };
    }

    // 3) 否定优先于肯定：「不是，我最近没加班」里同时有形似的「对」，不能当确认
    if (DENIAL.test(text)) {
        const targeted = scoped.filter(candidate => mentionsTopic(text, candidate.topic));
        if (targeted.length === 1) {
            return { outcome: 'denied', candidateId: targeted[0].id, reason: 'adjacent-denial' };
        }
        if (scoped.length === 1) {
            return { outcome: 'denied', candidateId: scoped[0].id, reason: 'adjacent-denial' };
        }
        return { outcome: 'still_pending', candidateId: null, reason: 'ambiguous-multi-topic' };
    }

    // 4) 含糊应答不构成确认
    if (WEAK.test(text)) {
        return { outcome: 'still_pending', candidateId: null, reason: 'weak-affirmation' };
    }

    // 5) 明确肯定：多议题时必须由议题词唯一指向，否则保持未决
    if (AFFIRM.test(text)) {
        if (scoped.length === 1) {
            return { outcome: 'confirmed', candidateId: scoped[0].id, reason: 'adjacent-affirmation' };
        }
        const targeted = scoped.filter(candidate => mentionsTopic(text, candidate.topic));
        if (targeted.length === 1) {
            return { outcome: 'confirmed', candidateId: targeted[0].id, reason: 'adjacent-affirmation' };
        }
        return { outcome: 'still_pending', candidateId: null, reason: 'ambiguous-multi-topic' };
    }

    // 6) 既没肯定也没否定：提到议题 → 还在这个议题上但没表态；没提到 → 换话题了
    const onTopic = scoped.some(candidate => mentionsTopic(text, candidate.topic));
    return onTopic
        ? { outcome: 'still_pending', candidateId: null, reason: 'topic-mismatch' }
        : { outcome: 'new_topic', candidateId: null, reason: 'topic-changed' };
}
