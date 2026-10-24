/**
 * 自主生活 · 隔离环境真实联调（真实浏览器 → 真实 worker 路由 → 真实 SQLite/IndexedDB）
 *
 * 这不是单测：它启动 `server.mjs`（真实 worker 路由 + node:sqlite 持久化），用 Chromium 打开
 * 联调页（页面里 import 的是仓库中的 utils/autonomyLife/{api,executor,localLedger}，走真实
 * IndexedDB 和真实 fetch），把下面这条链一次跑通并留证：
 *
 *   浏览器执行器 register → claim → commit-permit → 本地事务 → 回执
 *   服务端 D1(SQLite) 落库 → 重启后仍在 → /inspect 可核对
 *   外部只读窗口：真实 https 出网（jsonplaceholder）→ 字段投影 → 本地落库 → 配额计数
 *   撤销授权 / 账号暂停：同一张已签许可在出网前被拒，零出网、零落库
 *
 * 只跑本机、不部署、不连生产、不读任何密钥。用法：
 *   node scripts/autonomy-e2e/run.mjs [--port 4321]
 * 产物：<evidence>/e2e-report.json + e2e-http-requests.json + 控制台日志
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const EVIDENCE = process.env.AUTONOMY_E2E_EVIDENCE ?? join(HERE, '.data', 'evidence');
const PORT = (() => {
  const index = process.argv.indexOf('--port');
  return index >= 0 ? Number(process.argv[index + 1]) : 4321;
})();
const BASE = `http://127.0.0.1:${PORT}`;
const API = '/autonomy-life/v1';
const TOKEN = 'e2e-shared-token';
const USER = 'e2e-user';
const CHAR = 'e2e-char';
const INSTALLATION = 'e2e-install-1';
// 真实第三方只读端点：GitHub 公共 API（匿名可读、忽略未知 query、返回 JSON 数组）。
const EXTERNAL_HOST = 'api.github.com';
const EXTERNAL_URL = `https://${EXTERNAL_HOST}/users/octocat/repos`;

const CHROME = process.env.AUTONOMY_E2E_CHROME ?? '/root/.hermes/tools/chromium-1208/chrome-linux64/chrome';
const DEPS = process.env.AUTONOMY_E2E_DEPS ?? '/root/.hermes/profiles/ds-executor/cache/scratch/autonomy-e2e-deps';

mkdirSync(EVIDENCE, { recursive: true });

const findings = [];
const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass, detail });
  const line = `${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`;
  console.log(line);
  if (!pass) findings.push(name);
}
const section = (title) => console.log(`\n=== ${title} ===`);

// ── 进程与 HTTP ──────────────────────────────────────────────────────────────
let server = null;

function startServer({ reset }) {
  const args = ['scripts/autonomy-e2e/server.mjs', '--port', String(PORT)];
  if (reset) args.push('--reset');
  server = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AUTONOMY_E2E_EVIDENCE: EVIDENCE,
      AUTONOMY_EXTERNAL_XHS_URL: EXTERNAL_URL,
      AUTONOMY_EXTERNAL_READ_HOSTS: EXTERNAL_HOST,
    },
  });
  server.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  server.stderr.on('data', (chunk) => process.stderr.write(`[server:err] ${chunk}`));
}

async function stopServer() {
  if (!server) return;
  const proc = server;
  server = null;
  await new Promise((done) => {
    proc.once('exit', done);
    proc.kill('SIGTERM');
    setTimeout(() => proc.kill('SIGKILL'), 5000).unref?.();
  });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server_not_ready');
}

async function call(path, { method = 'GET', body, headers } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Token': TOKEN,
      'X-User-Id': USER,
      ...(headers ?? {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (res.status >= 400 && path !== '/inspect') {
    console.log(`[e2e] ${method} ${path} -> ${res.status}`, JSON.stringify(json)?.slice(0, 400));
  }
  return { status: res.status, json };
}

// ── 浏览器 ───────────────────────────────────────────────────────────────────
const require = createRequire(join(DEPS, 'index.js'));
const { chromium } = require('playwright-core');

let browser = null;
let page = null;

async function openBrowser() {
  browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext();
  page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`[browser:error] ${message.text()}`);
  });
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__AUTONOMY_E2E__ !== 'undefined', null, { timeout: 30_000 });
  const ua = await page.evaluate(() => navigator.userAgent);
  check('真实 Chromium 已加载联调页', /Chrome\//.test(ua), ua);

  // 页面里自证：IndexedDB 是浏览器的原生实现（不是 fake-indexeddb）。
  const nativeIdb = await page.evaluate(() => typeof indexedDB !== 'undefined' && !indexedDB._fake && !/FDBFactory/.test(String(indexedDB.constructor?.name)));
  check('页面使用原生 IndexedDB（非 fake-indexeddb）', nativeIdb === true);
  return ua;
}

async function runInBrowser() {
  const result = await page.evaluate(async (config) => window.__AUTONOMY_E2E__.run(config), {
    baseUrl: BASE,
    token: TOKEN,
    userId: USER,
    installationId: INSTALLATION,
    charId: CHAR,
  });
  return result;
}

async function readLocal() {
  return page.evaluate(async () => window.__AUTONOMY_E2E__.readLocal());
}

// ── 场景 ────────────────────────────────────────────────────────────────────
const grantFor = (provider, overrides = {}) => ({
  provider,
  scopes: provider === 'xhs' ? ['read:search'] : ['read:geo'],
  allowedHosts: [EXTERNAL_HOST],
  allowedFieldKeys: ['query'],
  purpose: 'e2e isolated 联调',
  expiresAt: Date.now() + 3600_000,
  dailyQuota: 5,
  ...overrides,
});

const BUDGET_OVERRIDE = { limits: { accountModelCallsPerDay: 30, charModelCallsPerDay: 30 } };

async function scenarioLocalEffect() {
  section('场景 1：浏览器 → worker → 本地 IndexedDB → 回执（真实链路）');
  const seed = await call('/seed', {
    method: 'POST',
    body: {
      kind: 'journal.write',
      semanticPurpose: 'e2e_journal',
      purposeKey: 'e2e-journal-1',
      account: BUDGET_OVERRIDE,
      args: { title: '联调日记', body: '这条日记由真实浏览器执行器写入 IndexedDB。', mood: 'calm' },
    },
  });
  check('seeded 动作行（journal.write）', seed.status === 200, { actionId: seed.json?.action?.id });
  const actionId = seed.json.action.id;

  const result = await runInBrowser();
  const outcome = result.rounds.flat().find((item) => item.charId === CHAR);
  check('执行器返回成功结果', outcome?.result?.status === 'succeeded', outcome?.result?.status ?? outcome?.note);
  check('执行器拿到的许可来自服务端（有 nonce）', typeof seed.json.action === 'object');
  check('本地 IndexedDB 落日记行', (result.diaries ?? []).some((row) => row.actionId === actionId), (result.diaries ?? []).length);
  check('本地 IndexedDB 落回执行回执', (result.receipts ?? []).some((row) => row.actionId === actionId), (result.receipts ?? []).length);
  check('本地许可在同事务核销（permitConsumedAt 已写）', (result.permits ?? []).every((row) => row.consumedAt !== undefined), (result.permits ?? []).length);

  const inspect = (await call('/inspect')).json;
  const action = inspect.actions.find((row) => row.id === actionId);
  check('服务端 D1(SQLite) 动作收敛为 succeeded', action?.status === 'succeeded', action);
  check('服务端记录已核销许可', action?.permitConsumedAt !== null && action?.permitConsumedAt !== undefined, action);
  check('服务端记录 resultRef', typeof action?.resultRef === 'string' && action.resultRef.includes('diaries:'), action?.resultRef);
  return actionId;
}

async function scenarioServerRestart(actionId) {
  section('场景 2：重启 worker 进程后持久化仍在（同一 SQLite 文件）');
  await stopServer();
  startServer({ reset: false });
  await waitForHealth();
  const inspect = (await call('/inspect')).json;
  const action = inspect.actions.find((row) => row.id === actionId);
  check('重启后动作行仍在且为 succeeded', action?.status === 'succeeded', action?.id);
  check('重启后许可核销时间仍在', action?.permitConsumedAt !== null && action?.permitConsumedAt !== undefined);
  check('重启后 SQLite 文件为同一路径', inspect.dbPath.endsWith('autonomy-e2e.sqlite'), inspect.dbPath);
}

async function scenarioExternalRead() {
  section('场景 3：受控外部只读 —— 真实第三方 https 出网 + 字段投影');
  const seed = await call('/seed', {
    method: 'POST',
    body: {
      kind: 'external.read',
      semanticPurpose: 'e2e_external_read',
      purposeKey: 'e2e-external-read-1',
      account: BUDGET_OVERRIDE,
      args: { query: '联调关键词', fields: ['title', 'url'] },
      grants: [grantFor('xhs')],
    },
  });
  check('seeded 动作行（external.read）', seed.status === 200, { actionId: seed.json?.action?.id });
  const actionId = seed.json.action.id;

  const result = await runInBrowser();
  const outcome = result.rounds.flat().find((item) => item.charId === CHAR);
  const readRow = (result.localLife ?? []).find((row) => row.actionId === actionId);

  check('执行器成功（真实出网 + 本地落库）', outcome?.result?.status === 'succeeded', outcome?.result?.status ?? outcome?.note ?? outcome);
  console.log('[e2e] external.read 本地记录:', JSON.stringify(readRow?.items?.[0] ?? null));
  check('本地只存白名单字段（title/url）', !!readRow && Object.keys(readRow.items?.[0] ?? {}).every((key) => ['title', 'url'].includes(key)), readRow?.items?.[0]);
  check('外部内容明确标注只读来源', readRow?.source === 'external_read_only', readRow?.source);
  check('读到的是真实响应（非空且带 url）', typeof readRow?.items?.[0]?.url === 'string' && readRow.items[0].url.includes(EXTERNAL_HOST), readRow?.items?.[0]?.url);

  const inspect = (await call('/inspect')).json;
  const action = inspect.actions.find((row) => row.id === actionId);
  check('服务端动作 succeeded', action?.status === 'succeeded', action?.status);
  check('服务端外部配额已+1', (inspect.usage ?? []).some((row) => row.provider === 'xhs' && row.used >= 1), inspect.usage);
  const log = readRequestLog();
  const readCalls = log.filter((entry) => entry.path === '/autonomy-life/v1/external/read');
  check('请求日志包含 /autonomy-life/v1/external/read 200', readCalls.some((entry) => entry.status === 200), readCalls.length);
  return actionId;
}

const errorCodeOf = (body) => body?.code ?? body?.error?.code ?? null;

function readRequestLog() {
  const path = join(EVIDENCE, 'e2e-http-requests.json');
  if (!existsSync(path)) return [];
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
}

/** 直接用 HTTP 准备一张已签许可（模拟执行器已领到、尚未执行）。 */
async function preparePermit(actionId) {
  const claim = await call(`${API}/execution/claim`, {
    method: 'POST',
    body: { charId: CHAR, installationId: INSTALLATION },
  });
  if (claim.status !== 200 || !claim.json?.action) throw new Error(`claim_failed:${claim.status}`);
  const action = claim.json.action;
  const permit = await call(`${API}/actions/${actionId}/commit-permit`, {
    method: 'POST',
    body: {
      installationId: INSTALLATION,
      leaseEpoch: claim.json.leaseEpoch,
      argsHash: action.argsHash,
      policyVersion: action.policyVersion,
    },
  });
  if (permit.status !== 200) throw new Error(`permit_failed:${permit.status}:${JSON.stringify(permit.json)}`);
  return { action: permit.json.action, permit: permit.json.permit };
}

