/**
 * 旧配置迁移（契约 §9、场景 L）：
 *   - 单次、幂等：重跑不恢复旧开关、不清空预算；
 *   - 上限只能更严（K2/K4/K8 取更小值，不上调）；
 *   - 频率类设置（cadence / sameKindMinGap / templateId 的次数）退役，不翻译成新数字；
 *   - 总暂停、禁区、免打扰按原值保留；旧 LLM 定时器标记停用；旧客户端要求升级。
 */
import { describe, expect, it } from 'vitest';

import { PLATFORM_FORBIDDEN_CATEGORIES } from '../../contracts/autonomyLife';
import {
  LEGACY_MIGRATION_VERSION,
  MIGRATION_SUMMARY,
  migrateLegacyAutonomyConfig,
  RETIRED_LEGACY_TIMERS,
  type LegacyAutonomyConfig,
} from './migration';

const NOW = Date.UTC(2026, 9, 24, 4, 0, 0);

const legacy = (overrides: LegacyAutonomyConfig = {}): LegacyAutonomyConfig => ({
  enabled: true,
  paused: false,
  cadence: { minHours: 2, maxHours: 6 },
  templateId: 'night_owl',
  maxRoundsPerDay: 8,
  perCharPerDay: 5,
  globalPerDay: 12,
  sameKindMinGapMinutes: 90,
  reserveTokensPerRun: 900,
  dailyTokenBudget: 80_000,
  quietHours: { start: '23:30', end: '07:30' },
  push: { mode: 'digest', maxPerDay: 2, cooldownMinutes: 60 },
  interests: ['咖啡'],
  avoidTopics: ['工作'],
  xhsCredentialsPresent: true,
  mapQuotaPerDay: 20,
  ...overrides,
});

