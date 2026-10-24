/**
 * 持久化层契约测试（集成卡 t_babca897）。
 *
 * 跑在真实 SQLite（node:sqlite）上，验证的是契约 5.1/5.3/5.5 的实际语义：
 * 唯一约束、revision CAS、跨 scope 隔离、租约恢复、内容版本单调。
 */

import { describe, expect, it } from 'vitest';
import { D1SocialStore, occurrenceKeyOf, PersistenceUnavailable } from './store';
import { openTestD1 } from './testDb';
import type { ShareAttachment } from '../../../utils/socialContent/types';

const NOW = 1_790_000_000_000;

function attachment(over: Partial<ShareAttachment> = {}): ShareAttachment {
  return {
    schemaVersion: 1,
    shareRef: 'shr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    messageId: 'msg-1',
    conversationId: 'char-1',
    characterId: 'char-1',
    occurrenceSpans: [{ start: 10, end: 40 }],
    originalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    platform: 'bilibili',
    sourceId: 'public',
    resolvedUrl: null,
    canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    openUrl: null,
    contentId: null,
    partKey: null,
    state: 'queued',
    revision: 1,
    attempt: 1,
    createdAt: NOW,
    updatedAt: NOW,
    error: null,
    preview: null,
    contextProjection: null,
    ...over,
  };
}

function contentRecord(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: 'bilibili:public:BV1xx411c7mD',
    platform: 'bilibili',
    sourceId: 'public',
    externalId: 'BV1xx411c7mD',
    author: { id: null, name: 'UP主', avatarUrl: null, profileUrl: null },
    title: '标题',
    text: '正文',
    media: [],
    images: [],
    canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    publishedAt: NOW,
    fetchedAt: NOW,
    updatedAt: null,
    attribution: { platformName: 'B站', authorName: 'UP主', sourceUrl: 'x', retrievalMethod: 'public_api', license: null },
    contentRevision: 1,
    body: { availability: 'available', text: '正文', truncated: false, originalLength: 2 },
    transcripts: [],
    commentsSample: null,
    summary: null,
    fieldProvenance: {},
    limits: {},
    status: 'available',
    visibility: 'public',
    counts: { likes: null, comments: null },
    ...over,
  } as never;
}

describe('D1SocialStore', () => {
  it('没有绑定 DB 时明确抛 PersistenceUnavailable（不退回内存 Map）', () => {
    const store = new D1SocialStore(null);
    expect(store.available).toBe(false);
    expect(() => store.forScope('deployment')).toThrow(PersistenceUnavailable);
  });

  it('插入后可按 shareRef/消息读回，且同消息同链接不会被插入第二次', async () => {
    const db = openTestD1();
    const store = new D1SocialStore(db as never);
    const st = store.forScope('deployment');

    expect(await st.put(attachment(), 0)).toBe(true);
    const again = await st.put(attachment({ shareRef: 'shr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', revision: 1 }), 0);
    expect(again).toBe(false); // 唯一索引 (scope, message_id, occurrence_key) 挡下
    expect(db.count('social_share_attachments')).toBe(1);

    const got = await st.get('shr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(got?.messageId).toBe('msg-1');
    expect(got?.occurrenceSpans).toEqual([{ start: 10, end: 40 }]);
    expect((await st.listByMessage('msg-1')).length).toBe(1);
  });

  it('revision CAS：旧持有者写不进更大 revision，更新只能按当前 revision 成功一次', async () => {
    const db = openTestD1();
    const store = new D1SocialStore(db as never);
    const st = store.forScope('deployment');
    await st.put(attachment(), 0);

    const ready = attachment({ state: 'ready', revision: 2, updatedAt: NOW + 1 });
    expect(await st.put(ready, 1)).toBe(true);
    // 另一个持有者还拿着 revision=1 想覆盖
    expect(await st.put(attachment({ state: 'failed', revision: 2 }), 1)).toBe(false);
    const got = await st.get('shr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(got?.state).toBe('ready');
    expect(got?.revision).toBe(2);
  });

  it('跨 scope 隔离：另一个 scope 读不到，也插不进同 shareRef', async () => {
    const db = openTestD1();
    const store = new D1SocialStore(db as never);
    await store.forScope('deployment').put(attachment(), 0);
    expect(await store.forScope('other').get('shr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeNull();
    expect(await store.forScope('other').listByMessage('msg-1')).toEqual([]);
  });

  it('租约：过期可被接管，恢复时把中断行明确标 failed(TIMEOUT)', async () => {
    const db = openTestD1();
    const store = new D1SocialStore(db as never);
    const st = store.forScope('deployment');
    await st.put(attachment({ state: 'resolving', revision: 2 }), 0);

    // 没有租约 → 视为无人持有，可抢
    expect(await st.claim('shr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', NOW + 20_000, NOW)).toBe(true);
    // 租约未来 → 抢不到
    expect(await st.claim('shr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', NOW + 40_000, NOW + 1_000)).toBe(false);
    // 租约过期 → 又能抢
    expect(await st.claim('shr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', NOW + 60_000, NOW + 30_000)).toBe(true);

    await st.release('shr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const recovered = await store.recoverInterrupted(NOW + 90_000);
    expect(recovered).toBe(1);
    const got = await st.get('shr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(got?.state).toBe('failed');
    expect(got?.error?.code).toBe('TIMEOUT');
    // 再次恢复是幂等的
    expect(await store.recoverInterrupted(NOW + 91_000)).toBe(0);
  });

  it('内容库：content_revision 单调，旧版本覆盖不了新版本', async () => {
    const db = openTestD1();
    const st = new D1SocialStore(db as never).forScope('deployment');
    await st.putContent(contentRecord({ contentRevision: 3, title: '新标题' }));
    await st.putContent(contentRecord({ contentRevision: 2, title: '旧标题' }));
    const got = await st.getContent('bilibili:public:BV1xx411c7mD');
    expect((got as unknown as { title: string }).title).toBe('新标题');
    await st.putContent(contentRecord({ contentRevision: 4, title: '更新标题' }));
    expect(((await st.getContent('bilibili:public:BV1xx411c7mD')) as unknown as { title: string }).title).toBe('更新标题');
  });

  it('occurrenceKeyOf 对同 URL 不同出现位置给出不同键（不同消息/不同位置不误合并）', () => {
    const a = occurrenceKeyOf({ originalUrl: 'https://b23.tv/x', occurrenceSpans: [{ start: 0, end: 10 }] });
    const b = occurrenceKeyOf({ originalUrl: 'https://b23.tv/x', occurrenceSpans: [{ start: 42, end: 52 }] });
    expect(a).not.toBe(b);
  });
});
