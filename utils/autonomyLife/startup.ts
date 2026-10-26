/**
 * 旧自主配置的**一次性退役**（真退役，不只是「登记一串名字」）
 *
 * 背景：以前迁移函数只把 `RETIRED_LEGACY_TIMERS` 写在返回值里，没人真的去停——
 * 于是「15/30/60/120 分钟自动刷新」「min/max 小时周期」这些旧链路还在跑。这里把
 * 退役真正做掉，并且只做一次：
 *
 *   1. 删掉旧定时器/设备的持久化键（`RETIRED_LEGACY_TIMERS`）；
 *   2. 清掉角色上的旧自动刷新字段（`phoneState.autoRefresh*`）——旧字段留着，
 *      旧 bundle 回来就又开了；
 *   3. 旧频率/周期**不翻译**成新边界数字；只按 `migrateLegacyAutonomyConfig` 的口径
 *      把「上限/暂停/禁区/免打扰」搬过来，allowedKinds 只做交集（不扩权）；
 *   4. 写一个 marker：之后再启动不再迁移（用户后来改的边界不会被旧配置盖回去）。
 *
 * 刻意不做的事：不恢复旧开关、不清空预算、不重启任何旧定时器、不覆盖已有边界
 * （账号边界 revision > 0 就当用户已经配置过）。
 */

import type { AutonomyLifeApi } from './api';
import { migrateLegacyAutonomyConfig, RETIRED_LEGACY_TIMERS } from './migration';

export const LEGACY_AUTONOMY_MIGRATION_MARKER = 'os_autonomy_life_migrated_v1';

/** 旧版护栏草稿（AutonomyPanel 时代缓存在 localStorage 的那一份）。 */
export const LEGACY_AUTONOMY_CONFIG_KEY = 'os_autonomy_guardrails';

export interface LegacyCharacterLike {
  id: string;
  /** 旧字段类型不确定（不同版本存过 bool/int），运行时按 record 收窄。 */
  phoneState?: unknown;
}

export interface LegacyRetirementOptions {
  api: AutonomyLifeApi;
  characters: readonly LegacyCharacterLike[];
  /** 落库单角色（通常是 DB.saveCharacter）。 */
  saveCharacter: (character: LegacyCharacterLike) => Promise<void>;
  /** 旧配置对象（默认从 LEGACY_AUTONOMY_CONFIG_KEY 读）。 */
  legacy?: unknown;
  legacyAllowedKinds?: readonly string[];
  timezone: string;
  storage?: Storage | null;
  now?: () => number;
}

export interface LegacyRetirementResult {
  /** 本轮是否真的写了边界（false = 已经迁移过 / 用户已配置 / 没东西可迁）。 */
  migrated: boolean;
  retiredTimerKeys: string[];
  strippedCharacters: string[];
  notes: string[];
  skippedReason?: 'already_migrated' | 'account_already_configured' | 'boundary_unavailable';
}

const safeStorage = (explicit?: Storage | null): Storage | null => {
  if (explicit !== undefined) return explicit;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
};

