// utils/airp/autonomySettings.test.ts
// 自主设置归并叶子：模板三态（模板全跟 / 单项覆盖 / 非法回落）、有效开关矩阵、
// 运行时面反归一化（autonomyLevel / mcpAllow / writable），以及「任何输入都不抛」。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  AIRP_AUTONOMY_TEMPLATES,
  AUTONOMY_DAILY_TOKEN_BUDGET,
  isAutonomyActive,
  mergeAutonomySettings,
} from './autonomySettings';
import type { AirpSettings } from './settings';

/** 合法 AirpSettings 工厂；over 用来塞非法值（测试故意越界）。 */
const airpOf = (over: Record<string, unknown> = {}): AirpSettings => ({
  enabled: true,
  autonomyLevel: 2,
  capabilities: [],
  mcpAllow: [],
  writable: false,
  version: 1,
  autonomy: { enabled: true, templateId: 'custom', overrides: {}, version: 1 },
  ...over,
} as unknown as AirpSettings);

/** char 外壳：mergeAutonomySettings / isAutonomyActive 收的是角色（airp 挂在其上）。 */
const charOf = (over: Record<string, unknown> = {}) => ({ airp: airpOf(over) });

const withTemplate = (templateId: string, overrides: unknown = {}) =>
  mergeAutonomySettings(charOf({ autonomy: { enabled: true, templateId, overrides, version: 1 } }));

const merge = (char: unknown) => mergeAutonomySettings(char as { airp?: AirpSettings });

describe('模板预填全跟（每种模板归并成文档值）', () => {
  it('night_player：2–4h、无静默段、battle/5/800/opener、push big/1/60、口语 note', () => {
    const out = withTemplate('night_player');
    expect(out.cadence).toEqual({ minHours: 2, maxHours: 4 });
    expect(out.quietHours).toBeUndefined();
    expect(out.maxRoundsPerDay).toBe(2);
    expect(out.retell).toEqual({ style: 'battle', maxItems: 5, maxChars: 800, opener: true });
    expect(out.push).toEqual({ mode: 'big', maxPerDay: 1, cooldownMinutes: 60 });
    expect(out.noteStyleHint).toBe(AIRP_AUTONOMY_TEMPLATES.night_player.noteStyleHint);
  });

  it('morning_brief：夜间静默、brief、push big/1', () => {
    const out = withTemplate('morning_brief');
    expect(out.cadence).toEqual({ minHours: 2, maxHours: 4 });
    expect(out.quietHours).toEqual({ start: '23:00', end: '06:00' });
    expect(out.retell.style).toBe('brief');
    expect(out.retell.opener).toBe(false);
    expect(out.push).toEqual({ mode: 'big', maxPerDay: 1, cooldownMinutes: 60 });
  });

  it('surf_share：3–5h、casual、push off', () => {
    const out = withTemplate('surf_share');
    expect(out.cadence).toEqual({ minHours: 3, maxHours: 5 });
    expect(out.retell.style).toBe('casual');
    expect(out.push.mode).toBe('off');
    expect(out.noteStyleHint).toBe(AIRP_AUTONOMY_TEMPLATES.surf_share.noteStyleHint);
  });

  it('custom：全常量兜底', () => {
    const out = withTemplate('custom');
    expect(out.cadence).toEqual({ minHours: 2, maxHours: 4 });
    expect(out.quietHours).toBeUndefined();
    expect(out.maxRoundsPerDay).toBe(2);
    expect(out.retell).toEqual({ style: 'plain', maxItems: 5, maxChars: 800, opener: false });
    expect(out.push).toEqual({ mode: 'big', maxPerDay: 1, cooldownMinutes: 60 });
    expect(out.noteStyleHint).toBeUndefined();
    expect(out.dailyTokenBudget).toBe(AUTONOMY_DAILY_TOKEN_BUDGET);
  });

  it('unknown templateId 回落 custom', () => {
    const out = withTemplate('does_not_exist');
    expect(out.cadence).toEqual({ minHours: 2, maxHours: 4 });
    expect(out.retell.style).toBe('plain');
  });
});

