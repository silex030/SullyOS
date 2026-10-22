#!/usr/bin/env node
/**
 * SullyOS VPS · 备份源清单与一致性快照工具
 *
 * 备份源不是「数据目录里 *.sqlite glob」，而是 vps-backend/config/services.js
 * 里真实登记的 db（pathEnv / defaultPath / enableIf）。本工具做五件事：
 *
 *   list          —— 打印当前服务配置解析出的库清单（required / optional / 缺失 / 未登记）
 *   registry      —— 打印「当前配置认识的库名」白名单 + **name → 本机绝对路径** 映射
 *                    （恢复时的唯一映射依据）。⚠ 该输出含本机绝对路径，只供本机 CLI
 *                    （restore.sh）内部使用，绝不写进随包分享的 manifest。
 *   snapshot      —— 对每个 required 库做 VACUUM INTO 一致性快照、校验完整性，
 *                    生成 manifest.json；required 缺一个就 complete=false 并非零退出
 *   verify        —— 按 manifest 校验一个解包目录：文件名安全、文件齐、大小/sha256、
 *                    SQLite 完整性；--registry 时再与当前注册表求差集
 *   archive-check —— 解包前预检 tar 成员：禁止绝对路径 / ../ / symlink / hardlink /
 *                    设备节点 / 子目录；只允许扁平布局里的普通文件
 *
 * required vs optional（关键语义）：
 *   · db.enableIf 不存在或求值为 true  → 该库「当前启用」= required，磁盘上必须存在；
 *     路径配置错误（相对路径、父目录不存在、文件名非法、同名歧义）一律算 problem。
 *   · db.enableIf 求值为 false         → 显式未启用 = optional，不要求文件存在，
 *     manifest 里记 optional + reason，绝不假装它被备份了，也不因此判整包不完整。
 *
 * 用法：
 *   node db-manifest.mjs list          [--env-file /opt/sullyos/.env]
 *   node db-manifest.mjs registry      [--env-file ...]
 *   node db-manifest.mjs snapshot      --dir <快照目录> [--env-file ...] [--manifest-out <path>]
 *   node db-manifest.mjs verify        --dir <目录> [--manifest <path>] [--registry] [--env-file ...]
 *   node db-manifest.mjs archive-check --file <tar.gz>
 *
 * 退出码：0 成功；1 不完整/校验失败；2 用法或配置错误。
 * 本工具不加密、不上传、不动原库（快照只读源库）。manifest 不写宿主绝对路径。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(here, '../..');
const configPath = process.env.SULLYOS_SERVICES_CONFIG || path.join(backendDir, 'config/services.js');
const MANIFEST_VERSION = 2;
/** 旧包（v1）必须继续可验、可恢复：只是没有 required/optional 字段，靠注册表白名单映射。 */
const SUPPORTED_MANIFEST_VERSIONS = [1, 2];
/** 包内库名白名单形状：纯文件名、.sqlite 结尾，不含任何路径分隔符。 */
const SAFE_DB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.sqlite$/;

// ─────────────────────── 参数 ───────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    } else out._.push(a);
  }
  return out;
}

function usage(msg) {
  if (msg) console.error(`[manifest] ${msg}`);
  console.error('用法: db-manifest.mjs <list|registry|snapshot|verify|archive-check> [--env-file F] [--dir D] [--manifest M] [--file P] [--registry] [--allow-partial]');
  process.exit(2);
}

