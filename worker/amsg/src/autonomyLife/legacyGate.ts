/**
 * 旧自主回合（AIRP `autonomous_round`）的**统一边界 / 统一预算闸**。
 *
 * 为什么需要这一层：`worker/amsg/src/index.ts` 的 cron 里还残留着旧调度
 * （`runAutonomyTick` + `createAutonomyPostTask`），它自己有另一套护栏/额度/暂停，
 * 完全不看新的 `autonomy_life_boundaries`。结果就是「用户在设置页按下总暂停 / 关了角色 /
 * 用完了额度」以后，旧链路照样能调模型、发消息——新边界形同虚设。
 *
 * 两处闸，缺一不可：
 *   1. `gateLegacyAutonomyPacks`（建任务前筛包）：不该建的任务别建，省一次上游往返；
 *   2. `reserveLegacyRoundCall`（**每一次真正的模型调用之前**）：按当前边界 + 统一预算
 *      **原子预留**一次调用，`settleLegacyRoundCall` 在模型回来后结算。只做第 1 步不够：
 *       - 建任务之后用户按了暂停/关了角色/加了禁区，任务已经排在那里，到点仍会 fire；
 *       - 「新预算只剩一次」时多个角色都能通过只读筛包，然后一起调模型。
 *
 * 判定口径与新引擎完全一致：
 *
 *   1. 账号层：必须 enabled 且未 globalPaused（没有边界行 = 默认关闭，直接不跑）；
 *   2. 角色层：charEnabled 不能被关掉（角色没登记也不跑：不替用户给全部角色开生活）；
 *   3. kind 白名单：旧回合本质是「角色发一条消息」→ 映射成 `interaction.message`，
 *      必须被 allowedKinds 允许；
 *   4. 禁区：旧回合的正文由上游 LLM 生成，worker 侧在出请求前**无法**证明它遵守了
 *      用户新增的 forbiddenCategories / avoidTopics。按 fail closed：只要边界里有
 *      **用户新增**的禁区/回避话题（平台内置禁区不算），旧回合就整跳不跑；
 *   5. 预算：统一账本里预留下一次调用（账号 + 角色两个维度一起判，原子）。
 *
 * 因此：升级后没有新建边界的存量用户 = 旧自动回合停下（旧配置不能旁路新边界）；
 * 想要它继续跑，必须在新入口里显式打开总开关、允许 `interaction.message`、
 * 不设置未验证的禁区、且额度还有余量。
 */

import {
  DEFAULT_ACCOUNT_LIMITS,
  PLATFORM_FORBIDDEN_CATEGORIES,
  type EffectiveBoundaryV1,
} from '../../../../contracts/autonomyLife';
import { boundaryGate, mergeEffectiveBoundary } from '../../../../utils/autonomyLife/boundary';
import {
  reserveBudget,
  settleBudget,
  windowIdAt,
  type BudgetGrant,
  type BudgetRow,
} from '../../../../utils/autonomyLife/budget';
import type { AutonomyTickPack } from '../autonomyScheduler';
import { createD1BudgetPort, readBudgetRows, type LifeDb } from './store';

/** 旧自主回合映射到新边界的 kind（它就是「角色发一条消息」）。 */
export const LEGACY_AUTONOMY_KIND = 'interaction.message' as const;

/** 旧回合每次调用预留的 token 上界（与引擎默认一致；结算按真实 usage 收缩）。 */
export const LEGACY_ROUND_RESERVE_TOKENS = 1600;

export type LegacyAutonomySkipReason =
  | 'account_disabled'
  | 'paused'
  | 'character_not_registered'
  | 'char_disabled'
  | 'kind_not_allowed'
  | 'forbidden_topic'
  | 'budget_exhausted';

export interface LegacyAutonomyGateResult {
  allowed: AutonomyTickPack[];
  skipped: Array<{ userId: string; charId: string; reason: LegacyAutonomySkipReason }>;
}

const sumCalls = (row: BudgetRow | null): number => (row ? row.usedCalls + row.reservedCalls : 0);

/** 用户新增的禁区（平台内置的不算：它们不改变「能不能跑」）。 */
const userForbidden = (boundary: EffectiveBoundaryV1): string[] =>
  boundary.forbiddenCategories.filter(
    (item) => !(PLATFORM_FORBIDDEN_CATEGORIES as readonly string[]).includes(item),
  );

/**
 * 从 D1 读「这个角色当前生效的边界」。
 * 缺账号行 = 从没在新入口打开过（account_disabled）；缺角色行 = 没登记（character_not_registered）。
 * 读失败一律按不可用处理（fail closed），旧链路不能因为「读不到边界」而放飞。
 */
