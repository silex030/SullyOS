/**
 * 本地原子写入（IndexedDB）：业务记录 + action receipt **同一 readwrite 事务**提交。
 *
 * 契约 §4.3 的落点：
 *   - receipt 主键 = actionId，存 kind / argsHash / resultRef / completedAt；
 *     已有且 argsHash 相同 → 返回旧回执（幂等重放），不同 → 409 IDEMPOTENCY_CONFLICT；
 *   - 事务里不 await 外部 Promise、不调用会另开事务的 DB helper；
 *     **只有 transaction.oncomplete 之后才允许上报 succeeded**；
 *   - 模拟订单：卡余额、`tx-order-<orderId>` 幂等凭证、同一条流水、订单、
 *     action receipt 全部同事务提交；退款同样同事务（状态校验 + 退款凭证 + 余额 + 订单变化），
 *     重复退款不会加第二次钱，也不覆盖原订单伪装从未发生；
 *   - 崩溃注入：任一 store 写失败 → 整事务 abort（全不提交）；下一次用**原 actionId**
 *     查本地回执重传，不再做业务动作。
 *
 * 这里刻意不依赖 utils/db.ts 的具体 helper（那会另开事务），只依赖数据库与 store 名字。
 */

import type { ActivityKind, AutonomyLifeErrorCode } from '../../contracts/autonomyLife';
import { hashArgs } from '../../contracts/autonomyLife';
import { localDateKey } from './time';

/** 本模块要用的既有 store（都是 utils/db.ts 已建好的业务表）。 */
export const AUTONOMY_BUSINESS_STORES = [
  'diaries',
  'room_todos',
  'room_notes',
  'shopping_orders',
  'bank_data',
  'bank_transactions',
  'messages',
] as const;

/** 自主生活新增的本地 store（在 utils/db.ts 的 upgrade 里建）。 */
export const AUTONOMY_CONTROL_STORES = [
  'autonomy_action_receipts', // keyPath actionId
  'autonomy_sim_vouchers',    // keyPath id（tx-order-<orderId> / refund-order-<orderId>）
  'autonomy_local_life',      // keyPath id（模拟查手机记录等本地生活物料）
] as const;

export const AUTONOMY_LOCAL_STORES = [...AUTONOMY_BUSINESS_STORES, ...AUTONOMY_CONTROL_STORES] as const;

export const DB_NAME = 'AetherOS_Data';

// ─── 端口抽象（真实 IDB / 测试用 fake-indexeddb 都实现它） ────────────────────

export interface LocalTx {
  get<T>(store: string, key: IDBValidKey): Promise<T | undefined>;
  getAll<T>(store: string): Promise<T[]>;
  put(store: string, value: unknown): Promise<void>;
  add(store: string, value: unknown): Promise<IDBValidKey>;
  del(store: string, key: IDBValidKey): Promise<void>;
}

export interface LocalDbPort {
  hasStores(names: readonly string[]): boolean;
  /**
   * 同事务执行 body。实现必须：
   *   1. 只在 oncomplete 后 resolve（body 里的写请求"排上队"不等于成功）；
   *   2. onerror / onabort 时 reject，绝不部分成功。
   */
  runTransaction<T>(stores: readonly string[], mode: IDBTransactionMode, body: (tx: LocalTx) => Promise<T>): Promise<T>;
}

function wrapTransaction(db: IDBDatabase, stores: readonly string[], mode: IDBTransactionMode): IDBTransaction {
  return db.transaction(stores as string[], mode);
}

function createTx(transaction: IDBTransaction): LocalTx {
  const request = <T>(fn: () => IDBRequest): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const req = fn();
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error ?? new Error('IDB request failed'));
    });
  return {
    get: <T>(store: string, key: IDBValidKey) =>
      request<T | undefined>(() => transaction.objectStore(store).get(key) as IDBRequest),
    getAll: <T>(store: string) => request<T[]>(() => transaction.objectStore(store).getAll() as IDBRequest),
    put: async (store: string, value: unknown) => {
      await request<IDBValidKey>(() => transaction.objectStore(store).put(value as never));
    },
    add: (store: string, value: unknown) => request<IDBValidKey>(() => transaction.objectStore(store).add(value as never)),
    del: async (store: string, key: IDBValidKey) => {
      await request<undefined>(() => transaction.objectStore(store).delete(key) as IDBRequest);
    },
  };
}

/** 把已打开的 IDBDatabase 包成端口。 */
export function createLocalDbPort(db: IDBDatabase): LocalDbPort {
  const hasStores = (names: readonly string[]): boolean => names.every((name) => db.objectStoreNames.contains(name));
  return {
    hasStores,
    runTransaction<T>(stores: readonly string[], mode: IDBTransactionMode, body: (tx: LocalTx) => Promise<T>) {
      return new Promise<T>((resolve, reject) => {
        let transaction: IDBTransaction;
        try {
          transaction = wrapTransaction(db, stores, mode);
        } catch (error) {
          reject(error);
          return;
        }
        let bodyResult: T;
        let bodyError: unknown = null;
        const tx = createTx(transaction);
        transaction.oncomplete = () => {
          if (bodyError) reject(bodyError);
          else resolve(bodyResult);
        };
        transaction.onabort = () => reject(transaction.error ?? bodyError ?? new Error('transaction aborted'));
        transaction.onerror = () => reject(transaction.error ?? bodyError ?? new Error('transaction failed'));
        Promise.resolve()
          .then(() => body(tx))
          .then((result) => {
            bodyResult = result;
          })
          .catch((error) => {
            bodyError = error;
            try {
              transaction.abort();
            } catch {
              /* already finished */
            }
            reject(error);
          });
      });
    },
  };
}

