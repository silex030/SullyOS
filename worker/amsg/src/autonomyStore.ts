/**
 * 自主背景生活（autonomy）的云端落库层。
 *
 * 表都建在用户自己的 D1 里、和上游表并列，绝不改上游 schema：
 *   autonomy_experiences —— 角色自己攒下的经历（P4：带 basis/source/plan_id，分清现实观测/推测/虚拟经历）
 *   autonomy_state       —— 既有回合的记账：窗口、当日轮数、token、熔断、configHash
 *   autonomy_tick        —— 每分钟一跳的「谁先到」闸
 *   autonomy_plans       —— P5 生活工作流的计划与状态机（proposed/scheduled/running/completed/
 *                           cancelled/failed/unknown）；带来源、前身、证据、去重键、租约
 *   autonomy_plan_runs   —— 每次执行的幂等键 + token 预留（重启/多设备重报都不重复生成）
 *   autonomy_global_state —— **用户级**共享的每日次数计数（全局 6 次/天；不是每角色一份）
 *   autonomy_perception  —— 已喂过的感知指纹（同 key 同值不再喂）
 *
 * B0：角色的 fire_pack 不在这几张表里，它是上游 `client_state` 表里 namespace
 * `amsg:char:<charId>` 下的 `fire_pack` 键（utils/amsgFirePack.ts:22-24）——cron 那条路
 * 没有请求上下文，只能直接扫那张表、按 user_id 解密、再解析（见 autonomyScheduler 的
 * scanAutonomyPacks）。
 *
 * 表懒建，照 worker/post-office/src/index.ts 的做法：模块级 ready 短路 + CREATE
 * TABLE/INDEX IF NOT EXISTS。老库缺列靠 tryAlter 补（只吞 duplicate column，别的错照抛）。
 */

import type {
  AutonomyPlanRecord,
  AutonomyPlanStatus,
  AutonomyWorkflowKind,
  AutonomyWorkflowTrigger,
} from '../../../utils/airp/lifeWorkflow';
import type { PerceptionSeenEntry } from '../../../utils/airp/perception';

/**
 * 调度器和 store 真正用到的那部分 D1（结构子集，与 pushFanout 的 FanoutDb 同一手法）。
 *
 * 不直接用 `D1Database` 这个名字：它在本仓库没有任何声明（worker 侧要么自己声明，
 * 要么像这里取结构子集），写上去就是一个新的 tsc 错误。
 */
export interface AutonomyStatement {
  bind(...args: unknown[]): AutonomyStatement;
  run(): Promise<unknown>;
  first(): Promise<Record<string, unknown> | null>;
  all(): Promise<{ results?: Array<Record<string, unknown>> }>;
}

export interface AutonomyDb {
  prepare(sql: string): AutonomyStatement;
}

/** 经历行的保留期：超过就删（cron 每跳顺手清一次）。 */
export const AUTONOMY_EXPERIENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const AUTONOMY_EXPERIENCES_DDL = `CREATE TABLE IF NOT EXISTS autonomy_experiences (
  id TEXT PRIMARY KEY,
  char_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  q TEXT,
  note TEXT NOT NULL,
  kind TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 0,
  pushed INTEGER NOT NULL DEFAULT 0,
  basis TEXT NOT NULL DEFAULT 'virtual',
  source TEXT NOT NULL DEFAULT 'autonomy_round',
  plan_id TEXT
)`;

export const AUTONOMY_EXPERIENCES_INDEX_DDL =
  'CREATE INDEX IF NOT EXISTS idx_autonomy_experiences_char_created ON autonomy_experiences (char_id, created_at)';

export const AUTONOMY_STATE_DDL = `CREATE TABLE IF NOT EXISTS autonomy_state (
  char_id TEXT PRIMARY KEY,
  last_round_at INTEGER NOT NULL DEFAULT 0,
  last_push_at INTEGER NOT NULL DEFAULT 0,
  fail_streak INTEGER NOT NULL DEFAULT 0,
  rounds_date TEXT NOT NULL DEFAULT '',
  rounds_today INTEGER NOT NULL DEFAULT 0,
  tokens_date TEXT NOT NULL DEFAULT '',
  tokens_today INTEGER NOT NULL DEFAULT 0,
  config_hash TEXT NOT NULL DEFAULT ''
)`;

/**
 * 每分钟一跳的「谁先到」闸。CF Cron 与 VPS node-cron 会同时喂同一个分钟，两边都跑到
 * 扫描（毫秒级、还要解密整包）就会双建任务、一天配额瞬间烧光。行只有一行（id=1 的
 * CHECK 钉死），minute 记最后一次被认领的分钟号；条件 UPDATE 是原子的，同一分钟只有
 * 一个 tick 能把 changes 拿到 1。
 */
