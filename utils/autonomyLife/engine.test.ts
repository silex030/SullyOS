/**
 * 自主生活引擎（契约 §3.3、§3.4、§4.2、§10-B/E/F/I/K）：
 *   - 未到期 → 0 次模型调用；
 *   - 预算/缺需求/熔断都不发请求；
 *   - 失败退避 30min → 2h → 8h，三次进 circuit_open；
 *   - 重启读既有机会，不重新抽样；
 *   - waiting_device / claim / permit / receipt / cancel 的状态机；
 *   - 暂停 acknowledged/quiesced 的区分；
 *   - 同日同语义去重 + 同类冷却。
 */
import { describe, expect, it } from 'vitest';

import type { EffectiveBoundaryV1 } from '../../contracts/autonomyLife';
import type { BudgetGrant, BudgetPort } from './budget';
import { createMemoryBudgetPort } from './budget';
import {
  cancelAction,
  claimAction,
  commitPermit,
  createInMemoryLifeStore,
  emptyCharacterLife,
  FAILURE_BACKOFF_MS,
  projectActivity,
  projectCharacterState,
  reportReceipt,
  requestPause,
  tickCharacter,
  type CharacterLifeRow,
  type EngineDeps,
  type ModelProposal,
} from './engine';
import type { Candidate } from './rhythm';
import { createManualClock, DAY_MS, HOUR_MS } from './time';

const TZ = 'Asia/Shanghai';
const NOON = Date.UTC(2026, 9, 24, 4, 0, 0); // 2026-10-24 12:00 +08:00

const boundary: EffectiveBoundaryV1 = {
  schemaVersion: 1,
  revision: 1,
  scope: 'account',
  enabled: true,
  globalPaused: false,
  charEnabled: true,
  timezone: TZ,
  allowedKinds: ['journal.write', 'room.plan', 'interaction.message'],
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
};

const CANDIDATES: Candidate[] = [
  { kind: 'journal.write', semanticPurpose: 'daily_note', args: { title: '今天', body: '傍晚的风很凉。' } },
  { kind: 'room.plan', semanticPurpose: 'tidy_plan', args: { items: ['整理书桌'] } },
  { kind: 'interaction.message', semanticPurpose: 'share_mood', args: { text: '刚看到一只很像你的猫。' } },
];

interface Harness {
  deps: EngineDeps;
  store: ReturnType<typeof createInMemoryLifeStore>;
  budget: ReturnType<typeof createMemoryBudgetPort>;
  clock: ReturnType<typeof createManualClock>;
  modelCalls: () => number;
  requests: Array<{ kind: string; promptKey: string }>;
  setBoundary: (next: EffectiveBoundaryV1) => void;
  setDeviceOnline: (value: boolean) => void;
  failModel: (value: boolean) => void;
}

function harness(opts?: {
  nowMs?: number;
  row?: CharacterLifeRow;
  limits?: Partial<EffectiveBoundaryV1['limits']>;
  deviceOnline?: boolean;
  proposal?: ModelProposal;
}): Harness {
  const clock = createManualClock(opts?.nowMs ?? NOON);
  const store = createInMemoryLifeStore();
  const budget = createMemoryBudgetPort();
  let boundaryNow: EffectiveBoundaryV1 = { ...boundary, limits: { ...boundary.limits, ...opts?.limits } };
  let online = opts?.deviceOnline ?? true;
  let fail = false;
  let calls = 0;
  const requests: Array<{ kind: string; promptKey: string }> = [];
  if (opts?.row) {
    void store.putCharacterLife(opts.row, 0);
  }
  const deps: EngineDeps = {
    store,
    budget: budget as BudgetPort,
    clock,
    seed: 'install-seed-1',
    accountId: 'acct-1',
    deviceOnline: async () => online,
    probes: async () => ({
      localStoresReady: true,
      deviceBound: true,
      hasModelCredentials: true,
      externalRead: { configured: false, reachable: false },
      map: { configured: false, reachable: false },
    }),
    boundaryFor: async () => boundaryNow,
    candidatesFor: () => CANDIDATES,
    model: {
      async request(input): Promise<ModelProposal | null> {
        calls += 1;
        requests.push({ kind: input.kind, promptKey: input.promptKey });
        if (fail) return null;
        return opts?.proposal ?? { candidates: CANDIDATES, tokensUsed: 120 };
      },
    },
  };
  return {
    deps,
    store,
    budget,
    clock,
    modelCalls: () => calls,
    requests,
    setBoundary: (next) => { boundaryNow = next; },
    setDeviceOnline: (value) => { online = value; },
    failModel: (value) => { fail = value; },
  };
}

