/**
 * 边界 v1 验收（契约 §5.1、§9、§10-B）：
 *   - 用户只能设边界，频率字段一律 422 DEPRECATED_FIELD；
 *   - 账号层 + 角色层归并「只能更严」，平台硬禁删不掉；
 *   - PATCH 用 expectedRevision 做 CAS，body 不允许多余字段；
 *   - 0 = 明确禁止（不是缺省），非法值不放大预算。
 */
import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_KINDS,
  DEFAULT_ACCOUNT_LIMITS,
  MAXIMUM_ACCOUNT_LIMITS,
  PLATFORM_FORBIDDEN_CATEGORIES,
  type BoundaryV1,
} from '../../contracts/autonomyLife';
import {
  applyBoundaryPatch,
  boundaryGate,
  boundaryMetadata,
  findDeprecatedFields,
  isKindAllowed,
  mergeEffectiveBoundary,
  normalizeBoundary,
} from './boundary';

const NOW = Date.UTC(2026, 9, 24, 4, 0, 0);

const account = (raw: Record<string, unknown> = {}, revision = 1): BoundaryV1 =>
  normalizeBoundary(
    {
      enabled: true,
      globalPaused: false,
      timezone: 'Asia/Shanghai',
      allowedKinds: [...ACTIVITY_KINDS],
      ...raw,
    },
    { scope: 'account', nowMs: NOW, revision },
  );

const character = (raw: Record<string, unknown> = {}, revision = 1): BoundaryV1 =>
  normalizeBoundary(raw, { scope: 'character', nowMs: NOW, revision });

