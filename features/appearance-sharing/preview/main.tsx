/**
 * 外观分享独立预览 harness（验证用，不改主网页路由）。
 *
 * 本文件直接挂载真实 `SharePanel`，并复用真实 `package` / `scopedStyle` 模块，
 * 不重复实现任何解析/校验/变量逻辑。构建产物仅供真实浏览器走查：
 * 导出→改包→文件选择导入→预览→取消/应用、错误、隔离、零外部请求。
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { SharePanel, type SharePanelApi } from '../SharePanel';
import type { ReadingStyle, ShareTarget } from '../types';
import { SHARE_VAR_NAMES } from '../scopedStyle';

const TARGETS: ShareTarget[] = ['collaboration', 'story-reading', 'date-reading'];

const TARGET_LABEL: Record<ShareTarget, string> = {
  collaboration: '协作界面',
  'story-reading': '故事阅读',
  'date-reading': '约会阅读',
};

const DEFAULTS: Record<ShareTarget, ReadingStyle> = {
  collaboration: {
    background: '#f4ecd8',
    foreground: '#3f3428',
    accent: '#0f766e',
    fontFamily: 'serif',
    fontSizePx: 15,
    lineHeight: 1.7,
    borderRadiusPx: 8,
  },
  'story-reading': {
    background: '#faf7f0',
    foreground: '#292524',
    accent: '#7c3aed',
    fontFamily: 'serif',
    fontSizePx: 16,
    lineHeight: 1.9,
    borderRadiusPx: 10,
  },
  'date-reading': {
    background: '#1e2321',
    foreground: '#e2e8f0',
    accent: '#6ee7b7',
    fontFamily: 'sans',
    fontSizePx: 16,
    lineHeight: 1.8,
    borderRadiusPx: 12,
  },
};

/** 页面级外部请求计数（harness 自带，不进交付模块）。 */
const externalRequests: string[] = [];
function armRequestTracking(): void {
  try {
    const origFetch = window.fetch.bind(window);
    window.fetch = ((...args: Parameters<typeof fetch>) => {
      try {
        const url = String(args[0]);
        if (/^https?:\/\//i.test(url)) externalRequests.push(`fetch:${url}`);
      } catch {
        /* 忽略记录失败 */
      }
      return origFetch(...args);
    }) as typeof fetch;
    const OrigXHR = window.XMLHttpRequest;
    (window as unknown as Record<string, unknown>).XMLHttpRequest = function (
      this: XMLHttpRequest,
    ): XMLHttpRequest {
      const xhr = new OrigXHR();
      const origOpen = xhr.open.bind(xhr);
      (xhr.open as unknown) = (
        method: string,
        url: string | URL,
        ...rest: unknown[]
      ) => {
        try {
          const s = String(url);
          if (/^https?:\/\//i.test(s)) externalRequests.push(`xhr:${method} ${s}`);
        } catch {
          /* 忽略记录失败 */
        }
        return (origOpen as (...a: unknown[]) => unknown)(method, url, ...rest);
      };
      return xhr;
    } as unknown as typeof XMLHttpRequest;
  } catch {
    /* 跟踪装不上也不影响走查 */
  }
}

function readPollution(): { ok: boolean; details: string } {
  const bad: string[] = [];
  const varNames = Object.values(SHARE_VAR_NAMES);
  const body = document.body as HTMLElement;
  const root = document.documentElement as HTMLElement;
  for (const v of varNames) {
    if (body.style.getPropertyValue(v)) bad.push(`body:${v}`);
    if (root.style.getPropertyValue(v)) bad.push(`:root:${v}`);
  }
  const injected = document.querySelectorAll('style[data-ap-share]').length;
  if (injected > 0) bad.push(`style[data-ap-share]:${injected}`);
  const adjacent = document.querySelector('[data-testid="ap-share-adjacent"]') as HTMLElement | null;
  if (adjacent) {
    for (const v of varNames) {
      if (adjacent.style.getPropertyValue(v)) bad.push(`adjacent:${v}`);
    }
  }
  return bad.length === 0
    ? { ok: true, details: '通过：body/:root/相邻节点无残留，无注入的 <style>' }
    : { ok: false, details: `污染：${bad.join(', ')}` };
}

function readResourceRequests(): string[] {
  try {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const origin = window.location.origin;
    return entries
      .map((e) => e.name)
      // 只统计真正的外部请求：同源（本地验证服务）与 blob:/data: 不算。
      .filter((n) => /^https?:\/\//i.test(n) && !n.startsWith(origin) && !/^(https?:\/\/(localhost|127\.0\.0\.1))([\/?:#]|$)/i.test(n));
  } catch {
    return [];
  }
}

declare global {
  interface Window {
    __apHarness?: {
      setTarget: (t: ShareTarget) => void;
      getTarget: () => ShareTarget;
      getCurrent: () => ReadingStyle;
      getApplied: () => { target: ShareTarget; style: ReadingStyle } | null;
      exportText: () => string;
      importText: (text: string) => { ok: boolean; error?: string };
      apply: () => void;
      cancel: () => void;
      previewVars: () => Record<string, string>;
      computedBorderRadius: () => string;
      computedFontSize: () => string;
      errorText: () => string;
      pollution: () => { ok: boolean; details: string };
      requests: () => { wrapped: string[]; resources: string[] };
    };
  }
}

function Harness(): React.ReactElement {
  const [target, setTarget] = React.useState<ShareTarget>('story-reading');
  const [currents, setCurrents] = React.useState<Record<ShareTarget, ReadingStyle>>(DEFAULTS);
  const [applied, setApplied] = React.useState<{ target: ShareTarget; style: ReadingStyle } | null>(
    null,
  );
  const apiRef = React.useRef<SharePanelApi | null>(null);

  React.useEffect(() => {
    window.__apHarness = {
      setTarget,
      getTarget: () => target,
      getCurrent: () => currents[target],
      getApplied: () => applied,
      exportText: () => (apiRef.current ? apiRef.current.exportJson() : ''),
      importText: (text: string) => {
        if (!apiRef.current) return { ok: false, error: '面板未挂载' };
        const r = apiRef.current.importJsonText(text);
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      },
      apply: () => apiRef.current?.apply(),
      cancel: () => apiRef.current?.cancel(),
      previewVars: () => {
        const el = document.querySelector(
          '[data-testid="ap-share-preview-target"]',
        ) as HTMLElement | null;
        const out: Record<string, string> = {};
        if (el) {
          for (const v of Object.values(SHARE_VAR_NAMES)) out[v] = el.style.getPropertyValue(v);
        }
        return out;
      },
      computedBorderRadius: () => {
        const el = document.querySelector(
          '[data-testid="ap-share-preview-target"]',
        ) as HTMLElement | null;
        return el ? getComputedStyle(el).borderRadius : '';
      },
      computedFontSize: () => {
        const el = document.querySelector(
          '[data-testid="ap-share-preview-target"]',
        ) as HTMLElement | null;
        return el ? getComputedStyle(el).fontSize : '';
      },
      errorText: () => {
        const el = document.querySelector('[role="alert"]');
        return el ? (el.textContent ?? '') : '';
      },
      pollution: readPollution,
      requests: () => ({ wrapped: [...externalRequests], resources: readResourceRequests() }),
    };
  }, [target, currents, applied]);

  return React.createElement(
    'div',
    { style: { maxWidth: 720, margin: '0 auto' } },
    React.createElement('h2', null, '外观分享 · 独立预览（真实 SharePanel）'),
    React.createElement(
      'div',
      { style: { display: 'flex', gap: 8, marginBottom: 12 } },
      TARGETS.map((t) =>
        React.createElement(
          'button',
          {
            key: t,
            type: 'button',
            'data-testid': `ap-harness-target-${t}`,
            onClick: () => setTarget(t),
            style: { fontWeight: target === t ? 700 : 400 },
          },
          `${TARGET_LABEL[t]}${target === t ? '（当前）' : ''}`,
        ),
      ),
    ),
    // 注意：此处故意不用 key={target} 强制重挂载 —— 公开组件必须在正常
    // React props 更新（target 变化不重挂载）下自行清理旧 draft 并使旧读取失效。
    React.createElement(SharePanel, {
      target,
      current: currents[target],
      onApply: (next: ReadingStyle) => {
        setCurrents((prev) => ({ ...prev, [target]: next }));
        setApplied({ target, style: next });
      },
      registerApi: (api: SharePanelApi) => {
        apiRef.current = api;
      },
    }),
    React.createElement(
      'div',
      {
        'data-testid': 'ap-share-adjacent',
        style: { marginTop: 12, padding: 8, border: '1px dashed rgba(255,255,255,0.2)' },
      },
      '相邻节点（应永远不受分享样式影响）',
    ),
    React.createElement(
      'div',
      { 'data-testid': 'ap-harness-applied', style: { marginTop: 8, fontSize: 12 } },
      applied ? `已应用[${applied.target}]：${JSON.stringify(applied.style)}` : '尚未应用',
    ),
    React.createElement('div', {
      'data-testid': 'ap-harness-pollution',
      style: { marginTop: 4, fontSize: 12 },
    }),
    React.createElement('div', {
      'data-testid': 'ap-harness-requests',
      style: { marginTop: 4, fontSize: 12 },
    }),
  );
}

armRequestTracking();
const mount = document.getElementById('root');
if (mount) createRoot(mount).render(React.createElement(Harness));
