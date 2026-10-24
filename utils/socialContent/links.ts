/**
 * 分享文本 → 链接候选（t_2c2dba79，契约 2.2 / 2.3 / 3.2）。
 *
 * 纯函数，不发网络请求。职责边界：
 *  - 从混合分享文本里提取候选链接，保留原文 UTF-16 span；
 *  - 去包裹标点，但**不改 ID 大小写、不动访问签名参数**；
 *  - 按平台域名/路径白名单判定支持范围，TikTok / bilibili.tv 明确不支持；
 *  - 短链只标 linkKind='short'，**不在这里合并内容引用**（合并要等受控展开确认）；
 *  - 同一消息内同链接合并，保留多个 span；
 *  - 超出 5 链接的候选逐项标记 overLimit，由调用方显式给状态，不静默丢弃。
 *
 * 反例（必须保持）：
 *  - `https://www.xiaohongshu.com@evil.com/explore/x` 的 host 是 evil.com → 拒绝；
 *  - `https://WWW.XIAOHONGSHU.COM/explore/ABC123` 的 externalId 保持 'ABC123'，不转小写；
 *  - `https://www.bilibili.com/video/BV1xx411c7mD?p=2&spm_id_from=...` 的 partKey 为 'p2'，
 *    canonicalUrl 不带 spm 之类跟踪参数；原文串本身仍原样保留在 originalUrl。
 */

import type { OccurrenceSpan, SocialPlatform } from './types';
import { SHARE_REQUEST_LIMITS } from './types';

export type { OccurrenceSpan };

/** 拒绝码沿用契约错误码子集；overLimit 用同一个 SIZE_LIMIT，不再造新码。 */
export type LinkRejectCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_PLATFORM'
  | 'UNSUPPORTED_LINK_TYPE'
  | 'UNSUPPORTED_REGION_OR_PRODUCT'
  | 'SOURCE_NOT_CONFIGURED'
  | 'SIZE_LIMIT';

export interface LinkCandidate {
  /** 用户原文里的链接字面值（已剥包裹标点，保留原大小写与查询串）。 */
  originalUrl: string;
  /** 解析用的绝对 URL（裸域名/裸 BV 会补齐 scheme）。 */
  resolvedInput: string;
  /** 该链接在原文中的全部出现位置；合并同链接后 >1 项。 */
  spans: OccurrenceSpan[];
  /** 首个 span 的便捷访问（= spans[0]）。 */
  span: OccurrenceSpan;
  /** canonical 直接得外部 ID；short 需受控展开；unsupported 明确不可解析。 */
  linkKind: 'canonical' | 'short' | 'unsupported';
  platform: SocialPlatform | null;
  /** 平台内容 ID（BV… / av… / 数字 / 笔记 ID），大小写原样保留。 */
  externalId: string | null;
  /** B 站 p 参数，形如 'p2'；其他平台为 null。 */
  partKey: string | null;
  /** 稳定官方内容页；短链未展开时为 null。 */
  canonicalUrl: string | null;
  /** 保留必要访问参数、通过白名单校验的跳转入口；未验证时为 null。 */
  openUrl: string | null;
  /** 超过单消息上限（契约 4.1），调用方须显式标状态。 */
  overLimit: boolean;
  rejectCode: LinkRejectCode | null;
  /** 拒绝原因，进日志/诊断，不直接展示给用户。 */
  rejectReason: string | null;
}

export interface ExtractOptions {
  /** rednote.com 独立会话只在显式开启后接受帖子路径（契约 2.1）。 */
  rednoteEnabled?: boolean;
  /** 单条消息链接上限，默认 5。 */
  maxLinks?: number;
  /** 文本上限，默认 16000 UTF-16 单元。 */
  maxTextUtf16Units?: number;
}

export type ExtractResult =
  | { ok: true; candidates: LinkCandidate[]; droppedOverLimit: number; duplicatesMerged: number; queuedCount: number }
  | { ok: false; code: 'SIZE_LIMIT' | 'INVALID_URL'; userMessage: string };

