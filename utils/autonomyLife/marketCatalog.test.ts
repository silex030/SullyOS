import { describe, expect, it } from 'vitest';

import {
  approvedCategoryOf,
  buildMarketCatalog,
  buildMarketProposal,
  catalogFromMall,
  catalogFromTakeout,
  orderTotalMinorFromArgs,
  type MarketCatalog,
} from './marketCatalog';

const NOW = Date.UTC(2026, 9, 24, 4, 0, 0); // 2026-10-24 12:00 +08:00
const TZ = 'Asia/Shanghai';

/**
 * 合法目录夹具：形状与 `public/shopping/*.json` 一致，价格/店名/商品 id 都在夹具里，
 * 断言「候选里的价格一定出自目录」。它只是测试夹具，不代表线上目录内容。
 */
const takeoutRaw = {
  shops: [
    { id: 'shop_a', name: '巷口面馆', cat: '美食外卖', deliveryFee: 2, minOrder: 15, monthlySales: 900 },
    { id: 'shop_b', name: '深夜烧烤', cat: '美食外卖', deliveryFee: 3, minOrder: 20, monthlySales: 300 },
    { id: 'shop_c', name: '某某棋牌', cat: '娱乐', deliveryFee: 1, minOrder: 0, monthlySales: 9999 },
    { id: 'shop_d', name: '贵价店', cat: '美食外卖', deliveryFee: 5, minOrder: 0, monthlySales: 1 },
  ],
  dishes: [
    { id: 'dish_a1', shopId: 'shop_a', name: '番茄鸡蛋面', price: 12.5, cat: '主食' },
    { id: 'dish_a2', shopId: 'shop_a', name: '凉拌黄瓜', price: 6, cat: '小菜' },
    { id: 'dish_b1', shopId: 'shop_b', name: '烤串拼盘', price: 18, cat: '烧烤' },
    { id: 'dish_c1', shopId: 'shop_c', name: '筹码', price: 10, cat: '筹码' },
    { id: 'dish_d1', shopId: 'shop_d', name: '豪华套餐', price: 88, cat: '套餐' },
    { id: 'dish_bad', shopId: 'shop_a', name: '零元购', price: 0, cat: '主食' },
  ],
};

const mallRaw = {
  shops: [
    { id: 'mshop_a', name: '三联书店', cat: '图书文具', monthlySales: 500 },
    { id: 'mshop_b', name: '某奢侈品', cat: '珠宝腕表', monthlySales: 900 },
    { id: 'mshop_c', name: '数码小铺', cat: '数码家电', monthlySales: 100 },
  ],
  goods: [
    { id: 'g_a1', shopId: 'mshop_a', name: '笔记本', price: 19.9, cat: '文具' },
    { id: 'g_c1', shopId: 'mshop_c', name: '充电线', price: 29, cat: '配件' },
    { id: 'g_b1', shopId: 'mshop_b', name: '钻戒', price: 9999, cat: '珠宝' },
  ],
};

const catalog: MarketCatalog = buildMarketCatalog({ takeout: takeoutRaw, mall: mallRaw });

describe('真实目录归一化（价格一律取目录，单位分）', () => {
  it('外卖：元 → 分；价格 <= 0 / 缺字段的条目丢弃', () => {
    const ds = catalogFromTakeout(takeoutRaw);
    expect(ds.shops.find((shop) => shop.id === 'shop_a')).toMatchObject({
      deliveryFeeMinor: 200, minOrderMinor: 1500, monthlySales: 900, cat: '美食外卖',
    });
    expect(ds.items.find((item) => item.id === 'dish_a1')?.priceMinor).toBe(1250);
    expect(ds.items.some((item) => item.id === 'dish_bad')).toBe(false);
  });

  it('购物：没有配送费就是 0（不编一个）；缺 id/价格非法丢弃', () => {
    const ds = catalogFromMall(mallRaw);
    expect(ds.shops.find((shop) => shop.id === 'mshop_a')?.deliveryFeeMinor).toBe(0);
    expect(ds.items.find((item) => item.id === 'g_a1')?.priceMinor).toBe(1990);
    expect(ds.items.length).toBe(3);
  });

  it('类目映射只认已审核白名单；「娱乐/珠宝腕表」这类不猜成安全品类', () => {
    expect(approvedCategoryOf('takeout.order', '美食外卖')).toBe('外卖');
    expect(approvedCategoryOf('takeout.order', '娱乐')).toBeNull();
    expect(approvedCategoryOf('shopping.order', '图书文具')).toBe('图书');
    expect(approvedCategoryOf('shopping.order', '珠宝腕表')).toBeNull();
  });
});

