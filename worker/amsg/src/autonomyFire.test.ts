// worker/amsg/src/autonomyFire.test.ts
// 自主回合（`autonomous_round`）这一轮的回归守卫。
//
// 三块职责分开钉：
//   1. 纯函数（后处理三件 / 两层容错解析 / 反刍输入 / 提示词组装 / 推送判定）——直接喂值；
//   2. D1 holder 的纪律——没配上就整轮跳过，绝不抛；
//   3. 整条 kind 分派链（经 amsgHooks）——证明注册表接的是真 handler，且落库/信封/回账
//      都真的发生了。
import { afterEach, describe, expect, it, vi } from 'vitest';

import { amsgHooks } from './index';
import { AUTONOMOUS_ROUND_KIND } from '../../../utils/airp/autonomySettings';
import type { ResolvedAirpAutonomy } from '../../../utils/airp/autonomySettings';
import { AMSG_FIRE_PACK_KEY, FIRE_PACK_VERSION, amsgStateNamespace, parseFirePack, type AmsgFirePack } from '../../../utils/amsgFirePack';
import { AMSG_TASK_KIND_KEY } from '../../../utils/amsgTaskKinds';
import {
  AUTONOMY_BAD_OUTPUT_REASON,
  AUTONOMY_FIRE_SKIP,
  AUTONOMY_NOTE_MAX_CHARS,
  AUTONOMY_ROUND_OVERRIDE,
  AUTONOMY_WORKFLOW_SKIP,
  autonomyRoundHandler,
  buildAutonomyPerceptionBlock,
  buildAutonomyRoundPrompt,
  buildWorkflowExecutionPrompt,
  collectBurntLines,
  configureAutonomyFireDb,
  configureAutonomyFireMasterKey,
  dominantAutonomyKind,
  extractDialogueTail,
  fullStopNote,
  isWithinQuietHours,
  parseAutonomyRoundReply,
  postProcessNote,
  readAutonomyPlanMeta,
  shouldPushAutonomy,
  stripThroatClearing,
  washMarkdownLinks,
} from './autonomyFire';
import { buildWantToSharePush } from './instantChat';
import type { AutonomyDb, AutonomyStatement } from './autonomyStore';
import type { RuminationPage } from './autonomyRumination';

const CHAR_ID = 'preset-nyah';
const NOW = Date.parse('2026-09-16T12:00:00.000Z'); // 角色时区（Asia/Shanghai）20:00
const HOUR = 60 * 60 * 1000;

afterEach(() => {
  // holder 是模块级单例：每个用例自己喂库，用完必须清回 null，否则下一条用例会串味。
  configureAutonomyFireDb(null);
  // 到点复核护栏：假库没有这一行 → status='absent' → 默认未暂停（测试口径）。
  configureAutonomyFireMasterKey('test-master-key');
});

// ─── 夹具 ────────────────────────────────────────────────────────────────

const baseAutonomy = (overrides: Partial<ResolvedAirpAutonomy> = {}): ResolvedAirpAutonomy => ({
  enabled: true,
  cadence: { minHours: 2, maxHours: 4 },
  maxRoundsPerDay: 2,
  interests: [],
  avoidTopics: [],
  retell: { style: 'plain', maxItems: 5, maxChars: 800, opener: false },
  push: { mode: 'big', maxPerDay: 1, cooldownMinutes: 0 },
  dailyTokenBudget: 100_000,
  autonomyLevel: 2,
  mcpAllow: [],
  writable: false,
  guardrails: {
    version: 1, perCharPerDay: 2, sameKindMinGapMinutes: 120,
    globalPerDay: 6, reserveTokensPerRun: 1600, paused: false,
  },
  ...overrides,
});

const buildPack = (overrides: Partial<AmsgFirePack> = {}): AmsgFirePack => ({
  v: 7,
  template: [
    '【角色系统设定】',
    '你是一个会在深夜突然想起对方的人。',
    '【最近对话上下文】',
    '【小明】',
    '今天搬完家了，累瘫',
    '【Nyah】',
    '那早点睡，别硬撑',
    '【当前时刻补充】',
    '当前本地时间（你所在地）：{{AMSG_CURRENT_TIME}}',
    '【开口之前】',
    '已经发生过 → 什么都不要输出。一个字都不要写。',
  ].join('\n'),
  lastUserMessageAt: NOW - 3 * HOUR,
  tzId: 'Asia/Shanghai',
  userTzId: 'Asia/Shanghai',
  targetName: '小明',
  builtAt: NOW - HOUR,
  pendingTasks: [],
  scene: null,
  selfScheduleEnabled: true,
  autonomy: baseAutonomy(),
  ...overrides,
});

interface FakeExperienceRow {
  id: string;
  char_id: string;
  created_at: number;
  q: string | null;
  note: string;
  kind: string;
  importance: number;
  pushed: number;
}

const experienceRow = (overrides: Partial<FakeExperienceRow> = {}): FakeExperienceRow => ({
  id: overrides.id ?? crypto.randomUUID(),
  char_id: CHAR_ID,
  created_at: overrides.created_at ?? NOW - 2 * HOUR,
  q: overrides.q ?? null,
  note: overrides.note ?? '记一条',
  kind: overrides.kind ?? 'surf',
  importance: overrides.importance ?? 0,
  pushed: overrides.pushed ?? 0,
});

/**
 * 记录型假 D1：只认 handler / store 真用到的那几条 SQL（前缀 + 关键词匹配）。
 * `stateRows` 直接喂 autonomy_state 的行，缺行时 store 自己回落零值。
 */
const createFakeDb = (seed: {
  experiences?: FakeExperienceRow[];
  state?: Record<string, Record<string, unknown>>;
  /**
   * owner 反查的答案（`SELECT user_id FROM client_state WHERE namespace = ?`）。
   * `userId: null` = 行在但 user_id 空 → 必须 fail-closed。
   */
  owner?: { userId?: string | null; rowMissing?: boolean };
} = {}) => {
  const experiences = [...(seed.experiences ?? [])];
  const stateRows = new Map<string, Record<string, unknown>>(Object.entries(seed.state ?? {}));
  const sql: string[] = [];

  const db: AutonomyDb = {
    prepare(text: string) {
      let args: unknown[] = [];
      const statement: AutonomyStatement = {
        bind(...next: unknown[]) {
          args = next;
          return statement;
        },
        async run() {
          sql.push(text);
          if (text.startsWith('INSERT INTO autonomy_experiences')) {
            const [id, charId, createdAt, q, note, kind, importance, pushed] = args;
            experiences.push({
              id: id as string,
              char_id: charId as string,
              created_at: createdAt as number,
              q: q as string | null,
              note: note as string,
              kind: kind as string,
              importance: importance as number,
              pushed: pushed as number,
            });
          }
          if (text.startsWith('INSERT INTO autonomy_state')) {
            const [
              charId, lastRoundAt, lastPushAt, failStreak,
              roundsDate, roundsToday, tokensDate, tokensToday, configHash,
            ] = args;
            stateRows.set(charId as string, {
              char_id: charId,
              last_round_at: lastRoundAt,
              last_push_at: lastPushAt,
              fail_streak: failStreak,
              rounds_date: roundsDate,
              rounds_today: roundsToday,
              tokens_date: tokensDate,
              tokens_today: tokensToday,
              config_hash: configHash,
            });
          }
          return { meta: { changes: 1 } };
        },
        async first() {
          sql.push(text);
          if (text.includes('SELECT user_id FROM client_state')) {
            if (seed.owner?.rowMissing) return null;
            return { user_id: seed.owner?.userId === undefined ? 'u1' : seed.owner.userId };
          }
          return stateRows.get(args[0] as string) ?? null;
        },
        async all() {
          sql.push(text);
          if (text.includes('pushed = 1')) {
            const [charId, since] = args as [string, number];
            return {
              results: experiences
                .filter((row) => row.char_id === charId && row.pushed === 1 && row.created_at >= since)
                .map((row) => ({ created_at: row.created_at })),
            };
          }
          const [charId, since, limit] = args as [string, number, number];
          return {
            results: experiences
              .filter((row) => row.char_id === charId && row.created_at >= since)
              .sort((a, b) => b.created_at - a.created_at)
              .slice(0, limit)
              .map((row) => ({ q: row.q, created_at: row.created_at })),
          };
        },
      };
      return statement;
    },
  };

  return { db, experiences, stateRows, sql };
};