export async function readEffectiveBoundary(
  db: LifeDb,
  args: { ownerId: string; charId: string; nowMs: number },
): Promise<{ ok: true; boundary: EffectiveBoundaryV1 } | { ok: false; reason: LegacyAutonomySkipReason }> {
  try {
    const accountRow = await db
      .prepare("SELECT payload FROM autonomy_life_boundaries WHERE owner_id = ? AND scope = 'account' AND char_id = ''")
      .bind(args.ownerId)
      .first();
    const characterRow = await db
      .prepare("SELECT payload FROM autonomy_life_boundaries WHERE owner_id = ? AND scope = 'character' AND char_id = ?")
      .bind(args.ownerId, args.charId)
      .first();
    if (!accountRow || !characterRow) {
      return { ok: false, reason: accountRow ? 'character_not_registered' : 'account_disabled' };
    }
    const account = JSON.parse(String(accountRow.payload)) as Parameters<typeof mergeEffectiveBoundary>[0]['account'];
    const character = JSON.parse(String(characterRow.payload)) as NonNullable<Parameters<typeof mergeEffectiveBoundary>[0]['character']>;
    return {
      ok: true,
      boundary: mergeEffectiveBoundary({ account, character, charId: args.charId, nowMs: args.nowMs }),
    };
  } catch {
    return { ok: false, reason: 'account_disabled' };
  }
}

/** 边界门（暂停/开关/角色/kind/未验证禁区）。纯判定，不写任何东西。 */
export function legacyBoundaryDenial(
  boundary: EffectiveBoundaryV1,
  kind: string = LEGACY_AUTONOMY_KIND,
): LegacyAutonomySkipReason | null {
  if (!boundary.enabled || boundary.globalPaused) return 'paused';
  if (boundary.charEnabled === false) return 'char_disabled';
  const gate = boundaryGate(boundary, kind as never);
  if (!gate.ok) return gate.code === 'CHAR_DISABLED' ? 'char_disabled' : 'kind_not_allowed';
  if (userForbidden(boundary).length > 0 || boundary.avoidTopics.length > 0) return 'forbidden_topic';
  return null;
}

/**
 * 建任务前的筛包（只读）。真正的硬门在 `reserveLegacyRoundCall`——这里提前筛只是为了
 * 不建一条到点必然被拒的任务。
 */
export async function gateLegacyAutonomyPacks(args: {
  db: LifeDb;
  packs: readonly AutonomyTickPack[];
  nowMs: number;
}): Promise<LegacyAutonomyGateResult> {
  const allowed: AutonomyTickPack[] = [];
  const skipped: LegacyAutonomyGateResult['skipped'] = [];

  for (const pack of args.packs) {
    const reason = await reasonToSkip(args.db, pack, args.nowMs);
    if (reason) skipped.push({ userId: pack.userId, charId: pack.charId, reason });
    else allowed.push(pack);
  }
  return { allowed, skipped };
}

async function reasonToSkip(
  db: LifeDb,
  pack: AutonomyTickPack,
  nowMs: number,
): Promise<LegacyAutonomySkipReason | null> {
  const read = await readEffectiveBoundary(db, { ownerId: pack.userId, charId: pack.charId, nowMs });
  if (!read.ok) return read.reason;
  const boundary = read.boundary;

  const denial = legacyBoundaryDenial(boundary);
  if (denial) return denial;

  try {
    const windowId = windowIdAt({ now: () => nowMs }, boundary.timezone);
    const rows = await readBudgetRows({ db, ownerId: pack.userId, charId: pack.charId, windowId });
    const accountLimit = boundary.limits.accountModelCallsPerDay ?? DEFAULT_ACCOUNT_LIMITS.accountModelCallsPerDay;
    const charLimit = boundary.limits.charModelCallsPerDay ?? DEFAULT_ACCOUNT_LIMITS.charModelCallsPerDay;
    if (sumCalls(rows.account) >= accountLimit) return 'budget_exhausted';
    if (sumCalls(rows.char) >= charLimit) return 'budget_exhausted';
  } catch {
    return 'budget_exhausted';
  }
  return null;
}

/** 旧回合的预留凭据（跨 beforeFire → llmOutput 携带）。 */
export interface LegacyRoundPermit {
  ownerId: string;
  charId: string;
  windowId: string;
  reservationId: string;
  grant: BudgetGrant;
}

