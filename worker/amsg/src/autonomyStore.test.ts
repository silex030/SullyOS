import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTONOMY_EXPERIENCE_TTL_MS,
  addAutonomyExperience,
  cancelPendingAutonomyPlans,
  claimAutonomyPlanForSchedule,
  claimAutonomyTick,
  claimGlobalAutonomyBudget,
  cleanupAutonomyExperiences,
  emptyAutonomyState,
  ensureAutonomySchema,
  getAutonomyState,
  insertAutonomyPlan,
  insertAutonomyPlanRun,
  listDueAutonomyPlans,
  markAutonomyPlanRunning,
  releaseGlobalAutonomyBudget,
  resetAutonomySchemaCacheForTesting,
  retryAutonomyPlanManually,
  setAutonomyState,
  settleAutonomyPlan,
  sumReservedAutonomyTokensSince,
  updateAutonomyPlanRun,
} from './autonomyStore';
import type { AutonomyPlanRecord } from '../../../utils/airp/lifeWorkflow';

interface Recorded {
  sql: string;
  args: unknown[];
}

/**
 * 极简 D1 替身（照 index.test.ts:4548 那类手搓 fake 的做法）：记录每一句 SQL 与绑定参数，
 * first/all 按预设的序列作答。DSL 只有本模块真正用到的那几句。
 */
const createFakeDb = (options: {
  firstRows?: Array<Record<string, unknown> | null>;
  changes?: number[];
} = {}) => {
  const statements: Recorded[] = [];
  let firstIndex = 0;
  let runIndex = 0;
  const db = {
    prepare(sql: string) {
      const stmt = {
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          stmt._args = args;
          return stmt;
        },
        async run() {
          statements.push({ sql, args: stmt._args });
          const changes = options.changes?.[runIndex];
          runIndex += 1;
          return { success: true, meta: { changes: changes ?? 0 } };
        },
        async first() {
          statements.push({ sql, args: stmt._args });
          const row = options.firstRows?.[firstIndex] ?? null;
          firstIndex += 1;
          return row;
        },
        async all() {
          statements.push({ sql, args: stmt._args });
          return { results: [] };
        },
      };
      return stmt;
    },
  };
  return { db, statements };
};

beforeEach(() => {
  resetAutonomySchemaCacheForTesting();
});

describe('ensureAutonomySchema', () => {
  it('建经历表 + 索引 + 记账表 + tick + P5 计划/执行/全局/感知表（老库补列）', async () => {
    const { db, statements } = createFakeDb();
    await ensureAutonomySchema(db);

    expect(statements.length).toBe(16);
    expect(statements[0].sql).toContain('CREATE TABLE IF NOT EXISTS autonomy_experiences');
    expect(statements[0].sql).toContain('char_id TEXT NOT NULL');
    expect(statements[0].sql).toContain('importance INTEGER NOT NULL DEFAULT 0');
    expect(statements[0].sql).toContain("basis TEXT NOT NULL DEFAULT 'virtual'");
    expect(statements[1].sql).toContain('CREATE INDEX IF NOT EXISTS idx_autonomy_experiences_char_created');
    expect(statements[2].sql).toContain('CREATE TABLE IF NOT EXISTS autonomy_state');
    for (const column of [
      'last_round_at', 'last_push_at', 'fail_streak', 'rounds_date',
      'rounds_today', 'tokens_date', 'tokens_today', 'config_hash',
    ]) {
      expect(statements[2].sql).toContain(column);
    }
    expect(statements[3].sql).toContain('CREATE TABLE IF NOT EXISTS autonomy_tick');
    expect(statements[3].sql).toContain('id INTEGER PRIMARY KEY CHECK (id = 1)');
    expect(statements[3].sql).toContain('minute INTEGER NOT NULL DEFAULT 0');
    expect(statements[4].sql).toBe('INSERT OR IGNORE INTO autonomy_tick (id, minute) VALUES (1, 0)');

    expect(statements[5].sql).toContain('CREATE TABLE IF NOT EXISTS autonomy_plans');
    expect(statements[6].sql).toContain('idx_autonomy_plans_char_dedupe');
    expect(statements[8].sql).toContain('CREATE TABLE IF NOT EXISTS autonomy_plan_runs');
    expect(statements[9].sql).toContain('idx_autonomy_plan_runs_idem');
    expect(statements[11].sql).toContain('CREATE TABLE IF NOT EXISTS autonomy_global_state');
    expect(statements[12].sql).toContain('CREATE TABLE IF NOT EXISTS autonomy_perception');
    // 老库补列：三条 ALTER（新库上会报 duplicate column，被吞掉）
    for (const i of [13, 14, 15]) expect(statements[i].sql).toContain('ALTER TABLE autonomy_experiences ADD COLUMN');
  });

  it('补列只吞 duplicate column，别的错误照抛', async () => {
    const statements: string[] = [];
    const db = {
      prepare(sql: string) {
        const stmt = {
          bind() { return stmt; },
          async run() {
            statements.push(sql);
            if (sql.includes('ALTER TABLE')) throw new Error('database is locked');
            return { success: true, meta: { changes: 0 } };
          },
          async first() { return null; },
          async all() { return { results: [] }; },
        };
        return stmt;
      },
    };
    resetAutonomySchemaCacheForTesting();
    await expect(ensureAutonomySchema(db)).rejects.toThrow('database is locked');
  });

  it('第二次调用走模块级短路，不再打 DDL', async () => {
    const { db, statements } = createFakeDb();
    await ensureAutonomySchema(db);
    statements.length = 0;
    await ensureAutonomySchema(db);
    expect(statements).toEqual([]);
  });
});

