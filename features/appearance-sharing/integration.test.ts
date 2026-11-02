import { describe, it, expect } from 'vitest';
import {
  coerceStoredReadingStyle,
  deriveStoryReadingStyle,
  deriveDateReadingStyle,
  deriveCollaborationReadingStyle,
  resolveStoryCurrent,
  resolveDateCurrent,
  resolveCollaborationCurrent,
  shareTextStyle,
  shareSurfaceStyle,
} from './integration';
import type { ReadingStyle } from './types';

const VALID: ReadingStyle = {
  background: '#1e2321',
  foreground: '#e2e8f0',
  accent: '#6ee7b7',
  fontFamily: 'sans',
  fontSizePx: 16,
  lineHeight: 1.8,
  borderRadiusPx: 12,
};

describe('coerceStoredReadingStyle（复用包校验 API，不自造校验）', () => {
  it('有效存档原样通过', () => {
    expect(coerceStoredReadingStyle(VALID, 'story-reading')).toEqual(VALID);
  });
  it('非法颜色 / 越界数字 / 错误 target 一律丢弃（历史数据不受影响）', () => {
    expect(coerceStoredReadingStyle({ ...VALID, background: 'red' }, 'story-reading')).toBeUndefined();
    expect(coerceStoredReadingStyle({ ...VALID, fontSizePx: 99 }, 'story-reading')).toBeUndefined();
    expect(coerceStoredReadingStyle({ ...VALID }, 'date-reading')).toEqual(VALID);
    // target 不匹配的包：按包校验语义应拒绝（调用方不得把别处样式串进来）
    expect(coerceStoredReadingStyle({ ...VALID, fontFamily: 'nope' }, 'collaboration')).toBeUndefined();
  });
  it('非对象 / 自定义 CSS 直接拒绝', () => {
    expect(coerceStoredReadingStyle(null, 'story-reading')).toBeUndefined();
    expect(coerceStoredReadingStyle('x', 'story-reading')).toBeUndefined();
    expect(coerceStoredReadingStyle({ ...VALID, customCss: 'body{}' }, 'story-reading')).toBeUndefined();
  });
  it('未知多余字段被忽略（旧包/未来字段不炸）', () => {
    expect(coerceStoredReadingStyle({ ...VALID, whatever: 1 }, 'collaboration')).toEqual(VALID);
  });
});

describe('deriveStoryReadingStyle（故事 4 档与 STORY_THEME_CSS 同源）', () => {
  it('浅色两档背景/强调色与主题变量一致', () => {
    expect(deriveStoryReadingStyle('light', 'plain')).toMatchObject({
      background: '#f6f4ef',
      foreground: '#243047',
      accent: '#7c3aed',
    });
    expect(deriveStoryReadingStyle('light', 'cinema')).toMatchObject({
      background: '#faf4f0',
      accent: '#8b5cf6',
    });
  });
  it('深色两档背景/强调色与主题变量一致（含 cinema 夜空档）', () => {
    expect(deriveStoryReadingStyle('dark', 'plain')).toMatchObject({
      background: '#111519',
      foreground: '#edf1f5',
      accent: '#ad8bff',
    });
    // 深色 + 花里胡哨：--story-bg #0d1020 / --story-accent #bd9cff，不是 plain 档回落
    expect(deriveStoryReadingStyle('dark', 'cinema')).toMatchObject({
      background: '#0d1020',
      accent: '#bd9cff',
    });
  });
  it('字号/行距对齐故事正文 font-serif text-[15px] leading-8，正文无圆角', () => {
    const style = deriveStoryReadingStyle('light', 'plain');
    expect(style.fontFamily).toBe('serif');
    expect(style.fontSizePx).toBe(15);
    // 精确同源：StoryTheaterSession.tsx:224 正文 text-[15px] leading-8(32px)，行距=32/15，不四舍五入
    expect(style.lineHeight).toBe(32 / 15);
    expect(style.borderRadiusPx).toBe(0);
  });
});

