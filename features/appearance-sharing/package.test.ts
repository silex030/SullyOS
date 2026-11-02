import { describe, it, expect } from 'vitest';
import { buildSharePackage, parseSharePackage, MAX_SHARE_PACKAGE_BYTES } from './package';
import type { ReadingStyle } from './types';

const BASE_STYLE: ReadingStyle = {
  background: '#1e2321',
  foreground: '#e2e8f0',
  accent: '#6ee7b7',
  fontFamily: 'sans',
  fontSizePx: 16,
  lineHeight: 1.8,
  borderRadiusPx: 12,
};

describe('appearance-share package roundtrip', () => {
  it('build → JSON → parse 还原出同样的样式', () => {
    const built = buildSharePackage(BASE_STYLE, 'collaboration', '我的协作皮肤');
    const text = JSON.stringify(built);
    const parsed = parseSharePackage(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.style).toEqual(BASE_STYLE);
      expect(parsed.target).toBe('collaboration');
    }
  });

  it('损坏的 JSON 给出中文错误且不返回样式', () => {
    const parsed = parseSharePackage('{not json');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/JSON|解析/);
      expect(parsed.style).toBeUndefined();
    }
  });

  it('超大包被拒绝且给出中文错误', () => {
    const big = 'x'.repeat(MAX_SHARE_PACKAGE_BYTES + 1);
    const parsed = parseSharePackage(big);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/过大|太大|上限/);
  });

  it('未知 schemaVersion 被拒绝', () => {
    const built: any = buildSharePackage(BASE_STYLE, 'story-reading');
    built.schemaVersion = 999;
    const parsed = parseSharePackage(JSON.stringify(built));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/版本/);
  });

  it('错误的 kind 被拒绝', () => {
    const parsed = parseSharePackage(JSON.stringify({ kind: 'sully_appearance_preset', schemaVersion: 1 }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/外观|类型|kind/);
  });

  it('非法 target 被拒绝', () => {
    const built: any = buildSharePackage(BASE_STYLE, 'collaboration');
    built.target = 'epub-reader';
    const parsed = parseSharePackage(JSON.stringify(built));
    expect(parsed.ok).toBe(false);
  });
});

describe('appearance-share 脱敏与白名单', () => {
  it('未知字段/敏感字段被过滤，不进入样式', () => {
    const dirty = {
      ...buildSharePackage(BASE_STYLE, 'date-reading'),
      style: {
        ...BASE_STYLE,
        apiKey: 'sk-secret',
        session: 'sess-123',
        token: 'tok',
        chatContent: 'hello',
        wallpaper: 'blob:...',
      },
    };
    const parsed = parseSharePackage(JSON.stringify(dirty));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.style).toEqual(BASE_STYLE);
      expect(parsed.style as any).not.toHaveProperty('apiKey');
      expect(parsed.style as any).not.toHaveProperty('wallpaper');
    }
  });

  it('包内带自定义 CSS 被明确拒绝并指引原路径', () => {
    const dirty: any = buildSharePackage(BASE_STYLE, 'date-reading');
    dirty.style = { ...BASE_STYLE, customCss: 'body{display:none}' };
    const parsed = parseSharePackage(JSON.stringify(dirty));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/自定义 CSS|原设置/);
  });

  it('原型污染键不会污染 Object.prototype', () => {
    const evil = `{"kind":"sully-appearance-share","schemaVersion":1,"target":"collaboration","style":{"background":"#ffffff","foreground":"#1f2937","accent":"#0f766e","fontFamily":"sans","fontSizePx":16,"lineHeight":1.8,"borderRadiusPx":12,"__proto__":{"polluted":true}},"exportedAt":1}`;
    const parsed = parseSharePackage(evil);
    expect((Object.prototype as any).polluted).toBeUndefined();
    expect(parsed.ok).toBe(true);
    delete (Object.prototype as any).polluted;
  });

  it('非法颜色/越界数字被拒绝或钳制', () => {
    const bad: any = buildSharePackage(BASE_STYLE, 'collaboration');
    bad.style = { ...BASE_STYLE, background: 'javascript:alert(1)', fontSizePx: 999, lineHeight: 0.1, borderRadiusPx: -5 };
    const parsed = parseSharePackage(JSON.stringify(bad));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/颜色|字号|行距|圆角/);
  });
});

