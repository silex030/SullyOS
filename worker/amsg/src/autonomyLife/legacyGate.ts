/**
 * 旧自主回合（AIRP `autonomous_round`）的**统一边界闸**。
 *
 * 为什么需要这一层：`worker/amsg/src/index.ts` 的 cron 里还残留着旧调度
 * （`runAutonomyTick` + `createAutonomyPostTask`），它自己有另一套护栏/额度/暂停，
 * 完全不看新的 `autonomy_life_boundaries`。结果就是「用户在设置页按下总暂停 / 关了角色 /
 * 用完了额度」以后，旧链路照样能调模型、发消息——新边界形同虚设。
 *
 * 处理方式（改道，不是删功能）：旧链路保留执行能力，但**每个角色每一跳都必须先过这里**，
 * 判定口径与新引擎完全一致：
 *
 *   1. 账号层：必须 enabled 且未 globalPaused（没有边界行 = 默认关闭，直接不跑）；
 *   2. 角色层：charEnabled 不能被关掉（角色没登记也不跑：不替用户给全部角色开生活）；
 *   3. kind 白名单：旧回合本质是「角色发一条消息」→ 映射成 `interaction.message`，
 *      必须被 allowedKinds 允许；
 *   4. 禁区：旧回合的正文由上游 LLM 生成，worker 侧在出请求前**无法**证明它遵守了
 *      用户新增的 forbiddenCategories / avoidTopics。按 fail closed：只要边界里有
 *      **用户新增**的禁区/回避话题（平台内置禁区不算），旧回合就整跳不跑；
 *   5. 预算：当前窗口的 calls（used + reserved）必须还没到 limits 上限。
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
import { windowIdAt, type BudgetRow } from '../../../../utils/autonomyLife/budget';
import type { AutonomyTickPack } from '../autonomyScheduler';
import { readBudgetRows, type LifeDb } from './store';

/** 旧自主回合映射到新边界的 kind（它就是「角色发一条消息」）。 */
export const LEGACY_AUTONOMY_KIND = 'interaction.message' as const;

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
 * 逐个角色判定（真 SQL 读边界与预算）。返回可继续跑的包与逐条跳过原因。
 * 读不出来（D1 错）按**不跑**处理：旧链路不能因为「读不到边界」而放飞。
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
  let boundary: EffectiveBoundaryV1;
  try {
    const accountRow = await db
      .prepare("SELECT payload FROM autonomy_life_boundaries WHERE owner_id = ? AND scope = 'account' AND char_id = ''")
      .bind(pack.userId)
      .first();
    const characterRow = await db
      .prepare("SELECT payload FROM autonomy_life_boundaries WHERE owner_id = ? AND scope = 'character' AND char_id = ?")
      .bind(pack.userId, pack.charId)
      .first();

    if (!accountRow || !characterRow) {
      // 没有账号边界行 = 从没在新入口里打开过；没有角色行 = 这个角色没被登记。
      return accountRow ? 'character_not_registered' : 'account_disabled';
    }
    const account = JSON.parse(String(accountRow.payload)) as Parameters<typeof mergeEffectiveBoundary>[0]['account'];
    const character = JSON.parse(String(characterRow.payload)) as NonNullable<Parameters<typeof mergeEffectiveBoundary>[0]['character']>;
    boundary = mergeEffectiveBoundary({ account, character, charId: pack.charId, nowMs });
  } catch {
    // 读边界失败 → 不跑（fail closed），原因按暂停处理给运维看。
    return 'account_disabled';
  }

  if (!boundary.enabled || boundary.globalPaused) return 'paused';
  if (boundary.charEnabled === false) return 'char_disabled';
  const gate = boundaryGate(boundary, LEGACY_AUTONOMY_KIND);
  if (!gate.ok) return gate.code === 'CHAR_DISABLED' ? 'char_disabled' : 'kind_not_allowed';
  if (userForbidden(boundary).length > 0 || boundary.avoidTopics.length > 0) return 'forbidden_topic';

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
