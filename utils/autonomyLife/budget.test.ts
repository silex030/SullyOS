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
  RESERVATION_TTL_MS,
  rotationOrder,
  settleBudget,
  verifyReservationHold,
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

  it('同一张凭据不能重复结算（第二次拒绝，预算不重复扣账）', async () => {
    const port = createMemoryBudgetPort();
    const reserved = await reserveBudget(port, baseRequest);
    if (!reserved.ok) throw new Error('reserve failed');
    const first = await settleBudget(port, reserved.grant, { actualTokens: 100, requestStarted: true });
    expect(first.ok).toBe(true);
    const second = await settleBudget(port, reserved.grant, { actualTokens: 100, requestStarted: true });
    expect(second).toMatchObject({ ok: false, code: 'STATE_CONFLICT' });
    const charRow = Object.values(port.snapshot()).find((row) => row.scope === 'char-1')!;
    // 只结算一次：重试必须重新预留（新凭据），不能拿旧凭据再扣一次。
    expect(charRow.usedCalls).toBe(1);
    const record = Object.values(port.reservationSnapshot()).find((row) => row.charId === 'char-1')!;
    expect(record.state).toBe('settled');
  });
});

describe('预算：预留凭据（可追溯，不拿历史用量背书）', () => {
  const WINDOW_ID = 'w:2026-10-24';

  it('预留会落一条记录：owner/角色/窗口/counter 与 id 自证一致，初始 held 未绑定', async () => {
    const port = createMemoryBudgetPort();
    const reserved = await reserveBudget(port, { ...baseRequest, planRef: 'rhythm-plan:char-1:2026-10-24' });
    if (!reserved.ok) throw new Error('reserve failed');
    const record = await port.readReservation(reserved.grant.reservationId);
    expect(record).toMatchObject({
      ownerId: 'acct-1',
      charId: 'char-1',
      windowId: WINDOW_ID,
      state: 'held',
      actionId: null,
      planRef: 'rhythm-plan:char-1:2026-10-24',
      calls: 1,
    });
    expect(record!.counter).toBeGreaterThan(0);
  });

  it('格式合法但从未签发的 id → reservation_missing（不再靠 usedCalls 背书）', async () => {
    const port = createMemoryBudgetPort();
    const reserved = await reserveBudget(port, baseRequest);
    if (!reserved.ok) throw new Error('reserve failed');
    await settleBudget(port, reserved.grant, { actualTokens: 10, requestStarted: true });
    // 伪造一条同窗口/同角色、counter 也从 1 开始、格式完全合法的 id。
    const forged = `rsv_${WINDOW_ID}_char-1_${NOW}_1`;
    const verdict = await verifyReservationHold(port, {
      reservationId: forged,
      windowId: WINDOW_ID,
      charId: 'char-1',
      actionId: 'act-x',
      nowMs: NOW,
      timezone: TZ,
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'reservation_missing' });
  });

  it('借用另一条动作的凭据 → reservation_not_bound；释放/过期 → 明确拒绝', async () => {
    const port = createMemoryBudgetPort();
    const reserved = await reserveBudget(port, baseRequest);
    if (!reserved.ok) throw new Error('reserve failed');
    const id = reserved.grant.reservationId;
    await settleBudget(port, reserved.grant, { actualTokens: 10, requestStarted: true });

    // 未绑定：任何动作都借不走。
    expect(await verifyReservationHold(port, {
      reservationId: id, windowId: WINDOW_ID, charId: 'char-1', actionId: 'act-a', nowMs: NOW, timezone: TZ,
    })).toMatchObject({ ok: false, reason: 'reservation_not_bound' });

    // 绑定到 act-a 后：act-a 能用，act-b 不能。
    expect(await port.bindReservation({ reservationId: id, actionId: 'act-a', charId: 'char-1', windowId: WINDOW_ID, nowMs: NOW })).toBe(true);
    expect(await verifyReservationHold(port, {
      reservationId: id, windowId: WINDOW_ID, charId: 'char-1', actionId: 'act-a', nowMs: NOW, timezone: TZ,
    })).toMatchObject({ ok: true });
    expect(await verifyReservationHold(port, {
      reservationId: id, windowId: WINDOW_ID, charId: 'char-1', actionId: 'act-b', nowMs: NOW, timezone: TZ,
    })).toMatchObject({ ok: false, reason: 'reservation_not_bound' });

    // 过期：超过凭据 TTL 就拒（不能拿隔天的旧凭据执行）。
    expect(await verifyReservationHold(port, {
      reservationId: id, windowId: WINDOW_ID, charId: 'char-1', actionId: 'act-a',
      nowMs: NOW + RESERVATION_TTL_MS + 1, timezone: TZ,
    })).toMatchObject({ ok: false, reason: 'reservation_expired' });
  });

  it('释放掉的凭据不能再用（preflight 取消 → released）', async () => {
    const port = createMemoryBudgetPort();
    const reserved = await reserveBudget(port, baseRequest);
    if (!reserved.ok) throw new Error('reserve failed');
    const id = reserved.grant.reservationId;
    await port.bindReservation({ reservationId: id, actionId: 'act-r', charId: 'char-1', windowId: WINDOW_ID, nowMs: NOW });
    await settleBudget(port, reserved.grant, { requestStarted: false });
    expect(await verifyReservationHold(port, {
      reservationId: id, windowId: WINDOW_ID, charId: 'char-1', actionId: 'act-r', nowMs: NOW, timezone: TZ,
    })).toMatchObject({ ok: false, reason: 'reservation_released' });
    // 预算也没被占：usedCalls 仍是 0。
    const charRow = Object.values(port.snapshot()).find((row) => row.scope === 'char-1')!;
    expect(charRow.usedCalls).toBe(0);
  });

  it('绑定与结算并发：其中一方条件更新失败就整笔放弃（不产生半条状态）', async () => {
    const port = createMemoryBudgetPort();
    const reserved = await reserveBudget(port, baseRequest);
    if (!reserved.ok) throw new Error('reserve failed');
    const id = reserved.grant.reservationId;
    const [a, b] = await Promise.all([
      port.bindReservation({ reservationId: id, actionId: 'act-1', charId: 'char-1', windowId: WINDOW_ID, nowMs: NOW }),
      port.bindReservation({ reservationId: id, actionId: 'act-2', charId: 'char-1', windowId: WINDOW_ID, nowMs: NOW }),
    ]);
    // 两个请求串行化后只有第一个成功；第二个既不能抢绑，也不能改掉第一个的绑定。
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const record = await port.readReservation(id);
    expect(['act-1', 'act-2']).toContain(record?.actionId);
    expect(await verifyReservationHold(port, {
      reservationId: id, windowId: WINDOW_ID, charId: 'char-1', actionId: record?.actionId, nowMs: NOW, timezone: TZ,
    })).toMatchObject({ ok: true });
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
