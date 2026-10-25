/**
 * 真实人设 / 日程 → 引擎可用的「人设信号」（纯函数，零 IO、零模型、零 Date.now）。
 *
 * 为什么单独一层：rhythm-v1 的 profile 一直支持 personaText / scheduleText，但生产上
 * 从来没人把真实人设/日程接进来（引擎只能拿到空文本 → 全员基础作息）。这一层负责把
 * worker 手里**真实存在**的两份素材整理成规范形状：
 *   - personaText：角色 fire_pack 模板（那里本来就是角色设定/世界/规则）；
 *   - scheduleText：角色当天真实日程（fire_pack.scene.schedule.slots），并且把「睡觉/
 *     休息/起床」那一段放在最前面——rhythm 的确定性解析只认第一段 HH:mm-HH:mm 作为
 *     睡眠窗，顺序错了会把「09:00 例会」当成睡眠。
 *
 * 边界（刻意不做的事）：
 *   - 不在这里编人设；没有真实文本就返回空信号，引擎按「暂用基础作息」fallback；
 *   - 不做任何模型调用（profile 的结构化提取是可选输入，不是这里）；
 *   - 不读时钟：调用方传入 nowMs / 时区，跨天日程由调用方决定是否采用。
 */

import { hashString } from '../../contracts/autonomyLife';

/** 引擎侧的人设信号：两份真实文本 + 角色真实城市（出行愿望用；空 = 不知道）。 */
export interface PersonaSignal {
  personaText: string;
  scheduleText: string;
  city: string;
}

export const EMPTY_PERSONA_SIGNAL: PersonaSignal = { personaText: '', scheduleText: '', city: '' };

/** rhythm 侧的长度上限（与 buildRhythmProfile 一致，提前截断避免哈希被无关尾部影响）。 */
export const PERSONA_MAX_CHARS = 4000;
export const SCHEDULE_MAX_CHARS = 2000;
export const CITY_MAX_CHARS = 20;

export function normalizePersonaSignal(
  input: { personaText?: unknown; scheduleText?: unknown; city?: unknown } | null | undefined,
): PersonaSignal {
  const personaText = typeof input?.personaText === 'string' ? input.personaText.slice(0, PERSONA_MAX_CHARS) : '';
  const scheduleText = typeof input?.scheduleText === 'string' ? input.scheduleText.slice(0, SCHEDULE_MAX_CHARS) : '';
  const city = typeof input?.city === 'string' ? input.city.trim().slice(0, CITY_MAX_CHARS) : '';
  return { personaText, scheduleText, city };
}

export function personaSignalIsEmpty(signal: PersonaSignal): boolean {
  return !signal.personaText.trim() && !signal.scheduleText.trim();
}

/**
 * 人设身份哈希：只在真实文本变化时变。
 * 没有任何文本 → `${charId}:fallback`（明确标成「没有信号」，不是伪造一个人设）。
 */
export function personaHashOf(charId: string, signal: PersonaSignal): string {
  if (personaSignalIsEmpty(signal)) return `${charId}:fallback`;
  return hashString(`${signal.personaText}\n${signal.scheduleText}`);
}

/** 日程 slot 的最小形状（utils/scheduleInjection 的 ScheduleSlot 兼容）。 */
export interface ScheduleSlotLike {
  startTime?: unknown;
  activity?: unknown;
}

const HHMM_RE = /^([01]?\d|2[0-3])[:：]([0-5]\d)$/;

const SLOT_END_LIMIT = 24 * 60;

