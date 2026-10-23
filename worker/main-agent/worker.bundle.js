// [build-workers] 内联自 src/local-embedding-route.js —— VPS 用 data: URL 加载，
// 相对 import 无 base 可解析，所以路由必须与入口同一个文件。改路由请改 src/ 那份。
const { handleLocalEmbedding } = (() => {
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

function createLocalEmbeddingHandler(options = {}) {
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
const handleLocalEmbedding = createLocalEmbeddingHandler();
  return { handleLocalEmbedding };
})();

/**
 * SullyOS main-agent — VPS 单文件 Worker bundle（手写，不经 esbuild）。
 *
 * 部署：cp src/index.js worker.bundle.js（bundle 为宿主加载的产物）。
 * 宿主：vps-backend/bin/sullyos-service.js（Node 22，全量 env 直通 + SSE 流式回写）。
 *
 * 职责：
 *   1. POST /v1/chat/completions —— OpenAI 兼容 SSE 聊天端点（stream 默认 true）；
 *      内部执行 MCP 工具循环：LLM tool_calls → MCP tools/call → 结果回填，
 *      直到无工具调用或达到 MCP_MAX_LOOPS（默认 12）。
 *   2. 多供应商 fallback：LLM_BASE_URL 主供应商 + LLM_FALLBACKS JSON 数组，按序切换。
 *   3. 参考类工具钉住：MCP_PINNED_TOOLS（逗号分隔工具名）从第 2 轮起始终携带，
 *      其余工具仅首轮下发（省上下文）。
 *   4. GET /v1/tools —— 汇总全部 MCP 工具清单。
 *   5. /webdav/* —— dufs（本机 WebDAV）认证注入中转，供代理调用备份文件。
 *   6. 严格鉴权：X-Client-Token（或 Authorization: Bearer）== AMSG_CLIENT_TOKEN。
 */
'use strict';


const DONE_MARKER = '[DONE]';

// CORS 契约（见 docs/superpowers/specs/2026-09-11-cors-unification-design.md）：
// 预检净化回显浏览器声明的请求头/方法，新头零配置放行；单文件内联以保持可整份复制部署。
const CORS_BASE_HEADERS = 'Content-Type, Authorization, X-Client-Token, Accept';
const CORS_BASE_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS, PROPFIND, MKCOL';

// ─────────────────────── 基础工具 ───────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': CORS_BASE_HEADERS,
      'access-control-allow-methods': CORS_BASE_METHODS,
    },
  });
}

function sanitizeRequestedHeaders(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)
    .slice(0, 16)
    .filter((s) => s.length <= 64 && /^[A-Za-z0-9-]+$/.test(s));
}

function corsPreflight(request) {
  const picked = sanitizeRequestedHeaders(request && request.headers ? request.headers.get('access-control-request-headers') : '');
  const method = String((request && request.headers ? request.headers.get('access-control-request-method') : '') || '').trim();
  const allowMethods = Array.from(new Set([...CORS_BASE_METHODS.split(',').map((s) => s.trim()), ...(method.length <= 16 && /^[A-Z]+$/.test(method) ? [method] : [])]));
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': [CORS_BASE_HEADERS, ...picked].join(', '),
      'access-control-allow-methods': allowMethods.join(', '),
      'access-control-max-age': '86400',
    },
  });
}

function checkAuth(req, env) {
  const expected = (env.AMSG_CLIENT_TOKEN || '').trim();
  const header = req.headers.get('x-client-token') || '';
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!expected) {
    // 未配置令牌 = fail-closed（生产默认拒绝）：漏配 env 时不能变成公开代理。
    // 只有显式开发开关才允许匿名——本地调试设 MAIN_AGENT_ALLOW_ANONYMOUS=true。
    if (String(env.MAIN_AGENT_ALLOW_ANONYMOUS || '').trim().toLowerCase() === 'true') return null;
    return json({
      error: 'unauthorized',
      hint: 'AMSG_CLIENT_TOKEN not configured (fail-closed); set MAIN_AGENT_ALLOW_ANONYMOUS=true only for local dev',
    }, 403);
  }
  if (header === expected || bearer === expected) return null;
  return json({ error: 'unauthorized', hint: 'X-Client-Token required' }, 403);
}

