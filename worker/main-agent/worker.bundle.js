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
  if (!expected) return null; // 未配置令牌 = 开发模式放行
  const header = req.headers.get('x-client-token') || '';
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
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
async function llmStream(provider, messages, tools, timeoutMs, emitText) {
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 120000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
        accept: 'text/event-stream',
        ...llmIdentityHeaders(provider.baseUrl),
      },
      body: JSON.stringify({
        model: provider.model,
        messages,
        tools: tools && tools.length ? tools : undefined,
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`LLM 连接失败 (${provider.baseUrl}): ${err.message}`);
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    const body = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status} (${provider.baseUrl}): ${body.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const acc = { text: '', toolCalls: [], finishReason: null };
  const tcMap = new Map();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      let sawTerminal = false;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        // 终止事件即收口：部分代理发完 [DONE]/finish_reason 后仍保持 socket，
        // 等 EOF 会被 120s abort 成「假失败」并触发 fallback 重试（重复计费）。
        if (data === DONE_MARKER) { acc.finishReason = acc.finishReason || 'stop'; sawTerminal = true; break; }
        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }
        const choice = chunk && chunk.choices && chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (typeof delta.content === 'string' && delta.content) {
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
        if (choice.finish_reason) { acc.finishReason = choice.finish_reason; sawTerminal = true; break; }
      }
      if (sawTerminal) break;
    }
  } finally {
    clearTimeout(timer);
    try { reader.cancel(); } catch { /* 忽略 */ }
  }
  acc.toolCalls = [...tcMap.values()].map((tc) => {
    let args = {};
    try { args = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch { args = { _raw: tc.arguments }; }
    return { id: tc.id || `call_${Math.random().toString(36).slice(2)}`, name: tc.name, arguments: args };
  });
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
  const stats = { loops: 0, toolCalls: 0, maxLoops, toolErrors, servers: servers.map((s) => s.name), llmSource: llmOverride ? 'request' : 'env' };
  const timeoutMs = parseInt(env.LLM_TIMEOUT_MS || '120000', 10) || 120000;
  let providerIdx = 0;

  for (let loop = 0; loop < maxLoops; loop++) {
    stats.loops = loop + 1;
    const toolsThisTurn = loop === 0 ? openaiTools : openaiTools.filter((t) => pinnedNames.has(t.function.name));

    // 供应商 fallback 重试
    let outcome = null;
    let attempts = 0;
    while (attempts < providers.length) {
      const provider = providers[providerIdx % providers.length];
      try {
        outcome = await llmStream(provider, messages, toolsThisTurn, timeoutMs, (txt) => emit({ type: 'delta', content: txt }));
        break;
      } catch (err) {
        attempts++;
        providerIdx = (providerIdx + 1) % providers.length;
        emit({ type: 'system', content: `LLM 供应商切换：${String(err.message).slice(0, 160)}` });
      }
    }
    if (!outcome) throw new Error('全部 LLM 供应商不可用');

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
      emit({ type: 'done', stats, finishReason: outcome.finishReason || 'stop' });
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
  emit({ type: 'done', stats, finishReason: 'max_loops', note: `达到 MCP_MAX_LOOPS=${maxLoops} 上限` });
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
async function ttsProxy(request, env) {
  const nanoUrl = (env?.NANO_TTS_URL || '').trim() || 'http://127.0.0.1:18083/api/generate';
  const demoId = (env?.NANO_DEMO_ID || '').trim() || 'demo-30';
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  if (!text) return json({ error: 'empty' }, 400);
  // Nano 无情绪参数：调用方仍可传 emotion，本代理直接忽略（不校验、不转发）。
  try {
    const form = new FormData();
    form.append('text', text);
    form.append('demo_id', demoId);
    form.append('seed', '7');
    form.append('max_new_frames', '200');
    const upstream = await fetch(nanoUrl, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(150000),
    });
    let data;
    try {
      data = await upstream.json();
    } catch {
      return json({ error: 'synth_failed' }, 502);
    }
    if (!upstream.ok || typeof data?.audio_base64 !== 'string' || !data.audio_base64) {
      return json({ error: 'synth_failed' }, 502);
    }
    const wav = Uint8Array.from(atob(data.audio_base64), (c) => c.charCodeAt(0));
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
    return json({ error: 'nano_unavailable' }, 502);
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

  if (!stream) {
    const out = { text: '' };
    const res = await runAgentLoop(env, [...messages], (ev) => {
      if (ev.type === 'delta') out.text += ev.content;
    }, llmOverride);
    return json({
      id: `chatcmpl-${Date.now().toString(36)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: (env.LLM_MODEL || 'sullyos-main-agent'),
      choices: [{ index: 0, message: { role: 'assistant', content: out.text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      _meta: { stats: res.stats },
    });
  }

  const sse = makeSse();
  sse.ping(15000);
  const chatId = `chatcmpl-${Date.now().toString(36)}`;
  runAgentLoop(env, [...messages], (ev) => {
    if (ev.type === 'delta') {
      sse.send('message', JSON.stringify({
        id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: env.LLM_MODEL || 'sullyos-main-agent',
        choices: [{ index: 0, delta: { content: ev.content }, finish_reason: null }],
      }));
    } else if (ev.type === 'tool_call') {
      sse.send('tool_call', JSON.stringify({ id: chatId, name: ev.name, server: ev.server, arguments: ev.arguments }));
    } else if (ev.type === 'tool_result') {
      sse.send('tool_result', JSON.stringify({ name: ev.name, ok: ev.ok, preview: ev.preview }));
    } else if (ev.type === 'system') {
      sse.send('system', JSON.stringify({ content: ev.content }));
    } else if (ev.type === 'done') {
      sse.send('done', JSON.stringify({ stats: ev.stats, finishReason: ev.finishReason, note: ev.note || null }));
      sse.send('message', DONE_MARKER);
      sse.close();
    }
  }, llmOverride).catch((err) => {
    try { sse.send('error', JSON.stringify({ error: String(err.message || err) })); } catch { /* 忽略 */ }
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

    if (plain === '/v1/chat/completions') return handleChat(request, env);
    if (plain === '/v1/tools') return handleToolsList(env);
    if (plain === '/v1/llm-credentials') return llmCredentialsProxy(request, env, url);
    if (plain === '/v1/mcp-relay') return mcpRelayProxy(request, env, url);
    if (plain === '/v1/models') return llmModelsProxy(request, env, url);

    // Genie-TTS（VPS 自建中文克隆）。适配层已处理情绪表、队列、分块与 WAV 包裹，
    // 本层只做鉴权后的无状态转发——不记情绪、不缓存参考音频，避免跨进程失效。
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
