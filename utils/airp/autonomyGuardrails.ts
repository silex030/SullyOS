/**
 * 自主生活护栏（P5 预算/暂停/次数）的纯契约叶子。
 *
 * 分工，别混：
 *   - 每角色上限（perCharPerDay / sameKindMinGapMinutes / reserveTokensPerRun）跟着角色设置走，
 *     由用户在前端改，随 fire_pack 下发（`ResolvedAirpAutonomy.guardrails`）。
 *   - 全局上限（globalPerDay）与总暂停（paused）是**用户级**的，存在云端一行共享配置里
 *     （client_state 的 `amsg:global/autonomy_guardrails`），由 worker 调度器直接读；
 *     **绝不从某个角色的 fire_pack 里取**——那等于让每个角色各自带一份「全局额度」，
 *     多角色时既不同步也不可信。
 *   - 模型输出永远不参与这里的任何字段：它只能提生活工作流提议，提议在 lifeWorkflow 里
 *     被降成固定白名单动作。
 *
 * 本文件是 worker bundle 会打进去的叶子：零浏览器依赖、零 React、零 fetch。
 */

/** 护栏配置结构版本（将来改形状时升）。 */
export const AUTONOMY_GUARDRAIL_VERSION = 1 as const;

export interface AirpAutonomyGuardrails {
  version: typeof AUTONOMY_GUARDRAIL_VERSION;
  /** 每角色每日最多执行几次生活工作流（默认 2）。 */
  perCharPerDay: number;
  /** 同一角色同一类动作的最小间隔分钟（默认 120 = 2h）。 */
  sameKindMinGapMinutes: number;
  /** 所有角色合计每天最多执行几次（默认 6）。只有共享配置这一份说了算。 */
  globalPerDay: number;
  /** 每次执行预留的 token（预算预留，不是实际消耗；结算时按实际改账）。 */
  reserveTokensPerRun: number;
  /** 用户级总暂停：true 时调度器不排任何自主生成（含既有回合）。 */
  paused: boolean;
}

/** 首版默认预算（plans/2026-10-22-interaction-cache-master-plan.md §P5）。 */
export const AUTONOMY_GUARDRAIL_DEFAULTS: AirpAutonomyGuardrails = {
  version: AUTONOMY_GUARDRAIL_VERSION,
  perCharPerDay: 2,
  sameKindMinGapMinutes: 120,
  globalPerDay: 6,
  reserveTokensPerRun: 1600,
  paused: false,
};

/**
 * 绝对天花板：前端可以自定义护栏，但不能把护栏改没。这些值是「再怎么配也不该超过」的
 * 结构性上限，不是产品建议值；真正生效的默认值见上。
 */
export const AUTONOMY_GUARDRAIL_CEILINGS = {
  perCharPerDay: 12,
  sameKindMinGapMinutes: 24 * 60,
  globalPerDay: 24,
  reserveTokensPerRun: 8000,
} as const;

/** 云端共享配置的位置（与 tool_config 同一个全局 namespace，不同 key）。 */
export const AUTONOMY_GUARDRAIL_STATE_NAMESPACE = 'amsg:global';
export const AUTONOMY_GUARDRAIL_STATE_KEY = 'autonomy_guardrails';

export interface AutonomyGuardrailStateEntry {
  namespace: string;
  key: string;
  value: string;
  updatedAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const positiveInt = (value: unknown, fallback: number, ceiling: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, ceiling);
};

/** 间隔允许 0（= 不设同类间隔），负值/非法回落默认。 */
const nonNegativeInt = (value: unknown, fallback: number, ceiling: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return fallback;
  }
  return Math.min(value, ceiling);
};

/**
 * 全局每日次数：0 = 用户级总暂停；负数按 0（更严的输入不能被放宽成默认 6）。
 * 只有「彻底不像数字」的值才回落默认，和角色级字段一致。
 */
const globalDailyLimit = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return AUTONOMY_GUARDRAIL_DEFAULTS.globalPerDay;
  }
  if (value <= 0) return 0;
  return Math.min(value, AUTONOMY_GUARDRAIL_CEILINGS.globalPerDay);
};

/**
 * 任意来源（角色设置里的 diff、云端共享行、导入备份）→ 完整合法护栏。
 * 任何输入都不抛：非法字段各自回落默认，越界值夹到天花板。
 */
export function normalizeAutonomyGuardrails(raw: unknown): AirpAutonomyGuardrails {
  if (!isRecord(raw)) return { ...AUTONOMY_GUARDRAIL_DEFAULTS };
  const globalPerDay = globalDailyLimit(raw.globalPerDay);
  return {
    version: AUTONOMY_GUARDRAIL_VERSION,
    // 0 = 明确禁止计划（不是「没填」）：必须保真传到 worker，再由预算门/认领口挡住。
    // 以前 `positiveInt` 把 0 折成默认值，用户「关到零」反而被放宽成 2/6 次。
    perCharPerDay: nonNegativeInt(
      raw.perCharPerDay,
      AUTONOMY_GUARDRAIL_DEFAULTS.perCharPerDay,
      AUTONOMY_GUARDRAIL_CEILINGS.perCharPerDay,
    ),
    sameKindMinGapMinutes: nonNegativeInt(
      raw.sameKindMinGapMinutes,
      AUTONOMY_GUARDRAIL_DEFAULTS.sameKindMinGapMinutes,
      AUTONOMY_GUARDRAIL_CEILINGS.sameKindMinGapMinutes,
    ),
    globalPerDay,
    reserveTokensPerRun: positiveInt(
      raw.reserveTokensPerRun,
      AUTONOMY_GUARDRAIL_DEFAULTS.reserveTokensPerRun,
      AUTONOMY_GUARDRAIL_CEILINGS.reserveTokensPerRun,
    ),
    // 全局 0 次/天就是总暂停；paused:false 盖不掉它，否则「关到零」会以默认 6 次继续跑。
    paused: raw.paused === true || globalPerDay === 0,
  };
}

