/**
 * B 站适配器（t_2c2dba79）。
 *
 * 复用既有 B 站读取的知识（utils/bilibiliCard.ts：view/player 公开接口、无 cookie），
 * 但**不复用**它的裸 expandShortUrl / getProxyWorkerUrl 通道：本适配器所有请求都走
 * safeGet（每跳白名单 + DNS/IP 复验 + 大小上限 + 超时），因为它要面对用户输入的任意链接。
 *
 * 真实端点（契约 2.1 候选，需部署环境实测）：
 *  - api.bilibili.com/x/web-interface/view?bvid=|aid=
 *  - api.bilibili.com/x/player/v2?bvid=&cid=          原生 CC 字幕轨
 *  - api.bilibili.com/x/v2/reply?type=1&oid=<aid>&sort=2&ps=5  少量热门评论
 *  - aisubtitle.hdslb.com/...                          字幕 JSON（二次 URL，独立白名单）
 *
 * 明确不做：不下载视频/音频字节，不做 ASR（ASR 默认关闭，标记 not_requested）。
 */

import type { CommentsSample, Transcript } from '../../../utils/socialContent/types';
import { bilibiliPartKey } from '../../../utils/socialContent/links';
import { safeGet, type SafeFetchResult } from '../safeFetch';
import { SocialError } from '../errors';
import { PLATFORM_HOSTS } from '../security';
import {
  DEFAULT_SOURCE_POLICY,
  fetchPolicy,
  toPlainText,
  toUtcMs,
  type AdapterContext,
  type AdapterDeps,
  type AdapterHealth,
  type ContentAdapter,
  type SourceTarget,
} from '../adapter';
import { buildRecord, mediaItem } from '../record';

const HOSTS = PLATFORM_HOSTS.bilibili;
const SUBTITLE_HOSTS = PLATFORM_HOSTS.bilibiliCdn;
const JSON_BYTES = 256 * 1024;
const COMMENTS_LIMIT = 5;
/** 公开接口要求普通浏览器 UA + 站内 Referer；不带会被风控 412（真实探测已验证）。 */
const OPEN_API_HEADERS: Record<string, string> = {
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  referer: 'https://www.bilibili.com/',
};

interface BiliViewData {
  bvid?: string;
  aid?: number;
  cid?: number;
  title?: string;
  desc?: string;
  pubdate?: number;
  pic?: string;
  owner?: { mid?: number; name?: string; face?: string };
  stat?: { like?: number; reply?: number };
  pages?: Array<{ cid?: number; page?: number; part?: string }>;
  duration?: number;
}

interface BiliPlayerData {
  subtitle?: {
    subtitles?: Array<{ lan?: string; lan_doc?: string; subtitle_url?: string }>;
  };
}

function parseJson(res: SafeFetchResult, what: string): unknown {
  try {
    return JSON.parse(res.text);
  } catch {
    throw new SocialError('UPSTREAM_CHANGED', `${what}_not_json`);
  }
}

/** B 站业务码 → 契约错误码。未知码一律 UPSTREAM_CHANGED，不猜成"没内容"。 */
function mapBiliCode(code: unknown): SocialError | null {
  if (code === 0) return null;
  switch (code) {
    case -404:
    case 62002:
      return new SocialError('CONTENT_NOT_FOUND', `bili_${code}`);
    case -403:
    case -352:
      return new SocialError('ACCESS_DENIED', `bili_${code}`);
    case 62004:
      return new SocialError('AUTH_REQUIRED', 'bili_62004');
    case -400:
      return new SocialError('INVALID_URL', 'bili_-400');
    default:
      return new SocialError('UPSTREAM_CHANGED', `bili_${String(code)}`);
  }
}

function externalIdToQuery(externalId: string): string {
  if (/^BV/i.test(externalId)) return `bvid=${encodeURIComponent(externalId)}`;
  const m = externalId.match(/^av(\d+)$/i);
  if (m) return `aid=${m[1]}`;
  throw new SocialError('INVALID_URL', 'bilibili_external_id_unparsable');
}

