/**
 * 自主出行（`travel/tick.ts` 的 cron tick）接入**统一边界 + 统一预算 + 外部授权**。
 *
 * 为什么需要这一层：出行 tick 是另一条独立的自动链路——它自己按分钟跑，用自己的
 * 授权、自己的模型账本（`travel/llmLedger.ts`）和旧 AIRP 护栏。结果就是
 * 「用户在设置页按下总暂停 / 关掉角色 / 撤掉 travel.wish 授权 / 撤掉 amap 外部授权 /
 * 用完新额度」以后，这条链路照样能调模型、照样落愿望。新边界只覆盖 AIRP 回合是不够的。
 *
 * 四道闸，缺一不可：
 *   1. `travelModelAccess`（建 wiring 时）：当前边界不允许 `travel.wish`、或当前没有
 *      未过期的 amap 授权，就**根本不装 decisionPort** —— tick 里所有模型分支（意图探针 /
 *      选点决策 / 闲逛分段）都靠它，没有端口 = 零模型请求、零新增愿望。
 *   2. `gateTravelDecisionPort` 调用前：按当前边界重判 + 在统一账本里**原子预留**一次调用。
 *   3. `gateTravelDecisionPort` 调用后（**模型回来之后、业务效果之前**）：结算这次调用，
 *      再按**当前**边界 / 授权核验一遍；意图探针的「想出去」要按 kind 配额核销一格，
 *      选点 / 分段这类决策位要拿一次性效果许可（`claimTravelDecisionAtomic`，边界 revision
 *      与 amap 授权在同一条 INSERT 的条件里）。任一步失败 → 抛错，tick 当成
 *      `llm_unavailable`：**零愿望、零行程**，但模型调用已经记账（不白嫖也不重复花）。
 *   4. `autonomyFire` 的 `travel` 段：走同一条 `reserveLegacyEffect('travel.wish')`
 *      （kind 白名单 + amap 授权 + 授权窗口额度 + 每 kind 配额）。
 *
 * 旧的东西照旧保留：地图调用额度、隐私脱敏、地图授权、旧 travel 账本都还在，
 * 这里只**加**一道统一闸，不替换它们的语义。
 */

import type { TravelDecisionPort } from '../travel/decision';
import { parseInteyProposal } from '../travel/decision';
import { getTravelBudget } from '../travel/budget';
import { getTravelCharSettings, getTravelSettings, type TravelDb } from '../travel/store';
import { windowIdAt } from '../../../../utils/autonomyLife/budget';
import type { EffectiveBoundaryV1 } from '../../../../contracts/autonomyLife';
import { localDateKey } from '../../../../utils/autonomyLife/time';
import {
  LEGACY_TRAVEL_KIND,
  effectiveGrantFor,
  legacyBoundaryDenial,
  legacyGrantDenial,
  readEffectiveBoundary,
  readExternalUsage,
  reserveLegacyEffect,
  reserveLegacyRoundCall,
  settleLegacyRoundCall,
  type LegacyAutonomySkipReason,
} from './legacyGate';
import { claimTravelDecisionAtomic, type LifeDb } from './store';

/** 出行模型调用在统一边界里的 kind（与 `contracts/autonomyLife.ts` 的受控外部窗口一致）。 */
export const TRAVEL_MODEL_KIND = LEGACY_TRAVEL_KIND;

/**
 * 当前边界是否允许出行链路调模型（只读，不写任何东西）。
 *
 * 缺账号/角色边界行、读失败、暂停、关角色、allowedKinds 不含 `travel.wish`、
 * 用户新增禁区/回避话题、**没有未过期的 amap 外部授权** → 一律不允许（fail closed）。
 */
export async function travelModelGateAllows(args: {
  db: LifeDb;
  ownerId: string;
  charId: string;
  nowMs: number;
}): Promise<{ ok: true; boundary: EffectiveBoundaryV1 } | { ok: false; reason: LegacyAutonomySkipReason }> {
  const read = await readEffectiveBoundary(args.db, {
    ownerId: args.ownerId,
    charId: args.charId,
    nowMs: args.nowMs,
  });
  if (!read.ok) return { ok: false, reason: read.reason };
  const denial = legacyBoundaryDenial(read.boundary, TRAVEL_MODEL_KIND)
    ?? legacyGrantDenial(read.boundary, TRAVEL_MODEL_KIND, args.nowMs);
  return denial ? { ok: false, reason: denial } : { ok: true, boundary: read.boundary };
}

/** 出行这条链路自己的失败原因（旧授权 + 新边界两套口径合起来）。 */
export type TravelModelDenialReason =
  | LegacyAutonomySkipReason
  | 'external_quota_exhausted'
  | 'travel_disabled'
  | 'travel_char_disabled'
  | 'travel_budget_missing'
  | 'travel_budget_paused'
  | 'travel_budget_zero';

/**
 * 出行链路能不能调模型：**新旧两套授权都要过**。
 *
 *   - 新边界（统一口径）：`travelModelGateAllows`，含 amap 外部授权（存在/未过期/未被撤）；
 *   - 旧出行授权：账号开关 + 角色开关 + 地图预算行（存在、未暂停、额度 > 0）。
 *
 * 为什么两套都要：只加新边界会漏掉「用户在出行面板里关掉出行 / 暂停出行预算」，
 * 只留旧授权就是这一轮要修的漏洞（新总暂停/额度/授权管不住它）。撤掉任一边 → 不装
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

  // 授权窗口的当日额度也用完 → 不再问模型：问了也落不了愿望（`reserveLegacyEffect`
  // 会拒），白烧一次调用。额度 0 = 明确禁止。
  const grant = effectiveGrantFor(gate.boundary, 'amap', args.nowMs);
  if (grant) {
    if (!(grant.dailyQuota > 0)) return { ok: false, reason: 'external_quota_exhausted' };
    const used = await readExternalUsage({
      db: args.db,
      ownerId: args.ownerId,
      dayKey: localDateKey(args.nowMs, gate.boundary.timezone),
      provider: 'amap',
    });
    if (used >= grant.dailyQuota) return { ok: false, reason: 'external_quota_exhausted' };
  }
  return { ok: true };
}

/** 模型结果的用途：意图探针会落愿望（要占 kind 配额），选点/分段是决策位（一次性许可）。 */
export type TravelEffectKind = 'intent' | 'decision';

