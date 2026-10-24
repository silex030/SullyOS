/**
 * 旧自主频率配置 → 边界 v1 的单次迁移（autonomy-life-v1）。
 *
 * 迁移的立场（契约 §9）：
 *   - 用户设过的**上限、暂停、禁区**一律保留，宁可更严；
 *   - 旧的「频率/周期/同类冷却/活跃度」在新版里没有对应字段，**直接退役**，
 *     不翻译成新的频率数字（那等于让旧设置偷偷决定新节奏）；
 *   - 旧的「一轮」可能包含多次模型请求，新口径按**调用**计数更严格，所以 K2 取 min 后
 *     不允许上调，并在 notes 里写明口径变化；
 *   - 迁移是幂等条件写入：已迁移过就原样返回现边界，不恢复旧开关、不清空预算；
 *   - 旧 LLM 定时器在这一步标记停用（真正的停用由执行门接管，见 notes）。
 */

import {
  AUTONOMY_LIFE_SCHEMA_VERSION,
  CURRENCY_DEFAULT,
  DEFAULT_ACCOUNT_LIMITS,
  MAXIMUM_ACCOUNT_LIMITS,
  PLATFORM_FORBIDDEN_CATEGORIES,
  type BoundaryV1,
  type DoNotDisturb,
  type LimitKey,
} from '../../contracts/autonomyLife';
import { normalizeBoundary } from './boundary';
import { hhmmToMinutes, normalizeTimeZone } from './time';

export const LEGACY_MIGRATION_VERSION = 'autonomy-life-v1';

/** 旧版 UI 里出现过的、迁移后必须失效的定时器/链路。 */
export const RETIRED_LEGACY_TIMERS = [
  'autonomy_round_llm_timer',
  'phone_autorefresh_interval',
  'vr_auto_login_generation',
  'world_home_llm_tick',
] as const;

export interface LegacyAutonomyConfig {
  enabled?: boolean;
  autonomyLevel?: number;
  paused?: boolean;
  cadence?: { minHours?: number; maxHours?: number };
  templateId?: string;
  maxRoundsPerDay?: number;
  perCharPerDay?: number;
  globalPerDay?: number;
  sameKindMinGapMinutes?: number;
  reserveTokensPerRun?: number;
  dailyTokenBudget?: number;
  quietHours?: { start?: string; end?: string };
  push?: { mode?: string; maxPerDay?: number; cooldownMinutes?: number };
  interests?: string[];
  avoidTopics?: string[];
  calendarSyncEnabled?: boolean;
  xhsCredentialsPresent?: boolean;
  mapQuotaPerDay?: number;
}

export interface MigrationInput {
  nowMs: number;
  timezone: string;
  legacy: unknown;
  /** 已存在边界（非 null）= 已经迁移过；原样返回，不动预算/开关。 */
  existingBoundary?: BoundaryV1 | null;
}

