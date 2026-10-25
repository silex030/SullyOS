/**
 * 适配器契约（契约 §2、§6 末段、§10-J）：能力门槛与「不伪造执行」。
 *   - 内部窗口：本地 store / 设备绑定 / 凭据都齐才 available；
 *   - 外部窗口：默认关闭，缺授权/缺配置/不可达都要给出**系统原因**；
 *   - 真实支付/发布/任意抓取：永远 CAPABILITY_UNAVAILABLE，无假确认；
 *   - validateAndPrepare 只读预计算（含配送费总额、地址、类目），不写任何东西。
 */
import { describe, expect, it } from 'vitest';

import type { EffectiveBoundaryV1 } from '../../contracts/autonomyLife';
import {
  describeCapabilities,
  describeNeverAutonomous,
  finalContentCheck,
  NEVER_AUTONOMOUS_KINDS,
  validateAndPrepare,
  type CapabilityProbeState,
} from './adapters';

const NOW = Date.UTC(2026, 9, 24, 4, 0, 0);

const boundary = (overrides: Partial<EffectiveBoundaryV1> = {}): EffectiveBoundaryV1 => ({
  schemaVersion: 1,
  revision: 1,
  scope: 'account',
  enabled: true,
  globalPaused: false,
  charEnabled: true,
  timezone: 'Asia/Shanghai',
  allowedKinds: ['journal.write', 'room.plan', 'room.note', 'phone.record', 'takeout.order', 'shopping.order', 'interaction.message', 'travel.wish', 'external.read'],
  forbiddenCategories: [],
  avoidTopics: [],
  allowFictionalNpc: false,
  doNotDisturb: null,
  limits: {
    accountModelCallsPerDay: 6,
    charModelCallsPerDay: 2,
    accountTokensPerDay: 100_000,
    charTokensPerDay: 40_000,
    notificationsPerDay: 1,
    perKindActionsPerDay: 3,
    virtualSpendPerDayMinor: 20_000,
    virtualOrderMaxMinor: 5_000,
  },
  externalGrants: [],
  ...overrides,
});

const probes = (overrides: Partial<CapabilityProbeState> = {}): CapabilityProbeState => ({
  localStoresReady: true,
  deviceBound: true,
  hasModelCredentials: true,
  externalRead: { configured: true, reachable: true },
  map: { configured: true, reachable: true },
  ...overrides,
});

describe('能力表：逐 kind 如实上报（§2 / §10-J）', () => {
  it('内部窗口在本地库/设备/凭据齐全时 available，且标记前台需求', () => {
    const caps = describeCapabilities({ boundary: boundary(), probes: probes(), nowMs: NOW });
    const journal = caps.find((item) => item.kind === 'journal.write')!;
    expect(journal).toMatchObject({ available: true, enabled: true, executionMode: 'local', requiresForeground: true });
  });

  it('缺凭据 / 设备未绑定 / 本地库缺失：给出不同系统原因（不写成角色改变心意）', () => {
    const noCreds = describeCapabilities({ boundary: boundary(), probes: probes({ hasModelCredentials: false }), nowMs: NOW });
    expect(noCreds.find((item) => item.kind === 'journal.write')?.unavailableReason).toBe('missing_credentials');
    const unbound = describeCapabilities({ boundary: boundary(), probes: probes({ deviceBound: false }), nowMs: NOW });
    expect(unbound.find((item) => item.kind === 'journal.write')?.unavailableReason).toBe('device_unbound');
    const noStores = describeCapabilities({ boundary: boundary(), probes: probes({ localStoresReady: false }), nowMs: NOW });
    expect(noStores.find((item) => item.kind === 'journal.write')?.unavailableReason).toBe('local_stores_missing');
  });

  it('外部只读：未配置 / 不可达 / 缺授权分别不可用', () => {
    const notConfigured = describeCapabilities({
      boundary: boundary(),
      probes: probes({ externalRead: { configured: false, reachable: true } }),
      nowMs: NOW,
    });
    expect(notConfigured.find((item) => item.kind === 'external.read')?.unavailableReason).toBe('external_adapter_not_configured');

    const unreachable = describeCapabilities({
      boundary: boundary(),
      probes: probes({ externalRead: { configured: true, reachable: false } }),
      nowMs: NOW,
    });
    expect(unreachable.find((item) => item.kind === 'external.read')?.unavailableReason).toBe('external_adapter_unreachable');

    // 默认没有 grant：即使探测通过也不可用。
    const noGrant = describeCapabilities({ boundary: boundary(), probes: probes(), nowMs: NOW });
    expect(noGrant.find((item) => item.kind === 'external.read')?.unavailableReason).toBe('grant_missing');
  });

  it('地图未配置 → 出行窗口不可用（不生成假位置）', () => {
    const caps = describeCapabilities({
      boundary: boundary(),
      probes: probes({ map: { configured: false, reachable: true } }),
      nowMs: NOW,
    });
    // 系统原因优先：地图根本没配，就别说成「你没授权」。
    expect(caps.find((item) => item.kind === 'travel.wish')?.unavailableReason).toBe('map_not_configured');
    const noGrant = describeCapabilities({
      boundary: boundary(),
      probes: probes({ map: { configured: true, reachable: true } }),
      nowMs: NOW,
    });
    expect(noGrant.find((item) => item.kind === 'travel.wish')?.unavailableReason).toBe('grant_missing');
    const withGrant = describeCapabilities({
      boundary: boundary({
        externalGrants: [{
          provider: 'amap', scopes: ['read:geo'], allowedHosts: ['restapi.amap.com'], allowedMethods: ['GET'],
          allowedFieldKeys: ['location'], purpose: '出行叙事', expiresAt: NOW + 86_400_000, dailyQuota: 3,
        }],
      }),
      probes: probes({ map: { configured: false, reachable: true } }),
      nowMs: NOW,
    });
    expect(withGrant.find((item) => item.kind === 'travel.wish')?.unavailableReason).toBe('map_not_configured');
  });

  it('用户没勾的 kind 是 enabled=false（available 与 enabled 分开报）', () => {
    const caps = describeCapabilities({
      boundary: boundary({ allowedKinds: ['journal.write'] }),
      probes: probes(),
      nowMs: NOW,
    });
    const message = caps.find((item) => item.kind === 'interaction.message')!;
    expect(message.available).toBe(true);
    expect(message.enabled).toBe(false);
  });

  it('真实支付/发布/任意抓取永远 CAPABILITY_UNAVAILABLE', () => {
    const never = describeNeverAutonomous();
    expect(never.map((item) => item.kind)).toEqual([...NEVER_AUTONOMOUS_KINDS]);
    expect(never.every((item) => item.code === 'CAPABILITY_UNAVAILABLE')).toBe(true);
    expect(never.every((item) => item.message.includes('未开放'))).toBe(true);
  });
});

