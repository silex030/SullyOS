/**
 * 出行 · 角色自己产生的出行愿望（后台自主回合 → 真实 wish）
 *
 * 要解决的是「用户不需要手写愿望」：角色在自己的自主回合同一份 JSON 里可以**可选**地
 * 说一句「我想出去走走」，这里把它变成一条真实的 `travel_wishes` 行，tick 随后照原
 * 有状态机搜点/选点/排路线。
 *
 * 三条硬边界：
 * 1. **不替角色编动机**：字段缺省 / `want:"none"` / 解析不合法 → 不写愿望（不是「随机出门」）；
 *    也**不**要求每次都必须出门 —— 一轮没有 wish 是正常结果。
 * 2. **不额外花模型钱**：intent 就挂在既有自主回合的 JSON 里，不再单独发一次 LLM 请求；
 *    这里只做「预算/授权复核 + 去重 + 落库」，不调用模型、不调用地图。
 * 3. **授权与预算先于写库**：总开关、角色启用位、账本行缺一不写；`paused` 或地图额度 0
 *    也不写 —— 写了也跑不动，等于给角色一个永远实现不了的愿望。
 */

import { sanitizeWishText } from '../../../../utils/travel/core';
import { getTravelBudget } from './budget';
import {
  getTravelCharSettings,
  getTravelSettings,
  insertTravelWish,
  listTravelWishes,
  type TravelDb,
  type TravelWishRecord,
} from './store';

/** 闲逛愿望的类别名（契约里 `category` 是自由串，这个值是 tick 认的分段标记）。 */
export const WANDER_CATEGORY = 'wander';
/** 闲逛没写具体想法时的占位（角色原话优先，不覆盖）。 */
export const WANDER_DEFAULT_WISH = '在附近随便走走';

export const TRAVEL_INTENT_MAX_WISH_CHARS = 80;
/** 自主产生的愿望多久没被处理就作废（不无限期挂着）。 */
export const TRAVEL_INTENT_TTL_MS = 45 * 60 * 1000;
/** 同一角色这段时间内已经有一条同类愿望就不再叠加（防每轮都写一条）。 */
export const TRAVEL_INTENT_DEDUPE_MS = 3 * 60 * 60 * 1000;

export type TravelIntent =
  | { kind: 'none' }
  | { kind: 'go'; wishText: string; category: string | null }
  | { kind: 'wander'; wishText: string; category: typeof WANDER_CATEGORY };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const clip = (text: string, max: number): string =>
  text.length <= max ? text : text.slice(0, max);

/**
 * 解析自主回合 JSON 里的可选 `travel` 段。
 *
 * - 缺省 / `null` → `{kind:'none'}`（这一轮没提，正常）
 * - 形状不合法（不是对象、`want` 不认识、`go` 没给可用愿望）→ `null`
 *   （调用方只记一条日志，**不**让整轮自主回合失败：出行是可选产出）
 * - 愿望文本过既有 `sanitizeWishText`：带坐标/住户级细节的直接判不合法，
 *   不落库、不送地图搜索。
 */
export function parseTravelIntent(raw: unknown): TravelIntent | null {
  if (raw === undefined || raw === null) return { kind: 'none' };
  if (!isRecord(raw)) return null;
  const want = typeof raw.want === 'string' ? raw.want.trim().toLowerCase() : '';
  if (want === 'none' || want === 'no' || want === 'stay') return { kind: 'none' };
  if (want === 'wander') {
    const rawText = typeof raw.wish === 'string' ? raw.wish.trim() : '';
    const checked = rawText ? sanitizeWishText(rawText) : null;
    if (checked && !checked.ok) return null;
    return {
      kind: 'wander',
      wishText: clip(
        checked && checked.ok ? checked.text : WANDER_DEFAULT_WISH,
        TRAVEL_INTENT_MAX_WISH_CHARS,
      ),
      category: WANDER_CATEGORY,
    };
  }
  if (want === 'go') {
    const rawText = typeof raw.wish === 'string' ? raw.wish.trim() : '';
    if (!rawText) return null;
    const checked = sanitizeWishText(rawText);
    if (!checked.ok) return null;
    const category = typeof raw.category === 'string' && raw.category.trim()
      ? raw.category.trim().slice(0, 24)
      : null;
    return {
      kind: 'go',
      wishText: clip(checked.text, TRAVEL_INTENT_MAX_WISH_CHARS),
      category,
    };
  }
  return null;
}

