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
import { hashAutonomyOutput } from './autonomyFire';
import { ensureTravelSchema, setTravelCharEnabled, upsertTravelSettings } from './travel/store';
import { ensureTravelBudgetRow } from './travel/budget';

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
    'autonomy_life_round_claims',
    'autonomy_life_actions',
    'client_state',
    'autonomy_experiences',
    'autonomy_state',
    'travel_wishes',
    'travel_char_settings',
    'travel_settings',
    'travel_budget_state',
  ]) {
    // 出行相关的表由 travel/store 懒建：第一次用到之前不存在，删不掉就算了。
    await db.prepare(`DELETE FROM ${table}`).run().catch(() => undefined);
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
        now: new Date(NOW),
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
        now: new Date(NOW),
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


/* ==================================================================== *
 * 输出效果的一次性执行门（P0）
 * ==================================================================== */

const bigOutput = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  v: 1,
  rest: false,
  experiences: [{ q: '晚风', note: '想跟你说说话。', kind: 'share', importance: 3 }],
  ...overrides,
});

const smallOutput = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  v: 1,
  rest: false,
  experiences: [{ q: '傍晚的风', note: '窗外起风了，翻了两页书。', kind: 'quiet', importance: 1 }],
  ...overrides,
});

const makeSinkCtx = (
  llmOutputText: string,
  usage: Record<string, unknown>,
  /** 执行期的当前服务端时钟（`llmOutput` 的安全判定只看它，不看 carried.nowMs）。 */
  nowMs: number = NOW,
): { ctx: KindSessionCtx; emitted: Array<Record<string, unknown>> } => {
  const emitted: Array<Record<string, unknown>> = [];
  return {
    emitted,
    ctx: {
      llmOutputText,
      usage,
      now: new Date(nowMs),
      emitResult: async (payload: Record<string, unknown>) => {
        emitted.push(payload);
      },
    } as unknown as KindSessionCtx,
  };
};

/**
 * `notification.show` 在即时 push 信封里是 `'always'`（见 instantChat.ts 的
 * `NOTIFICATION_ALWAYS`），被抑制时才是布尔 `false`。这里按「没被抑制」判。
 */
const notificationShows = (payload: Record<string, unknown> | undefined): boolean => {
  const notification = (payload as { notification?: { show?: unknown } } | undefined)?.notification;
  if (!notification) return false;
  return notification.show !== false && notification.show !== undefined;
};

const countPushedExperiences = async (): Promise<number> => Number(
  (await db.prepare('SELECT COUNT(*) AS n FROM autonomy_experiences WHERE char_id = ? AND pushed = 1').bind(CHAR).first())?.n ?? 0,
);

const countWishes = async (): Promise<number> => Number(
  (await db.prepare('SELECT COUNT(*) AS n FROM travel_wishes').first().catch(() => ({ n: 0 })))?.n ?? 0,
);

const countClaims = async (): Promise<number> => Number(
  (await db.prepare('SELECT COUNT(*) AS n FROM autonomy_life_round_claims WHERE owner_id = ?').bind(USER).first())?.n ?? 0,
);

const readAccountBudget = async () => {
  const row = await db
    .prepare('SELECT used_calls, reserved_calls, used_tokens, notifications FROM autonomy_life_budget WHERE owner_id = ? AND window_id = ? AND scope = ?')
    .bind(USER, WINDOW, 'account')
    .first();
  return row ?? null;
};

/**
 * 出行愿望的 amap 外部授权（与 `/external/wish` 同口径：allowedKinds 不够，必须有 grant）。
 */
const amapGrant = (overrides: Record<string, unknown> = {}) => ({
  provider: 'amap' as const,
  scopes: ['read:geo'],
  allowedHosts: ['restapi.amap.com'],
  allowedMethods: ['GET'],
  allowedFieldKeys: ['name'],
  purpose: '出行天气与地点',
  expiresAt: NOW + 86_400_000,
  dailyQuota: 5,
  ...overrides,
});

