import { describe, expect, it } from 'vitest';
import {
  buildShareUpdateEvent,
  planRetry,
  resolveShares,
  shouldIgnoreEvent,
  stateFromRecord,
  type ResolveDeps,
  type ShareStore,
} from './resolver';
import { buildRecord } from './record';
import type { AdapterDeps, ContentAdapter } from './adapter';
import { SHARE_FEATURE_DEFAULTS, type ContentRecord, type ShareAttachment } from '../../utils/socialContent/types';
import { RevisionConflictError } from './errors';

/**
 * shares/resolve 编排的契约测试（t_2c2dba79，契约 3.2/3.4/4.1）。
 * 适配器全部是内存假实现：这里验证状态机与限额，不验证平台读取（见 adapters.test.ts）。
 */

const NOW = 1700000000000;

function makeRecord(overrides: Partial<Parameters<typeof buildRecord>[0]> = {}): ContentRecord {
  return buildRecord({
    platform: 'bilibili',
    sourceId: 'bilibili-public',
    externalId: 'BV1xx411c7mD',
    author: { id: '1', name: '夹具作者', avatarUrl: null, profileUrl: null },
    title: '夹具标题',
    text: `正文开头${'填充'.repeat(120)}正文结尾标记`,
    images: [],
    canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    publishedAt: NOW - 1000,
    fetchedAt: NOW,
    platformName: '哔哩哔哩',
    retrievalMethod: 'fixture',
    ...overrides,
  });
}

function fakeAdapter(platform: 'bilibili' | 'douyin' | 'xiaohongshu', opts: {
  record?: ContentRecord;
  fetchError?: Error;
  delayMs?: number;
  expand?: { externalId: string; canonicalUrl: string };
} = {}): ContentAdapter {
  return {
    id: `fake-${platform}`,
    platform,
    version: 'test',
    capabilities: { detail: true, comments: false, shortLink: true, transcript: false },
    health: async () => ({ status: 'configured', note: 'fake' }),
    async expandShortLink() {
      if (!opts.expand) throw new Error('expand not stubbed');
      return {
        platform,
        externalId: opts.expand.externalId,
        partKey: null,
        canonicalUrl: opts.expand.canonicalUrl,
        resolvedUrl: opts.expand.canonicalUrl,
      };
    },
    async fetchContent() {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fetchError) throw opts.fetchError;
      return opts.record ?? makeRecord();
    },
  };
}

const baseReq = {
  messageId: 'msg-1',
  conversationId: 'conv-1',
  characterId: null,
  scope: 'public',
};

const sourceIds: Record<string, string> = { bilibili: 'bilibili-public', douyin: 'douyin-public' };

const buildDeps = (opts: {
  adapters?: Record<string, ContentAdapter>;
  sourceIdFor?: (p: string) => string | null;
  store?: ShareStore | null;
  deadlineMs?: number;
}): ResolveDeps => {
  let counter = 0;
  return {
    adapters: opts.adapters ?? {},
    sourceIdFor: opts.sourceIdFor ?? ((p: string) => sourceIds[p] ?? null),
    now: () => NOW,
    newShareRef: () => `shr_test_${++counter}`,
    store: opts.store ?? null,
    resolveDeadlineMs: opts.deadlineMs,
  };
};

