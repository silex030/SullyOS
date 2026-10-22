import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  decryptPayload,
  deriveUserEncryptionKey,
  encryptForStorage,
} from '@rei-standard/amsg-server/cloudflare';
import { FIRE_PACK_VERSION, type AmsgFirePack } from '../../../utils/amsgFirePack';
import { AUTONOMOUS_ROUND_KIND, type ResolvedAirpAutonomy } from '../../../utils/airp/autonomySettings';
import { FIRE_KIND_HANDLERS } from './fireKinds';
import { AUTONOMY_FIRE_SKIP, autonomyRoundHandler, configureAutonomyFireDb } from './autonomyFire';
import {
  AUTONOMY_FAIL_LIMIT,
  AUTONOMY_PLAN_META_KEY,
  AUTONOMY_SKIP_REASONS,
  autonomyDateKey,
  autonomyConfigHash,
  buildAutonomyScheduleRequest,
  createAutonomyPostTask,
  encryptPayloadMirror,
  readAutonomyGuardrailsForUser,
  readAutonomyGuardrailsForUserDetailed,
  reportAutonomyOutcome,
  runAutonomyPlanQueue,
  runAutonomyTick,
  scanAutonomyPacks,
  shouldPushNow,
  startOfAutonomyDayMs,
  type AutonomyTickPack,
} from './autonomyScheduler';
import type { AutonomyPlanRecord } from '../../../utils/airp/lifeWorkflow';
import {
  claimAutonomyTick,
  claimGlobalAutonomyBudget,
  emptyAutonomyState,
  ensureAutonomySchema,
  resetAutonomySchemaCacheForTesting,
  type AutonomyStateRow,
} from './autonomyStore';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const CHAR_ID = 'char-lumen';
const CHAR_NAME = '陆铭';
const MASTER = 'a'.repeat(64);
/** 2026-07-25 20:00 Asia/Shanghai（无夏令时，UTC+8）。 */
const NOW = Date.parse('2026-07-25T12:00:00.000Z');

const baseAutonomy = (overrides: Partial<ResolvedAirpAutonomy> = {}): ResolvedAirpAutonomy => ({
  enabled: true,
  cadence: { minHours: 1, maxHours: 1 },
  maxRoundsPerDay: 3,
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

const packFor = (autonomy: ResolvedAirpAutonomy | undefined): AmsgFirePack => ({
  v: FIRE_PACK_VERSION,
  template: '模板 {{AMSG_CURRENT_TIME}}',
  lastUserMessageAt: null,
  tzId: 'Asia/Shanghai',
  userTzId: 'Asia/Shanghai',
  targetName: '小明',
  builtAt: 0,
  pendingTasks: [],
  scene: null,
  selfScheduleEnabled: true,
  ...(autonomy ? { autonomy } : {}),
});

const toSnake = (state: AutonomyStateRow | undefined): Record<string, unknown> | null =>
  state
    ? {
        char_id: state.charId,
        last_round_at: state.lastRoundAt,
        last_push_at: state.lastPushAt,
        fail_streak: state.failStreak,
        rounds_date: state.roundsDate,
        rounds_today: state.roundsToday,
        tokens_date: state.tokensDate,
        tokens_today: state.tokensToday,
        config_hash: state.configHash,
      }
    : null;

/**
 * 记录型 D1 替身：autonomy_state 走一份真的内存表（读-改-写、claim 之后能查），
 * 其余语句只记下来供断言。经历表和 DDL 的细节由 autonomyStore.test.ts 管。
 */
const createStateDb = (
  initial: AutonomyStateRow[] = [],
  preflight: { credentials?: boolean; pushSubscription?: boolean } = {},
) => {
  const credentialsPresent = preflight.credentials ?? true;
  const pushPresent = preflight.pushSubscription ?? true;
  const states = new Map<string, AutonomyStateRow>(initial.map((state) => [state.charId, state]));
  const statements: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          stmt._args = args;
          return stmt;
        },
        async run() {
          statements.push({ sql, args: stmt._args });
          if (sql.includes('INSERT INTO autonomy_state')) {
            const a = stmt._args;
            states.set(String(a[0]), {
              charId: String(a[0]),
              lastRoundAt: Number(a[1]),
              lastPushAt: Number(a[2]),
              failStreak: Number(a[3]),
              roundsDate: String(a[4]),
              roundsToday: Number(a[5]),
              tokensDate: String(a[6]),
              tokensToday: Number(a[7]),
              configHash: String(a[8]),
            });
          }
          return { success: true, meta: { changes: 0 } };
        },
        async first() {
          statements.push({ sql, args: stmt._args });
          if (sql.includes('FROM autonomy_state')) return toSnake(states.get(String(stmt._args[0])));
          // 到点硬前置：默认两样都在（老用例照常走判定层），专门用例再关掉。
          if (sql.includes('FROM llm_credentials')) return credentialsPresent ? { ok: 1 } : null;
          if (sql.includes('FROM push_subscriptions')) return pushPresent ? { ok: 1 } : null;
          return null;
        },
        async all() {
          statements.push({ sql, args: stmt._args });
          return { results: [] };
        },
      };
      return stmt;
    },
  };
  return { db, states, statements };
};

const tick = (
  db: ReturnType<typeof createStateDb>['db'],
  packs: AutonomyTickPack[],
  options: { nowMs?: number; rand01?: () => number; postTask?: (args: unknown) => Promise<unknown> } = {},
) =>
  runAutonomyTick({
    nowMs: options.nowMs ?? NOW,
    rand01: options.rand01 ?? (() => 0),
    db,
    packs,
    // 假库没有护栏行 → absent → 默认值（和线上 index.ts 传 env.AMSG_MASTER_KEY 同口径）。
    masterKey: MASTER,
    postTask: options.postTask ?? (async () => ({ status: 200 })),
  });

const tickPack = (autonomy: ResolvedAirpAutonomy | undefined): AutonomyTickPack[] => [
  { userId: USER_ID, charId: CHAR_ID, charName: CHAR_NAME, pack: packFor(autonomy) },
];

