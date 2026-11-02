// @vitest-environment jsdom

// SharePanel 行为测试 —— 钉住三件事：
//   1. 预览只改变面板内的目标区域样式（行内变量），不污染 body；
//   2. 应用：点「应用」才调用 onApply，参数是预览中的样式；
//   3. 取消：不调用 onApply，预览恢复为传入的 current。
//
// 环境说明：用 React.createElement（不写 JSX），手法同 utils/blobRefHook.contract.test.ts。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SharePanel } from './SharePanel';
import type { ReadingStyle } from './types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CURRENT: ReadingStyle = {
  background: '#ffffff',
  foreground: '#1f2937',
  accent: '#0f766e',
  fontFamily: 'serif',
  fontSizePx: 15,
  lineHeight: 1.7,
  borderRadiusPx: 8,
};

const IMPORTED: ReadingStyle = {
  background: '#1e2321',
  foreground: '#e2e8f0',
  accent: '#6ee7b7',
  fontFamily: 'sans',
  fontSizePx: 18,
  lineHeight: 2.0,
  borderRadiusPx: 16,
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

function previewTarget(): HTMLElement | null {
  return container.querySelector('[data-testid="ap-share-preview-target"]');
}

describe('SharePanel', () => {
  it('预览目标带有当前样式的变量，且 body 无污染', async () => {
    await act(async () => {
      root.render(createElement(SharePanel, { target: 'collaboration', current: CURRENT, onApply: vi.fn() }));
    });
    const target = previewTarget();
    expect(target).not.toBeNull();
    expect(target!.style.getPropertyValue('--ap-share-bg')).toBe('#ffffff');
    expect(document.body.style.getPropertyValue('--ap-share-bg')).toBe('');
  });

  it('loadPreview 切换预览但不调用 onApply；取消恢复 current 且仍不调用', async () => {
    const onApply = vi.fn();
    let api: any = null;
    await act(async () => {
      root.render(
        createElement(SharePanel, {
          target: 'story-reading',
          current: CURRENT,
          onApply,
          registerApi: (a: any) => {
            api = a;
          },
        }),
      );
    });
    expect(api).not.toBeNull();
    await act(async () => {
      api.loadPreview(IMPORTED);
    });
    expect(previewTarget()!.style.getPropertyValue('--ap-share-bg')).toBe('#1e2321');
    expect(onApply).not.toHaveBeenCalled();
    await act(async () => {
      api.cancel();
    });
    expect(previewTarget()!.style.getPropertyValue('--ap-share-bg')).toBe('#ffffff');
    expect(onApply).not.toHaveBeenCalled();
  });

  it('点应用才调用 onApply，参数为预览中的样式', async () => {
    const onApply = vi.fn();
    let api: any = null;
    await act(async () => {
      root.render(
        createElement(SharePanel, {
          target: 'date-reading',
          current: CURRENT,
          onApply,
          registerApi: (a: any) => {
            api = a;
          },
        }),
      );
    });
    await act(async () => {
      api.loadPreview(IMPORTED);
    });
    await act(async () => {
      api.apply();
    });
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(IMPORTED);
  });

  it('预览消费全部 7 字段：圆角/字体/字号/行距/配色都落到预览根节点', async () => {
    const onApply = vi.fn();
    let api: any = null;
    await act(async () => {
      root.render(
        createElement(SharePanel, {
          target: 'story-reading',
          current: CURRENT,
          onApply,
          registerApi: (a: any) => {
            api = a;
          },
        }),
      );
    });
    await act(async () => {
      api.loadPreview(IMPORTED);
    });
    const target = previewTarget()!;
    // 7 个变量全部写入预览根节点
    expect(target.style.getPropertyValue('--ap-share-bg')).toBe('#1e2321');
    expect(target.style.getPropertyValue('--ap-share-fg')).toBe('#e2e8f0');
    expect(target.style.getPropertyValue('--ap-share-accent')).toBe('#6ee7b7');
    expect(target.style.getPropertyValue('--ap-share-font-size')).toBe('18px');
    expect(target.style.getPropertyValue('--ap-share-line-height')).toBe('2');
    expect(target.style.getPropertyValue('--ap-share-radius')).toBe('16px');
    expect(target.style.getPropertyValue('--ap-share-font')).not.toBe('');
    // 圆角必须实际消费变量，不能是写死的 12px
    expect(target.style.borderRadius).toContain('var(--ap-share-radius');
    expect(target.style.borderRadius).not.toBe('12px');
    expect(target.style.fontFamily).toContain('var(--ap-share-font');
    expect(onApply).not.toHaveBeenCalled();
  });

  it('importJsonText 走真实校验：圆角 0/24 预览生效，取消恢复 current', async () => {
    const onApply = vi.fn();
    let api: any = null;
    await act(async () => {
      root.render(
        createElement(SharePanel, {
          target: 'story-reading',
          current: CURRENT,
          onApply,
          registerApi: (a: any) => {
            api = a;
          },
        }),
      );
    });
    const { buildSharePackage, serializeSharePackage } = await import('./package');
    const zero = { ...IMPORTED, borderRadiusPx: 0 };
    let r: any;
    await act(async () => {
      r = api.importJsonText(serializeSharePackage(buildSharePackage(zero, 'story-reading')));
    });
    expect(r.ok).toBe(true);
    expect(previewTarget()!.style.getPropertyValue('--ap-share-radius')).toBe('0px');
    await act(async () => {
      api.cancel();
    });
    expect(previewTarget()!.style.getPropertyValue('--ap-share-radius')).toBe('8px');
    expect(previewTarget()!.style.getPropertyValue('--ap-share-bg')).toBe('#ffffff');
    expect(onApply).not.toHaveBeenCalled();
  });
});

describe('SharePanel 异步导入竞态（deferred File.text）', () => {
  async function pkgText(style: ReadingStyle, target: string): Promise<string> {
    const { buildSharePackage, serializeSharePackage } = await import('./package');
    return serializeSharePackage(buildSharePackage(style, target as any));
  }

  function deferredFile(name: string): {
    file: File;
    resolveText: (t: string) => void;
    rejectText: (e: unknown) => void;
  } {
    let resolveText!: (t: string) => void;
    let rejectText!: (e: unknown) => void;
    const gate = new Promise<string>((resolve, reject) => {
      resolveText = resolve;
      rejectText = reject;
    });
    const file = { name, size: 128, text: () => gate } as unknown as File;
    return { file, resolveText, rejectText };
  }

  function errorText(): string {
    const el = container.querySelector('[role="alert"]');
    return el ? (el.textContent ?? '') : '';
  }

  async function mountPanel(props: {
    target: 'collaboration' | 'story-reading' | 'date-reading';
    current: ReadingStyle;
    onApply: (s: ReadingStyle) => void;
    onApi: (a: any) => void;
  }): Promise<void> {
    await act(async () => {
      root.render(createElement(SharePanel, { ...props, registerApi: props.onApi }));
    });
  }

  it('取消后完成的旧读取不得回写预览，应用提交的是 current', async () => {
    const onApply = vi.fn();
    let api: any = null;
    await mountPanel({ target: 'story-reading', current: CURRENT, onApply, onApi: (a) => (api = a) });
    const text = await pkgText({ ...IMPORTED, borderRadiusPx: 24 }, 'story-reading');
    const d = deferredFile('late.json');
    let result: any = null;
    const pending = api.importFile(d.file).then((r: any) => {
      result = r;
    });
    await act(async () => {
      api.cancel();
    });
    expect(previewTarget()!.style.getPropertyValue('--ap-share-radius')).toBe('8px');
    await act(async () => {
      d.resolveText(text);
      await pending;
    });
    // 迟到完成被丢弃：预览仍是 current，无错误覆盖，可应用 draft 仍是 current。
    expect(result.ok).toBe(false);
    expect(previewTarget()!.style.getPropertyValue('--ap-share-radius')).toBe('8px');
    expect(errorText()).toBe('');
    await act(async () => {
      api.apply();
    });
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toEqual(CURRENT);
  });

  it('A/B 倒序完成：后发起的 B 获胜，先发起的 A 不得覆盖', async () => {
    const onApply = vi.fn();
    let api: any = null;
    await mountPanel({ target: 'story-reading', current: CURRENT, onApply, onApi: (a) => (api = a) });
    const textA = await pkgText({ ...IMPORTED, borderRadiusPx: 24, background: '#111111' }, 'story-reading');
    const textB = await pkgText({ ...IMPORTED, borderRadiusPx: 0, background: '#222222' }, 'story-reading');
    const fa = deferredFile('a.json');
    const fb = deferredFile('b.json');
    let ra: any = null;
    let rb: any = null;
    const pa = api.importFile(fa.file).then((r: any) => (ra = r));
    const pb = api.importFile(fb.file).then((r: any) => (rb = r));
    await act(async () => {
      fb.resolveText(textB);
      await pb;
    });
    expect(rb.ok).toBe(true);
    expect(previewTarget()!.style.getPropertyValue('--ap-share-radius')).toBe('0px');
    await act(async () => {
      fa.resolveText(textA);
      await pa;
    });
    expect(ra.ok).toBe(false);
    expect(previewTarget()!.style.getPropertyValue('--ap-share-radius')).toBe('0px');
    expect(previewTarget()!.style.getPropertyValue('--ap-share-bg')).toBe('#222222');
    expect(onApply).not.toHaveBeenCalled();
  });

  it('读取中切换 target（不重挂载）：旧 target 包不得进入新 draft', async () => {
    const onApply = vi.fn();
    let api: any = null;
    await mountPanel({ target: 'story-reading', current: CURRENT, onApply, onApi: (a) => (api = a) });
    const storyText = await pkgText({ ...IMPORTED, borderRadiusPx: 24 }, 'story-reading');
    const d = deferredFile('story.json');
    let result: any = null;
    const pending = api.importFile(d.file).then((r: any) => {
      result = r;
    });
    // 正常 React props 更新：同一挂载实例切换 target。
    await mountPanel({ target: 'date-reading', current: CURRENT, onApply, onApi: (a) => (api = a) });
    await act(async () => {
      d.resolveText(storyText);
      await pending;
    });
    expect(result.ok).toBe(false);
    expect(previewTarget()!.style.getPropertyValue('--ap-share-radius')).toBe('8px');
    expect(errorText()).toBe('');
    await act(async () => {
      api.apply();
    });
    // date 的 onApply 收到的是 date current，绝不是 story 包样式。
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toEqual(CURRENT);
    expect(onApply.mock.calls[0][0].borderRadiusPx).toBe(8);
  });

  it('读取中 current 变化：旧读取过期，预览跟随新 current', async () => {
    const onApply = vi.fn();
    let api: any = null;
    await mountPanel({ target: 'story-reading', current: CURRENT, onApply, onApi: (a) => (api = a) });
    const text = await pkgText({ ...IMPORTED, borderRadiusPx: 24 }, 'story-reading');
    const d = deferredFile('stale.json');
    let result: any = null;
    const pending = api.importFile(d.file).then((r: any) => {
      result = r;
    });
    const CURRENT2: ReadingStyle = { ...CURRENT, borderRadiusPx: 20, background: '#eeeeee' };
    await mountPanel({ target: 'story-reading', current: CURRENT2, onApply, onApi: (a) => (api = a) });
    await act(async () => {
      d.resolveText(text);
      await pending;
    });
    expect(result.ok).toBe(false);
    expect(previewTarget()!.style.getPropertyValue('--ap-share-radius')).toBe('20px');
    expect(previewTarget()!.style.getPropertyValue('--ap-share-bg')).toBe('#eeeeee');
    expect(onApply).not.toHaveBeenCalled();
  });

  it('文件读取拒绝：中文错误提示，current 不变；之后正常导入仍可走通', async () => {
    const onApply = vi.fn();
    let api: any = null;
    await mountPanel({ target: 'story-reading', current: CURRENT, onApply, onApi: (a) => (api = a) });
    const bad = { name: 'bad.json', size: 64, text: () => Promise.reject(new Error('boom')) } as unknown as File;
    let result: any = null;
    await act(async () => {
      result = await api.importFile(bad);
    });
    expect(result.ok).toBe(false);
    expect(errorText()).toContain('读取失败');
    expect(errorText()).toContain('当前设置未改变');
    expect(previewTarget()!.style.getPropertyValue('--ap-share-radius')).toBe('8px');
    expect(onApply).not.toHaveBeenCalled();
    // 恢复：正常同 target 导入→预览→应用闭环。
    const text = await pkgText(IMPORTED, 'story-reading');
    await act(async () => {
      result = await api.importFile({
        name: 'ok.json',
        size: 128,
        text: () => Promise.resolve(text),
      } as unknown as File);
    });
    expect(result.ok).toBe(true);
    expect(errorText()).toBe('');
    expect(previewTarget()!.style.getPropertyValue('--ap-share-radius')).toBe('16px');
    await act(async () => {
      api.apply();
    });
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toEqual(IMPORTED);
  });
});

describe('SharePanel 跨入口意图代次（redesign-v1 D：后发意图使旧读取失效）', () => {
  async function pkgText(style: ReadingStyle, target: string): Promise<string> {
    const { buildSharePackage, serializeSharePackage } = await import('./package');
    return serializeSharePackage(buildSharePackage(style, target as any));
  }

  function deferredFile(name: string): {
    file: File;
    resolveText: (t: string) => void;
    rejectText: (e: unknown) => void;
  } {
    let resolveText!: (t: string) => void;
    let rejectText!: (e: unknown) => void;
    const gate = new Promise<string>((resolve, reject) => {
      resolveText = resolve;
      rejectText = reject;
    });
    const file = { name, size: 128, text: () => gate } as unknown as File;
    return { file, resolveText, rejectText };
  }

  function errorText(): string {
    const el = container.querySelector('[role="alert"]');
    return el ? (el.textContent ?? '') : '';
  }

  async function mountPanel(props: {
    target: 'collaboration' | 'story-reading' | 'date-reading';
    current: ReadingStyle;
    onApply: (s: ReadingStyle) => void;
    onApi: (a: any) => void;
  }): Promise<void> {
    await act(async () => {
      root.render(createElement(SharePanel, { ...props, registerApi: props.onApi }));
    });
  }

  function radiusVars(): { radius: string; bg: string } {
    const el = previewTarget()!;
    return {
      radius: el.style.getPropertyValue('--ap-share-radius'),
      bg: el.style.getPropertyValue('--ap-share-bg'),
    };
  }

  it('A 文件待读 → B 合法文本导入成功 → A 迟到成功不得覆盖 B 的预览', async () => {
    const onApply = vi.fn();
    let api: any = null;
    await mountPanel({ target: 'story-reading', current: CURRENT, onApply, onApi: (a) => (api = a) });
    const textA = await pkgText({ ...IMPORTED, borderRadiusPx: 24, background: '#111111' }, 'story-reading');
    const textB = await pkgText({ ...IMPORTED, borderRadiusPx: 0, background: '#222222' }, 'story-reading');
    const fa = deferredFile('a.json');
    let ra: any = null;
    const pa = api.importFile(fa.file).then((r: any) => (ra = r));
    let rb: any = null;
    await act(async () => {
      rb = api.importJsonText(textB);
    });
    expect(rb.ok).toBe(true);
    expect(radiusVars()).toEqual({ radius: '0px', bg: '#222222' });
    await act(async () => {
      fa.resolveText(textA);
      await pa;
    });
    // A 已是过期意图：返回过期、不改 B 的 draft、不新增错误。
    expect(ra.ok).toBe(false);
    expect(ra.error).toContain('过期');
    expect(radiusVars()).toEqual({ radius: '0px', bg: '#222222' });
    expect(errorText()).toBe('');
    expect(onApply).not.toHaveBeenCalled();
  });

  it('A 文件待读 → B 非法文本导入拒绝 → A 迟到成功不得覆盖 B 的错误', async () => {
    const onApply = vi.fn();
    let api: any = null;
    await mountPanel({ target: 'story-reading', current: CURRENT, onApply, onApi: (a) => (api = a) });
    const textA = await pkgText({ ...IMPORTED, borderRadiusPx: 24 }, 'story-reading');
    // B：错 target 的合法包文本（同步非法意图）。
    const textB = await pkgText({ ...IMPORTED, borderRadiusPx: 0 }, 'date-reading');
    const fa = deferredFile('a.json');
    let ra: any = null;
    const pa = api.importFile(fa.file).then((r: any) => (ra = r));
    let rb: any = null;
    await act(async () => {
      rb = api.importJsonText(textB);
    });
    expect(rb.ok).toBe(false);
    const errB = errorText();
    expect(errB).toContain('约会阅读');
    expect(errB).toContain('当前设置未改变');
    expect(radiusVars().radius).toBe('8px');
    await act(async () => {
      fa.resolveText(textA);
      await pa;
    });
    expect(ra.ok).toBe(false);
    expect(ra.error).toContain('过期');
    // B 的拒绝错误必须保留，预览仍是 current。
    expect(errorText()).toBe(errB);
    expect(radiusVars().radius).toBe('8px');
    expect(onApply).not.toHaveBeenCalled();
  });

  it('A 文件待读 → B 非法文本导入拒绝 → A 迟到读取失败也不得覆盖 B 的错误', async () => {
    const onApply = vi.fn();
    let api: any = null;
    await mountPanel({ target: 'story-reading', current: CURRENT, onApply, onApi: (a) => (api = a) });
    const fa = deferredFile('a.json');
    let ra: any = null;
    const pa = api.importFile(fa.file).then((r: any) => (ra = r));
    let rb: any = null;
    await act(async () => {
      rb = api.importJsonText('这不是 JSON');
    });
    expect(rb.ok).toBe(false);
    const errB = errorText();
    expect(errB).toContain('JSON');
    await act(async () => {
      fa.rejectText(new Error('disk gone'));
      await pa;
    });
    expect(ra.ok).toBe(false);
    expect(ra.error).toContain('过期');
    expect(errorText()).toBe(errB);
    expect(radiusVars().radius).toBe('8px');
    expect(onApply).not.toHaveBeenCalled();
  });

  it('A 文件待读 → loadPreview 新意图 → A 迟到成功不得覆盖 loadPreview 的预览', async () => {
    const onApply = vi.fn();
    let api: any = null;
    await mountPanel({ target: 'story-reading', current: CURRENT, onApply, onApi: (a) => (api = a) });
    const textA = await pkgText({ ...IMPORTED, borderRadiusPx: 24, background: '#111111' }, 'story-reading');
    const fa = deferredFile('a.json');
    let ra: any = null;
    const pa = api.importFile(fa.file).then((r: any) => (ra = r));
    await act(async () => {
      api.loadPreview({ ...IMPORTED, borderRadiusPx: 4, background: '#333333' });
    });
    expect(radiusVars()).toEqual({ radius: '4px', bg: '#333333' });
    await act(async () => {
      fa.resolveText(textA);
      await pa;
    });
    expect(ra.ok).toBe(false);
    expect(ra.error).toContain('过期');
    // loadPreview 作为后发意图获胜：预览保持 C，不回退到 current，也不受 A 影响。
    expect(radiusVars()).toEqual({ radius: '4px', bg: '#333333' });
    expect(onApply).not.toHaveBeenCalled();
  });

  it('正常同 target 文本导入仍可预览→应用（新代次不破坏正常闭环）', async () => {
    const onApply = vi.fn();
    let api: any = null;
    await mountPanel({ target: 'date-reading', current: CURRENT, onApply, onApi: (a) => (api = a) });
    const text = await pkgText(IMPORTED, 'date-reading');
    let r: any = null;
    await act(async () => {
      r = api.importJsonText(text);
    });
    expect(r.ok).toBe(true);
    expect(radiusVars().radius).toBe('16px');
    await act(async () => {
      api.apply();
    });
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toEqual(IMPORTED);
  });
});
