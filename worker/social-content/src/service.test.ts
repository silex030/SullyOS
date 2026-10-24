/**
 * 服务编排测试（集成卡 t_babca897）。
 *
 * 覆盖契约里“接起来之后才会暴露”的行为：
 *  - 总开关关闭 → 503，不悄悄解析；
 *  - 幂等：同消息同链接不会建第二张卡；
 *  - 没有持久绑定 → 503 PERSISTENCE_UNAVAILABLE（不谎称已保存）；
 *  - 平台受限 → failed 卡带结构化错误（不是空卡、不是假内容）；
 *  - retry 真的重跑一次解析，attempt/revision 单调；
 *  - 内容库 + excerpts 端到端（正文/字幕/评论样本进投影与检索）。
 *
 * 适配器是测试桩，**不代表真实平台可达性**（真实探测结果见 docs/social-content/integration-v1.md）。
 */

import { describe, expect, it, vi } from 'vitest';
import { createSocialService, withContentPersistence } from './service';
import { D1SocialStore } from './store';
import { openTestD1 } from './testDb';
import { readSocialConfig } from './config';
import { buildRecord } from '../record';
import { SocialError } from '../errors';
import type { ContentAdapter, SourceTarget } from '../adapter';
import type { ContentRecord } from '../../../utils/socialContent/types';

const NOW = 1_790_000_000_000;

function config(over: Partial<Record<string, string>> = {}) {
  return readSocialConfig({
    SHARE_LINKS_ENABLED: 'true',
    ...over,
  } as Record<string, string>);
}

function record(over: Partial<{ text: string; caption: string | null; comments: boolean }> = {}): ContentRecord {
  const fetchedAt = NOW;
  return buildRecord({
    platform: 'bilibili',
    sourceId: 'public',
    externalId: 'BV1xx411c7mD',
    author: { id: '1', name: 'UP主', avatarUrl: null, profileUrl: null },
    title: '夹具视频标题',
    text: over.text ?? '这是虚构的正文简介。',
    images: [],
    canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    publishedAt: NOW - 1000,
    fetchedAt,
    platformName: 'B站',
    retrievalMethod: 'public_api',
    counts: { likes: 10, comments: 3 },
    transcripts:
      over.caption === null
        ? []
        : [
            {
              id: 'tr-1',
              partKey: null,
              kind: 'native_caption',
              language: 'zh-CN',
              provider: 'bilibili_native',
              availability: 'available',
              segments: [{ id: 's1', startMs: 0, endMs: 2000, text: over.caption ?? '第一句字幕' }],
              plainText: over.caption ?? '第一句字幕',
              truncated: false,
              originalLength: null,
              fetchedAt,
              sourceRef: 'bilibili:public:subtitle',
            },
          ],
    commentsSample:
      over.comments === false
        ? null
        : {
            availability: 'available',
            items: [
              { id: 'c1', author: { name: '路人' }, text: '夹具评论', likes: 2, publishedAt: null, sourceRef: 'bilibili:public:reply' },
            ],
            selection: 'platform_hot',
            requestedLimit: 5,
            returnedCount: 1,
            pagesFetched: 1,
            totalAvailable: null,
            hasMore: null,
            fetchedAt,
            truncated: false,
            scopeDescription: '第 1 页样本',
          },
  });
}

function fakeAdapter(
  opts: { onFetch?: () => ContentRecord | Promise<ContentRecord>; platform?: 'bilibili' | 'xiaohongshu' | 'douyin' } = {},
): ContentAdapter & { calls: number } {
  const adapter = {
    id: 'fake-bilibili',
    platform: opts.platform ?? 'bilibili',
    version: 'test',
    capabilities: { detail: true, comments: true, shortLink: true, transcript: true },
    calls: 0,
    async health() {
      return { status: 'configured' as const, note: 'test' };
    },
    async expandShortLink(url: string): Promise<SourceTarget> {
      return {
        platform: 'bilibili',
        externalId: 'BV1xx411c7mD',
        partKey: null,
        canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
        resolvedUrl: url,
      };
    },
    async fetchContent() {
      adapter.calls += 1;
      if (opts.onFetch) return await opts.onFetch();
      return record();
    },
  };
  return adapter as unknown as ContentAdapter & { calls: number };
}

function setup(
  opts: {
    adapter?: ContentAdapter;
    adapterPlatform?: 'bilibili' | 'xiaohongshu' | 'douyin';
    withDb?: boolean;
    cfg?: ReturnType<typeof config>;
  } = {},
) {
  const db = openTestD1();
  const store = new D1SocialStore((opts.withDb === false ? null : db) as never);
  const adapter = opts.adapter ?? fakeAdapter();
  const cfg = opts.cfg ?? config();
  const wrapped = withContentPersistence(adapter, store, { cacheAllowed: cfg.cacheAllowed });
  const service = createSocialService({
    config: cfg,
    store,
    adapters: { [opts.adapterPlatform ?? 'bilibili']: wrapped },
    sourceIdFor: (platform) => cfg.sourceIds[platform] ?? null,
    now: () => NOW,
  });
  return { db, store, adapter, service, cfg };
}