describe('自动化轮次 —— 闸的判定', () => {
  it('没开自主 / 档位为 0 → autonomy-disabled', async () => {
    const { db } = createStateDb();
    const off = await tick(db, tickPack(baseAutonomy({ enabled: false })));
    expect(off.skipped).toEqual([{ charId: CHAR_ID, reason: AUTONOMY_SKIP_REASONS.disabled }]);
    expect(off.built).toEqual([]);

    const { db: db2 } = createStateDb();
    const zero = await tick(db2, tickPack(baseAutonomy({ autonomyLevel: 0 })));
    expect(zero.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.disabled);

    const { db: db3 } = createStateDb();
    const absent = await tick(db3, [{ userId: USER_ID, charId: CHAR_ID, charName: CHAR_NAME, pack: packFor(undefined) }]);
    expect(absent.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.disabled);
  });

  it('cadence 不合法 → cadence-invalid（minHours>0 且 min<=max）', async () => {
    const { db } = createStateDb();
    const zero = await tick(db, tickPack(baseAutonomy({ cadence: { minHours: 0, maxHours: 4 } })));
    expect(zero.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.cadenceInvalid);

    const { db: db2 } = createStateDb();
    const inverted = await tick(db2, tickPack(baseAutonomy({ cadence: { minHours: 3, maxHours: 2 } })));
    expect(inverted.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.cadenceInvalid);
  });

  it('窗口没到 → spacing-window；到窗则建任务', async () => {
    const fresh = createStateDb();
    const first = await tick(fresh.db, tickPack(baseAutonomy()));
    expect(first.built).toEqual([CHAR_ID]);

    const { db } = createStateDb([{ ...emptyAutonomyState(CHAR_ID), lastRoundAt: NOW - 30 * 60_000 }]);
    const due = await tick(db, tickPack(baseAutonomy()));
    expect(due.skipped).toEqual([{ charId: CHAR_ID, reason: AUTONOMY_SKIP_REASONS.spacingWindow }]);

    const { db: db2 } = createStateDb([{ ...emptyAutonomyState(CHAR_ID), lastRoundAt: NOW - 2 * 60 * 60_000 }]);
    expect((await tick(db2, tickPack(baseAutonomy()))).built).toEqual([CHAR_ID]);
  });

  it('用户刚说过话 → spacing-window（间隔的第二半句）', async () => {
    const pack = { ...packFor(baseAutonomy()), lastUserMessageAt: NOW - 60_000 };
    const { db } = createStateDb();
    const result = await tick(db, [{ userId: USER_ID, charId: CHAR_ID, charName: CHAR_NAME, pack }]);
    expect(result.skipped).toEqual([{ charId: CHAR_ID, reason: AUTONOMY_SKIP_REASONS.spacingWindow }]);
  });

  it('窗口按 cadence 采样（每个角色只消费一次随机数）', async () => {
    const spent: number[] = [];
    const rand01 = () => { spent.push(1); return 0.5; };
    const { db } = createStateDb([{ ...emptyAutonomyState(CHAR_ID), lastRoundAt: NOW - 2 * 60 * 60_000 }]);
    const result = await tick(db, tickPack(baseAutonomy({ cadence: { minHours: 1, maxHours: 3 } })), { rand01 });
    // 窗口 = 1h + 0.5 * 2h = 2h，NOW-2h 不满足 ">" → 跳过
    expect(result.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.spacingWindow);
    expect(spent).toHaveLength(1);
  });

  it('非法时区 → tz-invalid（不猜一个钟）', async () => {
    const pack = { ...packFor(baseAutonomy()), tzId: 'Not/AZone' };
    const { db } = createStateDb();
    const result = await tick(db, [{ userId: USER_ID, charId: CHAR_ID, charName: CHAR_NAME, pack }]);
    expect(result.skipped).toEqual([{ charId: CHAR_ID, reason: AUTONOMY_SKIP_REASONS.tzInvalid }]);
  });

  it('静默段（含跨夜）', async () => {
    const overnight = baseAutonomy({ quietHours: { start: '23:00', end: '06:00' } });
    // 上海 00:30 → 落在跨夜段里
    const inside = createStateDb();
    const at0030 = await tick(inside.db, tickPack(overnight), { nowMs: Date.parse('2026-07-25T16:30:00.000Z') });
    expect(at0030.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.quietHours);
    // 上海 20:00 → 不在跨夜段里
    const outside = createStateDb();
    expect((await tick(outside.db, tickPack(overnight))).built).toEqual([CHAR_ID]);

    const midday = baseAutonomy({ quietHours: { start: '12:00', end: '13:00' } });
    // 上海 12:30 → 在段内（非跨夜）
    const { db } = createStateDb();
    const noon = await tick(db, tickPack(midday), { nowMs: Date.parse('2026-07-25T04:30:00.000Z') });
    expect(noon.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.quietHours);
    // 上海 13:00（段尾，左闭右开）→ 放行
    const { db: db2 } = createStateDb();
    expect((await tick(db2, tickPack(midday), { nowMs: Date.parse('2026-07-25T05:00:00.000Z') })).built).toEqual([CHAR_ID]);
  });

  it('当日轮数上限 + 角色时区翻日', async () => {
    const today = await autonomyDateKey(NOW, 'Asia/Shanghai');
    expect(today).toBe('2026-07-25');

    const { db } = createStateDb([
      { ...emptyAutonomyState(CHAR_ID), roundsDate: today, roundsToday: 3 },
    ]);
    const capped = await tick(db, tickPack(baseAutonomy({ maxRoundsPerDay: 3 })));
    expect(capped.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.dailyLimit);

    const { db: db2, states } = createStateDb([
      { ...emptyAutonomyState(CHAR_ID), roundsDate: '2026-07-24', roundsToday: 3 },
    ]);
    const rolled = await tick(db2, tickPack(baseAutonomy({ maxRoundsPerDay: 3 })));
    expect(rolled.built).toEqual([CHAR_ID]);
    expect(states.get(CHAR_ID)).toMatchObject({ roundsDate: today, roundsToday: 1 });
  });

  it('推送冷却（0 / 未推过都放行）', async () => {
    const { db } = createStateDb([{ ...emptyAutonomyState(CHAR_ID), lastPushAt: NOW - 10 * 60_000 }]);
    const cooled = await tick(db, tickPack(baseAutonomy({ push: { mode: 'big', maxPerDay: 1, cooldownMinutes: 60 } })));
    expect(cooled.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.pushCooldown);

    const { db: db2 } = createStateDb([{ ...emptyAutonomyState(CHAR_ID), lastPushAt: 0 }]);
    expect((await tick(db2, tickPack(baseAutonomy({ push: { mode: 'big', maxPerDay: 1, cooldownMinutes: 60 } })))).built)
      .toEqual([CHAR_ID]);

    const { db: db3 } = createStateDb([{ ...emptyAutonomyState(CHAR_ID), lastPushAt: NOW - 1 }]);
    expect((await tick(db3, tickPack(baseAutonomy({ push: { mode: 'big', maxPerDay: 1, cooldownMinutes: 0 } })))).built)
      .toEqual([CHAR_ID]);
  });

  it('token 预算（同翻日口径）', async () => {
    const today = await autonomyDateKey(NOW, 'Asia/Shanghai');
    const { db } = createStateDb([
      { ...emptyAutonomyState(CHAR_ID), tokensDate: today, tokensToday: 1000 },
    ]);
    const broke = await tick(db, tickPack(baseAutonomy({ dailyTokenBudget: 1000 })));
    expect(broke.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.tokenBudget);

    const { db: db2 } = createStateDb([
      { ...emptyAutonomyState(CHAR_ID), tokensDate: '2026-07-24', tokensToday: 1000 },
    ]);
    expect((await tick(db2, tickPack(baseAutonomy({ dailyTokenBudget: 1000 })))).built).toEqual([CHAR_ID]);
  });

  it('连续失败到上限 → fail-muted', async () => {
    const autonomy = baseAutonomy();
    const { db } = createStateDb([{
      ...emptyAutonomyState(CHAR_ID),
      failStreak: AUTONOMY_FAIL_LIMIT,
      configHash: autonomyConfigHash(autonomy),
    }]);
    const muted = await tick(db, tickPack(autonomy));
    expect(muted.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.failMuted);
  });

  it('configHash 变了 → 清熔断并把新口径记下来', async () => {
    const autonomy = baseAutonomy();
    const { db, states } = createStateDb([
      { ...emptyAutonomyState(CHAR_ID), failStreak: 2, configHash: 'stale' },
    ]);
    await tick(db, tickPack(autonomy));
    const after = states.get(CHAR_ID)!;
    expect(after.failStreak).toBe(0);
    expect(after.configHash).toBe(autonomyConfigHash(autonomy));
  });

  it('claim-first：postTask 抛错也不回滚，账已经扣掉', async () => {
    const { db, states } = createStateDb();
    const calls: unknown[] = [];
    const result = await tick(db, tickPack(baseAutonomy()), {
      postTask: async (args) => {
        calls.push(args);
        throw new Error('schedule-message 拒绝（HTTP 500）');
      },
    });
    expect(calls).toHaveLength(1);
    expect(result.built).toEqual([]);
    expect(result.skipped).toEqual([{ charId: CHAR_ID, reason: AUTONOMY_SKIP_REASONS.postFailed }]);
    expect(states.get(CHAR_ID)).toMatchObject({ lastRoundAt: NOW, roundsToday: 1 });
  });

  it('每跳清一遍 7 天前的经历', async () => {
    const { db, statements } = createStateDb();
    await tick(db, tickPack(baseAutonomy()));
    const cleanup = statements.find((s) => s.sql.includes('DELETE FROM autonomy_experiences'));
    expect(cleanup?.args).toEqual([NOW - 7 * 24 * 60 * 60 * 1000]);
  });
});