describe('deriveDateReadingStyle（约会小说视图真实容器同源）', () => {
  it('浅色映射小说容器 bg-[#faf8f5] 与角色正文 text-stone-700 / 边框 stone-200', () => {
    expect(deriveDateReadingStyle(true)).toEqual({
      background: '#faf8f5',
      foreground: '#44403c',
      accent: '#e7e5e4',
      fontFamily: 'serif',
      fontSizePx: 18,
      lineHeight: 2,
      borderRadiusPx: 0,
    });
  });
  it('深色映射小说容器 bg-black/90（半透明黑）与 text-slate-200 / 边框 white/10', () => {
    expect(deriveDateReadingStyle(false)).toEqual({
      background: 'rgba(0, 0, 0, 0.9)',
      foreground: '#e2e8f0',
      accent: 'rgba(255, 255, 255, 0.1)',
      fontFamily: 'serif',
      fontSizePx: 18,
      lineHeight: 2,
      borderRadiusPx: 0,
    });
  });
});

describe('deriveCollaborationReadingStyle（六皮肤各自助手气泡同源，不再固定 sully）', () => {
  it('sully 取角色气泡默认（#fff）而非页面底（#f4f6fa）', () => {
    // 精确同源：CollaborationWindow.tsx:1213 气泡 text-[15px] leading-7(28px)，行距=28/15，不四舍五入
    expect(deriveCollaborationReadingStyle('sully')).toEqual({
      background: '#ffffff',
      foreground: '#1e293b',
      accent: '#6366f1',
      fontFamily: 'sans',
      fontSizePx: 15,
      lineHeight: 28 / 15,
      borderRadiusPx: 20,
    });
  });
  it('非 sully 各皮肤取自家 --collab-* 与气泡覆盖半径', () => {
    expect(deriveCollaborationReadingStyle('gpt')).toMatchObject({
      background: '#ffffff',
      foreground: '#0d0d0d',
      accent: '#000000',
      borderRadiusPx: 0,
      lineHeight: 1.75,
    });
    expect(deriveCollaborationReadingStyle('claude')).toMatchObject({
      background: '#f7f6f2',
      foreground: '#292522',
      accent: '#d97757',
      fontFamily: 'serif',
      fontSizePx: 15.5,
      lineHeight: 1.75,
      borderRadiusPx: 0,
    });
    expect(deriveCollaborationReadingStyle('gemini')).toMatchObject({
      background: '#ffffff',
      foreground: '#1f1f1f',
      accent: '#315ed1',
      borderRadiusPx: 0,
    });
    // kimi / deepseek 助手气泡为白色卡片（CSS 239/246），半径取自家覆盖值
    expect(deriveCollaborationReadingStyle('kimi')).toMatchObject({
      background: '#ffffff',
      foreground: '#202331',
      accent: '#2864ff',
      borderRadiusPx: 16,
    });
    expect(deriveCollaborationReadingStyle('deepseek')).toMatchObject({
      background: '#ffffff',
      foreground: '#202739',
      accent: '#4d6bfe',
      borderRadiusPx: 14,
    });
  });
  it('claude 助手字号取真实 CSS 15.5px（不是通用档 15px）', () => {
    // 反例来源：CollaborationWindow.tsx:221 claude 助手规则 font-size:15.5px；
    // 通用非 sully 档（195）为 15px，claude 档覆盖之，派生必须跟覆盖值。
    expect(deriveCollaborationReadingStyle('claude').fontSizePx).toBe(15.5);
    expect(deriveCollaborationReadingStyle('gpt').fontSizePx).toBe(15);
  });
  it('sully 自定义 theme.ai 按消费点同式派生（MessageBubble:1214-1216）', () => {
    // 反例来源：MessageBubble 实际取 theme.ai.textColor/backgroundColor/
    // opacity/borderRadius；用户自定义气泡时固定默认回落即错。
    // 注意：opacity:1 时 withAlpha 仍输出 rgba(r, g, b, 1) 形式
    //（CollaborationWindow.tsx:287，无 alpha>=1 原样返回分支），
    // 派生值与 MessageBubble 真实内联值逐字一致，浏览器 computed 同值。
    expect(
      deriveCollaborationReadingStyle('sully', {
        textColor: '#123456',
        backgroundColor: '#abcdef',
        borderRadius: 8,
        opacity: 1,
      }),
    ).toMatchObject({
      background: 'rgba(171, 205, 239, 1)',
      foreground: '#123456',
      borderRadiusPx: 8,
    });
    // 半透明定制按 withAlpha 同算法（MessageBubble 内联同款）；
    // 强调色无同源字段，保留默认并明确（见 integration.ts 注释）。
    expect(
      deriveCollaborationReadingStyle('sully', {
        textColor: '#111111',
        backgroundColor: '#ff0000',
        borderRadius: 12,
        opacity: 0.5,
      }).background,
    ).toBe('rgba(255, 0, 0, 0.5)');
    // 无定制回落默认主题
    expect(deriveCollaborationReadingStyle('sully')).toMatchObject({
      background: '#ffffff',
      foreground: '#1e293b',
      borderRadiusPx: 20,
    });
  });
  it('sully 透明度下限与 withAlpha 同源（alpha 夹到 0.18～1）', () => {
    // 反例：opacity 0.1 不能原样输出，必须与消费点 withAlpha 一致夹到 0.18。
    expect(
      deriveCollaborationReadingStyle('sully', {
        textColor: '#111111',
        backgroundColor: '#ff0000',
        borderRadius: 12,
        opacity: 0.1,
      }).background,
    ).toBe('rgba(255, 0, 0, 0.18)');
    // 空 textColor 回落默认前景；undefined 定制整体回落默认主题
    expect(
      deriveCollaborationReadingStyle('sully', {
        textColor: '',
        backgroundColor: undefined,
        borderRadius: undefined,
        opacity: undefined,
      }),
    ).toMatchObject({
      background: '#ffffff',
      foreground: '#1e293b',
      borderRadiusPx: 20,
    });
  });
  it('缺省按 sully 回落（历史数据无主题字段时）', () => {
    expect(deriveCollaborationReadingStyle()).toEqual(deriveCollaborationReadingStyle('sully'));
    expect(deriveCollaborationReadingStyle(undefined)).toEqual(deriveCollaborationReadingStyle('sully'));
  });
});

