/**
 * 出行 · 后台 tick（B3）
 *
 * 这一层是**唯一**推进行程的地方：页面关着照样走，不依赖任何前端请求、不依赖推送订阅
 * （订阅只是通知，不是推进前置条件）。可挂 `scheduled`：
 *
 *   export default { fetch, scheduled: (controller, env, ctx) => handleTravelScheduled(controller, env, deps) }
 *   runTravelTick(env, deps)  // 也可以由 cron / 手动补跑直接调
 *
 * 一次 tick 的硬约束：
 * - **一个 subject 最多一次地图 HTTP 尝试**：预算在真正发请求前懒预留一次，之后同一 tick
 *   内再要地图就用这一次的结果；失败**不退** `map_calls_used`（B1 的 `settleMapCall`
 *   在失败时会退还 calls_used，tick 这一层刻意不调它，避免「失败→退款→再失败」的
 *   无限重试把预算表刷成假账；失败的重试只能由下一 tick 的新预算花掉）。
 * - **先复核再执行**：每次模型/地图调用前重读 `travel_budget_state.paused` 与护栏；
 *   暂停期间只做零成本的时间相位推进，不起新的模型/地图请求。
 * - **并发不重复**：wish 状态用条件 UPDATE 认领（`WHERE state = ?`），行程用
 *   `upsertTravelTrip` 的唯一 dedupe 键认领；没抢到的那一方直接跳过，不会再打一次模型或路线。
 * - **写全部 CAS**：行程只走 `casUpdateTravelTrip`（baseRevision）；wish 只走条件 UPDATE。
 * - **几何未许可就不落库**：`geometryPersistence !== 'allowed'` 时 `route` 恒为 null，
 *   `arriveAt` 也留 null（没有官方时长就不编 ETA）。
 */

import {
  TRAVEL_STALE_TRIP_MS,
  TRAVEL_RETENTION_DEFAULTS,
  type TravelCoordSys,
  type TravelPlaceAnchor,
  type TravelPlaceRef,
  type TravelProviderId,
  type TravelTripStatus,
} from '../../../../contracts/travel';
import {
  canChangePlan,
  canTransition,
  isTerminalStatus,
  positionAt,
  tripProgress,
} from '../../../../utils/travel/core';
import {
  appendTravelTripEvent,
  casUpdateTravelTrip,
  ensureTravelSchema,
  getActiveTravelTrip,
  appendTravelPosition,
  getLatestTripForWish,
  getTravelCandidate,
  getTravelCharSettings,
  getTravelSettings,
  getTravelShareState,
  listTravelCandidates,
  listTravelWishes,
  pruneTravelRetention,
  saveTravelCandidates,
  setTravelWishSelectedCandidate,
  upsertTravelTrip,
  type TravelDb,
  type TravelTripRecord,
  type TravelWishRecord,
} from './store';
import {
  getTravelBudget,
  reserveLlmTokens,
  reserveMapCall,
  resolveTravelBudgetGate,
  settleLlmTokens,
  type TravelLlmLedgerPort,
} from './budget';
import {
  providerForRegion,
  TravelProviderError,
  type TravelMapProvider,
  type TravelProviderRegion,
} from './provider';
import {
  decideWanderSegment,
  decideWishAction,
  proposeTravelIntent,
  toDecisionCandidates,
  type TravelDecisionPort,
  type TravelSegmentAction,
  type TravelSegmentContext,
} from './decision';
import {
  WANDER_CATEGORY,
  claimIntentProbe,
  finalizeIntentProbe,
  TRAVEL_INTENT_PROBE_WINDOW_MS,
} from './intent';
import { resolveTravelLicenses, retentionExpiryFor } from './state';

export interface TravelTickSubject {
  userId: string;
  charId: string;
}

export interface TravelTickWiring {
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  /** 候选 provider（按地区挑一个）。没有就只推进时间相位，不搜点、不排路线。 */
  providers?: readonly TravelMapProvider[];
  region?: TravelProviderRegion;
  /**
   * 按主体挑地区：国内走高德，国外走 world。缺省按锚点城市判（国内常见城市名 → CN，
   * 否则 overseas）。两边都没有可用 provider 时 `pickProvider` 返回 null → 不搜点、不画直线。
   */
  resolveRegion?: (subject: TravelTickSubject, anchor: TravelPlaceAnchor | null) => TravelProviderRegion;
  /** 角色住处锚点（用户确认过的）。没有就 `ANCHOR_NOT_CONFIRMED`，不拿城市中心冒充。 */
  readAnchor?: (subject: TravelTickSubject) => Promise<TravelPlaceAnchor | null>;
  decisionPort?: TravelDecisionPort | null;
  llmPort?: TravelLlmLedgerPort | null;
  /** 每次决策预留多少 token（缺省 1200；结算按同一预估值，端口不回 usage）。 */
  llmTokensPerDecision?: number;
  city?: string;
  licensedGeometry?: boolean;
  tripRetentionDays?: number;
  eventRetentionDays?: number;
  prune?: boolean;
  /** 停留时长（分钟）；缺省 45，仅用于「到了之后待多久」，不参与 ETA 编造。 */
  dwellMinutes?: number;
  /**
   * 自主意愿探针窗口（毫秒）：窗口内最多问一次「想不想出去」。
   * 缺省 3 小时；0/负数按最小 1 分钟夹住（不会变成「每 tick 都问」）。
   */
  intentWindowMs?: number;
  timeoutMs?: number;
}

export type TravelTickSkipReason =
  | 'budget_missing'
  | 'paused'
  /** 账号总开关没开 / 缺 settings 行（缺行 = 未开启，不默认开启）。 */
  | 'disabled'
  /** 这个角色没被单独启用。 */
  | 'char_disabled'
  | 'budget_blocked'
  | 'no_provider'
  | 'provider_failed'
  | 'anchor_missing'
  | 'llm_unavailable'
  | 'reroll'
  | 'wait'
  | 'cas_conflict'
  | 'no_wish'
  | 'dropped';

export interface TravelTickOutcome {
  subject: TravelTickSubject;
  advanced: TravelTripStatus[];
  searched: boolean;
  decided: boolean;
  planned: boolean;
  expired: boolean;
  skipped: TravelTickSkipReason[];
  /** 本 tick 是否真的花了一次地图预算（诊断/回归用）。 */
  mapReserved: boolean;
  /** 闲逛这一跳由角色做的分段动作（没有分段决策就是 null）。 */
  segment: TravelSegmentAction | null;
}

export interface TravelTickReport {
  nowMs: number;
  subjects: number;
  outcomes: TravelTickOutcome[];
  pruned: { trips: number; events: number; candidates: number; wishes: number } | null;
}

const DEFAULT_DWELL_MINUTES = 45;

const eventExpiry = (nowMs: number, days: number): number =>
  nowMs + Math.max(0, Math.trunc(days)) * 24 * 60 * 60 * 1000;

/**
 * wish 状态认领（真条件 UPDATE）：只有 `WHERE state = from` 命中 1 行才算抢到。
 * 不抢到说明另一个 tick / 另一台设备已经推进过这一步 —— 直接放弃本轮，不重复调模型。
 */
async function claimWishState(
  db: TravelDb,
  args: { userId: string; wishId: string; from: string; to: string; nowMs: number },
): Promise<boolean> {
  const result = await db
    .prepare('UPDATE travel_wishes SET state = ?, updated_at = ? WHERE user_id = ? AND id = ? AND state = ?')
    .bind(args.to, args.nowMs, args.userId, args.wishId, args.from)
    .run();
  const raw = result as { meta?: { changes?: unknown }; changes?: unknown } | null;
  const changes = Number(raw?.meta?.changes ?? raw?.changes ?? 0);
  return changes === 1;
}