function pickCid(view: BiliViewData, partKey: string | null): number | null {
  if (!partKey) return typeof view.cid === 'number' ? view.cid : null;
  const n = Number(partKey.slice(1));
  const page = (view.pages ?? []).find((p) => p.page === n);
  if (page && typeof page.cid === 'number') return page.cid;
  return typeof view.cid === 'number' ? view.cid : null;
}

async function fetchOfficialSubtitle(
  deps: AdapterDeps,
  url: string,
  ctx: AdapterContext,
  partKey: string | null,
  language: string | null,
  sourceRef: string,
): Promise<Transcript> {
  const now = ctx.now?.() ?? Date.now();
  const res = await safeGet(url, deps.safeFetch, {
    ...fetchPolicy(deps),
    allowedHosts: [...HOSTS, ...SUBTITLE_HOSTS],
    headers: OPEN_API_HEADERS,
    maxBytes: JSON_BYTES,
  });
  const parsed = parseJson(res, 'subtitle') as { body?: Array<{ from?: number; to?: number; content?: string }> };
  const body = Array.isArray(parsed.body) ? parsed.body : [];
  const segments = body.map((seg, i) => ({
    id: `${sourceRef}-s${i}`,
    startMs: typeof seg.from === 'number' ? Math.round(seg.from * 1000) : null,
    endMs: typeof seg.to === 'number' ? Math.round(seg.to * 1000) : null,
    text: typeof seg.content === 'string' ? seg.content : '',
  }));
  const plainText = segments.map((s) => s.text).join('\n');
  return {
    id: `native_caption:${partKey ?? 'main'}:${language ?? 'unknown'}`,
    partKey,
    kind: 'native_caption',
    language,
    provider: 'bilibili_native',
    availability: segments.length > 0 ? 'available' : 'not_available',
    segments,
    plainText,
    truncated: res.truncated,
    originalLength: plainText.length,
    fetchedAt: now,
    sourceRef,
  };
}

async function fetchComments(
  deps: AdapterDeps,
  aid: number,
  ctx: AdapterContext,
  sourceRef: string,
): Promise<CommentsSample> {
  const now = ctx.now?.() ?? Date.now();
  const url = `https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=2&ps=${COMMENTS_LIMIT}&pn=1`;
  const res = await safeGet(url, deps.safeFetch, { ...fetchPolicy(deps), headers: OPEN_API_HEADERS, maxBytes: JSON_BYTES });
  const parsed = parseJson(res, 'comments') as {
    code?: number;
    data?: {
      page?: { count?: number };
      replies?: Array<{
        rpid?: number | string;
        member?: { uname?: string };
        content?: { message?: string };
        like?: number;
        ctime?: number;
      }>;
    };
  };
  const mapped = mapBiliCode(parsed.code);
  if (mapped) throw mapped;
  const replies = parsed.data?.replies ?? [];
  const items = replies.slice(0, COMMENTS_LIMIT).map((r, i) => ({
    id: String(r.rpid ?? `${sourceRef}-c${i}`),
    author: { name: r.member?.uname ?? null },
    text: toPlainText(r.content?.message ?? '', 2000).text,
    likes: typeof r.like === 'number' ? r.like : null,
    publishedAt: toUtcMs(r.ctime),
    sourceRef: `${sourceRef}#reply`,
  }));
  const total = typeof parsed.data?.page?.count === 'number' ? parsed.data.page.count : null;
  return {
    availability: 'available',
    items,
    // sort=2 是"热度排序"的一页样本，不等于全量热门排行（契约 3.5 要求如实标注）
    selection: 'platform_hot',
    requestedLimit: COMMENTS_LIMIT,
    returnedCount: items.length,
    pagesFetched: 1,
    totalAvailable: total,
    hasMore: total === null ? null : total > items.length,
    fetchedAt: now,
    truncated: false,
    scopeDescription: 'bilibili 评论第 1 页（热度排序，最多 5 条，样本非全量）',
  };
}

