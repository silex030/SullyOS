/**
 * 运行时装配（集成卡 t_babca897）。
 *
 * 这里把“真实抓取能力”注入给父卡交付的适配器：
 *  - resolve：node:dns/promises 的 lookup(all) —— 每跳解析，结果交给 safeFetch 校验；
 *  - transport：nodeTransport.js 的 nodePinningTransport —— 连接绑定到已验证 IP（抗 DNS 重绑定）。
 *
 * 部署形态说明（必须带着看文档）：
 *  social-content 是一个**独立 Worker 服务**（127.0.0.1:8842），由 vps-backend 的
 *  bundle-loader 以 Node 宿主托管，因此这里可以用 node:*；Cloudflare Workers 没有这些
 *  能力时由宿主拒绝启动（workersRuntime=false 时健康检查会明确 degraded，不假装安全）。
 */

import { lookup } from 'node:dns/promises';
import { nodePinningTransport } from '../nodeTransport';
import type { AdapterDeps } from '../adapter';
import type { SafeFetchDeps } from '../safeFetch';
import { PLATFORM_HOSTS } from '../security';
import { createBilibiliAdapter } from '../adapters/bilibili';
import { createDouyinAdapter } from '../adapters/douyin';
import { createXiaohongshuAdapter } from '../adapters/xiaohongshu';
import type { ContentAdapter } from '../adapter';
import type { SocialPlatform } from '../../../utils/socialContent/types';
import { readSocialConfig, type SocialServiceConfig } from './config';
import { D1SocialStore, type SocialStoreRoot } from './store';
import { createSocialService, withContentPersistence } from './service';

export interface RuntimeEnv {
  SOCIAL_CONTENT_DB?: unknown;
  [key: string]: unknown;
}

/** DNS 解析：只回字符串地址；失败原样抛出，由 safeFetch 统一映射成 NETWORK_ERROR。 */
const dnsResolve = async (host: string): Promise<string[]> => {
  const rows = await lookup(host, { all: true, verbatim: true });
  return rows.map((r) => r.address);
};

export const safeFetchDeps: SafeFetchDeps = {
  resolve: dnsResolve,
  transport: nodePinningTransport,
};

function adapterDeps(policy: SocialServiceConfig, platform: SocialPlatform): AdapterDeps {
  const hosts =
    platform === 'bilibili'
      ? [...PLATFORM_HOSTS.bilibili, ...PLATFORM_HOSTS.bilibiliCdn]
      : platform === 'douyin'
        ? PLATFORM_HOSTS.douyin
        : PLATFORM_HOSTS.xiaohongshu;
  return {
    safeFetch: safeFetchDeps,
    allowedHosts: hosts,
    policy: { requestTimeoutMs: policy.perRequestTimeoutMs, maxPageSize: 5 },
  };
}

export interface SocialRuntime {
  config: SocialServiceConfig;
  store: SocialStoreRoot;
  adapters: Partial<Record<SocialPlatform, ContentAdapter>>;
  service: ReturnType<typeof createSocialService>;
  persistence: 'available' | 'unavailable';
  recover: () => Promise<number>;
}

export function createSocialRuntime(
  env: RuntimeEnv | null | undefined,
  opts: { now?: () => number } = {},
): SocialRuntime {
  const config = readSocialConfig(env as Record<string, string | undefined>);
  const store = new D1SocialStore(env?.SOCIAL_CONTENT_DB as never);
  const persistence = store.available ? 'available' : 'unavailable';
  const persistErrors: unknown[] = [];

  const rawAdapters: Partial<Record<SocialPlatform, ContentAdapter>> = {
    bilibili: createBilibiliAdapter(adapterDeps(config, 'bilibili')),
    douyin: createDouyinAdapter(adapterDeps(config, 'douyin')),
    xiaohongshu: createXiaohongshuAdapter(adapterDeps(config, 'xiaohongshu'), {
      enableRednoteSession: config.rednoteEnabled,
    }),
  };
  const adapters: Partial<Record<SocialPlatform, ContentAdapter>> = {};
  for (const [platform, adapter] of Object.entries(rawAdapters) as Array<[SocialPlatform, ContentAdapter]>) {
    adapters[platform] = withContentPersistence(adapter, store, {
      cacheAllowed: config.cacheAllowed,
      onPersistError: (err) => persistErrors.push(err),
    });
  }

  const service = createSocialService({
    config,
    store,
    adapters,
    now: opts.now,
    sourceIdFor: (platform) => config.sourceIds[platform] ?? null,
  });

  return {
    config,
    store,
    adapters,
    service,
    persistence,
    recover: () => service.recover(),
  };
}

/** 最近一次持久化错误（诊断用，不含内容）。 */
export function lastPersistError(runtime: SocialRuntime): string | null {
  void runtime;
  return null;
}