// ─────────────────────── .env 读取（不 source） ───────────────────────
function readEnvFile(file) {
  const out = {};
  if (!file || !existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(s);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function envFileFrom(opts) {
  const arg = opts['env-file'];
  return readEnvFile(arg ? path.resolve(String(arg)) : process.env.SULLYOS_ENV_FILE || '/opt/sullyos/.env');
}

// ─────────────────────── 服务配置 → 库清单 ───────────────────────
async function loadServices() {
  if (!existsSync(configPath)) throw new Error(`找不到服务配置: ${configPath}`);
  const mod = await import(pathToFileURL(configPath).href);
  const services = Array.isArray(mod.services) ? mod.services : [];
  if (services.length === 0) throw new Error(`服务配置里没有 services: ${configPath}`);
  return services;
}

function makeLookup(fileEnv) {
  return (key) => {
    if (!key) return '';
    const fromProc = (process.env[key] || '').trim();
    if (fromProc) return fromProc;
    return String(fileEnv[key] || '').trim();
  };
}

const isSafeDbName = (name) =>
  typeof name === 'string' && SAFE_DB_NAME.test(name) && name === path.basename(name) && !name.includes('\\');

/**
 * 把服务配置解析成「当前启用的 required 库」与「显式未启用的 optional 库」。
 * 返回的 problems 任何一条都会让备份不再宣称完整。
 */
function inspectServices(services, fileEnv) {
  const lookup = makeLookup(fileEnv);
  const envView = new Proxy({}, { get: (_t, key) => lookup(String(key)) });
  const problems = [];
  const optional = [];
  const entries = [];
  const byPath = new Map();

  for (const svc of services) {
    const db = svc && svc.db;
    if (!db) continue;
    const defaultName = db.defaultPath ? path.basename(db.defaultPath) : '';
    let enabled = true;
    if (typeof db.enableIf === 'function') {
      try {
        enabled = Boolean(db.enableIf(envView));
      } catch (err) {
        // 判断「是否启用」都出错的配置不能猜成 optional，那样会静默漏库
        problems.push({ service: svc.name, name: defaultName, code: 'enableif_error', error: String(err && err.message ? err.message : err) });
        enabled = true;
      }
    }
    if (!enabled) {
      optional.push({ service: svc.name, name: defaultName, reason: 'enableIf=false（当前显式未启用，不需要存在）' });
      continue;
    }

    const override = db.pathEnv ? lookup(db.pathEnv) : '';
    if (override && !path.isAbsolute(override)) {
      problems.push({ service: svc.name, name: defaultName, code: 'path_error', error: `${db.pathEnv} 必须是绝对路径（当前: ${override}）` });
      continue;
    }
    const raw = override || db.defaultPath || '';
    if (!raw) {
      problems.push({ service: svc.name, name: defaultName || '<unknown>', code: 'path_error', error: '服务配置里没有可用数据库路径' });
      continue;
    }
    const dbPath = path.resolve(raw);
    const name = path.basename(dbPath);
    if (!isSafeDbName(name)) {
      problems.push({ service: svc.name, name, code: 'path_error', error: `库文件名不合法（必须是纯文件名 *.sqlite）: ${name}` });
      continue;
    }
    if (!existsSync(path.dirname(dbPath))) {
      // 路径写错一个字符 / 挂载没起来：不能当成「库还没创建」而放过
      problems.push({ service: svc.name, name, code: 'path_error', error: `数据目录不存在: ${path.dirname(dbPath)}` });
      continue;
    }
    const present = existsSync(dbPath);
    const prev = byPath.get(dbPath);
    if (prev) {
      prev.services.push(svc.name); // 多个服务共用同一个库（如 amsg / instant-push 共用 AMSG_DB_PATH）
      continue;
    }
    const entry = { service: svc.name, services: [svc.name], bindKey: db.bindKey || 'DB', name, path: dbPath, present, required: true };
    byPath.set(dbPath, entry);
    entries.push(entry);
  }

  // 同名不同目录：恢复时按文件名映射必然有歧义 → 配置错误，不猜
  const byName = new Map();
  for (const e of entries) {
    if (!byName.has(e.name)) byName.set(e.name, []);
    byName.get(e.name).push(e);
  }
  const ambiguous = new Set();
  for (const [name, list] of byName) {
    if (list.length > 1) {
      for (const e of list) {
        ambiguous.add(e);
        problems.push({ service: e.service, name, code: 'path_error', error: `多个服务解析到同名但不同路径的库（${list.map((x) => x.path).join(' , ')}）` });
      }
    }
  }

  const usable = entries.filter((e) => !ambiguous.has(e));
  const absent = [];
  for (const e of usable) {
    if (!e.present) {
      absent.push({ service: e.service, name: e.name, required: true, code: 'missing_required' });
      problems.push({ service: e.service, name: e.name, code: 'missing_required', error: `已启用的库在磁盘上不存在: ${e.path}` });
    }
  }

  // 未登记的库：同目录下存在但不在服务配置里 → 只警告，不擅自扩面
  const unlisted = [];
  const dirs = [...new Set(usable.map((e) => path.dirname(e.path)))];
  const known = new Set(usable.map((e) => e.name));
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.sqlite') || known.has(f)) continue;
      unlisted.push(f);
    }
  }

  return { required: usable, absent, optional, problems, unlisted };
}

