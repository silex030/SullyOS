/**
 * rhythm-v1：人设驱动的拟真调度（**确定性**，普通 tick 不调用模型）。
 *
 * 分工（契约 §3.1–§3.4）：
 *   - 人设/日程 → RhythmProfile：只在人设改、时区改、摘要显著变更时失效重建；
 *     不做结构化模型提取时用确定性保守回退（23:00–08:00 睡、其余分晨/午/晚），
 *     并明确标「暂用基础作息」，不假装已经理解其人设。
 *   - 需求向量 need[k] 按**真实流逝时间**更新，离线 elapsed 最多计入一个本地日，
 *     所以「离线一天回来」不会堆出十几轮补跑。
 *   - 候选打分 = 特质亲和 + 需求 + 时段契合 + 情境 + 互动 + 有界噪声 − 重复惩罚 − 近期失败惩罚；
 *     噪声绝对值 ≤ 0.10，不能越过任何硬闸；同一机会重启重算不重新抽奖。
 *   - nextOpportunityAt：每次只按当前快照求一次并持久化；落在阶段窗口内，需求低就直接
 *     跳到下一阶段（不保证每个时段都有行动）。
 *
 * 本文件零 IO、零模型、零 Date.now()：时钟与随机源都由调用方注入，测试可完全复现。
 */

import type { ActivityKind } from '../../contracts/autonomyLife';
import { hashString, hashArgs } from '../../contracts/autonomyLife';
import {
  createRng,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  hhmmToMinutes,
  isWithinWindow,
  normalizeTimeZone,
  opportunityId as makeOpportunityId,
  zonedParts,
  type Rng,
} from './time';

export const RHYTHM_VERSION = 'rhythm-v1' as const;

export interface TraitVector {
  sociability: number;
  curiosity: number;
  orderliness: number;
  impulsiveness: number;
}

export interface SleepWindow {
  start: string; // HH:mm
  end: string;   // HH:mm
}

export type PhaseName = 'morning' | 'noon' | 'evening' | 'night';

export interface PhasePreferences {
  morning: number;
  noon: number;
  evening: number;
  night: number;
}

export type ScheduleConfidence = 'fallback' | 'persona';

export interface RhythmProfile {
  version: typeof RHYTHM_VERSION;
  personaHash: string;
  timezone: string;
  sleepWindows: SleepWindow[];
  phasePreferences: PhasePreferences;
  interestTags: string[];
  traits: TraitVector;
  confidence: ScheduleConfidence;
  source: 'persona_extract' | 'deterministic_fallback';
  generatedAt: number;
  /** 日程 revision：变了才允许重算机会（否则同一次机会的 id 会漂）。 */
  scheduleRevision: string;
  /** 人设摘要哈希：摘要显著变更时 profile 失效。 */
  summaryHash: string;
}

export const CONSERVATIVE_SLEEP: SleepWindow = { start: '23:00', end: '08:00' };

export const DEFAULT_PHASE_PREFERENCES: PhasePreferences = {
  morning: 0.5,
  noon: 0.5,
  evening: 0.55,
  night: 0.45,
};

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

const countHits = (text: string, words: readonly string[]): number =>
  words.reduce((sum, word) => (text.includes(word) ? sum + 1 : sum), 0);

const OUTGOING_WORDS = ['外向', '活泼', '健谈', '开朗', '社牛', '爱社交', '话多', '热闹', '喜欢认识'];
const RESERVED_WORDS = ['内向', '安静', '寡言', '社恐', '怕生', '独来独往', '不爱说话', '慢热'];
const CURIOUS_WORDS = ['好奇', '喜欢尝试', '爱研究', '求知', '探索', '爱看书', '刷到'];
const ORDERLY_WORDS = ['有条理', '爱整理', '规律', '自律', '清单', '计划性强', '整洁'];
const IMPULSIVE_WORDS = ['冲动', '随性', '想到就做', '任性', '反复无常', '三分钟热度'];
const NIGHT_WORDS = ['夜猫', '熬夜', '深夜', '晚睡', '凌晨'];
const MORNING_WORDS = ['早起', '晨型', '早睡早起', '清晨', '早餐'];
const INTEREST_HINTS = [
  '美食', '咖啡', '奶茶', '甜点', '音乐', '电影', '游戏', '读书', '小说', '摄影', '旅行', '运动',
  '健身', '猫', '狗', '植物', '手账', '穿搭', '天文', '编程', '动漫', '戏剧', '绘画', '书法',
];

