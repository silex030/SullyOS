/**
 * 本地原子写入（契约 §4.3、§10-D/E）——跑真实 fake-indexeddb：
 *   - 业务记录 + action receipt 同一事务；回执幂等/冲突；
 *   - 模拟订单：余额（元）+ 流水 + 订单 + 凭证 + 回执同事务，任一步失败全不提交；
 *   - 含配送费不足 / 负数 / 空地址 / 卡归属不符全部拒绝，且余额不动；
 *   - 退款同事务、重复退款不加第二次钱；
 *   - 旧消费入口（charOrder）改用的原子扣款只扣一次。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { DB, openDB } from '../db';
import type { BankFullState } from '../../types';
import {
  createLocalDbPort,
  debitCharCardAtomic,
  installLocalPermit,
  openAutonomyLocalDb,
  readLocalPermit,
  placeSimulatedOrder,
  readReceipt,
  refundCharCardAtomic,
  refundSimulatedOrder,
  writeInteractionMessage,
  writeJournalEntry,
  writePhoneRecord,
  writeRoomNote,
  writeRoomPlan,
  type JournalArgs,
  type InteractionMessageArgs,
  type LocalDbPort,
  type LocalPermitRecord,
  type LocalWriteOutcome,
  type PhoneRecordArgs,
  type RefundArgs,
  type RoomNoteArgs,
  type RoomPlanArgs,
  type SimulatedOrderArgs,
} from './localLedger';
import { signedArgsHash } from './executionPermit';
import { reconcileAction } from './adapters';
import { createManualClock } from './time';

const NOW = Date.UTC(2026, 9, 24, 4, 0, 0);
const CHAR = 'char-test-1';

let port: LocalDbPort;

const bankState = (balance: number, overrides: Partial<BankFullState> = {}): BankFullState => ({
  config: { dailyBudget: 100, currencySymbol: '¥' } as BankFullState['config'],
  shop: {} as BankFullState['shop'],
  goals: [],
  cards: [{
    id: 'card-char-1',
    name: '零花卡',
    tailNo: '1002',
    balance,
    isDefault: true,
    owner: 'char',
    ownerId: CHAR,
  }],
  todaySpent: 0,
  lastLoginDate: '2026-10-24',
  ...overrides,
});

async function resetDb(): Promise<void> {
  const db = await openDB();
  const names = [
    'diaries', 'room_todos', 'room_notes', 'messages', 'shopping_orders',
    'bank_transactions', 'bank_data', 'autonomy_action_receipts',
    'autonomy_sim_vouchers', 'autonomy_local_life',
  ];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(names, 'readwrite');
    for (const name of names) tx.objectStore(name).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function readBalance(): Promise<number> {
  const bank = await DB.getBankState();
  return bank?.cards?.find((card) => card.id === 'card-char-1')?.balance ?? Number.NaN;
}

async function count(store: string): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const orderArgs = (overrides: Record<string, unknown> = {}) => ({
  charId: CHAR,
  orderId: 'ORD-1',
  shopId: 'shop-1',
  shopName: '楼下便利店',
  shopCat: '超市便利',
  category: 'grocery',
  items: [{ dishId: 'd1', name: '酸奶', unitPriceMinor: 850, qty: 2 }],
  addressText: '模拟地址 A',
  deliveryFeeMinor: 300,
  cardId: 'card-char-1',
  ...overrides,
});

let permitSeq = 0;

/**
 * 直连本地库的用例要一张「等价的一次性许可」：生产里它由服务端签发、执行器安装，
 * 这里在测试里按同一口径（参数 hash = 去掉 top-level charId 的稳定 hash、短 TTL、
 * 唯一 nonce）现场造一张并安装，用来验证本地事务的许可核销语义。
 */
