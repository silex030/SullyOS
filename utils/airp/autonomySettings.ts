/**
 * 自主背景生活（autonomy）设置的归并叶子。
 *
 * 角色持久化的那份是「模板 id + 与模板的 diff（overrides）」，执行层（前端面板、
 * worker 调度器）只认这里 merge 出来的终值——模板只增数据不增执行分支，worker 读
 * fire_pack 里已经反归一化的终值，绝不去读 char.airp。
 *
 * 纯叶子：只 import 类型（./types 与 ./settings 的配置类型，编译期擦除），无运行时依赖，
 * 也不会被 settings.ts 反向 import（配置类型定义在 settings.ts 里），没有环。
 */

import type { AirpAutonomyLevel } from './types';
import { resolveAirpCapabilityPolicy, type AirpCapabilityMode } from './settings';
import {
  readCharAutonomyGuardrails,
  type AirpAutonomyGuardrails,
} from './autonomyGuardrails';
import type {
  AirpAutonomyConfig,
  AirpAutonomyOverrides,
  AirpAutonomyTemplateId,
  AirpSettings,
  RetellStyle,
} from './settings';

// 配置类型是设置契约的一部分，定义在 settings.ts（AirpSettings.autonomy 的宿主）。
// 这里原样转出去，调用方从本模块或 ./settings 取都行。
export type {
  AirpAutonomyConfig,
  AirpAutonomyOverrides,
  AirpAutonomyTemplateId,
  RetellStyle,
} from './settings';

// 护栏归并在独立叶子里（P5）；这里只把它挂进自主设置终值，转出类型方便前端直接用。
export type { AirpAutonomyGuardrails } from './autonomyGuardrails';

/** token 预算的常量兜底：模板与覆盖都没给时用它。 */
export const AUTONOMY_DAILY_TOKEN_BUDGET = 100_000;

// ─── 自主生活用到的任务种类名（worker 注册表与客户端排任务共用这份字面量） ───

/** 一轮自主生活的任务种类（写在 metadata 的 amsgKind 上，见 utils/amsgTaskKinds.ts）。 */
export const AUTONOMOUS_ROUND_KIND = 'autonomous_round';

/** 一轮自主生活的结果种类（`emitResult` 的 resultKind，客户端按它分流）。 */
export const AUTONOMY_RESULT_KIND = 'autonomy_result';

const DEFAULT_AUTONOMY_LEVEL: AirpAutonomyLevel = 2;
const DEFAULT_CADENCE = { minHours: 2, maxHours: 4 };
const DEFAULT_MAX_ROUNDS_PER_DAY = 2;
const DEFAULT_RETELL = { style: 'plain' as RetellStyle, maxItems: 5, maxChars: 800, opener: false };
const DEFAULT_PUSH = { mode: 'big' as const, maxPerDay: 1, cooldownMinutes: 60 };

/**
 * 三套模板的预填。取值出自 plans/autonomy-round.md §2.1：
 *   night_player → 深夜玩家：2–4h、无静默段、转述 battle、push big/1、口语有画面；
 *   morning_brief → 情报早报：夜间静默把窗口推到清晨、转述 brief、push big/1；
 *   surf_share → 冲浪分享：3–5h、转述 casual、push off、随手写给自己的。
 * custom 不在这里（= 全空，由常量兜底）。
 */
export const AIRP_AUTONOMY_TEMPLATES: Record<
  Exclude<AirpAutonomyTemplateId, 'custom'>,
  AirpAutonomyOverrides
> = {
  night_player: {
    cadence: { minHours: 2, maxHours: 4 },
    retell: { style: 'battle', maxItems: 5, maxChars: 800, opener: true },
    push: { mode: 'big', maxPerDay: 1, cooldownMinutes: 60 },
    noteStyleHint: '口语、有画面感，像深夜随手记下的一条发现，别端着。',
  },
  morning_brief: {
    quietHours: { start: '23:00', end: '06:00' },
    retell: { style: 'brief', maxItems: 5, maxChars: 800 },
    push: { mode: 'big', maxPerDay: 1, cooldownMinutes: 60 },
  },
  surf_share: {
    cadence: { minHours: 3, maxHours: 5 },
    retell: { style: 'casual', maxItems: 5, maxChars: 800 },
    push: { mode: 'off', maxPerDay: 1, cooldownMinutes: 60 },
    noteStyleHint: '随手写给自己的，像刷到好玩的就存一下，不为谁交代。',
  },
};

/**
 * 归并后的终值：执行层唯一该读的东西。除设置终值外，还带一份反归一化运行时面
 * （autonomyLevel / mcpAllow / writable）——worker 只读 fire_pack，不读 char.airp。
 */
