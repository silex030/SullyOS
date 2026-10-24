/**
 * 端到端：引擎 → 领取 → 许可 → 本地执行 → 回执（契约 §4.2/§4.3、场景 D/E/K）。
 *
 * 这条链是「自主动作真的落地」的唯一通路：任何一处失败都必须如实反映，不能把
 * 「已登记」说成「已完成」。这里用真实 fake-indexeddb + 内存调度存储跑完整链路。
 *
 * 契约是「无许可不发生」：动作先由引擎条件提交签发一次性许可，执行器**只能**用
 * 提交后的动作行 + 许可执行；claim 时的旧快照、没有许可、许可过期、非本机设备
 * 一律拒绝，且拒绝时业务 store 一个字节都不写（见下面的零写入断言）。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { EffectiveBoundaryV1, ExecutionPermit } from '../../contracts/autonomyLife';
import { hashArgs } from '../../contracts/autonomyLife';
import { DB, openDB } from '../db';
import type { BankFullState } from '../../types';
import type { BudgetPort } from './budget';
import { createMemoryBudgetPort } from './budget';
import {
  buildActionRow,
  claimAction,
  commitPermit,
  createInMemoryLifeStore,
  emptyCharacterLife,
  projectActivity,
  reportReceipt,
  tickCharacter,
  type ActionRow,
  type CharacterLifeRow,
  type EngineDeps,
} from './engine';
import { createLocalDbPort, readReceipt, type LocalDbPort } from './localLedger';
import { runLocalAction, reuploadReceipt } from './localRunner';
import type { Candidate } from './rhythm';
import { createManualClock, localDateKey } from './time';

const TZ = 'Asia/Shanghai';
const NOW = Date.UTC(2026, 9, 24, 4, 0, 0);
const CHAR = 'char-e2e';

const boundary: EffectiveBoundaryV1 = {
  schemaVersion: 1,
  revision: 1,
  scope: 'account',
  enabled: true,
  globalPaused: false,
  charEnabled: true,
  timezone: TZ,
  allowedKinds: ['journal.write'],
  forbiddenCategories: ['gambling', 'real_finance'],
  avoidTopics: [],
  allowFictionalNpc: false,
  doNotDisturb: null,
  limits: {
    accountModelCallsPerDay: 6,
    charModelCallsPerDay: 2,
    accountTokensPerDay: 100_000,
    charTokensPerDay: 40_000,
    notificationsPerDay: 1,
    perKindActionsPerDay: 3,
    virtualSpendPerDayMinor: 20_000,
    virtualOrderMaxMinor: 5_000,
  },
  externalGrants: [],
};

const CANDIDATES: Candidate[] = [{
  kind: 'journal.write',
  semanticPurpose: 'daily_note',
  args: { title: '今天', body: '雨停之后去楼下走了走。', mood: 'calm' },
}];

let port: LocalDbPort;

async function resetDb(): Promise<void> {
  const db = await openDB();
  const names = [
    'diaries', 'messages', 'autonomy_action_receipts', 'autonomy_local_life',
    'bank_data', 'bank_transactions', 'autonomy_sim_vouchers', 'autonomy_action_permits',
  ];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(names, 'readwrite');
    for (const name of names) tx.objectStore(name).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function diaryCount(): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('diaries', 'readonly').objectStore('diaries').count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

interface Harness {
  deps: EngineDeps;
  store: ReturnType<typeof createInMemoryLifeStore>;
  clock: ReturnType<typeof createManualClock>;
}

function harness(opts?: { deviceOnline?: boolean }): Harness {
  const clock = createManualClock(NOW);
  const store = createInMemoryLifeStore();
  const budget = createMemoryBudgetPort();
  const row: CharacterLifeRow = {
    ...emptyCharacterLife(CHAR, NOW, TZ),
    lastEvaluatedAt: NOW,
    nextOpportunityAt: NOW,
  };
  store.characters.set(CHAR, row);
  const deps: EngineDeps = {
    store,
    budget: budget as BudgetPort,
    clock,
    seed: 'install-seed-e2e',
    accountId: 'acct-e2e',
    deviceOnline: async () => opts?.deviceOnline ?? true,
    probes: async () => ({
      localStoresReady: true,
      deviceBound: true,
      hasModelCredentials: true,
      externalRead: { configured: false, reachable: false },
      map: { configured: false, reachable: false },
    }),
    boundaryFor: async () => boundary,
    candidatesFor: () => CANDIDATES,
    model: { request: async () => ({ candidates: CANDIDATES, tokensUsed: 90 }) },
  };
  return { deps, store, clock };
}

/**
 * 引擎侧的正规链路：claim → commitPermit，返回**提交后**的动作行与许可。
 * 执行器只认这一份：claim 返回的行还是 scheduled、也没有许可字段。
 */