/** 打开既有业务库（不升版本），缺 store 就 fail closed（老客户端不得执行）。 */
export async function openAutonomyLocalDb(
  factory: IDBFactory = indexedDB,
  dbName: string = DB_NAME,
): Promise<{ ok: true; port: LocalDbPort } | { ok: false; code: 'CAPABILITY_UNAVAILABLE'; reason: string }> {
  let db: IDBDatabase;
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(dbName); // 不带版本号：只连现有库，不触发 upgrade
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('open failed'));
    });
  } catch (error) {
    return { ok: false, code: 'CAPABILITY_UNAVAILABLE', reason: `db_open_failed:${String(error)}` };
  }
  const port = createLocalDbPort(db);
  const missing = AUTONOMY_LOCAL_STORES.filter((name) => !db.objectStoreNames.contains(name));
  if (missing.length) {
    return { ok: false, code: 'CAPABILITY_UNAVAILABLE', reason: `store_missing:${missing.join(',')}` };
  }
  return { ok: true, port };
}

// ─── 回执 ───────────────────────────────────────────────────────────────────

export interface ActionReceipt {
  actionId: string;
  kind: ActivityKind;
  argsHash: string;
  resultRef: string | null;
  completedAt: number;
  /** 便于对账：业务 store 与主键。 */
  stores: Array<{ store: string; key: string }>;
  /** 少量可展示的附加信息（卡尾号/余额等），不放正文与地址。 */
  meta?: Record<string, string>;
}

export type LocalWriteOutcome =
  | { status: 'succeeded'; receipt: ActionReceipt; replayed: boolean }
  | { status: 'failed'; code: AutonomyLifeErrorCode; message: string };

/** 读回执（崩溃后重传用：有回执只能补报，不能再做业务动作）。 */
export async function readReceipt(port: LocalDbPort, actionId: string): Promise<ActionReceipt | null> {
  const found = await port.runTransaction(['autonomy_action_receipts'], 'readonly', async (tx) => {
    return (await tx.get<ActionReceipt>('autonomy_action_receipts', actionId)) ?? null;
  });
  return found;
}

export interface FaultInjection {
  /** 在写完某个 store 之后抛错，模拟崩溃（测试用；生产不传）。 */
  throwAfterStore?: string;
  /** 直接让事务在开始时失败。 */
  failAtOpen?: boolean;
}

interface CommonWriteArgs {
  actionId: string;
  kind: ActivityKind;
  args: Record<string, unknown>;
  nowMs: number;
  fault?: FaultInjection;
}

function hashOf(args: Record<string, unknown>): string {
  return hashArgs(args);
}

function assertNoFault(fault: FaultInjection | undefined, store: string): void {
  if (fault?.throwAfterStore === store) throw new Error(`injected_failure_after:${store}`);
}

/**
 * 通用「业务写 + 回执」执行器。
 * body 只负责写业务记录并返回 receipt 的 resultRef/stores；幂等与回执由这里统一处理。
 */
async function commitWithReceipt(
  port: LocalDbPort,
  args: CommonWriteArgs,
  stores: readonly string[],
  body: (tx: LocalTx, ctx: { argsHash: string }) => Promise<{ resultRef: string; stores: Array<{ store: string; key: string }> }>,
): Promise<LocalWriteOutcome> {
  const argsHash = hashOf(args.args);
  try {
    return await port.runTransaction<LocalWriteOutcome>(stores, 'readwrite', async (tx) => {
      const existing = await tx.get<ActionReceipt>('autonomy_action_receipts', args.actionId);
      if (existing) {
        if (existing.argsHash === argsHash) {
          // 幂等重放：返回旧回执，绝不再写一次业务记录。
          return { status: 'succeeded', receipt: existing, replayed: true };
        }
        return {
          status: 'failed',
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'same actionId with different argsHash',
        };
      }
      const written = await body(tx, { argsHash });
      assertNoFault(args.fault, written.stores[written.stores.length - 1]?.store ?? '');
      const receipt: ActionReceipt = {
        actionId: args.actionId,
        kind: args.kind,
        argsHash,
        resultRef: written.resultRef,
        completedAt: args.nowMs,
        stores: written.stores,
      };
      await tx.put('autonomy_action_receipts', receipt);
      return { status: 'succeeded', receipt, replayed: false };
    });
  } catch (error) {
    if (error instanceof LocalRejection) {
      // 校验阶段就拒绝：效果确定没有发生，如实报失败原因（不进 unknown）。
      return { status: 'failed', code: error.code, message: error.reason };
    }
    return { status: 'failed', code: 'UNKNOWN_EFFECT', message: String(error) };
  }
}

// ─── 日记 ───────────────────────────────────────────────────────────────────