/** 造一份够 kind 分派用的 fire ctx（只喂 fire_pack 那一行）。 */
const makeFireCtx = (pack: AmsgFirePack) => {
  const scratch: Record<string, unknown> = {};
  const readState = vi.fn(async (namespace: string) => (
    namespace === amsgStateNamespace(CHAR_ID)
      ? [{ key: AMSG_FIRE_PACK_KEY, value: JSON.stringify(pack) }]
      : []
  ));
  return {
    ctx: {
      task: {
        id: 11,
        uuid: 'task-uuid-autonomy',
        contactName: 'Nyah',
        recurrenceType: 'none',
        nextSendAt: new Date(NOW).toISOString(),
        metadata: { charId: CHAR_ID, [AMSG_TASK_KIND_KEY]: AUTONOMOUS_ROUND_KIND },
      },
      userId: 'u1',
      readState,
      now: new Date(NOW),
      scratch,
    } as never,
    scratch,
  };
};

const makeSessionCtx = (
  scratch: Record<string, unknown>,
  llmOutputText: string,
  usage?: Record<string, number>,
) => {
  const emitResult = vi.fn(async (_payload: Record<string, unknown>) => ({ messageId: 'm1', pushed: false }));
  return {
    ctx: {
      sessionId: 'sess-autonomy',
      llmResponse: {},
      llmOutputText,
      metadata: {},
      scratch,
      emitResult,
      taskId: 11,
      taskUuid: 'task-uuid-autonomy',
      occurrenceMs: NOW,
      ...(usage ? { usage } : {}),
    } as never,
    emitResult,
  };
};

/** 跑完整一轮：beforeFire（拼提示词）+ onLLMOutput（解析落库发结果）。 */
const runRound = async (args: {
  pack?: AmsgFirePack;
  reply: string;
  seed?: Parameters<typeof createFakeDb>[0];
  usage?: Record<string, number>;
  withEmitResult?: boolean;
}) => {
  const fake = createFakeDb(args.seed);
  configureAutonomyFireDb(fake.db);
  configureAutonomyFireMasterKey('test-master-key');
  const { ctx: fireCtx, scratch } = makeFireCtx(args.pack ?? buildPack());
  const plan = await amsgHooks.onBeforeFire(fireCtx);
  const { ctx, emitResult } = makeSessionCtx(scratch, args.reply, args.usage);
  if (args.withEmitResult === false) delete (ctx as unknown as { emitResult?: unknown }).emitResult;
  const decision = await amsgHooks.onLLMOutput(ctx);
  return { plan, decision, emitResult, ...fake };
};

// ─── 后处理三件 ──────────────────────────────────────────────────────────

describe('autonomyFire 后处理三件', () => {
  it('禁清嗓子：开头的口水话削掉，连削多道', () => {
    expect(stripThroatClearing('翻到了：深海那边有条沉船')).toBe('深海那边有条沉船');
    expect(stripThroatClearing('记一下，查到了那边很冷')).toBe('那边很冷');
    expect(stripThroatClearing('这边风很大')).toBe('这边风很大');
  });

  it('洗链接：带词的只留词，裸网址整段抹掉', () => {
    const washed = washMarkdownLinks('看[沉船资料](https://example.com/a)时顺手存了 https://b.com/x，挺深');
    expect(washed).toContain('沉船资料');
    expect(washed).toContain('挺深');
    expect(washed).not.toContain('http');
    expect(washed).not.toContain('example.com');
  });

  it('整句收笔：超帽退到最后一个整句；没有整句就抹吊尾标点', () => {
    const capped = fullStopNote('第一句够长了。第二句也够长了。第三句会被裁掉半截句子', 16);
    expect(capped).toBe('第一句够长了。第二句也够长了。');
    expect(fullStopNote('一二三四五六七八九十', 5)).toBe('一二三四五');
    expect(fullStopNote('一个没有句号的长句子一直写下去', 6)).toBe('一个没有句号');
  });

  it('三件合起来：清嗓子 → 洗链接 → 收笔，削空就当这条没救', () => {
    const note = postProcessNote('翻到了：[资料](https://a.example)里写着沉船的事', 12);
    expect(note).toBe('资料里写着沉船的事');
    expect(postProcessNote('记一下：翻到了', 100)).toBe('');
  });
});

// ─── 两层容错解析 ────────────────────────────────────────────────────────

describe('autonomyFire 输出解析', () => {
  it('合法 JSON：逐项读出，未知 event type 丢掉（不致命）', () => {
    const reply = parseAutonomyRoundReply(JSON.stringify({
      v: 1,
      experiences: [{ q: '沉船', note: '深海那边有条沉船', kind: 'surf', importance: 2 }],
      proposedEvents: [
        { type: 'discovery', summary: '翻到一条沉船记录', impact: 'minor' },
        { type: 'telepathy', summary: '认不出来的类型', impact: 'major' },
      ],
    }));
    expect(reply).not.toBeNull();
    expect(reply!.experiences).toEqual([{ q: '沉船', note: '深海那边有条沉船', kind: 'surf', importance: 2 }]);
    expect(reply!.proposedEvents).toEqual([
      { type: 'discovery', summary: '翻到一条沉船记录', impact: 'minor' },
    ]);
    expect(reply!.rested).toBe(false);
  });

  it('围栏里的 JSON 也认（第一层容错）', () => {
    const reply = parseAutonomyRoundReply('```json\n{"v":1,"experiences":[]}\n```');
    expect(reply?.rested).toBe(true);
  });

  it('rest:true → 这一轮就是歇了', () => {
    const reply = parseAutonomyRoundReply('{"v":1,"rest":true}');
    expect(reply).toEqual({ rested: true, experiences: [], proposedEvents: [], workflowCandidates: [] });
  });

  it('版本或形状非法 → 判失败（回 null）', () => {
    expect(parseAutonomyRoundReply('{"v":2,"experiences":[]}')).toBeNull();
    expect(parseAutonomyRoundReply('{"v":1,"rest":"yes"}')).toBeNull();
    expect(parseAutonomyRoundReply('{"v":1,"experiences":"nope"}')).toBeNull();
    expect(parseAutonomyRoundReply('{"v":1,"proposedEvents":{}}')).toBeNull();
    expect(parseAutonomyRoundReply('{}')).toBeNull();
    expect(parseAutonomyRoundReply('模型今天不想按格式来')).toBeNull();
  });

  it('单条没有 note 的条目丢掉，别的照收', () => {
    const reply = parseAutonomyRoundReply(JSON.stringify({
      v: 1,
      experiences: [{ q: 'x' }, { note: '这条有内容', kind: 'forum' }],
    }));
    expect(reply!.experiences).toHaveLength(1);
    expect(reply!.experiences[0]).toMatchObject({ note: '这条有内容', kind: 'forum', q: '' });
  });
});

