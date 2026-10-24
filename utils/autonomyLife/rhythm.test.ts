/**
 * rhythm-v1 验收（契约 §10 A、B 的一部分）：人设差异、时机窗口、确定性复跑。
 */
import { describe, expect, it } from 'vitest';

import {
  BASE_KIND_COOLDOWN_MS,
  buildRhythmProfile,
  chooseActivity,
  DEFAULT_MIN_GAP_MS,
  isProfileStale,
  needsAreLow,
  planNextOpportunity,
  resolvePhase,
  updateNeeds,
  withinKindCooldown,
  type Candidate,
  type RecentActivity,
} from './rhythm';
import { createRng, DAY_MS, HOUR_MS, localDateKey, MINUTE_MS, zonedParts } from './time';

const TZ = 'Asia/Shanghai';
// 2026-10-24 12:00 +08:00
const NOON = Date.UTC(2026, 9, 24, 4, 0, 0);

const personas = {
  outgoing: '她性格外向，爱热闹，喜欢认识新朋友，说话活泼。',
  reserved: '她性格内向，安静寡言，怕生，独来独往。',
  nightOwl: '夜猫子，习惯熬夜到深夜，凌晨还在刷手机。',
  earlyBird: '早起型，早睡早起，清晨会去跑步。',
};

const candidates: Candidate[] = [
  { kind: 'interaction.message', semanticPurpose: 'share_mood' },
  { kind: 'journal.write', semanticPurpose: 'daily_note' },
  { kind: 'room.plan', semanticPurpose: 'tidy_plan' },
];

function profileFor(personaText: string, scheduleText = '', nowMs = NOON) {
  return buildRhythmProfile({
    personaText,
    scheduleText,
    timezone: TZ,
    personaHash: `persona:${personaText.length}`,
    nowMs,
  });
}

describe('rhythm-v1 人设解析', () => {
  it('外向/内向得到不同的社交特质，且不是靠模型', () => {
    const outgoing = profileFor(personas.outgoing);
    const reserved = profileFor(personas.reserved);
    expect(outgoing.traits.sociability).toBeGreaterThan(reserved.traits.sociability);
    expect(outgoing.confidence).toBe('persona');
    expect(reserved.source).toBe('persona_extract');
  });

  it('人设无有效信号时用保守回退并标记 fallback（23:00–08:00）', () => {
    const profile = profileFor('');
    expect(profile.confidence).toBe('fallback');
    expect(profile.source).toBe('deterministic_fallback');
    expect(profile.sleepWindows[0]).toEqual({ start: '23:00', end: '08:00' });
  });

  it('日程里明确写的时间段优先作为睡眠窗', () => {
    const profile = profileFor('她作息规律。', '作息 01:30-09:30，其余时间在工作');
    expect(profile.sleepWindows[0]).toEqual({ start: '01:30', end: '09:30' });
  });

  it('夜猫/晨型得到不同的夜间与晨间偏好', () => {
    const night = profileFor(personas.nightOwl);
    const morning = profileFor(personas.earlyBird);
    expect(night.phasePreferences.night).toBeGreaterThan(morning.phasePreferences.night);
    expect(morning.phasePreferences.morning).toBeGreaterThan(night.phasePreferences.morning);
  });

  it('profile 只在人设/时区/摘要变化时失效', () => {
    const profile = profileFor(personas.outgoing);
    const same = { personaHash: profile.personaHash, timezone: TZ, summaryHash: profile.summaryHash };
    expect(isProfileStale(profile, same)).toBe(false);
    expect(isProfileStale(profile, { ...same, summaryHash: 'changed' })).toBe(true);
    expect(isProfileStale(profile, { ...same, timezone: 'Europe/Paris' })).toBe(true);
  });
});

describe('rhythm-v1 时机窗口（场景 A）', () => {
  it('同一 profile/需求/窗口下，nextOpportunityAt 与 opportunityId 重算完全一致', () => {
    const profile = profileFor(personas.outgoing);
    const needs = { social: 0.8, record: 0.4, tidy: 0.3, food: 0.2, interest: 0.4 };
    const input = { profile, needs, nowMs: NOON, seed: 'seed-A', charId: 'char-1' };
    const first = planNextOpportunity(input);
    const second = planNextOpportunity(input);
    expect(second).toEqual(first);
  });

  it('换 seed 只在允许窗内变化，不会跑出这一阶段', () => {
    const profile = profileFor(personas.outgoing);
    const needs = { social: 0.7, record: 0.3, tidy: 0.2, food: 0.2, interest: 0.3 };
    const times = new Set<number>();
    for (let i = 0; i < 30; i += 1) {
      const plan = planNextOpportunity({ profile, needs, nowMs: NOON, seed: `seed-${i}`, charId: 'char-1' });
      times.add(plan.nextOpportunityAt);
      expect(plan.nextOpportunityAt).toBeGreaterThanOrEqual(plan.window.startMs);
      expect(plan.nextOpportunityAt).toBeLessThan(plan.window.endMs);
      // 机会 id 与 seed 绑定：同一 (seed, 角色, 日程 revision, 窗口) 必须稳定复现。
      const again = planNextOpportunity({ profile, needs, nowMs: NOON, seed: `seed-${i}`, charId: 'char-1' });
      expect(again.opportunityId).toBe(plan.opportunityId);
      expect(again.nextOpportunityAt).toBe(plan.nextOpportunityAt);
    }
    // 种子只影响窗口内的落点，不影响「落在哪个阶段」。
    expect(times.size).toBeGreaterThan(1);
  });

  it('需求低时直接跳到下一阶段（不为凑数排动作）', () => {
    const profile = profileFor(personas.outgoing);
    const low = { social: 0.05, record: 0.05, tidy: 0.02, food: 0.05, interest: 0.05 };
    expect(needsAreLow(low)).toBe(true);
    const plan = planNextOpportunity({ profile, needs: low, nowMs: NOON, seed: 's', charId: 'c' });
    expect(plan.skippedPhase).toBe(true);
    expect(plan.lifePhase).toBe('resting');
  });

  it('睡眠窗内识别为 resting', () => {
    const profile = profileFor('', '作息 23:00-08:00');
    const deepNight = Date.UTC(2026, 9, 23, 17, 0, 0); // 01:00 +08:00
    expect(resolvePhase(profile, deepNight).phase).toBe('resting');
    expect(resolvePhase(profile, NOON).phase).toBe('noon');
  });
});

