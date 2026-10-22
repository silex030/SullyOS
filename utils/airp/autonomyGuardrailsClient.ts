/**
 * 自主生活护栏的**客户端层**（UI 状态 + 每角色写入 + 全局草稿/同步状态）。
 *
 * 契约本体在 `./autonomyGuardrails`（纯叶子，worker bundle 也用那份）：
 *   AirpAutonomyGuardrails { perCharPerDay, sameKindMinGapMinutes, globalPerDay, reserveTokensPerRun, paused }
 *   - 每角色字段随角色设置走、随 fire_pack 下发；
 *   - globalPerDay / paused 只认云端共享行 `amsg:global/autonomy_guardrails`（worker 直接读）。
 *
 * 这里做的三件事：
 *   1. 把面板上的人类单位（小时）换算成契约单位（分钟），写进 `char.airp.autonomy.guardrails`；
 *   2. 兼容旧 worker：把「每天最多几次」镜像到 `autonomy.overrides.maxRoundsPerDay`；
 *   3. 全局共享配置的**已确认基线 + 草稿 + 乐观并发**：
 *      权威在后台（鉴权 client_state 条目），localStorage 只存「上次确认过的云端值」和
 *      「用户刚改还没确认的草稿」。**读不到云端真实值时不展示可保存的 paused:false**
 *      （那会把用户按下的总暂停悄悄覆盖掉），也绝不整对象覆写。
 *
 * 0 的语义（契约里 0 是合法的「关到底」）：
 *   - 每角色 0 次 → 同时把 `autonomy.enabled` 置 false（这个角色今天就不跑）；
 *   - 全局 0 次 → 契约里会强制 `paused: true`（用户级总暂停的正确表达）。
 */

import type { AirpAutonomyConfig, AirpSettings } from './settings';
import {
  AUTONOMY_GUARDRAIL_CEILINGS,
  AUTONOMY_GUARDRAIL_DEFAULTS,
  AUTONOMY_GUARDRAIL_VERSION,
  buildAutonomyGuardrailStateEntry,
  normalizeAutonomyGuardrails,
  readAutonomyGuardrailStateValue,
  type AirpAutonomyGuardrails,
  type AutonomyGuardrailStateEntry,
} from './autonomyGuardrails';

/** 全局共享配置的本地缓存键（存「上次确认值 + 待同步草稿」，**不是**权威副本）。 */
export const AUTONOMY_GUARDRAILS_DRAFT_KEY = 'os_autonomy_guardrails';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ─── 数值输入校验（UI 与单测共用）────────────────────────────────────────

export type GuardrailParseResult =
  | { kind: 'empty' }
  | { kind: 'invalid'; reason: 'nan' | 'range' | 'integer' }
  | { kind: 'set'; value: number };

/**
 * 空 → empty；非整数 / 超范围 → invalid（**不写盘**，输入框标红）；合法 → set。
 * 0 在 min=0 的字段里是合法值（不限 / 暂停），绝不静默夹成 1。
 */
export function parseGuardrailInput(raw: string, min: number, max: number): GuardrailParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: 'empty' };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return { kind: 'invalid', reason: 'nan' };
  if (!Number.isInteger(parsed)) return { kind: 'invalid', reason: 'integer' };
  if (parsed < min || parsed > max) return { kind: 'invalid', reason: 'range' };
  return { kind: 'set', value: parsed };
}

/** 小时 → 分钟（契约单位），夹到天花板；小数小时按分钟精度保留。 */
export const hoursToMinutes = (hours: number): number =>
  Math.min(
    AUTONOMY_GUARDRAIL_CEILINGS.sameKindMinGapMinutes,
    Math.max(0, Math.round(hours * 60)),
  );

/** 分钟 → 面板显示的小时（保留一位小数，120 → 2、90 → 1.5）。 */
export const minutesToHours = (minutes: number): number =>
  Math.round((Math.max(0, minutes) / 60) * 10) / 10;

// ─── 读每角色（面板显示用）───────────────────────────────────────────────

export interface CharGuardrailsUiValue {
  /** false = 没单独设置，显示的是契约默认值（2 次 / 2h / 1600 token）。 */
  hasOwn: boolean;
  /** 原始值，允许 0（0 = 这个角色停用）。 */
  perCharPerDay: number;
  /** 面板单位：小时（0 = 不限）。 */
  sameKindMinGapHours: number;
  reserveTokensPerRun: number;
}