export interface JournalArgs extends CommonWriteArgs {
  args: {
    charId: string;
    title: string;
    body: string;
    mood?: string;
    tags?: string[];
    entryType?: 'private' | 'exchange';
    date?: string;
  };
}

/**
 * 角色先写私人日记：新建一条记录（**不覆盖用户正文**）。
 * 页面按 charId+date 多页展示（UI 负责），这里保证 id 唯一、actionId 可追溯。
 */
export async function writeJournalEntry(port: LocalDbPort, input: JournalArgs): Promise<LocalWriteOutcome> {
  const { args } = input;
  const diaryId = `diary_${args.charId}_${input.actionId}`;
  return commitWithReceipt(port, input, ['diaries', 'autonomy_action_receipts'], async (tx) => {
    const date = args.date ?? localDateKey(input.nowMs, 'UTC');
    const record = {
      id: diaryId,
      charId: args.charId,
      date,
      timestamp: input.nowMs,
      isArchived: false,
      // 角色自己的页面；userPage 刻意缺省——不伪造用户写的正文。
      charPage: {
        title: args.title,
        content: args.body,
        mood: args.mood ?? '',
        tags: args.tags ?? [],
      },
      entryType: args.entryType ?? 'private',
      source: 'autonomy_life',
      actionId: input.actionId,
      simulated: false,
    };
    await tx.put('diaries', record);
    return { resultRef: `diaries:${diaryId}`, stores: [{ store: 'diaries', key: diaryId }] };
  });
}

// ─── 房间计划 / 笔记 ────────────────────────────────────────────────────────

export interface RoomPlanArgs extends CommonWriteArgs {
  args: { charId: string; items: string[]; mood?: string };
}

/** 每日待办用 角色+本地日期 作归并键；不把「计划」记成完成。 */
export async function writeRoomPlan(port: LocalDbPort, input: RoomPlanArgs, tz = 'UTC'): Promise<LocalWriteOutcome> {
  const { args } = input;
  const date = localDateKey(input.nowMs, tz);
  const todoId = `room_todo_${args.charId}_${date}`;
  return commitWithReceipt(port, input, ['room_todos', 'autonomy_action_receipts'], async (tx) => {
    const existing = await tx.get<{
      id: string; charId: string; date: string; items: { text: string; done: boolean }[];
      generatedAt: number; source?: string; actionIds?: string[];
    }>('room_todos', todoId);
    const items = Array.isArray(args.items) ? args.items.filter((text) => typeof text === 'string' && text.trim()) : [];
    const merged = existing ? [...existing.items] : [];
    for (const text of items) {
      if (!merged.some((item) => item.text === text)) merged.push({ text, done: false });
    }
    const record = {
      id: todoId,
      charId: args.charId,
      date,
      items: merged,
      generatedAt: input.nowMs,
      source: 'autonomy_life',
      actionIds: Array.from(new Set([...(existing?.actionIds ?? []), input.actionId])),
    };
    await tx.put('room_todos', record);
    return { resultRef: `room_todos:${todoId}`, stores: [{ store: 'room_todos', key: todoId }] };
  });
}

export interface RoomNoteArgs extends CommonWriteArgs {
  args: { charId: string; content: string; noteType?: string };
}

export async function writeRoomNote(port: LocalDbPort, input: RoomNoteArgs): Promise<LocalWriteOutcome> {
  const noteId = `room_note_${input.actionId}`;
  const allowed = new Set(['lyric', 'doodle', 'thought', 'search', 'gossip']);
  const noteType = input.args.noteType && allowed.has(input.args.noteType) ? input.args.noteType : 'thought';
  return commitWithReceipt(port, input, ['room_notes', 'autonomy_action_receipts'], async (tx) => {
    const record = {
      id: noteId,
      charId: input.args.charId,
      timestamp: input.nowMs,
      content: input.args.content,
      type: noteType,
      source: 'autonomy_life',
      actionId: input.actionId,
    };
    await tx.put('room_notes', record);
    return { resultRef: `room_notes:${noteId}`, stores: [{ store: 'room_notes', key: noteId }] };
  });
}

// ─── 查手机（模拟记录） ─────────────────────────────────────────────────────

export interface PhoneRecordArgs extends CommonWriteArgs {
  args: {
    charId: string;
    with: string;
    summary: string;
    channel?: 'chat' | 'call' | 'sms';
    durationMinutes?: number;
    fictionalNpc?: boolean;
  };
}

/**
 * 首期只生成**模拟**聊天/生活记录，且显著标「角色生活模拟」。
 * 刻意不写健康/用药/收支等真实档案字段（那需要用户自己的入口，不由自主动作代写）。
 */
export async function writePhoneRecord(port: LocalDbPort, input: PhoneRecordArgs): Promise<LocalWriteOutcome> {
  const recordId = `phone_sim_${input.actionId}`;
  return commitWithReceipt(port, input, ['autonomy_local_life', 'autonomy_action_receipts'], async (tx) => {
    const record = {
      id: recordId,
      kind: 'phone_record',
      charId: input.args.charId,
      with: input.args.with,
      summary: input.args.summary,
      channel: input.args.channel ?? 'chat',
      durationMinutes: input.args.durationMinutes ?? 0,
      fictionalNpc: input.args.fictionalNpc === true,
      timestamp: input.nowMs,
      actionId: input.actionId,
      /** 显著标记：这是 OS 内的角色生活模拟，不是用户真实通讯记录。 */
      simulated: true,
      label: '角色生活模拟',
    };
    await tx.put('autonomy_local_life', record);
    return { resultRef: `autonomy_local_life:${recordId}`, stores: [{ store: 'autonomy_local_life', key: recordId }] };
  });
}

