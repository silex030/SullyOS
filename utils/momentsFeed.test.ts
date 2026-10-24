// utils/momentsFeed.test.ts（Task 1 先建文件，后续任务追加用例）
import { describe, it, expect } from 'vitest';
import { AppID } from '../types';
describe('moments entry', () => {
  it('AppID.Moments 为 moments', () => { expect(AppID.Moments).toBe('moments'); });
});
describe('moments cover', () => {
  it('超 1MB 封面拒绝', async () => {
    const { coverSizeOk } = await import('./momentsFeed.js');
    expect(coverSizeOk(1024 * 1024 + 1)).toBe(false);
    expect(coverSizeOk(1024 * 1024)).toBe(true);
  });
});
describe('moments feed', () => {
  it('mastodon status 归一化（visibility/图/远端 id）', async () => {
    const { normalizeMastodonStatus } = await import('./momentsFeed.js');
    const p = normalizeMastodonStatus({ id: 's1', url: 'https://mstdn.social/@me/1', content: '<p>hi</p>', visibility: 'private', created_at: '2026-09-23T00:00:00Z', in_reply_to_id: null, media_attachments: [{ id: 'm1', url: 'https://mstdn.social/m1.png' }] }, 'mstdn.social', 'user');
    expect(p.origin).toBe('mastodon');
    expect(p.mastodonStatusId).toBe('s1');
    expect(p.images).toEqual(['https://mstdn.social/m1.png']);
    expect(p.content).toBe('hi');
  });
  it('远端 id 去重（本地已有的不插）', async () => {
    const { dedupeByRemoteId } = await import('./momentsFeed.js');
    const local = [{ id: 'l1', mastodonStatusId: 's1' }];
    const fresh = [{ id: 'x', mastodonStatusId: 's1' }, { id: 'y', mastodonStatusId: 's2' }];
    expect(dedupeByRemoteId(local as never, fresh as never).map((p: { id: string }) => p.id)).toEqual(['y']);
  });
  it('小手机可见性映射（默认 private）', async () => {
    const { toMastodonVisibility } = await import('./momentsFeed.js');
    expect(toMastodonVisibility('public')).toBe('unlisted');
    expect(toMastodonVisibility('private')).toBe('private');
    expect(toMastodonVisibility(undefined)).toBe('private');
  });
  it('只留简繁中文（language 为准，缺失看正文）', async () => {
    const { isChineseStatus } = await import('./momentsFeed.js');
    expect(isChineseStatus({ language: 'zh-CN', text: '' })).toBe(true);
    expect(isChineseStatus({ language: 'zh-TW', text: '' })).toBe(true);
    expect(isChineseStatus({ language: 'en', text: '' })).toBe(false);
    expect(isChineseStatus({ language: null, text: '今天天气不错' })).toBe(true);
    expect(isChineseStatus({ language: null, text: 'hello world' })).toBe(false);
  });
  it('去重带实例维度（不同实例同 id 不丢）', async () => {
    const { dedupeByRemoteId } = await import('./momentsFeed.js');
    const local = [{ id: 'l1', mastodonStatusId: '7', mastodonInstance: 'a.social' }];
    const fresh = [
      { id: 'x', mastodonStatusId: '7', mastodonInstance: 'a.social' },
      { id: 'y', mastodonStatusId: '7', mastodonInstance: 'b.social' },
    ];
    expect(dedupeByRemoteId(local as never, fresh as never).map((p: { id: string }) => p.id)).toEqual(['y']);
  });
  it('朋友圈可见性只收熟人线（mastodon / 本地手发）', async () => {
    const { visibleInMoments } = await import('./momentsFeed.js');
    expect(visibleInMoments({ origin: 'mastodon' } as never)).toBe(true);
    expect(visibleInMoments({ origin: 'moments' } as never)).toBe(true);
    // Spark 移除后遗留的旧帖来源（douban / gen）一律不进朋友圈，旧库数据不会突然冒出来
    expect(visibleInMoments({ origin: 'douban' } as never)).toBe(false);
    expect(visibleInMoments({ origin: 'gen' } as never)).toBe(false);
  });
});
describe('extractStatuses', () => {
  it('structuredContent.statuses 最高优先级', async () => {
    const { extractStatuses } = await import('./momentsFeed.js');
    expect(extractStatuses(null, { statuses: [{ id: '1' }] })).toEqual([{ id: '1' }]);
  });
  it('data.statuses 原分支照旧', async () => {
    const { extractStatuses } = await import('./momentsFeed.js');
    expect(extractStatuses({ statuses: [{ id: '2' }] }, undefined)).toEqual([{ id: '2' }]);
  });
  it('字符串“取回 N 条”回 [] 不抛', async () => {
    const { extractStatuses } = await import('./momentsFeed.js');
    expect(extractStatuses('取回 20 条', undefined)).toEqual([]);
  });
});
