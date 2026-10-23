/**
 * 角色自主出行 · 预算层（B1）
 *
 * 两件事，**不是**一套新额度体系：
 *
 * 1. **地图调用**：账号级单一账本 `travel_budget_state`（一行/user），日键由
 *    `travel_settings.budget_tz` + 服务端时间算（`dayKey`），预留是条件 UPDATE：
 *    `... WHERE paused = 0 AND map_calls_limit > 0 AND map_calls_used < map_calls_limit`
 *    拿 0 行就是没抢到 —— 并发下不会超卖。`limit = 0` 是硬零（`BUDGET_ZERO`），
 *    缺行 / 读失败 / 暂停一律 `BUDGET_BLOCKED`（fail-closed，**没有任何正数兜底**）。
 *    跨日只清 `used`，`limit` 与 `paused` 原样保留。
 *
 * 2. **LLM token**：**不在这里另立额度**。旅行里要花 token 的动作（选点、写一句
 *    「为什么想去」）一律走注入的 `TravelLlmLedgerPort`，由 B6 接到既有 autonomy
 *    权威账本（`autonomyStore.claimGlobalAutonomyBudget` / `autonomy_plan_runs` 的
 *    reserved_tokens / `autonomy_state.tokensToday`）。本表的 `llm_tokens_used /
 *    llm_tokens_limit` 只是**镜像**（给 UI 和诊断看），`limit` 写 0 也**不参与判定**；
 *    谁想用它当第二道额度，就是另造一套，契约不允许。
 *
 * 多角色共用同一 `user_id` 账本：本文件所有函数的签名里都**没有** charId，
 * 角色的 body/请求头也拿不到「我自己的额度」——想绕过只能改库里那一行。
 */

import { DEFAULT_BUDGET_TZ, type TravelBudgetKind } from '../../../../contracts/travel';
import { dayKey, resolveBudgetGate } from '../../../../utils/travel/core';
import {
  ensureTravelSchema,
  getTravelSettings,
  type TravelBudgetRecord,
  type TravelDb,
  type TravelStatement,
} from './store';

/** 预算层没有自己的 schema 缓存（复用 store 的），测试重置透传过去即可。 */
export { resetTravelSchemaCacheForTesting as resetTravelBudgetCacheForTesting } from './store';

export type TravelBudgetErrorCode = 'BUDGET_BLOCKED' | 'BUDGET_ZERO';

export type TravelBudgetGateResult =
  | { allowed: true }
  | { allowed: false; code: TravelBudgetErrorCode };

export type TravelBudgetReserveResult =
  | { ok: true; state: TravelBudgetRecord }
  | { ok: false; code: TravelBudgetErrorCode };

/**
 * 既有 autonomy 权威账本的端口（B6 用真实 store 实现；本层只依赖这个窄接口）。
 * 语义照既有实现：
 * - `read` 返回 null = 读不到 → 调用方必须 fail-closed；
 * - `reserve` 是真原子认领（`limit <= 0` 一律不放行）；
 * - `settle` 用实际 token 结算预留；`release` 在建任务失败时退回名额。
 */
export interface TravelLlmLedgerPort {
  read(input: {
    userId: string;
    nowMs: number;
  }): Promise<{ usedTokens: number; limitTokens: number; paused: boolean } | null>;
  reserve(input: {
    userId: string;
    tokens: number;
    idempotencyKey: string;
    nowMs: number;
  }): Promise<{ ok: true; reservationId: string } | { ok: false; code: TravelBudgetErrorCode }>;
  settle(input: {
    userId: string;
    reservationId: string;
    actualTokens: number;
    nowMs: number;
  }): Promise<void>;
  release(input: { userId: string; reservationId: string; nowMs: number }): Promise<void>;
}

/**
 * LLM 预留/结算必须带幂等键：同一 `idempotencyKey` 重放不能重复扣额度
 * （既有账本的 `autonomy_plan_runs.idempotency_key` 就是干这个的）。
 */
export interface LlmReserveInput {
  userId: string;
  tokens: number;
  idempotencyKey: string;
  nowMs: number;
  port: TravelLlmLedgerPort;
}

const BUDGET_COLUMNS =
  'user_id, map_calls_used, map_calls_limit, map_attempts_used, llm_tokens_used, llm_tokens_limit, day_key, paused, version, updated_at';

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
const asNumber = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const readBudgetRow = (row: Record<string, unknown>): TravelBudgetRecord => ({
  userId: asString(row.user_id),
  dayKey: asString(row.day_key),
  mapCallsUsed: asNumber(row.map_calls_used),
  mapCallsLimit: asNumber(row.map_calls_limit),
  mapAttemptsUsed: asNumber(row.map_attempts_used),
  llmTokensUsed: asNumber(row.llm_tokens_used),
  llmTokensLimit: asNumber(row.llm_tokens_limit),
  paused: Number(row.paused) === 1,
  version: asNumber(row.version),
  updatedAt: asNumber(row.updated_at),
});

