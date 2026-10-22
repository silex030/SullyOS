/**
 * 自主背景生活（autonomy）的到点调度器 —— wrapper 层，cron 每分钟调一次。
 *
 * 这条路解决的是「页面关着的时候角色也该过日子」：cron 扫一遍各角色的 fire_pack，
 * 按角色自己的 cadence / 静默段 / 当日配额 / 熔断逐道闸判定，通过了就**自转发**一条
 * `autonomous_round` 任务给上游（`POST /schedule-message`，见 task-17 brief 的
 * 「Locked enqueue mechanism」）。
 *
 * 三个不显然的设计点：
 *
 * 1. **claim-first**：先写 autonomy_state（last_round_at / rounds_today）再建任务，而且
 *    失败不回滚。CF Cron 与 VPS 的 node-cron 可能同时喂这一跳，扣账在前能把重复触发的
 *    代价压到「多花一次窗口」这一侧，另一个方向（先建任务、写账失败）会变成无限重排。
 *
 * 2. **加密镜像**：上游没有导出 `encryptPayload`（cloudflare.d.ts:10 只有
 *    deriveUserEncryptionKey / decryptPayload / encryptForStorage / decryptFromStorage），
 *    而 `/schedule-message` 强制加密（ENCRYPTION_REQUIRED）。所以这里内联一份 12 行的
 *    AES-256-GCM 镜像——格式与客户端 `encryptPayload` 逐字节相同：iv12 + tag16，
 *    信封 { iv, authTag, encryptedData } 全 base64，明文是 JSON 的 UTF-8 字节。
 *    同一格式在 worker/amsg/src/pushFanout.test.ts:36-56 有先例；
 *    另有 round-trip 测试拿上游导出的 decryptPayload 反过来钉住它。
 *
 * 3. **判定全注入**：nowMs / rand01 / postTask / packs 都是入参，决策层零 Date.now /
 *    Math.random / fetch——所以这一整套能在 vitest 里确定性地钉住。
 */

import { decryptFromStorage, deriveUserEncryptionKey } from '@rei-standard/amsg-server/cloudflare';
import { AUTONOMOUS_ROUND_KIND } from '../../../utils/airp/autonomySettings';
import {
  AUTONOMY_GUARDRAIL_DEFAULTS,
  AUTONOMY_GUARDRAIL_STATE_KEY,
  AUTONOMY_GUARDRAIL_STATE_NAMESPACE,
  effectiveAutonomyGuardrails,
  normalizeAutonomyGuardrails,
  parseAutonomyGuardrailStateValue,
  type AirpAutonomyGuardrails,
} from '../../../utils/airp/autonomyGuardrails';
import type { ResolvedAirpAutonomy } from '../../../utils/airp/autonomySettings';
import { canRunPrivateLifeAction } from '../../../utils/airp/lifeWorkflowPermissions';
import {
  computeScheduledAt,
  evaluateWorkflowBudget,
  chatUserMessageRef,
  isCancelableByUserSpeech,
  type AutonomyPlanRecord,
  type WorkflowBudgetReason,
} from '../../../utils/airp/lifeWorkflow';
import {
  AMSG_FIRE_PACK_KEY,
  AMSG_STATE_NAMESPACE_PREFIX,
  parseFirePack,
  unpackStateValue,
  wallClockPartsInZone,
  type AmsgFirePack,
} from '../../../utils/amsgFirePack';
import { AMSG_TOOL_PACK_KEY, parseToolPack } from '../../../utils/amsgToolPack';
import {
  AMSG_BACKGROUND_JOB_SUBTYPE,
  AMSG_JOB_ID_KEY,
  AMSG_TASK_KIND_KEY,
} from '../../../utils/amsgTaskKinds';
import {
  AUTONOMY_EXPERIENCE_TTL_MS,
  cancelPendingAutonomyPlans,
  claimAutonomyPlanForSchedule,
  claimGlobalAutonomyBudget,
  cleanupAutonomyExperiences,
  countAutonomyPlansSince,
  ensureAutonomySchema,
  expireStaleAutonomyPlans,
  getAutonomyState,
  getGlobalAutonomyUsage,
  insertAutonomyPlanRun,
  lastAutonomyPlanOfKindAt,
  listAutonomyPlans,
  listDueAutonomyPlans,
  releaseGlobalAutonomyBudget,
  setAutonomyState,
  settleAutonomyPlan,
  sumReservedAutonomyTokensSince,
  updateAutonomyPlanRun,
  type AutonomyDb,
} from './autonomyStore';

/** 连续失败到几次就熔断（不再排新的一轮，等用户动设置或下一轮成功清账）。 */
export const AUTONOMY_FAIL_LIMIT = 3;

/** 跳过原因只用这一组字面量：日志、测试和（之后的）面板都按它对齐。 */
export const AUTONOMY_SKIP_REASONS = {
  disabled: 'autonomy-disabled',
  paused: 'autonomy-paused',
  missingCredentials: 'missing-credentials',
  missingPushSubscription: 'missing-push-subscription',
  cadenceInvalid: 'cadence-invalid',
  tzInvalid: 'tz-invalid',
  spacingWindow: 'spacing-window',
  dailyLimit: 'daily-limit',
  quietHours: 'quiet-hours',
  pushCooldown: 'push-cooldown',
  tokenBudget: 'token-budget',
  failMuted: 'fail-muted',
  postFailed: 'post-failed',
  // P5 生活工作流（计划）侧的跳过原因：与既有回合分开，面板/日志才对得上。
  planDailyLimit: 'plan-char-daily-limit',
  planKindGap: 'plan-kind-gap',
  planGlobalLimit: 'plan-global-limit',
  planTokenBudget: 'plan-token-budget',
  planPostFailed: 'plan-post-failed',
  planNotPending: 'plan-not-pending',
  planCapability: 'plan-capability-denied',
  /** 共享护栏读不出来（缺钥/密文坏/D1 错）：这一跳暂停，绝不当成「用户没暂停」。 */
  guardrailsUnreadable: 'guardrails-unreadable',
} as const;

export type AutonomySkipReason = (typeof AUTONOMY_SKIP_REASONS)[keyof typeof AUTONOMY_SKIP_REASONS];

// ─── 扫描：上游 client_state 里的 fire_pack ──────────────────────────────

