/**
 * 真实目录 → 「消费类生活候选」的纯逻辑层（零 IO、零模型、零 Date.now）。
 *
 * 为什么这样分工（这是本卡 P1 整改的核心）：
 *   - 外卖/购物的参数必须来自**既有真实目录**（`public/shopping/*.json`：OSM 真实店铺 +
 *     品牌 SKU 真实价格），单价格式化成最小货币整数，**绝不交给模型编价**；
 *   - 只有绑定设备同时拥有三样真实东西：目录（静态资源）、角色收货地址（角色档案）、
 *     模拟钱包余额（`bank_data.main_state` 里属于该角色的卡）。所以候选由设备侧生成，
 *     经 `/proposals` 上报；服务端只做「选不选它 + 边界/额度/许可」；
 *   - 本文件只做纯计算，方便单测与两端共用（不含 fetch / IDB / DOM）。
 */

import {
  CLIENT_PROPOSAL_TTL_MS,
  hashString,
  isMarketProposalKind,
  type ClientProposalInput,
  type MarketProposalKind,
} from '../../contracts/autonomyLife';
import { createRng, localDateKey } from './time';

/** 目录里的一家店（只保留选单需要的字段）。 */
export interface MarketShop {
  id: string;
  name: string;
  /** 目录原始类目（外卖 `美食外卖` 等 / 购物 `图书文具` 等）。 */
  cat: string;
  /** 配送费（分）。 */
  deliveryFeeMinor: number;
  /** 起送价（分）；0 = 无起送限制。 */
  minOrderMinor: number;
  /** 月销（只用于确定性排序，不参与「伪造热度」展示）。 */
  monthlySales: number;
}

/** 目录里的一个商品/菜品（真实 id + 真实单价，单位分）。 */
export interface MarketItem {
  id: string;
  shopId: string;
  name: string;
  priceMinor: number;
}

export interface MarketDataset {
  shops: MarketShop[];
  items: MarketItem[];
}

export interface MarketCatalog {
  /** 外卖（TakeoutApp 数据集）。 */
  takeout: MarketDataset;
  /** 购物（ShoppingApp 数据集）。 */
  mall: MarketDataset;
}

export const EMPTY_MARKET_CATALOG: MarketCatalog = {
  takeout: { shops: [], items: [] },
  mall: { shops: [], items: [] },
};

/**
 * 目录类目 → 契约里**已审核**的购物类目标签（policy.mapShoppingCategory 的白名单）。
 * 不在表里的类目一律不生成候选（不猜成安全品类）。
 */
const TAKEOUT_CATEGORY: Record<string, string> = {
  美食外卖: '外卖',
  奶茶饮品: '奶茶',
  甜品蛋糕: '甜品',
  超市便利: '超市',
  生鲜果蔬: '生鲜',
  医药健康: '医药',
  鲜花绿植: '鲜花',
};

const MALL_CATEGORY: Record<string, string> = {
  图书文具: '图书',
  数码家电: '数码',
  商超百货: '超市',
};

export function approvedCategoryOf(kind: MarketProposalKind, shopCat: unknown): string | null {
  if (typeof shopCat !== 'string') return null;
  const table = kind === 'takeout.order' ? TAKEOUT_CATEGORY : MALL_CATEGORY;
  return table[shopCat.trim()] ?? null;
}

const yuanToMinor = (value: unknown): number => {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.round(num * 100);
};

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** 外卖数据集（shops.json + dishes.json）→ 归一化目录。 */
export function catalogFromTakeout(raw: {
  shops?: unknown;
  dishes?: unknown;
} | null | undefined): MarketDataset {
  const shopsRaw = Array.isArray(raw?.shops) ? raw?.shops as Array<Record<string, unknown>> : [];
  const dishesRaw = Array.isArray(raw?.dishes) ? raw?.dishes as Array<Record<string, unknown>> : [];
  const shops: MarketShop[] = [];
  for (const row of shopsRaw) {
    const id = asString(row?.id);
    const name = asString(row?.name);
    if (!id || !name) continue;
    shops.push({
      id,
      name,
      cat: asString(row?.cat),
      deliveryFeeMinor: yuanToMinor(row?.deliveryFee),
      minOrderMinor: yuanToMinor(row?.minOrder),
      monthlySales: Number.isFinite(Number(row?.monthlySales)) ? Number(row?.monthlySales) : 0,
    });
  }
  const items: MarketItem[] = [];
  for (const row of dishesRaw) {
    const id = asString(row?.id);
    const shopId = asString(row?.shopId);
    const name = asString(row?.name);
    const priceMinor = yuanToMinor(row?.price);
    if (!id || !shopId || !name || priceMinor <= 0) continue;
    items.push({ id, shopId, name, priceMinor });
  }
  return { shops, items };
}

