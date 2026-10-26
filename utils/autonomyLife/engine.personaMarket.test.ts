/**
 * 引擎整改回归：真实人设 → profile；真实目录候选 → 消费动作；外部只读 → 能力门。
 *
 * 这一组刻意从 **tickCharacter** 这个生产入口进，不注入预设 profile、不注入「已选中的
 * 动作」：人设从 personaFor 读，目录候选从 localCandidatesFor 读，外部候选由引擎自己
 * 从人设兴趣生成。断言的是「同样输入 → 同样输出」与「门确实拦得住」。
 */

import { describe, expect, it } from 'vitest';

import type { EffectiveBoundaryV1, ExternalGrant } from '../../contracts/autonomyLife';
import { createMemoryBudgetPort, type BudgetPort } from './budget';
import {
  createInMemoryLifeStore,
  emptyCharacterLife,
  tickCharacter,
  type CharacterLifeRow,
  type EngineDeps,
  type ModelProposal,
} from './engine';
import type { Candidate } from './rhythm';
import { createManualClock } from './time';

const TZ = 'Asia/Shanghai';
/** 2026-10-24 01:00 +08:00：早鸟在睡，夜猫刚醒。 */
const NIGHT = Date.UTC(2026, 9, 23, 17, 0, 0);
/** 2026-10-24 12:00 +08:00：两边都醒着，用于不涉及作息的断言。 */
const NOON = Date.UTC(2026, 9, 24, 4, 0, 0);

const grant = (overrides: Partial<ExternalGrant> = {}): ExternalGrant => ({
  provider: 'xhs',
  scopes: ['read:search'],
  allowedHosts: ['example.com'],
  allowedMethods: ['GET'],
  allowedFieldKeys: ['query'],
  purpose: '只看公开笔记',
  expiresAt: NIGHT + 86_400_000,
  dailyQuota: 5,
  ...overrides,
});

const boundary = (overrides: Partial<EffectiveBoundaryV1> = {}): EffectiveBoundaryV1 => ({
  schemaVersion: 1,
  revision: 1,
  scope: 'account',
  enabled: true,
  globalPaused: false,
  charEnabled: true,
  timezone: TZ,
  allowedKinds: ['journal.write'],
  forbiddenCategories: [],
  avoidTopics: [],
  allowFictionalNpc: false,
  doNotDisturb: null,
  limits: {
    accountModelCallsPerDay: 6,
    charModelCallsPerDay: 2,
    accountTokensPerDay: 10_000,
    charTokensPerDay: 4_000,
    notificationsPerDay: 1,
    perKindActionsPerDay: 3,
    virtualSpendPerDayMinor: 20_000,
    virtualOrderMaxMinor: 5_000,
  },
  externalGrants: [],
  ...overrides,
});

const journalCandidate: Candidate = {
  kind: 'journal.write',
  semanticPurpose: 'daily_note',
  args: { title: '今天', body: '雨停之后去楼下走了走。' },
};

const takeoutCandidate = (): Candidate => ({
  kind: 'takeout.order',
  semanticPurpose: 'meal_order',
  contentFingerprint: 'fp-1',
  args: {
    shopId: 'shop_a',
    shopName: '巷口面馆',
    category: '外卖',
    addressText: '北京市朝阳区某小区 3 号楼',
    orderId: 'ord_abc12345',
    cardId: 'card-char-1',
    shopCat: '美食外卖',
    deliveryFeeMinor: 200,
    items: [{ dishId: 'dish_a1', name: '番茄鸡蛋面', unitPriceMinor: 1250, qty: 1 }],
  },
});

interface Harness {
  deps: EngineDeps;
  store: ReturnType<typeof createInMemoryLifeStore>;
  budget: ReturnType<typeof createMemoryBudgetPort>;
  consumed: Array<{ charId: string; kind: string }>;
  setPersona(next: { personaText: string; scheduleText?: string; city?: string } | null): void;
  setBoundary(next: EffectiveBoundaryV1): void;
  setProbes(next: EngineDeps extends never ? never : Parameters<EngineDeps['probes']>[0] extends never ? never : { externalRead: { configured: boolean; reachable: boolean }; map: { configured: boolean; reachable: boolean } }): void;
  setLocalCandidates(next: Candidate[]): void;
  failModel(value: boolean): void;
  modelCalls(): number;
}

