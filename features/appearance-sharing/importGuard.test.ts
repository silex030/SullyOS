import { describe, it, expect } from 'vitest';
import { assertNoIllegalDateReadingStyle, findIllegalDateReadingStyle } from './importGuard';
import type { ReadingStyle } from './types';

const VALID: ReadingStyle = {
  background: 'rgba(0, 0, 0, 0.9)',
  foreground: '#e2e8f0',
  accent: 'rgba(255, 255, 255, 0.1)',
  fontFamily: 'serif',
  fontSizePx: 18,
  lineHeight: 2,
  borderRadiusPx: 0,
};

describe('assertNoIllegalDateReadingStyle（DB/OSContext 共用纯预检）', () => {
  it('有效样式通过，无字段旧包与空数组照常通过', () => {
    expect(() =>
      assertNoIllegalDateReadingStyle({ characters: [{ id: 'a', dateReadingStyle: { ...VALID } }] }),
    ).not.toThrow();
    expect(() => assertNoIllegalDateReadingStyle({ characters: [{ id: 'b' }] })).not.toThrow();
    expect(() => assertNoIllegalDateReadingStyle({ characters: [] })).not.toThrow();
    expect(() => assertNoIllegalDateReadingStyle({})).not.toThrow();
    expect(() => assertNoIllegalDateReadingStyle(null)).not.toThrow();
  });
  it('显式 null 即非法整包拒绝（字段缺席才兼容旧包）', () => {
    // 只有「没有 dateReadingStyle 字段」的旧包才放行；字段在却为 null 与其他非法值同等拒绝。
    const data = { characters: [{ id: 'a', dateReadingStyle: null }] };
    expect(findIllegalDateReadingStyle(data)).toEqual({ index: 0, id: 'a' });
    expect(() => assertNoIllegalDateReadingStyle(data)).toThrow(/约会阅读样式/);
    // 缺字段旧包照常通过（与首个用例的 id 'b' 互补，此处单列最小断言）
    expect(() => assertNoIllegalDateReadingStyle({ characters: [{ id: 'b' }] })).not.toThrow();
  });
  it('非法颜色整包拒绝并报中文错，定位到条目', () => {
    const data = { characters: [{ id: 'bad-1', dateReadingStyle: { ...VALID, background: 'red' } }] };
    expect(findIllegalDateReadingStyle(data)).toEqual({ index: 0, id: 'bad-1' });
    expect(() => assertNoIllegalDateReadingStyle(data)).toThrow(/约会阅读样式/);
  });
  it('越界数字整包拒绝', () => {
    const data = { characters: [{ id: 'ok' }, { id: 'bad-2', dateReadingStyle: { ...VALID, fontSizePx: 99 } }] };
    expect(findIllegalDateReadingStyle(data)).toEqual({ index: 1, id: 'bad-2' });
    expect(() => assertNoIllegalDateReadingStyle(data)).toThrow(/约会阅读样式/);
  });
  it('非法字体族同样拒绝，不静默入库', () => {
    // 包合同仅允许预设字体类别（sans/serif/rounded/mono），未知值整包拒绝。
    const data = { characters: [{ id: 'x', dateReadingStyle: { ...VALID, fontFamily: 'nope' } }] };
    expect(() => assertNoIllegalDateReadingStyle(data)).toThrow(/约会阅读样式/);
  });
});
