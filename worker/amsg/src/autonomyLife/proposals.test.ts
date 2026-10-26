import { beforeEach, describe, expect, it } from 'vitest';

import { createSqliteD1, openTestSqlite, type TestSqlite } from '../test/d1-sqlite';
import {
  ensureAutonomyLifeSchema,
  resetAutonomyLifeSchemaCacheForTesting,
  type LifeDb,
} from './store';
import {
  deleteClientProposals,
  listClientProposals,
  proposalToCandidate,
  upsertClientProposals,
  validateClientProposals,
} from './proposals';

const NOW = Date.UTC(2026, 9, 24, 4, 0, 0);
const OWNER = 'owner-1';
const CHAR = 'char-1';

const validProposal = (overrides: Record<string, unknown> = {}) => ({
  proposalId: 'mp_abc12345',
  kind: 'takeout.order',
  semanticPurpose: 'meal_order',
  contentFingerprint: 'a1b2c3d4',
  args: {
    shopId: 'shop_a',
    shopName: '巷口面馆',
    category: '外卖',
    shopCat: '美食外卖',
    orderId: 'ord_abc12345',
    cardId: 'card-char-1',
    addressText: '北京市朝阳区某小区 3 号楼',
    deliveryFeeMinor: 200,
    items: [{ dishId: 'dish_a1', name: '番茄鸡蛋面', unitPriceMinor: 1250, qty: 1 }],
  },
  ...overrides,
});

const ctx = { orderMaxMinor: 5000 };

describe('设备候选校验（整包拒绝，不半收）', () => {
  it('合法候选通过，字段原样保留', () => {
    const result = validateClientProposals([validProposal()], ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposals[0]).toEqual({
      proposalId: 'mp_abc12345',
      kind: 'takeout.order',
      semanticPurpose: 'meal_order',
      contentFingerprint: 'a1b2c3d4',
      args: validProposal().args,
    });
  });

  it('只接受外卖/购物：日记、消息这类自由文本 kind 一律拒（不能变成注入面）', () => {
    const journal = validProposal({ kind: 'journal.write', args: { title: 'x', body: 'y' } });
    const result = validateClientProposals([journal], ctx);
    expect(result).toMatchObject({ ok: false, reason: 'kind_not_proposable', index: 0 });
  });

  it('未知参数键 / 缺必填 / 越权键 → 拒', () => {
    const extra = validProposal({ args: { ...validProposal().args, url: 'https://evil.example' } });
    expect(validateClientProposals([extra], ctx)).toMatchObject({ ok: false, reason: 'args_unknown_arg_field' });
    const missing = validProposal({ args: { ...validProposal().args, addressText: '' } });
    expect(validateClientProposals([missing], ctx)).toMatchObject({ ok: false, reason: 'args_missing_arg' });
  });

  it('价格/数量必须是整数分；总额必须 >0 且 ≤ 单笔上限', () => {
    const floatPrice = validProposal({
      args: { ...validProposal().args, items: [{ dishId: 'd', name: 'n', unitPriceMinor: 12.5, qty: 1 }] },
    });
    expect(validateClientProposals([floatPrice], ctx)).toMatchObject({ ok: false, reason: 'item_price_invalid' });
    const zeroQty = validProposal({
      args: { ...validProposal().args, items: [{ dishId: 'd', name: 'n', unitPriceMinor: 100, qty: 0 }] },
    });
    expect(validateClientProposals([zeroQty], ctx)).toMatchObject({ ok: false, reason: 'item_qty_invalid' });
    expect(validateClientProposals([validProposal()], { orderMaxMinor: 100 })).toMatchObject({ ok: false, reason: 'order_over_max' });
    expect(validateClientProposals([validProposal()], { orderMaxMinor: 0 })).toMatchObject({ ok: false, reason: 'orders_disabled' });
  });

  it('未审核类目（娱乐/珠宝）→ 拒；id 形状不对/重复 → 拒；空数组/超量 → 拒', () => {
    const restricted = validProposal({ args: { ...validProposal().args, category: '娱乐' } });
    expect(validateClientProposals([restricted], ctx)).toMatchObject({ ok: false, reason: 'category_not_approved' });
    expect(validateClientProposals([validProposal({ proposalId: 'bad id!' })], ctx)).toMatchObject({ ok: false, reason: 'proposal_id_invalid' });
    expect(validateClientProposals([validProposal(), validProposal()], ctx)).toMatchObject({ ok: false, reason: 'duplicate_proposal_id' });
    expect(validateClientProposals([], ctx)).toMatchObject({ ok: false, reason: 'proposals_required' });
    expect(validateClientProposals([1, 2, 3, 4, 5], ctx)).toMatchObject({ ok: false, reason: 'too_many_proposals' });
  });
});

describe('候选落库（D1 真 SQL）：幂等、按角色隔离、过期不可用、可回收', () => {
  let sql: TestSqlite;
  let db: LifeDb;

  beforeEach(async () => {
    sql = openTestSqlite();
    db = createSqliteD1(sql) as unknown as LifeDb;
    resetAutonomyLifeSchemaCacheForTesting();
    await ensureAutonomyLifeSchema(db);
  });

  it('同一 proposalId 重传只留一行，过期后读不到；回收后清空', async () => {
    const [proposal] = (validateClientProposals([validProposal()], ctx) as { proposals: any[] }).proposals;
    await upsertClientProposals({ db, ownerId: OWNER, charId: CHAR, proposals: [proposal], nowMs: NOW });
    await upsertClientProposals({ db, ownerId: OWNER, charId: CHAR, proposals: [proposal], nowMs: NOW + 1_000 });
    const rows = sql.prepare('SELECT COUNT(*) AS n FROM autonomy_life_proposals WHERE owner_id = ?').get(OWNER) as { n: number };
    expect(Number(rows.n)).toBe(1);
    expect((await listClientProposals({ db, ownerId: OWNER, charId: CHAR, nowMs: NOW })).length).toBe(1);

    // 过期后不可用（真实价格/余额会变）。
    expect(await listClientProposals({ db, ownerId: OWNER, charId: CHAR, nowMs: NOW + 3 * 60 * 60_000 })).toEqual([]);

    await deleteClientProposals({ db, ownerId: OWNER, charId: CHAR, kind: 'takeout.order' });
    expect(await listClientProposals({ db, ownerId: OWNER, charId: CHAR, nowMs: NOW })).toEqual([]);
  });

  it('候选 → 引擎候选：参数原样（引擎不替设备改价）', async () => {
    const [proposal] = (validateClientProposals([validProposal()], ctx) as { proposals: any[] }).proposals;
    await upsertClientProposals({ db, ownerId: OWNER, charId: CHAR, proposals: [proposal], nowMs: NOW });
    const [stored] = await listClientProposals({ db, ownerId: OWNER, charId: CHAR, nowMs: NOW });
    const candidate = proposalToCandidate(stored);
    expect(candidate.kind).toBe('takeout.order');
    expect(candidate.semanticPurpose).toBe('meal_order');
    expect(candidate.args).toEqual(validProposal().args);
  });
});