const TIME_RANGE_RE = /([01]?\d|2[0-3])[:：]([0-5]\d)\s*[-–~至到]\s*([01]?\d|2[0-3])[:：]([0-5]\d)/;

const pad = (value: number): string => String(value).padStart(2, '0');

export interface BuildProfileInput {
  personaText?: string;
  scheduleText?: string;
  timezone: string;
  personaHash: string;
  nowMs: number;
  /** 可选：模型结构化提取结果（必须经过 schema 校验；字段只能是这里的形状）。 */
  extracted?: Partial<{
    sleepWindows: SleepWindow[];
    phasePreferences: PhasePreferences;
    interestTags: string[];
    traits: TraitVector;
  }>;
}

/**
 * 建 profile：先用确定性规则解析人设/日程，只有在 extracted 通过校验时才覆盖。
 * 没有任何可用信号 → confidence='fallback'（UI 文案「暂用基础作息」）。
 */
export function buildRhythmProfile(input: BuildProfileInput): RhythmProfile {
  const personaText = (input.personaText ?? '').slice(0, 4000);
  const scheduleText = (input.scheduleText ?? '').slice(0, 2000);
  const combined = `${personaText}\n${scheduleText}`;

  const outgoing = countHits(combined, OUTGOING_WORDS);
  const reserved = countHits(combined, RESERVED_WORDS);
  const curious = countHits(combined, CURIOUS_WORDS);
  const orderly = countHits(combined, ORDERLY_WORDS);
  const impulsive = countHits(combined, IMPULSIVE_WORDS);
  const night = countHits(combined, NIGHT_WORDS);
  const morning = countHits(combined, MORNING_WORDS);

  const baseTraits: TraitVector = {
    sociability: clamp01(0.5 + 0.12 * outgoing - 0.12 * reserved),
    curiosity: clamp01(0.5 + 0.1 * curious),
    orderliness: clamp01(0.5 + 0.1 * orderly),
    impulsiveness: clamp01(0.5 + 0.1 * impulsive),
  };

  const sleepWindows: SleepWindow[] = [];
  const rangeMatch = TIME_RANGE_RE.exec(scheduleText || personaText);
  if (rangeMatch) {
    const start = `${pad(Number(rangeMatch[1]))}:${rangeMatch[2]}`;
    const end = `${pad(Number(rangeMatch[3]))}:${rangeMatch[4]}`;
    if (hhmmToMinutes(start) !== null && hhmmToMinutes(end) !== null && start !== end) {
      sleepWindows.push({ start, end });
    }
  }
  if (!sleepWindows.length) {
    if (night > morning) sleepWindows.push({ start: '01:30', end: '09:30' });
    else if (morning > night) sleepWindows.push({ start: '22:30', end: '06:30' });
    else sleepWindows.push({ ...CONSERVATIVE_SLEEP });
  }

  const interestTags = INTEREST_HINTS.filter((tag) => combined.includes(tag)).slice(0, 8);

  const personaSignals = outgoing + reserved + curious + orderly + impulsive + night + morning + interestTags.length;
  const confidence: ScheduleConfidence = personaSignals > 0 ? 'persona' : 'fallback';

  let profile: RhythmProfile = {
    version: RHYTHM_VERSION,
    personaHash: input.personaHash,
    timezone: normalizeTimeZone(input.timezone),
    sleepWindows,
    phasePreferences: {
      morning: clamp01(DEFAULT_PHASE_PREFERENCES.morning + 0.1 * morning - 0.08 * night),
      noon: DEFAULT_PHASE_PREFERENCES.noon,
      evening: clamp01(DEFAULT_PHASE_PREFERENCES.evening + 0.05 * outgoing),
      night: clamp01(DEFAULT_PHASE_PREFERENCES.night + 0.12 * night - 0.08 * morning),
    },
    interestTags,
    traits: baseTraits,
    confidence,
    source: confidence === 'persona' ? 'persona_extract' : 'deterministic_fallback',
    generatedAt: input.nowMs,
    scheduleRevision: hashString(`${input.personaHash}|${input.timezone}|${scheduleText.length}`),
    summaryHash: hashString(combined),
  };

  if (input.extracted) {
    const ext = input.extracted;
    if (Array.isArray(ext.sleepWindows)) {
      const valid = ext.sleepWindows
        .filter((w) => w && hhmmToMinutes(w.start) !== null && hhmmToMinutes(w.end) !== null && w.start !== w.end)
        .slice(0, 3);
      if (valid.length) profile = { ...profile, sleepWindows: valid };
    }
    if (ext.phasePreferences) {
      profile = {
        ...profile,
        phasePreferences: {
          morning: clamp01(ext.phasePreferences.morning),
          noon: clamp01(ext.phasePreferences.noon),
          evening: clamp01(ext.phasePreferences.evening),
          night: clamp01(ext.phasePreferences.night),
        },
      };
    }
    if (Array.isArray(ext.interestTags)) {
      profile = { ...profile, interestTags: ext.interestTags.filter((t) => typeof t === 'string').slice(0, 8) };
    }
    if (ext.traits) {
      profile = {
        ...profile,
        traits: {
          sociability: clamp01(ext.traits.sociability),
          curiosity: clamp01(ext.traits.curiosity),
          orderliness: clamp01(ext.traits.orderliness),
          impulsiveness: clamp01(ext.traits.impulsiveness),
        },
      };
    }
  }
  return profile;
}