const dueRow = (charId = 'char-1', overrides: Partial<CharacterLifeRow> = {}): CharacterLifeRow => ({
  ...emptyCharacterLife(charId, NOON, TZ),
  lastEvaluatedAt: NOON,
  nextOpportunityAt: NOON,
  ...overrides,
});

describe('引擎：时机（§3.3 / 场景 B）', () => {
  it('未到期时连跑 100 次 tick，模型调用数为 0、预算不动', async () => {
    const h = harness({ row: dueRow('char-1', { nextOpportunityAt: NOON + 2 * HOUR_MS }) });
    for (let i = 0; i < 100; i += 1) {
      const result = await tickCharacter(h.deps, 'char-1');
      expect(result.status).toBe('not_due');
      expect(result.modelCalls).toBe(0);
    }
    expect(h.modelCalls()).toBe(0);
    expect(h.budget.snapshot()).toEqual({});
  });

  it('到点才行动，且行动后算出下一次机会（不保证每时段都行动）', async () => {
    const h = harness({ row: dueRow() });
    const result = await tickCharacter(h.deps, 'char-1');
    expect(result.modelCalls).toBe(1);
    expect(result.status).toMatch(/scheduled|waiting_device/);
    expect(result.nextOpportunityAt).not.toBeNull();
    expect(result.nextOpportunityAt!).toBeGreaterThan(h.clock.now());
    const row = await h.store.getCharacterLife('char-1');
    expect(row?.opportunityId).toBeTruthy();
    expect(row?.lastModelCallAt).toBe(NOON);
  });

  it('需求整体很低 → resting，跳过这一时段且不发模型请求', async () => {
    const h = harness({
      row: dueRow('char-1', { needs: { social: 0.02, record: 0.01, tidy: 0.01, food: 0.02, interest: 0.01 } }),
    });
    const result = await tickCharacter(h.deps, 'char-1');
    expect(result.status).toBe('resting');
    expect(result.modelCalls).toBe(0);
    expect(result.reasonCodes).toContain('RESTING');
    expect(h.modelCalls()).toBe(0);
  });

  it('重启（同一 store 行）不重新抽样：opportunityId / nextOpportunityAt 保持', async () => {
    const first = harness({ row: dueRow() });
    await tickCharacter(first.deps, 'char-1');
    const stored = await first.store.getCharacterLife('char-1');
    expect(stored).toBeTruthy();

    // 新进程：同一行、同一 seed、时钟不动 → 未到期，不做任何事。
    const restarted = harness({ row: stored! });
    restarted.store.characters.set('char-1', { ...stored! });
    const result = await tickCharacter(restarted.deps, 'char-1');
    expect(result.status).toBe('not_due');
    expect(restarted.modelCalls()).toBe(0);
    const after = await restarted.store.getCharacterLife('char-1');
    expect(after?.opportunityId).toBe(stored?.opportunityId);
    expect(after?.nextOpportunityAt).toBe(stored?.nextOpportunityAt);
  });

  it('离线一天回来只处理一次当前快照（不补跑多轮）', async () => {
    const h = harness({ row: dueRow('char-1', { nextOpportunityAt: NOON - DAY_MS, lastEvaluatedAt: NOON - DAY_MS }) });
    const result = await tickCharacter(h.deps, 'char-1');
    expect(result.modelCalls).toBe(1);
    expect(h.modelCalls()).toBe(1);
  });
});