const readAutonomyRecord = (
  char: { airp?: AirpSettings } | null | undefined,
): Record<string, unknown> | undefined => {
  if (!isRecord(char)) return undefined;
  const airp: unknown = char.airp;
  if (!isRecord(airp)) return undefined;
  const autonomy = airp.autonomy;
  return isRecord(autonomy) ? autonomy : undefined;
};

/** 角色持久化里的 guardrails 原始块（`autonomy.guardrails`，其次 `autonomy.overrides.guardrails`）。 */
export function readRawCharGuardrails(
  char: { airp?: AirpSettings } | null | undefined,
): Record<string, unknown> | undefined {
  const autonomy = readAutonomyRecord(char);
  if (!autonomy) return undefined;
  if (isRecord(autonomy.guardrails)) return autonomy.guardrails;
  const overrides = autonomy.overrides;
  if (isRecord(overrides) && isRecord(overrides.guardrails)) return overrides.guardrails;
  return undefined;
}

/**
 * 面板显示值：原始 diff 优先（这样 0 不会被任何归一化洗掉），
 * 没有自己的 diff 就显示契约默认。
 */
export function readCharGuardrailsUi(
  char: { airp?: AirpSettings } | null | undefined,
): CharGuardrailsUiValue {
  const raw = readRawCharGuardrails(char);
  if (!raw) {
    return {
      hasOwn: false,
      perCharPerDay: AUTONOMY_GUARDRAIL_DEFAULTS.perCharPerDay,
      sameKindMinGapHours: minutesToHours(AUTONOMY_GUARDRAIL_DEFAULTS.sameKindMinGapMinutes),
      reserveTokensPerRun: AUTONOMY_GUARDRAIL_DEFAULTS.reserveTokensPerRun,
    };
  }
  const normalized = normalizeAutonomyGuardrails(raw);
  const rawRuns = raw.perCharPerDay;
  return {
    hasOwn: true,
    perCharPerDay:
      typeof rawRuns === 'number' && Number.isInteger(rawRuns) && rawRuns === 0
        ? 0
        : normalized.perCharPerDay,
    sameKindMinGapHours: minutesToHours(normalized.sameKindMinGapMinutes),
    reserveTokensPerRun: normalized.reserveTokensPerRun,
  };
}

// ─── 写每角色 ────────────────────────────────────────────────────────────

const AIRP_BASE_DEFAULTS = {
  enabled: false,
  autonomyLevel: 2 as const,
  capabilities: [] as string[],
  mcpAllow: [] as string[],
  writable: false,
};

const TEMPLATE_IDS = ['night_player', 'morning_brief', 'surf_share', 'custom'] as const;

const normalizeAutonomyConfig = (raw: unknown): AirpAutonomyConfigWithGuardrails => {
  const source = isRecord(raw) ? raw : {};
  const templateId = typeof source.templateId === 'string'
    && (TEMPLATE_IDS as readonly string[]).includes(source.templateId)
    ? (source.templateId as AirpAutonomyConfig['templateId'])
    : 'custom';
  return {
    enabled: source.enabled === true,
    templateId,
    overrides: isRecord(source.overrides)
      ? (source.overrides as AirpAutonomyConfig['overrides'])
      : {},
    version: 1,
    // 保留原始 diff（不在这里归一）：0 次/天的原始值要留给面板读回。
    ...(isRecord(source.guardrails)
      ? { guardrails: source.guardrails as unknown as AirpAutonomyGuardrails }
      : {}),
  };
};

/** `autonomy.guardrails` 的元素类型（AirpAutonomyConfig 的契约扩展字段）。 */
export type AirpAutonomyConfigWithGuardrails = AirpAutonomyConfig & {
  guardrails?: AirpAutonomyGuardrails;
};

export interface CharGuardrailsPatch {
  /** 0 = 这个角色停用（会同时关掉 autonomy.enabled）。 */
  perCharPerDay?: number;
  /** 分钟，0 = 不限。 */
  sameKindMinGapMinutes?: number;
  reserveTokensPerRun?: number;
}

