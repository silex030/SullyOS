/**
 * 模型投影接线测试（集成卡 t_babca897）。
 *
 * 校验 utils/messageFormat.normalizeMessageContent 在消息带 metadata.shares 时的行为：
 *  - 链接被替换成 shareRef，用户问题保留；
 *  - 正文/字幕不整段进上下文（只用冻结简介 + 覆盖说明）；
 *  - 没有分享元数据的消息渲染逐字不变（回归）。
 */

import { describe, expect, it } from 'vitest';
import { normalizeMessageContent } from './messageFormat';
import type { Message } from '../types';
import type { ShareAttachment } from './socialContent/types';

const attachment = (over: Partial<ShareAttachment> = {}): ShareAttachment => ({
    schemaVersion: 1,
    shareRef: 'shr_0123456789abcdef0123456789abcdef',
    messageId: '42',
    conversationId: 'char-1',
    characterId: 'char-1',
    occurrenceSpans: [{ start: 5, end: 45 }],
    originalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    platform: 'bilibili',
    sourceId: 'public',
    resolvedUrl: null,
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
    preview: { title: '视频标题', authorName: 'UP主', platformName: 'B站', siteName: 'B站', coverUrl: null, excerpt: null },
    contextProjection: {
        projectionVersion: 1,
        shareRef: 'shr_0123456789abcdef0123456789abcdef',
        contentId: 'bilibili:public:BV1xx411c7mD',
        contentRevision: 1,
        stateAtFreeze: 'ready',
        summaryText: 'B站 · UP主：视频标题：一句话简介',
        evidenceCoverage: ['title', 'text', 'transcript'],
        reason: null,
        frozenAt: 2,
    },
    ...over,
});

const msg = (over: Partial<Message> = {}): Message => ({
    id: 42,
    charId: 'char-1',
    role: 'user',
    type: 'text',
    content: '看看 https://www.bilibili.com/video/BV1xx411c7mD 讲了啥？',
    timestamp: 1,
    ...over,
});

describe('normalizeMessageContent × 链接分享', () => {
    it('带分分享元数据：URL→shareRef、保留问题、给简介', () => {
        const out = normalizeMessageContent(
            msg({ metadata: { shares: { version: 1, attachments: [attachment()] } } }),
            '角色',
            '我',
        );
        expect(out).toContain('[分享 shr_01234567]');
        expect(out).not.toContain('https://www.bilibili.com');
        expect(out).toContain('讲了啥');
        expect(out).toContain('B站 · UP主：视频标题');
        expect(out).toContain('已获取：title/text/transcript');
    });

    it('失败卡：只有状态与原因，没有简介字段', () => {
        const failed = attachment({
            state: 'failed',
            contentId: null,
            preview: null,
            contextProjection: null,
            error: { code: 'AUTH_REQUIRED', retryable: false, retryAfterMs: null, userMessage: '需要登录', safeDiagnosticId: null },
        });
        const out = normalizeMessageContent(
            msg({
                content: '看这个 https://www.xiaohongshu.com/explore/64f0aa11bb',
                metadata: { shares: { version: 1, attachments: [failed] } },
            }),
            '角色',
            '我',
        );
        expect(out).toContain('未读取原因：AUTH_REQUIRED');
        expect(out).not.toContain('简介：');
    });

    it('字幕/正文不整段进上下文：只保留冻结简介', () => {
        const longSubtitle = '第'.repeat(20000);
        const withBody = attachment({
            contextProjection: { ...attachment().contextProjection!, summaryText: '短简介' },
        });
        const out = normalizeMessageContent(
            msg({ metadata: { shares: { version: 1, attachments: [withBody] }, rawBody: longSubtitle } }),
            '角色',
            '我',
        );
        expect(out).toContain('短简介');
        expect(out.length).toBeLessThan(800);
        expect(out).not.toContain('第第第第');
    });

    it('回归：没有 shares 的普通文本逐字不变；其它卡片类型不受影响', () => {
        expect(normalizeMessageContent(msg(), '角色', '我')).toBe('看看 https://www.bilibili.com/video/BV1xx411c7mD 讲了啥？');
        const img = normalizeMessageContent(msg({ type: 'image', content: 'blobref' }), '角色', '我');
        expect(img).toBe('[图片]');
        const interaction = normalizeMessageContent(msg({ type: 'interaction' }), '角色', '我');
        expect(interaction).toContain('戳了');
    });
});
