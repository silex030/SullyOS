/**
 * SullyOS VPS 后端 · 服务清单（端口矩阵唯一事实来源）。
 *
 * 每个服务两种宿主形态：
 *  - bundle 存在  → bin/sullyos-service.js 以「Cloudflare 兼容层」托管 worker.bundle.js；
 *  - bundle 不存在 → run-all 打印跳过原因（尚未移植）。
 *
 * 端口矩阵（与 /opt/sullyos/.env、deploy/caddy/SullyOS.Caddyfile 三处保持一致）：
 *   main-agent      8830   主代理（LLM 多供应商 + MCP 循环重构版）
 *   instant-push    8831   Step 1 里程碑（本文件当前唯一 enabled）
 *   amsg            8832   定时消息（AES-GCM）
 *   proactive-push  8833   主动消息
 *   wake-bridge     8834   唤醒桥
 *   heartbeat       8835   心跳
 *
 * 所有服务仅监听 127.0.0.1，由 Caddy 统一反代 80/443（自动 HTTPS）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根目录（vps-backend 的上一级）。 */
export const repoRoot = path.resolve(here, '../..');

/** vps-backend 数据目录（sqlite 落盘位置）。 */
export const dataDir = path.resolve(here, '../data');

/**
 * @typedef {object} ServiceDef
 * @property {string} name        服务名（进程名 / --service 参数）
 * @property {number} port        监听端口
 * @property {boolean} enabled    是否随 run-all 启动
 * @property {string} [bundle]    worker.bundle.js 绝对路径
 * @property {string[]} [envKeys] 直通给 Worker 的环境变量（文档用途；实际为全量直通 + DB 单独绑定）
 * @property {{bindKey:string, pathEnv?:string, defaultPath:string, enableIf?: (p:NodeJS.ProcessEnv)=>boolean}} [db]
 * @property {{expr:string, name?:string}[]} [crons]
 */

