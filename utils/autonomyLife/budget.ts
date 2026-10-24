/**
 * 统一自主预算账本（调用 / token / 通知 / 同类动作 / 模拟消费）。
 *
 * 契约 §5.2 的硬要求，逐条落在这里：
 *   - 每一次模型请求（profile 提取、规划、生成、工具后总结、自动重试）**逐次**计数，
 *     不能「一轮计一次」；
 *   - 账号 + 角色两个维度一起校验，任一维度失败 → **全不预留**；
 *   - token 先按最大可能用量预留，结算按真实 usage，usage 不明就保留全额上界（不猜零），
 *     后续对账只收缩不超额；
 *   - 0 明确禁止（不是缺省）；存储不可用一律 fail closed；
 *   - 预算窗口按**服务端**记录的角色时区日切确定并持久化，时区改了也不刷新已有窗口额度。
 *
 * 原子性怎么保证：所有「读 + 判 + 写」都在 port.mutate() 的同一临界区里完成。
 * D1 侧用 BEGIN IMMEDIATE / 单条条件 UPDATE，内存侧用串行队列（见 createMemoryBudgetPort）。
 * 绝不在 JS 里先 read 再 write ——那正是并发超额的来源。
 */

import type { AutonomyLifeErrorCode, BudgetUsage } from '../../contracts/autonomyLife';
import { DEFAULT_ACCOUNT_LIMITS, MAXIMUM_ACCOUNT_LIMITS, type AutonomyLimits } from '../../contracts/autonomyLife';
import { budgetWindowId, type Clock } from './time';

export type BudgetScopeKey = 'account' | string; // 'account' | charId

export interface BudgetRow {
  windowId: string;
  scope: BudgetScopeKey;
  usedCalls: number;
  reservedCalls: number;
  usedTokens: number;
  reservedTokens: number;
  notifications: number;
  kindCounts: Record<string, number>;
  spendMinor: number;
  /** 单调递增；SQLite 侧用来做条件更新（CAS），检测并发丢失更新。 */
  revision: number;
  updatedAt: number;
}

export function emptyBudgetRow(windowId: string, scope: BudgetScopeKey, updatedAt: number): BudgetRow {
  return {
    windowId,
    scope,
    usedCalls: 0,
    reservedCalls: 0,
    usedTokens: 0,
    reservedTokens: 0,
    notifications: 0,
    kindCounts: {},
    spendMinor: 0,
    revision: 0,
    updatedAt,
  };
}

export interface BudgetMutationResult<T> {
  updates: BudgetRow[];
  result: T;
}

/**
 * 预算存储端口。实现方必须保证 mutator 在同一临界区内执行且全有或全无：
 *   - 返回 null → 什么都不写（放弃这次预检）；
 *   - 抛异常 → 整次事务回滚，调用方按 fail closed 处理。
 */
export interface BudgetPort {
  available(): boolean;
  mutate<T>(
    windowId: string,
    scopes: BudgetScopeKey[],
    mutator: (rows: Record<string, BudgetRow>) => BudgetMutationResult<T> | null,
  ): Promise<T | null>;
}