describe('claimAutonomyTick', () => {
  it('同一分钟第二次认领 → false；下一分钟 → true', async () => {
    const { db, statements } = createFakeDb();
    const minute = 29_700_000;

    // 只有第一句 UPDATE 真的改了行（changes=1），第二句同分钟 changes=0。
    const { db: dbSeq, statements: seqStatements } = createFakeDb({ changes: [1, 0, 1] });
    expect(await claimAutonomyTick(dbSeq, minute)).toBe(true);
    expect(await claimAutonomyTick(dbSeq, minute)).toBe(false);
    expect(await claimAutonomyTick(dbSeq, minute + 1)).toBe(true);

    expect(seqStatements).toHaveLength(3);
    for (const s of seqStatements) {
      expect(s.sql).toBe('UPDATE autonomy_tick SET minute = ? WHERE id = 1 AND minute < ?');
      expect(s.args).toHaveLength(2);
    }
    expect(seqStatements[0].args).toEqual([minute, minute]);
    expect(seqStatements[2].args).toEqual([minute + 1, minute + 1]);

    // 没有 meta.changes 的形态按「没抢到」处理（宁可少跑一跳，不冒双跑风险）。
    expect(await claimAutonomyTick(db, minute)).toBe(false);
    expect(statements).toHaveLength(1);
  });
});

describe('getAutonomyState', () => {
  it('行不在 → 零值', async () => {
    const { db } = createFakeDb({ firstRows: [null] });
    expect(await getAutonomyState(db, 'c1')).toEqual(emptyAutonomyState('c1'));
  });

  it('行在 → 映射成驼峰（缺字段/类型不对回零）', async () => {
    const { db } = createFakeDb({
      firstRows: [{
        char_id: 'c1',
        last_round_at: 1000,
        last_push_at: 900,
        fail_streak: 2,
        rounds_date: '2026-07-25',
        rounds_today: 1,
        tokens_date: '2026-07-25',
        tokens_today: 1234,
        config_hash: 'abc',
      }],
    });
    expect(await getAutonomyState(db, 'c1')).toEqual({
      charId: 'c1',
      lastRoundAt: 1000,
      lastPushAt: 900,
      failStreak: 2,
      roundsDate: '2026-07-25',
      roundsToday: 1,
      tokensDate: '2026-07-25',
      tokensToday: 1234,
      configHash: 'abc',
    });
  });
});

describe('setAutonomyState', () => {
  it('整行 upsert（ON CONFLICT char_id）', async () => {
    const { db, statements } = createFakeDb();
    await setAutonomyState(db, { ...emptyAutonomyState('c1'), lastRoundAt: 42, roundsToday: 2 });
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain('INSERT INTO autonomy_state');
    expect(statements[0].sql).toContain('ON CONFLICT(char_id) DO UPDATE SET');
    expect(statements[0].args).toEqual(['c1', 42, 0, 0, '', 2, '', 0, '']);
  });
});