export interface MigrationResult {
  migrationVersion: typeof LEGACY_MIGRATION_VERSION;
  alreadyMigrated: boolean;
  boundary: BoundaryV1;
  /** 只读旧快照（保留 revision 与 migratedAt），可回滚 UI 读取，不参与调度。 */
  legacySnapshot: {
    readOnly: true;
    capturedAt: number;
    revision: number;
    raw: LegacyAutonomyConfig;
  } | null;
  notes: string[];
  retiredTimers: readonly string[];
  /** 升级后旧客户端必须被拒（服务端返回 426）。 */
  requiresClientUpgrade: true;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const intOrUndefined = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : undefined;

const minDefined = (values: Array<number | undefined>): number | undefined => {
  const list = values.filter((value): value is number => typeof value === 'number');
  return list.length ? Math.min(...list) : undefined;
};

const clampLimit = (key: LimitKey, value: number | undefined): number | undefined => {
  if (value === undefined) return undefined;
  // 只能更严：旧值比结构天花板还大就夹到天花板，不因为「迁移」而放宽。
  return Math.min(value, MAXIMUM_ACCOUNT_LIMITS[key]);
};

function legacyQuietHours(raw: unknown, timezone: string): DoNotDisturb | null {
  if (!isRecord(raw)) return null;
  const start = typeof raw.start === 'string' ? raw.start.trim() : '';
  const end = typeof raw.end === 'string' ? raw.end.trim() : '';
  if (hhmmToMinutes(start) === null || hhmmToMinutes(end) === null) return null;
  if (start === end) return null;
  return { timezone: normalizeTimeZone(timezone), start, end };
}

export function migrateLegacyAutonomyConfig(input: MigrationInput): MigrationResult {
  const legacyRaw = isRecord(input.legacy) ? (input.legacy as LegacyAutonomyConfig) : {};
  const notes: string[] = ['不再采用固定冷却/周期设置；行动时机由人设与情境决定。'];

  if (input.existingBoundary) {
    // 幂等：已经迁移过，什么都不改（尤其不恢复旧开关、不清空预算）。
    return {
      migrationVersion: LEGACY_MIGRATION_VERSION,
      alreadyMigrated: true,
      boundary: input.existingBoundary,
      legacySnapshot: null,
      notes: ['迁移已执行过，保留当前边界（未恢复旧开关、未清空预算）。'],
      retiredTimers: RETIRED_LEGACY_TIMERS,
      requiresClientUpgrade: true,
    };
  }

  // K2：perCharPerDay / maxRoundsPerDay → 角色每日调用上限，取更严者。
  const legacyCharPerDay = minDefined([intOrUndefined(legacyRaw.perCharPerDay), intOrUndefined(legacyRaw.maxRoundsPerDay)]);
  const charCalls = clampLimit('charModelCallsPerDay', legacyCharPerDay);
  if (legacyCharPerDay !== undefined) {
    notes.push(
      `角色每日次数：旧值 ${legacyCharPerDay} 轮 → 新上限 ${charCalls} 次调用；`
      + '新口径按调用计（一轮可能多次请求），因此更严格，未上调。',
    );
  }

  // K4：globalPerDay → 账号每日调用上限。
  const legacyGlobal = intOrUndefined(legacyRaw.globalPerDay);
  const accountCalls = clampLimit('accountModelCallsPerDay', legacyGlobal);
  if (legacyGlobal !== undefined) {
    notes.push(`账号每日次数：旧值 ${legacyGlobal} → 新上限 ${accountCalls} 次调用。`);
  }

  // K8：token 预算取更严有效值。
  const legacyTokens = intOrUndefined(legacyRaw.dailyTokenBudget);
  const accountTokens = clampLimit('accountTokensPerDay', legacyTokens);
  if (legacyTokens !== undefined) {
    notes.push(`每日 token：旧值 ${legacyTokens} 保留为账号上限（云端已用/预留不清零）。`);
  }

  // K7：通知条数作为上限保留；推送冷却内部化。
  const legacyPush = isRecord(legacyRaw.push) ? legacyRaw.push : {};
  const legacyNotifs = intOrUndefined(legacyPush.maxPerDay);
  const notifications = clampLimit('notificationsPerDay', legacyNotifs);
  if (legacyNotifs !== undefined) notes.push(`每日通知：旧上限 ${legacyNotifs} 保留；推送冷却改为内部节流。`);

  // K3 / K9：同类最小间隔与单次 token 预留退役为内部安全参数。
  if (legacyRaw.sameKindMinGapMinutes !== undefined) {
    notes.push('同类最小间隔设置已退役：系统内置冷却（日记 6h / 整理·记录 2h / 消息 1h）只读。');
  }
  if (legacyRaw.reserveTokensPerRun !== undefined) {
    notes.push('单次 token 预留已转为内部执行参数，不再由用户配置。');
  }
  // K1：模板只作为人格兴趣输入，不把模板次数当节奏目标。
  if (typeof legacyRaw.templateId === 'string' && legacyRaw.templateId) {
    notes.push(`旧模板「${legacyRaw.templateId}」不再提供次数目标，仅作为人设兴趣参考。`);
  }

  const limits: Record<string, number> = {};
  if (charCalls !== undefined) limits.charModelCallsPerDay = charCalls;
  if (accountCalls !== undefined) limits.accountModelCallsPerDay = accountCalls;
  if (accountTokens !== undefined) limits.accountTokensPerDay = accountTokens;
  if (notifications !== undefined) limits.notificationsPerDay = notifications;

  const boundaryRaw = {
    // K5：开关/暂停原值保留，绝不因为升级而自动开启。
    enabled: typeof legacyRaw.enabled === 'boolean' ? legacyRaw.enabled : false,
    globalPaused: legacyRaw.paused === true,
    charEnabled: typeof legacyRaw.enabled === 'boolean' ? legacyRaw.enabled : false,
    timezone: input.timezone,
    // 首期只把已实现的核心窗口交给用户授权；外部窗口默认关闭（K14）。
    allowedKinds: [
      'journal.write', 'room.plan', 'room.note', 'phone.record',
      'takeout.order', 'shopping.order', 'interaction.message',
    ],
    forbiddenCategories: [],
    avoidTopics: Array.isArray(legacyRaw.avoidTopics)
      ? legacyRaw.avoidTopics.filter((t): t is string => typeof t === 'string')
      : [],
    allowFictionalNpc: false,
    // K6：静默段保留为用户免打扰边界（不拿它硬造角色睡眠）。
    doNotDisturb: legacyQuietHours(legacyRaw.quietHours, input.timezone),
    limits,
    // K14：旧小红书凭据不等于自主授权。
    externalGrants: [],
  };

  if (legacyRaw.xhsCredentialsPresent === true) {
    notes.push('旧小红书凭据不等于外部只读授权：外部读取仍为关闭，需要单独授予只读权限。');
  }
  if (intOrUndefined(legacyRaw.mapQuotaPerDay) !== undefined) {
    notes.push('地图每日额度保留，并叠加统一模型预算（地图请求另记 provider 配额，不豁免模型预算）。');
  }
  if (legacyRaw.autonomyLevel !== undefined) {
    notes.push('旧自主档位（autonomyLevel）不再是执行参数：权限只按允许能力 ∩ 用户授权 ∩ 旧有效权限取交集。');
  }
  if (legacyRaw.cadence) notes.push('旧周期（minHours/maxHours）已删除，不再参与调度。');

  const boundary = normalizeBoundary(boundaryRaw, { scope: 'account', nowMs: input.nowMs, revision: 1 });
  // 平台硬禁写进边界：用户在新 UI 里能看到「赌博/真实金融」是不可关闭的。
  boundary.forbiddenCategories = Array.from(new Set([
    ...PLATFORM_FORBIDDEN_CATEGORIES,
    ...boundary.forbiddenCategories,
  ]));
  // 迁移出来的账号层必须给出明确数字（不能留 null 继承空值）。
  for (const key of Object.keys(DEFAULT_ACCOUNT_LIMITS) as LimitKey[]) {
    const value = boundary.limits[key];
    if (value === null) boundary.limits[key] = DEFAULT_ACCOUNT_LIMITS[key];
  }
  boundary.schemaVersion = AUTONOMY_LIFE_SCHEMA_VERSION;

  return {
    migrationVersion: LEGACY_MIGRATION_VERSION,
    alreadyMigrated: false,
    boundary,
    legacySnapshot: {
      readOnly: true,
      capturedAt: input.nowMs,
      revision: 1,
      raw: { ...legacyRaw },
    },
    notes,
    retiredTimers: RETIRED_LEGACY_TIMERS,
    requiresClientUpgrade: true,
  };
}

/** 迁移后写进「回滚说明」的固定文案（UI 展示用）。 */
export const MIGRATION_SUMMARY = {
  version: LEGACY_MIGRATION_VERSION,
  currency: CURRENCY_DEFAULT,
  rollback: '回滚只恢复兼容 UI 与读接口，不重启旧定时器、不回滚预算/付款账。',
} as const;
