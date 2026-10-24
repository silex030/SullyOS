import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  classifyEventVisibility,
  selectEventsByVisibility,
  selectEventsByType,
  selectUnprojectedEvents,
  selectCheckPhoneMaterial,
  renderCheckPhoneMaterialSection,
  CHECK_PHONE_PURCHASE_DISCIPLINE,
  renderSceneBlock,
  type AirpEventVisibility,
} from './projection';
import type { AirpCommittedEvent } from './commit';

type EventType = AirpCommittedEvent['type'];
type EventImpact = AirpCommittedEvent['impact'];

function makeEvent(overrides: Partial<AirpCommittedEvent> & { at: number }): AirpCommittedEvent {
  return {
    id: `e-${overrides.at}`,
    charId: 'char-1',
    type: 'activity',
    summary: `s-${overrides.at}`,
    participants: [],
    impact: 'minor',
    authority: 'runtime_state',
    disclosedToUser: false,
    source: { kind: 'runtime' },
    ...overrides,
  };
}

describe('classifyEventVisibility — 21-combo matrix', () => {
  const MATRIX: Array<[EventType, EventImpact, AirpEventVisibility]> = [
    ['conversation', 'trace', 'private'],
    ['conversation', 'minor', 'private'],
    ['conversation', 'major', 'private'],
    ['activity', 'trace', 'public'],
    ['activity', 'minor', 'public'],
    ['activity', 'major', 'private'],
    ['movement', 'trace', 'public'],
    ['movement', 'minor', 'public'],
    ['movement', 'major', 'private'],
    ['schedule', 'trace', 'public'],
    ['schedule', 'minor', 'public'],
    ['schedule', 'major', 'private'],
    ['relationship', 'trace', 'private'],
    ['relationship', 'minor', 'private'],
    ['relationship', 'major', 'private'],
    ['discovery', 'trace', 'public'],
    ['discovery', 'minor', 'public'],
    ['discovery', 'major', 'private'],
    ['social_trace', 'trace', 'trace'],
    ['social_trace', 'minor', 'trace'],
    ['social_trace', 'major', 'private'],
  ];

  it('covers all 7 x 3 = 21 combos exactly once (anti-vacuity)', () => {
    expect(MATRIX).toHaveLength(21);
    const covered = new Set(MATRIX.map(([type, impact]) => `${type}:${impact}`));
    expect(covered.size).toBe(21);
  });

  it.each(MATRIX)('%s + %s -> %s', (type, impact, expected) => {
    expect(classifyEventVisibility({ type, impact })).toBe(expected);
  });

  it('major social_trace is private, not trace (major check wins)', () => {
    expect(classifyEventVisibility({ type: 'social_trace', impact: 'major' })).toBe('private');
  });

  it('conversation + trace is private, not public', () => {
    expect(classifyEventVisibility({ type: 'conversation', impact: 'trace' })).toBe('private');
  });

  it('unknown combos fall back to private (default-deny)', () => {
    expect(
      classifyEventVisibility({ type: 'mystery' as EventType, impact: 'minor' }),
    ).toBe('private');
    expect(
      classifyEventVisibility({ type: 'activity', impact: 'huge' as EventImpact }),
    ).toBe('private');
  });
});