// ─── 互动消息 ───────────────────────────────────────────────────────────────

export interface InteractionMessageArgs extends CommonWriteArgs {
  args: { charId: string; text: string; style?: string; shareable?: boolean };
}

/** 消息持久成功 ≠ 推送送达：回执只说明本地入库成功。 */
export async function writeInteractionMessage(port: LocalDbPort, input: InteractionMessageArgs): Promise<LocalWriteOutcome> {
  return commitWithReceipt(port, input, ['messages', 'autonomy_action_receipts'], async (tx) => {
    const key = await tx.add('messages', {
      charId: input.args.charId,
      role: 'char',
      type: 'text',
      content: input.args.text,
      timestamp: input.nowMs,
      source: 'autonomy_life',
      actionId: input.actionId,
      deliveryState: 'stored',
    });
    return {
      resultRef: `messages:${String(key)}`,
      stores: [{ store: 'messages', key: String(key) }],
    };
  });
}

// ─── 模拟订单（原子） ───────────────────────────────────────────────────────

export interface SimulatedOrderItem {
  dishId: string;
  name: string;
  unitPriceMinor: number;
  qty: number;
}

export interface SimulatedOrderArgs extends CommonWriteArgs {
  args: {
    charId: string;
    orderId: string;
    shopId: string;
    shopName: string;
    shopCat: string;
    category: string;
    items: SimulatedOrderItem[];
    addressText: string;
    deliveryFeeMinor: number;
    cardId: string;
  };
}

export interface OrderValidation {
  ok: boolean;
  code?: AutonomyLifeErrorCode;
  reason?: string;
  subtotalMinor?: number;
  totalMinor?: number;
}

const isIntMinor = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

/** 订单校验：含配送费总额、最小货币整数、非空地址、卡归属（余额在事务里再查）。 */
export function validateSimulatedOrder(
  args: SimulatedOrderArgs['args'],
  card: { id: string; owner?: string; ownerId?: string; balance: number } | undefined,
): OrderValidation {
  if (!args.addressText || !args.addressText.trim()) return { ok: false, code: 'VALIDATION_FAILED', reason: 'empty_address' };
  if (!Array.isArray(args.items) || args.items.length === 0) return { ok: false, code: 'VALIDATION_FAILED', reason: 'empty_items' };
  let subtotal = 0;
  for (const item of args.items) {
    if (!isIntMinor(item.unitPriceMinor)) return { ok: false, code: 'VALIDATION_FAILED', reason: 'bad_price' };
    if (!Number.isInteger(item.qty) || item.qty <= 0) return { ok: false, code: 'VALIDATION_FAILED', reason: 'bad_qty' };
    const line = item.unitPriceMinor * item.qty;
    if (!Number.isSafeInteger(line)) return { ok: false, code: 'VALIDATION_FAILED', reason: 'overflow' };
    subtotal += line;
    if (!Number.isSafeInteger(subtotal)) return { ok: false, code: 'VALIDATION_FAILED', reason: 'overflow' };
  }
  if (!isIntMinor(args.deliveryFeeMinor)) return { ok: false, code: 'VALIDATION_FAILED', reason: 'bad_delivery_fee' };
  const total = subtotal + args.deliveryFeeMinor;
  if (!Number.isSafeInteger(total) || total <= 0) return { ok: false, code: 'VALIDATION_FAILED', reason: 'bad_total' };
  if (!card) return { ok: false, code: 'POLICY_DENIED', reason: 'card_missing' };
  if (card.owner !== 'char' || card.ownerId !== args.charId) {
    return { ok: false, code: 'POLICY_DENIED', reason: 'card_owner_mismatch' };
  }
  if (!(card.balance >= 0) || !Number.isFinite(card.balance)) {
    return { ok: false, code: 'VALIDATION_FAILED', reason: 'bad_balance' };
  }
  // 卡余额在既有 Bank 里是「元」（float），订单总额是分：先换算再比，别拿分比元。
  if (yuanToMinor(card.balance) < total) return { ok: false, code: 'BUDGET_EXHAUSTED', reason: 'insufficient_balance' };
  return { ok: true, subtotalMinor: subtotal, totalMinor: total };
}

interface BankDataShape {
  id?: string;
  cards?: Array<{ id: string; name?: string; tailNo?: string; balance: number; owner?: string; ownerId?: string; isDefault?: boolean }>;
  [key: string]: unknown;
}

/**
 * 既有 Bank 只认 main_state 这一条（utils/db.ts getBankState），余额是**元**（float，
 * 两位小数）。自主生活的预算账本用最小货币整数，跨这一步时统一在这里换算，
 * 绝不把「分」直接减到「元」的卡上。
 */
export const BANK_STATE_KEY = 'main_state';

/** 分 → 元（两位小数，避免浮点尾巴）。 */
export function minorToYuan(minor: number): number {
  return Math.round(minor) / 100;
}

