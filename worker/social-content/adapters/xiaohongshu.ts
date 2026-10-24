/**
 * 小红书适配器（t_2c2dba79）。
 *
 * 现状（只读核验）：worker/xhs-lite/README.md:36-38 记录国内与 RedNote 后端会话分离；
 * notes/ethernet-branch-context.md:123 记录 XHS VPS 会话因缺 camofox 停用。
 * 契约 8 / 2.1 明确：XHS 已停会话桥不能默认恢复，不得安装浏览器、扫码、换账号或过风控。
 *
 * 因此 v1 能力边界写死在这里：
 *  - 短链展开（xhslink → 官方内容页）可以走受控抓取，因为不需要登录；
 *  - **正文/图片/评论一律返回 AUTH_REQUIRED**，不抓取、不伪造、不从缓存复活旧内容；
 *  - rednote.com 独立会话默认关闭，只有部署端显式传入 enableRednoteSession 才放行短链展开，
 *    正文同样保持 AUTH_REQUIRED，除非将来验证过的独立会话接入（不在本卡范围）。
 */

import { safeGet } from '../safeFetch';
import { SocialError } from '../errors';
import { PLATFORM_HOSTS } from '../security';
import {
  DEFAULT_SOURCE_POLICY,
  fetchPolicy,
  type AdapterContext,
  type AdapterDeps,
  type AdapterHealth,
  type ContentAdapter,
  type SourceTarget,
} from '../adapter';

const HOSTS = PLATFORM_HOSTS.xiaohongshu;

export interface XiaohongshuAdapterOptions {
  /** 独立 RedNote 会话：默认 false；true 也只影响短链展开与 host 白名单。 */
  enableRednoteSession?: boolean;
}

function parseXhsPost(url: URL): { externalId: string; canonicalUrl: string } | null {
  const m = url.pathname.match(/^\/(?:explore|discovery\/item)\/([0-9A-Za-z]+)\/?$/);
  if (!m) return null;
  const host = url.hostname.toLowerCase();
  const canonicalHost = host.endsWith('rednote.com') ? 'https://www.rednote.com' : 'https://www.xiaohongshu.com';
  return { externalId: m[1], canonicalUrl: `${canonicalHost}/explore/${m[1]}` };
}

export function createXiaohongshuAdapter(deps: AdapterDeps, opts: XiaohongshuAdapterOptions = {}): ContentAdapter {
  const rednoteOn = opts.enableRednoteSession === true;
  const policy = { ...DEFAULT_SOURCE_POLICY, ...(deps.policy ?? {}) };
  const hosts = rednoteOn ? [...HOSTS, ...PLATFORM_HOSTS.rednote] : HOSTS;

  return {
    id: 'xiaohongshu-public-v1',
    platform: 'xiaohongshu',
    version: '1.0.0',
    capabilities: { detail: false, comments: false, shortLink: true, transcript: false },

    async health(): Promise<AdapterHealth> {
      // 会话桥停用是现状而不是故障：detail 能力没有，必须如实标 auth_required
      return {
        status: 'auth_required',
        note: 'XHS 会话桥已停用（缺 camofox）；v1 只做短链展开，正文/评论不抓取',
      };
    },

    async expandShortLink(url: string, ctx: AdapterContext): Promise<SourceTarget> {
      const res = await safeGet(url, deps.safeFetch, {
        ...fetchPolicy(deps, hosts),
        allowedHosts: hosts,
        perRequestTimeoutMs: policy.requestTimeoutMs,
        maxBytes: 64 * 1024,
        deadline: ctx.deadline,
      });
      const finalUrl = new URL(res.finalUrl);
      const parsed = parseXhsPost(finalUrl);
      if (!parsed) throw new SocialError('UNSUPPORTED_LINK_TYPE', 'xhslink_target_not_post');
      // resolvedUrl 去掉 query：其中的 xsec_token 等访问参数不进客户端/日志/缓存键（契约 2.3）
      const safeResolved = `${finalUrl.origin}${finalUrl.pathname}`;
      return {
        platform: 'xiaohongshu',
        externalId: parsed.externalId,
        partKey: null,
        canonicalUrl: parsed.canonicalUrl,
        resolvedUrl: safeResolved,
      };
    },

    async fetchContent(_target: SourceTarget, _ctx: AdapterContext) {
      // 明确拒绝而不是返回空内容：没有材料就是没有材料（契约 3.9）
      throw new SocialError('AUTH_REQUIRED', 'xhs_session_bridge_disabled');
    },
  };
}