describe('迁移 autonomy-life-v1（§9）', () => {
  it('首次迁移：旧上限取更严值，且不上调', () => {
    const result = migrateLegacyAutonomyConfig({ nowMs: NOW, timezone: 'Asia/Shanghai', legacy: legacy() });
    expect(result.alreadyMigrated).toBe(false);
    expect(result.migrationVersion).toBe(LEGACY_MIGRATION_VERSION);
    // 角色：perCharPerDay=5 与 maxRoundsPerDay=8 取 5。
    expect(result.boundary.limits.charModelCallsPerDay).toBe(5);
    expect(result.boundary.limits.accountModelCallsPerDay).toBe(12);
    expect(result.boundary.limits.accountTokensPerDay).toBe(80_000);
    expect(result.boundary.limits.notificationsPerDay).toBe(2);
    expect(result.notes.join('\n')).toContain('新口径按调用计');
  });

  it('开关/暂停/禁区/免打扰按原值保留，绝不自动开启', () => {
    const result = migrateLegacyAutonomyConfig({
      nowMs: NOW,
      timezone: 'Asia/Shanghai',
      legacy: legacy({ enabled: false, paused: true }),
    });
    expect(result.boundary.enabled).toBe(false);
    expect(result.boundary.globalPaused).toBe(true);
    expect(result.boundary.doNotDisturb).toEqual({ timezone: 'Asia/Shanghai', start: '23:30', end: '07:30' });
    expect(result.boundary.avoidTopics).toEqual(['工作']);
    expect(result.boundary.externalGrants).toEqual([]);
  });

  it('频率类字段退役：没有 cadence/sameKindMinGap 之类的新字段', () => {
    const result = migrateLegacyAutonomyConfig({ nowMs: NOW, timezone: 'Asia/Shanghai', legacy: legacy() });
    const keys = Object.keys(result.boundary);
    for (const retired of ['cadence', 'sameKindMinGap', 'templateId', 'activityLevel', 'reserveTokensPerRun']) {
      expect(keys).not.toContain(retired);
    }
    expect(result.notes.join('\n')).toContain('不再采用固定冷却');
    expect(result.notes.join('\n')).toContain('单次 token 预留已转为内部执行参数');
  });

  it('幂等：已迁移过就原样返回现边界，不恢复旧开关、不清空预算', () => {
    const first = migrateLegacyAutonomyConfig({ nowMs: NOW, timezone: 'Asia/Shanghai', legacy: legacy() });
    const second = migrateLegacyAutonomyConfig({
      nowMs: NOW + 1000,
      timezone: 'Asia/Shanghai',
      legacy: legacy({ enabled: false }),
      existingBoundary: first.boundary,
    });
    expect(second.alreadyMigrated).toBe(true);
    expect(second.boundary).toBe(first.boundary);
    expect(second.legacySnapshot).toBeNull();
    expect(second.notes.join()).toContain('未恢复旧开关');
  });

  it('旧 LLM 定时器登记为退役，旧客户端要求升级（426）', () => {
    const result = migrateLegacyAutonomyConfig({ nowMs: NOW, timezone: 'Asia/Shanghai', legacy: legacy() });
    expect(result.retiredTimers).toEqual(RETIRED_LEGACY_TIMERS);
    expect(RETIRED_LEGACY_TIMERS).toContain('autonomy_round_llm_timer');
    expect(RETIRED_LEGACY_TIMERS).toContain('world_home_llm_tick');
    expect(result.requiresClientUpgrade).toBe(true);
    expect(MIGRATION_SUMMARY.rollback).toContain('不重启旧定时器');
  });

  it('旧快照只读，保留 revision 与 migratedAt；平台硬禁写进边界', () => {
    const result = migrateLegacyAutonomyConfig({ nowMs: NOW, timezone: 'Asia/Shanghai', legacy: legacy() });
    expect(result.legacySnapshot).toMatchObject({ readOnly: true, capturedAt: NOW, revision: 1 });
    expect(result.legacySnapshot?.raw.templateId).toBe('night_owl');
    for (const category of PLATFORM_FORBIDDEN_CATEGORIES) {
      expect(result.boundary.forbiddenCategories).toContain(category);
    }
  });

  it('没有任何旧配置也能迁移成保守默认（不因缺字段而放宽）', () => {
    const result = migrateLegacyAutonomyConfig({ nowMs: NOW, timezone: 'UTC', legacy: null });
    expect(result.boundary.enabled).toBe(false);
    expect(result.boundary.limits.charModelCallsPerDay).toBe(2);
    expect(result.boundary.limits.accountModelCallsPerDay).toBe(6);
    expect(result.boundary.allowedKinds).not.toContain('external.read');
  });
});

describe('迁移 · 不扩权（allowedKinds 只做缩减）', () => {
  it('旧配置没开 → 一个 kind 都不授予（打开后由用户逐项选）', () => {
    const result = migrateLegacyAutonomyConfig({
      nowMs: NOW,
      timezone: 'Asia/Shanghai',
      legacy: legacy({ enabled: false }),
    });
    expect(result.boundary.allowedKinds).toEqual([]);
    expect(result.notes.join('\n')).toContain('不授予任何活动');
  });

  it('旧配置带能力清单 → 与首期内部能力取交集，不认识的/外部窗口一律不授予', () => {
    const result = migrateLegacyAutonomyConfig({
      nowMs: NOW,
      timezone: 'Asia/Shanghai',
      legacy: legacy({ capabilities: ['journal.write', 'external.read', 'phone.record', 'real_payment'] }),
    });
    expect(result.boundary.allowedKinds).toEqual(['journal.write', 'phone.record']);
    expect(result.boundary.allowedKinds).not.toContain('external.read');
    expect(result.notes.join('\n')).toContain('取交集');
  });

  it('调用方传入的 legacyAllowedKinds 与旧配置里的 capabilities 同口径（都只做交集）', () => {
    const result = migrateLegacyAutonomyConfig({
      nowMs: NOW,
      timezone: 'Asia/Shanghai',
      legacy: legacy({ capabilities: undefined }),
      legacyAllowedKinds: ['room.note', 'travel.wish'],
    });
    expect(result.boundary.allowedKinds).toEqual(['room.note']);
  });
});
