// ============================================================
// charLedger: char-owned bank bookkeeping.
// 选卡共享 charDefaultCard，写入各走各的（CheckPhone 随机 tx-char-* vs char 下单幂等 tx-order-<orderId>）。
// Shared by CheckPhone purchase simulation (Phase 3) and char-placed
// orders (Phase 4). Every char purchase writes exactly one outflow
// BankTransaction with ownerId=charId, so:
//   - CheckPhone bank view reads the same ledger (no second balance),
//   - BankApp user view hides char txns (it filters out ownerId txns),
//   - purchase <-> bank_txn linkage is stored both ways
//     (PhoneEvidence.linkedBankTxnId / BankTransaction.linkedPurchaseId).
// ============================================================
import { DB, openDB } from './db';
import type { BankCard } from '../types';
import { getLocalDateKey } from './localDate';
import { createLocalDbPort, debitCharCardAtomic } from './autonomyLife/localLedger';

const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

export interface CharPurchaseLink {
  bankTxnId: string;
  cardId: string; // '' when char has no card (txn still written, no deduction)
  cardLabel: string;
  deducted: boolean;
}

export function charCardsOf(cards: BankCard[] | undefined, charId: string): BankCard[] {
  return (cards || []).filter(c => c.owner === 'char' && c.ownerId === charId);
}

export function charDefaultCard(cards: BankCard[] | undefined, charId: string): BankCard | undefined {
  const mine = charCardsOf(cards, charId);
  return mine.find(c => c.isDefault) || mine[0];
}

export async function appendCharPurchaseTxn(
  charId: string,
  p: { amount: number; merchant: string; item: string; category: string; purchaseId: string; timestamp: number },
): Promise<CharPurchaseLink> {
  const total = Math.max(0, Math.round((Number(p.amount) || 0) * 100) / 100);
  const at = p.timestamp || Date.now();
  const dateStr = getLocalDateKey(new Date(at));
  const bank = await DB.getBankState().catch(() => null);
  const cards = bank?.cards || [];
  const payCard = charDefaultCard(cards, charId);
  const label = `${p.merchant}·${p.item}`;

  // 有钱可扣：走与自主消费同一套「余额+流水+凭证+回执」单事务提交（失败则整体不落）。
  if (bank && payCard && total > 0 && round2(payCard.balance) >= total) {
    const port = createLocalDbPort(await openDB());
    const outcome = await debitCharCardAtomic(port, {
      actionId: `legacy:checkPhone:${p.purchaseId}`,
      kind: 'shopping.order',
      nowMs: at,
      args: {
        charId,
        orderId: p.purchaseId,
        shop: p.merchant,
        totalMinor: Math.round(total * 100),
        note: label,
        category: p.category,
      },
    });
    if (outcome.status === 'succeeded') {
      return {
        bankTxnId: `tx-order-${p.purchaseId}`,
        cardId: payCard.id,
        cardLabel: `${payCard.name}·${payCard.tailNo}`,
        deducted: true,
      };
    }
    // 事务层拒绝（余额/归属变化）：不扣钱，但仍按旧语义记一条「未扣款」流水。
  }

  // 无卡或余额不足：沿用旧语义——只写一条未扣款的支出流水（单 store，不存在半扣）。
  const bankTxnId = `tx-char-${at}-${Math.floor(Math.random() * 1e4)}`;
  await DB.saveTransaction({
    id: bankTxnId,
    amount: -total,
    category: p.category,
    note: label,
    timestamp: at,
    dateStr,
    ownerId: charId,
    linkedPurchaseId: p.purchaseId,
    cardId: payCard?.id || undefined,
  });
  return {
    bankTxnId,
    cardId: payCard?.id || '',
    cardLabel: payCard ? `${payCard.name}·${payCard.tailNo}` : '',
    deducted: false,
  };
}
