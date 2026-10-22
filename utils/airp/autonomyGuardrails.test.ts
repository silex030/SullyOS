// utils/airp/autonomyGuardrails.test.ts
// 自主生活护栏契约：默认值、非法输入回落、上限夹取、0 的语义、全局配置解析、共享状态条目。
import { describe, expect, it } from 'vitest';
import {
  AUTONOMY_GUARDRAIL_CEILINGS,
  AUTONOMY_GUARDRAIL_DEFAULTS,
  AUTONOMY_GUARDRAIL_STATE_KEY,
  AUTONOMY_GUARDRAIL_STATE_NAMESPACE,
  buildAutonomyGuardrailStateEntry,
  effectiveAutonomyGuardrails,
  mergeAutonomyGuardrails,
  normalizeAutonomyGuardrails,
  parseAutonomyGuardrailStateValue,
  readAutonomyGuardrailStateValue,
} from './autonomyGuardrails';

describe('默认值', () => {
  it('每角色 2 次/天、同类 2h、全局 6 次/天、暂停关', () => {
    const g = normalizeAutonomyGuardrails(undefined);
    expect(g).toEqual(AUTONOMY_GUARDRAIL_DEFAULTS);
    expect(g.perCharPerDay).toBe(2);
    expect(g.sameKindMinGapMinutes).toBe(120);
    expect(g.globalPerDay).toBe(6);
    expect(g.paused).toBe(false);
  });

  it('非对象 / 数组 / 字符串一律回落默认', () => {
    for (const raw of [null, [], 'x', 42, true]) {
      expect(normalizeAutonomyGuardrails(raw)).toEqual(AUTONOMY_GUARDRAIL_DEFAULTS);
    }
  });
});

describe('逐字段校验与夹取', () => {
  it('合法值原样保留', () => {
    const g = normalizeAutonomyGuardrails({
      version: 1, perCharPerDay: 3, sameKindMinGapMinutes: 90,
      globalPerDay: 4, reserveTokensPerRun: 2000, paused: true,
    });
    expect(g.perCharPerDay).toBe(3);
    expect(g.sameKindMinGapMinutes).toBe(90);
    expect(g.globalPerDay).toBe(4);
    expect(g.reserveTokensPerRun).toBe(2000);
    expect(g.paused).toBe(true);
  });

  it('不发散的非法值回落默认（小数 / 字符串），不猜', () => {
    const g = normalizeAutonomyGuardrails({
      perCharPerDay: 1.5, sameKindMinGapMinutes: -1,
      globalPerDay: '4', reserveTokensPerRun: '4000',
    });
    expect(g.perCharPerDay).toBe(AUTONOMY_GUARDRAIL_DEFAULTS.perCharPerDay);
    expect(g.sameKindMinGapMinutes).toBe(AUTONOMY_GUARDRAIL_DEFAULTS.sameKindMinGapMinutes);
    expect(g.globalPerDay).toBe(AUTONOMY_GUARDRAIL_DEFAULTS.globalPerDay);
    expect(g.reserveTokensPerRun).toBe(AUTONOMY_GUARDRAIL_DEFAULTS.reserveTokensPerRun);
  });

  it('超过天花板的值被夹到天花板（前端可自定义，但不能把护栏改没）', () => {
    const g = normalizeAutonomyGuardrails({
      perCharPerDay: 999, sameKindMinGapMinutes: 1, globalPerDay: 999, reserveTokensPerRun: 10_000_000,
    });
    expect(g.perCharPerDay).toBe(AUTONOMY_GUARDRAIL_CEILINGS.perCharPerDay);
    expect(g.globalPerDay).toBe(AUTONOMY_GUARDRAIL_CEILINGS.globalPerDay);
    expect(g.reserveTokensPerRun).toBe(AUTONOMY_GUARDRAIL_CEILINGS.reserveTokensPerRun);
    // 同类间隔没有「太小」的硬下限（用户可以让它更密），但仍要 ≥ 0。
    expect(g.sameKindMinGapMinutes).toBe(1);
  });
});

describe('0 的语义（0 不能被洗成「活跃默认」）', () => {
  it('全局 0 次/天 = 总暂停：保留 0 并强制 paused，绝不回落默认 6', () => {
    const g = normalizeAutonomyGuardrails({ globalPerDay: 0, paused: false });
    expect(g.globalPerDay).toBe(0);
    expect(g.paused).toBe(true);
  });

  it('全局负数 = 更严的限制：按 0 处理（同样是暂停），不能被放宽成 6', () => {
    const g = normalizeAutonomyGuardrails({ globalPerDay: -3 });
    expect(g.globalPerDay).toBe(0);
    expect(g.paused).toBe(true);
  });

  it('每角色 0 次/天 = 这个角色停用：保留 0，不回落默认 2', () => {
    const g = normalizeAutonomyGuardrails({ perCharPerDay: 0 });
    expect(g.perCharPerDay).toBe(0);
    // 角色级 0 不影响用户级总暂停语义
    expect(g.paused).toBe(false);
  });

  it('paused 只在明确 true 或全局 0 时成立，字符串 "true" 不算', () => {
    expect(normalizeAutonomyGuardrails({ paused: 'true' }).paused).toBe(false);
    expect(normalizeAutonomyGuardrails({ paused: true }).paused).toBe(true);
  });
});