/**
 * **每一次真正的模型调用之前**：按当前生效边界重判 + 在统一账本里原子预留下一次调用。
 *
 * 这是旧链路唯一的放行点：拒绝时不产生任何写入（预算行/预留记录都不留），调用方直接 skip。
 * 「同账号多角色只剩一次额度」时，第二个角色会在这里被预算判定拒掉——只读筛包做不到这点。
 */
export async function reserveLegacyRoundCall(args: {
  db: LifeDb;
  ownerId: string;
  charId: string;
  nowMs: number;
  kind?: string;
  reserveTokens?: number;
}): Promise<
  | { ok: true; permit: LegacyRoundPermit; boundary: EffectiveBoundaryV1 }
  | { ok: false; reason: LegacyAutonomySkipReason }
> {
  const read = await readEffectiveBoundary(args.db, {
    ownerId: args.ownerId,
    charId: args.charId,
    nowMs: args.nowMs,
  });
  if (!read.ok) return { ok: false, reason: read.reason };
  const boundary = read.boundary;
  const denial = legacyBoundaryDenial(boundary, args.kind ?? LEGACY_AUTONOMY_KIND);
  if (denial) return { ok: false, reason: denial };

  const port = createD1BudgetPort({ db: args.db, ownerId: args.ownerId });
  if (!port.available()) return { ok: false, reason: 'budget_exhausted' };
  const windowId = windowIdAt({ now: () => args.nowMs }, boundary.timezone);
  const reservation = await reserveBudget(port, {
    nowMs: args.nowMs,
    windowTimezone: boundary.timezone,
    accountId: args.ownerId,
    charId: args.charId,
    limits: boundary.limits,
    calls: 1,
    tokens: args.reserveTokens ?? LEGACY_ROUND_RESERVE_TOKENS,
    kind: args.kind ?? LEGACY_AUTONOMY_KIND,
    planRef: `legacy-round:${args.charId}:${windowId}`,
  });
  if (!reservation.ok) return { ok: false, reason: 'budget_exhausted' };

  // 预留与边界读取之间还有一个窗口：用户可能恰好在这几毫秒里按了暂停/加了禁区。
  // 预留下再读一次边界；一旦变了就把这次预留全额释放（零消费）并按拒绝处理。
  const settledPort = createD1BudgetPort({ db: args.db, ownerId: args.ownerId });
  const recheck = await readEffectiveBoundary(args.db, {
    ownerId: args.ownerId,
    charId: args.charId,
    nowMs: args.nowMs,
  });
  const changed = !recheck.ok
    || recheck.boundary.accountRevision !== boundary.accountRevision
    || recheck.boundary.characterRevision !== boundary.characterRevision
    || legacyBoundaryDenial(recheck.boundary, args.kind ?? LEGACY_AUTONOMY_KIND) !== null;
  if (changed) {
    await settleBudget(settledPort, reservation.grant, { requestStarted: false }).catch(() => undefined);
    return { ok: false, reason: recheck.ok ? (legacyBoundaryDenial(recheck.boundary, args.kind ?? LEGACY_AUTONOMY_KIND) ?? 'paused') : recheck.reason };
  }

  return {
    ok: true,
    boundary,
    permit: {
      ownerId: args.ownerId,
      charId: args.charId,
      windowId: reservation.grant.windowId,
      reservationId: reservation.grant.reservationId,
      grant: reservation.grant,
    },
  };
}

/**
 * 模型回来之后结算：旧回合的消费**记进统一预算**（以前只写旧 autonomy_state，
 * 新预算永远看不到旧链路的消耗）。
 */
export async function settleLegacyRoundCall(args: {
  db: LifeDb;
  permit: LegacyRoundPermit;
  actualTokens?: number | null;
  requestStarted: boolean;
}): Promise<boolean> {
  const port = createD1BudgetPort({ db: args.db, ownerId: args.permit.ownerId });
  const settled = await settleBudget(port, args.permit.grant, {
    actualTokens: args.actualTokens ?? null,
    requestStarted: args.requestStarted,
  });
  return settled.ok;
}

/**
 * 执行期复核（llmOutput 落副作用之前）：用户可能在上游模型跑的这几秒里按了暂停 /
 * 关了角色 / 加了禁区。这里再读一次当前边界，拒了就只结算、不写任何业务产物。
 */
export async function legacyRoundStillAllowed(args: {
  db: LifeDb;
  ownerId: string;
  charId: string;
  nowMs: number;
  kind?: string;
}): Promise<LegacyAutonomySkipReason | null> {
  const read = await readEffectiveBoundary(args.db, {
    ownerId: args.ownerId,
    charId: args.charId,
    nowMs: args.nowMs,
  });
  if (!read.ok) return read.reason;
  return legacyBoundaryDenial(read.boundary, args.kind ?? LEGACY_AUTONOMY_KIND);
}

