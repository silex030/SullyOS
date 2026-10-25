/**
 * 出行链路（`travel/tick.ts` 的 cron 探针）纳入统一边界 + 统一预算 —— 真 SQLite 集成测试。
 *
 * 钉住三件事：
 *   1. 新边界或旧出行授权任一边不允许 → **零模型请求、零新增愿望**（不是跑完再丢）；
 *   2. wiring 建好之后边界才变严（tick 中途按下暂停）→ 每次模型调用前的闸仍然拦住；
 *   3. 允许时模型调用**进统一预算**（used_calls + 真实 token），愿望落一条。
 *
 * 用真 SQLite（node:sqlite）+ 真 tick + 真闸函数，不用假库。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { TRAVEL_SCHEMA_SQL } from '../../../../contracts/travel';
import { normalizeBoundary } from '../../../../utils/autonomyLife/boundary';
import { createSqliteD1, openTestSqlite, type TestSqlite } from '../test/d1-sqlite';
import {
  createD1LifeStore,
  ensureAutonomyLifeSchema,
  resetAutonomyLifeSchemaCacheForTesting,
  type LifeDb,
} from '../autonomyLife/store';
import { handleAutonomyLifeRequest, resolveOwnerFromSharedToken } from '../autonomyLife/routes';
import { emptyCharacterLife } from '../../../../utils/autonomyLife/engine';
import { gateTravelDecisionPort, travelModelAccess } from '../autonomyLife/travelGate';
import { ensureTravelBudgetRow, setTravelBudgetPaused } from './budget';
import {
  ensureTravelSchema,
  resetTravelSchemaCacheForTesting,
  setTravelCharEnabled,
  upsertTravelSettings,
  type TravelDb,
} from './store';
import { runTravelTickForSubject } from './tick';

const NOW = Date.parse('2026-10-24T04:00:00.000Z');
const USER = 'user-travel-gate';
const CHAR = 'char-travel-gate';
const WINDOW = 'w:2026-10-24';

const subject = { userId: USER, charId: CHAR };
const anchor = {
  label: '阳光花园',
  city: '杭州',
  lat: 30.1,
  lng: 120.1,
  coordSys: 'gcj02' as const,
  precision: 'area' as const,
  confirmedAt: NOW - 86_400_000,
  source: 'user' as const,
};

let sql: TestSqlite;
let db: TravelDb;
let lifeDb: LifeDb;

beforeEach(async () => {
  sql = openTestSqlite();
  resetTravelSchemaCacheForTesting();
  resetAutonomyLifeSchemaCacheForTesting();
  db = createSqliteD1(sql) as unknown as TravelDb;
  await ensureTravelSchema(db);
  if (!sql.prepare("SELECT name FROM sqlite_master WHERE name = 'travel_budget_state'").get()) {
    sql.exec(TRAVEL_SCHEMA_SQL);
  }
  lifeDb = createSqliteD1(sql) as unknown as LifeDb;
  await ensureAutonomyLifeSchema(lifeDb);
  for (const table of [
    'autonomy_life_boundaries',
    'autonomy_life_budget',
    'autonomy_life_budget_reservations',
    'autonomy_life_round_claims',
    'travel_wishes',
  ]) {
    await lifeDb.prepare(`DELETE FROM ${table}`).run().catch(() => undefined);
  }
});

/** 一条可用的 amap 外部授权（`travel.wish` 的硬前置，与 `/external/*` 同口径）。 */
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

/**
 * 新边界（账号 + 角色两行）。默认允许 interaction.message + travel.wish，
 * 并带一条未过期的 amap 授权——`allowedKinds` 只表示「能力允许」，真正的对外授权是 grant。
 */
