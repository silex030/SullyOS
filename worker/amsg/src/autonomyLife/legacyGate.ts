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
import { localDateKey } from '../../../../utils/autonomyLife/time';
import type { AutonomyTickPack } from '../autonomyScheduler';
import {
  consumeExternalQuotaAtomic,
  consumeLegacyQuotaAtomic,
  createD1BudgetPort,
  readBudgetRows,
  type LifeDb,
} from './store';

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
  | 'grant_missing'
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
 *
 * **真实暂停也在这里读**：`POST /pause` 不写 `autonomy_life_boundaries`——
 * 账号暂停写 `autonomy_life_accounts.paused`，角色暂停写
 * `autonomy_life_characters.payload.pauseRequestedAt`（`service.ts` 的落点）。
 * 只读 boundaries 会出现「用户按了暂停，边界 payload/ revision 一点没变，
 * 新起的旧 AIRP 回合与出行 tick 照样调模型」（第八轮复审退回的正是这一点）。
 * 这里把真实暂停折叠成 `globalPaused`，于是所有复用本函数的执行闸
 * （beforeFire / 结果效果 / 通知 / 出行模型与效果 / 授权额度）都按同一份暂停权威判定。
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
    // 真实暂停落点（与 POST /pause 写入的表/字段一致）。读失败 → 走 catch fail closed。
    const pauseRow = await db
      .prepare(`SELECT
          (SELECT COALESCE(paused, 0) FROM autonomy_life_accounts WHERE owner_id = ?) AS account_paused,
          (SELECT json_extract(payload, '$.pauseRequestedAt') FROM autonomy_life_characters
            WHERE owner_id = ? AND char_id = ?) AS char_pause_requested_at`)
      .bind(args.ownerId, args.ownerId, args.charId)
      .first();
    const account = JSON.parse(String(accountRow.payload)) as Parameters<typeof mergeEffectiveBoundary>[0]['account'];
    const character = JSON.parse(String(characterRow.payload)) as NonNullable<Parameters<typeof mergeEffectiveBoundary>[0]['character']>;
    const merged = mergeEffectiveBoundary({ account, character, charId: args.charId, nowMs: args.nowMs });
    const realPause = Number(pauseRow?.account_paused ?? 0) !== 0
      || pauseRow?.char_pause_requested_at != null;
    return { ok: true, boundary: realPause ? { ...merged, globalPaused: true } : merged };
  } catch {
    return { ok: false, reason: 'account_disabled' };
  }
}

/** 需要外部授权的 kind → provider（与 policy.ts / routes.ts 的契约一致）。 */
const KIND_GRANT_PROVIDER: Partial<Record<string, 'amap' | 'xhs'>> = {
  'travel.wish': 'amap',
  'external.read': 'xhs',
};

/**
 * 外部授权闸：`allowedKinds` 只是「允许这个能力」，**不等于**用户给了外部授权。
 * `travel.wish` 必须在当前生效边界里有一条未过期的 amap grant（撤权/到期 → 拒），
 * 口径与 `routes.ts` 的 `/external/*` 完全一致——旧出行链路以前只看 allowedKinds 就调模型、
 * 落愿望，等于绕过了授权窗口。
 */
export function legacyGrantDenial(
  boundary: EffectiveBoundaryV1,
  kind: string,
  nowMs: number,
): LegacyAutonomySkipReason | null {
  const provider = KIND_GRANT_PROVIDER[kind];
  if (!provider) return null;
  const grant = boundary.externalGrants.find((item) => item.provider === provider && item.expiresAt > nowMs);
  return grant ? null : 'grant_missing';
}