/** 购物数据集（mall-shops.json + mall-goods.json）→ 归一化目录。 */
export function catalogFromMall(raw: {
  shops?: unknown;
  goods?: unknown;
} | null | undefined): MarketDataset {
  const shopsRaw = Array.isArray(raw?.shops) ? raw?.shops as Array<Record<string, unknown>> : [];
  const goodsRaw = Array.isArray(raw?.goods) ? raw?.goods as Array<Record<string, unknown>> : [];
  const shops: MarketShop[] = [];
  for (const row of shopsRaw) {
    const id = asString(row?.id);
    const name = asString(row?.name);
    if (!id || !name) continue;
    shops.push({
      id,
      name,
      cat: asString(row?.cat),
      // 电商目录没有配送费/起送价：0 = 不额外收，也不编一个。
      deliveryFeeMinor: yuanToMinor(row?.deliveryFee),
      minOrderMinor: 0,
      monthlySales: Number.isFinite(Number(row?.monthlySales)) ? Number(row?.monthlySales) : 0,
    });
  }
  const items: MarketItem[] = [];
  for (const row of goodsRaw) {
    const id = asString(row?.id);
    const shopId = asString(row?.shopId);
    const name = asString(row?.name);
    const priceMinor = yuanToMinor(row?.price);
    if (!id || !shopId || !name || priceMinor <= 0) continue;
    items.push({ id, shopId, name, priceMinor });
  }
  return { shops, items };
}

export function buildMarketCatalog(input: {
  takeout?: { shops?: unknown; dishes?: unknown } | null;
  mall?: { shops?: unknown; goods?: unknown } | null;
}): MarketCatalog {
  return {
    takeout: catalogFromTakeout(input.takeout),
    mall: catalogFromMall(input.mall),
  };
}

export function datasetForKind(catalog: MarketCatalog, kind: MarketProposalKind): MarketDataset {
  return kind === 'takeout.order' ? catalog.takeout : catalog.mall;
}

/** 订单总额（分）= Σ 单价×数量 + 配送费；形状不对返回 null（不猜 0）。 */
export function orderTotalMinorFromArgs(args: unknown): number | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const row = args as Record<string, unknown>;
  if (!Array.isArray(row.items) || row.items.length === 0) return null;
  let subtotal = 0;
  for (const item of row.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const unit = (item as Record<string, unknown>).unitPriceMinor;
    const qty = (item as Record<string, unknown>).qty;
    if (typeof unit !== 'number' || !Number.isInteger(unit) || unit < 0) return null;
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty <= 0) return null;
    const line = unit * qty;
    if (!Number.isSafeInteger(line)) return null;
    subtotal += line;
    if (!Number.isSafeInteger(subtotal)) return null;
  }
  const fee = row.deliveryFeeMinor === undefined ? 0 : row.deliveryFeeMinor;
  if (typeof fee !== 'number' || !Number.isInteger(fee) || fee < 0) return null;
  const total = subtotal + fee;
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

export interface MarketBudget {
  /** 单笔上限（边界 virtualOrderMaxMinor）。 */
  orderMaxMinor: number;
  /** 今日剩余可花（边界 virtualSpendPerDayMinor − 已用/在途）。 */
  spendRemainingMinor: number;
  /** 角色默认卡余额（分）；0 = 没卡/没钱，不生成候选。 */
  walletBalanceMinor: number;
}

export interface BuildMarketProposalInput {
  catalog: MarketCatalog;
  kind: MarketProposalKind;
  charId: string;
  /** 角色真实收货地址（角色档案里的 delivery.addressText）；空 = 不生成。 */
  addressText: string;
  /** 付款的角色卡 id（模拟钱包；执行事务里再核归属与余额）。 */
  cardId: string;
  nowMs: number;
  timezone: string;
  budget: MarketBudget;
  /** 安装级种子（与引擎同一口径）；缺省用 charId。 */
  seed?: string;
}

const MAX_ITEMS_PER_ORDER = 2;

/**
 * 从真实目录里确定性选一单：同 (角色, 日期, 目录, 预算) 永远得到同一结果。
 *
 * 选法（简单、可解释，不做「看起来很强」的随机）：
 *   1. 只保留类目已审核、且至少有一件商品买得起的店；
 *   2. 店按（月销 + 评分缺失不影响）降序、同分按 id 升序，再按种子在**同档次**里轮转；
 *   3. 先拿最便宜的 1 件；不够起送价就再加最便宜的一件（最多 2 件）；
 *   4. 总额（含配送费）必须 ≤ min(单笔上限, 今日剩余额度, 卡余额)，否则不生成；
 *   5. 价格全部取自目录，**不做任何折扣/加价/四舍五入以外的改写**。
 */