const warn = (message: string): void => {
  console.warn(`[amsg:travel] ${message}`);
};

/** 账号固定时区；没有 settings 行就用契约默认值（这不是「额度兜底」，日键必须有值）。 */
async function readBudgetTimezone(db: TravelDb, userId: string): Promise<string> {
  const settings = await getTravelSettings(db, userId);
  const tz = settings?.budgetTz?.trim();
  return tz || DEFAULT_BUDGET_TZ;
}

async function fetchBudgetRow(db: TravelDb, userId: string): Promise<TravelBudgetRecord | null> {
  const row = await db
    .prepare(`SELECT ${BUDGET_COLUMNS} FROM travel_budget_state WHERE user_id = ?`)
    .bind(userId)
    .first();
  return row ? readBudgetRow(row) : null;
}

/** 跨日：只清 used/attempts，limit、paused 与 LLM 镜像的 limit 都不动。 */
async function rolloverIfNeeded(
  db: TravelDb,
  row: TravelBudgetRecord,
  todayKey: string,
  nowMs: number,
): Promise<void> {
  if (row.dayKey === todayKey) return;
  await db
    .prepare(
      `UPDATE travel_budget_state
       SET map_calls_used = 0, map_attempts_used = 0, llm_tokens_used = 0,
           day_key = ?, version = version + 1, updated_at = ?
       WHERE user_id = ? AND day_key <> ?`,
    )
    .bind(todayKey, nowMs, row.userId, todayKey)
    .run();
}

/**
 * 建账本行（额度来自设置页；`limit = 0` 合法 = 硬零）。
 * 已存在就**绝不覆盖** limit/paused —— 重复调用是安全的，但改额度只能走
 * `setTravelMapCallsLimit`（带条件更新）。
 */
export async function ensureTravelBudgetRow(
  db: TravelDb,
  args: { userId: string; mapCallsLimit: number; llmTokensLimit?: number; nowMs: number },
): Promise<void> {
  await ensureTravelSchema(db);
  const mapCallsLimit = Math.trunc(args.mapCallsLimit);
  if (!Number.isFinite(mapCallsLimit) || mapCallsLimit < 0) {
    throw new Error('travel budget: mapCallsLimit 必须是非负整数');
  }
  const todayKey = dayKey(args.nowMs, await readBudgetTimezone(db, args.userId));
  // llm_tokens_limit 只是镜像列（NOT NULL）：端口还没同步时写 0，不参与判定。
  const llmTokensLimit = Math.max(0, Math.trunc(args.llmTokensLimit ?? 0));
  await db
    .prepare(
      `INSERT OR IGNORE INTO travel_budget_state
        (user_id, map_calls_used, map_calls_limit, map_attempts_used,
         llm_tokens_used, llm_tokens_limit, day_key, paused, version, updated_at)
       VALUES (?, 0, ?, 0, 0, ?, ?, 0, 1, ?)`,
    )
    .bind(args.userId, mapCallsLimit, llmTokensLimit, todayKey, args.nowMs)
    .run();
}

/**
 * 读账本（顺带跨日翻页）。返回 null = 缺行或读失败 —— 调用方一律按
 * `BUDGET_BLOCKED` 处理，**不要在这里造默认额度**。
 */
export async function getTravelBudget(
  db: TravelDb,
  args: { userId: string; nowMs: number },
): Promise<TravelBudgetRecord | null> {
  await ensureTravelSchema(db);
  try {
    const row = await fetchBudgetRow(db, args.userId);
    if (!row) return null;
    const todayKey = dayKey(args.nowMs, await readBudgetTimezone(db, args.userId));
    if (row.dayKey !== todayKey) {
      await rolloverIfNeeded(db, row, todayKey, args.nowMs);
      return await fetchBudgetRow(db, args.userId);
    }
    return row;
  } catch (error) {
    warn(`预算读失败（按不可用处理）：${(error as Error)?.message ?? 'unknown'}`);
    return null;
  }
}

/**
 * 原子预留一次地图调用（调用前）。成功 = 已计入 `map_calls_used` 与
 * `map_attempts_used`；失败按上限/暂停/硬零分别给码。
 */