/**
 * 逐字段合并：primary 里合法的字段优先，其余取 fallback。
 * 两个入参都可以是半截对象——先各自归一，再按「来源是否显式给了这个字段」挑。
 */
export function mergeAutonomyGuardrails(
  primary: unknown,
  fallback: unknown,
): AirpAutonomyGuardrails {
  const base = normalizeAutonomyGuardrails(fallback);
  if (!isRecord(primary)) return base;
  const overlay = normalizeAutonomyGuardrails({ ...base, ...primary });
  return overlay;
}

/**
 * 角色设置里的护栏 diff。读两处是为了兼容两种落点：
 *   autonomy.guardrails（新面板写这里）与 autonomy.overrides.guardrails（塞在模板 diff 里）。
 * 找不到就给默认值——旧角色/旧包的行为不变。
 */
export function readCharAutonomyGuardrails(autonomyRaw: unknown): AirpAutonomyGuardrails {
  if (!isRecord(autonomyRaw)) return { ...AUTONOMY_GUARDRAIL_DEFAULTS };
  const direct = autonomyRaw.guardrails;
  if (isRecord(direct)) return normalizeAutonomyGuardrails(direct);
  const overrides = autonomyRaw.overrides;
  if (isRecord(overrides) && isRecord(overrides.guardrails)) {
    return normalizeAutonomyGuardrails(overrides.guardrails);
  }
  return { ...AUTONOMY_GUARDRAIL_DEFAULTS };
}

/**
 * 最终生效值：每角色字段以 charLevel 为准；全局额度与总暂停只认共享配置。
 * 这样即使某个角色的包被改坏（或旧包残留），也放宽不了全局额度。
 */
export function effectiveAutonomyGuardrails(
  charLevel: AirpAutonomyGuardrails,
  shared: AirpAutonomyGuardrails,
): AirpAutonomyGuardrails {
  return {
    version: AUTONOMY_GUARDRAIL_VERSION,
    perCharPerDay: charLevel.perCharPerDay,
    sameKindMinGapMinutes: charLevel.sameKindMinGapMinutes,
    reserveTokensPerRun: charLevel.reserveTokensPerRun,
    globalPerDay: shared.globalPerDay,
    paused: shared.paused,
  };
}

/** 前端写云端共享配置时用的条目（走既有 putClientStateOrThrow，不新开端点）。 */
export function buildAutonomyGuardrailStateEntry(
  guardrails: unknown,
  updatedAt: number = Date.now(),
): AutonomyGuardrailStateEntry {
  return {
    namespace: AUTONOMY_GUARDRAIL_STATE_NAMESPACE,
    key: AUTONOMY_GUARDRAIL_STATE_KEY,
    value: JSON.stringify(normalizeAutonomyGuardrails(guardrails)),
    updatedAt,
  };
}

/** 云端读回来的 value（已解密、已解压的 JSON 字符串）→ 护栏；坏数据 null。 */
export function parseAutonomyGuardrailStateValue(raw: unknown): AirpAutonomyGuardrails | null {
  const read = readAutonomyGuardrailStateValue(raw);
  return read.kind === 'ok' ? read.value : null;
}

/**
 * 三态读取：**缺行** 与 **读坏** 必须分开。
 *
 * - `absent`：null / 空串——这一行确实不存在（新用户），调用方才可以落默认值；
 * - `invalid`：行在、但解不出合法对象（坏 JSON / 不是对象 / 解密后乱码）——
 *   调用方必须保持上次确认值，**不得**当成「未暂停 + 6 次/天」；
 * - `ok`：合法值（0 的语义按 normalize 处理）。
 */
export type AutonomyGuardrailStateRead =
  | { kind: 'ok'; value: AirpAutonomyGuardrails }
  | { kind: 'absent' }
  | { kind: 'invalid'; reason: 'not-json' | 'not-object' };

export function readAutonomyGuardrailStateValue(raw: unknown): AutonomyGuardrailStateRead {
  if (raw == null) return { kind: 'absent' };
  if (typeof raw !== 'string') return { kind: 'invalid', reason: 'not-object' };
  if (raw.trim().length === 0) return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', reason: 'not-json' };
  }
  if (!isRecord(parsed)) return { kind: 'invalid', reason: 'not-object' };
  return { kind: 'ok', value: normalizeAutonomyGuardrails(parsed) };
}

/** 两份护栏是否等价（乐观并发比对用；按归一化结果比较，不比较字符串格式）。 */
export function guardrailValuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalizeAutonomyGuardrails(a)) === JSON.stringify(normalizeAutonomyGuardrails(b));
}
