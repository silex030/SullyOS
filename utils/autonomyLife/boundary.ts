/**
 * 边界 v1：归一化、账号/角色层归并、patch 校验。
 *
 * 用户只定边界：允许的活动、调用/token/通知上限、禁止方向、免打扰、外部只读授权。
 * 这里刻意**不认识**频率字段（cadence / perCharPerDay / sameKindMinGap / templateId …）：
 * 带这些键的 PATCH 一律 DEPRECATED_FIELD，旧配置的迁移在 ./migration.ts 里做，不在
 * 边界层偷偷翻译成新数字（否则页面改一下就把旧的更严预算放宽了）。
 */

import {
  ACTIVITY_KINDS,
  AUTONOMY_LIFE_SCHEMA_VERSION,
  CURRENCY_DEFAULT,
  DEFAULT_ACCOUNT_LIMITS,
  DEPRECATED_BOUNDARY_FIELDS,
  LIMIT_KEYS,
  MAXIMUM_ACCOUNT_LIMITS,
  PLATFORM_FORBIDDEN_CATEGORIES,
  type ActivityKind,
  type AutonomyLimits,
  type BoundaryScope,
  type BoundaryV1,
  type DoNotDisturb,
  type EffectiveBoundaryV1,
  type ExternalGrant,
  type LimitKey,
} from '../../contracts/autonomyLife';
import { hhmmToMinutes, normalizeTimeZone } from './time';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** 非负整数：0 保真（0 = 明确禁止），非法值 → null（= 继承/缺省）。 */
const nonNegativeIntOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null;
  return value;
};

const stringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
};

const kindList = (value: unknown): ActivityKind[] | null => {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const out: ActivityKind[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    if (!(ACTIVITY_KINDS as readonly string[]).includes(item)) continue; // 未实现的能力不能被授权
    const kind = item as ActivityKind;
    if (!out.includes(kind)) out.push(kind);
  }
  return out;
};

function normalizeLimits(raw: unknown, scope: BoundaryScope): AutonomyLimits {
  const source = isRecord(raw) ? raw : {};
  const limits = {} as AutonomyLimits;
  for (const key of LIMIT_KEYS) {
    const rawValue = nonNegativeIntOrNull(source[key]);
    if (scope === 'account') {
      // 账号层不允许 null（null 只用于角色层继承），缺省取既有护栏的更严终值。
      limits[key] = rawValue === null ? DEFAULT_ACCOUNT_LIMITS[key] : clamp(rawValue, 0, MAXIMUM_ACCOUNT_LIMITS[key]);
    } else {
      limits[key] = rawValue === null ? null : clamp(rawValue, 0, MAXIMUM_ACCOUNT_LIMITS[key]);
    }
  }
  return limits;
}

function normalizeDnd(raw: unknown): DoNotDisturb | null {
  if (!isRecord(raw)) return null;
  const start = typeof raw.start === 'string' ? raw.start.trim() : '';
  const end = typeof raw.end === 'string' ? raw.end.trim() : '';
  if (hhmmToMinutes(start) === null || hhmmToMinutes(end) === null) return null;
  return { timezone: normalizeTimeZone(typeof raw.timezone === 'string' ? raw.timezone : null), start, end };
}

function normalizeGrant(raw: unknown, nowMs: number): ExternalGrant | null {
  if (!isRecord(raw)) return null;
  const provider = raw.provider;
  if (provider !== 'xhs' && provider !== 'amap') return null;
  const scopes = stringList(raw.scopes);
  // 只读才是首期允许的；出现 write/publish/comment 之类直接整条丢弃（fail closed）。
  const writeLike = /write|publish|post|comment|like|collect|dm|message|delete|update/i;
  if (!scopes.length || scopes.some((scope) => writeLike.test(scope))) return null;
  const expiresAt = typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt) ? raw.expiresAt : 0;
  if (expiresAt <= nowMs) return null;
  const dailyQuota = nonNegativeIntOrNull(raw.dailyQuota);
  return {
    provider,
    scopes,
    allowedHosts: stringList(raw.allowedHosts),
    allowedMethods: stringList(raw.allowedMethods).map((m) => m.toUpperCase()),
    allowedFieldKeys: stringList(raw.allowedFieldKeys),
    purpose: typeof raw.purpose === 'string' ? raw.purpose.slice(0, 200) : '',
    expiresAt,
    dailyQuota: dailyQuota === null ? 0 : dailyQuota,
  };
}