export async function reserveMapCall(
  db: TravelDb,
  args: { userId: string; nowMs: number },
): Promise<TravelBudgetReserveResult> {
  const state = await getTravelBudget(db, args);
  if (!state) return { ok: false, code: 'BUDGET_BLOCKED' };

  const gate = resolveBudgetGate(state, 'map');
  if (!gate.allowed) return { ok: false, code: gate.code };

  const result = await db
    .prepare(
      `UPDATE travel_budget_state
       SET map_calls_used = map_calls_used + 1,
           map_attempts_used = map_attempts_used + 1,
           version = version + 1,
           updated_at = ?
       WHERE user_id = ? AND day_key = ? AND paused = 0
         AND map_calls_limit > 0 AND map_calls_used < map_calls_limit`,
    )
    .bind(args.nowMs, args.userId, state.dayKey)
    .run();

  if (changesOf(result) !== 1) {
    // 读与写之间被别人抢走了名额：重读一次只为给出正确码，绝不重试写入。
    const fresh = await fetchBudgetRow(db, args.userId);
    if (fresh && fresh.dayKey === state.dayKey && fresh.mapCallsLimit === 0) {
      return { ok: false, code: 'BUDGET_ZERO' };
    }
    return { ok: false, code: 'BUDGET_BLOCKED' };
  }

  const fresh = await fetchBudgetRow(db, args.userId);
  return { ok: true, state: fresh ?? state };
}

/**
/**
 * 结算一次地图调用。
 *
 * **语义（2026-10-23 集成修正）**：默认**不退款**。额度计量的是「实际发出去的请求」，
 * 上游失败也已经花掉了那次请求；按失败退款会让「失败→重试」变成不受额度的免费循环。
 * 只有确定**一个字节都没发出去**（缺 Key、坐标不合法、预算闸拒绝）时，调用方才可以显式
 * 传 `refund: true` 把这一格还回去。
 */
export async function settleMapCall(
  db: TravelDb,
  args: { userId: string; ok: boolean; nowMs: number; refund?: boolean },
): Promise<void> {
  if (args.ok) return;
  if (args.refund !== true) return;
  await ensureTravelSchema(db);
  try {
    await db
      .prepare(
        `UPDATE travel_budget_state
         SET map_calls_used = CASE WHEN map_calls_used > 0 THEN map_calls_used - 1 ELSE 0 END,
             version = version + 1, updated_at = ?
         WHERE user_id = ?`,
      )
      .bind(args.nowMs, args.userId)
      .run();
  } catch (error) {
    warn(`地图名额退回失败（少退一次，不影响正确性）：${(error as Error)?.message ?? 'unknown'}`);
  }
}

export type TravelLimitWriteResult = { ok: true; limit: number } | { ok: false; code: 'INVALID_LIMIT' };

/** 改地图额度（0 = 关闸）。行不存在时按该额度建行（fail-closed 的起点）。 */
export async function setTravelMapCallsLimit(
  db: TravelDb,
  args: { userId: string; limit: number; nowMs: number },
): Promise<TravelLimitWriteResult> {
  const limit = Math.trunc(args.limit);
  if (!Number.isFinite(limit) || limit < 0) return { ok: false, code: 'INVALID_LIMIT' };
  await ensureTravelSchema(db);
  const existing = await fetchBudgetRow(db, args.userId);
  if (!existing) {
    await ensureTravelBudgetRow(db, { userId: args.userId, mapCallsLimit: limit, nowMs: args.nowMs });
    return { ok: true, limit };
  }
  await db
    .prepare(
      `UPDATE travel_budget_state
       SET map_calls_limit = ?, version = version + 1, updated_at = ?
       WHERE user_id = ?`,
    )
    .bind(limit, args.nowMs, args.userId)
    .run();
  return { ok: true, limit };
}

/**
 * 账号级暂停（用户总授权位）。暂停是**跨日保留**的：翻页不清 paused。
 * 行不存在时建一行 `limit = 0` 的暂停账本 —— 无论谁先读都拿不到额度。
 */
export async function setTravelBudgetPaused(
  db: TravelDb,
  args: { userId: string; paused: boolean; nowMs: number },
): Promise<boolean> {
  await ensureTravelSchema(db);
  const existing = await fetchBudgetRow(db, args.userId);
  if (!existing) {
    await ensureTravelBudgetRow(db, { userId: args.userId, mapCallsLimit: 0, nowMs: args.nowMs });
  }
  const result = await db
    .prepare(
      `UPDATE travel_budget_state SET paused = ?, version = version + 1, updated_at = ?
       WHERE user_id = ?`,
    )
    .bind(args.paused ? 1 : 0, args.nowMs, args.userId)
    .run();
  return changesOf(result) === 1;
}

