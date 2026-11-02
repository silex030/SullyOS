// @vitest-environment jsdom

// 作用域测试 —— 钉住两件事：
//   1. 共享样式只写目标根节点的行内 CSS 变量，绝不碰 body/:root/document；
//   2. 取消（cleanup）后目标节点恢复原状，不残留变量。

import { describe, it, expect } from 'vitest';
import { styleToVars, applyShareVarsToElement, SHARE_VAR_PREFIX } from './scopedStyle';
import type { ReadingStyle } from './types';

const STYLE: ReadingStyle = {
  background: '#1e2321',
  foreground: '#e2e8f0',
  accent: '#6ee7b7',
  fontFamily: 'sans',
  fontSizePx: 16,
  lineHeight: 1.8,
  borderRadiusPx: 12,
};

describe('scoped style', () => {
  it('变量名全部带 --ap-share- 前缀', () => {
    const vars = styleToVars(STYLE);
    for (const key of Object.keys(vars)) {
      expect(key.startsWith(SHARE_VAR_PREFIX)).toBe(true);
    }
    expect(vars['--ap-share-bg']).toBe('#1e2321');
  });

  it('只作用目标根节点：body 与 documentElement 无残留', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const cleanup = applyShareVarsToElement(target, STYLE);
    expect(target.style.getPropertyValue('--ap-share-bg')).toBe('#1e2321');
    expect(target.getAttribute('data-ap-share')).toBeTruthy();
    expect(document.body.style.getPropertyValue('--ap-share-bg')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--ap-share-bg')).toBe('');
    expect(document.querySelectorAll('style[data-ap-share]').length).toBe(0);
    cleanup();
    expect(target.style.getPropertyValue('--ap-share-bg')).toBe('');
    target.remove();
  });

  it('cleanup 还原目标节点原有行内样式', () => {
    const target = document.createElement('div');
    target.style.color = 'red';
    document.body.appendChild(target);
    const cleanup = applyShareVarsToElement(target, STYLE);
    cleanup();
    expect(target.style.color).toBe('red');
    expect(target.hasAttribute('data-ap-share')).toBe(false);
    target.remove();
  });
});
