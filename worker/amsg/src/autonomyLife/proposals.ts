/**
 * 绑定设备上报的「真实目录候选」（外卖/购物）——校验、落库、取用。
 *
 * 为什么需要这条通道（本卡 P1 整改）：
 *   外卖/购物要花的钱必须是**目录里的真实价格**，收货地址与钱包余额只存在于绑定设备
 *   （角色档案 / `bank_data.main_state`）。worker 没有这些真实数据，让模型编一个
 *   `{shopId, items, unitPriceMinor}` 就是伪造消费。所以：
 *     设备选单（真实目录 + 真实地址 + 真实卡余额） → POST /proposals（本文件校验并落库）
 *     → 引擎 tick 把候选和模型候选一起打分 → 边界/额度/许可照旧 → 设备执行时再核一次。
 *
 * 硬约束（这里就不放宽）：
 *   - 只接受 `MARKET_PROPOSAL_KINDS`（takeout.order / shopping.order），**不接受**日记/
 *     消息这类自由文本 kind：这条通道不能变成绕过内容校验的注入面；
 *   - 参数必须过 `validateArgsForKind` 的封闭 schema；类目必须在已审核白名单里；
 *     单价/数量都是整数「分」，总额 = Σ单价×数量 + 配送费，且 ≤ 用户设的单笔上限；
 *   - 地址非空、长度受限；任何一条不合法整包拒绝（不「收下能收的」）。
 */

import {
  CLIENT_PROPOSAL_ID_RE,
  CLIENT_PROPOSAL_TTL_MS,
  MAX_CLIENT_PROPOSALS,
  isMarketProposalKind,
  type ClientProposal,
  type ClientProposalInput,
} from '../../../../contracts/autonomyLife';
import { orderTotalMinorFromArgs } from '../../../../utils/autonomyLife/marketCatalog';
import {
  isApprovedShoppingCategory,
  mapShoppingCategory,
  validateArgsForKind,
} from '../../../../utils/autonomyLife/policy';
import type { Candidate } from '../../../../utils/autonomyLife/rhythm';
import type { LifeDb } from './store';

export const PROPOSAL_ADDRESS_MAX_CHARS = 200;
export const PROPOSAL_NAME_MAX_CHARS = 120;
export const PROPOSAL_MAX_ITEMS = 8;
const SEMANTIC_PURPOSE_RE = /^[a-z0-9_:-]{1,48}$/i;
const FINGERPRINT_RE = /^[a-f0-9]{1,64}$/i;
const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CARD_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export interface ProposalValidationContext {
  /** 用户设的单笔上限（分）；<= 0 = 明确禁止消费。 */
  orderMaxMinor: number;
}

export type ProposalValidation =
  | { ok: true; proposals: ClientProposalInput[] }
  | { ok: false; reason: string; index: number | null };

const nonEmptyString = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null;