/** 任意来源（D1 行、导入备份、UI 请求）→ 完整合法边界。任何输入都不抛。 */
export function normalizeBoundary(
  raw: unknown,
  opts: { scope: BoundaryScope; nowMs: number; revision?: number },
): BoundaryV1 {
  const source = isRecord(raw) ? raw : {};
  const scope = opts.scope;
  const boolOrNull = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
  return {
    schemaVersion: AUTONOMY_LIFE_SCHEMA_VERSION,
    revision: typeof opts.revision === 'number' ? opts.revision : 0,
    scope,
    enabled: boolOrNull(source.enabled),
    globalPaused: scope === 'account' ? boolOrNull(source.globalPaused) : null,
    charEnabled: boolOrNull(source.charEnabled),
    timezone: typeof source.timezone === 'string' ? normalizeTimeZone(source.timezone) : null,
    allowedKinds: kindList(source.allowedKinds),
    forbiddenCategories: stringList(source.forbiddenCategories),
    avoidTopics: stringList(source.avoidTopics).slice(0, 50),
    allowFictionalNpc: boolOrNull(source.allowFictionalNpc),
    doNotDisturb: normalizeDnd(source.doNotDisturb),
    limits: normalizeLimits(source.limits, scope),
    externalGrants: Array.isArray(source.externalGrants)
      ? source.externalGrants
          .map((grant) => normalizeGrant(grant, opts.nowMs))
          .filter((grant): grant is ExternalGrant => grant !== null)
      : [],
  };
}

/**
 * 账号层 + 角色层 → 生效边界。
 *
 * 合并规则（只能更严，绝不因为某一层没填而放宽）：
 *   - 布尔：角色层 null 继承账号层；
 *   - limits：角色层 null 继承账号层；两边都有取 min；
 *   - allowedKinds：角色层缺席 = 继承账号白名单；两边都有取交集；
 *   - forbiddenCategories：并集（含平台硬禁，用户改不掉）；
 *   - externalGrants：只有账号层能给（角色层外部授权一律忽略）；
 *   - doNotDisturb / timezone：角色层优先，缺省继承账号层。
 */
export function mergeEffectiveBoundary(args: {
  account: BoundaryV1;
  character?: BoundaryV1 | null;
  charId: string;
  nowMs: number;
}): EffectiveBoundaryV1 {
  const account = args.account.scope === 'account'
    ? args.account
    : normalizeBoundary(args.account, { scope: 'account', nowMs: args.nowMs, revision: args.account.revision });
  const character = args.character ?? null;
  // 开关只能「更严」：账号层已经关掉时，角色层不能自己打开（否则等于绕过总开关）。
  const stricterOff = (charValue: boolean | null | undefined, accountValue: boolean | null | undefined): boolean => {
    if (charValue === false || accountValue === false) return false;
    if (typeof charValue === 'boolean') return charValue;
    return accountValue ?? true;
  };

  const limits = {} as AutonomyLimits;
  for (const key of LIMIT_KEYS) {
    const accountValue = account.limits[key];
    const base = accountValue === null ? DEFAULT_ACCOUNT_LIMITS[key as LimitKey] : accountValue;
    const charValue = character ? character.limits[key] : null;
    limits[key] = charValue === null || charValue === undefined ? base : Math.min(base, charValue);
  }

  const accountKinds = account.allowedKinds;
  const charKinds = character?.allowedKinds ?? null;
  let allowedKinds: ActivityKind[];
  if (accountKinds && charKinds) allowedKinds = accountKinds.filter((kind) => charKinds.includes(kind));
  else allowedKinds = accountKinds ?? charKinds ?? [...ACTIVITY_KINDS];

  const forbidden = new Set<string>(PLATFORM_FORBIDDEN_CATEGORIES);
  for (const item of account.forbiddenCategories) forbidden.add(item);
  for (const item of character?.forbiddenCategories ?? []) forbidden.add(item);

  const avoidTopics = Array.from(new Set([...account.avoidTopics, ...(character?.avoidTopics ?? [])]));

  return {
    schemaVersion: AUTONOMY_LIFE_SCHEMA_VERSION,
    revision: Math.max(account.revision, character?.revision ?? 0),
    // 原始两层 revision：许可条件更新用它发现并发撤销/改限额（不是取 max）。
    accountRevision: account.revision,
    characterRevision: character?.revision ?? null,
    scope: 'account',
    enabled: stricterOff(character?.enabled, account.enabled),
    globalPaused: account.globalPaused ?? false,
    charEnabled: stricterOff(character?.charEnabled, account.charEnabled),
    timezone: character?.timezone ?? account.timezone ?? 'UTC',
    allowedKinds,
    forbiddenCategories: Array.from(forbidden),
    avoidTopics,
    allowFictionalNpc: (() => {
      const charValue = character?.allowFictionalNpc ?? null;
      const accountValue = account.allowFictionalNpc;
      // 许可类开关：任何一层说 false 就是 false；两层都没明确给 → 默认不许。
      if (charValue === false || accountValue === false) return false;
      if (typeof charValue === 'boolean') return charValue;
      return accountValue ?? false;
    })(),
    doNotDisturb: character?.doNotDisturb ?? account.doNotDisturb ?? null,
    limits,
    externalGrants: account.externalGrants,
  };
}

export type BoundaryPatchErrorCode = 'DEPRECATED_FIELD' | 'REVISION_CONFLICT' | 'VALIDATION_FAILED';

export type BoundaryPatchResult =
  | { ok: true; boundary: BoundaryV1 }
  | { ok: false; code: BoundaryPatchErrorCode; details?: Record<string, unknown> };

