import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLATFORM_HOSTS } from './security';
import { fakeDeps } from './testSupport';
import { createBilibiliAdapter } from './adapters/bilibili';
import { createXiaohongshuAdapter } from './adapters/xiaohongshu';
import { createDouyinAdapter } from './adapters/douyin';
import type { AdapterDeps, SourceTarget } from './adapter';

/**
 * 三平台适配器契约测试（t_2c2dba79）。
 * 上游全部是 fixtures/ 下的**虚构脱敏夹具**，不代表真实平台响应；真实平台验证不在本测试范围。
 */

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const view = fixture('bilibili_view.json');
const player = fixture('bilibili_player.json');
const subtitle = fixture('bilibili_subtitle.json');
const replies = fixture('bilibili_replies.json');
const douyinHtml = fixture('douyin_share_page.html');

const biliTarget: SourceTarget = {
  platform: 'bilibili',
  externalId: 'BV1xx411c7mD',
  partKey: null,
  canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
  resolvedUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
};

const biliDeps = (
  routes: Record<string, { status?: number; body: string; headers?: Record<string, string> }>,
  addresses?: string[],
) => {
  const { deps, calls } = fakeDeps(routes, { addresses });
  const adapterDeps: AdapterDeps = {
    safeFetch: deps,
    allowedHosts: [...PLATFORM_HOSTS.bilibili, ...PLATFORM_HOSTS.bilibiliCdn],
    policy: { requestTimeoutMs: 500 },
  };
  return { adapterDeps, calls };
};

const biliRoutes = {
  'api.bilibili.com/x/web-interface/view': { body: view },
  'api.bilibili.com/x/player/v2': { body: player },
  'aisubtitle.hdslb.com/bfs/subtitle/fixture.json': { body: subtitle },
  'api.bilibili.com/x/v2/reply': { body: replies },
};

