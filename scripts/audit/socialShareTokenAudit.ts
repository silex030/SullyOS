/**
 * 链接分享上下文体积审计（集成卡 t_babca897）。
 *
 * 目的：回答“新投影比整段原文注入省多少、重复后续轮次多花多少”，且只用可复算的
 * 本地度量，**不虚构缓存命中率**（真实命中率需要供应商 usage/缓存字段，本机拿不到，
 * 报告里必须写 not_provided）。
 *
 * 运行方式（可复现）：
 *   npx esbuild scripts/audit/socialShareTokenAudit.ts --bundle --platform=node --format=esm \
 *     --outfile=/tmp/social-share-audit.mjs && node /tmp/social-share-audit.mjs
 *
 * token 估算：每 Unicode 码点 ≈1 token（契约 6.3 的保守口径，不声称精确）。
 */

import { buildShareMessageProjection, estimateShareTokens } from '../../utils/socialShare';
import type { ShareAttachment } from '../../utils/socialContent/types';

const BILIBILI_LIMIT_CHARS = 100_000; // messageFormat 里旧字幕注入的保险上限

/** 代表性长内容：B站长字幕 + XHS 图文正文（虚构样例，不代表任何真实账号）。 */
function makeAttachments(subtitleChars: number, bodyChars: number): ShareAttachment[] {
  const subtitle = '这是一句被测字幕文本。'.repeat(Math.ceil(subtitleChars / 11)).slice(0, subtitleChars);
  const body = '这是笔记正文的一部分。'.repeat(Math.ceil(bodyChars / 11)).slice(0, bodyChars);
  return [
    {
      schemaVersion: 1,
      shareRef: 'shr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      messageId: '1',
      conversationId: 'char-1',
      characterId: 'char-1',
      occurrenceSpans: [{ start: 6, end: 46 }],
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
      preview: { title: '一个很长的视频标题', authorName: 'UP主', platformName: 'B站', siteName: 'B站', coverUrl: null, excerpt: null },
      contextProjection: {
        projectionVersion: 1,
        shareRef: 'shr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        contentId: 'bilibili:public:BV1xx411c7mD',
        contentRevision: 1,
        stateAtFreeze: 'ready',
        summaryText: `B站 · UP主：一个很长的视频标题：${subtitle.slice(0, 120)}`,
        evidenceCoverage: ['title', 'text', 'transcript'],
        reason: null,
        frozenAt: 2,
      },
      _legacyTranscript: subtitle,
    } as ShareAttachment,
    {
      schemaVersion: 1,
      shareRef: 'shr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      messageId: '1',
      conversationId: 'char-1',
      characterId: 'char-1',
      occurrenceSpans: [{ start: 60, end: 100 }],
      originalUrl: 'https://www.xiaohongshu.com/explore/64f0aa11bb',
      platform: 'xiaohongshu',
      sourceId: 'public',
      resolvedUrl: null,
      canonicalUrl: 'https://www.xiaohongshu.com/explore/64f0aa11bb',
      openUrl: 'https://www.xiaohongshu.com/explore/64f0aa11bb',
      contentId: 'xiaohongshu:public:64f0aa11bb',
      partKey: null,
      state: 'partial',
      revision: 3,
      attempt: 1,
      createdAt: 1,
      updatedAt: 2,
      error: null,
      preview: { title: '一篇笔记', authorName: '作者', platformName: '小红书', siteName: '小红书', coverUrl: null, excerpt: null },
      contextProjection: {
        projectionVersion: 1,
        shareRef: 'shr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        contentId: 'xiaohongshu:public:64f0aa11bb',
        contentRevision: 1,
        stateAtFreeze: 'partial',
        summaryText: `小红书 · 作者：一篇笔记：${body.slice(0, 120)}`,
        evidenceCoverage: ['title', 'text'],
        reason: 'missing:comments',
        frozenAt: 2,
      },
      _legacyBody: body,
    } as ShareAttachment,
  ];
}

const USER_TEXT = '帮我看看这两个 https://www.bilibili.com/video/BV1xx411c7mD 和 https://www.xiaohongshu.com/explore/64f0aa11bb 讲了啥？';

/** 旧链路（现状）：URL 原样 + 字幕全文 + 网页正文全量（messageFormat 旧分支的口径）。 */
function legacyInjection(atts: ShareAttachment[]): string {
  const bili = atts[0] as ShareAttachment & { _legacyTranscript: string };
  const xhs = atts[1] as ShareAttachment & { _legacyBody: string };
  const sub = bili._legacyTranscript.slice(0, BILIBILI_LIMIT_CHARS);
  return [
    `[视频分享] 我分享了一个B站视频《一个很长的视频标题》（作者：UP主）\n链接：https://www.bilibili.com/video/BV1xx411c7mD`,
    `视频字幕全文：\n${sub}`,
    `[网页分享] 我分享了一个网页《一篇笔记》\n链接：https://www.xiaohongshu.com/explore/64f0aa11bb`,
    `网页正文：\n${xhs._legacyBody}`,
    USER_TEXT,
  ].join('\n\n');
}

function main() {
  const cases = [
    { name: '典型短视频（字幕 1.5k 字，笔记 800 字）', subtitle: 1500, body: 800 },
    { name: '长讲座（字幕 12k 字，笔记 4k 字）', subtitle: 12_000, body: 4000 },
    { name: '极长（字幕 80k 字，笔记 20k 字）', subtitle: 80_000, body: 20_000 },
  ];

  const rows = cases.map((c) => {
    const atts = makeAttachments(c.subtitle, c.body);
    const projection = buildShareMessageProjection(USER_TEXT, atts) ?? '';
    const legacy = legacyInjection(atts);
    const pTokens = estimateShareTokens(projection);
    const lTokens = estimateShareTokens(legacy);
    return {
      case: c.name,
      legacy_chars: legacy.length,
      legacy_tokens_est: lTokens,
      projection_chars: projection.length,
      projection_tokens_est: pTokens,
      saved_tokens_est: lTokens - pTokens,
      saved_ratio: Number((1 - pTokens / lTokens).toFixed(4)),
      // 同一条历史消息在后续每一轮都会被重发：每轮差额就是 saved_tokens_est
      per_followup_turn_extra_tokens_est: pTokens,
    };
  });

  // 投影稳定性：同一条消息重复构建立字节一致（缓存友好）；旧链路同理但体积大 2 个数量级
  const atts = makeAttachments(12_000, 4000);
  const p1 = buildShareMessageProjection(USER_TEXT, atts) ?? '';
  const p2 = buildShareMessageProjection(USER_TEXT, atts) ?? '';
  const stable = p1 === p2;

  const report = {
    generated_at: new Date().toISOString(),
    estimate_method: 'codepoint_approx (1 token ≈ 1 Unicode code point, 保守上限)',
    notes: [
      '这些是本地可复算的字符/token 估算，不是供应商账单数字。',
      '缓存命中率：not_provided —— 本机没有供应商 prompt-cache usage 字段，不能虚构命中率。',
      '旧链路数字按 utils/messageFormat.ts 旧 B站/网页分支口径重放（字幕上限 100000 字符）。',
      '投影每卡 ≤350 token、同消息 ≤1200 token（SHARE_BUDGETS）。',
    ],
    projection_stable_across_builds: stable,
    rows,
  };
  console.log(JSON.stringify(report, null, 2));
}

main();