/** 补偿：认领后模型失败，把 wish 放回可重试态（不是改成「不想出门」）。 */
async function releaseWishState(
  db: TravelDb,
  args: { userId: string; wishId: string; from: string; to: string; nowMs: number },
): Promise<void> {
  await db
    .prepare('UPDATE travel_wishes SET state = ?, updated_at = ? WHERE user_id = ? AND id = ? AND state = ?')
    .bind(args.to, args.nowMs, args.userId, args.wishId, args.from)
    .run();
}

const refFromAnchor = (anchor: TravelPlaceAnchor): TravelPlaceRef => ({
  label: anchor.label,
  city: anchor.city,
  ...(anchor.district ? { district: anchor.district } : {}),
  lat: anchor.lat,
  lng: anchor.lng,
  coordSys: anchor.coordSys,
  kind: 'anchor',
});

const refFromCandidate = (candidate: {
  label: string;
  city?: string;
  district?: string;
  lat: number;
  lng: number;
  coordSys: TravelCoordSys;
  placeId?: string;
}): TravelPlaceRef => ({
  label: candidate.label,
  city: candidate.city ?? '',
  ...(candidate.district ? { district: candidate.district } : {}),
  lat: candidate.lat,
  lng: candidate.lng,
  coordSys: candidate.coordSys,
  ...(candidate.placeId ? { placeId: candidate.placeId } : {}),
  kind: 'public',
});

const providerFailureKind = (error: unknown): string =>
  error instanceof TravelProviderError ? error.kind : 'bad-response';

const isUnavailableKind = (kind: string): boolean =>
  kind === 'unsupported-region' || kind === 'not-configured';

/**
 * 把一个 subject 推进一格。导出供测试与手动补跑使用（不导出不代表可以被路由调用：
 * 路由层没有任何「推进」端点）。
 */
