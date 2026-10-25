/**
 * 生产入口回归（本卡 P1 整改项 1/2/3 的验收）：
 *
 * 全部从 **handleAutonomyLifeScheduled**（cron 唯一入口）或 **HTTP /proposals**（设备唯一
 * 上报入口）进，不注入预设 profile、不直接 seed 目标动作：
 *   1. 同角色/同种子/同时间的早鸟 vs 夜猫 → 不同睡眠窗与不同下次机会；人设改了 profile 落库更新；
 *   2. 设备上报的真实目录候选 → 正常 tick 排出外卖单（价格来自目录、消费额度核销、候选回收）；
 *   3. 配置 + 授权 + 可达都成立 → 正常 tick 排出 external.read；任一不成立 → 排不出来。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSqliteD1, openTestSqlite, type TestSqlite } from '../test/d1-sqlite';
import { normalizeBoundary } from '../../../../utils/autonomyLife/boundary';
import { buildMarketCatalog, buildMarketProposal } from '../../../../utils/autonomyLife/marketCatalog';
import { createD1LifeStore, ensureAutonomyLifeSchema, resetAutonomyLifeSchemaCacheForTesting, type LifeDb } from './store';
import { handleAutonomyLifeRequest, resolveOwnerFromSharedToken } from './routes';
import { handleAutonomyLifeScheduled, resolveProbes } from './tick';
import { createAutonomyLifeRuntime } from './runtime';
import { listClientProposals } from './proposals';
import { isAsleep, resolvePhase } from '../../../../utils/autonomyLife/rhythm';
import { createReachabilityProbe } from './capabilityProbes';

const NOW = Date.UTC(2026, 9, 23, 17, 0, 0); // 2026-10-24 01:00 +08:00
const NOON = Date.UTC(2026, 9, 24, 4, 0, 0); // 2026-10-24 12:00 +08:00
const USER = 'user-prod';
const CHAR = 'char-prod';
const TOKEN = 'shared-token';
const TZ = 'Asia/Shanghai';

let sql: TestSqlite;
let db: LifeDb;

beforeEach(async () => {
  sql = openTestSqlite();
  db = createSqliteD1(sql) as unknown as LifeDb;
  resetAutonomyLifeSchemaCacheForTesting();
  await ensureAutonomyLifeSchema(db);
  await createD1LifeStore({ db, ownerId: USER, now: () => NOW }).getAccountPause(USER);
});

afterEach(() => {
  sql.close?.();
});

async function seedBoundary(changes: Record<string, unknown> = {}) {
  const boundary = normalizeBoundary(
    {
      enabled: true,
      globalPaused: false,
      timezone: TZ,
      allowedKinds: ['journal.write'],
      externalGrants: [],
      ...changes,
    },
    { scope: 'account', nowMs: NOW, revision: 1 },
  );
  await db
    .prepare('INSERT OR REPLACE INTO autonomy_life_boundaries (owner_id, scope, char_id, revision, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(USER, 'account', '', boundary.revision, JSON.stringify(boundary), NOW)
    .run();
}

async function registerCharacter(charId = CHAR) {
  const row = normalizeBoundary({}, { scope: 'character', nowMs: NOW, revision: 0 });
  await db
    .prepare('INSERT OR IGNORE INTO autonomy_life_boundaries (owner_id, scope, char_id, revision, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(USER, 'character', charId, row.revision, JSON.stringify(row), NOW)
    .run();
}

async function bindDevice() {
  await createD1LifeStore({ db, ownerId: USER, now: () => NOW }).bindInstallation(USER, 'install-1', NOW);
}

/** 换一个**全新的空库**（用于「同样的输入 → 不同人设 → 不同结果」的对照）。 */
async function freshWorld(changes: Record<string, unknown> = {}) {
  try { sql.close(); } catch { /* 已关 */ }
  sql = openTestSqlite();
  db = createSqliteD1(sql) as unknown as LifeDb;
  resetAutonomyLifeSchemaCacheForTesting();
  await ensureAutonomyLifeSchema(db);
  await createD1LifeStore({ db, ownerId: USER, now: () => NOW }).getAccountPause(USER);
  await seedBoundary(changes);
  await registerCharacter();
  await bindDevice();
}