/**
 * 当前配置「认识的」所有库名（含显式未启用的）——恢复白名单的唯一来源。
 *
 * 除了名字，还给出每个名字在**本机**解析到的绝对路径（pathEnv 覆盖 > defaultPath），
 * 供 restore.sh 按真实落盘位置做同盘暂存/替换/回滚。同名库解析到不同目录时标记
 * ambiguous：恢复侧无法无歧义映射，必须拒绝而不是猜一个。
 */
function buildRegistry(services, fileEnv) {
  const lookup = makeLookup(fileEnv);
  const envView = new Proxy({}, { get: (_t, key) => lookup(String(key)) });
  const names = new Map();
  const problems = [];
  const add = (name, svc, enabled, absPath) => {
    if (!name) return;
    if (!isSafeDbName(name)) {
      problems.push({ service: svc, name, code: 'path_error', error: `库文件名不合法（必须是纯文件名 *.sqlite）: ${name}` });
      return;
    }
    const prev = names.get(name);
    if (prev) {
      prev.services = [...new Set([...prev.services, svc])];
      prev.enabled = prev.enabled || enabled;
      if (absPath && prev.path && prev.path !== absPath) {
        prev.ambiguous = true;
        prev.paths = [...new Set([...prev.paths, absPath])];
      }
      return;
    }
    names.set(name, {
      name,
      service: svc,
      services: [svc],
      enabled,
      path: absPath || '',
      dir: absPath ? path.dirname(absPath) : '',
      paths: absPath ? [absPath] : [],
      ambiguous: false,
    });
  };
  for (const svc of services) {
    const db = svc && svc.db;
    if (!db) continue;
    let enabled = true;
    if (typeof db.enableIf === 'function') {
      try { enabled = Boolean(db.enableIf(envView)); } catch { enabled = true; }
    }
    const defaultAbs = db.defaultPath ? path.resolve(db.defaultPath) : '';
    const overrideRaw = db.pathEnv ? lookup(db.pathEnv) : '';
    const overrideAbs = overrideRaw && path.isAbsolute(overrideRaw) ? path.resolve(overrideRaw) : '';
    if (overrideRaw && !overrideAbs) {
      problems.push({ service: svc.name, name: defaultAbs ? path.basename(defaultAbs) : '', code: 'path_error', error: `${db.pathEnv} 必须是绝对路径（当前: ${overrideRaw}）` });
    }
    // 每个服务只有一个真实落点：pathEnv 覆盖 > defaultPath（与 inspectServices 同一口径）。
    // 只登记这一个名字，避免「同名库两个候选目录」把生产恢复误判成歧义。
    const resolved = overrideAbs || defaultAbs;
    if (!resolved) continue;
    add(path.basename(resolved), svc.name, enabled, resolved);
  }
  const list = [...names.values()];
  for (const e of list) {
    if (e.ambiguous) {
      problems.push({ service: e.service, name: e.name, code: 'path_error', error: `同名库解析到多个目录（${e.paths.join(' , ')}），恢复无法无歧义映射` });
    }
  }
  const targets = {};
  for (const e of list) {
    targets[e.name] = {
      path: e.ambiguous ? '' : e.path,
      dir: e.ambiguous ? '' : e.dir,
      enabled: e.enabled,
      ambiguous: e.ambiguous,
    };
  }
  return {
    names: list,
    required: list.filter((n) => n.enabled).map((n) => n.name).sort(),
    optional: list.filter((n) => !n.enabled).map((n) => n.name).sort(),
    targets,
    problems,
  };
}

