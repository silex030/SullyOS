/**
 * 作用域样式：将共享样式写成目标根节点的行内 CSS 变量。
 *
 * 保证：
 * - 只调用 el.style.setProperty，不创建 <style> 标签，不写 document/body/:root；
 * - 变量全部带 --ap-share- 前缀，由目标区域的 CSS 按需引用；
 * - cleanup 移除本次写入的变量与标记，还原节点原状（取消语义）；
 * - 首版不支持自定义 CSS：本文件不提供任何 CSS 文本解析/注入入口。
 */

import { SHARE_FONT_STACKS, type ReadingStyle } from './types';

export const SHARE_VAR_PREFIX = '--ap-share-';

export const SHARE_VAR_NAMES = {
  bg: '--ap-share-bg',
  fg: '--ap-share-fg',
  accent: '--ap-share-accent',
  font: '--ap-share-font',
  fontSize: '--ap-share-font-size',
  lineHeight: '--ap-share-line-height',
  radius: '--ap-share-radius',
} as const;

export const SHARE_TARGET_ATTR = 'data-ap-share';

/** typed 样式 → CSS 变量表（纯函数，可单测）。 */
export function styleToVars(style: ReadingStyle): Record<string, string> {
  return {
    [SHARE_VAR_NAMES.bg]: style.background,
    [SHARE_VAR_NAMES.fg]: style.foreground,
    [SHARE_VAR_NAMES.accent]: style.accent,
    [SHARE_VAR_NAMES.font]: SHARE_FONT_STACKS[style.fontFamily],
    [SHARE_VAR_NAMES.fontSize]: `${style.fontSizePx}px`,
    [SHARE_VAR_NAMES.lineHeight]: String(style.lineHeight),
    [SHARE_VAR_NAMES.radius]: `${style.borderRadiusPx}px`,
  };
}

/**
 * 把样式变量写到目标根节点，返回 cleanup。
 * 注意：只动传入的 el；调用方负责把 el 限定在预览/目标区域内。
 */
export function applyShareVarsToElement(el: HTMLElement, style: ReadingStyle): () => void {
  const vars = styleToVars(style);
  const previous: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars)) {
    previous[name] = el.style.getPropertyValue(name);
    el.style.setProperty(name, value);
  }
  const hadAttr = el.hasAttribute(SHARE_TARGET_ATTR);
  const previousAttr = el.getAttribute(SHARE_TARGET_ATTR);
  el.setAttribute(SHARE_TARGET_ATTR, '1');
  return () => {
    for (const [name] of Object.entries(vars)) {
      const prev = previous[name];
      if (prev) el.style.setProperty(name, prev);
      else el.style.removeProperty(name);
    }
    if (hadAttr && previousAttr !== null) el.setAttribute(SHARE_TARGET_ATTR, previousAttr);
    else el.removeAttribute(SHARE_TARGET_ATTR);
  };
}