describe('selectEventsByVisibility', () => {
  const events = [
    makeEvent({ id: 'a', type: 'activity', impact: 'minor', at: 100 }),
    makeEvent({ id: 'b', type: 'conversation', impact: 'minor', at: 300 }),
    makeEvent({ id: 'c', type: 'social_trace', impact: 'trace', at: 200 }),
    makeEvent({ id: 'd', type: 'movement', impact: 'trace', at: 500 }),
    makeEvent({ id: 'e', type: 'activity', impact: 'major', at: 400 }),
  ];

  it('filters by class', () => {
    expect(selectEventsByVisibility(events, 'public').map((e) => e.id)).toEqual(['d', 'a']);
    expect(selectEventsByVisibility(events, 'private').map((e) => e.id)).toEqual(['e', 'b']);
    expect(selectEventsByVisibility(events, 'trace').map((e) => e.id)).toEqual(['c']);
  });

  it('re-sorts defensively at-desc even when the input is unsorted', () => {
    const unsorted = [
      makeEvent({ id: 'x1', at: 10 }),
      makeEvent({ id: 'x3', at: 30 }),
      makeEvent({ id: 'x2', at: 20 }),
    ];
    expect(selectEventsByVisibility(unsorted, 'public').map((e) => e.id)).toEqual([
      'x3',
      'x2',
      'x1',
    ]);
  });

  it('keeps tie order stable (input order wins)', () => {
    const tied = [
      makeEvent({ id: 't1', at: 50 }),
      makeEvent({ id: 't2', at: 50 }),
      makeEvent({ id: 't3', at: 50 }),
    ];
    expect(selectEventsByVisibility(tied, 'public').map((e) => e.id)).toEqual(['t1', 't2', 't3']);
  });

  it('does not mutate the input array', () => {
    const input = [
      makeEvent({ id: 'm1', at: 1 }),
      makeEvent({ id: 'm2', at: 3 }),
      makeEvent({ id: 'm3', at: 2 }),
    ];
    const snapshot = input.map((e) => e.id);
    selectEventsByVisibility(input, 'public');
    expect(input.map((e) => e.id)).toEqual(snapshot);
  });

  it('limit: undefined means no limit', () => {
    expect(selectEventsByVisibility(events, 'public', undefined)).toHaveLength(2);
    expect(selectEventsByVisibility(events, 'public')).toHaveLength(2);
  });

  it('limit: 0 and negatives return []', () => {
    expect(selectEventsByVisibility(events, 'public', 0)).toEqual([]);
    expect(selectEventsByVisibility(events, 'public', -3)).toEqual([]);
  });

  it('limit: positive takes the newest N', () => {
    expect(selectEventsByVisibility(events, 'public', 1).map((e) => e.id)).toEqual(['d']);
  });

  it('returns [] when nothing matches', () => {
    expect(selectEventsByVisibility([makeEvent({ at: 1 })], 'trace')).toEqual([]);
  });
});

describe('selectEventsByType', () => {
  const events = [
    makeEvent({ id: 'a', type: 'activity', impact: 'minor', at: 100 }),
    makeEvent({ id: 'b', type: 'movement', impact: 'trace', at: 400 }),
    makeEvent({ id: 'c', type: 'activity', impact: 'major', at: 300 }),
    makeEvent({ id: 'd', type: 'movement', impact: 'minor', at: 200 }),
  ];

  it('filters by type and sorts at-desc', () => {
    expect(selectEventsByType(events, 'movement').map((e) => e.id)).toEqual(['b', 'd']);
    expect(selectEventsByType(events, 'activity').map((e) => e.id)).toEqual(['c', 'a']);
  });

  it('applies the limit rules', () => {
    expect(selectEventsByType(events, 'movement', 1).map((e) => e.id)).toEqual(['b']);
    expect(selectEventsByType(events, 'movement', 0)).toEqual([]);
    expect(selectEventsByType(events, 'movement', -1)).toEqual([]);
  });

  it('returns [] for a type with no matches', () => {
    expect(selectEventsByType(events, 'discovery')).toEqual([]);
  });
});