export type TravelIntentSkipReason =
  | 'none'
  | 'invalid'
  | 'disabled'
  | 'char_disabled'
  | 'budget_missing'
  | 'budget_paused'
  | 'budget_zero'
  | 'duplicate'
  | 'write_failed';

export interface TravelIntentResult {
  written: boolean;
  reason: TravelIntentSkipReason;
  wishId?: string;
}

const OPEN_STATES = ['open', 'candidates_ready', 'chosen'] as const;

/**
 * 把一条 intent 落成真实愿望。
 *
 * 顺序：授权（总开关 → 角色位）→ 预算（行存在、未暂停、地图额度 > 0）→ 去重 → 幂等插入。
 * 任何一步不过都**不写**，并回一个可诊断的 reason；调用方不会因为出行还没开就把自主回合
 * 判失败。
 */
export async function recordTravelIntent(
  db: TravelDb,
  args: {
    userId: string;
    charId: string;
    intent: TravelIntent | null;
    nowMs: number;
    ttlMs?: number;
    dedupeMs?: number;
  },
): Promise<TravelIntentResult> {
  const { userId, charId, intent, nowMs } = args;
  if (!intent) return { written: false, reason: 'invalid' };
  if (intent.kind === 'none') return { written: false, reason: 'none' };

  const settings = await getTravelSettings(db, userId);
  if (!settings || settings.enabled !== true) return { written: false, reason: 'disabled' };
  const charSettings = await getTravelCharSettings(db, { userId, charId });
  if (!charSettings || charSettings.enabled !== true) return { written: false, reason: 'char_disabled' };

  const budget = await getTravelBudget(db, { userId, nowMs });
  if (!budget) return { written: false, reason: 'budget_missing' };
  if (budget.paused) return { written: false, reason: 'budget_paused' };
  // 0 = 用户明确关掉地图额度：写一条注定跑不动的愿望是替角色假装有生活。
  if (!(budget.mapCallsLimit > 0)) return { written: false, reason: 'budget_zero' };

  const dedupeMs = Math.max(0, Math.trunc(args.dedupeMs ?? TRAVEL_INTENT_DEDUPE_MS));
  if (dedupeMs > 0) {
    try {
      const open = await listTravelWishes(db, {
        userId,
        charId,
        nowMs,
        states: [...OPEN_STATES],
      });
      const sameKind = open.find((wish) => (
        intent.kind === 'wander'
          ? (wish.category ?? '') === WANDER_CATEGORY
          : (wish.category ?? '') !== WANDER_CATEGORY
      ));
      if (sameKind && nowMs - sameKind.createdAt < dedupeMs) {
        return { written: false, reason: 'duplicate', wishId: sameKind.id };
      }
    } catch {
      // 读不出来就不去重（宁可多一条，也不要因为读失败把愿望吞掉）。
    }
  }

  const wish: TravelWishRecord = {
    id: `tw:${userId}:${charId}:${crypto.randomUUID()}`,
    userId,
    charId,
    wishText: intent.wishText,
    category: intent.category,
    selectedCandidateId: null,
    state: 'open',
    expiresAt: nowMs + Math.max(60_000, Math.trunc(args.ttlMs ?? TRAVEL_INTENT_TTL_MS)),
    createdAt: nowMs,
    updatedAt: nowMs,
  };
  const written = await insertTravelWish(db, wish);
  return written
    ? { written: true, reason: 'none', wishId: wish.id }
    : { written: false, reason: 'write_failed' };
}

