/**
 * 自主生活联调环境（隔离、非生产部署）
 *
 * 组成：
 *   - 真实 worker 路由：esbuild 把 worker/amsg/src/autonomyLife 打进内存 ESM，处理
 *     `POST/GET /autonomy-life/v1/*`；认证用真实的 `resolveOwnerFromSharedToken`。
 *   - 真实持久化：node:sqlite（SQLite 文件落在本目录的 .data/ 下，可重启后复查），
 *     通过一个极薄的 D1 适配器提供 `prepare/bind/first/all/run`。
 *   - 真实浏览器：由调用方用 Chromium 打开 http://127.0.0.1:<port>/，页面 import 真正的
 *     utils/autonomyLife/{api,executor,localLedger}.ts（真实 IndexedDB）。
 *
 * 只允许本机访问；不部署、不连生产 worker、不读任何密钥。
 *
 * 用法：
 *   node scripts/autonomy-e2e/server.mjs [--port 4319] [--reset]
 *   curl -s localhost:4319/inspect
 *   curl -s -XPOST localhost:4319/seed -d '{"kind":"journal.write",...}'
 */

import { build } from 'esbuild';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const SCRATCH = process.env.AUTONOMY_E2E_DIR ?? join(HERE, '.data');
const EVIDENCE = process.env.AUTONOMY_E2E_EVIDENCE ?? process.env.AUTONOMY_EVIDENCE_DIR ?? '';

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 4319;
const RESET = args.includes('--reset');

const TOKEN = process.env.AUTONOMY_E2E_TOKEN ?? 'e2e-shared-token';
const USER = 'e2e-user';
const CHAR = 'e2e-char';
const INSTALLATION = 'e2e-install-1';

mkdirSync(SCRATCH, { recursive: true });
const dbPath = join(SCRATCH, 'autonomy-e2e.sqlite');
if (RESET) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(dbPath + suffix, { force: true }); } catch { /* ignore */ }
  }
}

const sqlite = new DatabaseSync(dbPath);

// 真实 SQLite 上的 D1 适配器：语义与 worker 里的 D1 一致（changes 是真值）。
function makeD1(db) {
  return {
    prepare(sqlText) {
      let params = [];
      const stmt = {
        bind(...values) {
          params = values.map((value) => {
            if (value === undefined) return null;
            if (typeof value === 'boolean') return value ? 1 : 0;
            return value;
          });
          return stmt;
        },
        async first() {
          return db.prepare(sqlText).get(...params) ?? null;
        },
        async all() {
          return { results: db.prepare(sqlText).all(...params) };
        },
        async run() {
          const result = db.prepare(sqlText).run(...params);
          return {
            changes: Number(result.changes ?? 0),
            lastInsertRowid: Number(result.lastInsertRowid ?? 0),
            meta: { changes: Number(result.changes ?? 0) },
          };
        },
      };
      return stmt;
    },
  };
}

const d1 = makeD1(sqlite);

// ── 打包真实模块 ─────────────────────────────────────────────────────────────
async function bundle(entry, platform) {
  const result = await build({
    entryPoints: [join(ROOT, entry)],
    bundle: true,
    format: 'esm',
    platform,
    target: platform === 'node' ? 'node22' : 'es2022',
    write: false,
    logLevel: 'silent',
    define: platform === 'browser' ? { 'process.env.NODE_ENV': '"development"' } : {},
  });
  return result.outputFiles[0].text;
}

const serverBundlePath = join(SCRATCH, 'server-core.mjs');
writeFileSync(serverBundlePath, await bundle('scripts/autonomy-e2e/server-core.ts', 'node'));
const core = await import(`${serverBundlePath}?v=${Date.now()}`);

const harnessPath = join(SCRATCH, 'harness.js');
writeFileSync(harnessPath, await bundle('scripts/autonomy-e2e/harness-entry.ts', 'browser'));
const harnessJs = await bundle('scripts/autonomy-e2e/harness-entry.ts', 'browser');

