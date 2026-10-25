/**
 * 实时感知注册表 · 地图行（RED 先行）
 *
 * 宫格「地图」必须在表里（否则物理上不可能出现，连灰态都没有），且它的就绪
 * **只**由注入的服务端就绪决定：旧 `amapApiKey` 不参与、任一单把 Key 不等于全就绪。
 */
import { describe, expect, it } from 'vitest';
import { PERCEPTION_CAPABILITIES, perceptionRenderState } from './perceptionRegistry';
import type { RealtimeConfig } from '../types';

const mapCap = PERCEPTION_CAPABILITIES.find((c) => c.id === 'map');

const rc = (extra: Partial<RealtimeConfig> = {}): RealtimeConfig => ({
  weatherEnabled: false,
  weatherApiKey: '',
  weatherCity: '',
  newsEnabled: false,
  notionEnabled: false,
  notionApiKey: '',
  notionDatabaseId: '',
  feishuEnabled: false,
  feishuAppId: '',
  feishuAppSecret: '',
  feishuBaseId: '',
  feishuTableId: '',
  xhsEnabled: false,
  cacheMinutes: 10,
  perspectiveEnabled: false,
  perspectiveSupabaseUrl: '',
  perspectiveSupabaseAnonKey: '',
  perspectiveDays: 7,
  perspectiveMinIntervalSec: 60,
  perspectiveSummaryEnabled: false,
  perspectiveSummaryThreshold: 500,
  ...extra,
});

describe('实时感知注册表 · 地图', () => {
  it('注册表里有地图行（否则宫格永远不可能显示它）', () => {
    expect(mapCap).toBeTruthy();
    expect(mapCap!.label).toBe('地图');
    expect(mapCap!.description).toContain('地点');
    // 与其他能力同一套灰态色，不引入新视觉
    expect(mapCap!.tintIdle).toBe('bg-slate-50 text-slate-400');
  });

  it('没有就绪信息时是灰态 pending，不假装 on', () => {
    expect(perceptionRenderState(mapCap!, rc())).toBe('pending');
  });

  it('就绪信息未读到时也是灰态', () => {
    expect(perceptionRenderState(mapCap!, rc(), { known: false, ready: false })).toBe('pending');
  });

  it('只有部分凭据（ready=false）是灰态', () => {
    expect(perceptionRenderState(mapCap!, rc(), { known: true, ready: false })).toBe('pending');
  });

  it('两类凭据齐（ready=true）才是 on', () => {
    expect(perceptionRenderState(mapCap!, rc(), { known: true, ready: true })).toBe('on');
  });

  it('旧 amapApiKey 非空不能让地图变成已配置（它只是迁移输入）', () => {
    const legacy = rc({ amapApiKey: 'LEGACY_ONLY' });
    expect(perceptionRenderState(mapCap!, legacy, { known: true, ready: false })).toBe('pending');
    expect(mapCap!.configured(legacy)).toBe(false);
  });

  it('其他能力不受注入就绪影响（天气照旧按 realtimeConfig 判定）', () => {
    const weather = PERCEPTION_CAPABILITIES.find((c) => c.id === 'weather')!;
    expect(perceptionRenderState(weather, rc({ weatherEnabled: true, weatherCity: '上海' }), { known: true, ready: true })).toBe('on');
    expect(perceptionRenderState(weather, rc({ weatherEnabled: true }), { known: true, ready: true })).toBe('pending');
  });
});
