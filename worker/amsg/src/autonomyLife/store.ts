/**
 * 自主生活 v1 · D1 持久化端口（worker/amsg 侧）。
 *
 * 这里实现 `LifeStorePort` / `BoundaryRepo` / `BudgetPort` 三个端口，语义与内存实现
 * （utils/autonomyLife/engine.ts 尾部、boundary.ts、budget.ts）**逐条对齐**：
 *
 *   - 动作行 / 角色状态用 `payload` JSON + 查询列双写：查询列只用于 WHERE/ORDER，
 *     权威数据永远是 payload（投影不会因为列漂移而说谎）；
 *   - 所有写都是 CAS（`WHERE revision = ?`），changes=0 一律返回冲突，不覆盖别人的更新；
 *   - **暂停 + 动作 CAS 在同一句 UPDATE 里**（`commitPermitAtomic`）：用户按下暂停与
 *     签发许可之间不存在「检查完再写」的窗口；
 *   - 许可一旦写入就带 nonce；回执只能对齐已发许可的 argsHash（engine 负责判定，
 *     store 只保证读到的就是行里的那一份）；
 *   - 表懒建（`CREATE TABLE IF NOT EXISTS`），与既有 amsg worker 的建表方式一致。
 *
 * 刻意不做的事：不在这里做鉴权 / 归属解析（路由层负责，ownerId 由会话派生后注入），
 * 也不在这里拼业务规则（策略/预算判定都在 utils/autonomyLife 里）。
 */

import {
  isTerminalActionStatus,
  type AutonomyLifeErrorCode,
  type BoundaryScope,
  type BoundaryV1,
  type CharacterLifeState,
  type LifeEvent,
} from '../../../../contracts/autonomyLife';
import {
  actionCursor,
  type ActionRow,
  type AtomicPermitCommit,
  type AtomicPermitResult,
  type CharacterLifeRow,
  type LifeStorePort,
} from '../../../../utils/autonomyLife/engine';
import type { BoundaryRepo } from '../../../../utils/autonomyLife/service';
import {
  emptyBudgetRow,
  type BudgetMutationResult,
  type BudgetPort,
  type BudgetRow,
  type BudgetScopeKey,
  type ReservationRecord,
  type ReservationUpdate,
} from '../../../../utils/autonomyLife/budget';
import type { RecentActivity } from '../../../../utils/autonomyLife/rhythm';

/* ------------------------------------------------------------------ *
 * D1 结构子集（不引未声明的 D1Database，与 travel/store.ts 同一手法）
 * ------------------------------------------------------------------ */

export interface LifeStatement {
  bind(...args: unknown[]): LifeStatement;
  run(): Promise<unknown>;
  first(): Promise<Record<string, unknown> | null>;
  all(): Promise<{ results?: Array<Record<string, unknown>> }>;
}

export interface LifeDb {
  prepare(sql: string): LifeStatement;
}