const toMinutes = (raw: unknown): number | null => {
  if (typeof raw !== 'string') return null;
  const match = HHMM_RE.exec(raw.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

const toHhmm = (minutes: number): string => {
  const clamped = Math.max(0, Math.min(SLOT_END_LIMIT, Math.round(minutes)));
  const hour = Math.floor(clamped / 60);
  const minute = clamped % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

/** 「睡觉」类时段：只有这些才作为作息里的睡眠窗（「起床」不是睡觉）。 */
const SLEEP_SLOT_RE = /睡觉|就寝|入睡|睡眠|休息/;

/**
 * 把真实日程 slots 渲染成 rhythm 能读的日程文本。
 *
 * 规则（确定性）：
 *   1. 按 startTime 升序，同开始时间只留第一条；每条区间是「本条 start → 下一条 start」，
 *      最后一条到 24:00；
 *   2. rhythm 只把**第一段 HH:mm-HH:mm** 当睡眠窗，所以这里显式把「睡觉」时段放在最前：
 *      - 有睡觉时段 → 用它的区间（跨零点时结束 = 次日第一条的 start）；
 *      - 只有起床/洗漱没有睡觉 → 不放作息段（rhythm 词表会自己给保守值），
 *        免得把「07:00-09:00 洗漱」当成睡眠；
 *   3. 输出 `HH:mm-HH:mm 活动`，用「；」连接，最多 12 段。
 */
export function scheduleTextFromSlots(slots: readonly ScheduleSlotLike[] | null | undefined): string {
  if (!Array.isArray(slots) || slots.length === 0) return '';
  const rows: Array<{ start: number; end: number; activity: string }> = [];
  for (const slot of slots) {
    const start = toMinutes(slot?.startTime);
    if (start === null) continue;
    const activity = typeof slot?.activity === 'string' ? slot.activity.trim() : '';
    if (!activity) continue;
    if (activity.length > 40) continue;
    rows.push({ start, end: SLOT_END_LIMIT, activity });
  }
  if (rows.length === 0) return '';
  rows.sort((a, b) => (a.start === b.start ? (a.activity < b.activity ? -1 : 1) : a.start - b.start));
  const seen = new Set<number>();
  const ordered: typeof rows = [];
  for (const row of rows) {
    if (seen.has(row.start)) continue;
    seen.add(row.start);
    ordered.push(row);
  }
  for (let i = 0; i < ordered.length; i += 1) {
    ordered[i].end = i + 1 < ordered.length ? ordered[i + 1].start : SLOT_END_LIMIT;
  }

  const sleepIndex = ordered.findIndex((row) => SLEEP_SLOT_RE.test(row.activity));
  if (sleepIndex < 0) {
    // 没有睡觉时段：不硬造一段睡眠（rhythm 用词表 fallback）。日程本身仍给出去。
    return ordered.slice(0, 12).map((row) => `${toHhmm(row.start)}-${toHhmm(row.end)} ${row.activity}`).join('；');
  }
  const sleep = ordered[sleepIndex];
  // 睡觉是最后一条：结束时刻 = 次日第一条（早上）的开始；否则 = 下一条的开始。
  const sleepEnd = sleepIndex === ordered.length - 1
    ? (ordered[0].start < 12 * 60 ? ordered[0].start : SLOT_END_LIMIT)
    : sleep.end;
  const sleepLine = `${toHhmm(sleep.start)}-${toHhmm(sleepEnd)} 睡觉`;
  const others = ordered.filter((_, index) => index !== sleepIndex).slice(0, 11);
  return [sleepLine, ...others.map((row) => `${toHhmm(row.start)}-${toHhmm(row.end)} ${row.activity}`)].join('；');
}

export interface FireSceneLike {
  /** 这份日程说的是哪一天（角色当地 YYYY-MM-DD）。 */
  dateKey?: unknown;
  schedule?: { slots?: unknown } | null;
}

/**
 * 从 fire_pack 的 scene 里取「今天」的日程文本；跨天的日程整段不用
 * （拿周五的作息表照着周日念就是穿帮，与 AMSG_SLOT_SCENE 同一条门槛）。
 */
export function scheduleTextFromScene(scene: FireSceneLike | null | undefined, todayKey: string): string {
  if (!scene || typeof scene.dateKey !== 'string' || scene.dateKey !== todayKey) return '';
  const slots = scene.schedule?.slots;
  return Array.isArray(slots) ? scheduleTextFromSlots(slots as ScheduleSlotLike[]) : '';
}