// 上游 POST /schedule-message 建任务前就会查这两样（chunk-3JEWYDM4.mjs:2544-2596），
// 缺了任务到点必被 409 拒。所以调度器要在扣任何账之前先跳过——不建、不计轮、不烧预算。
describe('到点硬前置（缺凭据 / 缺推送订阅）', () => {
  const stateWrites = (statements: Array<{ sql: string }>) =>
    statements.filter((s) => s.sql.includes('INSERT INTO autonomy_state') || s.sql.includes('UPDATE autonomy_state'));

  it('缺 chat 凭据行 → missing-credentials，且零 state 写（不清熔断、不扣账）', async () => {
    const { db, states, statements } = createStateDb(
      [{ ...emptyAutonomyState(CHAR_ID), configHash: 'stale', failStreak: 2 }],
      { credentials: false },
    );
    const result = await tick(db, tickPack(baseAutonomy()));
    expect(result.built).toEqual([]);
    expect(result.skipped).toEqual([{ charId: CHAR_ID, reason: AUTONOMY_SKIP_REASONS.missingCredentials }]);
    // 前置闸在 configHash 写之前：配置指纹变了也不许落库，账一分没动。
    expect(stateWrites(statements)).toEqual([]);
    expect(states.get(CHAR_ID)).toMatchObject({
      lastRoundAt: 0, roundsToday: 0, configHash: 'stale', failStreak: 2,
    });
  });

  it('缺推送订阅 → missing-push-subscription，同样零 state 写', async () => {
    const { db, states, statements } = createStateDb([], { pushSubscription: false });
    const result = await tick(db, tickPack(baseAutonomy()));
    expect(result.skipped).toEqual([{ charId: CHAR_ID, reason: AUTONOMY_SKIP_REASONS.missingPushSubscription }]);
    expect(stateWrites(statements)).toEqual([]);
    expect(states.has(CHAR_ID)).toBe(false);
  });

  it('两样都缺时先报凭据；关着自主的角色仍报 disabled（disabled 闸在前）', async () => {
    const both = createStateDb([], { credentials: false, pushSubscription: false });
    expect((await tick(both.db, tickPack(baseAutonomy()))).skipped[0].reason)
      .toBe(AUTONOMY_SKIP_REASONS.missingCredentials);

    const off = createStateDb([], { credentials: false, pushSubscription: false });
    expect((await tick(off.db, tickPack(baseAutonomy({ enabled: false })))).skipped[0].reason)
      .toBe(AUTONOMY_SKIP_REASONS.disabled);
  });

  it('前置闸在 claim-first 之前：到窗也不建任务、不扣账', async () => {
    let posted = 0;
    const { db, states } = createStateDb([], { credentials: false });
    const result = await tick(db, tickPack(baseAutonomy()), {
      postTask: async () => { posted += 1; return { status: 200 }; },
    });
    expect(posted).toBe(0);
    expect(result.built).toEqual([]);
    expect(states.get(CHAR_ID)?.lastRoundAt ?? 0).toBe(0);
    expect(states.get(CHAR_ID)?.roundsToday ?? 0).toBe(0);
  });

  it('两样齐 → 照常建任务（前置不该误伤）', async () => {
    const { db } = createStateDb();
    expect((await tick(db, tickPack(baseAutonomy()))).built).toEqual([CHAR_ID]);
  });

  it('前置查询按上游表形状（user_id + cred_id / push_subscriptions）', async () => {
    const { db, statements } = createStateDb();
    await tick(db, tickPack(baseAutonomy()));
    const cred = statements.find((s) => s.sql.includes('FROM llm_credentials'));
    expect(cred?.sql).toContain('user_id = ? AND cred_id = ?');
    expect(cred?.args).toEqual([USER_ID, `char:${CHAR_ID}/chat`]);
    const push = statements.find((s) => s.sql.includes('FROM push_subscriptions'));
    expect(push?.sql).toContain('user_id = ?');
  });
});

describe('reportAutonomyOutcome', () => {
  it('skipped 不动账', async () => {
    const { db, states } = createStateDb([{ ...emptyAutonomyState(CHAR_ID), failStreak: 1 }]);
    await reportAutonomyOutcome(CHAR_ID, { ok: false, skipped: true }, { db, dateKey: '2026-07-25' });
    expect(states.get(CHAR_ID)!.failStreak).toBe(1);
  });

  it('ok 清熔断 + 记 token 与推送时间；fail 累加并翻日', async () => {
    const today = '2026-07-25';
    const { db, states } = createStateDb([
      { ...emptyAutonomyState(CHAR_ID), failStreak: 2, tokensDate: today, tokensToday: 100 },
    ]);
    await reportAutonomyOutcome(
      CHAR_ID,
      { ok: true, tokens: 500, pushed: true },
      { db, dateKey: today, nowMs: NOW },
    );
    expect(states.get(CHAR_ID)).toMatchObject({
      failStreak: 0, tokensToday: 600, lastPushAt: NOW, tokensDate: today,
    });

    const { db: db2, states: states2 } = createStateDb([
      { ...emptyAutonomyState(CHAR_ID), failStreak: 1, tokensDate: '2026-07-24', tokensToday: 100 },
    ]);
    await reportAutonomyOutcome(CHAR_ID, { ok: false }, { db: db2, dateKey: today });
    expect(states2.get(CHAR_ID)).toMatchObject({ failStreak: 2, tokensToday: 0, tokensDate: today });
  });
});