/** profile 只在人设改、时区改、摘要显著变更时失效；普通 tick 不动它。 */
export function isProfileStale(
  profile: RhythmProfile | null,
  input: { personaHash: string; timezone: string; summaryHash: string },
): boolean {
  if (!profile) return true;
  if (profile.version !== RHYTHM_VERSION) return true;
  if (profile.personaHash !== input.personaHash) return true;
  if (normalizeTimeZone(profile.timezone) !== normalizeTimeZone(input.timezone)) return true;
  return profile.summaryHash !== input.summaryHash;
}

// ─── 阶段与需求 ─────────────────────────────────────────────────────────────

export interface PhaseWindow {
  phase: PhaseName;
  startMs: number;
  endMs: number;
}

const PHASE_RANGES: Record<PhaseName, { start: string; end: string }> = {
  morning: { start: '08:00', end: '11:30' },
  noon: { start: '11:30', end: '17:00' },
  evening: { start: '17:00', end: '22:00' },
  night: { start: '22:00', end: '23:59' },
};

export function isAsleep(profile: RhythmProfile, nowMs: number): boolean {
  const parts = zonedParts(nowMs, profile.timezone);
  return profile.sleepWindows.some((window) => {
    const start = hhmmToMinutes(window.start);
    const end = hhmmToMinutes(window.end);
    if (start === null || end === null) return false;
    return isWithinWindow(parts.minuteOfDay, start, end);
  });
}

/** 当前阶段（睡眠 → resting；其余按当地小时切晨/午/晚/夜）。 */
export function resolvePhase(profile: RhythmProfile, nowMs: number): { phase: PhaseName | 'resting'; minuteOfDay: number } {
  const parts = zonedParts(nowMs, profile.timezone);
  if (isAsleep(profile, nowMs)) return { phase: 'resting', minuteOfDay: parts.minuteOfDay };
  const order: PhaseName[] = ['morning', 'noon', 'evening', 'night'];
  for (const phase of order) {
    const start = hhmmToMinutes(PHASE_RANGES[phase].start)!;
    const end = hhmmToMinutes(PHASE_RANGES[phase].end)!;
    if (parts.minuteOfDay >= start && parts.minuteOfDay < end) return { phase, minuteOfDay: parts.minuteOfDay };
  }
  // 落在 23:59–00:00 或阶段之间的空隙：算夜间。
  return { phase: 'night', minuteOfDay: parts.minuteOfDay };
}

export type NeedKey = 'social' | 'record' | 'tidy' | 'food' | 'interest';

export interface NeedVector {
  social: number;
  record: number;
  tidy: number;
  food: number;
  interest: number;
}

