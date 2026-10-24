/**
 * read_share_excerpts 的真实代码链路测试（执行卡 t_75dd49a5）。
 *
 * 链路：分享卡在上下文里 → 工具 schema → 模型 tool_calls（fixture 模型）→ 执行器 →
 * 真实 HTTP 契约（fetch 桩把请求交给服务端真实的 buildExcerpts 生成响应）→ tool result →
 * 下一跳请求 → 最终回复；再把 call/result 成对落进 metadata，下一轮投影真的读得回来。
 *
 * 说明：fetch 是桩（不连真实网络），但响应体由仓库里真实的 worker/social-content/excerpts
 * 生成，不是编造的执行输出；模型输出是 fixture（测试本来就无法调真实模型）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildExcerpts, estimateTokens } from '../worker/social-content/excerpts';
import type { ContentRecord, ShareAttachment } from './socialContent/types';
import { normalizeMessageContent } from './messageFormat';
import { buildToolResultMessage } from './toolCallCompat';
import {
  attachShareExcerptPairs,
  buildShareExcerptsTool,
  createShareExcerptTurn,
  dispatchShareExcerptToolCall,
  executeShareExcerptToolCall,
  pickShareExcerptTurnAnchor,
  renderShareExcerptPairProjection,
  resolveShareExcerptTarget,
  SHARE_EXCERPT_LIMITS,
  SHARE_EXCERPT_META_KEY,
  SHARE_EXCERPTS_TOOL_NAME,
  ShareExcerptBudget,
  ShareExcerptPairRecorder,
  hasReadableShareExcerptTarget,
} from './socialShareTool';

const BASE = 'https://os.example.com';
const TOKEN = 'client-token';
const CONTENT_ID = 'bilibili:public:BV1xx411c7mD';
const SHARE_REF = 'shr_0123456789abcdef0123456789abcdef';

const transcriptSegments = [
  '第一段字幕：这个视频讲了浏览器里装一个虚拟手机系统。'.repeat(6),
  '第二段字幕：角色会在聊天里跟你讨论分享的链接内容。'.repeat(6),
  '第三段字幕：字幕是按时间轴切片的，超出预算会返回 cursor。'.repeat(6),
  '第四段字幕：第四段的细节说明，讲到预算和投影的关系。'.repeat(6),
  '第五段字幕：第五段继续展开，说明为什么片段要有界。'.repeat(6),
  '第六段字幕：第六段讲评论样本和字幕分轨的区别。'.repeat(6),
  '第七段字幕：第七段讲重试、版本与 VERSION_UNAVAILABLE。'.repeat(6),
  '第八段字幕：最后一句是结论，读到这里就够了。'.repeat(6),
];

function contentRecord(over: Partial<ContentRecord> = {}): ContentRecord {
  return {
    schemaVersion: 1,
    id: CONTENT_ID,
    platform: 'bilibili',
    sourceId: 'public',
    externalId: 'BV1xx411c7mD',
    author: { id: null, name: '夹具UP主', avatarUrl: null, profileUrl: null },
    title: '夹具视频标题',
    text: '这是视频简介正文。\n\n第二段正文。',
    media: [],
    canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    publishedAt: 1_700_000_000_000,
    fetchedAt: 1_700_000_100_000,
    updatedAt: null,
    attribution: {
      platformName: 'B站',
      authorName: '夹具UP主',
      sourceUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
      retrievalMethod: 'fixture',
      license: null,
    },
    status: 'available',
    visibility: 'public',
    counts: { likes: null, comments: null },
    contentRevision: 3,
    body: { availability: 'available', text: '这是视频简介正文。\n\n第二段正文。', truncated: false, originalLength: 20 },
    images: [],
    transcripts: [
      {
        id: 'native-zh',
        partKey: null,
        kind: 'native_caption',
        language: 'zh',
        provider: 'bilibili',
        availability: 'available',
        segments: transcriptSegments.map((text, i) => ({
          id: `s${i}`,
          startMs: i * 20_000,
          endMs: (i + 1) * 20_000,
          text,
        })),
        plainText: transcriptSegments.join('\n'),
        truncated: false,
        originalLength: transcriptSegments.join('\n').length,
        fetchedAt: 1_700_000_100_000,
        sourceRef: `${CONTENT_ID}#transcript`,
      },
    ],
    commentsSample: null,
    summary: null,
    fieldProvenance: {},
    limits: { maxTextChars: 200000, maxResponseBytes: 256 * 1024, truncated: false, notes: [] },
    ...over,
  };
}

function attachment(over: Partial<ShareAttachment> = {}): ShareAttachment {
  return {
    schemaVersion: 1,
    shareRef: SHARE_REF,
    messageId: '101',
    conversationId: 'char-1',
    characterId: 'char-1',
    occurrenceSpans: [{ start: 3, end: 62 }],
    originalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    platform: 'bilibili',
    sourceId: 'public',
    resolvedUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    openUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    contentId: CONTENT_ID,
    partKey: null,
    state: 'ready',
    revision: 4,
    attempt: 1,
    createdAt: 1,
    updatedAt: 2,
    error: null,
    preview: {
      title: '夹具视频标题',
      authorName: '夹具UP主',
      platformName: 'B站',
      siteName: 'B站',
      coverUrl: null,
      excerpt: '这是视频简介正文',
    },
    contextProjection: {
      projectionVersion: 1,
      shareRef: SHARE_REF,
      contentId: CONTENT_ID,
      contentRevision: 3,
      stateAtFreeze: 'ready',
      summaryText: 'B站 · 夹具UP主：夹具视频标题：这是视频简介正文',
      evidenceCoverage: ['title', 'text', 'transcript'],
      reason: null,
      frozenAt: 2,
    },
    ...over,
  };
}

function userMessage(att: ShareAttachment = attachment()) {
  return {
    id: 101,
    charId: 'char-1',
    role: 'user' as const,
    type: 'text' as const,
    content: '看这个 https://www.bilibili.com/video/BV1xx411c7mD 讲了什么？',
    timestamp: 10,
    metadata: { shares: { version: 1, attachments: [att] } },
  };
}

interface HttpCall {
  url: string;
  method: string;
  token: string | null;
  body: any;
}

/** 桩：把请求交给服务端真实 buildExcerpts，返回真实形状的响应（不编造执行输出）。
 *  byId 可按 contentId 提供不同内容（多卡场景要证明「读的是这张卡，不是那张」）。 */