// ─── 反刍闸的输入 ────────────────────────────────────────────────────────

describe('autonomyFire 反刍输入', () => {
  const page = (q: string, hoursAgo: number): RuminationPage => ({ q, createdAt: NOW - hoursAgo * HOUR });

  it('撞满两页的选题才算写腻了，去重、最新在前', () => {
    const pages = [page('深海潜水装备', 5), page('深海潜水 装备清单', 1), page('完全无关的选题', 2)];
    expect(collectBurntLines(pages, NOW)).toEqual(['深海潜水装备', '深海潜水 装备清单']);
  });

  it('窗口外的老页不算', () => {
    const pages = [page('深海潜水装备', 200), page('深海潜水 装备清单', 300)];
    expect(collectBurntLines(pages, NOW)).toEqual([]);
  });

  it('对话尾巴取最近 8 行、每行截 80 字；没有那一段就回空', () => {
    const personality = [
      '【最近对话上下文】',
      ...Array.from({ length: 10 }, (_, i) => `第${i}行`),
      '【当前时刻补充】',
      '当前本地时间（你所在地）：2026年9月16日',
    ].join('\n');
    const tail = extractDialogueTail(personality);
    expect(tail).toHaveLength(8);
    expect(tail[0]).toBe('第2行');
    expect(extractDialogueTail('没有那一段')).toEqual([]);
    expect(extractDialogueTail(['【最近对话上下文】', 'x'.repeat(200), '【当前时刻补充】'].join('\n'))[0])
      .toHaveLength(80);
  });
});

// ─── 提示词组装 ──────────────────────────────────────────────────────────

describe('autonomyFire 提示词', () => {
  it('顺序锁死：人格 → 处境 → 自由度 → 由头 → 无工具 → 产出；全程没有工具块', () => {
    const pack = buildPack({ autonomy: baseAutonomy({ noteStyleHint: '口语、有画面感。' }) });
    const prompt = buildAutonomyRoundPrompt({ pack, nowMs: NOW, pages: [], autonomy: pack.autonomy! });

    const order = ['【角色系统设定】', '【这一轮的处境】', '【怎么过这一小会儿】', '【可以顺着去的由头】',
      '【记录的语气】', '【这一轮没有可用工具】', '【这一轮的产出】'];
    let cursor = -1;
    for (const marker of order) {
      const at = prompt.indexOf(marker);
      expect(at, `缺了 ${marker}`).toBeGreaterThan(-1);
      expect(at, `${marker} 的顺序不对`).toBeGreaterThan(cursor);
      cursor = at;
    }
    // 覆盖句：完整聊天模板末尾的【开口之前】「沉默」指令与这一轮的 JSON 契约顶牛，
    // 覆盖句必须夹在模板尾与框定语之间，把「这一轮以 JSON 契约为准」立死。
    const templateTail = prompt.indexOf('【开口之前】');
    const overrideAt = prompt.indexOf(AUTONOMY_ROUND_OVERRIDE);
    const framingAt = prompt.indexOf('【这一轮的处境】');
    expect(templateTail, '模板尾没进提示词').toBeGreaterThan(-1);
    expect(overrideAt, '缺了覆盖句').toBeGreaterThan(-1);
    expect(overrideAt, '覆盖句没排在模板尾之后').toBeGreaterThan(templateTail);
    expect(framingAt, '覆盖句没排在框定语之前').toBeGreaterThan(overrideAt);
    // 对话尾巴被引成由头；时间槽位在 fire 时刻填掉（不留 {{...}}）。
    expect(prompt).toContain('今天搬完家了，累瘫');
    expect(prompt).not.toContain('{{AMSG_');
    // 无工具：不给工具块，也没有可幻觉的 mcp__ 名字。
    expect(prompt).toContain('本轮你没有任何工具可调');
    expect(prompt).not.toContain('mcp__');
    // rest 出口明示。
    expect(prompt).toContain('"rest":true');
  });

  it('没有对话尾巴时降级到兴趣词 + 避开清单；写腻的方向进禁区行', () => {
    const pack = buildPack({
      template: '【角色系统设定】只有人设，没有对话段。',
      autonomy: baseAutonomy({ interests: ['深海', '旧相机'], avoidTopics: ['工作'] }),
    });
    const pages = [
      { q: '深海潜水装备', createdAt: NOW - 2 * HOUR },
      { q: '深海潜水 装备清单', createdAt: NOW - 1 * HOUR },
    ];
    const prompt = buildAutonomyRoundPrompt({ pack, nowMs: NOW, pages, autonomy: pack.autonomy! });

    expect(prompt).toContain('你平时惦记这些：深海、旧相机');
    expect(prompt).toContain('这些方向你自己说过这次不碰：工作');
    expect(prompt).toContain('「深海潜水 装备清单」');
  });
});

// ─── 提示词覆盖（P6：预设目录改写 → 下一轮自主 fire 生效） ────────────────

describe('autonomyFire 提示词覆盖', () => {
  const roundArgs = (pack: AmsgFirePack) => ({ pack, nowMs: NOW, pages: [], autonomy: pack.autonomy! });

  it('无覆盖回退硬编码：不传参 / 空对象 / 空串都与旧输出逐字一致', () => {
    const pack = buildPack();
    const baseline = buildAutonomyRoundPrompt(roundArgs(pack));
    expect(buildAutonomyRoundPrompt(roundArgs(pack), {})).toBe(baseline);
    expect(buildAutonomyRoundPrompt(roundArgs(pack), { situBlock: '' })).toBe(baseline);
  });

  it('有覆盖用覆盖：显式 overrides 替换对应块，其余块不变', () => {
    const pack = buildPack();
    const baseline = buildAutonomyRoundPrompt(roundArgs(pack));
    const prompt = buildAutonomyRoundPrompt(roundArgs(pack), { situBlock: '【这一轮的处境】自定义处境行' });
    expect(prompt).toContain('【这一轮的处境】自定义处境行');
    expect(prompt).not.toContain('对方没有在等你回话');
    // 其余四块保持硬编码原文。
    expect(prompt).toContain('【怎么过这一小会儿】');
    expect(prompt).toContain('本轮你没有任何工具可调');
    expect(prompt).toContain('【这一轮的产出】');
    expect(prompt).toContain(AUTONOMY_ROUND_OVERRIDE);
    expect(prompt.length).not.toBe(baseline.length);
  });

  it('pack.autonomyPromptOverrides 经 fire_pack 同步链生效（不传参也覆盖）', () => {
    const pack = buildPack({ autonomyPromptOverrides: { outputBlock: 'CUSTOM-OUTPUT-CONTRACT' } });
    const prompt = buildAutonomyRoundPrompt(roundArgs(pack));
    expect(prompt).toContain('CUSTOM-OUTPUT-CONTRACT');
    expect(prompt).not.toContain('【这一轮的产出】');
  });

  it('显式 param 优先于 pack 字段', () => {
    const pack = buildPack({ autonomyPromptOverrides: { situBlock: '来自包里的处境' } });
    const prompt = buildAutonomyRoundPrompt(roundArgs(pack), { situBlock: '显式参数的处境' });
    expect(prompt).toContain('显式参数的处境');
    expect(prompt).not.toContain('来自包里的处境');
  });
});

