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
import {
  gateLegacyAutonomyPacks,
  reserveLegacyEffect,
  reserveLegacyNotification,
  reserveLegacyRoundCall,
  settleLegacyRoundCall,
} from './legacyGate';
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

/**
 * 一条可用的 amap 外部授权（`travel.wish` 的硬前置）。
 * 与 `/external/*` 同口径：provider + 只读 scope + 到期时间 + 每日额度。
 */
export const amapGrant = (overrides: Record<string, unknown> = {}) => ({
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


/**
 * 统一配额：旧链路的**提醒**与**效果**类 kind 都必须走新账本。
 *
 * 这组用例跑真 SQLite：通知额度是账号层的（多角色共享同一格），kind 额度是角色层的；
 * 判额与占额在同一个临界区（D1 侧条件 UPDATE），并发下不会超额。
 */
describe('旧链路统一配额：提醒 / kind 效果（真 SQLite）', () => {
  const readBudgetRow = async (scope: string) => db
    .prepare('SELECT notifications, kind_counts, used_calls, reserved_calls FROM autonomy_life_budget WHERE owner_id = ? AND window_id = ? AND scope = ?')
    .bind(USER, WINDOW, scope)
    .first();

  const countBudgetRows = async () => Number(
    (await db.prepare('SELECT COUNT(*) AS n FROM autonomy_life_budget WHERE owner_id = ?').bind(USER).first())?.n ?? 0,
  );

  it('通知上限 = 0 → 拒，且不留下任何预算行/预留记录（只影响提醒）', async () => {
    await seedNewBoundary({ limits: { notificationsPerDay: 0 } });
    await registerCharacter();
    const result = await reserveLegacyNotification({ db, ownerId: USER, charId: CHAR, nowMs: NOW });
    expect(result).toEqual({ ok: false, reason: 'notifications_exhausted' });
    expect(await countBudgetRows()).toBe(0);
    const reservations = await db
      .prepare('SELECT COUNT(*) AS n FROM autonomy_life_budget_reservations WHERE owner_id = ?')
      .bind(USER)
      .first();
    expect(Number(reservations?.n ?? 0)).toBe(0);
  });

  it('通知额度只剩 1 条：同账号两个角色只有一个能占（账号层共享，原子）', async () => {
    await seedNewBoundary({ limits: { notificationsPerDay: 1 } });
    await registerCharacter({}, 'char-a');
    await registerCharacter({}, 'char-b');
    const first = await reserveLegacyNotification({ db, ownerId: USER, charId: 'char-a', nowMs: NOW });
    expect(first).toEqual({ ok: true });
    const row = await readBudgetRow('account');
    expect(Number(row?.notifications)).toBe(1);
    // 第二个角色（另一次调用）拿不到同一格。
    const second = await reserveLegacyNotification({ db, ownerId: USER, charId: 'char-b', nowMs: NOW });
    expect(second).toEqual({ ok: false, reason: 'notifications_exhausted' });
    expect(Number((await readBudgetRow('account'))?.notifications)).toBe(1);
  });

  it('并发抢最后一格通知：只有一次成功', async () => {
    await seedNewBoundary({ limits: { notificationsPerDay: 1 } });
    await registerCharacter({}, 'char-a');
    await registerCharacter({}, 'char-b');
    const results = await Promise.all([
      reserveLegacyNotification({ db, ownerId: USER, charId: 'char-a', nowMs: NOW }),
      reserveLegacyNotification({ db, ownerId: USER, charId: 'char-b', nowMs: NOW }),
    ]);
    expect(results.filter((item) => item.ok)).toHaveLength(1);
    expect(Number((await readBudgetRow('account'))?.notifications)).toBe(1);
  });

  it('travel.wish 未授权 → 效果被拒，kind 计数不动', async () => {
    await seedNewBoundary();
    await registerCharacter();
    const result = await reserveLegacyEffect({ db, ownerId: USER, charId: CHAR, nowMs: NOW, kind: 'travel.wish' });
    expect(result).toEqual({ ok: false, reason: 'kind_not_allowed' });
    expect(await countBudgetRows()).toBe(0);
  });

  it('travel.wish 授权后：占一格 per-kind（额度 1 时第二次被拒）', async () => {
    await seedNewBoundary({
      allowedKinds: ['interaction.message', 'travel.wish'],
      externalGrants: [amapGrant()],
      limits: { perKindActionsPerDay: 1 },
    });
    await registerCharacter();
    const first = await reserveLegacyEffect({ db, ownerId: USER, charId: CHAR, nowMs: NOW, kind: 'travel.wish' });
    expect(first).toEqual({ ok: true });
    const row = await readBudgetRow(CHAR);
    expect(JSON.parse(String(row?.kind_counts ?? '{}'))['travel.wish']).toBe(1);
    const second = await reserveLegacyEffect({ db, ownerId: USER, charId: CHAR, nowMs: NOW, kind: 'travel.wish' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('budget_exhausted');
  });

  it('账号暂停 → 提醒与效果都被拒（连额度都不该占）', async () => {
    await seedNewBoundary({ globalPaused: true, allowedKinds: ['interaction.message', 'travel.wish'] });
    await registerCharacter();
    expect(await reserveLegacyNotification({ db, ownerId: USER, charId: CHAR, nowMs: NOW }))
      .toEqual({ ok: false, reason: 'paused' });
    expect(await reserveLegacyEffect({ db, ownerId: USER, charId: CHAR, nowMs: NOW, kind: 'travel.wish' }))
      .toEqual({ ok: false, reason: 'paused' });
    expect(await countBudgetRows()).toBe(0);
  });
});

/**
 * 外部授权 + 效果核销的**原子条件**（第五轮返工）。
 *
 * 两类漏洞一起钉住：
 *   1. `allowedKinds` 不等于外部授权：`travel.wish` 必须当前有未过期的 amap 授权，
 *      授权窗口的每日额度也必须有余额（与 `/external/wish` 同口径）；
 *   2. 「读完边界再写预算」的竞态：核销语句把账号/角色 revision 与授权放进同一条
 *      WHERE，判完之后用户收紧额度/暂停/撤权 → 0 行、零提醒、零愿望。
 */
describe('旧链路效果：外部授权与核销原子条件（真 SQLite）', () => {
  const countBudgetRows = async () => Number(
    (await db.prepare('SELECT COUNT(*) AS n FROM autonomy_life_budget WHERE owner_id = ?').bind(USER).first())?.n ?? 0,
  );
  const kindCount = async (): Promise<number> => {
    const row = await db
      .prepare("SELECT kind_counts FROM autonomy_life_budget WHERE owner_id = ? AND window_id = ? AND scope = ?")
      .bind(USER, WINDOW, CHAR)
      .first();
    return Number(JSON.parse(String(row?.kind_counts ?? '{}'))['travel.wish'] ?? 0);
  };

  const travelBoundary = (overrides: Record<string, unknown> = {}) => seedNewBoundary({
    allowedKinds: ['interaction.message', 'travel.wish'],
    ...overrides,
  });

  it('缺 amap 授权（allowedKinds 与旧出行设置都开着）→ grant_missing，零写入', async () => {
    await travelBoundary();
    await registerCharacter();
    const result = await reserveLegacyEffect({ db, ownerId: USER, charId: CHAR, nowMs: NOW, kind: 'travel.wish' });
    expect(result).toEqual({ ok: false, reason: 'grant_missing' });
    expect(await countBudgetRows()).toBe(0);
    expect(await kindCount()).toBe(0);
  });

  it('amap 授权已过期（执行时钟越过 expiresAt）→ grant_missing，零写入', async () => {
    await travelBoundary({ externalGrants: [amapGrant({ expiresAt: NOW + 1000 })] });
    await registerCharacter();
    // 排队时还在有效期内（NOW + 1s 之后），执行时已经过期：必须按**当前**时钟判。
    const result = await reserveLegacyEffect({ db, ownerId: USER, charId: CHAR, nowMs: NOW + 60_000, kind: 'travel.wish' });
    expect(result).toEqual({ ok: false, reason: 'grant_missing' });
    expect(await countBudgetRows()).toBe(0);
  });

  it('授权窗口额度为 0 → external_quota_exhausted，零写入', async () => {
    await travelBoundary({ externalGrants: [amapGrant({ dailyQuota: 0 })] });
    await registerCharacter();
    const result = await reserveLegacyEffect({ db, ownerId: USER, charId: CHAR, nowMs: NOW, kind: 'travel.wish' });
    expect(result).toEqual({ ok: false, reason: 'external_quota_exhausted' });
    expect(await countBudgetRows()).toBe(0);
  });

  it('授权窗口当日额度已耗尽 → external_quota_exhausted，零写入', async () => {
    await travelBoundary({ externalGrants: [amapGrant({ dailyQuota: 1 })] });
    await registerCharacter();
    await db
      .prepare('INSERT OR REPLACE INTO autonomy_life_external_usage (owner_id, day_key, provider, used, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(USER, '2026-10-24', 'amap', 1, NOW)
      .run();
    const result = await reserveLegacyEffect({ db, ownerId: USER, charId: CHAR, nowMs: NOW, kind: 'travel.wish' });
    expect(result).toEqual({ ok: false, reason: 'external_quota_exhausted' });
    expect(await countBudgetRows()).toBe(0);
  });

  it('读完边界、核销之前用户把通知额度收紧到 0 并总暂停 → boundary_changed，零提醒、零写入', async () => {
    await seedNewBoundary();
    await registerCharacter();
    let injected = false;
    db = createSqliteD1(sql, {
      beforeStatement: (text) => {
        // 边界读完之后、核销 UPDATE 执行之前：另一台设备收紧额度并按下暂停。
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
    resetAutonomyLifeSchemaCacheForTesting();
    await ensureAutonomyLifeSchema(db);

    const result = await reserveLegacyNotification({ db, ownerId: USER, charId: CHAR, nowMs: NOW });
    expect(injected).toBe(true);
    expect(result).toEqual({ ok: false, reason: 'boundary_changed' });
    expect(await countBudgetRows()).toBe(0);
  });

  it('读完边界、核销之前 amap 授权被撤 → 零愿望、kind 计数不动', async () => {
    await travelBoundary({ externalGrants: [amapGrant()] });
    await registerCharacter();
    let injected = false;
    db = createSqliteD1(sql, {
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
    resetAutonomyLifeSchemaCacheForTesting();
    await ensureAutonomyLifeSchema(db);

    const result = await reserveLegacyEffect({ db, ownerId: USER, charId: CHAR, nowMs: NOW, kind: 'travel.wish' });
    expect(injected).toBe(true);
    expect(result).toEqual({ ok: false, reason: 'boundary_changed' });
    expect(await countBudgetRows()).toBe(0);
    expect(await kindCount()).toBe(0);
  });
});

/**
 * 授权窗口额度的**最终核销**（第六轮返工）：kind 名额核销完 → 授权额度核销前的窗口。
 *
 * 以前这里按「读边界时拿到的 `grant.dailyQuota`」调 `consumeExternalQuota`，语句里既没有
 * 边界 revision 也不看当前授权，所以在这两步之间收紧额度 / 撤权 / 暂停仍会返回成功效果。
 * 现在额度、授权有效期与两层 revision 都在 `consumeExternalQuotaAtomic` 的同一条 WHERE 里。
 */
describe('旧链路效果：授权额度的最终核销必须原子（真 SQLite）', () => {
  const externalUsed = async (): Promise<number> => Number(
    (await db
      .prepare('SELECT used FROM autonomy_life_external_usage WHERE owner_id = ? AND day_key = ? AND provider = ?')
      .bind(USER, '2026-10-24', 'amap')
      .first())?.used ?? 0,
  );
  const kindCount = async (): Promise<number> => {
    const row = await db
      .prepare('SELECT kind_counts FROM autonomy_life_budget WHERE owner_id = ? AND window_id = ? AND scope = ?')
      .bind(USER, WINDOW, CHAR)
      .first();
    return Number(JSON.parse(String(row?.kind_counts ?? '{}'))['travel.wish'] ?? 0);
  };

  const travelBoundary = (overrides: Record<string, unknown> = {}) => seedNewBoundary({
    allowedKinds: ['interaction.message', 'travel.wish'],
    externalGrants: [amapGrant()],
    ...overrides,
  });

  it('正向：一条愿望同时只扣 1 格 kind 与 1 次授权额度', async () => {
    await travelBoundary();
    await registerCharacter();
    const result = await reserveLegacyEffect({ db, ownerId: USER, charId: CHAR, nowMs: NOW, kind: 'travel.wish' });
    expect(result).toEqual({ ok: true });
    expect(await kindCount()).toBe(1);
    expect(await externalUsed()).toBe(1);
  });

  it('kind 核销之后、额度 UPDATE 之前收紧到 0（同 revision）→ 按当前限额拒绝，额度零新增', async () => {
    await travelBoundary();
    await registerCharacter();
    let injected = false;
    db = createSqliteD1(sql, {
      beforeStatement: (text) => {
        if (!injected && text.includes('UPDATE autonomy_life_external_usage')) {
          injected = true;
          // 只改 payload 的额度、不 bump revision：证明不是按读边界时的旧 limit 放行。
          sql.prepare(`UPDATE autonomy_life_boundaries
              SET payload = json_set(payload, '$.externalGrants[0].dailyQuota', 0)
              WHERE owner_id = ? AND scope = 'account' AND char_id = ''`)
            .run(USER);
        }
      },
    }) as unknown as LifeDb;
    resetAutonomyLifeSchemaCacheForTesting();
    await ensureAutonomyLifeSchema(db);

    const result = await reserveLegacyEffect({ db, ownerId: USER, charId: CHAR, nowMs: NOW, kind: 'travel.wish' });
    expect(injected).toBe(true);
    expect(result).toEqual({ ok: false, reason: 'external_quota_exhausted' });
    expect(await externalUsed()).toBe(0);
  });

  it('kind 核销之后、额度 UPDATE 之前撤权 / 暂停 → boundary_changed，额度零新增', async () => {
    for (const scenario of ['revoke', 'pause'] as const) {
      await travelBoundary();
      await registerCharacter();
      let injected = false;
      db = createSqliteD1(sql, {
        beforeStatement: (text) => {
          if (!injected && text.includes('UPDATE autonomy_life_external_usage')) {
            injected = true;
            const payload = scenario === 'revoke'
              ? "json_remove(payload, '$.externalGrants')"
              : "json_set(payload, '$.globalPaused', json('true'))";
            sql.prepare(`UPDATE autonomy_life_boundaries
                SET revision = revision + 1, payload = ${payload}
                WHERE owner_id = ? AND scope = 'account' AND char_id = ''`)
              .run(USER);
          }
        },
      }) as unknown as LifeDb;
      resetAutonomyLifeSchemaCacheForTesting();
      await ensureAutonomyLifeSchema(db);

      const result = await reserveLegacyEffect({ db, ownerId: USER, charId: CHAR, nowMs: NOW, kind: 'travel.wish' });
      expect(result, scenario).toEqual({ ok: false, reason: 'boundary_changed' });
      expect(await externalUsed(), scenario).toBe(0);
    }
  });

  it('授权额度刚好用完时：同一条语句挡住第二次（不超卖）', async () => {
    await travelBoundary({ externalGrants: [amapGrant({ dailyQuota: 1 })] });
    await registerCharacter();
    expect(await reserveLegacyEffect({ db, ownerId: USER, charId: CHAR, nowMs: NOW, kind: 'travel.wish' }))
      .toEqual({ ok: true });
    expect(await reserveLegacyEffect({ db, ownerId: USER, charId: CHAR, nowMs: NOW, kind: 'travel.wish' }))
      .toEqual({ ok: false, reason: 'external_quota_exhausted' });
    expect(await externalUsed()).toBe(1);
    expect(await kindCount()).toBe(1);
  });
});