function harness(opts?: {
  nowMs?: number;
  row?: CharacterLifeRow;
  persona?: { personaText: string; scheduleText?: string; city?: string } | null;
  boundary?: EffectiveBoundaryV1;
  probes?: { externalRead: { configured: boolean; reachable: boolean }; map: { configured: boolean; reachable: boolean } };
  model?: ModelProposal | null;
  localCandidates?: Candidate[];
}): Harness {
  const nowMs = opts?.nowMs ?? NIGHT;
  const clock = createManualClock(nowMs);
  const store = createInMemoryLifeStore();
  const budget = createMemoryBudgetPort();
  let currentBoundary = opts?.boundary ?? boundary();
  let persona = opts?.persona === undefined ? { personaText: '你叫阿夜，夜猫子，经常熬夜到凌晨。' } : opts.persona;
  let probes = opts?.probes ?? {
    externalRead: { configured: false, reachable: false },
    map: { configured: false, reachable: false },
  };
  let localCandidates = opts?.localCandidates ?? [];
  let modelResult: ModelProposal | null = opts?.model === undefined ? { candidates: [journalCandidate], tokensUsed: 120 } : opts.model;
  let calls = 0;
  const consumed: Array<{ charId: string; kind: string }> = [];

  // 生产上 tick.ts 的 ensureCharacterLife 会先建一行带角色时区的状态：这里照做，
  // 否则引擎会按占位行的 UTC 时区判作息（那是入口缺失，不是人设问题）。
  void store.putCharacterLife(opts?.row ?? dueRow(), opts?.row?.revision ?? 0);

  const deps: EngineDeps = {
    store,
    budget: budget as BudgetPort,
    clock,
    seed: 'install-seed-1',
    accountId: 'acct-1',
    deviceOnline: async () => true,
    probes: async () => ({
      localStoresReady: true,
      deviceBound: true,
      hasModelCredentials: true,
      ...probes,
    }),
    boundaryFor: async () => currentBoundary,
    personaFor: async () => persona,
    localCandidatesFor: async () => localCandidates,
    consumeLocalCandidates: async (charId, kind) => { consumed.push({ charId, kind }); },
    model: {
      async request() {
        calls += 1;
        return modelResult;
      },
    },
  };

  return {
    deps,
    store,
    budget,
    consumed,
    setPersona(next) { persona = next; },
    setBoundary(next) { currentBoundary = next; },
    setProbes(next) { probes = next; },
    setLocalCandidates(next) { localCandidates = next; },
    failModel(value) { modelResult = value ? null : { candidates: [journalCandidate], tokensUsed: 120 }; },
    modelCalls: () => calls,
  };
}

const dueRow = (overrides: Partial<CharacterLifeRow> = {}): CharacterLifeRow => ({
  ...emptyCharacterLife('char-1', NIGHT, TZ),
  lastEvaluatedAt: NIGHT,
  nextOpportunityAt: NIGHT,
  ...overrides,
});

