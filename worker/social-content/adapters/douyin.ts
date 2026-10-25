/**
 * 抖音适配器（t_2c2dba79）。
 *
 * 诚实定位：契约 8 明确"抖音真实适配器未知"。这里实现的是**可测试的最小 HTML 分享页读取**，
 * 标记 retrievalMethod='douyin_share_html_unverified'，health()='degraded'，
 * 未在真实出口验证前不得宣称接通（契约 8 最后一句 / 验收矩阵"真实访问"）。
 *
 * 输入形态（契约 2.1 候选）：
 *  - www.douyin.com/video/:id、/note/:id（短链 v.douyin.com 展开后落到这里）
 *  - www.iesdouyin.com/share/video/:id（兼容候选）
 * 输出：标题(desc)、作者、封面图、点赞/评论数、发布时间；评论不做（需要签名接口）。
 * 不下载视频字节，不做 ASR。
 */

import { safeGet } from '../safeFetch';
import { SocialError } from '../errors';
import { PLATFORM_HOSTS } from '../security';
import {
  DEFAULT_SOURCE_POLICY,
  fetchPolicy,
  emptyComments,
  toPlainText,
  toUtcMs,
  type AdapterContext,
  type AdapterDeps,
  type AdapterHealth,
  type ContentAdapter,
  type SourceTarget,
} from '../adapter';
import { buildRecord, mediaItem } from '../record';

const HOSTS = PLATFORM_HOSTS.douyin;
const HTML_MAX_BYTES = 2 * 1024 * 1024;

/** 平台侧的访问控制页特征：命中就明确 AUTH_REQUIRED，不猜测正文。 */
const AUTH_WALL_MARKERS = ['验证码', '请登录', '登录后查看', '安全验证', 'captcha'];

function parseDouyinIdFromUrl(url: URL): { externalId: string; kind: 'video' | 'note'; canonicalUrl: string } | null {
  const direct = url.pathname.match(/^\/(video|note)\/(\d{6,})\/?$/);
  if (direct) {
    return {
      externalId: direct[2],
      kind: direct[1] as 'video' | 'note',
      canonicalUrl: `https://www.douyin.com/${direct[1]}/${direct[2]}`,
    };
  }
  const share = url.pathname.match(/^\/share\/(video|note)\/(\d{6,})\/?$/);
  if (share) {
    return {
      externalId: share[2],
      kind: share[1] as 'video' | 'note',
      canonicalUrl: `https://www.douyin.com/${share[1]}/${share[2]}`,
    };
  }
  return null;
}