describe('resolve*Current（已保存有效值优先，否则当前真实样式）', () => {
  it('有效存档优先于主题派生', () => {
    expect(resolveStoryCurrent(VALID, 'light', 'plain')).toEqual(VALID);
    expect(resolveDateCurrent(VALID, true)).toEqual(VALID);
    expect(resolveCollaborationCurrent(VALID, 'kimi')).toEqual(VALID);
  });
  it('无存档/非法存档时回落到当前真实样式（含皮肤）', () => {
    expect(resolveStoryCurrent(undefined, 'dark', 'cinema')).toEqual(
      deriveStoryReadingStyle('dark', 'cinema'),
    );
    expect(resolveStoryCurrent({ ...VALID, accent: 'nope' }, 'light', 'plain')).toEqual(
      deriveStoryReadingStyle('light', 'plain'),
    );
    expect(resolveDateCurrent(undefined, false)).toEqual(deriveDateReadingStyle(false));
    // 切到 kimi 后不再导出 sully 默认包
    expect(resolveCollaborationCurrent(undefined, 'kimi')).toEqual(
      deriveCollaborationReadingStyle('kimi'),
    );
    expect(resolveCollaborationCurrent(undefined, 'kimi')).not.toEqual(
      deriveCollaborationReadingStyle('sully'),
    );
    expect(resolveCollaborationCurrent({ ...VALID, background: 'red' }, 'gpt')).toEqual(
      deriveCollaborationReadingStyle('gpt'),
    );
    // sully 自定义主题透传：面板调用 resolveCollaborationCurrent(saved, uiTheme, theme.ai)
    expect(
      resolveCollaborationCurrent(undefined, 'sully', {
        textColor: '#123456',
        backgroundColor: '#abcdef',
        borderRadius: 8,
        opacity: 1,
      }),
    ).toEqual(
      deriveCollaborationReadingStyle('sully', {
        textColor: '#123456',
        backgroundColor: '#abcdef',
        borderRadius: 8,
        opacity: 1,
      }),
    );
  });
});

describe('shareTextStyle / shareSurfaceStyle（七字段落到真实正文）', () => {
  it('文本四字段只用变量消费，不写全局选择器与 !important', () => {
    const css = shareTextStyle(VALID);
    expect(css.color).toBe('var(--ap-share-fg)');
    expect(css.fontFamily).toBe('var(--ap-share-font)');
    expect(css.fontSize).toBe('var(--ap-share-font-size)');
    expect(css.lineHeight).toBe('var(--ap-share-line-height)');
    for (const value of Object.values(css)) {
      expect(String(value)).not.toContain('!important');
    }
  });
  it('表面三字段覆盖背景/圆角/强调边框', () => {
    const css = shareSurfaceStyle(VALID);
    expect(css.backgroundColor).toBe('var(--ap-share-bg)');
    expect(css.borderRadius).toBe('var(--ap-share-radius)');
    expect(String(css.border)).toContain('var(--ap-share-accent)');
    expect(String(css.border)).not.toContain('!important');
  });
});