export async function runTravelTickForSubject(
  db: TravelDb,
  subject: TravelTickSubject,
  wiring: TravelTickWiring = {},
): Promise<TravelTickOutcome> {
  const nowMs = (wiring.now ?? (() => Date.now()))();
  const eventDays = wiring.eventRetentionDays ?? TRAVEL_RETENTION_DEFAULTS.eventDays;
  const outcome: TravelTickOutcome = {
    subject,
    advanced: [],
    searched: false,
    decided: false,
    planned: false,
    expired: false,
    skipped: [],
    mapReserved: false,
    segment: null,
  };

  await ensureTravelSchema(db);

  // 用户总开关 + 角色启用位都是**执行前**复核的授权边界：缺行 = 没开。
  const accountSettings = await getTravelSettings(db, subject.userId);
  if (!accountSettings || accountSettings.enabled !== true) {
    outcome.skipped.push('disabled');
    return outcome;
  }
  const charSettings = await getTravelCharSettings(db, {
    userId: subject.userId,
    charId: subject.charId,
  });
  if (!charSettings || charSettings.enabled !== true) {
    outcome.skipped.push('char_disabled');
    return outcome;
  }

  const budget = await getTravelBudget(db, { userId: subject.userId, nowMs });
  if (!budget) {
    // 没有账本行 = 用户没配额度。不是「无限额度」，也不替用户建一个默认值。
    outcome.skipped.push('budget_missing');
    return outcome;
  }

  // 预算：**每一次真正发出去的地图请求**扣一格。tick 只做只读闸门检查（不扣费），
  // 扣费统一由 provider 在出口处调用一次 —— 两边都扣就是双扣。
  let gateCache: boolean | null = null;
  const mapGateAllows = async (): Promise<boolean> => {
    if (gateCache !== null) return gateCache;
    const gate = await resolveTravelBudgetGate(db, { userId: subject.userId, nowMs, kind: 'map' });
    gateCache = gate.allowed;
    return gateCache;
  };

  const providerDeps = {
    fetch: wiring.fetch ?? globalThis.fetch,
    reserveMapCall: async () => {
      if (!(await mapGateAllows())) {
        return { allowed: false as const, code: 'BUDGET_BLOCKED' as const };
      }
      const reserved = await reserveMapCall(db, { userId: subject.userId, nowMs });
      if (!reserved.ok) {
        // 并发下额度刚被抢完：这一次请求不发，闸门也作废（后续不再假装还有额度）。
        gateCache = false;
        return { allowed: false as const, code: reserved.code };
      }
      outcome.mapReserved = true;
      return { allowed: true as const };
    },
    now: () => nowMs,
    ...(wiring.timeoutMs ? { timeoutMs: wiring.timeoutMs } : {}),
  };

  const settings = await getTravelSettings(db, subject.userId);
  const tripDays = wiring.tripRetentionDays ?? settings?.tripRetentionDays ?? TRAVEL_RETENTION_DEFAULTS.tripDays;

  const addEvent = async (tripId: string, kind: string, payload?: unknown): Promise<void> => {
    try {
      await appendTravelTripEvent(db, {
        userId: subject.userId,
        tripId,
        kind,
        at: nowMs,
        ...(payload === undefined ? {} : { payload }),
        source: 'travel_tick',
        nowMs,
        expiresAt: eventExpiry(nowMs, eventDays),
      });
    } catch {
      /* 事件是证据不是状态机：写不进去不影响行程推进，下一跳还能补 */
    }
  };

  let active = await getActiveTravelTrip(db, { userId: subject.userId, charId: subject.charId });

  /**
   * 位置历史只在**两种条件同时成立**时写：有几何许可，且这趟行程真有 provider 给回来的
   * 折线。没有任何可信几何时不插值、不编造轨迹（历史为空就是空）。
   */
  const recordPosition = async (trip: TravelTripRecord): Promise<void> => {
    if (wiring.licensedGeometry !== true) return;
    if (trip.status !== 'en_route' && trip.status !== 'returning') return;
    const points = trip.route?.points;
    if (!points || points.length < 2) return;
    let ratio = 0;
    try {
      const progress = tripProgress(trip, nowMs);
      ratio = trip.status === 'returning' ? progress.returnRatio : progress.outboundRatio;
    } catch {
      return;
    }
    const point = positionAt(points, ratio);
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;
    // 代数记下写入当时的共享版本：共享关了再开，版本 +1，旧代际的点不会被重新放出去。
    let shareGeneration = 0;
    try {
      const shareRow = await getTravelShareState(db, { userId: subject.userId, charId: subject.charId });
      shareGeneration = shareRow?.version ?? 0;
    } catch {
      shareGeneration = 0;
    }
    try {
      await appendTravelPosition(db, {
        userId: subject.userId,
        tripId: trip.id,
        at: nowMs,
        lat: point.lat,
        lng: point.lng,
        coordSys: trip.coordSys,
        shareGeneration,
        nowMs,
      });
    } catch {
      /* 轨迹是证据不是状态机：写不进去不影响相位推进 */
    }
  };

  /**
   * 这一趟是不是闲逛（`category === 'wander'`）。读在相位推进之前：闲逛的「停留结束」
   * 不是自动回家，而是**问角色**下一步做什么，所以不能先被 nextPhaseFor 推到 returning。
   */
  let wishes: TravelWishRecord[] = [];
  try {
    wishes = await listTravelWishes(db, {
      userId: subject.userId,
      charId: subject.charId,
      nowMs,
      states: ['open', 'candidates_ready', 'chosen'],
    });
  } catch {
    wishes = [];
  }
  const tripWishId = active ? wishIdFromDedupeKey(active.dedupeKey) : null;
  const activeWish: TravelWishRecord | null =
    (tripWishId ? wishes.find((w) => w.id === tripWishId) : null) ?? null;
  const wanderTrip = !!(active
    && activeWish
    && (activeWish.category ?? '') === WANDER_CATEGORY
    && (active.status === 'dwelling' || active.status === 'en_route' || active.status === 'planned'));

  /* ---------- 1. 时间相位推进（零成本，暂停也照走：虚拟时间不因用户暂停而冻结） ---------- */
  if (active) {
    const plan = nextPhaseFor(active, nowMs);
    if (plan.kind === 'expire') {
      const cas = await casUpdateTravelTrip(db, {
        userId: subject.userId,
        tripId: active.id,
        baseRevision: active.revision,
        patch: { status: 'expired' },
        nowMs,
      });
      if (cas.ok) {
        active = cas.trip;
        outcome.expired = true;
        outcome.advanced.push('expired');
        await addEvent(active.id, 'expired', { reason: 'stale' });
      } else {
        outcome.skipped.push('cas_conflict');
      }
    } else if (
      plan.kind === 'advance'
      // 闲逛的驻留结束交给角色自己的分段决策：这里不替角色决定回家。
      // （en_route→dwelling 照常推进；只有 dwelling→returning 这一条要等分段。）
      && !(wanderTrip && active.status === 'dwelling' && plan.to === 'returning')
      && canTransition(active.status, plan.to)
    ) {
      const cas = await casUpdateTravelTrip(db, {
        userId: subject.userId,
        tripId: active.id,
        baseRevision: active.revision,
        patch: { status: plan.to },
        nowMs,
      });
      if (cas.ok) {
        const from = active.status;
        active = cas.trip;
        outcome.advanced.push(plan.to);
        await addEvent(active.id, 'phase', { from, to: plan.to });
      } else {
        outcome.skipped.push('cas_conflict');
      }
    }
  }

  /**
   * 一趟走完（returned / stopped / expired）→ 把这条愿望闭环成 `completed`。
   * 不闭环的话 `chosen` 会在下一跳被 §6 当成「还要再排一次」→ 无限重排、反复烧地图。
   */
  if (active && activeWish && isTerminalStatus(active.status)) {
    try {
      await db
        .prepare(
          "UPDATE travel_wishes SET state = 'completed', updated_at = ? WHERE user_id = ? AND id = ? AND state = 'chosen'",
        )
        .bind(nowMs, subject.userId, activeWish.id)
        .run();
    } catch {
      /* 愿望收尾失败不影响行程：下一跳还会再试 */
    }
    // 本跳前面读到的是旧快照：别再拿这条已闭环的愿望去重排一次。
    wishes = wishes.filter((w) => w.id !== activeWish!.id);
  }

  // 相位推进过之后补一个位置采样（只有许可 + 真实几何才写）。
  if (active && !isTerminalStatus(active.status)) await recordPosition(active);

  /* ---------- 2. 暂停：不再起新的模型/地图请求 ---------- */
  if (budget.paused) {
    outcome.skipped.push('paused');
    return outcome;
  }

  /* ---------- 2.5 闲逛分段：驻留结束由角色自己决定下一步 ---------- */
  if (
    active
    && activeWish
    && wanderTrip
    && active.status === 'dwelling'
    && active.dwellUntil !== null
    && nowMs >= active.dwellUntil
  ) {
    const dwellMinutes = Math.max(1, Math.trunc(wiring.dwellMinutes ?? DEFAULT_DWELL_MINUTES));
    const dwellMs = dwellMinutes * 60 * 1000;

    // 并发闸：先用 CAS 把这一段的「决策权」抢下来（只 bump revision，不改语义）。
    // 抢不到说明另一个 tick / 另一台设备正在为同一段做决定 —— 直接放弃，
    // 不再打一次模型、也不再打一次地图。
    const claim = await casUpdateTravelTrip(db, {
      userId: subject.userId,
      tripId: active.id,
      baseRevision: active.revision,
      patch: { dwellUntil: active.dwellUntil },
      nowMs,
    });
    if (!claim.ok) {
      outcome.skipped.push('cas_conflict');
      return outcome;
    }
    const segmentTrip = claim.trip;

    // 没有模型端口 = 没有能力替角色做这个决定：**留在原地**，愿望与行程都不动，
    // 下一跳还可能恢复（凭据/额度补上）。不写「角色想回家」，也不标 returned。
    if (!wiring.decisionPort || typeof wiring.decisionPort.nextSegment !== 'function') {
      outcome.skipped.push('llm_unavailable');
      return outcome;
    }

    // 账本：先预留再调模型；幂等键绑定「这一趟 + 这一段（planVersion + 停留截止）」，
    // 同一段重放不会重复扣 token。
    const segmentKey = `travel:seg:${segmentTrip.id}:v${segmentTrip.planVersion}:d${segmentTrip.dwellUntil}`;
    const estimateTokens = Math.max(1, Math.trunc(wiring.llmTokensPerDecision ?? 1200));
    let reservation: string | null = null;
    if (wiring.llmPort) {
      const gate = await resolveTravelBudgetGate(db, {
        userId: subject.userId,
        nowMs,
        kind: 'llm',
        port: wiring.llmPort,
      });
      if (!gate.allowed) {
        outcome.skipped.push('budget_blocked');
        return outcome;
      }
      const reserved = await reserveLlmTokens(db, {
        userId: subject.userId,
        tokens: estimateTokens,
        idempotencyKey: segmentKey,
        nowMs,
        port: wiring.llmPort,
      });
      if (!reserved.ok) {
        outcome.skipped.push('budget_blocked');
        return outcome;
      }
      reservation = reserved.reservationId;
    }

    const anchor = await readAnchorSafe(wiring, subject);
    const provider = pickProvider(wiring, subject, anchor);
    const here: TravelPlaceRef | null = segmentTrip.dest;

    // 真实候选：优先复用「本段已经查过的那一批」（同一段重放不再花地图），
    // 否则在有额度 + 有 provider + 有落脚点时搜一次。
    let batch: Awaited<ReturnType<typeof listTravelCandidates>> = [];
    try {
      const known = await listTravelCandidates(db, {
        userId: subject.userId,
        wishId: activeWish.id,
        nowMs,
      });
      batch = known.filter((c) => Number(c.createdAt ?? 0) >= Number(segmentTrip.dwellUntil ?? 0));
    } catch {
      batch = [];
    }
    if (batch.length === 0 && here && provider && (await mapGateAllows())) {
      try {
        const hits = await provider.searchCandidates({
          wishText: activeWish.wishText,
          city: anchor?.city ?? '',
          center: { lat: here.lat, lng: here.lng, coordSys: here.coordSys ?? segmentTrip.coordSys },
          limit: 6,
        });
        outcome.searched = true;
        if (hits.length > 0) {
          const candidates = hits.map((hit) => ({
            id: `tc:${subject.userId}:${activeWish!.id}:${crypto.randomUUID()}`,
            userId: subject.userId,
            wishId: activeWish!.id,
            provider: hit.provider,
            ...(hit.id ? { placeId: String(hit.id) } : {}),
            label: hit.label,
            ...(hit.category ? { category: hit.category } : {}),
            city: hit.city,
            ...(hit.district ? { district: hit.district } : {}),
            lat: hit.location.lat,
            lng: hit.location.lng,
            coordSys: hit.location.coordSys,
            distanceM: hit.distanceM,
            expiresAt: nowMs + 6 * 60 * 60 * 1000,
            createdAt: nowMs,
          }));
          await saveTravelCandidates(db, { userId: subject.userId, wishId: activeWish.id, candidates, nowMs });
          batch = await listTravelCandidates(db, { userId: subject.userId, wishId: activeWish.id, nowMs });
        }
      } catch (error) {
        // 地图失败不等于角色改了主意：这一轮没有候选，模型仍可 stay/return/stop。
        if (providerFailureKind(error) === 'budget') {
          gateCache = false;
        }
      }
    }

    const minutesOut = segmentTrip.departAt === null
      ? 0
      : Math.max(0, Math.round((nowMs - segmentTrip.departAt) / 60000));
    const context: TravelSegmentContext = {
      wishText: activeWish.wishText,
      hereLabel: here?.label ?? null,
      homeLabel: segmentTrip.origin.label ?? null,
      segmentsSoFar: Math.max(0, segmentTrip.planVersion - 1),
      minutesOut,
      // 回家要走多久：只有真有几何 + 官方时长时才给，不编。
      minutesHome: segmentTrip.arriveAt !== null && segmentTrip.departAt !== null
        ? Math.max(0, Math.round((segmentTrip.arriveAt - segmentTrip.departAt) / 60000))
        : null,
      candidates: toDecisionCandidates(batch),
    };

    const decision = await decideWanderSegment({
      context,
      decisionPort: wiring.decisionPort,
      fallbackStayMinutes: dwellMinutes,
    });

    const settleSegment = async (ok: boolean): Promise<void> => {
      if (!reservation || !wiring.llmPort) return;
      // 真实 usage 优先（供应商回了就用真值），没有才按预估结算：宁多算不少算。
      const real = wiring.decisionPort?.lastUsageTokens?.();
      const usage = typeof real === 'number' && Number.isFinite(real) && real > 0
        ? Math.trunc(real)
        : null;
      try {
        await settleLlmTokens(db, {
          userId: subject.userId,
          reservationId: reservation,
          actualTokens: ok ? usage ?? estimateTokens : usage ?? 0,
          ok,
          nowMs,
          port: wiring.llmPort,
        });
      } catch {
        /* 结算失败不改状态机：下一跳账本读取会看到预留仍在（fail-closed） */
      }
    };

    if (decision.kind === 'wait') {
      // 接口失败/输出不合法/没候选：**零状态写入**，行程还停在 dwelling，愿望保留。
      await settleSegment(false);
      outcome.skipped.push(decision.reason === 'llm_unavailable' ? 'llm_unavailable' : 'wait');
      return outcome;
    }
    await settleSegment(true);
    outcome.segment = decision.kind;

    if (decision.kind === 'stay') {
      const extendTo = nowMs + Math.max(1, decision.minutes ?? dwellMinutes) * 60000;
      const cas = await casUpdateTravelTrip(db, {
        userId: subject.userId,
        tripId: segmentTrip.id,
        baseRevision: segmentTrip.revision,
        patch: { dwellUntil: extendTo },
        nowMs,
      });
      if (!cas.ok) {
        outcome.skipped.push('cas_conflict');
        return outcome;
      }
      await addEvent(segmentTrip.id, 'segment_stay', {
        until: extendTo,
        minutes: decision.minutes,
        ...(decision.reason ? { reason: decision.reason } : {}),
      });
      return outcome;
    }

    if (decision.kind === 'stop') {
      // 在外结束：终态 `stopped`（不是 returned —— 人没回家）。行程行保留 dest，
      // 快照按终态剥离，所以不会把「停在书店」画成「已经到家」。
      const cas = await casUpdateTravelTrip(db, {
        userId: subject.userId,
        tripId: segmentTrip.id,
        baseRevision: segmentTrip.revision,
        patch: { status: 'stopped' },
        nowMs,
      });
      if (!cas.ok) {
        outcome.skipped.push('cas_conflict');
        return outcome;
      }
      await addEvent(segmentTrip.id, 'segment_stop', {
        endedAway: true,
        atLabel: here?.label ?? null,
        ...(decision.reason ? { reason: decision.reason } : {}),
      });
      return outcome;
    }

    if (!anchor || !provider || !here) {
      // 想走却拿不到锚点/路线实现：留在原地，不画直线、不假装回家。
      outcome.skipped.push(anchor ? 'no_provider' : 'anchor_missing');
      return outcome;
    }

    if (decision.kind === 'next') {
      const picked = batch.find((c) => c.id === decision.candidateId) ?? null;
      if (!picked) {
        outcome.skipped.push('wait');
        return outcome;
      }
      const leg = await planSegmentLeg(db, subject, {
        wish: activeWish,
        current: segmentTrip,
        kind: 'next',
        from: here,
        to: refFromCandidate(picked),
        provider,
        providerDeps,
        mapGateAllows,
        addEvent,
        tripDays,
        nowMs,
        dwellMs,
        licensedGeometry: wiring.licensedGeometry === true,
        reason: decision.reason ?? null,
      });
      if (leg === 'planned') outcome.planned = true;
      else outcome.skipped.push('provider_failed');
      return outcome;
    }

    // decision.kind === 'return'：沿真实路线回锚点（不是原地标 returned）。
    const leg = await planSegmentLeg(db, subject, {
      wish: activeWish,
      current: segmentTrip,
      kind: 'return',
      from: here,
      to: refFromAnchor(anchor),
      provider,
      providerDeps,
      mapGateAllows,
      addEvent,
      tripDays,
      nowMs,
      dwellMs,
      licensedGeometry: wiring.licensedGeometry === true,
      reason: decision.reason ?? null,
    });
    if (leg === 'planned') outcome.planned = true;
    else outcome.skipped.push('provider_failed');
    return outcome;
  }

  /* ---------- 3. 已有非终态行程：只在有更新一代的愿望时改计划 ---------- */
  if (active && !isTerminalStatus(active.status)) {
    // 只认**另一条**愿望改的计划：当前在途代自己的愿望会一直是 chosen，
    // 若不过滤就会每跳都重排一次路线 —— 那是纯烧地图额度、把「按分钟 tick」变成
    // 「每分钟重算一遍」，用户什么也看不到。
    const newer = wishes.find(
      (w) => w.state === 'chosen' && !active.dedupeKey.startsWith(`wish:${w.id}:plan:`),
    );
    if (newer && canChangePlan(active.status)) {
      const planned = await planTripForWish(db, subject, newer, {
        wiring,
        nowMs,
        providerDeps,
        active,
        tripDays,
        mapGateAllows,
        addEvent,
      });
      if (planned === 'planned') {
        outcome.planned = true;
        const fresh = await getActiveTravelTrip(db, { userId: subject.userId, charId: subject.charId });
        if (fresh) await recordPosition(fresh);
      } else outcome.skipped.push('provider_failed');
    }
    return outcome;
  }

  const wish = wishes[0];
  if (!wish) {
    /*
     * 没有愿望。上游的自主回合要推送订阅才跑（`autonomyScheduler` 的闸 1.5，
     * 上游对无订阅任务回 409），所以「页面关着 + 没订阅」的用户永远拿不到愿望。
     * 这里用出行自己的授权 + 账本补一条**不需要推送**的探针回合：
     * 每个窗口最多问一次「想不想出去」，模型说不想就什么都不写。
     */
    const probeWindowMs = Math.max(60_000, Math.trunc(wiring.intentWindowMs ?? TRAVEL_INTENT_PROBE_WINDOW_MS));
    if (
      !active
      && wiring.decisionPort?.proposeIntent
      && budget.mapCallsLimit > 0
    ) {
      const probe = await claimIntentProbe(db, {
        charId: subject.charId,
        nowMs,
        windowMs: probeWindowMs,
      });
      if (probe.claimed) {
        const dropProbe = async (): Promise<void> => {
          try {
            await db
              .prepare("DELETE FROM travel_wishes WHERE id = ? AND user_id = '' AND state = 'open'")
              .bind(probe.wishId)
              .run();
          } catch {
            /* 删不掉就留着：它会在窗口结束时自然过期 */
          }
        };
        const estimate = Math.max(1, Math.trunc(wiring.llmTokensPerDecision ?? 1200));
        let inviteReservation: string | null = null;
        if (wiring.llmPort) {
          const gate = await resolveTravelBudgetGate(db, {
            userId: subject.userId,
            nowMs,
            kind: 'llm',
            port: wiring.llmPort,
          });
          if (!gate.allowed) {
            await dropProbe();
            outcome.skipped.push('budget_blocked');
            return outcome;
          }
          const reserved = await reserveLlmTokens(db, {
            userId: subject.userId,
            tokens: estimate,
            idempotencyKey: `travel:intent:${probe.wishId}`,
            nowMs,
            port: wiring.llmPort,
          });
          if (!reserved.ok) {
            await dropProbe();
            outcome.skipped.push('budget_blocked');
            return outcome;
          }
          inviteReservation = reserved.reservationId;
        }
        const anchor = await readAnchorSafe(wiring, subject);
        const proposal = await proposeTravelIntent({
          decisionPort: wiring.decisionPort,
          homeLabel: anchor?.label ?? null,
          minutesSinceLastOuting: null,
        });
        if (inviteReservation && wiring.llmPort) {
          try {
            await settleLlmTokens(db, {
              userId: subject.userId,
              reservationId: inviteReservation,
              actualTokens: proposal === null ? 0 : estimate,
              ok: proposal !== null,
              nowMs,
              port: wiring.llmPort,
            });
          } catch {
            /* 结算失败不改状态 */
          }
        }
        if (proposal === null) {
          // 端口缺失/抛错/输出坏了：这一轮没结论，删掉占位让下一跳还能再试。
          await dropProbe();
          outcome.skipped.push('llm_unavailable');
          return outcome;
        }
        const written = await finalizeIntentProbe(db, {
          userId: subject.userId,
          wishId: probe.wishId,
          proposal,
          nowMs,
        });
        if (written === 'written') return outcome;
      }
    }
    outcome.skipped.push('no_wish');
    return outcome;
  }

  /* ---------- 4. open：搜一批真实候选（一次地图调用） ---------- */
  if (wish.state === 'open') {
    const anchor = await readAnchorSafe(wiring, subject);
    if (!anchor) {
      outcome.skipped.push('anchor_missing');
      return outcome;
    }
    const provider = pickProvider(wiring, subject, anchor);
    if (!provider) {
      outcome.skipped.push('no_provider');
      return outcome;
    }
    if (!(await mapGateAllows())) {
      outcome.skipped.push('budget_blocked');
      return outcome;
    }
    try {
      const hits = await provider.searchCandidates({
        wishText: wish.wishText,
        city: anchor.city,
        center: { lat: anchor.lat, lng: anchor.lng, coordSys: anchor.coordSys },
        limit: 8,
      });
      outcome.searched = true;
      if (hits.length === 0) {
        outcome.skipped.push('provider_failed');
        return outcome;
      }
      const candidates = hits.map((hit) => ({
        // 候选 id 用租户/角色/意愿前缀 + 随机段，避免契约里「候选 id 是全局主键」的碰撞。
        id: `tc:${subject.userId}:${wish.id}:${crypto.randomUUID()}`,
        userId: subject.userId,
        wishId: wish.id,
        provider: hit.provider,
        ...(hit.id ? { placeId: String(hit.id) } : {}),
        label: hit.label,
        ...(hit.category ? { category: hit.category } : {}),
        city: hit.city,
        ...(hit.district ? { district: hit.district } : {}),
        lat: hit.location.lat,
        lng: hit.location.lng,
        coordSys: hit.location.coordSys,
        distanceM: hit.distanceM,
        expiresAt: nowMs + 6 * 60 * 60 * 1000,
        createdAt: nowMs,
      }));
      await saveTravelCandidates(db, { userId: subject.userId, wishId: wish.id, candidates, nowMs });
      const claimed = await claimWishState(db, {
        userId: subject.userId,
        wishId: wish.id,
        from: 'open',
        to: 'candidates_ready',
        nowMs,
      });
      if (!claimed) outcome.skipped.push('cas_conflict');
      return outcome;
    } catch (error) {
      outcome.skipped.push(providerFailureKind(error) === 'budget' ? 'budget_blocked' : 'provider_failed');
      return outcome;
    }
  }

  /* ---------- 5. candidates_ready：角色自己决定（模型经注入端口） ---------- */
  if (wish.state === 'candidates_ready') {
    const stored = await listTravelCandidates(db, { userId: subject.userId, wishId: wish.id, nowMs });
    // 先认领再调模型：并发 tick 里只有一方能走到模型；另一方直接跳过。
    const claimed = await claimWishState(db, {
      userId: subject.userId,
      wishId: wish.id,
      from: 'candidates_ready',
      to: 'chosen',
      nowMs,
    });
    if (!claimed) {
      outcome.skipped.push('cas_conflict');
      return outcome;
    }

    // 账本：**先预留再调模型**（幂等键 = 愿望 + 代次），成功结算、失败释放。
    // 预留失败 = 这一次不花，愿望退回可重试，不写任何「角色不想去」的结论。
    const decisionKey = `travel:${wish.id}:decide:v${wish.updatedAt}`;
    const estimateTokens = Math.max(1, Math.trunc(wiring.llmTokensPerDecision ?? 1200));
    let llmReservation: string | null = null;
    if (wiring.llmPort) {
      const gate = await resolveTravelBudgetGate(db, {
        userId: subject.userId,
        nowMs,
        kind: 'llm',
        port: wiring.llmPort,
      });
      if (!gate.allowed) {
        await releaseWishState(db, { userId: subject.userId, wishId: wish.id, from: 'chosen', to: 'candidates_ready', nowMs });
        outcome.skipped.push('budget_blocked');
        return outcome;
      }
      const reserved = await reserveLlmTokens(db, {
        userId: subject.userId,
        tokens: estimateTokens,
        idempotencyKey: decisionKey,
        nowMs,
        port: wiring.llmPort,
      });
      if (!reserved.ok) {
        await releaseWishState(db, { userId: subject.userId, wishId: wish.id, from: 'chosen', to: 'candidates_ready', nowMs });
        outcome.skipped.push('budget_blocked');
        return outcome;
      }
      llmReservation = reserved.reservationId;
    }

    const settleDecision = async (ok: boolean): Promise<void> => {
      if (!llmReservation || !wiring.llmPort) return;
      try {
        await settleLlmTokens(db, {
          userId: subject.userId,
          reservationId: llmReservation,
          // 模型端口不回 usage：成功按预估结算（宁多算不少算），失败/无结论按 0 结算。
          actualTokens: ok ? estimateTokens : 0,
          ok,
          nowMs,
          port: wiring.llmPort,
        });
      } catch {
        /* 结算失败不改状态机：下一跳的账本读取会看到预留仍在（fail-closed） */
      }
    };

    const decision = await decideWishAction({
      wish: { wishText: wish.wishText, ...(wish.category ? { category: wish.category } : {}) },
      candidates: stored,
      decisionPort: wiring.decisionPort ?? null,
      rerollsUsed: Math.floor(stored.length / 8),
      maxBatches: 2,
    });

    if (decision.kind === 'choose') {
      // 决策成功即落库：这是「角色选了哪」的唯一权威，重试时不再替角色重选。
      await setTravelWishSelectedCandidate(db, {
        userId: subject.userId,
        wishId: wish.id,
        candidateId: decision.candidateId,
        nowMs,
      });
      await settleDecision(true);
      const candidate = await getTravelCandidate(db, {
        userId: subject.userId,
        wishId: wish.id,
        candidateId: decision.candidateId,
        nowMs,
      });
      if (!candidate) {
        // 认领到的 id 在库里查不到（被清理/过期）：愿望放回可重试，不猜。
        await releaseWishState(db, { userId: subject.userId, wishId: wish.id, from: 'chosen', to: 'candidates_ready', nowMs });
        outcome.skipped.push('wait');
        return outcome;
      }
      outcome.decided = true;
      const planned = await planTripForWish(db, subject, wish, {
        wiring,
        nowMs,
        providerDeps,
        active: null,
        tripDays,
        mapGateAllows,
        addEvent,
        selectedCandidate: candidate,
      });
      if (planned === 'planned') {
        outcome.planned = true;
        const fresh = await getActiveTravelTrip(db, { userId: subject.userId, charId: subject.charId });
        if (fresh) await recordPosition(fresh);
      } else outcome.skipped.push('provider_failed');
      return outcome;
    }

    // 没选：换批 / 等 / 放弃。放弃是角色自己的决定（wish → dropped），接口失败不算。
    await settleDecision(false);
    if (decision.kind === 'drop') {
      outcome.skipped.push('dropped');
      await addEvent(`wish:${wish.id}`, 'dropped', { reason: decision.reason ?? null });
      return outcome;
    }
    if (decision.kind === 'reroll') {
      await releaseWishState(db, { userId: subject.userId, wishId: wish.id, from: 'chosen', to: 'open', nowMs });
      outcome.skipped.push('reroll');
      return outcome;
    }
    await releaseWishState(db, { userId: subject.userId, wishId: wish.id, from: 'chosen', to: 'candidates_ready', nowMs });
    outcome.skipped.push(decision.reason === 'llm_unavailable' ? 'llm_unavailable' : 'wait');
    return outcome;
  }

  /* ---------- 6. chosen：上次认领成功但行程没建起来 → 现在补 ---------- */
  const planned = await planTripForWish(db, subject, wish, {
    wiring,
    nowMs,
    providerDeps,
    active: null,
    tripDays,
    mapGateAllows,
    addEvent,
  });
  if (planned === 'planned') outcome.planned = true;
  return outcome;
}