/** 出行愿望要落库，需要旧的出行授权 + 地图额度（旧链路语义原样保留）。 */
async function seedTravelWishPrereqs(charId = CHAR) {
  await ensureTravelSchema(db as never);
  await upsertTravelSettings(db as never, { userId: USER, nowMs: NOW, baseVersion: null, enabled: true });
  await setTravelCharEnabled(db as never, { userId: USER, charId, enabled: true, nowMs: NOW });
  await ensureTravelBudgetRow(db as never, { userId: USER, mapCallsLimit: 10, nowMs: NOW });
}

describe('旧自动回合输出：一次性执行门（真 SQLite handler）', () => {
  it('同一份 beforeFire state + 同一份输出回放两次 → 第二次零新增经历、零再次下发、不重复结算', async () => {
    await seedBoundary();
    const plan = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    if (!('messages' in plan)) throw new Error('这一跳不该被跳过');

    const first = makeSinkCtx(smallOutput(), { total_tokens: 77 });
    const firstDecision = await autonomyRoundHandler.llmOutput({ ctx: first.ctx, state: plan.state });
    expect(firstDecision.decision).toBe('skip-push');
    expect(first.emitted).toHaveLength(1);
    expect(await countExperiences()).toBe(1);
    expect(await countClaims()).toBe(1);

    const second = makeSinkCtx(smallOutput(), { total_tokens: 77 });
    const secondDecision = await autonomyRoundHandler.llmOutput({ ctx: second.ctx, state: plan.state });
    expect(secondDecision).toEqual({ decision: 'skip-push', reason: AUTONOMY_FIRE_SKIP.governanceDenied });
    expect(second.emitted).toHaveLength(0);
    expect(await countExperiences()).toBe(1);
    expect(await countClaims()).toBe(1);

    // 预算只结算一次：used_calls=1、reserved 清零、token 也只记一次。
    const account = await readAccountBudget();
    expect(account?.used_calls).toBe(1);
    expect(account?.reserved_calls).toBe(0);
    expect(account?.used_tokens).toBe(77);
  });

  it('并发回放：同一 state 同时调两次 llmOutput → 只有一次落产物', async () => {
    await seedBoundary();
    const plan = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    if (!('messages' in plan)) throw new Error('这一跳不该被跳过');

    const a = makeSinkCtx(smallOutput(), { total_tokens: 40 });
    const b = makeSinkCtx(smallOutput(), { total_tokens: 40 });
    await Promise.all([
      autonomyRoundHandler.llmOutput({ ctx: a.ctx, state: plan.state }),
      autonomyRoundHandler.llmOutput({ ctx: b.ctx, state: plan.state }),
    ]);
    expect(a.emitted.length + b.emitted.length).toBe(1);
    expect(await countExperiences()).toBe(1);
  });

  it('旧形状 state（没有 owner / 凭据 / 回合引用）→ fail closed：零业务写入、零下发', async () => {
    await seedBoundary();
    const legacyState = {
      mode: 'round',
      charId: CHAR,
      autonomy: autonomy(),
      pages: [],
      tzId: 'Asia/Shanghai',
      dateKey: '2026-10-24',
      lastPushAt: 0,
      nowMs: NOW,
    };
    const sink = makeSinkCtx(smallOutput(), { total_tokens: 10 });
    const decision = await autonomyRoundHandler.llmOutput({ ctx: sink.ctx, state: legacyState });
    expect(decision).toEqual({ decision: 'skip-push', reason: AUTONOMY_FIRE_SKIP.governanceDenied });
    expect(sink.emitted).toHaveLength(0);
    expect(await countExperiences()).toBe(0);
    expect(await countClaims()).toBe(0);
    expect(await readAccountBudget()).toBeNull();
  });

  it('伪造 owner / 伪造凭据 id（格式合法但从没签发）→ 拒，零业务写入', async () => {
    await seedBoundary();
    const plan = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    if (!('messages' in plan)) throw new Error('这一跳不该被跳过');
    const base = plan.state as Record<string, unknown>;
    const permit = base.budgetPermit as Record<string, unknown>;

    // (a) 伪造 owner：owner 与预留记录对不上 → 查不到这条记录。
    const forgedOwner = makeSinkCtx(smallOutput(), { total_tokens: 10 });
    const ownerDecision = await autonomyRoundHandler.llmOutput({
      ctx: forgedOwner.ctx,
      state: { ...base, ownerUserId: 'user-other' },
    });
    expect(ownerDecision).toEqual({ decision: 'skip-push', reason: AUTONOMY_FIRE_SKIP.governanceDenied });
    expect(forgedOwner.emitted).toHaveLength(0);

    // (b) 伪造凭据 id：形状合法（rsv_<window>_<char>_<ts>_<n>）但从未签发。
    const forgedPermit = makeSinkCtx(smallOutput(), { total_tokens: 10 });
    const forgedDecision = await autonomyRoundHandler.llmOutput({
      ctx: forgedPermit.ctx,
      state: { ...base, budgetPermit: { ...permit, reservationId: `rsv_${WINDOW}_${CHAR}_${NOW}_999999` } },
    });
    expect(forgedDecision).toEqual({ decision: 'skip-push', reason: AUTONOMY_FIRE_SKIP.governanceDenied });

    // (c) 把凭据换成另一个角色的（同一账号下）→ 角色不匹配。
    const otherCharPermit = makeSinkCtx(smallOutput(), { total_tokens: 10 });
    const charDecision = await autonomyRoundHandler.llmOutput({
      ctx: otherCharPermit.ctx,
      state: {
        ...base,
        charId: 'char-other',
        budgetPermit: { ...permit, charId: CHAR },
      },
    });
    expect(charDecision.decision).toBe('skip-push');

    expect(await countExperiences()).toBe(0);
    expect(await countClaims()).toBe(0);
  });

  it('已释放（请求没发出）的凭据 → 拒；已过期的凭据 → 拒', async () => {
    await seedBoundary();
    const plan = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    if (!('messages' in plan)) throw new Error('这一跳不该被跳过');
    const permit = (plan.state as Record<string, unknown>).budgetPermit as { reservationId: string };

    // 释放：模拟 preflight 证明请求没发出。
    await db
      .prepare("UPDATE autonomy_life_budget_reservations SET state = 'released', revision = revision + 1 WHERE owner_id = ? AND reservation_id = ?")
      .bind(USER, permit.reservationId)
      .run();
    const released = makeSinkCtx(smallOutput(), { total_tokens: 10 });
    const releasedDecision = await autonomyRoundHandler.llmOutput({ ctx: released.ctx, state: plan.state });
    expect(releasedDecision).toEqual({ decision: 'skip-push', reason: AUTONOMY_FIRE_SKIP.governanceDenied });
    expect(await countExperiences()).toBe(0);
    expect(await countClaims()).toBe(0);

    // 过期：held 但 expires_at 已经过去。
    await db.prepare('DELETE FROM autonomy_life_budget_reservations WHERE owner_id = ?').bind(USER).run();
    await seedBoundary();
    const plan2 = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    if (!('messages' in plan2)) throw new Error('这一跳不该被跳过');
    await db
      .prepare('UPDATE autonomy_life_budget_reservations SET expires_at = ? WHERE owner_id = ?')
      .bind(NOW - 1000, USER)
      .run();
    const expired = makeSinkCtx(smallOutput(), { total_tokens: 10 });
    const expiredDecision = await autonomyRoundHandler.llmOutput({ ctx: expired.ctx, state: plan2.state });
    expect(expiredDecision).toEqual({ decision: 'skip-push', reason: AUTONOMY_FIRE_SKIP.governanceDenied });
    expect(await countExperiences()).toBe(0);
  });

  it('认领存储失败（D1 写异常）→ fail closed：零业务写入、预算不结算', async () => {
    await seedBoundary();
    const plan = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    if (!('messages' in plan)) throw new Error('这一跳不该被跳过');

    // 换一个「认领表写不进去」的适配器：真实 fire handler 走同一路径。
    const failing = createSqliteD1(sql, {
      beforeStatement: (text) => {
        if (text.includes('INSERT OR IGNORE INTO autonomy_life_round_claims')) {
          throw new Error('d1 write exploded');
        }
      },
    }) as unknown as LifeDb;
    configureAutonomyFireDb(failing as unknown as AutonomyDb);

    const sink = makeSinkCtx(smallOutput(), { total_tokens: 10 });
    const decision = await autonomyRoundHandler.llmOutput({ ctx: sink.ctx, state: plan.state });
    expect(decision).toEqual({ decision: 'skip-push', reason: AUTONOMY_FIRE_SKIP.governanceDenied });
    expect(sink.emitted).toHaveLength(0);
    expect(await countExperiences()).toBe(0);
    // 没认领成功 → 不结算：凭据仍在途（留给对账），不是「账记了但没产物」。
    const record = await db
      .prepare('SELECT state FROM autonomy_life_budget_reservations WHERE owner_id = ?')
      .bind(USER)
      .first();
    expect(record?.state).toBe('held');

    configureAutonomyFireDb(db as unknown as AutonomyDb);
  });

  it('许可按**排队时的 expires_at** 到期：执行时钟越过后第一次输出也进不来（零经历/零下发）', async () => {
    await seedBoundary();
    const plan = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    if (!('messages' in plan)) throw new Error('这一跳不该被跳过');

    // 排队状态与附件里的 expires_at 完全不动，只把执行时钟推过 6h 的 TTL。
    const reservation = await db
      .prepare('SELECT expires_at FROM autonomy_life_budget_reservations WHERE owner_id = ?')
      .bind(USER)
      .first();
    const expiresAt = Number(reservation?.expires_at);
    expect(expiresAt).toBe(NOW + 6 * 60 * 60 * 1000);

    const sink = makeSinkCtx(smallOutput(), { total_tokens: 10 }, expiresAt + 60_000);
    const decision = await autonomyRoundHandler.llmOutput({ ctx: sink.ctx, state: plan.state });
    expect(decision).toEqual({ decision: 'skip-push', reason: AUTONOMY_FIRE_SKIP.governanceDenied });
    expect(sink.emitted).toHaveLength(0);
    expect(await countExperiences()).toBe(0);
    expect(await countClaims()).toBe(0);
  });

  it('正常首次：认领记录可追溯（绑定 owner/角色/凭据/输出指纹）', async () => {
    await seedBoundary();
    const plan = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    if (!('messages' in plan)) throw new Error('这一跳不该被跳过');
    const text = smallOutput();
    const sink = makeSinkCtx(text, { total_tokens: 12 });
    await autonomyRoundHandler.llmOutput({ ctx: sink.ctx, state: plan.state });

    const permit = (plan.state as Record<string, unknown>).budgetPermit as { reservationId: string };
    const roundRef = (plan.state as Record<string, unknown>).roundRef as string;
    const claim = await db
      .prepare('SELECT claim_id, char_id, reservation_id, output_hash, state FROM autonomy_life_round_claims WHERE owner_id = ? AND round_ref = ?')
      .bind(USER, roundRef)
      .first();
    expect(claim?.char_id).toBe(CHAR);
    expect(claim?.reservation_id).toBe(permit.reservationId);
    expect(claim?.output_hash).toBe(hashAutonomyOutput(text));
    expect(claim?.state).toBe('claimed');
    expect(String(claim?.claim_id).startsWith('clm_')).toBe(true);
  });
});