export const NEED_KEYS: readonly NeedKey[] = ['social', 'record', 'tidy', 'food', 'interest'];

export const INITIAL_NEEDS: NeedVector = { social: 0.3, record: 0.3, tidy: 0.25, food: 0.2, interest: 0.3 };

/** 每小时基础增长速度（人设特质只调权重，不改「上限 1」这条）。 */
const NEED_GROWTH_PER_HOUR: Record<NeedKey, number> = {
  social: 0.11,
  record: 0.09,
  tidy: 0.06,
  food: 0.16,
  interest: 0.08,
};

export interface UpdateNeedsInput {
  elapsedMs: number;
  phase: PhaseName | 'resting';
  traits: TraitVector;
  /** 距上次用户互动多久（影响 social 需求：刚聊完就不那么想发消息）。 */
  sinceInteractionMs?: number;
}

/** 无模型需求更新：真实流逝时间 + 阶段 + 特质；elapsed 封顶一个本地日。 */
export function updateNeeds(prev: NeedVector, input: UpdateNeedsInput): NeedVector {
  const cappedElapsed = Math.min(Math.max(0, input.elapsedMs), DAY_MS);
  const hours = cappedElapsed / HOUR_MS;
  const phaseBoost: Record<PhaseName | 'resting', number> = {
    morning: 0.9,
    noon: 1.0,
    evening: 1.1,
    night: 0.8,
    resting: 0.35,
  };
  const boost = phaseBoost[input.phase];
  const next = { ...prev } as NeedVector;
  for (const key of NEED_KEYS) {
    let rate = NEED_GROWTH_PER_HOUR[key] * boost * hours;
    if (key === 'social') {
      rate *= 0.7 + 0.6 * input.traits.sociability;
      if (typeof input.sinceInteractionMs === 'number' && input.sinceInteractionMs < 10 * MINUTE_MS) rate *= 0.4;
    }
    if (key === 'record') rate *= 0.8 + 0.5 * input.traits.orderliness;
    if (key === 'tidy') rate *= 0.7 + 0.7 * input.traits.orderliness;
    if (key === 'interest') rate *= 0.8 + 0.6 * input.traits.curiosity;
    next[key] = clamp01(prev[key] + rate);
  }
  return next;
}

/** 成功做过一次之后降需求（并记录饱和度，供 repeatPenalty 使用）。 */
export function applyActivitySuccess(needs: NeedVector, kind: ActivityKind): NeedVector {
  const drop: Partial<Record<ActivityKind, Partial<Record<NeedKey, number>>>> = {
    'journal.write': { record: 0.35 },
    'room.plan': { tidy: 0.3 },
    'room.note': { record: 0.2, tidy: 0.1 },
    'phone.record': { social: 0.25, record: 0.1 },
    'takeout.order': { food: 0.45 },
    'shopping.order': { food: 0.25, interest: 0.1 },
    'interaction.message': { social: 0.4 },
    'travel.wish': { interest: 0.2 },
    'external.read': { interest: 0.3 },
  };
  const next = { ...needs } as NeedVector;
  for (const [key, value] of Object.entries(drop[kind] ?? {})) {
    const needKey = key as NeedKey;
    next[needKey] = clamp01(next[needKey] - (value as number));
  }
  return next;
}

// ─── 候选打分 ───────────────────────────────────────────────────────────────

export interface Candidate {
  kind: ActivityKind;
  /** 语义目的（同类去重键）：同一角色同一日同一 semanticPurpose 只产生一个主动动作。 */
  semanticPurpose: string;
  /** 内容指纹的补充材料（商品组合、标题等），不只看原文字符串。 */
  contentFingerprint?: string;
  interestTags?: string[];
  /**
   * 该 kind 的封闭参数（由受控模型出口按 schema 生成）。引擎只做选择与校验，
   * 不会替模型编内容；缺失时执行侧会因缺必填字段拒绝（不假装完成）。
   */
  args?: Record<string, unknown>;
}

export interface RecentActivity {
  kind: ActivityKind;
  semanticPurpose: string;
  contentFingerprint?: string;
  occurredAt: number;
  success: boolean;
}

