/**
 * 人工 retry 的**真表**回归（node:sqlite，不是记录 SQL 文本的假库）。
 *
 * 为什么必须用真表：`autonomy_plans` 上有 `UNIQUE (char_id, dedupe_key)`，
 * `insertAutonomyPlan` 又是 `INSERT OR IGNORE`。旧 retry 只换 id、沿用 `...previous`
 * 的 dedupe_key，想当然以为「新 id 就能插进去」——真表上它撞唯一索引、changes=0，
 * 函数返回 null，人工恢复永久死锁。假库只要把 changes 预设成 1 就完全看不出这件事。
 *
 * 这里钉住：
 *   1. failed / unknown → 人工新代确实插进去（status=proposed，可被调度认领）；
 *   2. 新代 dedupe_key 与旧代不同、且**确定性**（同一个 newPlanId 第二次必被拒）；
 *   3. 旧行（终态、attempts、scheduled_at）与旧 run 行一个字节都不动；
 *   4. 新代沿用旧代 char_id（不会跨角色），旧 planId 的终态也不会被改写。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

import {
  claimAutonomyPlanForSchedule,
  ensureAutonomySchema,
  getAutonomyPlan,
  insertAutonomyPlan,
  insertAutonomyPlanRun,
  listDueAutonomyPlans,
  markAutonomyPlanRunning,
  resetAutonomySchemaCacheForTesting,
  retryAutonomyPlanManually,
  updateAutonomyPlanRun,
} from './autonomyStore';
import type { AutonomyDb } from './autonomyStore';

// vitest(vite) 会把静态 `node:sqlite` 解析成裸 `sqlite`；运行时 require 走 Node 自己。
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

/** 最小 D1 适配器：真 SQL，`run()` 回 `meta.changes`（store 的 changesOf 只认这个形状）。 */
const createRealDb = (sql: DatabaseSyncType): AutonomyDb => ({
  prepare(text: string) {
    let params: unknown[] = [];
    const statement = {
      bind(...args: unknown[]) {
        params = args.map((value) => (value === undefined ? null : value));
        return statement;
      },
      async run() {
        const result = sql.prepare(text).run(...(params as never[]));
        return { meta: { changes: Number(result.changes ?? 0) } };
      },
      async first() {
        return sql.prepare(text).get(...(params as never[])) ?? null;
      },
      async all() {
        return { results: sql.prepare(text).all(...(params as never[])) };
      },
    };
    return statement as never;
  },
});

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const CHAR = 'c1';
const OLD_ID = 'plan-old';
const OLD_DEDUPE = 'wf:note:abc123';

let sql: DatabaseSyncType;
let db: AutonomyDb;

const basePlan = (overrides: Record<string, unknown> = {}) => ({
  id: OLD_ID,
  charId: CHAR,
  kind: 'diary' as const,
  status: 'unknown' as const,
  purpose: '整理一下今天看到的东西',
  title: '写一条夜记',
  maxChars: 400,
  trigger: { kind: 'now' as const },
  scheduledAt: 1000,
  expiresAt: NOW + 86_400_000,
  createdAt: 900,
  updatedAt: 1000,
  source: 'autonomy_round' as const,
  sourceRef: 'round-1',
  basis: 'virtual' as const,
  evidence: [],
  dedupeKey: OLD_DEDUPE,
  attempts: 2,
  leaseUntil: 0,
  lastError: 'boom',
  ...overrides,
});

const countRows = (where = '', ...params: unknown[]): number => {
  const row = sql.prepare(`SELECT COUNT(*) AS n FROM autonomy_plans ${where}`).get(...(params as never[]));
  return Number((row as { n: number }).n);
};

beforeEach(async () => {
  resetAutonomySchemaCacheForTesting();
  sql = new DatabaseSync(':memory:');
  db = createRealDb(sql);
  await ensureAutonomySchema(db);
});

