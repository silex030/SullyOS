/**
 * seasonal-events · halloween
 * 本地万圣节：收集 → 领取 → 已完成。纯函数，可单测。
 * - 日期比较只用 YYYY-MM-DD 字符串（含测试/preview 注入的 todayKey）；
 *   生产组件不传 todayKey 时取设备本地今天（getLocalDateKey(new Date())），
 *   绝不伪造当前日期。
 * - 领取幂等：claimed 后重复调用不再产生 intent，claimId 稳定。
 */
import {
  HALLOWEEN_END_KEY,
  HALLOWEEN_EVENT_ID,
  HALLOWEEN_SPOTS,
  HALLOWEEN_START_KEY,
  type HalloweenPhase,
  type HalloweenRewardIntent,
  type HalloweenSpotId,
  type HalloweenStateV1,
  halloweenStorageKey,
} from './types';

import type { StorageLike } from '../room3d/storage';
import {
  type CrossDocMutex,
  getDefaultMutex,
  halloweenLockKey,
} from '../room3d/mutex';

export function isHalloweenActive(todayKey: string): boolean {
  return todayKey >= HALLOWEEN_START_KEY && todayKey <= HALLOWEEN_END_KEY;
}

export function getHalloweenPhase(todayKey: string): HalloweenPhase {
  if (todayKey < HALLOWEEN_START_KEY) return 'before';
  if (todayKey > HALLOWEEN_END_KEY) return 'ended';
  return 'active';
}

const isSpot = (v: unknown): v is HalloweenSpotId =>
  typeof v === 'string' &&
  (HALLOWEEN_SPOTS as readonly string[]).includes(v);

export function createHalloweenState(
  charId: string,
  now: number = Date.now(),
): HalloweenStateV1 {
  return {
    version: 1,
    eventId: HALLOWEEN_EVENT_ID,
    charId,
    collected: [],
    claimed: false,
    claimId: null,
    updatedAt: now,
  };
}

export function allCollected(state: HalloweenStateV1): boolean {
  return HALLOWEEN_SPOTS.every((s) => state.collected.includes(s));
}

export function collectSpot(
  state: HalloweenStateV1,
  spotId: string,
  todayKey: string,
  now: number = Date.now(),
): { state: HalloweenStateV1; collected: boolean } {
  if (!isHalloweenActive(todayKey)) return { state, collected: false };
  if (!isSpot(spotId)) return { state, collected: false };
  if (state.collected.includes(spotId)) return { state, collected: false };
  return {
    state: {
      ...state,
      collected: [...state.collected, spotId],
      updatedAt: now,
    },
    collected: true,
  };
}

/** 稳定 claimId：同角色同活动终身唯一，关页重开不重复领取。 */
export function halloweenClaimId(charId: string): string {
  return `hw2026-${charId}`;
}

/**
 * 调用者归属校验（第1轮新架构复审）:持久化入口只接受与目标槽
 * 同 charId、同版本、同活动的本地态；跨角色/跨版本 payload 在触及
 * 锁与存储之前拒绝，零写入、零 intent（missing 槽不得采用旧 local）。
 */
const isOwnedHalloweenState = (state: HalloweenStateV1, charId: string): boolean =>
  state.version === 1 &&
  state.eventId === HALLOWEEN_EVENT_ID &&
  state.charId === charId &&
  Array.isArray(state.collected) &&
  state.collected.every(isSpot);

export function claimReward(
  state: HalloweenStateV1,
  _todayKey: string,
  now: number = Date.now(),
): { state: HalloweenStateV1; intent: HalloweenRewardIntent | null } {
  void _todayKey;
  if (state.claimed) return { state, intent: null };
  if (!allCollected(state)) return { state, intent: null };
  const claimId = state.claimId ?? halloweenClaimId(state.charId);
  const next: HalloweenStateV1 = {
    ...state,
    claimed: true,
    claimId,
    updatedAt: now,
  };
  return {
    state: next,
    intent: {
      kind: 'halloween-candy',
      eventId: HALLOWEEN_EVENT_ID,
      charId: state.charId,
      claimId,
      collectedCount: state.collected.length,
    },
  };
}

export function serializeHalloween(state: HalloweenStateV1): string {
  return JSON.stringify(state);
}

/** 损坏/串槽/版本不符一律返回 null，不抛错。 */
export function deserializeHalloween(
  json: string,
  expectedCharId: string,
): HalloweenStateV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (p['version'] !== 1) return null;
  if (p['eventId'] !== HALLOWEEN_EVENT_ID) return null;
  if (p['charId'] !== expectedCharId) return null;
  if (!Array.isArray(p['collected'])) return null;
  if (!p['collected'].every(isSpot)) return null;
  if (typeof p['claimed'] !== 'boolean') return null;
  if (p['claimId'] !== null && typeof p['claimId'] !== 'string') return null;
  if (typeof p['updatedAt'] !== 'number' || !Number.isFinite(p['updatedAt'])) {
    return null;
  }
  return {
    version: 1,
    eventId: HALLOWEEN_EVENT_ID,
    charId: expectedCharId,
    collected: p['collected'] as HalloweenSpotId[],
    claimed: p['claimed'] as boolean,
    claimId: p['claimId'] as string | null,
    updatedAt: p['updatedAt'] as number,
  };
}