describe('appearance-share 导入边界（返工回归：永不抛出）', () => {
  it('schemaVersion 为 toString=null 的对象时不抛出，给中文版本错误', () => {
    const evil: any = buildSharePackage(BASE_STYLE, 'collaboration');
    evil.schemaVersion = { toString: null };
    let parsed: any;
    expect(() => {
      parsed = parseSharePackage(JSON.stringify(evil));
    }).not.toThrow();
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/版本/);
    expect(parsed.style).toBeUndefined();
  });

  it('schemaVersion 为字符串/undefined 时不抛出，给中文版本错误', () => {
    for (const v of ['1', undefined, null, [1], { version: 1 }]) {
      const evil: any = buildSharePackage(BASE_STYLE, 'collaboration');
      evil.schemaVersion = v;
      let parsed: any;
      expect(() => {
        parsed = parseSharePackage(JSON.stringify(evil));
      }).not.toThrow();
      expect(parsed.ok).toBe(false);
    }
  });

  it('style 内 12000 层深数组（总包<64KB）不栈溢出、不抛出，给中文错误', () => {
    // 手工拼接 JSON 文本：避免测试自身的 JSON.stringify 先爆栈，
    // 文本本身合法但嵌套 12000 层（总包远小于 64KB）。
    const head = '{"kind":"sully-appearance-share","schemaVersion":1,"target":"story-reading","style":{"background":"#ffffff","foreground":"#1f2937","accent":"#0f766e","fontFamily":"sans","fontSizePx":16,"lineHeight":1.8,"borderRadiusPx":12,"ignored":';
    const depth = 12000;
    const text = head + '['.repeat(depth) + '0' + ']'.repeat(depth) + '},"exportedAt":1}';
    expect(text.length).toBeLessThan(MAX_SHARE_PACKAGE_BYTES);
    expect(new TextEncoder().encode(text).length).toBeLessThan(MAX_SHARE_PACKAGE_BYTES);
    let parsed: any;
    expect(() => {
      parsed = parseSharePackage(text);
    }).not.toThrow();
    // 白名单浅读直接忽略未知深层字段：合法包仍通过，无栈溢出、无抛出
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.style.background).toBe('#ffffff');
      expect(parsed.style).not.toHaveProperty('ignored');
    }
  });

  it('中等深度未知字段（50 层，可解析）被忽略、合法包仍通过', () => {
    let nested: unknown = 0;
    for (let i = 0; i < 50; i++) nested = [nested];
    const evil: any = buildSharePackage(BASE_STYLE, 'date-reading');
    evil.style = { ...BASE_STYLE, ignored: nested };
    let parsed: any;
    expect(() => {
      parsed = parseSharePackage(JSON.stringify(evil));
    }).not.toThrow();
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.style).toEqual(BASE_STYLE);
  });

  it('含 30000 个“中”的未知字段包按 UTF-8 字节超 64KB 被拒绝', () => {
    const evil: any = buildSharePackage(BASE_STYLE, 'collaboration');
    evil.style = { ...BASE_STYLE, note: '中'.repeat(30000) };
    const text = JSON.stringify(evil);
    const byteLen = new TextEncoder().encode(text).length;
    expect(byteLen).toBeGreaterThan(MAX_SHARE_PACKAGE_BYTES);
    expect(text.length).toBeLessThan(MAX_SHARE_PACKAGE_BYTES);
    const parsed = parseSharePackage(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/过大|上限/);
    expect(parsed.style).toBeUndefined();
  });

  it('非字符串输入一律中文失败、不抛出', () => {
    for (const v of [null, undefined, 123, {}, ['x'], Object.create(null)]) {
      let parsed: any;
      expect(() => {
        parsed = parseSharePackage(v as any);
      }).not.toThrow();
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(typeof parsed.error).toBe('string');
    }
  });
});
