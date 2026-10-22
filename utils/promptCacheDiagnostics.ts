/**
 * promptCacheDiagnostics —— 提示词「固定前缀」结构诊断（纯函数、零网络、零时间依赖）。
 *
 * 目的：在最终发送边界之前，把「这一段到底稳不稳」测成可比较的结构数字，而不是靠感觉：
 *  - 稳定段指纹 / 段落划分（哪一段变了）
 *  - 相邻两次请求的字节 LCP（公共前缀）、完整相同消息数、首个差异位置
 *  - 工具数组（含 schema）的规范化比较
 *  - stable 里混进动态内容（分钟级时钟、相对时间、关键词/概率世界书、depth 注入）的告警
 *
 * 边界（必须与总体计划 P1/P2 口径一致）：
 *  - 这里全部是**字节代理**指标。没有目标 tokenizer / chat template 时不报 token LCP，
 *    也不能把「字节 LCP 变长」说成「供应商缓存命中率提高」。
 *  - 只做诊断，不改任何提示词内容与用户设置的位置；世界书位置由用户决定（C9）。
 *  - 不持久化、不上报原始 prompt：告警只带代码、段落 id、行号与 ≤120 字的片段。
 */

export type CacheFindingCode =
    | 'minute-clock'
    | 'relative-time'
    | 'day-scoped'
    | 'worldbook-keyword'
    | 'worldbook-probability'
    | 'worldbook-at-depth';

export interface CacheFinding {
    code: CacheFindingCode;
    /** 逻辑段 id（'stable' / 'core' / 'appRules' / `worldbook:<id>`）。 */
    segment: string;
    /** stable 文本内的 1-based 行号（世界书类告警没有行号）。 */
    line?: number;
    /**
     * 纯结构说明：只说「哪一类模式、第几行、命中多长」，**不含任何 prompt 原文片段**。
     * 要回原文定位请用 segment + line 自己看，不靠诊断日志携带内容。
     */
    detail: string;
    /**
     * 可信度永远是 heuristic：这些是「形似动态」的启发式信号，不是确认这段每轮都会变。
     * 固定规则里也可能出现「今天/明天」「9:30」这类举例说明，属于误报，仅供排查参考。
     */
    confidence: 'heuristic';
}

export interface CacheSegmentInput {
    id: string;
    text: string;
}

export interface StableShapeReport {
    stableChars: number;
    segments: Array<{ id: string; chars: number; fingerprint: string }>;
    findings: CacheFinding[];
}

/** 世界书条目的最小结构（只读，不依赖 types.ts 的完整类型）。 */
export interface WorldbookStabilityInput {
    id?: string;
    title?: string;
    position?: number;
    depth?: number;
    key?: string[];
    constant?: boolean;
    selective?: boolean;
    probability?: number;
    useProbability?: boolean;
    disable?: boolean;
}

export interface CapturedMessage {
    role?: string;
    content?: unknown;
}

export interface CapturedChatRequest {
    messages?: CapturedMessage[];
    tools?: unknown[];
}

export interface RequestPrefixReport {
    prevMessageCount: number;
    messageCount: number;
    /** 从头开始逐条相同（角色 + 内容）的消息数。 */
    sameLeadingMessages: number;
    /** 前 N 条相同消息的 UTF-8 字节数（含每条一个分隔符）。字节代理，不是 token。 */
    messagesLcpBytes: number;
    prevMessagesBytes: number;
    messagesBytes: number;
    sameLeadingTools: number;
    toolsLcpBytes: number;
    /** 工具集合按规范化 JSON 的多重集比较（顺序/键序无关）。 */
    toolsCanonicalEqual: boolean;
    /** 第一条 system 是否逐字段相同（人设/规则前缀是否可复用）。 */
    stableSystemEqual: boolean;
    /** 首个差异位置，如 `messages[3].content` / `messages.length` / `tools[0].function.name`；完全一致为 null。 */
    firstDiffPath: string | null;
}

const encoder = new TextEncoder();

/** UTF-8 字节长度（不是 UTF-16 length）。 */
export const utf8ByteLength = (text: string): number => encoder.encode(text).length;

/**
 * 规范化 JSON：递归排序**对象键**，数组顺序原样保留。
 * enum / required / oneOf / anyOf 这类数组的顺序有语义，排序会改变含义；这里绝不碰。
 */
export function canonicalJson(value: unknown): string {
    const walk = (input: unknown): unknown => {
        if (Array.isArray(input)) return input.map(walk);
        if (input && typeof input === 'object') {
            const source = input as Record<string, unknown>;
            const out: Record<string, unknown> = {};
            for (const key of Object.keys(source).sort()) out[key] = walk(source[key]);
            return out;
        }
        return input;
    };
    try {
        return JSON.stringify(walk(value));
    } catch {
        return String(value);
    }
}

/**
 * 段落指纹：FNV-1a 32 位 + UTF-8 字节数。
 *
 * 只允许用于**本地结构诊断**（判断「这一段这一轮有没有变」）。
 * 非加密、可碰撞：不得当作安全校验、身份标识、去重键或跨设备对账依据。
 */