export interface ScoreInput {
  candidate: Candidate;
  profile: RhythmProfile;
  needs: NeedVector;
  phase: PhaseName | 'resting';
  /** 情境：设备/凭据是否可用、是否刚被拒。 */
  contextFit?: number;
  /** 互动状态：用户刚聊完 → 消息类候选降权。 */
  interactionFit?: number;
  recent: RecentActivity[];
  nowMs: number;
  tz: string;
  rng: Rng;
  recentFailurePenalty?: number;
}

const KIND_TRAIT_WEIGHTS: Record<ActivityKind, Partial<Record<keyof TraitVector, number>>> = {
  'journal.write': { orderliness: 0.6, curiosity: 0.4 },
  'room.plan': { orderliness: 0.9 },
  'room.note': { orderliness: 0.4, curiosity: 0.4 },
  'phone.record': { sociability: 0.8, impulsiveness: 0.2 },
  'takeout.order': { impulsiveness: 0.6, orderliness: 0.2 },
  'shopping.order': { impulsiveness: 0.5, curiosity: 0.3 },
  'interaction.message': { sociability: 1.0 },
  'travel.wish': { curiosity: 0.8, impulsiveness: 0.3 },
  'external.read': { curiosity: 1.0 },
};

const KIND_NEED_WEIGHT: Record<ActivityKind, Partial<Record<NeedKey, number>>> = {
  'journal.write': { record: 1.0 },
  'room.plan': { tidy: 1.0 },
  'room.note': { record: 0.5, tidy: 0.5 },
  'phone.record': { social: 0.9, record: 0.3 },
  'takeout.order': { food: 1.0 },
  'shopping.order': { food: 0.5, interest: 0.5 },
  'interaction.message': { social: 1.0 },
  'travel.wish': { interest: 0.8 },
  'external.read': { interest: 1.0 },
};

const KIND_PHASE_FIT: Record<ActivityKind, Partial<Record<PhaseName | 'resting', number>>> = {
  'journal.write': { night: 0.9, evening: 0.8, morning: 0.5, noon: 0.4, resting: 0.1 },
  'room.plan': { morning: 0.9, evening: 0.6, noon: 0.5, night: 0.3, resting: 0.1 },
  'room.note': { evening: 0.7, night: 0.6, noon: 0.5, morning: 0.5, resting: 0.1 },
  'phone.record': { evening: 0.8, noon: 0.7, night: 0.6, morning: 0.4, resting: 0.1 },
  'takeout.order': { noon: 0.9, evening: 0.9, morning: 0.5, night: 0.4, resting: 0.05 },
  'shopping.order': { evening: 0.7, noon: 0.6, morning: 0.5, night: 0.5, resting: 0.05 },
  'interaction.message': { evening: 0.7, night: 0.65, noon: 0.6, morning: 0.55, resting: 0.05 },
  'travel.wish': { morning: 0.6, noon: 0.6, evening: 0.7, night: 0.4, resting: 0.05 },
  'external.read': { evening: 0.7, night: 0.7, noon: 0.5, morning: 0.5, resting: 0.05 },
};

const traitAffinity = (candidate: Candidate, traits: TraitVector): number => {
  const weights = KIND_TRAIT_WEIGHTS[candidate.kind] ?? {};
  let sum = 0;
  let total = 0;
  for (const [key, weight] of Object.entries(weights)) {
    sum += traits[key as keyof TraitVector] * (weight as number);
    total += weight as number;
  }
  return total === 0 ? 0.5 : clamp01(sum / total);
};

const needAffinity = (candidate: Candidate, needs: NeedVector): number => {
  const weights = KIND_NEED_WEIGHT[candidate.kind] ?? {};
  let sum = 0;
  let total = 0;
  for (const [key, weight] of Object.entries(weights)) {
    sum += needs[key as NeedKey] * (weight as number);
    total += weight as number;
  }
  return total === 0 ? 0 : clamp01(sum / total);
};

/** 内容指纹：语义目的 + 内容摘要哈希（不是原文字符串比较）。 */
export function fingerprintOf(candidate: Candidate): string {
  return hashString(`${candidate.kind}|${candidate.semanticPurpose}|${candidate.contentFingerprint ?? ''}`);
}

