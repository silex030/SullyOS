// utils/airp/chatLifeWorkflowHandler.test.ts
// 真实聊天提出的工作流：鉴权作用域 → fire_pack 里的权限终值 → 共用校验器 → 落一条 proposed 计划。
// db 全部注入，测试里没有 D1、没有网络、没有时钟随机。
import { describe, expect, it, vi } from 'vitest';
import { handleChatLifeWorkflow, type ChatLifeWorkflowDeps } from './chatLifeWorkflowHandler';
import type { AutonomyPlanRecord } from './lifeWorkflow';
import type { AmsgFirePack } from '../amsgFirePack';

const NOW = Date.parse('2026-10-22T04:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const makePack = (autonomy: Record<string, unknown> | undefined): AmsgFirePack => ({
  v: 7,
  template: 'T',
  lastUserMessageAt: NOW - 5 * 60_000,
  tzId: 'Asia/Shanghai',
  userTzId: 'Asia/Shanghai',
  targetName: '对方',
  builtAt: NOW - 60_000,
  pendingTasks: [],
  scene: null,
  selfScheduleEnabled: false,
  ...(autonomy === undefined ? {} : { autonomy: autonomy as never }),
} as AmsgFirePack);

const enabledAutonomy = { enabled: true, writable: true, capabilities: [], autonomyLevel: 2 };

const body = (proposals: unknown[] = [{
  kind: 'diary',
  purpose: '今天下午那句话想记下来',
  title: '今天的一点小事',
  trigger: { kind: 'idle', afterMinutes: 60 },
}]) => ({ v: 1, charId: 'char_1', sourceRef: 'chat:turn-1', proposals });

interface Harness {
  deps: ChatLifeWorkflowDeps;
  inserted: AutonomyPlanRecord[];
  loadPack: ReturnType<typeof vi.fn>;
  cancelled: Array<{ planId: string; charId: string; reason: string }>;
  superseded: string[];
  plans: Map<string, AutonomyPlanRecord>;
}

const harness = (over: Partial<ChatLifeWorkflowDeps> & { pack?: AmsgFirePack | null } = {}): Harness => {
  const inserted: AutonomyPlanRecord[] = [];
  const plans = new Map<string, AutonomyPlanRecord>();
  const cancelled: Harness['cancelled'] = [];
  const superseded: string[] = [];
  const loadPack = vi.fn(async () => (over.pack === undefined ? makePack(enabledAutonomy) : over.pack));
  let seq = 0;
  const deps: ChatLifeWorkflowDeps = {
    userId: 'user_1',
    nowMs: NOW,
    rawBody: body(),
    loadPack: loadPack as never,
    isUserPaused: async () => false,
    insertPlan: async (plan) => {
      if (plans.has(plan.id)) return false;
      inserted.push(plan);
      plans.set(plan.id, plan);
      return true;
    },
    loadPlan: async (planId) => plans.get(planId) ?? null,
    cancelPlan: async (args) => { cancelled.push(args); return args.planId !== 'running_plan'; },
    cancelPredecessor: async ({ predecessorId }) => { superseded.push(predecessorId); return true; },
    newPlanId: () => `plan_${++seq}`,
    ...over,
  };
  if (!over.loadPack) deps.loadPack = loadPack as never;
  return { deps, inserted, loadPack, cancelled, superseded, plans };
};

describe('登记成功路径', () => {
  it('一条提议 → 落 proposed 计划，来源是 chat_reply，排期按 idle 往后推', async () => {
    const h = harness();
    const result = await handleChatLifeWorkflow(h.deps);
    expect(result.status).toBe(200);
    expect(h.inserted).toHaveLength(1);
    const plan = h.inserted[0];
    expect(plan).toMatchObject({
      charId: 'char_1',
      kind: 'diary',
      status: 'proposed',
      source: 'chat_reply',
      sourceRef: 'chat:turn-1',
      basis: 'virtual',
      attempts: 0,
      title: '今天的一点小事',
    });
    // idle 60 分钟：既不能早于「提议后 60 分钟」，也不能早于「最后一条用户消息后 60 分钟」
    expect(plan.scheduledAt).toBeGreaterThanOrEqual(NOW + 60 * 60_000);
    expect(plan.scheduledAt).toBeGreaterThanOrEqual(plan.createdAt);
    expect(plan.expiresAt).toBeGreaterThan(plan.scheduledAt);
    const data = (result.body as { data: { queued: unknown[] } }).data;
    expect(data.queued).toHaveLength(1);
  });

  it('用户级总暂停时不落任何计划', async () => {
    const h = harness({ isUserPaused: async () => true });
    const result = await handleChatLifeWorkflow(h.deps);
    expect(result.status).toBe(409);
    expect(h.inserted).toHaveLength(0);
  });

  it('同日同目的重复：计划表说插不进去，就报 0 条、不算错', async () => {
    const h = harness({ insertPlan: async () => false });
    const result = await handleChatLifeWorkflow(h.deps);
    expect(result.status).toBe(200);
    const data = (result.body as { data: { queued: unknown[]; deduped: number } }).data;
    expect(data.queued).toHaveLength(0);
    expect(data.deduped).toBe(1);
  });
});