/** @type {ServiceDef[]} */
export const services = [
  {
    name: 'main-agent',
    port: 8830,
    enabled: true, // ★ Step 3：MCP 循环已落地（MAX_LOOPS 可配默认 12、参考类工具钉住、WebDAV 认证注入）
    bundle: path.join(repoRoot, 'worker/main-agent/worker.bundle.js'),
    envKeys: [
      'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_FALLBACKS',
      'LLM_TIMEOUT_MS', 'MCP_MAX_LOOPS', 'MCP_PINNED_TOOLS', 'MCP_SERVERS',
      'AMSG_CLIENT_TOKEN',
      'DUFS_PORT', 'DUFS_AUTH', 'DUFS_ROOT',
      // 链接分享：main-agent 只做鉴权后的反代，解析在 social-content（8842）里跑。
      'SOCIAL_CONTENT_URL', 'SOCIAL_SERVICE_TOKEN', 'SHARE_LINKS_ENABLED',
      'INSTANT_PUSH_URL', 'AMSG_URL', 'PROACTIVE_PUSH_URL',
      // 本地 EmbeddingGemma2（127.0.0.1:8850）：这几个只服务 main-agent 的
      // /v1/local-embedding* 路由，由 systemd EnvironmentFile
      // /opt/sullyos/secrets/local-embedding.env 注入（600 root），
      // 不写进 .env、不回传浏览器、不进备份。缺 key 时路由返回 503 而不是匿名放行。
      'LOCAL_EMBEDDING_API_KEY', 'LOCAL_EMBEDDING_URL', 'LOCAL_EMBEDDING_MODEL',
      'LOCAL_EMBEDDING_DIMENSIONS', 'LOCAL_EMBEDDING_TIMEOUT_MS',
      'LOCAL_EMBEDDING_MAX_BATCH', 'LOCAL_EMBEDDING_MAX_ITEM_CHARS',
      'LOCAL_EMBEDDING_MAX_BODY_BYTES', 'LOCAL_EMBEDDING_MAX_QUEUE',
      'LOCAL_EMBEDDING_MAX_CONCURRENCY',
    ],
    crons: [],
  },
  {
    name: 'instant-push',
    port: 8831,
    enabled: true, // ★ Step 1 里程碑
    bundle: path.join(repoRoot, 'worker/instant-push/worker.bundle.js'),
    envKeys: [
      'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_EMAIL',
      'AMSG_CLIENT_TOKEN', 'AMSG_OVERSIZE_TRANSPORT', 'AMSG_ENABLE_D1_BLOBSTORE',
    ],
    // D1 BlobStore 可选：仅当 AMSG_ENABLE_D1_BLOBSTORE=true 才创建 better-sqlite3 适配器；
    // 缺省 multipart 模式完全不需要 DB（与 CF 行为一致：无绑定 → 优雅回退）。
    db: {
      bindKey: 'DB',
      pathEnv: 'AMSG_DB_PATH',
      defaultPath: path.join(dataDir, 'instant-push.sqlite'),
      schemaPath: path.join(repoRoot, 'worker/instant-push/schema.sql'),
      enableIf: (p) => p.AMSG_ENABLE_D1_BLOBSTORE === 'true',
    },
    crons: [
      // 原 CF 面板上的 scheduled trigger：D1 过期 blob 清理（未启用 D1 时为空操作，安全）
      { expr: '0 * * * *', name: 'd1-blob-sweeper' },
    ],
  },
  {
    // 链接分享解析（小红书/抖音/B站）—— 独立 Worker，只监听 127.0.0.1，
    // 外部入口统一经 main-agent 的 /agent/v1/social/* 鉴权反代（不单独开公网面）。
    // 依赖 node:http(s) 的连接绑定 transport（抗 DNS 重绑定），无 D1 绑定会明确 503。
    name: 'social-content',
    port: 8842,
    enabled: true,
    bundle: path.join(repoRoot, 'worker/social-content/worker.bundle.js'),
    envKeys: [
      'SHARE_LINKS_ENABLED',
      'SOCIAL_SERVICE_TOKEN', 'SOCIAL_SERVICE_ALLOW_ANONYMOUS', 'SOCIAL_DEPLOYMENT_SCOPE',
      'SOCIAL_SOURCE_ID_BILIBILI', 'SOCIAL_SOURCE_ID_XIAOHONGSHU', 'SOCIAL_SOURCE_ID_DOUYIN',
      'SOCIAL_MAX_LINKS_PER_MESSAGE', 'SOCIAL_MAX_CONCURRENT_PER_SCOPE',
      'SOCIAL_RESOLVE_DEADLINE_MS', 'SOCIAL_PER_REQUEST_TIMEOUT_MS', 'SOCIAL_MAX_REDIRECTS',
      'SOCIAL_CONTENT_CACHE_ALLOWED', 'TRANSCRIPTION_ENABLED', 'EXPERIMENTAL_XHS_COMMENTS',
      'REDNOTE_INDEPENDENT_SESSION',
    ],
    db: {
      bindKey: 'SOCIAL_CONTENT_DB',
      pathEnv: 'SOCIAL_CONTENT_DB_PATH',
      defaultPath: path.join(dataDir, 'social-content.sqlite'),
      schemaPath: path.join(repoRoot, 'worker/social-content/schema.sql'),
      enableIf: () => true,
    },
    crons: [],
  },
  {
    name: 'amsg',
    port: 8832,
    enabled: true, // ★ Step 2：已移植（DB 经 better-sqlite3 D1 适配器绑定，cron 每分钟 due-check）
    bundle: path.join(repoRoot, 'worker/amsg/worker.bundle.js'),
    envKeys: ['AMSG_SECRET_KEY', 'AMSG_DB_PATH', 'AMSG_CLIENT_TOKEN'],
    db: {
      bindKey: 'DB',
      pathEnv: 'AMSG_DB_PATH',
      defaultPath: path.join(dataDir, 'amsg.sqlite'),
      enableIf: () => true,
    },
    crons: [{ expr: '* * * * *', name: 'amsg-due-check' }],
  },
  {
    name: 'proactive-push',
    port: 8833,
    enabled: true, // ★ Step 2：已移植（DB 绑定 + cron 每 5 分钟 proactive-sweep）
    bundle: path.join(repoRoot, 'worker/proactive-push/worker.bundle.js'),
    envKeys: ['AMSG_CLIENT_TOKEN', 'CLIENT_TOKEN', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_EMAIL', 'VAPID_SUBJECT', 'HEARTBEAT_WINDOW_MS'],
    db: {
      bindKey: 'DB',
      pathEnv: 'PROACTIVE_DB_PATH',
      defaultPath: path.join(dataDir, 'proactive-push.sqlite'),
      schemaPath: path.join(repoRoot, 'worker/proactive-push/schema.sql'),
      enableIf: () => true,
    },
    crons: [{ expr: '*/5 * * * *', name: 'proactive-sweep' }],
  },
  {
    name: 'wake-bridge',
    port: 8834,
    enabled: true, // ★ Step 3：唤醒桥（主代理 ↔ 推送链路转发，token 门 + 白名单 relay）
    bundle: path.join(repoRoot, 'worker/wake-bridge/worker.bundle.js'),
    envKeys: ['WAKE_BRIDGE_TOKEN', 'AMSG_CLIENT_TOKEN', 'INSTANT_PUSH_URL', 'PROACTIVE_PUSH_URL'],
    crons: [],
  },
  {
    name: 'heartbeat',
    port: 8835,
    enabled: true, // ★ Step 3：独立心跳收集器（报活/存活视图/死条目清理）
    bundle: path.join(repoRoot, 'worker/heartbeat/worker.bundle.js'),
    envKeys: ['AMSG_CLIENT_TOKEN', 'HEARTBEAT_INTERVAL_SEC', 'HEARTBEAT_WINDOW_MS'],
    db: {
      bindKey: 'DB',
      pathEnv: 'HEARTBEAT_DB_PATH',
      defaultPath: path.join(dataDir, 'heartbeat.sqlite'),
      schemaPath: path.join(repoRoot, 'worker/heartbeat/schema.sql'),
      enableIf: () => true,
    },
    crons: [{ expr: '*/1 * * * *', name: 'heartbeat-sweep' }],
  },
  {
    name: 'sullyos-home',
    port: 8837,
    enabled: true,
    bundle: path.join(repoRoot, 'worker/sullyos-home/worker.bundle.js'),
    envKeys: ['AMSG_CLIENT_TOKEN', 'HOME_DB_PATH'],
    db: {
      bindKey: 'DB',
      pathEnv: 'HOME_DB_PATH',
      defaultPath: path.join(dataDir, 'sullyos-home.sqlite'),
      schemaPath: path.join(repoRoot, 'worker/sullyos-home/schema.sql'),
      enableIf: () => true,
    },
    crons: [],
  },
  {
    name: 'sullyos-google',
    port: 8841,
    enabled: false, // Google 日历桥：独立 node 进程（vps-backend/src/google/run.js），暂不进 run-all
    envKeys: [
      'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI',
      'GOOGLE_SESSION_KEY', 'GOOGLE_SESSION_FILE',
      'GOOGLE_BRIDGE_TOKEN', 'GOOGLE_BRIDGE_PORT',
    ],
    crons: [],
  },
];

/** @param {string} name */
export function getService(name) {
  const svc = services.find((s) => s.name === name);
  if (!svc) throw new Error(`未知服务: ${name}（可选: ${services.map((s) => s.name).join(', ')}）`);
  return svc;
}