describe('scanAutonomyPacks', () => {
  const scanDb = (rows: Array<Record<string, unknown>>) => ({
    prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }),
  });

  const encrypted = async (userId: string, value: unknown) =>
    encryptForStorage(JSON.stringify(value), await deriveUserEncryptionKey(userId, MASTER));

  it('解出 fire_pack，并从同命名空间的 tool_pack 取 charName', async () => {
    const pack = packFor(baseAutonomy());
    const db = scanDb([
      {
        user_id: USER_ID,
        namespace: `amsg:char:${CHAR_ID}`,
        key: 'fire_pack',
        value: await encrypted(USER_ID, pack),
      },
      {
        user_id: USER_ID,
        namespace: `amsg:char:${CHAR_ID}`,
        key: 'tool_pack',
        value: await encrypted(USER_ID, {
          v: 1,
          charName: CHAR_NAME,
          xhsEnabled: false,
          activeMemoryMonths: [],
          memories: [],
          timeAwarenessEnabled: true,
        }),
      },
      {
        user_id: USER_ID,
        namespace: 'amsg:job',
        key: 'plate:1',
        value: await encrypted(USER_ID, { hello: 1 }),
      },
    ]);

    const result = await scanAutonomyPacks({ db: db as never, masterKey: MASTER });
    expect(result.skipped).toEqual([]);
    expect(result.packs).toHaveLength(1);
    expect(result.packs[0]).toMatchObject({ userId: USER_ID, charId: CHAR_ID, charName: CHAR_NAME });
    expect(result.packs[0].pack.v).toBe(FIRE_PACK_VERSION);
  });

  it('读不出来的行记 pack-unreadable 并跳过（不拖垮整轮）', async () => {
    const db = scanDb([
      { user_id: USER_ID, namespace: `amsg:char:${CHAR_ID}`, key: 'fire_pack', value: 'not-encrypted' },
    ]);
    const result = await scanAutonomyPacks({ db: db as never, masterKey: MASTER });
    expect(result.packs).toEqual([]);
    expect(result.skipped).toEqual([{ charId: CHAR_ID, reason: 'pack-unreadable' }]);
  });
});

describe('自转发的载荷与加密', () => {
  it('加密镜像是 12B iv + 16B tag 的 base64 信封，且能被上游 decryptPayload 解开', async () => {
    const key = await deriveUserEncryptionKey(USER_ID, MASTER);
    const probe = { 你好: '世界', n: 1, nested: { ok: true } };
    const envelope = await encryptPayloadMirror(probe, key);

    expect(Object.keys(envelope).sort()).toEqual(['authTag', 'encryptedData', 'iv']);
    for (const part of [envelope.iv, envelope.authTag, envelope.encryptedData]) {
      expect(part).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    }
    expect(atob(envelope.iv)).toHaveLength(12);
    expect(atob(envelope.authTag)).toHaveLength(16);

    expect(await decryptPayload(envelope, key)).toEqual(probe);
  });

  it('组出来的 /schedule-message 请求符合上游校验口径', async () => {
    const request = await buildAutonomyScheduleRequest({
      userId: USER_ID,
      charId: CHAR_ID,
      charName: CHAR_NAME,
      masterKey: MASTER,
      clientToken: 'shared-secret',
    });

    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname.endsWith('/schedule-message')).toBe(true);
    expect(request.headers.get('X-User-Id')).toBe(USER_ID);
    expect(request.headers.get('X-Payload-Encrypted')).toBe('true');
    expect(request.headers.get('X-Encryption-Version')).toBe('1');
    expect(request.headers.get('X-Client-Token')).toBe('shared-secret');

    const envelope = await request.json() as { iv: string; authTag: string; encryptedData: string };
    const payload = await decryptPayload(envelope, await deriveUserEncryptionKey(USER_ID, MASTER)) as Record<string, any>;
    expect(payload.contactName).toBe(CHAR_NAME);
    expect(payload.messageType).toBe('auto');
    expect(payload.messageSubtype).toBe('job');
    expect(payload.immediate).toBe(true);
    expect(payload.recurrenceType).toBe('none');
    expect(payload.metadata).toMatchObject({
      charId: CHAR_ID,
      charName: CHAR_NAME,
      source: 'active_msg_2',
      amsgKind: AUTONOMOUS_ROUND_KIND,
    });
    expect(typeof payload.metadata.amsgJobId).toBe('string');
    expect(payload.credRefs).toEqual({ chat: `char:${CHAR_ID}/chat` });
    expect(payload.messages).toHaveLength(1);
    // 自主经历这一轮的采样：显式 temperature，只有 temperature（top_p 一个字都不出现）；
    // maxTokens = 理想长度 800 ×2。fire 侧从任务 payload 取采样，handler 层设不了。
    expect(payload.temperature).toBe(0.4);
    expect(payload.maxTokens).toBe(1600);
    expect(Object.keys(payload)).not.toContain('top_p');
    expect(Object.keys(payload)).not.toContain('topP');
  });

  it('没配口令不带 X-Client-Token；charName 缺失时回落到 charId', async () => {
    const request = await buildAutonomyScheduleRequest({
      userId: USER_ID, charId: CHAR_ID, charName: '', masterKey: MASTER,
    });
    expect(request.headers.get('X-Client-Token')).toBeNull();
    const payload = await decryptPayload(
      await request.json() as { iv: string; authTag: string; encryptedData: string },
      await deriveUserEncryptionKey(USER_ID, MASTER),
    ) as Record<string, any>;
    expect(payload.contactName).toBe(CHAR_ID);
  });

  it('createAutonomyPostTask：非 2xx 抛错，2xx 回状态码', async () => {
    const ok = createAutonomyPostTask({ forward: async () => new Response('{}', { status: 200 }), masterKey: MASTER });
    expect(await ok({ userId: USER_ID, charId: CHAR_ID, charName: CHAR_NAME, pack: packFor(baseAutonomy()) }))
      .toEqual({ status: 200 });

    const bad = createAutonomyPostTask({ forward: async () => new Response('{}', { status: 500 }), masterKey: MASTER });
    await expect(bad({ userId: USER_ID, charId: CHAR_ID, charName: CHAR_NAME, pack: packFor(baseAutonomy()) }))
      .rejects.toThrow(/HTTP 500/);
  });
});

describe('接线', () => {
  it('注册表里的 autonomous_round 就是真 handler；没配 D1 时安全跳过（Task-17 的 stub 已下线）', async () => {
    const handler = FIRE_KIND_HANDLERS[AUTONOMOUS_ROUND_KIND];
    expect(handler).toBe(autonomyRoundHandler);

    configureAutonomyFireDb(null);
    try {
      const plan = await handler.beforeFire({
        ctx: { task: {}, readState: async () => [], now: new Date(NOW), scratch: {} },
        charId: CHAR_ID,
        taskMeta: {},
      });
      expect(plan).toEqual({ skip: true, reason: AUTONOMY_FIRE_SKIP.dbUnavailable });
      expect(JSON.stringify(plan)).not.toContain('handler-pending-task-18');

      const decision = await handler.llmOutput({ ctx: { llmOutputText: '' }, state: null });
      expect(decision).toEqual({ decision: 'skip-push', reason: AUTONOMY_FIRE_SKIP.dbUnavailable });
      expect(JSON.stringify(decision)).not.toContain('handler-pending-task-18');
    } finally {
      // holder 是模块级单例，别把「没配」的状态漏给后面的用例。
      configureAutonomyFireDb(null);
    }
  });

  it('cron 的 scheduled() 里先认领再扫描/跑 tick', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8');
    const start = source.indexOf('async scheduled(');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, start + 2400);
    expect(body).toContain('runAutonomyTick');
    expect(body).toContain('scanAutonomyPacks');
    expect(body).toContain('createAutonomyPostTask');
    // 同一句 nowMs 既算分钟号又喂判定；认领闸在扫描之前，认领失败即 return。
    expect(body).toContain('const nowMs = Date.now()');
    expect(body).toContain('const minuteKey = Math.floor(nowMs / 60_000)');
    expect(body).toContain('claimAutonomyTick(db, minuteKey)');
    const claimAt = body.indexOf('claimAutonomyTick(db, minuteKey)');
    const scanAt = body.indexOf('scanAutonomyPacks');
    const tickAt = body.indexOf('runAutonomyTick');
    expect(claimAt).toBeLessThan(scanAt);
    expect(scanAt).toBeLessThan(tickAt);
  });
});