export function repeatPenalty(
  candidate: Candidate,
  recent: RecentActivity[],
  nowMs: number,
): number {
  const fp = fingerprintOf(candidate);
  const sameKind = recent.filter((item) => item.kind === candidate.kind);
  let penalty = 0;
  if (sameKind.some((item) => item.semanticPurpose === candidate.semanticPurpose)) penalty += 0.6;
  if (sameKind.some((item) => fingerprintOf(item) === fp)) penalty += 0.2;
  // 最近十个同类指纹里出现过就再扣一点（软性饱和，不是硬去重）。
  const lastTen = sameKind.slice(0, 10);
  if (lastTen.some((item) => fingerprintOf(item) === fp)) penalty += 0.15;
  // 今天的同类动作越频繁越不想做。
  const dayAgo = nowMs - DAY_MS;
  const todayCount = sameKind.filter((item) => item.occurredAt >= dayAgo).length;
  penalty += Math.min(0.3, todayCount * 0.08);
  return Math.min(1, penalty);
}

export const BOUNDED_NOISE = 0.1;

export interface ScoredCandidate {
  candidate: Candidate;
  score: number;
  parts: {
    traitAffinity: number;
    need: number;
    phaseFit: number;
    contextFit: number;
    interactionFit: number;
    noise: number;
    repeatPenalty: number;
    recentFailurePenalty: number;
  };
}

export function scoreCandidate(input: ScoreInput): ScoredCandidate {
  const trait = traitAffinity(input.candidate, input.profile.traits);
  const need = needAffinity(input.candidate, input.needs);
  const phaseFit = KIND_PHASE_FIT[input.candidate.kind]?.[input.phase] ?? 0.2;
  const interestBoost = (input.candidate.interestTags ?? []).some((tag) => input.profile.interestTags.includes(tag))
    ? 0.1
    : 0;
  const contextFit = clamp01(input.contextFit ?? 0.6) + interestBoost;
  const interactionFit = clamp01(input.interactionFit ?? 0.5);
  // 噪声绝对上界 0.10：不能越过任何硬闸，只能在同一批候选里打破平局。
  const noise = Math.max(-BOUNDED_NOISE, Math.min(BOUNDED_NOISE, input.rng.noise(BOUNDED_NOISE)));
  const repeat = repeatPenalty(input.candidate, input.recent, input.nowMs);
  const failure = clamp01(input.recentFailurePenalty ?? 0);
  const score =
    0.3 * trait + 0.3 * need + 0.18 * phaseFit + 0.12 * contextFit + 0.1 * interactionFit
    + noise - 0.45 * repeat - 0.3 * failure;
  return {
    candidate: input.candidate,
    score,
    parts: {
      traitAffinity: trait,
      need,
      phaseFit,
      contextFit,
      interactionFit,
      noise,
      repeatPenalty: repeat,
      recentFailurePenalty: failure,
    },
  };
}

export interface ChooseActivityInput extends Omit<ScoreInput, 'candidate' | 'rng'> {
  candidates: Candidate[];
  /** 允许的 kind（来自生效边界）；不在其中的候选连打分的资格都没有。 */
  allowedKinds: ActivityKind[];
  rng: Rng;
  /** 最低分数线：太低就干脆休息，不补「任务量」。 */
  minScore?: number;
}

export interface ChosenActivity {
  kind: ActivityKind;
  semanticPurpose: string;
  purposeKey: string;
  score: number;
  reasonSummary: string;
  candidate: Candidate;
}

/** 选出这一轮要做的动作（或 null = 自然休息）。 */
export function chooseActivity(input: ChooseActivityInput): ChosenActivity | null {
  const allowed = input.candidates.filter((candidate) => input.allowedKinds.includes(candidate.kind));
  if (!allowed.length) return null;
  const scored = allowed
    .map((candidate) => scoreCandidate({ ...input, candidate }))
    .sort((a, b) => (b.score === a.score ? (a.candidate.kind < b.candidate.kind ? -1 : 1) : b.score - a.score));
  const best = scored[0];
  const minScore = input.minScore ?? 0.12;
  if (!best || best.score < minScore) return null;
  const reasonSummary = describeReason(best, input.profile, input.needs);
  return {
    kind: best.candidate.kind,
    semanticPurpose: best.candidate.semanticPurpose,
    purposeKey: hashString(`${best.candidate.kind}|${best.candidate.semanticPurpose}`),
    score: Number(best.score.toFixed(4)),
    reasonSummary,
    candidate: best.candidate,
  };
}

