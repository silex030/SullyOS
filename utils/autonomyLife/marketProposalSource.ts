/**
 * 设备侧「真实目录候选」来源：把目录 + 角色地址 + 模拟钱包合成 `/proposals` 上报。
 *
 * 为什么在设备侧：真实收货地址在角色档案里、真钱在 `bank_data.main_state` 的
 * 角色卡上、目录是 App 的静态资源——这三样 worker 都没有。让它编价格就是伪造消费，
 * 所以这里只做「从真实数据里选，然后把选好的参数上报」，一条也不额外创造。
 *
 * 安全与时序：
 *   - 只在边界开启、且该 kind 在 allowedKinds 里时才上报（服务端还会再判一次）；
 *   - 额度口径来自服务端：单笔上限 `virtualOrderMaxMinor`、今日剩余 `virtual_spend`
 *     的 limit−used−reserved；余额来自角色默认卡；
 *   - 同一角色默认 10 分钟最多上报一次（这是「设备多久看一眼」，不是给角色设频率）；
 *   - 上报失败静默（下一轮自然重试），绝不本地造订单或回执。
 */

import type { ClientProposalInput, MarketProposalKind } from '../../contracts/autonomyLife';
import { DB } from '../db';
import { loadMallData, loadShoppingData } from '../shoppingData';
import type { AutonomyLifeApi } from './api';
import { buildMarketCatalog, buildMarketProposal, type MarketBudget, type MarketCatalog } from './marketCatalog';

export const MARKET_PROPOSAL_MIN_INTERVAL_MS = 10 * 60_000;

export interface CharacterMarketInput {
  addressText: string;
  walletBalanceMinor: number;
  budget: MarketBudget;
  allowedKinds: readonly string[];
}

export interface MarketProposalDeps {
  api: AutonomyLifeApi;
  now?: () => number;
  /** 测试/联调注入：目录、角色地址、钱包、额度。缺省读真实 App 数据与 API。 */
  loadCatalog?: () => Promise<MarketCatalog>;
  readCharacter?: (charId: string) => Promise<{ addressText: string } | null>;
  readWallet?: (charId: string) => Promise<{ balanceMinor: number; cardId: string } | null>;
  readBudget?: (charId: string) => Promise<{ allowedKinds: string[]; orderMaxMinor: number; spendRemainingMinor: number; timezone: string } | null>;
  minIntervalMs?: number;
}

const defaultLoadCatalog = async (): Promise<MarketCatalog> => {
  const [takeout, mall] = await Promise.all([
    loadShoppingData().catch(() => null),
    loadMallData().catch(() => null),
  ]);
  return buildMarketCatalog({ takeout, mall });
};

const defaultReadCharacter = async (charId: string): Promise<{ addressText: string } | null> => {
  const characters = await DB.getAllCharacters().catch(() => []);
  const found = characters.find((character) => character?.id === charId) as unknown as {
    delivery?: { addressText?: unknown };
  } | undefined;
  const addressText = typeof found?.delivery?.addressText === 'string' ? found.delivery.addressText.trim() : '';
  return addressText ? { addressText } : null;
};

const defaultReadWallet = async (charId: string): Promise<{ balanceMinor: number; cardId: string } | null> => {
  const bank = await DB.getBankState().catch(() => null);
  const cards = (bank?.cards ?? []) as Array<{ id: string; balance: number; owner?: string; ownerId?: string; isDefault?: boolean }>;
  const mine = cards.filter((card) => card.owner === 'char' && card.ownerId === charId);
  const card = mine.find((item) => item.isDefault) ?? mine[0];
  if (!card) return null;
  const balance = Number(card.balance);
  if (!Number.isFinite(balance) || balance <= 0) return { balanceMinor: 0, cardId: card.id };
  return { balanceMinor: Math.round(balance * 100), cardId: card.id };
};

const defaultReadBudget = async (
  api: AutonomyLifeApi,
  charId: string,
): Promise<{ allowedKinds: string[]; orderMaxMinor: number; spendRemainingMinor: number; timezone: string } | null> => {
  const [boundary, life] = await Promise.all([
    api.readBoundaries(charId).catch(() => null),
    api.readLife(charId).catch(() => null),
  ]);
  if (!boundary?.ok || !life?.ok) return null;
  const effective = boundary.data.effective;
  const spend = life.data.state.budget.find((row) => row.dimension === 'virtual_spend');
  const remaining = spend ? Math.max(0, spend.limit - spend.used - spend.reserved) : 0;
  return {
    allowedKinds: [...effective.allowedKinds],
    orderMaxMinor: effective.limits.virtualOrderMaxMinor ?? 0,
    spendRemainingMinor: remaining,
    timezone: effective.timezone || 'UTC',
  };
};

