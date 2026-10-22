import { describe, it, expect } from 'vitest';
import {
    canonicalJson,
    stableFingerprint,
    utf8ByteLcp,
    compareCapturedRequests,
    inspectStableText,
    inspectStableWorldbooks,
    inspectStableShape,
} from './promptCacheDiagnostics';

// 缓存结构诊断叶子（C4/C6/C9 的离线部分）：只做确定性的结构指标，
// 不联网、不读时间、不猜供应商 tokenizer。名字里带 proxy 的都只是字节代理。

describe('canonicalJson —— 对象键排序、数组顺序不动', () => {
    it('递归排序对象键，保留数组元素顺序', () => {
        const value = { b: 1, a: { d: 2, c: [3, 1] }, arr: [{ z: 1, y: 2 }] };
        expect(canonicalJson(value)).toBe('{"a":{"c":[3,1],"d":2},"arr":[{"y":2,"z":1}],"b":1}');
    });

    it('不排序语义数组：enum / required / oneOf 原样保留', () => {
        const schema = { type: 'object', required: ['b', 'a'], properties: { b: { enum: ['z', 'a'] }, a: { type: 'string' } } };
        const out = canonicalJson(schema);
        expect(out).toContain('"required":["b","a"]');
        expect(out).toContain('"enum":["z","a"]');
        // 对象键仍然有序，方便定位非语义噪音
        expect(out.indexOf('"a"')).toBeLessThan(out.indexOf('"b"'));
    });
});

describe('stableFingerprint —— 非加密指纹，够定位段落变化', () => {
    it('同一文本稳定，长度参与指纹', () => {
        const a = stableFingerprint('固定的规则文本');
        expect(stableFingerprint('固定的规则文本')).toBe(a);
        expect(a).toMatch(/^[0-9a-f]{8}:\d+$/);
    });

    it('一个字符变化即不同', () => {
        expect(stableFingerprint('规则A')).not.toBe(stableFingerprint('规则B'));
    });
});

describe('utf8ByteLcp —— 字节级公共前缀代理', () => {
    it('中文按 UTF-8 字节计数，不在半个字符处切断', () => {
        // '你好' = 6 字节；第 7 字节开始不同
        expect(utf8ByteLcp('你好世界', '你好时间')).toBe(6);
    });

    it('完全包含时取较短者', () => {
        expect(utf8ByteLcp('abc', 'abcdef')).toBe(3);
        expect(utf8ByteLcp('', 'abc')).toBe(0);
    });
});

describe('compareCapturedRequests —— 相同消息数 / 字节 LCP / 首个差异', () => {
    const prev = {
        messages: [
            { role: 'system', content: '固定人设' },
            { role: 'user', content: '在吗' },
        ],
        tools: [{ type: 'function', function: { name: 'b_tool', parameters: { type: 'object', properties: { b: {}, a: {} } } } }],
    };
    const appended = {
        messages: [
            ...prev.messages,
            { role: 'assistant', content: '在' },
            { role: 'user', content: '嗯' },
        ],
        tools: prev.tools,
    };

    it('未满窗追加历史：旧消息整段可复用，首个差异在新增处', () => {
        const report = compareCapturedRequests(prev, appended);
        expect(report.sameLeadingMessages).toBe(2);
        expect(report.firstDiffPath).toBe('messages.length');
        expect(report.stableSystemEqual).toBe(true);
        // 上一份 messages 的整体字节数被完整复用
        expect(report.messagesLcpBytes).toBe(report.prevMessagesBytes);
        expect(report.messagesLcpBytes).toBeLessThan(report.messagesBytes);
    });

    it('只改易变尾段：第一条 system 相同，差异定位到最后一条', () => {
        const volatileChanged = {
            messages: [
                prev.messages[0],
                prev.messages[1],
                { role: 'system', content: '现在 21:46' },
            ],
            tools: prev.tools,
        };
        const report = compareCapturedRequests(prev, volatileChanged);
        expect(report.stableSystemEqual).toBe(true);
        expect(report.sameLeadingMessages).toBe(2);
        expect(report.firstDiffPath).toBe('messages.length');
    });

    it('工具集合相同但发现顺序/键序不同 → 规范化后判等，顺序 LCP 如实下降', () => {
        const toolA = { type: 'function', function: { name: 'a_tool', parameters: { type: 'object', properties: {} } } };
        const toolB = { type: 'function', function: { name: 'b_tool', parameters: { type: 'object', properties: { b: {}, a: {} } } } };
        const ordered = { messages: prev.messages, tools: [toolB, toolA] };
        const reordered = {
            messages: prev.messages,
            tools: [
                toolA,
                { function: { parameters: { properties: { a: {}, b: {} }, type: 'object' }, name: 'b_tool' }, type: 'function' },
            ],
        };
        const report = compareCapturedRequests(ordered, reordered);
        expect(report.toolsCanonicalEqual).toBe(true);
        expect(report.sameLeadingTools).toBe(0);
        // 顺序变了：名字不同 → 直接点名 name
        expect(report.firstDiffPath).toBe('tools[0].function.name');
    });

    it('同一位置只有键序不同 → 规范化后算相同，顺序 LCP 不断', () => {
        const left = { messages: prev.messages, tools: [{ function: { name: 'b_tool', parameters: { type: 'object', properties: { b: {}, a: {} } } }, type: 'function' }] };
        const right = { messages: prev.messages, tools: [{ type: 'function', function: { parameters: { properties: { a: {}, b: {} }, type: 'object' }, name: 'b_tool' } }] };
        const report = compareCapturedRequests(left, right);
        expect(report.sameLeadingTools).toBe(1);
        expect(report.toolsCanonicalEqual).toBe(true);
        expect(report.firstDiffPath).toBeNull();
    });

    it('工具真的增减时不算相等', () => {
        const fewer = { messages: prev.messages, tools: [] };
        const report = compareCapturedRequests(prev, fewer);
        expect(report.toolsCanonicalEqual).toBe(false);
        expect(report.firstDiffPath).toBe('tools.length');
    });
});