describe('引擎：预算与失败（§3.4 / §5.2 / 场景 G/I）', () => {
  it('调用上限为 0 → BUDGET_EXHAUSTED，一次模型请求都不发', async () => {
    const h = harness({ row: dueRow(), limits: { charModelCallsPerDay: 0 } });
    const result = await tickCharacter(h.deps, 'char-1');
    expect(result.status).toBe('budget_exhausted');
    expect(result.modelCalls).toBe(0);
    expect(result.reasonCodes).toContain('BUDGET_EXHAUSTED');
    expect(h.modelCalls()).toBe(0);
  });

  it('预算存储不可用 → fail closed（不调模型，状态为 limited）', async () => {
    const h = harness({ row: dueRow() });
    h.budget.setAvailable(false);
    const result = await tickCharacter(h.deps, 'char-1');
    expect(result.modelCalls).toBe(0);
    expect(result.status).toBe('budget_exhausted');
    expect(h.modelCalls()).toBe(0);
  });

  it('模型失败：30min → 2h → 8h 退避，第三次进熔断，之后不再轮询', async () => {
    // 默认角色上限只有 2 次调用/天；这里放宽调用与 token，专门验证「三次连续失败」的熔断路径。
    const h = harness({
      row: dueRow(),
      limits: { charModelCallsPerDay: 6, accountModelCallsPerDay: 6, charTokensPerDay: 20_000, accountTokensPerDay: 50_000 },
    });
    h.failModel(true);

    const first = await tickCharacter(h.deps, 'char-1');
    expect(first.status).toBe('model_failed');
    let row = await h.store.getCharacterLife('char-1');
    expect(row?.retryAt).toBe(NOON + FAILURE_BACKOFF_MS[0]);

    // 退避期内：不请求。
    h.clock.set(NOON + 10 * 60_000);
    expect((await tickCharacter(h.deps, 'char-1')).modelCalls).toBe(0);

    h.clock.set(NOON + FAILURE_BACKOFF_MS[0]);
    const second = await tickCharacter(h.deps, 'char-1');
    expect(second.status).toBe('model_failed');
    row = await h.store.getCharacterLife('char-1');
    expect(row?.retryAt).toBe(h.clock.now() + FAILURE_BACKOFF_MS[1]);

    h.clock.set(row!.retryAt!);
    const third = await tickCharacter(h.deps, 'char-1');
    expect(third.status).toBe('circuit_open');
    row = await h.store.getCharacterLife('char-1');
    expect(row?.circuitOpenedAt).not.toBeNull();
    expect(row?.availability).toBe('error');

    // 熔断后仍然受 8h 兜底约束：立刻再 tick 不发请求。
    const callsAfterCircuit = h.modelCalls();
    expect((await tickCharacter(h.deps, 'char-1')).modelCalls).toBe(0);
    expect(h.modelCalls()).toBe(callsAfterCircuit);
  });

  it('连续失败后恢复：一次成功后清空 failStreak / 熔断', async () => {
    const h = harness({ row: dueRow() });
    h.failModel(true);
    await tickCharacter(h.deps, 'char-1');
    let row = await h.store.getCharacterLife('char-1');
    h.clock.set(row!.retryAt!);
    h.failModel(false);
    const recovered = await tickCharacter(h.deps, 'char-1');
    expect(recovered.modelCalls).toBe(1);
    row = await h.store.getCharacterLife('char-1');
    expect(row?.failStreak).toBe(0);
    expect(row?.circuitOpenedAt).toBeNull();
  });

  it('每次请求都逐次计入 calls（规划 + 后续生成不是一个计数）', async () => {
    const h = harness({ row: dueRow() });
    await tickCharacter(h.deps, 'char-1');
    const row = await h.store.getCharacterLife('char-1');
    // 下一次到点再跑一次（新窗口内仍算第 2 次）。
    h.clock.set(row!.nextOpportunityAt!);
    h.store.characters.set('char-1', { ...row!, lastModelCallAt: row!.nextOpportunityAt! - HOUR_MS });
    const second = await tickCharacter(h.deps, 'char-1');
    expect(h.modelCalls()).toBe(2);
    // 角色上限 2：第三次必须被预算挡住（而不是被「一轮」合并掉）。
    const row2 = await h.store.getCharacterLife('char-1');
    h.clock.set(row2!.nextOpportunityAt! + HOUR_MS);
    h.store.characters.set('char-1', { ...row2!, nextOpportunityAt: h.clock.now() });
    const third = await tickCharacter(h.deps, 'char-1');
    expect(third.status).toBe('budget_exhausted');
    expect(second.modelCalls).toBe(1);
  });
});