describe('订单总额口径（与执行侧一致）', () => {
  it('Σ 单价×数量 + 配送费', () => {
    expect(orderTotalMinorFromArgs({
      items: [{ unitPriceMinor: 1250, qty: 1 }, { unitPriceMinor: 600, qty: 2 }],
      deliveryFeeMinor: 200,
    })).toBe(1250 + 1200 + 200);
  });

  it('非法形状返回 null（不猜 0，也不四舍五入）', () => {
    expect(orderTotalMinorFromArgs(null)).toBeNull();
    expect(orderTotalMinorFromArgs({ items: [] })).toBeNull();
    expect(orderTotalMinorFromArgs({ items: [{ unitPriceMinor: 1.5, qty: 1 }] })).toBeNull();
    expect(orderTotalMinorFromArgs({ items: [{ unitPriceMinor: 10, qty: 0 }] })).toBeNull();
    expect(orderTotalMinorFromArgs({ items: [{ unitPriceMinor: 10, qty: 1 }], deliveryFeeMinor: -1 })).toBeNull();
  });
});

describe('从真实目录选单（不编价格、不越过上限）', () => {
  const base = {
    catalog,
    charId: 'char-market',
    addressText: '北京市朝阳区某小区 3 号楼',
    cardId: 'card-char-1',
    nowMs: NOW,
    timezone: TZ,
    seed: 'install-seed',
  };

  it('外卖：店/商品/单价全部来自目录，总额 = 目录价 + 配送费', () => {
    const proposal = buildMarketProposal({
      ...base,
      kind: 'takeout.order',
      budget: { orderMaxMinor: 5000, spendRemainingMinor: 20_000, walletBalanceMinor: 100_000 },
    });
    expect(proposal).not.toBeNull();
    const args = proposal!.args as {
      shopId: string; shopName: string; category: string; deliveryFeeMinor: number;
      orderId: string; cardId: string; shopCat: string;
      items: Array<{ dishId: string; name: string; unitPriceMinor: number; qty: number }>;
    };
    const shop = takeoutRaw.shops.find((item) => item.id === args.shopId)!;
    expect(shop).toBeTruthy();
    expect(args.shopName).toBe(shop.name);
    expect(args.category).toBe('外卖');
    expect(args.deliveryFeeMinor).toBe(Math.round((shop.deliveryFee ?? 0) * 100));
    expect(args.orderId).toMatch(/^ord_[a-z0-9]{4,40}$/);
    expect(args.cardId).toBe('card-char-1');
    expect(args.shopCat).toBe(shop.cat);
    for (const item of args.items) {
      const dish = takeoutRaw.dishes.find((row) => row.id === item.dishId)!;
      expect(dish.shopId).toBe(args.shopId);
      expect(item.name).toBe(dish.name);
      expect(item.unitPriceMinor).toBe(Math.round(dish.price * 100));
      expect(item.qty).toBe(1);
    }
    const total = orderTotalMinorFromArgs(args);
    expect(total).toBe(args.items.reduce((sum, item) => sum + item.unitPriceMinor * item.qty, 0) + args.deliveryFeeMinor);
    expect(total!).toBeLessThanOrEqual(5000);
    expect(total!).toBeGreaterThanOrEqual(shop.minOrder * 100);
    // 受限类目的店永远选不到。
    expect(args.shopId).not.toBe('shop_c');
  });

  it('购物：只在有已审核类目的店（图书/数码/商超）里选', () => {
    const proposal = buildMarketProposal({
      ...base,
      kind: 'shopping.order',
      budget: { orderMaxMinor: 5000, spendRemainingMinor: 20_000, walletBalanceMinor: 100_000 },
    });
    expect(proposal).not.toBeNull();
    const args = proposal!.args as { shopId: string; category: string };
    expect(['mshop_a', 'mshop_c']).toContain(args.shopId);
    expect(['图书', '数码']).toContain(args.category);
  });

  it('单笔上限 / 今日剩余额度 / 卡余额任一不足 → 不生成（不编一个便宜价）', () => {
    const zeroWallet = buildMarketProposal({
      ...base, kind: 'takeout.order',
      budget: { orderMaxMinor: 5000, spendRemainingMinor: 20_000, walletBalanceMinor: 0 },
    });
    expect(zeroWallet).toBeNull();
    // 余额只够最便宜的一单：仍要能选（>= 起送价的约束会被满足或直接不生成）。
    const tightWallet = buildMarketProposal({
      ...base, kind: 'takeout.order',
      budget: { orderMaxMinor: 5000, spendRemainingMinor: 20_000, walletBalanceMinor: 1400 },
    });
    if (tightWallet) {
      expect(orderTotalMinorFromArgs(tightWallet.args)!).toBeLessThanOrEqual(1400);
    }
    const zeroMax = buildMarketProposal({
      ...base, kind: 'takeout.order',
      budget: { orderMaxMinor: 0, spendRemainingMinor: 20_000, walletBalanceMinor: 100_000 },
    });
    expect(zeroMax).toBeNull();
    const zeroSpend = buildMarketProposal({
      ...base, kind: 'takeout.order',
      budget: { orderMaxMinor: 5000, spendRemainingMinor: 0, walletBalanceMinor: 100_000 },
    });
    expect(zeroSpend).toBeNull();
  });

  it('没有收货地址 / 没有付款卡 / 没有目录 → 不生成', () => {
    expect(buildMarketProposal({
      ...base, addressText: '', kind: 'takeout.order',
      budget: { orderMaxMinor: 5000, spendRemainingMinor: 20000, walletBalanceMinor: 100000 },
    })).toBeNull();
    expect(buildMarketProposal({
      ...base, cardId: '', kind: 'takeout.order',
      budget: { orderMaxMinor: 5000, spendRemainingMinor: 20000, walletBalanceMinor: 100000 },
    })).toBeNull();
    expect(buildMarketProposal({
      ...base, catalog: { takeout: { shops: [], items: [] }, mall: { shops: [], items: [] } }, kind: 'takeout.order',
      budget: { orderMaxMinor: 5000, spendRemainingMinor: 20000, walletBalanceMinor: 100000 },
    })).toBeNull();
  });

  it('确定性：同角色/同一天/同预算 → 同一 proposalId 与同一组参数', () => {
    const once = buildMarketProposal({
      ...base, kind: 'takeout.order',
      budget: { orderMaxMinor: 5000, spendRemainingMinor: 20_000, walletBalanceMinor: 100_000 },
    });
    const twice = buildMarketProposal({
      ...base, kind: 'takeout.order',
      budget: { orderMaxMinor: 5000, spendRemainingMinor: 20_000, walletBalanceMinor: 100_000 },
    });
    expect(once).not.toBeNull();
    expect(twice).toEqual(once);
    expect(once!.proposalId).toMatch(/^mp_[a-z0-9]{4,40}$/);
    // 隔天是另一份候选（日期进了 proposalId）。
    const nextDay = buildMarketProposal({
      ...base, nowMs: NOW + 24 * 60 * 60_000, kind: 'takeout.order',
      budget: { orderMaxMinor: 5000, spendRemainingMinor: 20_000, walletBalanceMinor: 100_000 },
    });
    expect(nextDay).not.toBeNull();
    expect(nextDay!.proposalId).not.toBe(once!.proposalId);
  });
});