const readLegacyConfig = (storage: Storage | null, explicit: unknown): unknown => {
  if (explicit !== undefined) return explicit;
  if (!storage) return null;
  try {
    const raw = storage.getItem(LEGACY_AUTONOMY_CONFIG_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export async function retireLegacyAutonomyConfig(options: LegacyRetirementOptions): Promise<LegacyRetirementResult> {
  const storage = safeStorage(options.storage);
  const nowMs = (options.now ?? (() => Date.now()))();
  const retiredTimerKeys: string[] = [];
  const strippedCharacters: string[] = [];
  const notes: string[] = [];

  // 1) 旧定时器/设备键：能删就删（不存在的键删了也无害）。
  for (const key of RETIRED_LEGACY_TIMERS) {
    try {
      if (storage?.getItem(key) !== null && storage?.getItem(key) !== undefined) {
        storage.removeItem(key);
        retiredTimerKeys.push(key);
      }
    } catch {
      /* 私隐模式/配额：删不掉就算了，下面的 marker 仍然阻止旧链路被重新打开 */
    }
  }

  // 2) 角色上的旧自动刷新字段：不删就会跟着备份/旧 bundle 回来。
  for (const character of options.characters) {
    const phoneState = character.phoneState;
    if (!phoneState || typeof phoneState !== 'object' || Array.isArray(phoneState)) continue;
    const record = phoneState as Record<string, unknown>;
    const hasLegacy = 'autoRefresh' in record
      || 'autoRefreshIntervalMin' in record
      || 'lastAutoRefreshAt' in record;
    if (!hasLegacy) continue;
    const { autoRefresh: _a, autoRefreshIntervalMin: _b, lastAutoRefreshAt: _c, ...rest } = record;
    void _a; void _b; void _c;
    await options.saveCharacter({ ...character, phoneState: rest });
    strippedCharacters.push(character.id);
  }

  // 3) 已经迁移过 → 什么都不写（尤其不碰用户后来的边界）。
  let marker = '';
  try {
    marker = storage?.getItem(LEGACY_AUTONOMY_MIGRATION_MARKER) ?? '';
  } catch {
    marker = '';
  }
  if (marker) {
    notes.push('旧配置已在之前退役；本轮只清理残留字段，不改边界。');
    return { migrated: false, retiredTimerKeys, strippedCharacters, notes, skippedReason: 'already_migrated' };
  }

  // 4) 读账号边界：revision > 0 说明用户已经在新界面配置过，绝不覆盖。
  const current = await options.api.readBoundaries().catch(() => null);
  if (!current?.ok) {
    notes.push('读不到账号边界（未连上后台）：本轮不迁移，下次启动再试。');
    return { migrated: false, retiredTimerKeys, strippedCharacters, notes, skippedReason: 'boundary_unavailable' };
  }
  if (current.data.account.revision > 0) {
    try { storage?.setItem(LEGACY_AUTONOMY_MIGRATION_MARKER, String(nowMs)); } catch { /* ignore */ }
    notes.push('账号边界已存在（用户已配置过）：不覆盖，只记录迁移已完成。');
    return { migrated: false, retiredTimerKeys, strippedCharacters, notes, skippedReason: 'account_already_configured' };
  }

  const legacy = readLegacyConfig(storage, options.legacy);
  const migration = migrateLegacyAutonomyConfig({
    nowMs,
    timezone: options.timezone,
    legacy,
    legacyAllowedKinds: options.legacyAllowedKinds,
  });
  notes.push(...migration.notes);

  // 只提交边界允许的字段（不传 schemaVersion/revision/scope，PATCH 会拒未知键）。
  const { boundary } = migration;
  const written = await options.api.writeBoundaries({
    scope: 'account',
    expectedRevision: current.data.account.revision,
    changes: {
      enabled: boundary.enabled,
      globalPaused: boundary.globalPaused,
      charEnabled: boundary.charEnabled,
      timezone: boundary.timezone,
      allowedKinds: boundary.allowedKinds,
      forbiddenCategories: boundary.forbiddenCategories,
      avoidTopics: boundary.avoidTopics,
      allowFictionalNpc: boundary.allowFictionalNpc,
      doNotDisturb: boundary.doNotDisturb,
      limits: boundary.limits,
      externalGrants: boundary.externalGrants,
    },
  }).catch(() => null);

  if (!written?.ok) {
    notes.push('迁移写边界失败（后台不可用/冲突）：本轮不标记完成，下次启动重试。');
    return { migrated: false, retiredTimerKeys, strippedCharacters, notes, skippedReason: 'boundary_unavailable' };
  }

  try {
    storage?.setItem(LEGACY_AUTONOMY_MIGRATION_MARKER, String(nowMs));
  } catch {
    /* 写不进 marker 就下次再来；幂等靠 readBoundaries 的 revision 保住 */
  }
  return { migrated: true, retiredTimerKeys, strippedCharacters, notes };
}