function getJsonEnv(env, key, fallback) {
  const raw = (env?.[key] || '').trim();
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

// ─────────────────────── LLM 供应商 ───────────────────────
/**
 * 供应商解析（三级来源，优先级从高到低）：
 *   1. 请求级 llmOverride —— 前端「API 预设」随请求直传（baseUrl/apiKey/model/fallbacks），
 *      后端零落盘、换预设即时生效；
 *   2. env：LLM_BASE_URL + LLM_MODEL + LLM_FALLBACKS（兜底）。
 */
function providersOf(env, llmOverride) {
  const out = [];
  if (llmOverride && llmOverride.baseUrl && llmOverride.model) {
    out.push({
      baseUrl: String(llmOverride.baseUrl).trim(),
      apiKey: String(llmOverride.apiKey || '').trim(),
      model: String(llmOverride.model).trim(),
    });
    if (Array.isArray(llmOverride.fallbacks)) {
      for (const f of llmOverride.fallbacks) {
        if (f && f.baseUrl && f.model) {
          out.push({ baseUrl: String(f.baseUrl), apiKey: String(f.apiKey || ''), model: String(f.model) });
        }
      }
    }
  }
  if (out.length === 0) {
    const primary = {
      baseUrl: (env.LLM_BASE_URL || '').trim(),
      apiKey: (env.LLM_API_KEY || '').trim(),
      model: (env.LLM_MODEL || '').trim(),
    };
    if (primary.baseUrl && primary.model) out.push(primary);
    const fbs = getJsonEnv(env, 'LLM_FALLBACKS', []);
    if (Array.isArray(fbs)) {
      for (const f of fbs) {
        if (f && f.baseUrl && f.model) {
          out.push({ baseUrl: String(f.baseUrl), apiKey: String(f.apiKey || ''), model: String(f.model) });
        }
      }
    }
  }
  return out;
}

// ─────────────────────── usage 保真（allowlist）───────────────────────
// 契约与 utils/llmUsage.ts 完全一致。main-agent 是 verbatim 单文件（宿主直接加载
// worker.bundle.js，不能 import），所以这里是内联副本；两边一致性由
// worker/main-agent/src/usage.test.ts 的契约测试守着（同一批 fixture 逐字段比对）。
//
// 三条硬规则：
//   1. 只认语义明确的数值字段；未知供应商字段不进日志（不长期落库上游原对象）；
//   2. 缺失不等于 0：没有到的字段键就不存在，绝不填 0 冒充"确实零消耗"；
//   3. 缓存读的语义分开记：cached_tokens 是 prompt 子集（可算比例），
//      cache_read_input_tokens 不含在 input_tokens 里（不能算比例）。
const USAGE_FIELDS = [
  'promptTokens', 'completionTokens', 'totalTokens',
  'cachedTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
];

function usageNumber(value) {
  return (typeof value === 'number' && Number.isFinite(value) && value >= 0) ? value : undefined;
}

function usageReadPath(source, path) {
  let cur = source;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function usagePick(source, paths) {
  for (const p of paths) {
    const value = usageNumber(usageReadPath(source, p));
    if (value !== undefined) return { value, source: p.join('.') };
  }
  return {};
}

function normalizeUsageEnvelope(raw) {
  const usagePresent = !!raw && typeof raw === 'object' && !Array.isArray(raw);
  const values = {};
  const fieldSources = {};
  let cacheReadSource = '';
  const take = (field, hit) => {
    if (hit.value === undefined) return;
    values[field] = hit.value;
    fieldSources[field] = hit.source || '';
  };
  if (usagePresent) {
    take('promptTokens', usagePick(raw, [['prompt_tokens'], ['input_tokens'], ['promptTokenCount']]));
    take('completionTokens', usagePick(raw, [['completion_tokens'], ['output_tokens'], ['candidatesTokenCount']]));
    take('totalTokens', usagePick(raw, [['total_tokens'], ['totalTokenCount']]));
    take('cachedTokens', usagePick(raw, [
      ['prompt_tokens_details', 'cached_tokens'],
      ['input_tokens_details', 'cached_tokens'],
      ['prompt_cache_hit_tokens'],
      ['cachedContentTokenCount'],
    ]));
    const cacheRead = usagePick(raw, [['cache_read_input_tokens'], ['cache_read_tokens']]);
    take('cacheReadTokens', cacheRead);
    if (cacheRead.source) cacheReadSource = cacheRead.source;
    take('cacheWriteTokens', usagePick(raw, [
      ['cache_creation_input_tokens'], ['cache_creation_tokens'], ['cache_write_tokens'],
    ]));
    take('reasoningTokens', usagePick(raw, [
      ['completion_tokens_details', 'reasoning_tokens'],
      ['output_tokens_details', 'reasoning_tokens'],
      ['reasoning_tokens'],
    ]));
  }
  const reported = USAGE_FIELDS.filter((f) => values[f] !== undefined);
  const missing = USAGE_FIELDS.filter((f) => values[f] === undefined);
  const status = reported.length === 0
    ? 'not-reported'
    : (values.promptTokens !== undefined && values.completionTokens !== undefined ? 'reported' : 'partial');
  let cacheReadSemantics = 'unknown';
  if (values.cachedTokens !== undefined) cacheReadSemantics = 'subset-of-prompt';
  else if (cacheReadSource === 'cache_read_input_tokens') cacheReadSemantics = 'exclusive-of-prompt';
  const usage = { reported, partial: [], missing, status, usagePresent, cacheReadSemantics };
  for (const field of USAGE_FIELDS) {
    if (values[field] !== undefined) usage[field] = values[field];
  }
  if (Object.keys(fieldSources).length > 0) usage.fieldSources = fieldSources;
  return usage;
}

function sumUsageEnvelopes(parts) {
  const list = (Array.isArray(parts) ? parts : []).filter(Boolean);
  const values = {};
  const reported = [];
  const partial = [];
  const missing = [];
  for (const field of USAGE_FIELDS) {
    let sum = 0;
    let provided = 0;
    for (const part of list) {
      const value = part[field];
      if (typeof value === 'number' && Number.isFinite(value)) { sum += value; provided++; }
    }
    if (list.length > 0 && provided === list.length) { values[field] = sum; reported.push(field); }
    else if (provided > 0) partial.push(field);
    else missing.push(field);
  }
  const status = reported.length === 0
    ? 'not-reported'
    : (values.promptTokens !== undefined && values.completionTokens !== undefined ? 'reported' : 'partial');
  const semantics = new Set();
  for (const part of list) {
    if (part.cachedTokens !== undefined || part.cacheReadTokens !== undefined) semantics.add(part.cacheReadSemantics);
  }
  const usage = {
    reported, partial, missing, status,
    usagePresent: list.some((part) => part.usagePresent),
    cacheReadSemantics: semantics.size === 1 ? [...semantics][0] : 'unknown',
  };
  for (const field of USAGE_FIELDS) {
    if (values[field] !== undefined) usage[field] = values[field];
  }
  return usage;
}

function usageToOpenAi(usage) {
  if (!usage) return undefined;
  const out = {};
  if (usage.promptTokens !== undefined) out.prompt_tokens = usage.promptTokens;
  if (usage.completionTokens !== undefined) out.completion_tokens = usage.completionTokens;
  if (usage.totalTokens !== undefined) out.total_tokens = usage.totalTokens;
  if (usage.cachedTokens !== undefined) out.prompt_tokens_details = { cached_tokens: usage.cachedTokens };
  if (usage.cacheReadTokens !== undefined) out.cache_read_input_tokens = usage.cacheReadTokens;
  if (usage.cacheWriteTokens !== undefined) out.cache_creation_input_tokens = usage.cacheWriteTokens;
  if (usage.reasoningTokens !== undefined) out.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens };
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 脱敏身份：只留 hostname，不带路径、查询参数或凭据。 */
function providerIdOf(baseUrl) {
  try { return new URL(String(baseUrl)).hostname.toLowerCase(); } catch { return 'unknown'; }
}

/** 终止事件之后留给尾随 usage 的宽限（有界；0 = 不额外等）。 */
function usageTailMsOf(env) {
  const raw = parseInt((env && env.LLM_USAGE_TAIL_MS) || '', 10);
  if (!Number.isFinite(raw)) return 600;
  return Math.max(0, Math.min(raw, 5000));
}

// ─────────────────────── MCP 客户端（streamable HTTP）───────────────────────
function mcpServersOf(env) {
  const list = getJsonEnv(env, 'MCP_SERVERS', []);
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => s && s.url)
    .map((s) => ({
      name: s.name || (() => { try { return new URL(s.url).hostname; } catch { return s.url; } })(),
      url: s.url,
      token: s.token || '',
      sessionId: null,
      tools: null,
    }));
}

function parseMcpResponse(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch { /* fallthrough to SSE */ }
  }
  let last = null;
  for (const line of trimmed.split(/\r?\n/)) {
    const m = line.match(/^data:\s*(.*)$/);
    if (!m) continue;
    try {
      const parsed = JSON.parse(m[1]);
      if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) last = parsed;
    } catch { /* 跳过非 JSON data 行 */ }
  }
  return last;
}

