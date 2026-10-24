// charOrder: char-initiated orders paid from the char's own bank card.
// Phase 4: the chat directive LIFE:ORDER deducts the char's default card
// (owner='char', ownerId=charId) instead of the user's card, so the
// CheckPhone bank ledger (ownerId-filtered, Phase 3) stays consistent.
// Money-only module: order document building stays in lifeRecords.ts;
// this file owns balance mutation + transaction writes + idempotency.
//
// v80（自主生活）：扣款/退款不再「先读流水判重 → saveBankState → saveTransaction」串两个
// 事务，而是委托给 utils/autonomyLife/localLedger 的**同一 readwrite 事务**：
//   `tx-order-<orderId>` 凭证 + 卡余额 + 流水 + 回执一起提交。
// 对外 API/返回形状不变（调用方不用改），但中途崩溃不会再出现「钱扣了流水没写」。
// Idempotency: outflow id = tx-order-<orderId>, refund id = tx-refund-<orderId>.
import { DB, openDB } from './db';
import { charDefaultCard } from './charLedger';
import { createLocalDbPort, debitCharCardAtomic, refundCharCardAtomic } from './autonomyLife/localLedger';

export const charOrderTxnId = (orderId: string): string => `tx-order-${orderId}`;
export const charRefundTxnId = (orderId: string): string => `tx-refund-${orderId}`;

export interface CharOrderPaymentInput {
  orderId: string;
  charId: string;
  charName?: string;
  shop: string;
  total: number;
}

export type CharOrderDenyReason = 'invalid' | 'no_bank' | 'no_card' | 'insufficient';

export interface CharOrderPaymentResult {
  ok: boolean;
  txnId?: string;
  cardId?: string;
  cardLabel?: string;
  reason?: CharOrderDenyReason;
  balance?: number;
  replay?: boolean;
}

const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

/** Deduct the char's default card once per orderId (idempotent, single transaction). */
export async function debitCharCardForOrder(input: CharOrderPaymentInput): Promise<CharOrderPaymentResult> {
  const total = round2(input.total);
  const orderId = (input.orderId || '').trim();
  if (!orderId || !(total > 0)) return { ok: false, reason: 'invalid' };

  // 先做只读前置检查，只为给出准确原因（no_bank / no_card / insufficient）；
  // 真正的判定与扣款在同一个事务里再做一次，读检查不承担正确性。
  const bank = await DB.getBankState().catch(() => null);
  if (!bank) return { ok: false, reason: 'no_bank' };
  const cards = bank.cards || [];
  const payCard = charDefaultCard(cards, input.charId);
  if (!payCard) return { ok: false, reason: 'no_card' };

  const port = createLocalDbPort(await openDB());
  const outcome = await debitCharCardAtomic(port, {
    actionId: `legacy:charOrder:${orderId}`,
    kind: 'shopping.order',
    nowMs: Date.now(),
    args: {
      charId: input.charId,
      orderId,
      shop: input.shop,
      totalMinor: Math.round(total * 100),
      charName: input.charName,
    },
  });
  if (outcome.status === 'succeeded') {
    const meta = outcome.receipt.meta ?? {};
    return {
      ok: true,
      txnId: charOrderTxnId(orderId),
      cardId: meta.cardId || payCard.id,
      cardLabel: meta.cardLabel || `${payCard.name}·${payCard.tailNo}`,
      ...(outcome.replayed ? { replay: true } : {}),
    };
  }
  if (outcome.code === 'BUDGET_EXHAUSTED') {
    return { ok: false, reason: 'insufficient', balance: payCard.balance };
  }
  if (outcome.code === 'POLICY_DENIED') return { ok: false, reason: 'no_card' };
  return { ok: false, reason: 'invalid' };
}

/** Explicit merchant-style refund: restores balance + writes an inflow txn (single transaction, idempotent). */
export async function refundCharOrder(
  orderId: string,
  charId: string,
  opts?: { shop?: string; total?: number; cardId?: string },
): Promise<{ refunded: boolean; txnId?: string; replay?: boolean }> {
  const oid = (orderId || '').trim();
  if (!oid) return { refunded: false };
  const port = createLocalDbPort(await openDB());
  const outcome = await refundCharCardAtomic(port, {
    actionId: `legacy:charRefund:${oid}`,
    nowMs: Date.now(),
    args: {
      charId,
      orderId: oid,
      shop: opts?.shop,
      ...(typeof opts?.total === 'number' && opts.total > 0 ? { totalMinor: Math.round(opts.total * 100) } : {}),
    },
  });
  if (outcome.status !== 'succeeded') return { refunded: false };
  return { refunded: true, txnId: charRefundTxnId(oid), ...(outcome.replayed ? { replay: true } : {}) };
}

/** Reject-rollback helper: user denial means "never happened" — give the money back. */
export async function restoreCharCardBalance(charId: string, amount: number, cardId?: string): Promise<boolean> {
  const amt = round2(amount);
  if (!(amt > 0)) return false;
  const bank = await DB.getBankState().catch(() => null);
  if (!bank) return false;
  const cards = bank.cards || [];
  const target = (cardId && cards.find(c => c.id === cardId)) || charDefaultCard(cards, charId);
  if (!target) return false;
  const nextCards = cards.map(c => (c.id === target.id ? { ...c, balance: round2(c.balance + amt) } : c));
  await DB.saveBankState({ ...bank, cards: nextCards });
  return true;
}

