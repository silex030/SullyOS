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
 * 输出效果认领（旧自动回合的一次性执行门）
 * ------------------------------------------------------------------ */

export type RoundClaimFailure =
  | 'invalid_input'
  | 'claim_exists'
  | 'reservation_invalid'
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
 *   2. `(owner_id, round_ref)` 是主键 → 同一回合只有第一次 INSERT 能成功。
 *
 * 返回 `claim_exists` = 这一回合已经被认领过（重放/并发），调用方必须零业务效果。
 * 返回 `reservation_invalid` = 凭据不可信（缺失/伪造/释放/过期），同样零业务效果。
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
        )`)
      .bind(
        ownerId, roundRef, claimId, charId, reservationId, asString(input.outputHash), input.nowMs, expiresAt,
        ownerId, reservationId, charId, input.nowMs,
      )
      .run();
    if (changesOf(inserted) > 0) {
      return { ok: true, claimId, outputHash: asString(input.outputHash) };
    }
    // 没插进去：要么这一回合已经认领过，要么凭据不可信。两者对调用方都是「拒绝」，
    // 但要能区分（审计/测试要看得见原因）。
    const existing = await input.db
      .prepare('SELECT claim_id FROM autonomy_life_round_claims WHERE owner_id = ? AND round_ref = ?')
      .bind(ownerId, roundRef)
      .first();
    return { ok: false, reason: existing ? 'claim_exists' : 'reservation_invalid' };
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