function validateOne(raw: unknown, ctx: ProposalValidationContext): { ok: true; value: ClientProposalInput } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'proposal_not_object' };
  const row = raw as Record<string, unknown>;

  const proposalId = typeof row.proposalId === 'string' ? row.proposalId.trim() : '';
  if (!CLIENT_PROPOSAL_ID_RE.test(proposalId)) return { ok: false, reason: 'proposal_id_invalid' };

  if (!isMarketProposalKind(row.kind)) return { ok: false, reason: 'kind_not_proposable' };
  const kind = row.kind;

  const semanticPurpose = typeof row.semanticPurpose === 'string' ? row.semanticPurpose.trim() : '';
  if (!SEMANTIC_PURPOSE_RE.test(semanticPurpose)) return { ok: false, reason: 'semantic_purpose_invalid' };

  if (row.args === null || typeof row.args !== 'object' || Array.isArray(row.args)) {
    return { ok: false, reason: 'args_not_object' };
  }
  const args = row.args as Record<string, unknown>;

  const shape = validateArgsForKind(kind, args);
  if (!shape.ok) return { ok: false, reason: `args_${shape.reasonCode ?? 'invalid'}` };

  const shopId = nonEmptyString(args.shopId, PROPOSAL_NAME_MAX_CHARS);
  const shopName = nonEmptyString(args.shopName, PROPOSAL_NAME_MAX_CHARS);
  const addressText = nonEmptyString(args.addressText, PROPOSAL_ADDRESS_MAX_CHARS);
  if (!shopId || !shopName) return { ok: false, reason: 'shop_invalid' };
  if (!addressText) return { ok: false, reason: 'address_invalid' };

  const orderId = nonEmptyString(args.orderId, 64);
  if (!orderId || !ORDER_ID_RE.test(orderId)) return { ok: false, reason: 'order_id_invalid' };
  const cardId = nonEmptyString(args.cardId, 64);
  if (!cardId || !CARD_ID_RE.test(cardId)) return { ok: false, reason: 'card_id_invalid' };
  if (args.shopCat !== undefined && (typeof args.shopCat !== 'string' || args.shopCat.length > 40)) {
    return { ok: false, reason: 'shop_cat_invalid' };
  }

  const mapped = mapShoppingCategory(args.category);
  if (mapped.restricted || !isApprovedShoppingCategory(mapped.category)) {
    return { ok: false, reason: 'category_not_approved' };
  }

  if (!Array.isArray(args.items) || args.items.length === 0 || args.items.length > PROPOSAL_MAX_ITEMS) {
    return { ok: false, reason: 'items_invalid' };
  }
  for (const item of args.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, reason: 'item_invalid' };
    const entry = item as Record<string, unknown>;
    if (!nonEmptyString(entry.dishId, PROPOSAL_NAME_MAX_CHARS)) return { ok: false, reason: 'item_id_invalid' };
    if (!nonEmptyString(entry.name, PROPOSAL_NAME_MAX_CHARS)) return { ok: false, reason: 'item_name_invalid' };
    if (typeof entry.unitPriceMinor !== 'number' || !Number.isInteger(entry.unitPriceMinor) || entry.unitPriceMinor < 0) {
      return { ok: false, reason: 'item_price_invalid' };
    }
    if (typeof entry.qty !== 'number' || !Number.isInteger(entry.qty) || entry.qty <= 0 || entry.qty > 20) {
      return { ok: false, reason: 'item_qty_invalid' };
    }
  }
  if (args.deliveryFeeMinor !== undefined) {
    if (typeof args.deliveryFeeMinor !== 'number' || !Number.isInteger(args.deliveryFeeMinor) || args.deliveryFeeMinor < 0) {
      return { ok: false, reason: 'delivery_fee_invalid' };
    }
  }
  if (args.note !== undefined && (typeof args.note !== 'string' || args.note.length > 120)) {
    return { ok: false, reason: 'note_invalid' };
  }

  const totalMinor = orderTotalMinorFromArgs(args);
  if (totalMinor === null || totalMinor <= 0) return { ok: false, reason: 'order_total_invalid' };
  if (ctx.orderMaxMinor <= 0) return { ok: false, reason: 'orders_disabled' };
  if (totalMinor > ctx.orderMaxMinor) return { ok: false, reason: 'order_over_max' };

  const fingerprint = row.contentFingerprint;
  if (fingerprint !== undefined && (typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint))) {
    return { ok: false, reason: 'fingerprint_invalid' };
  }

  return {
    ok: true,
    value: {
      proposalId,
      kind,
      semanticPurpose,
      args,
      ...(typeof fingerprint === 'string' ? { contentFingerprint: fingerprint } : {}),
    },
  };
}

/** 整包校验：任何一条不合法 → 整包拒绝（原因 + 下标，便于设备侧修）。 */
export function validateClientProposals(raw: unknown, ctx: ProposalValidationContext): ProposalValidation {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, reason: 'proposals_required', index: null };
  if (raw.length > MAX_CLIENT_PROPOSALS) return { ok: false, reason: 'too_many_proposals', index: null };
  const seen = new Set<string>();
  const out: ClientProposalInput[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const one = validateOne(raw[index], ctx);
    if (!one.ok) return { ok: false, reason: one.reason, index };
    if (seen.has(one.value.proposalId)) return { ok: false, reason: 'duplicate_proposal_id', index };
    seen.add(one.value.proposalId);
    out.push(one.value);
  }
  return { ok: true, proposals: out };
}