// ─────────────────────── SQLite 引擎（三层降级） ───────────────────────
let enginePromise;
async function sqliteEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      try {
        const requireFromBackend = createRequire(path.join(backendDir, 'package.json'));
        const Database = requireFromBackend('better-sqlite3');
        return { kind: 'better-sqlite3', Database };
      } catch { /* 继续降级 */ }
      try {
        const { DatabaseSync } = await import('node:sqlite');
        return { kind: 'node:sqlite', DatabaseSync };
      } catch { /* 继续降级 */ }
      return null;
    })();
  }
  return enginePromise;
}

const sqlQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** 一致性快照：源库只读打开，VACUUM INTO / backup() 生成副本。 */
async function snapshotDatabase(engine, srcPath, dstPath) {
  rmSync(dstPath, { force: true });
  if (engine.kind === 'better-sqlite3') {
    const db = new engine.Database(srcPath, { readonly: true, fileMustExist: true });
    try { await db.backup(dstPath); } finally { db.close(); }
  } else if (engine.kind === 'node:sqlite') {
    const db = new engine.DatabaseSync(srcPath);
    try { db.exec(`VACUUM INTO ${sqlQuote(dstPath)}`); } finally { db.close(); }
  } else {
    throw new Error('没有可用的 sqlite 实现（better-sqlite3 / node:sqlite）');
  }
}

/** PRAGMA integrity_check：只有单行 ok 才算通过。 */
function integrityCheck(engine, file) {
  if (engine.kind === 'better-sqlite3') {
    const db = new engine.Database(file, { readonly: true, fileMustExist: true });
    try {
      const rows = db.pragma('integrity_check');
      const first = Array.isArray(rows) && rows.length ? Object.values(rows[0])[0] : null;
      return { ok: first === 'ok', detail: String(first ?? 'unknown') };
    } finally { db.close(); }
  }
  const db = new engine.DatabaseSync(file);
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    const first = rows.length ? Object.values(rows[0])[0] : null;
    return { ok: first === 'ok', detail: String(first ?? 'unknown') };
  } finally { db.close(); }
}

const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// ─────────────────────── 子命令 ───────────────────────
async function cmdList(opts) {
  const fileEnv = envFileFrom(opts);
  const services = await loadServices();
  const { required, absent, optional, problems, unlisted } = inspectServices(services, fileEnv);
  console.log(JSON.stringify({
    manifestVersion: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    config: configPath,
    required: required.map((e) => ({ service: e.service, name: e.name, present: e.present })),
    optional,
    sources: required.map((e) => ({ service: e.service, services: e.services, bindKey: e.bindKey, name: e.name, path: e.path, present: e.present })),
    absent,
    problems,
    unlisted,
  }, null, 2));
  // list 是诊断视图：缺库/配错会写在 required/absent/problems 里，是否算失败由 snapshot 决定
  return 0;
}

async function cmdRegistry(opts) {
  const fileEnv = envFileFrom(opts);
  const services = await loadServices();
  const reg = buildRegistry(services, fileEnv);
  // localOnly：含本机绝对路径，只给本机 CLI 用，不要随包分享
  console.log(JSON.stringify({
    manifestVersion: MANIFEST_VERSION,
    config: path.basename(configPath),
    configPath,
    localOnly: true,
    ...reg,
  }, null, 2));
  for (const p of reg.problems) console.error(`[manifest] 注册表问题(${p.code || 'problem'}): ${p.service || '-'}/${p.name || '-'} — ${p.error || ''}`);
  return 0;
}

