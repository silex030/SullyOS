/**
 * B1 预算层的**真表**回归（node:sqlite + 契约 DDL）。
 *
 * 这一层钉住的是「额度不能被绕过」：
 *   1. 账号时区算日键（服务端时间 + `travel_settings.budget_tz`），跨日只清 used，
 *      limit 与 paused 原样保留；
 *   2. 预留是**条件 UPDATE**：并发方抢走最后一个名额，我们必须拿 0 行、绝不超卖；
 *   3. `limit = 0` → `BUDGET_ZERO`，暂停/缺行/读失败 → `BUDGET_BLOCKED`（fail-closed），
 *      任何路径都不许「补一个正数默认值」；
 *   4. LLM token **不在这里另立额度**：一律走注入的既有 autonomy 权威账本端口，
 *      本表的 `llm_tokens_*` 只是镜像（limit=0 也不参与判定）；
 *   5. 多角色共用同一 `user_id` 账本 —— 函数签名里根本没有 charId，行也只有一行。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSqliteD1, openTestSqlite, type TestSqlite } from '../test/d1-sqlite';
import {
  ensureTravelBudgetRow,
  getTravelBudget,
  reserveLlmTokens,
  reserveMapCall,
  resolveTravelBudgetGate,
  resetTravelBudgetCacheForTesting,
  setTravelBudgetPaused,
  setTravelMapCallsLimit,
  settleLlmTokens,
  settleMapCall,
  type TravelLlmLedgerPort,
} from './budget';
import { ensureTravelSchema, resetTravelSchemaCacheForTesting, upsertTravelSettings } from './store';

const NOW = Date.parse('2026-10-23T15:59:00.000Z'); // Asia/Shanghai 23:59
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let sql: TestSqlite;
let db: ReturnType<typeof createSqliteD1>;

const countRows = (where = '', ...params: unknown[]): number => {
  const row = sql.prepare(`SELECT COUNT(*) AS n FROM travel_budget_state ${where}`).get(...(params as never[]));
  return Number((row as { n: number }).n);
};

const rawRow = (userId: string) =>
  sql.prepare('SELECT * FROM travel_budget_state WHERE user_id = ?').get(userId) as
    | Record<string, unknown>
    | undefined;

const seed = async (args: {
  userId?: string;
  tz?: string;
  mapLimit?: number;
  llmLimit?: number;
}) => {
  const userId = args.userId ?? 'u1';
  await upsertTravelSettings(db, {
    userId,
    nowMs: NOW,
    baseVersion: null,
    budgetTz: args.tz ?? 'Asia/Shanghai',
  });
  await ensureTravelBudgetRow(db, {
    userId,
    mapCallsLimit: args.mapLimit ?? 3,
    llmTokensLimit: args.llmLimit ?? 0,
    nowMs: NOW,
  });
};

/** 既有 autonomy 权威账本的替身：真实系统在 B6 接线，这里只验「我们确实把门交给它」。 */
const createLlmPort = (
  initial: { usedTokens: number; limitTokens: number; paused?: boolean } | null = {
    usedTokens: 0,
    limitTokens: 1000,
  },
) => {
  const state = initial ? { ...initial, paused: initial.paused ?? false } : null;
  const reserve = vi.fn<TravelLlmLedgerPort['reserve']>(async ({ tokens }) => {
    if (!state) return { ok: false as const, code: 'BUDGET_BLOCKED' as const };
    if (state.paused) return { ok: false as const, code: 'BUDGET_BLOCKED' as const };
    if (state.limitTokens === 0) return { ok: false as const, code: 'BUDGET_ZERO' as const };
    if (state.usedTokens + tokens > state.limitTokens) {
      return { ok: false as const, code: 'BUDGET_BLOCKED' as const };
    }
    state.usedTokens += tokens;
    return { ok: true as const, reservationId: `res-${state.usedTokens}` };
  });
  const settle = vi.fn<TravelLlmLedgerPort['settle']>(async ({ actualTokens }) => {
    // 真实账本语义：预留按实际用量结算（reserved 200、实际 80 → 当日用量落在 80）。
    if (state) state.usedTokens = Math.max(0, actualTokens);
  });
  const release = vi.fn<TravelLlmLedgerPort['release']>(async () => {});
  const read = vi.fn<TravelLlmLedgerPort['read']>(async () =>
    state ? { usedTokens: state.usedTokens, limitTokens: state.limitTokens, paused: state.paused } : null,
  );
  return { port: { read, reserve, settle, release } as TravelLlmLedgerPort, state, reserve, settle, read, release };
};

beforeEach(async () => {
  resetTravelSchemaCacheForTesting();
  resetTravelBudgetCacheForTesting();
  sql = openTestSqlite();
  db = createSqliteD1(sql);
  await ensureTravelSchema(db);
});

