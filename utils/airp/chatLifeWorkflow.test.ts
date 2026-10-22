// utils/airp/chatLifeWorkflow.test.ts
// P5：聊天里提出生活工作流的**共享契约**——能不能提、提的形状、被拒后怎么回话。
// 这一层必须与自主回合共用同一个校验器（lifeWorkflow），不另写一套规则。
import { describe, expect, it } from 'vitest';
import {
  CHAT_LIFE_WORKFLOW_MAX_PROPOSALS,
  CHAT_LIFE_WORKFLOW_TOOL_NAME,
  chatLifeWorkflowAvailability,
  parseChatLifeWorkflowBody,
  proposalFromChatToolArgs,
  summarizeChatLifeWorkflowResult,
} from './chatLifeWorkflow';
import { validateAutonomyWorkflowProposal } from './lifeWorkflow';

const NOW = Date.parse('2026-10-22T04:00:00.000Z');

describe('注入闸：权限/写入总闸/自主开关同时成立才把工具交给模型', () => {
  it('自主关闭或没开写入，一律不注入', () => {
    expect(chatLifeWorkflowAvailability({ enabled: false, writable: true }).allowed).toBe(false);
    // writable=false（默认）**不**挡这条链：私人日记/计划/兴趣笔记不动真实数据，
    // 与后台执行侧 canRunPrivateLifeAction 同口径。真实写入闸仍管 MCP/发帖/下单。
    expect(chatLifeWorkflowAvailability({ enabled: true, writable: false }).allowed).toBe(true);
    expect(chatLifeWorkflowAvailability(null).allowed).toBe(false);
  });

  it('显式 none 不会复活；allowlist 按白名单逐类判定', () => {
    expect(chatLifeWorkflowAvailability({ enabled: true, writable: true, capabilityMode: 'none' }))
      .toEqual({ allowed: false, kinds: [] });
    const diaryOnly = chatLifeWorkflowAvailability({
      enabled: true, writable: true, capabilityMode: 'allowlist', capabilities: ['diary_write'],
    });
    expect(diaryOnly.allowed).toBe(true);
    expect(diaryOnly.kinds).toEqual(['diary', 'interest_note']);
    const scheduleOnly = chatLifeWorkflowAvailability({
      enabled: true, writable: true, capabilityMode: 'allowlist', capabilities: ['schedule_write'],
    });
    expect(scheduleOnly.kinds).toEqual(['plan']);
  });

  it('旧空数组仍是 all 语义（与 B4 契约一致）', () => {
    expect(chatLifeWorkflowAvailability({ enabled: true, writable: true, capabilities: [] }).allowed).toBe(true);
  });
});

