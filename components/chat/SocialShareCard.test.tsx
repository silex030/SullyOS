// @vitest-environment jsdom
/**
 * 链接分享卡片渲染测试（集成卡 t_babca897）。
 *
 * 只测渲染与安全边界（纯文本、转义、跳转过滤、状态文案）；重试按钮的真实网络/DB
 * 行为在 utils/socialShare.test.ts 与 service 测试里覆盖。
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import SocialShareCard from './SocialShareCard';
import type { ShareAttachment } from '../../utils/socialContent/types';

const base = (over: Partial<ShareAttachment> = {}): ShareAttachment => ({
    schemaVersion: 1,
    shareRef: 'shr_0123456789abcdef0123456789abcdef',
    messageId: '7',
    conversationId: 'char-1',
    characterId: 'char-1',
    occurrenceSpans: [{ start: 0, end: 10 }],
    originalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    platform: 'bilibili',
    sourceId: 'public',
    resolvedUrl: null,
    canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    openUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    contentId: 'bilibili:public:BV1xx411c7mD',
    partKey: null,
    state: 'ready',
    revision: 3,
    attempt: 1,
    createdAt: 1,
    updatedAt: 2,
    error: null,
    preview: { title: '标题', authorName: 'UP主', platformName: 'B站', siteName: 'B站', coverUrl: null, excerpt: '摘要' },
    contextProjection: {
        projectionVersion: 1,
        shareRef: 'shr_0123456789abcdef0123456789abcdef',
        contentId: 'bilibili:public:BV1xx411c7mD',
        contentRevision: 1,
        stateAtFreeze: 'ready',
        summaryText: '一句话简介',
        evidenceCoverage: ['title', 'text'],
        reason: null,
        frozenAt: 2,
    },
    ...over,
});

const render = (att: ShareAttachment, content?: string) =>
    renderToStaticMarkup(<SocialShareCard messageId={7} attachments={[att]} content={content} />);

describe('SocialShareCard 渲染', () => {
    it('ready：平台、标题、作者、简介、打开入口都在', () => {
        const html = render(base(), '这个讲了啥？');
        expect(html).toContain('data-testid="social-share-card"');
        expect(html).toContain('B站');
        expect(html).toContain('已读取');
        expect(html).toContain('标题');
        expect(html).toContain('@UP主');
        expect(html).toContain('一句话简介');
        expect(html).toContain('打开原页面');
        expect(html).toContain('这个讲了啥？');
    });

    it('外部文本按纯文本转义（不执行 HTML/脚本）', () => {
        const html = render(
            base({
                preview: { ...base().preview!, title: '<img src=x onerror=alert(1)>', authorName: '<script>alert(2)</script>' },
            }),
        );
        expect(html).not.toContain('<img src=x');
        expect(html).not.toContain('<script>alert(2)</script>');
        expect(html).toContain('&lt;img src=x');
    });

    it('failed：显示结构化原因 + 重试入口，不显示“已读取”或简介', () => {
        const html = render(
            base({
                state: 'failed',
                contentId: null,
                preview: null,
                contextProjection: null,
                error: { code: 'AUTH_REQUIRED', retryable: false, retryAfterMs: null, userMessage: '需要登录', safeDiagnosticId: null },
            }),
        );
        expect(html).toContain('未能读取');
        expect(html).toContain('需要登录');
        expect(html).toContain('重试');
        expect(html).not.toContain('已读取');
    });

    it('partial：明说缺了什么', () => {
        const html = render(
            base({
                state: 'partial',
                contextProjection: { ...base().contextProjection!, stateAtFreeze: 'partial', reason: 'missing:comments' },
            }),
        );
        expect(html).toContain('部分读取');
        expect(html).toContain('comments');
    });

    it('queued/resolving：显示进度而不是空卡', () => {
        expect(render(base({ state: 'queued', preview: null, contextProjection: null }))).toContain('排队解析');
        expect(render(base({ state: 'resolving', preview: null, contextProjection: null }))).toContain('正在读取');
    });

    it('不安全跳转（http / javascript）不给打开入口', () => {
        const http = render(base({ openUrl: 'http://www.bilibili.com/video/BV1' }));
        expect(http).not.toContain('打开原页面');
        const js = render(base({ openUrl: 'javascript:alert(1)' }));
        expect(js).not.toContain('打开原页面');
    });
});
