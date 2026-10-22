// utils/airp/perception.test.ts
// P4 L1/L2：感知事件归一 + 本地规则过滤 + 小快照渲染。
// 关键约束：不新增监控、只吃调用方已经拿到的数据；过期/无变化/重复/无权限/无关联一律本地丢掉。
import { describe, expect, it } from 'vitest';
import {
  activityPerception,
  calendarPerception,
  clockPerception,
  filterPerceptionEvents,
  newsPerception,
  perceptionDedupeRows,
  renderPerceptionSnapshot,
  weatherPerception,
  type AirpPerceptionEvent,
} from './perception';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const MIN = 60_000;

const eventOf = (over: Partial<AirpPerceptionEvent> = {}): AirpPerceptionEvent => ({
  v: 1,
  dedupeKey: 'k',
  source: 'weather',
  subject: 'char-1',
  summary: '杭州 晴 26℃',
  observedAt: NOW - 10 * MIN,
  expiresAt: NOW + 30 * MIN,
  permissions: { audience: 'self', promptAllowed: true },
  epistemic: 'observation',
  confidence: 1,
  valueHash: 'h1',
  version: 1,
  ...over,
});

describe('归一：只转换已拿到的数据，不自己取数', () => {
  it('天气：按城市分键、默认 30 分钟过期、观测档', () => {
    const e = weatherPerception({
      city: '杭州', summary: '晴 26℃', observedAt: NOW - MIN, subject: 'char-1',
    });
    expect(e.source).toBe('weather');
    expect(e.dedupeKey).toBe('weather:杭州');
    expect(e.expiresAt).toBe(NOW - MIN + 30 * MIN);
    expect(e.epistemic).toBe('observation');
    expect(e.permissions.promptAllowed).toBe(true);
  });

  it('时钟：按角色时区分小时键，整点过期', () => {
    const e = clockPerception({ nowMs: NOW, tzId: 'Asia/Shanghai', subject: 'char-1' });
    expect(e.source).toBe('clock');
    expect(e.dedupeKey).toContain('clock:Asia/Shanghai');
    expect(e.expiresAt).toBeGreaterThan(NOW);
    expect(e.summary).toMatch(/20:00/); // UTC+8
  });

  it('热搜：只记标题、明说不声称读过正文', () => {
    const e = newsPerception({ platform: '微博', title: '某地降温', observedAt: NOW, subject: 'char-1' });
    expect(e.source).toBe('news');
    expect(e.summary).toContain('某地降温');
    expect(e.summary).toContain('只看到标题');
    expect(e.expiresAt).toBe(NOW + 24 * 60 * MIN);
  });

  it('日程：用户日程是 user 主体、按结束时间过期；不给「有空」结论', () => {
    const e = calendarPerception({
      id: 'evt-1', title: '评审会', startsAt: NOW + 30 * MIN, endsAt: NOW + 90 * MIN,
      observedAt: NOW, subject: 'user',
    });
    expect(e.source).toBe('calendar');
    expect(e.subject).toBe('user');
    expect(e.expiresAt).toBe(NOW + 90 * MIN);
    expect(e.summary).not.toContain('有空');
  });

  it('活动：角色当前在做什么（虚拟生活自己的状态）', () => {
    const e = activityPerception({
      label: '写方案', startLabel: '15:00', endLabel: '18:00', observedAt: NOW, subject: 'char-1',
    });
    expect(e.source).toBe('activity');
    expect(e.summary).toContain('写方案');
  });
});

describe('过滤：过期 / 无变化 / 重复 / 无权限 / 无关联', () => {
  it('过期事件丢掉', () => {
    const out = filterPerceptionEvents({ events: [eventOf({ expiresAt: NOW - 1 })], nowMs: NOW });
    expect(out.kept).toEqual([]);
    expect(out.dropped[0].reason).toBe('expired');
  });

  it('同 key 同 valueHash（没变化）丢掉；同 key 新值保留并挤掉旧的', () => {
    const seen = [{ dedupeKey: 'weather:杭州', valueHash: 'h1', observedAt: NOW - 20 * MIN }];
    const unchanged = filterPerceptionEvents({
      events: [eventOf({ dedupeKey: 'weather:杭州', valueHash: 'h1' })], nowMs: NOW, seen,
    });
    expect(unchanged.kept).toEqual([]);
    expect(unchanged.dropped[0].reason).toBe('unchanged');

    const changed = filterPerceptionEvents({
      events: [
        eventOf({ dedupeKey: 'weather:杭州', valueHash: 'h2', observedAt: NOW - 5 * MIN }),
        eventOf({ dedupeKey: 'weather:杭州', valueHash: 'h1', observedAt: NOW - 20 * MIN }),
      ],
      nowMs: NOW, seen,
    });
    expect(changed.kept).toHaveLength(1);
    expect(changed.kept[0].valueHash).toBe('h2');
    expect(changed.dropped.some((d) => d.reason === 'duplicate')).toBe(true);
  });

  it('无权限 / 无关联主体丢掉', () => {
    const noPerm = filterPerceptionEvents({
      events: [eventOf({ permissions: { audience: 'self', promptAllowed: false } })], nowMs: NOW,
    });
    expect(noPerm.dropped[0].reason).toBe('no-permission');

    const other = filterPerceptionEvents({
      events: [eventOf({ subject: 'someone-else' })], nowMs: NOW, subjectAllow: ['char-1'],
    });
    expect(other.dropped[0].reason).toBe('irrelevant');
  });

  it('上限按最新优先、超出记 cap', () => {
    const events = [1, 2, 3].map((i) => eventOf({
      dedupeKey: `n:${i}`, valueHash: `h${i}`, observedAt: NOW - i * MIN,
    }));
    const out = filterPerceptionEvents({ events, nowMs: NOW, maxItems: 2 });
    expect(out.kept.map((e) => e.dedupeKey)).toEqual(['n:1', 'n:2']);
    expect(out.dropped.filter((d) => d.reason === 'cap')).toHaveLength(1);
  });

  it('空摘要 / 非法事件丢掉，不渲染空行', () => {
    const out = filterPerceptionEvents({
      events: [eventOf({ summary: '   ' })], nowMs: NOW,
    });
    expect(out.kept).toEqual([]);
    expect(out.dropped[0].reason).toBe('invalid');
  });
});

describe('渲染：小快照 + 认知边界', () => {
  it('渲染观测/推测/虚拟三种标记，且写明不能拿天气日程断言情绪', () => {
    const block = renderPerceptionSnapshot([
      eventOf({ summary: '杭州 晴 26℃' }),
      eventOf({
        dedupeKey: 'act:1', source: 'activity', summary: '在写方案', epistemic: 'inference',
        confidence: 0.5,
      }),
      eventOf({
        dedupeKey: 'v:1', source: 'activity', summary: '下午去了书店', epistemic: 'virtual',
      }),
    ], { nowMs: NOW });
    expect(block).toContain('观测');
    expect(block).toContain('推测');
    expect(block).toContain('虚拟经历');
    expect(block).toContain('不能');
    expect(block).toContain('情绪');
  });

  it('空数组 → 空串（没感知就不硬凑一段）', () => {
    expect(renderPerceptionSnapshot([], { nowMs: NOW })).toBe('');
  });

  it('去重行只带 key/hash/时间，够下一跳比对', () => {
    const rows = perceptionDedupeRows([eventOf()]);
    expect(rows[0]).toMatchObject({ dedupeKey: 'k', valueHash: 'h1' });
    expect(Object.keys(rows[0]).sort()).toEqual(['dedupeKey', 'expiresAt', 'observedAt', 'valueHash']);
  });
});
