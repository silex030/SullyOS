/**
 * 自主生活的时钟、时区与随机源（可控，便于确定性测试）。
 *
 * 三条硬规矩：
 *   1. 所有「现在几点了」都从 Clock 取，不在业务代码里直接 Date.now()——否则可控时钟
 *      在某些路径上会漏，测试就只能靠 sleep 赌时间。
 *   2. 随机源由「安装级种子 + 角色 + 日程 revision + opportunityId」派生并持久化。
 *      同一次机会在重启后重算必须得到同一个 nextOpportunityAt，不能重新抽奖。
 *   3. 日期一律按配置的 IANA 时区派生（存 UTC 毫秒），夏令时交给时区库。
 */

export interface Clock {
  now(): number;
}

/** 生产用时钟。 */
export const systemClock: Clock = { now: () => Date.now() };

export interface ManualClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
}

/** 测试用可控时钟。 */
export function createManualClock(startMs: number): ManualClock {
  let current = startMs;
  return {
    now: () => current,
    set: (ms: number) => {
      current = ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** 字符串种子 → 32 位整数（FNV-1a）。 */
export function seedToInt(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export interface Rng {
  /** [0, 1) 均匀 */
  next(): number;
  /** [0, max) 整数 */
  int(max: number): number;
  /** [-bound, bound] 有界噪声 */
  noise(bound: number): number;
}

/**
 * mulberry32：小、快、跨端一致（前端与 worker 算出的序列相同）。
 * 种子相同 → 序列相同；调用顺序固定 → 结果可复现。
 */
export function createRng(...seedParts: (string | number)[]): Rng {
  let state = seedToInt(seedParts.map(String).join('|')) || 0x9e3779b9;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (max: number) => (max <= 0 ? 0 : Math.floor(next() * max)),
    noise: (bound: number) => (next() * 2 - 1) * Math.abs(bound),
  };
}

/** 一次机会的确定性标识：同一 (种子, 角色, 日程 revision, 窗口起点) 永远相同。 */
export function opportunityId(args: {
  seed: string;
  charId: string;
  scheduleRevision: string | number;
  windowStartMs: number;
}): string {
  const rng = createRng('opportunity', args.seed, args.charId, String(args.scheduleRevision), args.windowStartMs);
  return `opp_${Math.floor(rng.next() * 0x100000000).toString(16)}`;
}

export interface ZonedParts {
  dateKey: string;  // YYYY-MM-DD（角色当地）
  hour: number;
  minute: number;
  /** 0=周日 */
  weekday: number;
  /** 当地当日已经过的分钟数 */
  minuteOfDay: number;
}

const FALLBACK_TZ = 'UTC';

export function isValidTimeZone(tzId: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tzId });
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimeZone(tzId: string | null | undefined, fallback = FALLBACK_TZ): string {
  if (typeof tzId === 'string' && tzId.trim() && isValidTimeZone(tzId)) return tzId;
  return fallback;
}

/** UTC 毫秒 → 角色当地墙上时间各部分。时区非法时退回 UTC（不抛）。 */
export function zonedParts(nowMs: number, tzId: string): ZonedParts {
  const tz = normalizeTimeZone(tzId);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const map: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(nowMs))) map[part.type] = part.value;
  let hour = Number.parseInt(map.hour ?? '0', 10);
  if (hour === 24) hour = 0;
  const minute = Number.parseInt(map.minute ?? '0', 10);
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekday = Math.max(0, weekdays.indexOf(map.weekday ?? 'Sun'));
  return {
    dateKey: `${map.year}-${map.month}-${map.day}`,
    hour,
    minute,
    weekday,
    minuteOfDay: hour * 60 + minute,
  };
}

export function localDateKey(nowMs: number, tzId: string): string {
  return zonedParts(nowMs, tzId).dateKey;
}

/** 预算窗口 id：服务端按角色时区的本地日切；任务属于哪个窗口就记哪个窗口。 */
export function budgetWindowId(nowMs: number, tzId: string): string {
  return `w:${zonedParts(nowMs, tzId).dateKey}`;
}

/** 把当地墙上时间（HH:mm）换成当天分钟数。 */
export function hhmmToMinutes(hhmm: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) return null;
  return Number.parseInt(match[1], 10) * 60 + Number.parseInt(match[2], 10);
}

/** 时间窗（含起点、不含终点）跨零点时也成立。 */
export function isWithinWindow(minuteOfDay: number, startMinutes: number, endMinutes: number): boolean {
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) return minuteOfDay >= startMinutes && minuteOfDay < endMinutes;
  return minuteOfDay >= startMinutes || minuteOfDay < endMinutes;
}