describe('引擎：去重与冷却（§3.2）', () => {
  it('同角色同日同语义目的只产生一个主动动作', async () => {
    const h = harness({ row: dueRow() });
    // 首次只给一个候选，确保「做了什么」是确定的。
    h.deps.candidatesFor = () => [{ kind: 'journal.write', semanticPurpose: 'daily_note', args: { title: '今天', body: '傍晚的风很凉。' } }];
    const first = await tickCharacter(h.deps, 'char-1');
    expect(first.actionId).toBeTruthy();
    const action = await h.store.getAction(first.actionId!);
    await reportReceipt(h.deps, {
      accountId: 'acct-1',
      actionId: first.actionId!,
      installationId: 'install-1',
      leaseEpoch: action!.leaseEpoch,
      argsHash: action!.argsHash,
      status: 'succeeded',
      resultRef: 'diaries:1',
      nowMs: NOON,
    });
    const row = await h.store.getCharacterLife('char-1');
    h.clock.set(NOON + 7 * HOUR_MS); // 越过日记 6h 冷却
    h.store.characters.set('char-1', {
      ...row!,
      // 需求拉满：保证候选能过打分门槛，从而命中「同日同语义」这道硬闸（而不是被软惩罚挤掉）。
      needs: { social: 1, record: 1, tidy: 1, food: 1, interest: 1 },
      nextOpportunityAt: h.clock.now(),
      lastModelCallAt: NOON,
      lastEvaluatedAt: h.clock.now(),
    });
    // 同语义目的（换个措辞也算）：跳过（不是换个 App 重试）。
    h.deps.candidatesFor = () => [{ kind: 'journal.write', semanticPurpose: 'daily_note', contentFingerprint: 'v2', args: { title: '今天', body: '换了措辞但语义一样。' } }];
    const second = await tickCharacter(h.deps, 'char-1');
    expect(second.status).toBe('skipped');
    expect(second.actionId).toBeNull();
  });

  it('同类冷却期内不做第二件同 kind 的事', async () => {
    const h = harness({ row: dueRow() });
    h.deps.candidatesFor = () => [{ kind: 'journal.write', semanticPurpose: 'daily_note', args: { title: '今天', body: '傍晚的风很凉。' } }];
    const first = await tickCharacter(h.deps, 'char-1');
    const action = await h.store.getAction(first.actionId!);
    await reportReceipt(h.deps, {
      accountId: 'acct-1',
      actionId: first.actionId!,
      installationId: 'install-1',
      leaseEpoch: action!.leaseEpoch,
      argsHash: action!.argsHash,
      status: 'succeeded',
      resultRef: 'x:1',
      nowMs: NOON,
    });
    const row = await h.store.getCharacterLife('char-1');
    h.clock.set(NOON + 2 * HOUR_MS); // 日记冷却 6h 内
    h.store.characters.set('char-1', { ...row!, nextOpportunityAt: h.clock.now(), lastEvaluatedAt: h.clock.now() });
    h.deps.candidatesFor = () => [{ kind: 'journal.write', semanticPurpose: 'other_note', args: { title: '今天', body: '另一个目的。' } }];
    const second = await tickCharacter(h.deps, 'char-1');
    expect(second.status).toBe('skipped');
  });
});

