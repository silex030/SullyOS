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
import type { AutonomyTickPack } from '../autonomyScheduler';
import { gateLegacyAutonomyPacks } from './legacyGate';
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

async function registerCharacter(charPayload: Record<string, unknown> = {}) {
  const row = normalizeBoundary(charPayload, { scope: 'character', nowMs: NOW, revision: 0 });
  await db
    .prepare('INSERT OR REPLACE INTO autonomy_life_boundaries (owner_id, scope, char_id, revision, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(USER, 'character', CHAR, row.revision, JSON.stringify(row), NOW)
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