export const AUTONOMY_TICK_DDL = `CREATE TABLE IF NOT EXISTS autonomy_tick (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  minute INTEGER NOT NULL DEFAULT 0
)`;

export const AUTONOMY_TICK_SEED = 'INSERT OR IGNORE INTO autonomy_tick (id, minute) VALUES (1, 0)';

/** P5 计划表：状态机 + 来源 + 前身 + 去重 + 租约。 */
export const AUTONOMY_PLANS_DDL = `CREATE TABLE IF NOT EXISTS autonomy_plans (
  id TEXT PRIMARY KEY,
  char_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  purpose TEXT NOT NULL,
  title TEXT NOT NULL,
  note_hint TEXT,
  max_chars INTEGER NOT NULL DEFAULT 400,
  trigger_kind TEXT NOT NULL,
  trigger_value TEXT,
  scheduled_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  basis TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  predecessor_id TEXT,
  dedupe_key TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
)`;

export const AUTONOMY_PLANS_UNIQUE_DDL =
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_autonomy_plans_char_dedupe ON autonomy_plans (char_id, dedupe_key)';

export const AUTONOMY_PLANS_STATUS_DDL =
  'CREATE INDEX IF NOT EXISTS idx_autonomy_plans_status ON autonomy_plans (char_id, status, scheduled_at)';

/** 每次执行的幂等键 + token 预留。 */
export const AUTONOMY_PLAN_RUNS_DDL = `CREATE TABLE IF NOT EXISTS autonomy_plan_runs (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  char_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  reserved_tokens INTEGER NOT NULL DEFAULT 0,
  actual_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  error TEXT
)`;

export const AUTONOMY_PLAN_RUNS_UNIQUE_DDL =
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_autonomy_plan_runs_idem ON autonomy_plan_runs (idempotency_key)';

export const AUTONOMY_PLAN_RUNS_CHAR_DDL =
  'CREATE INDEX IF NOT EXISTS idx_autonomy_plan_runs_char_created ON autonomy_plan_runs (char_id, created_at)';

/** 用户级共享计数：全局额度必须真正共享持久化，不能信某个角色的 body。 */
export const AUTONOMY_GLOBAL_STATE_DDL = `CREATE TABLE IF NOT EXISTS autonomy_global_state (
  user_id TEXT PRIMARY KEY,
  date TEXT NOT NULL DEFAULT '',
  used INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
)`;

/** 感知指纹（同 key 同值 = 没变化，下一轮不再喂）。 */
export const AUTONOMY_PERCEPTION_DDL = `CREATE TABLE IF NOT EXISTS autonomy_perception (
  char_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  value_hash TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (char_id, dedupe_key)
)`;

/** 老库补列：SQLite 没有 ADD COLUMN IF NOT EXISTS，只能吞 duplicate column。 */
const EXPERIENCE_ALTERS = [
  "ALTER TABLE autonomy_experiences ADD COLUMN basis TEXT NOT NULL DEFAULT 'virtual'",
  "ALTER TABLE autonomy_experiences ADD COLUMN source TEXT NOT NULL DEFAULT 'autonomy_round'",
  'ALTER TABLE autonomy_experiences ADD COLUMN plan_id TEXT',
] as const;

export interface AutonomyStateRow {
  charId: string;
  lastRoundAt: number;
  lastPushAt: number;
  failStreak: number;
  roundsDate: string;
  roundsToday: number;
  tokensDate: string;
  tokensToday: number;
  configHash: string;
}

export const emptyAutonomyState = (charId: string): AutonomyStateRow => ({
  charId,
  lastRoundAt: 0,
  lastPushAt: 0,
  failStreak: 0,
  roundsDate: '',
  roundsToday: 0,
  tokensDate: '',
  tokensToday: 0,
  configHash: '',
});

export interface AutonomyExperienceInput {
  charId: string;
  createdAt: number;
  /** 触发这条经历的用户原话（没有就 null）。 */
  q?: string | null;
  note: string;
  kind: string;
  importance?: number;
  pushed?: boolean;
  /** 不传就现造一个 uuid。 */
  id?: string;
  /** P4 认知档：现实观测 / 推测 / 虚拟经历。默认 virtual（自主生活本来就是虚拟的）。 */
  basis?: 'observation' | 'inference' | 'virtual';
  /** 这条经历是哪种链路产的。 */
  source?: 'autonomy_round' | 'workflow' | 'chat';
  /** 工作流执行产的经历挂到计划上（对账用）。 */
  planId?: string | null;
}