// ── 联调请求日志（证据） ─────────────────────────────────────────────────────
const requestLog = [];
const logRequest = (entry) => {
  requestLog.push(entry);
  if (EVIDENCE) {
    try {
      writeFileSync(join(EVIDENCE, 'e2e-http-requests.json'), JSON.stringify(requestLog, null, 2));
    } catch { /* ignore */ }
  }
  console.log('[e2e]', entry.method, entry.path, entry.status);
};

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type,x-client-token,x-user-id',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
};

const respond = (status, body) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

// ── 生产链路：可控模型响应（真实模型端口 → 本机 mock /chat/completions） ─────
let mockModelMode = 'journal';
const mockCandidates = [
  { kind: 'journal.write', semanticPurpose: 'daily_note', args: { title: '联调日记', body: '这是可控模型响应给出的候选。' } },
];

function mockModelResponse() {
  if (mockModelMode === 'fail') {
    return new Response(JSON.stringify({ error: { message: 'mock model failure' } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ candidates: mockCandidates }) } }],
    usage: { total_tokens: 120 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function readStaticJson(relativePath) {
  const file = join(ROOT, 'public', 'shopping', relativePath);
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8');
}

/** 写账号/角色边界（生产里由 UI 保存；这里直接落 D1，等价于用户在设置页点过）。 */
async function setupBoundary(input = {}) {
  const nowMs = input.nowMs ?? Date.now();
  const userId = input.userId ?? USER;
  const charId = input.charId ?? CHAR;
  await core.ensureAutonomyLifeSchema(d1);
  const previous = sqlite
    .prepare("SELECT revision FROM autonomy_life_boundaries WHERE owner_id = ? AND scope = 'account' AND char_id = ''")
    .get(userId);
  const revision = Number(previous?.revision ?? 0) + 1;
  const account = core.normalizeBoundary(
    {
      enabled: input.enabled !== false,
      globalPaused: input.globalPaused === true,
      timezone: 'Asia/Shanghai',
      allowedKinds: input.allowedKinds ?? [],
      externalGrants: input.grants ?? [],
      ...(input.limits ? { limits: input.limits } : {}),
    },
    { scope: 'account', nowMs, revision },
  );
  sqlite
    .prepare('INSERT OR REPLACE INTO autonomy_life_boundaries (owner_id, scope, char_id, revision, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, 'account', '', account.revision, JSON.stringify(account), nowMs);
  const character = core.normalizeBoundary({}, { scope: 'character', nowMs, revision: 0 });
  sqlite
    .prepare('INSERT OR IGNORE INTO autonomy_life_boundaries (owner_id, scope, char_id, revision, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, 'character', charId, character.revision, JSON.stringify(character), nowMs);
  const runtime = core.createAutonomyLifeRuntime({ db: d1, userId, charId, now: () => nowMs, timezone: 'Asia/Shanghai' });
  await runtime.store.bindInstallation(userId, input.installationId ?? INSTALLATION, nowMs);
  // `/pause` 的权威来源是 accounts.paused 与角色 payload.pauseRequestedAt（不在 boundaries）：
  // /setup 明确「恢复运行」，两处都清掉，避免场景之间互相污染。
  await runtime.store.setAccountPause(userId, false, nowMs);
  await d1
    .prepare("UPDATE autonomy_life_characters SET payload = json_set(payload, '$.pauseRequestedAt', json('null')) WHERE owner_id = ? AND char_id = ?")
    .bind(userId, charId)
    .run()
    .catch(() => undefined);
  return account;
}

/**
 * 生产入口 tick：调**真实** handleAutonomyLifeScheduled（cron 唯一入口）。
 * 模型请求走本机 mock /chat/completions（可控响应），外部窗口用 env 里的真实端点。
 */
async function runProductionTick(input = {}) {
  const nowMs = input.nowMs ?? Date.now();
  const userId = input.userId ?? USER;
  const charId = input.charId ?? CHAR;
  await core.ensureAutonomyLifeSchema(d1);
  // 联调「把时钟推到下一次机会」：只清调度时间指针，不注 profile/不造候选。
  if (input.forceDue) {
    await d1
      .prepare("UPDATE autonomy_life_characters SET payload = json_set(payload, '$.nextOpportunityAt', json('null'), '$.retryAt', json('null'), '$.circuitOpenedAt', json('null')) WHERE owner_id = ? AND char_id = ?")
      .bind(userId, charId)
      .run()
      .catch(() => undefined);
  }
  const pack = {
    userId,
    charId,
    charName: input.charName ?? '小夏',
    pack: {
      template: input.template ?? '你叫小夏，喜欢天文，作息规律。',
      tzId: 'Asia/Shanghai',
      ...(input.scene ? { scene: input.scene } : {}),
    },
  };
  const result = await core.handleAutonomyLifeScheduled({
    db: d1,
    packs: [pack],
    nowMs,
    credentialsFor: async () => ({
      baseUrl: `http://127.0.0.1:${PORT}/mock-llm/v1`,
      apiKey: 'mock-key',
      model: 'mock-model',
    }),
    fetch: globalThis.fetch,
    external: {
      xhsUrl: process.env.AUTONOMY_EXTERNAL_XHS_URL ?? '',
      readHosts: process.env.AUTONOMY_EXTERNAL_READ_HOSTS ?? '',
    },
    ...(input.reachability === 'unreachable' ? { reachability: async () => false } : {}),
  });
  return result;
}

// ── seed：把工程侧「计划产物」落成真实动作行（隔离环境没有真实 LLM 凭据） ─────
async function seedAction(input) {
  const nowMs = input.nowMs ?? Date.now();
  const userId = input.userId ?? USER;
  const charId = input.charId ?? CHAR;
  const installationId = input.installationId ?? INSTALLATION;
  await core.ensureAutonomyLifeSchema(d1);

  const account = core.normalizeBoundary(
    {
      enabled: true,
      globalPaused: false,
      timezone: 'Asia/Shanghai',
      allowedKinds: [input.kind],
      externalGrants: input.grants ?? [],
      ...(input.account ?? {}),
    },
    { scope: 'account', nowMs, revision: 1 },
  );
  sqlite
    .prepare('INSERT OR REPLACE INTO autonomy_life_boundaries (owner_id, scope, char_id, revision, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, 'account', '', account.revision, JSON.stringify(account), nowMs);
  const character = core.normalizeBoundary({}, { scope: 'character', nowMs, revision: 0 });
  sqlite
    .prepare('INSERT OR REPLACE INTO autonomy_life_boundaries (owner_id, scope, char_id, revision, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, 'character', charId, character.revision, JSON.stringify(character), nowMs);

  const runtime = core.createAutonomyLifeRuntime({
    db: d1,
    userId,
    charId,
    now: () => nowMs,
    timezone: 'Asia/Shanghai',
  });
  await runtime.store.bindInstallation(userId, installationId, nowMs);
  const effective = await runtime.boundaryFor(charId);
  const reservation = await core.reserveBudget(runtime.budget, {
    nowMs,
    windowTimezone: 'Asia/Shanghai',
    accountId: userId,
    charId,
    limits: effective.limits,
    tokens: 2_000,
    kind: input.kind,
  });
  if (!reservation.ok) throw new Error(`reservation_failed:${reservation.dimension}`);
  const row = core.buildActionRow({
    charId,
    chosen: {
      kind: input.kind,
      semanticPurpose: input.semanticPurpose ?? `e2e_${input.kind}`,
      purposeKey: input.purposeKey ?? `e2e-${input.kind}-${nowMs}`,
      args: input.args,
      reasonSummary: '联调：计划产物',
      candidate: { kind: input.kind, semanticPurpose: input.semanticPurpose ?? `e2e_${input.kind}` },
    },
    nowMs,
    budgetWindowId: core.windowIdAt({ now: () => nowMs }, 'Asia/Shanghai'),
    reservationId: reservation.grant.reservationId,
    policyVersion: 'autonomy-life-v1',
    tz: 'Asia/Shanghai',
    installationId,
    online: true,
  });
  const inserted = await runtime.store.insertAction(row);
  // 与引擎同一步：预留凭据必须绑定到这条动作，否则许可签发/外部副作用会按「没依据」拒绝。
  const bound = await runtime.budget.bindReservation({
    reservationId: reservation.grant.reservationId,
    actionId: row.id,
    charId,
    windowId: row.windowId,
    nowMs,
  });
  if (!bound) throw new Error('reservation_bind_failed');
  return { inserted, action: row, reservation: reservation.grant };
}

// ── inspect：服务端持久化的真实状态（回执/愿望/配额） ─────────────────────────
function inspect(ownerId = USER) {
  const actions = sqlite
    .prepare('SELECT id, payload FROM autonomy_life_actions WHERE owner_id = ? ORDER BY created_at ASC')
    .all(ownerId)
    .map((row) => {
      const payload = JSON.parse(row.payload);
      return {
        id: payload.id,
        kind: payload.kind,
        status: payload.status,
        revision: payload.revision,
        args: payload.args,
        argsHash: payload.argsHash,
        permitIssuedAt: payload.permitIssuedAt,
        permitConsumedAt: payload.permitConsumedAt,
        resultRef: payload.resultRef,
        errorCode: payload.errorCode,
      };
    });
  const wishes = sqlite
    .prepare('SELECT id, char_id, text, grant_id, created_at FROM autonomy_life_wishes WHERE owner_id = ? ORDER BY created_at ASC')
    .all(ownerId)
    .map((row) => ({ id: row.id, charId: row.char_id, text: row.text, grantId: row.grant_id, createdAt: row.created_at }));
  const usage = sqlite
    .prepare('SELECT day_key, provider, used FROM autonomy_life_external_usage WHERE owner_id = ? ORDER BY day_key, provider')
    .all(ownerId)
    .map((row) => ({ dayKey: row.day_key, provider: row.provider, used: row.used }));
  const budget = sqlite
    .prepare('SELECT window_id, scope, used_calls, reserved_calls, spend_minor, kind_counts FROM autonomy_life_budget WHERE owner_id = ? ORDER BY window_id, scope')
    .all(ownerId)
    .map((row) => ({
      windowId: row.window_id,
      scope: row.scope,
      usedCalls: row.used_calls,
      reservedCalls: row.reserved_calls,
      spendMinor: row.spend_minor,
      kindCounts: row.kind_counts,
    }));
  const proposals = sqlite
    .prepare('SELECT proposal_id, char_id, kind, payload, expires_at FROM autonomy_life_proposals WHERE owner_id = ? ORDER BY created_at ASC')
    .all(ownerId)
    .map((row) => ({
      proposalId: row.proposal_id,
      charId: row.char_id,
      kind: row.kind,
      expiresAt: row.expires_at,
      args: JSON.parse(row.payload).args,
    }));
  return { dbPath, actions, wishes, usage, budget, proposals };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const method = (req.method ?? 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    res.writeHead(204, JSON_HEADERS);
    res.end();
    return;
  }

  const send = (status, body, headers = JSON_HEADERS) => {
    res.writeHead(status, headers);
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    logRequest({ at: Date.now(), method, path: url.pathname, status });
  };

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = `<!doctype html><meta charset="utf-8"><title>autonomy e2e</title>
<body><pre id="out">ready</pre>
<script type="module">
import './harness.js';
window.__log = (v) => { document.getElementById('out').textContent = JSON.stringify(v, null, 2); };
window.__ready = true;
</script></body>`;
      send(200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return;
    }
    if (url.pathname === '/harness.js') {
      send(200, harnessJs, { 'Content-Type': 'text/javascript; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return;
    }
    if (url.pathname === '/health') {
      send(200, { ok: true, userAgent: req.headers['user-agent'] ?? null });
      return;
    }
    if (url.pathname === '/inspect') {
      send(200, inspect());
      return;
    }
    if (url.pathname.startsWith('/shopping/')) {
      const text = readStaticJson(url.pathname.slice('/shopping/'.length));
      if (text === null) {
        send(404, { error: 'not_found' }, JSON_HEADERS);
        return;
      }
      send(200, text, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return;
    }
    if (url.pathname === '/mock-llm-config' && method === 'POST') {
      const body = await readJson(req);
      mockModelMode = body.mode === 'fail' ? 'fail' : 'journal';
      send(200, { ok: true, mode: mockModelMode }, JSON_HEADERS);
      return;
    }
    if (url.pathname.startsWith('/mock-llm/') && method === 'POST') {
      // 真实模型端口的对端：可控响应（journal 候选 / 500）。请求体不落日志。
      send(200, await mockModelResponse().text(), { 'Content-Type': 'application/json' });
      return;
    }
    if (url.pathname === '/setup' && method === 'POST') {
      const body = await readJson(req);
      const account = await setupBoundary(body);
      send(200, { ok: true, boundary: account }, JSON_HEADERS);
      return;
    }
    if (url.pathname === '/tick' && method === 'POST') {
      const body = await readJson(req);
      const result = await runProductionTick(body);
      send(200, { ok: true, outcomes: result.outcomes, inspect: inspect(body.userId ?? USER) }, JSON_HEADERS);
      return;
    }
    if (url.pathname === '/seed' && method === 'POST') {
      const body = await readJson(req);
      const result = await seedAction(body);
      send(200, { ok: true, action: result.action, reservation: result.reservation }, JSON_HEADERS);
      return;
    }
    if (url.pathname.startsWith('/autonomy-life/v1')) {
      const { Readable } = await import('node:stream');
      const requestBody = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
      const request = new Request(`http://127.0.0.1:${PORT}${url.pathname}${url.search}`, {
        method,
        headers: req.headers,
        ...(requestBody ? { body: requestBody } : {}),
      });
      const response = await core.handleAutonomyLifeRequest(request, {
        DB: d1,
        AMSG_SERVER_TOKEN: TOKEN,
        AUTONOMY_EXTERNAL_XHS_URL: process.env.AUTONOMY_EXTERNAL_XHS_URL ?? 'https://jsonplaceholder.typicode.com/posts',
        AUTONOMY_EXTERNAL_READ_HOSTS: process.env.AUTONOMY_EXTERNAL_READ_HOSTS ?? 'jsonplaceholder.typicode.com',
      }, {
        now: () => Date.now(),
        resolveOwner: (req2) => core.resolveOwnerFromSharedToken(req2, { AMSG_SERVER_TOKEN: TOKEN }),
        respond: (status, payload) => respond(status, payload),
        hasModelCredentials: async () => true,
        timezoneFor: async () => 'Asia/Shanghai',
        requestId: () => `e2e_${Math.random().toString(36).slice(2, 10)}`,
      });
      if (!response) {
        send(404, { error: 'not_found' });
        return;
      }
      const text = await response.text();
      send(response.status, text || '{}', { ...JSON_HEADERS, ...Object.fromEntries(response.headers) });
      return;
    }
    send(404, { error: 'not_found' });
  } catch (error) {
    send(500, { error: String(error?.stack ?? error) });
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  return text ? JSON.parse(text) : {};
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[e2e] listening on http://127.0.0.1:${PORT} (db: ${dbPath})`);
  console.log(`[e2e] token: ${TOKEN} user: ${USER} char: ${CHAR} installation: ${INSTALLATION}`);
});
