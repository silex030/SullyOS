/**
 * 交付链回归（返工 t_42231e16 · 缺陷 1 + 缺陷 3）。
 *
 * 这里刻意**不手造完整附件**：串的是真实代码路径
 *   真实 service（真实 SQLite 状态机 + 真实 content 库）
 *   → 真实客户端 HTTP 代码（utils/socialShare.shareRequest：endpoint/header/JSON）
 *   → Chat.tsx 同款的 metadata.shares
 *   → 下一轮投影（utils/socialShare.buildShareMessageProjection）
 *   → read_share_excerpts 注入判定与执行（utils/socialShareTool）
 *   → 真实 excerpts（worker/social-content/excerpts.buildExcerpts）。
 *
 * 网络边界：fetch 被替换成“把请求交给本进程 service”的桩，不连真实网络；但请求体、
 * 状态码、响应体全部由真实代码生成，差别只在传输层（没有 socket/Caddy/鉴权反代）。
 * 适配器仍是夹具——平台是否真的可达见 docs/social-content/integration-v1.md §5，
 * 本文件不声称任何平台真实接通。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSocialService, withContentPersistence } from './service';
import { D1SocialStore } from './store';
import { openTestD1 } from './testDb';
import { readSocialConfig } from './config';
import { buildRecord } from '../record';
import type { ContentAdapter } from '../adapter';
import type { ContentRecord, ShareAttachment, Transcript } from '../../../utils/socialContent/types';
import {
  EXTERNAL_BLOCK_CLOSE,
  EXTERNAL_UNTRUSTED_NOTICE,
  buildShareMessageProjection,
  mergeShareAttachments,
  resolveSharesForMessage,
} from '../../../utils/socialShare';
import {
  createShareExcerptTurn,
  executeShareExcerptToolCall,
  hasReadableShareExcerptTarget,
} from '../../../utils/socialShareTool';
import { boundedProjection, PROJECTION_DELIVERY_LIMITS } from './delivery';

const NOW = 1_790_000_000_000;
const BV = 'BV1xx411c7mD';
const BASE = 'https://os.example.com';
const ENDPOINT = { base: BASE, token: 'client-token' };
/** 正文第一段要够长（>180 字），保证本地简介只覆盖第一段，检索锚点留在正文深处。 */
const LONG_TEXT = [
  '第一段正文：浏览器里的虚拟手机系统，分享链接后角色看到的是有界简介而不是全文。'.repeat(8),
  '第二段正文：这里放一个检索锚点-ZQ-MARKER，用来验证按需检索真的读到了正文深处。',
  '第三段正文：只有按需检索才会把这一段交给模型。',
].join('\n\n');
const DEEP_MARKER = 'ZQ-MARKER';

function record(over: Partial<Parameters<typeof buildRecord>[0]> = {}): ContentRecord {
  return buildRecord({
    platform: 'bilibili',
    sourceId: 'public',
    externalId: BV,
    author: { id: '1', name: '夹具UP主', avatarUrl: null, profileUrl: null },
    title: '交付链夹具标题',
    text: LONG_TEXT,
    images: [],
    canonicalUrl: `https://www.bilibili.com/video/${BV}`,
    publishedAt: NOW - 1000,
    fetchedAt: NOW,
    platformName: 'B站',
    retrievalMethod: 'fixture',
    ...over,
  });
}

function adapterFor(next: () => ContentRecord): ContentAdapter & { calls: number } {
  const adapter = {
    id: 'fake',
    platform: 'bilibili' as const,
    version: 'test',
    capabilities: { detail: true, comments: true, shortLink: true, transcript: true },
    calls: 0,
    async health() {
      return { status: 'configured' as const, note: 'test' };
    },
    async expandShortLink(url: string) {
      return { platform: 'bilibili' as const, externalId: BV, partKey: null, canonicalUrl: url, resolvedUrl: url };
    },
    async fetchContent() {
      adapter.calls += 1;
      return next();
    },
  };
  return adapter as unknown as ContentAdapter & { calls: number };
}

function build(next: () => ContentRecord = () => record()) {
  const db = openTestD1();
  const store = new D1SocialStore(db as never);
  const config = readSocialConfig({ SHARE_LINKS_ENABLED: 'true' } as never);
  const adapter = adapterFor(next);
  const service = createSocialService({
    config,
    store,
    adapters: { bilibili: withContentPersistence(adapter, store, { cacheAllowed: true }) },
    sourceIdFor: () => 'public',
    now: () => NOW,
  });
  return { db, store, service, adapter, scope: config.deploymentScope };
}

/**
 * 把浏览器端的 fetch 换成“请求交给真实 service”的桩。
 * 走的是 utils/socialShare.shareRequest 的真实拼 URL / header / JSON.parse 路径。
 */