/** 元 → 分（向下取整到分；用于读旧订单/退款时换算）。 */
export function yuanToMinor(yuan: number): number {
  return Math.round((Number(yuan) || 0) * 100);
}

async function loadBankData(tx: LocalTx): Promise<BankDataShape | undefined> {
  const direct = await tx.get<BankDataShape>('bank_data', BANK_STATE_KEY);
  if (direct) return direct;
  // 极老的数据可能没 main_state 键：退回第一行，但仍按同一形状处理。
  const all = await tx.getAll<BankDataShape>('bank_data');
  return all.find((row) => Array.isArray(row?.cards)) ?? all[0];
}

/**
 * 事务内的「明确拒绝」：校验发生在任何写之前，所以效果是确定的「没有发生」，
 * 不能被报成 unknown（那会让 UI 显示「结果待核对」并冻结设备切换）。
 * 只有真正写到一半的异常/崩溃才允许落到 UNKNOWN_EFFECT。
 */
class LocalRejection extends Error {
  constructor(readonly code: AutonomyLifeErrorCode, readonly reason: string) {
    super(reason);
    this.name = 'LocalRejection';
  }
}

function reject(code: AutonomyLifeErrorCode, reason: string): never {
  throw new LocalRejection(code, reason);
}

/**
 * 模拟外卖/购物下单：卡余额、`tx-order-<orderId>` 凭证、同条流水、订单、回执
 * 全部同一事务。任一步失败（含注入崩溃）→ 全不提交。
 */
export async function placeSimulatedOrder(port: LocalDbPort, input: SimulatedOrderArgs): Promise<LocalWriteOutcome> {
  const { args } = input;
  const voucherId = `tx-order-${args.orderId}`;
  return commitWithReceipt(
    port,
    input,
    ['bank_data', 'bank_transactions', 'shopping_orders', 'autonomy_sim_vouchers', 'autonomy_action_receipts'],
    async (tx) => {
      const voucher = await tx.get<{ id: string; orderId: string }>('autonomy_sim_vouchers', voucherId);
      if (voucher) {
        const existingOrder = await tx.get<{ id: string }>('shopping_orders', args.orderId);
        return {
          resultRef: `shopping_orders:${args.orderId}`,
          stores: existingOrder ? [{ store: 'shopping_orders', key: args.orderId }] : [],
        };
      }
      const bank = await loadBankData(tx);
      const cards = bank?.cards ?? [];
      // 指定卡必须存在且属于该角色；未指定时按既有 charDefaultCard 口径取角色默认卡。
      const mine = cards.filter((item) => item.owner === 'char' && item.ownerId === args.charId);
      const card = args.cardId
        ? mine.find((item) => item.id === args.cardId)
        : mine.find((item) => item.isDefault) ?? mine[0];
      const validation = validateSimulatedOrder(args, card);
      if (!validation.ok) {
        // 明确拒绝：code 落成 BUDGET_EXHAUSTED / POLICY_DENIED / VALIDATION_FAILED，
        // 且此刻还没有任何写入，效果确定为零。
        reject(validation.code ?? 'VALIDATION_FAILED', validation.reason ?? 'order_rejected');
      }
      const total = validation.totalMinor!;
      const subtotal = validation.subtotalMinor!;
      const totalYuan = minorToYuan(total);
      const cardLabel = card?.name ? `${card.name}·${card.tailNo ?? ''}` : '角色模拟卡';
      const nextCards = cards.map((item) =>
        item.id === card!.id ? { ...item, balance: Math.round((item.balance - totalYuan) * 100) / 100 } : item,
      );
      await tx.put('bank_data', { ...(bank ?? {}), id: BANK_STATE_KEY, cards: nextCards });
      assertNoFault(input.fault, 'bank_data');

      const order = {
        id: args.orderId,
        charId: args.charId,
        placedBy: 'char',
        recipientType: 'char',
        recipientName: '角色本人',
        addressText: args.addressText,
        shopId: args.shopId,
        shopName: args.shopName,
        shopCat: args.shopCat,
        category: args.category,
        // 既有 ShoppingOrder 用「元 + unitPrice/lineTotal」，这里两套都写：
        // 元字段给购物 App / UI 直接渲染，*Minor 字段给对账与预算精确核对。
        items: args.items.map((item) => ({
          dishId: item.dishId,
          name: item.name,
          unitPrice: minorToYuan(item.unitPriceMinor),
          qty: item.qty,
          lineTotal: minorToYuan(item.unitPriceMinor * item.qty),
          unitPriceMinor: item.unitPriceMinor,
          lineTotalMinor: item.unitPriceMinor * item.qty,
        })),
        itemCount: args.items.reduce((sum, item) => sum + item.qty, 0),
        subtotal: minorToYuan(subtotal),
        deliveryFee: minorToYuan(args.deliveryFeeMinor),
        total: totalYuan,
        subtotalMinor: subtotal,
        deliveryFeeMinor: args.deliveryFeeMinor,
        totalMinor: total,
        payMethod: 'bank_card',
        cardLabel,
        cardId: card!.id,
        status: 'paid',
        statusHistory: [{ status: 'paid', at: input.nowMs }],
        createdAt: input.nowMs,
        actionId: input.actionId,
        /** OS 内模拟订单：不暗示商家已接单、不暗示现实商品将送达。 */
        simulated: true,
        label: 'OS 内模拟订单',
        simulatedOrder: true,
      };
      await tx.put('shopping_orders', order);
      assertNoFault(input.fault, 'shopping_orders');

      const txId = voucherId;
      await tx.put('bank_transactions', {
        id: txId,
        amount: -totalYuan,
        category: 'shopping',
        ownerId: args.charId,
        cardId: card!.id,
        note: `${args.shopName}（OS 内模拟）`,
        timestamp: input.nowMs,
        dateStr: localDateKey(input.nowMs, 'UTC'),
        ownsBalance: true,
        simulated: true,
        linkedPurchaseId: args.orderId,
      });
      assertNoFault(input.fault, 'bank_transactions');

      await tx.put('autonomy_sim_vouchers', {
        id: voucherId,
        orderId: args.orderId,
        charId: args.charId,
        actionId: input.actionId,
        amount: total,
        createdAt: input.nowMs,
      });
      return {
        resultRef: `shopping_orders:${args.orderId}`,
        stores: [
          { store: 'shopping_orders', key: args.orderId },
          { store: 'bank_transactions', key: txId },
        ],
      };
    },
  );
}

