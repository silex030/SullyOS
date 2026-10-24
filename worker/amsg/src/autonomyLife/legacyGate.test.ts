/**
 * 旧 AIRP 自动回合的边界闸（真 SQL）：存量旧配置不能绕过新边界。
 *
 * 钉住：
 *   1. 只有旧配置（client_state 的 autonomy 护栏 + fire_pack），没有新边界 → 一个都不跑；
 *   2. 新边界开了但角色没登记 → character_not_registered；
 *   3. 暂停 / 关角色 / allowedKinds 不含 interaction.message → 各自跳过；
 *   4. 用户新增禁区 / 回避话题 → fail closed（旧回合正文无法在上游生成前验证）；
 *   5. 预算 used+reserved 达到上限 → budget_exhausted；
 *   6. 进程「重启」后再判一次结果一致（闸没有内存旁路）。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { createSqliteD1, openTestSqlite, type TestSqlite } from '../test/d1-sqlite';
import { normalizeBoundary } from '../../../../utils/autonomyLife/boundary';
import { parseReservationId } from '../../../../utils/autonomyLife/budget';
import type { AutonomyTickPack } from '../autonomyScheduler';
import { gateLegacyAutonomyPacks, reserveLegacyRoundCall, settleLegacyRoundCall } from './legacyGate';
import { ensureAutonomyLifeSchema, resetAutonomyLifeSchemaCacheForTesting, type LifeDb } from './store';

const NOW = Date.parse('2026-10-24T04:00:00.000Z');
const USER = 'user-legacy';
const CHAR = 'char-legacy';
const WINDOW = 'w:2026-10-24';

let sql: TestSqlite;
let db: LifeDb;

beforeEach(async () => {
  sql = openTestSqlite();
  db = createSqliteD1(sql) as unknown as LifeDb;
  resetAutonomyLifeSchemaCacheForTesting();
  await ensureAutonomyLifeSchema(db);
});

const pack = (): AutonomyTickPack => ({
  userId: USER,
  charId: CHAR,
  charName: '小夏',
  pack: {
    template: '你叫小夏',
    // 旧配置里确实开了「自主回合」，频率/额度都在这一份里。
    autonomy: { enabled: true, dailyLimit: 6, activeLevel: 'normal' },
  } as never,
  sharedGuardrails: { paused: false, dailyLimit: 6 } as never,
});

async function seedNewBoundary(overrides: Record<string, unknown> = {}) {
  const boundary = normalizeBoundary(
    { enabled: true, globalPaused: false, timezone: 'Asia/Shanghai', allowedKinds: ['interaction.message'], ...overrides },
    { scope: 'account', nowMs: NOW, revision: 1 },
  );
  await db
    .prepare('INSERT OR REPLACE INTO autonomy_life_boundaries (owner_id, scope, char_id, revision, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(USER, 'account', '', boundary.revision, JSON.stringify(boundary), NOW)
    .run();
  return boundary;
}

async function registerCharacter(charPayload: Record<string, unknown> = {}, charId = CHAR) {
  const row = normalizeBoundary(charPayload, { scope: 'character', nowMs: NOW, revision: 0 });
  await db
    .prepare('INSERT OR REPLACE INTO autonomy_life_boundaries (owner_id, scope, char_id, revision, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(USER, 'character', charId, row.revision, JSON.stringify(row), NOW)
    .run();
}

async function seedBudget(usedCalls: number, reservedCalls = 0) {
  for (const scope of ['account', CHAR]) {
    await db
      .prepare(`INSERT OR REPLACE INTO autonomy_life_budget
        (owner_id, window_id, scope, used_calls, reserved_calls, used_tokens, reserved_tokens, notifications, kind_counts, spend_minor, revision, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, 0, 0, '{}', 0, 1, ?)`)
      .bind(USER, WINDOW, scope, usedCalls, reservedCalls, NOW)
      .run();
  }
}

/** 旧配置：client_state 里那行 AIRP 护栏（未暂停、日限 6）。 */
async function seedLegacyClientState() {
  await db
    .prepare('INSERT OR REPLACE INTO client_state (user_id, namespace, key, value, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(USER, 'amsg:global', 'autonomy_guardrails', JSON.stringify({ paused: false, dailyLimit: 6 }), NOW)
    .run();
}

describe('旧自动回合：存量配置不能绕过新边界', () => {
  it('只有旧配置（fire_pack + client_state 护栏）→ 不跑（account_disabled）', async () => {
    await seedLegacyClientState();
    const result = await gateLegacyAutonomyPacks({ db, packs: [pack()], nowMs: NOW });
    expect(result.allowed).toEqual([]);
    expect(result.skipped).toEqual([{ userId: USER, charId: CHAR, reason: 'account_disabled' }]);
  });

  it('开了账号边界但角色没登记 → character_not_registered', async () => {
    await seedLegacyClientState();
    await seedNewBoundary();
    const result = await gateLegacyAutonomyPacks({ db, packs: [pack()], nowMs: NOW });
    expect(result.skipped).toEqual([{ userId: USER, charId: CHAR, reason: 'character_not_registered' }]);
  });

  it('边界开、角色登记、kind 允许、预算有余 → 放行', async () => {
    await seedLegacyClientState();
    await seedNewBoundary();
    await registerCharacter();
    await seedBudget(1);
    const result = await gateLegacyAutonomyPacks({ db, packs: [pack()], nowMs: NOW });
    expect(result.skipped).toEqual([]);
    expect(result.allowed.map((item) => item.charId)).toEqual([CHAR]);
  });

  it('总暂停 / 关角色 / allowedKinds 不含消息 → 分别跳过', async () => {
    await seedNewBoundary({ globalPaused: true });
    await registerCharacter();
    expect((await gateLegacyAutonomyPacks({ db, packs: [pack()], nowMs: NOW })).skipped[0].reason).toBe('paused');

    await seedNewBoundary({ charEnabled: false });
    expect((await gateLegacyAutonomyPacks({ db, packs: [pack()], nowMs: NOW })).skipped[0].reason).toBe('char_disabled');

    await seedNewBoundary({ allowedKinds: ['journal.write'] });
    expect((await gateLegacyAutonomyPacks({ db, packs: [pack()], nowMs: NOW })).skipped[0].reason).toBe('kind_not_allowed');
  });

  it('用户新增禁区 / 回避话题 → forbidden_topic（旧回合正文无法预先验证，fail closed）', async () => {
    await seedNewBoundary({ forbiddenCategories: ['politics'] });
    await registerCharacter();
    expect((await gateLegacyAutonomyPacks({ db, packs: [pack()], nowMs: NOW })).skipped[0].reason).toBe('forbidden_topic');

    await seedNewBoundary({ avoidTopics: ['前任'] });
    expect((await gateLegacyAutonomyPacks({ db, packs: [pack()], nowMs: NOW })).skipped[0].reason).toBe('forbidden_topic');
  });

  it('预算 used+reserved 到上限 → budget_exhausted（账号层与角色层都算）', async () => {
    await seedNewBoundary();
    await registerCharacter();
    await seedBudget(5, 1); // 账号上限 6
    expect((await gateLegacyAutonomyPacks({ db, packs: [pack()], nowMs: NOW })).skipped[0].reason).toBe('budget_exhausted');
  });

  it('「重启」之后结果一致：rerun gate 不因为进程状态而放行', async () => {
    await seedLegacyClientState();
    const first = await gateLegacyAutonomyPacks({ db, packs: [pack()], nowMs: NOW });
    // 新进程（重新读库）再判一次：结果必须一样。
    resetAutonomyLifeSchemaCacheForTesting();
    const second = await gateLegacyAutonomyPacks({ db, packs: [pack()], nowMs: NOW });
    expect(second).toEqual(first);
    expect(second.allowed).toEqual([]);
  });
});

/**
 * 真正的执行期硬门：`reserveLegacyRoundCall` / `settleLegacyRoundCall`。
 *
 * 这组用例跑真 SQLite：建任务→排队→到点这一跳的「原子预留 → 结算」，以及排队之后
 * 暂停/撤权/禁区变更与进程重启都必须是零模型调用、零业务写入。
 */
describe('旧自动回合：执行期统一边界 + 原子预算（真 SQLite）', () => {
  const limitsWithAccountCalls = (accountCalls: number) => ({
    accountModelCallsPerDay: accountCalls,
    charModelCallsPerDay: 5,
    accountTokensPerDay: 10_000,
    charTokensPerDay: 4_000,
  });

  const readBudget = async (charId: string) => {
    const rows = await db
      .prepare('SELECT scope, used_calls, reserved_calls, used_tokens FROM autonomy_life_budget WHERE owner_id = ? AND window_id = ?')
      .bind(USER, WINDOW)
      .all();
    return (rows.results ?? []).filter((row) => row.scope === 'account' || row.scope === charId);
  };

  const countReservations = async () => Number(
    (await db.prepare('SELECT COUNT(*) AS n FROM autonomy_life_budget_reservations WHERE owner_id = ?').bind(USER).first())?.n ?? 0,
  );

  it('同账号多角色只剩一次额度 → 最多一个角色拿到预许可（原子预留，不是只读筛包）', async () => {
    await seedNewBoundary({ limits: limitsWithAccountCalls(1) });
    await registerCharacter({}, 'char-a');
    await registerCharacter({}, 'char-b');

    const first = await reserveLegacyRoundCall({ db, ownerId: USER, charId: 'char-a', nowMs: NOW });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(parseReservationId(first.permit.reservationId)).not.toBeNull();
      expect(await countReservations()).toBe(1);
    }

    const second = await reserveLegacyRoundCall({ db, ownerId: USER, charId: 'char-b', nowMs: NOW });
    expect(second).toMatchObject({ ok: false, reason: 'budget_exhausted' });
    // 被拒的角色没有留下预留记录，也没有把额度占上（账号行是 char-a 的那条）。
    expect(await countReservations()).toBe(1);
    const bRows = (await readBudget('char-b')).filter((row) => row.scope === 'char-b');
    expect(bRows).toEqual([]);
  });

  it('旧路径调用之后新预算增加（结算把消费记进统一账本）', async () => {
    await seedNewBoundary();
    await registerCharacter();
    const reserved = await reserveLegacyRoundCall({ db, ownerId: USER, charId: CHAR, nowMs: NOW });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    // 预留是「在途」，还没算已用。
    let rows = await readBudget(CHAR);
    expect(rows.map((row) => row.used_calls)).toEqual([0, 0]);
    expect(rows.map((row) => row.reserved_calls)).toEqual([1, 1]);

    const settled = await settleLegacyRoundCall({
      db,
      permit: reserved.permit,
      actualTokens: 120,
      requestStarted: true,
    });
    expect(settled).toBe(true);

    rows = await readBudget(CHAR);
    for (const row of rows) {
      expect(row.used_calls).toBe(1);
      expect(row.reserved_calls).toBe(0);
      expect(row.used_tokens).toBe(120);
    }
    const record = await db
      .prepare('SELECT state, settled_at FROM autonomy_life_budget_reservations WHERE owner_id = ? AND reservation_id = ?')
      .bind(USER, reserved.permit.reservationId)
      .first();
    expect(record?.state).toBe('settled');
    expect(Number(record?.settled_at)).toBeGreaterThan(0);
  });

  it('排队之后暂停 / 关角色 / 新增禁区（含重启）→ 零模型调用、零业务写入', async () => {
    const scenarios: Array<{ name: string; overrides: () => Promise<void>; reason: string }> = [
      { name: '总暂停', overrides: async () => { await seedNewBoundary({ globalPaused: true }); }, reason: 'paused' },
      { name: '关角色', overrides: async () => { await seedNewBoundary({ charEnabled: false }); }, reason: 'char_disabled' },
      { name: '新增禁区', overrides: async () => { await seedNewBoundary({ avoidTopics: ['前任'] }); }, reason: 'forbidden_topic' },
      { name: '撤掉消息 kind 授权', overrides: async () => { await seedNewBoundary({ allowedKinds: ['journal.write'] }); }, reason: 'kind_not_allowed' },
    ];
    for (const scenario of scenarios) {
      await seedNewBoundary();
      await registerCharacter();
      await scenario.overrides();
      // 进程「重启」：换一个干净的适配器 + 清 schema 缓存，闸不能靠内存状态。
      db = createSqliteD1(sql) as unknown as LifeDb;
      resetAutonomyLifeSchemaCacheForTesting();
      await ensureAutonomyLifeSchema(db);

      const result = await reserveLegacyRoundCall({ db, ownerId: USER, charId: CHAR, nowMs: NOW });
      expect(result, scenario.name).toMatchObject({ ok: false, reason: scenario.reason });
      expect(await countReservations(), scenario.name).toBe(0);
      expect(await readBudget(CHAR), scenario.name).toEqual([]);
      // 业务表：没有任何经历/愿望被写（零业务效果）。
      const experiences = await db
        .prepare('SELECT COUNT(*) AS n FROM autonomy_experiences WHERE char_id = ?')
        .bind(CHAR)
        .first()
        .catch(() => ({ n: 0 }));
      expect(Number(experiences?.n ?? 0), scenario.name).toBe(0);
    }
  });

  it('预留与边界复核之间有暂停写入 → 释放这次预留（零消费）', async () => {
    await seedNewBoundary();
    await registerCharacter();
    let injected = false;
    db = createSqliteD1(sql, {
      beforeStatement: (text) => {
        // 预留记录刚落库、第二次读边界之前，另一台设备按了总暂停。
        if (!injected && text.includes('INSERT OR IGNORE INTO autonomy_life_budget_reservations')) {
          injected = true;
          sql.prepare("UPDATE autonomy_life_boundaries SET revision = revision + 1, payload = json_set(payload, '$.globalPaused', json('true')) WHERE owner_id = ? AND scope = 'account' AND char_id = ''")
            .run(USER);
        }
      },
    }) as unknown as LifeDb;
    resetAutonomyLifeSchemaCacheForTesting();
    await ensureAutonomyLifeSchema(db);

    const result = await reserveLegacyRoundCall({ db, ownerId: USER, charId: CHAR, nowMs: NOW });
    expect(injected).toBe(true);
    expect(result).toMatchObject({ ok: false });
    const rows = await readBudget(CHAR);
    for (const row of rows) {
      expect(row.used_calls).toBe(0);
      expect(row.reserved_calls).toBe(0);
    }
    const records = await db
      .prepare('SELECT state FROM autonomy_life_budget_reservations WHERE owner_id = ?')
      .bind(USER)
      .all();
    // 预留下就被释放：记录存在但状态是 released（额度已还回去）。
    expect((records.results ?? []).map((row) => row.state)).toEqual(['released']);
  });
});