let schemaReady = false;

/** 只为单测：模块级 ready 短路在用例之间会串味，测之前清一次。 */
export const resetAutonomySchemaCacheForTesting = (): void => {
  schemaReady = false;
};

const isDuplicateColumnError = (error: unknown): boolean =>
  /duplicate column/i.test(error instanceof Error ? error.message : String(error));

/**
 * 懒建全部表。任何一句失败都不吞（除了「列已存在」）：建不出表的话调度器整个跑不起来，
 * 让它在下一次 cron 重试，别静默当成「没有角色要跑」。
 */
export async function ensureAutonomySchema(db: AutonomyDb): Promise<void> {
  if (schemaReady) return;
  await db.prepare(AUTONOMY_EXPERIENCES_DDL).run();
  await db.prepare(AUTONOMY_EXPERIENCES_INDEX_DDL).run();
  await db.prepare(AUTONOMY_STATE_DDL).run();
  await db.prepare(AUTONOMY_TICK_DDL).run();
  await db.prepare(AUTONOMY_TICK_SEED).run();
  await db.prepare(AUTONOMY_PLANS_DDL).run();
  await db.prepare(AUTONOMY_PLANS_UNIQUE_DDL).run();
  await db.prepare(AUTONOMY_PLANS_STATUS_DDL).run();
  await db.prepare(AUTONOMY_PLAN_RUNS_DDL).run();
  await db.prepare(AUTONOMY_PLAN_RUNS_UNIQUE_DDL).run();
  await db.prepare(AUTONOMY_PLAN_RUNS_CHAR_DDL).run();
  await db.prepare(AUTONOMY_GLOBAL_STATE_DDL).run();
  await db.prepare(AUTONOMY_PERCEPTION_DDL).run();
  for (const sql of EXPERIENCE_ALTERS) {
    try {
      await db.prepare(sql).run();
    } catch (error) {
      if (!isDuplicateColumnError(error)) throw error;
    }
  }
  schemaReady = true;
}

/**
 * 认领这一分钟。`minute < ?` 是严格的：同一个分钟号第二次来 changes 就是 0（认领失败）。
 * 调用方拿到 false 就必须整跳放弃——扫描、判定、清理一个都不许跑。
 */
export async function claimAutonomyTick(db: AutonomyDb, minuteKey: number): Promise<boolean> {
  const result = await db
    .prepare('UPDATE autonomy_tick SET minute = ? WHERE id = 1 AND minute < ?')
    .bind(minuteKey, minuteKey)
    .run();
  const changes = (result as { meta?: { changes?: unknown } } | null)?.meta?.changes;
  return changes === 1;
}

const readNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const readString = (value: unknown): string => (typeof value === 'string' ? value : '');

const changesOf = (result: unknown): number => {
  const changes = (result as { meta?: { changes?: unknown } } | null)?.meta?.changes;
  return typeof changes === 'number' && Number.isFinite(changes) ? changes : 0;
};

/** 每角色一行记账；行不在（或字段被老库截断）时回落到零值。 */
export async function getAutonomyState(db: AutonomyDb, charId: string): Promise<AutonomyStateRow> {
  const row = await db
    .prepare('SELECT char_id, last_round_at, last_push_at, fail_streak, rounds_date, rounds_today, tokens_date, tokens_today, config_hash FROM autonomy_state WHERE char_id = ?')
    .bind(charId)
    .first();
  if (!row) return emptyAutonomyState(charId);
  return {
    charId,
    lastRoundAt: readNumber(row.last_round_at),
    lastPushAt: readNumber(row.last_push_at),
    failStreak: readNumber(row.fail_streak),
    roundsDate: readString(row.rounds_date),
    roundsToday: readNumber(row.rounds_today),
    tokensDate: readString(row.tokens_date),
    tokensToday: readNumber(row.tokens_today),
    configHash: readString(row.config_hash),
  };
}

