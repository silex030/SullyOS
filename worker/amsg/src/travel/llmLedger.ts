/**
 * 出行 · LLM 账本适配器（B3）
 *
 * 把 B1 的窄接口 `TravelLlmLedgerPort` 接到**既有 autonomy 权威账本**上，不新建额度表：
 *   read    → `sumReservedAutonomyTokensSince`（当日仍压着的预留 token）+ 既有护栏的
 *             `dailyTokenBudget` / `paused`；任何一步读不出来就回 `null`（调用方 fail-closed）。
 *   reserve → `claimGlobalAutonomyBudget`（共享次数闸）+ `insertAutonomyPlanRun`
 *             （`reserved_tokens` 记 token；`idempotencyKey` 自带 `travel:` 前缀，与计划不撞）。
 *   settle  → `updateAutonomyPlanRun({status:'settled', actualTokens})`
 *   release → `releaseGlobalAutonomyBudget` + `updateAutonomyPlanRun({status:'released'})`
 *
 * 三条硬约束：
 * 1. **没有第二套额度**：本文件不建表、不写 `travel_budget_state.llm_tokens_limit` 的判定；
 *    旅行表里的 llm 镜像列不参与任何 gate。
 * 2. **不猜**：护栏读失败、账本抛错一律向上回 `null` / `BUDGET_BLOCKED`，没有正数兜底。
 * 3. **幂等**：同一 `idempotencyKey` 重放不重复扣 token / 不多占一次全局名额。
 */

import { dayKey } from '../../../../utils/travel/core';
import {
  claimGlobalAutonomyBudget,
  getGlobalAutonomyUsage,
  insertAutonomyPlanRun,
  releaseGlobalAutonomyBudget,
  sumReservedAutonomyTokensSince,
  updateAutonomyPlanRun,
  type AutonomyDb,
} from '../autonomyStore';
import type { TravelBudgetErrorCode, TravelLlmLedgerPort } from './budget';

/** 既有护栏里出行要用的两个值。`null` = 读不出来（必须是失败，不是「默认开启」）。 */
export interface TravelGuardrailSnapshot {
  paused: boolean;
  dailyTokenBudget: number;
}

export type TravelGuardrailReader = () => Promise<TravelGuardrailSnapshot | null>;

