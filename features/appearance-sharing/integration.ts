/**
 * 外观分享 · 真实 App 接线 helper（t_40feeeaa）。
 *
 * 只做三件事，不碰已验收协议本身：
 * 1. 存档校验：复用 package.ts 的真实校验 API（parseSharePackage），
 *    不自造第二套颜色/越界/自定义 CSS 判断；
 * 2. current 回落：无有效存档时，按各区域「当前真实视觉」
 *    （主题 state / 开关）派生 ReadingStyle，绝不用与视觉不一致的固定默认包；
 * 3. 正文消费：七字段 → 行内变量引用的小函数，各 App 在真实正文
 *    消费点调用（只写目标节点行内 style，不写全局 :root，不用 !important）。
 */

import type { CSSProperties } from 'react';
import { parseSharePackage } from './package';
import { SHARE_SCHEMA_VERSION, type ReadingStyle, type ShareTarget } from './types';
import type { CollaborationUiTheme } from '../collaboration/types';

/**
 * 把持久化层里的可疑值还原为有效 ReadingStyle。
 * 手法：包成最小分享包 JSON，走 parseSharePackage 真实校验；
 * target 必须匹配（防串区），失败返回 undefined，调用方保留旧值。
 */
export function coerceStoredReadingStyle(value: unknown, target: ShareTarget): ReadingStyle | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  let text: string;
  try {
    text = JSON.stringify({
      kind: 'sully-appearance-share',
      schemaVersion: SHARE_SCHEMA_VERSION,
      target,
      style: value,
      exportedAt: Date.now(),
    });
  } catch {
    return undefined;
  }
  const parsed = parseSharePackage(text);
  if (!parsed.ok) return undefined;
  if (parsed.target !== target) return undefined;
  return parsed.style;
}

/**
 * 故事当前视觉 → ReadingStyle（四档全取，缺一不可）。
 * 取值同源：STORY_THEME_CSS（components/date/story/StoryTheaterTheme.tsx）
 * light/plain --story-bg #f6f4ef / --story-accent #7c3aed；
 * light/cinema --story-bg #faf4f0 / --story-accent #8b5cf6；
 * dark/plain  --story-bg #111519 / --story-accent #ad8bff；
 * dark/cinema --story-bg #0d1020 / --story-accent #bd9cff；
 * 墨色 light #243047 / dark #edf1f5（--story-ink，经 .text-slate-800 映射后的
 * 故事正文实际颜色）。字号/行距对齐故事正文
 * `font-serif text-[15px] leading-8`（32px/15px，精确 32/15，不四舍五入）；故事正文/article 无圆角，
 * 回落半径取 0（与无覆盖 computed 一致，导出即应用不变色不变形）。
 */
export function deriveStoryReadingStyle(color: 'light' | 'dark', decor: 'plain' | 'cinema'): ReadingStyle {
  const background =
    color === 'dark' ? (decor === 'cinema' ? '#0d1020' : '#111519') : decor === 'cinema' ? '#faf4f0' : '#f6f4ef';
  const accent =
    color === 'dark' ? (decor === 'cinema' ? '#bd9cff' : '#ad8bff') : decor === 'cinema' ? '#8b5cf6' : '#7c3aed';
  return {
    background,
    foreground: color === 'dark' ? '#edf1f5' : '#243047',
    accent,
    fontFamily: 'serif',
    fontSizePx: 15,
    lineHeight: 32 / 15,
    borderRadiusPx: 0,
  };
}

/**
 * 约会小说视图当前视觉 → ReadingStyle。
 * 取值同源：DateSession 小说容器与角色正文两处真实消费点——
 * 浅色：容器 `bg-[#faf8f5]` / 正文 `text-stone-700`(#44403c) / 正文边框
 * `border-stone-200`(#e7e5e4)；深色：容器 `bg-black/90`（computed
 * `rgba(0, 0, 0, 0.9)`）/ 正文 `text-slate-200`(#e2e8f0) / 边框
 * `border-white/10`（computed `rgba(255, 255, 255, 0.1)`）；强调色取正文
 * 边框色（分享生效时正文边框即用该色），非臆造的品牌色。
 * 字号对齐角色正文 text-[18px]，行距 leading-loose（2）；小说正文无圆角，
 * 回落半径取 0。
 */