/**
 * 写回整块 char.airp（宿主直接 handleChange('airp', next)）。
 *
 * - `autonomy.guardrails` 用契约形状（version / perCharPerDay / sameKindMinGapMinutes /
 *   reserveTokensPerRun / globalPerDay / paused）；globalPerDay 与 paused 在角色侧被
 *   effectiveAutonomyGuardrails 忽略，写默认值只为形状完整；
 * - perCharPerDay > 0 时镜像 `overrides.maxRoundsPerDay`（旧调度器只读那个字段）；
 * - perCharPerDay === 0 → 保留 0 原始值 + `autonomy.enabled = false`，并删掉旧计数镜像。
 */
export function withCharGuardrails(
  airp: AirpSettings | undefined,
  patch: CharGuardrailsPatch,
): AirpSettings {
  const current = isRecord(airp) ? airp : {};
  const base: AirpSettings = {
    ...AIRP_BASE_DEFAULTS,
    ...(current as Partial<AirpSettings>),
    version: 1,
  };
  const autonomy = normalizeAutonomyConfig(base.autonomy);
  const previousRaw: Record<string, unknown> = isRecord(autonomy.guardrails)
    ? (autonomy.guardrails as unknown as Record<string, unknown>)
    : {};
  const previous = normalizeAutonomyGuardrails(previousRaw);

  const rawRuns = patch.perCharPerDay ?? (previousRaw.perCharPerDay === 0 ? 0 : previous.perCharPerDay);
  const maxRunsPerDay = Math.min(
    AUTONOMY_GUARDRAIL_CEILINGS.perCharPerDay,
    Number.isInteger(rawRuns) && rawRuns >= 0 ? rawRuns : previous.perCharPerDay,
  );
  const sameKindMinGapMinutes = Math.min(
    AUTONOMY_GUARDRAIL_CEILINGS.sameKindMinGapMinutes,
    Math.max(0, Math.round(patch.sameKindMinGapMinutes ?? previous.sameKindMinGapMinutes)),
  );
  const reserveTokensPerRun = Math.min(
    AUTONOMY_GUARDRAIL_CEILINGS.reserveTokensPerRun,
    Math.max(1, Math.round(patch.reserveTokensPerRun ?? previous.reserveTokensPerRun)),
  );

  const guardrails: AirpAutonomyGuardrails = {
    version: AUTONOMY_GUARDRAIL_VERSION,
    perCharPerDay: maxRunsPerDay,
    sameKindMinGapMinutes,
    reserveTokensPerRun,
    globalPerDay: previous.globalPerDay,
    paused: previous.paused,
  };

  const paused = maxRunsPerDay === 0;
  const overrides: AirpAutonomyConfig['overrides'] = { ...autonomy.overrides };
  if (maxRunsPerDay > 0) overrides.maxRoundsPerDay = maxRunsPerDay;
  else delete overrides.maxRoundsPerDay;

  const autonomyNext: AirpAutonomyConfigWithGuardrails = {
    ...autonomy,
    enabled: paused ? false : autonomy.enabled,
    overrides,
    guardrails,
  };

  return { ...base, autonomy: autonomyNext, version: 1 };
}

/** 清掉角色自己的护栏（回到契约默认）；旧计数镜像一起清，免得两个来源打架。 */
export function clearCharGuardrails(airp: AirpSettings | undefined): AirpSettings {
  const current = isRecord(airp) ? airp : {};
  const base: AirpSettings = {
    ...AIRP_BASE_DEFAULTS,
    ...(current as Partial<AirpSettings>),
    version: 1,
  };
  const autonomy = normalizeAutonomyConfig(base.autonomy);
  const overrides: AirpAutonomyConfig['overrides'] = { ...autonomy.overrides };
  delete overrides.maxRoundsPerDay;
  const autonomyNext: AirpAutonomyConfigWithGuardrails = {
    ...autonomy,
    overrides,
    guardrails: undefined,
  };
  return { ...base, autonomy: autonomyNext, version: 1 };
}

// ─── 全局共享配置：已确认基线 + 草稿 + 乐观并发 ───────────────────────────

export type GuardrailsSyncStatus = 'unknown' | 'pending' | 'synced' | 'error' | 'conflict';

export interface GuardrailsSyncState {
  status: GuardrailsSyncStatus;
  pendingSync: boolean;
  savedAt?: number;
  confirmedAt?: number;
  lastError?: string;
}

/** 权威值从哪来：读不到云端真实值时是 unknown，**不允许**拿默认值去保存。 */
export type GlobalGuardrailsAuthority = 'remote-confirmed' | 'remote-absent' | 'draft' | 'unknown';