describe('正常解析与状态', () => {
  it('混合文本：B 站成功、抖音成功、TikTok 明确不支持，顺序与原文一致', async () => {
    const bili = fakeAdapter('bilibili');
    const douyin = fakeAdapter('douyin', {
      record: makeRecord({ platform: 'douyin', sourceId: 'douyin-public', externalId: '7300123456789012345' }),
    });
    const result = await resolveShares(
      {
        ...baseReq,
        text: '看这个 https://www.bilibili.com/video/BV1xx411c7mD 和 https://www.douyin.com/video/7300123456789012345 还有 https://www.tiktok.com/@a/video/123',
      },
      buildDeps({ adapters: { bilibili: bili, douyin } }),
    );

    expect(result.attachments).toHaveLength(3);
    expect(result.attachments.map((a) => a.originalUrl)).toEqual([
      'https://www.bilibili.com/video/BV1xx411c7mD',
      'https://www.douyin.com/video/7300123456789012345',
      'https://www.tiktok.com/@a/video/123',
    ]);
    expect(result.attachments[0]).toMatchObject({
      state: 'ready',
      contentId: 'bilibili:bilibili-public:BV1xx411c7mD',
      error: null,
    });
    expect(result.attachments[1].state).toBe('ready');
    expect(result.attachments[2].state).toBe('failed');
    expect(result.attachments[2].error?.code).toBe('UNSUPPORTED_REGION_OR_PRODUCT');
    // 卡片只放引用/预览/简介：正文全文不进 attachment
    const serialized = JSON.stringify(result.attachments[0]);
    expect(serialized).toContain('夹具标题');
    expect(serialized).not.toContain('正文结尾标记');
    expect('body' in result.attachments[0]).toBe(false);
    expect(result.attachments[0].preview?.excerpt?.length ?? 0).toBeLessThanOrEqual(120);
  });

  it('同链接重复出现合并一张卡、保留多个 span', async () => {
    const result = await resolveShares(
      { ...baseReq, text: 'https://www.bilibili.com/video/BV1xx411c7mD 再来 https://www.bilibili.com/video/BV1xx411c7mD#t=1' },
      buildDeps({ adapters: { bilibili: fakeAdapter('bilibili') } }),
    );
    // 带 fragment 的同一 BV 仍是同一条内容（dedupe 按 platform+externalId+partKey）
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].state).toBe('ready');
  });

  it('短链先受控展开，contentId 用展开后的外部 ID', async () => {
    const adapter = fakeAdapter('douyin', {
      expand: { externalId: '7300123456789012345', canonicalUrl: 'https://www.douyin.com/video/7300123456789012345' },
      record: makeRecord({ platform: 'douyin', sourceId: 'douyin-public', externalId: '7300123456789012345' }),
    });
    const result = await resolveShares({ ...baseReq, text: 'https://v.douyin.com/iRxAbCdE/' }, buildDeps({ adapters: { douyin: adapter } }));
    expect(result.attachments[0].state).toBe('ready');
    expect(result.attachments[0].resolvedUrl).toBe('https://www.douyin.com/video/7300123456789012345');
    expect(result.attachments[0].contentId).toBe('douyin:douyin-public:7300123456789012345');
  });

  it('评论样本失败 → partial，并在 contextProjection 标明缺什么', async () => {
    const record = makeRecord({
      commentsSample: {
        availability: 'failed',
        items: [],
        selection: 'unknown',
        requestedLimit: 5,
        returnedCount: 0,
        pagesFetched: 0,
        totalAvailable: null,
        hasMore: null,
        fetchedAt: NOW,
        truncated: false,
        scopeDescription: 'x',
      },
    });
    const result = await resolveShares(
      { ...baseReq, text: 'https://www.bilibili.com/video/BV1xx411c7mD' },
      buildDeps({ adapters: { bilibili: fakeAdapter('bilibili', { record }) } }),
    );
    const att = result.attachments[0];
    expect(att.state).toBe('partial');
    expect(att.contextProjection?.reason).toContain('missing:comments');
    expect(att.contextProjection?.evidenceCoverage).not.toContain('comments');
  });

  it('stateFromRecord：没有标题/封面不算失败；正文或字幕/评论失败才降级', () => {
    expect(stateFromRecord(makeRecord()).state).toBe('ready');
    expect(stateFromRecord(makeRecord({ title: null })).state).toBe('ready');
    expect(stateFromRecord(makeRecord({ title: 't', text: '正文' })).coverage).toContain('text');
    // 正文被限制访问 → 降级
    const restricted = makeRecord({ text: '', status: 'restricted' });
    expect(stateFromRecord(restricted).state).toBe('partial');
    expect(stateFromRecord(restricted).missing).toContain('text');
  });
});