describe('inspectStableText —— stable 里混进动态内容的诊断', () => {
    it('分钟级时钟被点名', () => {
        const findings = inspectStableText('固定规则\n现在是 21:45，记得吃饭。');
        expect(findings.map(f => f.code)).toContain('minute-clock');
    });

    it('相对时间与日期口径分别点名', () => {
        const findings = inspectStableText('你 5 分钟前说过这句话。「一起看流星雨」就是今天（2026-05-20）。');
        const codes = findings.map(f => f.code);
        expect(codes).toContain('relative-time');
        expect(codes).toContain('day-scoped');
    });

    it('纯固定文本零告警', () => {
        expect(inspectStableText('### 你的身份\n- 名字: 阿一\n你是稳定的角色设定。')).toEqual([]);
    });

    it('规则正文里的「刚才/今天」不算动态（避免满屏误报）', () => {
        expect(inspectStableText('对方刚才说的那句话，今天先别急着答；明天再聊也可以。')).toEqual([]);
    });

    it('诊断给出行号，便于回原文定位', () => {
        const findings = inspectStableText('第一行\n第二行 21:45\n第三行');
        const clock = findings.find(f => f.code === 'minute-clock');
        expect(clock?.line).toBe(2);
        // detail 只带结构信息（行号 / 命中长度），绝不带 prompt 原文片段
        expect(clock?.detail).toContain('第 2 行');
        expect(clock?.detail).not.toContain('21:45');
        expect(clock?.detail).not.toContain('第二行');
    });

    it('全部告警都标明是启发式，不把「像是动态」说成确认动态', () => {
        const findings = inspectStableText('规则举例：现在是 09:30，明天再说。');
        expect(findings.length).toBeGreaterThan(0);
        findings.forEach(f => {
            expect(f.confidence).toBe('heuristic');
            expect(f.detail).toContain('启发式');
        });
    });
});

describe('inspectStableWorldbooks —— 关键词/概率世界书进 stable 的诊断', () => {
    const base = { id: 'wb', title: '测试书', content: '内容' };

    it('position=0 且有关键词 → worldbook-keyword', () => {
        const findings = inspectStableWorldbooks([
            { ...base, id: 'wb1', title: '雨天的旧房子', position: 0, key: ['雨'], constant: false },
        ] as any);
        expect(findings.map(f => f.code)).toContain('worldbook-keyword');
        expect(findings[0].segment).toBe('worldbook:wb1');
        // 不带书名 / 关键词原文
        expect(findings[0].detail).not.toContain('雨天的旧房子');
        expect(findings[0].detail).not.toContain('雨');
    });

    it('概率激活（<100 或 useProbability）→ worldbook-probability', () => {
        const findings = inspectStableWorldbooks([
            { ...base, id: 'wb2', position: 1, probability: 40, useProbability: true },
        ] as any);
        expect(findings.map(f => f.code)).toContain('worldbook-probability');
    });

    it('depth 注入（position=4）不算 stable 污染，单独标注入位置风险', () => {
        const findings = inspectStableWorldbooks([
            { ...base, id: 'wb3', position: 4, depth: 0, key: ['雨'] },
        ] as any);
        expect(findings.map(f => f.code)).toContain('worldbook-at-depth');
        expect(findings.map(f => f.code)).not.toContain('worldbook-keyword');
    });

    it('常驻无概率条目与停用条目零告警', () => {
        const findings = inspectStableWorldbooks([
            { ...base, id: 'wb4', position: 1, constant: true },
            { ...base, id: 'wb5', position: 0, key: ['雨'], disable: true },
        ] as any);
        expect(findings).toEqual([]);
    });
});

describe('inspectStableShape —— 段落级汇总', () => {
    it('多个段各自诊断，并按段标出指纹', () => {
        const report = inspectStableShape({
            segments: [
                { id: 'core', text: '### 你的身份\n你是阿一。' },
                { id: 'appRules', text: '规则：现在是 09:30 该问早了。' },
            ],
            worldbooks: [{ id: 'wb1', title: '书', content: 'x', position: 0, key: ['雨'] }] as any,
        });
        expect(report.findings.map(f => f.code)).toEqual(
            expect.arrayContaining(['minute-clock', 'worldbook-keyword']),
        );
        expect(report.segments.map(s => s.id)).toEqual(['core', 'appRules']);
        expect(report.segments.every(s => /^[0-9a-f]{8}:\d+$/.test(s.fingerprint))).toBe(true);
        expect(report.stableChars).toBeGreaterThan(0);
    });
});
