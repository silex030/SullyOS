/**
 * 链接分享客户端接线测试（集成卡 t_babca897）。
 *
 * 全部是纯函数 + fetch 桩：不发真实网络请求；真实平台可达性见
 * docs/social-content/integration-v1.md 的探测表（这里不冒充真实支持）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildShareMessageProjection,
  estimateShareTokens,
  fetchShareExcerpts,
  isSocialShareEnabled,
  mergeShareAttachments,
  planShareText,
  resolveShareEndpoint,
  resolveSharesForMessage,
  retryShare,
  safeOpenUrl,
  shortShareRef,
  type SocialShareConfig,
} from './socialShare';
import { SHARE_BUDGETS, type ShareAttachment } from './socialContent/types';

const longText = (n: number) => '字'.repeat(n);

function attachment(over: Partial<ShareAttachment> = {}): ShareAttachment {
  return {
    schemaVersion: 1,
    shareRef: 'shr_0123456789abcdef0123456789abcdef',
    messageId: '101',
    conversationId: 'char-1',
    characterId: 'char-1',
    occurrenceSpans: [{ start: 6, end: 46 }],
    originalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    platform: 'bilibili',
    sourceId: 'public',
    resolvedUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    openUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    contentId: 'bilibili:public:BV1xx411c7mD',
    partKey: null,
    state: 'ready',
    revision: 4,
    attempt: 1,
    createdAt: 1,
    updatedAt: 2,
    error: null,
    preview: { title: '夹具视频标题', authorName: 'UP主', platformName: 'B站', siteName: 'B站', coverUrl: null, excerpt: '这是虚构的正文' },
    contextProjection: {
      projectionVersion: 1,
      shareRef: 'shr_0123456789abcdef0123456789abcdef',
      contentId: 'bilibili:public:BV1xx411c7mD',
      contentRevision: 1,
      stateAtFreeze: 'ready',
      summaryText: 'B站 · UP主：夹具视频标题：这是虚构的正文',
      evidenceCoverage: ['title', 'text', 'transcript'],
      reason: null,
      frozenAt: 2,
    },
    ...over,
  };
}

const cfg = (over: Partial<SocialShareConfig> = {}): SocialShareConfig => ({
  enabled: true,
  baseUrl: 'https://os.example.com',
  token: 'client-token',
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('分享识别（发送前）', () => {
  it('识别三平台长短链并给出平台集合', () => {
    const plan = planShareText('看这个 https://b23.tv/BV1xx411c7mD 和 https://www.douyin.com/video/7300123456789012345');
    expect(plan?.platforms.sort()).toEqual(['bilibili', 'douyin']);
    expect(plan?.linkCount).toBe(2);
    expect(plan?.overLimit).toBe(false);
  });

  it('没有平台链接 / 只有不支持的平台 → null（保持原有发送行为）', () => {
    expect(planShareText('今天吃什么')).toBeNull();
    expect(planShareText('https://www.tiktok.com/@a/video/1')).toBeNull();
    expect(planShareText('https://example.com/article')).toBeNull();
  });

  it('超过 5 条链接标记 overLimit（服务端逐项 SIZE_LIMIT）', () => {
    const text = Array.from({ length: 6 }, (_, i) => `https://www.bilibili.com/video/BV1xx411c7m${i}`).join(' ');
    expect(planShareText(text)?.overLimit).toBe(true);
  });

  it('超长文本不进入分享链路（16000 UTF-16 上限）', () => {
    expect(planShareText(longText(16001) + ' https://b23.tv/BV1xx411c7mD')).toBeNull();
  });
});

describe('模型投影（后续轮次）', () => {
  it('链接替换成 shareRef，问题保留，简介进投影', () => {
    const text = '看看 https://www.bilibili.com/video/BV1xx411c7mD 讲了啥？';
    const proj = buildShareMessageProjection(text, [attachment()], { userName: '我' })!;
    expect(proj).toContain('[分享 shr_0123456789abcdef0123456789abcdef]');
    expect(proj).not.toContain('https://www.bilibili.com');
    expect(proj).toContain('讲了啥');
    expect(proj).toContain('夹具视频标题');
    expect(proj).toContain('已获取：title/text/transcript');
    expect(proj).not.toContain('这是虚构的正文'.repeat(5));
  });

  it('失败卡只给状态与原因，不编造正文', () => {
    const failed = attachment({
      state: 'failed',
      contentId: null,
      preview: null,
      contextProjection: null,
      error: { code: 'AUTH_REQUIRED', retryable: false, retryAfterMs: null, userMessage: '需要登录', safeDiagnosticId: null },
    });
    const proj = buildShareMessageProjection('看这个 https://www.xiaohongshu.com/explore/x', [failed])!;
    expect(proj).toContain('未读取原因：AUTH_REQUIRED');
    expect(proj).toContain('需要登录');
    expect(proj).not.toContain('简介：');
  });

  it('单卡按 350 token 夹紧，同消息多卡按 1200 token 总量夹紧', () => {
    const huge = attachment({
      contextProjection: { ...attachment().contextProjection!, summaryText: longText(5000) },
    });
    const oneCard = buildShareMessageProjection('x https://www.bilibili.com/video/BV1xx411c7mD', [huge])!;
    const cardPart = oneCard.split('[分享 ')[1];
    expect(estimateShareTokens(cardPart)).toBeLessThanOrEqual(SHARE_BUDGETS.summaryPerCardTokens + 40);

    const many = Array.from({ length: 5 }, (_, i) =>
      attachment({
        shareRef: `shr_${String(i).padStart(32, '0')}`,
        occurrenceSpans: [{ start: i, end: i + 1 }],
        contextProjection: { ...attachment().contextProjection!, summaryText: longText(2000) },
      }),
    );
    const total = buildShareMessageProjection('01234', many)!;
    // 卡片段仍受 1200 总量夹紧；用户原文段只承担「链接 → 完整 shareRef」的替换开销，
    // 该开销有界：每张卡最多 `[分享 ` + 36 字符 + `]` ≈ 41 字符，单条消息最多 5 个链接。
    const [textSection, ...cardSections] = total.split('\n\n');
    expect(estimateShareTokens(cardSections.join('\n\n'))).toBeLessThanOrEqual(SHARE_BUDGETS.summaryPerMessageTokens + 40);
    expect(estimateShareTokens(textSection)).toBeLessThanOrEqual(5 + 5 * 45 + 20);
    expect(estimateShareTokens(total)).toBeLessThanOrEqual(SHARE_BUDGETS.summaryPerMessageTokens + 5 * 45 + 60);
  });

  it('多链接各自替换，保留原文其他内容', () => {
    const urlA = 'https://www.bilibili.com/video/BV1xx411c7mD';
    const urlB = 'https://www.bilibili.com/video/BV1xx411c7mE';
    const text = `开头看${urlA} 中间 ${urlB} 结尾`;
    const a = attachment({
      shareRef: 'shr_' + 'a'.repeat(32),
      occurrenceSpans: [{ start: text.indexOf(urlA), end: text.indexOf(urlA) + urlA.length }],
    });
    const b = attachment({
      shareRef: 'shr_' + 'b'.repeat(32),
      occurrenceSpans: [{ start: text.indexOf(urlB), end: text.indexOf(urlB) + urlB.length }],
    });
    const proj = buildShareMessageProjection(text, [a, b])!;
    expect(proj).toContain(`[分享 shr_${'a'.repeat(32)}]`);
    expect(proj).toContain(`[分享 shr_${'b'.repeat(32)}]`);
    expect(proj).toContain('开头看');
    expect(proj).toContain('中间');
    expect(proj).toContain('结尾');
    // 原文链接不再出现在模型投影里（只在 metadata/卡片跳转里）
    expect(proj.split('\n\n')[0]).not.toContain('https://');
  });

  it('没有附件时返回 null（调用方继续走原有渲染）', () => {
    expect(buildShareMessageProjection('hi', [])).toBeNull();
    expect(buildShareMessageProjection('hi', null)).toBeNull();
  });
});

describe('状态合并与安全跳转', () => {
  it('旧 attempt / 同 attempt 旧 revision 被丢弃', () => {
    const v4 = attachment({ revision: 4 });
    const v3 = attachment({ revision: 3, state: 'resolving' });
    const v5attempt2 = attachment({ revision: 5, attempt: 2, state: 'ready' });
    expect(mergeShareAttachments([v4], [v3])[0].revision).toBe(4);
    expect(mergeShareAttachments([v4], [v5attempt2])[0].attempt).toBe(2);
    expect(mergeShareAttachments([v5attempt2], [v4])[0].attempt).toBe(2);
  });

  it('新卡按出现顺序追加，不覆盖别的 shareRef', () => {
    const a = attachment();
    const b = attachment({ shareRef: 'shr_' + 'b'.repeat(32) });
    expect(mergeShareAttachments([a], [b]).length).toBe(2);
  });

  it('跳转只放行 https；http / userinfo / 非法地址返回 null', () => {
    expect(safeOpenUrl(attachment())).toBe('https://www.bilibili.com/video/BV1xx411c7mD');
    expect(safeOpenUrl(attachment({ openUrl: 'http://www.bilibili.com/video/BV1' }))).toBeNull();
    expect(safeOpenUrl(attachment({ openUrl: 'https://user:pw@www.bilibili.com/video/BV1' }))).toBeNull();
    expect(safeOpenUrl(attachment({ openUrl: 'javascript:alert(1)' }))).toBeNull();
    expect(safeOpenUrl(attachment({ openUrl: null, resolvedUrl: null, canonicalUrl: null }))).toBeNull();
  });

  it('shortShareRef 只给 UI 用：稳定且比完整 ref 短（不得出现在模型投影里）', () => {
    const full = 'shr_0123456789abcdef0123456789abcdef';
    expect(shortShareRef(full)).toBe('shr_01234567');
  });
});

describe('HTTP 客户端', () => {
  it('地址解析：去掉用户粘进来的 /agent 前缀', () => {
    expect(resolveShareEndpoint(cfg())?.base).toBe('https://os.example.com');
    expect(resolveShareEndpoint(cfg({ baseUrl: 'https://os.example.com/agent/v1' }))?.base).toBe('https://os.example.com');
    expect(resolveShareEndpoint(cfg({ baseUrl: '' }))).toBeNull();
  });

  it('开关必须同时满足 enabled 与地址可用', () => {
    expect(isSocialShareEnabled(cfg())).toBe(true);
    expect(isSocialShareEnabled(cfg({ enabled: false }))).toBe(false);
    expect(isSocialShareEnabled(cfg({ baseUrl: '' }))).toBe(false);
  });

  it('resolve 成功：把 attachments/pollAfterMs 归一化', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ attachments: [attachment()], pollAfterMs: 1000 }), { status: 202, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await resolveSharesForMessage({ conversationId: 'char-1', messageId: '101', text: 'x', endpoint: { base: 'https://os.example.com', token: 't' } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.attachments[0].shareRef).toBe('shr_0123456789abcdef0123456789abcdef');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://os.example.com/agent/v1/social/shares/resolve');
    expect((init.headers as Record<string, string>)['X-Client-Token']).toBe('t');
  });

  it('resolve 失败（503 PERSISTENCE_UNAVAILABLE）如实返回，不当成功', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'PERSISTENCE_UNAVAILABLE', attachments: [attachment()] }), { status: 503 })),
    );
    const res = await resolveSharesForMessage({ conversationId: 'c', messageId: '1', text: 'x', endpoint: { base: 'https://os.example.com', token: '' } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(503);
      expect(res.error).toBe('PERSISTENCE_UNAVAILABLE');
      expect(res.payload?.attachments).toHaveLength(1);
    }
  });

  it('网络异常折成 NETWORK_ERROR（不抛给 UI）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('reset'), { name: 'TypeError' });
      }),
    );
    const res = await resolveSharesForMessage({ conversationId: 'c', messageId: '1', text: 'x', endpoint: { base: 'https://os.example.com', token: '' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('NETWORK_ERROR');
  });

  it('retry 带上 expectedRevision', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ attachment: attachment({ attempt: 2, revision: 6 }) }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await retryShare('shr_x', 5, { endpoint: { base: 'https://os.example.com', token: '' } });
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/agent/v1/social/shares/shr_x/retry');
    expect(JSON.parse(String(init.body))).toMatchObject({ expectedRevision: 5 });
  });

  it('excerpts 请求把 maxTokens 夹到 1200（客户端也夹一次）', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ contentId: 'c', contentRevision: 1, segments: [], nextCursor: null, truncated: false, tokenEstimate: 0 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await fetchShareExcerpts({ contentId: 'bilibili:public:BV1', contentRevision: 1, maxTokens: 99999 }, { endpoint: { base: 'https://os.example.com', token: '' } });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).maxTokens).toBe(SHARE_BUDGETS.excerptsPerCallTokens);
  });
});