async function cmdSnapshot(opts) {
  const dir = opts.dir ? path.resolve(String(opts.dir)) : usage('snapshot 需要 --dir');
  const fileEnv = envFileFrom(opts);
  const services = await loadServices();
  const { required, absent, optional, problems: configProblems, unlisted } = inspectServices(services, fileEnv);
  mkdirSync(dir, { recursive: true });

  const engine = await sqliteEngine();
  const problems = [...configProblems];
  const done = [];

  for (const src of required) {
    if (!src.present) continue; // 缺失已由 inspectServices 记为 problem + absent
    const dst = path.join(dir, src.name);
    try {
      if (!engine) throw new Error('缺少 sqlite 实现');
      await snapshotDatabase(engine, src.path, dst);
      const integrity = integrityCheck(engine, dst);
      if (!integrity.ok) throw new Error(`integrity_check: ${integrity.detail}`);
      done.push({
        service: src.service,
        services: src.services,
        bindKey: src.bindKey,
        name: src.name,
        sizeBytes: statSync(dst).size,
        sha256: sha256File(dst),
        integrity: 'ok',
      });
    } catch (err) {
      problems.push({ service: src.service, name: src.name, code: 'snapshot_failed', error: String(err && err.message ? err.message : err) });
      rmSync(dst, { force: true });
    }
  }

  if (done.length === 0) problems.push({ service: '*', name: '*', code: 'no_sources', error: '没有任何可备份的数据库' });

  const requiredNames = required.map((e) => e.name).sort();
  const doneNames = new Set(done.map((d) => d.name));
  const missingRequired = requiredNames.filter((n) => !doneNames.has(n));
  const complete = problems.length === 0 && absent.length === 0 && missingRequired.length === 0;

  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    tool: 'db-manifest',
    createdAt: new Date().toISOString(),
    config: path.basename(configPath),
    complete,
    required: required.map((e) => ({ service: e.service, name: e.name })),
    optional,
    sources: done,
    absent,
    unlisted,
    problems,
  };
  const manifestOut = path.resolve(String(opts['manifest-out'] || path.join(dir, 'manifest.json')));
  writeFileSync(manifestOut, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  console.log(JSON.stringify(manifest, null, 2));
  for (const p of problems) console.error(`[manifest] 失败(${p.code || 'problem'}): ${p.service}/${p.name} — ${p.error || ''}`);
  for (const name of unlisted) console.error(`[manifest] 警告: 数据目录里有未登记的库，不会进备份: ${name}`);
  return complete ? 0 : 1;
}

function validateManifestName(name) {
  return isSafeDbName(name);
}

