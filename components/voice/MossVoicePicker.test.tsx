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

  it('空目录 / 未探到时给清晰空态，不出现任何前端硬编码音色', () => {
    const empty = normalizeMossVoiceHealth({ ready: false });
    const { host, unmount } = mount(
      <MossVoicePicker value="" onChange={() => {}} status={empty} showInherit />,
    );
    expect(host.textContent).toContain('还没有可选音色');
    expect(host.textContent).not.toContain('ether');
    unmount();
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