export interface AutonomyTickPack {
  userId: string;
  charId: string;
  /** 角色名（取自同命名空间的 tool_pack；缺了就是空串，转发时回落到 charId）。 */
  charName: string;
  pack: AmsgFirePack;
  /**
   * 用户级共享护栏（全局次数 / 总暂停）。由 scanAutonomyPacks 在同一次扫描里读出来
   * 挂在包上——cron 调用处不需要额外传 masterKey，也不会退回「每个角色各带一份全局额度」。
   * 缺省（手工喂包的单测）按默认 6 次/天、不暂停。
   */
  sharedGuardrails?: AirpAutonomyGuardrails;
  /**
   * true = 这个用户的共享护栏**读不出来**（缺 master key / 密文坏 / D1 错），
   * 不是「没配」。读到这个标记时调度器必须整跳暂停，不能补读默认值。
   */
  sharedGuardrailsUnreadable?: boolean;
}

export interface AutonomyScanSkipped {
  charId: string;
  reason: string;
}

export interface AutonomyScanResult {
  packs: AutonomyTickPack[];
  skipped: AutonomyScanSkipped[];
}

const SCAN_UNREADABLE = 'pack-unreadable';

/** `client_state.namespace` → charId；不是角色命名空间就回 null。 */
const charIdFromNamespace = (namespace: unknown): string | null => {
  if (typeof namespace !== 'string') return null;
  if (!namespace.startsWith(AMSG_STATE_NAMESPACE_PREFIX)) return null;
  const charId = namespace.slice(AMSG_STATE_NAMESPACE_PREFIX.length);
  return charId || null;
};

/**
 * 扫出所有带 fire_pack 的角色（cron 侧唯一的「有哪些角色在过自主生活」来源）。
 *
 * 一次查询把 fire_pack 与 tool_pack 两行都捞回来（同一命名空间、同一次解密口径）：
 * tool_pack 只为了拿 charName——fire_pack 里没有角色名字段，而转发的任务载荷需要它。
 *
 * 解不出来 / 版本不认识的角色记一条 skipped 就跳过（**不抛**）：一个角色的坏数据不能
 * 让整轮调度停摆。分块存储（value 是上游的 chunked root marker）落在这一类里——那需要
 * 复刻上游 chunk 行的命名空间与拼接规则，本任务不做，留到有需要时再说。
 */
export async function scanAutonomyPacks(args: {
  db: AutonomyDb;
  masterKey: string;
}): Promise<AutonomyScanResult> {
  const rows = await args.db
    .prepare('SELECT user_id, namespace, key, value FROM client_state WHERE key = ? OR key = ?')
    .bind(AMSG_FIRE_PACK_KEY, AMSG_TOOL_PACK_KEY)
    .all();

  const byNamespace = new Map<string, { userId: string; rows: Array<Record<string, unknown>> }>();
  for (const row of rows.results ?? []) {
    const charId = charIdFromNamespace(row.namespace);
    const userId = row.user_id;
    if (!charId || typeof userId !== 'string' || !userId) continue;
    const bucket = byNamespace.get(charId) ?? { userId, rows: [] };
    bucket.rows.push(row);
    byNamespace.set(charId, bucket);
  }

  const packs: AutonomyTickPack[] = [];
  const skipped: AutonomyScanSkipped[] = [];

  const decrypt = async (userId: string, value: unknown): Promise<string> => {
    if (typeof value !== 'string' || !value) throw new Error('值不是字符串');
    const userKey = await deriveUserEncryptionKey(userId, args.masterKey);
    return unpackStateValue(await decryptFromStorage(value, userKey));
  };

  for (const charId of [...byNamespace.keys()].sort()) {
    const bucket = byNamespace.get(charId)!;
    const packRow = bucket.rows.find((row) => row.key === AMSG_FIRE_PACK_KEY);
    if (!packRow) continue;

    let pack: AmsgFirePack | null = null;
    try {
      pack = parseFirePack(await decrypt(bucket.userId, packRow.value));
    } catch {
      pack = null;
    }
    if (!pack) {
      skipped.push({ charId, reason: SCAN_UNREADABLE });
      continue;
    }

    let charName = '';
    const toolRow = bucket.rows.find((row) => row.key === AMSG_TOOL_PACK_KEY);
    if (toolRow) {
      try {
        charName = parseToolPack(await decrypt(bucket.userId, toolRow.value))?.charName ?? '';
      } catch {
        charName = '';
      }
    }

    packs.push({ userId: bucket.userId, charId, charName, pack });
  }

  // 用户级共享护栏：和 fire_pack 同一次扫描、同一把 master key，读一次按 user 缓存。
  // 读不出来的用户**必须**被记住：`runAutonomyTick` 不能再用「没挂上护栏 = 默认 6 次/天、
  // 不暂停」去补一次读取，否则用户按下的总暂停会被无声取消（cloud 行坏了 / 换钥 / D1 抖动）。
  // 只有「行确实不存在」才是新用户，可以走默认值。
  const guardrailsByUser = new Map<string, AirpAutonomyGuardrails>();
  const guardrailsUnreadableUsers = new Set<string>();
  try {
    const rowsGuard = await args.db
      .prepare('SELECT user_id, value FROM client_state WHERE namespace = ? AND key = ?')
      .bind(AUTONOMY_GUARDRAIL_STATE_NAMESPACE, AUTONOMY_GUARDRAIL_STATE_KEY)
      .all();
    for (const row of rowsGuard.results ?? []) {
      const userId = row.user_id;
      const value = row.value;
      if (typeof userId !== 'string' || !userId) continue;
      if (typeof value !== 'string' || !value) {
        guardrailsUnreadableUsers.add(userId);
        continue;
      }
      try {
        const userKey = await deriveUserEncryptionKey(userId, args.masterKey);
        const plain = await unpackStateValue(await decryptFromStorage(value, userKey));
        const parsed = parseAutonomyGuardrailStateValue(plain);
        if (parsed) guardrailsByUser.set(userId, parsed);
        else guardrailsUnreadableUsers.add(userId);
      } catch (error) {
        // 单行坏掉只影响这个用户，但处理方式必须是「这一跳暂停」，不是「按默认预算跑」。
        guardrailsUnreadableUsers.add(userId);
        console.warn('[amsg:autonomy] 共享护栏解密/解析失败，本跳暂停这个用户', userId,
          error instanceof Error ? error.message : error);
      }
    }
  } catch (error) {
    // 整表读不出来：所有这个用户的包都按「读不出来」处理（fail-closed）。
    for (const bucket of byNamespace.values()) guardrailsUnreadableUsers.add(bucket.userId);
    console.warn('[amsg:autonomy] 共享护栏没读出来（本跳按暂停处理）', error);
  }
  for (const entry of packs) {
    const shared = guardrailsByUser.get(entry.userId);
    if (shared) entry.sharedGuardrails = shared;
    if (guardrailsUnreadableUsers.has(entry.userId)) entry.sharedGuardrailsUnreadable = true;
  }

  return { packs, skipped };
}

