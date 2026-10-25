import { describe, expect, it } from 'vitest';

import {
  normalizePersonaSignal,
  personaHashOf,
  personaSignalIsEmpty,
  scheduleTextFromScene,
  scheduleTextFromSlots,
} from './personaSignal';

describe('真实人设信号：规范化与身份哈希', () => {
  it('空/非字符串输入 → 空信号（没有信号就是没有，不编）', () => {
    expect(normalizePersonaSignal(null)).toEqual({ personaText: '', scheduleText: '', city: '' });
    expect(normalizePersonaSignal({ personaText: 42, scheduleText: {}, city: [] })).toEqual({
      personaText: '', scheduleText: '', city: '',
    });
    expect(personaSignalIsEmpty(normalizePersonaSignal(null))).toBe(true);
  });

  it('超长文本按 rhythm 的口径截断，城市只留短标签', () => {
    const signal = normalizePersonaSignal({
      personaText: '人'.repeat(5000),
      scheduleText: '事'.repeat(2500),
      city: '  北京市朝阳区某某街道某某小区  ',
    });
    expect(signal.personaText.length).toBe(4000);
    expect(signal.scheduleText.length).toBe(2000);
    expect(signal.city).toBe('北京市朝阳区某某街道某某小区'.slice(0, 20));
  });

  it('人设哈希只在真实文本变化时变；没有文本时明确标 fallback', () => {
    const a = { personaText: '早睡早起', scheduleText: '', city: '' };
    const b = { personaText: '早睡早起', scheduleText: '', city: '' };
    const c = { personaText: '经常熬夜', scheduleText: '', city: '' };
    expect(personaHashOf('char-1', a)).toBe(personaHashOf('char-1', b));
    expect(personaHashOf('char-1', a)).not.toBe(personaHashOf('char-1', c));
    expect(personaHashOf('char-1', { personaText: '', scheduleText: '', city: '' })).toBe('char-1:fallback');
    // 只有城市变化不算人设变化（城市不参与作息）。
    expect(personaHashOf('char-1', { personaText: 'x', scheduleText: '', city: '北京' }))
      .toBe(personaHashOf('char-1', { personaText: 'x', scheduleText: '', city: '上海' }));
  });
});

describe('真实日程 → rhythm 能读的日程文本', () => {
  it('把「睡觉」时段显式放到最前（跨零点结束 = 次日第一条的开始）', () => {
    const text = scheduleTextFromSlots([
      { startTime: '09:00', activity: '公司例会' },
      { startTime: '23:30', activity: '睡觉' },
      { startTime: '12:00', activity: '午饭' },
      { startTime: '07:00', activity: '起床洗漱' },
    ]);
    // rhythm 只认第一段 HH:mm-HH:mm 为睡眠窗：必须是「睡觉」，不能是「起床洗漱」。
    expect(text.startsWith('23:30-07:00 睡觉')).toBe(true);
    expect(text).toContain('09:00-12:00 公司例会');
    expect(text).toContain('12:00-23:30 午饭');
    expect(text).toContain('07:00-09:00 起床洗漱');
  });

  it('丢弃非法/空/超长活动，同开始时间只留第一条', () => {
    const text = scheduleTextFromSlots([
      { startTime: '9:00', activity: '上班' },
      { startTime: '09:00', activity: '另一个上班' },
      { startTime: '25:00', activity: '不存在' },
      { startTime: '10:00', activity: '   ' },
      { startTime: '11:00', activity: '很'.repeat(41) },
    ]);
    expect(text.match(/上班/g)?.length).toBe(1);
    expect(text).not.toContain('不存在');
    expect(text).not.toContain('很很');
  });

  it('没有可用 slot → 空串（不硬造一份作息）', () => {
    expect(scheduleTextFromSlots(null)).toBe('');
    expect(scheduleTextFromSlots([])).toBe('');
    expect(scheduleTextFromSlots([{ activity: '睡觉' }])).toBe('');
  });

  it('跨天日程整段不用（dateKey 不等于今天）', () => {
    const scene = { dateKey: '2026-10-23', schedule: { slots: [{ startTime: '23:30', activity: '睡觉' }] } };
    expect(scheduleTextFromScene(scene, '2026-10-24')).toBe('');
    expect(scheduleTextFromScene(scene, '2026-10-23')).toContain('睡觉');
    expect(scheduleTextFromScene(null, '2026-10-24')).toBe('');
  });
});