describe('作用域与权限闸', () => {
  it('没有认证用户 → 401，且不去读包', async () => {
    const h = harness({ userId: null });
    const result = await handleChatLifeWorkflow(h.deps);
    expect(result.status).toBe(401);
    expect(h.loadPack).not.toHaveBeenCalled();
  });

  it('别人家的 charId：按用户+角色查不到包 → 409，绝不落计划（不能伪造跨用户）', async () => {
    const h = harness({ pack: null });
    const result = await handleChatLifeWorkflow(h.deps);
    expect(result.status).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe('FIRE_PACK_MISSING');
    expect(h.inserted).toHaveLength(0);
  });

  it('自主没开 / 白名单不含这类动作 → 403/409，一条都不落；writable 不参与', async () => {
    const disabled = harness({ pack: makePack({ ...enabledAutonomy, enabled: false }) });
    expect((await handleChatLifeWorkflow(disabled.deps)).status).toBe(409);
    expect(disabled.inserted).toHaveLength(0);

    // writable=false 不是这道闸的事：私人虚拟生活不写真实数据，后台执行侧也不看它。
    const readOnly = harness({ pack: makePack({ ...enabledAutonomy, writable: false }) });
    expect((await handleChatLifeWorkflow(readOnly.deps)).status).toBe(200);
    expect(readOnly.inserted).toHaveLength(1);

    const planOnly = harness({
      pack: makePack({ ...enabledAutonomy, capabilityMode: 'allowlist', capabilities: ['schedule_write'] }),
    });
    const denied = await handleChatLifeWorkflow(planOnly.deps);
    expect(denied.status).toBe(403);
    expect((denied.body as { error: { code: string } }).error.code).toBe('CAPABILITY_MISSING');
    expect(planOnly.inserted).toHaveLength(0);
  });

  it('同一份白名单里日记是允许的：只拒不允许的那条，不整批失败', async () => {
    const h = harness({
      pack: makePack({ ...enabledAutonomy, capabilityMode: 'allowlist', capabilities: ['diary_write'] }),
      rawBody: {
        ...body([
          { kind: 'plan', purpose: '想调一下自己的计划', title: '调整计划', trigger: { kind: 'now' } },
          { kind: 'diary', purpose: '记一下今天', title: '今天', trigger: { kind: 'now' } },
        ]),
      },
    });
    const result = await handleChatLifeWorkflow(h.deps);
    expect(result.status).toBe(200);
    const data = (result.body as { data: { queued: Array<{ kind: string }>; rejected: Array<{ reason: string }> } }).data;
    expect(data.rejected.some((r) => r.reason === 'capability')).toBe(true);
    expect(data.queued).toHaveLength(1);
    expect(data.queued[0].kind).toBe('diary');
  });

  it('夹带网址/权限字段的提议被共用校验器拒收，不进队列', async () => {
    const h = harness({
      rawBody: body([{ kind: 'diary', purpose: 'p', title: 't', trigger: { kind: 'now' }, url: 'https://x.test' }]),
    });
    const result = await handleChatLifeWorkflow(h.deps);
    expect(result.status).toBe(200);
    const data = (result.body as { data: { queued: unknown[]; rejected: Array<{ reason: string }> } }).data;
    expect(data.queued).toHaveLength(0);
    expect(data.rejected[0].reason).toBe('forbidden-url');
  });

  it('请求体形状不对 → 400，不读包、不落库', async () => {
    const h = harness({ rawBody: { v: 1, charId: '', sourceRef: '', proposals: [] } });
    const result = await handleChatLifeWorkflow(h.deps);
    expect(result.status).toBe(400);
    expect(h.loadPack).not.toHaveBeenCalled();
    expect(h.inserted).toHaveLength(0);
  });

  it('最多只收一条：多提一条按 over-limit 丢掉', async () => {
    const h = harness({
      rawBody: body([
        { kind: 'diary', purpose: 'a', title: 'A', trigger: { kind: 'now' } },
        { kind: 'interest_note', purpose: 'b', title: 'B', trigger: { kind: 'now' } },
      ]),
    });
    const result = await handleChatLifeWorkflow(h.deps);
    expect(h.inserted).toHaveLength(1);
    const data = (result.body as { data: { rejected: Array<{ reason: string }> } }).data;
    expect(data.rejected[0].reason).toBe('over-limit');
  });

  it('计划不采信客户端给的 charId 之外的身份字段，也不采信执行状态', async () => {
    const h = harness({
      rawBody: {
        ...body(),
        userId: 'user_2',
        status: 'completed',
        scheduledAt: NOW - HOUR,
      },
      pack: makePack(enabledAutonomy),
    });
    await handleChatLifeWorkflow(h.deps);
    expect(h.inserted[0].status).toBe('proposed');
    expect(h.inserted[0].charId).toBe('char_1');
    expect(h.inserted[0].scheduledAt).toBeGreaterThanOrEqual(NOW);
  });
});