describe('账号时区与跨日', () => {
  it('day_key 由账号时区 + 服务端时间算：同一时刻两个账号可以是两个日键', async () => {
    await seed({ userId: 'u1', tz: 'Asia/Shanghai' });
    await seed({ userId: 'u2', tz: 'America/New_York' });

    const shanghai = await getTravelBudget(db, { userId: 'u1', nowMs: NOW });
    const newYork = await getTravelBudget(db, { userId: 'u2', nowMs: NOW });
    expect(shanghai!.dayKey).toBe('2026-10-23');
    expect(newYork!.dayKey).toBe('2026-10-23'); // 纽约此刻 11:59，同日
    // 再往东推 5 小时：上海已跨日、纽约还没。
    const later = NOW + 5 * 60 * MINUTE;
    expect((await getTravelBudget(db, { userId: 'u1', nowMs: later }))!.dayKey).toBe('2026-10-24');
    expect((await getTravelBudget(db, { userId: 'u2', nowMs: later }))!.dayKey).toBe('2026-10-23');
  });

  it('跨日只清 used/attempts，limit 与 paused 原样保留，version +1', async () => {
    await seed({ mapLimit: 3 });
    await reserveMapCall(db, { userId: 'u1', nowMs: NOW });
    await reserveMapCall(db, { userId: 'u1', nowMs: NOW });
    await setTravelBudgetPaused(db, { userId: 'u1', paused: true, nowMs: NOW });
    expect(rawRow('u1')!.map_calls_used).toBe(2);

    const after = await getTravelBudget(db, { userId: 'u1', nowMs: NOW + 2 * MINUTE });
    expect(after).toMatchObject({
      dayKey: '2026-10-24',
      mapCallsUsed: 0,
      mapAttemptsUsed: 0,
      mapCallsLimit: 3,
      paused: true,
    });
    expect(after!.version).toBeGreaterThan(3);

    // 暂停优先于额度：跨日之后还是不放行。
    expect(await reserveMapCall(db, { userId: 'u1', nowMs: NOW + 2 * MINUTE })).toEqual({
      ok: false,
      code: 'BUDGET_BLOCKED',
    });
  });
});

