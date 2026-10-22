/**
 * SullyOS main-agent — 本地 EmbeddingGemma2 路由（独立 handler，挂载由集成代理完成）
 *
 * 为什么单独一层，而不是让浏览器直连 127.0.0.1:8850：
 *   - 服务只 publish 到回环，且要 EMB_API_KEY；浏览器既不该持这把 key，也不该被
 *     https 页面的混合内容规则挡住。
 *   - 复用主代理既有鉴权（X-Client-Token / Bearer = AMSG_CLIENT_TOKEN，fail-closed），
 *     不新增匿名公网端点。
 *
 * 挂载契约（给集成代理，**本文件不改 index.js**）：
 *
 *   import { handleLocalEmbedding } from './local-embedding-route.js';
 *   // 放在 `const authFail = checkAuth(request, env); if (authFail) return authFail;` 之后：
 *   if (plain === '/v1/local-embedding'
 *       || plain === '/v1/local-embedding/embeddings'
 *       || plain === '/v1/local-embedding/health') {
 *     return handleLocalEmbedding(request, env, { authorize: (req) => checkAuth(req, env) });
 *   }
 *
 * 其中 `plain` 是 index.js 里已经剥掉 `/agent` 前缀的路径。传入 authorize 是为了让鉴权
 * 只有一份实现（不传时本模块会按同样的 env 语义自行校验，缺 token 即 403）。
 *
 * 需要的 env：
 *   LOCAL_EMBEDDING_API_KEY   本地服务 key（必填；只存在服务端，绝不回传浏览器）
 *   LOCAL_EMBEDDING_URL       默认 http://127.0.0.1:8850
 *   LOCAL_EMBEDDING_MODEL     默认 google/embeddinggemma-2（白名单，防跨模型写索引）
 *   LOCAL_EMBEDDING_TIMEOUT_MS      默认 30000（夹 1000..120000）
 *   LOCAL_EMBEDDING_MAX_BATCH       默认 10（夹 1..32）
 *   LOCAL_EMBEDDING_MAX_ITEM_CHARS  默认 4000
 *   LOCAL_EMBEDDING_MAX_BODY_BYTES  默认 262144
 *   LOCAL_EMBEDDING_MAX_QUEUE       默认 8（排队上限，超出 429）
 *   LOCAL_EMBEDDING_MAX_CONCURRENCY 默认 1（上游是 Semaphore(1)，多开会只是排队）
 */

'use strict';

const DIMENSIONS = 768;
const PREFIX_SCHEME = 'eg2-retrieval-v1';
const REVISION = '914f7f89';
const DEFAULT_MODEL = 'google/embeddinggemma-2';
const DEFAULT_URL = 'http://127.0.0.1:8850';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Content-Type, Authorization, X-Client-Token, Accept',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

const PREFIX_TOKENS = [
  'task: search result | query: ',
  'title: none | text: ',
  'task: search result | query:',
  'title: none | text:',
];

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function stripTaskPrefixes(text) {
  let out = String(text == null ? '' : text).trim();
  for (let guard = 0; guard < 4; guard++) {
    const lower = out.toLowerCase();
    const hit = PREFIX_TOKENS.find((token) => lower.startsWith(token.toLowerCase()));
    if (!hit) break;
    out = out.slice(hit.length).trim();
  }
  return out;
}