/** 国内（高德）与国外（world）都按地区换实现；都没有就返回 null，不画直线。 */
function pickProvider(
  wiring: TravelTickWiring,
  subject: TravelTickSubject,
  anchor: TravelPlaceAnchor | null,
): TravelMapProvider | null {
  const providers = wiring.providers ?? [];
  if (!providers.length) return null;
  const region = wiring.resolveRegion
    ? wiring.resolveRegion(subject, anchor)
    : wiring.region ?? inferRegionFromAnchor(anchor);
  return providerForRegion(region, providers) ?? null;
}

/** 兜底判地区：只有明确的中国行政区名才当国内；其余一律 overseas（缺 provider 就 honest unavailable）。 */
export function inferRegionFromAnchor(anchor: TravelPlaceAnchor | null): TravelProviderRegion {
  const city = (anchor?.city ?? '').trim();
  if (!city) return 'overseas';
  return CN_CITY_HINTS.some((hint) => city.includes(hint)) ? 'CN' : 'overseas';
}

const CN_CITY_HINTS = [
  '北京', '上海', '天津', '重庆', '广州', '深圳', '杭州', '南京', '成都', '武汉',
  '西安', '苏州', '长沙', '郑州', '青岛', '沈阳', '大连', '厦门', '福州', '昆明',
  '合肥', '济南', '哈尔滨', '长春', '石家庄', '太原', '南昌', '贵阳', '南宁', '海口',
  '兰州', '西宁', '银川', '乌鲁木齐', '呼和浩特', '拉萨', '宁波', '无锡', '佛山', '东莞',
];

