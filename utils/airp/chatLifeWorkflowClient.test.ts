// utils/airp/chatLifeWorkflowClient.test.ts
// 前端这一侧：工具声明只带「提想做的事」所需的白名单字段；执行 = 一次鉴权登记请求 +
// 一句「后台已排队」的工具回话。**不在这里生成日记正文，也不额外叫一次模型确认。**
import { beforeEach, describe, expect, it, vi } from 'vitest';

const submit = vi.fn();
vi.mock('../activeMsgClient', () => ({
  ActiveMsgClient: { submitChatLifeWorkflow: (...args: unknown[]) => submit(...args) },
}));

const { CHAT_LIFE_WORKFLOW_TOOLS, CHAT_LIFE_WORKFLOW_TOOL_NAMES, executeChatLifeWorkflowTool } =
  await import('./chatLifeWorkflowClient');

beforeEach(() => { submit.mockReset(); });

describe('工具声明', () => {
  it('只有一个工具，名字是白名单动作的提议，没有任何脚本/网址/权限参数', () => {
    expect(CHAT_LIFE_WORKFLOW_TOOLS).toHaveLength(1);
    expect(CHAT_LIFE_WORKFLOW_TOOLS[0].function.name).toBe('propose_life_workflow');
    expect(CHAT_LIFE_WORKFLOW_TOOL_NAMES.has('propose_life_workflow')).toBe(true);
    const props = Object.keys(CHAT_LIFE_WORKFLOW_TOOLS[0].function.parameters.properties ?? {});
    for (const banned of ['url', 'tool', 'tools', 'permission', 'capabilities', 'command', 'script']) {
      expect(props).not.toContain(banned);
    }
    expect(CHAT_LIFE_WORKFLOW_TOOLS[0].function.description).toContain('不要');
  });

  it('kind 只给三种白名单动作', () => {
    const kind = CHAT_LIFE_WORKFLOW_TOOLS[0].function.parameters.properties.kind;
    expect(kind.enum).toEqual(['diary', 'plan', 'interest_note']);
  });
});