describe('selectUnprojectedEvents', () => {
  const events = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('returns every event when nothing has been projected yet', () => {
    expect(selectUnprojectedEvents(events, new Set<string>()).map((e) => e.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(selectUnprojectedEvents(events, []).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns [] when every event is already projected', () => {
    expect(selectUnprojectedEvents(events, new Set(['a', 'b', 'c']))).toEqual([]);
    expect(selectUnprojectedEvents(events, ['a', 'b', 'c'])).toEqual([]);
  });

  it('returns only the unprojected ones (mixed set/array input)', () => {
    expect(selectUnprojectedEvents(events, new Set(['b'])).map((e) => e.id)).toEqual(['a', 'c']);
    expect(selectUnprojectedEvents(events, ['a', 'c']).map((e) => e.id)).toEqual(['b']);
  });

  it('preserves the incoming order and never re-sorts', () => {
    const unsorted = [{ id: 'z' }, { id: 'm' }, { id: 'a' }];
    expect(selectUnprojectedEvents(unsorted, ['a', 'z']).map((e) => e.id)).toEqual(['m']);
  });

  it('dedupes repeated ids inside the projected set / array', () => {
    expect(selectUnprojectedEvents(events, ['b', 'b', 'b']).map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('handles empty inputs', () => {
    expect(selectUnprojectedEvents([], new Set(['a']))).toEqual([]);
    expect(selectUnprojectedEvents([], [])).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = [{ id: 'a' }, { id: 'b' }];
    const snapshot = [...input];
    selectUnprojectedEvents(input, ['a']);
    expect(input).toEqual(snapshot);
  });

  it('tolerates a missing events array', () => {
    expect(
      selectUnprojectedEvents(undefined as unknown as { id: string }[], ['a']),
    ).toEqual([]);
  });

  it('keeps the original event objects (no cloning / extra-property loss)', () => {
    const rich = [{ id: 'a', summary: 'hi' }];
    expect(selectUnprojectedEvents(rich, [])[0]).toBe(rich[0]);
  });
});

describe('selectCheckPhoneMaterial', () => {
  const rel = (at: number, id: string, extra: Partial<AirpCommittedEvent> = {}) =>
    makeEvent({ id, at, type: 'relationship', impact: 'minor', ...extra });
  const act = (at: number, id: string) => makeEvent({ id, at, type: 'activity', impact: 'minor' });
  const social = (at: number, id: string) =>
    makeEvent({ id, at, type: 'social_trace', impact: 'trace' });

  it('maps each CheckPhone record type to its locked event type', () => {
    const events = [
      rel(100, 'r'),
      act(200, 'a'),
      social(300, 's'),
      makeEvent({ id: 'm', at: 400, type: 'movement', impact: 'trace' }),
    ];
    expect(selectCheckPhoneMaterial(events, [], 'chat').map((e) => e.id)).toEqual(['r']);
    expect(selectCheckPhoneMaterial(events, [], 'order').map((e) => e.id)).toEqual(['a']);
    expect(selectCheckPhoneMaterial(events, [], 'delivery').map((e) => e.id)).toEqual(['a']);
    expect(selectCheckPhoneMaterial(events, [], 'social').map((e) => e.id)).toEqual(['s']);
  });

  it('skips unmapped record types (call / contacts / custom app ids) entirely', () => {
    const events = [rel(100, 'r'), act(200, 'a')];
    for (const type of ['call', 'contacts', 'weibo', '']) {
      expect(selectCheckPhoneMaterial(events, [], type)).toEqual([]);
    }
    expect(
      selectCheckPhoneMaterial(events, [], undefined as unknown as string),
    ).toEqual([]);
  });

  it('drops events that were already projected (Set and array forms)', () => {
    const events = [rel(100, 'a'), rel(200, 'b')];
    expect(selectCheckPhoneMaterial(events, ['b'], 'chat').map((e) => e.id)).toEqual(['a']);
    expect(selectCheckPhoneMaterial(events, new Set(['a']), 'chat').map((e) => e.id)).toEqual(['b']);
  });

  it('re-sorts at-desc and caps at 5 newest', () => {
    const events = [1, 2, 3, 4, 5, 6, 7].map((n) => rel(n * 100, `e${n}`));
    expect(selectCheckPhoneMaterial(events, [], 'chat').map((e) => e.id)).toEqual([
      'e7',
      'e6',
      'e5',
      'e4',
      'e3',
    ]);
  });

  it('honours a custom limit and returns [] for limit <= 0', () => {
    const events = [1, 2, 3].map((n) => act(n * 100, `e${n}`));
    expect(selectCheckPhoneMaterial(events, [], 'order', 2).map((e) => e.id)).toEqual(['e3', 'e2']);
    expect(selectCheckPhoneMaterial(events, [], 'order', 0)).toEqual([]);
    expect(selectCheckPhoneMaterial(events, [], 'order', -1)).toEqual([]);
  });

  it('returns [] for empty / missing events and never mutates or clones', () => {
    expect(selectCheckPhoneMaterial([], [], 'chat')).toEqual([]);
    expect(
      selectCheckPhoneMaterial(undefined as unknown as AirpCommittedEvent[], [], 'chat'),
    ).toEqual([]);
    const events = [rel(100, 'a'), rel(200, 'b')];
    const snapshot = events.map((e) => e.id);
    const picked = selectCheckPhoneMaterial(events, [], 'chat');
    expect(events.map((e) => e.id)).toEqual(snapshot);
    expect(picked[0]).toBe(events[1]);
  });
});

describe('renderCheckPhoneMaterialSection', () => {
  it('returns an empty string for empty / missing events (prompt stays byte-identical)', () => {
    expect(renderCheckPhoneMaterialSection([])).toBe('');
    expect(
      renderCheckPhoneMaterialSection(undefined as unknown as AirpCommittedEvent[]),
    ).toBe('');
  });

  it('renders one "- {summary}" line per event plus the honesty rule', () => {
    const block = renderCheckPhoneMaterialSection([
      makeEvent({ id: 'r', at: 100, type: 'relationship', summary: '和阿禾聊了搬家的事' }),
      makeEvent({ id: 'a', at: 200, type: 'activity', summary: '下单了一个机械键盘' }),
    ]);
    expect(block).toContain('### 最近真实发生过的事 (Recent Events)');
    expect(block).toContain('- 和阿禾聊了搬家的事\n- 下单了一个机械键盘');
    expect(block).toContain('不得虚构');
    expect(block.startsWith('\n\n')).toBe(true);
  });

  it('omitting options keeps the strict honesty rule byte-identical', () => {
    const events = [makeEvent({ id: 'r', at: 100, type: 'relationship', summary: '和阿禾聊了搬家' })];
    expect(renderCheckPhoneMaterialSection(events)).toBe(
      renderCheckPhoneMaterialSection(events, {}),
    );
    expect(renderCheckPhoneMaterialSection(events)).toBe(
      renderCheckPhoneMaterialSection(events, { discipline: undefined }),
    );
    expect(renderCheckPhoneMaterialSection(events)).toContain('一律不得虚构，宁缺勿造');
    expect(renderCheckPhoneMaterialSection(events)).not.toContain('按原有模拟规则生成');
  });

  it('accepts a custom discipline (purchases seam uses the sim-compatible variant)', () => {
    const events = [makeEvent({ id: 'a', at: 200, type: 'activity', summary: '下单了一个机械键盘' })];
    const block = renderCheckPhoneMaterialSection(events, {
      discipline: CHECK_PHONE_PURCHASE_DISCIPLINE,
    });
    expect(block).toContain('### 最近真实发生过的事 (Recent Events)');
    expect(block).toContain('- 下单了一个机械键盘');
    expect(block).toContain('买的东西和时间以此为准');
    expect(block).toContain('金额、商家等明细按原有模拟规则生成，但不得与这些事实冲突');
    expect(block).not.toContain('一律不得虚构，宁缺勿造');
  });

  it('keeps the empty-material hinge (byte-identical prompt) with a custom discipline', () => {
    expect(renderCheckPhoneMaterialSection([], { discipline: CHECK_PHONE_PURCHASE_DISCIPLINE })).toBe('');
    expect(
      renderCheckPhoneMaterialSection(undefined as unknown as AirpCommittedEvent[], {
        discipline: CHECK_PHONE_PURCHASE_DISCIPLINE,
      }),
    ).toBe('');
  });
});

describe('renderSceneBlock', () => {
  const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);

  it('renders the time line with the directorPrompt wall-clock format', () => {
    // Timestamp substring duplicated from utils/airp/directorPrompt.test.ts:124:
    // that assertion checks the whole bullet line `- 时间：2026-01-02 11:04（Asia/Shanghai）`,
    // while this test checks the timestamp part only (no leading `- `). Hardcoded on
    // purpose: this leaf module must not import directorPrompt, but the clocks must match.
    const block = renderSceneBlock({ now: NOW, tzId: 'Asia/Shanghai', movements: [] });
    expect(block).toBe('时间：2026-01-02 11:04（Asia/Shanghai）');
  });

  it('renders the full block with at-desc movements and max 3 entries', () => {
    const block = renderSceneBlock({
      now: NOW,
      tzId: 'Asia/Shanghai',
      locationLabel: '家中书房',
      activity: '写代码',
      energy: 3,
      mood: '平静',
      weatherText: '小雨 16℃',
      movements: [
        { summary: '去便利店', locationLabel: '楼下便利店', at: NOW - 1000 },
        { summary: '散步', locationLabel: '河边', at: NOW - 2000 },
        { summary: '买咖啡', locationLabel: '咖啡店', at: NOW - 3000 },
        { summary: '回家', locationLabel: '家', at: NOW - 4000 },
      ],
    });

    expect(block).toBe(
      '时间：2026-01-02 11:04（Asia/Shanghai）\n' +
        '地点：家中书房\n' +
        '活动：写代码（精力 3，情绪 平静）\n' +
        '天气：小雨 16℃\n' +
        '近期行踪：\n' +
        '- 去便利店\n' +
        '- 散步\n' +
        '- 买咖啡',
    );
  });

  it('renders movements newest-first regardless of input order', () => {
    const block = renderSceneBlock({
      now: NOW,
      tzId: 'Asia/Shanghai',
      movements: [
        { summary: 'oldest', at: 10 },
        { summary: 'newest', at: 30 },
        { summary: 'middle', at: 20 },
      ],
    });
    expect(block).toContain('近期行踪：\n- newest\n- middle\n- oldest');
  });

  it('omits absent lines', () => {
    const block = renderSceneBlock({
      now: NOW,
      tzId: 'Asia/Shanghai',
      activity: '写代码',
      movements: [],
    });
    expect(block).toBe('时间：2026-01-02 11:04（Asia/Shanghai）\n活动：写代码');
  });

  it('appends only the present of energy / mood', () => {
    expect(
      renderSceneBlock({ now: NOW, tzId: 'UTC', activity: '发呆', energy: 1, movements: [] }),
    ).toContain('活动：发呆（精力 1）');
    expect(
      renderSceneBlock({ now: NOW, tzId: 'UTC', activity: '发呆', mood: '放空', movements: [] }),
    ).toContain('活动：发呆（情绪 放空）');
    expect(
      renderSceneBlock({ now: NOW, tzId: 'UTC', energy: 5, mood: '放空', movements: [] }),
    ).not.toContain('活动：');
  });

  it('skips movement entries with no summary', () => {
    const block = renderSceneBlock({
      now: NOW,
      tzId: 'UTC',
      movements: [
        { summary: '', locationLabel: '某处', at: 30 },
        { summary: '真行踪', locationLabel: '别处', at: 20 },
      ],
    });
    expect(block).toContain('近期行踪：\n- 真行踪');
    expect(block).not.toContain('某处');
  });

  it('falls back to an ISO/UTC label for an unknown tzId', () => {
    let block = '';
    expect(() => {
      block = renderSceneBlock({ now: NOW, tzId: 'Not/AZone', movements: [] });
    }).not.toThrow();
    expect(block).toBe('时间：2026-01-02T03:04:05.000Z（UTC）');
    expect(block).not.toContain('undefined');
  });

  it('resolves the device time zone when tzId is absent/blank (non-UTC wall line)', () => {
    const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: deviceTz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
    }).formatToParts(new Date(NOW));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const expectedWall = `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;

    const block = renderSceneBlock({ now: NOW, tzId: '', movements: [] });
    expect(block).toBe(`时间：${expectedWall}（${deviceTz}）`);
    if (deviceTz !== 'UTC') expect(block).not.toContain('（UTC）');
    expect(block).not.toContain('undefined');
  });

  it('treats a whitespace-only tzId as absent (same as undefined)', () => {
    const absent = renderSceneBlock({ now: NOW, tzId: '', movements: [] });
    const blank = renderSceneBlock({ now: NOW, tzId: '   ', movements: [] });
    expect(blank).toBe(absent);
    expect(renderSceneBlock({ now: NOW, tzId: undefined as unknown as string, movements: [] })).toBe(absent);
    if (Intl.DateTimeFormat().resolvedOptions().timeZone !== 'UTC') {
      expect(blank).not.toContain('（UTC）');
    }
  });

  it('returns an empty string when there is nothing renderable', () => {
    expect(renderSceneBlock({ now: Number.NaN, tzId: 'UTC', movements: [] })).toBe('');
  });

  it('tolerates a missing movements array', () => {
    const block = renderSceneBlock({
      now: NOW,
      tzId: 'UTC',
      movements: undefined as unknown as AirpCommittedEvent[],
    });
    expect(block).toBe('时间：2026-01-02 03:04（UTC）');
  });

  it('never renders the literal "undefined"', () => {
    const outputs = [
      renderSceneBlock({ now: NOW, tzId: 'UTC', movements: [] }),
      renderSceneBlock({ now: NOW, tzId: 'UTC', activity: 'a', movements: [] }),
      renderSceneBlock({
        now: NOW,
        tzId: 'UTC',
        movements: [{ summary: 's', at: 1 }],
      }),
    ];
    for (const output of outputs) expect(output).not.toContain('undefined');
  });
});

describe('module purity (leaf stays worker-safe)', () => {
  // 模块头注释里也出现 import/export 字样，先剥掉注释再扫代码，避免注释误判。
  const code = readFileSync(new URL('./projection.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  it('has no side-effect imports, re-exports, dynamic imports or requires', () => {
    // 运行时依赖的每一种隐蔽写法都要被这条挡住（旧版只看以 import 开头的行）。
    expect(code).not.toMatch(/\bimport\s*['"]/); // 副作用导入 import './x'
    expect(code).not.toMatch(/\bexport\b[\s\S]*?\bfrom\s*['"]/); // 再导出 export ... from './x'
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bimport\s*\(/); // 动态 import('./x')
  });

  it('only type-imports ./commit (multiline-safe; ./types is not imported)', () => {
    // 多行 import 也要整条取到 specifier：旧写法逐行匹配，多行声明会取不到 from 而假绿。
    const statements = code.match(/\bimport\s[\s\S]*?\bfrom\s*['"][^'"]+['"]/g) ?? [];
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.startsWith('import type')).toBe(true);
      const specifier = statement.match(/from\s*['"]([^'"]+)['"]$/)?.[1];
      expect(specifier).toBe('./commit');
    }
  });
});