async function mcpPost(server, method, params) {
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
  };
  if (server.token) headers['authorization'] = `Bearer ${server.token}`;
  if (server.sessionId) headers['mcp-session-id'] = server.sessionId;
  const res = await fetch(server.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random(),
      method,
      params,
    }),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) server.sessionId = sid;
  const text = await res.text();
  const parsed = parseMcpResponse(text);
  if (!res.ok) {
    // 会话被服务端回收 → 下次调用自动重新 initialize
    if (res.status === 404) server.sessionId = null;
    throw new Error(`MCP ${server.name} ${method} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (parsed && parsed.error) {
    if (String(parsed.error.message || '').toLowerCase().includes('session')) server.sessionId = null;
    throw new Error(`MCP ${server.name} ${method} → ${parsed.error.message || JSON.stringify(parsed.error)}`);
  }
  return parsed ? parsed.result : null;
}

async function ensureSession(server) {
  if (!server.sessionId) {
    await mcpPost(server, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'sullyos-main-agent', version: '1.0.0' },
    });
  }
}

async function serverTools(server) {
  if (server.tools) return server.tools;
  await ensureSession(server);
  const res = await mcpPost(server, 'tools/list', {});
  server.tools = Array.isArray(res && res.tools) ? res.tools : [];
  return server.tools;
}

async function callMcpTool(server, toolName, args) {
  await ensureSession(server);
  return mcpPost(server, 'tools/call', { name: toolName, arguments: args ?? {} });
}

// ─────────────────────── 内置工具 ───────────────────────
const BUILTIN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'time_now',
      description: '返回当前 UTC 时间与 Unix 毫秒时间戳（无需参数）。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

async function callBuiltin(name) {
  if (name === 'time_now') {
    return { utc: new Date().toISOString(), unixMs: Date.now() };
  }
  return { error: `unknown builtin tool: ${name}` };
}

// ─────────────────────── LLM 流式调用 ───────────────────────
// ── 上游 LLM 自标识（opencode Go 防滥用要求）──
// opencode 要求调用方：可识别的 User-Agent + x-opencode-session 头（提示词缓存亲和）。
// session 取进程级稳定 UUID：同一 VPS 的请求共享缓存上下文；非 opencode 上游一律不加。
let llmSessionId = null;
function llmIdentityHeaders(baseUrl) {
  let host = '';
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { return {}; }
  if (host !== 'opencode.ai' && !host.endsWith('.opencode.ai')) return {};
  if (!llmSessionId) {
    try {
      llmSessionId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    } catch { llmSessionId = `fallback-${Date.now().toString(36)}`; }
  }
  return {
    'user-agent': 'SullyOS-MainAgent/1.0 (+https://github.com/plasma953/SullyOS)',
    'x-opencode-session': llmSessionId,
  };
}
async function llmStream(provider, messages, tools, timeoutMs, emitText, env) {
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 120000);
  const startedAt = Date.now();
  const headers = {
    'content-type': 'application/json',
    ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
    accept: 'text/event-stream',
    ...llmIdentityHeaders(provider.baseUrl),
  };
  const requestBody = (withUsage) => JSON.stringify({
    model: provider.model,
    messages,
    tools: tools && tools.length ? tools : undefined,
    stream: true,
    ...(withUsage ? { stream_options: { include_usage: true } } : {}),
  });
  const post = (withUsage) => fetch(url, {
    method: 'POST',
    headers,
    body: requestBody(withUsage),
    signal: controller.signal,
  });

  // 能力声明：默认请求 include_usage（要给用户看真实缓存数）；LLM_INCLUDE_USAGE=0 才关。
  let includeUsage = provider.includeUsage !== false && String((env && env.LLM_INCLUDE_USAGE) || '') !== '0';
  let res;
  try {
    res = await post(includeUsage);
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`LLM 连接失败 (${provider.baseUrl}): ${err.message}`);
  }
  let errorText = '';
  if (includeUsage && res.status === 400) {
    // 只有上游**明确**拒收 stream_options（400 且正文点名它）才降级重发：那一次请求在上游
    // 就被拒了，没有生成、没有计费，换掉参数再发不属于"重复计费的重试"。5xx / 超时 /
    // 连接中断一律不在这里重发——那可能已经生成过，交给上层 fallback 策略决定。
    errorText = await res.text().catch(() => '');
    if (/stream_options|include_usage/i.test(errorText)) {
      includeUsage = false;
      provider.includeUsage = false; // 同一供应商后续 loop 不再试
      errorText = '';
      try {
        res = await post(false);
      } catch (err) {
        clearTimeout(timer);
        throw new Error(`LLM 连接失败 (${provider.baseUrl}): ${err.message}`);
      }
    }
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    const body = errorText || await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status} (${provider.baseUrl}): ${body.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const acc = {
    text: '', toolCalls: [], finishReason: null,
    usageRaw: null, usageExit: 'none', model: '',
    ttftMs: null, totalMs: 0, includeUsage,
  };
  const tcMap = new Map();
  const tailMs = usageTailMsOf(env);
  let sawTerminal = false;
  let tailDeadline = 0;
  const armTail = () => { if (!tailDeadline && tailMs > 0) tailDeadline = Date.now() + tailMs; };
  try {
    while (true) {
      let step;
      if (tailDeadline) {
        // 尾捕阶段：每次读都带剩余预算，绝不为等 usage 把连接无限挂着。
        const remaining = tailDeadline - Date.now();
        if (remaining <= 0) { acc.usageExit = 'timeout'; break; }
        let tailTimer = null;
        step = await Promise.race([
          reader.read(),
          new Promise((resolve) => { tailTimer = setTimeout(() => resolve({ __tailTimeout: true }), remaining); }),
        ]);
        if (tailTimer) clearTimeout(tailTimer);
        if (step && step.__tailTimeout) { acc.usageExit = 'timeout'; break; }
      } else {
        step = await reader.read();
      }
      if (step.done) break;
      buf += decoder.decode(step.value, { stream: true });
      let idx;
      let tailReady = false;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        // 终止事件不再是"立刻收口"：正文已经流完了，这里只决定还要不要等尾随 usage。
        if (data === DONE_MARKER) {
          acc.finishReason = acc.finishReason || 'stop';
          sawTerminal = true;
          if (acc.usageRaw) { acc.usageExit = 'in-chunk'; tailReady = true; break; }
          if (tailMs <= 0) { acc.usageExit = 'timeout'; tailReady = true; break; }
          armTail();
          continue; // 有代理把 usage 排在 [DONE] 之后
        }
        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }
        // usage / 自报 model 与 choices 无关：finish 之后那条 choices:[] 的尾块也走这里。
        if (chunk && chunk.usage && typeof chunk.usage === 'object') {
          acc.usageRaw = chunk.usage;
          if (sawTerminal) { acc.usageExit = 'tail'; tailReady = true; break; }
          acc.usageExit = 'in-chunk';
        }
        if (!acc.model && typeof chunk.model === 'string' && chunk.model) acc.model = chunk.model;
        const choice = chunk && chunk.choices && chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (typeof delta.content === 'string' && delta.content) {
          if (acc.ttftMs === null) acc.ttftMs = Date.now() - startedAt;
          acc.text += delta.content;
          if (emitText) emitText(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            const slot = tcMap.get(i) || { id: '', name: '', arguments: '' };
            if (tc.id) slot.id = tc.id;
            if (tc.function && tc.function.name) slot.name += tc.function.name;
            if (tc.function && tc.function.arguments) slot.arguments += tc.function.arguments;
            tcMap.set(i, slot);
          }
        }
        if (choice.finish_reason) {
          acc.finishReason = choice.finish_reason;
          sawTerminal = true;
          if (acc.usageRaw) { acc.usageExit = 'in-chunk'; tailReady = true; break; }
          if (tailMs <= 0) { acc.usageExit = 'timeout'; tailReady = true; break; }
          armTail();
        }
      }
      if (tailReady) break;
    }
  } finally {
    acc.totalMs = Date.now() - startedAt;
    clearTimeout(timer);
    try { reader.cancel(); } catch { /* 忽略 */ }
  }
  if (!acc.usageRaw && acc.usageExit !== 'timeout') acc.usageExit = sawTerminal ? 'eof' : 'none';
  acc.toolCalls = [...tcMap.values()].map((tc) => {
    let args = {};
    try { args = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch { args = { _raw: tc.arguments }; }
    return { id: tc.id || `call_${Math.random().toString(36).slice(2)}`, name: tc.name, arguments: args };
  });
  acc.usage = normalizeUsageEnvelope(acc.usageRaw);
  acc.usageStatus = acc.usage.status;
  acc.providerId = providerIdOf(provider.baseUrl);
  acc.requestModel = provider.model;
  acc.responseModel = acc.model || '';
  acc.includeUsage = includeUsage;
  return acc;
}

// ─────────────────────── SSE 输出 ───────────────────────
function makeSse() {
  const encoder = new TextEncoder();
  let controller;
  const stream = new ReadableStream({ start(c) { controller = c; } });
  let pingTimer = null;
  const stopPing = () => { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } };
  const send = (event, data) => {
    try {
      let payload = '';
      if (event && event !== 'message') payload += `event: ${event}\n`;
      const lines = String(data).split(/\r?\n/);
      for (const line of lines) payload += `data: ${line}\n`;
      payload += '\n';
      controller.enqueue(encoder.encode(payload));
    } catch { stopPing(); /* 客户端断开 */ }
  };
  // SSE 注释心跳：每 15s 一行 ": ping"（SSE 标准注释，所有解析端按规范忽略，
  // SseAssembler.feedLine 只认 data: 行）。目的：模型思考/工具执行的静默段里
  // 让字节持续流动，防运营商 NAT / 梯子对「无流量连接」的空闲超时掐线
  //（2026-09-07 实测手机端 28~116s 无字节即死，回复在服务端生成完却送不回来）。
  const ping = (intervalMs) => {
    stopPing();
    pingTimer = setInterval(() => {
      try { controller.enqueue(encoder.encode(': ping\n\n')); }
      catch { stopPing(); }
    }, intervalMs);
  };
  const close = () => { stopPing(); try { controller.close(); } catch { /* 已关闭 */ } };
  return { stream, send, close, ping };
}

// ─────────────────────── Agent 循环（核心）───────────────────────
async function runAgentLoop(env, messages, emit, llmOverride) {
  const maxLoops = Math.max(1, parseInt(env.MCP_MAX_LOOPS || '12', 10) || 12);
  const providers = providersOf(env, llmOverride);
  if (providers.length === 0) {
    throw new Error('未配置 LLM 供应商（请求体 llm 字段、LLM_BASE_URL + LLM_MODEL 或 LLM_FALLBACKS 均为空）');
  }
  const servers = mcpServersOf(env);
  const pinnedRaw = (env.MCP_PINNED_TOOLS || '').split(',').map((s) => s.trim()).filter(Boolean);

  // 收集工具：内置 + 各 MCP 服务器（逐个容错）
  //   collected  —— 按 name 分发的注册表（含 server/builtin 标记）
  //   openaiTools —— 发给 LLM 的 OpenAI functions 格式清单
  const collected = [];
  const openaiTools = [];
  const toolErrors = [];
  for (const b of BUILTIN_TOOLS) {
    collected.push({ name: b.function.name, builtin: true });
    openaiTools.push(b);
  }
  for (const srv of servers) {
    try {
      const tools = await serverTools(srv);
      for (const t of tools) {
        collected.push({ name: t.name, server: srv });
        openaiTools.push({
          type: 'function',
          function: {
            name: t.name,
            description: t.description || '',
            parameters: t.inputSchema || { type: 'object', properties: {} },
          },
        });
      }
    } catch (e) {
      toolErrors.push({ server: srv.name, error: String(e.message || e) });
    }
  }
  const byName = new Map(collected.map((c) => [c.name, c]));
  // 钉住工具（参考类）：第 2 轮起仍携带；其余工具仅首轮
  const pinnedNames = new Set(pinnedRaw);
  const stats = {
    loops: 0, toolCalls: 0, maxLoops, toolErrors,
    servers: servers.map((s) => s.name),
    llmSource: llmOverride ? 'request' : 'env',
    path: 'main-agent',
  };
  const timeoutMs = parseInt(env.LLM_TIMEOUT_MS || '120000', 10) || 120000;
  let providerIdx = 0;
  // 逐 attempt（含失败）与逐 loop（只记成功那一发）分开存，末轮与总和永不混用。
  const attempts = [];
  const loopRecords = [];
  let identity = null;

  const finalizeStats = () => {
    const totals = sumUsageEnvelopes(loopRecords.map((item) => item.usage));
    const last = loopRecords.length
      ? loopRecords[loopRecords.length - 1].usage
      : normalizeUsageEnvelope(undefined);
    stats.usage = {
      status: totals.status,
      totals,
      last,
      loops: loopRecords,
      // 只有每一轮都报全，总量才算"完整"；否则界面按 partial 显示，不去对账。
      complete: loopRecords.length > 0 && loopRecords.every((item) => item.usage.status === 'reported'),
    };
    stats.attempts = attempts;
    if (identity) stats.identity = identity;
    return stats;
  };

  for (let loop = 0; loop < maxLoops; loop++) {
    stats.loops = loop + 1;
    const toolsThisTurn = loop === 0 ? openaiTools : openaiTools.filter((t) => pinnedNames.has(t.function.name));

    // 供应商 fallback 重试（失败 attempt 也记账，计费可能已发生）
    let outcome = null;
    let served = null;
    let attemptNo = 0;
    while (attemptNo < providers.length) {
      const provider = providers[providerIdx % providers.length];
      attemptNo++;
      const attemptStartedAt = Date.now();
      try {
        outcome = await llmStream(
          provider, messages, toolsThisTurn, timeoutMs,
          (txt) => emit({ type: 'delta', content: txt }), env,
        );
        if (!outcome) continue;
        served = provider;
        attempts.push({
          loop: loop + 1,
          attempt: attemptNo,
          path: 'main-agent',
          ok: true,
          providerId: outcome.providerId,
          requestModel: outcome.requestModel,
          responseModel: outcome.responseModel || undefined,
          usage: outcome.usage,
          usageExit: outcome.usageExit,
          ttftMs: outcome.ttftMs,
          durationMs: outcome.totalMs,
          streamOptions: outcome.includeUsage,
        });
        break;
      } catch (err) {
        attempts.push({
          loop: loop + 1,
          attempt: attemptNo,
          path: 'main-agent',
          ok: false,
          providerId: providerIdOf(provider.baseUrl),
          requestModel: provider.model,
          usage: normalizeUsageEnvelope(undefined),
          durationMs: Date.now() - attemptStartedAt,
          error: String(err.message || err).slice(0, 200),
        });
        providerIdx = (providerIdx + 1) % providers.length;
        emit({ type: 'system', content: `LLM 供应商切换：${String(err.message).slice(0, 160)}` });
      }
    }
    if (!outcome) throw new Error('全部 LLM 供应商不可用');
    identity = {
      providerId: outcome.providerId,
      requestModel: outcome.requestModel,
      responseModel: outcome.responseModel || undefined,
      // 请求级 llm 预设才算 request；env 兜底要写清楚，别把自报模型当身份认证
      modelSource: llmOverride ? 'request' : 'env',
      streamOptions: outcome.includeUsage,
    };
    loopRecords.push({
      loop: loop + 1,
      path: 'main-agent',
      ...identity,
      usage: outcome.usage,
      usageExit: outcome.usageExit,
      ttftMs: outcome.ttftMs,
      durationMs: outcome.totalMs,
      finishReason: outcome.finishReason || undefined,
      toolCalls: outcome.toolCalls.length,
    });

    const assistantMsg = { role: 'assistant', content: outcome.text || null };
    if (outcome.toolCalls.length) {
      assistantMsg.tool_calls = outcome.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }));
    }
    messages.push(assistantMsg);

    if (!outcome.toolCalls.length) {
      emit({ type: 'done', stats: finalizeStats(), finishReason: outcome.finishReason || 'stop' });
      return { messages, stats };
    }

    for (const tc of outcome.toolCalls) {
      const entry = byName.get(tc.name);
      emit({ type: 'tool_call', name: tc.name, server: (entry && entry.server && entry.server.name) || 'builtin', arguments: tc.arguments });
      let result;
      try {
        if (!entry) result = { error: `未知工具: ${tc.name}` };
        else if (entry.builtin) result = await callBuiltin(tc.name, tc.arguments);
        else result = await callMcpTool(entry.server, tc.name, tc.arguments);
        stats.toolCalls++;
      } catch (e) {
        result = { error: String(e.message || e) };
      }
      const content = JSON.stringify(result).slice(0, 20000);
      messages.push({ role: 'tool', tool_call_id: tc.id, content });
      emit({ type: 'tool_result', name: tc.name, ok: !(result && result.error), preview: content.slice(0, 300) });
    }
  }
  emit({ type: 'done', stats: finalizeStats(), finishReason: 'max_loops', note: `达到 MCP_MAX_LOOPS=${maxLoops} 上限` });
  return { messages, stats };
}

// 配置走 main-agent 的 env 对象（与 getJsonEnv / providersOf 同一套读法），不是 process.env。
/** 从 44 字节 RIFF 头估算秒数；头不全/非标返回 null（放行不断链）。 */
function wavDurationSeconds(wav) {
  try {
    if (wav.length < 44) return null;
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (riff !== 'RIFF') return null;
    const byteRate = view.getUint32(28, true);
    const dataSize = view.getUint32(40, true);
    if (!byteRate || !dataSize) return null;
    return dataSize / byteRate;
  } catch {
    return null;
  }
}
// ─────────────────────── MOSS-TTS-Nano（本机 runtime 127.0.0.1:19890）───────────────────────
// 只做鉴权后的薄转发。三条硬约束：
//   1. 上游地址**只来自 env**（NANO_TTS_URL / NANO_HEALTH_URL），请求体里的 url/voice/路径一律
//      不读——否则浏览器能借这个端点打任意主机（SSRF），也能拿别人的音色 id。
//   2. 上行只有 {text} 和显式的 demo_id；demo_id 是服务端 env 的公开演示条目，
//      「用户/角色参考音频」不走这条路由（没有身份体系前不开放参考注册，见
//      /srv/model-tests/moss-nano/SULLYOS-ADAPTER.md）。
//   3. 缺参考音频的 422 必须翻成 no_ref_voice 409，绝不能回一段假音频充成功。
const NANO_DEFAULT_URL = 'http://127.0.0.1:19890/api/generate';
const NANO_DEFAULT_DEMO_ID = 'public-demo';
// 音色 ID 的形状和 relay 侧 VOICE_ID_RE 一致：只允许短的安全标识符。
// 任何带斜杠、点、空格或超长的值都不可能是合法 ID —— 直接判「没有这个音色」，
// 不转发给上游，也就不存在借音色字段做路径穿越/任意文件读的可能。
const NANO_VOICE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** env 里的音色白名单（`NANO_VOICE_IDS=a,b`）。只保留形状合法的 ID，去重保序。 */
function nanoVoiceList(env) {
  const out = [];
  for (const part of String(env?.NANO_VOICE_IDS || '').split(',')) {
    const id = part.trim();
    if (id && NANO_VOICE_ID_RE.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** 端点派生：base 只从 env 取，health 优先用显式 env，否则从 NANO_TTS_URL 推同主机 /health。 */
function nanoEndpoints(env) {
  const url = (env?.NANO_TTS_URL || '').trim() || NANO_DEFAULT_URL;
  let health = (env?.NANO_HEALTH_URL || '').trim();
  if (!health) {
    const m = /^(https?:\/\/[^/]+)/i.exec(url);
    health = m ? `${m[1]}/health` : 'http://127.0.0.1:19890/health';
  }
  const voices = nanoVoiceList(env);
  const configured = (env?.NANO_VOICE_ID || '').trim();
  // 默认音色只有在白名单里才算数（fail-closed）：运营把某个 ID 从白名单拿掉后，
  // 不能因为它还写在 NANO_VOICE_ID 里就继续被用。
  const defaultVoice = configured && voices.includes(configured) ? configured : '';
  return {
    url,
    health,
    demoId: (env?.NANO_DEMO_ID || '').trim() || NANO_DEFAULT_DEMO_ID,
    voices,
    defaultVoice,
    key: (env?.NANO_RELAY_KEY || '').trim(),
  };
}

/** 上游错误码白名单：只透传这几个人话码，其余按状态码收敛（不把上游原文回给浏览器）。 */
const NANO_ERROR_CODES = new Set([
  'no_ref_voice', 'reference_invalid', 'payload_too_large', 'unsupported_media',
  'busy', 'model_loading', 'timeout', 'bad_request', 'text_too_long',
]);

function nanoErrorFor(status, upstreamCode) {
  const code = NANO_ERROR_CODES.has(upstreamCode) ? upstreamCode : '';
  if (code === 'no_ref_voice' || status === 422) return { code: 'no_ref_voice', status: 409 };
  // 文本超长是「文字太长」，不能折成「参考音频超过 10MB」——那是两回事。
  if (code === 'text_too_long') return { code: 'text_too_long', status: 413 };
  if (code === 'timeout' || status === 504) return { code: 'timeout', status: 504 };
  if (code === 'payload_too_large' || status === 413) return { code: 'payload_too_large', status: 413 };
  if (code === 'busy' || status === 429) return { code: 'busy', status: 429 };
  if (code === 'model_loading') return { code: 'model_loading', status: 503 };
  if (code) return { code, status: status >= 500 ? 503 : 400 };
  if (status === 400 || status === 415) return { code: 'bad_request', status: 400 };
  return { code: 'nano_unavailable', status: 503 };
}

async function ttsProxy(request, env) {
  const { url: nanoUrl, demoId, voices, defaultVoice, key } = nanoEndpoints(env);
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  if (!text) return json({ error: 'empty' }, 400);
  // 只认 text、显式 demo:true 和 voice（白名单内的 ID）。emotion / voice_id / url / demo_id /
  // 任何路径字段一律忽略（不转发）。
  const body = { text };
  const headers = { 'content-type': 'application/json' };
  if (key) headers['x-relay-key'] = key; // 共享密钥：relay 只认它，不经浏览器
  if (payload?.demo === true) {
    // 试听公开演示：绝不带角色音色，避免「试听一下」变成拿用户音色。
    body.demo_id = demoId;
  } else {
    const requested = typeof payload?.voice === 'string' ? payload.voice.trim() : '';
    const voice = requested || defaultVoice;
    // 缺音色 / 音色不在白名单 → 明确 no_ref_voice，不回落 demo，也不偷偷换成默认音色。
    if (!voice || !voices.includes(voice)) return json({ error: 'no_ref_voice' }, 409);
    headers['x-voice-id'] = voice;
  }
  try {
    const upstream = await fetch(nanoUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(env?.NANO_TIMEOUT_MS || 120000)),
    });
    if (!upstream.ok) {
      let upstreamCode = '';
      try {
        const parsed = await upstream.json();
        upstreamCode = typeof parsed?.error === 'string' ? parsed.error : '';
      } catch { upstreamCode = ''; }
      const mapped = nanoErrorFor(upstream.status, upstreamCode);
      console.warn(`[tts] upstream ${upstream.status} ${upstreamCode || '-'} → ${mapped.code}`);
      return json({ error: mapped.code }, mapped.status);
    }
    // 兼容两种下行实现：JSON {audio_base64} 或裸 audio/wav（runtime 契约未定稿时都别断）。
    // 判据不只看 content-type：上游漏设头时按首字节嗅探（'{' 当 JSON，'RIFF' 当音频）。
    const ctype = String(upstream.headers.get('content-type') || '').toLowerCase();
    const raw = new Uint8Array(await upstream.arrayBuffer());
    let wav;
    if (!ctype.includes('audio/') && raw[0] === 0x7b) {
      let data;
      try {
        data = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return json({ error: 'synth_failed' }, 502);
      }
      if (typeof data?.audio_base64 !== 'string' || !data.audio_base64) {
        return json({ error: 'synth_failed' }, 502);
      }
      wav = Uint8Array.from(atob(data.audio_base64), (c) => c.charCodeAt(0));
    } else {
      wav = raw;
    }
    // WAV 门：不是 RIFF 头就不是音频，宁可报失败也不能把坏字节当声音发出去。
    if (wav.length < 44 || wavDurationSeconds(wav) === null) {
      console.warn(`[tts] reject non-wav payload: bytes=${wav.length} type=${ctype || '-'}`);
      return json({ error: 'synth_failed' }, 502);
    }
    // 时长守卫：复读循环的音频远长于文本应有长度，直接拒收（seed 抽风已实测）。
    const seconds = wavDurationSeconds(wav);
    if (seconds !== null && seconds > text.length * 0.6 + 4) {
      console.warn(`[tts] reject overlong audio: chars=${text.length} seconds=${seconds.toFixed(1)}`);
      return json({ error: 'synth_failed' }, 502);
    }
    const out = new Headers();
    out.set('content-type', 'audio/wav');
    out.set('access-control-allow-origin', '*');
    return new Response(wav, { status: 200, headers: out });
  } catch {
    return json({ error: 'nano_unavailable' }, 503);
  }
}

/**
 * 本机语音健康：把 runtime `/health` 收敛成 UI 需要的四个字段。
 * 只回 ready/model/referenceConfigured/demoAvailable —— 本机路径、模型目录、参考音频文件名
 * 一律不出主代理。探不通就 503，让界面说「未连接」而不是猜「已成功」。
 */
async function ttsHealth(request, env) {
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  const { health, voices } = nanoEndpoints(env);
  try {
    const upstream = await fetch(health, { signal: AbortSignal.timeout(4000) });
    if (!upstream.ok) return json({ error: 'nano_unavailable' }, 503);
    let data = null;
    try {
      data = await upstream.json();
    } catch {
      data = null;
    }
    const ready = !!data && typeof data === 'object' && data.ready === true;
    const referenceConfigured = !!data && typeof data === 'object' && data.referenceConfigured === true;
    const body = {
      ready,
      referenceConfigured,
      // 契约里没有独立的 demo 字段：只有模型 ready 才谈得上试听演示。
      demoAvailable: ready,
      // 可选音色只回服务端白名单里的 ID（是「可选清单」，不代表每个都已注册；
      // 真缺参考时合成会明确 409）。绝不回参考文件路径或本机目录。
      voices,
    };
    const model = data && typeof data === 'object' && typeof data.model === 'string' ? data.model.trim() : '';
    if (model) body.model = model;
    return json(body);
  } catch {
    return json({ error: 'nano_unavailable' }, 503);
  }
}

// ─────────────────────── WebDAV (dufs) 认证注入中转 ───────────────────────
async function webdavProxy(req, env, pathSuffix) {
  const auth = (env.DUFS_AUTH || '').trim();
  if (!auth) return json({ error: 'dufs 未配置（DUFS_AUTH 为空）' }, 503);
  const port = env.DUFS_PORT || '8890';
  const target = `http://127.0.0.1:${port}/${pathSuffix}`;
  const headers = new Headers();
  for (const [k, v] of req.headers) {
    if (['host', 'authorization', 'content-length', 'transfer-encoding', 'connection', 'x-client-token'].includes(k.toLowerCase())) continue;
    headers.set(k, v);
  }
  headers.set('authorization', `Basic ${btoa(auth)}`);
  let res;
  try {
    res = await fetch(target, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(),
    });
  } catch (err) {
    return json({ error: `dufs 不可达: ${err.message}` }, 502);
  }
  const out = new Headers(res.headers);
  out.set('access-control-allow-origin', '*');
  out.set('access-control-expose-headers', '*');
  return new Response(res.body, { status: res.status, headers: out });
}