/* ==================================================================== *
 * 新通知上限（P1）
 * ==================================================================== */

describe('旧自动回合的提醒：受用户新通知上限约束（真 SQLite handler）', () => {
  it('通知上限 = 0 → 经历照落、pushed=0、notification.show=false、统一通知计数不动', async () => {
    await seedBoundary({
      limits: {
        accountModelCallsPerDay: 5,
        charModelCallsPerDay: 5,
        accountTokensPerDay: 20_000,
        charTokensPerDay: 10_000,
        notificationsPerDay: 0,
      },
    });
    const plan = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    if (!('messages' in plan)) throw new Error('这一跳不该被跳过');

    const sink = makeSinkCtx(bigOutput(), { total_tokens: 60 });
    const decision = await autonomyRoundHandler.llmOutput({ ctx: sink.ctx, state: plan.state });
    expect(decision).toEqual({ decision: 'skip-push', reason: 'autonomy-result-emitted' });

    // 私人活动照常落库（通知关闭只影响提醒）。
    expect(await countExperiences()).toBe(1);
    expect(await countPushedExperiences()).toBe(0);
    expect(sink.emitted).toHaveLength(1);
    expect(notificationShows(sink.emitted[0])).toBe(false);
    // 统一账本的通知计数没有被扣（额度是 0，一格都没占）。
    expect(Number((await readAccountBudget())?.notifications ?? 0)).toBe(0);
  });

  it('排队后把通知上限收紧到 0 → 私人活动照落、提醒不发', async () => {
    // 建任务时额度还是默认的 1 条；到点之前用户在设置页把通知关成 0。
    await seedBoundary();
    const plan = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    if (!('messages' in plan)) throw new Error('这一跳不该被跳过');
    await seedBoundary({
      limits: {
        accountModelCallsPerDay: 5,
        charModelCallsPerDay: 5,
        accountTokensPerDay: 20_000,
        charTokensPerDay: 10_000,
        notificationsPerDay: 0,
      },
    });

    const sink = makeSinkCtx(bigOutput(), { total_tokens: 60 });
    await autonomyRoundHandler.llmOutput({ ctx: sink.ctx, state: plan.state });
    expect(await countExperiences()).toBe(1);
    expect(await countPushedExperiences()).toBe(0);
    expect(notificationShows(sink.emitted[0])).toBe(false);
    expect(Number((await readAccountBudget())?.notifications ?? 0)).toBe(0);
  });

  it('读完边界、扣通知额度之前用户收紧到 0 并暂停 → 零提醒（私人活动照落）', async () => {
    await seedBoundary();
    const plan = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    if (!('messages' in plan)) throw new Error('这一跳不该被跳过');

    // 边界读完之后、核销 UPDATE 执行之前：另一台设备把通知关成 0 并按下总暂停。
    // 核销语句的 WHERE 里带着账号/角色 revision，所以这次占格必须 0 行。
    let injected = false;
    const hooked = createSqliteD1(sql, {
      beforeStatement: (text) => {
        if (!injected && text.includes('SET notifications = notifications + 1')) {
          injected = true;
          sql.prepare(`UPDATE autonomy_life_boundaries
              SET revision = revision + 1,
                  payload = json_set(payload, '$.limits.notificationsPerDay', 0, '$.globalPaused', json('true'))
              WHERE owner_id = ? AND scope = 'account' AND char_id = ''`)
            .run(USER);
        }
      },
    }) as unknown as LifeDb;
    configureAutonomyFireDb(hooked as unknown as AutonomyDb);

    const sink = makeSinkCtx(bigOutput(), { total_tokens: 60 });
    await autonomyRoundHandler.llmOutput({ ctx: sink.ctx, state: plan.state });
    configureAutonomyFireDb(db as unknown as AutonomyDb);

    expect(injected).toBe(true);
    expect(await countExperiences()).toBe(1);
    expect(await countPushedExperiences()).toBe(0);
    expect(notificationShows(sink.emitted[0])).toBe(false);
    expect(Number((await readAccountBudget())?.notifications ?? 0)).toBe(0);
  });

  it('跨日执行：通知额度按**当前**窗口核算（排队时的旧窗口不算数）', async () => {
    await seedBoundary();
    const plan = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    if (!('messages' in plan)) throw new Error('这一跳不该被跳过');

    // 模拟「排在本地 12:00、半夜 01:00 才执行」：只把凭据的到期时间拉长（TTL 本身允许），
    // carried.nowMs / dateKey 保持排队时的值不动。
    const nextDay = NOW + 13 * 60 * 60 * 1000; // 2026-10-25 01:00 Asia/Shanghai
    await db
      .prepare('UPDATE autonomy_life_budget_reservations SET expires_at = ? WHERE owner_id = ?')
      .bind(nextDay + 60_000, USER)
      .run();

    const sink = makeSinkCtx(bigOutput(), { total_tokens: 60 }, nextDay);
    const decision = await autonomyRoundHandler.llmOutput({ ctx: sink.ctx, state: plan.state });
    expect(decision).toEqual({ decision: 'skip-push', reason: 'autonomy-result-emitted' });
    expect(await countExperiences()).toBe(1);
    expect(await countPushedExperiences()).toBe(1);
    expect(notificationShows(sink.emitted[0])).toBe(true);

    // 通知计数落在**今天**的窗口里（w:2026-10-25），不是排队那天的 w:2026-10-24。
    const nextWindow = await db
      .prepare('SELECT notifications FROM autonomy_life_budget WHERE owner_id = ? AND window_id = ? AND scope = ?')
      .bind(USER, 'w:2026-10-25', 'account')
      .first();
    expect(Number(nextWindow?.notifications ?? 0)).toBe(1);
    const oldWindow = await db
      .prepare('SELECT notifications FROM autonomy_life_budget WHERE owner_id = ? AND window_id = ? AND scope = ?')
      .bind(USER, WINDOW, 'account')
      .first();
    expect(Number(oldWindow?.notifications ?? 0)).toBe(0);
  });

  it('额度还有 1 条 → 提醒发出，统一通知计数 +1（下一轮就被挡）', async () => {
    await seedBoundary();
    const plan = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    if (!('messages' in plan)) throw new Error('这一跳不该被跳过');

    const sink = makeSinkCtx(bigOutput(), { total_tokens: 60 });
    await autonomyRoundHandler.llmOutput({ ctx: sink.ctx, state: plan.state });
    expect(await countPushedExperiences()).toBe(1);
    expect(notificationShows(sink.emitted[0])).toBe(true);
    expect(Number((await readAccountBudget())?.notifications ?? 0)).toBe(1);

    // 第二条：账号层额度已用完（默认 1/天）→ 只落经历、不再下发提醒。
    await db.prepare('DELETE FROM autonomy_life_budget_reservations WHERE owner_id = ?').bind(USER).run();
    const plan2 = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    if (!('messages' in plan2)) throw new Error('这一跳不该被跳过');
    const sink2 = makeSinkCtx(bigOutput(), { total_tokens: 60 });
    await autonomyRoundHandler.llmOutput({ ctx: sink2.ctx, state: plan2.state });
    expect(await countExperiences()).toBe(2);
    expect(notificationShows(sink2.emitted[0])).toBe(false);
    expect(Number((await readAccountBudget())?.notifications ?? 0)).toBe(1);
  });
});