describe('单项覆盖：覆盖 > 模板 > 常量', () => {
  it('只覆盖 cadence，模板其余字段保留', () => {
    const out = withTemplate('night_player', { cadence: { minHours: 1, maxHours: 2 } });
    expect(out.cadence).toEqual({ minHours: 1, maxHours: 2 });
    expect(out.retell.style).toBe('battle');
    expect(out.noteStyleHint).toBe(AIRP_AUTONOMY_TEMPLATES.night_player.noteStyleHint);
  });

  it('逐子字段覆盖 retell（只换 style 不丢 maxItems/opener）', () => {
    const out = withTemplate('night_player', { retell: { style: 'diary' } });
    expect(out.retell).toEqual({ style: 'diary', maxItems: 5, maxChars: 800, opener: true });
  });

  it('显式空数组可以清掉数组类字段', () => {
    const out = withTemplate('custom', { interests: [], avoidTopics: ['剧透'] });
    expect(out.interests).toEqual([]);
    expect(out.avoidTopics).toEqual(['剧透']);
  });

  it('quietHours 可被覆盖', () => {
    const out = withTemplate('morning_brief', { quietHours: { start: '01:00', end: '07:30' } });
    expect(out.quietHours).toEqual({ start: '01:00', end: '07:30' });
  });

  it('quietHours 显式 null = 清掉模板预填（跳过模板兜底）', () => {
    const out = withTemplate('morning_brief', { quietHours: null });
    expect(out.quietHours).toBeUndefined();
    // 只清静默段，其余字段照旧跟随模板
    expect(out.retell.style).toBe('brief');
    expect(out.cadence).toEqual({ minHours: 2, maxHours: 4 });
  });

  it('quietHours 缺省（undefined / 不写）仍跟随模板', () => {
    expect(withTemplate('morning_brief', { quietHours: undefined }).quietHours)
      .toEqual({ start: '23:00', end: '06:00' });
    expect(withTemplate('morning_brief').quietHours).toEqual({ start: '23:00', end: '06:00' });
  });

  it('quietHours null 且模板本来就没有 → 依旧缺省', () => {
    expect(withTemplate('custom', { quietHours: null }).quietHours).toBeUndefined();
  });
});

describe('非法值回落', () => {
  it('cadence 非法（非有限 / min>max）→ 默认 2–4h', () => {
    expect(withTemplate('custom', { cadence: { minHours: 'x', maxHours: 5 } }).cadence)
      .toEqual({ minHours: 2, maxHours: 4 });
    expect(withTemplate('custom', { cadence: { minHours: 9, maxHours: 3 } }).cadence)
      .toEqual({ minHours: 2, maxHours: 4 });
    expect(withTemplate('custom', { cadence: { minHours: NaN, maxHours: Infinity } }).cadence)
      .toEqual({ minHours: 2, maxHours: 4 });
  });

  it('autonomyLevel 非法 → 2', () => {
    for (const level of [9, -1, 1.5, '2', null, undefined]) {
      expect(mergeAutonomySettings(charOf({ autonomyLevel: level })).autonomyLevel).toBe(2);
    }
    for (const level of [0, 1, 2, 3]) {
      expect(mergeAutonomySettings(charOf({ autonomyLevel: level })).autonomyLevel).toBe(level);
    }
  });

  it('retell 各子字段非法 → 常量兜底', () => {
    const out = withTemplate('custom', {
      retell: { style: 'nope', maxItems: -1, maxChars: 0, opener: 'yes', customHint: '  ' },
    });
    expect(out.retell).toEqual({ style: 'plain', maxItems: 5, maxChars: 800, opener: false });
  });

  it('push 各子字段非法 → 常量兜底', () => {
    const out = withTemplate('custom', {
      push: { mode: 'huge', maxPerDay: 0, cooldownMinutes: -5 },
    });
    expect(out.push).toEqual({ mode: 'big', maxPerDay: 1, cooldownMinutes: 60 });
  });

  it('quietHours 形状不对 → 整块丢掉', () => {
    expect(withTemplate('custom', { quietHours: { start: '25:00', end: '06:00' } }).quietHours)
      .toBeUndefined();
    expect(withTemplate('custom', { quietHours: { start: '23:00', end: 'bad' } }).quietHours)
      .toBeUndefined();
    expect(withTemplate('custom', { quietHours: { start: 23, end: '06:00' } }).quietHours)
      .toBeUndefined();
    expect(withTemplate('custom', { quietHours: 'night' }).quietHours).toBeUndefined();
  });

  it('interests / avoidTopics 只收字符串数组', () => {
    const out = withTemplate('custom', { interests: 'x', avoidTopics: ['ok', 1, null, 'fine'] });
    expect(out.interests).toEqual([]);
    expect(out.avoidTopics).toEqual(['ok', 'fine']);
  });

  it('maxRoundsPerDay / dailyTokenBudget 非法回落', () => {
    const out = withTemplate('custom', { maxRoundsPerDay: 0, dailyTokenBudget: -1 });
    expect(out.maxRoundsPerDay).toBe(2);
    expect(out.dailyTokenBudget).toBe(AUTONOMY_DAILY_TOKEN_BUDGET);
  });

  it('noteStyleHint 空白等同缺省', () => {
    expect(withTemplate('custom', { noteStyleHint: '   ' }).noteStyleHint).toBeUndefined();
    expect(withTemplate('custom', { noteStyleHint: 42 }).noteStyleHint).toBeUndefined();
  });
});