async function permitFor(h: Harness, actionId: string, at = NOW) {
  await h.store.bindInstallation('acct-e2e', 'install-e2e', at);
  const claimed = await claimAction(h.deps, { accountId: 'acct-e2e', installationId: 'install-e2e', charId: CHAR });
  expect(claimed.action?.id).toBe(actionId);
  const permit = await commitPermit(h.deps, {
    accountId: 'acct-e2e',
    actionId,
    installationId: 'install-e2e',
    leaseEpoch: claimed.leaseEpoch,
    argsHash: claimed.action!.argsHash,
    policyVersion: claimed.action!.policyVersion,
    nowMs: at,
  });
  expect(permit.ok).toBe(true);
  return { permit: permit.permit!, action: (await h.store.getAction(actionId))! };
}

function run(
  h: Harness,
  action: ActionRow,
  permit: ExecutionPermit | null,
  extra?: { localPaused?: boolean; port?: LocalDbPort | null; boundaryFor?: () => Promise<EffectiveBoundaryV1> },
) {
  return runLocalAction({
    deps: h.deps,
    port: extra && 'port' in extra ? extra.port ?? null : port,
    action,
    installationId: 'install-e2e',
    nowMs: NOW,
    policyVersion: action.policyVersion,
    permit,
    boundaryFor: extra?.boundaryFor ?? (async () => boundary),
    localPaused: extra?.localPaused,
  });
}

beforeEach(async () => {
  await resetDb();
  const bank: BankFullState = {
    config: { dailyBudget: 100, currencySymbol: '¥' } as BankFullState['config'],
    shop: {} as BankFullState['shop'],
    goals: [],
    cards: [{ id: 'card-1', name: '零花卡', tailNo: '1002', balance: 500, isDefault: true, owner: 'char', ownerId: CHAR }],
    todaySpent: 0,
    lastLoginDate: '2026-10-24',
  };
  await DB.saveBankState(bank);
  port = createLocalDbPort(await openDB());
});