/* ==================================================================== *
 * 出行愿望：受统一边界 + kind 配额（P1）
 * ==================================================================== */

describe('旧自动回合的出行愿望：受统一边界与 kind 配额约束（真 SQLite handler）', () => {
  const travelOutput = (): string => JSON.stringify({
    v: 1,
    rest: false,
    experiences: [{ q: '午后', note: '想出去走走。', kind: 'walk', importance: 1 }],
    // 输出里的字段名是 `travel`（见 parseAutonomyRoundReply），形状见 travel/intent.ts 的 parseTravelIntent。
    travel: { want: 'wander', wish: '想去公园走走' },
  });

  it('allowedKinds 不含 travel.wish → 零新增愿望（其余产物照常）', async () => {
    await seedBoundary();
    await seedTravelWishPrereqs();
    const plan = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    if (!('messages' in plan)) throw new Error('这一跳不该被跳过');

    const sink = makeSinkCtx(travelOutput(), { total_tokens: 30 });
    await autonomyRoundHandler.llmOutput({ ctx: sink.ctx, state: plan.state });
    expect(await countWishes()).toBe(0);
    expect(await countExperiences()).toBe(1);
  });

  it('允许 travel.wish（含 amap 授权）→ 落一条愿望，并占一格 per-kind 配额', async () => {
    await seedBoundary({ allowedKinds: ['interaction.message', 'travel.wish'], externalGrants: [amapGrant()] });
    await seedTravelWishPrereqs();
    const plan = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    if (!('messages' in plan)) throw new Error('这一跳不该被跳过');

    const sink = makeSinkCtx(travelOutput(), { total_tokens: 30 });
    await autonomyRoundHandler.llmOutput({ ctx: sink.ctx, state: plan.state });
    expect(await countWishes()).toBe(1);
    const charRow = await db
      .prepare('SELECT kind_counts FROM autonomy_life_budget WHERE owner_id = ? AND window_id = ? AND scope = ?')
      .bind(USER, WINDOW, CHAR)
      .first();
    expect(JSON.parse(String(charRow?.kind_counts ?? '{}'))['travel.wish']).toBe(1);
  });

  it('没有 amap 授权（allowedKinds 有 travel.wish、旧出行设置开着）→ 零新增愿望', async () => {
    await seedBoundary({ allowedKinds: ['interaction.message', 'travel.wish'] });
    await seedTravelWishPrereqs();
    const plan = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    if (!('messages' in plan)) throw new Error('这一跳不该被跳过');

    const sink = makeSinkCtx(travelOutput(), { total_tokens: 30 });
    await autonomyRoundHandler.llmOutput({ ctx: sink.ctx, state: plan.state });
    expect(await countWishes()).toBe(0);
    expect(await countExperiences()).toBe(1);
    const charRow = await db
      .prepare('SELECT kind_counts FROM autonomy_life_budget WHERE owner_id = ? AND window_id = ? AND scope = ?')
      .bind(USER, WINDOW, CHAR)
      .first();
    expect(JSON.parse(String(charRow?.kind_counts ?? '{}'))['travel.wish'] ?? 0).toBe(0);
  });

  it('读完边界、核销 kind 之前 amap 授权被撤 → 零愿望（其余产物照常）', async () => {
    await seedBoundary({ allowedKinds: ['interaction.message', 'travel.wish'], externalGrants: [amapGrant()] });
    await seedTravelWishPrereqs();
    const plan = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    if (!('messages' in plan)) throw new Error('这一跳不该被跳过');

    let injected = false;
    const hooked = createSqliteD1(sql, {
      beforeStatement: (text) => {
        if (!injected && text.includes('SET kind_counts = json_set')) {
          injected = true;
          sql.prepare(`UPDATE autonomy_life_boundaries
              SET revision = revision + 1, payload = json_remove(payload, '$.externalGrants')
              WHERE owner_id = ? AND scope = 'account' AND char_id = ''`)
            .run(USER);
        }
      },
    }) as unknown as LifeDb;
    configureAutonomyFireDb(hooked as unknown as AutonomyDb);

    const sink = makeSinkCtx(travelOutput(), { total_tokens: 30 });
    await autonomyRoundHandler.llmOutput({ ctx: sink.ctx, state: plan.state });
    configureAutonomyFireDb(db as unknown as AutonomyDb);

    expect(injected).toBe(true);
    expect(await countWishes()).toBe(0);
    expect(await countExperiences()).toBe(1);
  });

  it('账号暂停后（模型跑完那一刻）→ 零新增愿望', async () => {
    await seedBoundary({ allowedKinds: ['interaction.message', 'travel.wish'] });
    await seedTravelWishPrereqs();
    const plan = await autonomyRoundHandler.beforeFire({ ctx: makeCtx(), charId: CHAR, taskMeta: {} });
    if (!('messages' in plan)) throw new Error('这一跳不该被跳过');

    await seedBoundary({ allowedKinds: ['interaction.message', 'travel.wish'], globalPaused: true });
    const sink = makeSinkCtx(travelOutput(), { total_tokens: 30 });
    await autonomyRoundHandler.llmOutput({ ctx: sink.ctx, state: plan.state });
    expect(await countWishes()).toBe(0);
    expect(await countExperiences()).toBe(0);
  });
});