/** 旧频率字段：出现就是 422，且列出具体键，前端据此把这几个输入框删掉。 */
export function findDeprecatedFields(changes: unknown): string[] {
  if (!isRecord(changes)) return [];
  const hits: string[] = [];
  for (const key of Object.keys(changes)) {
    if ((DEPRECATED_BOUNDARY_FIELDS as readonly string[]).includes(key)) hits.push(key);
  }
  if (isRecord(changes.limits)) {
    for (const key of Object.keys(changes.limits)) {
      if ((DEPRECATED_BOUNDARY_FIELDS as readonly string[]).includes(key)) hits.push(`limits.${key}`);
    }
  }
  return hits;
}

/**
 * PATCH /boundaries：CAS（expectedRevision）+ 旧字段拒绝 + 归并。
 * 不认识的键直接 VALIDATION_FAILED（body 不允许额外字段——免得有人偷偷塞 frequency 的变体）。
 */
export function applyBoundaryPatch(args: {
  current: BoundaryV1;
  changes: unknown;
  expectedRevision: number;
  nowMs: number;
}): BoundaryPatchResult {
  const { current, changes, expectedRevision, nowMs } = args;
  if (current.revision !== expectedRevision) {
    return { ok: false, code: 'REVISION_CONFLICT', details: { currentRevision: current.revision } };
  }
  const deprecated = findDeprecatedFields(changes);
  if (deprecated.length) {
    return { ok: false, code: 'DEPRECATED_FIELD', details: { fields: deprecated } };
  }
  if (!isRecord(changes)) return { ok: false, code: 'VALIDATION_FAILED', details: { reason: 'not-object' } };

  const allowedKeys = new Set([
    'enabled', 'globalPaused', 'charEnabled', 'timezone', 'allowedKinds',
    'forbiddenCategories', 'avoidTopics', 'allowFictionalNpc', 'doNotDisturb',
    'limits', 'externalGrants',
  ]);
  const unknownKeys = Object.keys(changes).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) {
    return { ok: false, code: 'VALIDATION_FAILED', details: { fields: unknownKeys } };
  }
  if (isRecord(changes.limits)) {
    const badLimitKeys = Object.keys(changes.limits).filter((key) => !(LIMIT_KEYS as readonly string[]).includes(key));
    if (badLimitKeys.length) {
      return { ok: false, code: 'VALIDATION_FAILED', details: { fields: badLimitKeys.map((k) => `limits.${k}`) } };
    }
  }

  const merged: Record<string, unknown> = {
    enabled: current.enabled,
    globalPaused: current.globalPaused,
    charEnabled: current.charEnabled,
    timezone: current.timezone,
    allowedKinds: current.allowedKinds,
    forbiddenCategories: current.forbiddenCategories,
    avoidTopics: current.avoidTopics,
    allowFictionalNpc: current.allowFictionalNpc,
    doNotDisturb: current.doNotDisturb,
    limits: { ...current.limits },
    externalGrants: current.externalGrants,
  };
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'limits' && isRecord(value)) {
      // 角色层可以显式 null 表示「继承」，账号层的 null 会被归成默认值。
      Object.assign(merged.limits as Record<string, unknown>, value);
      continue;
    }
    merged[key] = value;
  }

  const next = normalizeBoundary(merged, {
    scope: current.scope,
    nowMs,
    revision: current.revision + 1,
  });
  // 平台硬禁不能借 patch 删掉：normalizeBoundary 只清洗格式，这里再强制并集。
  next.forbiddenCategories = Array.from(new Set([...PLATFORM_FORBIDDEN_CATEGORIES, ...next.forbiddenCategories]));
  return { ok: true, boundary: next };
}

/** UI 只读的 defaults / maximums 元数据。 */
export function boundaryMetadata(): {
  defaults: Record<LimitKey, number>;
  maximums: Record<LimitKey, number>;
  currency: string;
  deprecatedFields: readonly string[];
  platformForbiddenCategories: readonly string[];
} {
  return {
    defaults: { ...DEFAULT_ACCOUNT_LIMITS },
    maximums: { ...MAXIMUM_ACCOUNT_LIMITS },
    currency: CURRENCY_DEFAULT,
    deprecatedFields: DEPRECATED_BOUNDARY_FIELDS,
    platformForbiddenCategories: PLATFORM_FORBIDDEN_CATEGORIES,
  };
}

/** 能力是否被用户授予（allowedKinds 只表示「允许」，可执行性还要过 adapter 探测）。 */
export function isKindAllowed(effective: EffectiveBoundaryV1, kind: ActivityKind): boolean {
  return effective.allowedKinds.includes(kind);
}

/** 暂停/开关的合并判定：总暂停与角色开关都算硬闸，但原因分开报。 */
export function boundaryGate(
  effective: EffectiveBoundaryV1,
  kind: ActivityKind,
): { ok: true } | { ok: false; code: 'GLOBAL_PAUSED' | 'CHAR_DISABLED' | 'POLICY_DENIED' } {
  if (effective.globalPaused || effective.enabled === false) return { ok: false, code: 'GLOBAL_PAUSED' };
  if (effective.charEnabled === false) return { ok: false, code: 'CHAR_DISABLED' };
  if (!isKindAllowed(effective, kind)) return { ok: false, code: 'POLICY_DENIED' };
  return { ok: true };
}