/** 整行 upsert（读-改-写的那一整行，不做字段级补丁，省得两处口径漂移）。 */
export async function setAutonomyState(db: AutonomyDb, state: AutonomyStateRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO autonomy_state
        (char_id, last_round_at, last_push_at, fail_streak, rounds_date, rounds_today, tokens_date, tokens_today, config_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(char_id) DO UPDATE SET
         last_round_at = excluded.last_round_at,
         last_push_at = excluded.last_push_at,
         fail_streak = excluded.fail_streak,
         rounds_date = excluded.rounds_date,
         rounds_today = excluded.rounds_today,
         tokens_date = excluded.tokens_date,
         tokens_today = excluded.tokens_today,
         config_hash = excluded.config_hash`,
    )
    .bind(
      state.charId,
      state.lastRoundAt,
      state.lastPushAt,
      state.failStreak,
      state.roundsDate,
      state.roundsToday,
      state.tokensDate,
      state.tokensToday,
      state.configHash,
    )
    .run();
}

/** 记一条经历（自主回合 / 工作流执行都走这里）。 */
export async function addAutonomyExperience(
  db: AutonomyDb,
  entry: AutonomyExperienceInput,
): Promise<string> {
  const id = entry.id ?? crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO autonomy_experiences
        (id, char_id, created_at, q, note, kind, importance, pushed, basis, source, plan_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      entry.charId,
      entry.createdAt,
      entry.q ?? null,
      entry.note,
      entry.kind,
      entry.importance ?? 0,
      entry.pushed ? 1 : 0,
      entry.basis ?? 'virtual',
      entry.source ?? 'autonomy_round',
      entry.planId ?? null,
    )
    .run();
  return id;
}

/** 删掉早于 beforeMs 的经历，返回删了几条。 */
export async function cleanupAutonomyExperiences(db: AutonomyDb, beforeMs: number): Promise<number> {
  const result = await db
    .prepare('DELETE FROM autonomy_experiences WHERE created_at < ?')
    .bind(beforeMs)
    .run();
  return changesOf(result);
}

// ─── 计划（P5） ──────────────────────────────────────────────────────────

const triggerValue = (trigger: AutonomyWorkflowTrigger): string | null =>
  trigger.kind === 'idle' ? String(trigger.afterMinutes ?? 180)
    : trigger.kind === 'at_time' ? (trigger.atLocalTime ?? null)
      : null;

const parseTrigger = (kind: string, value: string | null): AutonomyWorkflowTrigger => {
  if (kind === 'idle') {
    const minutes = Number(value);
    return { kind: 'idle', afterMinutes: Number.isFinite(minutes) ? minutes : 180 };
  }
  if (kind === 'at_time') return { kind: 'at_time', atLocalTime: value ?? '21:00' };
  return { kind: 'now' };
};

const toPlanRecord = (row: Record<string, unknown>): AutonomyPlanRecord => {
  let evidence: string[] = [];
  try {
    const parsed: unknown = JSON.parse(readString(row.evidence_json) || '[]');
    if (Array.isArray(parsed)) evidence = parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    evidence = [];
  }
  return {
    id: readString(row.id),
    charId: readString(row.char_id),
    kind: readString(row.kind) as AutonomyWorkflowKind,
    status: readString(row.status) as AutonomyPlanStatus,
    purpose: readString(row.purpose),
    title: readString(row.title),
    ...(readString(row.note_hint) ? { noteHint: readString(row.note_hint) } : {}),
    maxChars: readNumber(row.max_chars) || 400,
    trigger: parseTrigger(readString(row.trigger_kind), readString(row.trigger_value) || null),
    scheduledAt: readNumber(row.scheduled_at),
    expiresAt: readNumber(row.expires_at),
    createdAt: readNumber(row.created_at),
    updatedAt: readNumber(row.updated_at),
    source: readString(row.source) as AutonomyPlanRecord['source'],
    sourceRef: readString(row.source_ref),
    basis: readString(row.basis) === 'inference' ? 'inference' : 'virtual',
    evidence,
    ...(readString(row.predecessor_id) ? { predecessorId: readString(row.predecessor_id) } : {}),
    dedupeKey: readString(row.dedupe_key),
    attempts: readNumber(row.attempts),
    leaseUntil: readNumber(row.lease_until),
    ...(readString(row.last_error) ? { lastError: readString(row.last_error) } : {}),
  };
};

const PLAN_COLUMNS =
  'id, char_id, kind, status, purpose, title, note_hint, max_chars, trigger_kind, trigger_value, scheduled_at, expires_at, created_at, updated_at, source, source_ref, basis, evidence_json, predecessor_id, dedupe_key, attempts, lease_until, last_error';

/** 提议落库：同角色同去重键只允许一条（INSERT OR IGNORE，重报不重复）。 */
export async function insertAutonomyPlan(db: AutonomyDb, plan: AutonomyPlanRecord): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO autonomy_plans (${PLAN_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      plan.id,
      plan.charId,
      plan.kind,
      plan.status,
      plan.purpose,
      plan.title,
      plan.noteHint ?? null,
      plan.maxChars,
      plan.trigger.kind,
      triggerValue(plan.trigger),
      plan.scheduledAt,
      plan.expiresAt,
      plan.createdAt,
      plan.updatedAt,
      plan.source,
      plan.sourceRef,
      plan.basis,
      JSON.stringify(plan.evidence ?? []),
      plan.predecessorId ?? null,
      plan.dedupeKey,
      plan.attempts,
      plan.leaseUntil,
      plan.lastError ?? null,
    )
    .run();
  return changesOf(result) === 1;
}

export async function getAutonomyPlan(db: AutonomyDb, planId: string): Promise<AutonomyPlanRecord | null> {
  const row = await db
    .prepare(`SELECT ${PLAN_COLUMNS} FROM autonomy_plans WHERE id = ?`)
    .bind(planId)
    .first();
  return row ? toPlanRecord(row) : null;
}

/** 某角色某几个状态下的计划（最新在前）。 */
export async function listAutonomyPlans(
  db: AutonomyDb,
  charId: string,
  statuses: readonly AutonomyPlanStatus[],
  limit = 20,
): Promise<AutonomyPlanRecord[]> {
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => '?').join(', ');
  const rows = await db
    .prepare(
      `SELECT ${PLAN_COLUMNS} FROM autonomy_plans
       WHERE char_id = ? AND status IN (${placeholders})
       ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(charId, ...statuses, Math.max(1, Math.trunc(limit)))
    .all();
  return (rows.results ?? []).map(toPlanRecord);
}

/** 到点且未过期的提议（调度器每跳只排这些）。 */
export async function listDueAutonomyPlans(
  db: AutonomyDb,
  charId: string,
  nowMs: number,
  limit = 5,
): Promise<AutonomyPlanRecord[]> {
  const rows = await db
    .prepare(
      `SELECT ${PLAN_COLUMNS} FROM autonomy_plans
       WHERE char_id = ? AND status = 'proposed' AND scheduled_at <= ? AND expires_at > ?
       ORDER BY scheduled_at ASC LIMIT ?`,
    )
    .bind(charId, nowMs, nowMs, Math.max(1, Math.trunc(limit)))
    .all();
  return (rows.results ?? []).map(toPlanRecord);
}

/**
 * 认领一条计划去建任务：proposed → scheduled（带租约）。
 * 条件 UPDATE 保证多设备/多 cron 同时到达时只有一方能拿到 changes=1。
 */
export async function claimAutonomyPlanForSchedule(
  db: AutonomyDb,
  args: { planId: string; nowMs: number; leaseMs: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE autonomy_plans
       SET status = 'scheduled', lease_until = ?, updated_at = ?
       WHERE id = ? AND status = 'proposed' AND expires_at > ?`,
    )
    .bind(args.nowMs + args.leaseMs, args.nowMs, args.planId, args.nowMs)
    .run();
  return changesOf(result) === 1;
}

/** 到点执行开始：scheduled → running（带租约）。拿不到 = 别人先跑了，跳过。 */
export async function markAutonomyPlanRunning(
  db: AutonomyDb,
  args: { planId: string; nowMs: number; leaseMs: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE autonomy_plans
       SET status = 'running', attempts = attempts + 1, lease_until = ?, updated_at = ?
       WHERE id = ? AND status = 'scheduled'`,
    )
    .bind(args.nowMs + args.leaseMs, args.nowMs, args.planId)
    .run();
  return changesOf(result) === 1;
}

/** 收尾：只从 scheduled/running 迁出，终态不会被后来的重报改回去。 */
export async function settleAutonomyPlan(
  db: AutonomyDb,
  args: { planId: string; status: AutonomyPlanStatus; nowMs: number; error?: string | null },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE autonomy_plans
       SET status = ?, updated_at = ?, lease_until = 0, last_error = ?
       WHERE id = ? AND status IN ('scheduled', 'running')`,
    )
    .bind(args.status, args.nowMs, args.error ?? null, args.planId)
    .run();
  return changesOf(result) === 1;
}

/** 用户重新开口：取消还没开始的（proposed/scheduled 且没被正在跑的租约占住）。 */
export async function cancelPendingAutonomyPlans(
  db: AutonomyDb,
  args: { charId: string; nowMs: number; reason: string; createdBeforeMs?: number },
): Promise<number> {
  const createdBefore = typeof args.createdBeforeMs === 'number' && Number.isFinite(args.createdBeforeMs)
    ? args.createdBeforeMs : args.nowMs;
  const result = await db
    .prepare(
      `UPDATE autonomy_plans
       SET status = 'cancelled', updated_at = ?, lease_until = 0, last_error = ?
       WHERE char_id = ? AND status IN ('proposed', 'scheduled')
         AND created_at < ?
         AND (lease_until = 0 OR lease_until < ?)`,
    )
    .bind(args.nowMs, args.reason, args.charId, createdBefore, args.nowMs)
    .run();
  return changesOf(result);
}

/** 过期的提议/已排计划标 failed（不补跑、不补发积压）。 */
export async function expireStaleAutonomyPlans(
  db: AutonomyDb,
  args: { charId: string; nowMs: number },
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE autonomy_plans
       SET status = 'failed', updated_at = ?, lease_until = 0, last_error = 'expired'
       WHERE char_id = ? AND status IN ('proposed', 'scheduled') AND expires_at <= ?
         AND (lease_until = 0 OR lease_until < ?)`,
    )
    .bind(args.nowMs, args.charId, args.nowMs, args.nowMs)
    .run();
  return changesOf(result);
}