export function createBilibiliAdapter(deps: AdapterDeps): ContentAdapter {
  const policy = { ...DEFAULT_SOURCE_POLICY, ...(deps.policy ?? {}) };

  return {
    id: 'bilibili-public-v1',
    platform: 'bilibili',
    version: '1.0.0',
    capabilities: { detail: true, comments: true, shortLink: true, transcript: true },

    async health(): Promise<AdapterHealth> {
      return { status: 'configured', note: '公开 view/player/reply 接口，无 cookie；未实测部署出口' };
    },

    async expandShortLink(url: string, ctx: AdapterContext): Promise<SourceTarget> {
      const res = await safeGet(url, deps.safeFetch, {
        ...fetchPolicy(deps, HOSTS),
        headers: OPEN_API_HEADERS,
        maxBytes: 64 * 1024,
      });
      const finalUrl = new URL(res.finalUrl);
      const m = finalUrl.pathname.match(/^\/video\/((?:BV[0-9A-Za-z]{10})|(?:av\d+))\/?$/);
      if (!m) throw new SocialError('UNSUPPORTED_LINK_TYPE', 'b23_target_not_video');
      const partKey = bilibiliPartKey(finalUrl);
      const canonicalUrl = `https://www.bilibili.com/video/${m[1]}${partKey ? `?p=${partKey.slice(1)}` : ''}`;
      void ctx;
      return { platform: 'bilibili', externalId: m[1], partKey, canonicalUrl, resolvedUrl: res.finalUrl };
    },

    async fetchContent(target: SourceTarget, ctx: AdapterContext) {
      const now = ctx.now?.() ?? Date.now();
      const viewUrl = `https://api.bilibili.com/x/web-interface/view?${externalIdToQuery(target.externalId)}`;
      const viewRes = await safeGet(viewUrl, deps.safeFetch, { ...fetchPolicy(deps), headers: OPEN_API_HEADERS, maxBytes: JSON_BYTES });
      const viewEnvelope = parseJson(viewRes, 'view') as { code?: number; message?: string; data?: BiliViewData };
      const viewErr = mapBiliCode(viewEnvelope.code);
      if (viewErr) throw viewErr;
      const view = viewEnvelope.data ?? {};
      const bvid = view.bvid || (/^BV/i.test(target.externalId) ? target.externalId : '');
      if (!bvid) throw new SocialError('UPSTREAM_CHANGED', 'view_without_bvid');
      const cid = pickCid(view, target.partKey);

      const notes: string[] = [];
      const transcripts: Transcript[] = [];

      // 原生字幕：拿不到就是 not_available，不声称看过视频
      const sourceRef = `bilibili:${bvid}${target.partKey ? `:${target.partKey}` : ''}`;
      let captionsAvailable = false;
      if (cid && bvid) {
        try {
          const playerRes = await safeGet(
            `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`,
            deps.safeFetch,
            { ...fetchPolicy(deps), headers: OPEN_API_HEADERS, maxBytes: JSON_BYTES },
          );
          const player = parseJson(playerRes, 'player') as { code?: number; data?: BiliPlayerData };
          if (player.code === 0) {
            const tracks = player.data?.subtitle?.subtitles ?? [];
            for (const track of tracks) {
              if (!track.subtitle_url) continue;
              const absolute = track.subtitle_url.startsWith('//') ? `https:${track.subtitle_url}` : track.subtitle_url;
              transcripts.push(
                await fetchOfficialSubtitle(deps, absolute, ctx, target.partKey, track.lan ?? null, sourceRef),
              );
              captionsAvailable = true;
            }
          } else {
            notes.push(`player_api_code_${String(player.code)}`);
          }
        } catch (err) {
          // 字幕是可选字段：失败不拖垮正文，但必须显式记录
          notes.push(`caption_fetch_failed:${err instanceof SocialError ? err.code : 'unknown'}`);
          transcripts.push({
            id: `native_caption:${target.partKey ?? 'main'}`,
            partKey: target.partKey,
            kind: 'native_caption',
            language: null,
            provider: 'bilibili_native',
            availability: 'failed',
            segments: [],
            plainText: '',
            truncated: false,
            originalLength: null,
            fetchedAt: now,
            sourceRef,
          });
        }
      }

      if (!transcripts.some((t) => t.kind === 'native_caption')) {
        // 明确"这条视频没有原生字幕"：合法状态，不是失败，也不能拿简介冒充字幕
        transcripts.push({
          id: `native_caption:${target.partKey ?? 'main'}`,
          partKey: target.partKey,
          kind: 'native_caption',
          language: null,
          provider: 'bilibili_native',
          availability: 'not_available',
          segments: [],
          plainText: '',
          truncated: false,
          originalLength: null,
          fetchedAt: now,
          sourceRef,
        });
      }

      // ASR 默认关闭（TRANSCRIPTION_ENABLED=false）：永远显式写 not_requested，
      // 既避免把"没字幕"说成"转写中"，也避免把"有原生字幕"说成"已转写"
      {
        transcripts.push({
          id: `speech_transcription:${target.partKey ?? 'main'}`,
          partKey: target.partKey,
          kind: 'speech_transcription',
          language: null,
          provider: null,
          availability: 'not_requested',
          segments: [],
          plainText: '',
          truncated: false,
          originalLength: null,
          fetchedAt: now,
          sourceRef,
        });
      }

      // 评论样本：失败只降级为 partial，不伪造
      let commentsSample: CommentsSample | null = null;
      if (typeof view.aid === 'number') {
        try {
          commentsSample = await fetchComments(deps, view.aid, ctx, sourceRef);
        } catch (err) {
          notes.push(`comments_failed:${err instanceof SocialError ? err.code : 'unknown'}`);
          commentsSample = {
            availability: 'failed',
            items: [],
            selection: 'unknown',
            requestedLimit: COMMENTS_LIMIT,
            returnedCount: 0,
            pagesFetched: 0,
            totalAvailable: null,
            hasMore: null,
            fetchedAt: now,
            truncated: false,
            scopeDescription: 'bilibili 评论样本获取失败',
          };
        }
      }

      const desc = toPlainText(view.desc ?? '', 200000);
      const images = view.pic
        ? [mediaItem({ id: `${bvid}-cover`, type: 'image', safeUrl: view.pic.startsWith('http') ? view.pic : null, alt: view.title ?? null })]
        : [];

      return buildRecord({
        platform: 'bilibili',
        sourceId: 'bilibili-public',
        externalId: bvid,
        author: {
          id: view.owner?.mid != null ? String(view.owner.mid) : null,
          name: view.owner?.name ?? null,
          avatarUrl: view.owner?.face ?? null,
          profileUrl: view.owner?.mid != null ? `https://space.bilibili.com/${view.owner.mid}` : null,
        },
        title: view.title ?? null,
        text: desc.text,
        textTruncated: desc.truncated,
        textOriginalLength: desc.originalLength,
        images,
        canonicalUrl: target.canonicalUrl,
        publishedAt: toUtcMs(view.pubdate),
        fetchedAt: now,
        updatedAt: null,
        platformName: '哔哩哔哩',
        retrievalMethod: 'bilibili_open_api_v1',
        status: 'available',
        visibility: 'public',
        counts: {
          likes: typeof view.stat?.like === 'number' ? view.stat.like : null,
          comments: typeof view.stat?.reply === 'number' ? view.stat.reply : null,
        },
        transcripts,
        commentsSample,
        provenance: {
          title: { retrievalMethod: 'open_api_view', fetchedAt: now, availability: view.title ? 'available' : 'unavailable' },
          text: { retrievalMethod: 'open_api_view.desc', fetchedAt: now, availability: 'available' },
          images: { retrievalMethod: 'open_api_view.pic', fetchedAt: now, availability: images.length ? 'available' : 'unavailable' },
          transcript: {
            retrievalMethod: 'open_api_player_v2',
            fetchedAt: now,
            availability: captionsAvailable ? 'available' : 'unavailable',
          },
          comments: {
            retrievalMethod: 'open_api_reply_sort2',
            fetchedAt: now,
            availability: commentsSample?.availability === 'available' ? 'available' : 'unavailable',
          },
        },
        notes: [`policy_request_timeout_ms=${policy.requestTimeoutMs}`, ...notes],
      });
    },
  };
}