describe('B 站适配器', () => {
  it('成功路径：标题/作者/正文/封面/统计/原生字幕/评论样本', async () => {
    const { adapterDeps } = biliDeps(biliRoutes);
    const adapter = createBilibiliAdapter(adapterDeps);
    const record = await adapter.fetchContent(biliTarget, { scope: 'public', deadline: Date.now() + 5000, now: () => 1700000000000 });

    expect(record.id).toBe('bilibili:bilibili-public:BV1xx411c7mD');
    expect(record.title).toBe('夹具视频标题');
    expect(record.author).toMatchObject({ id: '10001', name: '夹具UP主' });
    expect(record.body.text).toContain('这是虚构的简介');
    expect(record.text).toBe(record.body.text);
    expect(record.publishedAt).toBe(1700000000000);
    expect(record.counts).toEqual({ likes: 50000, comments: 8000 });
    expect(record.images).toHaveLength(1);
    expect(record.images[0].safeUrl).toBe('https://i0.hdslb.com/bfs/archive/fixture-cover.jpg');
    // media 与 images 引用同一批对象，不双存
    expect(record.media).toBe(record.images);

    const caption = record.transcripts.find((t) => t.kind === 'native_caption');
    expect(caption).toMatchObject({ availability: 'available', language: 'zh-CN', provider: 'bilibili_native' });
    expect(caption?.segments).toHaveLength(2);
    expect(caption?.segments[0]).toMatchObject({ startMs: 500, endMs: 2500, text: '第一句原生字幕' });
    // ASR 默认关闭：不声称转写过
    expect(record.transcripts.find((t) => t.kind === 'speech_transcription')?.availability).toBe('not_requested');

    const comments = record.commentsSample;
    expect(comments).toMatchObject({ availability: 'available', requestedLimit: 5, returnedCount: 5, selection: 'platform_hot' });
    expect(comments?.items).toHaveLength(5);
    expect(comments?.items[0]).toMatchObject({ author: { name: '夹具观众甲' }, likes: 120 });
    expect(comments?.totalAvailable).toBe(4321);
    expect(comments?.hasMore).toBe(true);
    // 样本说明必须如实，不能称全量热门
    expect(comments?.scopeDescription).toContain('样本非全量');

    expect(record.attribution.retrievalMethod).toBe('bilibili_open_api_v1');
    expect(record.fieldProvenance.transcript?.availability).toBe('available');
  });

  it('分 P：p2 用对应 cid 请求字幕，canonical 保留 p 参数', async () => {
    const { adapterDeps, calls } = biliDeps(biliRoutes);
    const adapter = createBilibiliAdapter(adapterDeps);
    const target: SourceTarget = { ...biliTarget, partKey: 'p2', canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2' };
    const record = await adapter.fetchContent(target, { scope: 'public', deadline: Date.now() + 5000, now: () => 1700000000000 });
    expect(calls.some((c) => c.url.includes('cid=98765433'))).toBe(true);
    expect(record.transcripts.find((t) => t.kind === 'native_caption')?.partKey).toBe('p2');
  });

  it('无原生字幕：标 not_available，不伪造转写', async () => {
    const { adapterDeps } = biliDeps({
      ...biliRoutes,
      'api.bilibili.com/x/player/v2': { body: JSON.stringify({ code: 0, data: { subtitle: { subtitles: [] } } }) },
    });
    const adapter = createBilibiliAdapter(adapterDeps);
    const record = await adapter.fetchContent(biliTarget, { scope: 'public', deadline: Date.now() + 5000, now: () => 1700000000000 });
    expect(record.transcripts.find((t) => t.kind === 'native_caption')?.availability).toBe('not_available');
    expect(record.transcripts.find((t) => t.kind === 'speech_transcription')?.availability).toBe('not_requested');
    expect(record.fieldProvenance.transcript?.availability).toBe('unavailable');
  });

  it('评论接口失败：正文仍可用，评论标 failed 并记 note（不编造评论）', async () => {
    const { adapterDeps } = biliDeps({
      ...biliRoutes,
      'api.bilibili.com/x/v2/reply': { status: 403, body: '' },
    });
    const adapter = createBilibiliAdapter(adapterDeps);
    const record = await adapter.fetchContent(biliTarget, { scope: 'public', deadline: Date.now() + 5000, now: () => 1700000000000 });
    expect(record.commentsSample?.availability).toBe('failed');
    expect(record.commentsSample?.items).toHaveLength(0);
    expect(record.limits.notes.some((n) => n.startsWith('comments_failed:'))).toBe(true);
  });

  it('稿件不可见（62002）→ CONTENT_NOT_FOUND，不返回空壳', async () => {
    const { adapterDeps } = biliDeps({
      ...biliRoutes,
      'api.bilibili.com/x/web-interface/view': { body: JSON.stringify({ code: 62002, message: '稿件不可见' }) },
    });
    const adapter = createBilibiliAdapter(adapterDeps);
    await expect(
      adapter.fetchContent(biliTarget, { scope: 'public', deadline: Date.now() + 5000, now: () => 1700000000000 }),
    ).rejects.toMatchObject({ code: 'CONTENT_NOT_FOUND' });
  });

  it('b23 短链经受控展开得到 BV 与分P', async () => {
    const { adapterDeps, calls } = biliDeps({
      'b23.tv/XyZ123': { status: 302, headers: { location: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2&spm_id_from=333' }, body: '' },
      'www.bilibili.com/video/BV1xx411c7mD': { body: 'ok' },
    });
    const adapter = createBilibiliAdapter(adapterDeps);
    const target = await adapter.expandShortLink('https://b23.tv/XyZ123', { scope: 'public', deadline: Date.now() + 5000 });
    expect(target).toMatchObject({
      platform: 'bilibili',
      externalId: 'BV1xx411c7mD',
      partKey: 'p2',
      canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
    });
    expect(calls[0].pinnedAddresses).toEqual(['93.184.216.34']);
  });

  it('b23 跳到非视频页 → UNSUPPORTED_LINK_TYPE', async () => {
    const { adapterDeps } = biliDeps({
      'b23.tv/bad': { status: 302, headers: { location: 'https://www.bilibili.com/space/123' }, body: '' },
      'www.bilibili.com/space/123': { body: 'ok' },
    });
    const adapter = createBilibiliAdapter(adapterDeps);
    await expect(
      adapter.expandShortLink('https://b23.tv/bad', { scope: 'public', deadline: Date.now() + 5000 }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_LINK_TYPE' });
  });
});

describe('小红书适配器（会话桥停用现状）', () => {
  const deps = () => {
    const { deps: safeFetchDeps, calls } = fakeDeps({
      'xhslink.com/a/9Kd2Lm': {
        status: 302,
        headers: { location: 'https://www.xiaohongshu.com/explore/AbC123xYz?xsec_token=SECRET_TOKEN' },
        body: '',
      },
      'www.xiaohongshu.com/explore/AbC123xYz': { body: 'ok' },
    });
    return {
      adapter: createXiaohongshuAdapter({ safeFetch: safeFetchDeps, allowedHosts: PLATFORM_HOSTS.xiaohongshu }),
      calls,
    };
  };

  it('health 如实标 auth_required', async () => {
    const { adapter } = deps();
    expect(await adapter.health()).toMatchObject({ status: 'auth_required' });
    expect(adapter.capabilities.detail).toBe(false);
  });

  it('短链展开可用，但签名参数不进 resolvedUrl', async () => {
    const { adapter } = deps();
    const target = await adapter.expandShortLink('https://xhslink.com/a/9Kd2Lm', { scope: 'public', deadline: Date.now() + 5000 });
    expect(target.externalId).toBe('AbC123xYz');
    expect(target.resolvedUrl).toBe('https://www.xiaohongshu.com/explore/AbC123xYz');
    expect(target.resolvedUrl).not.toContain('xsec_token');
  });

  it('正文一律 AUTH_REQUIRED，不伪造内容也不恢复会话', async () => {
    const { adapter } = deps();
    await expect(
      adapter.fetchContent(
        {
          platform: 'xiaohongshu',
          externalId: 'AbC123xYz',
          partKey: null,
          canonicalUrl: 'https://www.xiaohongshu.com/explore/AbC123xYz',
          resolvedUrl: 'https://www.xiaohongshu.com/explore/AbC123xYz',
        },
        { scope: 'public', deadline: Date.now() + 5000 },
      ),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED', reason: 'xhs_session_bridge_disabled' });
  });
});

describe('抖音适配器（HTML 分享页，未验证标记）', () => {
  const douyinTarget: SourceTarget = {
    platform: 'douyin',
    externalId: '7300123456789012345',
    partKey: null,
    canonicalUrl: 'https://www.douyin.com/video/7300123456789012345',
    resolvedUrl: 'https://www.douyin.com/video/7300123456789012345',
  };
  const build = (html: string, extra?: Record<string, { status?: number; body: string; headers?: Record<string, string> }>) => {
    const { deps: safeFetchDeps, calls } = fakeDeps({
      'www.iesdouyin.com/share/video/7300123456789012345/': { body: html },
      ...extra,
    });
    return {
      adapter: createDouyinAdapter({ safeFetch: safeFetchDeps, allowedHosts: PLATFORM_HOSTS.douyin }),
      calls,
    };
  };

  it('health 标 degraded，版本号带 unverified', async () => {
    const { adapter } = build(douyinHtml);
    expect(await adapter.health()).toMatchObject({ status: 'degraded' });
    expect(adapter.version).toContain('unverified');
  });

  it('从 _ROUTER_DATA 解析正文/作者/封面/统计', async () => {
    const { adapter } = build(douyinHtml);
    const record = await adapter.fetchContent(douyinTarget, { scope: 'public', deadline: Date.now() + 5000, now: () => 1700000000000 });
    expect(record.id).toBe('douyin:douyin-public:7300123456789012345');
    expect(record.body.text).toContain('虚构分享文案');
    expect(record.title).toBeNull();
    expect(record.author).toMatchObject({ name: '夹具作者', id: '70000000001' });
    expect(record.counts).toEqual({ likes: 1234, comments: 56 });
    expect(record.images[0].safeUrl).toBe('https://p3.douyinpic.com/fixture-cover.jpeg');
    expect(record.publishedAt).toBe(1700000000000);
    expect(record.attribution.retrievalMethod).toBe('douyin_share_html_unverified');
    expect(record.limits.notes.some((n) => n.startsWith('adapter_unverified'))).toBe(true);
    // 不下载视频字节：images 只有封面，media 不出现 video 项
    expect(record.images.every((i) => i.type === 'image')).toBe(true);
    expect(record.commentsSample?.availability).toBe('not_requested');
  });

  it('访问控制页 → AUTH_REQUIRED（不绕过风控）', async () => {
    const { adapter } = build('<html><body>请登录后查看 安全验证</body></html>');
    await expect(
      adapter.fetchContent(douyinTarget, { scope: 'public', deadline: Date.now() + 5000 }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED', reason: 'douyin_auth_wall' });
  });

  it('页面完全没有 _ROUTER_DATA → UPSTREAM_CHANGED（结构变了）', async () => {
    const { adapter } = build('<html><body>nothing here</body></html>');
    await expect(
      adapter.fetchContent(douyinTarget, { scope: 'public', deadline: Date.now() + 5000 }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_CHANGED', reason: 'douyin_router_data_missing' });
  });

  it('有 _ROUTER_DATA 但没有 aweme 节点 → CONTENT_NOT_FOUND（真实探测：不存在的 id 就长这样）', async () => {
    const { adapter } = build(
      '<html><script>window._ROUTER_DATA = {"loaderData":{},"errors":{"status_code":404}};</script></html>',
    );
    await expect(
      adapter.fetchContent(douyinTarget, { scope: 'public', deadline: Date.now() + 5000 }),
    ).rejects.toMatchObject({ code: 'CONTENT_NOT_FOUND', reason: 'douyin_aweme_absent' });
  });

  it('v.douyin 短链展开到 video id', async () => {
    const { adapter } = build(douyinHtml, {
      'v.douyin.com/iRxAbCdE/': { status: 302, headers: { location: 'https://www.douyin.com/video/7300123456789012345' }, body: '' },
      'www.douyin.com/video/7300123456789012345': { body: 'ok' },
    });
    const target = await adapter.expandShortLink('https://v.douyin.com/iRxAbCdE/', { scope: 'public', deadline: Date.now() + 5000 });
    expect(target.externalId).toBe('7300123456789012345');
    expect(target.canonicalUrl).toBe('https://www.douyin.com/video/7300123456789012345');
  });
});
