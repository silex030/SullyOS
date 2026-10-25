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

/** 日程里的睡眠窗（结构化的那一份；start/end 是角色当地的 HH:mm，end 可早于 start 表示跨零点）。 */
export interface ScheduleSleepWindow {
  start: string;
  end: string;
}

/** 引擎侧的人设信号：两份真实文本 + 角色真实城市（出行愿望用；空 = 不知道）。 */
export interface PersonaSignal {
  personaText: string;
  scheduleText: string;
  city: string;
  /**
   * 从日程 slots **结构化**推出的睡眠窗（没有明确证据时为 null）。
   *
   * 为什么单独给一份：日程文本是给人看的（「09:00-18:00 上班」），rhythm 如果拿
   * 「第一段 HH:mm-HH:mm」当睡眠，就会把上班时间当睡觉。睡眠窗必须由「活动语义 + 时段」
   * 判定后单独传下去，文本只作为可读投影。
   */
  sleepWindow: ScheduleSleepWindow | null;
}

export const EMPTY_PERSONA_SIGNAL: PersonaSignal = {
  personaText: '',
  scheduleText: '',
  city: '',
  sleepWindow: null,
};

/** rhythm 侧的长度上限（与 buildRhythmProfile 一致，提前截断避免哈希被无关尾部影响）。 */
export const PERSONA_MAX_CHARS = 4000;
export const SCHEDULE_MAX_CHARS = 2000;
export const CITY_MAX_CHARS = 20;

export function normalizePersonaSignal(
  input: { personaText?: unknown; scheduleText?: unknown; city?: unknown; sleepWindow?: unknown } | null | undefined,
): PersonaSignal {
  const personaText = typeof input?.personaText === 'string' ? input.personaText.slice(0, PERSONA_MAX_CHARS) : '';
  const scheduleText = typeof input?.scheduleText === 'string' ? input.scheduleText.slice(0, SCHEDULE_MAX_CHARS) : '';
  const city = typeof input?.city === 'string' ? input.city.trim().slice(0, CITY_MAX_CHARS) : '';
  return { personaText, scheduleText, city, sleepWindow: normalizeSleepWindow(input?.sleepWindow) };
}

/** 睡眠窗形状校验：只接受合法的 HH:mm 且起止不同（其余一律丢掉，不猜）。 */
export function normalizeSleepWindow(raw: unknown): ScheduleSleepWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const start = toMinutes((raw as { start?: unknown }).start);
  const end = toMinutes((raw as { end?: unknown }).end);
  if (start === null || end === null || start === end) return null;
  return { start: toHhmm(start), end: toHhmm(end) };
}

export function personaSignalIsEmpty(
  signal: Pick<PersonaSignal, 'personaText' | 'scheduleText'>,
): boolean {
  return !signal.personaText.trim() && !signal.scheduleText.trim();
}

/**
 * 人设身份哈希：只在真实文本变化时变。
 * 没有任何文本 → `${charId}:fallback`（明确标成「没有信号」，不是伪造一个人设）。
 */