describe('人设驱动：真实人设/日程 → RhythmProfile', () => {
  it('同角色/同种子/同时间：早鸟与夜猫的睡眠窗与下次机会不同', async () => {
    const early = harness({ persona: { personaText: '你叫阿早，早睡早起，作息规律。' } });
    const earlyTick = await tickCharacter(early.deps, 'char-1');
    const earlyRow = await early.store.getCharacterLife('char-1');

    const night = harness({ persona: { personaText: '你叫阿夜，夜猫子，经常熬夜到凌晨。' } });
    const nightTick = await tickCharacter(night.deps, 'char-1');
    const nightRow = await night.store.getCharacterLife('char-1');

    expect(earlyRow?.profile?.confidence).toBe('persona');
    expect(nightRow?.profile?.confidence).toBe('persona');
    expect(earlyRow?.profile?.sleepWindows[0]).toEqual({ start: '22:30', end: '06:30' });
    expect(nightRow?.profile?.sleepWindows[0]).toEqual({ start: '01:30', end: '09:30' });
    // 01:00：早鸟在睡（resting），夜猫还醒着（真的排了动作）。
    expect(earlyTick.status).toBe('resting');
    expect(earlyTick.reasonCodes).toContain('SLEEPING');
    expect(nightTick.status).toBe('scheduled');
    expect(nightTick.actionId).toBeTruthy();
    expect(earlyTick.nextOpportunityAt).not.toBe(nightTick.nextOpportunityAt);
  });

  it('真实日程也会进 profile（睡觉时段 → 睡眠窗），并随人设哈希一起失效重建', async () => {
    const h = harness({
      persona: { personaText: '你叫阿早。', scheduleText: '23:30-07:00 睡觉；09:00-12:00 上班' },
    });
    await tickCharacter(h.deps, 'char-1');
    const first = await h.store.getCharacterLife('char-1');
    expect(first?.profile?.sleepWindows[0]).toEqual({ start: '23:30', end: '07:00' });

    // 人设改了：同一角色、下一次 tick（未到期也算）必须重建并落库新 profile。
    h.setPersona({ personaText: '你叫阿早，最近改成夜猫子，经常熬夜。', scheduleText: '01:30-09:30 睡觉' });
    await tickCharacter(h.deps, 'char-1');
    const second = await h.store.getCharacterLife('char-1');
    expect(second?.profile?.personaHash).not.toBe(first?.profile?.personaHash);
    expect(second?.profile?.sleepWindows[0]).toEqual({ start: '01:30', end: '09:30' });
    expect(second!.revision).toBeGreaterThan(first!.revision);

    // 人设没变：不重建（revision 不再增长、哈希不变）。
    const before = second!.revision;
    await tickCharacter(h.deps, 'char-1');
    const third = await h.store.getCharacterLife('char-1');
    expect(third?.profile?.personaHash).toBe(second?.profile?.personaHash);
    expect(third!.revision).toBe(before);
  });

  it('没有真实人设/日程信号 → 明确 fallback（基础作息），不是编一个人设', async () => {
    const h = harness({ persona: null, nowMs: NOON });
    const tick = await tickCharacter(h.deps, 'char-1');
    const row = await h.store.getCharacterLife('char-1');
    expect(row?.profile?.confidence).toBe('fallback');
    expect(row?.profile?.source).toBe('deterministic_fallback');
    expect(row?.profile?.personaHash).toBe('char-1:fallback');
    expect(tick.status).toBe('scheduled');
  });

  it('读人设失败（personaFor 抛错）→ 当作没有信号，不把这次 tick 判死', async () => {
    const h = harness({ persona: { personaText: '你叫阿夜，夜猫子。' }, nowMs: NOON });
    h.deps.personaFor = async () => { throw new Error('fire_pack_unreadable'); };
    const tick = await tickCharacter(h.deps, 'char-1');
    expect(tick.status).toBe('scheduled');
    const row = await h.store.getCharacterLife('char-1');
    expect(row?.profile?.confidence).toBe('fallback');
  });
});