async function seedNewBoundary(overrides: Record<string, unknown> = {}) {
  const account = normalizeBoundary(
    {
      enabled: true,
      globalPaused: false,
      timezone: 'Asia/Shanghai',
      allowedKinds: ['interaction.message', 'travel.wish'],
      externalGrants: [amapGrant()],
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
  await lifeDb
    .prepare('INSERT OR REPLACE INTO autonomy_life_boundaries (owner_id, scope, char_id, revision, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(USER, 'account', '', account.revision, JSON.stringify(account), NOW)
    .run();
  const character = normalizeBoundary({}, { scope: 'character', nowMs: NOW, revision: 0 });
  await lifeDb
    .prepare('INSERT OR REPLACE INTO autonomy_life_boundaries (owner_id, scope, char_id, revision, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(USER, 'character', CHAR, character.revision, JSON.stringify(character), NOW)
    .run();
}

/** 旧出行授权：账号开关 + 角色开关 + 地图预算行。 */
async function seedTravelAuthorization(opts: { enabled?: boolean; mapCallsLimit?: number } = {}) {
  await upsertTravelSettings(db, {
    userId: USER,
    nowMs: NOW,
    baseVersion: null,
    enabled: opts.enabled ?? true,
  });
  await setTravelCharEnabled(db, { userId: USER, charId: CHAR, enabled: true, nowMs: NOW });
  await ensureTravelBudgetRow(db, { userId: USER, mapCallsLimit: opts.mapCallsLimit ?? 10, nowMs: NOW });
}

/**
 * 按 `index.ts` 的 buildTravelSubjectWiring 口径装接线：访问检查不过就**不装**
 * decisionPort（tick 里所有模型分支都靠它）。
 */
function buildWiring(counter: { calls: number }, access: { ok: boolean }) {
  const rawPort = access.ok
    ? {
      async choose() {
        counter.calls += 1;
        return { kind: 'wait' };
      },
      async proposeIntent() {
        counter.calls += 1;
        return { want: 'wander', wish: '想去公园走走' };
      },
      lastUsageTokens: () => 321,
    }
    : null;
  const decisionPort = access.ok
    ? gateTravelDecisionPort(rawPort, { db: lifeDb, ownerId: USER, charId: CHAR, now: () => NOW })
    : null;
  return {
    now: () => NOW,
    providers: [],
    region: 'CN' as const,
    readAnchor: async () => anchor,
    decisionPort,
    intentWindowMs: 3 * 60 * 60 * 1000,
  };
}

const countWishes = async (): Promise<number> => Number(
  (await lifeDb.prepare('SELECT COUNT(*) AS n FROM travel_wishes').first())?.n ?? 0,
);

const budgetRows = async () => {
  const rows = await lifeDb
    .prepare('SELECT scope, used_calls, reserved_calls, used_tokens, reserved_tokens FROM autonomy_life_budget WHERE owner_id = ? AND window_id = ?')
    .bind(USER, WINDOW)
    .all();
  return rows.results ?? [];
};

/** 角色层 `travel.wish` 的 per-kind 计数（一条真实愿望只该占 1 格）。 */
const kindCount = async (): Promise<number> => {
  const row = await lifeDb
    .prepare('SELECT kind_counts FROM autonomy_life_budget WHERE owner_id = ? AND window_id = ? AND scope = ?')
    .bind(USER, WINDOW, CHAR)
    .first();
  return Number(JSON.parse(String(row?.kind_counts ?? '{}'))['travel.wish'] ?? 0);
};

/** 授权窗口的当日已用（`/external/*` 与效果核销共用这张表）。 */
const externalUsed = async (dayKey = '2026-10-24'): Promise<number> => Number(
  (await lifeDb
    .prepare('SELECT used FROM autonomy_life_external_usage WHERE owner_id = ? AND day_key = ? AND provider = ?')
    .bind(USER, dayKey, 'amap')
    .first())?.used ?? 0,
);

describe('出行 cron 探针：统一边界 + 统一预算（真 SQLite）', () => {
  const denials: Array<{ name: string; seed: () => Promise<void> }> = [
    {
      name: '新账号总暂停',
      seed: async () => {
        await seedNewBoundary({ globalPaused: true });
        await seedTravelAuthorization();
      },
    },
    {
      name: '新边界关掉角色',
      seed: async () => {
        await seedNewBoundary({ charEnabled: false });
        await seedTravelAuthorization();
      },
    },
    {
      name: '新边界不允许 travel.wish',
      seed: async () => {
        await seedNewBoundary({ allowedKinds: ['interaction.message'] });
        await seedTravelAuthorization();
      },
    },
    {
      name: '新边界新增禁区（模型输出无法预先验证，fail closed）',
      seed: async () => {
        await seedNewBoundary({ avoidTopics: ['前任'] });
        await seedTravelAuthorization();
      },
    },
    {
      name: '没有新边界行（存量旧配置）',
      seed: async () => {
        await seedTravelAuthorization();
      },
    },
    {
      name: '旧出行授权被撤（出行开关关掉）',
      seed: async () => {
        await seedNewBoundary();
        await seedTravelAuthorization({ enabled: false });
      },
    },
    {
      name: '旧地图预算被暂停',
      seed: async () => {
        await seedNewBoundary();
        await seedTravelAuthorization();
        await setTravelBudgetPaused(db, { userId: USER, paused: true, nowMs: NOW });
      },
    },
    {
      // allowedKinds 里有 travel.wish、旧出行开关也开着，但用户没给（或撤掉了）amap 授权。
      name: '没有 amap 外部授权（allowedKinds 与旧出行设置都开着）',
      seed: async () => {
        await seedNewBoundary({ externalGrants: [] });
        await seedTravelAuthorization();
      },
    },
  ];

  for (const scenario of denials) {
    it(`${scenario.name} → 零模型请求、零新增愿望`, async () => {
      await scenario.seed();
      const counter = { calls: 0 };
      const access = await travelModelAccess({
        db: lifeDb, travelDb: db, ownerId: USER, charId: CHAR, nowMs: NOW,
      });
      expect(access.ok, scenario.name).toBe(false);

      const outcome = await runTravelTickForSubject(db, subject, buildWiring(counter, access));
      expect(counter.calls, scenario.name).toBe(0);
      expect(await countWishes(), scenario.name).toBe(0);
      expect(outcome.skipped.length, scenario.name).toBeGreaterThan(0);
    });
  }

  it('新模型额度为 0 → tick 走到调用前被预算拒（零模型请求、零愿望）', async () => {
    await seedNewBoundary({ limits: { accountModelCallsPerDay: 0, charModelCallsPerDay: 5 } });
    await seedTravelAuthorization();
    const counter = { calls: 0 };
    const access = await travelModelAccess({ db: lifeDb, travelDb: db, ownerId: USER, charId: CHAR, nowMs: NOW });
    expect(access.ok).toBe(true); // 边界本身允许，是额度问题

    await runTravelTickForSubject(db, subject, buildWiring(counter, access));
    expect(counter.calls).toBe(0);
    expect(await countWishes()).toBe(0);
    expect(await budgetRows()).toEqual([]);
  });

  it('wiring 建好之后用户按下总暂停 → 调用前的闸仍然拦住（零模型请求、零愿望）', async () => {
    await seedNewBoundary();
    await seedTravelAuthorization();
    const counter = { calls: 0 };
    const access = await travelModelAccess({ db: lifeDb, travelDb: db, ownerId: USER, charId: CHAR, nowMs: NOW });
    expect(access.ok).toBe(true);
    const wiring = buildWiring(counter, access);

    // tick 还没跑到模型那一步，边界已经变严（另一台设备按下总暂停）。
    await seedNewBoundary({ globalPaused: true });

    const outcome = await runTravelTickForSubject(db, subject, wiring);
    expect(counter.calls).toBe(0);
    expect(await countWishes()).toBe(0);
    expect(outcome.skipped).toContain('llm_unavailable');
  });

  it('amap 授权在排队后到期（执行时钟越过 expiresAt）→ 零模型请求、零愿望', async () => {
    // 排队时还在有效期里（NOW + 1s），tick 执行时已经过期。
    await seedNewBoundary({ externalGrants: [amapGrant({ expiresAt: NOW + 1000 })] });
    await seedTravelAuthorization();
    const counter = { calls: 0 };
    const access = await travelModelAccess({
      db: lifeDb, travelDb: db, ownerId: USER, charId: CHAR, nowMs: NOW + 60_000,
    });
    expect(access).toMatchObject({ ok: false, reason: 'grant_missing' });

    const outcome = await runTravelTickForSubject(db, subject, {
      ...buildWiring(counter, access),
      now: () => NOW + 60_000,
    });
    expect(counter.calls).toBe(0);
    expect(await countWishes()).toBe(0);
    expect(outcome.skipped.length).toBeGreaterThan(0);
  });

  it('授权窗口额度为 0 / 已耗尽 → 连模型都不问（零模型请求、零愿望、零预算行）', async () => {
    for (const scenario of [
      { name: '额度为 0', grant: amapGrant({ dailyQuota: 0 }), seedUsed: 0 },
      { name: '额度耗尽', grant: amapGrant({ dailyQuota: 2 }), seedUsed: 2 },
    ]) {
      await seedNewBoundary({ externalGrants: [scenario.grant] });
      await seedTravelAuthorization();
      if (scenario.seedUsed > 0) {
        await lifeDb
          .prepare('INSERT OR REPLACE INTO autonomy_life_external_usage (owner_id, day_key, provider, used, updated_at) VALUES (?, ?, ?, ?, ?)')
          .bind(USER, '2026-10-24', 'amap', scenario.seedUsed, NOW)
          .run();
      }
      const counter = { calls: 0 };
      const access = await travelModelAccess({ db: lifeDb, travelDb: db, ownerId: USER, charId: CHAR, nowMs: NOW });
      expect(access, scenario.name).toMatchObject({ ok: false, reason: 'external_quota_exhausted' });

      const outcome = await runTravelTickForSubject(db, subject, buildWiring(counter, access));
      expect(counter.calls, scenario.name).toBe(0);
      expect(await countWishes(), scenario.name).toBe(0);
      expect(await budgetRows(), scenario.name).toEqual([]);
      expect(outcome.skipped.length, scenario.name).toBeGreaterThan(0);
    }
  });

  it('模型返回那一刻按下总暂停 → 零愿望（模型调用照常记账）', async () => {
    await seedNewBoundary();
    await seedTravelAuthorization();
    const counter = { calls: 0 };
    const access = await travelModelAccess({ db: lifeDb, travelDb: db, ownerId: USER, charId: CHAR, nowMs: NOW });
    expect(access.ok).toBe(true);

    // 端口在**请求已经发出之后**、返回之前把用户按下的总暂停写进库（另一台设备）。
    const rawPort = {
      async choose() { counter.calls += 1; return { kind: 'wait' }; },
      async proposeIntent() {
        counter.calls += 1;
        await lifeDb
          .prepare(`UPDATE autonomy_life_boundaries
              SET revision = revision + 1, payload = json_set(payload, '$.globalPaused', json('true'))
              WHERE owner_id = ? AND scope = 'account' AND char_id = ''`)
          .bind(USER)
          .run();
        return { want: 'wander', wish: '想去公园走走' };
      },
      lastUsageTokens: () => 111,
    };
    const decisionPort = gateTravelDecisionPort(rawPort, {
      db: lifeDb, ownerId: USER, charId: CHAR, now: () => NOW,
    });
    const wiring = {
      now: () => NOW,
      providers: [],
      region: 'CN' as const,
      readAnchor: async () => anchor,
      decisionPort,
      intentWindowMs: 3 * 60 * 60 * 1000,
    };

    const outcome = await runTravelTickForSubject(db, subject, wiring);
    expect(counter.calls).toBe(1);
    expect(await countWishes()).toBe(0);
    expect(outcome.skipped).toContain('llm_unavailable');
    const rows = await budgetRows();
    const account = rows.find((row) => row.scope === 'account');
    expect(Number(account?.used_calls)).toBe(1);
    expect(Number(account?.reserved_calls)).toBe(0);
  });

  it('模型返回那一刻关掉角色 / 新增禁区 → 零愿望（同一效果门）', async () => {
    const scenarios: Array<{ name: string; mutate: () => Promise<void> }> = [
      {
        name: '关角色',
        mutate: async () => {
          await lifeDb
            .prepare(`UPDATE autonomy_life_boundaries
                SET revision = revision + 1, payload = json_set(payload, '$.charEnabled', json('false'))
                WHERE owner_id = ? AND scope = 'character' AND char_id = ?`)
            .bind(USER, CHAR)
            .run();
        },
      },
      {
        name: '新增禁区',
        mutate: async () => {
          await lifeDb
            .prepare(`UPDATE autonomy_life_boundaries
                SET revision = revision + 1, payload = json_set(payload, '$.avoidTopics', json('[\"前任\"]'))
                WHERE owner_id = ? AND scope = 'account' AND char_id = ''`)
            .bind(USER)
            .run();
        },
      },
    ];

    for (const scenario of scenarios) {
      await seedNewBoundary();
      await seedTravelAuthorization();
      await lifeDb.prepare('DELETE FROM travel_wishes').run().catch(() => undefined);
      await lifeDb.prepare('DELETE FROM autonomy_life_budget').run().catch(() => undefined);
      await lifeDb.prepare('DELETE FROM autonomy_life_budget_reservations').run().catch(() => undefined);
      const counter = { calls: 0 };
      const rawPort = {
        async choose() { return { kind: 'wait' }; },
        async proposeIntent() {
          counter.calls += 1;
          await scenario.mutate();
          return { want: 'wander', wish: '想去公园走走' };
        },
        lastUsageTokens: () => 77,
      };
      const decisionPort = gateTravelDecisionPort(rawPort, {
        db: lifeDb, ownerId: USER, charId: CHAR, now: () => NOW,
      });
      const outcome = await runTravelTickForSubject(db, subject, {
        now: () => NOW,
        providers: [],
        region: 'CN' as const,
        readAnchor: async () => anchor,
        decisionPort,
        intentWindowMs: 3 * 60 * 60 * 1000,
      });
      expect(counter.calls, scenario.name).toBe(1);
      expect(await countWishes(), scenario.name).toBe(0);
      expect(outcome.skipped, scenario.name).toContain('llm_unavailable');
    }
  });

  it('模型返回那一刻撤掉 amap 授权 → 零愿望', async () => {
    await seedNewBoundary();
    await seedTravelAuthorization();
    const counter = { calls: 0 };
    const access = await travelModelAccess({ db: lifeDb, travelDb: db, ownerId: USER, charId: CHAR, nowMs: NOW });
    expect(access.ok).toBe(true);

    const rawPort = {
      async choose() { return { kind: 'wait' }; },
      async proposeIntent() {
        counter.calls += 1;
        await lifeDb
          .prepare(`UPDATE autonomy_life_boundaries
              SET revision = revision + 1, payload = json_remove(payload, '$.externalGrants')
              WHERE owner_id = ? AND scope = 'account' AND char_id = ''`)
          .bind(USER)
          .run();
        return { want: 'wander', wish: '想去公园走走' };
      },
      lastUsageTokens: () => 90,
    };
    const decisionPort = gateTravelDecisionPort(rawPort, {
      db: lifeDb, ownerId: USER, charId: CHAR, now: () => NOW,
    });

    await runTravelTickForSubject(db, subject, {
      now: () => NOW,
      providers: [],
      region: 'CN' as const,
      readAnchor: async () => anchor,
      decisionPort,
      intentWindowMs: 3 * 60 * 60 * 1000,
    });
    expect(counter.calls).toBe(1);
    expect(await countWishes()).toBe(0);
  });

  it('模型回来后结算失败（存储异常）→ fail closed：零愿望', async () => {
    await seedNewBoundary();
    await seedTravelAuthorization();
    let broken = false;
    const failingDb = createSqliteD1(sql, {
      beforeStatement: (text) => {
        if (text.includes('SET used_calls = ?')) {
          broken = true;
          throw new Error('d1 write exploded');
        }
      },
    }) as unknown as LifeDb;
    resetAutonomyLifeSchemaCacheForTesting();
    await ensureAutonomyLifeSchema(failingDb);
    const counter = { calls: 0 };
    const decisionPort = gateTravelDecisionPort(
      {
        async choose() { return { kind: 'wait' }; },
        async proposeIntent() { counter.calls += 1; return { want: 'wander', wish: '想去公园走走' }; },
        lastUsageTokens: () => 50,
      },
      { db: failingDb, ownerId: USER, charId: CHAR, now: () => NOW },
    );

    const outcome = await runTravelTickForSubject(db, subject, {
      now: () => NOW,
      providers: [],
      region: 'CN' as const,
      readAnchor: async () => anchor,
      decisionPort,
      intentWindowMs: 3 * 60 * 60 * 1000,
    });
    expect(counter.calls).toBe(1);
    expect(broken).toBe(true);
    expect(await countWishes()).toBe(0);
    expect(outcome.skipped).toContain('llm_unavailable');
    // 凭据不会被释放（请求确实发出去了）：D1 没有跨语句事务，预算行写失败时凭据可能
    // 已被推进到 settled / 仍停在 held，两种都是「不可再用」的保守状态——留给对账，
    // 不是「账记了但没产物」。
    const record = await lifeDb
      .prepare('SELECT state FROM autonomy_life_budget_reservations WHERE owner_id = ?')
      .bind(USER)
      .first();
    expect(['held', 'settled']).toContain(record?.state);
  });

  it('允许时：模型调用进统一预算（used_calls + usage），愿望落一条', async () => {
    await seedNewBoundary();
    await seedTravelAuthorization();
    const counter = { calls: 0 };
    const access = await travelModelAccess({ db: lifeDb, travelDb: db, ownerId: USER, charId: CHAR, nowMs: NOW });
    expect(access.ok).toBe(true);

    const outcome = await runTravelTickForSubject(db, subject, buildWiring(counter, access));
    expect(counter.calls).toBe(1);
    expect(await countWishes()).toBe(1);
    expect(outcome.skipped).not.toContain('llm_unavailable');

    const rows = await budgetRows();
    const account = rows.find((row) => row.scope === 'account');
    const character = rows.find((row) => row.scope === CHAR);
    expect(Number(account?.used_calls)).toBe(1);
    expect(Number(character?.used_calls)).toBe(1);
    // 端口回了 usage（321）→ 结算按真实值记，不按预留上界。
    expect(Number(account?.used_tokens)).toBe(321);
    expect(Number(account?.reserved_calls)).toBe(0);
    expect(Number(account?.reserved_tokens)).toBe(0);
    // 一条真实愿望只占 1 格 per-kind（模型调用不重复计数），授权额度也只扣 1。
    expect(await kindCount()).toBe(1);
    expect(await externalUsed()).toBe(1);
  });

  it('per-kind 额度 1：一条真实愿望只占 1 格；第二条连模型都不问', async () => {
    await seedNewBoundary({ limits: { perKindActionsPerDay: 1 } });
    await seedTravelAuthorization();
    const counter = { calls: 0 };
    const access = await travelModelAccess({ db: lifeDb, travelDb: db, ownerId: USER, charId: CHAR, nowMs: NOW });
    expect(access.ok).toBe(true);

    // 第一跳：真 tick → 一条愿望，模型调用 1 次，kind 计数只 +1。
    const outcome = await runTravelTickForSubject(db, subject, buildWiring(counter, access));
    expect(counter.calls).toBe(1);
    expect(await countWishes()).toBe(1);
    expect(outcome.skipped).not.toContain('llm_unavailable');
    expect(await kindCount()).toBe(1);
    expect(await externalUsed()).toBe(1);

    // 第二次（额度已用完）：端口在**调模型之前**就拒，不再问模型。
    // 注：同一个 tick 窗口里 `claimIntentProbe` 本身也不会再问一次，所以这条用端口直调来盯闸。
    const again = gateTravelDecisionPort(
      {
        async choose() { counter.calls += 1; return { kind: 'wait' }; },
        async proposeIntent() { counter.calls += 1; return { want: 'wander', wish: '又想去公园' }; },
        lastUsageTokens: () => 99,
      },
      { db: lifeDb, ownerId: USER, charId: CHAR, now: () => NOW },
    );
    await expect(again!.proposeIntent!({ homeLabel: null, minutesSinceLastOuting: null }))
      .rejects.toThrow('autonomy-life-gate:budget_exhausted');
    expect(counter.calls).toBe(1);
    expect(await kindCount()).toBe(1);
    expect(await externalUsed()).toBe(1);
  });

  it('模型说「不想出门」（none）/ 端口抛错 → 不占 kind 配额、不落愿望', async () => {
    await seedNewBoundary();
    await seedTravelAuthorization();
    let calls = 0;
    const port = gateTravelDecisionPort(
      {
        async choose() { throw new Error('unused'); },
        async proposeIntent() {
          calls += 1;
          if (calls === 1) return { want: 'none' };
          throw new Error('provider exploded');
        },
        lastUsageTokens: () => 12,
      },
      { db: lifeDb, ownerId: USER, charId: CHAR, now: () => NOW },
    );

    await expect(port!.proposeIntent!({ homeLabel: null, minutesSinceLastOuting: null }))
      .resolves.toEqual({ want: 'none' });
    await expect(port!.proposeIntent!({ homeLabel: null, minutesSinceLastOuting: null }))
      .rejects.toThrow('provider exploded');

    expect(calls).toBe(2);
    expect(await kindCount()).toBe(0);
    expect(await externalUsed()).toBe(0);
    expect(await countWishes()).toBe(0);
  });

  it('预留凭据跨过 6h TTL 才返回（只推进执行时钟）→ 结算被拒、零愿望', async () => {
    await seedNewBoundary();
    await seedTravelAuthorization();
    let clock = NOW;
    const counter = { calls: 0 };
    const decisionPort = gateTravelDecisionPort(
      {
        async choose() { return { kind: 'wait' }; },
        async proposeIntent() {
          counter.calls += 1;
          // 模型「跑」了 7 小时才回来：state/expires_at 一个字节都不改，只推进执行时钟。
          clock = NOW + 7 * 60 * 60 * 1000;
          return { want: 'wander', wish: '想去公园走走' };
        },
        lastUsageTokens: () => 200,
      },
      { db: lifeDb, ownerId: USER, charId: CHAR, now: () => clock },
    );

    const outcome = await runTravelTickForSubject(db, subject, {
      now: () => clock,
      providers: [],
      region: 'CN' as const,
      readAnchor: async () => anchor,
      decisionPort,
      intentWindowMs: 3 * 60 * 60 * 1000,
    });
    expect(counter.calls).toBe(1);
    expect(await countWishes()).toBe(0);
    expect(outcome.skipped).toContain('llm_unavailable');
    // 凭据按真实 TTL 过期：没有被结算成 used，仍是 held（留给对账），额度不重复花。
    const record = await lifeDb
      .prepare('SELECT state, expires_at, created_at FROM autonomy_life_budget_reservations WHERE owner_id = ?')
      .bind(USER)
      .first();
    expect(record?.state).toBe('held');
    expect(Number(record?.created_at)).toBe(NOW);
    expect(Number(record?.expires_at)).toBe(NOW + 6 * 60 * 60 * 1000);
    const rows = await budgetRows();
    expect(Number(rows.find((row) => row.scope === 'account')?.used_calls ?? 0)).toBe(0);
  });

  it('choose / nextSegment：模型返回后跨过 TTL → 拒，签不出一致性效果许可', async () => {
    for (const method of ['choose', 'nextSegment'] as const) {
      await seedNewBoundary();
      let clock = NOW;
      const rawPort = {
        async choose() {
          clock = NOW + 7 * 60 * 60 * 1000;
          return { kind: 'choose', candidateId: 'poi-1' };
        },
        async nextSegment() {
          clock = NOW + 7 * 60 * 60 * 1000;
          return { kind: 'home' };
        },
        lastUsageTokens: () => 42,
      };
      const port = gateTravelDecisionPort(rawPort, {
        db: lifeDb, ownerId: USER, charId: CHAR, now: () => clock,
      });
      const pending = method === 'choose'
        ? port!.choose({} as never)
        : port!.nextSegment!({} as never);
      await expect(pending).rejects.toThrow('autonomy-life-gate:');
      // 没签出任何效果许可；模型调用也没被结算成 used。
      const claims = await lifeDb
        .prepare('SELECT COUNT(*) AS n FROM autonomy_life_effect_claims WHERE owner_id = ?')
        .bind(USER)
        .first();
      expect(Number(claims?.n ?? 0), method).toBe(0);
      const rows = await budgetRows();
      expect(Number(rows.find((row) => row.scope === 'account')?.used_calls ?? 0), method).toBe(0);
    }
  });

  it('期限内 choose / nextSegment → 正常签出一次性效果许可（保留正向路径）', async () => {
    await seedNewBoundary();
    const port = gateTravelDecisionPort(
      {
        async choose() { return { kind: 'choose', candidateId: 'poi-1' }; },
        async nextSegment() { return { kind: 'home' }; },
        lastUsageTokens: () => 33,
      },
      { db: lifeDb, ownerId: USER, charId: CHAR, now: () => NOW },
    );
    await expect(port!.choose({ wishText: '散步', candidates: [], batchIndex: 0, rerollsUsed: 0 }))
      .resolves.toMatchObject({ kind: 'choose' });
    await expect(port!.nextSegment!({} as never)).resolves.toMatchObject({ kind: 'home' });
    const claims = await lifeDb
      .prepare('SELECT COUNT(*) AS n FROM autonomy_life_effect_claims WHERE owner_id = ?')
      .bind(USER)
      .first();
    expect(Number(claims?.n ?? 0)).toBe(2);
  });

  it('kind 核销之后、授权额度核销之前把 amap 额度收紧到 0（同一 revision）→ 零愿望', async () => {
    await seedNewBoundary();
    await seedTravelAuthorization();
    let injected = false;
    // 只改额度、**不** bump revision：证明额度按执行时的 payload 判，不是按读边界时的旧值。
    const hooked = createSqliteD1(sql, {
      beforeStatement: (text) => {
        if (!injected && text.includes('UPDATE autonomy_life_external_usage')) {
          injected = true;
          sql.prepare(`UPDATE autonomy_life_boundaries
              SET payload = json_set(payload, '$.externalGrants[0].dailyQuota', 0)
              WHERE owner_id = ? AND scope = 'account' AND char_id = ''`)
            .run(USER);
        }
      },
    }) as unknown as LifeDb;
    resetAutonomyLifeSchemaCacheForTesting();
    await ensureAutonomyLifeSchema(hooked);

    const counter = { calls: 0 };
    const decisionPort = gateTravelDecisionPort(
      {
        async choose() { return { kind: 'wait' }; },
        async proposeIntent() { counter.calls += 1; return { want: 'wander', wish: '想去公园走走' }; },
        lastUsageTokens: () => 66,
      },
      { db: hooked, ownerId: USER, charId: CHAR, now: () => NOW },
    );
    const outcome = await runTravelTickForSubject(db, subject, {
      now: () => NOW,
      providers: [],
      region: 'CN' as const,
      readAnchor: async () => anchor,
      decisionPort,
      intentWindowMs: 3 * 60 * 60 * 1000,
    });
    expect(injected).toBe(true);
    expect(counter.calls).toBe(1);
    expect(await countWishes()).toBe(0);
    expect(await externalUsed()).toBe(0);
    expect(outcome.skipped).toContain('llm_unavailable');
  });

  it('kind 核销之后、授权额度核销之前撤权 / 暂停 → 零愿望（授权额度不按旧 limit 发放）', async () => {
    for (const scenario of ['revoke', 'pause'] as const) {
      await seedNewBoundary();
      await seedTravelAuthorization();
      let injected = false;
      const hooked = createSqliteD1(sql, {
        beforeStatement: (text) => {
          if (!injected && text.includes('UPDATE autonomy_life_external_usage')) {
            injected = true;
            if (scenario === 'revoke') {
              sql.prepare(`UPDATE autonomy_life_boundaries
                  SET revision = revision + 1, payload = json_remove(payload, '$.externalGrants')
                  WHERE owner_id = ? AND scope = 'account' AND char_id = ''`)
                .run(USER);
            } else {
              sql.prepare(`UPDATE autonomy_life_boundaries
                  SET revision = revision + 1, payload = json_set(payload, '$.globalPaused', json('true'))
                  WHERE owner_id = ? AND scope = 'account' AND char_id = ''`)
                .run(USER);
            }
          }
        },
      }) as unknown as LifeDb;
      resetAutonomyLifeSchemaCacheForTesting();
      await ensureAutonomyLifeSchema(hooked);

      const counter = { calls: 0 };
      const decisionPort = gateTravelDecisionPort(
        {
          async choose() { return { kind: 'wait' }; },
          async proposeIntent() { counter.calls += 1; return { want: 'wander', wish: '想去公园走走' }; },
          lastUsageTokens: () => 55,
        },
        { db: hooked, ownerId: USER, charId: CHAR, now: () => NOW },
      );
      await runTravelTickForSubject(db, subject, {
        now: () => NOW,
        providers: [],
        region: 'CN' as const,
        readAnchor: async () => anchor,
        decisionPort,
        intentWindowMs: 3 * 60 * 60 * 1000,
      });
      expect(injected, scenario).toBe(true);
      expect(counter.calls, scenario).toBe(1);
      expect(await countWishes(), scenario).toBe(0);
      expect(await externalUsed(), scenario).toBe(0);
    }
  });
});


/* ==================================================================== *
 * 真实 POST /pause（真 SQLite + 真路由）：出行链路同样按真实暂停落点拒
 * ==================================================================== *
 *
 * `POST /pause` 只写 `autonomy_life_accounts.paused` /
 * `autonomy_life_characters.payload.pauseRequestedAt`，不动 boundaries。
 * 旧实现只读 boundaries，于是「暂停后 tick 仍调模型」；这里用真路由暂停，
 * 断言模型调用 0、愿望 0、预算行不新增。
 */

const ROUTE_TOKEN = 'shared-token';

const pauseRoute = async (body: Record<string, unknown>): Promise<Response | null> => {
  const env = { DB: lifeDb, AMSG_SERVER_TOKEN: ROUTE_TOKEN } as never;
  const headers = new Headers({
    'Content-Type': 'application/json',
    'X-User-Id': USER,
    'X-Client-Token': ROUTE_TOKEN,
  });
  const request = new Request('https://worker.example/autonomy-life/v1/pause', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return handleAutonomyLifeRequest(request, env, {
    now: () => NOW,
    resolveOwner: (req) => resolveOwnerFromSharedToken(req, env),
    respond: (status, payload) => new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
    hasModelCredentials: async () => true,
    requestId: () => 'req-pause-travel',
  });
};

const boundarySnapshot = async () => (await lifeDb
  .prepare('SELECT scope, char_id, revision, payload FROM autonomy_life_boundaries WHERE owner_id = ? ORDER BY scope, char_id')
  .bind(USER)
  .all()).results ?? [];

describe('出行 cron：真实 POST /pause 之后零模型 / 零愿望（真路由 + 真 SQLite）', () => {
  it('账号暂停（/pause 不改 boundaries）→ 已建好的 wiring 也不再调模型、不落愿望', async () => {
    await seedNewBoundary();
    await seedTravelAuthorization();
    const counter = { calls: 0 };
    const access = await travelModelAccess({ db: lifeDb, travelDb: db, ownerId: USER, charId: CHAR, nowMs: NOW });
    expect(access.ok).toBe(true);
    const wiring = buildWiring(counter, access);
    const before = await boundarySnapshot();

    const res = await pauseRoute({ scope: 'account', paused: true });
    expect(res?.status).toBe(200);
    expect(await boundarySnapshot()).toEqual(before);

    const outcome = await runTravelTickForSubject(db, subject, wiring);
    expect(counter.calls).toBe(0);
    expect(await countWishes()).toBe(0);
    expect(await budgetRows()).toEqual([]);
    expect(outcome.skipped.length).toBeGreaterThan(0);

    // 解除暂停后同一个 wiring 恢复工作（正常控制路径仍然在）。
    const resumed = await pauseRoute({ scope: 'account', paused: false });
    expect(resumed?.status).toBe(200);
    await runTravelTickForSubject(db, subject, wiring);
    expect(counter.calls).toBe(1);
    expect(await countWishes()).toBe(1);
  });

  it('角色暂停（/pause 只写 pauseRequestedAt）→ 已建好的 wiring 零模型、零愿望', async () => {
    await seedNewBoundary();
    await seedTravelAuthorization();
    const store = createD1LifeStore({ db: lifeDb, ownerId: USER, now: () => NOW });
    const life = emptyCharacterLife(CHAR, NOW, 'Asia/Shanghai');
    await store.putCharacterLife(life, life.revision);

    const counter = { calls: 0 };
    const access = await travelModelAccess({ db: lifeDb, travelDb: db, ownerId: USER, charId: CHAR, nowMs: NOW });
    expect(access.ok).toBe(true);
    const wiring = buildWiring(counter, access);
    const before = await boundarySnapshot();

    const res = await pauseRoute({ scope: 'character', charId: CHAR, paused: true });
    expect(res?.status).toBe(200);
    expect(await boundarySnapshot()).toEqual(before);

    const outcome = await runTravelTickForSubject(db, subject, wiring);
    expect(counter.calls).toBe(0);
    expect(await countWishes()).toBe(0);
    expect(outcome.skipped.length).toBeGreaterThan(0);
  });

  it('模型已经发出、返回之前按下真实 /pause → 零愿望（模型调用照常记账）', async () => {
    await seedNewBoundary();
    await seedTravelAuthorization();
    const counter = { calls: 0 };
    const rawPort = {
      async choose() { counter.calls += 1; return { kind: 'wait' }; },
      async proposeIntent() {
        counter.calls += 1;
        // 用户在另一台设备上按下真实暂停按钮（与 UI 同一个端点）。
        const res = await pauseRoute({ scope: 'account', paused: true });
        expect(res?.status).toBe(200);
        return { want: 'wander', wish: '想去公园走走' };
      },
      lastUsageTokens: () => 111,
    };
    const decisionPort = gateTravelDecisionPort(rawPort, {
      db: lifeDb, ownerId: USER, charId: CHAR, now: () => NOW,
    });
    const wiring = {
      now: () => NOW,
      providers: [],
      region: 'CN' as const,
      readAnchor: async () => anchor,
      decisionPort,
      intentWindowMs: 3 * 60 * 60 * 1000,
    };

    const outcome = await runTravelTickForSubject(db, subject, wiring);
    expect(counter.calls).toBe(1);
    expect(await countWishes()).toBe(0);
    expect(outcome.skipped).toContain('llm_unavailable');
    const rows = await budgetRows();
    const account = rows.find((row) => row.scope === 'account');
    expect(Number(account?.used_calls)).toBe(1);
    expect(Number(account?.reserved_calls)).toBe(0);
  });
});