/** 可见的人设/情境依据摘要（不输出隐含推理，不把模拟经历标成 observation）。 */
export function describeReason(scored: ScoredCandidate, profile: RhythmProfile, needs: NeedVector): string {
  const reasons: string[] = [];
  const dominantNeed = NEED_KEYS.reduce((best, key) => (needs[key] > needs[best] ? key : best), NEED_KEYS[0]);
  const needLabels: Record<NeedKey, string> = {
    social: '想和人说说话',
    record: '想把今天记下来',
    tidy: '想把房间和计划理一理',
    food: '有点想吃点东西',
    interest: '想刷点自己感兴趣的东西',
  };
  reasons.push(needLabels[dominantNeed]);
  if (profile.confidence === 'persona') reasons.push('按人设作息');
  else reasons.push('暂用基础作息');
  if (scored.parts.phaseFit >= 0.6) reasons.push('这个时段正合适');
  return reasons.join('，');
}

// ─── 下次时机 ───────────────────────────────────────────────────────────────

export interface PlanOpportunityInput {
  profile: RhythmProfile;
  needs: NeedVector;
  nowMs: number;
  /** 安装级种子（持久化），与角色/日程 revision 一起派生随机源。 */
  seed: string;
  charId: string;
  /** 安全保底：任意两次自主模型请求实际开始至少间隔 30 分钟。 */
  minGapMs?: number;
  /** 上一次机会的 id（重启时用同一窗口起点即可复现，不必真传）。 */
  lastOpportunityAt?: number;
}

export interface OpportunityPlan {
  opportunityId: string;
  nextOpportunityAt: number;
  lifePhase: PhaseName | 'resting';
  /** 需求太低 → 直接跳到下一阶段。 */
  skippedPhase: boolean;
  nextCheckAt: number;
  window: PhaseWindow;
}

export const DEFAULT_MIN_GAP_MS = 30 * MINUTE_MS;

/** 需求整体很低：干脆休息，不保证每个时段都行动。 */
export function needsAreLow(needs: NeedVector): boolean {
  return NEED_KEYS.every((key) => needs[key] < 0.25);
}

/** 由 profile 的睡眠窗与阶段表拼出当前/下一个阶段的墙上时间窗口。 */
export function currentPhaseWindow(profile: RhythmProfile, nowMs: number): PhaseWindow {
  const { phase } = resolvePhase(profile, nowMs);
  const parts = zonedParts(nowMs, profile.timezone);
  const dayStartMs = nowMs - ((parts.hour * 60 + parts.minute) * MINUTE_MS);
  if (phase === 'resting') {
    // 醒来的时刻 = 睡眠窗结束；若睡眠跨零点，结束时刻在「今天」。
    const sleep = profile.sleepWindows[0];
    const endMinutes = hhmmToMinutes(sleep?.end ?? '08:00') ?? 8 * 60;
    const endMs = dayStartMs + endMinutes * MINUTE_MS;
    const startMs = endMs > nowMs ? nowMs : endMs + DAY_MS;
    const startMinutes = hhmmToMinutes(PHASE_RANGES.morning.start) ?? 8 * 60;
    return { phase: 'morning', startMs: Math.max(startMs, dayStartMs + startMinutes * MINUTE_MS), endMs: dayStartMs + (hhmmToMinutes(PHASE_RANGES.morning.end) ?? 690) * MINUTE_MS };
  }
  const range = PHASE_RANGES[phase as PhaseName];
  return {
    phase: phase as PhaseName,
    startMs: dayStartMs + (hhmmToMinutes(range.start) ?? 0) * MINUTE_MS,
    endMs: dayStartMs + (hhmmToMinutes(range.end) ?? 0) * MINUTE_MS,
  };
}

/**
 * 求下一次机会。同一次机会（同一窗口起点 + 同一 schedule revision + 同一 seed）
 * 无论重算多少次、重启多少次，结果完全一致——随机源是派生的，不是现场抽的。
 */