async function readAnchorSafe(
  wiring: TravelTickWiring,
  subject: TravelTickSubject,
): Promise<TravelPlaceAnchor | null> {
  if (!wiring.readAnchor) return null;
  try {
    const anchor = await wiring.readAnchor(subject);
    return anchor && anchor.confirmedAt > 0 ? anchor : null;
  } catch {
    return null;
  }
}

interface PlanTripContext {
  wiring: TravelTickWiring;
  nowMs: number;
  providerDeps: {
    fetch: typeof globalThis.fetch;
    reserveMapCall: () => Promise<
      { allowed: true } | { allowed: false; code: 'BUDGET_BLOCKED' | 'BUDGET_ZERO' }
    >;
    now: () => number;
    timeoutMs?: number;
  };
  active: TravelTripRecord | null;
  tripDays: number;
  /** 只读闸门（不扣费）：地图请求真正的扣费在 provider 出口。 */
  mapGateAllows: () => Promise<boolean>;
  addEvent: (tripId: string, kind: string, payload?: unknown) => Promise<void>;
  selectedCandidate?: {
    id: string;
    label: string;
    city?: string;
    district?: string;
    lat: number;
    lng: number;
    coordSys: TravelCoordSys;
    placeId?: string;
  };
}

/**
 * 建/改一代行程。返回 'planned' | 'skipped'。
 *
 * 顺序刻意是「先认领行、再打路线」：`upsertTravelTrip` 的唯一 dedupe 键是并发闸，
 * 只有拿到 `inserted: true` 的那个 tick 会真的去请求路线；另一个 tick 直接返回。
 */