/**
 * **人工**恢复入口（review focus 第 2 条）——每次人工尝试落成一条**新计划代次**。
 *
 * 旧实现只把同一行改回 proposed，但 `autonomy_plan_runs` 里已经留着
 * `idempotency_key='plan:<id>'` 的终态行（唯一索引），下一次排期必被 INSERT OR IGNORE
 * 挡掉：人工恢复永久死锁。这里改成「新 planId + predecessorId 指回旧代」：
 *   - 旧行、旧 run 行全部保留（不清历史、不回退 attempts，额度照旧计入当天）；
 *   - 新代有自己的幂等键，能重新排期；
 *   - 旧任务已经是终态，不会再执行第二次。
 * 未知（unknown）同样不自动重试，只能由人调用本函数。
 */
export async function retryAutonomyPlanManually(
  db: AutonomyDb,
  args: { planId: string; newPlanId: string; nowMs: number; expiresAt: number },
): Promise<string | null> {
  const previous = await getAutonomyPlan(db, args.planId);
  if (!previous) return null;
  if (previous.status !== 'failed' && previous.status !== 'unknown') return null;
  const newPlanId = args.newPlanId.trim();
  if (!newPlanId || newPlanId === previous.id) return null;
  const inserted = await insertAutonomyPlan(db, {
    ...previous,
    id: newPlanId,
    status: 'proposed',
    scheduledAt: args.nowMs,
    expiresAt: args.expiresAt,
    createdAt: args.nowMs,
    updatedAt: args.nowMs,
    // 新代从头计数，但当天额度由 countAutonomyPlansSince 按行数算——旧行还在，绕不过去。
    attempts: 0,
    leaseUntil: 0,
    predecessorId: previous.id,
    // 去重键必须换（真表回归见 autonomyRetry.sqlite.test.ts）：旧终态行还在，
    // `UNIQUE (char_id, dedupe_key)` 原样沿用旧键的话 INSERT OR IGNORE 就是 0 行，
    // 人工恢复永远死锁。新代键 = 旧键 + 代次 id：
    //   - 确定性：同一个 newPlanId 再点一次落到同一把键，必被唯一索引拒掉（不靠随机数）；
    //   - 换 newPlanId 才是另一代，各自一条，也不构成「换个键就绕开当日额度」
    //     （额度按行数算，旧行都还在）。
    dedupeKey: `${previous.dedupeKey}:gen:${newPlanId}`,
  });
  if (!inserted) return null;
  // 旧代保持终态；只加一行溯源说明（不改状态、不清 run 历史）。
  await db
    .prepare('UPDATE autonomy_plans SET last_error = ?, updated_at = ? WHERE id = ?')
    .bind(`manual-retry:${newPlanId}`, args.nowMs, previous.id)
    .run();
  return newPlanId;
}