// ─── 覆盖表经 fire_pack 同步链的容错 ───────────────────────────────────────

describe('autonomyPromptOverrides 同步容错', () => {
  const syncableBase = () => ({
    v: FIRE_PACK_VERSION,
    template: '【角色系统设定】只有人设。',
    lastUserMessageAt: null as number | null,
    tzId: 'Asia/Shanghai',
    userTzId: 'Asia/Shanghai',
    targetName: '小明',
    builtAt: NOW,
    pendingTasks: [],
    scene: null,
    selfScheduleEnabled: true,
  });

  it('坏覆盖只丢该字段、包其余可用（warn 一行）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pack = parseFirePack(JSON.stringify({
        ...syncableBase(), autonomyPromptOverrides: { situBlock: 42 },
      }));
      expect(pack).not.toBeNull();
      expect(pack!.autonomyPromptOverrides).toBeUndefined();
      expect(pack!.tzId).toBe('Asia/Shanghai');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('好覆盖原样保留', () => {
    const pack = parseFirePack(JSON.stringify({
      ...syncableBase(), autonomyPromptOverrides: { situBlock: '自定义处境行' },
    }));
    expect(pack?.autonomyPromptOverrides).toEqual({ situBlock: '自定义处境行' });
  });
});

// ─── 推送判定 ────────────────────────────────────────────────────────────

describe('autonomyFire 推送判定', () => {
  const gate = (overrides: Record<string, unknown> = {}) => shouldPushAutonomy({
    push: { mode: 'big', maxPerDay: 1, cooldownMinutes: 0 },
    pushedToday: 0,
    lastPushAt: 0,
    nowMs: NOW,
    minutesOfDay: 12 * 60,
    ...overrides,
  } as never);

  it('mode=off / 当日配额已满都不推', () => {
    expect(gate({ push: { mode: 'off', maxPerDay: 1, cooldownMinutes: 0 } })).toBe(false);
    expect(gate({ pushedToday: 1 })).toBe(false);
  });

  it('冷却没过 / 静默段内都不推', () => {
    expect(gate({ lastPushAt: NOW - 10 * 60_000, push: { mode: 'big', maxPerDay: 1, cooldownMinutes: 60 } }))
      .toBe(false);
    expect(gate({ quietHours: { start: '23:00', end: '06:00' }, minutesOfDay: 60 })).toBe(false);
    expect(isWithinQuietHours({ start: '23:00', end: '06:00' }, 23 * 60 + 30)).toBe(true);
    expect(isWithinQuietHours(undefined, 300)).toBe(false);
  });

  it('push 缺省 / 不是对象 / mode 不认识 / 配额冷却不是数字：一律不推，绝不抛', () => {
    expect(gate({ push: undefined })).toBe(false);
    expect(gate({ push: null })).toBe(false);
    expect(gate({ push: 'big' })).toBe(false);
    expect(gate({ push: [] })).toBe(false);
    expect(gate({ push: { mode: 'weird', maxPerDay: 1, cooldownMinutes: 0 } })).toBe(false);
    expect(gate({ push: { maxPerDay: 1, cooldownMinutes: 0 } })).toBe(false);
    expect(gate({ push: { mode: 'big', maxPerDay: '1', cooldownMinutes: 0 } })).toBe(false);
    expect(gate({ push: { mode: 'big', maxPerDay: 1, cooldownMinutes: 'soon' } })).toBe(false);
    expect(gate({ push: { mode: 'big', maxPerDay: Number.NaN, cooldownMinutes: 0 } })).toBe(false);
    expect(gate({ push: { mode: 'big', maxPerDay: 1, cooldownMinutes: Number.POSITIVE_INFINITY } })).toBe(false);
  });
});

describe('autonomyFire did', () => {
  it('一种 kind 就是它，多于一种 mixed，没有就是 rest；不认识的 kind 收成 mixed', () => {
    expect(dominantAutonomyKind([{ kind: 'surf' }])).toBe('surf');
    expect(dominantAutonomyKind([{ kind: 'surf' }, { kind: 'surf' }])).toBe('surf');
    expect(dominantAutonomyKind([{ kind: 'surf' }, { kind: 'game' }])).toBe('mixed');
    expect(dominantAutonomyKind([{ kind: 'walk' }])).toBe('mixed');
    expect(dominantAutonomyKind([])).toBe('rest');
  });
});

// ─── D1 holder 的纪律 ────────────────────────────────────────────────────

describe('autonomyFire D1 holder', () => {
  it('没配 D1：beforeFire 回 skip-plan、llmOutput 回 skip-push，都不抛', async () => {
    configureAutonomyFireDb(null);
    const { ctx } = makeFireCtx(buildPack());
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
    // llmOutput 直接喂 handler：经 amsgHooks 只有 beforeFire 挂了 stash 才会走到 kind 分支，
    // 而这一轮压根没到「挂 stash」那一步。
    await expect(autonomyRoundHandler.llmOutput({
      ctx: makeSessionCtx({}, '{"v":1,"rest":true}').ctx,
      state: null,
    })).resolves.toEqual({ decision: 'skip-push', reason: AUTONOMY_FIRE_SKIP.dbUnavailable });
  });

  it('配了 null / undefined 一样是「没配」，不是抛错', async () => {
    configureAutonomyFireDb(null);
    const nulled = await autonomyRoundHandler.beforeFire({
      ctx: { task: {}, readState: async () => [], now: new Date(NOW), scratch: {} },
      charId: CHAR_ID,
      taskMeta: {},
    });
    expect(nulled).toEqual({ skip: true, reason: AUTONOMY_FIRE_SKIP.dbUnavailable });

    configureAutonomyFireDb(undefined);
    const undefineded = await autonomyRoundHandler.beforeFire({
      ctx: { task: {}, readState: async () => [], now: new Date(NOW), scratch: {} },
      charId: CHAR_ID,
      taskMeta: {},
    });
    expect(undefineded).toEqual({ skip: true, reason: AUTONOMY_FIRE_SKIP.dbUnavailable });
  });
});