describe('失败与限额', () => {
  it('适配器抛 AUTH_REQUIRED → failed 且 retryable=false', async () => {
    const { SocialError } = await import('./errors');
    const result = await resolveShares(
      { ...baseReq, text: 'https://www.xiaohongshu.com/explore/AbC123' },
      buildDeps({
        adapters: { xiaohongshu: fakeAdapter('xiaohongshu', { fetchError: new SocialError('AUTH_REQUIRED', 'xhs_session_bridge_disabled') }) },
        sourceIdFor: () => 'xhs-public',
      }),
    );
    expect(result.attachments[0].state).toBe('failed');
    expect(result.attachments[0].error).toMatchObject({ code: 'AUTH_REQUIRED', retryable: false });
  });

  it('平台未配置来源 → SOURCE_NOT_CONFIGURED，且不调用适配器', async () => {
    let called = false;
    const adapter = fakeAdapter('bilibili');
    adapter.fetchContent = async () => {
      called = true;
      return makeRecord();
    };
    const result = await resolveShares(
      { ...baseReq, text: 'https://www.bilibili.com/video/BV1xx411c7mD' },
      buildDeps({ adapters: { bilibili: adapter }, sourceIdFor: () => null }),
    );
    expect(result.attachments[0]).toMatchObject({ state: 'failed' });
    expect(result.attachments[0].error?.code).toBe('SOURCE_NOT_CONFIGURED');
    expect(called).toBe(false);
  });

  it('超过 5 条链接：第 6、7 条 failed + SIZE_LIMIT，不静默丢弃', async () => {
    const text = Array.from({ length: 7 }, (_, i) => `https://www.douyin.com/video/73001234567890123${i}`).join(' ');
    const result = await resolveShares(
      { ...baseReq, text },
      buildDeps({ adapters: { douyin: fakeAdapter('douyin') }, sourceIdFor: () => 'douyin-public' }),
    );
    expect(result.attachments).toHaveLength(7);
    expect(result.droppedOverLimit).toBe(2);
    const failed = result.attachments.filter((a) => a.error?.code === 'SIZE_LIMIT');
    expect(failed).toHaveLength(2);
    expect(result.attachments.filter((a) => a.state === 'ready')).toHaveLength(5);
  });

  it('超过整体期限 → TIMEOUT，且不残留 resolving', async () => {
    const slow = fakeAdapter('bilibili', { delayMs: 200 });
    const result = await resolveShares(
      { ...baseReq, text: 'https://www.bilibili.com/video/BV1xx411c7mD' },
      buildDeps({ adapters: { bilibili: slow }, deadlineMs: 10 }),
    );
    expect(result.attachments[0].state).toBe('failed');
    expect(result.attachments[0].error?.code).toBe('TIMEOUT');
    expect(result.attachments.some((a) => a.state === 'resolving' || a.state === 'queued')).toBe(false);
  });
});