const pack = (overrides: { template?: string; scene?: unknown } = {}) => ({
  userId: USER,
  charId: CHAR,
  charName: '小夏',
  pack: {
    template: overrides.template ?? '你叫小夏，早睡早起，作息规律。',
    tzId: TZ,
    ...(overrides.scene !== undefined ? { scene: overrides.scene } : {}),
  },
}) as any;

const credentialsFor = async () => ({ baseUrl: 'https://llm.example/v1', apiKey: 'test-key', model: 'test-model' });

/** 可控模型响应：journal 候选（证明模型链路仍然是真调用）。 */
const modelReturning = (candidates: unknown[]) => async () => new Response(
  JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates }) } }], usage: { total_tokens: 100 } }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);

/** 可控模型失败：500（真实模型端口会返回 null）。 */
const modelFailing = async () => new Response('boom', { status: 500 });

const characterLifeRow = async (charId = CHAR) => {
  const row = await db
    .prepare('SELECT payload FROM autonomy_life_characters WHERE owner_id = ? AND char_id = ?')
    .bind(USER, charId)
    .first();
  if (!row?.payload) return null;
  return JSON.parse(String(row.payload)) as { profile: any; revision: number; scheduleConfidence: string; nextOpportunityAt: number | null };
};

const actionsOf = async (charId = CHAR) => {
  const result = await db
    .prepare('SELECT payload FROM autonomy_life_actions WHERE owner_id = ? AND char_id = ? ORDER BY created_at ASC')
    .bind(USER, charId)
    .all();
  return (result?.results ?? []).map((row: any) => JSON.parse(String(row.payload)));
};

