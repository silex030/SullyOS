// utils/momentsFeed.ts
// 朋友圈纯函数：封面尺寸门（Task 2）；归一化/去重/映射（Task 3 追加）。
import type { SocialPost } from '../types';

export const MOMENTS_COVER_MAX_BYTES = 1024 * 1024;
export function coverSizeOk(dataUrlLengthBytes: number): boolean {
  return dataUrlLengthBytes <= MOMENTS_COVER_MAX_BYTES;
}

export function normalizeMastodonStatus(s: { id: string; url?: string | null; content?: string; visibility: string; created_at: string; in_reply_to_id?: string | null; media_attachments?: Array<{ id: string; url?: string | null }> }, instance: string, ownerId: string): SocialPost {
  return {
    id: `mastodon-${instance}-${s.id}`,
    authorName: ownerId, authorAvatar: '', title: '', tags: [],
    content: (s.content ?? '').replace(/<[^>]*>/g, ''),
    images: (s.media_attachments ?? []).map((m) => m.url ?? '').filter(Boolean),
    likes: 0, isCollected: false, isLiked: false, comments: [],
    timestamp: Date.parse(s.created_at) || Date.now(),
    origin: 'mastodon', mastodonStatusId: s.id, mastodonInstance: instance, mastodonOwnerId: ownerId,
  };
}

export function dedupeByRemoteId(local: SocialPost[], fresh: SocialPost[]): SocialPost[] {
  const known = new Set(local.map((p) => `${p.mastodonInstance ?? ''}\n${p.mastodonStatusId ?? ''}`));
  return fresh.filter((p) => p.mastodonStatusId && !known.has(`${p.mastodonInstance ?? ''}\n${p.mastodonStatusId ?? ''}`));
}

export function toMastodonVisibility(local: string | undefined): 'public' | 'unlisted' | 'private' | 'direct' {
  if (local === 'public') return 'unlisted';
  if (local === 'direct') return 'direct';
  return 'private';
}

// 朋友圈只看熟人线：mastodon 同步帖 + 朋友圈手发帖，别的来源一律不进（Spark 已于 2026-10-24 移除）。
export function visibleInMoments(p: SocialPost): boolean {
  return p.origin === 'mastodon' || p.origin === 'moments';
}
// MCP 返回形态不固定（data / rawText / content 文本块），尽量宽地抽出 status 数组
export function extractStatuses(payload: any, structuredContent?: any): any[] {
  if (Array.isArray(structuredContent?.statuses)) return structuredContent.statuses;
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.statuses)) return payload.statuses;
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.content)) {
    for (const block of payload.content) {
      const text = typeof block === 'string' ? block : block?.text;
      if (typeof text !== 'string') continue;
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed;
        if (Array.isArray(parsed?.statuses)) return parsed.statuses;
      } catch { /* 不是 JSON 就跳过 */ }
    }
  }
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.statuses)) return parsed.statuses;
    } catch { /* ignore */ }
  }
  return [];
}
// 发现页中文过滤：Mastodon language 字段为准（zh 开头全收：简/繁/粤）；缺失时看正文含 CJK 即收。
export function isChineseStatus(s: { language?: string | null; text: string }): boolean {
  if (s.language) return s.language.toLowerCase().startsWith('zh');
  return /[一-鿿㐀-䶿]/.test(s.text);
}