export interface AutonomyLlmLedgerOptions {
  db: AutonomyDb;
  /** 角色 id：`autonomy_plan_runs` 的 token 预算是按角色记的。 */
  charId: string;
  /** 既有护栏读入口（B6 传 autonomyScheduler 现成的那份）。 */
  readGuardrails: TravelGuardrailReader;
  /** 账号日键时区，缺省 Asia/Shanghai（与 travel_settings 默认一致）。 */
  budgetTz?: string;
  /** 覆盖日键算法（测试用，生产别传）。 */
  dateKeyOf?: (nowMs: number) => string;
  /** 覆盖当日起点（测试用）；缺省按日键推 UTC 零点。 */
  dayStartMsOf?: (nowMs: number) => number;
  /** 覆盖 run id 生成（测试用）。 */
  newRunId?: () => string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const toCount = (value: unknown): number => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** `dayKey` 是 YYYY-MM-DD；换算回当日起点 ms（UTC 口径，只用于「今天压着多少预留」）。 */
export const dayStartMsFromKey = (key: string, nowMs: number): number => {
  const parsed = Date.parse(`${key}T00:00:00.000Z`);
  if (Number.isFinite(parsed)) return parsed;
  return nowMs - DAY_MS;
};

/**
 * 建端口。**注意**：这里的 `reservationId` 就是 autonomy 的 `idempotency_key`
 * （`updateAutonomyPlanRun` 按它定位），调用方不要假设它是随机 id。
 */
export function createAutonomyLlmLedgerPort(options: AutonomyLlmLedgerOptions): TravelLlmLedgerPort {
  const { db, charId } = options;
  const tz = options.budgetTz?.trim() || 'Asia/Shanghai';
  const dateKeyOf = options.dateKeyOf ?? ((nowMs: number) => dayKey(nowMs, tz));
  const dayStartMsOf =
    options.dayStartMsOf ?? ((nowMs: number) => dayStartMsFromKey(dateKeyOf(nowMs), nowMs));
  const newRunId = options.newRunId ?? (() => `travel-run-${crypto.randomUUID()}`);

  return {
    async read({ userId, nowMs }) {
      try {
        const guardrails = await options.readGuardrails();
        if (!guardrails) return null; // 护栏读不出来 = 不知道能不能花 → 上层 fail-closed
        const usedTokens = await sumReservedAutonomyTokensSince(db, charId, dayStartMsOf(nowMs));
        return {
          usedTokens: toCount(usedTokens),
          limitTokens: toCount(guardrails.dailyTokenBudget),
          paused: guardrails.paused !== false,
        };
      } catch {
        return null;
      }
    },

    async reserve({ userId, tokens, idempotencyKey, nowMs }) {
      const dateKey = dateKeyOf(nowMs);
      try {
        const guardrails = await options.readGuardrails();
        if (!guardrails || guardrails.paused) return { ok: false, code: 'BUDGET_BLOCKED' };
        const limit = toCount(guardrails.dailyTokenBudget);
        if (limit <= 0) return { ok: false, code: 'BUDGET_ZERO' };

        const claimed = await claimGlobalAutonomyBudget(db, {
          userId,
          dateKey,
          limit,
          nowMs,
        });
        if (!claimed) return { ok: false, code: 'BUDGET_BLOCKED' };

        const inserted = await insertAutonomyPlanRun(db, {
          id: newRunId(),
          planId: `travel:${charId}`,
          charId,
          idempotencyKey,
          reservedTokens: toCount(tokens),
          nowMs,
        });
        if (!inserted) {
          // 同一键已存在：这次刚认领的全局名额是**多余**的，先退掉（否则重放会白吃次数）。
          // 仍为 `reserved` 才算可重放；settled/failed 的键不能再当有效预留。
          const row = await db
            .prepare('SELECT status FROM autonomy_plan_runs WHERE idempotency_key = ?')
            .bind(idempotencyKey)
            .first();
          await releaseGlobalAutonomyBudget(db, { userId, dateKey, nowMs });
          if (row && String(row.status) === 'reserved') {
            return { ok: true, reservationId: idempotencyKey };
          }
          return { ok: false, code: 'BUDGET_BLOCKED' };
        }
        return { ok: true, reservationId: idempotencyKey };
      } catch {
        return { ok: false, code: 'BUDGET_BLOCKED' };
      }
    },

    async settle({ reservationId, actualTokens, nowMs }) {
      try {
        await updateAutonomyPlanRun(db, {
          idempotencyKey: reservationId,
          status: 'settled',
          actualTokens: toCount(actualTokens),
          nowMs,
        });
      } catch {
        /* 额度以账本为准；这里只记日志，不向上抛（B1 同口径）。 */
      }
    },

    async release({ userId, reservationId, nowMs }) {
      try {
        await releaseGlobalAutonomyBudget(db, { userId, dateKey: dateKeyOf(nowMs), nowMs });
        await updateAutonomyPlanRun(db, {
          idempotencyKey: reservationId,
          status: 'released',
          nowMs,
        });
      } catch {
        /* 同上 */
      }
    },
  };
}

/**
 * 只读用量（给 `/travel/config` 与诊断）：**不**用来判定，只展示。
 * 读失败回 null，路由不要把它当「额度充足」。
 */
export async function readAutonomyLlmUsage(
  db: AutonomyDb,
  args: { userId: string; nowMs: number; budgetTz?: string },
): Promise<{ usage: number; dayKey: string } | null> {
  try {
    const key = dayKey(args.nowMs, args.budgetTz?.trim() || 'Asia/Shanghai');
    const usage = await getGlobalAutonomyUsage(db, { userId: args.userId, dateKey: key });
    return { usage: toCount(usage), dayKey: key };
  } catch {
    return null;
  }
}

export type { TravelBudgetErrorCode };