describe('地图额度：原子预留 + fail-closed', () => {
  it('limit=3 时正好放行 3 次，第 4 次被拒且不超卖', async () => {
    await seed({ mapLimit: 3 });
    for (let i = 1; i <= 3; i += 1) {
      const result = await reserveMapCall(db, { userId: 'u1', nowMs: NOW });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.state.mapCallsUsed).toBe(i);
    }
    expect(await reserveMapCall(db, { userId: 'u1', nowMs: NOW })).toEqual({
      ok: false,
      code: 'BUDGET_BLOCKED',
    });
    expect(rawRow('u1')!.map_calls_used).toBe(3);
    expect(rawRow('u1')!.map_attempts_used).toBe(3);
  });

  it('limit=0 是硬零（BUDGET_ZERO），不是「用默认值」', async () => {
    await seed({ mapLimit: 0 });
    expect(await reserveMapCall(db, { userId: 'u1', nowMs: NOW })).toEqual({
      ok: false,
      code: 'BUDGET_ZERO',
    });
    expect(rawRow('u1')!.map_calls_used).toBe(0);
  });

  it('缺行 → BUDGET_BLOCKED（不自动补一行正数额度）', async () => {
    await upsertTravelSettings(db, { userId: 'u9', nowMs: NOW, baseVersion: null });
    expect(await getTravelBudget(db, { userId: 'u9', nowMs: NOW })).toBeNull();
    expect(await reserveMapCall(db, { userId: 'u9', nowMs: NOW })).toEqual({
      ok: false,
      code: 'BUDGET_BLOCKED',
    });
    expect(countRows('WHERE user_id = ?', 'u9')).toBe(0);
  });

  it('并发方抢走最后一个名额：条件 UPDATE 拿 0 行，绝不写成 limit+1', async () => {
    await seed({ mapLimit: 1 });
    let injected = false;
    const racing = createSqliteD1(sql, {
      beforeStatement: (text) => {
        if (!injected && /^\s*UPDATE\s+travel_budget_state\b/i.test(text)) {
          injected = true;
          // 另一台设备（或另一个角色）先拿走名额：两个计数都落在 1。
          sql
            .prepare("UPDATE travel_budget_state SET map_calls_used = 1, map_attempts_used = 1 WHERE user_id = 'u1'")
            .run();
        }
      },
    });
    expect(await reserveMapCall(racing, { userId: 'u1', nowMs: NOW })).toEqual({
      ok: false,
      code: 'BUDGET_BLOCKED',
    });
    expect(rawRow('u1')!.map_calls_used).toBe(1);
    expect(rawRow('u1')!.map_attempts_used).toBe(1);
  });

  it('默认失败不退（真实请求已经花掉）；显式 refund 才退，且只退 used、attempts 留着', async () => {
    await seed({ mapLimit: 2 });
    await reserveMapCall(db, { userId: 'u1', nowMs: NOW });
    // 默认语义：失败也已经发过请求 → 不退（否则失败重试就是免费循环）
    await settleMapCall(db, { userId: 'u1', ok: false, nowMs: NOW + 1 });
    expect(rawRow('u1')!.map_calls_used).toBe(1);
    expect(rawRow('u1')!.map_attempts_used).toBe(1);
    // 显式退款（只用于「一个字节都没发出去」）
    await settleMapCall(db, { userId: 'u1', ok: false, nowMs: NOW + 2, refund: true });
    expect(rawRow('u1')!.map_calls_used).toBe(0);
    expect(rawRow('u1')!.map_attempts_used).toBe(1);

    // 再退也不会变成负数。
    await settleMapCall(db, { userId: 'u1', ok: false, nowMs: NOW + 3, refund: true });
    expect(rawRow('u1')!.map_calls_used).toBe(0);

    // 成功的结算不改 used（预留即计入）。
    await reserveMapCall(db, { userId: 'u1', nowMs: NOW + 3 });
    await settleMapCall(db, { userId: 'u1', ok: true, nowMs: NOW + 4 });
    expect(rawRow('u1')!.map_calls_used).toBe(1);
  });

  it('租户隔离 + 多角色共用：同一 user 只有一行，另一个 user 各自一份', async () => {
    await seed({ userId: 'u1', mapLimit: 5 });
    await seed({ userId: 'u2', mapLimit: 5 });

    // 同一账号下两个角色（c1 / c2）各自动一次 —— 签名里没有 charId，账本只有一行。
    await reserveMapCall(db, { userId: 'u1', nowMs: NOW });
    await reserveMapCall(db, { userId: 'u1', nowMs: NOW });
    await reserveMapCall(db, { userId: 'u2', nowMs: NOW });

    expect(countRows()).toBe(2);
    expect(rawRow('u1')!.map_calls_used).toBe(2);
    expect(rawRow('u2')!.map_calls_used).toBe(1);
  });

  it('改 limit / 暂停都带条件 UPDATE，且不影响别的租户', async () => {
    await seed({ userId: 'u1', mapLimit: 3 });
    await seed({ userId: 'u2', mapLimit: 3 });

    expect(await setTravelMapCallsLimit(db, { userId: 'u1', limit: 0, nowMs: NOW + 1 })).toEqual({
      ok: true,
      limit: 0,
    });
    expect((await getTravelBudget(db, { userId: 'u1', nowMs: NOW + 1 }))!.mapCallsLimit).toBe(0);
    expect((await getTravelBudget(db, { userId: 'u2', nowMs: NOW + 1 }))!.mapCallsLimit).toBe(3);

    expect(await setTravelBudgetPaused(db, { userId: 'u2', paused: true, nowMs: NOW + 2 })).toBe(true);
    expect(rawRow('u2')!.paused).toBe(1);
    expect(rawRow('u1')!.paused).toBe(0);
  });
});