describe('merge / 生效值', () => {
  it('merge 逐字段：primary 合法值优先，其余回落 fallback', () => {
    const merged = mergeAutonomyGuardrails(
      { perCharPerDay: 3 },
      { perCharPerDay: 1, globalPerDay: 5, paused: true },
    );
    expect(merged.perCharPerDay).toBe(3);
    expect(merged.globalPerDay).toBe(5);
    expect(merged.paused).toBe(true);
    expect(merged.sameKindMinGapMinutes).toBe(AUTONOMY_GUARDRAIL_DEFAULTS.sameKindMinGapMinutes);
  });

  it('merge 时 primary 的 globalPerDay=0 也会把结果钉成暂停', () => {
    const merged = mergeAutonomyGuardrails({ globalPerDay: 0 }, { paused: false, globalPerDay: 6 });
    expect(merged.globalPerDay).toBe(0);
    expect(merged.paused).toBe(true);
  });

  it('全局行只覆盖 globalPerDay / paused，不能借全局行放宽每角色额度', () => {
    const charLevel = normalizeAutonomyGuardrails({ perCharPerDay: 1, sameKindMinGapMinutes: 180 });
    const shared = normalizeAutonomyGuardrails({ perCharPerDay: 9, globalPerDay: 3, paused: true });
    const effective = effectiveAutonomyGuardrails(charLevel, shared);
    expect(effective.perCharPerDay).toBe(1);
    expect(effective.sameKindMinGapMinutes).toBe(180);
    expect(effective.globalPerDay).toBe(3);
    expect(effective.paused).toBe(true);
  });

  it('模型提议无法借道：不认识的键（budget/permission/工具名/嵌套 guardrails）一律丢弃', () => {
    const g = normalizeAutonomyGuardrails({
      perCharPerDay: 1,
      budget: 99999,
      permission: 'all',
      tool: 'shell',
      guardrails: { globalPerDay: 99 },
      pausedByModel: false,
    });
    expect(Object.keys(g).sort()).toEqual(
      ['globalPerDay', 'paused', 'perCharPerDay', 'reserveTokensPerRun', 'sameKindMinGapMinutes', 'version'].sort(),
    );
    expect(g.globalPerDay).toBe(AUTONOMY_GUARDRAIL_DEFAULTS.globalPerDay);
    expect(g.paused).toBe(false);
  });
});

describe('云端共享条目（全局护栏）', () => {
  it('条目形状与既有 client_state 一致：全局 namespace + 固定 key', () => {
    const entry = buildAutonomyGuardrailStateEntry(
      { perCharPerDay: 2, sameKindMinGapMinutes: 120, globalPerDay: 6, paused: false },
      1234,
    );
    expect(entry.namespace).toBe(AUTONOMY_GUARDRAIL_STATE_NAMESPACE);
    expect(entry.key).toBe(AUTONOMY_GUARDRAIL_STATE_KEY);
    expect(entry.updatedAt).toBe(1234);
    expect(JSON.parse(entry.value)).toMatchObject({ version: 1, perCharPerDay: 2, globalPerDay: 6 });
  });

  it('写 0 时条目里就是 0 + paused，不会悄悄换成 6', () => {
    const entry = buildAutonomyGuardrailStateEntry({ globalPerDay: 0 }, 1);
    expect(JSON.parse(entry.value)).toMatchObject({ globalPerDay: 0, paused: true });
  });

  it('解析：合法 JSON 归一；坏 JSON / 非对象 → null（这是「旧 API」，三态见下）', () => {
    expect(parseAutonomyGuardrailStateValue('{"version":1,"globalPerDay":4}')?.globalPerDay).toBe(4);
    expect(parseAutonomyGuardrailStateValue('{oops')).toBeNull();
    expect(parseAutonomyGuardrailStateValue('"x"')).toBeNull();
    expect(parseAutonomyGuardrailStateValue('')).toBeNull();
  });
});

describe('云端行三态读取（缺行 ≠ 读坏）', () => {
  it('null / 空串 = 明确缺行（新用户），调用方可以落默认', () => {
    expect(readAutonomyGuardrailStateValue(null)).toEqual({ kind: 'absent' });
    expect(readAutonomyGuardrailStateValue('')).toEqual({ kind: 'absent' });
    expect(readAutonomyGuardrailStateValue('   ')).toEqual({ kind: 'absent' });
  });

  it('坏 JSON / 非对象 = invalid（调用方必须保持上次确认值，不得落默认）', () => {
    expect(readAutonomyGuardrailStateValue('{oops')).toMatchObject({ kind: 'invalid' });
    expect(readAutonomyGuardrailStateValue('"x"')).toMatchObject({ kind: 'invalid' });
    expect(readAutonomyGuardrailStateValue(42)).toMatchObject({ kind: 'invalid' });
  });

  it('合法 JSON = ok + 归一值', () => {
    const out = readAutonomyGuardrailStateValue('{"globalPerDay":3,"paused":true}');
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.value.globalPerDay).toBe(3);
      expect(out.value.paused).toBe(true);
    }
  });
});