/* ------------------------------------------------------------------ *
 * 没有推送订阅时的自主意愿（tick 里的探针回合）
 *
 * `autonomyScheduler` 的自主回合在 `hasAutonomyPushSubscription` 没过时整跳跳过
 * （上游对无订阅任务回 409），所以「页面关着 + 没订阅」的用户永远拿不到愿望。
 * 这里用出行自己已有的授权 + 预算 + 账本补一条**不需要推送**的路径：
 * 每个窗口最多问一次「想不想出去」，模型说不想就什么都不写。
 * ------------------------------------------------------------------ */

/** 探针窗口：默认 3 小时最多问一次（不是每小时强制出门）。 */
export const TRAVEL_INTENT_PROBE_WINDOW_MS = 3 * 60 * 60 * 1000;
/** 探针窗口上限：配成「一天以上」等于把探针关掉，不给这种隐形关闭留口子。 */
export const TRAVEL_INTENT_PROBE_WINDOW_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * 探针窗口的解析（纯函数）：
 * 1. 运维显式配的分钟数（`TRAVEL_INTENT_PROBE_MINUTES`）；
 * 2. 否则沿用用户**自己配的**「同类动作最小间隔」（autonomy 护栏 `sameKindMinGapMinutes`，
 *    同一份授权、不另立一套设置，用户调大调小都跟着走）；
 * 3. 都没有才用 3h 兜底。
 * 夹在 [1 分钟, 24h]：用户把间隔配成 0（= 不设间隔）不会变成「每跳都问一次」，
 * 配错成巨大值也不会把探针悄悄关掉。
 */
export function resolveIntentProbeWindowMs(input: {
  configuredMinutes?: number | null;
  guardrailGapMinutes?: number | null;
}): number {
  for (const value of [input.configuredMinutes, input.guardrailGapMinutes]) {
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    const ms = Math.trunc(minutes) * 60_000;
    return Math.min(TRAVEL_INTENT_PROBE_WINDOW_MAX_MS, Math.max(60_000, ms));
  }
  return TRAVEL_INTENT_PROBE_WINDOW_MS;
}
/** 探针占位行的类别（不会被当成真愿望去搜点）。 */
export const INTENT_PROBE_CATEGORY = '__intent_probe';
/** 「这一轮没想出门」的留痕文案（不是角色说的话，只用来避免同一窗口反复问）。 */
const INTENT_PROBE_NONE_TEXT = '（这一轮没想出门）';

/**
 * 认领一个窗口的问询权：**确定性 id + INSERT OR IGNORE** 就是并发闸。
 * 同一个窗口里第二个 tick 拿不到认领，不会再多花一次模型。
 */
export async function claimIntentProbe(
  db: TravelDb,
  args: { charId: string; nowMs: number; windowMs?: number },
): Promise<{ claimed: boolean; wishId: string }> {
  const windowMs = Math.max(60_000, Math.trunc(args.windowMs ?? TRAVEL_INTENT_PROBE_WINDOW_MS));
  const slot = Math.floor(args.nowMs / windowMs);
  const wishId = `tw:intent:${args.charId}:${slot}`;
  const claimed = await insertTravelWish(db, {
    id: wishId,
    userId: '',
    charId: args.charId,
    wishText: '',
    category: INTENT_PROBE_CATEGORY,
    selectedCandidateId: null,
    state: 'open',
    expiresAt: args.nowMs + windowMs,
    createdAt: args.nowMs,
    updatedAt: args.nowMs,
  }).catch(() => false);
  return { claimed, wishId };
}

/**
 * 收尾：模型说「想出去」→ 占位行变成真愿望（交给 tick 原有状态机）；
 * 说「不想」/ 形状坏 → 标 expired（留痕，不再同一窗口追问，也不会被当成愿望去搜点）。
 * **绝不因为接口失败编一个愿望。**
 */