/** 从 HTML 里抠出 _ROUTER_DATA（或 RENDER_DATA）JSON；抠不到返回 null。 */
export function extractRouterData(html: string): unknown {
  const router = html.match(/_ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
  if (router) {
    try {
      return JSON.parse(router[1]);
    } catch {
      return null;
    }
  }
  const render = html.match(/<script[^>]+id="RENDER_DATA"[^>]*>([\s\S]*?)<\/script>/);
  if (render) {
    try {
      return JSON.parse(decodeURIComponent(render[1]));
    } catch {
      return null;
    }
  }
  return null;
}

/** 在未知形状的 JSON 里找第一个同时带 aweme_id/desc 的对象（分享页结构会变）。 */
export function findAwemeNode(node: unknown, depth = 0): Record<string, unknown> | null {
  if (!node || depth > 12) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findAwemeNode(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  if (typeof obj.aweme_id === 'string' && (typeof obj.desc === 'string' || obj.desc === undefined)) return obj;
  for (const value of Object.values(obj)) {
    const hit = findAwemeNode(value, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/** 从 {url_list:[...]} 形状里取第一个字符串 URL；形状不符返回 null。 */
function firstUrl(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const list = (node as Record<string, unknown>).url_list;
  if (!Array.isArray(list) || list.length === 0) return null;
  return str(list[0]);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function createDouyinAdapter(deps: AdapterDeps): ContentAdapter {
  const policy = { ...DEFAULT_SOURCE_POLICY, ...(deps.policy ?? {}) };

  return {
    id: 'douyin-share-html-v1',
    platform: 'douyin',
    version: '0.1.0-unverified',
    capabilities: { detail: true, comments: false, shortLink: true, transcript: false },

    async health(): Promise<AdapterHealth> {
      return {
        status: 'degraded',
        note: '仅 HTML 分享页解析；未在真实部署出口验证，可能随时变结构或要求登录',
      };
    },

    async expandShortLink(url: string, ctx: AdapterContext): Promise<SourceTarget> {
      const res = await safeGet(url, deps.safeFetch, {
        ...fetchPolicy(deps, HOSTS),
        allowedHosts: HOSTS,
        perRequestTimeoutMs: policy.requestTimeoutMs,
        maxBytes: 64 * 1024,
        deadline: ctx.deadline,
      });
      const finalUrl = new URL(res.finalUrl);
      const parsed = parseDouyinIdFromUrl(finalUrl);
      if (!parsed) throw new SocialError('UNSUPPORTED_LINK_TYPE', 'vdouyin_target_not_video');
      return {
        platform: 'douyin',
        externalId: parsed.externalId,
        partKey: null,
        canonicalUrl: parsed.canonicalUrl,
        resolvedUrl: `${finalUrl.origin}${finalUrl.pathname}`,
      };
    },

    async fetchContent(target: SourceTarget, ctx: AdapterContext) {
      const now = ctx.now?.() ?? Date.now();
      // 分享页路径：iesdouyin 对未登录抓取更宽容；失败也不换账号/过风控
      const shareUrl = `https://www.iesdouyin.com/share/video/${target.externalId}/`;
      const res = await safeGet(shareUrl, deps.safeFetch, {
        ...fetchPolicy(deps, HOSTS),
        allowedHosts: HOSTS,
        perRequestTimeoutMs: policy.requestTimeoutMs,
        maxBytes: HTML_MAX_BYTES,
        deadline: ctx.deadline,
      });

      const html = res.text;
      const lowered = html.slice(0, 200000).toLowerCase();
      if (AUTH_WALL_MARKERS.some((m) => lowered.includes(m.toLowerCase()))) {
        throw new SocialError('AUTH_REQUIRED', 'douyin_auth_wall');
      }
      if (res.truncated) {
        throw new SocialError('SIZE_LIMIT', 'douyin_html_truncated');
      }

      const data = extractRouterData(html);
      if (data === null) {
        // 连 _ROUTER_DATA 都抠不出来：页面结构变了，属于上游变更而不是"内容不存在"
        throw new SocialError('UPSTREAM_CHANGED', 'douyin_router_data_missing');
      }
      const aweme = findAwemeNode(data);
      if (!aweme) {
        // 真实探测：不存在的视频 id 会返回 200 + loaderData/errors 但没有 aweme 节点
        throw new SocialError('CONTENT_NOT_FOUND', 'douyin_aweme_absent');
      }

      const desc = toPlainText(aweme.desc ?? '', 200000);
      const authorNode = (aweme.author ?? {}) as Record<string, unknown>;
      const stats = (aweme.statistics ?? {}) as Record<string, unknown>;
      const videoNode = (aweme.video ?? {}) as Record<string, unknown>;
      const coverNode = (videoNode.cover ?? videoNode.origin_cover ?? {}) as Record<string, unknown>;
      const coverList = Array.isArray(coverNode.url_list) ? (coverNode.url_list as unknown[]) : [];
      const coverUrl = str(coverList[0]);
      const images = coverUrl && /^https:\/\//.test(coverUrl)
        ? [mediaItem({ id: `${target.externalId}-cover`, type: 'image', safeUrl: coverUrl, alt: desc.text.slice(0, 80) || null })]
        : [];

      return buildRecord({
        platform: 'douyin',
        sourceId: 'douyin-public',
        externalId: target.externalId,
        author: {
          id: str(authorNode.uid) ?? (num(authorNode.uid) != null ? String(authorNode.uid) : null),
          name: str(authorNode.nickname),
          avatarUrl: str(firstUrl(authorNode.avatar_thumb)),
          profileUrl: str(authorNode.sec_uid) ? `https://www.douyin.com/user/${String(authorNode.sec_uid)}` : null,
        },
        title: null,
        text: desc.text,
        textTruncated: desc.truncated,
        textOriginalLength: desc.originalLength,
        images,
        canonicalUrl: target.canonicalUrl,
        publishedAt: toUtcMs(aweme.create_time),
        fetchedAt: now,
        platformName: '抖音',
        retrievalMethod: 'douyin_share_html_unverified',
        status: 'available',
        visibility: 'public',
        counts: {
          likes: num(stats.digg_count),
          comments: num(stats.comment_count),
        },
        transcripts: [
          {
            id: 'speech_transcription:main',
            partKey: null,
            kind: 'speech_transcription',
            language: null,
            provider: null,
            availability: 'not_requested',
            segments: [],
            plainText: '',
            truncated: false,
            originalLength: null,
            fetchedAt: now,
            sourceRef: `douyin:${target.externalId}`,
          },
        ],
        commentsSample: emptyComments('douyin 评论样本本期不读取（需签名接口）', 5),
        provenance: {
          title: { retrievalMethod: 'share_html.desc', fetchedAt: now, availability: 'available' },
          text: { retrievalMethod: 'share_html.desc', fetchedAt: now, availability: 'available' },
          images: { retrievalMethod: 'share_html.video.cover', fetchedAt: now, availability: images.length ? 'available' : 'unavailable' },
          transcript: { retrievalMethod: 'none', fetchedAt: now, availability: 'unavailable' },
          comments: { retrievalMethod: 'none', fetchedAt: now, availability: 'unavailable' },
        },
        notes: ['adapter_unverified: douyin 真实适配器未在部署出口验证'],
      });
    },
  };
}
