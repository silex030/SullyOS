import { describe, it, expect } from 'vitest';
import type { CharacterProfile, Message, UserProfile } from '../types';
import { ChatPrompts } from './chatPrompts';
import { attachShareExcerptPairs } from './socialShareTool';

// 验收卡 t_8487919b 实跑发现的缺口：私聊主历史（ChatPrompts.buildMessageHistory）
// 的文本分支此前直接塞 m.content，导致 ——
//   ① 带 metadata.shares 的消息把原始长链接原样发给模型（看不到 shareRef/简介）；
//   ② 带 metadata.shareExcerpts 的消息不投影上一轮成对读到的片段。
// 这里锁住修复口径：有分享元数据时走 messageFormat.normalizeMessageContent。
const char = { id: 'char-1', name: 'Sully' } as CharacterProfile;
const user = { name: 'User' } as UserProfile;

const history = (msgs: Message[]) =>
  ChatPrompts.buildMessageHistory(msgs, 10, char, user, []).apiMessages as Array<{ role: string; content: string }>;

const shareAtt = {
  shareRef: 'shr_abc123def456',
  contentId: 'bilibili:bilibili-public:BV1xx411c7mD',
  state: 'ready',
  platform: 'bilibili',
  messageId: '1',
  occurrenceSpans: [{ start: 3, end: 42 }],
  preview: { title: '标题A', authorName: '作者A', platformName: '哔哩哔哩' },
  contextProjection: { contentRevision: 1, summaryText: '简介A' },
};

const shareMsg = {
  id: 1,
  charId: 'char-1',
  role: 'user',
  type: 'text',
  content: '看看 https://www.bilibili.com/video/BV1xx411c7mD',
  timestamp: 1_700_000_000_000,
  metadata: { shares: { version: 1, persisting: 'available', attachments: [shareAtt] } },
} as unknown as Message;

describe('buildMessageHistory · 链接分享投影（t_8487919b）', () => {
  it('带 shares 的文本消息投影成 shareRef + 简介，原始长链接不再出现', () => {
    const [m] = history([shareMsg]);
    expect(m.content).toContain('[分享 shr_abc123def456]');
    expect(m.content).toContain('标题：标题A');
    expect(m.content).toContain('简介：简介A');
    expect(m.content).not.toContain('https://www.bilibili.com/video/BV1xx411c7mD');
  });

  it('带 shareExcerpts 的消息把成对记录投影进下一轮上下文', () => {
    const withPairs = {
      ...shareMsg,
      id: 2,
      metadata: attachShareExcerptPairs(shareMsg.metadata, [{
        toolCallId: 'call_1',
        name: 'read_share_excerpts',
        args: { shareRef: 'shr_abc123def456', fields: ['text'] },
        ok: true,
        code: 'OK',
        chargedTokens: 120,
        at: 1_700_000_001_000,
        resultText: '[read_share_excerpts · OK] shr_abc123def456 · contentRevision=1 · 字段=text · 段数=1\n1. text：片段正文开头',
      }]),
    } as unknown as Message;
    const [, m2] = history([shareMsg, withPairs]);
    expect(m2.content).toContain('[read_share_excerpts 记录 · 1 次调用]');
    expect(m2.content).toContain('片段正文开头');
  });

  it('普通文本消息行为不变（不因修复多出投影尾巴）', () => {
    const plain = { ...shareMsg, id: 3, content: '普通一句', metadata: undefined } as unknown as Message;
    const [m] = history([plain]);
    expect(m.content).toContain('普通一句');
    expect(m.content).not.toContain('[分享 ');
    expect(m.content).not.toContain('read_share_excerpts');
  });
});