function stubServiceFetch(service: ReturnType<typeof createSocialService>, scope: string) {
  const seen: Array<{ url: string; method: string; body: any; token: string | null }> = [];
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(typeof input === 'string' ? input : input?.url ?? input);
    const headers = new Headers(init?.headers || {});
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    seen.push({ url, method: String(init?.method || 'GET'), body, token: headers.get('x-client-token') });

    if (/\/agent\/v1\/social\/shares\/resolve$/.test(url)) {
      const result = await service.resolve(scope, body);
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    const excerpt = /\/agent\/v1\/social\/items\/(.+)\/excerpts$/.exec(url);
    if (excerpt) {
      const result = await service.excerpts(scope, decodeURIComponent(excerpt[1]), body);
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, seen };
}

/** Chat.tsx 的写卡形状：响应附件原样进 metadata.shares。 */
function metadataOf(attachments: ShareAttachment[]) {
  return {
    shares: {
      version: 1,
      persisting: 'available' as const,
      attachments: mergeShareAttachments(null, attachments),
      updatedAt: NOW,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const USER_TEXT = `帮我看下 https://www.bilibili.com/video/${BV} 讲了啥？`;

describe('真实响应 → 客户端 metadata → 模型投影 → 按需检索', () => {
  it('resolve 响应带回有界投影（版本/字幕语义），不返回正文；下一轮工具可注入且读得到片段', async () => {
    const { service, scope, adapter } = build(() =>
      record({
        transcripts: [
          {
            id: 'tr',
            partKey: null,
            kind: 'native_caption',
            language: 'zh-CN',
            provider: 'bilibili_native',
            availability: 'not_available',
            segments: [],
            plainText: '',
            truncated: false,
            originalLength: null,
            fetchedAt: NOW,
            sourceRef: 'bilibili:public:subtitle',
          },
        ],
      }),
    );
    const { seen } = stubServiceFetch(service, scope);

    // 1) 真实客户端代码发 resolve（不是直接调 service）
    const resolved = await resolveSharesForMessage({
      conversationId: 'char-1',
      messageId: 'msg-1',
      characterId: 'char-1',
      text: USER_TEXT,
      endpoint: ENDPOINT,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const attachments = resolved.value.attachments;
    expect(attachments).toHaveLength(1);
    const att = attachments[0];
    expect(adapter.calls).toBe(1);
    expect(att.state).toBe('ready');

    // 这是修复前会丢的东西：投影被 light() 清成 null → 客户端拿不到版本与字幕语义。
    expect(att.contextProjection).not.toBeNull();
    expect(att.contextProjection?.contentRevision).toBe(1);
    expect(att.contextProjection?.transcriptState).toBe('not_available');
    expect(att.contextProjection?.evidenceCoverage).toContain('text');
    expect(att.contextProjection?.summaryText ?? '').toContain('交付链夹具标题');
    // 仍然“轻量”：正文/字幕正文不在响应里（正文只在内容库，靠 excerpts 按需取）
    const wire = JSON.stringify(att);
    // 简介允许带第一段开头（契约 6.4 的本地摘录），但正文深处不能出现在响应里
    expect(wire).not.toContain(DEEP_MARKER);
    expect(wire).not.toContain('第三段正文');
    expect(wire.length).toBeLessThan(4000);

    // 2) 下一轮：Chat.tsx 同款 metadata → 投影与工具注入
    const metadata = metadataOf(attachments);
    const projection = buildShareMessageProjection(USER_TEXT, attachments)!;
    expect(projection).toContain('[分享 shr_');
    expect(projection).not.toContain(`https://www.bilibili.com/video/${BV}`);
    expect(projection).toContain('已读取');
    expect(projection).toContain('交付链夹具标题');
    expect(projection).toContain('字幕：平台未提供'); // 字幕语义到达模型，不再静默
    expect(projection).toContain(EXTERNAL_UNTRUSTED_NOTICE); // 外部内容低信任隔离
    expect(projection).toContain('<<<EXTERNAL_CONTENT');

    const turn = createShareExcerptTurn([{ metadata }], { endpoint: ENDPOINT });
    expect(turn).not.toBeNull();
    // 修复前：contextProjection 为 null → readable=false → 工具根本不注入。
    expect(hasReadableShareExcerptTarget(turn)).toBe(true);

    // 3) 模型调工具 → 真实 excerpts → 片段包在低信任块里、预算不超卖
    const exec = await executeShareExcerptToolCall({
      turn: turn!,
      args: { shareRef: att.shareRef, fields: ['text'], query: DEEP_MARKER, maxTokens: 900 },
    });
    expect(exec.ok).toBe(true);
    expect(exec.code).toBe('OK');
    expect(exec.text).toContain('read_share_excerpts · OK');
    expect(exec.text).toContain(EXTERNAL_UNTRUSTED_NOTICE);
    expect(exec.text).toContain('<<<EXTERNAL_CONTENT');
    expect(exec.text).toContain(EXTERNAL_BLOCK_CLOSE);
    // 真实正文片段确实回来了（来自刚才 resolve 落库的那份内容，而且是正文深处）
    expect(exec.text).toContain(DEEP_MARKER);
    expect(exec.chargedTokens).toBeLessThanOrEqual(900);
    expect(turn!.budget.remaining).toBeGreaterThan(0);
    // excerpts 请求带的是卡片里的服务端版本（模型不能编造 revision）
    const excerptCall = seen.find((c) => c.url.includes('/excerpts'));
    expect(excerptCall?.body?.contentRevision).toBe(1);
    expect(excerptCall?.body?.fields).toEqual(['text']);
    expect(excerptCall?.token).toBe('client-token');
  });

  it('字幕五态都从真实响应走到模型：available 不提示，其余四态各有降级说明', async () => {
    const caption = (availability: Transcript['availability']): Transcript => ({
      id: `tr-${availability}`,
      partKey: null,
      kind: 'native_caption',
      language: 'zh-CN',
      provider: 'bilibili_native',
      availability,
      segments: [],
      plainText: '',
      truncated: false,
      originalLength: null,
      fetchedAt: NOW,
      sourceRef: 'bilibili:public:subtitle',
    });
    const cases: Array<{
      name: string;
      transcripts: Transcript[];
      state: 'ready' | 'partial';
      transcriptState: string;
      note: string | null;
    }> = [
      { name: 'available', transcripts: [caption('available')], state: 'ready', transcriptState: 'available', note: null },
      { name: 'failed', transcripts: [caption('failed')], state: 'partial', transcriptState: 'failed', note: '字幕：获取失败' },
      { name: 'not_available', transcripts: [caption('not_available')], state: 'ready', transcriptState: 'not_available', note: '字幕：平台未提供' },
      // not_requested 只出现在「没有原生字幕轨、ASR 未开启」的形态（stateFromRecord 口径）
      {
        name: 'not_requested',
        transcripts: [{ ...caption('not_requested'), id: 'asr', kind: 'speech_transcription', provider: null }],
        state: 'ready',
        transcriptState: 'not_requested',
        note: '字幕：未开启转写',
      },
      { name: 'absent', transcripts: [], state: 'ready', transcriptState: 'absent', note: '字幕：未取得' },
    ];

    let current = record({ transcripts: cases[0].transcripts });
    const { service, scope } = build(() => current);
    stubServiceFetch(service, scope);

    for (const [index, testCase] of cases.entries()) {
      const externalId = `BV1xx411c7m${index}`; // BV + 10 位，长这样才过链接识别
      current = record({ transcripts: testCase.transcripts, externalId });
      const text = `看这个 https://www.bilibili.com/video/${externalId}`;
      const resolved = await resolveSharesForMessage({
        conversationId: 'char-1',
        messageId: `msg-${testCase.name}`,
        text,
        endpoint: ENDPOINT,
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      const att = resolved.value.attachments[0];
      expect(att.state).toBe(testCase.state);
      expect(att.contextProjection?.transcriptState).toBe(testCase.transcriptState);

      const projection = buildShareMessageProjection(text, [att])!;
      if (testCase.note) expect(projection).toContain(testCase.note);
      else expect(projection).not.toContain('字幕：');
    }
  });

  it('有界投影：历史脏数据再长也被夹紧，且不携带正文', () => {
    const att = {
      shareRef: 'shr_abcdef0123456789',
      state: 'ready',
      contentId: 'bilibili:public:BV1',
      platform: 'bilibili',
      contextProjection: {
        projectionVersion: 1,
        shareRef: 'shr_abcdef0123456789',
        contentId: 'bilibili:public:BV1',
        contentRevision: 7,
        stateAtFreeze: 'ready',
        summaryText: 'x'.repeat(5000),
        evidenceCoverage: Array.from({ length: 40 }, (_, i) => `field-${i}-${'y'.repeat(50)}`),
        reason: 'missing:' + 'z'.repeat(2000),
        frozenAt: NOW,
        transcriptState: 'not_available',
      },
    } as unknown as ShareAttachment;

    const bounded = boundedProjection(att)!;
    expect(Array.from(bounded.summaryText).length).toBe(PROJECTION_DELIVERY_LIMITS.summaryChars);
    expect(bounded.evidenceCoverage).toHaveLength(PROJECTION_DELIVERY_LIMITS.coverageEntries);
    expect(bounded.evidenceCoverage.every((e) => Array.from(e).length <= PROJECTION_DELIVERY_LIMITS.coverageEntryChars)).toBe(true);
    expect(Array.from(bounded.reason ?? '').length).toBe(PROJECTION_DELIVERY_LIMITS.reasonChars);
    expect(bounded.contentRevision).toBe(7);
    expect(bounded.transcriptState).toBe('not_available');
    // 缺 transcriptState 的老卡不补造字段（交给 absent 的既有降级）
    const legacy = boundedProjection({ ...att, contextProjection: { ...att.contextProjection!, transcriptState: undefined } });
    expect(legacy && 'transcriptState' in legacy).toBe(false);
  });
});