describe('autonomyFire beforeFire 的跳过原因（直接喂 handler）', () => {
  const directCtx = (rows: Array<{ key: string; value: string }>) => ({
    task: {},
    readState: async () => rows,
    now: new Date(NOW),
    scratch: {},
  });

  it('fire_pack 不在 / 解不开 / 形状不认识 → 安静跳过', async () => {
    const fake = createFakeDb();
    configureAutonomyFireDb(fake.db);
  configureAutonomyFireMasterKey('test-master-key');
    configureAutonomyFireMasterKey('test-master-key');
    expect(await autonomyRoundHandler.beforeFire({ ctx: directCtx([]), charId: CHAR_ID, taskMeta: {} }))
      .toEqual({ skip: true, reason: AUTONOMY_FIRE_SKIP.packMissing });
    expect(await autonomyRoundHandler.beforeFire({
      ctx: directCtx([{ key: AMSG_FIRE_PACK_KEY, value: 'gz1:不是压缩数据' }]),
      charId: CHAR_ID,
      taskMeta: {},
    })).toEqual({ skip: true, reason: AUTONOMY_FIRE_SKIP.packUnreadable });
    expect(await autonomyRoundHandler.beforeFire({
      ctx: directCtx([{ key: AMSG_FIRE_PACK_KEY, value: '{"v":7}' }]),
      charId: CHAR_ID,
      taskMeta: {},
    })).toEqual({ skip: true, reason: AUTONOMY_FIRE_SKIP.packUnreadable });
  });

  it('自主关了 / 时区坏了 → 各自的原因', async () => {
    const fake = createFakeDb();
    configureAutonomyFireDb(fake.db);
  configureAutonomyFireMasterKey('test-master-key');
    configureAutonomyFireMasterKey('test-master-key');
    expect(await autonomyRoundHandler.beforeFire({
      ctx: directCtx([{ key: AMSG_FIRE_PACK_KEY, value: JSON.stringify(buildPack({ autonomy: baseAutonomy({ enabled: false }) })) }]),
      charId: CHAR_ID,
      taskMeta: {},
    })).toEqual({ skip: true, reason: AUTONOMY_FIRE_SKIP.disabled });
    expect(await autonomyRoundHandler.beforeFire({
      ctx: directCtx([{ key: AMSG_FIRE_PACK_KEY, value: JSON.stringify(buildPack({ tzId: 'Not/AZone' })) }]),
      charId: CHAR_ID,
      taskMeta: {},
    })).toEqual({ skip: true, reason: AUTONOMY_FIRE_SKIP.tzInvalid });
  });

  it('owner 认不出来（行缺失 / user_id 空串）→ 普通回合与计划都 fail-closed', async () => {
    // 行缺失：查不到 owner。
    const missing = createFakeDb({ owner: { rowMissing: true } });
    configureAutonomyFireDb(missing.db);
    configureAutonomyFireMasterKey('test-master-key');
    const pack = buildPack();
    const packRows = [{ key: AMSG_FIRE_PACK_KEY, value: JSON.stringify(pack) }];
    const planMeta = { amsgAutonomyPlan: { planId: 'plan-1', kind: 'diary', title: '写夜记' } };
    expect(await autonomyRoundHandler.beforeFire({ ctx: directCtx(packRows), charId: CHAR_ID, taskMeta: {} }))
      .toEqual({ skip: true, reason: AUTONOMY_FIRE_SKIP.ownerUnresolved });
    // 计划到点：owner 读不到时连计划行都不碰（绝不执行），更不会去读护栏当新用户放行。
    expect(await autonomyRoundHandler.beforeFire({ ctx: directCtx(packRows), charId: CHAR_ID, taskMeta: planMeta }))
      .toEqual({ skip: true, reason: AUTONOMY_FIRE_SKIP.ownerUnresolved });
    expect(missing.sql.some((text) => text.includes('FROM autonomy_plans WHERE id'))).toBe(false);

    // user_id 是空串：旧实现把它当「absent 新用户」→ paused:false 放行，这里必须同样拒绝。
    const blank = createFakeDb({ owner: { userId: '   ' } });
    configureAutonomyFireDb(blank.db);
    expect(await autonomyRoundHandler.beforeFire({ ctx: directCtx(packRows), charId: CHAR_ID, taskMeta: {} }))
      .toEqual({ skip: true, reason: AUTONOMY_FIRE_SKIP.ownerUnresolved });

    // 对照：owner 正常时这门放行（计划行缺失走 planMissing，而不是 ownerUnresolved）。
    const ok = createFakeDb();
    configureAutonomyFireDb(ok.db);
    expect(await autonomyRoundHandler.beforeFire({ ctx: directCtx(packRows), charId: CHAR_ID, taskMeta: planMeta }))
      .toEqual({ skip: true, reason: AUTONOMY_WORKFLOW_SKIP.planMissing });
  });
});

// ─── 整条分派链 ──────────────────────────────────────────────────────────