export interface ResolvedAirpAutonomy {
  /** 有效开关：airp.enabled && autonomy.enabled && autonomyLevel >= 1。 */
  enabled: boolean;
  cadence: { minHours: number; maxHours: number };
  quietHours?: { start: string; end: string };
  maxRoundsPerDay: number;
  interests: string[];
  avoidTopics: string[];
  retell: {
    style: RetellStyle; maxItems: number; maxChars: number;
    opener: boolean; customHint?: string;
  };
  push: { mode: 'off' | 'big'; maxPerDay: number; cooldownMinutes: number };
  noteStyleHint?: string;
  dailyTokenBudget: number;
  /** 反归一化的 AIRP 权限档位（worker 侧不再回读 char.airp）。 */
  autonomyLevel: AirpAutonomyLevel;
  /** 反归一化的 MCP 白名单。 */
  mcpAllow: string[];
  /** 反归一化的写入总闸。 */
  writable: boolean;
  capabilityMode?: AirpCapabilityMode;
  capabilities?: string[];
  /**
   * 自主生活护栏（P5）：每角色每日次数 / 同类最小间隔 / 单次 token 预留。
   * 全局额度与总暂停**不在这里说了算**——它们只认云端共享配置，调度器读到时覆盖
   * （见 utils/airp/autonomyGuardrails.ts 的 effectiveAutonomyGuardrails）。
   */
  guardrails: AirpAutonomyGuardrails;
}

/** 只接受普通对象；数组、null 与原始值一律视为无设置。 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** 正整数；0 视为非法（会回落默认）。 */
const toPositiveInt = (value: unknown): number | undefined => {
  const n = toFiniteNumber(value);
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
};

/** 非负有限数（冷却分钟允许 0 = 不冷却）。 */
const toNonNegativeNumber = (value: unknown): number | undefined => {
  const n = toFiniteNumber(value);
  return n !== undefined && n >= 0 ? n : undefined;
};

/** 空白字符串等同缺省；非字符串一律忽略。 */
const toTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/** 非数组 → 缺省（好让模板兜底）；数组 → 只留字符串条目。 */
const toStringArrayOrUndefined = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;

const toBooleanOrUndefined = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const toAutonomyLevel = (value: unknown): AirpAutonomyLevel =>
  value === 0 || value === 1 || value === 2 || value === 3 ? value : DEFAULT_AUTONOMY_LEVEL;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const toCadence = (value: unknown): { minHours: number; maxHours: number } | undefined => {
  if (!isRecord(value)) return undefined;
  const min = toFiniteNumber(value.minHours);
  const max = toFiniteNumber(value.maxHours);
  if (min === undefined || max === undefined || min > max) return undefined;
  return { minHours: min, maxHours: max };
};

/** 形状不对的静默段整块丢掉（不是只丢坏的那一头）。 */
const toQuietHours = (value: unknown): { start: string; end: string } | undefined => {
  if (!isRecord(value)) return undefined;
  const { start, end } = value;
  if (typeof start !== 'string' || typeof end !== 'string') return undefined;
  if (!HHMM.test(start) || !HHMM.test(end)) return undefined;
  return { start, end };
};

const RETELL_STYLES: readonly string[] =
  ['battle', 'brief', 'casual', 'coquettish', 'diary', 'teaser', 'plain', 'custom'];

const toRetellStyle = (value: unknown): RetellStyle | undefined =>
  typeof value === 'string' && RETELL_STYLES.includes(value) ? (value as RetellStyle) : undefined;

const toPushMode = (value: unknown): 'off' | 'big' | undefined =>
  value === 'off' || value === 'big' ? value : undefined;

/** 转述块逐子字段归并：覆盖 > 模板 > 常量兜底。 */
const mergeRetell = (overrideRaw: unknown, templateRaw: unknown): ResolvedAirpAutonomy['retell'] => {
  const override = isRecord(overrideRaw) ? overrideRaw : {};
  const template = isRecord(templateRaw) ? templateRaw : {};
  const customHint = toTrimmedString(override.customHint) ?? toTrimmedString(template.customHint);
  return {
    style: toRetellStyle(override.style) ?? toRetellStyle(template.style) ?? DEFAULT_RETELL.style,
    maxItems: toPositiveInt(override.maxItems)
      ?? toPositiveInt(template.maxItems) ?? DEFAULT_RETELL.maxItems,
    maxChars: toPositiveInt(override.maxChars)
      ?? toPositiveInt(template.maxChars) ?? DEFAULT_RETELL.maxChars,
    opener: toBooleanOrUndefined(override.opener)
      ?? toBooleanOrUndefined(template.opener) ?? DEFAULT_RETELL.opener,
    ...(customHint ? { customHint } : {}),
  };
};

