import { describe, it, expect } from 'vitest';
import {
  applyAutonomyLevel,
  isCapabilityEnabled,
  selectCapabilities,
  selectCapabilityPolicy,
  setCapabilityMode,
  toggleCapability,
  formatAirpEventTime,
  formatAirpEventRow,
  AIRP_LEVEL_OPTIONS,
  AIRP_RISK_LABELS,
} from '../../components/character/AirpPanel';
import { AIRP_CAPABILITIES } from '../../utils/airp/capabilityCatalog';
import { mergeAirpSettings, type AirpCapabilityPolicy, type AirpSettings } from '../../utils/airp/settings';

const ALL_IDS = ['a', 'b', 'c'];

const ALL_POLICY: AirpCapabilityPolicy = { mode: 'all', allow: [] };
const NONE_POLICY: AirpCapabilityPolicy = { mode: 'none', allow: [] };
const allow = (...ids: string[]): AirpCapabilityPolicy => ({ mode: 'allowlist', allow: ids });

const FULL: AirpSettings = {
  enabled: true,
  autonomyLevel: 3,
  directorModel: 'foo/bar',
  capabilities: ['a'],
  mcpAllow: ['srv-1'],
  writable: true,
  autonomy: { enabled: true, templateId: 'night_player', overrides: {}, version: 1 },
  version: 1,
};

describe('AIRP_LEVEL_OPTIONS（L0-L3 档位与一句后果）', () => {
  it('恰好四档 0-3，顺序稳定', () => {
    expect(AIRP_LEVEL_OPTIONS.map((option) => option.level)).toEqual([0, 1, 2, 3]);
  });

  it('每档都有非空 label 与 desc；L0 说明「静默」', () => {
    for (const option of AIRP_LEVEL_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.desc.length).toBeGreaterThan(0);
    }
    expect(AIRP_LEVEL_OPTIONS[0].desc).toContain('静默');
  });
});

describe('AIRP_RISK_LABELS（能力风险档中文标签）', () => {
  it('四种风险档都有标签', () => {
    for (const risk of ['read', 'low_write', 'confirm', 'forbidden'] as const) {
      expect(AIRP_RISK_LABELS[risk].length).toBeGreaterThan(0);
    }
  });

  it('目录里出现的每个风险档都能取到标签', () => {
    for (const capability of AIRP_CAPABILITIES) {
      expect(AIRP_RISK_LABELS[capability.risk]).toBeTruthy();
    }
  });
});

describe('applyAutonomyLevel（换档位只动 autonomyLevel，别的 airp 字段原样保留）', () => {
  it('没有 airp 时给安全默认 + 目标档位', () => {
    expect(applyAutonomyLevel(undefined, 1)).toEqual({
      enabled: false,
      autonomyLevel: 1,
      capabilities: [],
      mcpAllow: [],
      writable: false,
      version: 1,
    });
  });

  it('已有 airp：只改档位，导演模型 / 能力白名单 / MCP 白名单 / 可写 / autonomy 全保留', () => {
    const next = applyAutonomyLevel(FULL, 0);
    expect(next.autonomyLevel).toBe(0);
    expect(next.enabled).toBe(true);
    expect(next.directorModel).toBe('foo/bar');
    expect(next.capabilities).toEqual(['a']);
    expect(next.mcpAllow).toEqual(['srv-1']);
    expect(next.writable).toBe(true);
    expect(next.autonomy?.templateId).toBe('night_player');
    expect(next.version).toBe(1);
  });

  it('不改入参（返回新对象，autonomy 块不别名）', () => {
    const before = JSON.parse(JSON.stringify(FULL));
    const next = applyAutonomyLevel(FULL, 2);
    expect(FULL).toEqual(before);
    expect(next).not.toBe(FULL);
  });

  it('四档都能落盘', () => {
    for (const level of [0, 1, 2, 3] as const) {
      expect(applyAutonomyLevel(FULL, level).autonomyLevel).toBe(level);
    }
  });
});