/**
 * 为一个角色从真实目录里选候选（纯计算 + 注入的数据源）。
 * 返回 0~2 条（外卖 / 购物各一条），不会因为「没有」而报错。
 */
export async function collectCharacterMarketProposals(input: {
  charId: string;
  cardId: string;
  nowMs: number;
  timezone: string;
  market: CharacterMarketInput;
  catalog: MarketCatalog;
  seed?: string;
}): Promise<ClientProposalInput[]> {
  const out: ClientProposalInput[] = [];
  const kinds: MarketProposalKind[] = ['takeout.order', 'shopping.order'];
  for (const kind of kinds) {
    if (!input.market.allowedKinds.includes(kind)) continue;
    const proposal = buildMarketProposal({
      catalog: input.catalog,
      kind,
      charId: input.charId,
      addressText: input.market.addressText,
      cardId: input.cardId,
      nowMs: input.nowMs,
      timezone: input.timezone,
      budget: input.market.budget,
      seed: input.seed,
    });
    if (proposal) out.push(proposal);
  }
  return out;
}

export interface MarketProposalSubmitResult {
  charId: string;
  status: 'submitted' | 'skipped' | 'failed';
  accepted?: number;
  reason?: string;
}

/**
 * 跑一轮「为每个角色上报真实目录候选」。
 * 节流按角色记在进程内（页面生命周期）；失败不重试到爆，下一轮自然再来。
 */
export async function submitMarketProposals(
  charIds: readonly string[],
  deps: MarketProposalDeps,
): Promise<MarketProposalSubmitResult[]> {
  const now = deps.now ?? (() => Date.now());
  const minInterval = Math.max(60_000, deps.minIntervalMs ?? MARKET_PROPOSAL_MIN_INTERVAL_MS);
  const loadCatalog = deps.loadCatalog ?? defaultLoadCatalog;
  const readCharacter = deps.readCharacter ?? defaultReadCharacter;
  const readWallet = deps.readWallet ?? defaultReadWallet;
  const readBudget = deps.readBudget ?? ((charId: string) => defaultReadBudget(deps.api, charId));

  const results: MarketProposalSubmitResult[] = [];
  const catalog = await loadCatalog().catch(() => null);
  if (!catalog) return charIds.map((charId) => ({ charId, status: 'skipped', reason: 'catalog_unavailable' }));

  for (const charId of charIds) {
    if (!charId) continue;
    const nowMs = now();
    const last = lastSubmittedAt.get(charId) ?? 0;
    if (nowMs - last < minInterval) {
      results.push({ charId, status: 'skipped', reason: 'throttled' });
      continue;
    }
    const [character, wallet, budget] = await Promise.all([
      readCharacter(charId).catch(() => null),
      readWallet(charId).catch(() => null),
      readBudget(charId).catch(() => null),
    ]);
    if (!character) {
      results.push({ charId, status: 'skipped', reason: 'address_missing' });
      continue;
    }
    if (!budget) {
      results.push({ charId, status: 'skipped', reason: 'budget_unavailable' });
      continue;
    }
    if (!wallet || wallet.balanceMinor <= 0) {
      results.push({ charId, status: 'skipped', reason: 'wallet_empty' });
      continue;
    }
    const proposals = await collectCharacterMarketProposals({
      charId,
      nowMs,
      timezone: budget.timezone,
      cardId: wallet.cardId,
      market: {
        addressText: character.addressText,
        walletBalanceMinor: wallet.balanceMinor,
        budget: { orderMaxMinor: budget.orderMaxMinor, spendRemainingMinor: budget.spendRemainingMinor, walletBalanceMinor: wallet.balanceMinor },
        allowedKinds: budget.allowedKinds,
      },
      catalog,
    });
    if (proposals.length === 0) {
      results.push({ charId, status: 'skipped', reason: 'no_catalog_candidate' });
      continue;
    }
    const res = await deps.api.submitProposals({ charId, proposals }).catch(() => null);
    if (!res?.ok) {
      results.push({ charId, status: 'failed', reason: res?.code ?? 'network' });
      continue;
    }
    lastSubmittedAt.set(charId, nowMs);
    results.push({ charId, status: 'submitted', accepted: res.data.accepted });
  }
  return results;
}

const lastSubmittedAt = new Map<string, number>();

/** 测试用：清掉节流记忆。 */
export function resetMarketProposalThrottleForTesting(): void {
  lastSubmittedAt.clear();
}