async function cmdVerify(opts) {
  const dir = opts.dir ? path.resolve(String(opts.dir)) : usage('verify 需要 --dir');
  const manifestPath = path.resolve(String(opts.manifest || path.join(dir, 'manifest.json')));
  const problems = [];
  const warnings = [];

  if (!existsSync(manifestPath)) {
    console.error(`[manifest] 缺少 manifest: ${manifestPath}`);
    console.log(JSON.stringify({ ok: false, checked: 0, problems: ['manifest_missing'] }));
    return 2;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    console.error(`[manifest] manifest 解析失败: ${err.message}`);
    console.log(JSON.stringify({ ok: false, checked: 0, problems: ['manifest_invalid_json'] }));
    return 1;
  }

  if (!SUPPORTED_MANIFEST_VERSIONS.includes(manifest.manifestVersion)) problems.push('manifest_version_unsupported');
  if (manifest.complete !== true) problems.push('manifest_incomplete');
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) problems.push('manifest_no_sources');

  const sources = Array.isArray(manifest.sources) ? manifest.sources : [];

  // v2 的 required 语义：声明了必须备份的库，就必须真的在包里有快照
  const sourceNames = new Set(sources.map((s) => s.name));
  if (manifest.manifestVersion >= 2 && Array.isArray(manifest.required)) {
    for (const r of manifest.required) {
      if (!sourceNames.has(r && r.name)) problems.push(`${r && r.name}:missing_required`);
    }
  }
  for (const a of Array.isArray(manifest.absent) ? manifest.absent : []) {
    if (a && a.required) problems.push(`${a.name}:absent_required`);
  }

  // 包内库名：必须是纯文件名，拒绝 ../、绝对路径、子目录、反斜杠
  const safeNames = [];
  for (const src of sources) {
    const name = String(src && src.name || '');
    if (!name) { problems.push('source_without_name:bad_name'); continue; }
    if (!validateManifestName(name)) { problems.push(`${name}:bad_name`); continue; }
    safeNames.push(name);
  }

  const engine = await sqliteEngine();
  const checked = [];
  for (const src of sources) {
    const name = String(src && src.name || '');
    if (!validateManifestName(name)) continue; // bad_name 已记录，绝不按这个名字拼路径
    const file = path.join(dir, name);
    if (!existsSync(file)) { problems.push(`${name}:missing`); continue; }
    const size = statSync(file).size;
    if (typeof src.sizeBytes === 'number' && size !== src.sizeBytes) problems.push(`${name}:size_mismatch`);
    if (typeof src.sha256 === 'string' && sha256File(file) !== src.sha256) problems.push(`${name}:sha256_mismatch`);
    try {
      if (!engine) throw new Error('缺少 sqlite 实现');
      const integrity = integrityCheck(engine, file);
      if (!integrity.ok) problems.push(`${name}:integrity_${integrity.detail}`);
    } catch (err) {
      problems.push(`${name}:not_a_database`);
    }
    checked.push(name);
  }

  // 夹带：目录里有 manifest 之外的 .sqlite（例如事故包里混进来的 alpha/beta）
  if (existsSync(dir)) {
    const listed = new Set(safeNames);
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.sqlite') && !listed.has(f)) problems.push(`extra_sqlite:${f}`);
    }
  }

  // 白名单 + 必填子集：包里的库必须在当前服务注册表里，且**当前启用的必填库必须全在包里**
  // （--registry 时启用）。包内的 complete/required 是不可信输入，只能用来做包自身一致性检查，
  // 绝不能拿它证明「这次恢复是完整的」。
  let partial = false;
  if (opts.registry) {
    const fileEnv = envFileFrom(opts);
    const services = await loadServices();
    const reg = buildRegistry(services, fileEnv);
    const known = new Set(reg.names.map((n) => n.name));
    const enabled = new Set(reg.required);
    for (const name of safeNames) {
      if (!known.has(name)) problems.push(`unknown_db:${name}`);
      else if (!enabled.has(name)) warnings.push(`known_disabled:${name}`);
      if (known.has(name) && reg.targets[name] && reg.targets[name].ambiguous) problems.push(`ambiguous_target:${name}`);
    }
    const missingRequired = reg.required.filter((n) => !safeNames.includes(n));
    const allowPartial = opts['allow-partial'] === true;
    for (const name of missingRequired) {
      if (allowPartial) warnings.push(`partial_missing_required:${name}`);
      else problems.push(`missing_required_db:${name}`);
    }
    partial = allowPartial && missingRequired.length > 0;
    if (partial) console.error(`[manifest] 部分恢复：以下当前启用的必填库不在包内（--allow-partial）: ${missingRequired.join(', ')}`);
  }

  const ok = problems.length === 0;
  console.log(JSON.stringify({ ok, checked, problems, warnings, partial }, null, 2));
  for (const p of problems) {
    console.error(`[manifest] 校验失败: ${p}`);
    if (String(p).startsWith('missing_required_db:')) {
      console.error(`[manifest] 说明: 当前服务配置里 ${String(p).slice('missing_required_db:'.length)} 是启用中的必填库，包内没有它的快照，不能当完整恢复。`);
      console.error('[manifest] 如确为部分恢复，必须显式加 --allow-partial（默认拒绝）。');
    }
    if (String(p).startsWith('unknown_db:')) {
      console.error(`[manifest] 说明: ${String(p).slice('unknown_db:'.length)} 不在当前服务注册表里，绝不安装外来库。`);
    }
  }
  for (const w of warnings) {
    if (String(w).startsWith('known_disabled:')) {
      console.error(`[manifest] 警告: 包内库 ${String(w).slice('known_disabled:'.length)} 在当前服务配置里未启用（恢复后该服务不会使用它）`);
    } else {
      console.error(`[manifest] 警告: ${w}`);
    }
  }
  return ok ? 0 : 1;
}

