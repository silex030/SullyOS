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
  openAutonomyLocalDb,
  placeSimulatedOrder,
  readReceipt,
  refundCharCardAtomic,
  refundSimulatedOrder,
  writeInteractionMessage,
  writeJournalEntry,
  writePhoneRecord,
  writeRoomNote,
  writeRoomPlan,
  type LocalDbPort,
} from './localLedger';
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
    const outcome = await writeJournalEntry(port, {
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
    const first = await writeJournalEntry(port, { ...base, actionId: 'act-p1' });
    const second = await writeJournalEntry(port, { ...base, actionId: 'act-p2' });
    expect(first.status).toBe('succeeded');
    expect(second.status).toBe('succeeded');
    expect(await count('diaries')).toBe(2);

    const replay = await writeJournalEntry(port, { ...base, actionId: 'act-p1' });
    expect(replay.status).toBe('succeeded');
    if (replay.status === 'succeeded') expect(replay.replayed).toBe(true);
    expect(await count('diaries')).toBe(2);

    const conflict = await writeJournalEntry(port, {
      ...base,
      actionId: 'act-p1',
      args: { ...base.args, body: '换了正文' },
    });
    expect(conflict).toMatchObject({ status: 'failed', code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('房间计划按「角色+本地日期」归并，且不把计划记成完成', async () => {
    await writeRoomPlan(port, {
      actionId: 'act-plan-1',
      kind: 'room.plan',
      nowMs: NOW,
      args: { charId: CHAR, items: ['整理书桌', '浇花'] },
    }, 'Asia/Shanghai');
    const merged = await writeRoomPlan(port, {
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
    const note = await writeRoomNote(port, {
      actionId: 'act-note-1', kind: 'room.note', nowMs: NOW,
      args: { charId: CHAR, content: '窗台的绿萝长新叶了', noteType: 'thought' },
    });
    expect(note.status).toBe('succeeded');

    const phone = await writePhoneRecord(port, {
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
    const outcome = await writeInteractionMessage(port, {
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
    const outcome = await placeSimulatedOrder(port, {
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
    const first = await placeSimulatedOrder(port, args);
    expect(first.status).toBe('succeeded');
    const replay = await placeSimulatedOrder(port, { ...args, actionId: 'act-order-2b' });
    expect(replay.status).toBe('succeeded');
    expect(await readBalance()).toBe(980);
    expect(await count('bank_transactions')).toBe(1);
  });

  it('含配送费后余额不足 → 拒绝，且余额/订单/流水都不动', async () => {
    await DB.saveBankState(bankState(10));
    const outcome = await placeSimulatedOrder(port, {
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
      const outcome = await placeSimulatedOrder(port, {
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
    const outcome = await placeSimulatedOrder(port, {
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
    const outcome = await placeSimulatedOrder(port, {
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
      placeSimulatedOrder(port, { actionId: 'act-conc-1', kind: 'takeout.order', nowMs: NOW, args: orderArgs({ orderId: 'ORD-C1' }) }),
      placeSimulatedOrder(port, { actionId: 'act-conc-2', kind: 'shopping.order', nowMs: NOW, args: orderArgs({ orderId: 'ORD-C2' }) }),
      placeSimulatedOrder(port, { actionId: 'act-conc-3', kind: 'shopping.order', nowMs: NOW, args: orderArgs({ orderId: 'ORD-C1' }) }),
    ]);
    expect(results.every((item) => item.status === 'succeeded')).toBe(true);
    // 两张不同订单 = 40 元；同一 orderId 的第三次不再扣。
    expect(await readBalance()).toBe(960);
    expect(await count('bank_transactions')).toBe(2);
  });
});

describe('本地库：退款与对账（场景 D/E）', () => {
  it('退款同事务：余额加回、订单标记取消、写退款凭证', async () => {
    await placeSimulatedOrder(port, {
      actionId: 'act-refund-order', kind: 'shopping.order', nowMs: NOW, args: orderArgs({ orderId: 'ORD-R1' }),
    });
    const refund = await refundSimulatedOrder(port, {
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
    await placeSimulatedOrder(port, {
      actionId: 'act-refund-order2', kind: 'shopping.order', nowMs: NOW, args: orderArgs({ orderId: 'ORD-R2' }),
    });
    const first = await refundSimulatedOrder(port, {
      actionId: 'act-refund-2', kind: 'shopping.order', nowMs: NOW + 1000,
      args: { charId: CHAR, orderId: 'ORD-R2' },
    });
    const second = await refundSimulatedOrder(port, {
      actionId: 'act-refund-2b', kind: 'shopping.order', nowMs: NOW + 2000,
      args: { charId: CHAR, orderId: 'ORD-R2' },
    });
    expect(first.status).toBe('succeeded');
    expect(second.status).toBe('succeeded');
    expect(await readBalance()).toBe(1000);
    expect(await count('bank_transactions')).toBe(2); // 扣款 + 退款
  });

  it('对账：有回执且 argsHash 一致 → succeeded；无回执 → unknown（不盲目重做）', async () => {
    const outcome = await writeJournalEntry(port, {
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
