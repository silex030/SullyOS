// @vitest-environment jsdom
/**
 * 2026-10-24 第二轮反馈回归：「本地语音已经选了，右上还是『已选·未连接』，音色列表空的」。
 *
 * 这组用例**不打桩 UI**：用的是真实的 `useMossVoiceCatalog` + 真实的 `MossVoicePicker`
 * + 真实的 `probeMossVoiceStatus`，只有网络层按**线上真实响应**回放
 * （这些响应是我在 2026-10-24 用 curl 从 link.ethernet.bot.cd 抓到的原件形状）：
 *
 *   1. `GET /agent/v1/tts/health` 无令牌        → 403 {"error":"unauthorized",...}
 *   2. `GET /agent/agent/v1/tts/health`（重复前缀）→ 403（主代理在路由前就鉴权，错路径也是 403）
 *   3. 静态站对未知路径的兜底                   → 200 text/html（就是 index.html 本身）
 *   4. 带正确令牌的正常响应                     → 200 JSON {ready,referenceConfigured,voices,voiceOptions}
 *
 * 结论要锁死的两条真实缺陷：
 *   - 403 不能断言「令牌不对」：它同样可能是地址里多带了 `/agent`；
 *   - 200 text/html 不能被当成健康数据（否则 reachable=true + 空目录，
 *     UI 会说「服务端没注册音色」，把人引到完全错误的方向）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import MossVoicePicker from './MossVoicePicker';
import { useMossVoiceCatalog } from '../../utils/useMossVoiceCatalog';
import { mossAgentBaseCandidates } from '../../utils/genieTts';

const act = (React as unknown as { act: (cb: () => void) => void }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROD_HTML = '<!doctype html><html><head><title>SullyOS</title></head><body><div id="root"></div></body></html>';

/** 线上真实健康响应（音色目录由服务端给出，前端不硬编码）。 */
const PROD_HEALTH = {
  ready: true,
  model: 'MOSS-TTS-Nano-100M-ONNX',
  referenceConfigured: true,
  voices: ['ether', 'public-zh-01'],
  voiceOptions: [
    { id: 'ether', label: 'ether（我的声音）', origin: '用户本人提供', preview: true, registered: true },
    { id: 'public-zh-01', label: '公开中文语料示例', origin: 'AISHELL-3（Apache-2.0）', preview: true, registered: true },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const html = () => new Response(PROD_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

function setConfig(cfg: Record<string, string>) {
  localStorage.setItem('os_api_config', JSON.stringify(cfg));
}

/** 真实的设置页链路：hook 探活 → 选择器渲染（不加任何 UI 桩）。 */
function Harness({ onState }: { onState: (s: { reachable: boolean | null; error: string }) => void }) {
  const catalog = useMossVoiceCatalog(true);
  React.useEffect(() => {
    onState({ reachable: catalog.reachable, error: catalog.error });
  }, [catalog.reachable, catalog.error, onState]);
  return (
    <MossVoicePicker
      value=""
      onChange={() => {}}
      status={catalog.status}
      reachable={catalog.reachable}
      probeError={catalog.error}
      showInherit
      onRefresh={() => { void catalog.refresh(); }}
      refreshing={catalog.refreshing}
    />
  );
}

async function mountHarness() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const seen: { reachable: boolean | null; error: string } = { reachable: null, error: '' };
  await act(async () => {
    root.render(<Harness onState={(s) => Object.assign(seen, s)} />);
  });
  // 探活是异步的：等微任务把状态刷完再断言。
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return { host, seen, unmount: () => act(() => root.unmount()) };
}

beforeEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('本机音色目录链路（真实 hook + 真实选择器 + 线上响应回放）', () => {
  it('地址里多带了 /agent 时不会再拼成 /agent/agent/…，且失败原因说清是「令牌或前缀」', async () => {
    expect(mossAgentBaseCandidates()).toEqual(['']);
    setConfig({ agentUrl: 'https://link.ethernet.bot.cd/agent', agentToken: 'tok' });
    // 剥掉误粘的 /agent：第一个候选必须还是站点根。
    expect(mossAgentBaseCandidates()[0]).toBe('https://link.ethernet.bot.cd');

    const calls: string[] = [];
    vi.stubGlobal('fetch', (async (url: string) => {
      calls.push(String(url));
      return json({ error: 'unauthorized', hint: 'X-Client-Token required' }, 403);
    }) as unknown as typeof fetch);

    const { host, seen, unmount } = await mountHarness();
    // 关键：没有出现 /agent/agent
    expect(calls.join('\n')).not.toContain('/agent/agent');
    expect(seen.reachable).toBe(false);
    expect(seen.error).toContain('令牌');
    expect(seen.error).toContain('/agent');
    expect(host.textContent).toContain('读不到本机音色目录');
    unmount();
  });

  it('静态站兜底返回 200 text/html 时不能当成健康数据（否则会误报「没注册音色」）', async () => {
    setConfig({ agentUrl: 'https://example.invalid', agentToken: 'tok' });
    vi.stubGlobal('fetch', (async () => html()) as unknown as typeof fetch);

    const { host, seen, unmount } = await mountHarness();
    expect(seen.reachable).toBe(false);
    expect(seen.error).toContain('网页');
    // 绝不能出现「已连上主代理但没注册音色」这种误诊
    expect(host.textContent).not.toContain('已连上主代理');
    expect(host.textContent).toContain('读不到本机音色目录');
    unmount();
  });

  it('配置的那条地址失败时，同源反代仍可探通 → 音色列表照常出现', async () => {
    setConfig({ agentUrl: 'https://stale.example.invalid', agentToken: 'tok' });
    vi.stubGlobal('fetch', (async (url: string) => {
      const u = String(url);
      // 配置的旧域名连不上
      if (u.startsWith('https://stale.example.invalid')) throw new TypeError('Failed to fetch');
      // 同源反代正常
      return json(PROD_HEALTH);
    }) as unknown as typeof fetch);

    const { host, seen, unmount } = await mountHarness();
    expect(seen.reachable).toBe(true);
    expect(host.textContent).toContain('ether');
    expect(host.textContent).toContain('公开中文语料示例');
    unmount();
  });

  it('什么都没填时直接走同源，而不是让用户先去填地址', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (async (url: string) => {
      calls.push(String(url));
      return json(PROD_HEALTH);
    }) as unknown as typeof fetch);

    const { host, seen, unmount } = await mountHarness();
    expect(calls[0]).toBe('/agent/v1/tts/health');
    expect(seen.reachable).toBe(true);
    expect(host.textContent).toContain('ether');
    unmount();
  });
});