async function permitFor(
  actionId: string,
  args: Record<string, unknown>,
  nowMs = NOW,
  overrides: Partial<LocalPermitRecord> = {},
): Promise<LocalPermitRecord> {
  // 同一 actionId 的重复调用（幂等重放 / 冲突用例）沿用已安装的那一张：
  // 已消费的许可不会被覆盖，这也正是「同一许可不能用第二次」的本地证据。
  const existing = await readLocalPermit(port, actionId);
  if (existing) return existing;
  permitSeq += 1;
  const permit: LocalPermitRecord = {
    actionId,
    charId: CHAR,
    installationId: 'install-test',
    leaseEpoch: 1,
    argsHash: signedArgsHash(args),
    policyVersion: 'autonomy-life-v1',
    nonce: `nonce_test_${actionId}_${permitSeq}`,
    issuedAt: nowMs,
    expiresAt: nowMs + 60_000,
    consumedAt: null,
    ...overrides,
  };
  const installed = await installLocalPermit(port, permit);
  if (!installed.ok) throw new Error(installed.reason);
  return permit;
}

/**
 * 带许可的本地写入口（测试专用包装）：生产路径由 adapters.executeAction 组装，
 * 这里只负责「先领许可再写」，让每个用例聚焦在被测语义上。
 */
const local = {
  journal: async (input: Omit<JournalArgs, 'permit'>): Promise<LocalWriteOutcome> =>
    writeJournalEntry(port, { ...input, permit: await permitFor(input.actionId, input.args, input.nowMs) }),
  plan: async (input: Omit<RoomPlanArgs, 'permit'>, tz?: string): Promise<LocalWriteOutcome> =>
    writeRoomPlan(port, { ...input, permit: await permitFor(input.actionId, input.args, input.nowMs) }, tz),
  note: async (input: Omit<RoomNoteArgs, 'permit'>): Promise<LocalWriteOutcome> =>
    writeRoomNote(port, { ...input, permit: await permitFor(input.actionId, input.args, input.nowMs) }),
  phone: async (input: Omit<PhoneRecordArgs, 'permit'>): Promise<LocalWriteOutcome> =>
    writePhoneRecord(port, { ...input, permit: await permitFor(input.actionId, input.args, input.nowMs) }),
  message: async (input: Omit<InteractionMessageArgs, 'permit'>): Promise<LocalWriteOutcome> =>
    writeInteractionMessage(port, { ...input, permit: await permitFor(input.actionId, input.args, input.nowMs) }),
  order: async (input: Omit<SimulatedOrderArgs, 'permit'>): Promise<LocalWriteOutcome> =>
    placeSimulatedOrder(port, { ...input, permit: await permitFor(input.actionId, input.args, input.nowMs) }),
  refund: async (input: Omit<RefundArgs, 'permit'>): Promise<LocalWriteOutcome> =>
    refundSimulatedOrder(port, { ...input, permit: await permitFor(input.actionId, input.args, input.nowMs) }),
};

beforeEach(async () => {
  await resetDb();
  await DB.saveBankState(bankState(1000));
  port = createLocalDbPort(await openDB());
});

describe('本地库：端口与既有 store 对齐（§4.3）', () => {
  it('新 store 已经在 DB upgrade 里建好，端口探测通过', async () => {
    const opened = await openAutonomyLocalDb();
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.port.hasStores(['diaries', 'autonomy_action_receipts', 'autonomy_sim_vouchers'])).toBe(true);
  });
});

