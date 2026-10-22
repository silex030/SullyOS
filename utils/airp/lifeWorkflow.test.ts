// utils/airp/lifeWorkflow.test.ts
// P5：模型提议 → 类型化白名单动作 → 计划状态机 / 预算门 / 用户开口取消 / 执行输出解析。
import { describe, expect, it } from 'vitest';
import {
  AUTONOMY_PLAN_TERMINAL_STATUSES,
  AUTONOMY_WORKFLOW_KINDS,
  canTransitionPlan,
  computeScheduledAt,
  evaluateWorkflowBudget,
  chatUserMessageRef,
  isCancelableByUserSpeech,
  isPlanDue,
  parseWorkflowExecutionOutput,
  planDedupeKey,
  validateAutonomyWorkflowProposal,
  validateAutonomyWorkflowProposals,
  type AutonomyWorkflowProposal,
} from './lifeWorkflow';

const NOW = Date.parse('2026-10-22T04:00:00.000Z'); // 上海 12:00
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

const rawProposal = (over: Record<string, unknown> = {}) => ({
  v: 1,
  kind: 'diary',
  purpose: '把今天下午的事记下来',
  trigger: { kind: 'idle', afterMinutes: 120 },
  action: { kind: 'diary', title: '今天的一点小事', maxChars: 400 },
  expiresInHours: 24,
  basis: 'virtual',
  ...over,
});

const ctx = { nowMs: NOW, source: 'autonomy_round' as const, sourceRef: 'round-1', tzId: 'Asia/Shanghai' };

describe('提议校验：只允许三种低风险白名单动作', () => {
  it('三种动作都接受，并生成类型化提议', () => {
    for (const kind of AUTONOMY_WORKFLOW_KINDS) {
      const out = validateAutonomyWorkflowProposal(rawProposal({
        kind, action: { kind, title: 'T', maxChars: 300 },
      }), ctx);
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.proposal.kind).toBe(kind);
        expect(out.proposal.expiresAt).toBe(NOW + 24 * HOUR);
        expect(out.proposal.dedupeKey).toMatch(new RegExp(`^wf:${kind}:`));
      }
    }
  });

  it('未知动作 / 动作与提议不一致 / 缺 title → 拒', () => {
    expect(validateAutonomyWorkflowProposal(rawProposal({ kind: 'post_moment' }), ctx))
      .toMatchObject({ ok: false, reason: 'unknown-kind' });
    expect(validateAutonomyWorkflowProposal(rawProposal({
      action: { kind: 'plan', title: 'T' },
    }), ctx)).toMatchObject({ ok: false, reason: 'action-kind-mismatch' });
    expect(validateAutonomyWorkflowProposal(rawProposal({
      action: { kind: 'diary', title: '   ' },
    }), ctx)).toMatchObject({ ok: false, reason: 'bad-action' });
  });

  it('不许带 URL / 方法 / 代码 / 工具 / 权限 / 预算字段（模型文本不是脚本）', () => {
    for (const over of [
      { action: { kind: 'diary', title: 'T', url: 'https://example.com' } },
      { action: { kind: 'diary', title: 'T', method: 'POST' } },
      { action: { kind: 'diary', title: 'T', code: 'rm -rf /' } },
      { action: { kind: 'diary', title: 'T', tool: 'mcp__x' } },
      { action: { kind: 'diary', title: 'T', permissions: { writable: true } } },
      { action: { kind: 'diary', title: 'T', budget: 999 } },
      { purpose: '去 https://example.com 抓一下' },
      { purpose: '执行 eval("x")' },
    ]) {
      const out = validateAutonomyWorkflowProposal(rawProposal(over), ctx);
      expect(out.ok).toBe(false);
    }
  });

  it('不许用天气/日程空白断言用户情绪或空闲', () => {
    for (const purpose of [
      '用户一定很开心',
      '看天气这么好，对方肯定心情不错',
      '你没有安排，说明你有空',
    ]) {
      expect(validateAutonomyWorkflowProposal(rawProposal({ purpose }), ctx))
        .toMatchObject({ ok: false, reason: 'forbidden-assertion' });
    }
  });

  it('提议不能冒充现实观测：basis=observation 拒；inference 要有依据', () => {
    expect(validateAutonomyWorkflowProposal(rawProposal({ basis: 'observation' }), ctx))
      .toMatchObject({ ok: false, reason: 'basis-overclaim' });
    expect(validateAutonomyWorkflowProposal(rawProposal({ basis: 'inference', evidence: [] }), ctx))
      .toMatchObject({ ok: false, reason: 'no-basis' });
    expect(validateAutonomyWorkflowProposal(
      rawProposal({ basis: 'inference', evidence: ['最近聊到想整理房间'] }), ctx,
    ).ok).toBe(true);
  });

  it('过期时间必须有界：0 / 负数 / 超过 7 天都拒', () => {
    for (const expiresInHours of [0, -1, 24 * 8]) {
      expect(validateAutonomyWorkflowProposal(rawProposal({ expiresInHours }), ctx).ok).toBe(false);
    }
  });

  it('批量校验：好的收下、坏的逐条给原因，绝不整批抛', () => {
    const out = validateAutonomyWorkflowProposals(
      [rawProposal(), rawProposal({ kind: 'x' }), null, rawProposal({ purpose: '' })],
      ctx,
    );
    expect(out.accepted).toHaveLength(1);
    expect(out.rejected).toHaveLength(3);
    expect(out.rejected[0].index).toBe(1);
  });
});