describe('addAutonomyExperience', () => {
  it('插入一行并回 id（不传 id 时自动生成）', async () => {
    const { db, statements } = createFakeDb();
    const id = await addAutonomyExperience(db, {
      charId: 'c1',
      createdAt: 1000,
      q: '在吗',
      note: '读到一条关于潮汐的笔记',
      kind: 'note',
      importance: 3,
      pushed: true,
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(statements[0].sql).toContain('INSERT INTO autonomy_experiences');
    expect(statements[0].args).toEqual([
      id, 'c1', 1000, '在吗', '读到一条关于潮汐的笔记', 'note', 3, 1, 'virtual', 'autonomy_round', null,
    ]);
  });

  it('省略 q / importance / pushed 时落 null / 0 / 0；显式 basis/source/planId 透传', async () => {
    const { db, statements } = createFakeDb();
    await addAutonomyExperience(db, {
      id: 'fixed', charId: 'c1', createdAt: 1, note: 'n', kind: 'diary',
      basis: 'observation', source: 'workflow', planId: 'plan-1',
    });
    expect(statements[0].args).toEqual(['fixed', 'c1', 1, null, 'n', 'diary', 0, 0, 'observation', 'workflow', 'plan-1']);
  });
});

describe('cleanupAutonomyExperiences', () => {
  it('按截止时刻删并回条数', async () => {
    const { db, statements } = createFakeDb({ changes: [4] });
    const removed = await cleanupAutonomyExperiences(db, 777);
    expect(statements[0].sql).toBe('DELETE FROM autonomy_experiences WHERE created_at < ?');
    expect(statements[0].args).toEqual([777]);
    expect(removed).toBe(4);
  });

  it('没有 meta.changes 时回 0（d1 / better-sqlite3 形态差异）', async () => {
    const { db } = createFakeDb();
    expect(await cleanupAutonomyExperiences(db, 1)).toBe(0);
  });
});

describe('保留期常量', () => {
  it('7 天', () => {
    expect(AUTONOMY_EXPERIENCE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

// ─── P5：计划 / 执行预留 / 全局共享计数 ──────────────────────────────────

const planRecord = (over: Partial<AutonomyPlanRecord> = {}): AutonomyPlanRecord => ({
  id: 'plan-1',
  charId: 'c1',
  kind: 'diary',
  status: 'proposed',
  purpose: '把今天记下来',
  title: '今天的一点小事',
  maxChars: 400,
  trigger: { kind: 'idle', afterMinutes: 120 },
  scheduledAt: 1000,
  expiresAt: 90_000,
  createdAt: 500,
  updatedAt: 500,
  source: 'autonomy_round',
  sourceRef: 'round-1',
  basis: 'virtual',
  evidence: [],
  dedupeKey: 'wf:diary:abc',
  attempts: 0,
  leaseUntil: 0,
  ...over,
});

describe('autonomy_plans', () => {
  it('提议落库用 INSERT OR IGNORE（同角色同去重键只一条），changes 决定成功', async () => {
    const inserted = createFakeDb({ changes: [1] });
    expect(await insertAutonomyPlan(inserted.db, planRecord())).toBe(true);
    expect(inserted.statements[0].sql).toContain('INSERT OR IGNORE INTO autonomy_plans');
    expect(inserted.statements[0].args).toContain('wf:diary:abc');
    expect(inserted.statements[0].args).toContain('[]');

    const duplicate = createFakeDb({ changes: [0] });
    expect(await insertAutonomyPlan(duplicate.db, planRecord())).toBe(false);
  });

  it('读回一行 → 驼峰 + trigger/evidence 还原', async () => {
    const { db } = createFakeDb({
      firstRows: [{
        id: 'plan-1', char_id: 'c1', kind: 'diary', status: 'proposed',
        purpose: 'p', title: 't', note_hint: '口语', max_chars: 300,
        trigger_kind: 'idle', trigger_value: '120', scheduled_at: 1000, expires_at: 2000,
        created_at: 500, updated_at: 600, source: 'autonomy_round', source_ref: 'round-1',
        basis: 'inference', evidence_json: '["最近聊到想整理房间"]', predecessor_id: 'old',
        dedupe_key: 'k', attempts: 1, lease_until: 0, last_error: null,
      }],
    });
    const { getAutonomyPlan } = await import('./autonomyStore');
    const plan = await getAutonomyPlan(db, 'plan-1');
    expect(plan).toMatchObject({
      id: 'plan-1', charId: 'c1', kind: 'diary', status: 'proposed', noteHint: '口语',
      trigger: { kind: 'idle', afterMinutes: 120 }, evidence: ['最近聊到想整理房间'],
      predecessorId: 'old', basis: 'inference',
    });
  });

  it('认领排期：只从 proposed 且未过期迁到 scheduled（条件 UPDATE 带租约）', async () => {
    const { db, statements } = createFakeDb({ changes: [1] });
    expect(await claimAutonomyPlanForSchedule(db, { planId: 'plan-1', nowMs: 5000, leaseMs: 60_000 })).toBe(true);
    expect(statements[0].sql).toContain("SET status = 'scheduled'");
    expect(statements[0].sql).toContain("WHERE id = ? AND status = 'proposed' AND expires_at > ?");
    expect(statements[0].args).toEqual([65_000, 5000, 'plan-1', 5000]);

    const lost = createFakeDb({ changes: [0] });
    expect(await claimAutonomyPlanForSchedule(lost.db, { planId: 'plan-1', nowMs: 1, leaseMs: 1 })).toBe(false);
  });

  it('开跑：scheduled → running，attempts+1；终态不会再开跑', async () => {
    const { db, statements } = createFakeDb({ changes: [1] });
    expect(await markAutonomyPlanRunning(db, { planId: 'plan-1', nowMs: 7000, leaseMs: 30_000 })).toBe(true);
    expect(statements[0].sql).toContain("status = 'running', attempts = attempts + 1");
    expect(statements[0].sql).toContain("WHERE id = ? AND status = 'scheduled'");
  });

  it('收尾只从 scheduled/running 迁出（重报不会把 completed 改回 failed）', async () => {
    const { db, statements } = createFakeDb({ changes: [1] });
    await settleAutonomyPlan(db, { planId: 'plan-1', status: 'completed', nowMs: 9000 });
    expect(statements[0].sql).toContain("status IN ('scheduled', 'running')");
    expect(statements[0].args).toEqual(['completed', 9000, null, 'plan-1']);
  });

  it('用户开口取消：只动还没开始、且没被租约占住的', async () => {
    const { db, statements } = createFakeDb({ changes: [2] });
    expect(await cancelPendingAutonomyPlans(db, { charId: 'c1', nowMs: 100, reason: 'user-spoke' })).toBe(2);
    expect(statements[0].sql).toContain("status IN ('proposed', 'scheduled')");
    expect(statements[0].sql).toContain('lease_until < ?');
  });

  it('到点查询只排 proposed + 未过期（scheduled 表示已经建过任务，绝不重排）', async () => {
    const { db, statements } = createFakeDb();
    await listDueAutonomyPlans(db, 'c1', 5000);
    expect(statements[0].sql).toContain("status = 'proposed'");
    expect(statements[0].sql).toContain('scheduled_at <= ?');
    expect(statements[0].args).toEqual(['c1', 5000, 5000, 5]);
  });

  it('人工恢复落成新计划代次（不清 run 历史、不复用旧幂等键）', async () => {
    const failedRow = {
      id: 'plan-1', char_id: 'c1', kind: 'diary', status: 'failed', purpose: 'p', title: 't',
      note_hint: null, max_chars: 400, trigger_kind: 'idle', trigger_value: '60',
      scheduled_at: 1000, expires_at: 9000, created_at: 0, updated_at: 0,
      source: 'chat_reply', source_ref: 'r', basis: 'virtual', evidence_json: '[]',
      predecessor_id: null, dedupe_key: 'k', attempts: 1, lease_until: 0, last_error: 'boom',
    };
    const ok = createFakeDb({ changes: [1], firstRows: [failedRow] });
    expect(await retryAutonomyPlanManually(ok.db, {
      planId: 'plan-1', newPlanId: 'plan-1-attempt-2', nowMs: 3000, expiresAt: 9000,
    })).toBe('plan-1-attempt-2');
    const insert = ok.statements.find((s) => s.sql.includes('INSERT OR IGNORE INTO autonomy_plans'));
    expect(insert).toBeTruthy();
    // 新代 id + predecessor 指回旧代；旧代仍保留（不 UPDATE 回 proposed、不清 attempts）
    expect(insert!.args[0]).toBe('plan-1-attempt-2');
    expect(insert!.args[18]).toBe('plan-1');
    expect(ok.statements.some((s) => s.args.includes('manual-retry:plan-1-attempt-2'))).toBe(true);
    expect(ok.statements.some((s) => s.sql.includes("SET status = 'proposed'"))).toBe(false);

    const missing = createFakeDb({ firstRows: [null] });
    expect(await retryAutonomyPlanManually(missing.db, {
      planId: 'nope', newPlanId: 'x', nowMs: 1, expiresAt: 2,
    })).toBe(null);
  });
});

describe('autonomy_plan_runs（幂等 + token 预留）', () => {
  it('插入预留用唯一幂等键，重报插入不进去', async () => {
    const first = createFakeDb({ changes: [1, 1] });
    expect(await insertAutonomyPlanRun(first.db, {
      id: 'run-1', planId: 'plan-1', charId: 'c1',
      idempotencyKey: 'plan:plan-1', reservedTokens: 1600, nowMs: 1000,
    })).toBe(true);
    // 先把 released 旧行改名（让出唯一键，但行本身留着做审计），再插
    expect(first.statements[0].sql).toContain("status = 'released'");
    expect(first.statements[0].sql).toContain("idempotency_key = idempotency_key || ':released:' || id");
    expect(first.statements[0].sql).not.toContain('DELETE');
    expect(first.statements[1].sql).toContain('INSERT OR IGNORE INTO autonomy_plan_runs');
    expect(first.statements[1].args).toEqual(['run-1', 'plan-1', 'c1', 'plan:plan-1', 1600, 1000, 1000]);

    const duplicate = createFakeDb({ changes: [1, 0] });
    expect(await insertAutonomyPlanRun(duplicate.db, {
      id: 'run-2', planId: 'plan-1', charId: 'c1',
      idempotencyKey: 'plan:plan-1', reservedTokens: 1600, nowMs: 2000,
    })).toBe(false);
  });

  it('结算按实际 token 写回', async () => {
    const { db, statements } = createFakeDb();
    await updateAutonomyPlanRun(db, { idempotencyKey: 'plan:plan-1', status: 'settled', actualTokens: 812, nowMs: 3000 });
    expect(statements[0].sql).toContain('UPDATE autonomy_plan_runs');
    expect(statements[0].args).toEqual(['settled', 812, null, 3000, 'plan:plan-1']);
  });

  it('当日未结算预留求和（token 门防超卖）', async () => {
    const { db } = createFakeDb({ firstRows: [{ total: 3200 }] });
    expect(await sumReservedAutonomyTokensSince(db, 'c1', 0)).toBe(3200);
  });
});

describe('autonomy_global_state（全局额度真正共享）', () => {
  it('认领：先保证行存在，再条件 +1；changes=1 才拿到名额', async () => {
    const ok = createFakeDb({ changes: [0, 1] });
    expect(await claimGlobalAutonomyBudget(ok.db, {
      userId: 'u1', dateKey: '2026-10-22', limit: 6, nowMs: 1000,
    })).toBe(true);
    expect(ok.statements[0].sql).toContain('INSERT OR IGNORE INTO autonomy_global_state');
    expect(ok.statements[1].sql).toContain('used < ?');
    expect(ok.statements[1].args).toEqual(['2026-10-22', '2026-10-22', 1000, 'u1', '2026-10-22', 6, '2026-10-22', 6]);

    const full = createFakeDb({ changes: [0, 0] });
    expect(await claimGlobalAutonomyBudget(full.db, {
      userId: 'u1', dateKey: '2026-10-22', limit: 6, nowMs: 1000,
    })).toBe(false);
  });

  it('建任务失败退名额（没发生生成就不该占额度）', async () => {
    const { db, statements } = createFakeDb();
    await releaseGlobalAutonomyBudget(db, { userId: 'u1', dateKey: '2026-10-22', nowMs: 2000 });
    expect(statements[0].sql).toContain('used - 1');
  });
});