export function deriveDateReadingStyle(light: boolean): ReadingStyle {
  return light
    ? {
        background: '#faf8f5',
        foreground: '#44403c',
        accent: '#e7e5e4',
        fontFamily: 'serif',
        fontSizePx: 18,
        lineHeight: 2,
        borderRadiusPx: 0,
      }
    : {
        background: 'rgba(0, 0, 0, 0.9)',
        foreground: '#e2e8f0',
        accent: 'rgba(255, 255, 255, 0.1)',
        fontFamily: 'serif',
        fontSizePx: 18,
        lineHeight: 2,
        borderRadiusPx: 0,
      };
}

/**
 * 协作当前视觉 → ReadingStyle（按皮肤逐档派生，禁止固定 sully）。
 * 取值同源：COLLABORATION_UI_THEME_CSS 各皮肤 `--collab-*` 变量与气泡覆盖
 * 规则（195 通用档 / 239 kimi / 246 deepseek）+ sully 默认气泡
 * （ThemeMaker ai：背景 #fff / 圆角 20）+ claude 助手衬线档
 * （CollaborationWindow.tsx:221 font-size:15.5px，Georgia 衬线）。
 * 背景取“助手气泡”可视底：sully #ffffff（角色气泡默认，不是页面底
 * #f4f6fa）；gpt/gemini 助手透明→线程底 #ffffff；claude 助手透明→暖纸底
 * #f7f6f2；kimi/deepseek 助手为白色卡片 #ffffff。
 * 前景取各皮肤 --collab-ink；强调取各皮肤 --collab-accent；字号/行距对齐
 * 气泡（sully text-[15px] leading-7，即 28px/15px，精确 28/15，不四舍五入；非 sully 覆盖档 15px/1.75，
 * 唯 claude 助手档为 15.5px）；圆角取助手气泡覆盖半径
 * （sully 20 / gpt-claude-gemini 0 / kimi 16 / deepseek 14）；
 * 字体 claude 助手为 Georgia 衬线（CSS 221），其余 sans。
 * sully 档若传入真实 theme.ai 定制（textColor/backgroundColor/opacity/
 * borderRadius），背景/前景/圆角按 MessageBubble:1214-1216 同式派生
 * （withAlpha 同算法），无定制时回落默认主题值；强调色无同源字段，
 * 保留默认 #6366f1 并在注释中明确。
 */
export interface SullyAiBubbleOverride {
  textColor?: string;
  backgroundColor?: string;
  borderRadius?: number;
  opacity?: number;
}