describe('持久化与 retry', () => {
  const memoryStore = (): ShareStore & { rows: Map<string, ShareAttachment> } => {
    const rows = new Map<string, ShareAttachment>();
    return {
      rows,
      async put(att, expectedRevision) {
        if (expectedRevision === 0) {
          if (rows.has(att.shareRef)) return false;
          rows.set(att.shareRef, att);
          return true;
        }
        const existing = rows.get(att.shareRef);
        if (!existing || existing.revision !== expectedRevision) return false;
        rows.set(att.shareRef, att);
        return true;
      },
      async get(ref) {
        return rows.get(ref) ?? null;
      },
      async listByMessage(_scope, messageId) {
        return [...rows.values()].filter((r) => r.messageId === messageId);
      },
    };
  };

  it('有 store：终态落库，persistence=available', async () => {
    const store = memoryStore();
    const result = await resolveShares(
      { ...baseReq, text: 'https://www.bilibili.com/video/BV1xx411c7mD' },
      { ...buildDeps({ adapters: { bilibili: fakeAdapter('bilibili') } }), store },
    );
    expect(result.persistence).toBe('available');
    expect(store.rows.size).toBe(1);
    expect([...store.rows.values()][0].state).toBe('ready');
  });

  it('没有 store：明确 persistence=unavailable，不假装持久化', async () => {
    const result = await resolveShares(
      { ...baseReq, text: 'https://www.bilibili.com/video/BV1xx411c7mD' },
      buildDeps({ adapters: { bilibili: fakeAdapter('bilibili') } }),
    );
    expect(result.persistence).toBe('unavailable');
  });

  it('planRetry：attempt/revision 单调递增并清空内容引用', () => {
    const base: ShareAttachment = {
      schemaVersion: 1,
      shareRef: 'shr_1',
      messageId: 'm',
      conversationId: 'c',
      characterId: null,
      occurrenceSpans: [{ start: 0, end: 10 }],
      originalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
      platform: 'bilibili',
      sourceId: 'bilibili-public',
      resolvedUrl: null,
      canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
      openUrl: null,
      contentId: 'bilibili:bilibili-public:BV1xx411c7mD',
      partKey: null,
      state: 'failed',
      revision: 3,
      attempt: 1,
      createdAt: NOW,
      updatedAt: NOW,
      error: { code: 'TIMEOUT', retryable: true, retryAfterMs: null, userMessage: 'x', safeDiagnosticId: null },
      preview: null,
      contextProjection: null,
    };
    const next = planRetry(base, 3, NOW + 1);
    expect(next).toMatchObject({ state: 'queued', attempt: 2, revision: 4, contentId: null, error: null });
    expect(() => planRetry(base, 2, NOW + 1)).toThrow(RevisionConflictError);
  });
});

describe('UI 事件与开关默认值', () => {
  it('social-share.updated 事件带完整 attachment，旧 attempt/revision 被丢弃', async () => {
    const result = await resolveShares(
      { ...baseReq, text: 'https://www.bilibili.com/video/BV1xx411c7mD' },
      buildDeps({ adapters: { bilibili: fakeAdapter('bilibili') } }),
    );
    const att = result.attachments[0];
    const event = buildShareUpdateEvent(att);
    expect(event).toMatchObject({
      event: 'social-share.updated',
      schemaVersion: 1,
      shareRef: att.shareRef,
      messageId: att.messageId,
      attempt: att.attempt,
      revision: att.revision,
      state: 'ready',
    });
    expect(event.attachment.contentId).toBe(att.contentId);

    // 同一 attempt 下更旧/相同 revision 不覆盖
    expect(shouldIgnoreEvent(event, { attempt: att.attempt, revision: att.revision })).toBe(true);
    expect(shouldIgnoreEvent(event, { attempt: att.attempt, revision: att.revision + 1 })).toBe(true);
    // 新的 attempt 即使 revision 更小也要接受
    expect(shouldIgnoreEvent({ ...event, attempt: att.attempt + 1, revision: 1 }, { attempt: att.attempt, revision: 99 })).toBe(false);
  });

  it('契约 7.2 默认值：总开关/ASR/实验评论/RedNote 会话默认关闭', () => {
    expect(SHARE_FEATURE_DEFAULTS.SHARE_LINKS_ENABLED).toBe(false);
    expect(SHARE_FEATURE_DEFAULTS.TRANSCRIPTION_ENABLED).toBe(false);
    expect(SHARE_FEATURE_DEFAULTS.EXPERIMENTAL_XHS_COMMENTS).toBe(false);
    expect(SHARE_FEATURE_DEFAULTS.REDNOTE_INDEPENDENT_SESSION).toBe(false);
    expect(SHARE_FEATURE_DEFAULTS.MAX_LINKS_PER_MESSAGE).toBe(5);
    expect(SHARE_FEATURE_DEFAULTS.RESOLVE_DEADLINE_MS).toBe(20000);
  });
});