describe('LLM token：走既有 autonomy 权威账本，不另立额度', () => {
  it('本表 llm_tokens_limit=0 / used 很高也不拦：判定只看注入端口', async () => {
    await seed({ mapLimit: 3, llmLimit: 0 });
    sql
      .prepare("UPDATE travel_budget_state SET llm_tokens_used = 999999 WHERE user_id = 'u1'")
      .run();
    const { port } = createLlmPort({ usedTokens: 0, limitTokens: 1000 });

    const result = await reserveLlmTokens(db, {
      userId: 'u1',
      tokens: 120,
      idempotencyKey: 'travel:wish-1:choose',
      nowMs: NOW,
      port,
    });
    expect(result.ok).toBe(true);
    // 镜像跟着走（只为 UI/诊断），不是判定依据。
    expect(rawRow('u1')!.llm_tokens_used).toBe(120);
  });

  it('端口读不到 / 暂停 / 硬零 / 预留被拒：一律 fail-closed，且不写镜像', async () => {
    await seed({ mapLimit: 3, llmLimit: 1000 });

    const missing = createLlmPort(null);
    expect(
      await reserveLlmTokens(db, { userId: 'u1', tokens: 10, idempotencyKey: 'k1', nowMs: NOW, port: missing.port }),
    ).toEqual({ ok: false, code: 'BUDGET_BLOCKED' });

    const paused = createLlmPort({ usedTokens: 0, limitTokens: 1000, paused: true });
    expect(
      await reserveLlmTokens(db, { userId: 'u1', tokens: 10, idempotencyKey: 'k2', nowMs: NOW, port: paused.port }),
    ).toEqual({ ok: false, code: 'BUDGET_BLOCKED' });

    const zero = createLlmPort({ usedTokens: 0, limitTokens: 0 });
    expect(
      await reserveLlmTokens(db, { userId: 'u1', tokens: 10, idempotencyKey: 'k3', nowMs: NOW, port: zero.port }),
    ).toEqual({ ok: false, code: 'BUDGET_ZERO' });

    const tight = createLlmPort({ usedTokens: 995, limitTokens: 1000 });
    expect(
      await reserveLlmTokens(db, { userId: 'u1', tokens: 10, idempotencyKey: 'k4', nowMs: NOW, port: tight.port }),
    ).toEqual({ ok: false, code: 'BUDGET_BLOCKED' });

    expect(rawRow('u1')!.llm_tokens_used).toBe(0);
  });

  it('端口抛错（读失败）→ BUDGET_BLOCKED，不把异常漏给调用方也不放行', async () => {
    await seed({ mapLimit: 3, llmLimit: 1000 });
    const port: TravelLlmLedgerPort = {
      read: async () => {
        throw new Error('D1 read failed');
      },
      reserve: async () => {
        throw new Error('D1 read failed');
      },
      settle: async () => {},
      release: async () => {},
    };
    expect(
      await reserveLlmTokens(db, { userId: 'u1', tokens: 10, idempotencyKey: 'k5', nowMs: NOW, port }),
    ).toEqual({ ok: false, code: 'BUDGET_BLOCKED' });
    expect(rawRow('u1')!.llm_tokens_used).toBe(0);
  });

  it('结算把实际 token 交给端口，镜像回读权威用量；失败可释放', async () => {
    await seed({ mapLimit: 3, llmLimit: 1000 });
    const { port, reserve, settle, release } = createLlmPort({ usedTokens: 0, limitTokens: 1000 });

    const reserved = await reserveLlmTokens(db, {
      userId: 'u1',
      tokens: 200,
      idempotencyKey: 'travel:wish-1:choose',
      nowMs: NOW,
      port,
    });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', tokens: 200, idempotencyKey: 'travel:wish-1:choose' }),
    );

    await settleLlmTokens(db, {
      userId: 'u1',
      reservationId: reserved.reservationId,
      actualTokens: 80,
      ok: true,
      nowMs: NOW + 10,
      port,
    });
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: reserved.reservationId, actualTokens: 80 }),
    );
    expect(rawRow('u1')!.llm_tokens_used).toBe(80);

    await settleLlmTokens(db, {
      userId: 'u1',
      reservationId: 'res-failed',
      actualTokens: 0,
      ok: false,
      nowMs: NOW + 20,
      port,
    });
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ reservationId: 'res-failed' }));
  });
});

describe('resolveTravelBudgetGate（给路由用的只读闸）', () => {
  it('地图能过 / 用尽 / 暂停 三种口径', async () => {
    await seed({ mapLimit: 1 });
    expect(await resolveTravelBudgetGate(db, { userId: 'u1', nowMs: NOW, kind: 'map' })).toEqual({
      allowed: true,
    });
    await reserveMapCall(db, { userId: 'u1', nowMs: NOW });
    expect(await resolveTravelBudgetGate(db, { userId: 'u1', nowMs: NOW, kind: 'map' })).toEqual({
      allowed: false,
      code: 'BUDGET_BLOCKED',
    });

    await setTravelBudgetPaused(db, { userId: 'u1', paused: true, nowMs: NOW });
    await setTravelMapCallsLimit(db, { userId: 'u1', limit: 5, nowMs: NOW });
    expect(
      await resolveTravelBudgetGate(db, {
        userId: 'u1',
        nowMs: NOW + DAY,
        kind: 'map',
        port: createLlmPort().port,
      }),
    ).toEqual({ allowed: false, code: 'BUDGET_BLOCKED' });
  });

  it('LLM 口径把闸交给端口（暂停优先于硬零）', async () => {
    await seed({ mapLimit: 1, llmLimit: 0 });
    expect(
      await resolveTravelBudgetGate(db, {
        userId: 'u1',
        nowMs: NOW,
        kind: 'llm',
        port: createLlmPort({ usedTokens: 0, limitTokens: 0, paused: true }).port,
      }),
    ).toEqual({ allowed: false, code: 'BUDGET_BLOCKED' });
    expect(
      await resolveTravelBudgetGate(db, {
        userId: 'u1',
        nowMs: NOW,
        kind: 'llm',
        port: createLlmPort({ usedTokens: 10, limitTokens: 0 }).port,
      }),
    ).toEqual({ allowed: false, code: 'BUDGET_ZERO' });
    expect(
      await resolveTravelBudgetGate(db, {
        userId: 'u1',
        nowMs: NOW,
        kind: 'llm',
        port: createLlmPort({ usedTokens: 10, limitTokens: 100 }).port,
      }),
    ).toEqual({ allowed: true });
  });
});