/**
 * 给 decisionPort 套上统一闸：每次模型调用前原子预留、调用后结算，**模型结果落业务效果前**
 * 再按当前边界 / 授权核验并核销一次性许可。
 *
 * 被拒时**抛错**（不是返回空对象）：`travel/decision.ts` 的 `proposeTravelIntent` /
 * `decideWishAction` 已经把「端口抛错」定义为「本轮不决定」，tick 会当成
 * `llm_unavailable` 处理——零愿望、零状态推进。这样即使边界在 tick 中途变严，
 * 也不会因为「端口还在」而偷偷把请求发出去或把结果写下去。
 */
export function gateTravelDecisionPort(
  port: TravelDecisionPort | null | undefined,
  deps: { db: LifeDb; ownerId: string; charId: string; now?: () => number },
): TravelDecisionPort | null {
  if (!port) return null;
  const now = deps.now ?? (() => Date.now());

  const gated = async <T>(effect: TravelEffectKind, run: () => Promise<T>): Promise<T> => {
    const reservedAt = now();
    const reserved = await reserveLegacyRoundCall({
      db: deps.db,
      ownerId: deps.ownerId,
      charId: deps.charId,
      nowMs: reservedAt,
      kind: TRAVEL_MODEL_KIND,
    });
    if (!reserved.ok) {
      throw new Error(`autonomy-life-gate:${reserved.reason}`);
    }

    let value: T;
    try {
      value = await run();
    } catch (error) {
      // 端口抛错时无法证明请求**没有**发出 → 按「已发出」结算（与旧行为一致的保守口径：
      // 宁可多记一次消耗，也不让一次真实调用白嫖额度）。结算失败也只影响账本，错误继续往外抛，
      // 本轮不产生任何业务效果。
      await settleLegacyRoundCall({
        db: deps.db,
        permit: reserved.permit,
        actualTokens: null,
        requestStarted: true,
      }).catch(() => undefined);
      throw error;
    }

    // 请求已经发出去了：先按真实 usage 记账。结算被拒（重复结算 / 存储不可用）
    // → fail closed：结果是**不可信**的，不交给业务侧写任何东西。
    const settled = await settleLegacyRoundCall({
      db: deps.db,
      permit: reserved.permit,
      actualTokens: port.lastUsageTokens?.() ?? null,
      requestStarted: true,
    });
    if (!settled) {
      throw new Error('autonomy-life-gate:budget_settle_failed');
    }

    // ── 模型回来之后的效果门（以前这里直接 return，暂停/撤权后照样落愿望）──
    const nowMs = now();
    const read = await readEffectiveBoundary(deps.db, {
      ownerId: deps.ownerId,
      charId: deps.charId,
      nowMs,
    });
    if (!read.ok) throw new Error(`autonomy-life-gate:${read.reason}`);
    const denial = legacyBoundaryDenial(read.boundary, TRAVEL_MODEL_KIND)
      ?? legacyGrantDenial(read.boundary, TRAVEL_MODEL_KIND, nowMs);
    if (denial) throw new Error(`autonomy-life-gate:${denial}`);

    if (effect === 'intent') {
      const proposal = parseInteyProposal(value);
      // 只有真的要出门（go/wander）才占 kind 配额；`none` 不产生业务效果。
      if (proposal && proposal.kind !== 'none') {
        const permit = await reserveLegacyEffect({
          db: deps.db,
          ownerId: deps.ownerId,
          charId: deps.charId,
          nowMs,
          kind: TRAVEL_MODEL_KIND,
        });
        if (!permit.ok) throw new Error(`autonomy-life-gate:${permit.reason}`);
      }
    } else {
      // 选点 / 分段：一次性效果许可（不占 kind 额度，但绑定当前边界版本与 amap 授权）。
      const claim = await claimTravelDecisionAtomic({
        db: deps.db,
        ownerId: deps.ownerId,
        charId: deps.charId,
        windowId: windowIdAt({ now: () => nowMs }, read.boundary.timezone),
        nowMs,
        expectedAccountRevision: read.boundary.accountRevision ?? null,
        expectedCharacterRevision: read.boundary.characterRevision ?? null,
        claimRef: `${deps.charId}:${effectClaimRef()}`,
      });
      if (!claim.ok) throw new Error(`autonomy-life-gate:${claim.reason}`);
    }

    return value;
  };

  return {
    choose: (input) => gated('decision', () => port.choose(input)),
    ...(port.nextSegment ? { nextSegment: (input) => gated('decision', () => port.nextSegment!(input)) } : {}),
    ...(port.lastUsageTokens ? { lastUsageTokens: () => port.lastUsageTokens!() } : {}),
    ...(port.proposeIntent ? { proposeIntent: (input) => gated('intent', () => port.proposeIntent!(input)) } : {}),
  };
}

/** 效果许可的稳定唯一引用（worker/浏览器都有 crypto）。 */
function effectClaimRef(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (webCrypto?.randomUUID) return webCrypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