describe('autonomyFire 整轮（经 amsgHooks 的 kind 分派）', () => {
  const REPLY = JSON.stringify({
    v: 1,
    experiences: [{ q: '深海沉船', note: '翻到了：深海那边有条沉船', kind: 'surf', importance: 2 }],
    proposedEvents: [{ type: 'discovery', summary: '翻到一条沉船记录', impact: 'minor' }],
  });

  it('big 且配额冷却都过：落 D1（pushed=1）→ emit 锁定信封 → 回账', async () => {
    const { plan, decision, emitResult, experiences, stateRows } = await runRound({
      reply: REPLY,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    const prompt = (plan as { messages: Array<{ content: string }> }).messages[0].content;
    expect(prompt).toContain('【这一轮的产出】');

    expect(decision).toEqual({ decision: 'skip-push', reason: 'autonomy-result-emitted' });
    expect(emitResult).toHaveBeenCalledTimes(1);
    const payload = emitResult.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.resultKind).toBe('autonomy_result');
    expect(payload.charId).toBe(CHAR_ID);
    expect(payload.toolsUsed).toEqual([]);
    expect(payload.did).toBe('surf');
    expect(payload.rested).toBe(false);
    expect(payload.usage).toEqual({ prompt: 100, completion: 50, total: 150 });
    expect(payload.proposedEvents).toEqual([{ type: 'discovery', summary: '翻到一条沉船记录', impact: 'minor' }]);

    const rows = payload.experiences as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(typeof rows[0].id).toBe('string');
    expect(rows[0].note).toBe('深海那边有条沉船'); // 清嗓子削掉了开头的「翻到了：」
    expect(rows[0].pushed).toBe(true);
    expect(payload.notification).toEqual({
      title: '深海那边有条沉船', body: '深海那边有条沉船', show: 'always',
      silent: 'when-visible', tag: 'amsg-instant-preset-nyah', renotify: true,
    });

    // D1：经历行的 id 就是信封里那个；推送时间与 token 都回账了。
    expect(experiences).toHaveLength(1);
    expect(experiences[0].id).toBe(rows[0].id);
    expect(experiences[0].pushed).toBe(1);
    expect(stateRows.get(CHAR_ID)).toMatchObject({ last_push_at: NOW, tokens_today: 150, fail_streak: 0 });
  });

  it('P4 接线：wantToShare 命中→instant-chat 信封字段齐→走既有 emitResult 下发', async () => {
    const { emitResult } = await runRound({
      reply: REPLY,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });
    // 下发函数被调且仅一次（mock 下发桩）。
    expect(emitResult).toHaveBeenCalledTimes(1);
    const payload = emitResult.mock.calls[0]![0] as Record<string, unknown>;
    // payload 字段齐：与 buildWantToSharePush 同参数产出逐字一致。
    const expected = buildWantToSharePush({
      charId: CHAR_ID, title: '深海那边有条沉船', body: '深海那边有条沉船',
    }) as Record<string, unknown>;
    expect(payload.notification).toEqual(expected.notification);
    const n = payload.notification as Record<string, unknown>;
    expect(n.show).toBe('always');
    expect(n.silent).toBe('when-visible');
    expect(n.tag).toBe(`amsg-instant-${CHAR_ID}`);
    expect(n.renotify).toBe(true);
  });

  it('整轮全是 small：一条都不推、不响铃，但经历照落 D1', async () => {
    const { decision, emitResult, experiences } = await runRound({
      reply: JSON.stringify({
        v: 1,
        experiences: [
          { q: '随口一条', note: '今天风有点大', kind: 'surf', importance: 0 },
          { q: '又一条', note: '顺手记一笔', kind: 'game', importance: 1 },
        ],
      }),
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    expect(decision).toEqual({ decision: 'skip-push', reason: 'autonomy-result-emitted' });
    const payload = emitResult.mock.calls[0]![0] as Record<string, unknown>;
    const rows = payload.experiences as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.pushed === false)).toBe(true);
    expect(payload.notification).toEqual({ show: false });
    expect(payload.did).toBe('mixed');
    // D1 行 importance 仍是数字（信封才是字符串）；没有一条被标 pushed。
    expect(experiences.map((row) => row.importance)).toEqual([0, 1]);
    expect(experiences.every((row) => row.pushed === 0)).toBe(true);
  });

  it('夹心 big：推的是第一条 big（findIndex），铃铛文案就是它的 note，不是队首', async () => {
    const { emitResult, experiences } = await runRound({
      reply: JSON.stringify({
        v: 1,
        experiences: [
          { q: '小的在前', note: '先记一条小的', kind: 'game', importance: 0 },
          { q: '大的在后', note: '翻到了：深海那条沉船', kind: 'surf', importance: 3 },
        ],
      }),
    });

    const payload = emitResult.mock.calls[0]![0] as Record<string, unknown>;
    const rows = payload.experiences as Array<Record<string, unknown>>;
    // 信封 importance 收成字符串两档。
    expect(rows.map((row) => row.importance)).toEqual(['small', 'big']);
    expect(rows.map((row) => row.pushed)).toEqual([false, true]);
    expect(payload.notification).toEqual({
      title: '深海那条沉船', body: '深海那条沉船', show: 'always',
      silent: 'when-visible', tag: 'amsg-instant-preset-nyah', renotify: true,
    });
    // D1：只有那条 big（第二条）标 pushed=1。
    expect(experiences.map((row) => row.pushed)).toEqual([0, 1]);
  });

  it('冷却没过：照样落 D1，但不推（show:false / pushed=0）', async () => {
    const { emitResult, experiences } = await runRound({
      reply: REPLY,
      pack: buildPack({ autonomy: baseAutonomy({ push: { mode: 'big', maxPerDay: 1, cooldownMinutes: 60 } }) }),
      seed: { state: { [CHAR_ID]: { char_id: CHAR_ID, last_push_at: NOW - 10 * 60_000 } } },
    });
    const payload = emitResult.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.notification).toEqual({ show: false });
    expect((payload.experiences as Array<Record<string, unknown>>)[0].pushed).toBe(false);
    expect(experiences[0].pushed).toBe(0);
  });

  it('坏包：push 整块缺失也不抛，整轮照跑、只是不推（pushed=0）', async () => {
    const autonomy = baseAutonomy();
    delete (autonomy as { push?: unknown }).push;
    const { decision, emitResult, experiences } = await runRound({ reply: REPLY, pack: buildPack({ autonomy }) });
    expect(decision).toEqual({ decision: 'skip-push', reason: 'autonomy-result-emitted' });
    const payload = emitResult.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.notification).toEqual({ show: false });
    expect((payload.experiences as Array<Record<string, unknown>>)[0].pushed).toBe(false);
    expect(experiences[0].pushed).toBe(0);
  });

  it('选题全是冷饭：收成 rest，不落库、不推送，但照样回账', async () => {
    const seeded = [
      experienceRow({ q: '深海潜水装备', created_at: NOW - 2 * HOUR }),
      experienceRow({ q: '深海潜水 装备清单', created_at: NOW - HOUR }),
    ];
    const { decision, emitResult, experiences } = await runRound({
      reply: JSON.stringify({ v: 1, experiences: [{ q: '深海潜水装备', note: '又想去看看', kind: 'surf' }] }),
      seed: { experiences: seeded },
    });

    expect(decision).toEqual({ decision: 'skip-push', reason: 'autonomy-rested' });
    const payload = emitResult.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.rested).toBe(true);
    expect(payload.did).toBe('rest');
    expect(payload.experiences).toEqual([]);
    expect(experiences).toHaveLength(2); // 没写新行
  });

  it('只撞一页不算冷饭（第二回放行）：照常落库', async () => {
    const { decision, emitResult, experiences } = await runRound({
      reply: JSON.stringify({ v: 1, experiences: [{ q: '深海潜水装备', note: '又想去看看', kind: 'surf', importance: 2 }] }),
      seed: { experiences: [experienceRow({ q: '深海潜水装备', created_at: NOW - HOUR })] },
    });
    expect(decision).toEqual({ decision: 'skip-push', reason: 'autonomy-result-emitted' });
    const payload = emitResult.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.rested).toBe(false);
    expect((payload.experiences as Array<Record<string, unknown>>)[0].pushed).toBe(true);
    expect(experiences).toHaveLength(2);
  });

  it('输出解析不出来：判失败、不落库不发结果，回账累加失败', async () => {
    const { decision, emitResult, experiences, stateRows } = await runRound({ reply: '今天不想按格式来' });
    expect(decision).toEqual({ decision: 'skip-push', reason: AUTONOMY_BAD_OUTPUT_REASON });
    expect(emitResult).not.toHaveBeenCalled();
    expect(experiences).toHaveLength(0);
    expect(stateRows.get(CHAR_ID)).toMatchObject({ fail_streak: 1 });
  });

  it('老 worker 没有 emitResult：经历照样落 D1，只把结果送不回去的原因说清楚', async () => {
    const { decision, experiences } = await runRound({ reply: REPLY, withEmitResult: false });
    expect(decision).toEqual({ decision: 'skip-push', reason: 'autonomy-emit-result-unsupported' });
    expect(experiences).toHaveLength(1);
  });

  it('整句收笔按 800 字帽裁（超帽的 note 退到最后一个整句）', async () => {
    const long = `${'句'.repeat(500)}。${'尾'.repeat(500)}`;
    const { emitResult } = await runRound({
      reply: JSON.stringify({ v: 1, experiences: [{ q: 'q', note: long, kind: 'forum' }] }),
    });
    const note = (emitResult.mock.calls[0]![0] as { experiences: Array<{ note: string }> }).experiences[0].note;
    expect(note.length).toBeLessThanOrEqual(AUTONOMY_NOTE_MAX_CHARS);
    expect(note.endsWith('。')).toBe(true);
  });
});

