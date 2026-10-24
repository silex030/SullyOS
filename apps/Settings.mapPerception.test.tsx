// @vitest-environment jsdom
/**
 * 真实父页面（apps/Settings）· 地图灰态与统一就绪（RED 先行）
 *
 * 这里渲染的是 **真的 Settings 父组件**（不是孤立的卡片）：宫格状态必须由父自己
 * 初始化的单一就绪快照驱动，后端存在性读回通过注入的 runtime 模拟，
 * 不能靠详情卡挂载后再回调上报。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';

const act = (React as unknown as { act: (cb: () => void) => void }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  config: {
    weatherEnabled: false, weatherApiKey: '', weatherCity: '',
    newsEnabled: false, newsApiKey: '', newsPlatforms: [],
    notionEnabled: false, notionApiKey: '', notionDatabaseId: '',
    feishuEnabled: false, feishuAppId: '', feishuAppSecret: '', feishuBaseId: '', feishuTableId: '',
    xhsEnabled: false, cacheMinutes: 10,
    perspectiveEnabled: false, perspectiveSupabaseUrl: '', perspectiveSupabaseAnonKey: '',
    perspectiveDays: 7, perspectiveMinIntervalSec: 60,
    perspectiveSummaryEnabled: false, perspectiveSummaryThreshold: 500,
    amapApiKey: '',
  } as Record<string, unknown>,
  updateRealtimeConfig: vi.fn(),
  readMapCredentials: vi.fn(),
  saveMapCredentials: vi.fn(),
  testMapConnection: vi.fn(),
}));

const OS_VALUE = {
  apiConfig: { apiKey: '', baseUrl: '', agentUrl: '', model: '' },
  updateApiConfig: vi.fn(),
  closeApp: vi.fn(),
  availableModels: [],
  setAvailableModels: vi.fn(),
  theme: 'light',
  updateTheme: vi.fn(),
  exportSystem: vi.fn(),
  importSystem: vi.fn(),
  addToast: vi.fn(),
  showError: vi.fn(),
  resetSystem: vi.fn(),
  updateCharacter: vi.fn(),
  apiPresets: [],
  addApiPreset: vi.fn(),
  updateApiPreset: vi.fn(),
  removeApiPreset: vi.fn(),
  sysOperation: { status: 'idle' },
  get realtimeConfig() { return h.config; },
  updateRealtimeConfig: h.updateRealtimeConfig,
  characters: [],
  groups: [],
  userProfile: { name: '我', location: { city: '上海' } },
  cloudBackupConfig: {},
  updateCloudBackupConfig: vi.fn(),
  cloudBackupToWebDAV: vi.fn(),
  cloudRestoreFromWebDAV: vi.fn(),
  listCloudBackups: vi.fn(),
};

vi.mock('../context/OSContext', () => ({
  useOS: () => OS_VALUE,
  OSProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../utils/travel/runtime', () => ({
  getTravelRuntime: () => ({
    readMapCredentials: h.readMapCredentials,
    saveMapCredentials: h.saveMapCredentials,
    testMapConnection: h.testMapConnection,
  }),
  resetTravelRuntimeForTests: () => {},
}));

vi.mock('../utils/travel/session', () => ({
  readTravelOwnerCredential: () => ({ userId: 'user-1', ownerKey: 'owner-1' }),
  travelSessionState: () => 'ready',
  readTravelSession: () => ({ token: 'tok', expiresAt: Date.now() + 3600_000 }),
  ensureTravelSession: async () => true,
  saveTravelOwnerCredential: () => true,
  clearTravelOwnerCredential: () => {},
  clearTravelSession: () => {},
}));

import Settings from './Settings';
import { __resetMapReadinessForTests } from '../utils/travel/mapReadiness';

const credentials = (presence: Partial<Record<'amapWebKey' | 'amapJsKey' | 'amapJsCode' | 'mapboxToken', boolean>>) => ({
  configured: false,
  unreadable: false,
  has: { amapWebKey: false, amapJsKey: false, amapJsCode: false, mapboxToken: false, ...presence },
  amapJsKey: null,
  mapboxToken: null,
  mapboxStyleUrl: null,
  updatedAt: 1,
  serviceHost: null,
  serviceHostExpiresAt: null,
});

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Settings)); });
  // 「实时感知」是折叠区（既有交互），先展开再断言宫格 —— 走的是用户真实路径。
  const header = Array.from(document.querySelectorAll('button'))
    .find((b) => (b.textContent || '').includes('实时感知'));
  await act(async () => { header?.click(); });
  // 等父组件的就绪刷新落定（一次读回）
  await act(async () => { await Promise.resolve(); });
  return { host, root, unmount: () => act(() => root.unmount()) };
}

const tile = (name: string) => document.querySelector(`[data-testid="perception-${name}"]`) as HTMLElement | null;

describe('父页面宫格 · 地图灰态', () => {
  beforeEach(() => {
    __resetMapReadinessForTests();
    h.config.amapApiKey = '';
    h.readMapCredentials.mockReset();
  });
  afterEach(() => { document.body.innerHTML = ''; });

  it('后端读回「没有凭据」时仍显示地图格子，且是灰态「未配置」', async () => {
    h.readMapCredentials.mockResolvedValue({ known: true, error: null, credentials: credentials({}) });
    const { unmount } = await mount();
    const map = tile('map');
    console.log('BODYLEN', document.body.innerHTML.length, 'HAS_SECTION', document.body.textContent?.includes('实时感知'), 'TESTIDS', Array.from(document.querySelectorAll('[data-testid]')).length, 'GRID_HTML', (document.body.innerHTML.match(/<div class="grid grid-cols-4[\s\S]{0,600}/)||[''])[0]);
    expect(map).toBeTruthy();
    expect(map!.getAttribute('data-state')).toBe('unconfigured');
    expect(map!.className).toContain('bg-slate-50');
    expect(map!.getAttribute('title')).toContain('未配置');
    unmount();
  });

  it('只有 Web 服务 Key 时是「部分就绪」灰态，不是全就绪', async () => {
    h.readMapCredentials.mockResolvedValue({ known: true, error: null, credentials: credentials({ amapWebKey: true }) });
    const { unmount } = await mount();
    const map = tile('map')!;
    expect(map.getAttribute('data-state')).toBe('partial');
    expect(map.className).toContain('bg-slate-50');
    expect(map.getAttribute('title')).toContain('还缺');
    unmount();
  });

  it('两类凭据都齐时才是彩色（on）', async () => {
    h.readMapCredentials.mockResolvedValue({
      known: true, error: null,
      credentials: credentials({ amapWebKey: true, amapJsKey: true, amapJsCode: true }),
    });
    const { unmount } = await mount();
    const map = tile('map')!;
    expect(map.getAttribute('data-state')).toBe('ready');
    expect(map.className).not.toContain('bg-slate-50');
    expect(map.getAttribute('title')).toContain('已就绪');
    unmount();
  });

  it('读取失败时灰态「读取失败」并提示可重试，不假活跃', async () => {
    h.readMapCredentials.mockResolvedValue({ known: false, error: 'NETWORK', credentials: null });
    const { unmount } = await mount();
    const map = tile('map')!;
    expect(map.getAttribute('data-state')).toBe('error');
    expect(map.className).toContain('bg-slate-50');
    expect(map.getAttribute('title')).toContain('重试');
    unmount();
  });

  it('旧 amapApiKey 还在、服务端没有凭据时仍按未配置（旧 Key 不是就绪证据）', async () => {
    h.config.amapApiKey = 'LEGACY_LOCAL_KEY';
    h.readMapCredentials.mockResolvedValue({ known: true, error: null, credentials: credentials({}) });
    const { unmount } = await mount();
    const map = tile('map')!;
    expect(map.getAttribute('data-state')).toBe('unconfigured');
    expect(document.body.innerHTML).not.toContain('LEGACY_LOCAL_KEY');
    unmount();
  });

  it('父页面只读一次后端存在性（宫格不额外探测），点击格子打开原实时感知配置并定位地图组', async () => {
    h.readMapCredentials.mockResolvedValue({ known: true, error: null, credentials: credentials({}) });
    const { unmount } = await mount();
    expect(h.readMapCredentials).toHaveBeenCalledTimes(1);

    const map = tile('map')!;
    await act(async () => { map.click(); });
    expect(document.body.textContent).toContain('实时感知配置');
    const group = document.querySelector('[data-testid="realtime-map-group"]');
    expect(group).toBeTruthy();
    expect(group!.getAttribute('data-focused')).toBe('true');
    unmount();
  });
});