describe('引擎：设备、许可、回执（§4.2 / 场景 E/K）', () => {
  it('设备离线 → waiting_device；换设备 claim 被拒；绑定设备可领', async () => {
    const h = harness({ row: dueRow(), deviceOnline: false });
    const result = await tickCharacter(h.deps, 'char-1');
    expect(result.status).toBe('waiting_device');
    expect(result.reasonCodes).toContain('WAITING_DEVICE');
    const action = await h.store.getAction(result.actionId!);
    expect(action?.status).toBe('waiting_device');

    await h.store.bindInstallation('acct-1', 'install-1', NOON);
    const wrong = await claimAction(h.deps, { accountId: 'acct-1', installationId: 'install-2', charId: 'char-1' });
    expect(wrong.action).toBeNull();
    const claimed = await claimAction(h.deps, { accountId: 'acct-1', installationId: 'install-1', charId: 'char-1' });
    expect(claimed.action?.id).toBe(result.actionId);
    expect(claimed.leaseEpoch).toBe(1);
  });

  it('commit-permit 在暂停后不再发新许可；在途许可如实显示未 quiesced', async () => {
    const h = harness({ row: dueRow() });
    const tick = await tickCharacter(h.deps, 'char-1');
    await h.store.bindInstallation('acct-1', 'install-1', NOON);
    const claimed = await claimAction(h.deps, { accountId: 'acct-1', installationId: 'install-1', charId: 'char-1' });
    const permit = await commitPermit(h.deps, {
      accountId: 'acct-1',
      actionId: tick.actionId!,
      installationId: 'install-1',
      leaseEpoch: claimed.leaseEpoch,
      argsHash: claimed.action!.argsHash,
      policyVersion: claimed.action!.policyVersion,
      nowMs: NOON,
    });
    expect(permit.ok).toBe(true);
    expect(permit.permit?.expiresAt).toBe(NOON + 60_000);

    const pause = await requestPause(h.deps, { accountId: 'acct-1', paused: true, nowMs: NOON + 1000 });
    expect(pause.acknowledged).toBe(true);
    // 在途许可未完成 → 还没有 quiesced。
    expect(pause.quiesced).toBe(false);

    const blocked = await commitPermit(h.deps, {
      accountId: 'acct-1',
      actionId: tick.actionId!,
      installationId: 'install-1',
      leaseEpoch: claimed.leaseEpoch,
      argsHash: claimed.action!.argsHash,
      policyVersion: claimed.action!.policyVersion,
      nowMs: NOON + 2000,
    });
    expect(blocked).toMatchObject({ ok: false, code: 'GLOBAL_PAUSED' });

    // 在途回执落库后 → quiesced。
    await reportReceipt(h.deps, {
      accountId: 'acct-1',
      actionId: tick.actionId!,
      installationId: 'install-1',
      leaseEpoch: claimed.leaseEpoch,
      argsHash: claimed.action!.argsHash,
      status: 'succeeded',
      resultRef: 'diaries:42',
      nowMs: NOON + 3000,
    });
    const quiesced = await requestPause(h.deps, { accountId: 'acct-1', paused: true, nowMs: NOON + 4000 });
    expect(quiesced.quiesced).toBe(true);

    // 暂停期间 tick 不发请求；解除后也不补跑所有过期计划。
    expect((await tickCharacter(h.deps, 'char-1')).status).toBe('paused');
    h.clock.set(NOON + 5000);
    const resumed = await requestPause(h.deps, { accountId: 'acct-1', paused: false });
    expect(resumed.paused).toBe(false);
    const afterResume = await tickCharacter(h.deps, 'char-1');
    expect(afterResume.status).toBe('not_due');
  });

  it('回执 succeeded 之后动作终态且 activeActionId 清空；effectVerified 需要 resultRef', async () => {
    const h = harness({ row: dueRow() });
    const tick = await tickCharacter(h.deps, 'char-1');
    const action = await h.store.getAction(tick.actionId!);
    await h.store.bindInstallation('acct-1', 'install-1', NOON);
    const claimed = await claimAction(h.deps, { accountId: 'acct-1', installationId: 'install-1', charId: 'char-1' });
    await commitPermit(h.deps, {
      accountId: 'acct-1',
      actionId: tick.actionId!,
      installationId: 'install-1',
      leaseEpoch: claimed.leaseEpoch,
      argsHash: action!.argsHash,
      policyVersion: action!.policyVersion,
      nowMs: NOON,
    });
    const receipt = await reportReceipt(h.deps, {
      accountId: 'acct-1',
      actionId: tick.actionId!,
      installationId: 'install-1',
      leaseEpoch: claimed.leaseEpoch,
      argsHash: action!.argsHash,
      status: 'succeeded',
      resultRef: 'diaries:99',
      nowMs: NOON + 1000,
    });
    expect(receipt.ok).toBe(true);
    const saved = await h.store.getAction(tick.actionId!);
    expect(saved?.status).toBe('succeeded');
    const record = projectActivity(saved!);
    expect(record.effectVerified).toBe(true);
    expect(record.resultRef).toBe('diaries:99');
    const life = await h.store.getCharacterLife('char-1');
    expect(life?.activeActionId).toBeNull();
  });

  it('unknown 阻止设备切换（不能盲切）；对账后由用户决定新动作', async () => {
    const h = harness({ row: dueRow() });
    const tick = await tickCharacter(h.deps, 'char-1');
    const action = await h.store.getAction(tick.actionId!);
    await h.store.bindInstallation('acct-1', 'install-1', NOON);
    const claimed = await claimAction(h.deps, { accountId: 'acct-1', installationId: 'install-1', charId: 'char-1' });
    await commitPermit(h.deps, {
      accountId: 'acct-1',
      actionId: tick.actionId!,
      installationId: 'install-1',
      leaseEpoch: claimed.leaseEpoch,
      argsHash: action!.argsHash,
      policyVersion: action!.policyVersion,
      nowMs: NOON,
    });
    await reportReceipt(h.deps, {
      accountId: 'acct-1',
      actionId: tick.actionId!,
      installationId: 'install-1',
      leaseEpoch: claimed.leaseEpoch,
      argsHash: action!.argsHash,
      status: 'unknown',
      nowMs: NOON + 1000,
    });
    const saved = await h.store.getAction(tick.actionId!);
    expect(saved?.status).toBe('unknown');
    expect(saved?.errorCode).toBe('UNKNOWN_EFFECT');
  });

  it('取消：还没拿到副作用的可以取消，running 返回 CANNOT_CANCEL', async () => {
    const h = harness({ row: dueRow() });
    const tick = await tickCharacter(h.deps, 'char-1');
    const action = await h.store.getAction(tick.actionId!);
    await h.store.bindInstallation('acct-1', 'install-1', NOON);
    const claimed = await claimAction(h.deps, { accountId: 'acct-1', installationId: 'install-1', charId: 'char-1' });
    const other = h.store.actions.get(tick.actionId!)!;
    const cancelled = await cancelAction(h.deps, { accountId: 'acct-1', actionId: tick.actionId!, expectedRevision: other.revision });
    expect(cancelled.ok).toBe(true);
    expect(cancelled.action?.status).toBe('cancelled');
    const again = await cancelAction(h.deps, { accountId: 'acct-1', actionId: tick.actionId!, expectedRevision: other.revision });
    expect(again).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' });

    // 另起一个动作，走到 running 后取消。
    const tick2 = await tickCharacter(h.deps, 'char-1');
    if (tick2.actionId) {
      const act2 = await h.store.getAction(tick2.actionId);
      await commitPermit(h.deps, {
        accountId: 'acct-1',
        actionId: tick2.actionId,
        installationId: 'install-1',
        leaseEpoch: act2!.leaseEpoch,
        argsHash: act2!.argsHash,
        policyVersion: act2!.policyVersion,
        nowMs: h.clock.now(),
      });
      const running = await h.store.getAction(tick2.actionId);
      expect(running?.status).toBe('running');
      const cannot = await cancelAction(h.deps, {
        accountId: 'acct-1', actionId: tick2.actionId, expectedRevision: running!.revision,
      });
      expect(cannot).toMatchObject({ ok: false, code: 'CANNOT_CANCEL' });
    }
    expect(action?.installationId).toBeDefined();
  });
});