// ─── P4/P5：感知 / 工作流提议 / 到点执行 ────────────────────────────────

describe('P4 感知小快照', () => {
  it('角色时区 + 当天日程 → 一小段带认知边界的感知；坏时区不炸', async () => {
    const pack = buildPack({
      scene: {
        charId: CHAR_ID,
        dateKey: '2026-09-16',
        schedule: {
          slots: [{ startTime: '19:00', activity: '写方案' }, { startTime: '21:00', activity: '洗漱' }],
          flowNarrative: { '19:00': '' },
        },
        songPool: [],
      },
    });
    const fake = createFakeDb();
    const block = await buildAutonomyPerceptionBlock({ db: fake.db, charId: CHAR_ID, pack, nowMs: NOW });
    expect(block).toContain('【此刻的感知】');
    expect(block).toContain('写方案');
    expect(block).toContain('情绪');
    expect(block).toContain('不能');

    const broken = buildPack({ tzId: 'Not/AZone' });
    const fallback = await buildAutonomyPerceptionBlock({ db: fake.db, charId: CHAR_ID, pack: broken, nowMs: NOW });
    expect(typeof fallback).toBe('string');
  });
});

describe('P5 工作流提议（W1/W2）', () => {
  it('解析层收下 workflows；非数组整轮判坏', () => {
    const ok = parseAutonomyRoundReply(JSON.stringify({
      v: 1, experiences: [], workflows: [{ kind: 'diary' }],
    }));
    expect(ok?.workflowCandidates).toHaveLength(1);
    expect(parseAutonomyRoundReply(JSON.stringify({ v: 1, workflows: 'x' }))).toBeNull();
  });

  it('回合里提的合法提议落成 planned 计划；非法提议丢掉，不影响本轮', async () => {
    const reply = JSON.stringify({
      v: 1,
      experiences: [{ q: 'q', note: '记一条', kind: 'surf' }],
      workflows: [
        {
          v: 1, kind: 'diary', purpose: '把今天的事记下来',
          trigger: { kind: 'idle', afterMinutes: 120 },
          action: { kind: 'diary', title: '今天的一点小事', maxChars: 400 },
          expiresInHours: 24, basis: 'virtual',
        },
        { v: 1, kind: 'post_moment', purpose: '发朋友圈', action: { kind: 'post_moment', title: 'x' } },
      ],
    });
    const { emitResult, sql } = await runRound({ reply });
    const payload = emitResult.mock.calls[0]![0] as any;
    expect(payload.workflows).toHaveLength(1);
    expect(payload.workflows[0]).toMatchObject({ kind: 'diary', title: '今天的一点小事', basis: 'virtual' });
    expect(payload.basis).toBe('virtual');
    expect(sql.some((text) => text.includes('INSERT OR IGNORE INTO autonomy_plans'))).toBe(true);
    // 朋友圈这类不可自动公开的动作没有进计划表
    expect(JSON.stringify(payload.workflows)).not.toContain('post_moment');
  });

  it('提议带 URL / 工具 / 权限 → 不落计划', async () => {
    for (const bad of [
      { kind: 'diary', purpose: 'p', trigger: { kind: 'now' }, action: { kind: 'diary', title: 't', url: 'https://x' } },
      { kind: 'diary', purpose: 'p', trigger: { kind: 'now' }, action: { kind: 'diary', title: 't', tool: 'mcp__x' } },
      { kind: 'diary', purpose: 'p', trigger: { kind: 'now' }, action: { kind: 'diary', title: 't', permissions: {} } },
    ]) {
      const { emitResult } = await runRound({
        reply: JSON.stringify({ v: 1, experiences: [], workflows: [bad] }),
      });
      const payload = emitResult.mock.calls[0]![0] as any;
      expect(payload.workflows).toBeUndefined();
    }
  });
});

