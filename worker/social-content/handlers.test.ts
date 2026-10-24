import { describe, expect, it } from 'vitest';
import { createSocialHandlers, type HandlerDeps } from './handlers';
import type { ShareStore } from './resolver';
import { buildRecord } from './record';
import type { ContentAdapter } from './adapter';
import type { ContentRecord, ShareAttachment } from '../../utils/socialContent/types';

/**
 * /v1/social/* 协议层测试（t_2c2dba79，契约 4.1-4.6）。
 * 只验证状态码/归属校验/错误翻译；真实挂路由与鉴权由集成人接线，不在本文件范围。
 */

const NOW = 1700000000000;
const BV = 'BV1xx411c7mD';

function record(): ContentRecord {
  return buildRecord({
    platform: 'bilibili',
    sourceId: 'bilibili-public',
    externalId: BV,
    author: { id: '1', name: '夹具作者', avatarUrl: null, profileUrl: null },
    title: '夹具标题',
    text: '夹具正文内容，用于 item 与 excerpts。',
    images: [],
    canonicalUrl: `https://www.bilibili.com/video/${BV}`,
    publishedAt: NOW,
    fetchedAt: NOW,
    platformName: '哔哩哔哩',
    retrievalMethod: 'fixture',
  });
}

function memoryStore(): ShareStore & { byScope: Map<string, ShareAttachment>; rows: ShareAttachment[] } {
  const byScope = new Map<string, ShareAttachment>();
  const rows: ShareAttachment[] = [];
  const key = (scope: string, ref: string) => `${scope}:${ref}`;
  return {
    byScope,
    rows,
    async put(att, expectedRevision) {
      // scope 不在 attachment 上，测试里统一按 'public' 归属
      const existing = byScope.get(key('public', att.shareRef));
      if (expectedRevision === 0) {
        if (existing) return false;
        byScope.set(key('public', att.shareRef), att);
        rows.push(att);
        return true;
      }
      if (!existing || existing.revision !== expectedRevision) return false;
      byScope.set(key('public', att.shareRef), att);
      return true;
    },
    async get(ref, scope) {
      return byScope.get(key(scope, ref)) ?? null;
    },
    async listByMessage(scope, messageId) {
      return [...byScope.entries()]
        .filter(([k]) => k.startsWith(`${scope}:`))
        .map(([, v]) => v)
        .filter((v) => v.messageId === messageId);
    },
  };
}

const adapter = (): ContentAdapter => ({
  id: 'fake-bili',
  platform: 'bilibili',
  version: 'test',
  capabilities: { detail: true, comments: false, shortLink: false, transcript: false },
  health: async () => ({ status: 'configured', note: 'fake' }),
  async expandShortLink() {
    throw new Error('not used');
  },
  async fetchContent() {
    return record();
  },
});

function setup(overrides: Partial<HandlerDeps> = {}) {
  const store = memoryStore();
  const content = record();
  const deps: HandlerDeps = {
    adapters: { bilibili: adapter() },
    sourceIdFor: (p) => (p === 'bilibili' ? 'bilibili-public' : null),
    now: () => NOW,
    newShareRef: (() => {
      let i = 0;
      return () => `shr_h${++i}`;
    })(),
    store,
    getContent: async (contentId, scope) => (scope === 'public' && contentId === content.id ? content : null),
    ...overrides,
  };
  return { handlers: createSocialHandlers(deps), store, content };
}

const resolveBody = (text: string) => ({
  schemaVersion: 1,
  messageId: 'msg-1',
  conversationId: 'conv-1',
  characterId: null,
  text,
  idempotencyKey: 'idem-1',
});

describe('POST /shares/resolve', () => {
  it('202 返回 attachments 与 pollAfterMs，并落库', async () => {
    const { handlers, store } = setup();
    const res = await handlers.resolve('public', resolveBody(`看看 https://www.bilibili.com/video/${BV}`));
    expect(res.status).toBe(202);
    const body = res.body as { attachments: ShareAttachment[]; pollAfterMs: number };
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]).toMatchObject({ state: 'ready', contentId: `bilibili:bilibili-public:${BV}` });
    expect(body.pollAfterMs).toBe(1000);
    expect(store.rows).toHaveLength(1);
  });

  it('缺 text/ID → 422；文本超长 → 413', async () => {
    const { handlers } = setup();
    expect((await handlers.resolve('public', { messageId: 'm', conversationId: 'c' })).status).toBe(422);
    const tooLong = await handlers.resolve('public', resolveBody('a'.repeat(16001)));
    expect(tooLong.status).toBe(413);
  });

  it('未配置来源 → 503 且附件是 failed/SOURCE_NOT_CONFIGURED', async () => {
    const { handlers } = setup({ sourceIdFor: () => null });
    const res = await handlers.resolve('public', resolveBody(`https://www.bilibili.com/video/${BV}`));
    // 解析本身成功入队（202），单卡状态是失败
    expect(res.status).toBe(202);
    const body = res.body as { attachments: ShareAttachment[] };
    expect(body.attachments[0].error?.code).toBe('SOURCE_NOT_CONFIGURED');
  });
});