export function planNextOpportunity(input: PlanOpportunityInput): OpportunityPlan {
  const { profile, needs, nowMs, seed, charId } = input;
  const minGap = input.minGapMs ?? DEFAULT_MIN_GAP_MS;
  const { phase } = resolvePhase(profile, nowMs);
  const window = currentPhaseWindow(profile, nowMs);
  const windowStart = window.startMs;
  const rng = createRng('opportunity-at', seed, charId, profile.scheduleRevision, windowStart);

  const opportunityId = makeOpportunityId({
    seed,
    charId,
    scheduleRevision: profile.scheduleRevision,
    windowStartMs: windowStart,
  });

  const skip = needsAreLow(needs);
  const windowLength = Math.max(MINUTE_MS, window.endMs - windowStart);
  // 需求越高越早（但永远留在窗口内）；skip 时直接落到下一阶段起点。
  const dominant = NEED_KEYS.reduce((best, key) => (needs[key] > needs[best] ? key : best), NEED_KEYS[0]);
  const urgency = clamp01(needs[dominant]);
  const baseRatio = skip ? 1 : Math.max(0.08, 0.75 - 0.55 * urgency);
  const jitterRatio = (rng.next() - 0.5) * 0.12; // 窗口内截断采样
  const ratio = Math.min(0.95, Math.max(0.02, baseRatio + jitterRatio));

  let nextOpportunityAt = Math.floor(windowStart + windowLength * ratio);
  if (phase === 'resting' && !skip) {
    // 睡着时不排动作：醒来后的第一个窗口再说。
    nextOpportunityAt = Math.max(nextOpportunityAt, window.startMs);
  }
  const floor = nowMs + (input.lastOpportunityAt ? minGap : 0) + (skip ? 0 : 0);
  nextOpportunityAt = Math.max(nextOpportunityAt, Math.min(floor, window.endMs - MINUTE_MS));

  return {
    opportunityId,
    nextOpportunityAt,
    lifePhase: skip ? 'resting' : phase,
    skippedPhase: skip,
    nextCheckAt: Math.min(nextOpportunityAt, nowMs + 30 * MINUTE_MS),
    window,
  };
}

/** 日记/整理/记录/消息的基础冷却（部署内常量，UI 只读，不可被随机性放宽）。 */
export const BASE_KIND_COOLDOWN_MS: Record<string, number> = {
  'journal.write': 6 * HOUR_MS,
  'room.plan': 2 * HOUR_MS,
  'room.note': 2 * HOUR_MS,
  'phone.record': 2 * HOUR_MS,
  'interaction.message': 1 * HOUR_MS,
  'takeout.order': 2 * HOUR_MS,
  'shopping.order': 2 * HOUR_MS,
  'travel.wish': 3 * HOUR_MS,
  'external.read': 2 * HOUR_MS,
};

export const MODEL_REQUEST_MIN_GAP_MS = 30 * MINUTE_MS;

/** 冷却是否允许现在开始这个 kind（预算只能更严，不能更松）。 */
export function withinKindCooldown(
  recent: RecentActivity[],
  kind: string,
  nowMs: number,
  cooldownMs: number = BASE_KIND_COOLDOWN_MS[kind] ?? 2 * HOUR_MS,
): boolean {
  const last = recent.find((item) => item.kind === kind && item.success);
  if (!last) return false;
  return nowMs - last.occurredAt < cooldownMs;
}

/** 同一角色同一日本地日、同一 semanticPurpose 只产生一个主动动作。 */
export function alreadyProducedToday(args: {
  recent: RecentActivity[];
  semanticPurpose: string;
  nowMs: number;
  tz: string;
}): boolean {
  const today = zonedParts(args.nowMs, args.tz).dateKey;
  return args.recent.some(
    (item) => item.success && item.semanticPurpose === args.semanticPurpose
      && zonedParts(item.occurredAt, args.tz).dateKey === today,
  );
}

/** 候选的内容指纹（去重键的补充，不只看原文字符串）。 */
export function candidateArgsHash(candidate: Candidate): string {
  return hashArgs({ kind: candidate.kind, purpose: candidate.semanticPurpose, fingerprint: candidate.contentFingerprint ?? '' });
}