describe('validateAndPrepare：执行前的只读预计算（§4.2 / §5.3）', () => {
  const orderItems = [{ dishId: 'd1', name: '饭团', unitPriceMinor: 650, qty: 2 }];
  const order = (patch: Record<string, unknown> = {}) => ({
    shopId: 's1', shopName: '便利店', items: orderItems, addressText: '模拟地址', deliveryFeeMinor: 300, category: '超市',
    orderId: 'ord_adapters_1', cardId: 'card-char-1', shopCat: '超市便利', ...patch,
  });

  it('订单总额含配送费（分），并以最小货币整数给出 spendMinor', () => {
    const result = validateAndPrepare({
      kind: 'takeout.order', charId: 'c1', args: order(), boundary: boundary(), nowMs: NOW, tz: 'Asia/Shanghai',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.spendMinor).toBe(1600);
    expect(result.prepared.summary).toContain('OS 内模拟');
    expect(result.prepared.summary).not.toContain('模拟地址');
  });

  it('空地址 / 非法金额 / 未登记类目都拒绝', () => {
    expect(validateAndPrepare({
      kind: 'takeout.order', charId: 'c1', args: order({ addressText: '  ' }), boundary: boundary(), nowMs: NOW, tz: 'UTC',
    })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(validateAndPrepare({
      kind: 'takeout.order', charId: 'c1', args: order({ items: [{ dishId: 'd', name: 'x', unitPriceMinor: -1, qty: 1 }] }), boundary: boundary(), nowMs: NOW, tz: 'UTC',
    })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(validateAndPrepare({
      kind: 'shopping.order', charId: 'c1', args: order({ category: '娱乐' }), boundary: boundary(), nowMs: NOW, tz: 'UTC',
    })).toMatchObject({ ok: false, code: 'POLICY_DENIED' });
  });

  it('边界未允许 / 总暂停 → 直接拒绝（执行侧不依赖 UI 先拦）', () => {
    expect(validateAndPrepare({
      kind: 'journal.write', charId: 'c1', args: { title: 't', body: 'b' },
      boundary: boundary({ allowedKinds: [] }), nowMs: NOW, tz: 'UTC',
    })).toMatchObject({ ok: false, code: 'POLICY_DENIED' });
    expect(validateAndPrepare({
      kind: 'journal.write', charId: 'c1', args: { title: 't', body: 'b' },
      boundary: boundary({ globalPaused: true }), nowMs: NOW, tz: 'UTC',
    })).toMatchObject({ ok: false, code: 'GLOBAL_PAUSED' });
  });

  it('外部读取：没有授权就 GRANT_REQUIRED；查询里带 URL/PII 判 POLICY_DENIED', () => {
    const noGrant = validateAndPrepare({
      kind: 'external.read', charId: 'c1', args: { query: '咖啡探店' }, boundary: boundary(), nowMs: NOW, tz: 'UTC',
    });
    expect(noGrant).toMatchObject({ ok: false, code: 'GRANT_REQUIRED' });

    const granted = boundary({
      externalGrants: [{
        provider: 'xhs', scopes: ['read:search'], allowedHosts: ['xhs.com'], allowedMethods: ['GET'],
        allowedFieldKeys: ['query'], purpose: '兴趣', expiresAt: NOW + 3_600_000, dailyQuota: 3,
      }],
    });
    expect(validateAndPrepare({
      kind: 'external.read', charId: 'c1', args: { query: '咖啡探店' }, boundary: granted, nowMs: NOW, tz: 'UTC',
    }).ok).toBe(true);
    expect(validateAndPrepare({
      kind: 'external.read', charId: 'c1', args: { query: '帮我看 https://evil.example/x' }, boundary: granted, nowMs: NOW, tz: 'UTC',
    })).toMatchObject({ ok: false, code: 'POLICY_DENIED' });
    expect(validateAndPrepare({
      kind: 'external.read', charId: 'c1', args: { query: '我的地址是xx路' }, boundary: granted, nowMs: NOW, tz: 'UTC',
    })).toMatchObject({ ok: false, code: 'POLICY_DENIED' });
  });

  it('内容侧最终检查复用同一份禁止方向判定', () => {
    expect(finalContentCheck('今天去赌场下了注', boundary())).toMatchObject({ ok: false });
    expect(finalContentCheck('今天在阳台晒太阳', boundary())).toEqual({ ok: true });
  });
});