describe('GET /shares', () => {
  it('按会话+消息列出，跨会话不返回', async () => {
    const { handlers } = setup();
    await handlers.resolve('public', resolveBody(`https://www.bilibili.com/video/${BV}`));
    const ok = await handlers.list('public', 'conv-1', 'msg-1');
    expect(ok.status).toBe(200);
    expect((ok.body as { attachments: ShareAttachment[] }).attachments).toHaveLength(1);

    const other = await handlers.list('public', 'conv-2', 'msg-1');
    expect((other.body as { attachments: ShareAttachment[] }).attachments).toHaveLength(0);
  });

  it('GET /shares/:ref 跨 scope 返回 404，不透露存在性', async () => {
    const { handlers } = setup();
    const created = await handlers.resolve('public', resolveBody(`https://www.bilibili.com/video/${BV}`));
    const ref = (created.body as { attachments: ShareAttachment[] }).attachments[0].shareRef;

    expect((await handlers.get('public', ref)).status).toBe(200);
    expect((await handlers.get('other-scope', ref)).status).toBe(404);
    expect((await handlers.get('public', 'shr_missing')).status).toBe(404);
  });

  it('列表不返回 contextProjection（只轻量字段）', async () => {
    const { handlers } = setup();
    await handlers.resolve('public', resolveBody(`https://www.bilibili.com/video/${BV}`));
    const listed = await handlers.list('public', 'conv-1', 'msg-1');
    const att = (listed.body as { attachments: ShareAttachment[] }).attachments[0];
    expect(att.contextProjection).toBeNull();
  });
});

describe('POST /shares/:ref/retry', () => {
  it('expectedRevision 正确时 202 且 attempt+1；旧 revision → 409', async () => {
    const { handlers, store } = setup();
    const created = await handlers.resolve('public', resolveBody(`https://www.bilibili.com/video/${BV}`));
    const att = (created.body as { attachments: ShareAttachment[] }).attachments[0];

    const ok = await handlers.retry('public', att.shareRef, { expectedRevision: att.revision, idempotencyKey: 'k1' });
    expect(ok.status).toBe(202);
    const next = (ok.body as { attachment: ShareAttachment }).attachment;
    expect(next).toMatchObject({ state: 'queued', attempt: att.attempt + 1, revision: att.revision + 1, contentId: null });

    const stale = await handlers.retry('public', att.shareRef, { expectedRevision: att.revision, idempotencyKey: 'k2' });
    expect(stale.status).toBe(409);
    expect(store.rows.length).toBeGreaterThan(0);
  });

  it('缺 expectedRevision → 422；未知 ref → 404', async () => {
    const { handlers } = setup();
    const created = await handlers.resolve('public', resolveBody(`https://www.bilibili.com/video/${BV}`));
    const ref = (created.body as { attachments: ShareAttachment[] }).attachments[0].shareRef;
    expect((await handlers.retry('public', ref, {})).status).toBe(422);
    expect((await handlers.retry('public', 'shr_nope', { expectedRevision: 1 })).status).toBe(404);
  });
});

describe('GET /items 与 excerpts', () => {
  it('item 命中返回内容，未知或跨 scope 404', async () => {
    const { handlers, content } = setup();
    const ok = await handlers.item('public', content.id);
    expect(ok.status).toBe(200);
    expect((ok.body as { content: ContentRecord }).content.id).toBe(content.id);
    expect((await handlers.item('public', 'bilibili:other:1')).status).toBe(404);
    expect((await handlers.item('private', content.id)).status).toBe(404);
  });

  it('excerpts 成功并夹紧预算', async () => {
    const { handlers, content } = setup();
    const res = await handlers.excerpts('public', content.id, {
      contentRevision: 1,
      query: null,
      fields: ['text'],
      partKey: null,
      cursor: null,
      maxTokens: 999999,
    });
    expect(res.status).toBe(200);
    const body = res.body as { tokenEstimate: number; segments: unknown[]; estimateMethod: string };
    expect(body.tokenEstimate).toBeLessThanOrEqual(1200);
    expect(body.segments.length).toBeGreaterThan(0);
    expect(body.estimateMethod).toBe('codepoint_approx');
  });

  it('contentRevision 过期 → 409 VERSION_UNAVAILABLE', async () => {
    const { handlers, content } = setup();
    const res = await handlers.excerpts('public', content.id, {
      contentRevision: 0,
      query: null,
      fields: ['text'],
      partKey: null,
      cursor: null,
      maxTokens: 500,
    });
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toBe('VERSION_UNAVAILABLE');
  });

  it('excerpts 未知内容 → 404', async () => {
    const { handlers } = setup();
    const res = await handlers.excerpts('public', 'bilibili:other:1', { contentRevision: 1, maxTokens: 100 });
    expect(res.status).toBe(404);
  });
});
