/**
 * 执行器（浏览器侧）：register → claim → permit → 本地事务 → 回执。
 *
 * 用真实 fake-indexeddb 跑本地事务，服务端用可编程的假 api（只实现执行链需要的
 * 四个方法）。这里钉住：
 *   1. 没有许可 / permit 被拒 → 业务 store 一个字节不写；
 *   2. 正常链路 → 本地写入 + 回执带 actionId/leaseEpoch/argsHash/installationId；
 *   3. 回执送不出去 → 进待补报队列，下次用**原 actionId** 重传，不重做业务动作。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { AutonomyLifeApi, ClaimPayload } from './api';
import type { EffectiveBoundaryV1, ExecutionPermit } from '../../contracts/autonomyLife';
import { hashArgs } from '../../contracts/autonomyLife';
import { DB, openDB } from '../db';
import type { BankFullState } from '../../types';
import { createAutonomyLifeExecutor, type PendingReceipt, type PendingReceiptStore } from './executor';
import { createLocalDbPort, type LocalDbPort } from './localLedger';

const NOW = Date.UTC(2026, 9, 24, 4, 0, 0);
const CHAR = 'char-exec';

const boundary: EffectiveBoundaryV1 = {
  schemaVersion: 1,
  revision: 1,
  scope: 'account',
  enabled: true,
  globalPaused: false,
  charEnabled: true,
  timezone: 'Asia/Shanghai',
  allowedKinds: ['journal.write'],
  forbiddenCategories: [],
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

const actionArgs = { title: '今天', body: '雨停之后去楼下走了走。' };

function actionWire(argsHash: string, over: Record<string, unknown> = {}) {
  return {
    id: 'act-exec-1',
    charId: CHAR,
    kind: 'journal.write' as const,
    status: 'running' as const,
    args: actionArgs,
    argsHash,
    policyVersion: 'autonomy-life-v1',
    leaseEpoch: 1,
    leaseExpiresAt: NOW + 60_000,
    permitIssuedAt: NOW,
    permitNonce: 'nonce-exec',
    permitConsumedAt: null,
    installationId: 'inst-exec',
    revision: 2,
    windowId: 'w:2026-10-24',
    expiresAt: NOW + 6 * 60 * 60_000,
    ...over,
  } as never;
}

const permitFor = (argsHash: string): ExecutionPermit => ({
  actionId: 'act-exec-1',
  charId: CHAR,
  installationId: 'inst-exec',
  leaseEpoch: 1,
  argsHash,
  policyVersion: 'autonomy-life-v1',
  reservationId: 'rsv-exec',
  nonce: 'nonce-exec',
  issuedAt: NOW,
  expiresAt: NOW + 60_000,
});

interface FakeServer {
  api: AutonomyLifeApi;
  receipts: Array<Record<string, unknown>>;
  commitCalls: number;
  claimPayload: ClaimPayload | null;
  permitOk: boolean;
  receiptOk: boolean;
}

function fakeServer(argsHash: string, overrides?: Partial<FakeServer>): FakeServer {
  const server: FakeServer = {
    receipts: [],
    commitCalls: 0,
    claimPayload: { action: actionWire(argsHash), leaseEpoch: 1, leaseExpiresAt: NOW + 60_000 },
    permitOk: true,
    receiptOk: true,
    api: null as never,
    ...overrides,
  };
  server.api = {
    registerDevice: async () => ({ ok: true, data: { bindingState: 'bound' } }),
    claim: async () => ({ ok: true, data: server.claimPayload! }),
    commitPermit: async () => {
      server.commitCalls += 1;
      if (!server.permitOk) return { ok: false, code: 'GLOBAL_PAUSED', status: 403 };
      return { ok: true, data: { permit: permitFor(argsHash), action: actionWire(argsHash) } };
    },
    receipt: async (input: Parameters<AutonomyLifeApi['receipt']>[0]) => {
      server.receipts.push(input as unknown as Record<string, unknown>);
      if (!server.receiptOk) return { ok: false, code: 'SERVICE_UNAVAILABLE', status: 503 };
      return { ok: true, data: { action: actionWire(argsHash, { status: 'succeeded', permitConsumedAt: NOW }) } };
    },
  } as unknown as AutonomyLifeApi;
  return server;
}

let port: LocalDbPort;

async function resetDb(): Promise<void> {
  const db = await openDB();
  const names = [
    'diaries', 'autonomy_action_receipts', 'autonomy_action_permits',
    'bank_data', 'bank_transactions', 'shopping_orders', 'autonomy_sim_vouchers', 'autonomy_local_life',
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

function memoryPending(): PendingReceiptStore & { items: PendingReceipt[] } {
  const store = {
    items: [] as PendingReceipt[],
    read() { return [...store.items]; },
    write(items: PendingReceipt[]) { store.items = [...items]; },
  };
  return store;
}

beforeEach(async () => {
  await resetDb();
  const bank: BankFullState = {
    config: { dailyBudget: 100, currencySymbol: '¥' } as BankFullState['config'],
    shop: {} as BankFullState['shop'],
    goals: [],
    cards: [],
    todaySpent: 0,
    lastLoginDate: '2026-10-24',
  };
  await DB.saveBankState(bank);
  port = createLocalDbPort(await openDB());
});

describe('执行器：唯一的前台执行入口', () => {
  it('正常链路：claim → permit → 本地事务 → 回执（带 argsHash/installationId）', async () => {
    const argsHash = hashArgs(actionArgs);
    const server = fakeServer(argsHash);
    const pending = memoryPending();
    const executor = createAutonomyLifeExecutor({
      api: server.api,
      installationId: 'inst-exec',
      charIds: () => [CHAR],
      openPort: async () => port,
      boundaryFor: async () => boundary,
      now: () => NOW,
      pending,
    });

    const outcomes = await executor.runOnce();
    expect(outcomes[0].result?.status).toBe('succeeded');
    expect(await diaryCount()).toBe(1);
    expect(server.receipts.length).toBe(1);
    expect(server.receipts[0]).toMatchObject({
      actionId: 'act-exec-1',
      installationId: 'inst-exec',
      leaseEpoch: 1,
      argsHash,
      status: 'succeeded',
    });
    expect(pending.items.length).toBe(0);

    // 第二轮：服务端已经没有可领的动作 → 不重复写。
    server.claimPayload = { action: null, leaseEpoch: 0, leaseExpiresAt: null };
    await executor.runOnce();
    expect(await diaryCount()).toBe(1);
  });

  it('permit 被服务端拒绝 → 不做任何本地写（停用/暂停优先于执行）', async () => {
    const argsHash = hashArgs(actionArgs);
    const server = fakeServer(argsHash, { permitOk: false });
    const executor = createAutonomyLifeExecutor({
      api: server.api,
      installationId: 'inst-exec',
      charIds: () => [CHAR],
      openPort: async () => port,
      boundaryFor: async () => boundary,
      now: () => NOW,
      pending: memoryPending(),
    });
    const outcomes = await executor.runOnce();
    expect(outcomes[0].claimed).toBe(true);
    expect(outcomes[0].result).toBeNull();
    expect(outcomes[0].note).toBe('GLOBAL_PAUSED');
    expect(await diaryCount()).toBe(0);
    expect(server.receipts.length).toBe(0);
  });

  it('本地库缺失（老版本没 upgrade）→ 不执行、不伪造回执', async () => {
    const argsHash = hashArgs(actionArgs);
    const server = fakeServer(argsHash);
    const executor = createAutonomyLifeExecutor({
      api: server.api,
      installationId: 'inst-exec',
      charIds: () => [CHAR],
      openPort: async () => null,
      boundaryFor: async () => boundary,
      now: () => NOW,
      pending: memoryPending(),
    });
    const outcomes = await executor.runOnce();
    expect(outcomes).toEqual([]);
    expect(server.receipts.length).toBe(0);
  });

  it('回执送不出去 → 进待补报；下一轮用原 actionId 补报，不重做业务动作', async () => {
    const argsHash = hashArgs(actionArgs);
    const server = fakeServer(argsHash, { receiptOk: false });
    const pending = memoryPending();
    const executor = createAutonomyLifeExecutor({
      api: server.api,
      installationId: 'inst-exec',
      charIds: () => [CHAR],
      openPort: async () => port,
      boundaryFor: async () => boundary,
      now: () => NOW,
      pending,
    });

    const first = await executor.runOnce();
    // 本地效果为真：即使回执没送到，也报 succeeded（效果已验证）。
    expect(first[0].result?.status).toBe('succeeded');
    expect(await diaryCount()).toBe(1);
    expect(pending.items.length).toBe(1);

    // 云端恢复：本轮先补报，再领（本轮已没有可领动作）。
    server.receiptOk = true;
    server.claimPayload = { action: null, leaseEpoch: 0, leaseExpiresAt: null };
    await executor.runOnce();
    expect(pending.items.length).toBe(0);
    expect(server.receipts.filter((item) => item.status === 'succeeded').length).toBeGreaterThanOrEqual(2);
    expect(await diaryCount()).toBe(1);
  });
});