/**
 * 角色自己撤销一条待办计划（聊天工具 / manage 入口）。条件 UPDATE：
 *   - 只认同角色（charId 必须来自鉴权后的包），跨角色一律 0 行；
 *   - 只撤 proposed/scheduled 且没被租约占住；running 及以上是 0 行 → 调用方必须说「撤不了」，
 *     不许假称已撤销；
 *   - 终态不会被改回去。
 */
export async function cancelAutonomyPlanById(
  db: AutonomyDb,
  args: { planId: string; charId: string; nowMs: number; reason: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE autonomy_plans
       SET status = 'cancelled', updated_at = ?, lease_until = 0, last_error = ?
       WHERE id = ? AND char_id = ? AND status IN ('proposed', 'scheduled')
         AND (lease_until = 0 OR lease_until < ?)`,
    )
    .bind(args.nowMs, args.reason, args.planId, args.charId, args.nowMs)
    .run();
  return changesOf(result) === 1;
}

/**
 * 新提议取代前身（`predecessorId`）：**先落新计划、再撤旧计划**，所以「新提议没通过校验」
 * 永远不会误伤旧计划。同样限定同 charId + 仅 pending + 未租用。
 */
export async function cancelSupersededAutonomyPlan(
  db: AutonomyDb,
  args: { charId: string; predecessorId: string; nowMs: number },
): Promise<boolean> {
  if (!args.predecessorId) return false;
  const result = await db
    .prepare(
      `UPDATE autonomy_plans
       SET status = 'cancelled', updated_at = ?, lease_until = 0, last_error = 'superseded'
       WHERE id = ? AND char_id = ? AND status IN ('proposed', 'scheduled')
         AND (lease_until = 0 OR lease_until < ?)`,
    )
    .bind(args.nowMs, args.predecessorId, args.charId, args.nowMs)
    .run();
  return changesOf(result) === 1;
}

/** 该角色从 sinceMs 起已经排出去几次（含 running/终态；cancelled 不算）。 */
export async function countAutonomyPlansSince(
  db: AutonomyDb,
  charId: string,
  sinceMs: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total FROM autonomy_plans
       WHERE char_id = ? AND scheduled_at >= ?
         AND status IN ('scheduled', 'running', 'completed', 'failed', 'unknown')`,
    )
    .bind(charId, sinceMs)
    .first();
  return readNumber(row?.total);
}