export function stableFingerprint(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${hash.toString(16).padStart(8, '0')}:${utf8ByteLength(text)}`;
}

/** 两个字符串的 UTF-8 字节级公共前缀长度（不切半个字符）。 */
export function utf8ByteLcp(a: string, b: string): number {
    const left = encoder.encode(a);
    const right = encoder.encode(b);
    const max = Math.min(left.length, right.length);
    let i = 0;
    while (i < max && left[i] === right[i]) i += 1;
    return i;
}

const MINUTE_CLOCK = /(?:^|[^\d:])([01]?\d|2[0-3]):([0-5]\d)(?:[^\d:]|$)/;
/**
 * 只认「带数值的相对时间」（5 分钟前 / 3 小时前）。
 * 规则正文里常有「你刚才说的」「今天就先这样」这类**说明性**用法，那不是运行时读数，
 * 一律不算命中 —— 否则每条固定规则都会被标成动态，诊断就没用了。
 */
const RELATIVE_TIME = /\d+\s*(分钟|小时|天)前/;
/**
 * 只认「带日期锚点的今天/明天/昨天」（就是今天（2026-05-20） / 明天 5月21日）与「N 天后」。
 * 裸的「今天/明天」在规则里太常见，不作为信号。
 */
const DAY_SCOPED = /(?:今天|明天|昨天)[^。\n]{0,14}(?:\d{1,2}\s*[月日号/.-])|(?:\d+|几)\s*天后/;

const lineOf = (text: string, index: number): number => {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i += 1) {
        if (text[i] === '\n') line += 1;
    }
    return line;
};

/**
 * 扫描 stable 文本里的动态内容。命中即告警，不改文本。
 *
 * 这是**启发式**扫描：固定规则里写「今天/明天」「9:30」当举例说明，也会命中，
 * 那属于误报，不代表这段真的每轮变化。所以每条告警都带 confidence: 'heuristic'，
 * 且 detail 只给行号与命中长度，不带原文片段（诊断日志可能被导出 / 粘贴）。
 */
export function inspectStableText(text: string, segment = 'stable'): CacheFinding[] {
    if (!text) return [];
    const findings: CacheFinding[] = [];
    const patterns: Array<{ code: CacheFindingCode; re: RegExp; why: string }> = [
        { code: 'minute-clock', re: MINUTE_CLOCK, why: '形似分钟级时钟；若确为实时读数会每分钟改写稳定前缀' },
        { code: 'relative-time', re: RELATIVE_TIME, why: '形似相对时间表达；若确为运行时读数，跨轮即失效' },
        { code: 'day-scoped', re: DAY_SCOPED, why: '形似日期口径表达；若确为运行时读数，跨日即变' },
    ];
    for (const { code, re, why } of patterns) {
        const match = re.exec(text);
        if (!match) continue;
        findings.push({
            code,
            segment,
            line: lineOf(text, match.index),
            detail: `第 ${lineOf(text, match.index)} 行命中 ${match[0].trim().length} 字符：${why}（启发式，需人工确认）`,
            confidence: 'heuristic',
        });
    }
    return findings;
}

const STABLE_POSITIONS = new Set([0, 1, 2, 3, 5, 6]);

/**
 * 世界书诊断（C9）：关键词激活 / 概率抽取 / depth 注入都会让「同样的配置」产生不同文本。
 * 这里只报告，不搬动用户设定的位置（不静默改用户世界书是硬约束）。
 */
export function inspectStableWorldbooks(books: WorldbookStabilityInput[] | undefined): CacheFinding[] {
    if (!Array.isArray(books) || books.length === 0) return [];
    const findings: CacheFinding[] = [];
    for (const book of books) {
        if (!book || book.disable === true) continue;
        const id = book.id || book.title || 'unknown';
        const segment = `worldbook:${id}`;
        const position = typeof book.position === 'number' ? book.position : 1;

        if (position === 4) {
            findings.push({
                code: 'worldbook-at-depth',
                segment,
                detail: `depth=${book.depth ?? 4} 注入历史内部：历史增长时落点右移，较早的历史前缀会先断（位置是用户设定，未改动）`,
                confidence: 'heuristic',
            });
            continue;
        }
        if (!STABLE_POSITIONS.has(position)) continue;

        const probability = typeof book.probability === 'number' ? book.probability : 100;
        if (book.useProbability === true || probability < 100) {
            findings.push({
                code: 'worldbook-probability',
                segment,
                detail: `按概率 ${probability}% 激活：同一输入也可能抽出不同文本，稳定段无法保证逐字节一致（启发式，仅提示）`,
                confidence: 'heuristic',
            });
            continue;
        }
        const hasKeys = Array.isArray(book.key) && book.key.length > 0;
        if (hasKeys && book.constant !== true) {
            findings.push({
                code: 'worldbook-keyword',
                segment,
                detail: `按 ${book.key!.length} 个关键词激活：命中进出会改写稳定段；位置属于用户设定，未改动（启发式，仅提示）`,
                confidence: 'heuristic',
            });
        }
    }
    return findings;
}

/** 段落级汇总：每段指纹 + 全部告警。stableChars 为各段字符数之和。 */
export function inspectStableShape(input: {
    segments: CacheSegmentInput[];
    worldbooks?: WorldbookStabilityInput[];
}): StableShapeReport {
    const segments = input.segments.map(seg => ({
        id: seg.id,
        chars: seg.text.length,
        fingerprint: stableFingerprint(seg.text),
    }));
    const findings = [
        ...input.segments.flatMap(seg => inspectStableText(seg.text, seg.id)),
        ...inspectStableWorldbooks(input.worldbooks),
    ];
    return {
        stableChars: segments.reduce((sum, seg) => sum + seg.chars, 0),
        segments,
        findings,
    };
}

const messageBytes = (message: CapturedMessage): number => {
    let serialized: string;
    try {
        serialized = JSON.stringify(message);
    } catch {
        serialized = String(message);
    }
    // 每条一个分隔符：两边口径一致，所以累计值可直接比较。
    return utf8ByteLength(serialized) + 1;
};

const sameMessage = (a: CapturedMessage, b: CapturedMessage): boolean => {
    const roleEqual = (a.role || '') === (b.role || '');
    if (!roleEqual) return false;
    try {
        return JSON.stringify(a.content) === JSON.stringify(b.content);
    } catch {
        return String(a.content) === String(b.content);
    }
};

const toolKey = (tool: unknown): string => {
    const fn = (tool as { function?: { name?: string } })?.function;
    return typeof fn?.name === 'string' ? fn.name : '';
};

/**
 * 比较相邻两次「即将发送」的请求体（messages + tools）。
 *
 * 调用方应在最终发送边界抓取（useChatAI 的实际 attemptedBody），本函数只做纯计算：
 * 不联网、不落盘、不打印原文。
 */
export function compareCapturedRequests(
    prev: CapturedChatRequest,
    cur: CapturedChatRequest,
): RequestPrefixReport {
    const prevMessages = prev.messages || [];
    const curMessages = cur.messages || [];
    const minMessages = Math.min(prevMessages.length, curMessages.length);
    let sameLeadingMessages = 0;
    while (
        sameLeadingMessages < minMessages
        && sameMessage(prevMessages[sameLeadingMessages], curMessages[sameLeadingMessages])
    ) {
        sameLeadingMessages += 1;
    }

    const prevMessagesBytes = prevMessages.reduce((sum, m) => sum + messageBytes(m), 0);
    const messagesBytes = curMessages.reduce((sum, m) => sum + messageBytes(m), 0);
    const messagesLcpBytes = prevMessages
        .slice(0, sameLeadingMessages)
        .reduce((sum, m) => sum + messageBytes(m), 0);

    const prevTools = prev.tools || [];
    const curTools = cur.tools || [];
    const minTools = Math.min(prevTools.length, curTools.length);
    let sameLeadingTools = 0;
    while (
        sameLeadingTools < minTools
        && canonicalJson(prevTools[sameLeadingTools]) === canonicalJson(curTools[sameLeadingTools])
    ) {
        sameLeadingTools += 1;
    }
    const toolsLcpBytes = prevTools
        .slice(0, sameLeadingTools)
        .reduce<number>((sum, tool) => sum + utf8ByteLength(canonicalJson(tool)) + 1, 0);

    const prevToolKeys = prevTools.map(tool => canonicalJson(tool)).sort();
    const curToolKeys = curTools.map(tool => canonicalJson(tool)).sort();
    const toolsCanonicalEqual = prevToolKeys.length === curToolKeys.length
        && prevToolKeys.every((key, index) => key === curToolKeys[index]);

    const stableSystemEqual = prevMessages.length > 0
        && curMessages.length > 0
        && sameMessage(prevMessages[0], curMessages[0]);

    let firstDiffPath: string | null = null;
    if (sameLeadingMessages < minMessages) {
        const a = prevMessages[sameLeadingMessages];
        const b = curMessages[sameLeadingMessages];
        const field = (a.role || '') === (b.role || '') ? 'content' : 'role';
        firstDiffPath = `messages[${sameLeadingMessages}].${field}`;
    } else if (prevMessages.length !== curMessages.length) {
        firstDiffPath = 'messages.length';
    } else if (sameLeadingTools < minTools) {
        const nameChanged = toolKey(prevTools[sameLeadingTools]) !== toolKey(curTools[sameLeadingTools]);
        firstDiffPath = `tools[${sameLeadingTools}].function.${nameChanged ? 'name' : 'fields'}`;
    } else if (prevTools.length !== curTools.length) {
        firstDiffPath = 'tools.length';
    }

    return {
        prevMessageCount: prevMessages.length,
        messageCount: curMessages.length,
        sameLeadingMessages,
        messagesLcpBytes,
        prevMessagesBytes,
        messagesBytes,
        sameLeadingTools,
        toolsLcpBytes,
        toolsCanonicalEqual,
        stableSystemEqual,
        firstDiffPath,
    };
}