async function planTripForWish(
  db: TravelDb,
  subject: TravelTickSubject,
  wish: TravelWishRecord,
  ctx: PlanTripContext,
): Promise<'planned' | 'skipped'> {
  const { nowMs, wiring, active } = ctx;
  const anchor = await readAnchorSafe(wiring, subject);
  if (!anchor) return 'skipped';
  const provider = pickProvider(wiring, subject, anchor);
  if (!provider) return 'skipped';

  const candidate = ctx.selectedCandidate
    ?? (await pickCandidateForWish(db, subject, wish, nowMs));
  if (!candidate) return 'skipped';

  // 代次：改计划 = 在途代 +1；重试 = 上一代（含已终态）+1。
  // 只按 `active` 算会让失败重试恒定用同一个 dedupe 键，被唯一索引永久挡住。
  const latest = active ?? (await getLatestTripForWish(db, {
    userId: subject.userId,
    charId: subject.charId,
    wishId: wish.id,
  }));
  const planVersion = (latest?.planVersion ?? 0) + 1;
  const dedupeKey = `wish:${wish.id}:plan:${planVersion}`;
  const departAt = nowMs;
  const dwellMs = Math.max(1, Math.trunc(wiring.dwellMinutes ?? DEFAULT_DWELL_MINUTES)) * 60 * 1000;

  const seed: TravelTripRecord = {
    id: crypto.randomUUID(),
    userId: subject.userId,
    charId: subject.charId,
    status: 'considering',
    phase: 'considering',
    planVersion,
    revision: 1,
    coordSys: candidate.coordSys,
    provider: provider.id as TravelProviderId,
    origin: refFromAnchor(anchor),
    dest: refFromCandidate(candidate),
    route: null,
    routeFetchedAt: null,
    departAt,
    arriveAt: null,
    dwellUntil: null,
    returnAt: null,
    retentionExpiresAt: retentionExpiryFor(nowMs, ctx.tripDays),
    dedupeKey,
    createdAt: nowMs,
    updatedAt: nowMs,
  };

  const upserted = await upsertTravelTrip(db, seed);
  if (!upserted.inserted) {
    // 并发下另一 tick 已经建了同一代：不重复请求路线 / 不重复扣预算。
    return 'skipped';
  }
  const trip = upserted.trip;

  // 改计划：旧代先标 aborted(plan_changed)，再让新代上位（旧行不改写历史时间）。
  if (active && active.id !== trip.id) {
    const aborted = await casUpdateTravelTrip(db, {
      userId: subject.userId,
      tripId: active.id,
      baseRevision: active.revision,
      patch: { status: 'aborted' },
      nowMs,
    });
    if (aborted.ok) await ctx.addEvent(active.id, 'plan_changed', { nextTripId: trip.id, planVersion });
  }

  if (!(await ctx.mapGateAllows())) {
    await casUpdateTravelTrip(db, {
      userId: subject.userId,
      tripId: trip.id,
      baseRevision: trip.revision,
      patch: { status: 'unavailable' },
      nowMs,
    });
    return 'skipped';
  }

  let routePoints: { lat: number; lng: number }[] | null = null;
  let distanceM = 0;
  let durationMs: number | null = null;
  try {
    const route = await provider.route({
      origin: { lat: anchor.lat, lng: anchor.lng, coordSys: anchor.coordSys },
      destination: { lat: candidate.lat, lng: candidate.lng, coordSys: candidate.coordSys },
      ...(candidate.placeId ? { destinationPlaceId: candidate.placeId } : {}),
    });
    routePoints = route.points.map((p) => ({ lat: p.lat, lng: p.lng }));
    distanceM = route.distanceM;
    durationMs = route.durationS === null ? null : Math.max(0, Math.round(route.durationS * 1000));
  } catch (error) {
    const kind = providerFailureKind(error);
    // 失败的一代**标终态**（否则它会一直占着 active，把重试堵死），愿望退回可重试。
    // 注意：这不是「角色不想去了」——放弃只能由角色自己（drop）或过期产生。
    await casUpdateTravelTrip(db, {
      userId: subject.userId,
      tripId: trip.id,
      baseRevision: trip.revision,
      patch: { status: 'aborted' },
      nowMs,
    });
    await ctx.addEvent(trip.id, 'provider_failed', {
      kind,
      ...(isUnavailableKind(kind) ? { unavailable: true } : {}),
    });
    // 愿望**保持 chosen**：角色已经决定了去哪，技术失败不该再让模型重新选一次
    // （每次重选都是一次真实模型开销）。下一跳由 §6 用已落库的选择重试排路线。
    return 'skipped';
  }

  // 几何许可未取得 → 路线只在本次 tick 内存里用，绝不落库；没有官方时长就没有 ETA。
  const geometryAllowed = wiring.licensedGeometry === true;
  const nextTimes = {
    arriveAt: durationMs === null ? null : departAt + durationMs,
    dwellUntil: durationMs === null ? null : departAt + durationMs + dwellMs,
    returnAt: durationMs === null ? null : departAt + durationMs * 2 + dwellMs,
  };

  const cas = await casUpdateTravelTrip(db, {
    userId: subject.userId,
    tripId: trip.id,
    baseRevision: trip.revision,
    patch: {
      status: 'planned',
      coordSys: provider.coordSys,
      provider: provider.id as TravelProviderId,
      route: geometryAllowed && routePoints ? { points: routePoints, distanceM } : null,
      routeFetchedAt: geometryAllowed && routePoints ? nowMs : null,
      departAt,
      ...nextTimes,
    },
    nowMs,
  });
  if (!cas.ok) {
    await ctx.addEvent(trip.id, 'cas_conflict', { phase: 'planned' });
    return 'skipped';
  }
  await ctx.addEvent(trip.id, 'planned', {
    candidateId: candidate.id,
    geometryPersisted: geometryAllowed && !!routePoints,
  });
  // 理由只在有真实候选时才有意义；wish 已经在认领时置 chosen。
  if (wish.state !== 'chosen') {
    await db
      .prepare("UPDATE travel_wishes SET state = 'chosen', updated_at = ? WHERE user_id = ? AND id = ?")
      .bind(nowMs, subject.userId, wish.id)
      .run();
  }
  return 'planned';
}