describe('本地库：日记 / 计划 / 笔记 / 查手机 / 消息（场景 C）', () => {
  it('角色先写私人日记：只写 charPage，不伪造 userPage，并落回执', async () => {
    const outcome = await local.journal({
      actionId: 'act-journal-1',
      kind: 'journal.write',
      nowMs: NOW,
      args: { charId: CHAR, title: '今天', body: '下午在窗边看书。', mood: 'calm', date: '2026-10-24' },
    });
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;
    expect(outcome.receipt.resultRef).toBe(`diaries:diary_${CHAR}_act-journal-1`);

    const db = await openDB();
    const stored = await new Promise<any>((resolve, reject) => {
      const req = db.transaction('diaries', 'readonly').objectStore('diaries').get(`diary_${CHAR}_act-journal-1`);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(stored.charPage.content).toBe('下午在窗边看书。');
    expect(stored.userPage).toBeUndefined();
    expect(stored.source).toBe('autonomy_life');
    expect(stored.actionId).toBe('act-journal-1');
    expect(stored.entryType).toBe('private');
    const receipt = await readReceipt(port, 'act-journal-1');
    expect(receipt?.stores).toEqual([{ store: 'diaries', key: `diary_${CHAR}_act-journal-1` }]);
  });

  it('同角色同日可以有多页（不同 actionId = 不同日记），重放同一 actionId 不重复写', async () => {
    const base = {
      kind: 'journal.write' as const,
      nowMs: NOW,
      args: { charId: CHAR, title: '页', body: '内容', date: '2026-10-24' },
    };
    const first = await local.journal({ ...base, actionId: 'act-p1' });
    const second = await local.journal({ ...base, actionId: 'act-p2' });
    expect(first.status).toBe('succeeded');
    expect(second.status).toBe('succeeded');
    expect(await count('diaries')).toBe(2);

    const replay = await local.journal({ ...base, actionId: 'act-p1' });
    expect(replay.status).toBe('succeeded');
    if (replay.status === 'succeeded') expect(replay.replayed).toBe(true);
    expect(await count('diaries')).toBe(2);

    const conflict = await local.journal({
      ...base,
      actionId: 'act-p1',
      args: { ...base.args, body: '换了正文' },
    });
    expect(conflict).toMatchObject({ status: 'failed', code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('房间计划按「角色+本地日期」归并，且不把计划记成完成', async () => {
    await local.plan({
      actionId: 'act-plan-1',
      kind: 'room.plan',
      nowMs: NOW,
      args: { charId: CHAR, items: ['整理书桌', '浇花'] },
    }, 'Asia/Shanghai');
    const merged = await local.plan({
      actionId: 'act-plan-2',
      kind: 'room.plan',
      nowMs: NOW + 60_000,
      args: { charId: CHAR, items: ['整理书桌', '洗衣服'] },
    }, 'Asia/Shanghai');
    expect(merged.status).toBe('succeeded');
    const db = await openDB();
    const todo = await new Promise<any>((resolve, reject) => {
      const req = db.transaction('room_todos', 'readonly').objectStore('room_todos').get(`room_todo_${CHAR}_2026-10-24`);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(todo.items.map((item: any) => item.text)).toEqual(['整理书桌', '浇花', '洗衣服']);
    expect(todo.items.every((item: any) => item.done === false)).toBe(true);
    expect(todo.actionIds).toEqual(['act-plan-1', 'act-plan-2']);
  });

  it('房间笔记与查手机记录都标来源；模拟记录显著标「角色生活模拟」', async () => {
    const note = await local.note({
      actionId: 'act-note-1', kind: 'room.note', nowMs: NOW,
      args: { charId: CHAR, content: '窗台的绿萝长新叶了', noteType: 'thought' },
    });
    expect(note.status).toBe('succeeded');

    const phone = await local.phone({
      actionId: 'act-phone-1', kind: 'phone.record', nowMs: NOW,
      args: { charId: CHAR, with: '已登记联系人', summary: '聊了十分钟', channel: 'chat' },
    });
    expect(phone.status).toBe('succeeded');
    const db = await openDB();
    const record = await new Promise<any>((resolve, reject) => {
      const req = db.transaction('autonomy_local_life', 'readonly').objectStore('autonomy_local_life').get('phone_sim_act-phone-1');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(record.simulated).toBe(true);
    expect(record.label).toBe('角色生活模拟');
    expect(record.kind).toBe('phone_record');
  });

  it('主动消息本地入库成功 ≠ 推送送达（回执只说明 stored）', async () => {
    const outcome = await local.message({
      actionId: 'act-msg-1', kind: 'interaction.message', nowMs: NOW,
      args: { charId: CHAR, text: '刚看到一只很像你的猫' },
    });
    expect(outcome.status).toBe('succeeded');
    const db = await openDB();
    const message = await new Promise<any>((resolve, reject) => {
      const req = db.transaction('messages', 'readonly').objectStore('messages').getAll();
      req.onsuccess = () => resolve(req.result[0]);
      req.onerror = () => reject(req.error);
    });
    expect(message.deliveryState).toBe('stored');
    expect(message.source).toBe('autonomy_life');
  });
});

describe('本地库：模拟订单原子性（场景 D）', () => {
  it('下单在同一事务里扣余额（元）+ 写流水 + 订单 + 凭证 + 回执', async () => {
    const outcome = await local.order({
      actionId: 'act-order-1', kind: 'takeout.order', nowMs: NOW, args: orderArgs(),
    });
    expect(outcome.status).toBe('succeeded');
    // 8.5*2 + 3.0 = 20.0 元
    expect(await readBalance()).toBe(980);
    expect(await count('bank_transactions')).toBe(1);
    expect(await count('shopping_orders')).toBe(1);
    expect(await count('autonomy_sim_vouchers')).toBe(1);

    const order = await new Promise<any>((resolve, reject) => {
      openDB().then((db) => {
        const req = db.transaction('shopping_orders', 'readonly').objectStore('shopping_orders').get('ORD-1');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    });
    expect(order.total).toBe(20);
    expect(order.totalMinor).toBe(2000);
    expect(order.simulated).toBe(true);
    expect(order.label).toBe('OS 内模拟订单');
    expect(order.placedBy).toBe('char');
    expect(order.items[0].unitPrice).toBe(8.5);
  });

  it('同一 orderId 重放：只扣一次，返回旧回执', async () => {
    const args = { actionId: 'act-order-2', kind: 'shopping.order' as const, nowMs: NOW, args: orderArgs({ orderId: 'ORD-2' }) };
    const first = await local.order(args);
    expect(first.status).toBe('succeeded');
    const replay = await local.order({ ...args, actionId: 'act-order-2b' });
    expect(replay.status).toBe('succeeded');
    expect(await readBalance()).toBe(980);
    expect(await count('bank_transactions')).toBe(1);
  });

  it('含配送费后余额不足 → 拒绝，且余额/订单/流水都不动', async () => {
    await DB.saveBankState(bankState(10));
    const outcome = await local.order({
      actionId: 'act-order-3', kind: 'takeout.order', nowMs: NOW, args: orderArgs({ orderId: 'ORD-3' }),
    });
    expect(outcome).toMatchObject({ status: 'failed', code: 'BUDGET_EXHAUSTED' });
    expect(await readBalance()).toBe(10);
    expect(await count('shopping_orders')).toBe(0);
    expect(await count('bank_transactions')).toBe(0);
    expect(await readReceipt(port, 'act-order-3')).toBeNull();
  });

  it('负数 / 非整数价 / 空地址 / 卡不属于该角色 全部拒绝', async () => {
    const cases: Array<{ name: string; patch: Record<string, unknown>; code: string }> = [
      { name: '负数', patch: { items: [{ dishId: 'd', name: 'x', unitPriceMinor: -100, qty: 1 }] }, code: 'VALIDATION_FAILED' },
      { name: '非整数', patch: { items: [{ dishId: 'd', name: 'x', unitPriceMinor: 1.5, qty: 1 }] }, code: 'VALIDATION_FAILED' },
      { name: '空地址', patch: { addressText: '   ' }, code: 'VALIDATION_FAILED' },
      { name: '数量为0', patch: { items: [{ dishId: 'd', name: 'x', unitPriceMinor: 100, qty: 0 }] }, code: 'VALIDATION_FAILED' },
      { name: '卡不存在', patch: { cardId: 'other-card' }, code: 'POLICY_DENIED' },
    ];
    for (const item of cases) {
      const outcome = await local.order({
        actionId: `act-bad-${item.name}`, kind: 'shopping.order', nowMs: NOW,
        args: orderArgs({ orderId: `ORD-${item.name}`, ...item.patch }),
      });
      expect(outcome.status, item.name).toBe('failed');
      if (outcome.status === 'failed') expect(outcome.code, item.name).toBe(item.code);
    }
    expect(await readBalance()).toBe(1000);
    expect(await count('shopping_orders')).toBe(0);
    expect(await count('bank_transactions')).toBe(0);
  });

  it('故障注入：写完 bank_data 就崩 → 整事务回滚（余额不扣、无订单、无回执）', async () => {
    const outcome = await local.order({
      actionId: 'act-crash-1', kind: 'takeout.order', nowMs: NOW,
      args: orderArgs({ orderId: 'ORD-CRASH' }), fault: { throwAfterStore: 'bank_data' },
    });
    expect(outcome).toMatchObject({ status: 'failed', code: 'UNKNOWN_EFFECT' });
    expect(await readBalance()).toBe(1000);
    expect(await count('shopping_orders')).toBe(0);
    expect(await count('bank_transactions')).toBe(0);
    expect(await count('autonomy_sim_vouchers')).toBe(0);
    expect(await readReceipt(port, 'act-crash-1')).toBeNull();
  });

  it('故障注入：写完订单后崩 → 同样全不提交', async () => {
    const outcome = await local.order({
      actionId: 'act-crash-2', kind: 'takeout.order', nowMs: NOW,
      args: orderArgs({ orderId: 'ORD-CRASH-2' }), fault: { throwAfterStore: 'shopping_orders' },
    });
    expect(outcome.status).toBe('failed');
    expect(await readBalance()).toBe(1000);
    expect(await count('shopping_orders')).toBe(0);
    expect(await readReceipt(port, 'act-crash-2')).toBeNull();
  });

  it('并发：不同订单并发只按各自金额扣；同一 orderId 并发只扣一次', async () => {
    const results = await Promise.all([
      local.order({ actionId: 'act-conc-1', kind: 'takeout.order', nowMs: NOW, args: orderArgs({ orderId: 'ORD-C1' }) }),
      local.order({ actionId: 'act-conc-2', kind: 'shopping.order', nowMs: NOW, args: orderArgs({ orderId: 'ORD-C2' }) }),
      local.order({ actionId: 'act-conc-3', kind: 'shopping.order', nowMs: NOW, args: orderArgs({ orderId: 'ORD-C1' }) }),
    ]);
    expect(results.every((item) => item.status === 'succeeded')).toBe(true);
    // 两张不同订单 = 40 元；同一 orderId 的第三次不再扣。
    expect(await readBalance()).toBe(960);
    expect(await count('bank_transactions')).toBe(2);
  });
});

describe('本地库：退款与对账（场景 D/E）', () => {
  it('退款同事务：余额加回、订单标记取消、写退款凭证', async () => {
    await local.order({
      actionId: 'act-refund-order', kind: 'shopping.order', nowMs: NOW, args: orderArgs({ orderId: 'ORD-R1' }),
    });
    const refund = await local.refund({
      actionId: 'act-refund-1', kind: 'shopping.order', nowMs: NOW + 1000,
      args: { charId: CHAR, orderId: 'ORD-R1', reason: '不想要了' },
    });
    expect(refund.status).toBe('succeeded');
    expect(await readBalance()).toBe(1000);
    const order = await new Promise<any>((resolve, reject) => {
      openDB().then((db) => {
        const req = db.transaction('shopping_orders', 'readonly').objectStore('shopping_orders').get('ORD-R1');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    });
    expect(order.status).toBe('cancelled');
    expect(order.refundMinor).toBe(2000);
  });

  it('重复退款（新 actionId）不会加第二次钱', async () => {
    await local.order({
      actionId: 'act-refund-order2', kind: 'shopping.order', nowMs: NOW, args: orderArgs({ orderId: 'ORD-R2' }),
    });
    const first = await local.refund({
      actionId: 'act-refund-2', kind: 'shopping.order', nowMs: NOW + 1000,
      args: { charId: CHAR, orderId: 'ORD-R2' },
    });
    const second = await local.refund({
      actionId: 'act-refund-2b', kind: 'shopping.order', nowMs: NOW + 2000,
      args: { charId: CHAR, orderId: 'ORD-R2' },
    });
    expect(first.status).toBe('succeeded');
    expect(second.status).toBe('succeeded');
    expect(await readBalance()).toBe(1000);
    expect(await count('bank_transactions')).toBe(2); // 扣款 + 退款
  });

  it('对账：有回执且 argsHash 一致 → succeeded；无回执 → unknown（不盲目重做）', async () => {
    const outcome = await local.journal({
      actionId: 'act-reconcile', kind: 'journal.write', nowMs: NOW,
      args: { charId: CHAR, title: 't', body: 'b' },
    });
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;
    const found = await reconcileAction({ port, actionId: 'act-reconcile', argsHash: outcome.receipt.argsHash });
    expect(found.status).toBe('succeeded');
    const mismatch = await reconcileAction({ port, actionId: 'act-reconcile', argsHash: 'deadbeef' });
    expect(mismatch.status).toBe('unknown');
    const missing = await reconcileAction({ port, actionId: 'act-missing', argsHash: 'x' });
    expect(missing.status).toBe('unknown');
  });
});

describe('本地库：旧消费入口原子化（§4.3 末段）', () => {
  it('角色卡扣款重复调用同一 orderId 只扣一次', async () => {
    const first = await debitCharCardAtomic(port, {
      actionId: 'legacy:charOrder:ORD-L1',
      nowMs: NOW,
      args: { charId: CHAR, orderId: 'ORD-L1', shop: '奶茶店', totalMinor: 1500, charName: '小夏' },
    });
    expect(first.status).toBe('succeeded');
    const replay = await debitCharCardAtomic(port, {
      actionId: 'legacy:charOrder:ORD-L1-again',
      nowMs: NOW + 1,
      args: { charId: CHAR, orderId: 'ORD-L1', shop: '奶茶店', totalMinor: 1500, charName: '小夏' },
    });
    expect(replay.status).toBe('succeeded');
    expect(await readBalance()).toBe(985);
    expect(await count('bank_transactions')).toBe(1);
  });

  it('余额不足时明确拒绝（不是 unknown）', async () => {
    const outcome = await debitCharCardAtomic(port, {
      actionId: 'legacy:charOrder:ORD-L2',
      nowMs: NOW,
      args: { charId: CHAR, orderId: 'ORD-L2', shop: '贵店', totalMinor: 200_000 },
    });
    expect(outcome).toMatchObject({ status: 'failed', code: 'BUDGET_EXHAUSTED' });
    expect(await readBalance()).toBe(1000);
    expect(await readReceipt(port, 'legacy:charOrder:ORD-L2')).toBeNull();
  });

  it('退款重复调用不加第二次钱；没有原扣款流水则拒绝', async () => {
    await debitCharCardAtomic(port, {
      actionId: 'legacy:charOrder:ORD-L3',
      nowMs: NOW,
      args: { charId: CHAR, orderId: 'ORD-L3', shop: '店', totalMinor: 1000 },
    });
    const refund = await refundCharCardAtomic(port, {
      actionId: 'legacy:charRefund:ORD-L3',
      nowMs: NOW + 1000,
      args: { charId: CHAR, orderId: 'ORD-L3' },
    });
    expect(refund.status).toBe('succeeded');
    expect(await readBalance()).toBe(1000);
    const again = await refundCharCardAtomic(port, {
      actionId: 'legacy:charRefund:ORD-L3-b',
      nowMs: NOW + 2000,
      args: { charId: CHAR, orderId: 'ORD-L3' },
    });
    expect(again).toMatchObject({ status: 'failed', code: 'STATE_CONFLICT' });
    expect(await readBalance()).toBe(1000);

    const missing = await refundCharCardAtomic(port, {
      actionId: 'legacy:charRefund:ORD-NONE',
      nowMs: NOW,
      args: { charId: CHAR, orderId: 'ORD-NONE' },
    });
    expect(missing).toMatchObject({ status: 'failed', code: 'NOT_FOUND' });
  });

  it('查手机购买走同一原子扣款；重复 purchaseId 不二次扣钱', async () => {
    const { appendCharPurchaseTxn } = await import('../charLedger');
    const first = await appendCharPurchaseTxn(CHAR, {
      amount: 12.5, merchant: '模拟便利店', item: '饮料', category: 'shopping', purchaseId: 'purchase-1', timestamp: NOW,
    });
    expect(first.deducted).toBe(true);
    expect(await readBalance()).toBe(987.5);
    const second = await appendCharPurchaseTxn(CHAR, {
      amount: 12.5, merchant: '模拟便利店', item: '饮料', category: 'shopping', purchaseId: 'purchase-1', timestamp: NOW + 1000,
    });
    expect(second.deducted).toBe(true);
    expect(await readBalance()).toBe(987.5);
    expect(await count('bank_transactions')).toBe(1);
  });

  it('余额不足时沿用旧语义：记一条未扣款流水，余额不动', async () => {
    const { appendCharPurchaseTxn } = await import('../charLedger');
    await DB.saveBankState(bankState(1));
    const link = await appendCharPurchaseTxn(CHAR, {
      amount: 50, merchant: '贵店', item: '大件', category: 'shopping', purchaseId: 'purchase-2', timestamp: NOW,
    });
    expect(link.deducted).toBe(false);
    expect(await readBalance()).toBe(1);
    expect(await count('bank_transactions')).toBe(1);
  });

  it('金额按最小货币整数校验（0 / 负数 / 小数拒绝），避免拿分当元', async () => {
    for (const totalMinor of [0, -100, 1.5]) {
      const outcome = await debitCharCardAtomic(port, {
        actionId: `legacy:bad:${totalMinor}`,
        nowMs: NOW,
        args: { charId: CHAR, orderId: `ORD-BAD-${totalMinor}`, shop: 'x', totalMinor },
      });
      expect(outcome).toMatchObject({ status: 'failed', code: 'VALIDATION_FAILED' });
    }
    expect(await readBalance()).toBe(1000);
  });
});

describe('本地库：执行许可是硬门（无许可 / 过期 / 错参数 / 跨角色 / 重放）', () => {
  it('没有许可 → 拒绝且零业务写入（连事务都不开）', async () => {
    const outcome = await placeSimulatedOrder(port, {
      actionId: 'act-nopermit', kind: 'takeout.order', nowMs: NOW, args: orderArgs({ orderId: 'ORD-NP' }),
    });
    expect(outcome).toMatchObject({ status: 'failed', code: 'STATE_CONFLICT' });
    expect(await readBalance()).toBe(1000);
    expect(await count('shopping_orders')).toBe(0);
    expect(await count('bank_transactions')).toBe(0);
    expect(await readReceipt(port, 'act-nopermit')).toBeNull();
  });

  it('许可过期 / 参数被改 / 角色不符 → 拒绝且零业务写入', async () => {
    const args = orderArgs({ orderId: 'ORD-EXP' });
    const expired = await permitFor('act-expired', args, NOW, { expiresAt: NOW - 1 });
    const outExpired = await placeSimulatedOrder(port, {
      actionId: 'act-expired', kind: 'takeout.order', nowMs: NOW, args, permit: expired,
    });
    expect(outExpired).toMatchObject({ status: 'failed', code: 'STATE_CONFLICT' });

    const valid = await permitFor('act-tampered', args, NOW);
    const outTampered = await placeSimulatedOrder(port, {
      actionId: 'act-tampered', kind: 'takeout.order', nowMs: NOW,
      args: orderArgs({ orderId: 'ORD-EXP', addressText: '换了个地址' }),
      permit: valid,
    });
    expect(outTampered).toMatchObject({ status: 'failed', code: 'STATE_CONFLICT' });

    const crossChar = await permitFor('act-crosschar', args, NOW);
    const outCrossChar = await placeSimulatedOrder(port, {
      actionId: 'act-crosschar', kind: 'takeout.order', nowMs: NOW,
      args: orderArgs({ orderId: 'ORD-EXP', charId: 'someone-else' }),
      permit: crossChar,
    });
    expect(outCrossChar).toMatchObject({ status: 'failed', code: 'FORBIDDEN' });

    expect(await readBalance()).toBe(1000);
    expect(await count('shopping_orders')).toBe(0);
    expect(await count('bank_transactions')).toBe(0);
    expect(await count('autonomy_sim_vouchers')).toBe(0);
    expect(await readReceipt(port, 'act-expired')).toBeNull();
    expect(await readReceipt(port, 'act-tampered')).toBeNull();
    expect(await readReceipt(port, 'act-crosschar')).toBeNull();
  });

  it('已核销的许可即使回执被删也不能再写一次', async () => {
    const args = { charId: CHAR, title: 't', body: '一次', date: '2026-10-24' };
    const permit = await permitFor('act-once', args, NOW);
    const first = await writeJournalEntry(port, { actionId: 'act-once', kind: 'journal.write', nowMs: NOW, args, permit });
    expect(first.status).toBe('succeeded');

    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('autonomy_action_receipts', 'readwrite');
      tx.objectStore('autonomy_action_receipts').delete('act-once');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const again = await writeJournalEntry(port, { actionId: 'act-once', kind: 'journal.write', nowMs: NOW, args, permit });
    expect(again).toMatchObject({ status: 'failed', code: 'STATE_CONFLICT' });
    expect(await count('diaries')).toBe(1);
  });
});