describe('每分钟认领闸（双 cron 防护）', () => {
  /** 带一张真内存 tick 行的记录型 D1 替身：把「谁先到」的原子性照实现搬进 fake。 */
  const createTickDb = () => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    let minute = 0;
    const db = {
      prepare(sql: string) {
        const stmt = {
          _args: [] as unknown[],
          bind(...args: unknown[]) {
            stmt._args = args;
            return stmt;
          },
          async run() {
            statements.push({ sql, args: stmt._args });
            if (sql.startsWith('UPDATE autonomy_tick SET minute')) {
              const next = Number(stmt._args[0]);
              if (minute < next) {
                minute = next;
                return { success: true, meta: { changes: 1 } };
              }
              return { success: true, meta: { changes: 0 } };
            }
            return { success: true, meta: { changes: 0 } };
          },
          async first() {
            statements.push({ sql, args: stmt._args });
            // 到点前置的两张上游表在这里一律当「存在」：本 describe 只测认领闸。
            if (sql.includes('FROM llm_credentials') || sql.includes('FROM push_subscriptions')) {
              return { ok: 1 };
            }
            return null;
          },
          async all() {
            statements.push({ sql, args: stmt._args });
            return { results: [] };
          },
        };
        return stmt;
      },
    };
    return { db, statements, minute: () => minute };
  };

  it('认领失败的那一跳不再产生任何 D1 写（认领行之外零写）', async () => {
    resetAutonomySchemaCacheForTesting();
    const { db, statements, minute } = createTickDb();
    const key = 29_700_000;

    await ensureAutonomySchema(db);
    statements.length = 0;

    expect(await claimAutonomyTick(db, key)).toBe(true);
    expect(minute()).toBe(key);
    expect(await claimAutonomyTick(db, key)).toBe(false);

    expect(statements.map((s) => s.sql)).toEqual([
      'UPDATE autonomy_tick SET minute = ? WHERE id = 1 AND minute < ?',
      'UPDATE autonomy_tick SET minute = ? WHERE id = 1 AND minute < ?',
    ]);
    for (const { sql } of statements) {
      expect(sql).not.toContain('autonomy_state');
      expect(sql).not.toContain('autonomy_experiences');
    }
  });

  it('认领与建任务是两套独立机制：post 失败不影响下一分钟再认领', async () => {
    resetAutonomySchemaCacheForTesting();
    const { db } = createTickDb();
    const key = 29_700_000;

    await ensureAutonomySchema(db);
    expect(await claimAutonomyTick(db, key)).toBe(true);
    // 这一分钟里 tick 的 post 失败（claim-first：账照扣，见上面的 claim-first 用例）。
    const result = await tick(db, tickPack(baseAutonomy()), {
      postTask: async () => { throw new Error('schedule-message 拒绝（HTTP 500）'); },
    });
    expect(result.skipped).toEqual([{ charId: CHAR_ID, reason: AUTONOMY_SKIP_REASONS.postFailed }]);
    // 下一分钟照常认领：gate 只看 minute，与 post 成败无关。
    expect(await claimAutonomyTick(db, key + 1)).toBe(true);
  });
});

describe('home round policy', () => {
  it('凌晨 3 点不推送', () => {
    // 180 = 北京时间 03:00 的当日分钟数（调用方按角色时区算好传进来，与机器时区无关）
    expect(shouldPushNow(3 * 60, 47)).toBe(false);
  });
  it('日 48 轮熔断', () => {
    expect(shouldPushNow(15 * 60, 48)).toBe(false);
  });
  it('生产链：旧链日计数到 48 熔断', async () => {
    const today = await autonomyDateKey(NOW, 'Asia/Shanghai');
    const { db } = createStateDb([
      { ...emptyAutonomyState(CHAR_ID), roundsDate: today, roundsToday: 48 },
    ]);
    const result = await tick(db, tickPack(baseAutonomy({ maxRoundsPerDay: 100 })));
    expect(result.built).toEqual([]);
    expect(result.skipped).toEqual([{ charId: CHAR_ID, reason: AUTONOMY_SKIP_REASONS.dailyLimit }]);
  });
  it('生产链：角色时区 03:00 只写不推（旧链静默段未配也拦得住）', async () => {
    const { db } = createStateDb();
    const result = await tick(db, tickPack(baseAutonomy()), {
      nowMs: Date.parse('2026-07-25T19:00:00.000Z'), // 上海 2026-07-26 03:00
    });
    expect(result.built).toEqual([]);
    expect(result.skipped).toEqual([{ charId: CHAR_ID, reason: AUTONOMY_SKIP_REASONS.quietHours }]);
  });
  it('生产链：单轮间隔不低于 P2 默认 30 分钟', async () => {
    const { db } = createStateDb([{ ...emptyAutonomyState(CHAR_ID), lastRoundAt: NOW - 10 * 60_000 }]);
    const result = await tick(db, tickPack(baseAutonomy({ cadence: { minHours: 0.1, maxHours: 0.1 } })));
    expect(result.skipped).toEqual([{ charId: CHAR_ID, reason: AUTONOMY_SKIP_REASONS.spacingWindow }]);
  });
});

// ─── P5：生活工作流队列 ─────────────────────────────────────────────────

const planRow = (over: Partial<AutonomyPlanRecord> = {}): Record<string, unknown> => {
  const plan: AutonomyPlanRecord = {
    id: 'plan-1',
    charId: CHAR_ID,
    kind: 'diary',
    status: 'proposed',
    purpose: '把今天下午的事记下来',
    title: '今天的一点小事',
    maxChars: 400,
    trigger: { kind: 'now' },
    scheduledAt: NOW - 1000,
    expiresAt: NOW + 60 * 60_000,
    createdAt: NOW - 3 * 60 * 60_000,
    updatedAt: NOW - 3 * 60 * 60_000,
    source: 'autonomy_round',
    sourceRef: 'round-1',
    basis: 'virtual',
    evidence: [],
    dedupeKey: 'wf:diary:abc',
    attempts: 0,
    leaseUntil: 0,
    ...over,
  };
  return {
    id: plan.id, char_id: plan.charId, kind: plan.kind, status: plan.status,
    purpose: plan.purpose, title: plan.title, note_hint: plan.noteHint ?? null,
    max_chars: plan.maxChars, trigger_kind: plan.trigger.kind,
    trigger_value: plan.trigger.kind === 'idle' ? String(plan.trigger.afterMinutes) : null,
    scheduled_at: plan.scheduledAt, expires_at: plan.expiresAt,
    created_at: plan.createdAt, updated_at: plan.updatedAt,
    source: plan.source, source_ref: plan.sourceRef, basis: plan.basis,
    evidence_json: JSON.stringify(plan.evidence), predecessor_id: null,
    dedupe_key: plan.dedupeKey, attempts: plan.attempts, lease_until: plan.leaseUntil,
    last_error: null,
  };
};

