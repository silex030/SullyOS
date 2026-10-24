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

  it('幂等：同一消息同一链接重复 POST 只留一张卡、shareRef 不变、且不再重复抓取', async () => {
    const { service, db, adapter } = setup();
    const first = await service.resolve('deployment', { messageId: 'm1', conversationId: 'c1', text: TEXT });
    const second = await service.resolve('deployment', { messageId: 'm1', conversationId: 'c1', text: TEXT });
    const a = (first.body as any).attachments[0];
    const b = (second.body as any).attachments[0];
    expect(b.shareRef).toBe(a.shareRef);
    expect(b.revision).toBe(a.revision);
    expect(db.count('social_share_attachments')).toBe(1);
    // 终态卡复用：第二次 POST 直接返回已存结果，不再打一次平台（缺陷 1 的回归断言）
    expect((adapter as unknown as { calls: number }).calls).toBe(1);
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

  it('不支持/超限的卡也落库；重复 POST 不会重复建卡（不只在终态路径幂等）', async () => {
    const { service, db } = setup();
    const text = Array.from({ length: 6 }, (_, i) => `https://www.bilibili.com/video/BV1xx411c7m${i}`).join(' ');
    const first = await service.resolve('deployment', { messageId: 'm-limit', conversationId: 'c1', text });
    expect((first.body as any).attachments).toHaveLength(6);
    expect(db.count('social_share_attachments')).toBe(6);
    const second = await service.resolve('deployment', { messageId: 'm-limit', conversationId: 'c1', text });
    expect((second.body as any).attachments).toHaveLength(6);
    expect(db.count('social_share_attachments')).toBe(6);
    // 第 6 条是 SIZE_LIMIT 的失败卡，但它也在库里（GET /shares 看得到）
    const listed = await service.list('deployment', 'c1', 'm-limit');
    const atts = (listed.body as any).attachments as Array<{ error: { code: string } | null }>;
    expect(atts.some((a) => a.error?.code === 'SIZE_LIMIT')).toBe(true);
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

/**
 * 缺陷 1 的回归：幂等/租约必须接进**真实解析路径**，而不是只在 service 外层“事后去重”。
 * 这里用真实 SQLite + 可卡住的适配器制造真实在途任务，验证：
 *  - 占位（resolving + lease_until）在任何出站请求返回之前就已落库；
 *  - 租约还活着时重复 POST 复用在途作业、不重复抓取；
 *  - 进程重启后启动恢复把在途卡标 failed(TIMEOUT)，迟到的成功不覆盖它，之后 retry 还能成功。
 */
function serviceFor(db: ReturnType<typeof openTestD1>, adapter: ContentAdapter, nowFn: () => number) {
  const store = new D1SocialStore(db as never);
  const cfg = config();
  return createSocialService({
    config: cfg,
    store,
    adapters: { bilibili: withContentPersistence(adapter, store, { cacheAllowed: cfg.cacheAllowed }) },
    sourceIdFor: () => cfg.sourceIds.bilibili ?? null,
    now: nowFn,
  });
}

/** 卡住 fetch 的适配器：抓取“已经开始但没有返回”，用来制造真实在途任务。 */
function gatedAdapter() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapter = fakeAdapter({
    onFetch: async () => {
      await gate;
      return record();
    },
  });
  return { adapter, release };
}

describe('幂等 / 租约 / 重启恢复（真实 SQLite + 真实在途任务）', () => {
  it('占位先落库：出站抓取返回前库里已是 resolving + 租约（首屏 1500ms 内即可恢复）', async () => {
    const db = openTestD1();
    const { adapter, release } = gatedAdapter();
    const service = serviceFor(db, adapter, () => NOW);
    const store = new D1SocialStore(db as never).forScope('deployment');

    const pending = service.resolve('deployment', { messageId: 'm-inflight', conversationId: 'c1', text: TEXT });
    let row: Awaited<ReturnType<typeof store.listByMessage>>[number] | undefined;
    await vi.waitFor(
      async () => {
        const rows = await store.listByMessage('m-inflight');
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe('resolving');
        row = rows[0];
      },
      { timeout: 2000, interval: 5 },
    );

    // 此刻 fetch 还没返回：正文没入库、租约已写、原文/span 都可恢复
    expect(db.count('social_content_items')).toBe(0);
    expect(row!.leaseUntil).toBeGreaterThan(NOW);
    expect(row!.occurrenceSpans.length).toBe(1);
    expect(adapter.calls).toBe(1);

    release();
    const done = await pending;
    expect((done.body as any).attachments[0].state).toBe('ready');
    const after = await store.get(row!.shareRef);
    expect(after?.state).toBe('ready');
    expect(after?.leaseUntil).toBeNull();
  });

  it('在途作业复用：租约未到期时重复 POST 不再打平台，返回同一张在途卡', async () => {
    const db = openTestD1();
    const { adapter, release } = gatedAdapter();
    const service = serviceFor(db, adapter, () => NOW);
    const store = new D1SocialStore(db as never).forScope('deployment');

    const first = service.resolve('deployment', { messageId: 'm-inflight', conversationId: 'c1', text: TEXT });
    await vi.waitFor(
      async () => {
        const rows = await store.listByMessage('m-inflight');
        expect(rows[0]?.state).toBe('resolving');
      },
      { timeout: 2000, interval: 5 },
    );

    const second = await service.resolve('deployment', { messageId: 'm-inflight', conversationId: 'c1', text: TEXT });
    const att = (second.body as any).attachments[0];
    expect(second.status).toBe(202);
    expect(att.state).toBe('resolving');
    expect(att.leaseUntil).toBeGreaterThan(NOW);
    // 关键断言：同一在途作业被复用，适配器只被调用过一次
    expect(adapter.calls).toBe(1);
    expect(db.count('social_share_attachments')).toBe(1);

    release();
    const done = await first;
    expect((done.body as any).attachments[0].state).toBe('ready');
    expect(db.count('social_share_attachments')).toBe(1);
  });

  it('晚到的失败仍然回写（卡不会永远停在 resolving），并给出可重试的错误', async () => {
    const db = openTestD1();
    const store = new D1SocialStore(db as never).forScope('deployment');
    let rejectFetch!: (err: Error) => void;
    const adapter = fakeAdapter({
      onFetch: () =>
        new Promise<ReturnType<typeof record>>((_resolve, reject) => {
          rejectFetch = reject;
        }),
    });
    const service = serviceFor(db, adapter, () => NOW);
    const pending = service.resolve('deployment', { messageId: 'm-late-fail', conversationId: 'c1', text: TEXT });
    await vi.waitFor(
      async () => {
        const rows = await store.listByMessage('m-late-fail');
        expect(rows[0]?.state).toBe('resolving');
      },
      { timeout: 2000, interval: 5 },
    );

    // 慢请求最终失败：失败必须写回库（用户看到原因 + 可重试），而不是停在 resolving
    rejectFetch(new SocialError('TIMEOUT', 'late_timeout'));
    const done = await pending;
    const att = (done.body as any).attachments[0];
    expect(att.state).toBe('failed');
    expect(att.error.code).toBe('TIMEOUT');
    const stored = await store.listByMessage('m-late-fail');
    expect(stored[0]?.state).toBe('failed');
    expect(stored[0]?.leaseUntil).toBeNull();
  });

  it('重启恢复：在途卡 → failed(TIMEOUT)，迟到的成功不覆盖，重试仍能成功', async () => {
    const db = openTestD1();
    let clock = NOW;
    const owner = gatedAdapter(); // 旧进程：请求卡在 fetch 上
    const serviceA = serviceFor(db, owner.adapter, () => clock);
    const store = new D1SocialStore(db as never).forScope('deployment');

    const pending = serviceA.resolve('deployment', { messageId: 'm-restart', conversationId: 'c1', text: TEXT });
    let inflight: Awaited<ReturnType<typeof store.listByMessage>>[number] | undefined;
    await vi.waitFor(
      async () => {
        const rows = await store.listByMessage('m-restart');
        expect(rows[0]?.state).toBe('resolving');
        inflight = rows[0];
      },
      { timeout: 2000, interval: 5 },
    );
    expect(inflight!.leaseUntil).toBeGreaterThan(clock);

    // “进程重启”：另一个实例 + 启动恢复（单实例部署，旧租约即使没到期也已经没人续）
    clock += 1000;
    // 新实例用正常返回的适配器：恢复后的 retry 要真的能跑完，不能又被同一个闸门挡住
    const restarted = { adapter: fakeAdapter() };
    const serviceB = serviceFor(db, restarted.adapter, () => clock);
    expect(await serviceB.recover()).toBe(1);
    const recovered = await store.get(inflight!.shareRef);
    expect(recovered?.state).toBe('failed');
    expect(recovered?.error?.code).toBe('TIMEOUT');
    expect(recovered?.leaseUntil).toBeNull();

    // 重启后同一消息再次 POST：复用 failed 卡（用户看到“解析被中断，可重试”），不再打平台
    const afterRestart = await serviceB.resolve('deployment', { messageId: 'm-restart', conversationId: 'c1', text: TEXT });
    const reused = (afterRestart.body as any).attachments[0];
    expect(afterRestart.status).toBe(202);
    expect(reused.state).toBe('failed');
    expect(reused.revision).toBe(recovered!.revision);
    expect(restarted.adapter.calls).toBe(0);

    // 旧持有者的迟到成功：CAS 落库失败 → 回读库里的 failed，不覆盖恢复后的状态
    owner.release();
    const late = await pending;
    expect((late.body as any).attachments[0].state).toBe('failed');
    const still = await store.get(inflight!.shareRef);
    expect(still?.state).toBe('failed');
    expect(still?.revision).toBe(recovered!.revision);

    // 人工 retry：真的重跑一次并成功（attempt=2）
    const retried = await serviceB.retry('deployment', inflight!.shareRef, { expectedRevision: still!.revision });
    expect(retried.status).toBe(202);
    const fin = (retried.body as any).attachment;
    expect(fin.state).toBe('ready');
    expect(fin.attempt).toBe(2);
    expect(fin.revision).toBeGreaterThan(still!.revision);
    expect(restarted.adapter.calls).toBe(1);
  });
});