/**
 * 取「角色已经选中的那个候选」。**没有就返回 null**（不替角色挑、不就近兜底）：
 * 上一轮模型选的 id 存在 `travel_wishes.selected_candidate_id`；查不到（被清理/过期）
 * 或根本没选过，都交回上层把愿望放回 `candidates_ready` 等下一次模型。
 */
async function pickCandidateForWish(
  db: TravelDb,
  subject: TravelTickSubject,
  wish: TravelWishRecord,
  nowMs: number,
): Promise<PlanTripContext['selectedCandidate'] | null> {
  const selectedId = wish.selectedCandidateId ?? null;
  if (!selectedId) return null;
  const chosen = await getTravelCandidate(db, {
    userId: subject.userId,
    wishId: wish.id,
    candidateId: selectedId,
    nowMs,
  });
  if (!chosen) return null;
  return {
    id: chosen.id,
    label: chosen.label,
    city: chosen.city,
    district: chosen.district,
    lat: chosen.lat,
    lng: chosen.lng,
    coordSys: chosen.coordSys,
    placeId: chosen.placeId,
  };
}

/** `wish:<wishId>:plan:<n>` → wishId（wish id 自身含冒号，所以只剥两端）。 */
export function wishIdFromDedupeKey(dedupeKey: string): string | null {
  const match = /^wish:(.+):plan:\d+$/.exec(String(dedupeKey ?? ''));
  return match ? match[1] : null;
}

interface SegmentLegArgs {
  wish: TravelWishRecord;
  current: TravelTripRecord;
  kind: 'next' | 'return';
  from: TravelPlaceRef;
  to: TravelPlaceRef;
  provider: TravelMapProvider;
  providerDeps: PlanTripContext['providerDeps'];
  mapGateAllows: () => Promise<boolean>;
  addEvent: (tripId: string, kind: string, payload?: unknown) => Promise<void>;
  tripDays: number;
  nowMs: number;
  dwellMs: number;
  licensedGeometry: boolean;
  reason: string | null;
}

/**
 * 闲逛下一段（换站 / 回家）。与 `planTripForWish` 的区别只有两点：
 * - 起点是**当前落脚点**（不是住处），所以路线是「这一站 → 下一站」，沿真实道路；
 * - `return` 直接以 `returning` 相位起步，`returnAt` 到点才变 `returned` ——
 *   人是一步步走回去的，不是原地翻个状态。
 *
 * 并发/重放：新行的 dedupe 键是 `wish:<id>:plan:<planVersion+1>`，唯一索引保证
 * 只有一方能插入成功，另一方直接返回、不再请求路线。
 */