export async function finalizeIntentProbe(
  db: TravelDb,
  args: {
    userId: string;
    wishId: string;
    proposal: { kind: 'none' } | { kind: 'go'; wishText: string; category: string | null } | { kind: 'wander'; wishText: string } | null;
    nowMs: number;
    ttlMs?: number;
  },
): Promise<'written' | 'none'> {
  const { userId, wishId, proposal, nowMs } = args;
  if (!proposal || proposal.kind === 'none') {
    await db
      .prepare("UPDATE travel_wishes SET user_id = ?, wish_text = ?, category = ?, state = 'expired', expires_at = ?, updated_at = ? WHERE id = ?")
      .bind(userId, INTENT_PROBE_NONE_TEXT, INTENT_PROBE_CATEGORY, nowMs, nowMs, wishId)
      .run();
    return 'none';
  }
  const checked = sanitizeWishText(proposal.wishText);
  const wishText = proposal.kind === 'wander'
    ? (checked.ok ? checked.text : WANDER_DEFAULT_WISH)
    : (checked.ok ? checked.text : '');
  if (!wishText) {
    // `go` 却没有可用愿望（带坐标/门牌）：不落愿望，也不冒充「角色改主意」。
    await db
      .prepare("UPDATE travel_wishes SET user_id = ?, wish_text = ?, category = ?, state = 'expired', expires_at = ?, updated_at = ? WHERE id = ?")
      .bind(userId, INTENT_PROBE_NONE_TEXT, INTENT_PROBE_CATEGORY, nowMs, nowMs, wishId)
      .run();
    return 'none';
  }
  await db
    .prepare("UPDATE travel_wishes SET user_id = ?, wish_text = ?, category = ?, selected_candidate_id = NULL, state = 'open', expires_at = ?, updated_at = ? WHERE id = ?")
    .bind(
      userId,
      wishText,
      proposal.kind === 'wander' ? WANDER_CATEGORY : proposal.category,
      nowMs + Math.max(60_000, Math.trunc(args.ttlMs ?? TRAVEL_INTENT_TTL_MS)),
      nowMs,
      wishId,
    )
    .run();
  return 'written';
}

/**
 * 后台枚举：**已获授权的角色**（出行总开关 + 角色启用位都为真）。
 *
 * tick 的 subject 不能只看「已有愿望」（那样第一次永远动不起来，且用户不必手写愿望）。
 * 这里只读两张授权表；预算与暂停仍在 `runTravelTickForSubject` 执行前复核，
 * 所以枚举范围放宽**不会**导致未授权/零额度角色被调用模型或地图。
 */
export async function listAuthorizedTravelSubjects(
  db: TravelDb,
): Promise<Array<{ userId: string; charId: string }>> {
  const rows = await db
    .prepare(
      'SELECT s.user_id AS user_id, c.char_id AS char_id FROM travel_settings s'
      + ' JOIN travel_char_settings c ON c.user_id = s.user_id'
      + ' WHERE s.enabled = 1 AND c.enabled = 1'
      + ' ORDER BY s.user_id ASC, c.char_id ASC',
    )
    .bind()
    .all();
  return (rows.results ?? [])
    .filter((row) => typeof row.user_id === 'string' && typeof row.char_id === 'string')
    .map((row) => ({ userId: String(row.user_id), charId: String(row.char_id) }));
}

/** tick 默认枚举：已授权角色 ∪ 真的建过愿望的租户（后者保证老数据继续跑完）。 */
export async function listTravelTickSubjectsWithAuthorized(
  db: TravelDb,
): Promise<Array<{ userId: string; charId: string }>> {
  const [wishes, authorized] = await Promise.all([
    db
      .prepare('SELECT DISTINCT user_id, char_id FROM travel_wishes')
      .bind()
      .all()
      .then((rows) => (rows.results ?? []))
      .catch(() => [] as Record<string, unknown>[]),
    listAuthorizedTravelSubjects(db).catch(() => [] as Array<{ userId: string; charId: string }>),
  ]);
  const merged = new Map<string, { userId: string; charId: string }>();
  for (const subject of authorized) merged.set(`${subject.userId}\u0000${subject.charId}`, subject);
  for (const row of wishes) {
    if (typeof row.user_id !== 'string' || typeof row.char_id !== 'string') continue;
    const key = `${row.user_id}\u0000${row.char_id}`;
    if (!merged.has(key)) merged.set(key, { userId: row.user_id, charId: row.char_id });
  }
  return [...merged.values()].sort((a, b) => (
    a.userId === b.userId ? a.charId.localeCompare(b.charId) : a.userId.localeCompare(b.userId)
  ));
}
