/**
 * 端到端：引擎 → 领取 → 许可 → 本地执行 → 回执（契约 §4.2/§4.3、场景 D/E/K）。
 *
 * 这条链是「自主动作真的落地」的唯一通路：任何一处失败都必须如实反映，不能把
 * 「已登记」说成「已完成」。这里用真实 fake-indexeddb + 内存调度存储跑完整链路。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { EffectiveBoundaryV1 } from '../../contracts/autonomyLife';
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
  tickCharacter,
  type ActionRow,
  type CharacterLifeRow,
  type EngineDeps,
} from './engine';
import { createLocalDbPort, readReceipt, type LocalDbPort } from './localLedger';
import { runLocalAction, reuploadReceipt } from './localRunner';
import type { Candidate } from './rhythm';
import { createManualClock } from './time';
import { localDateKey } from './time';

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
  const names = ['diaries', 'messages', 'autonomy_action_receipts', 'autonomy_local_life', 'bank_data', 'bank_transactions', 'autonomy_sim_vouchers'];
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

function harness(opts?: { deviceOnline?: boolean }) {
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

    await h.store.bindInstallation('acct-e2e', 'install-e2e', NOW);
    const claimed = await claimAction(h.deps, { accountId: 'acct-e2e', installationId: 'install-e2e', charId: CHAR });
    expect(claimed.action?.id).toBe(tick.actionId);

    const permit = await commitPermit(h.deps, {
      accountId: 'acct-e2e',
      actionId: tick.actionId!,
      installationId: 'install-e2e',
      leaseEpoch: claimed.leaseEpoch,
      argsHash: claimed.action!.argsHash,
      policyVersion: claimed.action!.policyVersion,
      nowMs: NOW,
    });
    expect(permit.ok).toBe(true);

    const result = await runLocalAction({
      deps: h.deps,
      port,
      action: claimed.action!,
      installationId: 'install-e2e',
      nowMs: NOW,
      policyVersion: claimed.action!.policyVersion,
      boundary,
    });
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
    const life = await h.store.getCharacterLife(CHAR);
    expect(life?.activeActionId).toBeNull();
    expect(life?.pendingCount).toBe(0);
  });

  it('执行侧第二道门：即使动作已登记，写入前仍会因禁止方向被拒（不留日记/回执）', async () => {
    const h = harness();
    const clock = h.clock;
    const bypass: ActionRow = buildActionRow({
      charId: CHAR,
      chosen: {
        kind: 'journal.write',
        semanticPurpose: 'chat_share',
        purposeKey: 'k-chat',
        args: { title: '今晚', body: '去楼下赌场下了注，赔率不错' },
        reasonSummary: '聊天里提到',
        candidate: CANDIDATES[0],
      },
      nowMs: clock.now(),
      budgetWindowId: 'w:2026-10-24',
      reservationId: 'rsv-x',
      policyVersion: 'autonomy-life-v1',
      tz: TZ,
      installationId: 'install-e2e',
      online: true,
      source: 'chat_reply',
      sourceRef: 'msg-1',
    });
    await h.store.insertAction(bypass);
    const result = await runLocalAction({
      deps: h.deps,
      port,
      action: { ...bypass, leaseEpoch: 1 },
      installationId: 'install-e2e',
      nowMs: clock.now(),
      policyVersion: 'autonomy-life-v1',
      boundary,
    });
    expect(result).toMatchObject({ status: 'failed', code: 'POLICY_DENIED' });
    expect(await diaryCount()).toBe(0);
    expect(await readReceipt(port, bypass.id)).toBeNull();
  });

  it('本地已暂停 → 不执行；没有本地库 → CAPABILITY_UNAVAILABLE（不假装完成）', async () => {
    const h = harness();
    const tick = await tickCharacter(h.deps, CHAR);
    const action = (await h.store.getAction(tick.actionId!))!;
    const paused = await runLocalAction({
      deps: h.deps, port, action, installationId: 'install-e2e', nowMs: NOW,
      policyVersion: 'autonomy-life-v1', boundary, localPaused: true,
    });
    expect(paused).toMatchObject({ status: 'failed', code: 'GLOBAL_PAUSED' });
    expect(await diaryCount()).toBe(0);

    const noPort = await runLocalAction({
      deps: h.deps, port: null, action, installationId: 'install-e2e', nowMs: NOW,
      policyVersion: 'autonomy-life-v1', boundary,
    });
    expect(noPort).toMatchObject({ status: 'failed', code: 'CAPABILITY_UNAVAILABLE' });
    expect(await diaryCount()).toBe(0);
  });

  it('设备离线时动作停在 waiting_device（不说「App 已完成」）；设备回来可继续', async () => {
    const h = harness({ deviceOnline: false });
    const tick = await tickCharacter(h.deps, CHAR);
    expect(tick.status).toBe('waiting_device');
    const action = (await h.store.getAction(tick.actionId!))!;
    expect(action.status).toBe('waiting_device');
    expect(await diaryCount()).toBe(0);

    // 设备回来后 claim 得到同一动作，执行成功。
    await h.store.bindInstallation('acct-e2e', 'install-e2e', NOW);
    const claimed = await claimAction(h.deps, { accountId: 'acct-e2e', installationId: 'install-e2e', charId: CHAR });
    expect(claimed.action?.id).toBe(action.id);
    const result = await runLocalAction({
      deps: h.deps, port, action: claimed.action!, installationId: 'install-e2e', nowMs: NOW,
      policyVersion: 'autonomy-life-v1', boundary,
    });
    expect(result.status).toBe('succeeded');
  });

  it('崩溃恢复：本地有回执但云端未收到 → 用原 actionId 补报，不重做业务动作', async () => {
    const h = harness();
    const tick = await tickCharacter(h.deps, CHAR);
    await h.store.bindInstallation('acct-e2e', 'install-e2e', NOW);
    const claimed = await claimAction(h.deps, { accountId: 'acct-e2e', installationId: 'install-e2e', charId: CHAR });
    await commitPermit(h.deps, {
      accountId: 'acct-e2e', actionId: tick.actionId!, installationId: 'install-e2e',
      leaseEpoch: claimed.leaseEpoch, argsHash: claimed.action!.argsHash,
      policyVersion: claimed.action!.policyVersion, nowMs: NOW,
    });
    // 本地执行成功；模拟「回执上报丢了」：直接把云端动作回滚成 running 记录不存在。
    const executed = await runLocalAction({
      deps: h.deps, port, action: claimed.action!, installationId: 'install-e2e', nowMs: NOW,
      policyVersion: 'autonomy-life-v1', boundary,
    });
    expect(executed.status).toBe('succeeded');
    // 云端状态被当作「还没收到」：这里用一个新的内存 store 模拟云端记录丢失。
    const cloud = createInMemoryLifeStore();
    await cloud.insertAction({ ...claimed.action!, status: 'running', permitIssuedAt: NOW });
    const receipt = await readReceipt(port, tick.actionId!);
    const reuploaded = await reuploadReceipt({
      deps: { ...h.deps, store: cloud },
      action: { ...claimed.action!, leaseEpoch: claimed.leaseEpoch },
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

describe('端到端：时间与存储一致性', () => {
  it('动作 id 里带日期与去重键；同一天重复 tick 不会产生第二个可执行动作', async () => {
    const h = harness();
    const first = await tickCharacter(h.deps, CHAR);
    const action = (await h.store.getAction(first.actionId!))!;
    expect(action.dedupeKey).toHaveLength(8);
    expect(action.id.startsWith(`act_${action.dedupeKey}_`)).toBe(true);
    // 第二次 tick 在冷却内：即使候选还在，也不会产生新动作。
    h.clock.advance(30 * 60_000);
    const row = await h.store.getCharacterLife(CHAR);
    h.store.characters.set(CHAR, { ...row!, nextOpportunityAt: h.clock.now(), lastEvaluatedAt: h.clock.now() });
    const second = await tickCharacter(h.deps, CHAR);
    expect(second.actionId).toBeNull();
    expect(h.store.actions.size).toBe(1);
  });
});