export interface RefundArgs extends CommonWriteArgs {
  args: { charId: string; orderId: string; reason?: string };
}

/**
 * 退款补偿动作：同事务做「状态校验 + 退款凭证 + 余额 + 订单状态 + 回执」。
 * 重复退款：凭证已存在且 argsHash 相同 → 返回旧回执，**不再加第二次钱**。
 */
export async function refundSimulatedOrder(port: LocalDbPort, input: RefundArgs): Promise<LocalWriteOutcome> {
  const { args } = input;
  const voucherId = `refund-order-${args.orderId}`;
  return commitWithReceipt(
    port,
    input,
    ['bank_data', 'bank_transactions', 'shopping_orders', 'autonomy_sim_vouchers', 'autonomy_action_receipts'],
    async (tx) => {
      const existingVoucher = await tx.get<{ id: string }>('autonomy_sim_vouchers', voucherId);
      if (existingVoucher) return { resultRef: `shopping_orders:${args.orderId}`, stores: [] };

      const order = await tx.get<{
        id: string; charId?: string; status: string; total?: number; totalMinor?: number; cardId?: string;
        statusHistory?: Array<{ status: string; at: number }>;
      }>('shopping_orders', args.orderId);
      if (!order) reject('NOT_FOUND', 'order_not_found');
      if (order.charId !== args.charId) reject('POLICY_DENIED', 'order_owner_mismatch');
      if (order.status === 'cancelled') reject('STATE_CONFLICT', 'order_already_cancelled');
      if (order.status === 'pending_pay') reject('STATE_CONFLICT', 'order_not_paid');

      // 兼容两种记账口径：新订单有 totalMinor，旧购物 App 订单只有 total（元）。
      const refundMinor = typeof order.totalMinor === 'number' ? order.totalMinor : yuanToMinor(order.total ?? 0);
      if (!(refundMinor > 0)) reject('VALIDATION_FAILED', 'refund_amount_invalid');
      const refundYuan = minorToYuan(refundMinor);

      const bank = await loadBankData(tx);
      const cards = bank?.cards ?? [];
      const target = cards.find((card) => card.id === order.cardId)
        ?? cards.find((card) => card.owner === 'char' && card.ownerId === args.charId);
      if (!target) reject('POLICY_DENIED', 'refund_card_missing');
      const nextCards = cards.map((card) =>
        card.id === target.id ? { ...card, balance: Math.round((card.balance + refundYuan) * 100) / 100 } : card,
      );
      await tx.put('bank_data', { ...(bank ?? {}), id: BANK_STATE_KEY, cards: nextCards });
      assertNoFault(input.fault, 'bank_data');

      const txId = voucherId;
      await tx.put('bank_transactions', {
        id: txId,
        amount: refundYuan,
        category: 'income',
        ownerId: args.charId,
        cardId: target.id,
        note: `退款（OS 内模拟）：${args.reason ?? '主动取消'}`,
        timestamp: input.nowMs,
        dateStr: localDateKey(input.nowMs, 'UTC'),
        ownsBalance: true,
        simulated: true,
        linkedPurchaseId: args.orderId,
        reversalOf: `tx-order-${args.orderId}`,
      });
      assertNoFault(input.fault, 'bank_transactions');

      await tx.put('shopping_orders', {
        ...order,
        status: 'cancelled',
        statusHistory: [...(order.statusHistory ?? []), { status: 'cancelled', at: input.nowMs }],
        refundedAt: input.nowMs,
        refundMinor,
        refund: refundYuan,
      });
      assertNoFault(input.fault, 'shopping_orders');

      await tx.put('autonomy_sim_vouchers', {
        id: voucherId,
        orderId: args.orderId,
        charId: args.charId,
        actionId: input.actionId,
        amount: refundYuan,
        amountMinor: refundMinor,
        createdAt: input.nowMs,
        kind: 'refund',
      });
      return {
        resultRef: `shopping_orders:${args.orderId}`,
        stores: [
          { store: 'shopping_orders', key: args.orderId },
          { store: 'bank_transactions', key: txId },
        ],
      };
    },
  );
}