describe('端到端：一次自主动作的完整链路（场景 D/E/K）', () => {
  it('tick → claim → permit → 本地事务 → 回执 → 状态收口', async () => {
    const h = harness();
    const tick = await tickCharacter(h.deps, CHAR);
    expect(tick.status).toBe('scheduled');
    expect(tick.actionId).toBeTruthy();

    const { action, permit } = await permitFor(h, tick.actionId!);
    // 提交后：running + 许可字段都在同一份动作行上（执行器不能拿 claim 快照）。
    expect(action.status).toBe('running');
    expect(action.permitIssuedAt).toBe(NOW);
    expect(action.permitNonce).toBe(permit.nonce);
    expect(action.permitConsumedAt).toBeNull();

    const result = await run(h, action, permit);
    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') return;
    expect(result.effectVerified).toBe(true);
    expect(result.resultRef).toMatch(/^diaries:diary_char-e2e_/);
    expect(await diaryCount()).toBe(1);

    // 本地回执与云端状态都收口：动作 succeeded、activeActionId 清空、记录 effectVerified。
    const receipt = await readReceipt(port, tick.actionId!);
    expect(receipt?.resultRef).toBe(result.resultRef);
    const saved = await h.store.getAction(tick.actionId!);
    expect(saved?.status).toBe('succeeded');
    expect(projectActivity(saved!).effectVerified).toBe(true);
    expect(saved?.permitConsumedAt).not.toBeNull();
    const life = await h.store.getCharacterLife(CHAR);
    expect(life?.activeActionId).toBeNull();
    expect(life?.pendingCount).toBe(0);
  });

  it('执行侧第二道门：即使动作已登记，写入前仍会因禁止方向被拒（不留日记/回执）', async () => {
    const h = harness();
    const bypass: ActionRow = {
      ...buildActionRow({
        charId: CHAR,
        chosen: {
          kind: 'journal.write',
          semanticPurpose: 'chat_share',
          purposeKey: 'k-chat',
          args: { title: '今晚', body: '去楼下赌场下了注，赔率不错' },
          reasonSummary: '聊天里提到',
          candidate: CANDIDATES[0],
        },
        nowMs: NOW,
        budgetWindowId: 'w:2026-10-24',
        reservationId: 'rsv-x',
        policyVersion: 'autonomy-life-v1',
        tz: TZ,
        installationId: 'install-e2e',
        online: true,
        source: 'chat_reply',
        sourceRef: 'msg-1',
      }),
      // 假设有人绕过了服务端许可门：执行侧仍必须自己拒绝（第二道强校验）。
      status: 'running',
      leaseEpoch: 1,
      permitIssuedAt: NOW,
      permitNonce: 'nonce-bypass',
      leaseExpiresAt: NOW + 60_000,
    };
    await h.store.insertAction(bypass);
    const forgedPermit: ExecutionPermit = {
      actionId: bypass.id,
      charId: CHAR,
      installationId: 'install-e2e',
      leaseEpoch: 1,
      argsHash: hashArgs(bypass.args),
      policyVersion: bypass.policyVersion,
      reservationId: 'rsv-x',
      nonce: 'nonce-bypass',
      issuedAt: NOW,
      expiresAt: NOW + 60_000,
    };
    const result = await run(h, bypass, forgedPermit);
    expect(result).toMatchObject({ status: 'failed', code: 'POLICY_DENIED' });
    expect(await diaryCount()).toBe(0);
    expect(await readReceipt(port, bypass.id)).toBeNull();
  });

  it('本地已暂停 → 不执行；没有本地库 → CAPABILITY_UNAVAILABLE（不假装完成）', async () => {
    const h = harness();
    const tick = await tickCharacter(h.deps, CHAR);
    const { action, permit } = await permitFor(h, tick.actionId!);
    const paused = await run(h, action, permit, { localPaused: true });
    expect(paused).toMatchObject({ status: 'failed', code: 'GLOBAL_PAUSED' });
    expect(await diaryCount()).toBe(0);

    const noPort = await run(h, action, permit, { port: null });
    expect(noPort).toMatchObject({ status: 'failed', code: 'CAPABILITY_UNAVAILABLE' });
    expect(await diaryCount()).toBe(0);
    // 两次拒绝都没有消费许可，也没有业务写入。
    expect(await readReceipt(port, action.id)).toBeNull();
  });

  it('设备离线时动作停在 waiting_device（不说「App 已完成」）；设备回来可继续', async () => {
    const h = harness({ deviceOnline: false });
    const tick = await tickCharacter(h.deps, CHAR);
    expect(tick.status).toBe('waiting_device');
    const action = (await h.store.getAction(tick.actionId!))!;
    expect(action.status).toBe('waiting_device');
    expect(await diaryCount()).toBe(0);

    // 设备回来后 claim 得到同一动作，领到许可再执行。
    const permitted = await permitFor(h, action.id);
    const result = await run(h, permitted.action, permitted.permit);
    expect(result.status).toBe('succeeded');
    expect(await diaryCount()).toBe(1);
  });

  it('崩溃恢复：本地有回执但云端未收到 → 用原 actionId 补报，不重做业务动作', async () => {
    const h = harness();
    const tick = await tickCharacter(h.deps, CHAR);
    const { action, permit } = await permitFor(h, tick.actionId!);
    const executed = await run(h, action, permit);
    expect(executed.status).toBe('succeeded');
    // 云端状态被当作「还没收到」：这里用一个新的内存 store 模拟云端记录丢失。
    const cloud = createInMemoryLifeStore();
    await cloud.insertAction({ ...action, status: 'running', resultRef: null, permitConsumedAt: null });
    const receipt = await readReceipt(port, tick.actionId!);
    const reuploaded = await reuploadReceipt({
      deps: { ...h.deps, store: cloud },
      action,
      installationId: 'install-e2e',
      nowMs: NOW + 1000,
      receipt,
    });
    expect(reuploaded.ok).toBe(true);
    const healed = await cloud.getAction(tick.actionId!);
    expect(healed?.status).toBe('succeeded');
    expect(await diaryCount()).toBe(1); // 没有第二次写日记
  });
});