export { halloweenStorageKey };

/**
 * 万圣节槽位读取四态：missing / ok / corrupt / read-error。
 * - corrupt：坏 JSON、未知版本、串槽（charId 不一致）、字段非法；
 * - 调用方（组件）损坏时只展示恢复 UI，绝不自动覆写原字节。
 */
export type HalloweenLoadStatus = 'missing' | 'ok' | 'corrupt' | 'read-error';

export interface HalloweenLoadMeta {
  status: HalloweenLoadStatus;
  state: HalloweenStateV1 | null;
  /** 原始字节（missing/read-error 时为 null）。 */
  raw: string | null;
}

export function loadHalloweenMeta(storage: StorageLike, charId: string): HalloweenLoadMeta {
  let raw: string | null = null;
  try {
    raw = storage.getItem(halloweenStorageKey(charId));
  } catch {
    return { status: 'read-error', state: null, raw: null };
  }
  if (raw == null) return { status: 'missing', state: null, raw: null };
  const parsed = deserializeHalloween(raw, charId);
  if (!parsed) return { status: 'corrupt', state: null, raw };
  return { status: 'ok', state: parsed, raw };
}

/**
 * 写穿收集（锁内单调）：每次写前在锁内重读并校验最新持久化槽。
 * - claimed 一旦为 true（盘上或本地），任何过期收集一律拒绝
 *  （already-claimed），绝不撤销已领取、绝不产生第二个 intent 前提；
 * - collected 只按实际点击与最新状态推进：新旧 collected 取并集，
 *   不用过期本地快照覆盖，进度不倒退；
 * - 坏 JSON/未知版本/读错误（即使 mount 后才出现）一律拒绝写入并保留原字节：
 *   corrupt-blocked / read-error，调用方显示保护态；
 * - 无互斥能力（mutex 为 null）fail closed：persist-failed(no-cross-tab-mutex)。
 * 落盘（含写后确认）成功才返回 ok:true；调用方不得在 ok:false 时更新 UI。
 */
export async function tryPersistCollect(
  storage: StorageLike,
  charId: string,
  state: HalloweenStateV1,
  spotId: string,
  todayKey: string,
  now: number = Date.now(),
  mutex?: CrossDocMutex | null,
): Promise<{ ok: true; state: HalloweenStateV1 } | { ok: false; state: HalloweenStateV1; error: string }> {
  if (!isOwnedHalloweenState(state, charId)) {
    return { ok: false as const, state, error: 'owner-mismatch' };
  }
  const m = mutex !== undefined ? mutex : getDefaultMutex();
  if (!m) return { ok: false, state, error: 'no-cross-tab-mutex' };
  return m.withLock(halloweenLockKey(charId), async () => {
    const meta = loadHalloweenMeta(storage, charId);
    if (meta.status === 'read-error') return { ok: false as const, state, error: 'read-error' };
    if (meta.status === 'corrupt') return { ok: false as const, state, error: 'corrupt-blocked' };
    const stored = meta.status === 'ok' && meta.state ? meta.state : null;
    // 已领取保护：盘上或本地任一 claimed 即拒绝，返回盘上最新态。
    if (stored?.claimed || state.claimed) {
      return { ok: false as const, state: stored ?? state, error: 'already-claimed' };
    }
    // 进度单调：新旧 collected 取并集，过期快照不得覆盖。
    const merged: HalloweenStateV1 =
      stored && stored.charId === charId
        ? {
            ...stored,
            collected: Array.from(new Set([...stored.collected, ...state.collected])),
          }
        : state;
    const tick = stored && now <= stored.updatedAt ? stored.updatedAt + 1 : now;
    const r = collectSpot(merged, spotId, todayKey, tick);
    if (!r.collected) return { ok: false as const, state: stored ?? state, error: 'not-collectible' };
    const bytes = serializeHalloween(r.state);
    try {
      storage.setItem(halloweenStorageKey(charId), bytes);
    } catch {
      return { ok: false as const, state: stored ?? state, error: 'persist-failed' };
    }
    // 写后确认：读回必须逐字节一致，否则视为失败。
    let check: string | null = null;
    try {
      check = storage.getItem(halloweenStorageKey(charId));
    } catch {
      return { ok: false as const, state: stored ?? state, error: 'persist-failed' };
    }
    if (check !== bytes) {
      return { ok: false as const, state: stored ?? state, error: 'persist-failed' };
    }
    return { ok: true as const, state: r.state };
  });
}