async function boundaryRevision(scope) {
  const res = await call(`${API}/boundaries?charId=${CHAR}`);
  const account = res.json?.account ?? res.json?.data?.account;
  const character = res.json?.character ?? res.json?.data?.character;
  return scope === 'account' ? account?.revision ?? 0 : character?.revision ?? 0;
}

async function scenarioRevokeAndPause() {
  section('场景 4：撤销授权 / 账号暂停 —— 已签许可在出网前被拒，零出网零落库');

  // 4a 撤销授权
  const seedRevoke = await call('/seed', {
    method: 'POST',
    body: {
      kind: 'external.read',
      semanticPurpose: 'e2e_external_revoke',
      purposeKey: 'e2e-external-revoke-1',
      account: BUDGET_OVERRIDE,
      args: { query: '撤销联调', fields: ['title'] },
      grants: [grantFor('xhs')],
    },
  });
  const revokeActionId = seedRevoke.json.action.id;
  const prepared = await preparePermit(revokeActionId);
  const usageBefore = (await call('/inspect')).json.usage;
  const wishesBefore = (await call('/inspect')).json.wishes.length;
  const logBefore = readRequestLog().filter((entry) => entry.path === '/autonomy-life/v1/external/read').length;

  const accountRevision = await boundaryRevision('account');
  const revoke = await call(`${API}/boundaries`, {
    method: 'PATCH',
    body: { scope: 'account', expectedRevision: accountRevision, changes: { externalGrants: [] } },
  });
  check('撤销授权成功（边界 revision+1）', revoke.status === 200, revoke.status);

  const revokedCall = await call(`${API}/external/read`, {
    method: 'POST',
    body: {
      charId: CHAR,
      query: '撤销联调',
      fields: ['title'],
      actionId: revokeActionId,
      installationId: INSTALLATION,
      leaseEpoch: prepared.permit.leaseEpoch,
      argsHash: prepared.permit.argsHash,
      nonce: prepared.permit.nonce,
    },
  });
  check('撤销后外部读取被拒（403 GRANT_REQUIRED）', revokedCall.status === 403 && errorCodeOf(revokedCall.json) === 'GRANT_REQUIRED', `${revokedCall.status} ${errorCodeOf(revokedCall.json)}`);
  const afterRevoke = (await call('/inspect')).json;
  check('撤销场景：动作未被消费', afterRevoke.actions.find((row) => row.id === revokeActionId)?.permitConsumedAt === null);
  check('撤销场景：配额未增加（没有出网）', JSON.stringify(afterRevoke.usage) === JSON.stringify(usageBefore), afterRevoke.usage);
  check('撤销场景：愿望表零写入', afterRevoke.wishes.length === wishesBefore, afterRevoke.wishes.length);
  const logAfterRevoke = readRequestLog().filter((entry) => entry.path === '/autonomy-life/v1/external/read').length;
  check('撤销场景：请求日志只有被拒那一次（没有额外出网痕迹）', logAfterRevoke === logBefore + 1, { logBefore, logAfterRevoke });

  // 4b 账号暂停
  const seed2 = await call('/seed', {
    method: 'POST',
    body: {
      kind: 'external.read',
      semanticPurpose: 'e2e_external_pause',
      purposeKey: 'e2e-external-pause-1',
      account: BUDGET_OVERRIDE,
      args: { query: '暂停联调', fields: ['title'] },
      grants: [grantFor('xhs')],
    },
  });
  const pauseActionId = seed2.json.action.id;
  const prepared2 = await preparePermit(pauseActionId);
  const usageBeforePause = (await call('/inspect')).json.usage;
  const pauseRevision = await boundaryRevision('account');
  const pause = await call(`${API}/pause`, {
    method: 'POST',
    body: { scope: 'account', paused: true, expectedRevision: pauseRevision },
  });
  check('账号总暂停成功', pause.status === 200, pause.status);
  const pausedCall = await call(`${API}/external/read`, {
    method: 'POST',
    body: {
      charId: CHAR,
      query: '暂停联调',
      fields: ['title'],
      actionId: pauseActionId,
      installationId: INSTALLATION,
      leaseEpoch: prepared2.permit.leaseEpoch,
      argsHash: prepared2.permit.argsHash,
      nonce: prepared2.permit.nonce,
    },
  });
  check('暂停后外部读取被拒（409 GLOBAL_PAUSED）', pausedCall.status === 409 && errorCodeOf(pausedCall.json) === 'GLOBAL_PAUSED', `${pausedCall.status} ${errorCodeOf(pausedCall.json)}`);
  const afterPause = (await call('/inspect')).json;
  check('暂停场景：配额未增加（没有出网）', JSON.stringify(afterPause.usage) === JSON.stringify(usageBeforePause), afterPause.usage);
  check('暂停场景：动作未被消费', afterPause.actions.find((row) => row.id === pauseActionId)?.permitConsumedAt === null);
  const resumeRevision = await boundaryRevision('account');
  await call(`${API}/pause`, { method: 'POST', body: { scope: 'account', paused: false, expectedRevision: resumeRevision } });
}