describe('真实目录候选：外卖/购物走设备上报，价格不经过模型', () => {
  it('模型失败但有设备候选 → 照常排单；参数与价格原样保留，消费额度当场核销', async () => {
    const candidate = takeoutCandidate();
    const h = harness({ localCandidates: [candidate], boundary: boundary({ allowedKinds: ['takeout.order'] }) });
    h.failModel(true);

    const tick = await tickCharacter(h.deps, 'char-1');
    expect(tick.status).toBe('scheduled');
    expect(tick.actionId).toBeTruthy();

    const action = await h.store.getAction(tick.actionId!);
    expect(action?.kind).toBe('takeout.order');
    expect(action?.args).toEqual(candidate.args);
    expect(action?.argsHash).toBeTruthy();

    const rows = Object.values(h.budget.snapshot());
    const charRow = rows.find((row) => row.scope === 'char-1')!;
    expect(charRow.spendMinor).toBe(1450);
    expect(charRow.kindCounts['takeout.order']).toBe(1);
    // 排上之后回收这份候选（同一笔钱不会被排第二次）。
    expect(h.consumed).toEqual([{ charId: 'char-1', kind: 'takeout.order' }]);
  });

  it('超出单笔上限 → BUDGET_EXHAUSTED，不落动作、不记账', async () => {
    const h = harness({
      localCandidates: [takeoutCandidate()],
      boundary: boundary({ allowedKinds: ['takeout.order'], limits: { ...boundary().limits, virtualOrderMaxMinor: 500 } }),
    });
    h.failModel(true);
    const tick = await tickCharacter(h.deps, 'char-1');
    expect(tick.status).toBe('budget_exhausted');
    expect(tick.budgetDimension).toBe('virtual_order_max');
    expect(tick.actionId).toBeNull();
    const actions = await h.store.dueActions('char-1', NIGHT + 1, 5);
    expect(actions).toEqual([]);
    const charRow = Object.values(h.budget.snapshot()).find((row) => row.scope === 'char-1')!;
    expect(charRow.spendMinor).toBe(0);
  });

  it('消费类候选也要过边界（kind 不在 allowedKinds → 不排单）', async () => {
    const h = harness({ localCandidates: [takeoutCandidate()], boundary: boundary({ allowedKinds: ['journal.write'] }) });
    h.failModel(true);
    const tick = await tickCharacter(h.deps, 'char-1');
    expect(tick.actionId).toBeNull();
  });
});

describe('外部只读：配置 + 授权 + 可达 三者都成立才进候选', () => {
  it('三者成立 → 由正常链路排出 external.read（查询词来自人设兴趣）', async () => {
    const h = harness({
      boundary: boundary({ allowedKinds: ['external.read'], externalGrants: [grant()] }),
      persona: { personaText: '你叫阿夜，夜猫子，喜欢天文和咖啡。' },
      probes: { externalRead: { configured: true, reachable: true }, map: { configured: false, reachable: false } },
      model: null,
    });
    const tick = await tickCharacter(h.deps, 'char-1');
    expect(tick.status).toBe('scheduled');
    const action = await h.store.getAction(tick.actionId!);
    expect(action?.kind).toBe('external.read');
    const args = action?.args as { query: string; fields: string[] };
    expect(['天文', '咖啡']).toContain(args.query);
    expect(args.fields).toEqual(['title', 'excerpt', 'url']);
  });

  it('端点不可达 → 不生成外部候选（模型也失败 → 整轮 model_failed，不假装」看过了」）', async () => {
    const h = harness({
      boundary: boundary({ allowedKinds: ['external.read'], externalGrants: [grant()] }),
      persona: { personaText: '你叫阿夜，夜猫子，喜欢天文和咖啡。' },
      probes: { externalRead: { configured: true, reachable: false }, map: { configured: false, reachable: false } },
      model: null,
    });
    const tick = await tickCharacter(h.deps, 'char-1');
    expect(tick.actionId).toBeNull();
    expect(tick.status).toBe('model_failed');
    const actions = await h.store.dueActions('char-1', NIGHT + 1, 5);
    expect(actions).toEqual([]);
  });

  it('没授权 → 即使端点可达也不生成（授权门不等于配置门）', async () => {
    const h = harness({
      boundary: boundary({ allowedKinds: ['external.read'], externalGrants: [] }),
      persona: { personaText: '你叫阿夜，夜猫子，喜欢天文和咖啡。' },
      probes: { externalRead: { configured: true, reachable: true }, map: { configured: false, reachable: false } },
      model: null,
    });
    const tick = await tickCharacter(h.deps, 'char-1');
    expect(tick.actionId).toBeNull();
  });
});
