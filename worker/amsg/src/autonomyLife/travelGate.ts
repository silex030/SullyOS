/**
 * 自主出行（`travel/tick.ts` 的 cron tick）接入**统一边界 + 统一预算**。
 *
 * 为什么需要这一层：出行 tick 是另一条独立的自动链路——它自己按分钟跑，用自己的
 * 授权、自己的模型账本（`travel/llmLedger.ts`）和旧 AIRP 护栏。结果就是
 * 「用户在设置页按下总暂停 / 关掉角色 / 撤掉 travel.wish 授权 / 用完新额度」以后，
 * 这条链路照样能调模型、照样落愿望。新边界只覆盖 AIRP 回合是不够的。
 *
 * 两处闸，缺一不可：
 *   1. `travelModelGateAllows`（建 wiring 时）：当前边界不允许 `travel.wish` 就**根本不装
 *      decisionPort** —— tick 里所有模型分支（意图探针 / 选点决策 / 闲逛分段）都靠它，
 *      没有端口 = 零模型请求、零新增愿望（不是「跑完再丢」）。
 *   2. `gateTravelDecisionPort`（每一次真正的模型调用前）：按当前边界重判 + 在统一账本里
 *      **原子预留一次调用**，调用回来按真实 usage 结算。边界可能在 tick 中途被改，
 *      只在建 wiring 时判一次挡不住。
 *
 * 旧的东西照旧保留：地图调用额度、隐私脱敏、地图授权、旧 travel 账本都还在，
 * 这里只**加**一道统一闸，不替换它们的语义。
 */

import type { TravelDecisionPort } from '../travel/decision';
import { getTravelBudget } from '../travel/budget';
import { getTravelCharSettings, getTravelSettings, type TravelDb } from '../travel/store';
import {
  LEGACY_TRAVEL_KIND,
  legacyBoundaryDenial,
  readEffectiveBoundary,
  reserveLegacyRoundCall,
  settleLegacyRoundCall,
  type LegacyAutonomySkipReason,
} from './legacyGate';
import type { LifeDb } from './store';

/** 出行模型调用在统一边界里的 kind（与 `contracts/autonomyLife.ts` 的受控外部窗口一致）。 */
export const TRAVEL_MODEL_KIND = LEGACY_TRAVEL_KIND;

/**
 * 当前边界是否允许出行链路调模型（只读，不写任何东西）。
 *
 * 缺账号/角色边界行、读失败、暂停、关角色、allowedKinds 不含 `travel.wish`、
 * 用户新增禁区/回避话题 → 一律不允许（fail closed）。
 */
export async function travelModelGateAllows(args: {
  db: LifeDb;
  ownerId: string;
  charId: string;
  nowMs: number;
}): Promise<{ ok: true } | { ok: false; reason: LegacyAutonomySkipReason }> {
  const read = await readEffectiveBoundary(args.db, {
    ownerId: args.ownerId,
    charId: args.charId,
    nowMs: args.nowMs,
  });
  if (!read.ok) return { ok: false, reason: read.reason };
  const denial = legacyBoundaryDenial(read.boundary, TRAVEL_MODEL_KIND);
  return denial ? { ok: false, reason: denial } : { ok: true };
}

/** 出行这条链路自己的失败原因（旧授权 + 新边界两套口径合起来）。 */
export type TravelModelDenialReason =
  | LegacyAutonomySkipReason
  | 'travel_disabled'
  | 'travel_char_disabled'
  | 'travel_budget_missing'
  | 'travel_budget_paused'
  | 'travel_budget_zero';

/**
 * 出行链路能不能调模型：**新旧两套授权都要过**。
 *
 *   - 新边界（统一口径）：`travelModelGateAllows`；
 *   - 旧出行授权：账号开关 + 角色开关 + 地图预算行（存在、未暂停、额度 > 0）。
 *
 * 为什么两套都要：只加新边界会漏掉「用户在出行面板里关掉出行 / 暂停出行预算」，
 * 只留旧授权就是这一轮要修的漏洞（新总暂停/额度管不住它）。撤掉任一边 → 不装
 * decisionPort → tick 里零模型请求、零新增愿望，已有行程照旧推进时间相位。
 */
export async function travelModelAccess(args: {
  db: LifeDb;
  travelDb: TravelDb;
  ownerId: string;
  charId: string;
  nowMs: number;
}): Promise<{ ok: true } | { ok: false; reason: TravelModelDenialReason }> {
  const gate = await travelModelGateAllows({
    db: args.db,
    ownerId: args.ownerId,
    charId: args.charId,
    nowMs: args.nowMs,
  });
  if (!gate.ok) return gate;

  const [settings, charSettings, budget] = await Promise.all([
    getTravelSettings(args.travelDb, args.ownerId).catch(() => null),
    getTravelCharSettings(args.travelDb, { userId: args.ownerId, charId: args.charId }).catch(() => null),
    getTravelBudget(args.travelDb, { userId: args.ownerId, nowMs: args.nowMs }).catch(() => null),
  ]);
  if (!settings || settings.enabled !== true) return { ok: false, reason: 'travel_disabled' };
  if (!charSettings || charSettings.enabled !== true) return { ok: false, reason: 'travel_char_disabled' };
  if (!budget) return { ok: false, reason: 'travel_budget_missing' };
  if (budget.paused) return { ok: false, reason: 'travel_budget_paused' };
  if (!(budget.mapCallsLimit > 0)) return { ok: false, reason: 'travel_budget_zero' };
  return { ok: true };
}

/**
 * 给 decisionPort 套上统一闸：每次模型调用前原子预留、调用后结算。
 *
 * 被拒时**抛错**（不是返回空对象）：`travel/decision.ts` 的 `proposeTravelIntent` /
 * `decideWishAction` 已经把「端口抛错」定义为「本轮不决定」，tick 会当成
 * `llm_unavailable` 处理——零愿望、零状态推进。这样即使边界在 tick 中途变严，
 * 也不会因为「端口还在」而偷偷把请求发出去。
 */
export function gateTravelDecisionPort(
  port: TravelDecisionPort | null | undefined,
  deps: { db: LifeDb; ownerId: string; charId: string; now?: () => number },
): TravelDecisionPort | null {
  if (!port) return null;
  const now = deps.now ?? (() => Date.now());

  const gated = async <T>(run: () => Promise<T>): Promise<T> => {
    const nowMs = now();
    const reserved = await reserveLegacyRoundCall({
      db: deps.db,
      ownerId: deps.ownerId,
      charId: deps.charId,
      nowMs,
      kind: TRAVEL_MODEL_KIND,
    });
    if (!reserved.ok) {
      throw new Error(`autonomy-life-gate:${reserved.reason}`);
    }
    try {
      return await run();
    } finally {
      // 请求已经发出去了（走到这里说明 decisionPort 真的被调用），按真实 usage 结算；
      // 端口没回 usage 就按预留上界（与统一预算的口径一致：不猜零）。
      await settleLegacyRoundCall({
        db: deps.db,
        permit: reserved.permit,
        actualTokens: port.lastUsageTokens?.() ?? null,
        requestStarted: true,
      }).catch(() => undefined);
    }
  };

  return {
    choose: (input) => gated(() => port.choose(input)),
    ...(port.nextSegment ? { nextSegment: (input) => gated(() => port.nextSegment!(input)) } : {}),
    ...(port.lastUsageTokens ? { lastUsageTokens: () => port.lastUsageTokens!() } : {}),
    ...(port.proposeIntent ? { proposeIntent: (input) => gated(() => port.proposeIntent!(input)) } : {}),
  };
}