function stubShareServer(
  record: ContentRecord | null = contentRecord(),
  byId: Record<string, ContentRecord> = {},
) {
  const calls: HttpCall[] = [];
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(typeof input === 'string' ? input : input?.url ?? input);
    const headers = new Headers(init?.headers || {});
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method: String(init?.method || 'GET'), token: headers.get('x-client-token'), body });
    const m = /\/agent\/v1\/social\/items\/(.+)\/excerpts$/.exec(url);
    if (!m) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    const effective = byId[decodeURIComponent(m[1])] ?? record;
    if (!effective) return new Response(JSON.stringify({ error: 'CONTENT_NOT_FOUND' }), { status: 404 });
    try {
      const result = buildExcerpts(effective, {
        contentRevision: Number(body?.contentRevision),
        query: typeof body?.query === 'string' ? body.query : null,
        fields: Array.isArray(body?.fields) ? body.fields : ['text'],
        partKey: typeof body?.partKey === 'string' ? body.partKey : null,
        cursor: typeof body?.cursor === 'string' ? body.cursor : null,
        maxTokens: Number(body?.maxTokens) || 0,
      });
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    } catch (err: any) {
      if (String(err?.name || '').includes('VersionUnavailable')) {
        return new Response(JSON.stringify({ error: 'VERSION_UNAVAILABLE' }), { status: 409 });
      }
      return new Response(JSON.stringify({ error: 'INTERNAL' }), { status: 500 });
    }
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

const endpoint = { base: BASE, token: TOKEN };

function makeTurn(messages: any[] = [userMessage()], opts: { budget?: ShareExcerptBudget } = {}) {
  return createShareExcerptTurn(messages, { endpoint, now: () => 1_000, budget: opts.budget })!;
}

/** 还原 useChatAI 里的调用形状：模型给 tool_call，执行器跑，结果回填。 */
async function runToolCall(turn: any, args: Record<string, unknown>, id = 'call_1') {
  const toolCall = toolCallFor(args, id);
  const outcome = await executeShareExcerptToolCall({ toolCall, turn });
  return { toolCall, outcome };
}

function toolCallFor(args: Record<string, unknown>, id = 'call_1') {
  return {
    id,
    type: 'function',
    function: { name: SHARE_EXCERPTS_TOOL_NAME, arguments: JSON.stringify(args) },
  };
}

/** 每张卡一份内容记录（多卡场景要证明读到的是这张卡的字幕，不是那张的）。 */
function cardRecord(contentId: string, marker: string): ContentRecord {
  const base = contentRecord();
  return {
    ...base,
    id: contentId,
    externalId: contentId.split(':').pop() || contentId,
    title: `${marker}标题`,
    transcripts: [
      {
        ...base.transcripts[0],
        segments: [{ id: 's0', startMs: 0, endMs: 1000, text: `${marker}字幕片段内容` }],
        plainText: `${marker}字幕片段内容`,
      },
    ],
  };
}

/** 两张卡的分享消息：shareRef 前 12 字符（旧短引用口径）完全相同 → 短引用必然歧义。 */
const DUAL = {
  idA: 'bilibili:public:AAA',
  idB: 'bilibili:public:BBB',
  refA: 'shr_0123456789aa' + 'a'.repeat(20),
  refB: 'shr_0123456789bb' + 'b'.repeat(20),
  urlA: 'https://a.example/1',
  urlB: 'https://b.example/2',
};

function dualCardMessage() {
  const content = `看 ${DUAL.urlA} 和 ${DUAL.urlB} 讲什么？`;
  const mk = (shareRef: string, contentId: string, url: string, messageId: string): ShareAttachment =>
    attachment({
      shareRef,
      contentId,
      messageId,
      originalUrl: url,
      resolvedUrl: url,
      canonicalUrl: url,
      openUrl: url,
      occurrenceSpans: [{ start: content.indexOf(url), end: content.indexOf(url) + url.length }],
      preview: { ...attachment().preview!, title: `${shareRef.slice(14, 16)}标题` },
      contextProjection: { ...attachment().contextProjection!, shareRef, contentId, contentRevision: 3 },
    });
  return {
    id: 201,
    charId: 'char-1',
    role: 'user' as const,
    type: 'text' as const,
    content,
    timestamp: 10,
    metadata: {
      shares: {
        version: 1,
        attachments: [mk(DUAL.refA, DUAL.idA, DUAL.urlA, '101'), mk(DUAL.refB, DUAL.idB, DUAL.urlB, '102')],
      },
    },
  };
}

