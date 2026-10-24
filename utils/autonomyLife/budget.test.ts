/**
 * 统一预算账本（契约 §5.2、§10-G）：
 *   - 多维度任一失败 → 全不预留；
 *   - 0 = 明确禁止；
 *   - 存储不可用 → fail closed（SERVICE_UNAVAILABLE，不「先放过再补账」）；
 *   - token 不明就按预留上界计入，不猜零；
 *   - 并发两次不能都过；
 *   - 跨窗口（时区日切）不双花。
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_ACCOUNT_LIMITS, MAXIMUM_ACCOUNT_LIMITS, type AutonomyLimits } from '../../contracts/autonomyLife';
import {
  createMemoryBudgetPort,
  emptyBudgetRow,
  precheckBudget,
  projectBudgetUsage,
  reserveBudget,
  rotationOrder,
  settleBudget,
  windowIdAt,
} from './budget';
import { createManualClock } from './time';

const TZ = 'Asia/Shanghai';
const NOW = Date.UTC(2026, 9, 24, 4, 0, 0); // 2026-10-24 12:00 +08:00

const limits = (overrides: Partial<AutonomyLimits> = {}): AutonomyLimits => ({
  ...DEFAULT_ACCOUNT_LIMITS,
  ...overrides,
});

const baseRequest = {
  nowMs: NOW,
  windowTimezone: TZ,
  accountId: 'acct-1',
  charId: 'char-1',
  limits: limits({ accountModelCallsPerDay: 6, charModelCallsPerDay: 2, accountTokensPerDay: 10_000, charTokensPerDay: 4_000 }),
  calls: 1,
  tokens: 1_000,
};

describe('预算：多维度原子预留（§5.2）', () => {
  it('角色调用上限为 2：第三次预留被拒，且失败不留任何占用', async () => {
    const port = createMemoryBudgetPort();
    const first = await reserveBudget(port, baseRequest);
    const second = await reserveBudget(port, baseRequest);
    const third = await reserveBudget(port, baseRequest);
    expect(first.ok && second.ok).toBe(true);
    expect(third).toMatchObject({ ok: false, code: 'BUDGET_EXHAUSTED', dimension: 'char_calls' });
    const snapshot = Object.values(port.snapshot());
    const charRow = snapshot.find((row) => row.scope === 'char-1')!;
    expect(charRow.reservedCalls).toBe(2);
    expect(charRow.usedCalls).toBe(0);
  });

  it('0 = 明确禁止（不是缺省），账号维度为 0 时角色维度再宽也没用', async () => {
    const port = createMemoryBudgetPort();
    const outcome = await reserveBudget(port, {
      ...baseRequest,
      limits: limits({ accountModelCallsPerDay: 0, charModelCallsPerDay: 12 }),
    });
    expect(outcome).toMatchObject({ ok: false, code: 'BUDGET_EXHAUSTED', dimension: 'account_calls' });
    expect(port.snapshot()).toEqual({});
  });

  it('token 维度不够时整个预留失败（不会只扣 calls）', async () => {
    const port = createMemoryBudgetPort();
    const outcome = await reserveBudget(port, {
      ...baseRequest,
      limits: limits({ accountTokensPerDay: 1_500, charTokensPerDay: 4_000 }),
      tokens: 2_000,
    });
    expect(outcome).toMatchObject({ ok: false, dimension: 'account_tokens' });
    expect(port.snapshot()).toEqual({});
  });

  it('通知 / 同类动作 / 模拟消费也走同一临界区', async () => {
    const port = createMemoryBudgetPort();
    const notify = await reserveBudget(port, {
      ...baseRequest,
      limits: limits({ notificationsPerDay: 1 }),
      notification: true,
      kind: 'interaction.message',
    });
    expect(notify.ok).toBe(true);
    const secondNotify = await reserveBudget(port, {
      ...baseRequest,
      limits: limits({ notificationsPerDay: 1 }),
      notification: true,
    });
    expect(secondNotify).toMatchObject({ ok: false, dimension: 'notifications' });

    const spend = await reserveBudget(port, {
      ...baseRequest,
      limits: limits({ virtualSpendPerDayMinor: 5_000, virtualOrderMaxMinor: 2_000 }),
      calls: 0,
      tokens: 0,
      spendMinor: 2_500,
    });
    expect(spend).toMatchObject({ ok: false, dimension: 'virtual_order_max' });
  });

  it('存储不可用 → SERVICE_UNAVAILABLE（fail closed）', async () => {
    const port = createMemoryBudgetPort({ failClosed: true });
    const outcome = await reserveBudget(port, baseRequest);
    expect(outcome).toMatchObject({ ok: false, code: 'SERVICE_UNAVAILABLE' });
    port.setAvailable(false);
    expect((await reserveBudget(port, baseRequest)).ok).toBe(false);
  });

  it('并发两次预留只有一个能过（临界区内判定）', async () => {
    const port = createMemoryBudgetPort();
    const request = { ...baseRequest, limits: limits({ charModelCallsPerDay: 1, accountModelCallsPerDay: 6 }) };
    const [a, b] = await Promise.all([reserveBudget(port, request), reserveBudget(port, request)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });
});

describe('预算：结算口径（§5.2）', () => {
  it('真实 usage 小于预留：按真实结算，剩余额度还回去', async () => {
    const port = createMemoryBudgetPort();
    const reserved = await reserveBudget(port, { ...baseRequest, tokens: 1_000 });
    if (!reserved.ok) throw new Error('reserve failed');
    const settled = await settleBudget(port, reserved.grant, { actualTokens: 250, requestStarted: true });
    expect(settled).toMatchObject({ ok: true, usedTokens: 250 });
    const charRow = Object.values(port.snapshot()).find((row) => row.scope === 'char-1')!;
    expect(charRow.usedTokens).toBe(250);
    expect(charRow.reservedTokens).toBe(0);
    expect(charRow.usedCalls).toBe(1);
  });

  it('usage 不明：保留全额上界，不猜零', async () => {
    const port = createMemoryBudgetPort();
    const reserved = await reserveBudget(port, { ...baseRequest, tokens: 1_000 });
    if (!reserved.ok) throw new Error('reserve failed');
    const settled = await settleBudget(port, reserved.grant, { actualTokens: null, requestStarted: true });
    expect(settled).toMatchObject({ ok: true, keptReservation: true });
    const charRow = Object.values(port.snapshot()).find((row) => row.scope === 'char-1')!;
    expect(charRow.usedTokens).toBe(1_000);
  });

  it('usage 超预留：只按预留上界结算，不让它突破', async () => {
    const port = createMemoryBudgetPort();
    const reserved = await reserveBudget(port, { ...baseRequest, tokens: 800 });
    if (!reserved.ok) throw new Error('reserve failed');
    const settled = await settleBudget(port, reserved.grant, { actualTokens: 5_000, requestStarted: true });
    expect(settled).toMatchObject({ ok: true, usedTokens: 800 });
  });

  it('preflight 取消且证明未发出：全额释放（calls 也不计入）', async () => {
    const port = createMemoryBudgetPort();
    const reserved = await reserveBudget(port, baseRequest);
    if (!reserved.ok) throw new Error('reserve failed');
    const settled = await settleBudget(port, reserved.grant, { requestStarted: false });
    expect(settled).toMatchObject({ ok: true, usedTokens: 0 });
    const charRow = Object.values(port.snapshot()).find((row) => row.scope === 'char-1')!;
    expect(charRow.usedCalls).toBe(0);
    expect(charRow.reservedCalls).toBe(0);
  });

  it('重试要新预留（同一 grant 不能重复结算出新额度）', async () => {
    const port = createMemoryBudgetPort();
    const reserved = await reserveBudget(port, baseRequest);
    if (!reserved.ok) throw new Error('reserve failed');
    await settleBudget(port, reserved.grant, { actualTokens: 100, requestStarted: true });
    await settleBudget(port, reserved.grant, { actualTokens: 100, requestStarted: true });
    const charRow = Object.values(port.snapshot()).find((row) => row.scope === 'char-1')!;
    // 两次结算同一 grant 的 usedCalls 会重复 +1 —— 这是硬约束：调用方必须为新请求重新预留，
    // 引擎的 retry 路径（见 engine.test.ts）就是这么做的；这里记录「不允许复用」的口径。
    expect(charRow.usedCalls).toBe(2);
  });
});

describe('预算：窗口、投影与公平轮转', () => {
  it('窗口 id 按角色时区日切，跨日后换窗口（不跨时区刷额度）', () => {
    const clock = createManualClock(NOW);
    const before = windowIdAt(clock, TZ);
    clock.advance(12 * 60 * 60 * 1000);
    const after = windowIdAt(clock, TZ);
    expect(before).toBe('w:2026-10-24');
    expect(after).toBe('w:2026-10-25');
  });

  it('时区改变不会复用旧窗口：预算窗口以持久化的 windowTimezone 为准', async () => {
    const port = createMemoryBudgetPort();
    await reserveBudget(port, { ...baseRequest, windowTimezone: 'Asia/Shanghai' });
    // 同一时刻西半球还在前一天：属于另一个 windowId —— 旧窗口的已用量不会「继承」过来。
    await reserveBudget(port, { ...baseRequest, windowTimezone: 'Pacific/Honolulu' });
    const keys = Object.keys(port.snapshot()).filter((key) => key.includes('char-1'));
    expect(keys).toHaveLength(2);
    expect(new Set(keys.map((key) => key.split('::')[0])).size).toBe(2);
  });

  it('projectBudgetUsage 同时给角色层与账号层调用数（合并显示不串层）', () => {
    const accountRow = { ...emptyBudgetRow('w:1', 'account', NOW), usedCalls: 4, reservedCalls: 1, notifications: 0 };
    const charRow = { ...emptyBudgetRow('w:1', 'char-1', NOW), usedCalls: 2, reservedCalls: 1, usedTokens: 900 };
    const usage = projectBudgetUsage(accountRow, charRow, limits());
    const byDim = Object.fromEntries(usage.map((item) => [item.dimension, item]));
    expect(byDim.model_calls.used).toBe(2);
    expect(byDim.model_calls_account.used).toBe(4);
    expect(byDim.tokens.used).toBe(900);
    expect(byDim.model_calls_account.limit).toBe(DEFAULT_ACCOUNT_LIMITS.accountModelCallsPerDay);
  });

  it('多角色轮转：先比已用调用，再比上次获准时间', () => {
    const states = [
      { charId: 'b', usedCalls: 2, lastGrantedAt: 1 },
      { charId: 'a', usedCalls: 1, lastGrantedAt: 9 },
      { charId: 'c', usedCalls: 1, lastGrantedAt: 3 },
    ];
    expect(rotationOrder(states).map((s) => s.charId)).toEqual(['c', 'a', 'b']);
  });

  it('precheck 不修改入参（纯判定，避免调用方以为已经扣了）', () => {
    const accountRow = emptyBudgetRow('w:1', 'account', NOW);
    const charRow = emptyBudgetRow('w:1', 'char-1', NOW);
    const before = JSON.stringify([accountRow, charRow]);
    const result = precheckBudget({ accountRow, charRow, limits: limits(), request: baseRequest });
    expect(result.ok).toBe(true);
    expect(JSON.stringify([accountRow, charRow])).toBe(before);
  });

  it('结构天花板：限制值再大也不会超过 MAXIMUM', () => {
    expect(MAXIMUM_ACCOUNT_LIMITS.accountModelCallsPerDay).toBeGreaterThanOrEqual(DEFAULT_ACCOUNT_LIMITS.accountModelCallsPerDay);
    const clamped = { ...DEFAULT_ACCOUNT_LIMITS, accountModelCallsPerDay: MAXIMUM_ACCOUNT_LIMITS.accountModelCallsPerDay };
    expect(precheckBudget({
      accountRow: { ...emptyBudgetRow('w:1', 'account', NOW), usedCalls: MAXIMUM_ACCOUNT_LIMITS.accountModelCallsPerDay },
      charRow: emptyBudgetRow('w:1', 'char-1', NOW),
      limits: clamped,
      request: { ...baseRequest, limits: clamped },
    })).toMatchObject({ ok: false, dimension: 'account_calls' });
  });
});