describe('rhythm-v1 需求更新（场景 B）', () => {
  it('离线一天最多计入一个本地日，不会堆出多轮', () => {
    const traits = { sociability: 0.5, curiosity: 0.5, orderliness: 0.5, impulsiveness: 0.5 };
    const oneDay = updateNeeds({ social: 0, record: 0, tidy: 0, food: 0, interest: 0 }, {
      elapsedMs: DAY_MS, phase: 'noon', traits,
    });
    const tenDays = updateNeeds({ social: 0, record: 0, tidy: 0, food: 0, interest: 0 }, {
      elapsedMs: 10 * DAY_MS, phase: 'noon', traits,
    });
    expect(tenDays).toEqual(oneDay);
  });

  it('刚和用户聊过会压低社交需求', () => {
    const traits = { sociability: 0.9, curiosity: 0.5, orderliness: 0.5, impulsiveness: 0.5 };
    const quiet = updateNeeds({ social: 0.2, record: 0, tidy: 0, food: 0, interest: 0 }, {
      elapsedMs: 3 * HOUR_MS, phase: 'noon', traits,
    });
    const justChatted = updateNeeds({ social: 0.2, record: 0, tidy: 0, food: 0, interest: 0 }, {
      elapsedMs: 3 * HOUR_MS, phase: 'noon', traits, sinceInteractionMs: 2 * MINUTE_MS,
    });
    expect(justChatted.social).toBeLessThan(quiet.social);
  });
});

describe('rhythm-v1 候选选择（场景 A：人设差异体现在选择上）', () => {
  const traitsOf = (personaText: string) => profileFor(personaText).traits;
  const needs = { social: 0.6, record: 0.5, tidy: 0.5, food: 0.3, interest: 0.4 };

  function countPicks(personaText: string, kind: 'interaction.message' | 'room.plan'): number {
    let picks = 0;
    for (let i = 0; i < 40; i += 1) {
      const profile = profileFor(personaText);
      const choice = chooseActivity({
        candidates,
        allowedKinds: ['interaction.message', 'journal.write', 'room.plan'],
        profile,
        needs,
        phase: 'evening',
        recent: [],
        nowMs: NOON,
        tz: TZ,
        rng: createRng('pick', i),
        interactionFit: 0.6,
      });
      if (choice?.kind === kind) picks += 1;
    }
    expect(traitsOf(personaText)).toBeTruthy();
    return picks;
  }

  it('外向角色显著比内向角色更容易选择主动消息', () => {
    const outgoingPicks = countPicks(personas.outgoing, 'interaction.message');
    const reservedPicks = countPicks(personas.reserved, 'interaction.message');
    expect(outgoingPicks).toBeGreaterThan(reservedPicks);
  });

  it('噪声有界：同一候选的分数差异不超过噪声上限', () => {
    const profile = profileFor(personas.outgoing);
    const scores: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const choice = chooseActivity({
        candidates: [{ kind: 'journal.write', semanticPurpose: 'daily_note' }],
        allowedKinds: ['journal.write'],
        profile,
        needs,
        phase: 'night',
        recent: [],
        nowMs: NOON,
        tz: TZ,
        rng: createRng('noise', i),
      })!;
      scores.push(choice.score);
    }
    expect(Math.max(...scores) - Math.min(...scores)).toBeLessThanOrEqual(0.2 + 1e-9);
  });

  it('同类冷却在冷却期内命中，过期后放开', () => {
    const recent: RecentActivity[] = [{
      kind: 'journal.write', semanticPurpose: 'daily_note', occurredAt: NOON - 2 * HOUR_MS, success: true,
    }];
    expect(withinKindCooldown(recent, 'journal.write', NOON)).toBe(true);
    expect(withinKindCooldown(recent, 'journal.write', NOON - 2 * HOUR_MS + BASE_KIND_COOLDOWN_MS['journal.write'])).toBe(false);
  });

  it('本地日期键按角色时区派生', () => {
    expect(localDateKey(NOON, TZ)).toBe('2026-10-24');
    expect(zonedParts(NOON, TZ).hour).toBe(12);
    expect(localDateKey(NOON, 'America/New_York')).toBe('2026-10-24');
  });

  it('最小间隔：两次模型请求至少隔 30 分钟', () => {
    const profile = profileFor(personas.outgoing);
    const plan = planNextOpportunity({
      profile, needs, nowMs: NOON, seed: 'gap', charId: 'c', minGapMs: DEFAULT_MIN_GAP_MS, lastOpportunityAt: NOON - MINUTE_MS,
    });
    expect(plan.nextOpportunityAt).toBeGreaterThanOrEqual(NOON + DEFAULT_MIN_GAP_MS);
  });
});