/** 内存版 metadata 存档：行为与 DB.updateMessageMetadata + attachShareExcerptPairs 一致。 */
function memoryStore() {
  const store = new Map<number, any>();
  const writes: Array<{ id: number; ids: string[] }> = [];
  const saver = async (id: number, records: readonly any[]) => {
    writes.push({ id, ids: records.map((r) => r.toolCallId) });
    store.set(id, attachShareExcerptPairs(store.get(id), records));
  };
  return { store, writes, saver };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('read_share_excerpts · 工具声明', () => {
  it('schema 只暴露 shareRef/contentId/query/fields/partKey/cursor/maxTokens/contentRevision，不含任何地址/凭据字段', () => {
    const tool = buildShareExcerptsTool();
    expect(tool.type).toBe('function');
    expect(tool.function.name).toBe(SHARE_EXCERPTS_TOOL_NAME);
    const props = Object.keys(tool.function.parameters.properties as Record<string, unknown>).sort();
    expect(props).toEqual(
      ['contentId', 'contentRevision', 'cursor', 'fields', 'maxTokens', 'partKey', 'query', 'shareRef'].sort(),
    );
    for (const forbidden of ['url', 'baseUrl', 'token', 'scope', 'endpoint']) {
      expect(props).not.toContain(forbidden);
    }
    expect(tool.function.parameters.additionalProperties).toBe(false);
  });

  it('只有「能读」的卡才算可注入：失败/解析中的卡不算', () => {
    const readable = createShareExcerptTurn([userMessage()], { endpoint })!;
    expect(hasReadableShareExcerptTarget(readable)).toBe(true);
    const failed = createShareExcerptTurn([userMessage(attachment({ state: 'failed' }))], { endpoint })!;
    expect(hasReadableShareExcerptTarget(failed)).toBe(false);
    expect(hasReadableShareExcerptTarget(null)).toBe(false);
  });

  it('只有分享卡不在场时返回 null（不注入工具 = 旧行为）', () => {
    expect(createShareExcerptTurn([{ metadata: undefined }], { endpoint })).toBeNull();
    expect(createShareExcerptTurn([], { endpoint })).toBeNull();
  });
});

describe('read_share_excerpts · 真实链路（fixture 模型 + 真实 excerpts 服务逻辑）', () => {
  it('分享卡在场 → schema → 模型调用 → HTTP excerpts → tool result → 下一跳请求 → 最终回复', async () => {
    const { calls } = stubShareServer();
    const user = userMessage();

    // 1) 卡在上下文里，且投影是 shareRef + 简介（模型看不到原始长链接里的大段正文）
    const projection = normalizeMessageContent(user as any, '角色', '我');
    // 模型可见标识就是它之后要拿去调工具的那个值（完整 shareRef）——从真实投影里取，不另起一份。
    const visibleShareRef = /\[分享 ([^\]\s]+)\]/.exec(projection)?.[1] ?? '';
    expect(visibleShareRef).toBe(SHARE_REF);
    expect(projection).toContain(`[分享 ${SHARE_REF}]`);
    expect(projection).toContain('简介：');

    // 2) 工具注入：有卡才建 turn；schema 来自本模块
    const turn = makeTurn([user]);
    expect(turn.targets.size).toBe(1);
    const tools = [buildShareExcerptsTool()];
    expect(tools[0].function.name).toBe(SHARE_EXCERPTS_TOOL_NAME);

    // 3) fixture 模型第一跳：要求读字幕
    const modelTurn1 = {
      role: 'assistant' as const,
      content: '我看看字幕说了什么',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          // 模型只能照抄上下文里看到的引用 → 直接用投影里提取出的那个值（不偷看 metadata 的完整 ID）
          function: { name: SHARE_EXCERPTS_TOOL_NAME, arguments: JSON.stringify({ shareRef: visibleShareRef, fields: ['transcript'] }) },
        },
      ],
    };
    const loopMessages: any[] = [
      { role: 'system', content: 'you are a character' },
      { role: 'user', content: projection },
      modelTurn1,
    ];

    // 4) 执行器真的发出请求（走 fetchShareExcerpts 的 URL/请求体契约）
    const outcome = await executeShareExcerptToolCall({ toolCall: modelTurn1.tool_calls[0], turn });
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/agent/v1/social/items/${encodeURIComponent(CONTENT_ID)}/excerpts`);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].token).toBe(TOKEN);
    expect(calls[0].body.contentRevision).toBe(3); // 卡片版本，不是模型给的
    expect(calls[0].body.maxTokens).toBe(
      SHARE_EXCERPT_LIMITS.perCallTokens - SHARE_EXCERPT_LIMITS.envelopeTokens - SHARE_EXCERPT_LIMITS.serverSegmentOvershootTokens,
    );

    // 5) 结果里是真实切片文本（来自服务端 buildExcerpts 处理夹具内容）
    expect(outcome.text).toContain('第一段字幕');
    expect(outcome.text).toContain('transcript');
    expect(outcome.text).toContain('可续读：cursor=');
    expect(outcome.chargedTokens).toBeLessThanOrEqual(SHARE_EXCERPT_LIMITS.perCallTokens);

    // 6) tool result 与 call 成对（同一 tool_call_id）
    const toolMsg = buildToolResultMessage(modelTurn1.tool_calls[0], outcome.text);
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.tool_call_id).toBe('call_1');
    loopMessages.push(toolMsg);

    // 7) 下一跳请求（投影）里成对存在 assistant.tool_calls + role:tool
    const assistantIdx = loopMessages.findIndex((m) => Array.isArray(m.tool_calls));
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(loopMessages[assistantIdx + 1].role).toBe('tool');
    expect(loopMessages[assistantIdx + 1].tool_call_id).toBe(loopMessages[assistantIdx].tool_calls[0].id);

    // 8) fixture 模型第二跳：拿着片段给最终回复
    const finalReply = { role: 'assistant' as const, content: `字幕里说：${'第一段字幕'}` };
    expect(finalReply.content).toContain('第一段字幕');

    // 9) 落历史：call/result 成对进 metadata，下一轮投影读得回来（不是孤立片段）
    let stored: any = null;
    const db = {
      updateMessageMetadata: async (_id: number, updater: (prev: any) => any) => {
        stored = updater(stored);
      },
    };
    await db.updateMessageMetadata(10, (prev: any) => attachShareExcerptPairs(prev, turn.calls));
    expect(stored[SHARE_EXCERPT_META_KEY]).toBeDefined();
    const pair = stored[SHARE_EXCERPT_META_KEY].pairs[0];
    expect(pair.call.toolCallId).toBe('call_1');
    expect(pair.call.args.shareRef).toBe(visibleShareRef);
    expect(pair.result.text).toContain('第一段字幕');

    const nextRound = normalizeMessageContent(
      { id: 10, charId: 'char-1', role: 'assistant', type: 'text', content: finalReply.content, timestamp: 20, metadata: stored } as any,
      '角色',
      '我',
    );
    expect(nextRound).toContain('read_share_excerpts 记录');
    expect(nextRound).toContain(SHARE_REF);
    expect(nextRound).toContain('第一段字幕');
  });

  it('contentId 也能定位同一张卡，且版本以卡片为准（模型传错版本不影响）', async () => {
    const { calls } = stubShareServer();
    const turn = makeTurn();
    const { outcome } = await runToolCall(turn, { contentId: CONTENT_ID, contentRevision: 999, fields: ['transcript'] });
    expect(outcome.ok).toBe(true);
    expect(calls[0].body.contentRevision).toBe(3);
  });

  it('服务端 VERSION_UNAVAILABLE / CONTENT_NOT_FOUND 如实返回结构化失败，并要求基于简介回答', async () => {
    stubShareServer(null); // 404 CONTENT_NOT_FOUND
    const turnMissing = makeTurn();
    const missing = await runToolCall(turnMissing, { shareRef: SHARE_REF });
    expect(missing.outcome.ok).toBe(false);
    expect(missing.outcome.code).toBe('CONTENT_NOT_FOUND');
    expect(missing.outcome.text).toContain('不要声称自己读过');

    const versionedTurn = createShareExcerptTurn([userMessage(attachment({
      contextProjection: { ...attachment().contextProjection!, contentRevision: 99 },
    }))], { endpoint, now: () => 1_000 })!;
    stubShareServer(contentRecord({ contentRevision: 3 }));
    const stale = await runToolCall(versionedTurn, { shareRef: SHARE_REF });
    expect(stale.outcome.ok).toBe(false);
    expect(stale.outcome.code).toBe('VERSION_UNAVAILABLE');
    expect(stale.outcome.text).toContain('基于这张分享卡里已有的简介回答');
  });
});

describe('read_share_excerpts · 预算（单次/轮次/并发）', () => {
  it('模型传入的 maxTokens 不被信任：夹紧到单次 1200', async () => {
    const { calls } = stubShareServer();
    const turn = makeTurn();
    const { outcome } = await runToolCall(turn, { shareRef: SHARE_REF, fields: ['transcript'], maxTokens: 999999 });
    expect(outcome.ok).toBe(true);
    expect(calls[0].body.maxTokens).toBe(
      SHARE_EXCERPT_LIMITS.perCallTokens - SHARE_EXCERPT_LIMITS.envelopeTokens - SHARE_EXCERPT_LIMITS.serverSegmentOvershootTokens,
    );
    expect(outcome.chargedTokens).toBeLessThanOrEqual(SHARE_EXCERPT_LIMITS.perCallTokens);
  });

  it('单次收费按自身保守口径重算，不用服务端自报 tokenEstimate', async () => {
    stubShareServer();
    const turn = makeTurn();
    const { outcome } = await runToolCall(turn, { shareRef: SHARE_REF, fields: ['transcript'] });
    // 自己算的：结果全文码点数 = chargedTokens（保守口径，每码点 1 token）
    expect(outcome.chargedTokens).toBe(estimateTokens(outcome.text));
    expect(turn.budget.snapshot().spent).toBe(outcome.chargedTokens);
  });

  it('用户轮次累计不超过 2400：读满两屏后继续读会被拒，且不再发请求', async () => {
    const { calls } = stubShareServer();
    const turn = makeTurn();

    const first = await runToolCall(turn, { shareRef: SHARE_REF, fields: ['transcript'] }, 'call_1');
    expect(first.outcome.ok).toBe(true);
    const cursor = first.outcome.text.match(/cursor=([A-Za-z0-9_-]+)/)?.[1];
    expect(cursor, '第一次应给出 nextCursor').toBeTruthy();

    const second = await runToolCall(turn, { shareRef: SHARE_REF, fields: ['transcript'], cursor }, 'call_2');
    expect(second.outcome.ok).toBe(true);

    let okCount = 2;
    let refused: Awaited<ReturnType<typeof runToolCall>> | null = null;
    for (let i = 0; i < 6; i++) {
      const next = await runToolCall(turn, { shareRef: SHARE_REF, fields: ['transcript'], query: `第${['一', '二', '三', '四', '五', '六'][i]}段` }, `call_x${i}`);
      if (!next.outcome.ok && next.outcome.code === 'TURN_BUDGET_EXHAUSTED') {
        refused = next;
        break;
      }
      if (next.outcome.ok) okCount += 1;
    }
    expect(refused, '预算应最终被耗尽').not.toBeNull();
    expect(refused!.outcome.text).toContain('本轮片段预算已用尽');
    expect(refused!.outcome.text).toContain('不要声称自己读过');

    const snapshot = turn.budget.snapshot();
    expect(snapshot.spent).toBeLessThanOrEqual(SHARE_EXCERPT_LIMITS.perTurnTokens);
    expect(snapshot.spent).toBe(turn.calls.filter((c) => c.ok).reduce((sum, c) => sum + c.chargedTokens, 0));
    // 被拒的那次不产生 HTTP 请求
    expect(calls.length).toBe(okCount);
  });

  it('并发调用不会超卖轮次预算', async () => {
    const { calls } = stubShareServer();
    const turn = makeTurn();
    const [a, b, c] = await Promise.all([
      runToolCall(turn, { shareRef: SHARE_REF, fields: ['transcript'] }, 'call_1'),
      runToolCall(turn, { shareRef: SHARE_REF, fields: ['transcript'], query: '第二段' }, 'call_2'),
      runToolCall(turn, { shareRef: SHARE_REF, fields: ['transcript'], query: '第三段' }, 'call_3'),
    ]);
    const oks = [a, b, c].filter((r) => r.outcome.ok);
    const charged = oks.reduce((sum, r) => sum + r.outcome.chargedTokens, 0);
    expect(charged).toBeLessThanOrEqual(SHARE_EXCERPT_LIMITS.perTurnTokens);
    expect(charged).toBe(turn.budget.snapshot().spent);
    expect(calls.length).toBe(oks.length);
    // 三轮各 1200 的申请不可能都成功
    expect(oks.length).toBeLessThanOrEqual(2);
  });

  it('预算只能往下调：构造器不接受超过契约上限的值', () => {
    const budget = new ShareExcerptBudget({ perCallTokens: 5000, perTurnTokens: 9000 });
    expect(budget.perCall).toBe(SHARE_EXCERPT_LIMITS.perCallTokens);
    expect(budget.perTurn).toBe(SHARE_EXCERPT_LIMITS.perTurnTokens);

    const small = new ShareExcerptBudget({ perTurnTokens: 600 });
    const grant = small.reserve(1200);
    expect(grant.ok).toBe(true);
    if (grant.ok) expect(grant.grant).toBe(600);
  });

  it('剩余额度小到放不下一条切片时直接拒绝，而不是发一次空请求', async () => {
    stubShareServer();
    const turn = makeTurn([userMessage()], { budget: new ShareExcerptBudget({ perTurnTokens: 600 }) });
    await runToolCall(turn, { shareRef: SHARE_REF, fields: ['transcript'] }, 'call_1');
    const second = await runToolCall(turn, { shareRef: SHARE_REF, fields: ['transcript'], query: '第四段' }, 'call_2');
    expect(second.outcome.ok).toBe(false);
    expect(second.outcome.code).toBe('TURN_BUDGET_EXHAUSTED');
  });
});

describe('read_share_excerpts · 权限与入参边界', () => {
  it('模型不能指定 URL/baseUrl/token/scope：命中即拒绝且一次请求都不发', async () => {
    const { calls } = stubShareServer();
    const turn = makeTurn();
    for (const bad of [
      { shareRef: SHARE_REF, url: 'https://evil.example.com/v1/x' },
      { shareRef: SHARE_REF, baseUrl: 'https://evil.example.com' },
      { shareRef: SHARE_REF, token: 'stolen' },
      { shareRef: SHARE_REF, scope: 'someone-else' },
    ]) {
      const { outcome } = await runToolCall(turn, bad);
      expect(outcome.ok).toBe(false);
      expect(outcome.code).toBe('ARGUMENT_NOT_ALLOWED');
    }
    expect(calls).toHaveLength(0);
  });

  it('集合外的 shareRef/contentId 一律拒绝（不让模型指向任意网络位置）', async () => {
    const { calls } = stubShareServer();
    const turn = makeTurn();
    const byRef = await runToolCall(turn, { shareRef: 'shr_ffffffffffffffff' });
    const byContent = await runToolCall(turn, { contentId: 'bilibili:public:BV9zzzz' });
    expect(byRef.outcome.code).toBe('SHARE_NOT_IN_CONTEXT');
    expect(byContent.outcome.code).toBe('SHARE_NOT_IN_CONTEXT');
    expect(calls).toHaveLength(0);
  });

  it('shareRef 与 contentId 指向不同卡时拒绝', async () => {
    const { calls } = stubShareServer();
    const turn = makeTurn();
    const { outcome } = await runToolCall(turn, { shareRef: SHARE_REF, contentId: 'bilibili:public:OTHER' });
    expect(outcome.code).toBe('SHARE_TARGET_MISMATCH');
    expect(calls).toHaveLength(0);
  });

  it('卡片没读到内容（failed）时不发请求，如实说没有片段', async () => {
    const { calls } = stubShareServer();
    const failedCard = attachment({ state: 'failed', contentId: CONTENT_ID, contextProjection: null });
    const turn = createShareExcerptTurn([userMessage(failedCard)], { endpoint, now: () => 1_000 })!;
    const { outcome } = await runToolCall(turn, { shareRef: SHARE_REF });
    expect(outcome.code).toBe('SHARE_CONTENT_NOT_READY');
    expect(calls).toHaveLength(0);
  });

  it('cursor 只能原样复用 nextCursor：带 URL 的 cursor 被拒', async () => {
    stubShareServer();
    const turn = makeTurn();
    const bad = await runToolCall(turn, { shareRef: SHARE_REF, cursor: 'https://evil.example.com/x' });
    expect(bad.outcome.code).toBe('INVALID_CURSOR');
    const good = await runToolCall(turn, { shareRef: SHARE_REF, fields: ['transcript'], cursor: 'i2' });
    expect(good.outcome.ok).toBe(true);
  });

  it('同一组参数重复调用不重复花钱、也不重复打网络', async () => {
    const { calls } = stubShareServer();
    const turn = makeTurn();
    const first = await runToolCall(turn, { shareRef: SHARE_REF, fields: ['transcript'] }, 'call_1');
    const again = await runToolCall(turn, { shareRef: SHARE_REF, fields: ['transcript'] }, 'call_2');
    expect(first.outcome.ok).toBe(true);
    expect(again.outcome.ok).toBe(false);
    expect(again.outcome.code).toBe('DUPLICATE_TOOL_CALL');
    expect(calls).toHaveLength(1);
    expect(turn.budget.snapshot().spent).toBe(first.outcome.chargedTokens);
  });

  it('失败后允许同参重试（去重只挡「已经成功读过」的组合）', async () => {
    let attempt = 0;
    const record = contentRecord();
    vi.stubGlobal('fetch', vi.fn(async (_input: any, init?: any) => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('network down');
      const body = JSON.parse(String(init?.body));
      const result = buildExcerpts(record, {
        contentRevision: Number(body.contentRevision),
        query: null,
        fields: body.fields,
        partKey: null,
        cursor: null,
        maxTokens: Number(body.maxTokens) || 0,
      });
      return new Response(JSON.stringify(result), { status: 200 });
    }));
    const turn = makeTurn();
    const first = await runToolCall(turn, { shareRef: SHARE_REF, fields: ['transcript'] }, 'call_1');
    expect(first.outcome.ok).toBe(false);
    expect(first.outcome.code).toBe('NETWORK_ERROR');
    const retry = await runToolCall(turn, { shareRef: SHARE_REF, fields: ['transcript'] }, 'call_2');
    expect(retry.outcome.ok).toBe(true);
    expect(attempt).toBe(2);
    expect(turn.budget.snapshot().spent).toBe(retry.outcome.chargedTokens);
  });

  it('本轮调用次数有硬顶，且空匹配如实返回 NO_SEGMENTS（不算失败、也不假装读过）', async () => {
    stubShareServer();
    const turn = makeTurn();
    for (let i = 0; i < SHARE_EXCERPT_LIMITS.maxToolCallsPerTurn; i++) {
      const r = await runToolCall(turn, { shareRef: SHARE_REF, query: `不存在的词${i}` }, `call_${i}`);
      expect(r.outcome.ok).toBe(true);
      expect(r.outcome.code).toBe('NO_SEGMENTS');
      expect(r.outcome.text).toContain('没有可返回的片段');
    }
    const over = await runToolCall(turn, { shareRef: SHARE_REF, query: 'over' }, 'call_over');
    expect(over.outcome.code).toBe('TOOL_CALL_LIMIT');
  });
});

describe('read_share_excerpts · 可见标识 = 可执行标识（返工 P1 第 1 条）', () => {
  it('投影里给的是完整 shareRef：两张卡同前缀也不会出现「看着一样」的引用', () => {
    const msg = dualCardMessage();
    const projection = normalizeMessageContent(msg as any, '角色', '我');
    const visible = new Set([...projection.matchAll(/\[分享 ([^\]\s]+)\]/g)].map((m) => m[1]));
    expect(visible).toEqual(new Set([DUAL.refA, DUAL.refB]));
    // 旧口径（前 12 字符）会把两张卡显示成同一个字符串，这正是要修的缺陷
    expect(DUAL.refA.slice(0, 12)).toBe(DUAL.refB.slice(0, 12));
    expect(projection).not.toContain(DUAL.refA.slice(0, 12) + ']');
  });

  it('多卡同前缀：抄短成公共前缀一律判歧义并列出候选，一次请求都不发（绝不猜一张）', async () => {
    const { calls } = stubShareServer(null, {
      [DUAL.idA]: cardRecord(DUAL.idA, 'A卡'),
      [DUAL.idB]: cardRecord(DUAL.idB, 'B卡'),
    });
    const turn = createShareExcerptTurn([dualCardMessage()], { endpoint, now: () => 1_000 })!;
    const short = DUAL.refA.slice(0, 12); // 模型抄短（旧可见值）
    const ambiguous = await runToolCall(turn, { shareRef: short, fields: ['transcript'] });
    expect(ambiguous.outcome.ok).toBe(false);
    expect(ambiguous.outcome.code).toBe('SHARE_REF_AMBIGUOUS');
    expect(ambiguous.outcome.text).toContain(DUAL.refA);
    expect(ambiguous.outcome.text).toContain(DUAL.refB);
    expect(calls).toHaveLength(0);
  });

  it('唯一前缀仍能命中，且读到的是那张卡的内容（不是同前缀的另一张）', async () => {
    const { calls } = stubShareServer(null, {
      [DUAL.idA]: cardRecord(DUAL.idA, 'A卡'),
      [DUAL.idB]: cardRecord(DUAL.idB, 'B卡'),
    });
    const turnA = createShareExcerptTurn([dualCardMessage()], { endpoint, now: () => 1_000 })!;
    const uniquePrefix = DUAL.refA.slice(0, 16); // 只属于 A
    const hitA = await runToolCall(turnA, { shareRef: uniquePrefix, fields: ['transcript'] });
    expect(hitA.outcome.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(encodeURIComponent(DUAL.idA));
    expect(hitA.outcome.text).toContain('A卡字幕片段内容');
    expect(hitA.outcome.text).not.toContain('B卡字幕片段内容');

    const turnB = createShareExcerptTurn([dualCardMessage()], { endpoint, now: () => 1_000 })!;
    const hitB = await runToolCall(turnB, { shareRef: DUAL.refB, fields: ['transcript'] });
    expect(hitB.outcome.ok).toBe(true);
    expect(calls[1].url).toContain(encodeURIComponent(DUAL.idB));
    expect(hitB.outcome.text).toContain('B卡字幕片段内容');
  });

  it('形状不对/太短/集合外的引用：结构化拒绝且不发请求', async () => {
    const { calls } = stubShareServer();
    const turn = makeTurn();
    const urlLike = await runToolCall(turn, { shareRef: 'https://evil.example.com/x' });
    const tooShort = await runToolCall(turn, { shareRef: 'shr_01' });
    const unknown = await runToolCall(turn, { shareRef: 'shr_ffffffffffffffffffffffffffffffff' });
    const partial = await runToolCall(turn, { shareRef: SHARE_REF.slice(0, 20) });
    expect(urlLike.outcome.code).toBe('SHARE_REF_INVALID');
    expect(tooShort.outcome.code).toBe('SHARE_NOT_IN_CONTEXT');
    expect(unknown.outcome.code).toBe('SHARE_NOT_IN_CONTEXT');
    expect(partial.outcome.ok).toBe(true); // 单卡时短前缀唯一命中，属容错
    expect(calls).toHaveLength(1);
  });

  it('resolveShareExcerptTarget：精确 > 唯一前缀 > 歧义/未知（纯函数口径）', () => {
    const turn = createShareExcerptTurn([dualCardMessage()], { endpoint })!;
    const exact = resolveShareExcerptTarget(turn, DUAL.refB);
    expect(exact.ok).toBe(true);
    if (exact.ok) {
      expect(exact.matched).toBe('exact');
      expect(exact.target.contentId).toBe(DUAL.idB);
    }
    const prefixed = resolveShareExcerptTarget(turn, DUAL.refA.slice(0, 18));
    expect(prefixed.ok && prefixed.matched).toBe('prefix');
    const ambiguous = resolveShareExcerptTarget(turn, DUAL.refA.slice(0, 12));
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.candidates).toEqual([DUAL.refA, DUAL.refB]);
  });
});

describe('read_share_excerpts · call/result 成对落历史（不依赖最终回复，返工 P1 第 2 条）', () => {
  it('每执行完一次工具就成对落库到本轮触发消息；之后模型失败/取消/没有助手回复都不影响', async () => {
    stubShareServer();
    const { store, writes, saver } = memoryStore();
    // 锚点 = contextMsgs 最后一条（本轮触发消息），此时库里还没有任何 assistant 回复
    const anchorId = pickShareExcerptTurnAnchor([{ id: 77 }, { id: 101 }]);
    expect(anchorId).toBe(101);
    const recorder = new ShareExcerptPairRecorder({ anchorId, savePairs: saver });
    const turn = makeTurn();

    const outcome = await dispatchShareExcerptToolCall({
      toolCall: toolCallFor({ shareRef: SHARE_REF, fields: ['transcript'] }),
      turn,
      recorder,
    });
    await recorder.flush();

    expect(outcome.ok).toBe(true);
    expect(writes).toEqual([{ id: 101, ids: [outcome.record.toolCallId] }]);
    const pairs = store.get(101)[SHARE_EXCERPT_META_KEY].pairs;
    expect(pairs).toHaveLength(1);
    expect(pairs[0].call.toolCallId).toBe(outcome.record.toolCallId);
    expect(pairs[0].call.args.shareRef).toBe(SHARE_REF);
    expect(pairs[0].result.ok).toBe(true);
    expect(pairs[0].result.text).toContain('第一段字幕');
    expect(recorder.snapshot()).toMatchObject({ anchorId: 101, recorded: 1, failures: 0, pendingWrites: 0 });

    // 下一轮真的读得回来：挂在触发消息（user）上也要投影
    const nextRound = normalizeMessageContent(
      { id: 101, charId: 'char-1', role: 'user', type: 'text', content: '看这个', timestamp: 10, metadata: store.get(101) } as any,
      '角色',
      '我',
    );
    expect(nextRound).toContain('read_share_excerpts 记录');
    expect(nextRound).toContain('第一段字幕');
  });

  it('取消 / 网络失败的调用也成对留存（不是只留成功的）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }));
    const { store, saver } = memoryStore();
    const recorder = new ShareExcerptPairRecorder({ anchorId: 101, savePairs: saver });
    const turn = makeTurn();
    const outcome = await dispatchShareExcerptToolCall({
      toolCall: toolCallFor({ shareRef: SHARE_REF }),
      turn,
      recorder,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('TIMEOUT'); // 用户取消/中断走的就是这条
    const pairs = store.get(101)[SHARE_EXCERPT_META_KEY].pairs;
    expect(pairs).toHaveLength(1);
    expect(pairs[0].call.args.shareRef).toBe(SHARE_REF);
    expect(pairs[0].result.ok).toBe(false);
    expect(pairs[0].result.code).toBe('TIMEOUT');
    expect(recorder.snapshot().recorded).toBe(1);
  });

  it('两轮并发各写各自的触发消息：同 toolCallId 也不串轮、不互相覆盖', async () => {
    stubShareServer(null, {
      [DUAL.idA]: cardRecord(DUAL.idA, 'A卡'),
      [DUAL.idB]: cardRecord(DUAL.idB, 'B卡'),
    });
    const { store, saver } = memoryStore();
    const msgA = { id: 301, metadata: { shares: { version: 1, attachments: [dualCardMessage().metadata.shares.attachments[0]] } }, role: 'user', type: 'text', content: 'A', charId: 'c' };
    const msgB = { id: 302, metadata: { shares: { version: 1, attachments: [dualCardMessage().metadata.shares.attachments[1]] } }, role: 'user', type: 'text', content: 'B', charId: 'c' };
    const turnA = createShareExcerptTurn([msgA], { endpoint, now: () => 1_000 })!;
    const turnB = createShareExcerptTurn([msgB], { endpoint, now: () => 1_000 })!;
    const recA = new ShareExcerptPairRecorder({ anchorId: pickShareExcerptTurnAnchor([msgA]), savePairs: saver });
    const recB = new ShareExcerptPairRecorder({ anchorId: pickShareExcerptTurnAnchor([msgB]), savePairs: saver });

    await Promise.all([
      dispatchShareExcerptToolCall({ toolCall: toolCallFor({ shareRef: DUAL.refA, fields: ['transcript'] }, 'call_1'), turn: turnA, recorder: recA }),
      dispatchShareExcerptToolCall({ toolCall: toolCallFor({ shareRef: DUAL.refB, fields: ['transcript'] }, 'call_1'), turn: turnB, recorder: recB }),
    ]);

    const pairsA = store.get(301)[SHARE_EXCERPT_META_KEY].pairs;
    const pairsB = store.get(302)[SHARE_EXCERPT_META_KEY].pairs;
    expect(pairsA).toHaveLength(1);
    expect(pairsB).toHaveLength(1);
    expect(pairsA[0].call.args.shareRef).toBe(DUAL.refA);
    expect(pairsA[0].result.text).toContain('A卡字幕片段内容');
    expect(pairsA[0].result.text).not.toContain('B卡字幕片段内容');
    expect(pairsB[0].call.args.shareRef).toBe(DUAL.refB);
    expect(pairsB[0].result.text).toContain('B卡字幕片段内容');
  });

  it('幂等：同一批记录重复提交只写一次，落库侧也按 toolCallId 去重（DB 重试不产生重复对）', async () => {
    stubShareServer();
    const { store, writes, saver } = memoryStore();
    const recorder = new ShareExcerptPairRecorder({ anchorId: 101, savePairs: saver });
    const turn = makeTurn();
    const outcome = await dispatchShareExcerptToolCall({
      toolCall: toolCallFor({ shareRef: SHARE_REF, fields: ['transcript'] }),
      turn,
      recorder,
    });
    await recorder.record([outcome.record]); // 收尾 flush 又提交同一批
    await recorder.record(turn.calls);
    expect(writes).toHaveLength(1);
    expect(store.get(101)[SHARE_EXCERPT_META_KEY].pairs).toHaveLength(1);

    // 落库侧重放同一批：attach 自己也要按 id 去重
    const replayed = attachShareExcerptPairs(store.get(101), [outcome.record, outcome.record]);
    expect(replayed[SHARE_EXCERPT_META_KEY].pairs).toHaveLength(1);
  });

  it('落库失败不阻断工具结果，失败批次不标记已写（重试能补上）', async () => {
    stubShareServer();
    // 这条路径本来就会 console.warn（失败的可见信号），测试里静音以免污染输出
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let attempts = 0;
    const store = new Map<number, any>();
    const saver = async (id: number, records: readonly any[]) => {
      attempts += 1;
      if (attempts === 1) throw new Error('IDB quota');
      store.set(id, attachShareExcerptPairs(store.get(id), records));
    };
    const recorder = new ShareExcerptPairRecorder({ anchorId: 101, savePairs: saver });
    const turn = makeTurn();
    const outcome = await dispatchShareExcerptToolCall({
      toolCall: toolCallFor({ shareRef: SHARE_REF, fields: ['transcript'] }),
      turn,
      recorder,
    });
    // 工具结果照常给模型（落库失败只影响下一轮回放）
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('第一段字幕');
    expect(recorder.snapshot()).toMatchObject({ recorded: 0, failures: 1 });
    expect(recorder.has(outcome.record.toolCallId)).toBe(false);

    await recorder.record([outcome.record]); // 重试同一批
    expect(recorder.has(outcome.record.toolCallId)).toBe(true);
    expect(attempts).toBe(2);
    expect(store.get(101)[SHARE_EXCERPT_META_KEY].pairs).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('写入串行化：并发 record 的 read-modify-write 不互相覆盖', async () => {
    const store = new Map<number, any>();
    let inFlight = 0;
    let maxInFlight = 0;
    const saver = async (id: number, records: readonly any[]) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const prev = store.get(id);
      await new Promise((r) => setTimeout(r, 5));
      store.set(id, attachShareExcerptPairs(prev, records));
      inFlight -= 1;
    };
    const recorder = new ShareExcerptPairRecorder({ anchorId: 5, savePairs: saver });
    const record = (id: string) => ({
      toolCallId: id,
      name: SHARE_EXCERPTS_TOOL_NAME,
      args: {},
      ok: true,
      code: 'OK',
      chargedTokens: 1,
      at: 1,
      resultText: 'x',
    });
    await Promise.all([recorder.record([record('a')]), recorder.record([record('b')])]);
    expect(maxInFlight).toBe(1);
    expect(store.get(5)[SHARE_EXCERPT_META_KEY].pairs.map((p: any) => p.call.toolCallId)).toEqual(['a', 'b']);
  });

  it('拿不到本轮触发消息 id 时不写、也不挂到别的消息上（宁缺勿错挂）', async () => {
    stubShareServer();
    const { store, writes, saver } = memoryStore();
    const recorder = new ShareExcerptPairRecorder({ anchorId: null, savePairs: saver });
    const turn = makeTurn();
    const outcome = await dispatchShareExcerptToolCall({
      toolCall: toolCallFor({ shareRef: SHARE_REF }),
      turn,
      recorder,
    });
    expect(outcome.ok).toBe(true);
    expect(writes).toHaveLength(0);
    expect(store.size).toBe(0);
    expect(pickShareExcerptTurnAnchor([{}, { id: 'oops' }, { id: null }])).toBeNull();
  });
});

describe('read_share_excerpts · 落历史与下一轮投影', () => {
  it('成对记录：call 与 result 一一对应，投影只回放成对块且有界', () => {
    const records = [
      {
        toolCallId: 'call_a',
        name: SHARE_EXCERPTS_TOOL_NAME,
        args: { shareRef: SHARE_REF, fields: ['transcript'] },
        ok: true,
        code: 'OK',
        chargedTokens: 120,
        at: 1,
        resultText: '[read_share_excerpts · OK] header\n1. transcript：第一段字幕内容',
      },
      {
        toolCallId: 'call_b',
        name: SHARE_EXCERPTS_TOOL_NAME,
        args: { shareRef: SHARE_REF, fields: ['comments'] },
        ok: false,
        code: 'TURN_BUDGET_EXHAUSTED',
        chargedTokens: 0,
        at: 2,
        resultText: '[read_share_excerpts · 未读取] code=TURN_BUDGET_EXHAUSTED: 预算用尽\n不要声称自己读过',
      },
    ];
    const meta = attachShareExcerptPairs({ existing: 'keep-me' }, records);
    expect(meta.existing).toBe('keep-me');
    const pairs = meta.shareExcerpts.pairs;
    expect(pairs).toHaveLength(2);
    expect(pairs[0].call.toolCallId).toBe('call_a');
    expect(pairs[0].result.ok).toBe(true);
    expect(pairs[1].result.code).toBe('TURN_BUDGET_EXHAUSTED');

    const projection = renderShareExcerptPairProjection(meta, 'assistant', { maxTokens: 600 })!;
    expect(projection).toContain('2 次调用');
    expect(projection).toContain('call_a');
    expect(projection).toContain('第一段字幕内容');
    expect(projection).toContain('TURN_BUDGET_EXHAUSTED');
    expect(Array.from(projection).length).toBeLessThanOrEqual(600 + 80); // 标题/说明行不超预算太多

    // 记录挂在「本轮触发消息」上（正常是用户消息）→ user 角色必须投影；system/tool 不背
    expect(renderShareExcerptPairProjection(meta, 'user')).not.toBeNull();
    expect(renderShareExcerptPairProjection(meta, 'system')).toBeNull();
    expect(renderShareExcerptPairProjection(meta, 'tool')).toBeNull();
    // 没记录就没有投影
    expect(renderShareExcerptPairProjection({}, 'assistant')).toBeNull();
  });

  it('锚点 = 本轮触发消息（contextMsgs 最后一条），与最终回复是否落库无关', () => {
    // 正常用户轮：contextMsgs 结尾就是那条刚落库的用户消息，此刻还没有 assistant 回复
    expect(pickShareExcerptTurnAnchor([{ id: 1 }, { id: 2, role: 'user' }, { id: 3, role: 'user' }])).toBe(3);
    // 主动消息/无最终回复的轮次：结尾可能是上一条 assistant，同样能定位到确定的消息
    expect(pickShareExcerptTurnAnchor([{ id: 8, role: 'user' }, { id: 9, role: 'assistant' }])).toBe(9);
    expect(pickShareExcerptTurnAnchor([])).toBeNull();
    expect(pickShareExcerptTurnAnchor(null)).toBeNull();
    // 尾部系统提示不抢占锚点（system 角色不投影，锚在它身上等于白存）
    expect(pickShareExcerptTurnAnchor([{ id: 5, role: 'user' }, { id: 6, role: 'system' }])).toBe(5);
    expect(pickShareExcerptTurnAnchor([{}, { id: 'oops' }, { id: 0 }, { id: -1 }])).toBeNull();
  });
});
