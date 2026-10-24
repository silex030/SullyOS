/**
 * 端到端链路测试（集成卡 t_babca897）：发消息 → 解析 → 卡片 → 下一轮上下文。
 *
 * 这条用例跨两侧代码：服务端 service（真实 SQLite + 状态机）与客户端投影
 * （utils/socialShare.buildShareMessageProjection）。适配器是测试桩，因此这里证明的是
 * “接线与状态/预算正确”，**不证明任何平台真实可达**（真实探测见集成文档）。
 */

import { describe, expect, it } from 'vitest';
import { createSocialService, withContentPersistence } from './service';
import { D1SocialStore } from './store';
import { openTestD1 } from './testDb';
import { readSocialConfig } from './config';
import { buildRecord } from '../record';
import { SocialError } from '../errors';
import type { ContentAdapter } from '../adapter';
import type { ContentRecord, ShareAttachment } from '../../../utils/socialContent/types';
import { buildShareMessageProjection, planShareText, mergeShareAttachments, estimateShareTokens } from '../../../utils/socialShare';

const NOW = 1_790_000_000_000;
const USER_TEXT = '帮我看看 https://www.bilibili.com/video/BV1xx411c7mD 讲了啥？';

function biliRecord(): ContentRecord {
  return buildRecord({
    platform: 'bilibili',
    sourceId: 'public',
    externalId: 'BV1xx411c7mD',
    author: { id: '1', name: 'UP主', avatarUrl: null, profileUrl: null },
    title: '端到端夹具标题',
    text: '正文简介：这是一次端到端测试。',
    images: [],
    canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    publishedAt: NOW - 1000,
    fetchedAt: NOW,
    platformName: 'B站',
    retrievalMethod: 'public_api',
    transcripts: [
      {
        id: 'tr',
        partKey: null,
        kind: 'native_caption',
        language: 'zh-CN',
        provider: 'bilibili_native',
        availability: 'available',
        segments: [{ id: 's1', startMs: 0, endMs: 1500, text: '第一句字幕' }],
        plainText: '第一句字幕',
        truncated: false,
        originalLength: null,
        fetchedAt: NOW,
        sourceRef: 'bilibili:public:subtitle',
      },
    ],
    commentsSample: null,
  });
}

function adapter(behaviour: { fail?: string } = {}): ContentAdapter {
  return {
    id: 'fake',
    platform: 'bilibili',
    version: 'test',
    capabilities: { detail: true, comments: false, shortLink: true, transcript: true },
    async health() {
      return { status: 'configured' as const, note: 'test' };
    },
    async expandShortLink(url: string) {
      return { platform: 'bilibili' as const, externalId: 'BV1xx411c7mD', partKey: null, canonicalUrl: url, resolvedUrl: url };
    },
    async fetchContent() {
      if (behaviour.fail) throw new SocialError(behaviour.fail as never, 'stub_failure');
      return biliRecord();
    },
  };
}

function build(initial: { fail?: string } = {}) {
  const behaviour: { fail?: string } = { ...initial };
  const db = openTestD1();
  const store = new D1SocialStore(db as never);
  const cfg = readSocialConfig({ SHARE_LINKS_ENABLED: 'true' } as never);
  const service = createSocialService({
    config: cfg,
    store,
    adapters: { bilibili: withContentPersistence(adapter(behaviour), store, { cacheAllowed: true }) },
    sourceIdFor: () => 'public',
    now: () => NOW,
  });
  return { db, store, service, behaviour };
}

describe('端到端：链接分享 → 卡片 → 下一轮上下文', () => {
  it('发送前识别 → 解析 → 卡片 → 下一轮模型看到投影而不是原始长链接', async () => {
    const { service } = build();
    expect(planShareText(USER_TEXT)?.platforms).toEqual(['bilibili']);

    const res = await service.resolve('deployment', { messageId: '101', conversationId: 'char-1', characterId: 'char-1', text: USER_TEXT });
    expect(res.status).toBe(202);
    const att = (res.body as { attachments: ShareAttachment[] }).attachments[0];
    expect(att.state).toBe('ready');

    const projection = buildShareMessageProjection(USER_TEXT, [att])!;
    expect(projection).toContain('[分享 shr_');
    expect(projection).not.toContain('https://www.bilibili.com');
    expect(projection).toContain('讲了啥');
    expect(projection).toContain('端到端夹具标题');
    // 预算：单卡 350 + 同消息 1200 之内
    expect(estimateShareTokens(projection)).toBeLessThan(1200);
  });

  it('重复 POST 不产生第二张卡（幂等），shareRef 稳定', async () => {
    const { service, db } = build();
    const first = await service.resolve('deployment', { messageId: '102', conversationId: 'char-1', text: USER_TEXT });
    const second = await service.resolve('deployment', { messageId: '102', conversationId: 'char-1', text: USER_TEXT });
    const a = (first.body as any).attachments[0];
    const b = (second.body as any).attachments[0];
    expect(b.shareRef).toBe(a.shareRef);
    expect(db.count('social_share_attachments')).toBe(1);
  });

  it('失败 → 卡片显示原因 → 重试成功 → 下一轮投影变成已读取', async () => {
    const { service, db, behaviour } = build({ fail: 'TIMEOUT' });
    const first = await service.resolve('deployment', { messageId: '103', conversationId: 'char-1', text: USER_TEXT });
    const failed = (first.body as any).attachments[0];
    expect(failed.state).toBe('failed');

    const projectionBefore = buildShareMessageProjection(USER_TEXT, [failed])!;
    expect(projectionBefore).toContain('未读取原因：TIMEOUT');
    expect(projectionBefore).toContain('可重试');
    expect(projectionBefore).not.toContain('端到端夹具标题');

    // 网络恢复后手动重试：同一个库、同一个 service，只是适配器这次能成功
    behaviour.fail = undefined;
    const retried = await service.retry('deployment', failed.shareRef, { expectedRevision: failed.revision });
    expect(retried.status).toBe(202);
    const ready = (retried.body as any).attachment;
    expect(ready.state).toBe('ready');
    expect(ready.attempt).toBe(2);

    const projectionAfter = buildShareMessageProjection(USER_TEXT, [ready])!;
    expect(projectionAfter).toContain('已读取');
    expect(projectionAfter).toContain('端到端夹具标题');
    // 库里也只留最新一份
    expect(db.count('social_share_attachments')).toBe(1);
  });

  it('晚到/轮询合并：旧 revision/旧 attempt 不覆盖新状态', () => {
    const ready = {
      shareRef: 'shr_x',
      attempt: 1,
      revision: 5,
      state: 'ready',
    } as unknown as ShareAttachment;
    const stale = { shareRef: 'shr_x', attempt: 1, revision: 4, state: 'resolving' } as unknown as ShareAttachment;
    const retried = { shareRef: 'shr_x', attempt: 2, revision: 6, state: 'queued' } as unknown as ShareAttachment;
    expect(mergeShareAttachments([ready], [stale])[0].state).toBe('ready');
    expect(mergeShareAttachments([ready], [retried])[0].attempt).toBe(2);
    expect(mergeShareAttachments([retried], [ready])[0].attempt).toBe(2);
  });
});