describe('去重键 / 排期', () => {
  it('同一天同一类同一目的 → 同键；换天/换目的 → 换键', () => {
    const a = validateAutonomyWorkflowProposal(rawProposal(), ctx);
    const b = validateAutonomyWorkflowProposal(rawProposal(), { ...ctx, nowMs: NOW + HOUR });
    const nextDay = validateAutonomyWorkflowProposal(rawProposal(), { ...ctx, nowMs: NOW + 24 * HOUR });
    const other = validateAutonomyWorkflowProposal(rawProposal({ purpose: '换一件事' }), ctx);
    expect(a.ok && b.ok && a.proposal.dedupeKey === b.proposal.dedupeKey).toBe(true);
    expect(a.ok && nextDay.ok && a.proposal.dedupeKey !== nextDay.proposal.dedupeKey).toBe(true);
    expect(a.ok && other.ok && a.proposal.dedupeKey !== other.proposal.dedupeKey).toBe(true);
    expect(planDedupeKey({ kind: 'diary', title: 'T', dateKey: '2026-10-22' })).toMatch(/^wf:diary:/);
  });

  it('idle：等用户安静够久才排；at_time：下一个本地整点', () => {
    const idle = validateAutonomyWorkflowProposal(rawProposal({ trigger: { kind: 'idle', afterMinutes: 120 } }), ctx);
    expect(idle.ok).toBe(true);
    if (!idle.ok) return;
    const scheduled = computeScheduledAt(idle.proposal, { nowMs: NOW, tzId: 'Asia/Shanghai', lastUserMessageAt: NOW - 30 * MIN });
    expect(scheduled).toBe(NOW + 120 * MIN);

    const at = validateAutonomyWorkflowProposal(rawProposal({ trigger: { kind: 'at_time', atLocalTime: '21:30' } }), ctx);
    expect(at.ok).toBe(true);
    if (!at.ok) return;
    const atScheduled = computeScheduledAt(at.proposal, { nowMs: NOW, tzId: 'Asia/Shanghai' });
    // 上海 12:00 → 下一个 21:30 是同日 13:30 UTC
    expect(new Date(atScheduled).toISOString()).toBe('2026-10-22T13:30:00.000Z');
  });

  it('到点判定：proposed + 到点 + 未过期才算 due', () => {
    const p = validateAutonomyWorkflowProposal(rawProposal(), ctx);
    if (!p.ok) throw new Error('fixture');
    const plan = {
      ...p.proposal, id: 'p1', charId: 'c1', status: 'proposed' as const,
      title: 'T', maxChars: 300, createdAt: NOW, updatedAt: NOW,
      scheduledAt: NOW, attempts: 0, leaseUntil: 0,
    };
    expect(isPlanDue(plan, NOW)).toBe(true);
    expect(isPlanDue({ ...plan, status: 'scheduled' }, NOW)).toBe(false);
    expect(isPlanDue(plan, plan.expiresAt + 1)).toBe(false);
  });
});

describe('状态机', () => {
  it('proposed → scheduled → running → completed/failed/unknown', () => {
    expect(canTransitionPlan('proposed', 'scheduled')).toBe(true);
    expect(canTransitionPlan('scheduled', 'running')).toBe(true);
    expect(canTransitionPlan('running', 'completed')).toBe(true);
    expect(canTransitionPlan('running', 'failed')).toBe(true);
    expect(canTransitionPlan('running', 'unknown')).toBe(true);
    expect(canTransitionPlan('completed', 'running')).toBe(false);
    expect(canTransitionPlan('unknown', 'scheduled')).toBe(false);
  });

  it('cancelled 只能从还没开始的 proposed/scheduled 来', () => {
    expect(canTransitionPlan('proposed', 'cancelled')).toBe(true);
    expect(canTransitionPlan('scheduled', 'cancelled')).toBe(true);
    expect(canTransitionPlan('running', 'cancelled')).toBe(false);
    expect(AUTONOMY_PLAN_TERMINAL_STATUSES).toContain('unknown');
  });

  it('用户重新开口：只取消还没开始的；running/终态不动', () => {
    const base = { status: 'proposed' as const, createdAt: NOW - HOUR };
    expect(isCancelableByUserSpeech({ ...base, status: 'scheduled' }, NOW)).toBe(true);
    expect(isCancelableByUserSpeech(base, NOW)).toBe(true);
    expect(isCancelableByUserSpeech({ ...base, status: 'running' }, NOW)).toBe(false);
    expect(isCancelableByUserSpeech({ ...base, status: 'completed' }, NOW)).toBe(false);
    // 用户在这条提议之前说的话不算（不能把旧消息当取消理由）
    expect(isCancelableByUserSpeech(base, NOW - 2 * HOUR)).toBe(false);
  });

  it('同一条用户消息催出来的计划，不会被它自己立刻撤掉（真实 msg id 对齐）', () => {
    const created = {
      status: 'proposed' as const,
      createdAt: NOW - HOUR,
      sourceRef: chatUserMessageRef('c1', 41),
    };
    // 只看时间戳：这条消息比计划新 → 会被误判成「用户又开口了」
    expect(isCancelableByUserSpeech(created, NOW)).toBe(true);
    // 认出是同一句：不撤
    expect(isCancelableByUserSpeech(created, NOW, { lastUserMessageRef: chatUserMessageRef('c1', 41) })).toBe(false);
    // 换了一条（后面的那一句）：照常撤
    expect(isCancelableByUserSpeech(created, NOW, { lastUserMessageRef: chatUserMessageRef('c1', 42) })).toBe(true);
    // 老包没有消息引用时退回只比时间戳（行为不变）
    expect(isCancelableByUserSpeech(created, NOW, { lastUserMessageRef: null })).toBe(true);
  });

  it('chatUserMessageRef 与聊天工具 sourceRef 同一格式', () => {
    expect(chatUserMessageRef('char_1', 9)).toBe('chat:char_1:m9');
  });
});