// ─── 旧消费入口（LIFE:ORDER / 查手机）原子化改写 ────────────────────────────

export interface CharCardDebitArgs {
  actionId: string;
  kind?: ActivityKind;
  nowMs: number;
  fault?: FaultInjection;
  args: {
    charId: string;
    orderId: string;
    shop: string;
    totalMinor: number;
    charName?: string;
    note?: string;
  };
}

/**
 * 角色卡扣款（旧 `charOrder.debitCharCardForOrder` 的原子替代）。
 *
 * 以前的写法是「先读全部流水判重 → 再 saveBankState → 再 saveTransaction」：两次独立
 * 事务，中间崩就只剩一边。这里改成一条 readwrite 事务：
 *   `tx-order-<orderId>` 凭证查重 → 卡余额（元）→ 卡上扣款 → 流水 → 凭证 → 回执。
 * 重复调用同一 orderId 只返回旧回执，不二次扣钱；不同金额复用同一 orderId → 409。
 */
export async function debitCharCardAtomic(port: LocalDbPort, input: CharCardDebitArgs): Promise<LocalWriteOutcome> {
  const { args } = input;
  const voucherId = `tx-order-${args.orderId}`;
  if (!args.orderId.trim()) return { status: 'failed', code: 'VALIDATION_FAILED', message: 'order_id_required' };
  if (!isIntMinor(args.totalMinor) || args.totalMinor <= 0) {
    return { status: 'failed', code: 'VALIDATION_FAILED', message: 'invalid_total' };
  }
  try {
    return await port.runTransaction<LocalWriteOutcome>(
      ['bank_data', 'bank_transactions', 'autonomy_sim_vouchers', 'autonomy_action_receipts'],
      'readwrite',
      async (tx) => {
        const argsHash = hashOf(args as unknown as Record<string, unknown>);
        const existingReceipt = await tx.get<ActionReceipt>('autonomy_action_receipts', input.actionId);
        if (existingReceipt) {
          if (existingReceipt.argsHash === argsHash) {
            return { status: 'succeeded', receipt: existingReceipt, replayed: true };
          }
          return { status: 'failed', code: 'IDEMPOTENCY_CONFLICT', message: 'same actionId with different argsHash' };
        }
        const voucher = await tx.get<{ id: string; cardId?: string; cardLabel?: string; balanceAfter?: number }>(
          'autonomy_sim_vouchers',
          voucherId,
        );
        if (voucher) {
          const receipt: ActionReceipt = {
            actionId: input.actionId,
            kind: input.kind ?? 'shopping.order',
            argsHash,
            resultRef: `bank_transactions:${voucherId}`,
            completedAt: input.nowMs,
            stores: [{ store: 'bank_transactions', key: voucherId }],
            meta: {
              cardId: voucher.cardId ?? '',
              cardLabel: voucher.cardLabel ?? '',
              balanceAfter: String(voucher.balanceAfter ?? ''),
            },
          };
          await tx.put('autonomy_action_receipts', receipt);
          return { status: 'succeeded', receipt, replayed: true };
        }

        const bank = await loadBankData(tx);
        const cards = bank?.cards ?? [];
        const mine = cards.filter((card) => card.owner === 'char' && card.ownerId === args.charId);
        const card = mine.find((item) => item.isDefault) ?? mine[0];
        if (!card) reject('POLICY_DENIED', 'no_card');
        if (yuanToMinor(card.balance) < args.totalMinor) reject('BUDGET_EXHAUSTED', 'insufficient');
        const totalYuan = minorToYuan(args.totalMinor);
        const balanceAfter = Math.round((card.balance - totalYuan) * 100) / 100;
        const cardLabel = `${card.name ?? ''}·${card.tailNo ?? ''}`;
        const nextCards = cards.map((item) => (item.id === card.id ? { ...item, balance: balanceAfter } : item));
        await tx.put('bank_data', { ...(bank ?? {}), id: BANK_STATE_KEY, cards: nextCards });
        assertNoFault(input.fault, 'bank_data');

        await tx.put('bank_transactions', {
          id: voucherId,
          amount: -totalYuan,
          category: 'shopping',
          note: args.note ?? (args.charName ? `${args.shop}（${args.charName}点的）` : args.shop),
          timestamp: input.nowMs,
          dateStr: localDateKey(input.nowMs, 'UTC'),
          ownerId: args.charId,
          linkedPurchaseId: args.orderId,
          cardId: card.id,
        });
        assertNoFault(input.fault, 'bank_transactions');

        await tx.put('autonomy_sim_vouchers', {
          id: voucherId,
          orderId: args.orderId,
          charId: args.charId,
          actionId: input.actionId,
          amount: totalYuan,
          amountMinor: args.totalMinor,
          cardId: card.id,
          cardLabel,
          balanceAfter,
          createdAt: input.nowMs,
          kind: 'order',
        });
        assertNoFault(input.fault, 'autonomy_sim_vouchers');

        const receipt: ActionReceipt = {
          actionId: input.actionId,
          kind: input.kind ?? 'shopping.order',
          argsHash,
          resultRef: `bank_transactions:${voucherId}`,
          completedAt: input.nowMs,
          stores: [
            { store: 'bank_transactions', key: voucherId },
            { store: 'autonomy_sim_vouchers', key: voucherId },
          ],
          meta: { cardId: card.id, cardLabel, balanceAfter: String(balanceAfter) },
        };
        await tx.put('autonomy_action_receipts', receipt);
        return { status: 'succeeded', receipt, replayed: false };
      },
    );
  } catch (error) {
    if (error instanceof LocalRejection) return { status: 'failed', code: error.code, message: error.reason };
    return { status: 'failed', code: 'UNKNOWN_EFFECT', message: String(error) };
  }
}

