import { describe, expect, it } from 'vitest';

import {
  normalizePersonaSignal,
  personaHashOf,
  personaSignalIsEmpty,
  scheduleTextFromScene,
  scheduleTextFromSlots,
  sleepWindowFromScene,
  sleepWindowFromSlots,
} from './personaSignal';

describe('真实人设信号：规范化与身份哈希', () => {
  it('空/非字符串输入 → 空信号（没有信号就是没有，不编）', () => {
    expect(normalizePersonaSignal(null)).toEqual({ personaText: '', scheduleText: '', city: '', sleepWindow: null });
    expect(normalizePersonaSignal({ personaText: 42, scheduleText: {}, city: [], sleepWindow: { start: 'x', end: 'y' } })).toEqual({
      personaText: '', scheduleText: '', city: '', sleepWindow: null,
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
    expect(personaHashOf('char-1', normalizePersonaSignal({}))).toBe('char-1:fallback');
    // 只有城市变化不算人设变化（城市不参与作息）。
    expect(personaHashOf('char-1', normalizePersonaSignal({ personaText: 'x', city: '北京' })))
      .toBe(personaHashOf('char-1', normalizePersonaSignal({ personaText: 'x', city: '上海' })));
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

describe('日程 → 睡眠窗（结构化，不是「第一段时间范围」）', () => {
  it('只有工作/起床的日程不产生睡眠窗（09:00 上班不会被当成睡觉）', () => {
    const slots = [
      { startTime: '07:00', activity: '起床洗漱' },
      { startTime: '09:00', activity: '上班' },
      { startTime: '18:00', activity: '下班' },
    ];
    expect(sleepWindowFromSlots(slots)).toBeNull();
    const text = scheduleTextFromSlots(slots);
    expect(text).not.toContain('睡觉');
    expect(text.startsWith('07:00-09:00 起床洗漱')).toBe(true);
  });

  it('午间休息 + 夜间睡觉：取夜间那段，午休绝不抢整夜睡眠', () => {
    const slots = [
      { startTime: '07:00', activity: '起床' },
      { startTime: '09:00', activity: '上班' },
      { startTime: '12:00', activity: '午休' },
      { startTime: '18:00', activity: '下班' },
      { startTime: '23:30', activity: '睡觉' },
    ];
    expect(sleepWindowFromSlots(slots)).toEqual({ start: '23:30', end: '07:00' });
    const text = scheduleTextFromSlots(slots);
    expect(text.startsWith('23:30-07:00 睡觉')).toBe(true);
    expect(text).toContain('12:00-18:00 午休');
  });

  it('只有午休/休息、没有夜间睡觉 → 不硬造睡眠窗', () => {
    expect(sleepWindowFromSlots([
      { startTime: '07:00', activity: '起床' },
      { startTime: '12:00', activity: '午休' },
      { startTime: '13:00', activity: '上班' },
      { startTime: '15:00', activity: '休息一下' },
    ])).toBeNull();
  });

  it('真正的跨午夜睡眠：22:00 睡觉 → 次日 07:00 起床', () => {
    expect(sleepWindowFromSlots([
      { startTime: '22:00', activity: '睡觉' },
      { startTime: '07:00', activity: '起床' },
    ])).toEqual({ start: '22:00', end: '07:00' });
  });

  it('夜里只写了「休息」可以当睡眠；白天「休息」不行；不足 1 小时不行', () => {
    expect(sleepWindowFromSlots([
      { startTime: '02:00', activity: '休息' },
      { startTime: '09:00', activity: '上班' },
    ])).toEqual({ start: '02:00', end: '09:00' });
    expect(sleepWindowFromSlots([
      { startTime: '14:00', activity: '休息' },
      { startTime: '18:00', activity: '下班' },
    ])).toBeNull();
    expect(sleepWindowFromSlots([
      { startTime: '09:00', activity: '上班' },
      { startTime: '12:00', activity: '睡觉' },
      { startTime: '12:30', activity: '午饭' },
    ])).toBeNull();
  });

  it('scene 的睡眠窗与日程文本共用同一条跨天门槛', () => {
    const scene = {
      dateKey: '2026-10-24',
      schedule: { slots: [{ startTime: '23:30', activity: '睡觉' }, { startTime: '07:00', activity: '起床' }] },
    };
    expect(sleepWindowFromScene(scene, '2026-10-24')).toEqual({ start: '23:30', end: '07:00' });
    expect(sleepWindowFromScene(scene, '2026-10-23')).toBeNull();
    expect(sleepWindowFromScene(null, '2026-10-24')).toBeNull();
  });
});