/** 同类最近一次执行时刻（kind-gap 用）；没有回 0。 */
export async function lastAutonomyPlanOfKindAt(
  db: AutonomyDb,
  charId: string,
  kind: AutonomyWorkflowKind,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT MAX(scheduled_at) AS last_at FROM autonomy_plans
       WHERE char_id = ? AND kind = ?
         AND status IN ('scheduled', 'running', 'completed', 'failed', 'unknown')`,
    )
    .bind(charId, kind)
    .first();
  return readNumber(row?.last_at);
}

// ─── 执行预留（幂等 + token） ─────────────────────────────────────────────

export async function insertAutonomyPlanRun(
  db: AutonomyDb,
  args: {
    id: string;
    planId: string;
    charId: string;
    idempotencyKey: string;
    reservedTokens: number;
    nowMs: number;
  },
): Promise<boolean> {
  // `released` = 上一次认领了名额但**没有真的建任务**（计划认领失败 / 建任务失败后名额退回）。
  // 这种行不占「已执行」语义，却会因为唯一索引把同一个计划永久挡死（review 里那条死锁）。
  //
  // 修法**不是删掉它**：那行是「这次认领过、但没建任务」的唯一证据，删了历史审计就断了
  // （事后分不清「从没认领过」和「认领过又退回」）。改成给它换一个保留原名的幂等键
  // （`plan:<id>:released:<rowId>`），行还在、金额/时间/reason 都还在，唯一键也让出来了。
  // settled/failed/unknown 的行连键都不动——那些是真执行过的。
  await db
    .prepare(
      `UPDATE autonomy_plan_runs
          SET idempotency_key = idempotency_key || ':released:' || id, updated_at = ?
        WHERE idempotency_key = ? AND status = 'released'`,
    )
    .bind(args.nowMs, args.idempotencyKey)
    .run();
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO autonomy_plan_runs
        (id, plan_id, char_id, idempotency_key, status, reserved_tokens, actual_tokens, created_at, updated_at, error)
       VALUES (?, ?, ?, ?, 'reserved', ?, 0, ?, ?, NULL)`,
    )
    .bind(
      args.id, args.planId, args.charId, args.idempotencyKey,
      Math.max(0, Math.trunc(args.reservedTokens)), args.nowMs, args.nowMs,
    )
    .run();
  return changesOf(result) === 1;
}

export async function updateAutonomyPlanRun(
  db: AutonomyDb,
  args: {
    idempotencyKey: string;
    status: 'settled' | 'released' | 'unknown' | 'failed';
    actualTokens?: number;
    error?: string | null;
    nowMs: number;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE autonomy_plan_runs
       SET status = ?, actual_tokens = ?, error = ?, updated_at = ?
       WHERE idempotency_key = ?`,
    )
    .bind(
      args.status,
      Math.max(0, Math.trunc(args.actualTokens ?? 0)),
      args.error ?? null,
      args.nowMs,
      args.idempotencyKey,
    )
    .run();
}

/** 当日还压着没结算的预留 token（token 门要把它们算进去，防两跳之间超卖）。 */
export async function sumReservedAutonomyTokensSince(
  db: AutonomyDb,
  charId: string,
  sinceMs: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(reserved_tokens), 0) AS total FROM autonomy_plan_runs
       WHERE char_id = ? AND status = 'reserved' AND created_at >= ?`,
    )
    .bind(charId, sinceMs)
    .first();
  return readNumber(row?.total);
}