describe('执行', () => {
  it('参数合法 → 一次登记请求，回话只说后台排队、不许宣布', async () => {
    submit.mockResolvedValue({
      status: 200,
      body: { success: true, data: { queued: [{ planId: 'p1', kind: 'diary', scheduledAt: 1 }], rejected: [], deduped: 0 } },
    });
    const text = await executeChatLifeWorkflowTool({
      kind: 'diary', purpose: '想把今天的事记下来', title: '今天的一点小事',
      trigger: { kind: 'idle', afterMinutes: 90 },
    }, { charId: 'char_1', sourceRef: 'chat:turn-1' });

    expect(submit).toHaveBeenCalledTimes(1);
    const sent = submit.mock.calls[0][0] as { charId: string; sourceRef: string; proposals: unknown[] };
    expect(sent.charId).toBe('char_1');
    expect(sent.sourceRef).toBe('chat:turn-1');
    expect(sent.proposals).toHaveLength(1);
    expect(text).toContain('后台');
    expect(text).toContain('不要');
    // 工具回话不追问、不要求模型再确认一遍
    expect(text).not.toMatch(/确认|是否继续|要不要/);
  });

  it('参数不合法 → 本地打回，一个请求都不发', async () => {
    const text = await executeChatLifeWorkflowTool({ kind: 'publish', purpose: 'p', title: 't' }, {
      charId: 'char_1', sourceRef: 'chat:turn-1',
    });
    expect(submit).not.toHaveBeenCalled();
    expect(text).toContain('没有登记');
  });

  it('服务端拒收/网络失败 → 一句「没能登记」，不抛给主链路、不重试', async () => {
    submit.mockResolvedValueOnce({ status: 403, body: { success: false, error: { code: 'CAPABILITY_MISSING', message: 'no' } } });
    const denied = await executeChatLifeWorkflowTool({ kind: 'diary', purpose: 'p', title: 't', trigger: { kind: 'now' } }, {
      charId: 'char_1', sourceRef: 'chat:turn-1',
    });
    expect(denied).toContain('没有登记');

    submit.mockRejectedValueOnce(new Error('offline'));
    const offline = await executeChatLifeWorkflowTool({ kind: 'diary', purpose: 'p', title: 't', trigger: { kind: 'now' } }, {
      charId: 'char_1', sourceRef: 'chat:turn-1',
    });
    // 请求没回来 = 送达未知：说「没等到确认」，不声称登记成功，也不重试
    expect(offline).toContain('没等到云端的确认');
    expect(offline).not.toContain('已经记进');
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('action=cancel 带 planId → 走撤销；缺 planId 本地打回不发请求', async () => {
    submit.mockResolvedValueOnce({ status: 200, body: { success: true, data: { queued: [], rejected: [], deduped: 0, cancelled: true } } });
    const done = await executeChatLifeWorkflowTool({ action: 'cancel', planId: 'plan_9' }, {
      charId: 'char_1', sourceRef: 'chat:turn-1',
    });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ action: 'cancel', planId: 'plan_9' }));
    expect(done).toContain('已经撤掉');
    submit.mockClear();
    const missing = await executeChatLifeWorkflowTool({ action: 'cancel' }, {
      charId: 'char_1', sourceRef: 'chat:turn-1',
    });
    expect(submit).not.toHaveBeenCalled();
    expect(missing).toContain('没有生效');
  });

  it('登记成功 → 本地落一条可查看记录（下一轮才拿得到编号）', async () => {
    const { DB } = await import('../db');
    const { buildPendingPlansBlock } = await import('./pendingPlansPrompt');
    submit.mockResolvedValueOnce({
      status: 200,
      body: { success: true, data: { queued: [{ planId: 'p-local-1', kind: 'diary', scheduledAt: Date.now() + 60_000 }], rejected: [], deduped: 0 } },
    });
    await executeChatLifeWorkflowTool({
      kind: 'diary', purpose: '想把今天的事记下来', title: '今天的一点小事',
      trigger: { kind: 'idle', afterMinutes: 90 },
    }, { charId: 'char_local_rec', sourceRef: 'chat:char_local_rec:m41' });

    const rows = await DB.getWorkflowPlansByChar('char_local_rec');
    const row = rows.find((r) => r.id === 'p-local-1');
    expect(row).toBeTruthy();
    expect(row!.status).toBe('proposed');
    expect(row!.title).toBe('今天的一点小事');
    expect(row!.source).toBe('chat_reply');
    expect(row!.sourceRef).toBe('chat:char_local_rec:m41');
    // 下一轮上下文里就能看到这个编号（否则「撤自己的安排」永远没有 id 可用）
    expect(buildPendingPlansBlock({ plans: rows, nowMs: Date.now() })).toContain('p-local-1');
  });

  it('撤销成功 → 本地记录标 cancelled，并且不再出现在「还排着」里', async () => {
    const { DB } = await import('../db');
    const { buildPendingPlansBlock } = await import('./pendingPlansPrompt');
    const now = Date.now();
    await DB.saveWorkflowPlans([{
      id: 'p-local-cancel', charId: 'char_local_cancel', kind: 'diary', status: 'proposed',
      title: '待撤的小事', purpose: 'p', basis: 'virtual', source: 'chat_reply',
      sourceRef: 'chat:char_local_cancel:m1', scheduledAt: now + 60_000, expiresAt: now + 3_600_000,
      createdAt: now - 1000, updatedAt: now - 1000,
    }]);
    submit.mockResolvedValueOnce({ status: 200, body: { success: true, data: { queued: [], rejected: [], deduped: 0, cancelled: true } } });
    await executeChatLifeWorkflowTool({ action: 'cancel', planId: 'p-local-cancel' }, {
      charId: 'char_local_cancel', sourceRef: 'chat:char_local_cancel:m2',
    });

    const rows = await DB.getWorkflowPlansByChar('char_local_cancel');
    expect(rows.find((r) => r.id === 'p-local-cancel')?.status).toBe('cancelled');
    expect(buildPendingPlansBlock({ plans: rows, nowMs: Date.now() })).toBe('');
  });

  it('服务端说「撤不了」→ 保留真实状态、只标原因，不写成 cancelled/完成', async () => {
    const { DB } = await import('../db');
    const { buildPendingPlansBlock } = await import('./pendingPlansPrompt');
    const now = Date.now();
    await DB.saveWorkflowPlans([{
      id: 'p-local-running', charId: 'char_local_run', kind: 'diary', status: 'scheduled',
      title: '已经开始做的事', purpose: 'p', basis: 'virtual', source: 'chat_reply',
      sourceRef: 'chat:char_local_run:m1', scheduledAt: now - 1000, expiresAt: now + 3_600_000,
      createdAt: now - 5000, updatedAt: now - 5000,
    }]);
    submit.mockResolvedValueOnce({ status: 409, body: { success: false, error: { code: 'PLAN_NOT_CANCELLABLE', message: 'no' } } });
    const text = await executeChatLifeWorkflowTool({ action: 'cancel', planId: 'p-local-running' }, {
      charId: 'char_local_run', sourceRef: 'chat:char_local_run:m2',
    });
    expect(text).toContain('撤');

    const rows = await DB.getWorkflowPlansByChar('char_local_run');
    const row = rows.find((r) => r.id === 'p-local-running');
    expect(row?.status).toBe('scheduled'); // 没被谎报成 cancelled / completed
    expect(row?.lastError).toBe('cannot-cancel');
    // 也不再当「可以撤」列给模型
    expect(buildPendingPlansBlock({ plans: rows, nowMs: Date.now() })).toBe('');
  });

  it('超时/断网 → 送达未知，不写本地记录（不假装登记成功）', async () => {
    const { DB } = await import('../db');
    submit.mockRejectedValueOnce(new Error('timeout'));
    const text = await executeChatLifeWorkflowTool({
      kind: 'diary', purpose: 'p', title: 't', trigger: { kind: 'now' },
    }, { charId: 'char_local_unknown', sourceRef: 'chat:char_local_unknown:m1' });
    expect(text).toContain('没等到云端的确认');
    expect(await DB.getWorkflowPlansByChar('char_local_unknown')).toHaveLength(0);
  });

  it('工具 schema 不接受未声明键（additionalProperties:false）', () => {
    const tool = CHAT_LIFE_WORKFLOW_TOOLS[0] as { function: { parameters: Record<string, unknown> } };
    expect(tool.function.parameters.additionalProperties).toBe(false);
    const trigger = (tool.function.parameters.properties as Record<string, Record<string, unknown>>).trigger;
    expect(trigger.additionalProperties).toBe(false);
  });
});
