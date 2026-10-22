import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildChatRequestPayload, type BuildChatPayloadInput } from './chatRequestPayload';
import { RealtimeContextManager } from './realtimeContext';
import { DB } from './db';
import { buildMcpOpenAITools } from './mcpToolBridge';
import { bumpMcpTurn, recordMcpResult, clearMcpResults } from './mcpResultMemory';
import { compareCapturedRequests, canonicalJson } from './promptCacheDiagnostics';
import { nowInTimeZone } from './timezone';
import { getLocalDateKey } from './localDate';

// C6/C7/C8 离线回归（零网络）：只看「结构前缀」能不能复用，不宣称真实缓存命中。
// - 只改分钟 / 天气 / MCP 近期结果 / 契约倒计时 / 生活动态摘要时，第一条 system 必须逐字节相同；
// - 未满窗追加历史不得改写旧消息；
// - 工具集合相同、发现顺序不同时规范化结果稳定；
// - 关键功能信息一条都不能少（移到尾段不等于删掉）。

const MCP_SERVERS_KEY = 'aetheros.mcp.servers';
const CHAR = 'char-cache-prefix';
const USER = { name: '小明' } as any;

const fetchSpy = () => vi.spyOn(globalThis, 'fetch');

const baseInput = (over: Partial<BuildChatPayloadInput> = {}): BuildChatPayloadInput => ({
    char: {
        id: CHAR,
        name: '阿一',
        systemPrompt: '你是阿一。',
        memoryPalaceEnabled: false,
        timeZone: 'Asia/Shanghai',
        // 世界书：position=0（角色设定前）+ 关键词激活 → 属于 stable 里的动态条目，
        // 本期只做诊断，绝不静默移动用户的世界书位置。
        mountedWorldbooks: [{
            id: 'wb-rain',
            title: '雨天设定',
            content: '下雨天你会想起旧房子。',
            position: 0,
            key: ['下雨'],
            constant: false,
        }],
    } as any,
    userProfile: USER,
    groups: [],
    emojis: [],
    categories: [],
    historyMsgs: [
        { id: 1, charId: CHAR, role: 'user', type: 'text', content: '在吗', timestamp: Date.parse('2026-05-20T09:50:00+08:00') },
        { id: 2, charId: CHAR, role: 'assistant', type: 'text', content: '在。', timestamp: Date.parse('2026-05-20T09:50:30+08:00') },
        { id: 3, charId: CHAR, role: 'user', type: 'text', content: '今天下雨了', timestamp: Date.parse('2026-05-20T09:59:00+08:00') },
    ] as any[],
    contextLimit: 20,
    realtimeConfig: { weatherEnabled: true, newsEnabled: true } as any,
    recallEntryPoint: 'chat_app',
    ...over,
});

const stableOf = (payload: Awaited<ReturnType<typeof buildChatRequestPayload>>) =>
    String(payload.fullMessages[0]?.content ?? '');
const tailOf = (payload: Awaited<ReturnType<typeof buildChatRequestPayload>>) =>
    String(payload.fullMessages[payload.volatileTailIndex]?.content ?? '');
const allText = (payload: Awaited<ReturnType<typeof buildChatRequestPayload>>) =>
    payload.fullMessages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

beforeEach(() => {
    // 零网络：任何真实请求都直接失败，测试不允许偷偷联网。
    fetchSpy().mockRejectedValue(new Error('offline fixture: network is forbidden'));
    vi.spyOn(RealtimeContextManager, 'buildFullContext').mockImplementation(async () => '\n### 天气\n晴 21°C\n');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-20T10:00:20+08:00'));
    localStorage.setItem(MCP_SERVERS_KEY, JSON.stringify([
        { id: 'mcp-1', name: '笔记台', url: 'https://mcp.example.com/sse', enabled: true, tools: [{ name: 'b_search' }, { name: 'a_read' }] },
    ]));
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.removeItem(MCP_SERVERS_KEY);
});