describe('P5 到点执行（独立后台请求）', () => {
  const planColumns = (over: Record<string, unknown> = {}) => ({
    id: 'plan-1', char_id: CHAR_ID, kind: 'diary', status: 'scheduled',
    purpose: '把今天下午的事记下来', title: '今天的一点小事', note_hint: null,
    max_chars: 400, trigger_kind: 'now', trigger_value: null,
    scheduled_at: NOW - 1000, expires_at: NOW + 60 * 60_000,
    created_at: NOW - 3 * 60 * 60_000, updated_at: NOW - 3 * 60 * 60_000,
    source: 'autonomy_round', source_ref: 'round-1', basis: 'virtual',
    evidence_json: '[]', predecessor_id: null, dedupe_key: 'wf:diary:abc',
    attempts: 0, lease_until: 0, last_error: null,
    ...over,
  });

  const createWorkflowDb = (plan: Record<string, unknown>) => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const experiences: Array<Record<string, unknown>> = [];
    const db: AutonomyDb = {
      prepare(text: string) {
        let args: unknown[] = [];
        const stmt: AutonomyStatement = {
          bind(...next: unknown[]) { args = next; return stmt; },
          async run() {
            statements.push({ sql: text, args });
            if (text.startsWith('INSERT INTO autonomy_experiences')) {
              experiences.push({
                id: args[0], basis: args[8], source: args[9], plan_id: args[10],
              });
            }
            return { meta: { changes: 1 } };
          },
          async first() {
            statements.push({ sql: text, args });
            // owner 反查：计划到点前必须先认得出 userId（真库是角色命名空间那一行）。
            if (text.includes('SELECT user_id FROM client_state')) return { user_id: 'u1' };
            if (text.includes('FROM autonomy_plans WHERE id')) return plan;
            return null;
          },
          async all() {
            statements.push({ sql: text, args });
            return { results: [] };
          },
        };
        return stmt;
      },
    };
    return { db, statements, experiences };
  };

  const runWorkflow = async (args: {
    plan?: Record<string, unknown>;
    reply: string;
    kind?: 'diary' | 'plan' | 'interest_note';
  }) => {
    const fake = createWorkflowDb(args.plan ?? planColumns(args.kind ? { kind: args.kind } : {}));
    configureAutonomyFireDb(fake.db);
  configureAutonomyFireMasterKey('test-master-key');
    configureAutonomyFireMasterKey('test-master-key');
    const pack = buildPack();
    const { ctx: fireCtx, scratch } = makeFireCtx(pack);
    (fireCtx as any).task.metadata.amsgAutonomyPlan = {
      planId: 'plan-1', kind: args.kind ?? 'diary', title: '今天的一点小事',
      purpose: '把今天下午的事记下来', maxChars: 400,
    };
    const plan = await amsgHooks.onBeforeFire(fireCtx);
    // skip 的计划不会挂 stash，也不该再跑 onLLMOutput（防止替上游掩盖 bug）。
    if ('skip' in plan) return { plan, decision: null, emitResult: vi.fn(), ...fake };
    const { ctx, emitResult } = makeSessionCtx(scratch, args.reply, { total_tokens: 500 });
    const decision = await amsgHooks.onLLMOutput(ctx);
    return { plan, decision, emitResult, ...fake };
  };

  it('metadata → 独立提示词（人格全文 + 这件事 + 无工具），不是聊天回合', async () => {
    const { plan } = await runWorkflow({ reply: '今天下了很久的雨。' });
    expect('messages' in plan).toBe(true);
    if (!('messages' in plan)) return;
    const prompt = (plan.messages[0] as { content: string }).content;
    expect(prompt).toContain('你是一个会在深夜突然想起对方的人');
    expect(prompt).toContain('今天的一点小事');
    expect(prompt).toContain('没有可用工具');
    expect(prompt).not.toContain('"experiences"');
  });

  it('写完 → 落虚拟经历（basis=virtual / source=workflow）+ 计划 completed + 不推送', async () => {
    const { decision, experiences, statements, emitResult } = await runWorkflow({ reply: '今天下了很久的雨。' });
    expect(experiences).toHaveLength(1);
    expect(experiences[0]).toMatchObject({ basis: 'virtual', source: 'workflow', plan_id: 'plan-1' });
    const settle = statements.find((s) => s.sql.includes('UPDATE autonomy_plans') && s.args.includes('completed'));
    expect(settle).toBeTruthy();
    expect(emitResult).not.toBeNull();
    const payload = emitResult!.mock.calls[0]![0] as any;
    expect(payload.workflow).toMatchObject({ planId: 'plan-1', kind: 'diary', basis: 'virtual' });
    expect(payload.notification).toEqual({ show: false });
    expect(payload.basis).toBe('virtual');
    expect(decision).toEqual({ decision: 'skip-push', reason: 'autonomy-workflow-completed' });
  });

  it('计划调整必须给结构化条目：一段散文 → 失败终态，不重试', async () => {
    const { decision, experiences, statements } = await runWorkflow({
      kind: 'plan', reply: '我打算周末去买伞。',
    });
    expect(experiences).toEqual([]);
    expect(decision).toEqual({ decision: 'skip-push', reason: AUTONOMY_WORKFLOW_SKIP.badOutput });
    const settle = statements.find((s) => s.sql.includes('UPDATE autonomy_plans') && s.args.includes('failed'));
    expect(settle).toBeTruthy();
  });

  it('计划不是 scheduled/running（已取消/已完成/unknown）→ 直接跳过，不重复生成', async () => {
    for (const status of ['cancelled', 'completed', 'unknown']) {
      const { plan } = await runWorkflow({ reply: 'x', plan: planColumns({ status }) });
      // 上游 onBeforeFire 只把 skip 交出去（reason 只进 worker 日志）；这里验「没进生成」。
      expect(plan).toEqual({ skip: true });
    }
  });

  it('handler 层对非待执行计划给出明确原因（不误报成坏数据）', async () => {
    const fake = createWorkflowDb(planColumns({ status: 'cancelled' }));
    configureAutonomyFireDb(fake.db);
  configureAutonomyFireMasterKey('test-master-key');
    configureAutonomyFireMasterKey('test-master-key');
    const plan = await autonomyRoundHandler.beforeFire({
      ctx: {
        task: { id: 1, metadata: {} },
        readState: async () => [{ key: AMSG_FIRE_PACK_KEY, value: JSON.stringify(buildPack()) }],
        now: new Date(NOW), scratch: {},
      } as never,
      charId: CHAR_ID,
      taskMeta: { amsgAutonomyPlan: { planId: 'plan-1', kind: 'diary', title: 't', maxChars: 400 } },
    });
    expect(plan).toEqual({ skip: true, reason: AUTONOMY_WORKFLOW_SKIP.planNotPending });
  });

  it('旧 task payload 只能碰自己那一代：planId 是旧代 → 跳过，绝不执行/结算新代', async () => {
    // 人工重试后旧代是 failed 终态，新代有新的 planId；一条早就排好的旧任务到点只能看到旧 id。
    const fake = createWorkflowDb(planColumns({ id: 'plan-old', status: 'failed' }));
    configureAutonomyFireDb(fake.db);
    configureAutonomyFireMasterKey('test-master-key');
    const plan = await autonomyRoundHandler.beforeFire({
      ctx: {
        task: { id: 1, metadata: {} },
        readState: async () => [{ key: AMSG_FIRE_PACK_KEY, value: JSON.stringify(buildPack()) }],
        now: new Date(NOW), scratch: {},
      } as never,
      charId: CHAR_ID,
      taskMeta: { amsgAutonomyPlan: { planId: 'plan-old', kind: 'diary', title: 't', maxChars: 400 } },
    });
    expect(plan).toEqual({ skip: true, reason: AUTONOMY_WORKFLOW_SKIP.planNotPending });
    // 一个写语句都不该落到新代（更不该把它标成 failed/completed）
    expect(fake.statements.some((s) => s.args.includes('plan-new'))).toBe(false);
    expect(fake.statements.some((s) => s.sql.includes('UPDATE autonomy_plans'))).toBe(false);
  });

  it('unknown 是终态：超时/未知的那一代不会自动重跑（只有人工重试能开新代）', async () => {
    const fake = createWorkflowDb(planColumns({ status: 'unknown' }));
    configureAutonomyFireDb(fake.db);
    configureAutonomyFireMasterKey('test-master-key');
    const plan = await autonomyRoundHandler.beforeFire({
      ctx: {
        task: { id: 1, metadata: {} },
        readState: async () => [{ key: AMSG_FIRE_PACK_KEY, value: JSON.stringify(buildPack()) }],
        now: new Date(NOW), scratch: {},
      } as never,
      charId: CHAR_ID,
      taskMeta: { amsgAutonomyPlan: { planId: 'plan-1', kind: 'diary', title: 't', maxChars: 400 } },
    });
    expect(plan).toEqual({ skip: true, reason: AUTONOMY_WORKFLOW_SKIP.planNotPending });
    // 没有建任务 / 没有重试写入
    expect(fake.statements.some((s) => s.sql.includes('INSERT OR IGNORE INTO autonomy_plan_runs'))).toBe(false);
  });

  it('metadata 形状坏 → 不认（按普通回合走，不误跑计划）', () => {
    expect(readAutonomyPlanMeta({ amsgAutonomyPlan: { planId: '', kind: 'diary', title: 't' } })).toBeNull();
    expect(readAutonomyPlanMeta({ amsgAutonomyPlan: { planId: 'p', kind: 'post', title: 't' } })).toBeNull();
    expect(readAutonomyPlanMeta(undefined)).toBeNull();
    expect(readAutonomyPlanMeta({})).toBeNull();
  });

  it('执行提示词对计划类明确要求 JSON 条目（散文不算计划）', () => {
    const prompt = buildWorkflowExecutionPrompt({
      pack: buildPack(), nowMs: NOW,
      plan: { kind: 'plan', title: 'T', purpose: 'P', maxChars: 300 },
    });
    expect(prompt).toContain('"plans"');
    expect(prompt).toContain('至少一条');
  });
});