describe('boundary v1：频率字段退役（§9 K1/K3）', () => {
  it('把旧频率键写进 PATCH 一律 DEPRECATED_FIELD，并指出具体字段', () => {
    const current = account();
    const result = applyBoundaryPatch({
      current,
      changes: { cadence: { minHours: 2, maxHours: 6 }, perCharPerDay: 4 },
      expectedRevision: current.revision,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('DEPRECATED_FIELD');
    expect((result.details?.fields as string[]).sort()).toEqual(['cadence', 'perCharPerDay']);
  });

  it('limits 里夹带 sameKindMinGap 也算旧字段（不能换个位置复活）', () => {
    const current = account();
    const result = applyBoundaryPatch({
      current,
      changes: { limits: { sameKindMinGap: 3 } },
      expectedRevision: current.revision,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.details?.fields).toEqual(['limits.sameKindMinGap']);
  });

  it('findDeprecatedFields 认识 templateId / activityLevel / reserveTokensPerRun', () => {
    expect(findDeprecatedFields({
      templateId: 'night_owl', activityLevel: 5, reserveTokensPerRun: 900,
    })).toEqual(['templateId', 'activityLevel', 'reserveTokensPerRun']);
  });

  it('边界对象里根本不存在频率字段（结构上就没有）', () => {
    const current = account();
    const patchable = applyBoundaryPatch({
      current,
      changes: { timezone: 'Europe/Paris' },
      expectedRevision: current.revision,
      nowMs: NOW,
    });
    expect(patchable.ok).toBe(true);
    if (!patchable.ok) return;
    for (const forbidden of ['frequency', 'cadence', 'sameKindMinGap', 'activeLevel']) {
      expect(Object.keys(patchable.boundary)).not.toContain(forbidden);
    }
  });
});

describe('boundary v1：归并只能更严（§5.1）', () => {
  it('角色层 null 继承账号层，两边都有取更小值', () => {
    const acct = account({
      limits: { accountModelCallsPerDay: 6, charModelCallsPerDay: 3, virtualSpendPerDayMinor: 20_000 },
    }, 2);
    const char = character({ limits: { charModelCallsPerDay: 1 } }, 3);
    const eff = mergeEffectiveBoundary({ account: acct, character: char, charId: 'c1', nowMs: NOW });
    expect(eff.limits.charModelCallsPerDay).toBe(1);
    expect(eff.limits.accountModelCallsPerDay).toBe(6);
    expect(eff.limits.virtualSpendPerDayMinor).toBe(20_000);
  });

  it('allowedKinds 取交集：角色层不能取消账号层的限制', () => {
    const acct = account({ allowedKinds: ['journal.write', 'interaction.message'] });
    const char = character({ allowedKinds: ['journal.write', 'shopping.order'] });
    const eff = mergeEffectiveBoundary({ account: acct, character: char, charId: 'c1', nowMs: NOW });
    expect(eff.allowedKinds).toEqual(['journal.write']);
  });

  it('平台硬禁永远在 forbiddenCategories 里，PATCH 也删不掉', () => {
    const current = account({ forbiddenCategories: ['gambling'] });
    const patched = applyBoundaryPatch({
      current,
      changes: { forbiddenCategories: [] },
      expectedRevision: current.revision,
      nowMs: NOW,
    });
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    for (const category of PLATFORM_FORBIDDEN_CATEGORIES) {
      expect(patched.boundary.forbiddenCategories).toContain(category);
    }
    const eff = mergeEffectiveBoundary({
      account: patched.boundary,
      character: character({ forbiddenCategories: ['my-own-taboo'] }),
      charId: 'c1',
      nowMs: NOW,
    });
    expect(eff.forbiddenCategories).toEqual(expect.arrayContaining([
      ...PLATFORM_FORBIDDEN_CATEGORIES, 'my-own-taboo',
    ]));
  });

  it('角色层不能自行加外部授权（只有账号层能给）', () => {
    const acct = account();
    const char = character({
      externalGrants: [{
        provider: 'xhs', scopes: ['read:search'], allowedHosts: ['xhs.com'], allowedMethods: ['GET'],
        allowedFieldKeys: ['query'], purpose: 'p', expiresAt: NOW + 86_400_000, dailyQuota: 5,
      }],
    });
    const eff = mergeEffectiveBoundary({ account: acct, character: char, charId: 'c1', nowMs: NOW });
    expect(eff.externalGrants).toEqual([]);
  });

  it('写权 scope 的外部授权在归一化阶段就丢弃（只读才允许）', () => {
    const acct = account({
      externalGrants: [
        { provider: 'xhs', scopes: ['read:search', 'write:post'], allowedHosts: ['a'], allowedMethods: ['get'], allowedFieldKeys: [], purpose: 'p', expiresAt: NOW + 1000, dailyQuota: 1 },
        { provider: 'xhs', scopes: ['read:note'], allowedHosts: ['a'], allowedMethods: ['get'], allowedFieldKeys: [], purpose: 'p', expiresAt: NOW + 1000, dailyQuota: 1 },
        { provider: 'xhs', scopes: ['read:note'], allowedHosts: ['a'], allowedMethods: ['get'], allowedFieldKeys: [], purpose: 'p', expiresAt: NOW - 1, dailyQuota: 1 },
      ],
    });
    expect(acct.externalGrants).toHaveLength(1);
    expect(acct.externalGrants[0].scopes).toEqual(['read:note']);
    expect(acct.externalGrants[0].allowedMethods).toEqual(['GET']);
  });
});

describe('boundary v1：PATCH 语义（§7）', () => {
  it('expectedRevision 不匹配 → REVISION_CONFLICT（不盲覆盖）', () => {
    const current = account({}, 4);
    const result = applyBoundaryPatch({
      current,
      changes: { timezone: 'Asia/Tokyo' },
      expectedRevision: 3,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('REVISION_CONFLICT');
      expect(result.details?.currentRevision).toBe(4);
    }
  });

  it('多余字段 → VALIDATION_FAILED（body 不允许额外字段）', () => {
    const current = account({}, 1);
    const result = applyBoundaryPatch({
      current,
      changes: { timezone: 'Asia/Tokyo', sneaky: 1 },
      expectedRevision: 1,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('VALIDATION_FAILED');
  });

  it('合法 PATCH 版本 +1，0 保真为「明确禁止」', () => {
    const current = account({}, 1);
    const result = applyBoundaryPatch({
      current,
      changes: { limits: { notificationsPerDay: 0 } },
      expectedRevision: 1,
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.boundary.revision).toBe(2);
    expect(result.boundary.limits.notificationsPerDay).toBe(0);
  });

  it('非法/负数上限不会把预算放大成「无限制」', () => {
    const normalized = normalizeBoundary(
      { limits: { charModelCallsPerDay: -5, accountTokensPerDay: 1e15, virtualOrderMaxMinor: 2.5 } },
      { scope: 'account', nowMs: NOW, revision: 1 },
    );
    expect(normalized.limits.charModelCallsPerDay).toBe(DEFAULT_ACCOUNT_LIMITS.charModelCallsPerDay);
    expect(normalized.limits.accountTokensPerDay).toBe(MAXIMUM_ACCOUNT_LIMITS.accountTokensPerDay);
    expect(normalized.limits.virtualOrderMaxMinor).toBe(DEFAULT_ACCOUNT_LIMITS.virtualOrderMaxMinor);
  });

  it('metadata 给 UI 的 defaults/maximums 与实际归一化口径一致', () => {
    const meta = boundaryMetadata();
    expect(meta.defaults).toEqual(DEFAULT_ACCOUNT_LIMITS);
    expect(meta.maximums).toEqual(MAXIMUM_ACCOUNT_LIMITS);
    expect(meta.deprecatedFields).toContain('cadence');
    expect(meta.platformForbiddenCategories).toContain('gambling');
    expect(meta.currency).toBe('CNY');
  });
});

describe('boundary v1：硬闸', () => {
  it('总暂停 / 角色关闭 / 未允许 kind 分别报不同原因', () => {
    const paused = mergeEffectiveBoundary({
      account: account({ globalPaused: true }),
      character: null,
      charId: 'c1',
      nowMs: NOW,
    });
    expect(boundaryGate(paused, 'journal.write')).toEqual({ ok: false, code: 'GLOBAL_PAUSED' });

    const charOff = mergeEffectiveBoundary({
      account: account({ charEnabled: false }),
      character: null,
      charId: 'c1',
      nowMs: NOW,
    });
    expect(boundaryGate(charOff, 'journal.write')).toEqual({ ok: false, code: 'CHAR_DISABLED' });

    const narrow = mergeEffectiveBoundary({
      account: account({ allowedKinds: ['journal.write'] }),
      character: null,
      charId: 'c1',
      nowMs: NOW,
    });
    expect(boundaryGate(narrow, 'shopping.order')).toEqual({ ok: false, code: 'POLICY_DENIED' });
    expect(isKindAllowed(narrow, 'journal.write')).toBe(true);
  });

  it('免打扰与角色作息是两件事：DND 不影响「能不能做」，只影响「要不要打扰用户」', () => {
    const eff = mergeEffectiveBoundary({
      account: account({
        doNotDisturb: { timezone: 'Asia/Shanghai', start: '22:00', end: '08:00' },
      }),
      character: null,
      charId: 'c1',
      nowMs: NOW,
    });
    expect(eff.doNotDisturb).toEqual({ timezone: 'Asia/Shanghai', start: '22:00', end: '08:00' });
    // DND 不是 allowedKinds 的一部分：私人日记在免打扰里照样允许。
    expect(boundaryGate(eff, 'journal.write')).toEqual({ ok: true });
  });
});
