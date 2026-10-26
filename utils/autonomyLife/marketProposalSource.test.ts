import { beforeEach, describe, expect, it } from 'vitest';

import {
  collectCharacterMarketProposals,
  resetMarketProposalThrottleForTesting,
  submitMarketProposals,
} from './marketProposalSource';
import { buildMarketCatalog, orderTotalMinorFromArgs, type MarketCatalog } from './marketCatalog';
import { createAutonomyLifeApi, type AutonomyLifeApi } from './api';

const NOW = Date.UTC(2026, 9, 24, 4, 0, 0);
const TZ = 'Asia/Shanghai';

/** 合法目录夹具（形状同 public/shopping/*.json；价格来自夹具自身）。 */
const catalog: MarketCatalog = buildMarketCatalog({
  takeout: {
    shops: [{ id: 'shop_a', name: '巷口面馆', cat: '美食外卖', deliveryFee: 2, minOrder: 12, monthlySales: 900 }],
    dishes: [{ id: 'dish_a1', shopId: 'shop_a', name: '番茄鸡蛋面', price: 12.5, cat: '主食' }],
  },
  mall: {
    shops: [{ id: 'mshop_a', name: '三联书店', cat: '图书文具', monthlySales: 500 }],
    goods: [{ id: 'g_a1', shopId: 'mshop_a', name: '笔记本', price: 19.9, cat: '文具' }],
  },
});

interface SubmitCall {
  charId: string;
  proposals: Array<{ proposalId: string; kind: string; args: Record<string, unknown> }>;
}

const fakeApi = (result: { ok: true; accepted: number } | { ok: false; code: string } = { ok: true, accepted: 1 }) => {
  const calls: SubmitCall[] = [];
  const api = {
    submitProposals: async (input: SubmitCall) => {
      calls.push(input);
      return result.ok
        ? { ok: true as const, data: { charId: input.charId, accepted: result.accepted, expiresAt: NOW + 7200_000 } }
        : { ok: false as const, code: result.code, status: 500 };
    },
  } as unknown as AutonomyLifeApi;
  return { api, calls };
};

const deps = (over: Record<string, unknown> = {}) => ({
  now: () => NOW,
  loadCatalog: async () => catalog,
  readCharacter: async () => ({ addressText: '北京市朝阳区某小区 3 号楼' }),
  readWallet: async () => ({ balanceMinor: 100_000, cardId: 'card-1' }),
  readBudget: async () => ({
    allowedKinds: ['takeout.order', 'shopping.order'],
    orderMaxMinor: 5000,
    spendRemainingMinor: 20_000,
    timezone: TZ,
  }),
  ...over,
});

beforeEach(() => resetMarketProposalThrottleForTesting());