// ─────────────────────── LLM 预设直通代理 ───────────────────────
/**
 * /v1/llm-credentials → 透明转发 amsg 的同名端点（含加密协议、query、body 全透传）。
 * 前端已有 amsg 加密协议的代码只需把 URL 换成 agent 即可；
 * agent 侧不解析、不落盘任何凭据内容。
 */
async function llmCredentialsProxy(req, env, url) {
  const base = (env.AMSG_URL || 'http://127.0.0.1:8832').replace(/\/+$/, '');
  const target = `${base}/llm-credentials${url.search}`;
  const headers = new Headers();
  for (const [k, v] of req.headers) {
    if (['host', 'content-length', 'transfer-encoding', 'connection'].includes(k.toLowerCase())) continue;
    headers.set(k, v);
  }
  let res;
  try {
    res = await fetch(target, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(),
    });
  } catch (err) {
    return json({ error: `amsg 不可达: ${err.message}` }, 502);
  }
  const out = new Headers(res.headers);
  out.set('access-control-allow-origin', '*');
  out.set('access-control-expose-headers', '*');
  return new Response(res.body, { status: res.status, headers: out });
}

// ─────────────────────── 处理器 ───────────────────────
async function handleChat(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const messages = Array.isArray(body && body.messages) ? body.messages : null;
  if (!messages || messages.length === 0) return json({ error: 'messages required' }, 400);
  const stream = body.stream !== false;
  // 前端「API 预设」随请求直传：{ baseUrl, apiKey, model, fallbacks? }
  const llmOverride = body.llm && typeof body.llm === 'object' ? body.llm : null;
  // 排障用的关联 id：只留安全字符，客户端没传就自己生成（不进日志正文）。
  const requestId = String(body.requestId || req.headers.get('x-request-id') || `agent-${Date.now().toString(36)}`)
    .replace(/[^\w.:-]/g, '')
    .slice(0, 64);
  // 请求侧模型：只在还没有响应自报身份时兜底，绝不写一个假名字冒充真实后端。
  const requestedModel = (llmOverride && llmOverride.model) || (env.LLM_MODEL || '');
  const modelOf = (stats) => (stats && stats.identity && (stats.identity.responseModel || stats.identity.requestModel))
    || requestedModel
    || 'unknown';

  if (!stream) {
    const out = { text: '' };
    const res = await runAgentLoop(env, [...messages], (ev) => {
      if (ev.type === 'delta') out.text += ev.content;
    }, llmOverride);
    // 没有真实 usage 就不给这个字段（以前硬编码 0，看起来像"确实零消耗"）。
    const usage = usageToOpenAi(res.stats.usage && res.stats.usage.totals);
    return json({
      id: `chatcmpl-${Date.now().toString(36)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelOf(res.stats),
      choices: [{ index: 0, message: { role: 'assistant', content: out.text }, finish_reason: 'stop' }],
      ...(usage ? { usage } : {}),
      _meta: { stats: res.stats, requestId },
    });
  }

  const sse = makeSse();
  sse.ping(15000);
  const chatId = `chatcmpl-${Date.now().toString(36)}`;
  runAgentLoop(env, [...messages], (ev) => {
    if (ev.type === 'delta') {
      sse.send('message', JSON.stringify({
        id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        // 流里先报请求侧模型（此时还不知道后端自报什么）；末块 usage 再报实际身份。
        ...(requestedModel ? { model: requestedModel } : {}),
        choices: [{ index: 0, delta: { content: ev.content }, finish_reason: null }],
      }));
    } else if (ev.type === 'tool_call') {
      sse.send('tool_call', JSON.stringify({ id: chatId, name: ev.name, server: ev.server, arguments: ev.arguments }));
    } else if (ev.type === 'tool_result') {
      sse.send('tool_result', JSON.stringify({ name: ev.name, ok: ev.ok, preview: ev.preview }));
    } else if (ev.type === 'system') {
      sse.send('system', JSON.stringify({ content: ev.content }));
    } else if (ev.type === 'done') {
      // 先发一个 OpenAI 兼容的 usage 末块（choices: []）：客户端/日志的既有扫描
      // 只认 data 行里的 chunk.usage，这样缓存字段不用另造通道就能落进「API 调用记录」。
      const usage = usageToOpenAi(ev.stats && ev.stats.usage && ev.stats.usage.totals);
      if (usage) {
        sse.send('message', JSON.stringify({
          id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
          model: modelOf(ev.stats),
          choices: [],
          usage,
        }));
      }
      sse.send('done', JSON.stringify({
        stats: ev.stats,
        finishReason: ev.finishReason,
        note: ev.note || null,
        requestId,
      }));
      sse.send('message', DONE_MARKER);
      sse.close();
    }
  }, llmOverride).catch((err) => {
    try { sse.send('error', JSON.stringify({ error: String(err.message || err), requestId })); } catch { /* 忽略 */ }
    try { sse.close(); } catch { /* 忽略 */ }
  });
  return new Response(sse.stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
    },
  });
}

// ─────────────────────── LLM 模型列表透传 ───────────────────────
/**
 * /v1/models?target=<完整 /models URL> —— 模型列表透传（浏览器 CORS 的出口）。
 *
 * 背景：设置页「刷新模型列表」等浏览器侧 GET <baseUrl>/models 会被 CORS 拦
 * （主流 LLM 网关不回 CORS 头），而全局拦截器只改写 /chat/completions。
 * 前端把 baseUrl 拼成完整 target 发到这里，由服务端代拉。
 * 鉴权：供应商 key 放请求头 X-Relay-Target-Authorization（与 MCP 中转同一约定），
 * 不进 URL、不落盘；opencode.ai 上游自动带 User-Agent + x-opencode-session。
 * 只放行公网 http(s)（SSRF 守卫）；响应 256KB 封顶；上游状态码原样透传。
 */
async function llmModelsProxy(req, env, url) {
  if (req.method !== 'GET') return json({ error: 'method_not_allowed', hint: 'GET only' }, 405);
  const raw = (url.searchParams.get('target') || '').trim();
  if (!raw) return json({ error: 'bad_target', hint: '缺少 target=<完整 /models URL>' }, 400);
  if (!isRelayablePublicTarget(raw)) return json({ error: 'bad_target', hint: 'target 必须是公网 http(s) 地址' }, 400);
  const headers = { accept: 'application/json', ...llmIdentityHeaders(raw) };
  const carried = (req.headers.get('x-relay-target-authorization') || '').trim().slice(0, 4096);
  if (carried) headers['authorization'] = carried;
  let res;
  try {
    res = await fetch(raw, { method: 'GET', headers, signal: AbortSignal.timeout(15000) });
  } catch (err) {
    return json({ error: 'upstream_unreachable', detail: String(err.message || err) }, 502);
  }
  const text = await res.text();
  if (text.length > 262144) return json({ error: 'response_too_large', hint: '上游 /models 响应超过 256KB' }, 502);
  return new Response(text, {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') || 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
    },
  });
}

async function handleToolsList(env) {
  const collected = [];
  const errors = [];
  for (const b of BUILTIN_TOOLS) {
    collected.push({ name: b.function.name, server: 'builtin', description: b.function.description, inputSchema: b.function.parameters });
  }
  for (const srv of mcpServersOf(env)) {
    try {
      const tools = await serverTools(srv);
      for (const t of tools) {
        collected.push({ name: t.name, server: srv.name, description: t.description || '', inputSchema: t.inputSchema || null });
      }
    } catch (e) {
      errors.push({ server: srv.name, error: String(e.message || e) });
    }
  }
  return json({ ok: true, tools: collected, errors });
}

// ─────────────────────── 路由 ───────────────────────
// ────────────────────── MCP 中转（通用 CORS 中转） ──────────────────────────
/**
 * /v1/mcp-relay?target=<MCP 地址> —— MCP 统一转发端点（浏览器侧 CORS 的唯一出口）。
 *
 * 两类 target（按顺序判定）：
 *  1. 本机 MCP 前缀（MCP_RELAY_MAP）：改写成 http://127.0.0.1:<port>，
 *     Bearer token 由服务端按 MCP_SERVERS 注入，服务凭据绝不下发浏览器；
 *  2. 任意公网 http(s) URL（如第三方 MCP）：按 SSRF 规则校验后原样转发，
 *     目标鉴权来自请求头 X-Relay-Target-Authorization（浏览器按本机 MCP 条目的
 *     token 现场填写，中转只翻译转发、不存储、不落盘；该头不向目标透传）。
 *
 * 只透传非跳点头；Mcp-Session-Id 双向透传，响应流式回传。
 */
const MCP_RELAY_MAP = [
  { prefix: '/xhs-mcp-http', port: 8810, name: 'xhs-mcp' },
  { prefix: '/xhs-mcp', port: 8809, name: 'xhs-mcp-legacy' },
  { prefix: '/theseus-brain', port: 8787, name: 'theseus-brain' },
  { prefix: '/kaleidoscope', port: 8788, name: 'kaleidoscope-rp' },
  { prefix: '/ruota', port: 8790, name: 'ruota-della-fortuna' },
];

function resolveMcpRelayTarget(rawTarget, env) {
  let t = (rawTarget || '').trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) {
    try { const u = new URL(t); t = u.pathname + (u.search || ''); } catch { return null; }
  }
  if (t.charAt(0) !== '/') return null;
  const servers = mcpServersOf(env);
  for (const m of MCP_RELAY_MAP) {
    if (t === m.prefix || t.indexOf(m.prefix + '/') === 0 || t.indexOf(m.prefix + '?') === 0) {
      const suffix = t.slice(m.prefix.length) || '/mcp';
      const known = servers.find((s) => s.name === m.name);
      return { url: 'http://127.0.0.1:' + m.port + suffix, token: (known && known.token) || '' };
    }
  }
  // 兼容 localhost 形态（如 http://127.0.0.1:8787/mcp）：按端口回退匹配
  if (/^https?:\/\//i.test(rawTarget || '')) {
    try {
      const u = new URL(rawTarget);
      const byPort = MCP_RELAY_MAP.find((m) => String(m.port) === u.port);
      if (byPort) {
        const known = servers.find((s) => s.name === byPort.name);
        return { url: 'http://127.0.0.1:' + byPort.port + (u.pathname || '/mcp') + (u.search || ''), token: (known && known.token) || '' };
      }
    } catch { /* fallthrough */ }
  }
  // 第三方公网 MCP：按 SSRF 规则校验后原样转发，目标 token 走请求头现场携带。
  if (/^https?:\/\//i.test(rawTarget || '') && isRelayablePublicTarget(rawTarget)) {
    return { url: rawTarget.trim(), token: '' };
  }
  return null;
}

// 通用中转的 SSRF 守卫：只放行公网 http(s)。本机/回环/私网/链路本地/
// 内网后缀一律拒绝（与中心 worker 的 isUnsafeFetchTarget 同口径）。
function isRelayablePublicTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return false;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((n) => n < 0 || n > 255)) return false;
    const a = parts[0], b = parts[1];
    if (a === 127 || a === 10 || a === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  }
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) return false;
  return true;
}

async function mcpRelayProxy(req, env, url) {
  const resolved = resolveMcpRelayTarget(url.searchParams.get('target'), env);
  if (!resolved) {
    return json({ error: 'bad_target', hint: 'target 必须是本机 MCP 路径（如 /theseus-brain/mcp）或公网 http(s) 地址' }, 400);
  }
  const headers = new Headers();
  for (const [k, v] of req.headers) {
    if (['host', 'authorization', 'content-length', 'transfer-encoding', 'connection', 'x-client-token', 'origin', 'x-relay-target-authorization'].includes(k.toLowerCase())) continue;
    headers.set(k, v);
  }
  if (resolved.token) {
    headers.set('authorization', 'Bearer ' + resolved.token);
  } else {
    // 第三方 target：目标鉴权现场经 X-Relay-Target-Authorization 携带，
    // 中转只翻译转发、不存储、不落盘。
    const carried = (req.headers.get('x-relay-target-authorization') || '').trim().slice(0, 4096);
    if (carried) headers.set('authorization', carried);
  }
  let res;
  try {
    res = await fetch(resolved.url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(),
    });
  } catch (err) {
    return json({ error: 'MCP 服务不可达: ' + err.message }, 502);
  }
  const out = new Headers(res.headers);
  out.set('access-control-allow-origin', '*');
  out.set('access-control-expose-headers', 'Mcp-Session-Id');
  return new Response(res.body, { status: res.status, headers: out });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let path = url.pathname;
    // Caddy /agent/* 会剥前缀；同时兼容裸路径与带前缀路径
    const plain = path.replace(/^\/agent(?=\/|$)/, '') || '/';

    if (request.method === 'OPTIONS') return corsPreflight(request);

    if (plain === '/health' || plain === '/') {
      const providers = providersOf(env);
      return json({
        ok: true,
        service: 'main-agent',
        version: '1.0.0',
        llmConfigured: providers.length > 0,
        providers: providers.length,
        mcpServers: mcpServersOf(env).map((s) => s.name),
        mcpMaxLoops: parseInt(env.MCP_MAX_LOOPS || '12', 10) || 12,
        time: new Date().toISOString(),
      });
    }

    const authFail = checkAuth(request, env);
    if (authFail) return authFail;

    // 本地 EmbeddingGemma2（127.0.0.1:8850，只 publish 到回环）——
    // **精确三个路径**，全部在鉴权之后：
    //   /v1/local-embedding              POST（兼容 baseUrl 不带 /embeddings 的写法）
    //   /v1/local-embedding/embeddings   POST（前端 embedding.ts 拼的就是这个）
    //   /v1/local-embedding/health       GET（轻量探活，不触上游推理；同样要 token）
    // 上游地址与 key 只来自 env（LOCAL_EMBEDDING_URL / LOCAL_EMBEDDING_API_KEY），
    // 不接受请求体里的 server URL，浏览器也永远拿不到那把 key。
    if (plain === '/v1/local-embedding'
        || plain === '/v1/local-embedding/embeddings'
        || plain === '/v1/local-embedding/health') {
      return handleLocalEmbedding(request, env, { authorize: (req) => checkAuth(req, env) });
    }

    if (plain === '/v1/chat/completions') return handleChat(request, env);
    if (plain === '/v1/tools') return handleToolsList(env);
    if (plain === '/v1/llm-credentials') return llmCredentialsProxy(request, env, url);
    if (plain === '/v1/mcp-relay') return mcpRelayProxy(request, env, url);
    if (plain === '/v1/models') return llmModelsProxy(request, env, url);

    // 本机 MOSS-TTS-Nano（CPU，中文）。适配只在 runtime 内；本层做鉴权后的无状态转发，
    // 不缓存参考音频、不接受任何上游地址或音色 id。
    // GET /v1/tts/health 是 UI 判断「就绪 / 待配置 / 未连接」的唯一来源，同样要 token。
    if (plain === '/v1/tts/health') return ttsHealth(request, env);
    if (plain === '/v1/tts') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return ttsProxy(request, env);
    }

    if (plain.startsWith('/webdav')) {
      const suffix = plain.replace(/^\/webdav\/?/, '');
      return webdavProxy(request, env, suffix);
    }

    return json({ error: 'not_found', path }, 404);
  },
};

// 测试与 utils/llmUsage.ts 的契约对齐用（运行时无人调用，只是把纯函数暴露出来）。
export { normalizeUsageEnvelope, sumUsageEnvelopes, usageToOpenAi, providerIdOf };