// ─── 决策层 ────────────────────────────────────────────────────────────

export interface AutonomyPostTaskArgs {
  userId: string;
  charId: string;
  charName: string;
  pack: AmsgFirePack;
  /** P5：这次建的是生活工作流任务（到点由 autonomyFire 走独立请求）。 */
  plan?: AutonomyPlanRecord;
}

export interface AutonomyTickInput {
  nowMs: number;
  /** 采样源；不传用 Math.random。每个角色最多消费一次。 */
  rand01?: () => number;
  db: AutonomyDb;
  packs: AutonomyTickPack[];
  postTask: (args: AutonomyPostTaskArgs) => Promise<unknown>;
  /**
   * 读共享护栏（`amsg:global/autonomy_guardrails`，加密行）用的 master key。
   * 父集成在 cron 调用处传 `env.AMSG_MASTER_KEY`；缺省时全局配置回落到默认值
   * （6 次/天、不暂停），不会让整跳失败。
   */
  masterKey?: string;
}

export interface AutonomyTickResult {
  /** 这一跳真的建出任务的角色。 */
  built: string[];
  /** 这一跳排出去的生活工作流计划 id（P5；与回合分开记）。 */
  plansScheduled: string[];
  skipped: Array<{ charId: string; reason: string }>;
}

/** 角色时区下的日期 key（`YYYY-MM-DD`）。非法 tzId 抛错，调用方按跳过处理。 */
export function autonomyDateKey(nowMs: number, tzId: string): string {
  const p = wallClockPartsInZone(nowMs, { tzId });
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** 角色时区当地当日起点（绝对毫秒）。非法 tzId 抛错，与 autonomyDateKey 同语义。 */
export function startOfAutonomyDayMs(nowMs: number, tzId: string): number {
  const p = wallClockPartsInZone(nowMs, { tzId });
  // 把「本地墙上时间当成 UTC」反推偏移，再折回绝对时刻；分钟级精度足够算日界。
  const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const offset = localAsUtc - Math.floor(nowMs / 60_000) * 60_000;
  return Date.UTC(p.year, p.month - 1, p.day, 0, 0) - offset;
}

// ─── 全局护栏（用户级共享配置） ──────────────────────────────────────────
//
// 全局额度与总暂停存在 client_state 的 `amsg:global/autonomy_guardrails` 一行里：
// 与工具配置同一个全局 namespace、同一套 X-User-Id + masterKey 加密边界，前端写它走
// 既有 putClientStateOrThrow。**worker 只读这一行，绝不从某个角色的 fire_pack 里拿全局额度**——
// 那等于让每个角色自带一份「全局额度」，多角色/多设备时既不同步也不可信。

/**
 * 读这个用户的共享护栏。三态是必须的：
 *   - `absent`：这一行**确实不存在** = 新用户/没配过，可以走默认（6 次/天、不暂停）；
 *   - `ok`：读到并归一；
 *   - `unreadable`：缺 master key / 密文坏 / D1 错 / 形状坏——**不许**当成默认值。
 *
 * 以前这里把所有失败都折成默认值，等于用户按下的总暂停会被一次 D1 抖动静默取消。
 */
export type AutonomyGuardrailReadStatus = 'ok' | 'absent' | 'unreadable';

export interface AutonomyGuardrailReadResult {
  status: AutonomyGuardrailReadStatus;
  /** 只有 `ok` 是用户真实配置；`absent` 是默认值；`unreadable` 是保守暂停值。 */
  guardrails: AirpAutonomyGuardrails;
  error?: string;
}

/** 读不出来时给调用方的保守值：暂停 + 0 额度（不会有任何计划被排出去）。 */
export const AUTONOMY_GUARDRAIL_UNREADABLE: AirpAutonomyGuardrails = {
  ...AUTONOMY_GUARDRAIL_DEFAULTS,
  paused: true,
  globalPerDay: 0,
};

export async function readAutonomyGuardrailsForUserDetailed(
  db: AutonomyDb,
  masterKey: string,
  userId: string,
): Promise<AutonomyGuardrailReadResult> {
  if (!masterKey) {
    // 没有 key 就无法证明用户没有暂停：按暂停处理，绝不「默认不暂停」。
    return { status: 'unreadable', guardrails: { ...AUTONOMY_GUARDRAIL_UNREADABLE }, error: 'missing-master-key' };
  }
  try {
    const row = await db
      .prepare('SELECT value FROM client_state WHERE user_id = ? AND namespace = ? AND key = ?')
      .bind(userId, AUTONOMY_GUARDRAIL_STATE_NAMESPACE, AUTONOMY_GUARDRAIL_STATE_KEY)
      .first();
    if (row == null) {
      return { status: 'absent', guardrails: { ...AUTONOMY_GUARDRAIL_DEFAULTS } };
    }
    // 行的形状都不是「value 列」= 这条查询根本没命中护栏行（旧假库/异常驱动）；
    // 真正的护栏行一定带 value 键（值可能是 null/空串 → 那是 unreadable）。
    if (!('value' in (row as Record<string, unknown>))) {
      return { status: 'absent', guardrails: { ...AUTONOMY_GUARDRAIL_DEFAULTS } };
    }
    const value = (row as { value?: unknown }).value;
    if (typeof value !== 'string' || !value) {
      return { status: 'unreadable', guardrails: { ...AUTONOMY_GUARDRAIL_UNREADABLE }, error: 'empty-value' };
    }
    const userKey = await deriveUserEncryptionKey(userId, masterKey);
    const plain = await unpackStateValue(await decryptFromStorage(value, userKey));
    const parsed = parseAutonomyGuardrailStateValue(plain);
    if (!parsed) {
      return { status: 'unreadable', guardrails: { ...AUTONOMY_GUARDRAIL_UNREADABLE }, error: 'bad-shape' };
    }
    return { status: 'ok', guardrails: parsed };
  } catch (error) {
    return {
      status: 'unreadable',
      guardrails: { ...AUTONOMY_GUARDRAIL_UNREADABLE },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 兼容入口：调用方只要护栏值。读不出来时返回**保守暂停值**（paused:true），
 * 不是默认的「不暂停」。调用方要区分三态请用 `readAutonomyGuardrailsForUserDetailed`。
 */
export async function readAutonomyGuardrailsForUser(
  db: AutonomyDb,
  masterKey: string,
  userId: string,
): Promise<AirpAutonomyGuardrails> {
  const result = await readAutonomyGuardrailsForUserDetailed(db, masterKey, userId);
  if (result.status === 'unreadable') {
    console.warn('[amsg:autonomy] 共享护栏读不出来，本轮按暂停处理', userId, result.error);
  }
  return result.guardrails;
}

const budgetSkipReason = (reason: WorkflowBudgetReason): string => {
  switch (reason) {
    case 'paused': return AUTONOMY_SKIP_REASONS.paused;
    case 'char-daily-limit': return AUTONOMY_SKIP_REASONS.planDailyLimit;
    case 'kind-gap': return AUTONOMY_SKIP_REASONS.planKindGap;
    case 'global-daily-limit': return AUTONOMY_SKIP_REASONS.planGlobalLimit;
    case 'token-budget': return AUTONOMY_SKIP_REASONS.planTokenBudget;
    default: return AUTONOMY_SKIP_REASONS.planGlobalLimit;
  }
};

// ─── 到点硬前置：上游 /schedule-message 在**建任务时**就会查这两样 ────────────
//
// 核实自 @rei-standard/amsg-server dist/chunk-3JEWYDM4.mjs 的 POST /schedule-message 分支：
//   :2544 supportsPushSubscriptionStore → :2549 db.getPushSubscription(userId) →
//   :2562 没有订阅行 / 不是非空字符串 → 409 PUSH_SUBSCRIPTION_MISSING（**无条件**，
//         与 messageSubtype / push 档位无关）；
//   :2574 `if (payload.credRefs)` → :2580 findMissingCredIds → :2584 缺行
//         → 409 CREDENTIAL_NOT_FOUND。
// 表形状同为上游 schema（adapters/schema.sqlite.d.ts:34-35）：
//   llm_credentials (user_id, cred_id, ...)  PK (user_id, cred_id)
//   push_subscriptions (user_id PRIMARY KEY, subscription, updated_at)
// 缺任何一样，任务即使建出来也必然被拒——所以调度器要在**扣账之前**先查，
// 缺了就跳过但不动 state（不算一轮、不烧预算），等用户补上后自然恢复。

/** 与 buildAutonomyScheduleRequest 的 credRefs 同一口径：角色 chat 用途的凭据行名。 */
export const autonomyChatCredId = (charId: string): string => `char:${charId}/chat`;

/**
 * 云端有没有这个角色 chat 用途的凭据行。查不到 / 查出错（表还没建、D1 抖动）都按
 * 「没有」处理：跳过比建一条到点必被 409 拒的任务更安全。
 */
export async function hasAutonomyChatCredential(
  db: AutonomyDb,
  userId: string,
  charId: string,
): Promise<boolean> {
  try {
    const row = await db
      .prepare('SELECT 1 AS ok FROM llm_credentials WHERE user_id = ? AND cred_id = ?')
      .bind(userId, autonomyChatCredId(charId))
      .first();
    return row != null;
  } catch {
    return false;
  }
}

/**
 * 这个用户有没有登记的推送订阅。上游建任何任务前都会无条件查它（见上方核实），
 * 所以推送档位为 off 的角色也得过这一关。订阅是按 user_id 存的一行（每设备），
 * 没有 per-char 概念——自主生活直接继承它。
 */
export async function hasAutonomyPushSubscription(db: AutonomyDb, userId: string): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT 1 AS ok FROM push_subscriptions WHERE user_id = ? AND subscription <> ''")
      .bind(userId)
      .first();
    return row != null;
  } catch {
    return false;
  }
}

/** 'HH:MM' → 当日起始的分钟数；形状不对回 null。 */
const parseHHMM = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** 含跨夜区间（start > end 时是「当天 start 到次日 end」）。start === end 视为没有静默段。 */
const inQuietHours = (quiet: { start: string; end: string }, minutes: number): boolean => {
  const start = parseHHMM(quiet.start);
  const end = parseHHMM(quiet.end);
  if (start === null || end === null || start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
};

/** 稳定的 JSON 串（键排序、递归）：configHash 只跟自己比，只要确定性就够。 */
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
};

/**
 * 自主设置的指纹（写进 `autonomy_state.config_hash`）。用户改设置 → 哈希变 → 清熔断，
 * 这就是「重新开始」的全部机制。导出是为了让 Task 18/19 与测试用同一份口径。
 */
export const autonomyConfigHash = (autonomy: unknown): string => stableStringify(autonomy);

/** 每小时毫秒数。 */
const HOUR_MS = 60 * 60 * 1000;

/** 计划任务在 metadata 上的键：到点由 autonomyFire 认出「这次是工作流执行」。 */
export const AUTONOMY_PLAN_META_KEY = 'amsgAutonomyPlan';

export interface AutonomyPlanMeta {
  planId: string;
  kind: string;
  title: string;
  purpose: string;
  noteHint?: string;
  maxChars: number;
}

/** 调度器只依赖 autonomy 终值里的这一小撮字段（结构子集，避免循环类型）。 */
/**
 * 计划队列读的自主设置：直接用 fire_pack 里的 `ResolvedAirpAutonomy`（含 capabilityMode /
 * capabilities），**不能**在这里另写一个窄接口——窄接口会让「排队前的能力闸」拿不到权限终值，
 * 于是 none 只能等到点才被拦住（白排一次任务、白占一个当日名额）。
 */
type ResolvedAirpAutonomyLike = ResolvedAirpAutonomy;

export interface AutonomyPlanTickArgs {
  db: AutonomyDb;
  userId: string;
  charId: string;
  charName: string;
  pack: AmsgFirePack;
  nowMs: number;
  lastUserMessageAt: number | null;
  autonomous: ResolvedAirpAutonomyLike;
  sharedGuardrails: AirpAutonomyGuardrails;
  postTask: (args: AutonomyPostTaskArgs) => Promise<unknown>;
}

export interface AutonomyPlanTickResult {
  scheduled: string[];
  skipped: Array<{ planId: string; reason: string }>;
  cancelled: number;
}

/** 排期租约：建任务到到点之间最多 30 分钟；过点说明任务丢了，不重排、按过期失败收。 */
const PLAN_SCHEDULE_LEASE_MS = 30 * 60 * 1000;

const isUnknownFailure = (message: string): boolean =>
  /timeout|timed\s*out|timedout|超时|unknown|未知|abort/i.test(message);

/**
 * 处理这个角色的生活工作流队列（P5 W3/W4）。
 *
 * 只在**既有 cron 跳**里跑，不新起定时器、不新增 LLM 判定调用：
 *   - 用户重新开口 → 取消还没开始的（scheduled 但没被租约占住）；
 *   - 到点的 proposed → 过次数/token 双门禁 → 认领全局额度 → 写执行预留 → 建一条
 *     autonomous_round 任务（metadata 带计划 id，到点走独立后台请求）；
 *   - 建任务失败：退全局名额、预留标 failed/unknown、计划标 failed/unknown（终态，
 *     绝不自动重试）。
 *
 * 幂等：计划认领是条件 UPDATE，执行行有唯一幂等键；重启/多设备重报都不会重复生成。
 */
export async function runAutonomyPlanQueue(args: AutonomyPlanTickArgs): Promise<AutonomyPlanTickResult> {
  const { db, charId, nowMs } = args;
  const scheduled: string[] = [];
  const skipped: AutonomyPlanTickResult['skipped'] = [];
  let cancelled = 0;

  try {
    await expireStaleAutonomyPlans(db, { charId, nowMs });
  } catch (error) {
    console.warn('[amsg:autonomy] 过期计划没标掉（下一跳再试）', charId, error);
  }

  // W4：用户重新开口 → 取消尚未开始的收尾（running 里的只标结果不再适用，不假装能退款）。
  // 「这一条用户消息」的引用带进判定：同一条消息催出来的计划不算「又开口了」。
  const lastUserMessageRef = typeof args.pack.lastUserMessageId === 'number'
    ? chatUserMessageRef(charId, args.pack.lastUserMessageId)
    : null;
  try {
    const pending = await listAutonomyPlans(db, charId, ['proposed', 'scheduled'], 20);
    if (pending.some((plan) => isCancelableByUserSpeech(plan, args.lastUserMessageAt, { lastUserMessageRef }))) {
      cancelled = await cancelPendingAutonomyPlans(db, {
        charId,
        nowMs,
        reason: 'user-spoke',
        ...(typeof args.lastUserMessageAt === 'number' ? { createdBeforeMs: args.lastUserMessageAt } : {}),
      });
    }
  } catch (error) {
    console.warn('[amsg:autonomy] 取消待办计划失败（下一跳再试）', charId, error);
  }

  let due: AutonomyPlanRecord[] = [];
  try {
    due = await listDueAutonomyPlans(db, charId, nowMs);
  } catch (error) {
    console.warn('[amsg:autonomy] 读到点计划失败（下一跳再试）', charId, error);
    return { scheduled, skipped, cancelled };
  }

  if (due.length === 0) return { scheduled, skipped, cancelled };

  const dayStart = startOfAutonomyDayMs(nowMs, args.pack.tzId);
  const dateKey = autonomyDateKey(nowMs, args.pack.tzId);
  // 全局额度是**用户级**的：日界必须按用户那边的钟算，不能跟着每个角色的时区走。
  // 否则上海角色和纽约角色会各自把共享行翻到不同日期，6 次/天被绕过。
  const globalDateKey = autonomyDateKey(nowMs, args.pack.userTzId || args.pack.tzId);
  const limits = effectiveAutonomyGuardrails(
    normalizeAutonomyGuardrails(args.autonomous.guardrails),
    args.sharedGuardrails,
  );
  // 既有回合已经烧掉的 token 记在 autonomy_state；计划侧再把未结算的预留加进去。
  const state = await getAutonomyState(db, charId);
  const tokensToday = state.tokensDate === dateKey ? state.tokensToday : 0;

  for (const plan of due) {
    // 能力闸必须**排队前**就过一遍，不能只等到点执行时再拦：
    // 用户把某一类（或全部）能力关掉后，队列里旧计划不该继续占当天的次数/全局名额，
    // 更不该建出一条到点必然失败的任务。到点那一侧（autonomyFire）仍会再查一次——
    // 两次读的是同一份权限代理，中间的开关变化由后一次兜住。
    if (!canRunPrivateLifeAction(args.autonomous, plan.kind)) {
      try {
        await settleAutonomyPlan(db, { planId: plan.id, status: 'failed', nowMs, error: 'capability-not-allowed' });
      } catch { /* 下一跳再收 */ }
      skipped.push({ planId: plan.id, reason: AUTONOMY_SKIP_REASONS.planCapability });
      continue;
    }

    if (isCancelableByUserSpeech(plan, args.lastUserMessageAt, { lastUserMessageRef })) {
      // 预扫已经把这些待办整体取消过；这里只兜「同一跳里读到的旧行」，不重复计数。
      skipped.push({ planId: plan.id, reason: 'user-spoke' });
      continue;
    }

    const [charUsedToday, lastSameKindAt, globalUsedToday, reservedTokens] = await Promise.all([
      countAutonomyPlansSince(db, charId, dayStart),
      lastAutonomyPlanOfKindAt(db, charId, plan.kind),
      getGlobalAutonomyUsage(db, { userId: args.userId, dateKey: globalDateKey }),
      sumReservedAutonomyTokensSince(db, charId, dayStart),
    ]);

    const budget = evaluateWorkflowBudget({
      nowMs,
      limits,
      usage: {
        charUsedToday,
        lastSameKindAt,
        globalUsedToday,
        reservedTokensToday: reservedTokens,
        // 计划侧的 token 门：既有回合已烧的账 + 本次及排队中未结算的预留。
        tokensToday,
        dailyTokenBudget: args.autonomous.dailyTokenBudget,
      },
    });
    if (!budget.allowed) {
      skipped.push({ planId: plan.id, reason: budgetSkipReason(budget.reason) });
      continue;
    }

    // 全局额度是共享持久化的一行：条件 +1 只有一方能拿到，绝不信任任何角色 body。
    const globalClaimed = await claimGlobalAutonomyBudget(db, {
      userId: args.userId, dateKey: globalDateKey, limit: limits.globalPerDay, nowMs,
    });
    if (!globalClaimed) {
      skipped.push({ planId: plan.id, reason: AUTONOMY_SKIP_REASONS.planGlobalLimit });
      continue;
    }

    const idempotencyKey = `plan:${plan.id}`;
    const runId = crypto.randomUUID();
    const reserved = await insertAutonomyPlanRun(db, {
      id: runId, planId: plan.id, charId,
      idempotencyKey, reservedTokens: limits.reserveTokensPerRun, nowMs,
    });
    if (!reserved) {
      await releaseGlobalAutonomyBudget(db, { userId: args.userId, dateKey: globalDateKey, nowMs });
      skipped.push({ planId: plan.id, reason: AUTONOMY_SKIP_REASONS.planNotPending });
      continue;
    }

    const claimed = await claimAutonomyPlanForSchedule(db, {
      planId: plan.id, nowMs, leaseMs: PLAN_SCHEDULE_LEASE_MS,
    });
    if (!claimed) {
      await releaseGlobalAutonomyBudget(db, { userId: args.userId, dateKey: globalDateKey, nowMs });
      await updateAutonomyPlanRun(db, { idempotencyKey, status: 'released', nowMs });
      skipped.push({ planId: plan.id, reason: AUTONOMY_SKIP_REASONS.planNotPending });
      continue;
    }

    try {
      await args.postTask({
        userId: args.userId,
        charId,
        charName: args.charName,
        pack: args.pack,
        plan: { ...plan, status: 'scheduled', scheduledAt: computedAt(plan, nowMs, args.lastUserMessageAt, args.pack.tzId) },
      });
      scheduled.push(plan.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await releaseGlobalAutonomyBudget(db, { userId: args.userId, dateKey: globalDateKey, nowMs });
      await updateAutonomyPlanRun(db, {
        idempotencyKey, status: isUnknownFailure(message) ? 'unknown' : 'failed', error: message, nowMs,
      });
      // unknown 是终态：绝不自动重试（总计划 review focus 第 2 条）。
      try {
        await settleAutonomyPlan(db, {
          planId: plan.id, status: isUnknownFailure(message) ? 'unknown' : 'failed', nowMs, error: message,
        });
      } catch (settleError) {
        console.warn('[amsg:autonomy] 计划收尾没写进去（不再重排，等人工/下一份新提议）', plan.id, settleError);
      }
      skipped.push({ planId: plan.id, reason: AUTONOMY_SKIP_REASONS.planPostFailed });
    }
  }

  return { scheduled, skipped, cancelled };
}

const computedAt = (
  plan: AutonomyPlanRecord,
  nowMs: number,
  lastUserMessageAt: number | null,
  tzId: string,
): number => {
  // 计划落库时已经算过 scheduledAt；这里只兜「老行没算过」的情况。
  if (plan.scheduledAt > 0) return plan.scheduledAt;
  return computeScheduledAt(
    { trigger: plan.trigger, createdAt: plan.createdAt },
    { nowMs, tzId, lastUserMessageAt },
  );
};

/**
 * 跑一跳。返回这一跳建了哪些角色、各自因为什么被跳过。
 *
 * 闸的顺序见 brief：开关 → configHash → cadence/间隔 → 当日轮数 → 静默段 → 推送冷却
 * → token 预算 → 熔断 → claim-first 建任务。
 */
export async function runAutonomyTick(input: AutonomyTickInput): Promise<AutonomyTickResult> {
  const { db, packs, postTask } = input;
  const rand = input.rand01 ?? Math.random;
  const built: string[] = [];
  const plansScheduled: string[] = [];
  const skipped: Array<{ charId: string; reason: string }> = [];
  // 同一跳里同一用户的共享护栏只读一次（D1 往返按 user 计，不按角色计）。
  const sharedGuardrailsByUser = new Map<string, AirpAutonomyGuardrails>();

  await ensureAutonomySchema(db);
  // 每跳顺手清一次过期经历（7 天）。清不掉只记日志：它是收尾活儿，不该拖垮这一跳。
  try {
    await cleanupAutonomyExperiences(db, input.nowMs - AUTONOMY_EXPERIENCE_TTL_MS);
  } catch (error) {
    console.warn('[amsg:autonomy] 过期经历没清掉（下一跳再试）', error);
  }

  for (const entry of packs) {
    const { charId, userId, charName, pack } = entry;
    const skip = (reason: string) => { skipped.push({ charId, reason }); };

    const autonomy = pack.autonomy;
    // 闸 1：开关与档位（L0 静默）。老 pack 没有 autonomy 段 = 自主功能没开过。
    if (!autonomy || autonomy.enabled !== true || autonomy.autonomyLevel < 1) {
      skip(AUTONOMY_SKIP_REASONS.disabled);
      continue;
    }

    // 闸 1.2：用户级总暂停（共享配置）。暂停是用户的主权闸，优先于凭据/推送等硬前置：
    // 用户已经喊停，这一跳连扫描后的判定都不该继续。
    // 扫描阶段已经确认「这个用户的护栏读不出来」：整跳暂停，不再补读默认值。
    if (entry.sharedGuardrailsUnreadable) {
      skip(AUTONOMY_SKIP_REASONS.guardrailsUnreadable);
      continue;
    }
    let sharedGuardrails = entry.sharedGuardrails ?? sharedGuardrailsByUser.get(userId);
    if (!sharedGuardrails) {
      const read = await readAutonomyGuardrailsForUserDetailed(db, input.masterKey ?? '', userId);
      if (read.status === 'unreadable') {
        // 手工喂包 / 老调用方没带护栏：读不出来同样 fail-closed，不按默认预算跑。
        console.warn('[amsg:autonomy] 这一跳读不出共享护栏，跳过这个用户', userId, read.error);
        skip(AUTONOMY_SKIP_REASONS.guardrailsUnreadable);
        continue;
      }
      sharedGuardrails = read.guardrails;
      sharedGuardrailsByUser.set(userId, sharedGuardrails);
    }
    if (sharedGuardrails.paused) {
      skip(AUTONOMY_SKIP_REASONS.paused);
      continue;
    }

    // 闸 1.5：到点硬前置（见上方核实段）。**必须在任何 state 写之前**：缺凭据行 /
    // 推送订阅时这条任务到点必被上游 409 拒掉，正确做法是这一跳整个跳过、一分账都不扣，
    // 而不是先清熔断 / 扣账再失败。查不到就是跳过，不写、不建、不烧预算。
    if (!(await hasAutonomyChatCredential(db, userId, charId))) {
      skip(AUTONOMY_SKIP_REASONS.missingCredentials);
      continue;
    }
    if (!(await hasAutonomyPushSubscription(db, userId))) {
      skip(AUTONOMY_SKIP_REASONS.missingPushSubscription);
      continue;
    }

    // P5：生活工作流队列（W3/W4）。跑在既有回合的 cadence 闸之前——计划有它自己的
    // 到点时间与预算，不该被「距上一轮多久」挡住；用户刚开口的情况会在队列内部取消。
    try {
      const planTick = await runAutonomyPlanQueue({
        db,
        userId,
        charId,
        charName,
        pack,
        nowMs: input.nowMs,
        lastUserMessageAt: typeof pack.lastUserMessageAt === 'number' ? pack.lastUserMessageAt : null,
        autonomous: autonomy,
        sharedGuardrails,
        postTask,
      });
      plansScheduled.push(...planTick.scheduled);
      for (const entry of planTick.skipped) {
        skipped.push({ charId, reason: entry.reason });
      }
    } catch (error) {
      // 计划队列坏掉不该拖垮既有回合：记一行，继续走下面的回合闸。
      console.warn('[amsg:autonomy] 生活工作流队列这一跳失败（回合照走）', charId, error);
    }

    const state = await getAutonomyState(db, charId);
    const configHash = autonomyConfigHash(autonomy);

    // 闸 2：configHash。用户动了设置 = 重新开始：清熔断并把新口径记下来。
    // 间隔、当日轮数、token 都不动——用户改的是 cadence/静默段，不是「今天还没跑过」。
    if (state.configHash !== configHash) {
      state.failStreak = 0;
      state.configHash = configHash;
      await setAutonomyState(db, state);
    }

    // 闸 3：cadence 先自查（minHours>0 且 min<=max），坏了就没有合法的「窗口」可言。
    const cadence = autonomy.cadence;
    if (!cadence || !(cadence.minHours > 0) || !(cadence.maxHours >= cadence.minHours)) {
      skip(AUTONOMY_SKIP_REASONS.cadenceInvalid);
      continue;
    }
    // 每个角色只消费一次随机数：窗口落在 [min, max] 小时之间。
    // P2 底线：单轮间隔不低于 resolveRoundIntervalMin（/home/config 快照缺失回退 30，
    // P5 接入配置源后自动生效）；spec §7 默认每角色每 30 分钟至多 1 轮。
    const windowMs = Math.max(
      (cadence.minHours + rand() * (cadence.maxHours - cadence.minHours)) * HOUR_MS,
      resolveRoundIntervalMin(null) * 60_000,
    );
    const lastUserMessageAt = pack.lastUserMessageAt;
    const userJustSpoke = typeof lastUserMessageAt === 'number'
      && input.nowMs - lastUserMessageAt <= windowMs;
    const roundDue = state.lastRoundAt === 0 || input.nowMs - state.lastRoundAt > windowMs;
    if (userJustSpoke || !roundDue) {
      skip(AUTONOMY_SKIP_REASONS.spacingWindow);
      continue;
    }

    // 时区读数（日期 key 与静默段都要）。非法 tzId = 数据坏了：跳过并留痕，不猜一个钟。
    let dateKey: string;
    let minutes: number;
    try {
      const parts = wallClockPartsInZone(input.nowMs, { tzId: pack.tzId });
      dateKey = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
      minutes = parts.hour * 60 + parts.minute;
    } catch {
      skip(AUTONOMY_SKIP_REASONS.tzInvalid);
      continue;
    }

    // 闸 4：当日轮数（按角色时区翻日）。
    if (state.roundsDate !== dateKey) {
      state.roundsDate = dateKey;
      state.roundsToday = 0;
    }
    if (state.roundsToday >= autonomy.maxRoundsPerDay) {
      skip(AUTONOMY_SKIP_REASONS.dailyLimit);
      continue;
    }

    // 闸 5：静默段（含跨夜）。
    if (autonomy.quietHours && inQuietHours(autonomy.quietHours, minutes)) {
      skip(AUTONOMY_SKIP_REASONS.quietHours);
      continue;
    }

    // P2 家策略底线：角色时区 00:00–07:00 只写事件不推送，单日 48 轮熔断。
    // 旧链闸口（配额/静默段）在前；roundsToday 用旧链当日计数（闸 4 已按角色时区翻日）。
    if (!shouldPushNow(minutes, state.roundsToday)) {
      skip(state.roundsToday >= 48 ? AUTONOMY_SKIP_REASONS.dailyLimit : AUTONOMY_SKIP_REASONS.quietHours);
      continue;
    }

    // 闸 6：推送冷却。没推过（0）或冷却为 0 都放行。
    const cooldownMinutes = autonomy.push?.cooldownMinutes ?? 0;
    if (state.lastPushAt > 0 && cooldownMinutes > 0 && input.nowMs - state.lastPushAt <= cooldownMinutes * 60_000) {
      skip(AUTONOMY_SKIP_REASONS.pushCooldown);
      continue;
    }

    // 闸 7：当日 token 预算（与当日轮数同一套翻日）。
    if (state.tokensDate !== dateKey) {
      state.tokensDate = dateKey;
      state.tokensToday = 0;
    }
    const budget = autonomy.dailyTokenBudget;
    if (typeof budget === 'number' && budget > 0 && state.tokensToday >= budget) {
      skip(AUTONOMY_SKIP_REASONS.tokenBudget);
      continue;
    }

    // 闸 8：熔断。
    if (state.failStreak >= AUTONOMY_FAIL_LIMIT) {
      skip(AUTONOMY_SKIP_REASONS.failMuted);
      continue;
    }

    // 闸 9：claim-first。扣账先落地，再建任务；建失败不回滚（见文件头）。
    state.lastRoundAt = input.nowMs;
    state.roundsToday += 1;
    state.roundsDate = dateKey;
    await setAutonomyState(db, state);
    try {
      await postTask({ userId, charId, charName, pack });
      built.push(charId);
    } catch (error) {
      console.warn('[amsg:autonomy] 建任务失败（不回滚，下一次到窗再试）', charId, error);
      skip(AUTONOMY_SKIP_REASONS.postFailed);
    }
  }

  return { built, plansScheduled, skipped };
}

// ─── 结果回账（Task 18 的 handler 调） ────────────────────────────────────

export interface AutonomyOutcome {
  ok: boolean;
  /** true = 这一轮其实什么都没做（上游把任务 skip 掉了）：`'skipped'` 不动账。 */
  skipped?: boolean;
  /** 这一轮烧掉的 token（成功才该传）。 */
  tokens?: number;
  /** 这一轮真的推出去了（记推送时间用）。 */
  pushed?: boolean;
}

/**
 * 一轮自主生活的结局回账（语义照 utils/vrWorld/scheduler.ts:215-227 的 VRScheduler）：
 * ok 清熔断、fail 累加（到 AUTONOMY_FAIL_LIMIT 就静默）、skipped 什么都不动。
 *
 * dateKey 必传：token 是「当日」口径，没有角色时区就没法翻日。调用方用
 * autonomyDateKey(nowMs, pack.tzId) 算好传进来。
 */
export async function reportAutonomyOutcome(
  charId: string,
  outcome: AutonomyOutcome,
  args: { db: AutonomyDb; dateKey: string; nowMs?: number },
): Promise<void> {
  if (outcome.skipped) return;
  await ensureAutonomySchema(args.db);

  const state = await getAutonomyState(args.db, charId);
  if (outcome.ok) state.failStreak = 0;
  else state.failStreak += 1;

  if (state.tokensDate !== args.dateKey) {
    state.tokensDate = args.dateKey;
    state.tokensToday = 0;
  }
  if (typeof outcome.tokens === 'number' && outcome.tokens > 0) {
    state.tokensToday += outcome.tokens;
  }
  if (outcome.pushed) state.lastPushAt = args.nowMs ?? Date.now();

  await setAutonomyState(args.db, state);
}

// ─── 自转发：组任务载荷 → 加密 → POST /schedule-message ───────────────────

/**
 * 转发的占位正文。上游要求 `messageType:'auto'` 必须带 completePrompt 或 messages 二选一，
 * 而真正发给 LLM 的 messages 由 kind handler 的返回值覆盖（upstream schedule-message
 * 校验只要求它形状合法）——所以这条内容永远不参与生成，跟客户端
 * activeMsgClient.ts:871 那个占位是同一个用途。
 */
export const AUTONOMY_PLACEHOLDER_PROMPT =
  'AMSG2_PLACEHOLDER_PROMPT（自主生活这一轮的提示词到点由 worker 的 autonomous_round handler 下发；看到这条说明 handler 没接上）';

/** 与 pushFanout.test.ts:29 同款：显式 ArrayBuffer 兜住 lib.dom 里 BufferSource 的窄化。 */
const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/**
 * 与库内 encryptPayload 逐字节相同的传输信封（AES-256-GCM、iv12 + tag16、base64）。
 * 包没有导出 encryptPayload（见文件头第 2 点），所以这里内联；格式与客户端一致。
 */
export const encryptPayloadMirror = async (
  payload: unknown,
  hexKey: string,
): Promise<{ iv: string; authTag: string; encryptedData: string }> => {
  const key = await crypto.subtle.importKey('raw', hexToBytes(hexKey), { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    new TextEncoder().encode(plaintext),
  ));
  return {
    iv: bytesToBase64(iv),
    authTag: bytesToBase64(sealed.slice(sealed.length - 16)),
    encryptedData: bytesToBase64(sealed.slice(0, sealed.length - 16)),
  };
};

/**
 * 照客户端 scheduleBackgroundJob（utils/activeMsgClient.ts:2463-2487）那份载荷口径组一条
 * `/schedule-message` 请求。上游按 `pathname.endsWith('/schedule-message')` 匹配路由，
 * 所以 cron 里没有挂载路径也能用（内部 URL 随便给一个 host）。
 */
export async function buildAutonomyScheduleRequest(args: {
  userId: string;
  charId: string;
  charName: string;
  masterKey: string;
  clientToken?: string;
  /** P5：这是一次生活工作流执行（不是普通自主回合）。 */
  plan?: AutonomyPlanRecord;
}): Promise<Request> {
  const charName = args.charName || args.charId;
  const planMeta: AutonomyPlanMeta | null = args.plan
    ? {
        planId: args.plan.id,
        kind: args.plan.kind,
        title: args.plan.title,
        purpose: args.plan.purpose,
        ...(args.plan.noteHint ? { noteHint: args.plan.noteHint } : {}),
        maxChars: args.plan.maxChars,
      }
    : null;
  const payload = {
    contactName: charName,
    messageType: 'auto',
    messageSubtype: AMSG_BACKGROUND_JOB_SUBTYPE,
    // 立刻可跑：到期时间由服务端自己盖（跟客户端那条路同一个理由——客户端算出来的
    // 时刻在路上就过去了，服务端一律打回「时间必须在未来」）。
    immediate: true,
    recurrenceType: 'none',
    // 自主经历这一轮的采样：显式 0.4 只动 temperature，top_p 全篇不出现（不动共享采样
    // 体系）。maxTokens = 理想长度 800 字 ×2（B2 的口径），留给 JSON 信封与收笔的余量。
    // 上游请求体的采样参数来自任务 payload（amsg-shared 的 buildLlmRequestBody）。
    temperature: 0.4,
    maxTokens: 1600,
    metadata: {
      charId: args.charId,
      charName,
      source: 'active_msg_2',
      [AMSG_TASK_KIND_KEY]: AUTONOMOUS_ROUND_KIND,
      // Task 18 不需要 amsg:job 的一次性输入（只读 fire_pack + autonomy 表），
      // 这个键照客户端口径带上，handler 不读它。
      [AMSG_JOB_ID_KEY]: crypto.randomUUID(),
      // P5：计划执行走同一种 kind（不新增 kind 就无需父集成改注册表），
      // 到点由 autonomyFire 读这个键转成一次独立的后台工作流请求。
      ...(planMeta ? { [AUTONOMY_PLAN_META_KEY]: planMeta } : {}),
    },
    credRefs: { chat: autonomyChatCredId(args.charId) },
    messages: [{ role: 'user', content: AUTONOMY_PLACEHOLDER_PROMPT }],
  };
  const envelope = await encryptPayloadMirror(
    payload,
    await deriveUserEncryptionKey(args.userId, args.masterKey),
  );
  const token = args.clientToken?.trim();
  return new Request('https://internal/schedule-message', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': args.userId,
      'X-Payload-Encrypted': 'true',
      'X-Encryption-Version': '1',
      ...(token ? { 'X-Client-Token': token } : {}),
    },
    body: JSON.stringify(envelope),
  });
}

/**
 * 生产用的 postTask：把请求交给上游 worker（index.ts 传 `upstream.fetch` 进来，测试吐 stub）。
 * 非 2xx 直接抛——调度器会把它记成 post-failed，账已经扣掉，下一次到窗再试。
 */
export const createAutonomyPostTask = (deps: {
  forward: (request: Request) => Promise<Response>;
  masterKey: string;
  clientToken?: string;
}): ((args: AutonomyPostTaskArgs) => Promise<{ status: number }>) =>
  async ({ userId, charId, charName, plan }) => {
    const request = await buildAutonomyScheduleRequest({
      userId,
      charId,
      charName,
      masterKey: deps.masterKey,
      clientToken: deps.clientToken,
      ...(plan ? { plan } : {}),
    });
    const response = await deps.forward(request);
    if (!response.ok) throw new Error(`schedule-message 拒绝（HTTP ${response.status}）`);
    return { status: response.status };
  };

export function quietHours(minutesOfDay: number): boolean {
  // 分钟数由调用方按角色时区算好传进来（wallClockPartsInZone），本函数不碰时区；
  // 口径复用调度主链的 inQuietHours，MVP 窗口 00:00–07:00。
  return inQuietHours({ start: '00:00', end: '07:00' }, minutesOfDay);
}
export function shouldPushNow(minutesOfDay: number, roundsToday: number): boolean {
  if (roundsToday >= 48) return false;
  if (quietHours(minutesOfDay)) return false;
  return true;
}
/** P2 频率可调：模拟器间隔分钟数读 /home/config，快照缺失回退 30，越界 clamp 到 5–120。 */
export function resolveRoundIntervalMin(cfg: { roundIntervalMin?: unknown } | null | undefined): number {
  const v = Number(cfg?.roundIntervalMin);
  if (!Number.isFinite(v)) return 30;
  return Math.min(120, Math.max(5, Math.floor(v)));
}