describe('工具参数 → 提议（形状对不上就本地打回，不猜不改写）', () => {
  it('正常一条：补 v=1，动作类型跟着外层 kind 走', () => {
    const built = proposalFromChatToolArgs({
      kind: 'diary',
      purpose: '想把今天下午的事记下来',
      title: '今天的一点小事',
      trigger: { kind: 'idle', afterMinutes: 60 },
      maxChars: 400,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal).toMatchObject({
      v: 1,
      kind: 'diary',
      action: { kind: 'diary', title: '今天的一点小事', maxChars: 400 },
      basis: 'virtual',
    });
    const verdict = validateAutonomyWorkflowProposal(built.proposal, {
      nowMs: NOW, source: 'chat_reply', sourceRef: 'chat:1', tzId: 'Asia/Shanghai',
    });
    expect(verdict.ok).toBe(true);
  });

  it('缺 kind/标题/目的、或 kind 不在白名单 → 本地就拒', () => {
    expect(proposalFromChatToolArgs(null).ok).toBe(false);
    expect(proposalFromChatToolArgs({ purpose: 'p', title: 't' }).ok).toBe(false);
    expect(proposalFromChatToolArgs({ kind: 'publish', purpose: 'p', title: 't' }).ok).toBe(false);
    expect(proposalFromChatToolArgs({ kind: 'diary', purpose: '', title: 't' }).ok).toBe(false);
    expect(proposalFromChatToolArgs({ kind: 'diary', purpose: 'p', title: '' }).ok).toBe(false);
  });

  it('夹带网址/工具/权限不会被本地悄悄洗白，而是由共用校验器明确拒收', () => {
    for (const sneaky of [{ url: 'https://x.test' }, { tool: 'shell' }, { permissions: ['all'] }]) {
      const built = proposalFromChatToolArgs({
        kind: 'diary', purpose: 'p', title: 't', trigger: { kind: 'now' }, ...sneaky,
      });
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const verdict = validateAutonomyWorkflowProposal(built.proposal, {
        nowMs: NOW, source: 'chat_reply', sourceRef: 'chat:1', tzId: 'Asia/Shanghai',
      });
      expect(verdict.ok).toBe(false);
    }
  });
});

describe('请求体解析（worker 侧第一道闸）', () => {
  const good = {
    v: 1,
    charId: 'char_1',
    sourceRef: 'chat:abc',
    proposals: [{ kind: 'diary', purpose: 'p', title: 't', trigger: { kind: 'now' } }],
  };

  it('正常请求原样收下', () => {
    const parsed = parseChatLifeWorkflowBody(good);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.body.charId).toBe('char_1');
    expect(parsed.body.proposals).toHaveLength(1);
  });

  it('版本、charId、来源、条数、空列表都收口', () => {
    expect(parseChatLifeWorkflowBody({ ...good, v: 2 }).ok).toBe(false);
    expect(parseChatLifeWorkflowBody({ ...good, charId: 'char/../1' }).ok).toBe(false);
    expect(parseChatLifeWorkflowBody({ ...good, charId: '' }).ok).toBe(false);
    expect(parseChatLifeWorkflowBody({ ...good, sourceRef: '' }).ok).toBe(false);
    expect(parseChatLifeWorkflowBody({ ...good, sourceRef: 'x'.repeat(400) }).ok).toBe(false);
    expect(parseChatLifeWorkflowBody({ ...good, proposals: [] }).ok).toBe(false);
    expect(parseChatLifeWorkflowBody({
      ...good,
      proposals: new Array(CHAT_LIFE_WORKFLOW_MAX_PROPOSALS + 1).fill(good.proposals[0]),
    }).ok).toBe(false);
    expect(parseChatLifeWorkflowBody('nope').ok).toBe(false);
  });
});

describe('工具结果回话：只报「后台已排队」，绝不把日记内容带进前台', () => {
  it('登记成功 → 说清后台会做，且不许向对方宣布', () => {
    const out = summarizeChatLifeWorkflowResult(200, {
      success: true,
      data: { queued: [{ planId: 'p1', kind: 'diary', scheduledAt: NOW + 3_600_000 }], rejected: [], deduped: 0 },
    });
    expect(out.ok).toBe(true);
    expect(out.queued).toBe(1);
    expect(out.text).toContain('后台');
    expect(out.text).toContain('不要');
    // 前台只拿到「排队」这句话，没有日记正文
    expect(out.text).not.toMatch(/日记正文|内容如下/);
  });

  it('同名同日重复 → 不报成功也不报错，只说不重复记', () => {
    const out = summarizeChatLifeWorkflowResult(200, {
      success: true, data: { queued: [], rejected: [], deduped: 1 },
    });
    expect(out.ok).toBe(true);
    expect(out.queued).toBe(0);
    expect(out.text).toContain('已经');
  });

  it('被拒/服务端不开 → 明说没登记，不要用户解释、不要重试', () => {
    const denied = summarizeChatLifeWorkflowResult(403, {
      success: false, error: { code: 'CAPABILITY_MISSING', message: 'no' },
    });
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain('不要');
    const throttled = summarizeChatLifeWorkflowResult(429, { success: false, error: { code: 'X', message: 'm' } });
    expect(throttled.ok).toBe(false);
  });
});

describe('自然提议不靠关键词：普通闲聊里的一句话就够', () => {
  it('不要求任何告别/晚安字样，也没有可供触发的词表', () => {
    const built = proposalFromChatToolArgs({
      kind: 'interest_note',
      purpose: '刚聊到的那本旧书想去翻两页',
      title: '翻两页那本旧书',
      trigger: { kind: 'idle', afterMinutes: 45 },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const verdict = validateAutonomyWorkflowProposal(built.proposal, {
      nowMs: NOW, source: 'chat_reply', sourceRef: 'chat:no-goodnight', tzId: 'Asia/Shanghai',
    });
    expect(verdict.ok).toBe(true);
    expect(CHAT_LIFE_WORKFLOW_TOOL_NAME).toBe('propose_life_workflow');
  });
});