describe('预算门：次数 + token 双门禁', () => {
  const limits = {
    perCharPerDay: 2, sameKindMinGapMinutes: 120, globalPerDay: 6,
    reserveTokensPerRun: 1600, paused: false, version: 1 as const,
  };
  const usage = (over: Partial<Parameters<typeof evaluateWorkflowBudget>[0]['usage']> = {}) => ({
    charUsedToday: 0, lastSameKindAt: 0, globalUsedToday: 0,
    tokensToday: 0, reservedTokensToday: 0, dailyTokenBudget: 100_000,
    ...over,
  });
  const check = (over: Partial<Parameters<typeof evaluateWorkflowBudget>[0]> = {}) =>
    evaluateWorkflowBudget({ nowMs: NOW, limits, usage: usage(), ...over });

  it('全通过', () => expect(check()).toEqual({ allowed: true }));

  it('总暂停优先', () => {
    expect(check({ limits: { ...limits, paused: true } }))
      .toEqual({ allowed: false, reason: 'paused' });
  });

  it('每角色每日 2 次', () => {
    expect(check({ usage: usage({ charUsedToday: 2 }) }))
      .toEqual({ allowed: false, reason: 'char-daily-limit' });
  });

  it('同类 2 小时', () => {
    expect(check({ usage: usage({ lastSameKindAt: NOW - 30 * MIN }) }))
      .toEqual({ allowed: false, reason: 'kind-gap' });
    expect(check({ usage: usage({ lastSameKindAt: NOW - 3 * HOUR }) }).allowed).toBe(true);
  });

  it('全局 6 次（共享计数）', () => {
    expect(check({ usage: usage({ globalUsedToday: 6 }) }))
      .toEqual({ allowed: false, reason: 'global-daily-limit' });
  });

  it('token 预算把预留算进去（防两跳之间超卖）', () => {
    expect(check({
      usage: usage({ tokensToday: 98_000, reservedTokensToday: 1000, dailyTokenBudget: 100_000 }),
    })).toEqual({ allowed: false, reason: 'token-budget' });
    expect(check({
      usage: usage({ tokensToday: 90_000, reservedTokensToday: 1000, dailyTokenBudget: 100_000 }),
    }).allowed).toBe(true);
  });
});

describe('执行输出解析（后台独立请求的产物）', () => {
  it('JSON 信封：取 text 与 plans', () => {
    const out = parseWorkflowExecutionOutput(
      '```json\n{"v":1,"text":"今天下了很久的雨。","plans":[{"title":"周末去买伞"}]}\n```',
      'plan', 300,
    );
    expect(out).toMatchObject({ ok: true, text: '今天下了很久的雨。' });
    if (out.ok) expect(out.plans).toEqual(['周末去买伞']);
  });

  it('日记/兴趣笔记允许纯文本；空输出算失败', () => {
    expect(parseWorkflowExecutionOutput('随手记一句。', 'diary', 300)).toMatchObject({ ok: true, text: '随手记一句。' });
    expect(parseWorkflowExecutionOutput('   ', 'diary', 300)).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('计划调整必须有可读条目，不能只给一段散文', () => {
    expect(parseWorkflowExecutionOutput('我打算周末去买伞。', 'plan', 300))
      .toMatchObject({ ok: false, reason: 'bad-shape' });
  });

  it('超过上限按整句收笔，不留半句', () => {
    const long = '第一句话。第二句话很长很长。第三句';
    const out = parseWorkflowExecutionOutput(long, 'diary', 12);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.text.endsWith('。')).toBe(true);
  });
});