describe('C6 零网络 LCP 回归：只有易变内容变化时固定前缀不动', () => {
    it('分钟与天气变化 → 第一条 system 逐字节相同，差异只落在尾段', async () => {
        const first = await buildChatRequestPayload(baseInput());

        vi.setSystemTime(new Date('2026-05-20T10:03:40+08:00'));
        vi.spyOn(RealtimeContextManager, 'buildFullContext').mockImplementation(async () => '\n### 天气\n阴 19°C 有风\n');
        const second = await buildChatRequestPayload(baseInput());

        expect(second.fullMessages[0]).toEqual(first.fullMessages[0]);
        expect(stableOf(second)).toBe(stableOf(first));
        expect(tailOf(second)).not.toBe(tailOf(first));

        const report = compareCapturedRequests(
            { messages: first.fullMessages },
            { messages: second.fullMessages },
        );
        expect(report.stableSystemEqual).toBe(true);
        // 第一条 system + 3 条历史逐条相同；差异出现在易变尾段（历史之后那条）
        expect(report.sameLeadingMessages).toBe(1 + 3);
        expect(report.firstDiffPath).toBe('messages[4].content');
    });

    it('未满窗追加历史 → 旧消息原样复用，不改写', async () => {
        const first = await buildChatRequestPayload(baseInput());
        const grown = baseInput();
        grown.historyMsgs = [
            ...grown.historyMsgs,
            { id: 4, charId: CHAR, role: 'assistant', type: 'text', content: '嗯，记得带伞。', timestamp: Date.parse('2026-05-20T10:00:00+08:00') },
            { id: 5, charId: CHAR, role: 'user', type: 'text', content: '好', timestamp: Date.parse('2026-05-20T10:00:10+08:00') },
        ] as any[];
        const second = await buildChatRequestPayload(grown);

        // 历史消息在后段之前：第一条 system 之后的 3 条旧消息必须原样复用
        const prevHistory = first.fullMessages.slice(1, 4);
        const nextHistory = second.fullMessages.slice(1, 4);
        expect(nextHistory).toEqual(prevHistory);
        expect(second.fullMessages[0]).toEqual(first.fullMessages[0]);

        const report = compareCapturedRequests(
            { messages: first.fullMessages },
            { messages: second.fullMessages },
        );
        expect(report.stableSystemEqual).toBe(true);
        // 旧请求的易变尾段停在其旧终点，新历史接在它后面 —— LCP 在这里断是结构决定的，
        // 断点之后没有被改写的旧历史（上面 3 条已逐条比对）。旧尾段是 system，新位置是
        // assistant，所以首个差异落在 role 上。
        expect(report.sameLeadingMessages).toBe(1 + 3);
        expect(report.firstDiffPath).toBe('messages[4].role');
    });

    it('全程没有任何真实网络请求', async () => {
        await buildChatRequestPayload(baseInput());
        expect(fetchSpy()).not.toHaveBeenCalled();
    });
});

describe('C7 动态内容后移：信息完整、位置改变', () => {
    it('契约倒计时（今天/明天/N 天后）进尾段，不再放稳定前缀', async () => {
        const today = getLocalDateKey(nowInTimeZone('Asia/Shanghai'));
        await DB.saveAnniversary({
            id: 'anni-cache-1',
            charId: CHAR,
            title: '一起看流星雨的约定',
            date: today,
            repeat: { mode: 'yearly' },
            content: '那天我们说好要去山顶。',
        } as any);

        const payload = await buildChatRequestPayload(baseInput());
        expect(stableOf(payload)).not.toContain('时光契约');
        expect(tailOf(payload)).toContain('时光契约');
        expect(tailOf(payload)).toContain('一起看流星雨的约定');
        expect(tailOf(payload)).toContain('就是今天');
    });

    it('生活记录：固定说明留 stable，实时摘要进尾段', async () => {
        const char = baseInput().char as any;
        char.lifeRecordEnabled = true;
        char.lifeRecordPeriodEnabled = true;
        await DB.saveLifeRecord({
            id: 'life-period-cache-1',
            module: 'period',
            kind: 'start',
            date: getLocalDateKey(nowInTimeZone('Asia/Shanghai')),
            payload: {},
            createdAt: Date.now(),
            recordedBy: 'user',
        } as any);

        const payload = await buildChatRequestPayload(baseInput({ char }));
        const stable = stableOf(payload);
        const tail = tailOf(payload);

        // 固定说明与代记纪律在 stable（变化极慢，可以长期复用）
        expect(stable).toContain('生活记录（潜意识背景）');
        expect(stable).toContain('一件事只记一次');
        expect(stable).not.toContain('生理期：**第');
        // 实时摘要（今日/第 N 天）在尾段
        expect(tail).toContain('生理期：**第');
        // 信息没丢
        expect(allText(payload)).toContain('生理期：**第');
    });

    it('MCP：近期调用结果进尾段，长期手册留 stable', async () => {
        clearMcpResults(CHAR, 'all');
        const turn = bumpMcpTurn(CHAR);
        recordMcpResult({
            charId: CHAR,
            server: { id: 'mcp-1', name: '笔记台' },
            toolName: 'b_search',
            args: { q: '流星雨' },
            result: { success: true, data: '搜到三条流星雨的笔记' },
            turnId: turn,
            keepTurns: 3,
        });
        recordMcpResult({
            charId: CHAR,
            server: { id: 'mcp-1', name: '笔记台' },
            toolName: '操作手册',
            args: { doc: 'main' },
            result: { success: true, data: '手册原文：先读再写' },
            turnId: turn,
            keepTurns: 3,
        });

        const payload = await buildChatRequestPayload(baseInput());
        const stable = stableOf(payload);
        const tail = tailOf(payload);

        expect(tail).toContain('搜到三条流星雨的笔记');
        expect(stable).not.toContain('搜到三条流星雨的笔记');
        expect(stable).toContain('手册原文：先读再写');

        // 两条都在这一次请求里，没有因为搬家被裁掉
        const text = allText(payload);
        expect(text).toContain('搜到三条流星雨的笔记');
        expect(text).toContain('手册原文：先读再写');
        clearMcpResults(CHAR, 'all');
    });

    it('用户世界书按用户位置保留在 stable，只做诊断不搬动', async () => {
        const payload = await buildChatRequestPayload(baseInput());
        expect(stableOf(payload)).toContain('下雨天你会想起旧房子。');
        const codes = (payload.cacheShape?.findings || []).map(f => f.code);
        expect(codes).toContain('worldbook-keyword');
    });
});