export type HalloweenClaimResult =
  | { status: 'claimed'; intent: HalloweenRewardIntent; state: HalloweenStateV1 }
  | { status: 'already-claimed'; state: HalloweenStateV1 }
  | { status: 'not-ready'; state: HalloweenStateV1 }
  | { status: 'persist-failed'; state: HalloweenStateV1; error: string }
  | { status: 'corrupt-blocked'; raw: string | null }
  | { status: 'read-error' };

/**
 * 持久化优先的领取（锁内单调幂等核心）：
 * 1. 锁内先 fresh-read 当前槽位：已 claimed（即使本地态过期）→ already-claimed，
 *    绝不产生第二个 intent（覆盖双实例/双 tab 过期认领）；
 * 2. 未集齐 → not-ready；损坏/不可读 → corrupt-blocked/read-error，不写盘；
 * 3. 写 claimed 落盘（含写后确认）成功后才返回 intent；写失败 → persist-failed，
 *    调用方不得显示成功、不得调用 onReward；
 * 4. 无互斥能力 → persist-failed(no-cross-tab-mutex)，fail closed。
 */
export async function tryClaimPersisted(
  storage: StorageLike,
  charId: string,
  local: HalloweenStateV1,
  todayKey: string,
  now: number = Date.now(),
  mutex?: CrossDocMutex | null,
): Promise<HalloweenClaimResult> {
  if (!isOwnedHalloweenState(local, charId)) {
    return { status: 'persist-failed', state: local, error: 'owner-mismatch' };
  }
  const m = mutex !== undefined ? mutex : getDefaultMutex();
  if (!m) {
    return { status: 'persist-failed', state: local, error: 'no-cross-tab-mutex' };
  }
  return m.withLock(halloweenLockKey(charId), async (): Promise<HalloweenClaimResult> => {
    const meta = loadHalloweenMeta(storage, charId);
    if (meta.status === 'read-error') return { status: 'read-error' };
    if (meta.status === 'corrupt') return { status: 'corrupt-blocked', raw: meta.raw };
    // 以本地态与已存态的并集判定集齐（写穿收集下二者本应一致；合并防本地超前）。
    const merged: HalloweenStateV1 =
      meta.status === 'ok' && meta.state
        ? {
            ...meta.state,
            collected: Array.from(new Set([...meta.state.collected, ...local.collected])),
          }
        : local;
    if (merged.claimed) return { status: 'already-claimed', state: merged };
    if (!allCollected(merged)) return { status: 'not-ready', state: merged };
    const tick = meta.status === 'ok' && meta.state && now <= meta.state.updatedAt
      ? meta.state.updatedAt + 1
      : now;
    const r = claimReward(merged, todayKey, tick);
    if (!r.intent) return { status: 'not-ready', state: merged };
    const bytes = serializeHalloween(r.state);
    try {
      storage.setItem(halloweenStorageKey(charId), bytes);
    } catch {
      return { status: 'persist-failed', state: merged, error: '底层存储写入失败' };
    }
    let check: string | null = null;
    try {
      check = storage.getItem(halloweenStorageKey(charId));
    } catch {
      return { status: 'persist-failed', state: merged, error: '底层存储写入失败' };
    }
    if (check !== bytes) {
      return { status: 'persist-failed', state: merged, error: '写后确认失败' };
    }
    return { status: 'claimed', intent: r.intent, state: r.state };
  });
}

/**
 * 显式用户恢复：锁内重验，仅当槽位损坏（或已空）且字节未被别人动过时清除。
 * 好存档/不可读一律返回 false。无互斥能力返回 false。
 */
export async function clearHalloweenCorrupt(
  storage: StorageLike,
  charId: string,
  expectedRaw: string | null,
  mutex?: CrossDocMutex | null,
): Promise<boolean> {
  const m = mutex !== undefined ? mutex : getDefaultMutex();
  if (!m) return false;
  return m.withLock(halloweenLockKey(charId), async () => {
    const meta = loadHalloweenMeta(storage, charId);
    if (meta.status === 'read-error') return false;
    if (meta.status === 'missing') return true;
    if (meta.status === 'ok') return false;
    if (expectedRaw !== null && meta.raw !== expectedRaw) return false;
    try {
      storage.removeItem(halloweenStorageKey(charId));
    } catch {
      return false;
    }
    // 写后确认（与收集/领取写后确认同协议）：同一锁内读回同一 key，
    // 确认为 missing/null 才成功。残留字节/读异常一律失败，
    // 不重建默认值、不提示已清除。
    try {
      const confirm = storage.getItem(halloweenStorageKey(charId));
      if (confirm !== null) return false;
    } catch {
      return false;
    }
    return true;
  });
}