describe('isAutonomyActive 矩阵（总闸 × 功能开关 × 档位，L0 为假）', () => {
  const cases: Array<[boolean, boolean, 0 | 1, boolean]> = [
    [true, true, 1, true],
    [true, true, 0, false],
    [true, false, 1, false],
    [true, false, 0, false],
    [false, true, 1, false],
    [false, true, 0, false],
    [false, false, 1, false],
    [false, false, 0, false],
  ];

  for (const [master, feature, level, expected] of cases) {
    it(`master=${master} feature=${feature} level=${level} → ${expected}`, () => {
      const char = charOf({
        enabled: master,
        autonomyLevel: level,
        autonomy: { enabled: feature, templateId: 'custom', overrides: {}, version: 1 },
      });
      expect(isAutonomyActive(char)).toBe(expected);
      expect(mergeAutonomySettings(char).enabled).toBe(expected);
    });
  }

  it('缺省（没配过自主 / 没有 airp / 空 char）一律非活跃', () => {
    expect(isAutonomyActive(charOf({ autonomy: undefined }))).toBe(false);
    expect(isAutonomyActive(charOf({ enabled: false }))).toBe(false);
    expect(isAutonomyActive({})).toBe(false);
    expect(isAutonomyActive(undefined)).toBe(false);
    expect(isAutonomyActive(null)).toBe(false);
  });
});

describe('反归一化运行时面：autonomyLevel / mcpAllow / writable', () => {
  it('顶层字段原样进终值', () => {
    const out = mergeAutonomySettings(charOf({
      autonomyLevel: 3,
      mcpAllow: ['fs', 'web_search', 42, null],
      writable: true,
    }));
    expect(out.autonomyLevel).toBe(3);
    expect(out.mcpAllow).toEqual(['fs', 'web_search']);
    expect(out.writable).toBe(true);
    expect(out.enabled).toBe(true);
  });

  it('writable 非 true 一律为 false', () => {
    for (const writable of ['true', 1, null, undefined, {}]) {
      expect(mergeAutonomySettings(charOf({ writable })).writable).toBe(false);
    }
  });

  it('mcpAllow 非数组回落空数组', () => {
    expect(mergeAutonomySettings(charOf({ mcpAllow: 'fs' })).mcpAllow).toEqual([]);
  });
});

describe('纯叶子 / 不变式', () => {
  it('module hygiene：只 import airp 内的纯叶子（无浏览器/网络依赖）', () => {
    const source = readFileSync(new URL('./autonomySettings.ts', import.meta.url), 'utf8');
    const specifiers = [
      ...source.matchAll(/from\s+['"]([^'"]+)['"]/g),
      ...source.matchAll(/import\s+['"]([^'"]+)['"]/g),
    ].map((m) => m[1]);
    // 护栏归并是同目录纯叶子（P5）；除此之外仍只允许 types/settings 的类型引用。
    expect(specifiers.every((s) => s === './types' || s === './settings' || s === './autonomyGuardrails')).toBe(true);
  });

  it('不修改输入对象（模板对象也不被别名污染）', () => {
    const raw = charOf({ autonomy: { enabled: true, templateId: 'night_player', overrides: {}, version: 1 } });
    const before = structuredClone(raw);
    const out = mergeAutonomySettings(raw);
    out.interests.push('mutated');
    expect(raw).toEqual(before);
    expect(AIRP_AUTONOMY_TEMPLATES.night_player.interests).toBeUndefined();
  });
});