export function personaHashOf(
  charId: string,
  signal: Pick<PersonaSignal, 'personaText' | 'scheduleText'>,
): string {
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

/** 明确的睡眠活动（「休息」不在其中：午休不是整夜睡眠）。 */
const EXPLICIT_SLEEP_RE = /睡觉|就寝|入睡|睡眠|睡下|熟睡|安睡/;

/** 只写了「休息/小憩」的活动：只有落在夜里才可能是睡觉。 */
const REST_SLOT_RE = /休息|小憩|打盹|眯/;

/** 夜里 = 20:00 以后或 06:00 以前（判断「休息」是不是睡觉、以及多个睡眠候选的优先级）。 */
const isNightish = (minuteOfDay: number): boolean => minuteOfDay >= 20 * 60 || minuteOfDay <= 6 * 60;

interface ScheduleRow {
  start: number;
  end: number;
  activity: string;
}

/**
 * slots → 有序行（start/end 为当地分钟；end 可以 > 1440 表示跨到次日）。
 * 没有 startTime / 没有活动 / 活动过长 / 重复开始时间 → 丢掉（确定性，不猜）。
 */
function scheduleRows(slots: readonly ScheduleSlotLike[] | null | undefined): ScheduleRow[] {
  if (!Array.isArray(slots) || slots.length === 0) return [];
  const rows: ScheduleRow[] = [];
  for (const slot of slots) {
    const start = toMinutes(slot?.startTime);
    if (start === null) continue;
    const activity = typeof slot?.activity === 'string' ? slot.activity.trim() : '';
    if (!activity) continue;
    if (activity.length > 40) continue;
    rows.push({ start, end: SLOT_END_LIMIT, activity });
  }
  if (rows.length === 0) return [];
  rows.sort((a, b) => (a.start === b.start ? (a.activity < b.activity ? -1 : 1) : a.start - b.start));
  const seen = new Set<number>();
  const ordered: ScheduleRow[] = [];
  for (const row of rows) {
    if (seen.has(row.start)) continue;
    seen.add(row.start);
    ordered.push(row);
  }
  for (let i = 0; i < ordered.length; i += 1) {
    ordered[i].end = i + 1 < ordered.length ? ordered[i + 1].start : SLOT_END_LIMIT;
  }
  return ordered;
}

/**
 * 从日程 slots **结构化**推导睡眠窗。
 *
 * 规则（确定性）：
 *   1. 候选 = 明确写了「睡觉/就寝/入睡/睡眠…」的时段；「休息/小憩」只有在夜里
 *      （20:00–06:00）才算候选 —— 午休永远不会被当成整夜睡眠；
 *   2. 有明确睡眠时段时优先于「夜里休息」；同类里优先夜里、再优先更长的；
 *   3. 结束时刻 = 下一条的 start；跨零点时 +24h；睡眠是最后一条时用次日第一条（早上）
 *      的 start 作为起床时间；
 *   4. 推不出结束（最后一条且没有早间锚点，或时长不足 1 小时）→ 返回 null，
 *      由 rhythm 的人设词表/保守值兜底，**不硬造一段睡眠**。
 */
export function sleepWindowFromSlots(
  slots: readonly ScheduleSlotLike[] | null | undefined,
): ScheduleSleepWindow | null {
  const rows = scheduleRows(slots);
  if (rows.length === 0) return null;

  const candidates = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => EXPLICIT_SLEEP_RE.test(row.activity)
      || (REST_SLOT_RE.test(row.activity) && isNightish(row.start)));
  if (candidates.length === 0) return null;

  const explicit = (row: ScheduleRow): number => (EXPLICIT_SLEEP_RE.test(row.activity) ? 1 : 0);
  const duration = (row: ScheduleRow): number => (row.end > row.start ? row.end - row.start : row.end + SLOT_END_LIMIT - row.start);
  candidates.sort((a, b) => (
    explicit(b.row) - explicit(a.row)
    || Number(isNightish(b.row.start)) - Number(isNightish(a.row.start))
    || duration(b.row) - duration(a.row)
    || a.row.start - b.row.start
  ));

  const { row, index } = candidates[0];
  let end: number;
  if (index + 1 < rows.length) {
    end = rows[index + 1].start;
    if (end <= row.start) end += SLOT_END_LIMIT;
  } else {
    const nextMorning = rows[0].start;
    // 最后一条是睡眠：起床时间来自「次日第一条早间活动」；没有早间锚点就不猜结束时刻。
    if (nextMorning > row.start || nextMorning > 12 * 60) return null;
    end = nextMorning + SLOT_END_LIMIT;
  }
  // 时长不足 1 小时的「睡觉」多半是写错了（或只是打个盹），不当整夜睡眠。
  if (end - row.start < 60) return null;
  return { start: toHhmm(row.start), end: toHhmm(end % SLOT_END_LIMIT) };
}

/**
 * 把真实日程 slots 渲染成 rhythm / 界面能读的日程文本。
 *
 * 规则（确定性）：
 *   1. 按 startTime 升序，同开始时间只留第一条；每条区间是「本条 start → 下一条 start」，
 *      最后一条到 24:00；
 *   2. 有睡眠窗（见 sleepWindowFromSlots）时把那一行放到最前并标注「睡觉」，
 *      让人一眼看到作息；否则按时间顺序原样给出 —— 普通上班/起床/午休**不会**
 *      被写成睡眠；
 *   3. 输出 `HH:mm-HH:mm 活动`，用「；」连接，最多 12 段。
 */
export function scheduleTextFromSlots(slots: readonly ScheduleSlotLike[] | null | undefined): string {
  const ordered = scheduleRows(slots);
  if (ordered.length === 0) return '';
  const sleep = sleepWindowFromSlots(slots);
  const lines = ordered.slice(0, 12).map((row) => `${toHhmm(row.start)}-${toHhmm(row.end)} ${row.activity}`);
  if (!sleep) return lines.join('；');

  // 睡眠行：标注「睡觉」，放在最前（文本是给人看的投影，睡眠窗本身已结构化传出）。
  const sleepLine = `${sleep.start}-${sleep.end} 睡觉`;
  const sleepStart = toMinutes(sleep.start);
  const others = ordered
    .filter((row) => row.start !== sleepStart)
    .slice(0, 11)
    .map((row) => `${toHhmm(row.start)}-${toHhmm(row.end)} ${row.activity}`);
  return [sleepLine, ...others].join('；');
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

/** 今天日程的结构化睡眠窗（与 scheduleTextFromScene 同一份 slots 与同一条跨天门槛）。 */
export function sleepWindowFromScene(
  scene: FireSceneLike | null | undefined,
  todayKey: string,
): ScheduleSleepWindow | null {
  if (!scene || typeof scene.dateKey !== 'string' || scene.dateKey !== todayKey) return null;
  const slots = scene.schedule?.slots;
  return Array.isArray(slots) ? sleepWindowFromSlots(slots as ScheduleSlotLike[]) : null;
}