export interface GlobalGuardrailsSnapshot {
  /** null = 不知道云端当前值。界面必须显示「未确认」，不得当成未暂停。 */
  value: AirpAutonomyGuardrails | null;
  /** 上一次确认过的云端值（成功 load 或写后读回）。 */
  lastConfirmed: AirpAutonomyGuardrails | null;
  authority: GlobalGuardrailsAuthority;
  /** 只有确认过云端现值（或确认那一行不存在）才允许保存。 */
  canSave: boolean;
  pendingSync: boolean;
  syncState: GuardrailsSyncState;
}

export interface CachedGlobalGuardrails {
  v: typeof AUTONOMY_GUARDRAIL_VERSION;
  /** 用户刚改、还没被后台确认的值。 */
  draft?: AirpAutonomyGuardrails;
  /** 上一次确认过的云端值。 */
  confirmed?: AirpAutonomyGuardrails;
  /** 云端明确没有这一行（新用户）。 */
  absent?: boolean;
  savedAt: number;
  confirmedAt?: number;
  lastError?: string;
  conflict?: boolean;
}

/**
 * 写前基线：`absent` = 期望云端没有这一行（新用户首次创建）；
 * `value` = 期望云端恰好是上一份确认值。核对不上就是冲突，绝不盲写。
 */
export type GuardrailWriteExpectation =
  | { kind: 'absent' }
  | { kind: 'value'; value: AirpAutonomyGuardrails };

/** 护栏同步的结构化错误：UI 按 code 区分「冲突 / 未确认 / 网络」。 */
export class GuardrailSyncError extends Error {
  readonly code: 'conflict' | 'unconfirmed' | 'network';
  readonly remoteValue: string | null;

  constructor(code: 'conflict' | 'unconfirmed' | 'network', message: string, remoteValue: string | null = null) {
    super(message);
    this.name = 'GuardrailSyncError';
    this.code = code;
    this.remoteValue = remoteValue;
  }
}

export interface GuardrailsSaveResult {
  ok: boolean;
  /** 还没读到云端真实值 → 拒绝保存（不是失败，是「不许盲写」）。 */
  blocked?: boolean;
  /** 另一台设备同时改过 → 已放弃本次写入并采用云端值。 */
  conflict?: boolean;
  /** 基线是暂停，调用方没明确要求解暂停 → paused 被保住。 */
  unpauseIgnored?: boolean;
  status: GuardrailsSyncStatus;
  value: AirpAutonomyGuardrails | null;
  /** 真正上传的条目（被拒绝/无端口时没有）。 */
  entry?: AutonomyGuardrailStateEntry;
  error?: string;
}

/**
 * 鉴权同步端口：父代理/后台在主动消息初始化处绑一次。
 *
 * 参考实现（拿到 ActiveMsgClient 后）：`createGuardrailCloudPort(ActiveMsgClient)`，
 * 见 `./autonomyGuardrailTransport`。
 *
 * `save` 的第二个参数是写前基线（乐观并发）：实现方必须先读云端、核对基线，
 * 再写、再读回比对；不实现这个核对 = 多设备同时改时会互相覆盖。
 */
export interface GuardrailSaveOptions {
  /** 用户**明确**要求解除暂停（只能来自总开关那一次点击）。服务端据此决定要不要松手。 */
  allowUnpause?: boolean;
}

/** 服务端确认后的回执：真正落库的值 + 它有没有把「解暂停」按回去。 */
export interface GuardrailSaveAck {
  unpauseIgnored?: boolean;
  value?: AirpAutonomyGuardrails;
}

export interface GuardrailCloudSyncPort {
  save: (
    entry: AutonomyGuardrailStateEntry,
    expectation?: GuardrailWriteExpectation,
    options?: GuardrailSaveOptions,
  ) => Promise<GuardrailSaveAck | void>;
  load?: () => Promise<string | null>;
}

let syncPort: GuardrailCloudSyncPort | null = null;
const listeners = new Set<(value: AirpAutonomyGuardrails) => void>();