async function planSegmentLeg(
  db: TravelDb,
  subject: TravelTickSubject,
  args: SegmentLegArgs,
): Promise<'planned' | 'skipped'> {
  const { nowMs, current, wish, from, to, provider } = args;
  const planVersion = current.planVersion + 1;
  const seed: TravelTripRecord = {
    id: crypto.randomUUID(),
    userId: subject.userId,
    charId: subject.charId,
    status: args.kind === 'return' ? 'returning' : 'planned',
    phase: args.kind === 'return' ? 'returning' : 'planned',
    planVersion,
    revision: 1,
    coordSys: to.coordSys ?? from.coordSys ?? current.coordSys,
    provider: provider.id as TravelProviderId,
    origin: from,
    dest: to,
    route: null,
    routeFetchedAt: null,
    departAt: nowMs,
    arriveAt: null,
    dwellUntil: null,
    returnAt: null,
    retentionExpiresAt: retentionExpiryFor(nowMs, args.tripDays),
    dedupeKey: `wish:${wish.id}:plan:${planVersion}`,
    createdAt: nowMs,
    updatedAt: nowMs,
  };

  const upserted = await upsertTravelTrip(db, seed);
  if (!upserted.inserted) return 'skipped';
  const trip = upserted.trip;

  // 上一段收尾：标 aborted 并留下「因为换了计划」的证据（不原地改写历史时间）。
  const closed = await casUpdateTravelTrip(db, {
    userId: subject.userId,
    tripId: current.id,
    baseRevision: current.revision,
    patch: { status: 'aborted' },
    nowMs,
  });
  if (closed.ok) {
    await args.addEvent(current.id, 'segment_changed', {
      nextTripId: trip.id,
      planVersion,
      action: args.kind,
      ...(args.reason ? { reason: args.reason } : {}),
    });
  }

  if (!(await args.mapGateAllows())) {
    await casUpdateTravelTrip(db, {
      userId: subject.userId,
      tripId: trip.id,
      baseRevision: trip.revision,
      patch: { status: 'unavailable' },
      nowMs,
    });
    return 'skipped';
  }

  let routePoints: { lat: number; lng: number }[] | null = null;
  let distanceM = 0;
  let durationMs: number | null = null;
  try {
    const route = await provider.route({
      origin: {
        lat: from.lat,
        lng: from.lng,
        coordSys: from.coordSys ?? current.coordSys,
      },
      destination: {
        lat: to.lat,
        lng: to.lng,
        coordSys: to.coordSys ?? current.coordSys,
      },
      ...(to.placeId ? { destinationPlaceId: to.placeId } : {}),
    });
    routePoints = route.points.map((point) => ({ lat: point.lat, lng: point.lng }));
    distanceM = route.distanceM;
    durationMs = route.durationS === null ? null : Math.max(0, Math.round(route.durationS * 1000));
  } catch (error) {
    await casUpdateTravelTrip(db, {
      userId: subject.userId,
      tripId: trip.id,
      baseRevision: trip.revision,
      patch: { status: 'aborted' },
      nowMs,
    });
    await args.addEvent(trip.id, 'provider_failed', { kind: providerFailureKind(error) });
    return 'skipped';
  }

  const arriveAt = durationMs === null ? null : nowMs + durationMs;
  const times = args.kind === 'return'
    // 回家这一段的「返程」区间就是整段路：returnAt 到点才变 returned。
    ? { arriveAt, dwellUntil: nowMs, returnAt: arriveAt }
    : {
        arriveAt,
        dwellUntil: arriveAt === null ? null : arriveAt + args.dwellMs,
        returnAt: null,
      };

  const cas = await casUpdateTravelTrip(db, {
    userId: subject.userId,
    tripId: trip.id,
    baseRevision: trip.revision,
    patch: {
      status: args.kind === 'return' ? 'returning' : 'planned',
      coordSys: provider.coordSys,
      route: args.licensedGeometry && routePoints ? { points: routePoints, distanceM } : null,
      routeFetchedAt: args.licensedGeometry && routePoints ? nowMs : null,
      departAt: nowMs,
      ...times,
    },
    nowMs,
  });
  if (!cas.ok) {
    await args.addEvent(trip.id, 'cas_conflict', { phase: 'segment' });
    return 'skipped';
  }
  await args.addEvent(trip.id, args.kind === 'return' ? 'segment_return' : 'segment_next', {
    fromLabel: from.label,
    toLabel: to.label,
    geometryPersisted: args.licensedGeometry && !!routePoints,
  });
  return 'planned';
}

/** 相位推进决策（纯函数，方便回归）。 */
export function nextPhaseFor(
  trip: Pick<TravelTripRecord, 'status' | 'departAt' | 'arriveAt' | 'dwellUntil' | 'returnAt'>,
  nowMs: number,
): { kind: 'advance'; to: TravelTripStatus } | { kind: 'expire' } | { kind: 'idle' } {
  const { status } = trip;
  if (isTerminalStatus(status)) return { kind: 'idle' };

  if (trip.departAt !== null && nowMs > trip.departAt + TRAVEL_STALE_TRIP_MS) {
    return { kind: 'expire' };
  }
  switch (status) {
    case 'planned':
      if (trip.departAt === null) return { kind: 'idle' };
      return nowMs >= trip.departAt ? { kind: 'advance', to: 'en_route' } : { kind: 'idle' };
    case 'en_route':
      if (trip.arriveAt === null) return { kind: 'idle' };
      return nowMs >= trip.arriveAt ? { kind: 'advance', to: 'dwelling' } : { kind: 'idle' };
    case 'dwelling':
      if (trip.dwellUntil === null) return { kind: 'idle' };
      return nowMs >= trip.dwellUntil ? { kind: 'advance', to: 'returning' } : { kind: 'idle' };
    case 'returning':
      if (trip.returnAt === null) return { kind: 'idle' };
      return nowMs >= trip.returnAt ? { kind: 'advance', to: 'returned' } : { kind: 'idle' };
    default:
      return { kind: 'idle' };
  }
}

/** 默认 subject 枚举：只有真的建过愿望的租户（cron 不做全表遍历）。 */
export async function listTravelTickSubjects(db: TravelDb): Promise<TravelTickSubject[]> {
  const rows = await db
    .prepare('SELECT DISTINCT user_id, char_id FROM travel_wishes ORDER BY user_id ASC, char_id ASC')
    .bind()
    .all();
  return (rows.results ?? [])
    .filter((row) => typeof row.user_id === 'string' && typeof row.char_id === 'string')
    .map((row) => ({ userId: String(row.user_id), charId: String(row.char_id) }));
}

export interface TravelTickEnv {
  DB?: unknown;
}

/**
 * cron / scheduled 入口。`env.DB` 是 D1（或 VPS 上的同构适配器）。
 * `wiring.listSubjects` 可覆盖枚举（测试/单账号补跑）。
 */
export async function runTravelTick(
  env: TravelTickEnv | null | undefined,
  wiring: TravelTickWiring & {
    listSubjects?: (db: TravelDb) => Promise<TravelTickSubject[]>;
    /**
     * 按主体构造这一格的接线（provider 预算回调、模型端口、账本端口都是 per-user 的，
     * 不能一份实例跨角色复用）。返回值与 `wiring` 浅合并。
     */
    wiringForSubject?: (subject: TravelTickSubject) => TravelTickWiring | Promise<TravelTickWiring>;
  } = {},
): Promise<TravelTickReport> {
  const db = env?.DB as TravelDb | undefined;
  const nowMs = (wiring.now ?? (() => Date.now()))();
  if (!db) return { nowMs, subjects: 0, outcomes: [], pruned: null };

  await ensureTravelSchema(db);
  // 许可**以 env 为准**：调用方（含未来第二个调用点）传什么都不能解锁几何落库。
  // 单测仍可用 `runTravelTickForSubject` 的 wiring 直接驱动，所以这里只收口 cron 入口。
  const envLicensed = resolveTravelLicenses(env as Record<string, unknown> | null | undefined)
    .geometryPersistence === 'allowed';
  const subjects = await (wiring.listSubjects ?? listTravelTickSubjects)(db);
  const outcomes: TravelTickOutcome[] = [];
  for (const subject of subjects) {
    try {
      const perSubject = {
        ...wiring,
        ...(wiring.wiringForSubject ? await wiring.wiringForSubject(subject) : {}),
        licensedGeometry: envLicensed,
      };
      outcomes.push(await runTravelTickForSubject(db, subject, perSubject));
    } catch {
      outcomes.push({
        subject,
        advanced: [],
        searched: false,
        decided: false,
        planned: false,
        expired: false,
        skipped: [],
        mapReserved: false,
        segment: null,
      });
    }
  }

  let pruned: TravelTickReport['pruned'] = null;
  if (wiring.prune) {
    try {
      pruned = await pruneTravelRetention(db, { nowMs });
    } catch {
      pruned = null;
    }
  }
  return { nowMs, subjects: subjects.length, outcomes, pruned };
}

/** `scheduled` 处理器：有 waitUntil 就挂上去，没有就 await（VPS 兼容层）。 */
export async function handleTravelScheduled(
  controller: { waitUntil?: (p: Promise<unknown>) => void } | null | undefined,
  env: TravelTickEnv | null | undefined,
  wiring?: TravelTickWiring & {
    listSubjects?: (db: TravelDb) => Promise<TravelTickSubject[]>;
    wiringForSubject?: (subject: TravelTickSubject) => TravelTickWiring | Promise<TravelTickWiring>;
  },
): Promise<TravelTickReport> {
  const task = runTravelTick(env, { ...wiring, prune: wiring?.prune ?? true });
  if (controller && typeof controller.waitUntil === 'function') {
    controller.waitUntil(task);
  }
  return task;
}