describe('never throws（敌意输入）', () => {
  const hostile: unknown[] = [
    undefined, null, 0, 1, -1, NaN, Infinity, '', 'str', true, false, [], {},
    () => {}, Symbol('x'), 10n,
    Object.create(null),
    new Map(), new Set(), new Date(),
    { airp: null }, { airp: 0 }, { airp: 'x' }, { airp: [] },
    { airp: {} },
    { airp: { autonomy: null } }, { airp: { autonomy: 0 } }, { airp: { autonomy: [] } },
    { airp: { autonomy: {} } },
    { airp: { autonomy: { overrides: 0 } } },
    { airp: { autonomy: { overrides: [] } } },
    { airp: { autonomy: { templateId: 1, overrides: { cadence: [], retell: 'x', push: 3 } } } },
    { airp: { enabled: {}, autonomyLevel: {}, mcpAllow: {}, writable: {} } },
    { toString: () => 'x' },
    { valueOf: () => { throw new Error('boom'); } },
  ];

  for (const input of hostile) {
    it(`does not throw for ${describeInput(input)}`, () => {
      expect(() => merge(input)).not.toThrow();
      expect(() => isAutonomyActive(input as { airp?: AirpSettings })).not.toThrow();
      const out = merge(input);
      expect(typeof out.enabled).toBe('boolean');
      expect(Number.isFinite(out.cadence.minHours)).toBe(true);
      expect(Number.isFinite(out.cadence.maxHours)).toBe(true);
      expect(out.cadence.minHours).toBeLessThanOrEqual(out.cadence.maxHours);
      expect(Number.isInteger(out.maxRoundsPerDay)).toBe(true);
      expect(out.maxRoundsPerDay).toBeGreaterThan(0);
      expect(Array.isArray(out.interests)).toBe(true);
      expect(Array.isArray(out.avoidTopics)).toBe(true);
      expect(['plain', 'battle', 'brief', 'casual', 'coquettish', 'diary', 'teaser', 'custom'])
        .toContain(out.retell.style);
      expect(typeof out.retell.opener).toBe('boolean');
      expect(['off', 'big']).toContain(out.push.mode);
      expect(out.dailyTokenBudget).toBeGreaterThan(0);
      expect([0, 1, 2, 3]).toContain(out.autonomyLevel);
      expect(Array.isArray(out.mcpAllow)).toBe(true);
      expect(typeof out.writable).toBe('boolean');
      expect(Number.isInteger(out.guardrails.perCharPerDay)).toBe(true);
      expect(out.guardrails.perCharPerDay).toBeGreaterThan(0);
      expect(out.guardrails.globalPerDay).toBeGreaterThan(0);
      expect(typeof out.guardrails.paused).toBe('boolean');
    });
  }
});

describe('护栏（P5）：挂进终值、非法回落、模板不影响', () => {
  it('没配护栏 → 默认 2 次/天、同类 120 分钟、6 次/天', () => {
    const out = withTemplate('custom');
    expect(out.guardrails).toEqual({
      version: 1, perCharPerDay: 2, sameKindMinGapMinutes: 120,
      globalPerDay: 6, reserveTokensPerRun: 1600, paused: false,
    });
  });

  it('autonomy.guardrails 覆盖生效；越界值夹到天花板', () => {
    const out = merge(charOf({
      autonomy: {
        enabled: true, templateId: 'custom', version: 1,
        overrides: {},
        guardrails: { perCharPerDay: 3, sameKindMinGapMinutes: 90, globalPerDay: 99 },
      },
    }));
    expect(out.guardrails.perCharPerDay).toBe(3);
    expect(out.guardrails.sameKindMinGapMinutes).toBe(90);
    expect(out.guardrails.globalPerDay).toBe(24);
  });

  it('兼容 overrides.guardrails 落点；两处都有时 direct 优先', () => {
    const viaOverrides = merge(charOf({
      autonomy: {
        enabled: true, templateId: 'custom', version: 1,
        overrides: { guardrails: { perCharPerDay: 1 } },
      },
    }));
    expect(viaOverrides.guardrails.perCharPerDay).toBe(1);

    const both = merge(charOf({
      autonomy: {
        enabled: true, templateId: 'custom', version: 1,
        overrides: { guardrails: { perCharPerDay: 1 } },
        guardrails: { perCharPerDay: 4 },
      },
    }));
    expect(both.guardrails.perCharPerDay).toBe(4);
  });

  it('模板不会带护栏（护栏只由用户/共享配置决定）', () => {
    for (const templateId of ['night_player', 'morning_brief', 'surf_share']) {
      const out = withTemplate(templateId);
      expect(out.guardrails.perCharPerDay).toBe(2);
      expect(out.guardrails.globalPerDay).toBe(6);
    }
  });
});

function describeInput(input: unknown): string {
  if (typeof input === 'symbol') return 'Symbol';
  if (typeof input === 'bigint') return '10n';
  if (typeof input === 'function') return 'function';
  try {
    return JSON.stringify(input) ?? String(input);
  } catch {
    return String(input);
  }
}