const readCache = (): CachedGlobalGuardrails | null => {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(AUTONOMY_GUARDRAILS_DRAFT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const cache: CachedGlobalGuardrails = {
      v: AUTONOMY_GUARDRAIL_VERSION,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
    };
    if (isRecord(parsed.confirmed)) cache.confirmed = normalizeAutonomyGuardrails(parsed.confirmed);
    if (isRecord(parsed.draft)) cache.draft = normalizeAutonomyGuardrails(parsed.draft);
    if (parsed.absent === true) cache.absent = true;
    if (typeof parsed.confirmedAt === 'number') cache.confirmedAt = parsed.confirmedAt;
    if (typeof parsed.lastError === 'string' && parsed.lastError) cache.lastError = parsed.lastError;
    if (parsed.conflict === true) cache.conflict = true;

    // 升级前的旧形状 { value, pendingSync }：
    //   - 只有「已确认过」那条才算基线（confirmedAt 存在且不是待同步）；
    //   - 旧客户端写的待同步 value 没有可信基线 → 不升级成权威值，宁可按未确认处理。
    if (!cache.confirmed && !cache.draft && isRecord(parsed.value)) {
      if (parsed.pendingSync !== true && typeof parsed.confirmedAt === 'number') {
        cache.confirmed = normalizeAutonomyGuardrails(parsed.value);
      }
    }
    return cache;
  } catch {
    return null;
  }
};

const writeCache = (cache: CachedGlobalGuardrails): void => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(AUTONOMY_GUARDRAILS_DRAFT_KEY, JSON.stringify(cache));
  } catch {
    // 配额满 / 隐私模式：草稿退回内存态，这一轮 UI 仍可用。
  }
};

/** 合并写缓存（undefined 字段用 delete 表达「清掉」，避免 JSON 里留 null 误判）。 */
const patchCache = (patch: Partial<CachedGlobalGuardrails>): CachedGlobalGuardrails => {
  const current = readCache() ?? { v: AUTONOMY_GUARDRAIL_VERSION, savedAt: 0 };
  const next: CachedGlobalGuardrails = { ...current, ...patch, v: AUTONOMY_GUARDRAIL_VERSION };
  const mutable = next as unknown as Record<string, unknown>;
  for (const key of ['draft', 'confirmed', 'absent', 'confirmedAt', 'lastError', 'conflict'] as const) {
    if (key in patch && patch[key] === undefined) delete mutable[key];
  }
  writeCache(next);
  return next;
};

const emit = (value: AirpAutonomyGuardrails): void => {
  for (const cb of listeners) {
    try {
      cb(value);
    } catch {
      // 一个订阅者出错不影响其它订阅者。
    }
  }
};

export function getGuardrailsSyncState(): GuardrailsSyncState {
  const cache = readCache();
  const pendingSync = !!cache?.draft;
  const status: GuardrailsSyncStatus = cache?.conflict
    ? 'conflict'
    : cache?.lastError
      ? 'error'
      : pendingSync
        ? 'pending'
        : cache?.confirmed || cache?.absent
          ? 'synced'
          : 'unknown';
  return {
    status,
    pendingSync,
    ...(typeof cache?.savedAt === 'number' && cache.savedAt > 0 ? { savedAt: cache.savedAt } : {}),
    ...(cache?.confirmedAt !== undefined ? { confirmedAt: cache.confirmedAt } : {}),
    ...(cache?.lastError ? { lastError: cache.lastError } : {}),
  };
}

/**
 * 当前全局护栏快照：这是**唯一**应该被界面用来判断「能不能保存 / paused 是什么」的入口。
 * 读不到云端真实值时 `value` 是 null，调用方必须显示「未确认」，不能补一个默认值。
 */
export function getGlobalGuardrailsSnapshot(): GlobalGuardrailsSnapshot {
  const cache = readCache();
  const lastConfirmed = cache?.confirmed ?? null;
  const hasBase = lastConfirmed !== null || cache?.absent === true;
  const pendingSync = !!cache?.draft;
  const authority: GlobalGuardrailsAuthority = pendingSync
    ? (hasBase ? 'draft' : 'unknown')
    : lastConfirmed
      ? 'remote-confirmed'
      : cache?.absent
        ? 'remote-absent'
        : 'unknown';
  const value = pendingSync
    ? (cache?.draft ?? null)
    : lastConfirmed ?? (cache?.absent ? { ...AUTONOMY_GUARDRAIL_DEFAULTS } : null);
  return {
    value,
    lastConfirmed,
    authority,
    canSave: authority !== 'unknown',
    pendingSync,
    syncState: getGuardrailsSyncState(),
  };
}