/** 计划队列专用假库：按 SQL 关键字喂行 / 控制认领结果，记录所有语句。 */
const createPlanDb = (opts: {
  due?: Array<Record<string, unknown>>;
  pending?: Array<Record<string, unknown>>;
  globalUsed?: number;
  charUsed?: number;
  lastKindAt?: number;
  reserved?: number;
  claimGlobal?: boolean;
  insertRun?: boolean;
  claimPlan?: boolean;
} = {}) => {
  const statements: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          stmt._args = args;
          return stmt;
        },
        async run() {
          statements.push({ sql, args: stmt._args });
          if (sql.includes('INSERT OR IGNORE INTO autonomy_plan_runs')) {
            return { success: true, meta: { changes: (opts.insertRun ?? true) ? 1 : 0 } };
          }
          if (sql.includes("SET status = 'scheduled'")) {
            return { success: true, meta: { changes: (opts.claimPlan ?? true) ? 1 : 0 } };
          }
          if (sql.includes("SET used = CASE WHEN date = ?")) {
            return { success: true, meta: { changes: (opts.claimGlobal ?? true) ? 1 : 0 } };
          }
          if (sql.includes("SET status = 'cancelled'")) {
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
        async first() {
          statements.push({ sql, args: stmt._args });
          if (sql.includes('COUNT(*) AS total FROM autonomy_plans')) return { total: opts.charUsed ?? 0 };
          if (sql.includes('MAX(scheduled_at) AS last_at')) return { last_at: opts.lastKindAt ?? 0 };
          if (sql.includes('FROM autonomy_global_state')) {
            return { date: '2026-07-25', used: opts.globalUsed ?? 0 };
          }
          if (sql.includes('SUM(reserved_tokens)')) return { total: opts.reserved ?? 0 };
          return null;
        },
        async all() {
          statements.push({ sql, args: stmt._args });
          if (sql.includes("status IN (?, ?)") && sql.includes('ORDER BY created_at DESC')) {
            return { results: opts.pending ?? [] };
          }
          if (sql.includes("status = 'proposed' AND scheduled_at <= ?")) {
            return { results: opts.due ?? [] };
          }
          return { results: [] };
        },
      };
      return stmt;
    },
  };
  return { db, statements };
};

const planQueueArgs = (
  db: unknown,
  over: Partial<Parameters<typeof runAutonomyPlanQueue>[0]> = {},
  postTask: (args: unknown) => Promise<unknown> = async () => ({ status: 200 }),
): Parameters<typeof runAutonomyPlanQueue>[0] => ({
  db: db as never,
  userId: USER_ID,
  charId: CHAR_ID,
  charName: CHAR_NAME,
  pack: packFor(baseAutonomy()),
  nowMs: NOW,
  lastUserMessageAt: null,
  autonomous: baseAutonomy(),
  sharedGuardrails: baseAutonomy().guardrails,
  postTask: postTask as never,
  ...over,
});

describe('生活工作流队列（P5）', () => {
  it('到点计划 → 建一条带计划 metadata 的任务；全局额度 + 预留都落地', async () => {
    const { db, statements } = createPlanDb({ due: [planRow()] });
    const posts: any[] = [];
    const result = await runAutonomyPlanQueue(
      planQueueArgs(db, {}, async (args) => { posts.push(args); return { status: 200 }; }),
    );

    expect(result.scheduled).toEqual(['plan-1']);
    expect(posts).toHaveLength(1);
    expect(posts[0].plan).toMatchObject({ id: 'plan-1', kind: 'diary', status: 'scheduled' });
    expect(statements.some((s) => s.sql.includes('INSERT OR IGNORE INTO autonomy_plan_runs'))).toBe(true);
    expect(statements.some((s) => s.sql.includes('INSERT OR IGNORE INTO autonomy_global_state'))).toBe(true);
  });

  it('用户重新开口 → 取消还没开始的，绝不建任务', async () => {
    const { db } = createPlanDb({
      pending: [planRow()],
      due: [planRow()],
    });
    const posts: unknown[] = [];
    const result = await runAutonomyPlanQueue(planQueueArgs(
      db,
      { lastUserMessageAt: NOW - 60_000 },
      async (args) => { posts.push(args); return { status: 200 }; },
    ));
    expect(posts).toEqual([]);
    expect(result.scheduled).toEqual([]);
    expect(result.cancelled).toBe(1);
  });

  it('同一句用户消息催出来的计划不会被它自己马上撤掉（真实 msg id 对齐）', async () => {
    // 时钟偏差场景：消息时间戳 (NOW-30s) 比计划 createdAt (NOW-60s) 新 —— 只比时间戳会误撤。
    const { db } = createPlanDb({
      pending: [planRow({ sourceRef: 'chat:char-lumen:m77' })],
      due: [planRow({ sourceRef: 'chat:char-lumen:m77' })],
    });
    const posts: unknown[] = [];
    const result = await runAutonomyPlanQueue(planQueueArgs(
      db,
      {
        lastUserMessageAt: NOW - 30_000,
        pack: { ...packFor(baseAutonomy()), lastUserMessageId: 77 },
      },
      async (args) => { posts.push(args); return { status: 200 }; },
    ));
    expect(result.cancelled).toBe(0);
    expect(result.scheduled).toEqual(['plan-1']);
    expect(posts).toHaveLength(1);
  });

  it('换了一条新的用户消息 → 旧计划照样按「重新开口」取消', async () => {
    const { db } = createPlanDb({
      pending: [planRow({ sourceRef: 'chat:char-lumen:m77' })],
      due: [planRow({ sourceRef: 'chat:char-lumen:m77' })],
    });
    const posts: unknown[] = [];
    const result = await runAutonomyPlanQueue(planQueueArgs(
      db,
      {
        lastUserMessageAt: NOW - 30_000,
        pack: { ...packFor(baseAutonomy()), lastUserMessageId: 78 },
      },
      async (args) => { posts.push(args); return { status: 200 }; },
    ));
    expect(result.cancelled).toBe(1);
    expect(posts).toEqual([]);
  });

  it('全局 6 次满了 → plan-global-limit（共享计数说了算）', async () => {
    const { db } = createPlanDb({ due: [planRow()], globalUsed: 6 });
    const posts: unknown[] = [];
    const result = await runAutonomyPlanQueue(planQueueArgs(db, {}, async (args) => { posts.push(args); return {}; }));
    expect(posts).toEqual([]);
    expect(result.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.planGlobalLimit);
  });

  it('每角色 2 次 / 同类 2h / 总暂停 都在队列里生效', async () => {
    const daily = createPlanDb({ due: [planRow()], charUsed: 2 });
    expect((await runAutonomyPlanQueue(planQueueArgs(daily.db))).skipped[0].reason)
      .toBe(AUTONOMY_SKIP_REASONS.planDailyLimit);

    const gap = createPlanDb({ due: [planRow()], lastKindAt: NOW - 30 * 60_000 });
    expect((await runAutonomyPlanQueue(planQueueArgs(gap.db))).skipped[0].reason)
      .toBe(AUTONOMY_SKIP_REASONS.planKindGap);

    const paused = createPlanDb({ due: [planRow()] });
    expect((await runAutonomyPlanQueue(planQueueArgs(paused.db, {
      sharedGuardrails: { ...baseAutonomy().guardrails, paused: true },
    }))).skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.paused);
  });

  it('能力被关掉 → 排队前就拦，不建任务、不占次数（等到点才拦等于白烧一次排程）', async () => {
    // 显式 none：一类都不许
    const noneDb = createPlanDb({ due: [planRow()] });
    const nonePosts: unknown[] = [];
    const noneResult = await runAutonomyPlanQueue(planQueueArgs(
      noneDb.db,
      { autonomous: { ...baseAutonomy(), capabilityMode: 'none', capabilities: [] } },
      async (args) => { nonePosts.push(args); return {}; },
    ));
    expect(nonePosts).toEqual([]);
    expect(noneResult.scheduled).toEqual([]);
    expect(noneResult.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.planCapability);
    // 计划被标成 failed（终态，不再重复尝试），不是静静地留在 proposed
    expect(noneDb.statements.some((s) => s.sql.includes('UPDATE autonomy_plans') && s.args.includes('failed'))).toBe(true);

    // 白名单只放行 schedule_write：diary 计划仍被拒，plan 计划才放行
    const deniedDb = createPlanDb({ due: [planRow({ kind: 'diary' })] });
    expect((await runAutonomyPlanQueue(planQueueArgs(deniedDb.db, {
      autonomous: { ...baseAutonomy(), capabilityMode: 'allowlist', capabilities: ['schedule_write'] },
    }))).skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.planCapability);

    const allowedDb = createPlanDb({ due: [planRow({ kind: 'plan' })] });
    const allowedPosts: unknown[] = [];
    const allowed = await runAutonomyPlanQueue(planQueueArgs(allowedDb.db, {
      autonomous: { ...baseAutonomy(), capabilityMode: 'allowlist', capabilities: ['schedule_write'] },
    }, async (args) => { allowedPosts.push(args); return { status: 200 }; }));
    expect(allowed.scheduled).toEqual(['plan-1']);
    expect(allowedPosts).toHaveLength(1);
  });

  it('全局名额抢不到 → 不建任务（多设备/多 cron 只有一方成功）', async () => {
    const { db } = createPlanDb({ due: [planRow()], claimGlobal: false });
    const posts: unknown[] = [];
    const result = await runAutonomyPlanQueue(planQueueArgs(db, {}, async (args) => { posts.push(args); return {}; }));
    expect(posts).toEqual([]);
    expect(result.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.planGlobalLimit);
  });

  it('计划认领失败 → 退全局名额、预留释放，不建任务', async () => {
    const { db, statements } = createPlanDb({ due: [planRow()], claimPlan: false });
    const posts: unknown[] = [];
    const result = await runAutonomyPlanQueue(planQueueArgs(db, {}, async (args) => { posts.push(args); return {}; }));
    expect(posts).toEqual([]);
    expect(result.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.planNotPending);
    expect(statements.some((s) => s.sql.includes('used - 1'))).toBe(true);
    expect(statements.some((s) => s.args.includes('released'))).toBe(true);
  });

  it('建任务超时 → 计划/执行都标 unknown（终态，不自动重试）', async () => {
    const { db, statements } = createPlanDb({ due: [planRow()] });
    const result = await runAutonomyPlanQueue(planQueueArgs(db, {}, async () => {
      throw new Error('ETIMEDOUT');
    }));
    expect(result.scheduled).toEqual([]);
    expect(result.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.planPostFailed);
    const runUpdate = statements.find((s) => s.sql.includes('UPDATE autonomy_plan_runs') && s.args.includes('unknown'));
    expect(runUpdate).toBeTruthy();
    const settle = statements.find((s) => s.sql.includes('UPDATE autonomy_plans') && s.args.includes('unknown'));
    expect(settle).toBeTruthy();
  });
});