/** D1 的 `run()` 回 `{meta:{changes}}`；测试用的 sqlite 适配器回 `{changes}`。 */
export function changesOf(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  const row = result as { changes?: unknown; meta?: { changes?: unknown } };
  const raw = row.meta?.changes ?? row.changes;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
const asNumber = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */

/**
 * 表结构（additive，不改上游表）：
 *
 *   autonomy_life_accounts   —— 账号级：暂停、绑定设备、种子、事件序号
 *   autonomy_life_characters —— 角色状态（CAS）
 *   autonomy_life_actions    —— 动作行（CAS；查询列 + payload）
 *   autonomy_life_events     —— 事件流（append-only，seq 单调）
 *   autonomy_life_boundaries —— 边界（账号层 + 角色层，revision CAS）
 *   autonomy_life_budget     —— 统一预算账本（窗口 × scope）
 */
export const AUTONOMY_LIFE_DDL = [
  `CREATE TABLE IF NOT EXISTS autonomy_life_accounts (
    owner_id TEXT PRIMARY KEY,
    paused INTEGER NOT NULL DEFAULT 0,
    pause_requested_at INTEGER,
    bound_installation_id TEXT,
    seed TEXT NOT NULL,
    event_seq INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS autonomy_life_characters (
    owner_id TEXT NOT NULL,
    char_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, char_id)
  )`,
  `CREATE TABLE IF NOT EXISTS autonomy_life_actions (
    owner_id TEXT NOT NULL,
    id TEXT NOT NULL,
    char_id TEXT NOT NULL,
    status TEXT NOT NULL,
    not_before INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_autonomy_life_actions_due
    ON autonomy_life_actions (owner_id, char_id, status, not_before)`,
  `CREATE INDEX IF NOT EXISTS idx_autonomy_life_actions_page
    ON autonomy_life_actions (owner_id, char_id, created_at DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS autonomy_life_events (
    owner_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS autonomy_life_boundaries (
    owner_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    char_id TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, scope, char_id)
  )`,
  `CREATE TABLE IF NOT EXISTS autonomy_life_external_usage (
    owner_id TEXT NOT NULL,
    day_key TEXT NOT NULL,
    provider TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, day_key, provider)
  )`,
  `CREATE TABLE IF NOT EXISTS autonomy_life_wishes (
    owner_id TEXT NOT NULL,
    id TEXT NOT NULL,
    char_id TEXT NOT NULL,
    text TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, id)
  )`,
  // 绑定设备上报的真实目录候选（外卖/购物）。参数里带真实店/商品/单价/收货地址，
  // 由设备侧从既有目录与钱包选出来；worker 只校验形状/类目/单笔上限后落库，供 tick 打分。
  // 过期即不可用（真实价格与余额会变），排上动作后按 (char, kind) 回收。
  `CREATE TABLE IF NOT EXISTS autonomy_life_proposals (
    owner_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    char_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, proposal_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_autonomy_life_proposals_char
    ON autonomy_life_proposals (owner_id, char_id, kind, expires_at)`,
  `CREATE TABLE IF NOT EXISTS autonomy_life_budget (
    owner_id TEXT NOT NULL,
    window_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    used_calls INTEGER NOT NULL DEFAULT 0,
    reserved_calls INTEGER NOT NULL DEFAULT 0,
    used_tokens INTEGER NOT NULL DEFAULT 0,
    reserved_tokens INTEGER NOT NULL DEFAULT 0,
    notifications INTEGER NOT NULL DEFAULT 0,
    kind_counts TEXT NOT NULL DEFAULT '{}',
    spend_minor INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, window_id, scope)
  )`,
  // 旧自动回合的**输出效果认领**：一个回合（round_ref）只允许落一次业务产物。
  //
  // 为什么需要：`llmOutput` 可能被上游重放（同一次模型输出的 handler 再跑一遍），
  // 也可能被同一份 carried state 直接调两次。只靠「预算是 held」挡不住——第一次
  // 结算之后状态变成 settled，第二次仍能写第二批经历并再次 emitResult。这里用
  // (owner_id, round_ref) 主键 + 条件 INSERT 做**一次性**认领：抢到的那一次才允许
  // 落业务效果，且认领本身绑定到那条可信的预留记录（owner/角色/生命周期）。
  `CREATE TABLE IF NOT EXISTS autonomy_life_round_claims (
    owner_id TEXT NOT NULL,
    round_ref TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    char_id TEXT NOT NULL,
    reservation_id TEXT NOT NULL,
    output_hash TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_id, round_ref)
  )`,
  // 效果/决策的一次性认领（出行模型结果 → 愿望/行程、外部窗口决策位）。
  //
  // 为什么单独一张表：这些效果的「额度」住在预算行里（通知/kind 计数），但**能不能核销**
  // 还取决于当时的账号/角色边界与外部授权。核销语句必须把边界 revision 与授权放进同一条
  // WHERE（D1 没有跨语句事务，先读后写就是竞态窗口），成功核销再留一行可追溯记录。
  `CREATE TABLE IF NOT EXISTS autonomy_life_effect_claims (
    owner_id TEXT NOT NULL,
    claim_ref TEXT NOT NULL,
    char_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    window_id TEXT NOT NULL,
    notification INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'claimed',
    revision INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_id, claim_ref)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_autonomy_life_effect_claims_window
    ON autonomy_life_effect_claims (owner_id, window_id, kind)`,
  // 预留凭据：许可签发/外部副作用前按 id 查这一条（不是看「本窗口有过用量」）。
  `CREATE TABLE IF NOT EXISTS autonomy_life_budget_reservations (
    owner_id TEXT NOT NULL,
    reservation_id TEXT NOT NULL,
    window_id TEXT NOT NULL,
    char_id TEXT NOT NULL,
    counter INTEGER NOT NULL,
    kind TEXT,
    plan_ref TEXT,
    calls INTEGER NOT NULL,
    tokens INTEGER NOT NULL,
    state TEXT NOT NULL,
    action_id TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    settled_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_id, reservation_id)
  )`,
] as const;

let schemaReady = false;

export async function ensureAutonomyLifeSchema(db: LifeDb): Promise<void> {
  if (schemaReady) return;
  for (const statement of AUTONOMY_LIFE_DDL) {
    await db.prepare(statement).run();
  }
  schemaReady = true;
}

export function resetAutonomyLifeSchemaCacheForTesting(): void {
  schemaReady = false;
}

/* ------------------------------------------------------------------ *
 * 账号行（暂停 / 绑定设备 / 种子）
 * ------------------------------------------------------------------ */

interface AccountRow {
  paused: boolean;
  pauseRequestedAt: number | null;
  boundInstallationId: string | null;
  seed: string;
  eventSeq: number;
}

const parseJson = <T>(text: unknown, fallback: T): T => {
  if (typeof text !== 'string' || !text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

async function readAccount(db: LifeDb, ownerId: string, nowMs: number): Promise<AccountRow> {
  const row = await db
    .prepare('SELECT paused, pause_requested_at, bound_installation_id, seed, event_seq FROM autonomy_life_accounts WHERE owner_id = ?')
    .bind(ownerId)
    .first();
  if (row) {
    return {
      paused: asNumber(row.paused) === 1,
      pauseRequestedAt: row.pause_requested_at === null ? null : asNumber(row.pause_requested_at),
      boundInstallationId: typeof row.bound_installation_id === 'string' ? row.bound_installation_id : null,
      seed: asString(row.seed) || `seed_${ownerId}`,
      eventSeq: asNumber(row.event_seq),
    };
  }
  const seed = `seed_${ownerId}`;
  await db
    .prepare('INSERT OR IGNORE INTO autonomy_life_accounts (owner_id, paused, pause_requested_at, bound_installation_id, seed, event_seq, updated_at) VALUES (?, 0, NULL, NULL, ?, 0, ?)')
    .bind(ownerId, seed, nowMs)
    .run();
  return { paused: false, pauseRequestedAt: null, boundInstallationId: null, seed, eventSeq: 0 };
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

export interface D1LifeStoreOptions {
  db: LifeDb;
  ownerId: string;
  /** 服务端时钟（测试可注入）。 */
  now?: () => number;
}

/**
 * `LifeStorePort` 的 D1 实现。一个实例绑定一个 ownerId —— ownerId 从不会来自请求体，
 * 每个 SQL 都带 `owner_id = ?`，跨账号读写不可能只靠「前端没传」发生。
 */
export function createD1LifeStore(options: D1LifeStoreOptions): LifeStorePort & {
  /** 供路由/调度层复用账号行。 */
  readAccount(): Promise<AccountRow>;
  /** 心跳：设备每次带 installationId 调 API 时刷新，调度器据此判在线。 */
  touchInstallation(installationId: string): Promise<void>;
  seed(): Promise<string>;
} {
  const { db, ownerId } = options;
  const now = options.now ?? (() => Date.now());

  const rowFromPayload = (payload: unknown): ActionRow => payload as ActionRow;

  const readAction = async (actionId: string): Promise<ActionRow | null> => {
    const row = await db
      .prepare('SELECT payload FROM autonomy_life_actions WHERE owner_id = ? AND id = ?')
      .bind(ownerId, actionId)
      .first();
    return row ? rowFromPayload(parseJson(row.payload, null)) : null;
  };

  return {
    async readAccount() {
      return readAccount(db, ownerId, now());
    },

    async seed() {
      return (await readAccount(db, ownerId, now())).seed;
    },

    async touchInstallation(installationId: string) {
      await db
        .prepare('UPDATE autonomy_life_accounts SET updated_at = ? WHERE owner_id = ? AND bound_installation_id = ?')
        .bind(now(), ownerId, installationId)
        .run();
    },

    async getCharacterLife(charId) {
      const row = await db
        .prepare('SELECT payload FROM autonomy_life_characters WHERE owner_id = ? AND char_id = ?')
        .bind(ownerId, charId)
        .first();
      return row ? (parseJson(row.payload, null) as CharacterLifeRow | null) : null;
    },

    async putCharacterLife(row, expectedRevision) {
      const text = JSON.stringify(row);
      const updated = await db
        .prepare('UPDATE autonomy_life_characters SET payload = ?, revision = ?, updated_at = ? WHERE owner_id = ? AND char_id = ? AND revision = ?')
        .bind(text, row.revision, now(), ownerId, row.charId, expectedRevision)
        .run();
      if (changesOf(updated) > 0) return true;
      if (expectedRevision !== 0) return false;
      const inserted = await db
        .prepare('INSERT OR IGNORE INTO autonomy_life_characters (owner_id, char_id, revision, payload, updated_at) VALUES (?, ?, ?, ?, ?)')
        .bind(ownerId, row.charId, row.revision, text, now())
        .run();
      return changesOf(inserted) > 0;
    },

    async getAction(actionId) {
      return readAction(actionId);
    },

    async insertAction(row) {
      const result = await db
        .prepare('INSERT OR IGNORE INTO autonomy_life_actions (owner_id, id, char_id, status, not_before, expires_at, created_at, revision, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(ownerId, row.id, row.charId, row.status, row.notBefore, row.expiresAt, row.createdAt, row.revision, JSON.stringify(row), now())
        .run();
      return changesOf(result) > 0;
    },

    async putAction(row, expectedRevision) {
      const result = await db
        .prepare('UPDATE autonomy_life_actions SET status = ?, not_before = ?, expires_at = ?, revision = ?, payload = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND revision = ?')
        .bind(row.status, row.notBefore, row.expiresAt, row.revision, JSON.stringify(row), now(), ownerId, row.id, expectedRevision)
        .run();
      return changesOf(result) > 0;
    },

    async dueActions(charId, nowMs, limit) {
      const result = await db
        .prepare(`SELECT payload FROM autonomy_life_actions
          WHERE owner_id = ? AND char_id = ? AND status IN ('scheduled', 'waiting_device') AND not_before <= ?
          ORDER BY not_before ASC, created_at ASC LIMIT ?`)
        .bind(ownerId, charId, nowMs, Math.max(1, Math.trunc(limit)))
        .all();
      return (result?.results ?? []).map((row) => rowFromPayload(parseJson(row.payload, null))).filter(Boolean) as ActionRow[];
    },

    async listActions({ charId, status, limit, cursor }) {
      // 游标与 engine.actionCursor 同口径：`<createdAt>.<id>`，稳定降序。
      let cursorAt: number | null = null;
      let cursorId: string | null = null;
      if (cursor) {
        const index = cursor.indexOf('.');
        if (index > 0) {
          const at = Number(cursor.slice(0, index));
          const id = cursor.slice(index + 1);
          if (Number.isFinite(at) && id) {
            cursorAt = at;
            cursorId = id;
          }
        }
      }
      const clauses = ['owner_id = ?', 'char_id = ?'];
      const params: unknown[] = [ownerId, charId];
      if (status) {
        clauses.push('status = ?');
        params.push(status);
      }
      if (cursorAt !== null && cursorId !== null) {
        clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
        params.push(cursorAt, cursorAt, cursorId);
      }
      const result = await db
        .prepare(`SELECT payload FROM autonomy_life_actions WHERE ${clauses.join(' AND ')}
          ORDER BY created_at DESC, id DESC LIMIT ?`)
        .bind(...params, Math.max(1, Math.trunc(limit)))
        .all();
      const items = (result?.results ?? [])
        .map((row) => rowFromPayload(parseJson(row.payload, null)))
        .filter(Boolean) as ActionRow[];
      const nextCursor = items.length === Math.max(1, Math.trunc(limit)) ? actionCursor(items[items.length - 1]) : null;
      return { items, nextCursor };
    },

    async recentActivities(charId, sinceMs) {
      const result = await db
        .prepare(`SELECT created_at, payload FROM autonomy_life_actions
          WHERE owner_id = ? AND char_id = ? AND created_at >= ?
          ORDER BY created_at DESC LIMIT 50`)
        .bind(ownerId, charId, sinceMs)
        .all();
      return (result?.results ?? [])
        .map((row) => rowFromPayload(parseJson(row.payload, null)))
        .filter((row): row is ActionRow => !!row && isTerminalActionStatus(row.status))
        .filter((row) => row.status === 'succeeded')
        .map((row): RecentActivity => ({
          kind: row.kind,
          semanticPurpose: row.semanticPurpose,
          occurredAt: row.createdAt,
          success: true,
        }));
    },

    async appendEvent(event: LifeEvent) {
      // seq 在同一句里取 MAX+1：单用户 worker 上足够，且不需要额外往返。
      await db
        .prepare(`INSERT INTO autonomy_life_events (owner_id, seq, payload, created_at)
          SELECT ?, COALESCE((SELECT MAX(seq) FROM autonomy_life_events WHERE owner_id = ?), 0) + 1, ?, ?`)
        .bind(ownerId, ownerId, JSON.stringify(event), now())
        .run();
    },

    async getAccountPause(_accountId: string) {
      const account = await readAccount(db, ownerId, now());
      return { paused: account.paused, requestedAt: account.pauseRequestedAt };
    },

    async setAccountPause(_accountId: string, paused: boolean, nowMs: number) {
      await readAccount(db, ownerId, nowMs);
      await db
        .prepare('UPDATE autonomy_life_accounts SET paused = ?, pause_requested_at = ?, updated_at = ? WHERE owner_id = ?')
        .bind(paused ? 1 : 0, paused ? nowMs : null, nowMs, ownerId)
        .run();
    },

    async inflightPermits(_accountId: string, nowMs: number) {
      // 一律按 payload 判定：查询列只服务于索引，许可字段不重复存列（避免双份真相）。
      const result = await db
        .prepare(`SELECT payload FROM autonomy_life_actions WHERE owner_id = ? AND status = 'running'`)
        .bind(ownerId)
        .all()
        .catch(() => ({ results: [] }));
      const rows = (result?.results ?? [])
        .map((row) => rowFromPayload(parseJson(row.payload, null)))
        .filter(Boolean) as ActionRow[];
      return rows.filter((row) =>
        row.permitIssuedAt !== null
        && row.permitConsumedAt === null
        && (row.leaseExpiresAt ?? 0) > nowMs).length;
    },

    async getBoundInstallation(_accountId: string) {
      return (await readAccount(db, ownerId, now())).boundInstallationId;
    },

    async bindInstallation(_accountId: string, installationId: string, nowMs: number) {
      await readAccount(db, ownerId, nowMs);
      const bound = await db
        .prepare(`UPDATE autonomy_life_accounts SET bound_installation_id = ?, updated_at = ?
          WHERE owner_id = ? AND (bound_installation_id IS NULL OR bound_installation_id = ?)`)
        .bind(installationId, nowMs, ownerId, installationId)
        .run();
      return changesOf(bound) > 0;
    },

    /**
     * 「暂停读取 + 动作 CAS」同一句：暂停是 WHERE 里的 EXISTS，不是先读后写。
     * changes=0 时再读一次区分原因（只用于错误码，不参与判定）。
     */
    async commitPermitAtomic(input: AtomicPermitCommit): Promise<AtomicPermitResult> {
      const current = await readAction(input.actionId);
      if (!current) return { ok: false, code: 'NOT_FOUND' };
      if (current.charId !== input.charId) return { ok: false, code: 'FORBIDDEN' };
      if (!input.installationId || !current.installationId || current.installationId !== input.installationId) {
        return { ok: false, code: 'FORBIDDEN' };
      }
      if (isTerminalActionStatus(current.status)) return { ok: false, code: 'STATE_CONFLICT' };
      // 只有「已 claim、未发许可」的动作能发许可（status=waiting_device 表示还没设备领走）。
      if (current.status !== 'scheduled') return { ok: false, code: 'STATE_CONFLICT' };
      if (current.permitIssuedAt !== null) return { ok: false, code: 'STATE_CONFLICT' };
      if (current.leaseEpoch !== input.leaseEpoch || current.leaseEpoch < 1) return { ok: false, code: 'STATE_CONFLICT' };
      if (current.leaseExpiresAt === null || input.nowMs > current.leaseExpiresAt) return { ok: false, code: 'STATE_CONFLICT' };
      if (current.windowId !== input.expectedWindowId) return { ok: false, code: 'STATE_CONFLICT' };
      if (current.argsHash !== input.argsHash) return { ok: false, code: 'STATE_CONFLICT' };
      if (current.policyVersion !== input.policyVersion) return { ok: false, code: 'STATE_CONFLICT' };
      if (current.permitConsumedAt !== null) return { ok: false, code: 'STATE_CONFLICT' };
      if (input.nowMs > current.expiresAt) return { ok: false, code: 'STATE_CONFLICT' };

      const next: ActionRow = {
        ...current,
        status: 'running',
        permitIssuedAt: input.nowMs,
        permitNonce: input.nonce,
        permitConsumedAt: null,
        leaseExpiresAt: input.expiresAt,
        revision: current.revision + 1,
      };

      // 一句 UPDATE 承担全部线性化条件：动作 CAS + 账号暂停 + 角色暂停 + 预算窗口
      // + **边界两层 revision**（撤销授权/改限额/改禁区都会让 revision 变）。
      // 边界 revision 传 null 时 COALESCE(...,-1) = NULL 恒不成立 → fail closed。
      const updated = await db
        .prepare(`UPDATE autonomy_life_actions
          SET status = 'running', revision = revision + 1, payload = ?, updated_at = ?
          WHERE owner_id = ? AND id = ? AND revision = ?
            AND status = 'scheduled'
            AND json_extract(payload, '$.windowId') = ?
            AND COALESCE((SELECT revision FROM autonomy_life_boundaries
                  WHERE owner_id = ? AND scope = 'account' AND char_id = ''), -1) = ?
            AND COALESCE((SELECT revision FROM autonomy_life_boundaries
                  WHERE owner_id = ? AND scope = 'character' AND char_id = ?), -1) = ?
            AND EXISTS (
              SELECT 1 FROM autonomy_life_accounts a
              WHERE a.owner_id = autonomy_life_actions.owner_id AND a.paused = 0
            )
            AND NOT EXISTS (
              SELECT 1 FROM autonomy_life_characters c
              WHERE c.owner_id = autonomy_life_actions.owner_id
                AND c.char_id = autonomy_life_actions.char_id
                AND json_extract(c.payload, '$.pauseRequestedAt') IS NOT NULL
            )
            AND EXISTS (
              SELECT 1 FROM autonomy_life_budget_reservations r
              WHERE r.owner_id = autonomy_life_actions.owner_id
                AND r.reservation_id = json_extract(autonomy_life_actions.payload, '$.reservationId')
                AND r.state != 'released'
                AND COALESCE(r.action_id, '') = autonomy_life_actions.id
                AND r.revision = ?
                AND r.expires_at > ?
            )`)
        .bind(
          JSON.stringify(next),
          input.nowMs,
          ownerId,
          input.actionId,
          input.expectedRevision,
          input.expectedWindowId,
          ownerId,
          input.expectedAccountBoundaryRevision ?? null,
          ownerId,
          input.charId,
          input.expectedCharacterBoundaryRevision ?? -1,
          input.expectedReservationRevision ?? -1,
          input.nowMs,
        )
        .run();

      if (changesOf(updated) > 0) return { ok: true, action: next };

      // 失败原因（非原子，只用于把错误说准）：
      const pause = await readAccount(db, ownerId, input.nowMs);
      if (pause.paused) return { ok: false, code: 'GLOBAL_PAUSED' };
      const life = await db
        .prepare('SELECT payload FROM autonomy_life_characters WHERE owner_id = ? AND char_id = ?')
        .bind(ownerId, input.charId)
        .first();
      const lifeRow = life ? (parseJson(life.payload, null) as CharacterLifeRow | null) : null;
      if (lifeRow?.pauseRequestedAt != null) return { ok: false, code: 'GLOBAL_PAUSED' };
      return { ok: false, code: 'STATE_CONFLICT' };
    },
  };
}

/* ------------------------------------------------------------------ *
 * 外部窗口：服务端核销一次性许可（副作用只在这里发生）
 * ------------------------------------------------------------------ */

export interface ConsumeExternalPermitInput {
  actionId: string;
  charId: string;
  installationId: string;
  leaseEpoch: number;
  argsHash: string;
  nonce: string;
  kind: 'external.read' | 'travel.wish';
  nowMs: number;
  expectedRevision: number;
  expectedWindowId: string;
  expectedAccountBoundaryRevision: number | null;
  expectedCharacterBoundaryRevision: number | null;
  /** 同一窗口内同类动作的当前上限（null = 不限）；条件 UPDATE 里原子核验。 */
  maxKindActions: number | null;
  /** 核销前读到的预留凭据 revision（同一条 UPDATE 里核，防「读完凭据后被释放」）。 */
  expectedReservationRevision?: number | null;
}

/**
 * 外部副作用（出网读 / 落出行愿望）之前**服务端**核销一次性许可。
 *
 * 为什么要在服务端核销：这两类动作的副作用不在浏览器里——授权、白名单、配额、出网
 * 都在 worker。如果只在浏览器侧核销本地许可，重放同一个请求就能重复出网/重复落愿望。
 * 这里用一条条件 UPDATE 同时校验：动作 CAS、kind、设备、租约、参数 hash、nonce、
 * 未消费、未过期、预算窗口、账号暂停、角色暂停、两层边界 revision（撤销授权会变）。
 * changes=0 = 一个字节都不写。
 */
export async function consumeExternalPermitAtomic(
  options: { db: LifeDb; ownerId: string },
  input: ConsumeExternalPermitInput,
): Promise<{ ok: true; action: ActionRow } | { ok: false; code: AutonomyLifeErrorCode }> {
  const { db, ownerId } = options;
  const current = await db
    .prepare('SELECT payload FROM autonomy_life_actions WHERE owner_id = ? AND id = ?')
    .bind(ownerId, input.actionId)
    .first()
    .catch(() => null);
  const row = current ? (parseJson(current.payload, null) as ActionRow | null) : null;
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  if (row.charId !== input.charId || row.kind !== input.kind) return { ok: false, code: 'FORBIDDEN' };
  if (!input.installationId || !row.installationId || row.installationId !== input.installationId) {
    return { ok: false, code: 'FORBIDDEN' };
  }
  if (row.leaseEpoch !== input.leaseEpoch || row.argsHash !== input.argsHash) {
    return { ok: false, code: 'STATE_CONFLICT' };
  }
  if (!row.permitNonce || !input.nonce || row.permitNonce !== input.nonce) {
    return { ok: false, code: 'STATE_CONFLICT' };
  }
  if (row.permitIssuedAt === null || row.status !== 'running' || row.permitConsumedAt !== null) {
    return { ok: false, code: 'STATE_CONFLICT' };
  }
  if (row.leaseExpiresAt === null || input.nowMs > row.leaseExpiresAt) {
    return { ok: false, code: 'STATE_CONFLICT' };
  }
  if (row.windowId !== input.expectedWindowId) return { ok: false, code: 'STATE_CONFLICT' };

  const next: ActionRow = { ...row, permitConsumedAt: input.nowMs, revision: row.revision + 1 };
  const updated = await db
    .prepare(`UPDATE autonomy_life_actions
      SET revision = revision + 1, payload = ?, updated_at = ?
      WHERE owner_id = ? AND id = ? AND revision = ?
        AND status = 'running'
        AND json_extract(payload, '$.kind') = ?
        AND json_extract(payload, '$.installationId') = ?
        AND json_extract(payload, '$.leaseEpoch') = ?
        AND json_extract(payload, '$.argsHash') = ?
        AND json_extract(payload, '$.permitNonce') = ?
        AND json_extract(payload, '$.permitIssuedAt') IS NOT NULL
        AND json_extract(payload, '$.permitConsumedAt') IS NULL
        AND COALESCE(json_extract(payload, '$.leaseExpiresAt'), -1) >= ?
        AND json_extract(payload, '$.windowId') = ?
        AND COALESCE((SELECT revision FROM autonomy_life_boundaries
              WHERE owner_id = ? AND scope = 'account' AND char_id = ''), -1) = ?
        AND COALESCE((SELECT revision FROM autonomy_life_boundaries
              WHERE owner_id = ? AND scope = 'character' AND char_id = ?), -1) = ?
        AND EXISTS (
          SELECT 1 FROM autonomy_life_accounts a
          WHERE a.owner_id = autonomy_life_actions.owner_id AND a.paused = 0
        )
        AND NOT EXISTS (
          SELECT 1 FROM autonomy_life_characters c
          WHERE c.owner_id = autonomy_life_actions.owner_id
            AND c.char_id = autonomy_life_actions.char_id
            AND json_extract(c.payload, '$.pauseRequestedAt') IS NOT NULL
        )
        AND EXISTS (
          SELECT 1 FROM autonomy_life_budget_reservations r
          WHERE r.owner_id = autonomy_life_actions.owner_id
            AND r.reservation_id = json_extract(autonomy_life_actions.payload, '$.reservationId')
            AND r.state != 'released'
            AND COALESCE(r.action_id, '') = autonomy_life_actions.id
            AND r.revision = ?
            AND r.expires_at > ?
        )
        AND (
          ? IS NULL OR (
            SELECT COUNT(*) FROM autonomy_life_actions x
            WHERE x.owner_id = autonomy_life_actions.owner_id
              AND x.char_id = autonomy_life_actions.char_id
              AND x.id != autonomy_life_actions.id
              AND COALESCE(json_extract(x.payload, '$.kind'), '') = ?
              AND COALESCE(json_extract(x.payload, '$.windowId'), '') = ?
          ) < ?
        )`)
    .bind(
      JSON.stringify(next),
      input.nowMs,
      ownerId,
      input.actionId,
      input.expectedRevision,
      input.kind,
      input.installationId,
      input.leaseEpoch,
      input.argsHash,
      input.nonce,
      input.nowMs,
      input.expectedWindowId,
      ownerId,
      input.expectedAccountBoundaryRevision ?? null,
      ownerId,
      input.charId,
      input.expectedCharacterBoundaryRevision ?? -1,
      input.expectedReservationRevision ?? -1,
      input.nowMs,
      input.maxKindActions,
      input.kind,
      input.expectedWindowId,
      input.maxKindActions,
    )
    .run();

  if (changesOf(updated) > 0) return { ok: true, action: next };

  // 失败原因（非原子，只用于把错误说准）。
  const pause = await readAccount(db, ownerId, input.nowMs);
  if (pause.paused) return { ok: false, code: 'GLOBAL_PAUSED' };
  const life = await db
    .prepare('SELECT payload FROM autonomy_life_characters WHERE owner_id = ? AND char_id = ?')
    .bind(ownerId, input.charId)
    .first();
  const lifeRow = life ? (parseJson(life.payload, null) as CharacterLifeRow | null) : null;
  if (lifeRow?.pauseRequestedAt != null) return { ok: false, code: 'GLOBAL_PAUSED' };
  return { ok: false, code: 'STATE_CONFLICT' };
}

/* ------------------------------------------------------------------ *
 * 边界仓库
 * ------------------------------------------------------------------ */

/** D1 版 `BoundaryRepo`：账号层一行 + 每个角色层一行，写都是 revision CAS。 */
export function createD1BoundaryRepo(options: { db: LifeDb; ownerId: string; defaultBoundary: BoundaryV1 }): BoundaryRepo {
  const { db, ownerId } = options;
  const read = async (scope: BoundaryScope, charId: string): Promise<BoundaryV1 | null> => {
    const row = await db
      .prepare('SELECT payload FROM autonomy_life_boundaries WHERE owner_id = ? AND scope = ? AND char_id = ?')
      .bind(ownerId, scope, scope === 'account' ? '' : charId)
      .first();
    return row ? (parseJson(row.payload, null) as BoundaryV1 | null) : null;
  };

  return {
    async getAccount() {
      const existing = await read('account', '');
      if (existing) return existing;
      // 懒建账号边界行：许可条件 UPDATE 用「账号边界 revision」做并发 CAS，
      // 没有行就只能退回 -1，会让每次签许可都失败（或把缺行当成「最新」）。
      // 这里像 account 行一样按默认值建一行 revision=0，之后所有写都是 CAS。
      await db
        .prepare('INSERT OR IGNORE INTO autonomy_life_boundaries (owner_id, scope, char_id, revision, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(ownerId, 'account', '', options.defaultBoundary.revision, JSON.stringify(options.defaultBoundary), Date.now())
        .run();
      return (await read('account', '')) ?? options.defaultBoundary;
    },
    async getCharacter(charId) {
      return read('character', charId);
    },
    async put(target, boundary, expectedRevision) {
      const scope: BoundaryScope = target.scope;
      const charId = target.scope === 'character' ? target.charId : '';
      const text = JSON.stringify(boundary);
      const nowMs = Date.now();
      const updated = await db
        .prepare('UPDATE autonomy_life_boundaries SET payload = ?, revision = ?, updated_at = ? WHERE owner_id = ? AND scope = ? AND char_id = ? AND revision = ?')
        .bind(text, boundary.revision, nowMs, ownerId, scope, charId, expectedRevision)
        .run();
      if (changesOf(updated) > 0) return true;
      // 首次写入（没有行）才允许 INSERT；已有行但 revision 不符 = 冲突。
      const existing = await read(scope, charId);
      if (existing) return false;
      const inserted = await db
        .prepare('INSERT OR IGNORE INTO autonomy_life_boundaries (owner_id, scope, char_id, revision, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(ownerId, scope, charId, boundary.revision, text, nowMs)
        .run();
      return changesOf(inserted) > 0;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 预算端口
 * ------------------------------------------------------------------ */

const budgetKey = (windowId: string, scope: BudgetScopeKey): string => `${windowId}::${scope}`;

const rowFromBudget = (record: Record<string, unknown>): BudgetRow => ({
  windowId: asString(record.window_id),
  scope: asString(record.scope),
  usedCalls: asNumber(record.used_calls),
  reservedCalls: asNumber(record.reserved_calls),
  usedTokens: asNumber(record.used_tokens),
  reservedTokens: asNumber(record.reserved_tokens),
  notifications: asNumber(record.notifications),
  kindCounts: parseJson<Record<string, number>>(record.kind_counts, {}),
  spendMinor: asNumber(record.spend_minor),
  revision: asNumber(record.revision),
  updatedAt: asNumber(record.updated_at),
});

const rowFromReservation = (record: Record<string, unknown>): ReservationRecord => ({
  reservationId: asString(record.reservation_id),
  counter: asNumber(record.counter),
  ownerId: asString(record.owner_id),
  windowId: asString(record.window_id),
  charId: asString(record.char_id),
  kind: typeof record.kind === 'string' ? record.kind : null,
  planRef: typeof record.plan_ref === 'string' ? record.plan_ref : null,
  calls: asNumber(record.calls),
  tokens: asNumber(record.tokens),
  state: record.state === 'settled' || record.state === 'released' ? record.state : 'held',
  actionId: typeof record.action_id === 'string' && record.action_id ? record.action_id : null,
  createdAt: asNumber(record.created_at),
  expiresAt: asNumber(record.expires_at),
  settledAt: record.settled_at === null || record.settled_at === undefined ? null : asNumber(record.settled_at),
  revision: asNumber(record.revision),
});

/**
 * D1 版预算端口。
 *
 * 原子性：D1 没有交互式事务，这里用「同 isolate 串行队列 + 每行 revision CAS」实现：
 *   - 串行队列消掉同一 isolate 内的读改写交错；
 *   - 写入带 `WHERE revision = ?`，跨 isolate 的并发会 changes=0 → 整批重读重试；
 *   - 重试 3 次仍冲突 → 返回 null（引擎按 fail-closed 处理，不会超额）。
 */
export function createD1BudgetPort(options: { db: LifeDb; ownerId: string }): BudgetPort {
  const { db, ownerId } = options;
  let queue: Promise<unknown> = Promise.resolve();

  const readRows = async (windowId: string, scopes: BudgetScopeKey[]): Promise<Record<string, BudgetRow>> => {
    const rows: Record<string, BudgetRow> = {};
    for (const scope of scopes) {
      const row = await db
        .prepare('SELECT * FROM autonomy_life_budget WHERE owner_id = ? AND window_id = ? AND scope = ?')
        .bind(ownerId, windowId, scope)
        .first();
      rows[scope] = row ? rowFromBudget(row) : emptyBudgetRow(windowId, scope, Date.now());
    }
    return rows;
  };

  const readReservation = async (reservationId: string): Promise<ReservationRecord | null> => {
    const row = await db
      .prepare('SELECT * FROM autonomy_life_budget_reservations WHERE owner_id = ? AND reservation_id = ?')
      .bind(ownerId, String(reservationId ?? '').trim())
      .first();
    return row ? rowFromReservation(row) : null;
  };

  const readReservations = async (ids: string[]): Promise<Record<string, ReservationRecord>> => {
    const out: Record<string, ReservationRecord> = {};
    for (const id of ids) {
      const record = await readReservation(id);
      if (record) out[id] = record;
    }
    return out;
  };

  const writeRow = async (row: BudgetRow, expectedRevision: number, created: boolean): Promise<boolean> => {
    if (created) {
      const inserted = await db
        .prepare(`INSERT OR IGNORE INTO autonomy_life_budget
          (owner_id, window_id, scope, used_calls, reserved_calls, used_tokens, reserved_tokens, notifications, kind_counts, spend_minor, revision, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          ownerId, row.windowId, row.scope, row.usedCalls, row.reservedCalls, row.usedTokens, row.reservedTokens,
          row.notifications, JSON.stringify(row.kindCounts), row.spendMinor, row.revision, row.updatedAt,
        )
        .run();
      return changesOf(inserted) > 0;
    }
    const updated = await db
      .prepare(`UPDATE autonomy_life_budget SET used_calls = ?, reserved_calls = ?, used_tokens = ?, reserved_tokens = ?,
        notifications = ?, kind_counts = ?, spend_minor = ?, revision = ?, updated_at = ?
        WHERE owner_id = ? AND window_id = ? AND scope = ? AND revision = ?`)
      .bind(
        row.usedCalls, row.reservedCalls, row.usedTokens, row.reservedTokens, row.notifications,
        JSON.stringify(row.kindCounts), row.spendMinor, row.revision, row.updatedAt,
        ownerId, row.windowId, row.scope, expectedRevision,
      )
      .run();
    return changesOf(updated) > 0;
  };

  /**
   * 预留记录写入（与预算行同一次 mutate 调用）。
   *   - expectedRevision = -1 → 新建（INSERT OR IGNORE：同 id 已存在 = 冲突，不覆盖）；
   *   - 否则 `WHERE revision = ?` 条件更新（结算/释放都走这条）。
   */
  const writeReservation = async (update: ReservationUpdate): Promise<boolean> => {
    const record = update.reservation;
    if (update.expectedRevision === -1) {
      const inserted = await db
        .prepare(`INSERT OR IGNORE INTO autonomy_life_budget_reservations
          (owner_id, reservation_id, window_id, char_id, counter, kind, plan_ref, calls, tokens, state, action_id, created_at, expires_at, settled_at, revision)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          ownerId, record.reservationId, record.windowId, record.charId, record.counter, record.kind, record.planRef,
          record.calls, record.tokens, record.state, record.actionId, record.createdAt, record.expiresAt,
          record.settledAt, record.revision,
        )
        .run();
      return changesOf(inserted) > 0;
    }
    const updated = await db
      .prepare(`UPDATE autonomy_life_budget_reservations
        SET state = ?, settled_at = ?, revision = ?
        WHERE owner_id = ? AND reservation_id = ? AND revision = ?`)
      .bind(
        record.state, record.settledAt, record.revision,
        ownerId, record.reservationId, update.expectedRevision,
      )
      .run();
    return changesOf(updated) > 0;
  };

  return {
    available: () => true,
    readReservation,
    async bindReservation(input) {
      const updated = await db
        .prepare(`UPDATE autonomy_life_budget_reservations
          SET action_id = ?, revision = revision + 1
          WHERE owner_id = ? AND reservation_id = ? AND action_id IS NULL
            AND state != 'released' AND window_id = ? AND char_id = ?`)
        .bind(input.actionId, ownerId, input.reservationId, input.windowId, input.charId)
        .run();
      if (changesOf(updated) > 0) return true;
      // 幂等：同一张凭据再次绑同一条动作算成功；绑到别的动作/别的角色一律 false。
      const existing = await readReservation(input.reservationId);
      return !!existing
        && existing.actionId === input.actionId
        && existing.windowId === input.windowId
        && existing.charId === input.charId;
    },
    mutate<T>(
      windowId: string,
      scopes: BudgetScopeKey[],
      mutator: (
        rows: Record<string, BudgetRow>,
        reservations: Record<string, ReservationRecord>,
      ) => BudgetMutationResult<T> | null,
      reservationIds: string[] = [],
    ): Promise<T | null> {
      const run = async (): Promise<T | null> => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const existing = await readRows(windowId, scopes);
          const snapshot: Record<string, BudgetRow> = {};
          for (const scope of scopes) {
            snapshot[scope] = { ...existing[scope], kindCounts: { ...existing[scope].kindCounts } };
          }
          const held = await readReservations(reservationIds);
          const outcome = mutator(snapshot, held);
          if (!outcome) return null;
          // 预留记录先落（条件更新失败 = 凭据状态已变，整笔放弃，不再写预算行）。
          let reservationsOk = true;
          for (const update of outcome.reservations ?? []) {
            if (!(await writeReservation(update))) {
              reservationsOk = false;
              break;
            }
          }
          if (!reservationsOk) return null;
          let ok = true;
          for (const row of outcome.updates) {
            const before = existing[row.scope];
            const created = !before || before.revision === 0;
            const wrote = await writeRow({ ...row, revision: (before?.revision ?? 0) + 1 }, before?.revision ?? 0, created);
            if (!wrote) {
              ok = false;
              break;
            }
          }
          if (ok) return outcome.result;
        }
        return null;
      };
      const next = queue.then(run, run);
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 只读投影（路由层给 UI 的当前窗口预算行）
 * ------------------------------------------------------------------ */

export async function readBudgetRows(options: {
  db: LifeDb;
  ownerId: string;
  charId: string;
  windowId: string;
}): Promise<{ account: BudgetRow | null; char: BudgetRow | null }> {
  const { db, ownerId, charId, windowId } = options;
  const read = async (scope: BudgetScopeKey): Promise<BudgetRow | null> => {
    const row = await db
      .prepare('SELECT * FROM autonomy_life_budget WHERE owner_id = ? AND window_id = ? AND scope = ?')
      .bind(ownerId, windowId, scope)
      .first();
    return row ? rowFromBudget(row) : null;
  };
  return { account: await read('account'), char: await read(charId) };
}

/* ------------------------------------------------------------------ *
 * 统一配额核销（提醒 / kind 效果）：边界 revision + 授权在同一条语句里
 * ------------------------------------------------------------------ */

export type QuotaConsumeFailure =
  | 'invalid_input'
  | 'boundary_changed'
  | 'notifications_exhausted'
  | 'kind_exhausted'
  | 'external_quota_exhausted'
  | 'claim_exists'
  | 'store_unavailable';

/**
 * 读**真实暂停落点**（不是边界 payload 里的 volatile 标记）：
 *   - 账号层：`POST /pause` → `requestPause` → `autonomy_life_accounts.paused = 1`；
 *   - 角色层：`POST /pause` → `service.pause` → `autonomy_life_characters.payload.pauseRequestedAt`。
 *
 * 只用于「0 行之后把原因说准」与 read-side 判定；原子判定在 SQL 条件里各写一遍。
 * 读失败按「暂停」处理（fail closed），避免把存储故障说成额度问题。
 */
export async function readRealPause(options: {
  db: LifeDb;
  ownerId: string;
  charId: string;
}): Promise<boolean> {
  try {
    const row = await options.db
      .prepare(`SELECT
          (SELECT COALESCE(paused, 0) FROM autonomy_life_accounts WHERE owner_id = ?) AS account_paused,
          (SELECT json_extract(payload, '$.pauseRequestedAt') FROM autonomy_life_characters
            WHERE owner_id = ? AND char_id = ?) AS char_pause_requested_at`)
      .bind(options.ownerId, options.ownerId, options.charId)
      .first();
    return Number(row?.account_paused ?? 0) !== 0 || row?.char_pause_requested_at != null;
  } catch {
    return true;
  }
}

/**
 * 边界必须「还是读它时那一版」才允许核销。
 *
 * 为什么不用「再读一次再判」：D1 没有跨语句事务，读完边界到写预算之间永远有一个窗口。
 * 把两层 revision 与暂停/开关标志放进**同一条** UPDATE/INSERT 的 WHERE，窗口就没了：
 * 期间任何一次 PATCH（撤权、暂停、收紧额度）都会让 revision 变，语句 0 行 → 核销失败。
 *
 * 真正的暂停按钮**不写边界**：`POST /pause` → `requestPause` → `autonomy_life_accounts.paused`；
 * 角色暂停 → `autonomy_life_characters.payload.pauseRequestedAt`（见 `service.ts`）。
 * 所以「边界 revision 没变」不等于「用户没暂停」——只看 boundaries 的旧写法会让
 * 「按了暂停之后新起的回合/最终额度门」照样放行（第八轮复审退回的正是这一点）。
 * 这里把**真实暂停落点**也放进同一条条件语句：暂停后 0 行，不依赖 revision。
 */
const BOUNDARY_ATOMIC_GUARD = `EXISTS (
    SELECT 1 FROM autonomy_life_boundaries b
    WHERE b.owner_id = ? AND b.scope = 'account' AND b.char_id = ''
      AND b.revision = ?
      AND COALESCE(json_extract(b.payload, '$.globalPaused'), 0) <> 1
      AND COALESCE(json_extract(b.payload, '$.enabled'), 1) <> 0
  )
  AND EXISTS (
    SELECT 1 FROM autonomy_life_boundaries cb
    WHERE cb.owner_id = ? AND cb.scope = 'character' AND cb.char_id = ?
      AND cb.revision = ?
      AND COALESCE(json_extract(cb.payload, '$.charEnabled'), 1) <> 0
      AND COALESCE(json_extract(cb.payload, '$.enabled'), 1) <> 0
  )
  AND NOT EXISTS (
    SELECT 1 FROM autonomy_life_accounts pa
    WHERE pa.owner_id = ? AND COALESCE(pa.paused, 0) <> 0
  )
  AND NOT EXISTS (
    SELECT 1 FROM autonomy_life_characters pc
    WHERE pc.owner_id = ? AND pc.char_id = ?
      AND json_extract(pc.payload, '$.pauseRequestedAt') IS NOT NULL
  )`;

/** 外部授权也进原子条件：核销那一刻重新读 payload 里的授权（撤权/到期 → 0 行）。 */
const GRANT_ATOMIC_GUARD = `EXISTS (
    SELECT 1 FROM autonomy_life_boundaries g, json_each(json_extract(g.payload, '$.externalGrants')) ge
    WHERE g.owner_id = ? AND g.scope = 'account' AND g.char_id = ''
      AND json_extract(ge.value, '$.provider') = ?
      AND COALESCE(json_extract(ge.value, '$.expiresAt'), 0) > ?
  )`;

/** kind_counts 的 JSON 路径（kind 来自固定白名单；仍去掉引号防路径注入）。 */
const kindJsonPath = (kind: string): string => `$."${String(kind).replace(/["\\]/g, '')}"`;

export interface QuotaConsumeInput {
  db: LifeDb;
  ownerId: string;
  charId: string;
  windowId: string;
  nowMs: number;
  /** 读边界时拿到的两层 revision（null = 该层没有行，条件里用 -1 恒不成立）。 */
  expectedAccountRevision: number | null;
  expectedCharacterRevision: number | null;
  /** 账号层通知额度（null = 这次不占通知）。0 = 明确禁止。 */
  notificationLimit?: number | null;
  /** 角色层同类动作额度（null = 这次不占 kind）。 */
  kind?: { kind: string; limit: number } | null;
  /** 要求当前仍存在未过期的外部授权（travel.wish → amap）。 */
  requireGrant?: 'amap' | 'xhs' | null;
}

/**
 * **原子**核销一格配额（通知 / per-kind 效果）。
 *
 * 判额与占额都在同一条条件语句里：UPDATE 命中 `notifications < limit`（或 kind 计数 < limit）
 * 才 +1；行不存在时用带同样条件的 INSERT 兜底。两条语句各自原子，并发下都不会超额。
 * 失败时**不留下任何行**（与被拒即零写入的既有语义一致）。
 */
export async function consumeLegacyQuotaAtomic(
  input: QuotaConsumeInput,
): Promise<{ ok: true } | { ok: false; reason: QuotaConsumeFailure }> {
  const { db, ownerId, charId, windowId, nowMs } = input;
  if (!ownerId || !charId || !windowId) return { ok: false, reason: 'invalid_input' };
  if (input.notificationLimit == null && !input.kind) return { ok: false, reason: 'invalid_input' };

  const accountRevision = input.expectedAccountRevision ?? -1;
  const characterRevision = input.expectedCharacterRevision ?? -1;
  // 绑定顺序与 BOUNDARY_ATOMIC_GUARD 的占位符顺序一致（末尾三个是真实暂停落点）。
  const guardBindings = (): unknown[] => [
    ownerId, accountRevision,
    ownerId, charId, characterRevision,
    ownerId,
    ownerId, charId,
  ];
  const grantBindings = (): unknown[] =>
    input.requireGrant ? [ownerId, input.requireGrant, nowMs] : [];
  const grantClause = input.requireGrant ? `AND ${GRANT_ATOMIC_GUARD}` : '';

  try {
    if (input.notificationLimit != null) {
      const limit = Math.max(0, Math.trunc(input.notificationLimit));
      const updated = await db
        .prepare(`UPDATE autonomy_life_budget
          SET notifications = notifications + 1, revision = revision + 1, updated_at = ?
          WHERE owner_id = ? AND window_id = ? AND scope = 'account'
            AND notifications < ?
            AND ${BOUNDARY_ATOMIC_GUARD}
            ${grantClause}`)
        .bind(nowMs, ownerId, windowId, limit, ...guardBindings(), ...grantBindings())
        .run();
      if (changesOf(updated) > 0) return { ok: true };
      if (limit > 0) {
        const inserted = await db
          .prepare(`INSERT OR IGNORE INTO autonomy_life_budget
            (owner_id, window_id, scope, used_calls, reserved_calls, used_tokens, reserved_tokens,
             notifications, kind_counts, spend_minor, revision, updated_at)
            SELECT ?, ?, 'account', 0, 0, 0, 0, 1, '{}', 0, 1, ?
            WHERE ${BOUNDARY_ATOMIC_GUARD}
            ${grantClause}`)
          .bind(ownerId, windowId, nowMs, ...guardBindings(), ...grantBindings())
          .run();
        if (changesOf(inserted) > 0) return { ok: true };
      }
    }

    if (input.kind) {
      const limit = Math.max(0, Math.trunc(input.kind.limit));
      const path = kindJsonPath(input.kind.kind);
      const rowScope = charId;
      const updated = await db
        .prepare(`UPDATE autonomy_life_budget
          SET kind_counts = json_set(
                CASE WHEN json_valid(kind_counts) THEN kind_counts ELSE '{}' END,
                ?,
                COALESCE(json_extract(CASE WHEN json_valid(kind_counts) THEN kind_counts ELSE '{}' END, ?), 0) + 1
              ),
              revision = revision + 1, updated_at = ?
          WHERE owner_id = ? AND window_id = ? AND scope = ?
            AND COALESCE(json_extract(CASE WHEN json_valid(kind_counts) THEN kind_counts ELSE '{}' END, ?), 0) < ?
            AND ${BOUNDARY_ATOMIC_GUARD}
            ${grantClause}`)
        .bind(path, path, nowMs, ownerId, windowId, rowScope, path, limit, ...guardBindings(), ...grantBindings())
        .run();
      if (changesOf(updated) > 0) return { ok: true };
      if (limit > 0) {
        const inserted = await db
          .prepare(`INSERT OR IGNORE INTO autonomy_life_budget
            (owner_id, window_id, scope, used_calls, reserved_calls, used_tokens, reserved_tokens,
             notifications, kind_counts, spend_minor, revision, updated_at)
            SELECT ?, ?, ?, 0, 0, 0, 0, 0, json_set('{}', ?, 1), 0, 1, ?
            WHERE ${BOUNDARY_ATOMIC_GUARD}
            ${grantClause}`)
          .bind(ownerId, windowId, rowScope, path, nowMs, ...guardBindings(), ...grantBindings())
          .run();
        if (changesOf(inserted) > 0) return { ok: true };
      }
    }

    // 0 行：把原因说准（非原子，只用于返回码/日志；业务效果已经确定为「不许」）。
    const stillCurrent = await db
      .prepare(`SELECT
          (SELECT revision FROM autonomy_life_boundaries WHERE owner_id = ? AND scope = 'account' AND char_id = '') AS ar,
          (SELECT revision FROM autonomy_life_boundaries WHERE owner_id = ? AND scope = 'character' AND char_id = ?) AS cr`)
      .bind(ownerId, ownerId, charId)
      .first()
      .catch(() => null);
    if (!stillCurrent
      || Number(stillCurrent.ar ?? -1) !== accountRevision
      || Number(stillCurrent.cr ?? -1) !== characterRevision) {
      return { ok: false, reason: 'boundary_changed' };
    }
    // revision 没变也可能是因为**真实暂停按钮**（accounts.paused / 角色 pauseRequestedAt）：
    // 这两个落点不动边界 revision，必须单独判，否则会把「暂停」误报成「额度用完」。
    if (await readRealPause({ db, ownerId, charId })) return { ok: false, reason: 'boundary_changed' };
    if (input.requireGrant && !input.kind) return { ok: false, reason: 'external_quota_exhausted' };
    if (input.kind) return { ok: false, reason: 'kind_exhausted' };
    return { ok: false, reason: input.notificationLimit != null ? 'notifications_exhausted' : 'kind_exhausted' };
  } catch {
    return { ok: false, reason: 'store_unavailable' };
  }
}

/**
 * 授权窗口当日额度的**原子核销**（`/external/*` 与旧链路效果共用口径）。
 *
 * 为什么不能沿用「先读 `grant.dailyQuota`、再 `consumeExternalQuota(旧 limit)`」：
 *   - 那个 limit 是读边界那一刻的旧值。用户如果在「kind 名额核销完 → 授权额度核销前」
 *     把额度收紧到 0 / 撤权 / 暂停，旧实现仍会按旧 limit 放行并返回成功效果；
 *   - 那条语句里也拿不到边界 revision，等于读边界与最终核销之间又开了一个竞态窗口。
 *
 * 这里把「当前边界 revision + 暂停/开关 + 未过期授权 + **payload 里的当前 dailyQuota**」
 * 全放进同一条条件语句：
 *   - `used < (SELECT json_extract(..., '$.dailyQuota'))` → 额度按**执行那一刻**的授权算；
 *   - 授权被撤/过期 → 子查询为 NULL → 0 行；
 *   - 边界 revision 变了（暂停/收紧限额/撤权都会 bump revision）→ 0 行；
 *   - 行不存在时用同样条件的 INSERT 兜底，再 UPDATE 一次（并发下另一条已插入的情形）。
 * 三条语句任何一条命中即成功；全部 0 行 = 拒绝，且不留下任何行。
 */
export async function consumeExternalQuotaAtomic(input: {
  db: LifeDb;
  ownerId: string;
  charId: string;
  dayKey: string;
  provider: 'amap' | 'xhs';
  nowMs: number;
  expectedAccountRevision: number | null;
  expectedCharacterRevision: number | null;
}): Promise<
  | { ok: true }
  | { ok: false; reason: 'boundary_changed' | 'external_quota_exhausted' | 'store_unavailable' }
> {
  const { db, ownerId, charId, dayKey, provider, nowMs } = input;
  if (!ownerId || !charId || !dayKey || !provider) return { ok: false, reason: 'store_unavailable' };

  const accountRevision = input.expectedAccountRevision ?? -1;
  const characterRevision = input.expectedCharacterRevision ?? -1;
  const guardBindings = (): unknown[] => [
    ownerId, accountRevision,
    ownerId, charId, characterRevision,
    ownerId,
    ownerId, charId,
  ];
  // 当前授权额度（执行时读 payload，不看读边界时的旧值）；没有有效授权 → NULL → 条件不成立。
  const QUOTA_GUARD = `used < (
      SELECT COALESCE(json_extract(ge.value, '$.dailyQuota'), 0)
      FROM autonomy_life_boundaries g, json_each(json_extract(g.payload, '$.externalGrants')) ge
      WHERE g.owner_id = ? AND g.scope = 'account' AND g.char_id = ''
        AND json_extract(ge.value, '$.provider') = ?
        AND COALESCE(json_extract(ge.value, '$.expiresAt'), 0) > ?
      LIMIT 1
    )`;
  const quotaBindings = (): unknown[] => [ownerId, provider, nowMs];

  const bump = async (): Promise<boolean> => {
    const updated = await db
      .prepare(`UPDATE autonomy_life_external_usage
        SET used = used + 1, updated_at = ?
        WHERE owner_id = ? AND day_key = ? AND provider = ?
          AND ${QUOTA_GUARD}
          AND ${BOUNDARY_ATOMIC_GUARD}`)
      .bind(nowMs, ownerId, dayKey, provider, ...quotaBindings(), ...guardBindings())
      .run();
    return changesOf(updated) > 0;
  };

  try {
    if (await bump()) return { ok: true };

    const inserted = await db
      .prepare(`INSERT OR IGNORE INTO autonomy_life_external_usage
        (owner_id, day_key, provider, used, updated_at)
        SELECT ?, ?, ?, 1, ?
        WHERE EXISTS (
          SELECT 1 FROM autonomy_life_boundaries g, json_each(json_extract(g.payload, '$.externalGrants')) ge
          WHERE g.owner_id = ? AND g.scope = 'account' AND g.char_id = ''
            AND json_extract(ge.value, '$.provider') = ?
            AND COALESCE(json_extract(ge.value, '$.expiresAt'), 0) > ?
            AND COALESCE(json_extract(ge.value, '$.dailyQuota'), 0) > 0
        )
          AND ${BOUNDARY_ATOMIC_GUARD}`)
      .bind(ownerId, dayKey, provider, nowMs, ...quotaBindings(), ...guardBindings())
      .run();
    if (changesOf(inserted) > 0) return { ok: true };

    // 另一条并发语句刚好插了行：再试一次条件 UPDATE（不重试就等于把并发放行改成拒绝，
    // 但「行已存在」不该被误判成额度耗尽）。
    if (await bump()) return { ok: true };

    // 0 行：把原因说准（非原子，只用于返回码/日志；此刻已经确定「不许」）。
    const stillCurrent = await db
      .prepare(`SELECT
          (SELECT revision FROM autonomy_life_boundaries WHERE owner_id = ? AND scope = 'account' AND char_id = '') AS ar,
          (SELECT revision FROM autonomy_life_boundaries WHERE owner_id = ? AND scope = 'character' AND char_id = ?) AS cr`)
      .bind(ownerId, ownerId, charId)
      .first()
      .catch(() => null);
    if (!stillCurrent
      || Number(stillCurrent.ar ?? -1) !== accountRevision
      || Number(stillCurrent.cr ?? -1) !== characterRevision) {
      return { ok: false, reason: 'boundary_changed' };
    }
    // 真实暂停落点（不改边界 revision）：按「边界变了」回 409，而不是误报「额度用完」。
    if (await readRealPause({ db, ownerId, charId })) return { ok: false, reason: 'boundary_changed' };
    return { ok: false, reason: 'external_quota_exhausted' };
  } catch {
    return { ok: false, reason: 'store_unavailable' };
  }
}

/**
 * 出行模型结果的**一次性效果许可**（`choose` / `nextSegment` 这类不占 kind 额度的决策位）。
 *
 * 一条 INSERT … SELECT 完成：账号/角色边界还是读它时那一版（revision + 暂停/开关）+
 * 当前仍有未过期的 amap 授权 + 同一个 claim_ref 只允许认领一次。0 行 = 拒绝，
 * 业务侧不写任何行程。
 */
export async function claimTravelDecisionAtomic(input: {
  db: LifeDb;
  ownerId: string;
  charId: string;
  windowId: string;
  nowMs: number;
  expectedAccountRevision: number | null;
  expectedCharacterRevision: number | null;
  claimRef: string;
  ttlMs?: number;
}): Promise<{ ok: true; claimId: string } | { ok: false; reason: QuotaConsumeFailure }> {
  const { db, ownerId, charId, windowId, nowMs } = input;
  const claimRef = String(input.claimRef ?? '').trim();
  if (!ownerId || !charId || !windowId || !claimRef) return { ok: false, reason: 'invalid_input' };
  const claimId = `eff_${claimRef}`;
  const expiresAt = nowMs + (input.ttlMs ?? 60 * 60 * 1000);
  const accountRevision = input.expectedAccountRevision ?? -1;
  const characterRevision = input.expectedCharacterRevision ?? -1;
  try {
    const inserted = await db
      .prepare(`INSERT OR IGNORE INTO autonomy_life_effect_claims
        (owner_id, claim_ref, char_id, kind, window_id, notification, created_at, expires_at, state, revision)
        SELECT ?, ?, ?, 'travel.decision', ?, 0, ?, ?, 'claimed', 0
        WHERE ${BOUNDARY_ATOMIC_GUARD}
          AND ${GRANT_ATOMIC_GUARD}`)
      .bind(
        ownerId, claimRef, charId, windowId, nowMs, expiresAt,
        ownerId, accountRevision, ownerId, charId, characterRevision,
        ownerId, ownerId, charId,
        ownerId, 'amap', nowMs,
      )
      .run();
    if (changesOf(inserted) > 0) return { ok: true, claimId };
    const existing = await db
      .prepare('SELECT claim_id FROM autonomy_life_effect_claims WHERE owner_id = ? AND claim_ref = ?')
      .bind(ownerId, claimRef)
      .first()
      .catch(() => null);
    if (existing) return { ok: false, reason: 'claim_exists' };
    const stillCurrent = await db
      .prepare(`SELECT
          (SELECT revision FROM autonomy_life_boundaries WHERE owner_id = ? AND scope = 'account' AND char_id = '') AS ar,
          (SELECT revision FROM autonomy_life_boundaries WHERE owner_id = ? AND scope = 'character' AND char_id = ?) AS cr`)
      .bind(ownerId, ownerId, charId)
      .first()
      .catch(() => null);
    if (!stillCurrent
      || Number(stillCurrent.ar ?? -1) !== accountRevision
      || Number(stillCurrent.cr ?? -1) !== characterRevision) {
      return { ok: false, reason: 'boundary_changed' };
    }
    // 真实暂停落点不动边界 revision，必须单独判（否则误报成授权额度问题）。
    if (await readRealPause({ db, ownerId, charId })) return { ok: false, reason: 'boundary_changed' };
    return { ok: false, reason: 'external_quota_exhausted' };
  } catch {
    return { ok: false, reason: 'store_unavailable' };
  }
}

/* ------------------------------------------------------------------ *
 * 输出效果认领（旧自动回合的一次性执行门）
 * ------------------------------------------------------------------ */

export type RoundClaimFailure =
  | 'invalid_input'
  | 'claim_exists'
  | 'reservation_invalid'
  | 'paused'
  | 'store_unavailable';

export type RoundClaimResult =
  | { ok: true; claimId: string; outputHash: string }
  | { ok: false; reason: RoundClaimFailure };

/**
 * 认领这一回合的**输出效果**（一次性、可追溯、绑定可信预留）。
 *
 * 一条语句完成「校验 + 认领」，没有任何「先读后写」的窗口：
 *   1. 预留记录必须真实存在、属于本 owner、本角色，且生命周期可用
 *      （`held` 在途 / `settled` 已结算的计划期凭据）且未过期；
 *   2. **真实暂停落点**（accounts.paused / 角色 pauseRequestedAt）必须为空：
 *      这是 `POST /pause` 写的两张表，不写 boundaries，所以不能只看边界 revision；
 *   3. `(owner_id, round_ref)` 是主键 → 同一回合只有第一次 INSERT 能成功。
 *
 * 返回 `claim_exists` = 这一回合已经被认领过（重放/并发），调用方必须零业务效果。
 * 返回 `reservation_invalid` = 凭据不可信（缺失/伪造/释放/过期），同样零业务效果。
 * 返回 `paused` = 用户在这期间真的按了暂停（同样零业务效果）。
 * 抛错/存储不可用一律按拒绝处理（fail closed）。
 */
export async function claimRoundEffect(input: {
  db: LifeDb;
  ownerId: string;
  charId: string;
  roundRef: string;
  reservationId: string;
  outputHash: string;
  nowMs: number;
  /** 认领记录的有效期（默认与动作执行窗对齐的 6h）。 */
  ttlMs?: number;
}): Promise<RoundClaimResult> {
  const ownerId = asString(input.ownerId).trim();
  const charId = asString(input.charId).trim();
  const roundRef = asString(input.roundRef).trim();
  const reservationId = asString(input.reservationId).trim();
  if (!ownerId || !charId || !roundRef || !reservationId) return { ok: false, reason: 'invalid_input' };

  const claimId = `clm_${crypto.randomUUID()}`;
  const expiresAt = input.nowMs + (input.ttlMs ?? 6 * 60 * 60 * 1000);
  try {
    const inserted = await input.db
      .prepare(`INSERT OR IGNORE INTO autonomy_life_round_claims
        (owner_id, round_ref, claim_id, char_id, reservation_id, output_hash, state, created_at, expires_at, revision)
        SELECT ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, 0
        WHERE EXISTS (
          SELECT 1 FROM autonomy_life_budget_reservations r
          WHERE r.owner_id = ? AND r.reservation_id = ? AND r.char_id = ?
            AND r.state IN ('held', 'settled') AND r.expires_at > ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM autonomy_life_accounts pa
          WHERE pa.owner_id = ? AND COALESCE(pa.paused, 0) <> 0
        )
        AND NOT EXISTS (
          SELECT 1 FROM autonomy_life_characters pc
          WHERE pc.owner_id = ? AND pc.char_id = ?
            AND json_extract(pc.payload, '$.pauseRequestedAt') IS NOT NULL
        )`)
      .bind(
        ownerId, roundRef, claimId, charId, reservationId, asString(input.outputHash), input.nowMs, expiresAt,
        ownerId, reservationId, charId, input.nowMs,
        ownerId,
        ownerId, charId,
      )
      .run();
    if (changesOf(inserted) > 0) {
      return { ok: true, claimId, outputHash: asString(input.outputHash) };
    }
    // 没插进去：要么这一回合已经认领过，要么凭据不可信，要么刚被暂停。
    // 三者对调用方都是「拒绝」，但要能区分（审计/测试要看得见原因）。
    const existing = await input.db
      .prepare('SELECT claim_id FROM autonomy_life_round_claims WHERE owner_id = ? AND round_ref = ?')
      .bind(ownerId, roundRef)
      .first();
    if (existing) return { ok: false, reason: 'claim_exists' };
    if (await readRealPause({ db: input.db, ownerId, charId })) return { ok: false, reason: 'paused' };
    return { ok: false, reason: 'reservation_invalid' };
  } catch {
    return { ok: false, reason: 'store_unavailable' };
  }
}

/** 只读：这个回合有没有被认领过（审计/测试用）。 */
export async function readRoundClaim(options: {
  db: LifeDb;
  ownerId: string;
  roundRef: string;
}): Promise<{ claimId: string; charId: string; reservationId: string; outputHash: string; state: string } | null> {
  const row = await options.db
    .prepare('SELECT claim_id, char_id, reservation_id, output_hash, state FROM autonomy_life_round_claims WHERE owner_id = ? AND round_ref = ?')
    .bind(options.ownerId, options.roundRef)
    .first();
  if (!row) return null;
  return {
    claimId: asString(row.claim_id),
    charId: asString(row.char_id),
    reservationId: asString(row.reservation_id),
    outputHash: asString(row.output_hash),
    state: asString(row.state),
  };
}

/** 角色状态投影复用（路由层只读） */
export type { CharacterLifeState };