export function buildMarketProposal(input: BuildMarketProposalInput): ClientProposalInput | null {
  const { catalog, kind, charId, nowMs, timezone, budget } = input;
  const addressText = asString(input.addressText);
  const cardId = asString(input.cardId);
  if (!addressText || addressText.length > 200) return null;
  if (!cardId || cardId.length > 64) return null;
  if (!isMarketProposalKind(kind)) return null;
  const dataset = datasetForKind(catalog, kind);
  if (!dataset.shops.length || !dataset.items.length) return null;

  const cap = Math.min(
    Math.max(0, Math.trunc(budget.orderMaxMinor)),
    Math.max(0, Math.trunc(budget.spendRemainingMinor)),
    Math.max(0, Math.trunc(budget.walletBalanceMinor)),
  );
  if (cap <= 0) return null;

  const itemsByShop = new Map<string, MarketItem[]>();
  for (const item of dataset.items) {
    const list = itemsByShop.get(item.shopId);
    if (list) list.push(item);
    else itemsByShop.set(item.shopId, [item]);
  }
  for (const list of itemsByShop.values()) {
    list.sort((a, b) => (a.priceMinor === b.priceMinor ? (a.id < b.id ? -1 : 1) : a.priceMinor - b.priceMinor));
  }

  const eligible = dataset.shops
    .filter((shop) => approvedCategoryOf(kind, shop.cat) !== null)
    .filter((shop) => {
      const items = itemsByShop.get(shop.id) ?? [];
      const cheapest = items[0];
      return !!cheapest && cheapest.priceMinor + shop.deliveryFeeMinor <= cap;
    })
    .sort((a, b) => (b.monthlySales === a.monthlySales ? (a.id < b.id ? -1 : 1) : b.monthlySales - a.monthlySales));
  if (!eligible.length) return null;

  const dateKey = localDateKey(nowMs, timezone);
  const rng = createRng('market-proposal', input.seed ?? charId, charId, kind, dateKey);
  // 只在前 8 家店里轮转：确定性、又不至于每天都点同一家；选不出合规一单就试下一家。
  const head = eligible.slice(0, 8);
  const startIndex = rng.int(head.length);

  for (let offset = 0; offset < head.length; offset += 1) {
    const shop = head[(startIndex + offset) % head.length];
    const menu = itemsByShop.get(shop.id) ?? [];
    const picked: MarketItem[] = [];
    let subtotal = 0;
    for (const item of menu) {
      if (picked.length >= MAX_ITEMS_PER_ORDER) break;
      const total = subtotal + item.priceMinor + shop.deliveryFeeMinor;
      if (total > cap) continue;
      if (picked.length === 0) {
        picked.push(item);
        subtotal += item.priceMinor;
        continue;
      }
      const belowMinOrder = subtotal + shop.deliveryFeeMinor < shop.minOrderMinor;
      if (!belowMinOrder && rng.next() >= 0.35) continue;
      picked.push(item);
      subtotal += item.priceMinor;
    }
    if (picked.length === 0) continue;
    const totalMinor = subtotal + shop.deliveryFeeMinor;
    if (totalMinor > cap || totalMinor < shop.minOrderMinor) continue;
    const category = approvedCategoryOf(kind, shop.cat);
    if (!category) continue;

    const fingerprint = hashString(
      `${shop.id}|${picked.map((item) => `${item.id}:${item.priceMinor}`).join(',')}|${totalMinor}`,
    );
    const orderId = `ord_${hashString(`${charId}|${kind}|${dateKey}|${fingerprint}`).slice(0, 20)}`;
    const args: Record<string, unknown> = {
      shopId: shop.id,
      shopName: shop.name,
      shopCat: shop.cat,
      orderId,
      cardId,
      items: picked.map((item) => ({
        dishId: item.id,
        name: item.name,
        unitPriceMinor: item.priceMinor,
        qty: 1,
      })),
      addressText,
      category,
      deliveryFeeMinor: shop.deliveryFeeMinor,
    };
    const semanticPurpose = kind === 'takeout.order' ? 'meal_order' : 'daily_errand';
    return {
      proposalId: `mp_${hashString(`${charId}|${kind}|${dateKey}|${fingerprint}`).slice(0, 20)}`,
      kind,
      semanticPurpose,
      contentFingerprint: fingerprint,
      args,
    };
  }
  return null;
}

/** 候选失效时刻（服务端决定以它为准，这里只给同一口径的默认值）。 */
export function proposalExpiry(nowMs: number): number {
  return nowMs + CLIENT_PROPOSAL_TTL_MS;
}
