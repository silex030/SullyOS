// P4/L2 前台感知小快照：只吃已有快照、不重复注入、缺席就省略。
import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildChatPerceptionSnapshot } from './perceptionPrompt';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');

const base = {
  nowMs: NOW,
  tzId: 'Asia/Shanghai',
  charId: 'char_1',
};

afterEach(() => { vi.restoreAllMocks(); });

describe('缺席就省略', () => {
  it('什么都没有 → 空字符串（不占位、不留空标题）', () => {
    expect(buildChatPerceptionSnapshot(base)).toBe('');
  });

  it('已经过期半天的天气快照不算「此刻」', () => {
    expect(buildChatPerceptionSnapshot({
      ...base,
      weather: { city: '上海', description: '小雨', temp: 17, observedAt: NOW - 3 * 60 * 60_000 },
    })).toBe('');
  });

  it('结束了的日程不再进快照', () => {
    expect(buildChatPerceptionSnapshot({
      ...base,
      calendar: [{ id: 'cal-1', title: '评审会', startsAt: NOW - 2 * 60 * 60_000, endsAt: NOW - 60 * 60_000, subject: 'user' }],
    })).toBe('');
  });
});

describe('不重复注入', () => {
  it('本次提示词里已经渲染过的来源，一个都不再出现', () => {
    const block = buildChatPerceptionSnapshot({
      ...base,
      alreadyRendered: ['weather', 'calendar'],
      weather: { city: '上海', description: '小雨', temp: 17, observedAt: NOW - 5 * 60_000 },
      calendar: [{ id: 'cal-1', title: '评审会', startsAt: NOW + 60 * 60_000, endsAt: NOW + 2 * 60 * 60_000, subject: 'user' }],
    });
    expect(block).toBe('');
  });

  it('只把没渲染过的那一条放进来', () => {
    const block = buildChatPerceptionSnapshot({
      ...base,
      alreadyRendered: ['weather'],
      weather: { city: '上海', description: '小雨', temp: 17, observedAt: NOW - 5 * 60_000 },
      news: [{ platform: '微博', title: '某地降温', observedAt: NOW - 10 * 60_000 }],
    });
    expect(block).toContain('微博');
    expect(block).not.toContain('小雨');
  });
});

describe('权限与认知边界', () => {
  it('开关关掉的来源不出现（不是「没数据」，是「不许看」）', () => {
    expect(buildChatPerceptionSnapshot({
      ...base,
      enabled: { weather: false },
      weather: { city: '上海', description: '小雨', temp: 17, observedAt: NOW - 60_000 },
    })).toBe('');
  });

  it('热搜只给标题，并且明说没读正文', () => {
    const block = buildChatPerceptionSnapshot({
      ...base,
      news: [{ platform: '微博', title: '某地降温', observedAt: NOW - 10 * 60_000 }],
    });
    expect(block).toContain('某地降温');
    expect(block).toContain('没读正文');
  });

  it('带上边界句：不许拿天气/日程空白推断对方情绪或空闲', () => {
    const block = buildChatPerceptionSnapshot({
      ...base,
      weather: { city: '上海', description: '小雨', temp: 17, observedAt: NOW - 60_000 },
    });
    expect(block).toContain('【边界】');
    expect(block).toContain('情绪');
  });

  it('角色自己的作息槽位算观测，写成「按你的作息」', () => {
    const block = buildChatPerceptionSnapshot({
      ...base,
      activity: { label: '看书', startLabel: '10:00', endLabel: '12:00', observedAt: NOW - 60_000 },
    });
    expect(block).toContain('按你的作息');
    expect(block).toContain('看书');
  });
});

describe('不取数', () => {
  it('纯函数：整轮不碰网络、不读时钟', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never).mockImplementation((() => {
      throw new Error('perception 不该发请求');
    }) as never);
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('perception 不该自己读时钟');
    });

    const block = buildChatPerceptionSnapshot({
      ...base,
      weather: { city: '上海', description: '小雨', temp: 17, observedAt: NOW - 60_000 },
      news: [{ platform: '微博', title: '某地降温', observedAt: NOW - 10 * 60_000 }],
      calendar: [{ id: 'cal-1', title: '评审会', startsAt: NOW + 60 * 60_000, endsAt: NOW + 2 * 60 * 60_000, subject: 'user' }],
      activity: { label: '看书', startLabel: '10:00', endLabel: '12:00', observedAt: NOW - 60_000 },
    });

    expect(block.length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(nowSpy).not.toHaveBeenCalled();
  });
});