export interface CharCardRefundArgs {
  actionId: string;
  nowMs: number;
  fault?: FaultInjection;
  args: { charId: string; orderId: string; totalMinor?: number; shop?: string };
}

/**
 * 角色卡退款（旧 `charOrder.refundCharOrder` 的原子替代）。
 * `tx-refund-<orderId>` 凭证保证重复退款不加第二次钱；找不到原扣款流水就拒绝。
 */
export async function refundCharCardAtomic(port: LocalDbPort, input: CharCardRefundArgs): Promise<LocalWriteOutcome> {
  const { args } = input;
  const outId = `tx-order-${args.orderId}`;
  const refundId = `tx-refund-${args.orderId}`;
  if (!args.orderId.trim()) return { status: 'failed', code: 'VALIDATION_FAILED', message: 'order_id_required' };
  try {
    return await port.runTransaction<LocalWriteOutcome>(
      ['bank_data', 'bank_transactions', 'autonomy_sim_vouchers', 'autonomy_action_receipts'],
      'readwrite',
      async (tx) => {
        const argsHash = hashOf(args);
        const existingReceipt = await tx.get<ActionReceipt>('autonomy_action_receipts', input.actionId);
        if (existingReceipt) {
          if (existingReceipt.argsHash === argsHash) {
            return { status: 'succeeded', receipt: existingReceipt, replayed: true };
          }
          return { status: 'failed', code: 'IDEMPOTENCY_CONFLICT', message: 'same actionId with different argsHash' };
        }
        const already = await tx.get<{ id: string }>('autonomy_sim_vouchers', refundId);
        if (already) reject('STATE_CONFLICT', 'already_refunded');

        const orig = await tx.get<{ id: string; amount: number; cardId?: string; note?: string }>('bank_transactions', outId);
        if (!orig) reject('NOT_FOUND', 'original_txn_missing');
        const requestedMinor = typeof args.totalMinor === 'number' ? args.totalMinor : yuanToMinor(-orig.amount);
        if (!isIntMinor(requestedMinor) || requestedMinor <= 0) reject('VALIDATION_FAILED', 'invalid_refund_amount');

        const bank = await loadBankData(tx);
        const cards = bank?.cards ?? [];
        const target = (orig.cardId ? cards.find((card) => card.id === orig.cardId) : undefined)
          ?? cards.find((card) => card.owner === 'char' && card.ownerId === args.charId);
        if (!target) reject('POLICY_DENIED', 'refund_card_missing');
        const amountYuan = minorToYuan(requestedMinor);
        const balanceAfter = Math.round((target.balance + amountYuan) * 100) / 100;
        const nextCards = cards.map((card) => (card.id === target.id ? { ...card, balance: balanceAfter } : card));
        await tx.put('bank_data', { ...(bank ?? {}), id: BANK_STATE_KEY, cards: nextCards });
        assertNoFault(input.fault, 'bank_data');

        await tx.put('bank_transactions', {
          id: refundId,
          amount: amountYuan,
          category: 'income',
          note: `${args.shop ?? orig.note ?? '订单'}退款`,
          timestamp: input.nowMs,
          dateStr: localDateKey(input.nowMs, 'UTC'),
          ownerId: args.charId,
          linkedPurchaseId: args.orderId,
          cardId: target.id,
          reversalOf: outId,
        });
        assertNoFault(input.fault, 'bank_transactions');

        await tx.put('autonomy_sim_vouchers', {
          id: refundId,
          orderId: args.orderId,
          charId: args.charId,
          actionId: input.actionId,
          amount: amountYuan,
          amountMinor: requestedMinor,
          createdAt: input.nowMs,
          kind: 'refund',
        });
        assertNoFault(input.fault, 'autonomy_sim_vouchers');

        const receipt: ActionReceipt = {
          actionId: input.actionId,
          kind: 'shopping.order',
          argsHash,
          resultRef: `bank_transactions:${refundId}`,
          completedAt: input.nowMs,
          stores: [
            { store: 'bank_transactions', key: refundId },
            { store: 'autonomy_sim_vouchers', key: refundId },
          ],
          meta: { cardId: target.id, balanceAfter: String(balanceAfter) },
        };
        await tx.put('autonomy_action_receipts', receipt);
        return { status: 'succeeded', receipt, replayed: false };
      },
    );
  } catch (error) {
    if (error instanceof LocalRejection) return { status: 'failed', code: error.code, message: error.reason };
    return { status: 'failed', code: 'UNKNOWN_EFFECT', message: String(error) };
  }
}