/**
 * 展示用读法（**不能**用来决定写入）：确认值 → 草稿 → 契约默认。
 * 权威判断一律走 `getGlobalGuardrailsSnapshot()`。
 */
export function readGlobalGuardrails(): AirpAutonomyGuardrails {
  return getGlobalGuardrailsSnapshot().value ?? { ...AUTONOMY_GUARDRAIL_DEFAULTS };
}

export function bindGuardrailCloudSync(port: GuardrailCloudSyncPort | null): void {
  syncPort = port;
}

/** 测试 / 重登用：清掉本机缓存与端口绑定（不动云端那一行）。 */
export function resetGlobalGuardrailsState(): void {
  syncPort = null;
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(AUTONOMY_GUARDRAILS_DRAFT_KEY);
  } catch { /* ignore */ }
}

const handleStorageEvent = (event: StorageEvent): void => {
  if (event.key !== AUTONOMY_GUARDRAILS_DRAFT_KEY) return;
  emit(readGlobalGuardrails());
};

export function subscribeGlobalGuardrails(cb: (value: AirpAutonomyGuardrails) => void): () => void {
  listeners.add(cb);
  if (typeof window !== 'undefined' && listeners.size === 1) {
    window.addEventListener('storage', handleStorageEvent);
  }
  return () => {
    listeners.delete(cb);
    if (typeof window !== 'undefined' && listeners.size === 0) {
      window.removeEventListener('storage', handleStorageEvent);
    }
  };
}

export interface SaveGlobalGuardrailsOptions {
  /**
   * 用户**明确**要求解除总暂停（只能来自总开关那一次点击）。
   * 缺省时基线是暂停就不会被改成未暂停——旧客户端「顺手整对象覆写」也解不了暂停。
   */
  allowUnpause?: boolean;
}

const GUARDRAIL_PATCH_KEYS = [
  'perCharPerDay',
  'sameKindMinGapMinutes',
  'globalPerDay',
  'reserveTokensPerRun',
  'paused',
] as const;

const pickGuardrailPatch = (raw: unknown): Partial<AirpAutonomyGuardrails> => {
  if (!isRecord(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const key of GUARDRAIL_PATCH_KEYS) {
    if (key in raw) out[key] = raw[key];
  }
  return out as Partial<AirpAutonomyGuardrails>;
};

const errorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200);

/**
 * 保存全局护栏：**只写传进来的字段**，其余字段沿用已确认基线。
 *
 * 流程：已确认基线 + patch → 归一 → 落本机草稿 → 带基线写云端（写前核对 + 写后读回）
 * → 成功才标记「已确认」。任何一步读不到云端真实值都不写、不假装成功。
 */