describe('isCapabilityEnabled（按显式 all / allowlist / none 判定勾选态）', () => {
  it('all 对任何 id 都为真（含目录外 id）', () => {
    expect(isCapabilityEnabled(ALL_POLICY, 'a')).toBe(true);
    expect(isCapabilityEnabled(ALL_POLICY, 'not-in-catalog')).toBe(true);
  });

  it('allowlist 按 id 精确匹配', () => {
    expect(isCapabilityEnabled(allow('a', 'b'), 'a')).toBe(true);
    expect(isCapabilityEnabled(allow('a', 'b'), 'c')).toBe(false);
  });

  it('none 对任何 id 都为假，残留 allow 不许复活', () => {
    expect(isCapabilityEnabled(NONE_POLICY, 'a')).toBe(false);
    expect(isCapabilityEnabled({ mode: 'none', allow: ['a'] }, 'a')).toBe(false);
  });
});

describe('toggleCapability（勾选 = 显式白名单；勾满 = all，清空 = none）', () => {
  it('从 all 取消一项 → allowlist 列出其余项', () => {
    expect(toggleCapability(ALL_POLICY, 'b', ALL_IDS)).toEqual(allow('a', 'c'));
  });

  it('把刚才取消的项勾回来 → 回到 all', () => {
    expect(toggleCapability(allow('a', 'c'), 'b', ALL_IDS)).toEqual(ALL_POLICY);
  });

  it('allowlist 里取消一项 → 只删该项', () => {
    expect(toggleCapability(allow('a', 'b'), 'a', ALL_IDS)).toEqual(allow('b'));
  });

  it('allowlist 里补上最后缺的一项 → 回到 all', () => {
    expect(toggleCapability(allow('b', 'c'), 'a', ALL_IDS)).toEqual(ALL_POLICY);
  });

  it('从 none 勾上一个 → allowlist 只有它（不是 all）', () => {
    expect(toggleCapability(NONE_POLICY, 'a', ALL_IDS)).toEqual(allow('a'));
  });

  it('allowlist 取消最后一项 → none，不许悄悄变回 all', () => {
    expect(toggleCapability(allow('a'), 'a', ALL_IDS)).toEqual(NONE_POLICY);
  });

  it('不修改入参（纯函数）', () => {
    const policy = allow('a');
    toggleCapability(policy, 'b', ALL_IDS);
    expect(policy).toEqual(allow('a'));
  });

  it('白名单里混进目录外 id 时，不会误判为「勾满」而丢配置', () => {
    expect(toggleCapability(allow('ghost'), 'a', ALL_IDS)).toEqual(allow('ghost', 'a'));
  });

  it('all 态点目录外 id：有效集合不变，仍是 all', () => {
    expect(toggleCapability(ALL_POLICY, 'ghost', ALL_IDS)).toEqual(ALL_POLICY);
  });
});

describe('setCapabilityMode（面板上的「全部允许 / 全部禁止」）', () => {
  it('切到 all 直接清空白名单', () => {
    expect(setCapabilityMode(allow('a'), 'all', ALL_IDS)).toEqual(ALL_POLICY);
  });

  it('切到 none 直接禁用全部，且不保留任何 id', () => {
    expect(setCapabilityMode(ALL_POLICY, 'none', ALL_IDS)).toEqual(NONE_POLICY);
  });

  it('切到 allowlist 时沿用当前有效集合（从 all 就是全勾）', () => {
    expect(setCapabilityMode(ALL_POLICY, 'allowlist', ALL_IDS)).toEqual(allow('a', 'b', 'c'));
  });

  it('从 none 切到 allowlist 仍是 none（空 allowlist 不等于全开）', () => {
    expect(setCapabilityMode(NONE_POLICY, 'allowlist', ALL_IDS)).toEqual(NONE_POLICY);
  });
});

