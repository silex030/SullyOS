import { describe, it, expect, beforeEach } from 'vitest';
import {
    MEMORY_NEGOTIATION_STORAGE_KEY,
    buildMemoryNegotiationBlock,
    isMemoryNegotiationEnabled,
    resolveMemoryNegotiationEnabled,
    resolveClarification,
    type MemoryNegotiationCandidate,
} from './memoryNegotiation';

// P3 前台的策略部分：
//  - 一段固定的协商纪律（进 stable，不新增记忆写入指令捷径、不加前置分析请求）
//  - 一个纯函数澄清解析器：候选必须按消息 id + 议题绑定，证据不足就保持未决
// 正常聊天里不新增专门判断调用；离线测试只证明数据与流程契约。

const cand = (over: Partial<MemoryNegotiationCandidate> = {}): MemoryNegotiationCandidate => ({
    id: 'cand-1',
    charId: 'char-1',
    subject: 'user',
    topic: '加班',
    evidence: 'undecided',
    scope: 'ongoing',
    sourceMessageId: 10,
    askedAtMessageId: 11,
    createdAt: 1000,
    ...over,
});

beforeEach(() => localStorage.removeItem(MEMORY_NEGOTIATION_STORAGE_KEY));

describe('开关 —— 默认关闭，可显式覆盖', () => {
    it('默认关闭（P6：记忆协商独立开关、默认关）', () => {
        expect(isMemoryNegotiationEnabled()).toBe(false);
        expect(resolveMemoryNegotiationEnabled()).toBe(false);
    });

    it('存储为 1 才开；显式 override 优先于存储', () => {
        localStorage.setItem(MEMORY_NEGOTIATION_STORAGE_KEY, '1');
        expect(isMemoryNegotiationEnabled()).toBe(true);
        expect(resolveMemoryNegotiationEnabled(false)).toBe(false);
        expect(resolveMemoryNegotiationEnabled(true)).toBe(true);
    });
});

describe('buildMemoryNegotiationBlock —— 固定规则文本', () => {
    it('明确三类证据与短期状态不升级', () => {
        const block = buildMemoryNegotiationBlock();
        expect(block).toContain('明确说过');
        expect(block).toContain('猜测');
        expect(block).toContain('短期');
        expect(block).toContain('不要升级');
    });

    it('是自然协商而不是问卷：允许拒答/换话题，一次只问一件', () => {
        const block = buildMemoryNegotiationBlock();
        expect(block).toContain('一次只问一件');
        expect(block).toContain('不想说');
        expect(block).toContain('不要追问');
        expect(block).not.toContain('问卷');
    });

    it('不新增长期记忆写入指令捷径（不许出现 [[...]] 这类标签）', () => {
        expect(buildMemoryNegotiationBlock()).not.toContain('[[');
    });
});

describe('resolveClarification —— 消息 id + 议题绑定', () => {
    it('紧邻的明确肯定 → confirmed', () => {
        const d = resolveClarification({
            candidates: [cand()],
            reply: { messageId: 12, content: '对，最近加班挺凶的' },
        });
        expect(d.outcome).toBe('confirmed');
        expect(d.candidateId).toBe('cand-1');
    });

    it('紧邻的否定 → denied（不写成用户事实）', () => {
        const d = resolveClarification({
            candidates: [cand()],
            reply: { messageId: 12, content: '不是，我最近没加班' },
        });
        expect(d.outcome).toBe('denied');
        expect(d.candidateId).toBe('cand-1');
    });

    it('隔了几条的回复不算确认（页面刷新 / 中间插话）', () => {
        const d = resolveClarification({
            candidates: [cand()],
            reply: { messageId: 14, content: '对' },
        });
        expect(d.outcome).toBe('still_pending');
        expect(d.reason).toBe('non-adjacent');
    });

    it('模糊应答「嗯」不构成确认', () => {
        const d = resolveClarification({
            candidates: [cand()],
            reply: { messageId: 12, content: '嗯' },
        });
        expect(d.outcome).toBe('still_pending');
        expect(d.reason).toBe('weak-affirmation');
    });

    it('多议题 + 指代不明 → 保持未决，绝不把下一句当确认', () => {
        const d = resolveClarification({
            candidates: [
                cand({ id: 'cand-1', topic: '加班' }),
                cand({ id: 'cand-2', topic: '换工作' }),
            ],
            reply: { messageId: 12, content: '对' },
        });
        expect(d.outcome).toBe('still_pending');
        expect(d.reason).toBe('ambiguous-multi-topic');
        expect(d.candidateId).toBeNull();
    });

    it('多议题但回复点明了议题 → 只确认对应的一条', () => {
        const d = resolveClarification({
            candidates: [
                cand({ id: 'cand-1', topic: '加班' }),
                cand({ id: 'cand-2', topic: '换工作' }),
            ],
            reply: { messageId: 12, content: '换工作的事对，正在看机会' },
        });
        expect(d.outcome).toBe('confirmed');
        expect(d.candidateId).toBe('cand-2');
    });

    it('引用自己以前的话不等于确认新猜测', () => {
        const quoted = '[用户引用了你之前说的「你是不是最近都在加班？」，并回复了 ↓]\n我上周就说过我闲得要死';
        const d = resolveClarification({
            candidates: [cand()],
            reply: { messageId: 12, content: quoted },
        });
        expect(d.outcome).not.toBe('confirmed');
    });

    it('用户拒答 → declined，之后不再追问', () => {
        const d = resolveClarification({
            candidates: [cand()],
            reply: { messageId: 12, content: '这个不想说' },
        });
        expect(d.outcome).toBe('declined');
        expect(d.candidateId).toBe('cand-1');
    });

    it('换话题 → new_topic，候选保持未决', () => {
        const d = resolveClarification({
            candidates: [cand()],
            reply: { messageId: 12, content: '话说你今晚吃什么' },
        });
        expect(d.outcome).toBe('new_topic');
    });

    it('重复回调同一句 → 结果幂等（不会第二次变成确认）', () => {
        const input = {
            candidates: [cand()],
            reply: { messageId: 12, content: '嗯' },
        };
        const first = resolveClarification(input);
        const second = resolveClarification(input);
        expect(second).toEqual(first);
    });

    it('没有待澄清候选 → new_topic，不凭空造候选', () => {
        const d = resolveClarification({
            candidates: [],
            reply: { messageId: 12, content: '对' },
        });
        expect(d.outcome).toBe('new_topic');
        expect(d.candidateId).toBeNull();
    });

    it('候选已带证据等级时不重复协商（只处理 undecided）', () => {
        const d = resolveClarification({
            candidates: [cand({ evidence: 'user_stated' })],
            reply: { messageId: 12, content: '对' },
        });
        expect(d.outcome).toBe('new_topic');
        expect(d.reason).toBe('no-pending-question');
    });

    it('多角色：只处理该角色名下候选（按 charId 过滤）', () => {
        const d = resolveClarification({
            candidates: [cand({ id: 'cand-2', charId: 'char-2' })],
            charId: 'char-1',
            reply: { messageId: 12, content: '对' },
        });
        expect(d.outcome).toBe('new_topic');
    });
});