describe('共享护栏（用户级全局配置）', () => {
  it('扫描时把共享护栏挂在包上（cron 不需要额外传 masterKey）', async () => {
    const key = await deriveUserEncryptionKey(USER_ID, MASTER);
    const pack = packFor(baseAutonomy());
    const packRow = {
      user_id: USER_ID, namespace: `amsg:char:${CHAR_ID}`, key: 'fire_pack',
      value: await encryptForStorage(JSON.stringify(pack), key),
    };
    const guardRow = {
      user_id: USER_ID, namespace: 'amsg:global', key: 'autonomy_guardrails',
      value: await encryptForStorage(JSON.stringify({ version: 1, globalPerDay: 3, paused: true }), key),
    };
    const db = {
      prepare(sql: string) {
        const stmt = {
          bind() { return stmt; },
          async all() {
            return { results: sql.includes('namespace = ? AND key = ?') ? [guardRow] : [packRow] };
          },
        };
        return stmt;
      },
    };
    const result = await scanAutonomyPacks({ db: db as never, masterKey: MASTER });
    expect(result.packs[0].sharedGuardrails).toMatchObject({ globalPerDay: 3, paused: true });
  });

  it('总暂停 → 整跳跳过（不建回合、不排计划）', async () => {
    const { db } = createStateDb();
    const posted: unknown[] = [];
    const result = await tick(db, [{
      userId: USER_ID, charId: CHAR_ID, charName: CHAR_NAME,
      pack: packFor(baseAutonomy()),
      sharedGuardrails: { ...baseAutonomy().guardrails, paused: true },
    }], { postTask: async (args) => { posted.push(args); return {}; } });
    expect(posted).toEqual([]);
    expect(result.built).toEqual([]);
    expect(result.skipped).toEqual([{ charId: CHAR_ID, reason: AUTONOMY_SKIP_REASONS.paused }]);
  });
  it('读云端加密行 → 归一后的护栏；缺行回落默认', async () => {
    const key = await deriveUserEncryptionKey(USER_ID, MASTER);
    const value = await encryptForStorage(JSON.stringify({ version: 1, globalPerDay: 4, paused: true }), key);
    const db = {
      prepare() {
        const stmt = {
          bind() { return stmt; },
          async first() { return { value }; },
          async run() { return {}; },
          async all() { return { results: [] }; },
        };
        return stmt;
      },
    };
    const loaded = await readAutonomyGuardrailsForUser(db as never, MASTER, USER_ID);
    expect(loaded.globalPerDay).toBe(4);
    expect(loaded.paused).toBe(true);

    const empty = {
      prepare() {
        const stmt = {
          bind() { return stmt; },
          async first() { return null; },
          async run() { return {}; },
          async all() { return { results: [] }; },
        };
        return stmt;
      },
    };
    expect((await readAutonomyGuardrailsForUser(empty as never, MASTER, USER_ID)).globalPerDay).toBe(6);
    // 没有 master key = 「读不出来」，不是「用户没暂停」：必须保守暂停（fail-closed）
    expect((await readAutonomyGuardrailsForUser(empty as never, '', USER_ID)).paused).toBe(true);
  });

  it('角色时区当日 0 点', () => {
    // 上海 2026-07-25 20:00 → 当日 0 点 = 2026-07-24T16:00:00Z
    expect(new Date(startOfAutonomyDayMs(NOW, 'Asia/Shanghai')).toISOString())
      .toBe('2026-07-24T16:00:00.000Z');
  });

  it('计划任务 metadata 随 /schedule-message 上云（不加新 kind）', async () => {
    const { db } = createPlanDb({ due: [planRow()] });
    const posts: any[] = [];
    await runAutonomyPlanQueue(planQueueArgs(db, {}, async (args) => { posts.push(args); return {}; }));
    const request = await buildAutonomyScheduleRequest({
      userId: USER_ID, charId: CHAR_ID, charName: CHAR_NAME, masterKey: MASTER,
      plan: posts[0].plan,
    });
    const payload = await decryptPayload(
      await request.json() as { iv: string; authTag: string; encryptedData: string },
      await deriveUserEncryptionKey(USER_ID, MASTER),
    ) as Record<string, any>;
    expect(payload.metadata.amsgKind).toBe(AUTONOMOUS_ROUND_KIND);
    expect(payload.metadata[AUTONOMY_PLAN_META_KEY]).toMatchObject({
      planId: 'plan-1', kind: 'diary', title: '今天的一点小事', maxChars: 400,
    });
  });
});