describe('selectCapabilities / selectCapabilityPolicy（面板读权限：损坏 / 导入的非数组值不炸渲染）', () => {
  it('旧字符串数组读成 allowlist，内容原样透传', () => {
    expect(selectCapabilities({ capabilities: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(selectCapabilityPolicy({ capabilities: ['a', 'b'] })).toEqual(allow('a', 'b'));
  });

  it('旧空数组读成 all（迁移保留原语义）', () => {
    expect(selectCapabilityPolicy({ capabilities: [] })).toEqual(ALL_POLICY);
    expect(selectCapabilityPolicy(undefined)).toEqual(ALL_POLICY);
  });

  it('显式 none 读成 none', () => {
    expect(selectCapabilityPolicy({ capabilityMode: 'none', capabilities: [] })).toEqual(NONE_POLICY);
  });

  it('非数组脏值（字符串 / 数字 / null / undefined）→ 空列表 + all（不炸渲染）', () => {
    for (const raw of [{ capabilities: 'oops' }, { capabilities: 42 }, { capabilities: null }, undefined]) {
      expect(selectCapabilities(raw)).toEqual([]);
      expect(selectCapabilityPolicy(raw)).toEqual(ALL_POLICY);
    }
  });

  it('与 mergeAirpSettings 同口径（归并等价）', () => {
    for (const raw of [{ capabilities: ['a', 5, 'b'] }, { capabilities: {} }, 'junk', null, undefined]) {
      expect(selectCapabilities(raw)).toEqual(mergeAirpSettings(raw).capabilities);
      expect(selectCapabilityPolicy(raw).allow).toEqual(mergeAirpSettings(raw).capabilities);
    }
  });
});

describe('formatAirpEventTime（M/D HH:mm，坏值回落占位）', () => {
  it('有效时间戳按本地时间格式化', () => {
    expect(formatAirpEventTime(new Date(2026, 0, 2, 3, 4).getTime())).toBe('1/2 03:04');
    expect(formatAirpEventTime(new Date(2026, 11, 31, 23, 59).getTime())).toBe('12/31 23:59');
  });

  it('缺值 / 非数字 / 非有限数 → 占位符', () => {
    expect(formatAirpEventTime(undefined)).toBe('—');
    expect(formatAirpEventTime('abc')).toBe('—');
    expect(formatAirpEventTime(Number.NaN)).toBe('—');
    expect(formatAirpEventTime(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('null 不当作 0（Number(null) === 0）→ 占位符', () => {
    expect(formatAirpEventTime(null)).toBe('—');
  });
});

describe('formatAirpEventRow（时间 + 类型 + 摘要 + 影响 / 交代标记）', () => {
  it('完整事件：字段逐个中文化、摘要去首尾空白', () => {
    const row = formatAirpEventRow({
      at: new Date(2026, 0, 2, 3, 4).getTime(),
      type: 'activity',
      summary: '  去楼下买了杯咖啡  ',
      impact: 'minor',
      disclosedToUser: true,
    });
    expect(row).toEqual({
      time: '1/2 03:04',
      type: 'activity',
      typeLabel: '活动',
      summary: '去楼下买了杯咖啡',
      impact: 'minor',
      impactLabel: '小事',
      disclosed: true,
      disclosureLabel: '已交代',
    });
  });

  it('缺摘要 / 空摘要 / 非字符串摘要 → 占位摘要', () => {
    for (const summary of [undefined, '', '   ', 42, null]) {
      const row = formatAirpEventRow({ at: 0, type: 'discovery', summary, impact: 'trace', disclosedToUser: false });
      expect(row.summary).toBe('（无摘要）');
    }
  });

  it('未交代的事件标记为未交代', () => {
    const row = formatAirpEventRow({ at: 0, type: 'social_trace', summary: '赞了条帖子', impact: 'trace', disclosedToUser: false });
    expect(row.disclosed).toBe(false);
    expect(row.disclosureLabel).toBe('未交代');
    expect(row.typeLabel).toBe('社交痕迹');
  });

  it('未知类型 / 未知影响档走兜底标签，不吐出 undefined', () => {
    const row = formatAirpEventRow({ at: 0, type: 'mystery', summary: 'x', impact: 'huge', disclosedToUser: undefined });
    expect(row.typeLabel).toBe('未知');
    expect(row.impactLabel).toBe('—');
    expect(row.summary).not.toContain('undefined');
    expect(row.typeLabel).not.toContain('undefined');
  });

  it('坏时间戳同样落到占位符', () => {
    const row = formatAirpEventRow({ at: 'nope', type: 'activity', summary: 'x', impact: 'major', disclosedToUser: true });
    expect(row.time).toBe('—');
    expect(row.impactLabel).toBe('大事');
  });
});