describe('角色自己撤销 / 替换待办计划（发布阻断项 3）', () => {
  const pendingPlan = (over: Partial<AutonomyPlanRecord> = {}): AutonomyPlanRecord => ({
    id: 'plan_9', charId: 'char_1', kind: 'diary', status: 'proposed',
    purpose: 'p', title: 't', maxChars: 400,
    trigger: { kind: 'idle', afterMinutes: 60 }, scheduledAt: NOW + HOUR, expiresAt: NOW + 24 * HOUR,
    createdAt: NOW - HOUR, updatedAt: NOW - HOUR, source: 'chat_reply', sourceRef: 'chat:turn-0',
    basis: 'virtual', evidence: [], dedupeKey: 'k', attempts: 0, leaseUntil: 0,
    ...over,
  });

  it('撤销自己的 pending 计划 → 200 cancelled:true，按 charId 作用域', async () => {
    const h = harness();
    h.plans.set('plan_9', pendingPlan());
    h.deps.rawBody = { v: 1, charId: 'char_1', sourceRef: 'chat:turn-2', action: 'cancel', planId: 'plan_9' };
    const result = await handleChatLifeWorkflow(h.deps);
    expect(result.status).toBe(200);
    expect(result.body.data?.cancelled).toBe(true);
    expect(h.cancelled).toEqual([{ planId: 'plan_9', charId: 'char_1', reason: 'role-cancelled' }]);
  });

  it('running / 已结束 → 409 PLAN_NOT_CANCELLABLE（绝不假称撤销）', async () => {
    const h = harness();
    h.plans.set('running_plan', pendingPlan({ id: 'running_plan', status: 'running' }));
    h.deps.rawBody = { v: 1, charId: 'char_1', sourceRef: 'chat:turn-2', action: 'cancel', planId: 'running_plan' };
    const result = await handleChatLifeWorkflow(h.deps);
    expect(result.status).toBe(409);
    expect(result.body.error?.code).toBe('PLAN_NOT_CANCELLABLE');
  });

  it('跨角色撤销 → 404 PLAN_NOT_FOUND（同一用户也越不过 charId）', async () => {
    const h = harness();
    h.plans.set('other_char_plan', pendingPlan({ id: 'other_char_plan', charId: 'char_2' }));
    h.deps.rawBody = { v: 1, charId: 'char_1', sourceRef: 'chat:turn-2', action: 'cancel', planId: 'other_char_plan' };
    const result = await handleChatLifeWorkflow(h.deps);
    expect(result.status).toBe(404);
    expect(h.cancelled).toEqual([]);
  });

  it('新提议带 predecessorId → 先落新计划，再撤前身', async () => {
    const h = harness();
    const order: string[] = [];
    h.deps.insertPlan = async (plan) => { order.push(`insert:${plan.id}`); return true; };
    h.deps.cancelPredecessor = async ({ predecessorId }) => { order.push(`cancel:${predecessorId}`); return true; };
    h.deps.rawBody = body([{
      kind: 'diary', purpose: '换个说法', title: '改主意了',
      trigger: { kind: 'idle', afterMinutes: 30 }, predecessorId: 'plan_old',
    }]);
    const result = await handleChatLifeWorkflow(h.deps);
    expect(result.status).toBe(200);
    expect(order).toEqual(['insert:plan_1', 'cancel:plan_old']);
  });

  it('新提议被校验拒 → 前身一动不动', async () => {
    const h = harness();
    const order: string[] = [];
    h.deps.insertPlan = async (plan) => { order.push(`insert:${plan.id}`); return true; };
    h.deps.cancelPredecessor = async ({ predecessorId }) => { order.push(`cancel:${predecessorId}`); return true; };
    h.deps.rawBody = body([{
      kind: 'diary', purpose: '带链接', title: '看 https://evil.example',
      trigger: { kind: 'now' }, predecessorId: 'plan_old',
    }]);
    await handleChatLifeWorkflow(h.deps);
    expect(order).toEqual([]);
  });
});