const call = (path: string, init: RequestInit & { token?: string; user?: string } = {}) => {
  const { token = TOKEN, user = USER, ...rest } = init;
  const headers = new Headers(rest.headers ?? {});
  if (token) headers.set('X-Client-Token', token);
  if (user) headers.set('X-User-Id', user);
  if (rest.body) headers.set('Content-Type', 'application/json');
  const request = new Request(`https://worker.example${path}`, { ...rest, headers });
  const env = { DB: db, AMSG_SERVER_TOKEN: TOKEN } as never;
  return handleAutonomyLifeRequest(request, env, {
    now: () => NOW,
    resolveOwner: (req) => resolveOwnerFromSharedToken(req, env),
    respond: (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
    hasModelCredentials: async () => true,
    timezoneFor: async () => TZ,
    requestId: () => 'req-prod',
  });
};

// ── 合法目录夹具（形状与 public/shopping/*.json 一致；价格全部来自夹具） ─────────────
const catalog = buildMarketCatalog({
  takeout: {
    shops: [
      { id: 'shop_a', name: '巷口面馆', cat: '美食外卖', deliveryFee: 2, minOrder: 15, monthlySales: 900 },
      { id: 'shop_b', name: '深夜烧烤', cat: '美食外卖', deliveryFee: 3, minOrder: 18, monthlySales: 100 },
    ],
    dishes: [
      { id: 'dish_a1', shopId: 'shop_a', name: '番茄鸡蛋面', price: 12.5, cat: '主食' },
      { id: 'dish_b1', shopId: 'shop_b', name: '烤串拼盘', price: 16, cat: '烧烤' },
    ],
  },
  mall: {
    shops: [{ id: 'mshop_a', name: '三联书店', cat: '图书文具', monthlySales: 500 }],
    goods: [{ id: 'g_a1', shopId: 'mshop_a', name: '笔记本', price: 19.9, cat: '文具' }],
  },
});

const proposalFor = () => buildMarketProposal({
  catalog,
  kind: 'takeout.order',
  charId: CHAR,
  cardId: 'card-e2e-1',
  addressText: '北京市朝阳区某小区 3 号楼',
  nowMs: NOW,
  timezone: TZ,
  budget: { orderMaxMinor: 5000, spendRemainingMinor: 20_000, walletBalanceMinor: 100_000 },
  seed: `seed_${USER}`,
})!;

describe('生产入口：真实人设/日程 → profile', () => {
  it('同角色/同种子/同时间：早鸟在睡、夜猫还醒着；睡眠窗与下次机会都不同', async () => {
    await freshWorld({ allowedKinds: ['journal.write'] });
    const early = await handleAutonomyLifeScheduled({
      db,
      packs: [pack({ template: '你叫小夏，早睡早起，作息规律。' })],
      nowMs: NOW,
      credentialsFor,
      fetch: modelReturning([{ kind: 'journal.write', semanticPurpose: 'daily_note', args: { title: '今天', body: '写完就睡。' } }]),
    });
    expect(early.outcomes[0]).toMatchObject({ status: 'ticked', tick: 'resting' });
    const earlyRow = await characterLifeRow();
    expect(earlyRow?.profile?.confidence).toBe('persona');
    expect(earlyRow?.profile?.sleepWindows[0]).toEqual({ start: '22:30', end: '06:30' });
    expect(earlyRow?.scheduleConfidence).toBe('persona');
    expect(await actionsOf()).toEqual([]);

    // 同角色/同种子（安装种子按 owner 派生）/同时间，只换了人设。
    await freshWorld({ allowedKinds: ['journal.write'] });
    const night = await handleAutonomyLifeScheduled({
      db,
      packs: [pack({ template: '你叫小夏，夜猫子，经常熬夜到凌晨。' })],
      nowMs: NOW,
      credentialsFor,
      fetch: modelReturning([{ kind: 'journal.write', semanticPurpose: 'daily_note', args: { title: '凌晨', body: '夜里更清醒。' } }]),
    });
    expect(night.outcomes[0]).toMatchObject({ status: 'ticked', tick: 'scheduled' });
    const nightRow = await characterLifeRow();
    expect(nightRow?.profile?.sleepWindows[0]).toEqual({ start: '01:30', end: '09:30' });
    expect(nightRow?.profile?.sleepWindows[0]).not.toEqual(earlyRow?.profile?.sleepWindows[0]);

    // 夜猫在 01:00 是醒着的：真的排出了动作（而不是也在睡）。
    const actions = await actionsOf();
    expect(actions.length).toBe(1);
    expect(actions[0].kind).toBe('journal.write');
    expect(nightRow?.nextOpportunityAt).not.toBe(earlyRow?.nextOpportunityAt);
  });

  it('真实日程也参与：睡觉时段进睡眠窗；换日程后 profile 落库更新、未到期也会重建', async () => {
    await seedBoundary({ allowedKinds: ['journal.write'] });
    await registerCharacter();
    await bindDevice();
    const scene = (dateKey: string, sleepStart: string) => ({
      charId: CHAR,
      dateKey,
      schedule: { slots: [{ startTime: sleepStart, activity: '睡觉' }, { startTime: '09:00', activity: '上班' }] },
      songPool: [],
    });

    await handleAutonomyLifeScheduled({
      db,
      packs: [pack({ template: '你叫小夏。', scene: scene('2026-10-24', '23:30') })],
      nowMs: NOON,
      credentialsFor,
      fetch: modelReturning([{ kind: 'journal.write', semanticPurpose: 'daily_note', args: { title: '今天', body: '午饭前。' } }]),
    });
    const first = await characterLifeRow();
    expect(first?.profile?.sleepWindows[0]).toEqual({ start: '23:30', end: '09:00' });

    await handleAutonomyLifeScheduled({
      db,
      packs: [pack({ template: '你叫小夏。', scene: scene('2026-10-24', '01:30') })],
      nowMs: NOON + 60_000,
      credentialsFor,
      fetch: modelReturning([{ kind: 'journal.write', semanticPurpose: 'daily_note', args: { title: '今天', body: '午饭前。' } }]),
    });
    const second = await characterLifeRow();
    expect(second?.profile?.sleepWindows[0]).toEqual({ start: '01:30', end: '09:00' });
    expect(second?.profile?.summaryHash).not.toBe(first?.profile?.summaryHash);
    expect(second!.revision).toBeGreaterThan(first!.revision);

    // 跨天日程不采用（dateKey 不是今天）：日程段被丢掉，profile 回到人设词表结果。
    await handleAutonomyLifeScheduled({
      db,
      packs: [pack({ template: '你叫小夏。', scene: scene('2026-10-23', '23:30') })],
      nowMs: NOON + 120_000,
      credentialsFor,
      fetch: modelReturning([{ kind: 'journal.write', semanticPurpose: 'daily_note', args: { title: '今天', body: '午饭前。' } }]),
    });
    const third = await characterLifeRow();
    expect(third?.profile?.summaryHash).not.toBe(second?.profile?.summaryHash);
  });

  it('日程睡眠窗三类：只有工作/起床、午休+夜睡、跨午夜 —— 都不误判白天', async () => {
    const runSchedule = async (slots: unknown, nowMs: number, template = '你叫小夏。') => {
      await handleAutonomyLifeScheduled({
        db,
        packs: [pack({ template, scene: { charId: CHAR, dateKey: '2026-10-24', schedule: { slots }, songPool: [] } })],
        nowMs,
        credentialsFor,
        fetch: modelReturning([{ kind: 'journal.write', semanticPurpose: 'daily_note', args: { title: '今天', body: '记录一下。' } }]),
      });
      const row = await characterLifeRow();
      return row!.profile;
    };

    // 1) 只有工作/起床：不能被当成 09:00-18:00 睡眠；白天醒着、深夜在睡。
    await freshWorld({ allowedKinds: ['journal.write'] });
    const onlyWork = await runSchedule([
      { startTime: '07:00', activity: '起床洗漱' },
      { startTime: '09:00', activity: '上班' },
      { startTime: '18:00', activity: '下班' },
    ], NOON);
    expect(onlyWork.sleepWindows[0]).toEqual({ start: '23:00', end: '08:00' });
    expect(isAsleep(onlyWork, NOON)).toBe(false);
    expect(resolvePhase(onlyWork, NOON).phase).not.toBe('resting');
    expect(isAsleep(onlyWork, NOW)).toBe(true);

    // 2) 午间休息 + 夜间睡觉：取夜间那段（23:30-07:00），午休不抢整夜。
    await freshWorld({ allowedKinds: ['journal.write'] });
    const napAndNight = await runSchedule([
      { startTime: '07:00', activity: '起床' },
      { startTime: '09:00', activity: '上班' },
      { startTime: '12:00', activity: '午休' },
      { startTime: '18:00', activity: '下班' },
      { startTime: '23:30', activity: '睡觉' },
    ], NOON);
    expect(napAndNight.sleepWindows[0]).toEqual({ start: '23:30', end: '07:00' });
    expect(isAsleep(napAndNight, NOON)).toBe(false);
    expect(isAsleep(napAndNight, NOW)).toBe(true);
    // 人设说「早睡早起」也不能覆盖日程里明确的睡眠窗（结构化优先）。
    const precedence = await runSchedule([
      { startTime: '07:00', activity: '起床' },
      { startTime: '23:30', activity: '睡觉' },
    ], NOON, '你叫小夏，早睡早起，作息规律。');
    expect(precedence.sleepWindows[0]).toEqual({ start: '23:30', end: '07:00' });

    // 3) 跨午夜：22:00 睡觉 → 次日 07:00 起床。
    await freshWorld({ allowedKinds: ['journal.write'] });
    const crossMidnight = await runSchedule([
      { startTime: '07:00', activity: '起床' },
      { startTime: '09:00', activity: '上班' },
      { startTime: '22:00', activity: '睡觉' },
    ], NOON);
    expect(crossMidnight.sleepWindows[0]).toEqual({ start: '22:00', end: '07:00' });
    expect(isAsleep(crossMidnight, NOON)).toBe(false);
    expect(isAsleep(crossMidnight, Date.UTC(2026, 9, 23, 15, 0, 0))).toBe(true); // 23:00 当地
  });

  it('没有模板/日程 → 明确 fallback（不是编一个人设）', async () => {
    await seedBoundary({ allowedKinds: ['journal.write'] });
    await registerCharacter();
    await bindDevice();
    await handleAutonomyLifeScheduled({
      db,
      packs: [pack({ template: '' })],
      nowMs: NOON,
      credentialsFor,
      fetch: modelReturning([{ kind: 'journal.write', semanticPurpose: 'daily_note', args: { title: '今天', body: '空设定。' } }]),
    });
    const row = await characterLifeRow();
    expect(row?.profile?.confidence).toBe('fallback');
    expect(row?.profile?.personaHash).toBe(`${CHAR}:fallback`);
  });
});

describe('生产入口：设备上报的真实目录候选 → 自主点单', () => {
  it('POST /proposals 收下合法候选；模型失败时 tick 仍按目录价格排单并核销消费额度', async () => {
    await seedBoundary({ allowedKinds: ['takeout.order'] });
    await registerCharacter();
    await bindDevice();

    const proposal = proposalFor();
    expect(proposal).toBeTruthy();
    const submitted = await call('/autonomy-life/v1/proposals', {
      method: 'POST',
      body: JSON.stringify({ charId: CHAR, proposals: [proposal] }),
    });
    expect(submitted?.status).toBe(200);
    const submittedBody = await submitted!.json() as any;
    expect(submittedBody.accepted).toBe(1);
    expect(submittedBody.expiresAt).toBeGreaterThan(NOW);

    const stored = await listClientProposals({ db, ownerId: USER, charId: CHAR, nowMs: NOW });
    expect(stored.length).toBe(1);
    expect(stored[0].args).toEqual(proposal.args);

    // 模型 500：真实模型端口返回 null，但设备候选仍然排得上（真实价格不需要模型点头）。
    const tick = await handleAutonomyLifeScheduled({
      db,
      packs: [pack({ template: '你叫小夏，夜猫子，经常熬夜到凌晨。' })],
      nowMs: NOW,
      credentialsFor,
      fetch: modelFailing,
    });
    expect(tick.outcomes[0]).toMatchObject({ status: 'ticked', tick: 'scheduled' });

    const actions = await actionsOf();
    expect(actions.length).toBe(1);
    expect(actions[0].kind).toBe('takeout.order');
    expect(actions[0].args).toEqual(proposal.args);
    // 价格口径：目录价 + 配送费（与客户端/执行侧同一份算法）。
    const items = (proposal.args as any).items as Array<{ unitPriceMinor: number; qty: number }>;
    const expectedTotal = items.reduce((sum, item) => sum + item.unitPriceMinor * item.qty, 0) + 1300 - 1300
      + Number((proposal.args as any).deliveryFeeMinor ?? 0);
    const budget = await db
      .prepare('SELECT spend_minor, kind_counts FROM autonomy_life_budget WHERE owner_id = ? AND scope = ?')
      .bind(USER, CHAR)
      .first();
    expect(Number(budget?.spend_minor)).toBe(expectedTotal);
    expect(JSON.parse(String(budget?.kind_counts))['takeout.order']).toBe(1);

    // 候选已回收：同一份候选不会被排第二次。
    const remaining = await listClientProposals({ db, ownerId: USER, charId: CHAR, nowMs: NOW });
    expect(remaining).toEqual([]);
  });

  it('单笔超上限 / 类目不符 / kind 未开 / 暂停 → HTTP 直接拒（整包，不半收）', async () => {
    await seedBoundary({ allowedKinds: ['takeout.order'] });
    await registerCharacter();
    await bindDevice();
    const proposal = proposalFor();

    const overMax = { ...proposal, args: { ...proposal.args, deliveryFeeMinor: 100_000 } };
    const rejected = await call('/autonomy-life/v1/proposals', {
      method: 'POST',
      body: JSON.stringify({ charId: CHAR, proposals: [overMax] }),
    });
    expect(rejected?.status).toBe(422);
    expect((await rejected!.json() as any).error.message).toBe('order_over_max');

    const badCategory = { ...proposal, args: { ...proposal.args, category: '娱乐' } };
    const badCatRes = await call('/autonomy-life/v1/proposals', {
      method: 'POST',
      body: JSON.stringify({ charId: CHAR, proposals: [badCategory] }),
    });
    expect(badCatRes?.status).toBe(422);
    expect((await badCatRes!.json() as any).error.message).toBe('category_not_approved');

    // kind 未被边界允许 → 403，且不会落库。
    await seedBoundary({ allowedKinds: ['journal.write'] });
    const notAllowed = await call('/autonomy-life/v1/proposals', {
      method: 'POST',
      body: JSON.stringify({ charId: CHAR, proposals: [proposal] }),
    });
    expect(notAllowed?.status).toBe(403);
    expect((await listClientProposals({ db, ownerId: USER, charId: CHAR, nowMs: NOW }))).toEqual([]);

    // 账号暂停 → 409。
    await seedBoundary({ allowedKinds: ['takeout.order'], globalPaused: true });
    const paused = await call('/autonomy-life/v1/proposals', {
      method: 'POST',
      body: JSON.stringify({ charId: CHAR, proposals: [proposal] }),
    });
    expect(paused?.status).toBe(409);
  });

  it('别的角色/别人的 owner 读不到这份候选', async () => {
    await seedBoundary({ allowedKinds: ['takeout.order'] });
    await registerCharacter();
    await bindDevice();
    await call('/autonomy-life/v1/proposals', {
      method: 'POST',
      body: JSON.stringify({ charId: CHAR, proposals: [proposalFor()] }),
    });
    expect(await listClientProposals({ db, ownerId: USER, charId: 'char-other', nowMs: NOW })).toEqual([]);
    expect(await listClientProposals({ db, ownerId: 'user-other', charId: CHAR, nowMs: NOW })).toEqual([]);
  });
});

describe('生产入口：外部只读窗口受配置/授权/可达约束', () => {
  const grant = {
    provider: 'xhs' as const,
    scopes: ['read:search'],
    allowedHosts: ['example.com'],
    allowedMethods: ['GET'],
    allowedFieldKeys: ['query'],
    purpose: '只看公开笔记',
    expiresAt: NOW + 86_400_000,
    dailyQuota: 5,
  };

  it('三者成立 → 正常 tick 排出 external.read（查询词来自人设兴趣，模型失败也能排）', async () => {
    await seedBoundary({ allowedKinds: ['external.read'], externalGrants: [grant] });
    await registerCharacter();
    await bindDevice();
    const probed: string[] = [];
    const tick = await handleAutonomyLifeScheduled({
      db,
      packs: [pack({ template: '你叫小夏，喜欢天文，是个安静的人。' })],
      nowMs: NOON,
      credentialsFor,
      fetch: modelFailing,
      external: { xhsUrl: 'https://example.com/search', readHosts: ['example.com'] },
      reachability: async (url: string) => { probed.push(url); return true; },
    });
    expect(tick.outcomes[0]).toMatchObject({ status: 'ticked', tick: 'scheduled' });
    expect(probed).toEqual(['https://example.com/search']);

    const actions = await actionsOf();
    expect(actions.length).toBe(1);
    expect(actions[0].kind).toBe('external.read');
    expect((actions[0].args as any).query).toBe('天文');
  });

  it('端点没配 / 不可达 / 没授权 → 排不出来（不假装「为角色读过什么」）', async () => {
    const run = async (external: any, reachability: (url: string) => Promise<boolean>, boundaryChanges: Record<string, unknown> = { allowedKinds: ['external.read'], externalGrants: [grant] }) => {
      await seedBoundary(boundaryChanges);
      await registerCharacter();
      await bindDevice();
      resetAutonomyLifeSchemaCacheForTesting();
      await ensureAutonomyLifeSchema(db);
      await db.prepare('DELETE FROM autonomy_life_actions WHERE owner_id = ?').bind(USER).run();
      await db.prepare('DELETE FROM autonomy_life_characters WHERE owner_id = ?').bind(USER).run();
      await db.prepare('DELETE FROM autonomy_life_budget WHERE owner_id = ?').bind(USER).run();
      await db.prepare('DELETE FROM autonomy_life_budget_reservations WHERE owner_id = ?').bind(USER).run();
      return handleAutonomyLifeScheduled({
        db,
        packs: [pack({ template: '你叫小夏，喜欢天文，是个安静的人。' })],
        nowMs: NOON,
        credentialsFor,
        fetch: modelFailing,
        external,
        reachability,
      });
    };

    // 没配置端点
    const unconfigured = await run(null, async () => true);
    expect(unconfigured.outcomes[0]).toMatchObject({ status: 'ticked', tick: 'model_failed' });
    expect(await actionsOf()).toEqual([]);

    // 配置了但不可达
    const unreachable = await run({ xhsUrl: 'https://example.com/search', readHosts: ['example.com'] }, async () => false);
    expect(unreachable.outcomes[0]).toMatchObject({ status: 'ticked', tick: 'model_failed' });
    expect(await actionsOf()).toEqual([]);

    // 配置且可达、但用户没授权
    const unauthorized = await run(
      { xhsUrl: 'https://example.com/search', readHosts: ['example.com'] },
      async () => true,
      { allowedKinds: ['external.read'], externalGrants: [] },
    );
    expect(unauthorized.outcomes[0]).toMatchObject({ status: 'ticked', tick: 'model_failed' });
    expect(await actionsOf()).toEqual([]);
  });

  it('探测前先过主机/scope/暂停边界：不该探的场景一次网络请求都没有（真实调度入口 + spy fetch）', async () => {
    const grantOf = (overrides: Record<string, unknown> = {}) => ({ ...grant, ...overrides });
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    const tickWith = async (args: {
      external: { xhsUrl: string; readHosts: string[] };
      grants?: unknown[];
      allowedKinds?: string[];
      paused?: boolean;
      charId?: string;
      probe?: ReturnType<typeof createReachabilityProbe>;
    }) => {
      const charId = args.charId ?? CHAR;
      await seedBoundary({
        allowedKinds: args.allowedKinds ?? ['external.read'],
        externalGrants: (args.grants ?? [grant]) as never,
        globalPaused: args.paused === true,
      });
      await registerCharacter(charId);
      await bindDevice();
      resetAutonomyLifeSchemaCacheForTesting();
      await ensureAutonomyLifeSchema(db);
      const probe = args.probe ?? createReachabilityProbe({ fetch: fetchSpy as unknown as typeof fetch, now: () => NOW });
      return handleAutonomyLifeScheduled({
        db,
        packs: [{
          userId: USER,
          charId,
          charName: '小夏',
          pack: { template: '你叫小夏，喜欢天文，是个安静的人。', tzId: TZ },
        }] as never,
        nowMs: NOON,
        credentialsFor,
        fetch: modelFailing,
        external: args.external,
        reachability: probe,
      });
    };

    // 1) 运营白名单 = allowed.example，端点却指向 other.example → 不能探。
    const operatorHost = await tickWith({ external: { xhsUrl: 'https://other.example/read', readHosts: ['allowed.example'] }, charId: 'char-host-operator' });
    expect(operatorHost.outcomes[0]).toMatchObject({ status: 'ticked' });
    expect(fetchSpy).toHaveBeenCalledTimes(0);

    // 2) 运营白名单放行 other.example，但 grant 只授权 allowed.example → 不能探。
    const grantHost = await tickWith({
      external: { xhsUrl: 'https://other.example/read', readHosts: ['other.example'] },
      grants: [grantOf({ allowedHosts: ['allowed.example'] })],
      charId: 'char-host-grant',
    });
    expect(grantHost.outcomes[0]).toMatchObject({ status: 'ticked' });
    expect(fetchSpy).toHaveBeenCalledTimes(0);

    // 3) scope 不符（grant 只有 read:note）→ 不能探。
    const scope = await tickWith({
      external: { xhsUrl: 'https://allowed.example/read', readHosts: ['allowed.example'] },
      grants: [grantOf({ scopes: ['read:note'] })],
      charId: 'char-scope',
    });
    expect(scope.outcomes[0]).toMatchObject({ status: 'ticked' });
    expect(fetchSpy).toHaveBeenCalledTimes(0);

    // 4) 授权过期 → 不能探。
    const expired = await tickWith({
      external: { xhsUrl: 'https://allowed.example/read', readHosts: ['allowed.example'] },
      grants: [grantOf({ expiresAt: NOW })],
      charId: 'char-expired',
    });
    expect(expired.outcomes[0]).toMatchObject({ status: 'ticked' });
    expect(fetchSpy).toHaveBeenCalledTimes(0);

    // 5) 已撤权（没有 grant）→ 不能探。
    const revoked = await tickWith({
      external: { xhsUrl: 'https://allowed.example/read', readHosts: ['allowed.example'] },
      grants: [],
      charId: 'char-revoked',
    });
    expect(revoked.outcomes[0]).toMatchObject({ status: 'ticked' });
    expect(fetchSpy).toHaveBeenCalledTimes(0);

    // 6) 账号暂停 → 整跳跳过，更不会探。
    const paused = await tickWith({
      external: { xhsUrl: 'https://allowed.example/read', readHosts: ['allowed.example'] },
      paused: true,
      charId: 'char-paused',
    });
    expect(paused.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'account_disabled' });
    expect(fetchSpy).toHaveBeenCalledTimes(0);

    // 7) resolveProbes 显式 paused：即便调用方没先判，也不发请求。
    const probes = await resolveProbes({
      external: { xhsUrl: 'https://allowed.example/read', amapUrl: '', readHosts: ['allowed.example'] },
      grants: [grantOf()] as never,
      allowedKinds: ['external.read'],
      nowMs: NOW,
      deviceBound: true,
      paused: true,
      reachability: createReachabilityProbe({ fetch: fetchSpy as unknown as typeof fetch, now: () => NOW }),
    });
    expect(probes.externalRead).toMatchObject({ configured: true, reachable: false, reason: 'paused' });
    expect(fetchSpy).toHaveBeenCalledTimes(0);

    // 8) 全部成立：有界探测 —— 一次 tick 一次 GET；10 分钟 TTL 内再 tick 不重复出网。
    const allowedProbe = createReachabilityProbe({ fetch: fetchSpy as unknown as typeof fetch, now: () => NOW });
    const allowedGrant = grantOf({ allowedHosts: ['allowed.example'] });
    await tickWith({
      external: { xhsUrl: 'https://allowed.example/read', readHosts: ['allowed.example'] },
      grants: [allowedGrant],
      charId: 'char-allowed',
      probe: allowedProbe,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String((fetchSpy.mock.calls[0] as unknown as [string])[0])).toBe('https://allowed.example/read');
    await tickWith({
      external: { xhsUrl: 'https://allowed.example/read', readHosts: ['allowed.example'] },
      grants: [allowedGrant],
      charId: 'char-allowed',
      probe: allowedProbe,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('resolveProbes：没授权就不去探端点（不替用户敲没授权的门）', async () => {
    const probed: string[] = [];
    const probes = await resolveProbes({
      external: { xhsUrl: 'https://example.com/search', amapUrl: '', readHosts: ['example.com'] },
      grants: [],
      allowedKinds: ['external.read'],
      nowMs: NOW,
      deviceBound: true,
      reachability: async (url: string) => { probed.push(url); return true; },
    });
    expect(probes.externalRead).toMatchObject({ configured: true, reachable: false, reason: 'grant_missing' });
    expect(probed).toEqual([]);
  });
});