export async function saveGlobalGuardrails(
  patch: Partial<AirpAutonomyGuardrails>,
  options: SaveGlobalGuardrailsOptions = {},
): Promise<GuardrailsSaveResult> {
  const snapshot = getGlobalGuardrailsSnapshot();
  const base = snapshot.lastConfirmed
    ?? (snapshot.authority === 'remote-absent' ? { ...AUTONOMY_GUARDRAIL_DEFAULTS } : null);
  if (!base) {
    return {
      ok: false,
      blocked: true,
      status: snapshot.syncState.status,
      value: snapshot.value,
      error: '还没读到云端真实配置，先同步再保存（否则会把云端的暂停覆盖成未暂停）。',
    };
  }

  const merged = normalizeAutonomyGuardrails({ ...base, ...pickGuardrailPatch(patch) });
  let unpauseIgnored = false;
  if (base.paused && merged.paused === false && options.allowUnpause !== true) {
    merged.paused = true;
    unpauseIgnored = true;
  }

  const entry = buildAutonomyGuardrailStateEntry(merged, Date.now());
  const now = entry.updatedAt;
  patchCache({ draft: merged, savedAt: now, lastError: undefined, conflict: false });
  emit(merged);

  if (!syncPort) {
    return {
      ok: false,
      status: 'pending',
      value: merged,
      unpauseIgnored,
      entry,
      error: '后台同步端口还没接上：本机只是草稿，没有上传。',
    };
  }

  const expectation: GuardrailWriteExpectation = snapshot.lastConfirmed
    ? { kind: 'value', value: snapshot.lastConfirmed }
    : { kind: 'absent' };

  try {
    const ack = await syncPort.save(entry, expectation, { allowUnpause: options.allowUnpause === true });
    // 以**服务端回执**为准落「已确认」值：它可能把 pause 保住（unpauseIgnored）或把 0 归一。
    const confirmedValue = ack?.value ? normalizeAutonomyGuardrails(ack.value) : merged;
    const finalUnpauseIgnored = unpauseIgnored || ack?.unpauseIgnored === true;
    if (finalUnpauseIgnored) confirmedValue.paused = true;
    patchCache({
      draft: undefined,
      confirmed: confirmedValue,
      absent: false,
      savedAt: now,
      confirmedAt: now,
      lastError: undefined,
      conflict: false,
    });
    emit(confirmedValue);
    return {
      ok: true,
      status: 'synced',
      value: confirmedValue,
      entry,
      ...(finalUnpauseIgnored ? { unpauseIgnored: true } : {}),
    };
  } catch (error) {
    const message = errorMessage(error);
    if (error instanceof GuardrailSyncError && error.code === 'conflict') {
      // 先把草稿撤掉：留着草稿再点一次「重试」就会把另一台设备的暂停压掉。
      patchCache({ draft: undefined, savedAt: now, lastError: message, conflict: true });
      const adopted = error.remoteValue != null
        ? readAutonomyGuardrailStateValue(error.remoteValue)
        : null;
      if (adopted?.kind === 'ok') {
        patchCache({ confirmed: adopted.value, absent: false, confirmedAt: now });
        emit(adopted.value);
      } else if (adopted?.kind === 'absent') {
        patchCache({ confirmed: undefined, absent: true, confirmedAt: now });
        emit({ ...AUTONOMY_GUARDRAIL_DEFAULTS });
      } else {
        await refreshGlobalGuardrailsFromRemote();
      }
      return {
        ok: false,
        conflict: true,
        status: 'conflict',
        value: getGlobalGuardrailsSnapshot().value,
        error: message,
      };
    }
    patchCache({ savedAt: now, lastError: message, conflict: false });
    return { ok: false, status: 'error', value: merged, entry, error: message };
  }
}

export type GlobalGuardrailsRefresh =
  | { status: 'ok'; value: AirpAutonomyGuardrails }
  | { status: 'absent' }
  | { status: 'invalid'; error: string }
  | { status: 'error'; error: string }
  | { status: 'skipped'; reason: 'no-port' | 'pending' };

const asStateString = (raw: unknown): unknown => {
  if (typeof raw === 'string' || raw == null) return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return null;
  }
};

/**
 * 从后台共享行回读权威值。
 *
 * - 本地还有待同步草稿 → 不覆盖（避免把用户刚改的丢掉），返回 skipped；
 * - 缺行（null / 空串）→ 确认「云端没有这一行」，允许落默认；
 * - 坏 JSON / 解密失败 / 网络错误 → 保持上次确认值，只标 error，**不落默认**。
 */
export async function refreshGlobalGuardrailsFromRemote(): Promise<GlobalGuardrailsRefresh> {
  if (!syncPort?.load) return { status: 'skipped', reason: 'no-port' };
  if (getGlobalGuardrailsSnapshot().pendingSync) return { status: 'skipped', reason: 'pending' };
  try {
    const raw = await syncPort.load();
    const read = readAutonomyGuardrailStateValue(asStateString(raw));
    const now = Date.now();
    if (read.kind === 'absent') {
      patchCache({ draft: undefined, confirmed: undefined, absent: true, savedAt: now, confirmedAt: now, lastError: undefined, conflict: false });
      emit({ ...AUTONOMY_GUARDRAIL_DEFAULTS });
      return { status: 'absent' };
    }
    if (read.kind === 'invalid') {
      const error = '云端护栏配置读不出来（可能密钥不匹配或那一行损坏）；保持不变，请重试。';
      // 不清 conflict：刚刚发生过冲突时，「冲突」比「读不出来」更需要用户看见。
      patchCache({ lastError: error });
      return { status: 'invalid', error };
    }
    patchCache({ draft: undefined, confirmed: read.value, absent: false, savedAt: now, confirmedAt: now, lastError: undefined, conflict: false });
    emit(read.value);
    return { status: 'ok', value: read.value };
  } catch (error) {
    const message = errorMessage(error);
    patchCache({ lastError: message });
    return { status: 'error', error: message };
  }
}