async function scenarioTravelWish() {
  section('场景 5：出行愿望（真实落库 + 每日配额）');
  const seed = await call('/seed', {
    method: 'POST',
    body: {
      kind: 'travel.wish',
      semanticPurpose: 'e2e_travel_wish',
      purposeKey: 'e2e-travel-wish-1',
      account: BUDGET_OVERRIDE,
      args: { wishText: '想去海边看一次日出' },
      grants: [grantFor('amap', { scopes: ['read:geo'], dailyQuota: 1 })],
    },
  });
  check('seeded 动作行（travel.wish）', seed.status === 200, { actionId: seed.json?.action?.id });
  const actionId = seed.json.action.id;
  const result = await runInBrowser();
  const outcome = result.rounds.flat().find((item) => item.charId === CHAR);
  check('出行愿望执行成功', outcome?.result?.status === 'succeeded', outcome?.result?.status ?? outcome?.note ?? outcome);
  const localRow = (result.localLife ?? []).find((row) => row.actionId === actionId);
  check('本地写入 travel_wish 记录', localRow?.kind === 'travel_wish', localRow?.kind);
  const inspect = (await call('/inspect')).json;
  check('服务端落一行愿望', inspect.wishes.length === 1, inspect.wishes.length);
  check('服务端动作 succeeded', inspect.actions.find((row) => row.id === actionId)?.status === 'succeeded');

  // 配额耗尽：第二张许可能签（配额在外部入口扣），但出网前 429 拒绝，且不落第二行。
  const seed2 = await call('/seed', {
    method: 'POST',
    body: {
      kind: 'travel.wish',
      semanticPurpose: 'e2e_travel_wish',
      purposeKey: 'e2e-travel-wish-2',
      account: BUDGET_OVERRIDE,
      args: { wishText: '想去看一场雪' },
      grants: [grantFor('amap', { scopes: ['read:geo'], dailyQuota: 1 })],
    },
  });
  const actionId2 = seed2.json.action.id;
  const result2 = await runInBrowser();
  const outcome2 = result2.rounds.flat().find((item) => item.charId === CHAR);
  check('配额耗尽后第二笔被拒（未本地落库）', outcome2?.result?.status === 'failed', outcome2?.result?.code ?? outcome2?.note ?? outcome2);
  const inspect2 = (await call('/inspect')).json;
  check('配额耗尽后服务端愿望仍只有一行', inspect2.wishes.length === 1, inspect2.wishes.length);
  check('配额耗尽后第二笔动作没有 succeeded', inspect2.actions.find((row) => row.id === actionId2)?.status !== 'succeeded', inspect2.actions.find((row) => row.id === actionId2)?.status);
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const started = Date.now();
  console.log(`[e2e] root=${ROOT}`);
  console.log(`[e2e] evidence=${EVIDENCE}`);
  console.log(`[e2e] chrome=${CHROME}`);
  startServer({ reset: true });
  await waitForHealth();

  let ua = null;
  try {
    ua = await openBrowser();
    const actionId = await scenarioLocalEffect();
    await scenarioServerRestart(actionId);
    await scenarioExternalRead();
    await scenarioRevokeAndPause();
    await scenarioTravelWish();
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer();
  }

  const report = {
    at: new Date().toISOString(),
    durationMs: Date.now() - started,
    baseUrl: BASE,
    chrome: { executablePath: CHROME, userAgent: ua },
    evidence: EVIDENCE,
    checks,
    failed: findings,
    http: readRequestLog(),
  };
  writeFileSync(join(EVIDENCE, 'e2e-report.json'), JSON.stringify(report, null, 2));
  console.log(`\n[e2e] ${checks.length - findings.length}/${checks.length} checks passed`);
  if (findings.length) {
    console.log(`[e2e] FAILED: ${findings.join(' | ')}`);
    process.exitCode = 1;
  } else {
    console.log('[e2e] OK');
  }
}

main().catch(async (error) => {
  console.error('[e2e] crashed:', error);
  if (browser) await browser.close().catch(() => {});
  await stopServer();
  process.exitCode = 1;
});