describe('设备侧真实目录候选：来源与上报', () => {
  it('外卖 + 购物各一条，价格/店/商品全部取自目录，总额不超上限', async () => {
    const { api, calls } = fakeApi({ ok: true, accepted: 2 });
    const results = await submitMarketProposals(['char-1'], { api, ...deps() });
    expect(results[0]).toMatchObject({ charId: 'char-1', status: 'submitted', accepted: 2 });
    expect(calls.length).toBe(1);
    const kinds = calls[0].proposals.map((item) => item.kind).sort();
    expect(kinds).toEqual(['shopping.order', 'takeout.order']);
    for (const proposal of calls[0].proposals) {
      const total = orderTotalMinorFromArgs(proposal.args);
      expect(total).not.toBeNull();
      expect(total!).toBeLessThanOrEqual(5000);
      const items = (proposal.args as any).items as Array<{ unitPriceMinor: number }>;
      // 价格只能是目录里的整数分（1250 / 1990），不是随手编的。
      expect(items.every((item) => item.unitPriceMinor === 1250 || item.unitPriceMinor === 1990)).toBe(true);
    }
  });

  it('没有地址 / 钱包没钱 / 额度为 0 → 不上报（并给出原因）', async () => {
    const noAddress = fakeApi();
    const r1 = await submitMarketProposals(['char-1'], { api: noAddress.api, ...deps({ readCharacter: async () => null }) });
    expect(r1[0]).toMatchObject({ status: 'skipped', reason: 'address_missing' });
    expect(noAddress.calls).toEqual([]);

    resetMarketProposalThrottleForTesting();
    const emptyWallet = fakeApi();
    const r2 = await submitMarketProposals(['char-1'], { api: emptyWallet.api, ...deps({ readWallet: async () => ({ balanceMinor: 0, cardId: 'card-1' }) }) });
    expect(r2[0]).toMatchObject({ status: 'skipped', reason: 'wallet_empty' });

    resetMarketProposalThrottleForTesting();
    const noBudget = fakeApi();
    const r3 = await submitMarketProposals(['char-1'], {
      api: noBudget.api,
      ...deps({
        readBudget: async () => ({
          allowedKinds: ['takeout.order'], orderMaxMinor: 0, spendRemainingMinor: 0, timezone: TZ,
        }),
      }),
    });
    expect(r3[0]).toMatchObject({ status: 'skipped', reason: 'no_catalog_candidate' });
    expect(noBudget.calls).toEqual([]);
  });

  it('kind 不在边界白名单 → 不生成该 kind（设备不替用户扩权）', async () => {
    const proposals = await collectCharacterMarketProposals({
      charId: 'char-1',
      cardId: 'card-1',
      nowMs: NOW,
      timezone: TZ,
      catalog,
      market: {
        addressText: '北京市朝阳区某小区 3 号楼',
        walletBalanceMinor: 100_000,
        budget: { orderMaxMinor: 5000, spendRemainingMinor: 20_000, walletBalanceMinor: 100_000 },
        allowedKinds: ['shopping.order'],
      },
    });
    expect(proposals.length).toBe(1);
    expect(proposals[0].kind).toBe('shopping.order');
  });

  it('同一角色 10 分钟内只上报一次（「多久看一眼」不是给角色设的频率）', async () => {
    const { api, calls } = fakeApi({ ok: true, accepted: 2 });
    await submitMarketProposals(['char-1'], { api, ...deps() });
    const second = await submitMarketProposals(['char-1'], { api, ...deps() });
    expect(second[0]).toMatchObject({ status: 'skipped', reason: 'throttled' });
    expect(calls.length).toBe(1);

    const later = await submitMarketProposals(['char-1'], { api, ...deps({ now: () => NOW + 11 * 60_000 }) });
    expect(later[0].status).toBe('submitted');
    expect(calls.length).toBe(2);
  });

  it('上报失败如实报 failed，不本地造假候选', async () => {
    const { api } = fakeApi({ ok: false, code: 'NETWORK' });
    const results = await submitMarketProposals(['char-1'], { api, ...deps() });
    expect(results[0]).toMatchObject({ status: 'failed', reason: 'NETWORK' });
  });
});

describe('api.submitProposals：真实 HTTP 形状校验', () => {
  it('POST /autonomy-life/v1/proposals，带 charId + 候选；回包形状不对 → MALFORMED_RESPONSE', async () => {
    const seen: Array<{ url: string; body: any }> = [];
    const api = createAutonomyLifeApi({
      resolveEndpoint: () => ({ baseUrl: 'https://worker.example', headers: { 'X-Client-Token': 't' } }),
      transport: async (url, init) => {
        seen.push({ url, body: init.body });
        return new Response(JSON.stringify({ schemaVersion: 1, requestId: 'req-1', serverTime: NOW, accepted: 1, expiresAt: NOW + 7200_000 }), { status: 200 });
      },
      now: () => NOW,
    });
    const res = await api.submitProposals({
      charId: 'char-1',
      proposals: [{ proposalId: 'mp_abc12345', kind: 'takeout.order', semanticPurpose: 'meal_order', args: { a: 1 } }],
    });
    expect(res.ok).toBe(true);
    expect(seen[0].url).toBe('https://worker.example/autonomy-life/v1/proposals');
    expect(JSON.parse(String(seen[0].body))).toMatchObject({ charId: 'char-1' });

    const malformed = createAutonomyLifeApi({
      resolveEndpoint: () => ({ baseUrl: 'https://worker.example', headers: {} }),
      transport: async () => new Response(JSON.stringify({ schemaVersion: 1, requestId: 'req-2', serverTime: NOW, accepted: 'many' }), { status: 200 }),
      now: () => NOW,
    });
    const bad = await malformed.submitProposals({
      charId: 'char-1',
      proposals: [{ proposalId: 'mp_abc12345', kind: 'takeout.order', semanticPurpose: 'meal_order', args: { a: 1 } }],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('MALFORMED_RESPONSE');
  });
});