// ─── 全局共享计数（用户级） ───────────────────────────────────────────────

/**
 * 认领一次全局额度：真正共享（D1 一行/user），不信任任何角色 body。
 * 两步都是原子语句：先保证行存在，再条件 +1；只有 changes=1 的那一方拿到名额。
 */
export async function claimGlobalAutonomyBudget(
  db: AutonomyDb,
  args: { userId: string; dateKey: string; limit: number; nowMs: number },
): Promise<boolean> {
  // 0 / 负数 / 非数字 = 用户把这条闸关到零（或配置坏了）：一律不放行。
  // 以前跨日那一跳 `date <> ?` 为真就无条件 +1，limit=0 也能拿到 1 个名额。
  const limit = Math.trunc(args.limit);
  if (!Number.isFinite(limit) || limit <= 0) return false;
  await db
    .prepare('INSERT OR IGNORE INTO autonomy_global_state (user_id, date, used, updated_at) VALUES (?, ?, 0, ?)')
    .bind(args.userId, args.dateKey, args.nowMs)
    .run();
  const result = await db
    .prepare(
      `UPDATE autonomy_global_state
       SET used = CASE WHEN date = ? THEN used + 1 ELSE 1 END, date = ?, updated_at = ?
       WHERE user_id = ? AND ((date = ? AND used < ?) OR (date <> ? AND ? > 0))`,
    )
    .bind(args.dateKey, args.dateKey, args.nowMs, args.userId, args.dateKey, limit, args.dateKey, limit)
    .run();
  return changesOf(result) === 1;
}

/** 建任务失败时退回刚认领的那个名额（没发生生成，不该占额度）。 */
export async function releaseGlobalAutonomyBudget(
  db: AutonomyDb,
  args: { userId: string; dateKey: string; nowMs: number },
): Promise<void> {
  await db
    .prepare(
      `UPDATE autonomy_global_state SET used = CASE WHEN used > 0 THEN used - 1 ELSE 0 END, updated_at = ?
       WHERE user_id = ? AND date = ?`,
    )
    .bind(args.nowMs, args.userId, args.dateKey)
    .run();
}

export async function getGlobalAutonomyUsage(
  db: AutonomyDb,
  args: { userId: string; dateKey: string },
): Promise<number> {
  const row = await db
    .prepare('SELECT date, used FROM autonomy_global_state WHERE user_id = ?')
    .bind(args.userId)
    .first();
  if (!row || readString(row.date) !== args.dateKey) return 0;
  return readNumber(row.used);
}

// ─── 感知指纹 ────────────────────────────────────────────────────────────

export async function loadPerceptionSeen(
  db: AutonomyDb,
  charId: string,
  nowMs: number,
  limit = 60,
): Promise<PerceptionSeenEntry[]> {
  const rows = await db
    .prepare(
      `SELECT dedupe_key, value_hash, observed_at, expires_at FROM autonomy_perception
       WHERE char_id = ? AND expires_at > ? ORDER BY observed_at DESC LIMIT ?`,
    )
    .bind(charId, nowMs, Math.max(1, Math.trunc(limit)))
    .all();
  return (rows.results ?? [])
    .filter((row) => typeof row.dedupe_key === 'string')
    .map((row) => ({
      dedupeKey: readString(row.dedupe_key),
      valueHash: readString(row.value_hash),
      observedAt: readNumber(row.observed_at),
      expiresAt: readNumber(row.expires_at),
    }));
}

/** 记下这轮喂过的指纹（同 key 覆盖）。失败只记日志，不该拖垮这一轮。 */
export async function savePerceptionSeen(
  db: AutonomyDb,
  charId: string,
  rows: readonly PerceptionSeenEntry[],
): Promise<void> {
  for (const row of rows) {
    try {
      await db
        .prepare(
          `INSERT INTO autonomy_perception (char_id, dedupe_key, value_hash, observed_at, expires_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(char_id, dedupe_key) DO UPDATE SET
             value_hash = excluded.value_hash,
             observed_at = excluded.observed_at,
             expires_at = excluded.expires_at`,
        )
        .bind(charId, row.dedupeKey, row.valueHash, row.observedAt, row.expiresAt ?? row.observedAt)
        .run();
    } catch (error) {
      console.warn('[amsg:autonomy] 感知指纹没写进去（下一轮会重复喂一次）', charId, row.dedupeKey, error);
    }
  }
}