const TEXT = '帮我看下这个 https://www.bilibili.com/video/BV1xx411c7mD 讲了啥？';

describe('social-content service', () => {
  it('总开关关闭时 503 SHARE_LINKS_DISABLED，且不调用适配器', async () => {
    const { service, adapter } = setup({ cfg: readSocialConfig({}) });
    const res = await service.resolve('deployment', { messageId: 'm1', conversationId: 'c1', text: TEXT });
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toBe('SHARE_LINKS_DISABLED');
    expect((adapter as unknown as { calls: number }).calls).toBe(0);
  });

  it('解析成功：ready 卡 + 冻结投影 + 内容入库 + 可检索摘录', async () => {
    const { service, db } = setup();
    const res = await service.resolve('deployment', { messageId: 'm1', conversationId: 'c1', characterId: 'char-1', text: TEXT });
    expect(res.status).toBe(202);
    const body = res.body as { attachments: Array<Record<string, any>>; pollAfterMs: number };
    expect(body.pollAfterMs).toBeGreaterThan(0);
    expect(body.attachments).toHaveLength(1);
    const att = body.attachments[0];
    expect(att.state).toBe('ready');
    expect(att.contentId).toBe('bilibili:public:BV1xx411c7mD');
    expect(att.openUrl).toBe('https://www.bilibili.com/video/BV1xx411c7mD');
    // 列表接口不回投影正文（轻量），但库里必须有冻结投影
    expect(att.contextProjection).toBeNull();
    const stored = await new D1SocialStore(db as never).forScope('deployment').get(att.shareRef);
    expect(stored?.contextProjection?.summaryText).toContain('UP主');
    expect(stored?.contextProjection?.evidenceCoverage).toContain('transcript');
    expect(db.count('social_content_items')).toBe(1);

    const excerpts = await service.excerpts('deployment', 'bilibili:public:BV1xx411c7mD', {
      contentRevision: 1,
      fields: ['text', 'transcript'],
      maxTokens: 60,
    });
    expect(excerpts.status).toBe(200);
    const ex = excerpts.body as { segments: Array<{ field: string; text: string }>; tokenEstimate: number; truncated: boolean };
    expect(ex.segments.some((s) => s.field === 'text')).toBe(true);
    expect(ex.tokenEstimate).toBeLessThanOrEqual(60);
  });

  it('幂等：同一消息同一链接重复 POST 只留一张卡，shareRef 不变', async () => {
    const { service, db, adapter } = setup();
    const first = await service.resolve('deployment', { messageId: 'm1', conversationId: 'c1', text: TEXT });
    const second = await service.resolve('deployment', { messageId: 'm1', conversationId: 'c1', text: TEXT });
    const a = (first.body as any).attachments[0];
    const b = (second.body as any).attachments[0];
    expect(b.shareRef).toBe(a.shareRef);
    expect(db.count('social_share_attachments')).toBe(1);
    // 第二次仍会跑一遍解析（服务端无分布式锁），但结果写不进第二行 —— 幂等由唯一约束兜底
    expect((adapter as unknown as { calls: number }).calls).toBe(2);
  });

  it('没有持久绑定：503 PERSISTENCE_UNAVAILABLE，但把本次结果如实带回', async () => {
    const { service } = setup({ withDb: false });
    const res = await service.resolve('deployment', { messageId: 'm1', conversationId: 'c1', text: TEXT });
    expect(res.status).toBe(503);
    const body = res.body as { error: string; attachments: Array<{ state: string }> };
    expect(body.error).toBe('PERSISTENCE_UNAVAILABLE');
    expect(body.attachments[0].state).toBe('ready');
    expect(await service.list('deployment', 'c1', 'm1').then((r) => r.status)).toBe(503);
  });

  it('平台要求登录：failed 卡带 AUTH_REQUIRED，不伪造正文', async () => {
    const adapter = fakeAdapter({
      onFetch: () => {
        throw new SocialError('AUTH_REQUIRED', 'xhs_session_disabled');
      },
    });
    const { service } = setup({ adapter, adapterPlatform: 'xiaohongshu' });
    const res = await service.resolve('deployment', {
      messageId: 'm2',
      conversationId: 'c1',
      text: '看这个 https://www.xiaohongshu.com/explore/64f0aa11bb',
    });
    const att = (res.body as any).attachments[0];
    expect(att.state).toBe('failed');
    expect(att.error.code).toBe('AUTH_REQUIRED');
    expect(att.contentId).toBeNull();
  });

  it('未配置来源：SOURCE_NOT_CONFIGURED，不调用适配器', async () => {
    const { service, adapter } = setup({
      cfg: config({ SOCIAL_SOURCE_ID_BILIBILI: '' }),
    });
    const res = await service.resolve('deployment', { messageId: 'm3', conversationId: 'c1', text: TEXT });
    const att = (res.body as any).attachments[0];
    expect(att.state).toBe('failed');
    expect(att.error.code).toBe('SOURCE_NOT_CONFIGURED');
    expect((adapter as unknown as { calls: number }).calls).toBe(0);
  });

  it('retry 真重跑：attempt/revision 递增，成功后覆盖失败卡', async () => {
    let fail = true;
    const adapter = fakeAdapter({
      onFetch: () => {
        if (fail) throw new SocialError('TIMEOUT', 'first_attempt_timeout');
        return record();
      },
    });
    const { service, db } = setup({ adapter });
    const first = await service.resolve('deployment', { messageId: 'm4', conversationId: 'c1', text: TEXT });
    const failed = (first.body as any).attachments[0];
    expect(failed.state).toBe('failed');

    fail = false;
    const retried = await service.retry('deployment', failed.shareRef, { expectedRevision: failed.revision });
    expect(retried.status).toBe(202);
    const att = (retried.body as any).attachment;
    expect(att.state).toBe('ready');
    expect(att.attempt).toBe(2);
    expect(att.revision).toBeGreaterThan(failed.revision);
    const stored = await new D1SocialStore(db as never).forScope('deployment').get(failed.shareRef);
    expect(stored?.state).toBe('ready');
    expect(stored?.attempt).toBe(2);
  });

  it('retry 用错 revision → 409，不改动已存卡', async () => {
    const { service } = setup();
    const first = await service.resolve('deployment', { messageId: 'm5', conversationId: 'c1', text: TEXT });
    const att = (first.body as any).attachments[0];
    const res = await service.retry('deployment', att.shareRef, { expectedRevision: 999 });
    expect(res.status).toBe(409);
  });

  it('超长文本 → 413 SIZE_LIMIT（16000 UTF-16 上限）', async () => {
    const { service } = setup();
    const res = await service.resolve('deployment', { messageId: 'm6', conversationId: 'c1', text: 'x'.repeat(16001) });
    expect(res.status).toBe(413);
    expect((res.body as { error: string }).error).toBe('SIZE_LIMIT');
  });

  it('多链接：第 6 条起逐项 SIZE_LIMIT，不静默丢弃', async () => {
    const { service } = setup();
    const text = Array.from({ length: 6 }, (_, i) => `https://www.bilibili.com/video/BV1xx411c7m${i}`).join(' ');
    const res = await service.resolve('deployment', { messageId: 'm7', conversationId: 'c1', text });
    const atts = (res.body as any).attachments as Array<{ state: string; error: { code: string } | null }>;
    expect(atts).toHaveLength(6);
    expect(atts.filter((a) => a.error?.code === 'SIZE_LIMIT')).toHaveLength(1);
  });

  it('跨会话 get 一律 404（不透露存在性）', async () => {
    const { service } = setup();
    const first = await service.resolve('deployment', { messageId: 'm8', conversationId: 'c1', text: TEXT });
    const att = (first.body as any).attachments[0];
    expect((await service.get('deployment', att.shareRef)).status).toBe(200);
    expect((await service.get('other-scope', att.shareRef)).status).toBe(404);
    expect((await service.list('deployment', 'another-conversation', 'm8')).body).toEqual({ attachments: [] });
  });

  it('持久化失败（写库抛错）不谎称成功', async () => {
    const db = openTestD1();
    const store = new D1SocialStore(db as never);
    const broken = {
      ...store,
      available: true,
      forScope() {
        return {
          scope: 'deployment',
          put: async () => {
            throw new Error('disk full');
          },
          get: async () => null,
          listByMessage: async () => [],
          putContent: async () => {},
          getContent: async () => null,
          claim: async () => false,
          release: async () => {},
        };
      },
    };
    const service = createSocialService({
      config: config(),
      store: broken as never,
      adapters: { bilibili: fakeAdapter() },
      sourceIdFor: () => 'public',
      now: () => NOW,
    });
    const res = await service.resolve('deployment', { messageId: 'm9', conversationId: 'c1', text: TEXT });
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toBe('PERSISTENCE_UNAVAILABLE');
  });

  it('内容正文被体积上限夹紧（不把整段原文塞进库/上下文）', async () => {
    const huge = '正'.repeat(250_000);
    const adapter = fakeAdapter({ onFetch: () => record({ text: huge }) });
    const { service, db } = setup({ adapter });
    await service.resolve('deployment', { messageId: 'm10', conversationId: 'c1', text: TEXT });
    const row = await new D1SocialStore(db as never)
      .forScope('deployment')
      .getContent('bilibili:public:BV1xx411c7mD');
    expect(row?.body.text.length).toBe(200_000);
    expect(row?.body.truncated).toBe(true);
    expect(vi.isMockFunction(adapter.fetchContent)).toBe(false);
  });
});