/** 内存实现（测试 + 单进程降级）。串行队列保证 mutator 不交错。 */
export function createMemoryBudgetPort(opts?: { failClosed?: boolean }): BudgetPort & {
  snapshot(): Record<string, BudgetRow>;
  setAvailable(value: boolean): void;
} {
  const rows = new Map<string, BudgetRow>();
  let queue: Promise<unknown> = Promise.resolve();
  let available = opts?.failClosed !== true;
  const keyOf = (windowId: string, scope: BudgetScopeKey): string => `${windowId}::${scope}`;

  return {
    available: () => available,
    setAvailable: (value: boolean) => {
      available = value;
    },
    snapshot: () => Object.fromEntries(rows),
    mutate<T>(
      windowId: string,
      scopes: BudgetScopeKey[],
      mutator: (input: Record<string, BudgetRow>) => BudgetMutationResult<T> | null,
    ): Promise<T | null> {
      const run = async (): Promise<T | null> => {
        if (!available) throw new Error('BUDGET_STORE_UNAVAILABLE');
        const input: Record<string, BudgetRow> = {};
        const created: string[] = [];
        for (const scope of scopes) {
          const key = keyOf(windowId, scope);
          if (!rows.has(key)) {
            rows.set(key, emptyBudgetRow(windowId, scope, Date.now()));
            created.push(key);
          }
          input[scope] = { ...rows.get(key)!, kindCounts: { ...rows.get(key)!.kindCounts } };
        }
        let outcome: BudgetMutationResult<T> | null;
        try {
          outcome = mutator(input);
        } catch (error) {
          for (const key of created) rows.delete(key);
          throw error;
        }
        if (!outcome) {
          // 判定失败：连「刚建出来的空行」都不留（与 D1 侧不插行一致）。
          for (const key of created) rows.delete(key);
          return null;
        }
        for (const row of outcome.updates) {
          const key = keyOf(row.windowId, row.scope);
          rows.set(key, { ...row, kindCounts: { ...row.kindCounts } });
        }
        // 只读用途（例如 reserve 失败后回读维度原因）不会返回 updates：
        // 这种情况下新建的空行不该被持久化，否则「失败也留了一行」会误导快照。
        const updatedKeys = new Set(outcome.updates.map((row) => keyOf(row.windowId, row.scope)));
        for (const key of created) {
          if (!updatedKeys.has(key)) rows.delete(key);
        }
        return outcome.result;
      };
      const next = queue.then(run, run);
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

export interface ReservationRequest {
  nowMs: number;
  /** 服务端在窗口开启时持久化的时区；不要用「当前设置的时区」重算已有窗口。 */
  windowTimezone: string;
  accountId: string;
  charId: string;
  limits: AutonomyLimits;
  /** 本次请求开始就消耗的调用数（一次请求 = 1，重试算新请求）。 */
  calls?: number;
  /** 本次请求 token 上界（max_tokens + 输入上界）。 */
  tokens: number;
  kind?: string;
  /** 是否需要占一条通知配额。 */
  notification?: boolean;
  /** 模拟消费金额（最小货币单位）。 */
  spendMinor?: number;
  /** 单笔/单次订单上限校验用。 */
  orderMaxMinor?: number;
}

export interface BudgetGrant {
  reservationId: string;
  windowId: string;
  charId: string;
  calls: number;
  tokens: number;
  notification: boolean;
  spendMinor: number;
  kind: string | null;
  createdAt: number;
}

export type ReserveOutcome =
  | { ok: true; grant: BudgetGrant }
  | { ok: false; code: Extract<AutonomyLifeErrorCode, 'BUDGET_EXHAUSTED' | 'SERVICE_UNAVAILABLE'>; dimension: string };

const limitOf = (limits: AutonomyLimits, key: keyof AutonomyLimits, scope: 'account' | 'char'): number => {
  const value = limits[key];
  if (value === null || value === undefined) {
    return Math.min(
      DEFAULT_ACCOUNT_LIMITS[key as keyof typeof DEFAULT_ACCOUNT_LIMITS] ?? 0,
      MAXIMUM_ACCOUNT_LIMITS[key as keyof typeof MAXIMUM_ACCOUNT_LIMITS] ?? 0,
    );
  }
  return value;
};

export interface BudgetPrecheckInputs {
  accountRow: BudgetRow;
  charRow: BudgetRow;
  limits: AutonomyLimits;
  request: ReservationRequest;
}

export interface BudgetPrecheck {
  ok: boolean;
  dimension?: string;
}

/**
 * 纯判定：所有维度都必须通过。不修改入参。
 * 注意 calls 与 tokens 都是「已用 + 在途 + 本次」一起比额度——在途预留也算占用，
 * 否则并发两次都能过。
 */
export function precheckBudget(inputs: BudgetPrecheckInputs): BudgetPrecheck {
  const { accountRow, charRow, limits, request } = inputs;
  const calls = request.calls ?? 1;
  const tokens = request.tokens;
  const spend = request.spendMinor ?? 0;

  const acctCalls = limitOf(limits, 'accountModelCallsPerDay', 'account');
  const charCalls = limitOf(limits, 'charModelCallsPerDay', 'char');
  const acctTokens = limitOf(limits, 'accountTokensPerDay', 'account');
  const charTokens = limitOf(limits, 'charTokensPerDay', 'char');
  const notifLimit = limitOf(limits, 'notificationsPerDay', 'account');
  const perKind = limitOf(limits, 'perKindActionsPerDay', 'char');
  const spendLimit = limitOf(limits, 'virtualSpendPerDayMinor', 'char');
  const orderMax = limitOf(limits, 'virtualOrderMaxMinor', 'char');

  if (calls > 0) {
    if (acctCalls <= 0) return { ok: false, dimension: 'account_calls' };
    if (charCalls <= 0) return { ok: false, dimension: 'char_calls' };
    if (accountRow.usedCalls + accountRow.reservedCalls + calls > acctCalls) {
      return { ok: false, dimension: 'account_calls' };
    }
    if (charRow.usedCalls + charRow.reservedCalls + calls > charCalls) {
      return { ok: false, dimension: 'char_calls' };
    }
  }
  if (tokens > 0) {
    if (acctTokens <= 0) return { ok: false, dimension: 'account_tokens' };
    if (charTokens <= 0) return { ok: false, dimension: 'char_tokens' };
    if (accountRow.usedTokens + accountRow.reservedTokens + tokens > acctTokens) {
      return { ok: false, dimension: 'account_tokens' };
    }
    if (charRow.usedTokens + charRow.reservedTokens + tokens > charTokens) {
      return { ok: false, dimension: 'char_tokens' };
    }
  }
  if (request.notification) {
    if (notifLimit <= 0) return { ok: false, dimension: 'notifications' };
    if (accountRow.notifications + 1 > notifLimit) return { ok: false, dimension: 'notifications' };
  }
  if (request.kind) {
    if (perKind <= 0) return { ok: false, dimension: 'kind_actions' };
    const used = charRow.kindCounts[request.kind] ?? 0;
    if (used + 1 > perKind) return { ok: false, dimension: 'kind_actions' };
  }
  if (spend > 0) {
    if (spendLimit <= 0) return { ok: false, dimension: 'virtual_spend' };
    if (orderMax <= 0 || spend > orderMax) return { ok: false, dimension: 'virtual_order_max' };
    if (charRow.spendMinor + spend > spendLimit) return { ok: false, dimension: 'virtual_spend' };
  }
  return { ok: true };
}

let reservationCounter = 0;

/**
 * 解析预留 id（`rsv_<windowId>_<charId>_<createdAt>_<counter>`）。
 *
 * 为什么需要：动作行里只存 reservationId 一个字符串，签发许可时必须能自证
 * 「这个预留属于本窗口、本角色」，否则伪造一个 id 就能过。windowId 不含 `_`，
 * 所以按 `_` 从右往左解析（charId 允许带下划线），解析不出来 = 拒绝。
 */
export function parseReservationId(
  reservationId: string | null | undefined,
): { windowId: string; charId: string; createdAt: number; counter: number } | null {
  const raw = String(reservationId ?? '').trim();
  if (!raw) return null;
  const match = /^rsv_(w:[^_]+)_(.+)_(\d{1,16})_(\d{1,9})$/.exec(raw);
  if (!match) return null;
  const createdAt = Number(match[3]);
  const counter = Number(match[4]);
  if (!Number.isFinite(createdAt) || !Number.isFinite(counter)) return null;
  return { windowId: match[1], charId: match[2], createdAt, counter };
}

export interface ReservationVerification {
  ok: boolean;
  reason?:
    | 'reservation_missing'
    | 'reservation_malformed'
    | 'reservation_window_mismatch'
    | 'reservation_character_mismatch'
    | 'reservation_not_held';
}

/**
 * 服务端在签发许可前复核预留依据：id 自证归属 + 预算行里仍有在途预留。
 *
 * 只校验「预留还在」不够——伪造 id 也能撞上别人留下的 reservedCalls；只校验 id 也不够
 * ——预留可能已结算（reserved 归零）。两条都过才发许可。
 */
export function verifyReservationHold(input: {
  reservationId: string | null | undefined;
  windowId: string;
  charId: string;
  nowMs: number;
  /** 用于校验预留创建时刻确实落在该窗口（缺省跳过这一条）。 */
  timezone?: string;
  rows: { account: BudgetRow | null; char: BudgetRow | null };
}): ReservationVerification {
  const parsed = parseReservationId(input.reservationId);
  if (!parsed) {
    return {
      ok: false,
      reason: String(input.reservationId ?? '').trim() ? 'reservation_malformed' : 'reservation_missing',
    };
  }
  if (parsed.windowId !== input.windowId) return { ok: false, reason: 'reservation_window_mismatch' };
  if (parsed.charId !== input.charId) return { ok: false, reason: 'reservation_character_mismatch' };
  // 预留不会晚于签发时刻产生；时钟回拨/伪造都对不上。
  if (parsed.createdAt > input.nowMs) return { ok: false, reason: 'reservation_malformed' };
  if (input.timezone && budgetWindowId(parsed.createdAt, input.timezone) !== input.windowId) {
    return { ok: false, reason: 'reservation_window_mismatch' };
  }
  const account = input.rows.account;
  const char = input.rows.char;
  if (!account || !char) return { ok: false, reason: 'reservation_not_held' };
  if (account.windowId !== input.windowId || char.windowId !== input.windowId) {
    return { ok: false, reason: 'reservation_window_mismatch' };
  }
  // 本窗口必须真的有预算记账（预留或在途已结算）：空窗口里冒出来的 id = 没有依据。
  // 注意不能只认 reservedCalls：计划期的预留会在模型调用后立刻结算成 used，
  // 到执行期 reservedCalls 归零是正常状态，不代表「没发生过预留」。
  if (account.reservedCalls + account.usedCalls < 1 || char.reservedCalls + char.usedCalls < 1) {
    return { ok: false, reason: 'reservation_not_held' };
  }
  return { ok: true };
}

/**
 * 预留：原子、全维度、失败即全不预留。
 * 存储不可用/抛错 → SERVICE_UNAVAILABLE（fail closed），绝不「先放过去再补账」。
 */
export async function reserveBudget(port: BudgetPort, request: ReservationRequest): Promise<ReserveOutcome> {
  if (!port.available()) {
    return { ok: false, code: 'SERVICE_UNAVAILABLE', dimension: 'store_unavailable' };
  }
  const calls = request.calls ?? 1;
  const windowId = budgetWindowId(request.nowMs, request.windowTimezone);
  try {
    const outcome = await port.mutate(windowId, ['account', request.charId], (rows) => {
      const accountRow = rows.account ?? emptyBudgetRow(windowId, 'account', request.nowMs);
      const charRow = rows[request.charId] ?? emptyBudgetRow(windowId, request.charId, request.nowMs);
      const precheck = precheckBudget({ accountRow, charRow, limits: request.limits, request });
      if (!precheck.ok) return null;
      reservationCounter += 1;
      const grant: BudgetGrant = {
        reservationId: `rsv_${windowId}_${request.charId}_${request.nowMs}_${reservationCounter}`,
        windowId,
        charId: request.charId,
        calls,
        tokens: request.tokens,
        notification: request.notification === true,
        spendMinor: request.spendMinor ?? 0,
        kind: request.kind ?? null,
        createdAt: request.nowMs,
      };
      const nextAccount: BudgetRow = {
        ...accountRow,
        reservedCalls: accountRow.reservedCalls + calls,
        reservedTokens: accountRow.reservedTokens + request.tokens,
        notifications: accountRow.notifications + (request.notification ? 1 : 0),
        revision: accountRow.revision + 1,
        updatedAt: request.nowMs,
      };
      const kindCounts = { ...charRow.kindCounts };
      if (request.kind) kindCounts[request.kind] = (kindCounts[request.kind] ?? 0) + 1;
      const nextChar: BudgetRow = {
        ...charRow,
        reservedCalls: charRow.reservedCalls + calls,
        reservedTokens: charRow.reservedTokens + request.tokens,
        kindCounts,
        spendMinor: charRow.spendMinor + (request.spendMinor ?? 0),
        revision: charRow.revision + 1,
        updatedAt: request.nowMs,
      };
      return { updates: [nextAccount, nextChar], result: grant };
    });
    if (!outcome) {
      // 走到这里说明临界区里判定失败：按维度重新判一次，给 UI 准确原因。
      const detail = await port.mutate(windowId, ['account', request.charId], (rows) => {
        const precheck = precheckBudget({
          accountRow: rows.account,
          charRow: rows[request.charId],
          limits: request.limits,
          request,
        });
        return { result: precheck, updates: [] };
      });
      const dimension = detail && !detail.ok ? detail.dimension ?? 'unknown' : 'unknown';
      return { ok: false, code: 'BUDGET_EXHAUSTED', dimension };
    }
    return { ok: true, grant: outcome };
  } catch {
    return { ok: false, code: 'SERVICE_UNAVAILABLE', dimension: 'store_unavailable' };
  }
}

export interface SettleInput {
  /** 真实 usage；undefined/null = 不明，保留全额上界（不猜零）。 */
  actualTokens?: number | null;
  /** 是否真的把请求交给了 provider（false 且能证明没发出 → 释放）。 */
  requestStarted: boolean;
}

export type SettleOutcome =
  | { ok: true; usedTokens: number; keptReservation: boolean }
  | { ok: false; code: 'SERVICE_UNAVAILABLE' };

/**
 * 结算：reserved → used。
 *   - requestStarted=false（preflight 取消且证明未发出）：calls/tokens 全额释放；
 *   - usage 不明：token 按预留上界记 used（不猜零）；
 *   - usage 超过预留：只按预留结算，超出部分单独记账为 overage，不让它突破预留上界。
 */
export async function settleBudget(
  port: BudgetPort,
  grant: BudgetGrant,
  input: SettleInput,
): Promise<SettleOutcome> {
  if (!port.available()) return { ok: false, code: 'SERVICE_UNAVAILABLE' };
  const released = !input.requestStarted;
  const settledTokens = released
    ? 0
    : typeof input.actualTokens === 'number' && Number.isFinite(input.actualTokens) && input.actualTokens >= 0
      ? Math.min(Math.round(input.actualTokens), grant.tokens)
      : grant.tokens;
  try {
    const outcome = await port.mutate(grant.windowId, ['account', grant.charId], (rows) => {
      const accountRow = rows.account;
      const charRow = rows[grant.charId];
      if (!accountRow || !charRow) return null;
      const nextAccount: BudgetRow = {
        ...accountRow,
        reservedCalls: Math.max(0, accountRow.reservedCalls - grant.calls),
        reservedTokens: Math.max(0, accountRow.reservedTokens - grant.tokens),
        usedCalls: accountRow.usedCalls + (released ? 0 : grant.calls),
        usedTokens: accountRow.usedTokens + settledTokens,
        revision: accountRow.revision + 1,
        updatedAt: Date.now(),
      };
      const nextChar: BudgetRow = {
        ...charRow,
        reservedCalls: Math.max(0, charRow.reservedCalls - grant.calls),
        reservedTokens: Math.max(0, charRow.reservedTokens - grant.tokens),
        usedCalls: charRow.usedCalls + (released ? 0 : grant.calls),
        usedTokens: charRow.usedTokens + settledTokens,
        revision: charRow.revision + 1,
        updatedAt: Date.now(),
      };
      return { updates: [nextAccount, nextChar], result: { usedTokens: settledTokens } };
    });
    if (!outcome) return { ok: false, code: 'SERVICE_UNAVAILABLE' };
    return { ok: true, usedTokens: outcome.usedTokens, keptReservation: !released && input.actualTokens == null };
  } catch {
    return { ok: false, code: 'SERVICE_UNAVAILABLE' };
  }
}

/** 只读：当前窗口用量快照（UI 的 budget 投影）。 */
export function projectBudgetUsage(
  rowAccount: BudgetRow | null,
  rowChar: BudgetRow | null,
  limits: AutonomyLimits,
): BudgetUsage[] {
  const account = rowAccount ?? emptyBudgetRow('', 'account', 0);
  const character = rowChar ?? emptyBudgetRow('', 'char', 0);
  return [
    {
      dimension: 'model_calls',
      used: character.usedCalls,
      reserved: character.reservedCalls,
      limit: limitOf(limits, 'charModelCallsPerDay', 'char'),
    },
    {
      dimension: 'model_calls_account',
      used: account.usedCalls,
      reserved: account.reservedCalls,
      limit: limitOf(limits, 'accountModelCallsPerDay', 'account'),
    },
    {
      dimension: 'tokens',
      used: character.usedTokens,
      reserved: character.reservedTokens,
      limit: limitOf(limits, 'charTokensPerDay', 'char'),
    },
    {
      dimension: 'notifications',
      used: account.notifications,
      reserved: 0,
      limit: limitOf(limits, 'notificationsPerDay', 'account'),
    },
    {
      dimension: 'virtual_spend',
      used: character.spendMinor,
      reserved: 0,
      limit: limitOf(limits, 'virtualSpendPerDayMinor', 'char'),
    },
  ];
}

/**
 * 多角色公平轮转：先比当日已用调用数，再比上次获准时间。
 * 免得「第一个角色把账号总额度吃干」。
 */
export function rotationOrder<T extends { charId: string; usedCalls: number; lastGrantedAt: number }>(
  states: T[],
): T[] {
  return [...states].sort((a, b) => {
    if (a.usedCalls !== b.usedCalls) return a.usedCalls - b.usedCalls;
    if (a.lastGrantedAt !== b.lastGrantedAt) return a.lastGrantedAt - b.lastGrantedAt;
    return a.charId < b.charId ? -1 : a.charId > b.charId ? 1 : 0;
  });
}

/** 供引擎/worker 复用的窗口 id 助手（明确要求传「窗口开启时记录的时区」）。 */
export function windowIdAt(clock: Clock, timezone: string): string {
  return budgetWindowId(clock.now(), timezone);
}
