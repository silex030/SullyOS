/**
 * 真实网络探针（默认跳过；只有 SOCIAL_REAL_NETWORK=1 才跑）。
 *
 * 为什么单独一个文件：缺陷 5 要求「测试必须区分真实网络与 mock」，并且真实成功/失败都要有
 * 原始证据。仓库其它 social-content 测试全部用夹具/桩，**不代表平台可达性**；这个文件用
 * 真实 DNS + 真实 pinned transport + 真实适配器打真链，只记录结果（成功就记标题/正文字符数/
 * 字幕状态，失败就记结构化错误码），不对任何平台“宣称已接通”。
 *
 * 运行：
 *   SOCIAL_REAL_NETWORK=1 npx vitest run worker/social-content/realNetwork.probe.test.ts --reporter=verbose
 */
import { describe, expect, it } from 'vitest';
import { lookup } from 'node:dns/promises';
import { nodePinningTransport } from './nodeTransport';
import { createBilibiliAdapter } from './adapters/bilibili';
import { createDouyinAdapter } from './adapters/douyin';
import { createXiaohongshuAdapter } from './adapters/xiaohongshu';
import { PLATFORM_HOSTS } from './security';
import type { AdapterDeps } from './adapter';
import type { SocialPlatform } from '../../utils/socialContent/types';

const RUN = process.env.SOCIAL_REAL_NETWORK === '1';

const dnsResolve = async (host: string): Promise<string[]> => {
  const rows = await lookup(host, { all: true, verbatim: true });
  return rows.map((r) => r.address);
};

function depsFor(platform: SocialPlatform): AdapterDeps {
  const hosts =
    platform === 'bilibili'
      ? [...PLATFORM_HOSTS.bilibili, ...PLATFORM_HOSTS.bilibiliCdn]
      : platform === 'douyin'
        ? PLATFORM_HOSTS.douyin
        : PLATFORM_HOSTS.xiaohongshu;
  return {
    safeFetch: { resolve: dnsResolve, transport: nodePinningTransport },
    allowedHosts: hosts,
    policy: { requestTimeoutMs: 8000, maxPageSize: 5 },
  };
}

/** 只打印结构化事实，不打印正文（避免把第三方内容落进日志）。 */
interface ProbeRow {
  platform: SocialPlatform;
  url: string;
  outcome: 'ok' | 'error';
  ms: number;
  title?: string | null;
  bodyChars?: number;
  transcript?: string;
  comments?: string;
  errorCode?: string;
  errorReason?: string | null;
}

const CASES: Array<{ platform: SocialPlatform; externalId: string; canonicalUrl: string; partKey: string | null }> = [
  {
    platform: 'bilibili',
    externalId: 'BV1xx411c7mD',
    canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    partKey: null,
  },
  {
    platform: 'douyin',
    // 公开分享页路径（未登录）。ID 是探针输入，不代表这条视频一定存在；
    // 不存在/登录墙都会如实记成结构化错误码，不伪造内容。
    externalId: '7300123456789012345',
    canonicalUrl: 'https://www.douyin.com/video/7300123456789012345',
    partKey: null,
  },
  {
    platform: 'xiaohongshu',
    externalId: '64f0aa11bb',
    canonicalUrl: 'https://www.xiaohongshu.com/explore/64f0aa11bb',
    partKey: null,
  },
];

describe.runIf(RUN)('真实网络探针（只读；不声称平台已接通）', () => {
  it(
    '三平台真链：记录成功事实或结构化失败',
    async () => {
      const rows: ProbeRow[] = [];
      for (const c of CASES) {
        const adapter =
          c.platform === 'bilibili'
            ? createBilibiliAdapter(depsFor('bilibili'))
            : c.platform === 'douyin'
              ? createDouyinAdapter(depsFor('douyin'))
              : createXiaohongshuAdapter(depsFor('xiaohongshu'));
        const deadline = Date.now() + 20000;
        const started = Date.now();
        try {
          const record = await adapter.fetchContent(
            {
              platform: c.platform,
              externalId: c.externalId,
              partKey: c.partKey,
              canonicalUrl: c.canonicalUrl,
              resolvedUrl: c.canonicalUrl,
            },
            { scope: 'real-network-probe', deadline },
          );
          const caption = (record.transcripts ?? []).find((t) => t.kind === 'native_caption');
          rows.push({
            platform: c.platform,
            url: c.canonicalUrl,
            outcome: 'ok',
            ms: Date.now() - started,
            title: record.title,
            bodyChars: record.body.text.length,
            transcript: caption?.availability ?? 'absent',
            comments: record.commentsSample?.availability ?? 'not_requested',
          });
        } catch (err) {
          const e = err as { code?: string; reason?: string; message?: string };
          rows.push({
            platform: c.platform,
            url: c.canonicalUrl,
            outcome: 'error',
            ms: Date.now() - started,
            errorCode: e?.code ?? 'UNKNOWN',
            errorReason: e?.reason ?? e?.message ?? null,
          });
        }
      }
      // 原始证据：整行 JSON（含每平台耗时/错误码），供人工复核，不做“都成功”的断言
      console.log('REAL_NETWORK_PROBE ' + JSON.stringify(rows, null, 2));
      expect(rows).toHaveLength(CASES.length);
      for (const row of rows) {
        expect(['ok', 'error']).toContain(row.outcome);
        if (row.outcome === 'ok') expect(row.bodyChars).toBeGreaterThanOrEqual(0);
        else expect(row.errorCode).toBeTruthy();
      }
    },
    120_000,
  );
});
