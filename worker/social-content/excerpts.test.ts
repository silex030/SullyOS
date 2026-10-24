import { describe, expect, it } from 'vitest';
import { buildExcerpts, chunkText, collectCandidates, estimateTokens } from './excerpts';
import { buildRecord } from './record';
import { VersionUnavailableError } from './errors';
import { SHARE_BUDGETS, type ContentRecord, type ExcerptsRequest } from '../../utils/socialContent/types';

/**
 * items/:contentId/excerpts 契约测试（t_2c2dba79，契约 4.5/6.3/6.4）。
 * 预算按码点保守估算，响应显式标 estimateMethod，不声称精确 token。
 */

const NOW = 1700000000000;

function record(): ContentRecord {
  const long = Array.from({ length: 12 }, (_, i) => `第${i + 1}段：这是一段用于摘录预算测试的中文正文内容。`).join('\n\n');
  return buildRecord({
    platform: 'bilibili',
    sourceId: 'bilibili-public',
    externalId: 'BV1xx411c7mD',
    author: { id: '1', name: '夹具作者', avatarUrl: null, profileUrl: null },
    title: '夹具标题',
    text: long,
    images: [],
    canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    publishedAt: NOW,
    fetchedAt: NOW,
    platformName: '哔哩哔哩',
    retrievalMethod: 'fixture',
    transcripts: [
      {
        id: 'native_caption:main:zh-CN',
        partKey: null,
        kind: 'native_caption',
        language: 'zh-CN',
        provider: 'bilibili_native',
        availability: 'available',
        segments: [
          { id: 's0', startMs: 500, endMs: 2500, text: '第一句原生字幕' },
          { id: 's1', startMs: 2500, endMs: 5000, text: '第二句原生字幕' },
        ],
        plainText: '第一句原生字幕\n第二句原生字幕',
        truncated: false,
        originalLength: 18,
        fetchedAt: NOW,
        sourceRef: 'bilibili:BV1xx411c7mD',
      },
    ],
    commentsSample: {
      availability: 'available',
      items: [
        { id: 'c1', author: { name: '观众甲' }, text: '第一条评论样本', likes: 10, publishedAt: NOW, sourceRef: 'bilibili:BV1xx411c7mD#reply' },
        { id: 'c2', author: { name: '观众乙' }, text: '第二条评论样本', likes: 2, publishedAt: NOW, sourceRef: 'bilibili:BV1xx411c7mD#reply' },
      ],
      selection: 'platform_hot',
      requestedLimit: 5,
      returnedCount: 2,
      pagesFetched: 1,
      totalAvailable: 2,
      hasMore: false,
      fetchedAt: NOW,
      truncated: false,
      scopeDescription: '样本',
    },
  });
}

const req = (patch: Partial<ExcerptsRequest> = {}): ExcerptsRequest => ({
  contentRevision: 1,
  query: null,
  fields: ['text'],
  partKey: null,
  cursor: null,
  maxTokens: SHARE_BUDGETS.excerptsPerCallTokens,
  ...patch,
});

describe('正文切片与预算', () => {
  it('按段落切片且每片不超过 400 字', () => {
    const chunks = chunkText('第一段。\n\n第二段内容较长' + '啊'.repeat(900) + '。\n\n第三段。');
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.length <= 400)).toBe(true);
  });

  it('预算被服务端夹紧到合同上限 1200', () => {
    const res = buildExcerpts(record(), req({ maxTokens: 999999 }));
    expect(res.tokenEstimate).toBeLessThanOrEqual(SHARE_BUDGETS.excerptsPerCallTokens);
    expect(res.estimateMethod).toBe('codepoint_approx');
  });

  it('超预算时给 nextCursor，续读不重复也不丢内容', () => {
    const rec = record();
    const first = buildExcerpts(rec, req({ maxTokens: 60 }));
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    const second = buildExcerpts(rec, req({ maxTokens: 60, cursor: first.nextCursor }));
    expect(second.segments.length).toBeGreaterThan(0);
    const firstIds = new Set(first.segments.map((s) => s.id));
    expect(second.segments.every((s) => !firstIds.has(s.id))).toBe(true);

    // 一路读完能覆盖全部候选，且游标最终为 null
    let cursor: string | null = second.nextCursor;
    const seen = new Set([...first.segments, ...second.segments].map((s) => s.id));
    let guard = 0;
    while (cursor && guard < 50) {
      const page = buildExcerpts(rec, req({ maxTokens: 60, cursor }));
      for (const seg of page.segments) seen.add(seg.id);
      cursor = page.nextCursor;
      guard += 1;
    }
    expect(cursor).toBeNull();
    expect(seen.size).toBe(collectCandidates(rec, ['text'], null, null).length);
  });

  it('cursor 非法时从头开始，不跳内容也不报错', () => {
    const res = buildExcerpts(record(), req({ cursor: 'garbage' }));
    expect(res.segments.length).toBeGreaterThan(0);
  });
});

describe('字段选择与检索', () => {
  it('字幕字段保留时间轴，便于引用', () => {
    const res = buildExcerpts(record(), req({ fields: ['transcript'] }));
    expect(res.segments.every((s) => s.field === 'transcript')).toBe(true);
    expect(res.segments[0]).toMatchObject({ startMs: 500, endMs: 2500, text: '第一句原生字幕' });
  });

  it('评论字段只取已授权样本，不补全量', () => {
    const res = buildExcerpts(record(), req({ fields: ['comments'] }));
    expect(res.segments).toHaveLength(2);
    expect(res.segments[0].text).toBe('第一条评论样本');
  });

  it('query 过滤按子串命中（不区分大小写），按原文顺序', () => {
    const res = buildExcerpts(record(), req({ fields: ['text'], query: '第3段' }));
    expect(res.segments.length).toBeGreaterThan(0);
    expect(res.segments.every((s) => s.text.includes('第3段'))).toBe(true);
  });

  it('未知字段被忽略并回退到正文', () => {
    const res = buildExcerpts(record(), req({ fields: ['evil' as never] }));
    expect(res.segments.every((s) => s.field === 'text')).toBe(true);
  });

  it('partKey 过滤只保留对应字幕轨', () => {
    const rec = record();
    rec.transcripts.push({
      ...rec.transcripts[0],
      id: 'native_caption:p2:zh-CN',
      partKey: 'p2',
      segments: [{ id: 'p2s0', startMs: 0, endMs: 1000, text: '第二P字幕' }],
      plainText: '第二P字幕',
    });
    const res = buildExcerpts(rec, req({ fields: ['transcript'], partKey: 'p2' }));
    expect(res.segments.map((s) => s.text)).toEqual(['第二P字幕']);
  });
});

describe('版本一致性', () => {
  it('旧 contentRevision → VERSION_UNAVAILABLE，不混新正文', () => {
    expect(() => buildExcerpts(record(), req({ contentRevision: 0 }))).toThrow(VersionUnavailableError);
    try {
      buildExcerpts(record(), req({ contentRevision: 0 }));
    } catch (err) {
      expect((err as VersionUnavailableError).message).toContain('VERSION_UNAVAILABLE');
    }
  });
});

describe('token 估算', () => {
  it('按码点计数：中文与表情都不按 UTF-16 单元重复计数', () => {
    expect(estimateTokens('abc')).toBe(3);
    expect(estimateTokens('中文')).toBe(2);
    expect(estimateTokens('😀')).toBe(1);
  });
});
