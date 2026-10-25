/**
 * 地图就绪快照（RED 先行）：父宫格与地图卡必须读同一份快照，且分级就绪。
 *
 * 断言意图：
 * - 任一单把 Key 都不等于「全就绪」；
 * - 旧 RealtimeConfig.amapApiKey 不参与判定（只作迁移输入）；
 * - 未连接 / 待批准 / 读取失败 / 未配置 / 部分就绪 / 就绪各有不同文案；
 * - 刷新只打一次后端读回（单飞），失败不伪装成活跃。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetMapReadinessForTests,
  deriveMapReadiness,
  getMapReadinessSnapshot,
  refreshMapReadiness,
  setMapPairPending,
  subscribeMapReadiness,
  type MapCredentialPresenceLike,
} from './mapReadiness';

// 读回语义依赖「本机有会话」；这里固定为已配对，专测读回/失败/单飞。
vi.mock('./session', () => ({
  readTravelOwnerCredential: () => ({ userId: 'user-1', ownerKey: 'owner-1' }),
  travelSessionState: () => 'ready',
}));

const has = (p: Partial<MapCredentialPresenceLike>): MapCredentialPresenceLike => ({
  amapWebKey: false,
  amapJsKey: false,
  amapJsCode: false,
  mapboxToken: false,
  ...p,
});

const base = {
  paired: true,
  pairPending: false,
  known: true,
  error: null as string | null,
};

describe('地图就绪 · 分级判定', () => {
  it('Web 服务 Key 单独存在只是「部分就绪」，不能算全就绪', () => {
    const s = deriveMapReadiness({ ...base, has: has({ amapWebKey: true }) });
    expect(s.restReady).toBe(true);
    expect(s.basemapReady).toBe(false);
    expect(s.fullyReady).toBe(false);
    expect(s.phase).toBe('partial');
    expect(s.detail).toContain('还缺');
  });

  it('只有 JS Key + jscode 也只是「部分就绪」（搜索/路线仍不可用）', () => {
    const s = deriveMapReadiness({ ...base, has: has({ amapJsKey: true, amapJsCode: true }) });
    expect(s.restReady).toBe(false);
    expect(s.basemapReady).toBe(true);
    expect(s.fullyReady).toBe(false);
    expect(s.phase).toBe('partial');
  });

  it('JS Key 与 jscode 必须成对：只填其中一把不算底图就绪', () => {
    expect(deriveMapReadiness({ ...base, has: has({ amapJsKey: true }) }).basemapReady).toBe(false);
    expect(deriveMapReadiness({ ...base, has: has({ amapJsCode: true }) }).basemapReady).toBe(false);
  });

  it('两类都齐才是就绪；Mapbox 是可选，不影响国内就绪', () => {
    const s = deriveMapReadiness({ ...base, has: has({ amapWebKey: true, amapJsKey: true, amapJsCode: true }) });
    expect(s.phase).toBe('ready');
    expect(s.fullyReady).toBe(true);
    expect(s.detail).toContain('已就绪');
    expect(deriveMapReadiness({ ...base, has: has({ amapWebKey: true, amapJsKey: true, amapJsCode: true }) }).intlReady).toBe(false);
  });

  it('服务端没有凭据 = 未配置（灰），不是错误', () => {
    const s = deriveMapReadiness({ ...base, has: has({}) });
    expect(s.phase).toBe('unconfigured');
    expect(s.fullyReady).toBe(false);
    expect(s.detail).toContain('未配置');
  });

  it('未连接（本机没有会话）优先于「未配置」：文案说清下一步', () => {
    const s = deriveMapReadiness({ ...base, paired: false, known: false, has: null });
    expect(s.phase).toBe('unconnected');
    expect(s.detail).toContain('未连接');
  });

  it('批准中是独立状态，不显示「已连接」', () => {
    const s = deriveMapReadiness({ ...base, paired: false, pairPending: true, known: false, has: null });
    expect(s.phase).toBe('pending-approval');
    expect(s.detail).toContain('批准');
  });

  it('读取失败给出失败态与重试提示，不假装活跃', () => {
    const s = deriveMapReadiness({ ...base, known: false, error: 'NETWORK', has: null });
    expect(s.phase).toBe('error');
    expect(s.fullyReady).toBe(false);
    expect(s.detail).toContain('重试');
  });

  it('解不开（主密钥变更）不算就绪', () => {
    const s = deriveMapReadiness({ ...base, has: has({ amapWebKey: true }), unreadable: true });
    expect(s.fullyReady).toBe(false);
    expect(s.phase).toBe('error');
  });

  it('旧 RealtimeConfig.amapApiKey 不参与判定（只有迁移输入，不是就绪证据）', () => {
    // 派生函数根本不接受 rc，这里用「传了旧 Key 也不改变结果」的形式钉住口径。
    const withLegacy = deriveMapReadiness({
      ...base, has: has({}), legacyAmapApiKey: 'LEGACY_KEY_SHOULD_BE_IGNORED',
    } as never);
    expect(withLegacy.phase).toBe('unconfigured');
    expect(withLegacy.fullyReady).toBe(false);
    expect(JSON.stringify(withLegacy)).not.toContain('LEGACY_KEY_SHOULD_BE_IGNORED');
  });
});

describe('地图就绪 · 单一快照与订阅', () => {
  beforeEach(() => __resetMapReadinessForTests());

  it('父与卡共享同一引用；刷新只打一次后端读回', async () => {
    const readMapCredentials = vi.fn(async () => ({
      known: true,
      error: null,
      credentials: {
        configured: true, unreadable: false,
        has: has({ amapWebKey: true, amapJsKey: true, amapJsCode: true }),
        amapJsKey: 'pub', mapboxToken: null, mapboxStyleUrl: null,
        updatedAt: 1, serviceHost: null, serviceHostExpiresAt: null,
      },
    }));
    const runtime = { readMapCredentials } as never;

    const [a, b] = await Promise.all([
      refreshMapReadiness(runtime),
      refreshMapReadiness(runtime),
    ]);
    expect(readMapCredentials).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(getMapReadinessSnapshot()).toBe(a);
  });

  it('订阅者收到新快照；读取失败落成 error 而不是 ready', async () => {
    const seen: string[] = [];
    subscribeMapReadiness((s) => seen.push(s.phase));
    await refreshMapReadiness({ readMapCredentials: async () => ({ known: false, credentials: null, error: 'NETWORK' }) } as never);
    expect(seen).toContain('error');
    expect(getMapReadinessSnapshot().fullyReady).toBe(false);
  });

  it('批准中标记会改变快照并通知（父宫格不必等卡片挂载）', () => {
    const seen: string[] = [];
    subscribeMapReadiness((s) => seen.push(s.phase));
    setMapPairPending(true);
    expect(getMapReadinessSnapshot().phase).toBe('pending-approval');
    expect(seen).toContain('pending-approval');
    setMapPairPending(false);
  });
});
