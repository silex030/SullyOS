/**
 * 链接分享服务配置读取（集成卡 t_babca897）。
 *
 * 契约 7.2：新安装 SHARE_LINKS_ENABLED=false；ASR/实验评论/RedNote 独立会话默认关。
 * 这里只做 env → 配置对象，不读全局配置、不硬编码账号/实例地址。
 *
 * 开关与回滚：
 *  - SHARE_LINKS_ENABLED     总开关；false 时 /v1/social/shares/resolve 返回 503 SHARE_LINKS_DISABLED，
 *                            前端据此回落到旧的本地卡片链路（与集成前行为一致）。
 *  - SOCIAL_CONTENT_CACHE_ALLOWED  是否把正文/字幕/评论样本持久化到本机内容库（默认 true，
 *                            单租户自部署：数据只落在部署端 sqlite；设为 false 则 excerpts 不可用，
 *                            契约 5.6 的“不持久正文”语义由该开关承担）。
 *  - SOCIAL_SOURCE_ID_<PLATFORM>   来源标识（默认 'public'：公开只读来源）。
 *                            删掉/置空即视为“未配置来源”，解析返回 SOURCE_NOT_CONFIGURED。
 */

import { SHARE_FEATURE_DEFAULTS, type SocialPlatform } from '../../../utils/socialContent/types';

export interface SocialServiceConfig {
  enabled: boolean;
  maxLinksPerMessage: number;
  maxConcurrentPerScope: number;
  resolveDeadlineMs: number;
  perRequestTimeoutMs: number;
  maxRedirects: number;
  cacheAllowed: boolean;
  transcriptionEnabled: boolean;
  experimentalXhsComments: boolean;
  rednoteEnabled: boolean;
  sourceIds: Partial<Record<SocialPlatform, string | null>>;
  /** 空串 = 不校验（仅限 loopback 部署）；非空时要求 X-Client-Token 相等。 */
  serviceToken: string;
  allowAnonymous: boolean;
  /** 服务端唯一可信 scope（部署共享）。绝不从 body/query 取。 */
  deploymentScope: string;
}

type EnvLike = Record<string, string | undefined>;

function boolOf(raw: unknown, fallback: boolean): boolean {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return fallback;
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return fallback;
}

function intOf(raw: unknown, fallback: number, min: number, max: number): number {
  const s = String(raw ?? '').trim();
  if (!s) return fallback;
  const n = Number(s);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

const PLATFORM_ENV = {
  bilibili: 'SOCIAL_SOURCE_ID_BILIBILI',
  xiaohongshu: 'SOCIAL_SOURCE_ID_XIAOHONGSHU',
  douyin: 'SOCIAL_SOURCE_ID_DOUYIN',
} as const;

type ConfiguredPlatform = keyof typeof PLATFORM_ENV;

export function readSocialConfig(env: EnvLike | null | undefined): SocialServiceConfig {
  const e = env ?? {};
  const sourceIds: Partial<Record<SocialPlatform, string | null>> = {};
  for (const platform of Object.keys(PLATFORM_ENV) as ConfiguredPlatform[]) {
    const raw = e[PLATFORM_ENV[platform]];
    const value = raw === undefined ? 'public' : String(raw).trim();
    sourceIds[platform] = value ? value : null;
  }
  return {
    enabled: boolOf(e.SHARE_LINKS_ENABLED, SHARE_FEATURE_DEFAULTS.SHARE_LINKS_ENABLED),
    maxLinksPerMessage: intOf(e.SOCIAL_MAX_LINKS_PER_MESSAGE, SHARE_FEATURE_DEFAULTS.MAX_LINKS_PER_MESSAGE, 1, 10),
    maxConcurrentPerScope: intOf(e.SOCIAL_MAX_CONCURRENT_PER_SCOPE, SHARE_FEATURE_DEFAULTS.MAX_CONCURRENT_PER_SCOPE, 1, 4),
    resolveDeadlineMs: intOf(e.SOCIAL_RESOLVE_DEADLINE_MS, SHARE_FEATURE_DEFAULTS.RESOLVE_DEADLINE_MS, 2000, 60000),
    perRequestTimeoutMs: intOf(e.SOCIAL_PER_REQUEST_TIMEOUT_MS, SHARE_FEATURE_DEFAULTS.PER_REQUEST_TIMEOUT_MS, 1000, 30000),
    maxRedirects: intOf(e.SOCIAL_MAX_REDIRECTS, SHARE_FEATURE_DEFAULTS.MAX_REDIRECTS, 0, 8),
    cacheAllowed: boolOf(e.SOCIAL_CONTENT_CACHE_ALLOWED, true),
    transcriptionEnabled: boolOf(e.TRANSCRIPTION_ENABLED, SHARE_FEATURE_DEFAULTS.TRANSCRIPTION_ENABLED),
    experimentalXhsComments: boolOf(e.EXPERIMENTAL_XHS_COMMENTS, SHARE_FEATURE_DEFAULTS.EXPERIMENTAL_XHS_COMMENTS),
    rednoteEnabled: boolOf(e.REDNOTE_INDEPENDENT_SESSION, SHARE_FEATURE_DEFAULTS.REDNOTE_INDEPENDENT_SESSION),
    sourceIds,
    // 服务被 main-agent 反代到 127.0.0.1，不再单独持一份 token；但若部署端配了就必须匹配。
    serviceToken: String(e.SOCIAL_SERVICE_TOKEN ?? '').trim(),
    allowAnonymous: boolOf(e.SOCIAL_SERVICE_ALLOW_ANONYMOUS, false),
    deploymentScope: String(e.SOCIAL_DEPLOYMENT_SCOPE ?? '').trim() || 'deployment',
  };
}

/** 运行时自检用：给 /health 与状态面板的安全摘要（不含 token）。 */
export function publicConfigSummary(cfg: SocialServiceConfig) {
  return {
    enabled: cfg.enabled,
    maxLinksPerMessage: cfg.maxLinksPerMessage,
    resolveDeadlineMs: cfg.resolveDeadlineMs,
    cacheAllowed: cfg.cacheAllowed,
    transcriptionEnabled: cfg.transcriptionEnabled,
    experimentalXhsComments: cfg.experimentalXhsComments,
    rednoteEnabled: cfg.rednoteEnabled,
    sources: {
      bilibili: cfg.sourceIds.bilibili ? 'configured' : 'not_configured',
      xiaohongshu: cfg.sourceIds.xiaohongshu ? 'configured' : 'not_configured',
      douyin: cfg.sourceIds.douyin ? 'configured' : 'not_configured',
    },
  };
}
