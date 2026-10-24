// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { normalizeMossVoiceHealth } from '../../utils/mossTtsStatus';

const act = (React as unknown as { act: (cb: () => void) => void }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 预览走 utils/genieTts，全 mock 掉：这里只验证 UI 契约（点了哪个音色、传给后端的 ID）。
const h = vi.hoisted(() => ({
  fetchPreview: vi.fn(async () => ({ url: 'blob:preview-1', blob: new Blob(['x']) })),
  revoke: vi.fn(),
}));
vi.mock('../../utils/genieTts', () => ({
  fetchMossVoicePreview: h.fetchPreview,
}));

import MossVoicePicker from './MossVoicePicker';

const status = normalizeMossVoiceHealth({
  ready: true,
  referenceConfigured: true,
  voices: ['ether', 'official-sample', 'no-preview'],
  voiceOptions: [
    { id: 'ether', label: 'ether（我的声音）', origin: '用户本人提供', preview: true, registered: true },
    { id: 'official-sample', label: '公开语料示例', origin: 'AISHELL-3（Apache-2.0）', preview: true, registered: true },
    { id: 'no-preview', label: '无试听音色', origin: '官方示例', preview: false, registered: true },
  ],
});

function mount(node: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return { host, root, unmount: () => act(() => root.unmount()) };
}

describe('MossVoicePicker：角色/全局共用的音色列表与 2 秒试听', () => {
  beforeEach(() => {
    h.fetchPreview.mockClear();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: h.revoke } as any);
    vi.stubGlobal('Audio', class {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      pause = vi.fn();
      play = vi.fn(async () => {});
      constructor(public src: string) {}
    } as any);
  });
  afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

  it('列出后端给的每个音色（中文名 + 来源），并显示「继承全局」', () => {
    const { host, unmount } = mount(
      <MossVoicePicker value="" onChange={() => {}} status={status} globalVoiceId="ether" showInherit />,
    );
    expect(host.textContent).toContain('ether（我的声音）');
    expect(host.textContent).toContain('公开语料示例');
    expect(host.textContent).toContain('AISHELL-3（Apache-2.0）');
    expect(host.textContent).toContain('继承全局');
    expect(host.textContent).toContain('当前：ether（我的声音）');
    unmount();
  });

  it('选择某个音色时把 ID 交给 onChange（持久化由上层写 voiceProfile.mossVoiceId）', () => {
    const onChange = vi.fn();
    const { host, unmount } = mount(
      <MossVoicePicker value="ether" onChange={onChange} status={status} globalVoiceId="ether" showInherit />,
    );
    const radio = host.querySelector('input[type="radio"][value="official-sample"]') as HTMLInputElement;
    act(() => { radio.click(); });
    expect(onChange).toHaveBeenCalledWith('official-sample');
    unmount();
  });

  it('点试听只取「该音色」的 2 秒预览，不是统一 demo', async () => {
    const { host, unmount } = mount(
      <MossVoicePicker value="ether" onChange={() => {}} status={status} globalVoiceId="ether" showInherit />,
    );
    const btn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('试听')) as HTMLButtonElement;
    await act(async () => { btn.click(); await Promise.resolve(); });
    expect(h.fetchPreview).toHaveBeenCalledWith('ether');
    expect(host.textContent).toContain('音色示例');
    unmount();
    expect(h.revoke).toHaveBeenCalled();
  });

  it('没有试听片段的音色按钮禁用并说明原因（不静默换成别的音色）', () => {
    const { host, unmount } = mount(
      <MossVoicePicker value="ether" onChange={() => {}} status={status} globalVoiceId="ether" />,
    );
    const rows = Array.from(host.querySelectorAll('[data-voice-row]'));
    const row = rows.find((r) => r.getAttribute('data-voice-row') === 'no-preview') as HTMLElement;
    const btn = row.querySelector('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(row.textContent).toContain('无试听');
    unmount();
  });

  it('空态分三种：探测中 / 连不上（带原因与重试）/ 连上但没注册音色', () => {
    const empty = normalizeMossVoiceHealth({ ready: false });
    // 1) 还在探测
    const a = mount(<MossVoicePicker value="" onChange={() => {}} status={null} showInherit />);
    expect(a.host.textContent).toContain('正在检测本机音色');
    a.unmount();
    // 2) 连不上：必须给出原因，并指到设置里该核对的地方
    const b = mount(
      <MossVoicePicker value="" onChange={() => {}} status={empty} showInherit reachable={false} probeError="主代理返回 403" onRefresh={() => {}} />,
    );
    expect(b.host.textContent).toContain('读不到本机音色目录');
    expect(b.host.textContent).toContain('主代理返回 403');
    expect(b.host.textContent).toContain('重新检测');
    b.unmount();
    // 3) 连上了但目录为空：不能再说「主代理没连上」
    const c = mount(
      <MossVoicePicker value="" onChange={() => {}} status={empty} showInherit reachable onRefresh={() => {}} />,
    );
    expect(c.host.textContent).toContain('已连上主代理');
    expect(c.host.textContent).not.toContain('读不到本机音色目录');
    expect(c.host.textContent).not.toContain('ether');
    c.unmount();
  });

  it('播放失败给出明确文案，且不会自动重试或改选别的音色', async () => {
    h.fetchPreview.mockRejectedValueOnce(new Error('该音色没有可试听的片段'));
    const { host, unmount } = mount(
      <MossVoicePicker value="ether" onChange={() => {}} status={status} globalVoiceId="ether" />,
    );
    const btn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('试听')) as HTMLButtonElement;
    await act(async () => { btn.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toContain('该音色没有可试听的片段');
    unmount();
  });
});