/* ------------------------------------------------------------------ *
 * 统一配额：提醒（通知）与「效果」类 kind
 * ------------------------------------------------------------------ */

export type LegacyQuotaFailure = LegacyAutonomySkipReason | 'notifications_exhausted';

/**
 * 在统一账本里**原子**占用一格配额（不涉及模型调用）。
 *
 *   - `notification: true` → 账号层 `notificationsPerDay`（多角色共享同一格）；
 *   - `kind: 'travel.wish'` → 角色层 `perKindActionsPerDay` + kind 计数。
 *
 * 为什么必须走统一账本：旧链路（AIRP 回合的提醒、出行愿望）以前只读自己的旧开关，
 * 于是「新设置里通知关掉 / 额度用完」根本挡不住它。这里把「判额 + 占额」放进
 * `reserveBudget` 的同一临界区（D1 侧是条件 UPDATE），并发下不会超额。
 *
 * 失败时不留下任何预算行/预留记录（`reserveBudget` 的既有语义）。
 */
async function chargeLegacyQuota(args: {
  db: LifeDb;
  ownerId: string;
  charId: string;
  nowMs: number;
  notification?: boolean;
  kind?: string;
}): Promise<{ ok: true } | { ok: false; reason: LegacyQuotaFailure }> {
  const read = await readEffectiveBoundary(args.db, {
    ownerId: args.ownerId,
    charId: args.charId,
    nowMs: args.nowMs,
  });
  if (!read.ok) return { ok: false, reason: read.reason };
  const boundary = read.boundary;
  // 边界本身先过一遍：暂停/关角色/kind 未授权时连额度都不该占。
  const denial = legacyBoundaryDenial(boundary, args.kind ?? LEGACY_AUTONOMY_KIND);
  if (denial) return { ok: false, reason: denial };

  const port = createD1BudgetPort({ db: args.db, ownerId: args.ownerId });
  if (!port.available()) return { ok: false, reason: 'budget_exhausted' };
  const reserved = await reserveBudget(port, {
    nowMs: args.nowMs,
    windowTimezone: boundary.timezone,
    accountId: args.ownerId,
    charId: args.charId,
    limits: boundary.limits,
    // 只占「配额」，不占模型调用/ token：calls=0 / tokens=0 时 precheckBudget 不判这两维，
    // 通知与 kind 计数各自按自己的额度判。
    calls: 0,
    tokens: 0,
    ...(args.notification ? { notification: true } : {}),
    ...(args.kind ? { kind: args.kind } : {}),
    planRef: `legacy-quota:${args.kind ?? 'notification'}:${args.charId}`,
  });
  if (!reserved.ok) {
    return {
      ok: false,
      reason: args.notification ? 'notifications_exhausted' : 'budget_exhausted',
    };
  }
  // 立刻结算这张「零调用」凭据：配额在预留时就已经记账（notifications / kindCounts），
  // 结算只是把记录推进到 settled，避免留下一条无主的在途预留。
  await settleBudget(port, reserved.grant, { requestStarted: true, actualTokens: 0 }).catch(() => undefined);
  return { ok: true };
}

/**
 * 提醒（推送）前的统一通知额度：返回 false 只代表「这一次不发提醒」，
 * 私人活动照常落库（与新 UI 的承诺一致：通知关闭只影响提醒）。
 */
export async function reserveLegacyNotification(args: {
  db: LifeDb;
  ownerId: string;
  charId: string;
  nowMs: number;
}): Promise<{ ok: true } | { ok: false; reason: LegacyQuotaFailure }> {
  return chargeLegacyQuota({ ...args, notification: true });
}

/** 出行愿望的 kind。 */
export const LEGACY_TRAVEL_KIND = 'travel.wish' as const;

/**
 * 「效果」类动作的 kind 配额（出行愿望等）：落业务效果之前占一格 `perKindActionsPerDay`，
 * 并复核当前边界确实允许这个 kind（用户没授权 travel.wish 就不许落愿望）。
 */
export async function reserveLegacyEffect(args: {
  db: LifeDb;
  ownerId: string;
  charId: string;
  nowMs: number;
  kind: string;
}): Promise<{ ok: true } | { ok: false; reason: LegacyQuotaFailure }> {
  return chargeLegacyQuota(args);
}