function applyBubbleOpacity(backgroundColor: string | undefined, opacity: number | undefined, fallback: string): string {
  // 与 CollaborationWindow.tsx:287 withAlpha 逐字同算法（含 alpha>=1 仍输出
  // rgba(r, g, b, 1) 的形式），保证派生值与 MessageBubble 真实内联值一致。
  if (!backgroundColor) return fallback;
  const hex = backgroundColor.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!hex) return backgroundColor;
  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${Math.max(0.18, Math.min(1, opacity ?? 1))})`;
}

export function deriveCollaborationReadingStyle(
  uiTheme: CollaborationUiTheme = 'sully',
  sullyAi?: SullyAiBubbleOverride,
): ReadingStyle {
  switch (uiTheme) {
    case 'gpt':
      return {
        background: '#ffffff',
        foreground: '#0d0d0d',
        accent: '#000000',
        fontFamily: 'sans',
        fontSizePx: 15,
        lineHeight: 1.75,
        borderRadiusPx: 0,
      };
    case 'claude':
      return {
        background: '#f7f6f2',
        foreground: '#292522',
        accent: '#d97757',
        fontFamily: 'serif',
        // 真实值：CollaborationWindow.tsx:221 claude 助手规则 font-size:15.5px
        //（通用非 sully 档 15px 被该规则覆盖）；字号为有限范围 number，允许小数。
        fontSizePx: 15.5,
        lineHeight: 1.75,
        borderRadiusPx: 0,
      };
    case 'gemini':
      return {
        background: '#ffffff',
        foreground: '#1f1f1f',
        accent: '#315ed1',
        fontFamily: 'sans',
        fontSizePx: 15,
        lineHeight: 1.75,
        borderRadiusPx: 0,
      };
    case 'kimi':
      return {
        background: '#ffffff',
        foreground: '#202331',
        accent: '#2864ff',
        fontFamily: 'sans',
        fontSizePx: 15,
        lineHeight: 1.75,
        borderRadiusPx: 16,
      };
    case 'deepseek':
      return {
        background: '#ffffff',
        foreground: '#202739',
        accent: '#4d6bfe',
        fontFamily: 'sans',
        fontSizePx: 15,
        lineHeight: 1.75,
        borderRadiusPx: 14,
      };
    case 'sully':
    default: {
      // 有真实 theme.ai 定制时按消费点同式派生（MessageBubble:1214-1216）：
      // 前景取 ai.textColor（空回落 #1e293b），背景取 withAlpha 同算法
      // （ai.backgroundColor + ai.opacity，下限 0.18），圆角取 ai.borderRadius；
      // 无定制回落默认主题（makers 默认 ai / bubbleSchema）。
      // 调用方 ApiSettingsPanel:635 已传入真实 theme.ai。
      const foreground = sullyAi?.textColor || '#1e293b';
      const background = applyBubbleOpacity(sullyAi?.backgroundColor, sullyAi?.opacity, '#ffffff');
      const borderRadiusPx = sullyAi?.borderRadius ?? 20;
      return {
        background,
        foreground,
        accent: '#6366f1',
        fontFamily: 'sans',
        fontSizePx: 15,
        lineHeight: 28 / 15,
        borderRadiusPx,
      };
    }
  }
}

/** 面板 current：已保存有效值优先，否则当前真实视觉。 */
export function resolveStoryCurrent(
  saved: unknown,
  color: 'light' | 'dark',
  decor: 'plain' | 'cinema',
): ReadingStyle {
  return coerceStoredReadingStyle(saved, 'story-reading') ?? deriveStoryReadingStyle(color, decor);
}

export function resolveDateCurrent(saved: unknown, light: boolean): ReadingStyle {
  return coerceStoredReadingStyle(saved, 'date-reading') ?? deriveDateReadingStyle(light);
}

export function resolveCollaborationCurrent(
  saved: unknown,
  uiTheme: CollaborationUiTheme = 'sully',
  sullyAi?: SullyAiBubbleOverride,
): ReadingStyle {
  return coerceStoredReadingStyle(saved, 'collaboration') ?? deriveCollaborationReadingStyle(uiTheme, sullyAi);
}

/** 正文文本四字段：只引用变量，调用方在真实消费点以行内 style 生效。 */
export function shareTextStyle(_style: ReadingStyle): CSSProperties {
  void _style;
  return {
    color: 'var(--ap-share-fg)',
    fontFamily: 'var(--ap-share-font)',
    fontSize: 'var(--ap-share-font-size)',
    lineHeight: 'var(--ap-share-line-height)',
  };
}

/**
 * 正文表面三字段：背景 + 圆角 + 强调边框。
 * 边框写法与模块 preview 自带惯用法一致
 * （SharePanel 预览：`1px solid var(--ap-share-accent, …)`）。
 */
export function shareSurfaceStyle(_style: ReadingStyle): CSSProperties {
  void _style;
  return {
    backgroundColor: 'var(--ap-share-bg)',
    borderRadius: 'var(--ap-share-radius)',
    border: '1px solid var(--ap-share-accent)',
  };
}