/* ------------------------------------------------------------------ *
 * LLM：门交给既有 autonomy 权威账本
 * ------------------------------------------------------------------ */

type LlmGate =
  | { allowed: true; usedTokens: number; limitTokens: number }
  | { allowed: false; code: TravelBudgetErrorCode };

/**
 * LLM 闸：**只看** `travel_budget_state.paused` + 注入端口。本表的
 * `llm_tokens_limit / llm_tokens_used` 一个字段都不读（镜像列）。
 */
async function checkLlmGate(
  state: TravelBudgetRecord | null,
  input: { userId: string; nowMs: number; port?: TravelLlmLedgerPort | null },
): Promise<LlmGate> {
  if (!state) return { allowed: false, code: 'BUDGET_BLOCKED' };
  if (state.paused) return { allowed: false, code: 'BUDGET_BLOCKED' };
  if (!input.port) return { allowed: false, code: 'BUDGET_BLOCKED' };
  let ledger: { usedTokens: number; limitTokens: number; paused: boolean } | null = null;
  try {
    ledger = await input.port.read({ userId: input.userId, nowMs: input.nowMs });
  } catch (error) {
    warn(`LLM 账本读失败（fail-closed）：${(error as Error)?.message ?? 'unknown'}`);
    return { allowed: false, code: 'BUDGET_BLOCKED' };
  }
  if (!ledger) return { allowed: false, code: 'BUDGET_BLOCKED' };
  if (ledger.paused) return { allowed: false, code: 'BUDGET_BLOCKED' };
  const limit = Number(ledger.limitTokens);
  const used = Number(ledger.usedTokens);
  if (!Number.isFinite(limit) || limit < 0) return { allowed: false, code: 'BUDGET_BLOCKED' };
  if (limit === 0) return { allowed: false, code: 'BUDGET_ZERO' };
  if (!Number.isFinite(used) || used >= limit) return { allowed: false, code: 'BUDGET_BLOCKED' };
  return { allowed: true, usedTokens: used, limitTokens: limit };
}