describe('护栏 fail-closed（发布阻断项 1）', () => {
  const dbWith = (first: unknown) => ({
    prepare() {
      const stmt = {
        bind() { return stmt; },
        async first() { return first; },
        async run() { return {}; },
        async all() { return { results: [] }; },
      };
      return stmt;
    },
  });

  it('行不存在 = 新用户 → absent，允许默认值（paused=false, 6 次/天）', async () => {
    const read = await readAutonomyGuardrailsForUserDetailed(dbWith(null) as never, MASTER, USER_ID);
    expect(read.status).toBe('absent');
    expect(read.guardrails.paused).toBe(false);
    expect(read.guardrails.globalPerDay).toBe(6);
  });

  it('缺 master key → unreadable + 保守暂停（不再回落 paused:false）', async () => {
    const read = await readAutonomyGuardrailsForUserDetailed(dbWith(null) as never, '', USER_ID);
    expect(read.status).toBe('unreadable');
    expect(read.guardrails.paused).toBe(true);
    expect((await readAutonomyGuardrailsForUser(dbWith(null) as never, '', USER_ID)).paused).toBe(true);
  });

  it('密文坏 → unreadable + 暂停；不把用户的总暂停吞掉', async () => {
    const read = await readAutonomyGuardrailsForUserDetailed(
      dbWith({ value: 'not-a-ciphertext' }) as never, MASTER, USER_ID,
    );
    expect(read.status).toBe('unreadable');
    expect(read.guardrails.paused).toBe(true);
    expect((await readAutonomyGuardrailsForUser(dbWith({ value: 'not-a-ciphertext' }) as never, MASTER, USER_ID)).paused).toBe(true);
  });

  it('DB 抛错 → unreadable（不是默认配置）', async () => {
    const broken = {
      prepare() {
        const stmt = {
          bind() { return stmt; },
          async first(): Promise<unknown> { throw new Error('D1_ERROR'); },
        };
        return stmt;
      },
    };
    const read = await readAutonomyGuardrailsForUserDetailed(broken as never, MASTER, USER_ID);
    expect(read.status).toBe('unreadable');
    expect(read.guardrails.paused).toBe(true);
  });

  it('包上带 sharedGuardrailsUnreadable → 整跳跳过，且不建任务、不排计划', async () => {
    const { db } = createStateDb();
    const posted: unknown[] = [];
    const result = await tick(db, [{
      userId: USER_ID, charId: CHAR_ID, charName: CHAR_NAME,
      pack: packFor(baseAutonomy()),
      sharedGuardrailsUnreadable: true,
    }], { postTask: async (args) => { posted.push(args); return {}; } });
    expect(posted).toEqual([]);
    expect(result.built).toEqual([]);
    expect(result.skipped).toEqual([{ charId: CHAR_ID, reason: AUTONOMY_SKIP_REASONS.guardrailsUnreadable }]);
  });

  it('扫描时单行解不开 → 该用户标记 unreadable（其他用户不受影响）', async () => {
    const key = await deriveUserEncryptionKey(USER_ID, MASTER);
    const pack = packFor(baseAutonomy());
    const packRow = {
      user_id: USER_ID, namespace: `amsg:char:${CHAR_ID}`, key: 'fire_pack',
      value: await encryptForStorage(JSON.stringify(pack), key),
    };
    const guardRow = {
      user_id: USER_ID, namespace: 'amsg:global', key: 'autonomy_guardrails',
      value: await encryptForStorage('{broken', key),
    };
    const db = {
      prepare(sql: string) {
        const stmt = {
          bind() { return stmt; },
          async all() { return { results: sql.includes('namespace = ? AND key = ?') ? [guardRow] : [packRow] }; },
        };
        return stmt;
      },
    };
    const result = await scanAutonomyPacks({ db: db as never, masterKey: MASTER });
    expect(result.packs[0].sharedGuardrailsUnreadable).toBe(true);
    expect(result.packs[0].sharedGuardrails).toBeUndefined();
  });
});

describe('全局预算 0 / 非法额度（发布阻断项 4）', () => {
  it('limit=0 时不放行，跨日也一样', async () => {
    const statements: string[] = [];
    const db = {
      prepare(sql: string) {
        statements.push(sql);
        const stmt = {
          bind() { return stmt; },
          async run() { return { meta: { changes: 1 } }; },
        };
        return stmt;
      },
    };
    expect(await claimGlobalAutonomyBudget(db as never, {
      userId: USER_ID, dateKey: '2026-07-25', limit: 0, nowMs: NOW,
    })).toBe(false);
    expect(await claimGlobalAutonomyBudget(db as never, {
      userId: USER_ID, dateKey: '2026-07-26', limit: -3, nowMs: NOW,
    })).toBe(false);
    // 一次 SQL 都不该发：连「跨日无条件 +1」的机会都不给
    expect(statements).toEqual([]);
  });

  it('计划队列遇到 globalPerDay=0 → 不建任务（当面额度也是 0）', async () => {
    const { db } = createPlanDb({ due: [planRow()] });
    const posts: unknown[] = [];
    const result = await runAutonomyPlanQueue(planQueueArgs(db, {
      sharedGuardrails: { ...baseAutonomy().guardrails, globalPerDay: 0 },
    }, async (args) => { posts.push(args); return {}; }));
    expect(posts).toEqual([]);
    expect(result.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.planGlobalLimit);
  });
});

describe('人工重试不再被固定幂等键挡死（发布阻断项 2）', () => {
  it('insertAutonomyPlanRun 让 released 旧行让出唯一键，但保留那行做审计', async () => {
    const { db, statements } = createPlanDb({ due: [planRow()], insertRun: false });
    await runAutonomyPlanQueue(planQueueArgs(db, {}, async () => ({ status: 200 })));
    // 不再 DELETE：认领过又退回这件事本身就值得留痕（否则事后分不清「没认领过」和「认领后又退了」）。
    const del = statements.find((s) => s.sql.includes('DELETE FROM autonomy_plan_runs'));
    expect(del).toBeFalsy();
    const relabel = statements.find((s) => s.sql.includes("status = 'released'")
      && s.sql.includes("idempotency_key = idempotency_key || ':released:' || id"));
    expect(relabel).toBeTruthy();
    expect(relabel!.args).toContain('plan:plan-1');
  });
});