/** 当前生效的 provider 授权（没有/过期 → null）。 */
export function effectiveGrantFor(
  boundary: EffectiveBoundaryV1,
  provider: 'amap' | 'xhs',
  nowMs: number,
): EffectiveBoundaryV1['externalGrants'][number] | null {
  return boundary.externalGrants.find((item) => item.provider === provider && item.expiresAt > nowMs) ?? null;
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
  const grantDenial = legacyGrantDenial(boundary, LEGACY_AUTONOMY_KIND, nowMs);
  if (grantDenial) return grantDenial;

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
  /**
   * 是否把本次调用的 `kind` 计入角色层 per-kind 配额（默认 true）。
   *
   * 出行链路的模型调用必须传 `false`：它的 `kind`（`travel.wish`）只是用来判
   * 「这条能力有没有被授权」，真正的业务效果计数由**效果核销**
   * （`reserveLegacyEffect`）负责。两处都记 → 一条合法愿望占两格，
   * `perKindActionsPerDay = 1` 时首条愿望永远落不了（上一轮退回的问题）。
   */
  countKind?: boolean;
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
  const grantDenial = legacyGrantDenial(boundary, args.kind ?? LEGACY_AUTONOMY_KIND, args.nowMs);
  if (grantDenial) return { ok: false, reason: grantDenial };

  const port = createD1BudgetPort({ db: args.db, ownerId: args.ownerId });
  if (!port.available()) return { ok: false, reason: 'budget_exhausted' };
  const windowId = windowIdAt({ now: () => args.nowMs }, boundary.timezone);
  const gateKind = args.kind ?? LEGACY_AUTONOMY_KIND;
  const reservation = await reserveBudget(port, {
    nowMs: args.nowMs,
    windowTimezone: boundary.timezone,
    accountId: args.ownerId,
    charId: args.charId,
    limits: boundary.limits,
    calls: 1,
    tokens: args.reserveTokens ?? LEGACY_ROUND_RESERVE_TOKENS,
    // `countKind === false` → 只保留「这次调用属于哪个 kind」的门禁语义（边界/授权已在
    // 上面判过），**不**把 kind 计数写进预算行：效果配额由效果核销单独占一格。
    kind: args.countKind === false ? undefined : gateKind,
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
    || legacyBoundaryDenial(recheck.boundary, args.kind ?? LEGACY_AUTONOMY_KIND) !== null
    || legacyGrantDenial(recheck.boundary, args.kind ?? LEGACY_AUTONOMY_KIND, args.nowMs) !== null;
  if (changed) {
    await settleBudget(settledPort, reservation.grant, { requestStarted: false }).catch(() => undefined);
    return { ok: false, reason: recheck.ok ? (legacyBoundaryDenial(recheck.boundary, args.kind ?? LEGACY_AUTONOMY_KIND) ?? legacyGrantDenial(recheck.boundary, args.kind ?? LEGACY_AUTONOMY_KIND, args.nowMs) ?? 'paused') : recheck.reason };
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
  /** 当前可信服务端时钟：给了就按它复核凭据是否已过期（不看排队时的旧时钟）。 */
  nowMs?: number;
}): Promise<boolean> {
  const port = createD1BudgetPort({ db: args.db, ownerId: args.permit.ownerId });
  const settled = await settleBudget(port, args.permit.grant, {
    actualTokens: args.actualTokens ?? null,
    requestStarted: args.requestStarted,
    ...(args.nowMs != null ? { nowMs: args.nowMs } : {}),
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

export type LegacyQuotaFailure = LegacyAutonomySkipReason | 'notifications_exhausted' | 'external_quota_exhausted' | 'boundary_changed';

/** 授权窗口的当日已用（`/external/*` 也用这张表；0 = 还没有记录）。 */
export async function readExternalUsage(args: {
  db: LifeDb;
  ownerId: string;
  dayKey: string;
  provider: 'amap' | 'xhs';
}): Promise<number> {
  const row = await args.db
    .prepare('SELECT used FROM autonomy_life_external_usage WHERE owner_id = ? AND day_key = ? AND provider = ?')
    .bind(args.ownerId, args.dayKey, args.provider)
    .first()
    .catch(() => null);
  const used = Number(row?.used ?? 0);
  return Number.isFinite(used) && used > 0 ? used : 0;
}

/**
 * 在统一账本里**原子**核销一格配额（不涉及模型调用）。
 *
 *   - `notification: true` → 账号层 `notificationsPerDay`（多角色共享同一格）；
 *   - `kind: 'travel.wish'` → 角色层 `perKindActionsPerDay` + kind 计数，
 *     并且必须当前仍有未过期的 amap 授权、授权窗口的当日额度还有余量。
 *
 * 为什么必须走统一账本：旧链路（AIRP 回合的提醒、出行愿望）以前只读自己的旧开关，
 * 于是「新设置里通知关掉 / 额度用完 / 授权撤掉」根本挡不住它。
 *
 * 并发安全怎么来的：判额 + 占额 + **边界 revision / 暂停 / 授权**都在
 * `consumeLegacyQuotaAtomic` 的**同一条条件语句**里（`store.ts`）。这里不再
 * 「读完边界再写预算」——那正是上一轮被退回的竞态窗口（读完边界后用户收紧额度/暂停，
 * 预算仍按旧值占格并放行）。
 *
 * 失败时不留下任何预算行/预留记录/效果记录（条件语句 0 行 = 零写入）。
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
  const kind = args.kind;
  // 边界本身先过一遍：暂停/关角色/kind 未授权时连额度都不该占。
  const denial = legacyBoundaryDenial(boundary, kind ?? LEGACY_AUTONOMY_KIND);
  if (denial) return { ok: false, reason: denial };
  if (kind) {
    const grantDenial = legacyGrantDenial(boundary, kind, args.nowMs);
    if (grantDenial) return { ok: false, reason: grantDenial };
  }

  const windowId = windowIdAt({ now: () => args.nowMs }, boundary.timezone);
  const kindLimit = boundary.limits.perKindActionsPerDay ?? DEFAULT_ACCOUNT_LIMITS.perKindActionsPerDay;
  const notificationLimit = boundary.limits.notificationsPerDay ?? DEFAULT_ACCOUNT_LIMITS.notificationsPerDay;

  // 授权窗口的每日额度（与 `/external/wish` 同口径）：先只读预判，避免白占 kind 名额；
  // 真正的占用在核销之后用条件 UPDATE 原子扣（并发不会超卖）。
  let grant: ReturnType<typeof effectiveGrantFor> = null;
  let dayKey = '';
  if (kind) {
    const provider = KIND_GRANT_PROVIDER[kind];
    if (provider) {
      grant = effectiveGrantFor(boundary, provider, args.nowMs);
      if (grant) {
        dayKey = localDateKey(args.nowMs, boundary.timezone);
        if (!(grant.dailyQuota > 0)) return { ok: false, reason: 'external_quota_exhausted' };
        const used = await readExternalUsage({ db: args.db, ownerId: args.ownerId, dayKey, provider });
        if (used >= grant.dailyQuota) return { ok: false, reason: 'external_quota_exhausted' };
      }
    }
  }

  const consumed = await consumeLegacyQuotaAtomic({
    db: args.db,
    ownerId: args.ownerId,
    charId: args.charId,
    windowId,
    nowMs: args.nowMs,
    expectedAccountRevision: boundary.accountRevision ?? null,
    expectedCharacterRevision: boundary.characterRevision ?? null,
    ...(args.notification ? { notificationLimit } : {}),
    ...(kind ? { kind: { kind, limit: kindLimit } } : {}),
    ...(kind && KIND_GRANT_PROVIDER[kind] ? { requireGrant: KIND_GRANT_PROVIDER[kind]! } : {}),
  });
  if (!consumed.ok) {
    if (consumed.reason === 'notifications_exhausted') return { ok: false, reason: 'notifications_exhausted' };
    if (consumed.reason === 'external_quota_exhausted') return { ok: false, reason: 'external_quota_exhausted' };
    if (consumed.reason === 'boundary_changed') return { ok: false, reason: 'boundary_changed' };
    if (consumed.reason === 'kind_exhausted') return { ok: false, reason: 'budget_exhausted' };
    if (consumed.reason === 'invalid_input') return { ok: false, reason: 'budget_exhausted' };
    return { ok: false, reason: 'budget_exhausted' };
  }

  // kind 名额已经占上；授权窗口的当日额度最后扣。这一步同样必须**原子绑定当前边界**：
  // 以前这里用「读边界时拿到的 grant.dailyQuota」去 `consumeExternalQuota`，语句里既没有
  // 边界 revision 也不看当前授权 → 在这两步之间把额度收紧到 0 / 撤权 / 暂停仍会放行
  // （上一轮退回的竞态）。现在额度、授权有效性与 revision 全在同一条条件语句里判，
  // 0 行 → 拒绝写效果（fail closed；浪费一格 kind 名额是可接受的保守方向）。
  if (grant && dayKey) {
    const quota = await consumeExternalQuotaAtomic({
      db: args.db,
      ownerId: args.ownerId,
      charId: args.charId,
      dayKey,
      provider: grant.provider,
      nowMs: args.nowMs,
      expectedAccountRevision: boundary.accountRevision ?? null,
      expectedCharacterRevision: boundary.characterRevision ?? null,
    });
    if (!quota.ok) {
      if (quota.reason === 'boundary_changed') return { ok: false, reason: 'boundary_changed' };
      if (quota.reason === 'external_quota_exhausted') return { ok: false, reason: 'external_quota_exhausted' };
      return { ok: false, reason: 'budget_exhausted' };
    }
  }
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
