/**
 * 旧 AIRP 自动回合「调度 → fire → 结算」的真实 SQLite 集成测试。
 *
 * 为什么单开一份：`legacyGate.test.ts` 钉的是闸函数本身；这里必须证明**真正的 fire 入口**
 * （`autonomyRoundHandler.beforeFire` / `llmOutput`）就在模型请求之前过统一边界 + 原子
 * 预算，并且旧路径的消费真的记进新账本。用真 SQLite（node:sqlite）+ 真 handler，
 * 不用假库、不用 fixture。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createSqliteD1, openTestSqlite, type TestSqlite } from './test/d1-sqlite';
import { normalizeBoundary } from '../../../utils/autonomyLife/boundary';
import { AMSG_FIRE_PACK_KEY, amsgStateNamespace, type AmsgFirePack } from '../../../utils/amsgFirePack';
import type { ResolvedAirpAutonomy } from '../../../utils/airp/autonomySettings';
import { ensureAutonomySchema, type AutonomyDb } from './autonomyStore';
import type { KindSessionCtx } from './fireKinds';
import {
  AUTONOMY_FIRE_SKIP,
  autonomyRoundHandler,
  configureAutonomyFireDb,
  configureAutonomyFireMasterKey,
} from './autonomyFire';
import { ensureAutonomyLifeSchema, resetAutonomyLifeSchemaCacheForTesting, type LifeDb } from './autonomyLife/store';

const NOW = Date.parse('2026-10-24T04:00:00.000Z'); // Asia/Shanghai 12:00
const USER = 'user-fire';
const CHAR = 'char-fire';
const WINDOW = 'w:2026-10-24';

let sql: TestSqlite;
let db: LifeDb;

beforeAll(async () => {
  sql = openTestSqlite();
  db = createSqliteD1(sql) as unknown as LifeDb;
  resetAutonomyLifeSchemaCacheForTesting();
  await ensureAutonomyLifeSchema(db);
  // autonomyStore 的 schemaReady 是模块级缓存：整份文件共用一个库，逐例清数据。
  await ensureAutonomySchema(db as unknown as AutonomyDb);
  configureAutonomyFireDb(db as unknown as AutonomyDb);
  configureAutonomyFireMasterKey('test-master-key');
});

beforeEach(async () => {
  for (const table of [
    'autonomy_life_boundaries',
    'autonomy_life_budget',
    'autonomy_life_budget_reservations',
    'autonomy_life_actions',
    'client_state',
    'autonomy_experiences',
    'autonomy_state',
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
});

afterAll(() => {
  configureAutonomyFireDb(null);
});

const autonomy = (): ResolvedAirpAutonomy => ({
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
    version: 1,
    perCharPerDay: 2,
    sameKindMinGapMinutes: 120,
    globalPerDay: 6,
    reserveTokensPerRun: 1600,
    paused: false,
  },
});

const firePack = (): AmsgFirePack => ({
  v: 7,
  template: '【角色系统设定】\n你叫小夏，是个安静的人。',
  lastUserMessageAt: NOW - 3 * 60 * 60 * 1000,
  tzId: 'Asia/Shanghai',
  userTzId: 'Asia/Shanghai',
  targetName: '小明',
  builtAt: NOW - 60 * 60 * 1000,
  pendingTasks: [],
  scene: null,
  selfScheduleEnabled: true,
  autonomy: autonomy(),
});

async function seedBoundary(overrides: Record<string, unknown> = {}) {
  const account = normalizeBoundary(
    {
      enabled: true,
      globalPaused: false,
      timezone: 'Asia/Shanghai',
      allowedKinds: ['interaction.message'],
      limits: {
        accountModelCallsPerDay: 5,
        charModelCallsPerDay: 5,
        accountTokensPerDay: 20_000,
        charTokensPerDay: 10_000,
      },
      ...overrides,
    },
    { scope: 'account', nowMs: NOW, revision: 1 },
  );
  await db
    .prepare('INSERT OR REPLACE INTO autonomy_life_boundaries (owner_id, scope, char_id, revision, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(USER, 'account', '', account.revision, JSON.stringify(account), NOW)
    .run();
  const character = normalizeBoundary({}, { scope: 'character', nowMs: NOW, revision: 0 });
  await db
    .prepare('INSERT OR REPLACE INTO autonomy_life_boundaries (owner_id, scope, char_id, revision, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(USER, 'character', CHAR, character.revision, JSON.stringify(character), NOW)
    .run();
  // owner 的唯一可信来源：client_state 的角色命名空间行。
  await db
    .prepare('INSERT OR REPLACE INTO client_state (user_id, namespace, key, value, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(USER, amsgStateNamespace(CHAR), AMSG_FIRE_PACK_KEY, JSON.stringify(firePack()), NOW)
    .run();
}

const makeCtx = () => ({
  task: { metadata: {} },
  readState: async () => [{ key: AMSG_FIRE_PACK_KEY, value: JSON.stringify(firePack()) }],
  now: new Date(NOW),
  scratch: {},
});

const budgetRows = async () => {
  const rows = await db
    .prepare('SELECT scope, used_calls, reserved_calls, used_tokens, reserved_tokens FROM autonomy_life_budget WHERE owner_id = ? AND window_id = ?')
    .bind(USER, WINDOW)
    .all();
  return rows.results ?? [];
};

const countExperiences = async () => Number(
  (await db.prepare('SELECT COUNT(*) AS n FROM autonomy_experiences WHERE char_id = ?').bind(CHAR).first())?.n ?? 0,
);

describe('旧自动回合 fire：真 SQLite 上过统一边界与原子预算', () => {
  it('账号额度只剩一次：第一跳拿到 messages，第二跳在 fire 前被预算拒（不是只读筛包）', async () => {
    await seedBoundary({ limits: { accountModelCallsPerDay: 1, charModelCallsPerDay: 5 } });

    const first = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    expect('messages' in first).toBe(true);
    expect(await budgetRows()).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'account', reserved_calls: 1 }),
    ]));

    const second = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    expect(second).toEqual({ skip: true, reason: AUTONOMY_FIRE_SKIP.budgetExhausted });
    // 被拒的一跳没有多出任何预留。
    const reservations = await db
      .prepare('SELECT COUNT(*) AS n FROM autonomy_life_budget_reservations WHERE owner_id = ?')
      .bind(USER)
      .first();
    expect(Number(reservations?.n ?? 0)).toBe(1);
  });

  it('排队之后用户按下总暂停 → fire 前整跳跳过（零模型调用、零预留、零业务写入）', async () => {
    await seedBoundary();
    const allowed = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    expect('messages' in allowed).toBe(true);
    // 清掉这一次预留，模拟「上一跳已经结束」。
    await db.prepare('DELETE FROM autonomy_life_budget WHERE owner_id = ?').bind(USER).run();
    await db.prepare('DELETE FROM autonomy_life_budget_reservations WHERE owner_id = ?').bind(USER).run();

    await seedBoundary({ globalPaused: true });
    // 进程重启也不能让闸失效。
    resetAutonomyLifeSchemaCacheForTesting();
    await ensureAutonomyLifeSchema(db);
    const skipped = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    expect(skipped).toEqual({ skip: true, reason: AUTONOMY_FIRE_SKIP.governanceDenied });
    expect(await budgetRows()).toEqual([]);
    expect(await countExperiences()).toBe(0);
  });

  it('模型回来之后结算：真实 usage 记进新预算，预留转为 settled，经历落库', async () => {
    await seedBoundary();
    const plan = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    if (!('messages' in plan)) throw new Error('这一跳不该被跳过');

    const decision = await autonomyRoundHandler.llmOutput({
      ctx: {
        llmOutputText: JSON.stringify({
          v: 1,
          rest: false,
          experiences: [{ q: '傍晚的风', note: '窗外起风了，翻了两页书。', kind: 'quiet', importance: 1 }],
        }),
        usage: { total_tokens: 77 },
      } as unknown as KindSessionCtx,
      state: plan.state,
    });
    expect(decision.decision).toBe('skip-push');

    const rows = await budgetRows();
    for (const row of rows) {
      expect(row.used_calls).toBe(1);
      expect(row.reserved_calls).toBe(0);
      expect(row.used_tokens).toBe(77);
      expect(row.reserved_tokens).toBe(0);
    }
    const record = await db
      .prepare('SELECT state, settled_at FROM autonomy_life_budget_reservations WHERE owner_id = ?')
      .bind(USER)
      .first();
    expect(record?.state).toBe('settled');
    expect(Number(record?.settled_at)).toBeGreaterThan(0);
    expect(await countExperiences()).toBe(1);
  });

  it('模型跑的这段时间里用户加了禁区 → 只结算、不落业务产物', async () => {
    await seedBoundary();
    const plan = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    if (!('messages' in plan)) throw new Error('这一跳不该被跳过');

    // llmOutput 之前边界变了（avoidTopics 命中不了正文也没关系：新增禁区本身即 fail closed）。
    await seedBoundary({ avoidTopics: ['书'] });

    const decision = await autonomyRoundHandler.llmOutput({
      ctx: {
        llmOutputText: JSON.stringify({
          v: 1,
          rest: false,
          experiences: [{ q: '傍晚的风', note: '翻了两页书。', kind: 'quiet', importance: 1 }],
        }),
        usage: { total_tokens: 50 },
      } as unknown as KindSessionCtx,
      state: plan.state,
    });
    expect(decision).toEqual({ decision: 'skip-push', reason: AUTONOMY_FIRE_SKIP.governanceDenied });
    // 预算按「请求已发出」结算（不算白嫖），但业务表零写入。
    const rows = await budgetRows();
    for (const row of rows) {
      expect(row.used_calls).toBe(1);
      expect(row.reserved_calls).toBe(0);
    }
    expect(await countExperiences()).toBe(0);
  });
});