describe('retryAutonomyPlanManually（真表 + UNIQUE(char_id, dedupe_key)）', () => {
  it('unknown 旧代 → 新代真的插得进去、能排期能认领；同 newPlanId 重复只一条', async () => {
    expect(await insertAutonomyPlan(db, basePlan() as never)).toBe(true);
    expect(await insertAutonomyPlanRun(db, {
      id: 'run-old', planId: OLD_ID, charId: CHAR,
      idempotencyKey: `plan:${OLD_ID}`, reservedTokens: 1600, nowMs: 1000,
    })).toBe(true);
    // 旧 run 已是终态（真执行过的那种）。
    await updateAutonomyPlanRun(db, {
      idempotencyKey: `plan:${OLD_ID}`, status: 'unknown', actualTokens: 812, error: 'timeout', nowMs: 2000,
    });

    const newId = 'plan-old-gen2';
    expect(await retryAutonomyPlanManually(db, {
      planId: OLD_ID, newPlanId: newId, nowMs: 5000, expiresAt: NOW + 86_400_000,
    })).toBe(newId);

    // 真表里确实多了一行，而且不再是 INSERT OR IGNORE 被唯一索引吞掉的那种「假装成功」。
    expect(countRows()).toBe(2);
    const fresh = await getAutonomyPlan(db, newId);
    expect(fresh).not.toBeNull();
    expect(fresh!.status).toBe('proposed');
    expect(fresh!.charId).toBe(CHAR);
    expect(fresh!.predecessorId).toBe(OLD_ID);
    expect(fresh!.dedupeKey).not.toBe(OLD_DEDUPE);
    expect(fresh!.dedupeKey).toContain(newId);
    expect(fresh!.attempts).toBe(0);

    // 旧代：状态仍是 unknown（终态不被改回 proposed），attempts / scheduled_at / 去重键不动。
    const old = await getAutonomyPlan(db, OLD_ID);
    expect(old!.status).toBe('unknown');
    expect(old!.attempts).toBe(2);
    expect(old!.scheduledAt).toBe(1000);
    expect(old!.dedupeKey).toBe(OLD_DEDUPE);
    const oldRun = sql.prepare('SELECT status, idempotency_key FROM autonomy_plan_runs WHERE plan_id = ?')
      .get(OLD_ID) as { status: string; idempotency_key: string };
    expect(oldRun).toEqual({ status: 'unknown', idempotency_key: `plan:${OLD_ID}` });

    // 新代可被调度看见并认领（真 UPDATE，不是假 changes）。
    const due = await listDueAutonomyPlans(db, CHAR, 6000);
    expect(due.map((plan) => plan.id)).toEqual([newId]);
    expect(await claimAutonomyPlanForSchedule(db, { planId: newId, nowMs: 6000, leaseMs: 60_000 })).toBe(true);
    expect(await markAutonomyPlanRunning(db, { planId: newId, nowMs: 7000, leaseMs: 60_000 })).toBe(true);
    expect((await getAutonomyPlan(db, newId))!.status).toBe('running');

    // 同一个 newPlanId 再人工点一次：确定性拒绝，真表里仍然只有两条（新代一条）。
    expect(await retryAutonomyPlanManually(db, {
      planId: OLD_ID, newPlanId: newId, nowMs: 8000, expiresAt: NOW + 86_400_000,
    })).toBeNull();
    expect(countRows()).toBe(2);
    expect(countRows('WHERE dedupe_key = ?', fresh!.dedupeKey)).toBe(1);

    // 换一个 newPlanId 是另一代：各自一条，去重键互不相同。
    const gen3 = 'plan-old-gen3';
    expect(await retryAutonomyPlanManually(db, {
      planId: OLD_ID, newPlanId: gen3, nowMs: 9000, expiresAt: NOW + 86_400_000,
    })).toBe(gen3);
    expect(countRows()).toBe(3);
    const third = await getAutonomyPlan(db, gen3);
    expect(third!.dedupeKey).not.toBe(fresh!.dedupeKey);
    expect(third!.charId).toBe(CHAR);
  });

  it('failed 旧代同样能恢复；已终态计划不会被「旧 planId」重跑', async () => {
    expect(await insertAutonomyPlan(db, basePlan({ status: 'failed', attempts: 1 }) as never)).toBe(true);
    const newId = 'plan-old-gen2';
    expect(await retryAutonomyPlanManually(db, {
      planId: OLD_ID, newPlanId: newId, nowMs: 3000, expiresAt: NOW + 86_400_000,
    })).toBe(newId);
    expect((await getAutonomyPlan(db, newId))!.status).toBe('proposed');
    // 旧 planId 仍然 failed：到点任务若还挂着旧 id，只会走 planNotPending，不会执行新代。
    expect((await getAutonomyPlan(db, OLD_ID))!.status).toBe('failed');
  });
});