describe('端到端：没有许可就没有执行', () => {
  it('缺许可 / 过期 / 错 hash / 未 claim / 已消费 / 换设备：全部拒绝且零业务写入', async () => {
    const h = harness();
    const tick = await tickCharacter(h.deps, CHAR);
    const { action, permit } = await permitFor(h, tick.actionId!);

    const cases: Array<{ name: string; runIt: () => ReturnType<typeof run> }> = [
      { name: '缺许可', runIt: () => run(h, action, null) },
      { name: '许可过期', runIt: () => run(h, action, { ...permit, expiresAt: NOW - 1 }) },
      { name: '错 hash', runIt: () => run(h, action, { ...permit, argsHash: 'deadbeef' }) },
      { name: '错 nonce', runIt: () => run(h, action, { ...permit, nonce: 'another-nonce' }) },
      { name: '未 claim（动作还是 scheduled）', runIt: () => run(h, { ...action, status: 'scheduled' }, permit) },
      { name: '已消费', runIt: () => run(h, { ...action, permitConsumedAt: NOW - 1 }, permit) },
      { name: '换设备', runIt: () => run(h, { ...action, installationId: 'other-device' }, permit) },
      { name: '租约代次不符', runIt: () => run(h, { ...action, leaseEpoch: action.leaseEpoch + 1 }, permit) },
    ];

    for (const item of cases) {
      const result = await item.runIt();
      expect(result.status, item.name).toBe('failed');
      expect(await diaryCount(), item.name).toBe(0);
      expect(await readReceipt(port, action.id), item.name).toBeNull();
    }

    // 这些拒绝都不该把动作推向终态：许可仍可被（同一个）执行器正确使用一次。
    const ok = await run(h, action, permit);
    expect(ok.status).toBe('succeeded');
    expect(await diaryCount()).toBe(1);
  });

  it('角色暂停 / 边界撤销：执行前现读的边界说了算（旧快照不能放行）', async () => {
    const h = harness();
    const tick = await tickCharacter(h.deps, CHAR);
    const { action, permit } = await permitFor(h, tick.actionId!);

    const paused = await run(h, action, permit, {
      boundaryFor: async () => ({ ...boundary, globalPaused: true }),
    });
    expect(paused).toMatchObject({ status: 'failed', code: 'GLOBAL_PAUSED' });
    expect(await diaryCount()).toBe(0);

    const disabled = await run(h, action, permit, {
      boundaryFor: async () => ({ ...boundary, charEnabled: false }),
    });
    expect(disabled.status).toBe('failed');

    const kindOff = await run(h, action, permit, {
      boundaryFor: async () => ({ ...boundary, allowedKinds: [] }),
    });
    expect(kindOff.status).toBe('failed');

    expect(await diaryCount()).toBe(0);
    expect(await readReceipt(port, action.id)).toBeNull();
  });

  it('同一许可不能用第二次（本地许可已核销，重放被事务/许可层拒绝）', async () => {
    const h = harness();
    const tick = await tickCharacter(h.deps, CHAR);
    const { action, permit } = await permitFor(h, tick.actionId!);
    const first = await run(h, action, permit);
    expect(first.status).toBe('succeeded');

    // 正常重放（回执还在）是幂等的：不重写、返回旧回执。
    const replay = await run(h, { ...action, permitConsumedAt: null }, permit);
    expect(replay.status).toBe('succeeded');
    expect(await diaryCount()).toBe(1);

    // 即使有人把本地回执删掉，已核销的许可也不能再执行一次业务写入。
    await port.runTransaction(['autonomy_action_receipts'], 'readwrite', async (tx) => {
      await tx.del('autonomy_action_receipts', action.id);
    });
    const again = await run(h, { ...action, permitConsumedAt: null }, permit);
    expect(again.status).toBe('failed');
    expect(await diaryCount()).toBe(1);
  });

  it('伪造回执：没有许可的动作不能报成功；错 argsHash / 换设备都拒绝', async () => {
    const h = harness();
    const tick = await tickCharacter(h.deps, CHAR);
    const scheduled = (await h.store.getAction(tick.actionId!))!;

    const forged = await reportReceipt(h.deps, {
      accountId: 'acct-e2e',
      actionId: scheduled.id,
      installationId: 'install-e2e',
      leaseEpoch: scheduled.leaseEpoch,
      argsHash: scheduled.argsHash,
      status: 'succeeded',
      resultRef: 'diaries:forged',
      nowMs: NOW,
    });
    expect(forged.ok).toBe(false);
    expect((await h.store.getAction(scheduled.id))?.status).toBe('scheduled');

    const { action: permitted } = await permitFor(h, tick.actionId!);
    const wrongHash = await reportReceipt(h.deps, {
      accountId: 'acct-e2e',
      actionId: permitted.id,
      installationId: 'install-e2e',
      leaseEpoch: permitted.leaseEpoch,
      argsHash: 'deadbeef',
      status: 'succeeded',
      resultRef: 'diaries:x',
      nowMs: NOW,
    });
    expect(wrongHash.ok).toBe(false);

    const wrongDevice = await reportReceipt(h.deps, {
      accountId: 'acct-e2e',
      actionId: permitted.id,
      installationId: 'other-device',
      leaseEpoch: permitted.leaseEpoch,
      argsHash: permitted.argsHash,
      status: 'succeeded',
      resultRef: 'diaries:x',
      nowMs: NOW,
    });
    expect(wrongDevice.ok).toBe(false);

    // 仍然允许真正的回执收尾一次。
    const ok = await reportReceipt(h.deps, {
      accountId: 'acct-e2e',
      actionId: permitted.id,
      installationId: 'install-e2e',
      leaseEpoch: permitted.leaseEpoch,
      argsHash: permitted.argsHash,
      status: 'succeeded',
      resultRef: 'diaries:real',
      nowMs: NOW,
    });
    expect(ok.ok).toBe(true);
  });
});

describe('端到端：时间与存储一致性', () => {
  it('动作 id 里带日期与去重键；同一天重复 tick 不会产生第二个可执行动作', async () => {
    const h = harness();
    const first = await tickCharacter(h.deps, CHAR);
    const action = (await h.store.getAction(first.actionId!))!;
    expect(action.dedupeKey).toHaveLength(8);
    expect(action.id.startsWith(`act_${action.dedupeKey}_`)).toBe(true);
    expect(action.windowId).toBe(`w:${localDateKey(NOW, TZ)}`);
    // 第二次 tick 在冷却内：即使候选还在，也不会产生新动作。
    h.clock.advance(30 * 60_000);
    const row = await h.store.getCharacterLife(CHAR);
    h.store.characters.set(CHAR, { ...row!, nextOpportunityAt: h.clock.now(), lastEvaluatedAt: h.clock.now() });
    const second = await tickCharacter(h.deps, CHAR);
    expect(second.actionId).toBeNull();
    expect(h.store.actions.size).toBe(1);
  });
});