/** 幂等落库：同一 proposalId 覆盖（重传同一份候选不会变成两条）。 */
export async function upsertClientProposals(input: {
  db: LifeDb;
  ownerId: string;
  charId: string;
  proposals: readonly ClientProposalInput[];
  nowMs: number;
  ttlMs?: number;
}): Promise<number> {
  const ttl = Math.max(60_000, Math.trunc(input.ttlMs ?? CLIENT_PROPOSAL_TTL_MS));
  let written = 0;
  for (const proposal of input.proposals) {
    const payload: ClientProposal = {
      ...proposal,
      charId: input.charId,
      createdAt: input.nowMs,
      expiresAt: input.nowMs + ttl,
    };
    const result = await input.db
      .prepare(
        `INSERT INTO autonomy_life_proposals (owner_id, proposal_id, char_id, kind, payload, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_id, proposal_id) DO UPDATE SET payload = excluded.payload,
           kind = excluded.kind, created_at = excluded.created_at, expires_at = excluded.expires_at`,
      )
      .bind(input.ownerId, proposal.proposalId, input.charId, proposal.kind, JSON.stringify(payload), input.nowMs, payload.expiresAt)
      .run();
    if (result) written += 1;
  }
  return written;
}

const parsePayload = (raw: unknown): ClientProposal | null => {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as ClientProposal;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!isMarketProposalKind(parsed.kind)) return null;
    if (!parsed.args || typeof parsed.args !== 'object' || Array.isArray(parsed.args)) return null;
    if (typeof parsed.proposalId !== 'string' || typeof parsed.semanticPurpose !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
};

/** 取该角色当前仍有效的候选（过期的不返回；坏的 payload 跳过而不是整轮失败）。 */
export async function listClientProposals(input: {
  db: LifeDb;
  ownerId: string;
  charId: string;
  nowMs: number;
}): Promise<ClientProposal[]> {
  const result = await input.db
    .prepare(
      `SELECT payload FROM autonomy_life_proposals
       WHERE owner_id = ? AND char_id = ? AND expires_at > ?
       ORDER BY created_at ASC LIMIT 8`,
    )
    .bind(input.ownerId, input.charId, input.nowMs)
    .all()
    .catch(() => null);
  const rows = (result?.results ?? []) as Array<{ payload?: unknown }>;
  return rows
    .map((row) => parsePayload(row.payload))
    .filter((row): row is ClientProposal => row !== null);
}

/** 动作排上之后回收该角色的同类候选（同一笔钱不排两次）。 */
export async function deleteClientProposals(input: {
  db: LifeDb;
  ownerId: string;
  charId: string;
  kind: string;
}): Promise<void> {
  await input.db
    .prepare('DELETE FROM autonomy_life_proposals WHERE owner_id = ? AND char_id = ? AND kind = ?')
    .bind(input.ownerId, input.charId, input.kind)
    .run()
    .catch(() => undefined);
}

/** 清掉过期行（cron 每跳顺手做一次，避免表无限长）。 */
export async function pruneClientProposals(input: {
  db: LifeDb;
  ownerId: string;
  nowMs: number;
  keepMs?: number;
}): Promise<void> {
  await input.db
    .prepare('DELETE FROM autonomy_life_proposals WHERE owner_id = ? AND expires_at < ?')
    .bind(input.ownerId, input.nowMs - Math.max(0, input.keepMs ?? 0))
    .run()
    .catch(() => undefined);
}

/** 候选 → 引擎候选（保留参数原样；打分只额外用 interestTags 之类的人设信号）。 */
export function proposalToCandidate(proposal: ClientProposal): Candidate {
  return {
    kind: proposal.kind,
    semanticPurpose: proposal.semanticPurpose,
    ...(proposal.contentFingerprint ? { contentFingerprint: proposal.contentFingerprint } : {}),
    args: proposal.args,
  };
}
