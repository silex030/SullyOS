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
  ensureAutonomyLifeSchema,
  resetAutonomyLifeSchemaCacheForTesting,
  type LifeDb,
} from '../autonomyLife/store';
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

/** 新边界（账号 + 角色两行）。默认允许 interaction.message + travel.wish。 */
async function seedNewBoundary(overrides: Record<string, unknown> = {}) {
  const account = normalizeBoundary(
    {
      enabled: true,
      globalPaused: false,
      timezone: 'Asia/Shanghai',
      allowedKinds: ['interaction.message', 'travel.wish'],
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
  });
});