/** 镜像回写（best-effort）：只为 UI/诊断显示，读失败不影响判定。 */
async function syncLlmMirror(
  db: TravelDb,
  args: { userId: string; nowMs: number; fallbackAddTokens?: number },
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE travel_budget_state
         SET llm_tokens_used = llm_tokens_used + ?, version = version + 1, updated_at = ?
         WHERE user_id = ?`,
      )
      .bind(Math.max(0, Math.trunc(args.fallbackAddTokens ?? 0)), args.nowMs, args.userId)
      .run();
  } catch (error) {
    warn(`LLM 镜像没写进去（不影响判定）：${(error as Error)?.message ?? 'unknown'}`);
  }
}

/**
 * 用账本权威用量覆盖镜像（读得到就用真值，读不到才退回「加上这次预留」）。
 * 镜像**永远不是判定依据**：这里失败只记日志。
 */
async function mirrorFromLedger(
  db: TravelDb,
  args: { userId: string; nowMs: number; port: TravelLlmLedgerPort; fallbackAddTokens: number },
): Promise<void> {
  let ledger: { usedTokens: number; limitTokens: number; paused: boolean } | null = null;
  try {
    ledger = await args.port.read({ userId: args.userId, nowMs: args.nowMs });
  } catch {
    ledger = null;
  }
  if (!ledger) {
    await syncLlmMirror(db, {
      userId: args.userId,
      nowMs: args.nowMs,
      fallbackAddTokens: args.fallbackAddTokens,
    });
    return;
  }
  try {
    await db
      .prepare(
        `UPDATE travel_budget_state
         SET llm_tokens_used = ?, llm_tokens_limit = ?, version = version + 1, updated_at = ?
         WHERE user_id = ?`,
      )
      .bind(
        Math.max(0, Math.trunc(ledger.usedTokens)),
        Math.max(0, Math.trunc(ledger.limitTokens)),
        args.nowMs,
        args.userId,
      )
      .run();
  } catch (error) {
    warn(`LLM 镜像没写进去（不影响判定）：${(error as Error)?.message ?? 'unknown'}`);
  }
}

/**
 * 预留 LLM token。**判定与扣账都在端口里**（既有 autonomy 权威账本），这里只：
 * 读一次状态做暂停判定 → 把 `tokens + idempotencyKey` 交给端口 → 镜像 used。
 */
export async function reserveLlmTokens(
  db: TravelDb,
  input: LlmReserveInput,
): Promise<{ ok: true; reservationId: string; state: TravelBudgetRecord | null } | { ok: false; code: TravelBudgetErrorCode }> {
  const state = await getTravelBudget(db, { userId: input.userId, nowMs: input.nowMs });
  const gate = await checkLlmGate(state, input);
  if (!gate.allowed) return { ok: false, code: gate.code };

  const tokens = Math.max(0, Math.trunc(input.tokens));
  let reserved: { ok: true; reservationId: string } | { ok: false; code: TravelBudgetErrorCode };
  try {
    reserved = await input.port.reserve({
      userId: input.userId,
      tokens,
      idempotencyKey: input.idempotencyKey,
      nowMs: input.nowMs,
    });
  } catch (error) {
    warn(`LLM 账本预留失败（fail-closed）：${(error as Error)?.message ?? 'unknown'}`);
    return { ok: false, code: 'BUDGET_BLOCKED' };
  }
  if (!reserved.ok) return { ok: false, code: reserved.code };

  await mirrorFromLedger(db, {
    userId: input.userId,
    nowMs: input.nowMs,
    port: input.port,
    fallbackAddTokens: tokens,
  });
  const fresh = await fetchBudgetRow(db, input.userId);
  return { ok: true, reservationId: reserved.reservationId, state: fresh ?? state };
}

/**
 * 结算 LLM：`ok` 用实际 token 结算预留，失败则释放（没发生生成就不该占额度）。
 * 之后按端口权威用量回写镜像（回读失败就保留上次镜像值，不影响判定）。
 */
export async function settleLlmTokens(
  db: TravelDb,
  args: {
    userId: string;
    reservationId: string;
    actualTokens: number;
    ok: boolean;
    nowMs: number;
    port: TravelLlmLedgerPort;
  },
): Promise<void> {
  const actualTokens = Math.max(0, Math.trunc(args.actualTokens));
  try {
    if (args.ok) {
      await args.port.settle({
        userId: args.userId,
        reservationId: args.reservationId,
        actualTokens,
        nowMs: args.nowMs,
      });
    } else {
      await args.port.release({
        userId: args.userId,
        reservationId: args.reservationId,
        nowMs: args.nowMs,
      });
    }
  } catch (error) {
    warn(`LLM 账本结算失败（额度以账本为准，这里只记日志）：${(error as Error)?.message ?? 'unknown'}`);
    return;
  }

  try {
    const ledger = await args.port.read({ userId: args.userId, nowMs: args.nowMs });
    if (!ledger) return;
    await db
      .prepare(
        `UPDATE travel_budget_state
         SET llm_tokens_used = ?, llm_tokens_limit = ?, version = version + 1, updated_at = ?
         WHERE user_id = ?`,
      )
      .bind(
        Math.max(0, Math.trunc(ledger.usedTokens)),
        Math.max(0, Math.trunc(ledger.limitTokens)),
        args.nowMs,
        args.userId,
      )
      .run();
  } catch (error) {
    warn(`LLM 镜像回读失败（不影响判定）：${(error as Error)?.message ?? 'unknown'}`);
  }
}

/**
 * 只读闸（路由在真正发起 provider / LLM 前调一次）。
 * `llm` 口径必须带 port；不带就是 `BUDGET_BLOCKED`，不猜。
 */
export async function resolveTravelBudgetGate(
  db: TravelDb,
  args: { userId: string; nowMs: number; kind: TravelBudgetKind; port?: TravelLlmLedgerPort | null },
): Promise<TravelBudgetGateResult> {
  const state = await getTravelBudget(db, { userId: args.userId, nowMs: args.nowMs });
  if (args.kind === 'map') {
    if (!state) return { allowed: false, code: 'BUDGET_BLOCKED' };
    const gate = resolveBudgetGate(state, 'map');
    return gate.allowed ? { allowed: true } : { allowed: false, code: gate.code };
  }
  const gate = await checkLlmGate(state, {
    userId: args.userId,
    nowMs: args.nowMs,
    port: args.port,
  });
  return gate.allowed ? { allowed: true } : { allowed: false, code: gate.code };
}

/* 内部：与 store 的 changesOf 同口径（D1 的 meta.changes / 替身的 changes）。 */
function changesOf(result: unknown): number {
  const raw = result as { meta?: { changes?: unknown }; changes?: unknown } | null;
  const value = raw?.meta?.changes ?? raw?.changes ?? 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export type { TravelBudgetRecord, TravelDb, TravelStatement };