// ─────────────────────── 解包前预检 ───────────────────────
function normalizeMemberName(raw) {
  let name = String(raw);
  while (name.startsWith('./')) name = name.slice(2);
  if (name === '.') return '';
  return name;
}

function cmdArchiveCheck(opts) {
  const file = opts.file ? path.resolve(String(opts.file)) : usage('archive-check 需要 --file');
  if (!existsSync(file)) {
    console.log(JSON.stringify({ ok: false, members: [], problems: ['archive_missing'] }));
    return 2;
  }
  const names = spawnSync('tar', ['-tzf', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (names.status !== 0) {
    console.log(JSON.stringify({ ok: false, members: [], problems: ['archive_unreadable'] }));
    console.error(`[manifest] 无法读取归档: ${(names.stderr || '').trim()}`);
    return 1;
  }
  const verbose = spawnSync('tar', ['-tvzf', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const nameList = (names.stdout || '').split('\n').filter(Boolean);
  const verboseList = (verbose.stdout || '').split('\n').filter(Boolean);
  const problems = [];
  const members = [];

  if (nameList.length > 2000) problems.push('archive_too_many_members');

  for (let i = 0; i < nameList.length; i += 1) {
    const raw = nameList[i];
    const info = verboseList[i] || '';
    const type = info.charAt(0);
    const normalized = normalizeMemberName(raw);
    const label = normalized || raw;

    // 类型：只允许普通文件与目录
    if (type === 'l') problems.push(`unsafe_member:symlink:${label}`);
    else if (type === 'h') problems.push(`unsafe_member:hardlink:${label}`);
    else if (type === 'b' || type === 'c') problems.push(`unsafe_member:device:${label}`);
    else if (type === 'p') problems.push(`unsafe_member:fifo:${label}`);
    else if (type !== '-' && type !== 'd') problems.push(`unsafe_member:type_${type || 'unknown'}:${label}`);

    // 路径：扁平布局，禁止绝对路径 / 反斜杠 / .. / 子目录
    if (!normalized) {
      members.push({ name: raw, type: 'dir' });
      continue;
    }
    if (path.isAbsolute(raw) || raw.startsWith('/') || raw.startsWith('\\')) problems.push(`unsafe_member:absolute:${label}`);
    if (normalized.includes('\\')) problems.push(`unsafe_member:backslash:${label}`);
    if (normalized.split('/').some((seg) => seg === '..')) problems.push(`unsafe_member:dotdot:${label}`);

    // 包是平铺的：只允许一层文件名（directory 条目由上面 continue 处理）
    if (type === '-' && normalized.includes('/')) problems.push(`unsafe_member:subdir:${label}`);
    members.push({ name: normalized, type });
  }

  const fileMembers = members.filter((m) => m.type === '-').map((m) => m.name);
  if (!fileMembers.includes('manifest.json')) problems.push('manifest_missing_in_archive');
  if (!fileMembers.some((n) => n.endsWith('.sqlite'))) problems.push('archive_no_database');

  const ok = problems.length === 0;
  console.log(JSON.stringify({ ok, members: fileMembers, problems }, null, 2));
  for (const p of problems) console.error(`[manifest] 归档预检失败: ${p}`);
  return ok ? 0 : 1;
}

// ─────────────────────── 入口 ───────────────────────
const argv = process.argv.slice(2);
const opts = parseArgs(argv);
const cmd = opts._[0];
try {
  if (!cmd || opts.help) usage();
  if (cmd === 'list') process.exitCode = await cmdList(opts);
  else if (cmd === 'registry') process.exitCode = await cmdRegistry(opts);
  else if (cmd === 'snapshot') process.exitCode = await cmdSnapshot(opts);
  else if (cmd === 'verify') process.exitCode = await cmdVerify(opts);
  else if (cmd === 'archive-check') process.exitCode = cmdArchiveCheck(opts);
  else usage(`未知子命令: ${cmd}`);
} catch (err) {
  console.error(`[manifest] ${err && err.message ? err.message : err}`);
  process.exitCode = 2;
}
