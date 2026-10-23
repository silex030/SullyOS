import { beforeEach, describe, expect, it } from 'vitest';

import { createSqliteD1, openTestSqlite, type TestSqlite } from '../test/d1-sqlite';
import {
  ensureAutonomySchema,
  getGlobalAutonomyUsage,
  resetAutonomySchemaCacheForTesting,
  type AutonomyDb,
} from '../autonomyStore';
import { createAutonomyLlmLedgerPort } from './llmLedger';

const NOW = Date.parse('2026-10-23T04:00:00.000Z');
const DAY = '2026-10-23';

let sql: TestSqlite;
let db: AutonomyDb;
let guardrails: { paused: boolean; dailyTokenBudget: number } | null;

const port = () => createAutonomyLlmLedgerPort({
  db,
  charId: 'c1',
  readGuardrails: async () => guardrails,
  dateKeyOf: () => DAY,
  dayStartMsOf: () => NOW - 6 * 3600_000,
  newRunId: () => 'run-1',
});

beforeEach(async () => {
  sql = openTestSqlite();
  resetAutonomySchemaCacheForTesting();
  // autonomyStore 按真实 D1 读 `meta.changes`；测试替身只回顶层 changes，这里补一层，
  // 不为了让测试通过去改公共的 autonomyStore。
  const raw = createSqliteD1(sql);
  db = {
    prepare(text: string) {
      const stmt = raw.prepare(text);
      const withMeta = {
        run: async () => {
          const result = (await stmt.run()) as { changes: number; lastInsertRowid: number };
          return { ...result, meta: { changes: result.changes } };
        },
        first: () => stmt.first(),
        all: () => stmt.all(),
      };
      return {
        ...withMeta,
        bind: (...args: unknown[]) => {
          const bound = stmt.bind(...args);
          return {
            run: async () => {
              const result = (await bound.run()) as { changes: number; lastInsertRowid: number };
              return { ...result, meta: { changes: result.changes } };
            },
            first: () => bound.first(),
            all: () => bound.all(),
          };
        },
      };
    },
  } as unknown as AutonomyDb;
  await ensureAutonomySchema(db);
  guardrails = { paused: false, dailyTokenBudget: 5000 };
});

describe('LLM 账本适配：接既有 autonomy 权威账本', () => {
  it('护栏读不出来 → read 返回 null（fail-closed，不默认额度）', async () => {
    guardrails = null;
    expect(await port().read({ userId: 'u1', nowMs: NOW })).toBeNull();
    expect(await port().reserve({ userId: 'u1', tokens: 100, idempotencyKey: 'travel:w1:choose', nowMs: NOW }))
      .toEqual({ ok: false, code: 'BUDGET_BLOCKED' });
  });

  it('暂停或零额度不放行', async () => {
    guardrails = { paused: true, dailyTokenBudget: 5000 };
    expect(await port().reserve({ userId: 'u1', tokens: 100, idempotencyKey: 'k1', nowMs: NOW })).toEqual({ ok: false, code: 'BUDGET_BLOCKED' });
    guardrails = { paused: false, dailyTokenBudget: 0 };
    expect(await port().reserve({ userId: 'u1', tokens: 100, idempotencyKey: 'k1', nowMs: NOW })).toEqual({ ok: false, code: 'BUDGET_ZERO' });
  });

  it('预留 → 结算；同幂等键重放不多占全局名额', async () => {
    const p = port();
    const first = await p.reserve({ userId: 'u1', tokens: 120, idempotencyKey: 'travel:w1:choose', nowMs: NOW });
    expect(first.ok).toBe(true);
    const usageAfterFirst = await getGlobalAutonomyUsage(db, { userId: 'u1', dateKey: DAY });
    expect(usageAfterFirst).toBe(1);

    const replay = await p.reserve({ userId: 'u1', tokens: 120, idempotencyKey: 'travel:w1:choose', nowMs: NOW });
    expect(replay).toEqual({ ok: true, reservationId: 'travel:w1:choose' });
    expect(await getGlobalAutonomyUsage(db, { userId: 'u1', dateKey: DAY })).toBe(1);

    const read = await p.read({ userId: 'u1', nowMs: NOW });
    expect(read).toEqual({ usedTokens: 120, limitTokens: 5000, paused: false });

    await p.settle({ userId: 'u1', reservationId: 'travel:w1:choose', actualTokens: 90, nowMs: NOW });
    const row = sql.prepare('SELECT status, actual_tokens FROM autonomy_plan_runs WHERE idempotency_key = ?').get('travel:w1:choose') as {
      status: string;
      actual_tokens: number;
    };
    expect(row.status).toBe('settled');
    expect(row.actual_tokens).toBe(90);
  });

  it('释放：名额退回且账本行留 released 证据', async () => {
    const p = port();
    await p.reserve({ userId: 'u1', tokens: 60, idempotencyKey: 'k-release', nowMs: NOW });
    await p.release({ userId: 'u1', reservationId: 'k-release', nowMs: NOW });
    expect(await getGlobalAutonomyUsage(db, { userId: 'u1', dateKey: DAY })).toBe(0);
    const row = sql.prepare('SELECT status FROM autonomy_plan_runs WHERE idempotency_key = ?').get('k-release') as { status: string };
    expect(row.status).toBe('released');
  });
});