/** 推送参数逐子字段归并：覆盖 > 模板 > 常量兜底。 */
const mergePush = (overrideRaw: unknown, templateRaw: unknown): ResolvedAirpAutonomy['push'] => {
  const override = isRecord(overrideRaw) ? overrideRaw : {};
  const template = isRecord(templateRaw) ? templateRaw : {};
  return {
    mode: toPushMode(override.mode) ?? toPushMode(template.mode) ?? DEFAULT_PUSH.mode,
    maxPerDay: toPositiveInt(override.maxPerDay)
      ?? toPositiveInt(template.maxPerDay) ?? DEFAULT_PUSH.maxPerDay,
    cooldownMinutes: toNonNegativeNumber(override.cooldownMinutes)
      ?? toNonNegativeNumber(template.cooldownMinutes) ?? DEFAULT_PUSH.cooldownMinutes,
  };
};

/**
 * 把角色持久化的自主设置（模板 id + diff）归并成一份完整、合法的终值。
 * 任何输入都不会抛错：非对象 → 全默认；对象 → 逐字段校验，非法字段各自回落
 * （覆盖 → 模板 → 常量默认三态）。
 */
export function mergeAutonomySettings(
  char: { airp?: AirpSettings } | null | undefined,
): ResolvedAirpAutonomy {
  const airpRaw: unknown = isRecord(char) ? char.airp : undefined;
  const airp = isRecord(airpRaw) ? airpRaw : {};
  const autonomy = isRecord(airp.autonomy) ? airp.autonomy : {};
  const overrides = isRecord(autonomy.overrides) ? autonomy.overrides : {};

  const templateId: AirpAutonomyTemplateId =
    autonomy.templateId === 'night_player' || autonomy.templateId === 'morning_brief'
    || autonomy.templateId === 'surf_share' || autonomy.templateId === 'custom'
      ? autonomy.templateId
      : 'custom';
  const template: AirpAutonomyOverrides =
    templateId === 'custom' ? {} : AIRP_AUTONOMY_TEMPLATES[templateId];

  const level = toAutonomyLevel(airp.autonomyLevel);

  const cadence = toCadence(overrides.cadence) ?? toCadence(template.cadence) ?? DEFAULT_CADENCE;
  // 显式 null = 「不要静默段」的哨兵：跳过模板兜底（undefined / 缺省才跟随模板）。
  const quietHours = overrides.quietHours === null
    ? undefined
    : toQuietHours(overrides.quietHours) ?? toQuietHours(template.quietHours);
  const maxRoundsPerDay = toPositiveInt(overrides.maxRoundsPerDay)
    ?? toPositiveInt(template.maxRoundsPerDay) ?? DEFAULT_MAX_ROUNDS_PER_DAY;
  // 显式给了数组（哪怕是空数组）就认它——空数组是「清掉模板预填」的合法表达。
  const interests = toStringArrayOrUndefined(overrides.interests)
    ?? toStringArrayOrUndefined(template.interests) ?? [];
  const avoidTopics = toStringArrayOrUndefined(overrides.avoidTopics)
    ?? toStringArrayOrUndefined(template.avoidTopics) ?? [];
  const noteStyleHint = toTrimmedString(overrides.noteStyleHint)
    ?? toTrimmedString(template.noteStyleHint);
  const dailyTokenBudget = toPositiveInt(overrides.dailyTokenBudget) ?? AUTONOMY_DAILY_TOKEN_BUDGET;

  return {
    // 三层语义各自独立：AIRP 总闸（master）× 自主功能开关（feature）× 权限档位（tier）。
    // 反归一化后 worker 只看这一个布尔，不必也没法回读 char.airp。
    enabled: airp.enabled === true && autonomy.enabled === true && level >= 1,
    cadence,
    ...(quietHours ? { quietHours } : {}),
    maxRoundsPerDay,
    interests,
    avoidTopics,
    retell: mergeRetell(overrides.retell, template.retell),
    push: mergePush(overrides.push, template.push),
    ...(noteStyleHint ? { noteStyleHint } : {}),
    dailyTokenBudget,
    autonomyLevel: level,
    mcpAllow: toStringArrayOrUndefined(airp.mcpAllow) ?? [],
    writable: airp.writable === true,
    capabilityMode: resolveAirpCapabilityPolicy(airp).mode,
    capabilities: resolveAirpCapabilityPolicy(airp).allow,
    guardrails: readCharAutonomyGuardrails(autonomy),
  };
}

/**
 * 打脏门用的廉价判定：AIRP 总闸开着、自主开关开着、且档位不低于 1（L0 静默）。
 * 与 mergeAutonomySettings(char).enabled 同义，共用一份定义免得两处漂移。
 */
export function isAutonomyActive(char: { airp?: AirpSettings } | null | undefined): boolean {
  return mergeAutonomySettings(char).enabled;
}