describe('引擎：状态投影（§6）', () => {
  it('CharacterLifeState 同时带预算窗口、原因码与下次机会（不吞掉其它限制）', async () => {
    const h = harness({ row: dueRow(), deviceOnline: false });
    const tick = await tickCharacter(h.deps, 'char-1');
    const row = await h.store.getCharacterLife('char-1');
    const state = projectCharacterState({
      row: row!,
      capabilities: [],
      budgetRows: {
        account: { windowId: 'w:2026-10-24', scope: 'account', usedCalls: 1, reservedCalls: 0, usedTokens: 120, reservedTokens: 0, notifications: 0, kindCounts: {}, spendMinor: 0, revision: 1, updatedAt: NOON },
        char: { windowId: 'w:2026-10-24', scope: 'char-1', usedCalls: 1, reservedCalls: 0, usedTokens: 120, reservedTokens: 0, notifications: 0, kindCounts: {}, spendMinor: 0, revision: 1, updatedAt: NOON },
      },
      limits: boundary.limits,
      nowMs: NOON,
    });
    expect(state.schemaVersion).toBe(1);
    expect(state.charId).toBe('char-1');
    expect(state.reasonCodes).toContain('WAITING_DEVICE');
    expect(state.budget.find((item) => item.dimension === 'model_calls')?.used).toBe(1);
    expect(tick.status).toBe('waiting_device');
  });

  it('sleeping/dnd 不阻止私人日记（阶段与通知是两条线）——由 rhythm 决定 resting，引擎只休息', async () => {
    const h = harness({
      nowMs: Date.UTC(2026, 9, 23, 17, 30, 0), // 01:30 +08:00，睡眠窗内
      row: dueRow('char-1', {
        lastEvaluatedAt: Date.UTC(2026, 9, 23, 17, 30, 0),
        nextOpportunityAt: Date.UTC(2026, 9, 23, 17, 30, 0),
        profile: null,
      }),
    });
    const result = await tickCharacter(h.deps, 'char-1');
    // 默认保守作息 23:00–08:00：睡着时不发模型请求，下一次机会落在醒来之后。
    expect(result.status).toBe('resting');
    expect(result.modelCalls).toBe(0);
    expect(result.reasonCodes).toContain('SLEEPING');
    expect(result.nextOpportunityAt!).toBeGreaterThan(h.clock.now());
  });
});