function num(raw, fallback, min, max) {
  const n = parseInt(String(raw == null ? '' : raw), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function fingerprintOf(model) {
  return [
    'provider:local-gemma',
    `model:${model}`,
    `rev:${REVISION}`,
    `dim:${DIMENSIONS}`,
    `prefix:${PREFIX_SCHEME}`,
    'norm:l2',
  ].join('|');
}

/** 默认鉴权：与 main-agent 的 checkAuth 同语义（缺 token ⇒ fail-closed 403）。 */
function defaultAuthorize(request, env) {
  const expected = String((env && env.AMSG_CLIENT_TOKEN) || '').trim();
  const header = request.headers.get('x-client-token') || '';
  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!expected) {
    if (String((env && env.MAIN_AGENT_ALLOW_ANONYMOUS) || '').trim().toLowerCase() === 'true') return null;
    return json({ error: 'unauthorized', hint: 'AMSG_CLIENT_TOKEN not configured (fail-closed)' }, 403);
  }
  if (header === expected || bearer === expected) return null;
  return json({ error: 'unauthorized', hint: 'X-Client-Token required' }, 403);
}

/**
 * 并发闸门：上游 uvicorn 是 Semaphore(1)。这里显式排队 + 上限，
 * 避免几百条重建把主代理内存堆满，也避免用户看到「全都超时」。
 */
function createGate(maxConcurrency, maxQueue) {
  let active = 0;
  const waiting = [];
  return {
    async acquire(signal) {
      if (signal && signal.aborted) {
        const err = new Error('cancelled');
        err.code = 'cancelled';
        throw err;
      }
      if (active < maxConcurrency) { active++; return; }
      if (waiting.length >= maxQueue) {
        const err = new Error('queue_full');
        err.code = 'queue_full';
        throw err;
      }
      await new Promise((resolve, reject) => {
        const entry = { resolve, reject, signal };
        if (signal) {
          entry.onAbort = () => {
            const idx = waiting.indexOf(entry);
            if (idx >= 0) waiting.splice(idx, 1);
            const err = new Error('cancelled');
            err.code = 'cancelled';
            reject(err);
          };
          signal.addEventListener('abort', entry.onAbort, { once: true });
        }
        waiting.push(entry);
      });
    },
    release() {
      const next = waiting.shift();
      if (!next) { active = Math.max(0, active - 1); return; }
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
      next.resolve();
    },
  };
}

function readConfig(env) {
  return {
    upstream: String((env && env.LOCAL_EMBEDDING_URL) || DEFAULT_URL).replace(/\/+$/, ''),
    apiKey: String((env && env.LOCAL_EMBEDDING_API_KEY) || ''),
    model: String((env && env.LOCAL_EMBEDDING_MODEL) || DEFAULT_MODEL),
    timeoutMs: num(env && env.LOCAL_EMBEDDING_TIMEOUT_MS, 30000, 1000, 120000),
    maxBatch: num(env && env.LOCAL_EMBEDDING_MAX_BATCH, 10, 1, 32),
    maxItemChars: num(env && env.LOCAL_EMBEDDING_MAX_ITEM_CHARS, 4000, 64, 32000),
    maxBodyBytes: num(env && env.LOCAL_EMBEDDING_MAX_BODY_BYTES, 262144, 1024, 4 * 1024 * 1024),
    maxQueue: num(env && env.LOCAL_EMBEDDING_MAX_QUEUE, 8, 0, 128),
    maxConcurrency: num(env && env.LOCAL_EMBEDDING_MAX_CONCURRENCY, 1, 1, 4),
  };
}

function normalizePath(pathname) {
  return String(pathname || '').replace(/^\/agent(?=\/|$)/, '') || '/';
}

export function createLocalEmbeddingHandler(options = {}) {
  const overrides = options;
  let gateCache = null;
  let gateKey = '';

  function gateFor(cfg) {
    const key = `${cfg.maxConcurrency}:${cfg.maxQueue}`;
    if (!gateCache || gateKey !== key) {
      gateCache = createGate(cfg.maxConcurrency, cfg.maxQueue);
      gateKey = key;
    }
    return gateCache;
  }

  return async function handle(request, env) {
    const cfg = { ...readConfig(env), ...pickLimits(overrides) };
    const url = new URL(request.url);
    const plain = normalizePath(url.pathname);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS_HEADERS, 'access-control-max-age': '86400' } });
    }

    const isHealth = plain === '/v1/local-embedding/health';
    const isEmbed = plain === '/v1/local-embedding' || plain === '/v1/local-embedding/embeddings';
    if (!isHealth && !isEmbed) return json({ error: 'not_found', path: url.pathname }, 404);

    const authorize = options.authorize || defaultAuthorize;
    const authFail = authorize(request, env);
    if (authFail) return authFail;

    if (isHealth) {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      // 轻量：不访问上游、不触发推理。真正的推理能力由 POST 证明。
      // 安全：只回身份/形状字段，**不回** upstream 内网地址（旧版回显过
      // `127.0.0.1:8850`，等于把内网拓扑交给任何过鉴权的客户端）。
      return json({
        ok: true,
        service: 'local-embedding',
        model: cfg.model,
        dimensions: DIMENSIONS,
        fingerprint: fingerprintOf(cfg.model),
        configured: !!cfg.apiKey,
        tasks: ['query', 'document'],
      });
    }

    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    if (!cfg.apiKey) {
      return json({
        error: 'local_embedding_unconfigured',
        message: '主代理未配置 LOCAL_EMBEDDING_API_KEY，本地 embedding 不可用（记忆宫殿会退回词法检索）',
      }, 503);
    }

    // ─── body 读取与体积上限 ───────────────────────────
    const declared = parseInt(request.headers.get('content-length') || '0', 10);
    if (Number.isFinite(declared) && declared > cfg.maxBodyBytes) {
      return json({ error: 'payload_too_large', limit: cfg.maxBodyBytes }, 413);
    }
    let raw;
    try {
      raw = await request.text();
    } catch {
      return json({ error: 'invalid_json', message: '请求体读取失败' }, 400);
    }
    if (new TextEncoder().encode(raw).length > cfg.maxBodyBytes) {
      return json({ error: 'payload_too_large', limit: cfg.maxBodyBytes }, 413);
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'invalid_json', message: '请求体不是合法 JSON' }, 400);
    }
    if (!body || typeof body !== 'object') {
      return json({ error: 'invalid_json', message: '请求体必须是对象' }, 400);
    }

    // ─── 参数校验 ─────────────────────────────────────
    if (body.dimensions !== undefined && body.dimensions !== null) {
      return json({
        error: 'dimensions_not_supported',
        message: '本地 EmbeddingGemma2 固定输出 768 维（MRL 由客户端切片并重新归一，服务端不接受 dimensions）',
      }, 400);
    }
    if (body.task !== undefined && body.task !== null && body.task !== 'query' && body.task !== 'document') {
      return json({ error: 'invalid_task', allowed: ['query', 'document'] }, 400);
    }
    if (body.model !== undefined && body.model !== null && body.model !== '') {
      if (String(body.model).trim().toLowerCase() !== cfg.model.toLowerCase()) {
        return json({ error: 'model_not_allowed', expected: cfg.model }, 400);
      }
    }

    const rawInput = body.input;
    const list = Array.isArray(rawInput) ? rawInput : (typeof rawInput === 'string' ? [rawInput] : null);
    if (!list || list.length === 0) {
      return json({ error: 'invalid_input', message: 'input 必须是非空字符串或字符串数组' }, 400);
    }
    if (list.some((item) => typeof item !== 'string')) {
      return json({ error: 'invalid_input', message: 'input 只能是字符串' }, 400);
    }
    if (list.length > cfg.maxBatch) {
      return json({ error: 'payload_too_large', message: `单次最多 ${cfg.maxBatch} 条`, limit: cfg.maxBatch }, 413);
    }
    if (list.some((item) => item.length > cfg.maxItemChars)) {
      return json({ error: 'payload_too_large', message: `单条最多 ${cfg.maxItemChars} 字符`, limit: cfg.maxItemChars }, 413);
    }

    // 前缀只由服务端按 task 加一次：把客户端带进来的前缀剥掉（防御双前缀）
    const input = list.map(stripTaskPrefixes);
    const task = body.task === 'query' ? 'query' : 'document';

    // ─── 排队 + 上游调用 ──────────────────────────────
    const gate = gateFor(cfg);
    try {
      await gate.acquire(request.signal);
    } catch (err) {
      if (err && err.code === 'queue_full') {
        return json({ error: 'queue_full', message: '本地 embedding 队列已满，请稍后重试' }, 429);
      }
      return json({ error: 'client_cancelled' }, 499);
    }

    const controller = new AbortController();
    let timedOut = false;
    const onClientAbort = () => controller.abort();
    if (request.signal) request.signal.addEventListener('abort', onClientAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, cfg.timeoutMs);

    try {
      const fetchImpl = options.fetchImpl || fetch;
      const upstreamRes = await fetchImpl(`${cfg.upstream}/v1/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          input,
          encoding_format: 'float',
          task,
        }),
        signal: controller.signal,
      });

      if (!upstreamRes.ok) {
        // 不回显上游 body：里面可能带内部地址或凭据片段
        const code = upstreamRes.status === 401 || upstreamRes.status === 403 ? 'upstream_auth_failed' : 'upstream_error';
        return json({ error: code, upstreamStatus: upstreamRes.status }, 502);
      }

      let data = null;
      try {
        data = await upstreamRes.json();
      } catch {
        return json({ error: 'upstream_bad_response', message: '上游返回不是合法 JSON' }, 502);
      }

      const items = data && Array.isArray(data.data) ? data.data : null;
      if (!items || items.length !== input.length) {
        return json({ error: 'upstream_bad_response', message: '上游返回条数与请求不一致' }, 502);
      }
      const sorted = [...items].sort((a, b) => (a && a.index ? a.index : 0) - (b && b.index ? b.index : 0));
      for (const item of sorted) {
        if (!item || !Array.isArray(item.embedding) || item.embedding.length !== DIMENSIONS) {
          return json({ error: 'upstream_bad_response', message: `上游向量维度不是 ${DIMENSIONS}` }, 502);
        }
      }

      return json({
        object: 'list',
        model: cfg.model,
        dimensions: DIMENSIONS,
        fingerprint: fingerprintOf(cfg.model),
        task,
        data: sorted.map((item, i) => ({ object: 'embedding', index: i, embedding: item.embedding })),
      });
    } catch (err) {
      const aborted = (err && err.name === 'AbortError') || controller.signal.aborted;
      if (aborted) {
        if (timedOut) return json({ error: 'upstream_timeout', timeoutMs: cfg.timeoutMs }, 504);
        return json({ error: 'client_cancelled' }, 499);
      }
      return json({
        error: 'upstream_unavailable',
        message: '本地 embedding 服务不可达（记忆宫殿会退回词法检索）',
      }, 503);
    } finally {
      clearTimeout(timer);
      if (request.signal) request.signal.removeEventListener('abort', onClientAbort);
      gate.release();
    }
  };
}

function pickLimits(overrides) {
  const out = {};
  if (overrides.maxBatch) out.maxBatch = overrides.maxBatch;
  if (overrides.maxItemChars) out.maxItemChars = overrides.maxItemChars;
  if (overrides.maxBodyBytes) out.maxBodyBytes = overrides.maxBodyBytes;
  if (overrides.maxQueue !== undefined) out.maxQueue = overrides.maxQueue;
  if (overrides.maxConcurrency) out.maxConcurrency = overrides.maxConcurrency;
  if (overrides.timeoutMs !== undefined) out.timeoutMs = overrides.timeoutMs;
  return out;
}

/** 默认单例（共享一个排队器）。index.js 挂载时直接用这个。 */
export const handleLocalEmbedding = createLocalEmbeddingHandler();
