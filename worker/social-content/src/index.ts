/**
 * social-content Worker 入口（集成卡 t_babca897）。
 *
 * 部署形态：独立 Worker（127.0.0.1:8842），由 vps-backend 的 sullyos-service.js 托管；
 * main-agent 在 `/v1/social/*` 上做**鉴权后的反代**（外部仍走 /agent/v1/social/*），
 * 因此本服务不需要公网入口，也不实现自己的账号体系。
 *
 * 路由（契约 4）：
 *   GET  /health
 *   POST /v1/social/shares/resolve
 *   GET  /v1/social/shares?conversationId=&messageId=
 *   GET  /v1/social/shares/:shareRef
 *   POST /v1/social/shares/:shareRef/retry
 *   GET  /v1/social/items/:contentId
 *   POST /v1/social/items/:contentId/excerpts
 *
 * 安全：
 *  - 缺 SOCIAL_SERVICE_TOKEN 且未显式允许匿名 → fail-closed 403；
 *  - scope 只来自服务端配置（SOCIAL_DEPLOYMENT_SCOPE），绝不读 body/query；
 *  - 请求体上限 256KiB，超限 413；错误一律如实返回，不伪装成功。
 */

import { createSocialRuntime, type RuntimeEnv } from './runtime';
import { publicConfigSummary } from './config';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Content-Type, Authorization, X-Client-Token, X-Social-Service-Token',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'cache-control': 'no-store',
};

const MAX_BODY_BYTES = 256 * 1024;

/**
 * 每个 isolate 只做一次启动恢复（幂等，但没必要每个请求都扫一遍表）。
 * 失败不缓存：下次请求重试，避免一张表缺失把恢复永久关死。
 */
let recoveredOnce: Promise<unknown> | null = null;
function recoverOnce(runtime: { recover: () => Promise<number> }): Promise<unknown> {
  if (!recoveredOnce) {
    recoveredOnce = runtime.recover().catch((err) => {
      recoveredOnce = null;
      throw err;
    });
  }
  return recoveredOnce;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: JSON_HEADERS });
}

function authorized(req: Request, env: RuntimeEnv): boolean {
  const expected = String(env.SOCIAL_SERVICE_TOKEN ?? '').trim();
  const allowAnon = ['1', 'true', 'yes', 'on'].includes(
    String(env.SOCIAL_SERVICE_ALLOW_ANONYMOUS ?? '').trim().toLowerCase(),
  );
  if (!expected) return allowAnon;
  const header = req.headers.get('x-social-service-token') || '';
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const client = req.headers.get('x-client-token') || '';
  return header === expected || bearer === expected || client === expected;
}

async function readJsonBody(req: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) return { ok: false, status: 413, error: 'body_too_large' };
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return { ok: false, status: 413, error: 'body_too_large' };
  if (!raw.trim()) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, status: 422, error: 'body_not_object' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' };
  }
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const url = new URL(request.url);
    const plain = url.pathname.replace(/^\/agent(?=\/|$)/, '') || '/';

    if (request.method === 'OPTIONS') return corsPreflight();

    const runtime = createSocialRuntime(env);
    const cfg = runtime.config;

    if (plain === '/health' || plain === '/') {
      // 不泄露 token/来源 id；只回能力与开关
      return json({
        ok: true,
        service: 'social-content',
        version: '1.0.0',
        persistence: runtime.persistence,
        feature: publicConfigSummary(cfg),
        transport: 'node_pinned',
        time: new Date().toISOString(),
      });
    }

    if (!authorized(request, env)) {
      return json({ error: 'unauthorized', hint: 'X-Social-Service-Token required' }, 403);
    }

    // 启动恢复（惰性、幂等）：把上次进程留下的 resolving/queued 明确标 failed
    try {
      await recoverOnce(runtime);
    } catch {
      // 没绑 DB 或表缺失时 recover 失败不应挡住只读接口；持久化缺失会在各接口里如实返回 503
    }

    const scope = cfg.deploymentScope;
    const parts = plain.split('/').filter(Boolean); // ['v1','social',...]
    if (parts[0] !== 'v1' || parts[1] !== 'social') {
      return json({ error: 'not_found', path: plain }, 404);
    }
    const rest = parts.slice(2);

    // POST /v1/social/shares/resolve
    if (rest[0] === 'shares' && rest[1] === 'resolve' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body.ok) return json({ error: body.error }, body.status);
      const result = await runtime.service.resolve(scope, body.value);
      return json(result.body, result.status);
    }

    // GET /v1/social/shares?conversationId=&messageId=
    if (rest.length === 1 && rest[0] === 'shares' && request.method === 'GET') {
      const result = await runtime.service.list(
        scope,
        url.searchParams.get('conversationId') || '',
        url.searchParams.get('messageId') || '',
      );
      return json(result.body, result.status);
    }

    // POST /v1/social/shares/:shareRef/retry
    if (rest[0] === 'shares' && rest[1] && rest[2] === 'retry' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body.ok) return json({ error: body.error }, body.status);
      const result = await runtime.service.retry(scope, rest[1], body.value);
      return json(result.body, result.status);
    }

    // GET /v1/social/shares/:shareRef
    if (rest[0] === 'shares' && rest[1] && rest.length === 2 && request.method === 'GET') {
      const result = await runtime.service.get(scope, rest[1]);
      return json(result.body, result.status);
    }

    // POST /v1/social/items/:contentId/excerpts
    if (rest[0] === 'items' && rest[1] && rest[2] === 'excerpts' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body.ok) return json({ error: body.error }, body.status);
      const result = await runtime.service.excerpts(scope, decodeURIComponent(rest[1]), body.value);
      return json(result.body, result.status);
    }

    // GET /v1/social/items/:contentId
    if (rest[0] === 'items' && rest[1] && rest.length === 2 && request.method === 'GET') {
      const result = await runtime.service.item(scope, decodeURIComponent(rest[1]));
      return json(result.body, result.status);
    }

    return json({ error: 'not_found', path: plain, method: request.method }, 404);
  },
};