/** 尾部包裹标点：只剥这些，不剥 URL 自身的合法字符。 */
const TRAILING_PUNCT = /[.,;:!?'"`)\]}>，。！？；：、）】》」』”’…]+$/u;
/** 前导包裹符：中文书名号/引号/括号不进入链接。 */
const LEADING_PUNCT = /^[<(\[{「『“"'《【（]+/u;

/** 常见分享文本里的裸域名短链（无 scheme）。只对白名单短链 host 生效。 */
const SCHEMELESS_HOSTS = ['xhslink.com', 'www.xhslink.com', 'b23.tv', 'v.douyin.com'];

const URL_IN_TEXT = /(?:https?:\/\/|www\.)[^\s<>"'`，。！？；：、（）【】《》「」『』“”‘’…]+/giu;
const SCHEMELESS_IN_TEXT = new RegExp(
  `(?<![\\w.@/])(?:${SCHEMELESS_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|')})/[^\\s<>"'\`，。！？；：、（）【】《》「」『』“”‘’…]*`,
  'giu',
);

const BV_RE = /(?<![0-9A-Za-z])BV[0-9A-Za-z]{10}(?![0-9A-Za-z])/g;

/** 已知不支持：TikTok 与 bilibili.tv/biliintl 不是同一产品（契约 2.1）。 */
const UNSUPPORTED_PRODUCT_HOSTS = [
  'tiktok.com',
  'www.tiktok.com',
  'm.tiktok.com',
  'vm.tiktok.com',
  'vt.tiktok.com',
  'bilibili.tv',
  'www.bilibili.tv',
  'biliintl.com',
  'www.biliintl.com',
];

const XHS_POST_PATHS: RegExp[] = [/^\/explore\/([0-9A-Za-z]+)\/?$/, /^\/discovery\/item\/([0-9A-Za-z]+)\/?$/];
const DOUYIN_PATHS: Array<{ re: RegExp; kind: 'video' | 'note' }> = [
  { re: /^\/video\/(\d{6,})\/?$/, kind: 'video' },
  { re: /^\/note\/(\d{6,})\/?$/, kind: 'note' },
];
const BILIBILI_VIDEO_PATH = /^\/video\/((?:BV[0-9A-Za-z]{10})|(?:av\d+))\/?$/;

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
}

function isIpLiteral(host: string): boolean {
  if (host.includes(':')) return true; // IPv6 字面量
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // 整型/十六进制写法（2130706433、0x7f000001）一律按 IP 字面量拒绝
  if (/^(0x[0-9a-f]+|\d+)$/.test(host)) return true;
  return false;
}

function hasControlChars(raw: string): boolean {
  // 控制字符、零宽字符、双向覆盖字符都可能是混淆手法
  return /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(raw);
}

type ParsedUrl = { ok: true; url: URL } | { ok: false; code: 'INVALID_URL'; reason: string };

/** URL 层硬性拒绝，先于任何平台判定（契约 7.1）。 */
function parseStrict(raw: string): ParsedUrl {
  if (!raw || raw.length > 4096) return { ok: false, code: 'INVALID_URL', reason: 'url_too_long' };
  if (hasControlChars(raw)) return { ok: false, code: 'INVALID_URL', reason: 'control_chars' };
  if (raw.includes('\\')) return { ok: false, code: 'INVALID_URL', reason: 'backslash_obfuscation' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, code: 'INVALID_URL', reason: 'unparsable' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, code: 'INVALID_URL', reason: 'protocol' };
  if (u.username || u.password) return { ok: false, code: 'INVALID_URL', reason: 'userinfo' };
  if (u.port && u.port !== '80' && u.port !== '443') return { ok: false, code: 'INVALID_URL', reason: 'port' };
  const host = normalizeHost(u.hostname);
  if (!host) return { ok: false, code: 'INVALID_URL', reason: 'empty_host' };
  if (isIpLiteral(host)) return { ok: false, code: 'INVALID_URL', reason: 'ip_literal' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, code: 'INVALID_URL', reason: 'internal_host' };
  }
  return { ok: true, url: u };
}

/** B 站 p 参数：合法正整数才算，其余忽略（不猜）。 */
export function bilibiliPartKey(u: URL): string | null {
  const raw = u.searchParams.get('p');
  if (!raw || !/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return null;
  return `p${n}`;
}

type Classified = Omit<LinkCandidate, 'originalUrl' | 'resolvedInput' | 'spans' | 'span' | 'overLimit'>;

function reject(
  patch: Partial<Classified> & { rejectCode: LinkRejectCode; rejectReason: string },
): Classified {
  return {
    linkKind: 'unsupported',
    platform: null,
    externalId: null,
    partKey: null,
    canonicalUrl: null,
    openUrl: null,
    ...patch,
  } as Classified;
}

/** 平台判定 + 内容 ID 抽取。不支持的域名返回 linkKind='unsupported' 与明确错误码。 */
function classify(u: URL, rednoteEnabled: boolean): Classified {
  const host = normalizeHost(u.hostname);
  const pathname = u.pathname || '/';

  if (UNSUPPORTED_PRODUCT_HOSTS.includes(host)) {
    return reject({ rejectCode: 'UNSUPPORTED_REGION_OR_PRODUCT', rejectReason: 'product_out_of_scope' });
  }

  if (host === 'xhslink.com' || host === 'www.xhslink.com') {
    if (pathname.length < 2) {
      return reject({ platform: 'xiaohongshu', rejectCode: 'INVALID_URL', rejectReason: 'empty_short_link' });
    }
    return {
      linkKind: 'short',
      platform: 'xiaohongshu',
      externalId: null,
      partKey: null,
      canonicalUrl: null,
      openUrl: null,
      rejectCode: null,
      rejectReason: null,
    };
  }

  if (host === 'xiaohongshu.com' || host === 'www.xiaohongshu.com') {
    for (const re of XHS_POST_PATHS) {
      const m = pathname.match(re);
      if (m) {
        const id = m[1];
        return {
          linkKind: 'canonical',
          platform: 'xiaohongshu',
          externalId: id,
          partKey: null,
          canonicalUrl: `https://www.xiaohongshu.com/explore/${id}`,
          // XHS 必要访问参数（xsec_token 等）不盲删，但只在受控展开确认后进 openUrl；
          // 客户端直接拼的开链不携带任何签名，故此处为 null。
          openUrl: null,
          rejectCode: null,
          rejectReason: null,
        };
      }
    }
    return reject({ platform: 'xiaohongshu', rejectCode: 'UNSUPPORTED_LINK_TYPE', rejectReason: 'xhs_path_not_post' });
  }

  if (host === 'rednote.com' || host === 'www.rednote.com') {
    if (!rednoteEnabled) {
      return reject({
        platform: 'xiaohongshu',
        rejectCode: 'SOURCE_NOT_CONFIGURED',
        rejectReason: 'rednote_session_disabled',
      });
    }
    for (const re of XHS_POST_PATHS) {
      const m = pathname.match(re);
      if (m) {
        return {
          linkKind: 'canonical',
          platform: 'xiaohongshu',
          externalId: m[1],
          partKey: null,
          canonicalUrl: `https://www.rednote.com/explore/${m[1]}`,
          openUrl: null,
          rejectCode: null,
          rejectReason: null,
        };
      }
    }
    return reject({ platform: 'xiaohongshu', rejectCode: 'UNSUPPORTED_LINK_TYPE', rejectReason: 'rednote_path_not_post' });
  }

  if (host === 'v.douyin.com') {
    if (pathname.length < 2) {
      return reject({ platform: 'douyin', rejectCode: 'INVALID_URL', rejectReason: 'empty_short_link' });
    }
    return {
      linkKind: 'short',
      platform: 'douyin',
      externalId: null,
      partKey: null,
      canonicalUrl: null,
      openUrl: null,
      rejectCode: null,
      rejectReason: null,
    };
  }

  if (host === 'douyin.com' || host === 'www.douyin.com') {
    for (const p of DOUYIN_PATHS) {
      const m = pathname.match(p.re);
      if (m) {
        return {
          linkKind: 'canonical',
          platform: 'douyin',
          externalId: m[1],
          partKey: null,
          canonicalUrl: `https://www.douyin.com/${p.kind}/${m[1]}`,
          openUrl: null,
          rejectCode: null,
          rejectReason: null,
        };
      }
    }
    return reject({ platform: 'douyin', rejectCode: 'UNSUPPORTED_LINK_TYPE', rejectReason: 'douyin_path_not_video_or_note' });
  }

  // 兼容候选：iesdouyin 分享页。只在拿到视频/笔记 ID 时接受。
  if (host === 'iesdouyin.com' || host === 'www.iesdouyin.com') {
    const m = pathname.match(/^\/share\/(?:video|note)\/(\d{6,})\/?$/);
    if (m) {
      return {
        linkKind: 'canonical',
        platform: 'douyin',
        externalId: m[1],
        partKey: null,
        canonicalUrl: `https://www.douyin.com/video/${m[1]}`,
        openUrl: null,
        rejectCode: null,
        rejectReason: null,
      };
    }
    return reject({ platform: 'douyin', rejectCode: 'UNSUPPORTED_LINK_TYPE', rejectReason: 'iesdouyin_path_unknown' });
  }

  if (host === 'b23.tv') {
    if (pathname.length < 2) {
      return reject({ platform: 'bilibili', rejectCode: 'INVALID_URL', rejectReason: 'empty_short_link' });
    }
    return {
      linkKind: 'short',
      platform: 'bilibili',
      externalId: null,
      partKey: bilibiliPartKey(u),
      canonicalUrl: null,
      openUrl: null,
      rejectCode: null,
      rejectReason: null,
    };
  }

  if (host === 'bilibili.com' || host === 'www.bilibili.com' || host === 'm.bilibili.com') {
    const m = pathname.match(BILIBILI_VIDEO_PATH);
    if (m) {
      const externalId = m[1];
      const partKey = bilibiliPartKey(u);
      const canonicalUrl = `https://www.bilibili.com/video/${externalId}${partKey ? `?p=${partKey.slice(1)}` : ''}`;
      return {
        linkKind: 'canonical',
        platform: 'bilibili',
        externalId,
        partKey,
        canonicalUrl,
        openUrl: canonicalUrl,
        rejectCode: null,
        rejectReason: null,
      };
    }
    return reject({ platform: 'bilibili', rejectCode: 'UNSUPPORTED_LINK_TYPE', rejectReason: 'bilibili_path_not_video' });
  }

  return reject({ rejectCode: 'UNSUPPORTED_PLATFORM', rejectReason: 'host_not_allowlisted' });
}

/** 去重键：短链语义未确认前按保留签名的完整 URL 归并；canonical 按平台 ID + partKey。 */
function dedupeKey(c: Pick<LinkCandidate, 'linkKind' | 'platform' | 'externalId' | 'partKey' | 'rejectCode' | 'resolvedInput'>): string {
  if (c.linkKind === 'canonical' && c.platform && c.externalId) {
    return `${c.platform}:${c.externalId}:${c.partKey ?? ''}`;
  }
  if (c.linkKind === 'short') return `short:${c.platform}:${c.resolvedInput}`;
  return `unsupported:${c.rejectCode}:${c.resolvedInput}`;
}

interface Found {
  /** 用户原文里的字面值 */
  display: string;
  /** 解析用绝对 URL；裸 BV 号原样 */
  url: string;
  start: number;
  end: number;
}

function findRawLinks(text: string): Found[] {
  const found: Found[] = [];
  const push = (rawStart: number, rawText: string, forceScheme: boolean) => {
    let display = rawText;
    let start = rawStart;
    const lead = display.match(LEADING_PUNCT);
    if (lead) {
      display = display.slice(lead[0].length);
      start += lead[0].length;
    }
    const trail = display.match(TRAILING_PUNCT);
    if (trail) display = display.slice(0, display.length - trail[0].length);
    if (!display) return;
    const url = forceScheme && !/^https?:\/\//i.test(display) ? `https://${display}` : display;
    found.push({ display, url, start, end: start + display.length });
  };

  for (const m of text.matchAll(URL_IN_TEXT)) {
    push(m.index ?? 0, m[0], true);
  }
  for (const m of text.matchAll(SCHEMELESS_IN_TEXT)) {
    const idx = m.index ?? 0;
    if (found.some((f) => idx >= f.start && idx < f.end)) continue;
    push(idx, m[0], true);
  }
  for (const m of text.matchAll(BV_RE)) {
    const idx = m.index ?? 0;
    if (found.some((f) => idx >= f.start && idx < f.end)) continue;
    found.push({ display: m[0], url: m[0], start: idx, end: idx + m[0].length });
  }
  return found.sort((a, b) => a.start - b.start);
}

function mergeCandidate(map: Map<string, LinkCandidate>, candidate: LinkCandidate, onDuplicate: () => void): void {
  const key = dedupeKey(candidate);
  const existing = map.get(key);
  if (!existing) {
    map.set(key, candidate);
    return;
  }
  // 同链接合并：保留首个 originalUrl（用户最早发的那个），span 全留
  existing.spans.push({ ...candidate.span });
  existing.span = existing.spans[0];
  onDuplicate();
}

/**
 * 从混合分享文本里提取链接候选。
 *  - candidates 按原文顺序；同链接合并 spans；超出上限的标 overLimit=true 仍返回；
 *  - droppedOverLimit 与 queuedCount 供路由层做显式限额说明。
 */
export function extractShareLinks(text: string, opts: ExtractOptions = {}): ExtractResult {
  const maxText = opts.maxTextUtf16Units ?? SHARE_REQUEST_LIMITS.maxTextUtf16Units;
  const maxLinks = opts.maxLinks ?? SHARE_REQUEST_LIMITS.maxLinksPerMessage;
  const rednoteEnabled = opts.rednoteEnabled === true;

  if (typeof text !== 'string') return { ok: false, code: 'INVALID_URL', userMessage: '分享文本必须是字符串' };
  if (text.length > maxText) {
    return { ok: false, code: 'SIZE_LIMIT', userMessage: `分享文本超过 ${maxText} 个 UTF-16 单元，请分段发送` };
  }

  const rawLinks = findRawLinks(text);
  if (rawLinks.length === 0) {
    return { ok: true, candidates: [], droppedOverLimit: 0, duplicatesMerged: 0, queuedCount: 0 };
  }

  const byKey = new Map<string, LinkCandidate>();
  let duplicatesMerged = 0;

  for (const f of rawLinks) {
    if (/^BV[0-9A-Za-z]{10}$/.test(f.url)) {
      const c: LinkCandidate = {
        originalUrl: f.display,
        resolvedInput: f.url,
        spans: [{ start: f.start, end: f.end }],
        span: { start: f.start, end: f.end },
        linkKind: 'canonical',
        platform: 'bilibili',
        externalId: f.url,
        partKey: null,
        canonicalUrl: `https://www.bilibili.com/video/${f.url}`,
        openUrl: `https://www.bilibili.com/video/${f.url}`,
        overLimit: false,
        rejectCode: null,
        rejectReason: null,
      };
      mergeCandidate(byKey, c, () => duplicatesMerged++);
      continue;
    }

    const parsed = parseStrict(f.url);
    let c: LinkCandidate;
    if (!parsed.ok) {
      c = {
        originalUrl: f.display,
        resolvedInput: f.url,
        spans: [{ start: f.start, end: f.end }],
        span: { start: f.start, end: f.end },
        overLimit: false,
        ...reject({ rejectCode: parsed.code, rejectReason: parsed.reason }),
      };
    } else {
      const cls = classify(parsed.url, rednoteEnabled);
      c = {
        originalUrl: f.display,
        resolvedInput: parsed.url.toString(),
        spans: [{ start: f.start, end: f.end }],
        span: { start: f.start, end: f.end },
        overLimit: false,
        ...cls,
      };
      // canonical 且未计算 openUrl 时，至少 canonicalUrl 已过白名单
      if (!c.openUrl && c.canonicalUrl && c.linkKind === 'canonical') c.openUrl = c.canonicalUrl;
    }
    mergeCandidate(byKey, c, () => duplicatesMerged++);
  }

  const all = [...byKey.values()].sort((a, b) => a.span.start - b.span.start);

  // 上限只作用于"真正排队解析"的项；unsupported 也返回（它们同样是用户发的链接），
  // 但第 6 个及以后的可解析链接标 overLimit，由调用方逐项给状态。
  let queued = 0;
  let dropped = 0;
  for (const c of all) {
    if (c.linkKind === 'unsupported') continue;
    if (queued >= maxLinks) {
      c.overLimit = true;
      dropped += 1;
      continue;
    }
    queued += 1;
  }

  return {
    ok: true,
    candidates: all,
    droppedOverLimit: dropped,
    duplicatesMerged,
    queuedCount: queued,
  };
}

/**
 * 内容 ID：platform:encoded(sourceId):encoded(externalId)（契约 3.2）。
 * 额外把 ':' 转义，保证分段可逆、防碰撞；不产生 UUID 替代共享 ID。
 */
export function buildContentId(platform: SocialPlatform, sourceId: string, externalId: string): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/:/g, '%3A');
  if (!sourceId) throw new Error('sourceId 不能为空');
  if (!externalId) throw new Error('externalId 不能为空');
  return `${platform}:${enc(sourceId)}:${enc(externalId)}`;
}

/** 从 contentId 反解（审计/日志用；不解码成可执行输入）。 */
export function parseContentId(id: string): { platform: string; sourceId: string; externalId: string } | null {
  const parts = id.split(':');
  if (parts.length !== 3) return null;
  try {
    return { platform: parts[0], sourceId: decodeURIComponent(parts[1]), externalId: decodeURIComponent(parts[2]) };
  } catch {
    return null;
  }
}