describe('C8 工具排序稳定（同一集合、不同发现顺序）', () => {
    it('两次构建的 tools 规范化后完全一致', async () => {
        const first = buildMcpOpenAITools(CHAR);

        localStorage.setItem(MCP_SERVERS_KEY, JSON.stringify([
            { id: 'mcp-1', name: '笔记台', url: 'https://mcp.example.com/sse', enabled: true, tools: [{ name: 'a_read' }, { name: 'b_search' }] },
        ]));
        const second = buildMcpOpenAITools(CHAR);

        expect(canonicalJson(first.tools)).toBe(canonicalJson(second.tools));
        expect(first.tools.map(t => t.function.name)).toEqual(['a_read', 'b_search']);
    });
});

describe('C9 诊断出口：stable 指纹与动态条目告警', () => {
    it('payload 带上 stable 指纹与告警，不落原始 prompt', async () => {
        const payload = await buildChatRequestPayload(baseInput());
        expect(payload.cacheShape).toBeTruthy();
        expect(payload.cacheShape?.stableHash).toMatch(/^[0-9a-f]{8}:\d+$/);
        expect(payload.cacheShape?.stableChars).toBeGreaterThan(0);
        expect(Array.isArray(payload.cacheShape?.findings)).toBe(true);
        // 诊断只带段落 id / 行号 / 命中长度：不带任何 prompt 原文片段，可安全落本地日志
        const serialized = JSON.stringify(payload.cacheShape);
        ['阿一', '在下雨', '你是阿一', '小明', '雨天设定'].forEach(secret => {
            expect(serialized).not.toContain(secret);
        });
        for (const finding of payload.cacheShape?.findings || []) {
            expect(finding.detail.length).toBeLessThan(120);
            expect(finding.confidence).toBe('heuristic');
        }
    });

    it('固定前缀内容不变时指纹不变', async () => {
        const first = await buildChatRequestPayload(baseInput());
        vi.setSystemTime(new Date('2026-05-20T10:07:00+08:00'));
        const second = await buildChatRequestPayload(baseInput());
        expect(second.cacheShape?.stableHash).toBe(first.cacheShape?.stableHash);
    });
});

describe('P3 记忆协商：默认关闭，打开只是固定纪律', () => {
    it('默认不注入协商段', async () => {
        const payload = await buildChatRequestPayload(baseInput());
        expect(stableOf(payload)).not.toContain('记忆协商');
    });

    it('显式打开后进稳定前缀，且不含任何记忆写入指令', async () => {
        const payload = await buildChatRequestPayload(baseInput({ memoryNegotiationEnabled: true }));
        const stable = stableOf(payload);
        expect(stable).toContain('记忆协商');
        expect(stable).toContain('明确说过');
        expect(stable).toContain('不要追问');
        // 不新增长期记忆写入捷径
        expect(stable).not.toContain('[[MEMORY');
        // 固定文案：同一轮里重复构建不抖
        const again = await buildChatRequestPayload(baseInput({ memoryNegotiationEnabled: true }));
        expect(stableOf(again)).toBe(stable);
    });
});
