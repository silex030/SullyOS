// vps-backend/deploy/scripts/__tests__/sandbox.ts
// 备份/恢复脚本的测试沙箱。
//
// 隔离口径（事故报告的整改要求）：环境变量 + fake PATH 不足以证明隔离。
// 因此每次脚本执行都放进 `unshare -m -n` 的 mount + net 命名空间：
//   · mount namespace：先 `mount -t tmpfs tmpfs /opt/sullyos`，把生产数据目录、
//     备份目录、部署仓和 .env 全部遮蔽；再把 /var/log 遮蔽成空 tmpfs，
//     连硬编码的 /var/log/sullyos-backup.log 也写不到真实文件。
//   · net namespace：新命名空间没有可用网卡，任何上传必然失败。
// 命名空间不可用时**直接报不能跑**（run() 抛错），绝不退回「只靠假 PATH」执行。
//
// 生产护栏：运行前后对生产文件做 sha256 + size + mtime 快照（内容哈希，不只文件名）。
// 唯一容忍的是本机 sullyos.service 正在写的 -wal/-shm（在线库自身活动），
// 其余任何内容变化、文件增删都会让测试失败。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BACKEND_DIR = path.resolve(SCRIPTS_DIR, '../..');
export const REAL_SERVICES_CONFIG = path.join(BACKEND_DIR, 'config/services.js');
export const BACKUP_SH = path.join(SCRIPTS_DIR, 'backup.sh');
export const RESTORE_SH = path.join(SCRIPTS_DIR, 'restore.sh');
export const MANIFEST_TOOL = path.join(SCRIPTS_DIR, 'db-manifest.mjs');

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
}

export interface Sandbox {
  root: string;
  dataDir: string;
  backupDir: string;
  logFile: string;
  envFile: string;
  servicesConfig: string;
  binDir: string;
  fakeLog: string;
  writeEnv(kv: Record<string, string>): void;
  makeDb(file: string, marker?: string): void;
  makeGarbageDb(file: string): void;
  dbMarker(file: string): string;
  run(script: string, args: string[], env?: Record<string, string>, cwd?: string): RunResult;
  runTool(args: string[], env?: Record<string, string>): RunResult;
  /** 在同一个隔离命名空间里跑任意命令（用于证明遮蔽真的生效）。 */
  runIsolated(command: string, args: string[], env?: Record<string, string>): RunResult;
  seedPackage(name: string, ageSeconds?: number): string;
  cleanup(): void;
  fakeLogLines(): string[];
}

// ─────────────────────── 命名空间隔离 ───────────────────────
const ISOLATION_PROBE_SCRIPT = `
set -e
mount -t tmpfs tmpfs /opt/sullyos 2>/dev/null || { echo ISOLATION_MOUNT_FAILED >&2; exit 90; }
[ -d /var/log ] && { mount -t tmpfs tmpfs /var/log 2>/dev/null || { echo ISOLATION_LOG_MASK_FAILED >&2; exit 91; }; }
if [ -e /opt/sullyos/data ]; then echo ISOLATION_MASK_INCOMPLETE >&2; exit 92; fi
echo ISOLATION_OK
`;

const probe = spawnSync('unshare', ['-m', '-n', '--propagation', 'private', '/bin/bash', '-c', ISOLATION_PROBE_SCRIPT], {
  encoding: 'utf8',
  timeout: 30_000,
});

export const ISOLATION = {
  available: probe.status === 0 && (probe.stdout || '').includes('ISOLATION_OK'),
  detail: probe.status === 0
    ? (probe.stdout || '').trim()
    : `unshare 探测失败（status=${probe.status}）: ${(probe.stderr || probe.error?.message || '').trim()}`,
  wrapper: 'unshare -m -n --propagation private',
};

function assertIsolation(): void {
  if (!ISOLATION.available) {
    throw new Error(
      `[sandbox] 环境不支持 mount+net 命名空间隔离，拒绝在未隔离状态下执行备份/恢复脚本：${ISOLATION.detail}`,
    );
  }
}

/** 命名空间内先遮蔽生产面，再 exec 目标命令。 */
function isolatedSpawn(command: string, args: string[], options: { cwd?: string; env: Record<string, string> }) {
  assertIsolation();
  const prelude = `
set -e
mount -t tmpfs tmpfs /opt/sullyos 2>/dev/null || { echo "[sandbox] ISOLATION_MOUNT_FAILED" >&2; exit 90; }
[ -d /var/log ] && { mount -t tmpfs tmpfs /var/log 2>/dev/null || { echo "[sandbox] ISOLATION_LOG_MASK_FAILED" >&2; exit 91; }; }
cd "$SANDBOX_CWD" 2>/dev/null || cd /
exec "$@"
`;
  return spawnSync(
    'unshare',
    ['-m', '-n', '--propagation', 'private', '/bin/bash', '-c', prelude, 'sandbox-isolation', command, ...args],
    {
      cwd: options.cwd,
      encoding: 'utf8',
      env: { ...options.env, SANDBOX_CWD: options.cwd || '/' },
      timeout: 180_000,
    },
  );
}

// ─────────────────────── 生产面内容快照 ───────────────────────
// 本机就是 VPS：/opt/sullyos 是活的。只比文件名不够——覆盖内容文件名不变。
const PROD_DIRS = ['/opt/sullyos/data', '/opt/sullyos/backups', '/opt/sullyos/backups/webdav'];
const PROD_FILES = ['/opt/sullyos/.env', '/var/log/sullyos-backup.log', '/opt/sullyos/sullyos-repo/.git/HEAD'];

export type Snapshot = Record<string, string>;

const sha256File = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

function walk(dir: string, depth = 0): string[] {
  if (depth > 3) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const full = path.join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walk(full, depth + 1));
    else if (st.isFile()) out.push(full);
  }
  return out;
}

/** 生产面快照：路径 → size:sha256:mtimeMs。内容变了哈希就变。 */
export function prodSnapshot(): Snapshot {
  const files = [...PROD_DIRS.flatMap((d) => walk(d)), ...PROD_FILES];
  const snap: Snapshot = {};
  for (const file of files) {
    try {
      const st = statSync(file);
      snap[file] = `${st.size}:${sha256File(file)}:${Math.trunc(st.mtimeMs)}`;
    } catch {
      snap[file] = 'unreadable';
    }
  }
  return snap;
}

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  changed: string[];
  tolerated: string[];
}

/** 纯函数：对比两次快照。容忍在线库自身的 -wal/-shm 活动（服务在写，不是测试写的）。 */
export function diffSnapshots(before: Snapshot, after: Snapshot): SnapshotDiff {
  const added = Object.keys(after).filter((k) => !(k in before));
  const removed = Object.keys(before).filter((k) => !(k in after));
  const changed = Object.keys(after).filter((k) => k in before && before[k] !== after[k]);
  const isWal = (f: string) => /-(wal|shm)$/.test(f);
  const tolerated = changed.filter(isWal);
  return { added, removed, changed: changed.filter((f) => !isWal(f)), tolerated };
}

function serviceActive(): boolean {
  const r = spawnSync('systemctl', ['is-active', 'sullyos.service'], { encoding: 'utf8', timeout: 10_000 });
  return (r.stdout || '').trim() === 'active';
}

function assertProdUnchanged(before: Snapshot, diff: SnapshotDiff): void {
  // 在线库的 -wal 由服务自己追加；容忍它，但必须打印出来，不能静默。
  if (diff.tolerated.length) {
    console.warn(`[sandbox] 在线库 WAL/SHM 活动（服务 active=${serviceActive()}）: ${diff.tolerated.join(', ')}`);
  }
  if (diff.added.length || diff.removed.length || diff.changed.length) {
    const fmt = (xs: string[]) => xs.map((f) => {
      const b = before[f] ?? '(absent)';
      return `${f}\n      before: ${b}\n      after:  ${JSON.stringify(f)}`;
    }).join('\n    ');
    throw new Error(
      '[sandbox] 测试改动了真实生产面，必须修脚本/测试：\n' +
      `  added:   ${diff.added.join(', ') || '-'}\n` +
      `  removed: ${diff.removed.join(', ') || '-'}\n` +
      `  changed: ${diff.changed.join(', ') || '-'}\n  ${fmt([...diff.added, ...diff.removed, ...diff.changed])}`,
    );
  }
}

// ─────────────────────── fake 命令 ───────────────────────
const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
printf 'systemctl %s\\n' "$*" >> "\${FAKE_LOG:-/dev/null}"
case "\${1:-}" in
  stop) exit "\${FAKE_STOP_EXIT:-0}" ;;
  start) exit "\${FAKE_START_EXIT:-0}" ;;
esac
exit 0
`;

const FAKE_CP = `#!/usr/bin/env bash
printf 'cp %s\\n' "$*" >> "\${FAKE_LOG:-/dev/null}"
dest=""
for a in "$@"; do dest="$a"; done
if [ -n "\${FAKE_CP_FAIL_MATCH:-}" ]; then
  case "$dest" in
    *"\${FAKE_CP_FAIL_MATCH}"*) echo "fake cp: injected failure -> $dest" >&2; exit 1 ;;
  esac
fi
exec /bin/cp "$@"
`;

export const FIXTURE_SERVICES_CONFIG = `// 测试用服务清单：结构与 vps-backend/config/services.js 一致
import path from 'node:path';
// 数据目录可由沙箱注入（默认 /fixture 只是占位，脚本绝不会真往那儿写）
const dataDir = process.env.SULLYOS_FIXTURE_DATA_DIR || '/fixture/sullyos/vps-backend/data';
export const repoRoot = '/fixture/sullyos';
export { dataDir };
export const services = [
  {
    name: 'alpha',
    port: 9001,
    enabled: true,
    db: { bindKey: 'DB', pathEnv: 'ALPHA_DB_PATH', defaultPath: path.join(dataDir, 'alpha.sqlite'), enableIf: () => true },
  },
  {
    name: 'beta',
    port: 9002,
    enabled: true,
    db: { bindKey: 'DB', pathEnv: 'BETA_DB_PATH', defaultPath: path.join(dataDir, 'beta.sqlite'), enableIf: (p) => p.BETA_ENABLE === 'true' },
  },
  {
    name: 'gamma',
    port: 9004,
    enabled: true,
    db: { bindKey: 'DB', pathEnv: 'GAMMA_DB_PATH', defaultPath: path.join(dataDir, 'gamma.sqlite'), enableIf: (p) => p.GAMMA_ENABLE === 'true' },
  },
  {
    name: 'no-db-service',
    port: 9003,
    enabled: true,
  },
];
`;

// 会泄漏生产凭据的环境变量名：测试子进程一律不许带。
const SECRET_ENV = /(^|_)(PAT|TOKEN|SECRET|KEY|PASSWORD)$|PASS$/;
const SECRET_ENV_ALLOW = new Set(['BACKUP_ENCRYPT_PASSPHRASE']);

function assertNoSecrets(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (SECRET_ENV_ALLOW.has(key)) continue;
    if (SECRET_ENV.test(key) && env[key]) {
      throw new Error(`[sandbox] 拒绝把疑似生产凭据传给子进程: ${key}（测试请用假值并在沙箱内自建）`);
    }
  }
}

export function makeSandbox(opts: { servicesConfig?: 'real' | 'fixture'; env?: Record<string, string> } = {}): Sandbox {
  assertIsolation();
  const root = mkdtempSync(path.join(tmpdir(), 'sullyos-backend-safety-'));
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const binDir = path.join(root, 'fakebin');
  const logFile = path.join(root, 'logs/sullyos-backup.log');
  const envFile = path.join(root, '.env');
  const fakeLog = path.join(root, 'fake.log');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(path.dirname(logFile), { recursive: true });
  mkdirSync(path.join(root, 'tmp'), { recursive: true });
  writeFileSync(path.join(binDir, 'systemctl'), FAKE_SYSTEMCTL, { mode: 0o755 });
  writeFileSync(path.join(binDir, 'cp'), FAKE_CP, { mode: 0o755 });
  chmodSync(path.join(binDir, 'systemctl'), 0o755);
  chmodSync(path.join(binDir, 'cp'), 0o755);

  let servicesConfig = REAL_SERVICES_CONFIG;
  if (opts.servicesConfig === 'fixture') {
    servicesConfig = path.join(root, 'fixture-services.js');
    writeFileSync(servicesConfig, FIXTURE_SERVICES_CONFIG);
  }

  writeFileSync(envFile, '# test env\n');
  writeFileSync(fakeLog, '');
  // 沙箱内的“生产布局”指针：即使被测脚本还要读 .env 里的 AMSG_DATA_DIR/DUFS_ROOT，
  // 也必须落在临时目录里（历史脚本曾因此把测试库写进 /opt/sullyos/data）。
  const containmentEnv: Record<string, string> = {
    AMSG_DATA_DIR: dataDir,
    DUFS_ROOT: backupDir,
    BACKUP_ENCRYPT_PASSPHRASE: '',
    SULLYOS_LOG_FILE: logFile,
  };
  const prodBefore = prodSnapshot();

  const baseEnv = (): Record<string, string> => ({
    PATH: `${binDir}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
    HOME: root,
    TMPDIR: path.join(root, 'tmp'),
    SULLYOS_ENV_FILE: envFile,
    SULLYOS_DATA_DIR: dataDir,
    SULLYOS_BACKUP_DIR: backupDir,
    SULLYOS_REPO_DIR: path.join(root, 'no-such-repo'),
    SULLYOS_SERVICES_CONFIG: servicesConfig,
    SULLYOS_FIXTURE_DATA_DIR: dataDir,
    SULLYOS_LOG_FILE: logFile,
    FAKE_LOG: fakeLog,
    ...(opts.env || {}),
  });

  const sb: Sandbox = {
    root,
    dataDir,
    backupDir,
    logFile,
    envFile,
    servicesConfig,
    binDir,
    fakeLog,
    writeEnv(kv) {
      const merged = { ...containmentEnv, ...kv };
      const lines = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
      writeFileSync(envFile, `${['# test env', ...lines].join('\n')}\n`);
    },
    makeDb(file, marker = 'seed') {
      mkdirSync(path.dirname(file), { recursive: true });
      const sql = `CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('${marker}');`;
      const r = spawnSync('sqlite3', [file, sql], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`sqlite3 不可用或建库失败: ${r.stderr || r.error}`);
    },
    makeGarbageDb(file) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'this is definitely not a sqlite database\n'.repeat(8));
    },
    dbMarker(file) {
      const r = spawnSync('sqlite3', [file, 'SELECT v FROM t ORDER BY id DESC LIMIT 1;'], { encoding: 'utf8' });
      if (r.status !== 0) return `__error__:${r.stderr}`;
      return (r.stdout || '').trim();
    },
    run(script, args, env = {}, cwd = root) {
      const childEnv = { ...baseEnv(), ...env };
      assertNoSecrets(childEnv);
      const r = isolatedSpawn('/bin/bash', [script, ...args], { cwd, env: childEnv });
      return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', output: `${r.stdout || ''}${r.stderr || ''}` };
    },
    runTool(args, env = {}) {
      const childEnv = { ...baseEnv(), ...env };
      assertNoSecrets(childEnv);
      const r = isolatedSpawn(process.execPath, [MANIFEST_TOOL, ...args], { cwd: root, env: childEnv });
      return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', output: `${r.stdout || ''}${r.stderr || ''}` };
    },
    runIsolated(command, args, env = {}) {
      const childEnv = { ...baseEnv(), ...env };
      assertNoSecrets(childEnv);
      const r = isolatedSpawn(command, args, { cwd: root, env: childEnv });
      return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', output: `${r.stdout || ''}${r.stderr || ''}` };
    },
    seedPackage(name, ageSeconds = 0) {
      const file = path.join(backupDir, name);
      writeFileSync(file, `seeded-package-${name}\n`);
      if (ageSeconds > 0) {
        const t = Math.floor(Date.now() / 1000) - ageSeconds;
        utimesSync(file, t, t);
      }
      return file;
    },
    cleanup() {
      // 先核对生产面（内容哈希），再删沙箱；即使断言失败也保留沙箱目录便于取证。
      const prodAfter = prodSnapshot();
      const diff = diffSnapshots(prodBefore, prodAfter);
      try {
        assertProdUnchanged(prodBefore, diff);
      } catch (err) {
        console.error(`[sandbox] 沙箱保留供取证: ${root}`);
        throw err;
      }
      rmSync(root, { recursive: true, force: true });
    },
    fakeLogLines() {
      if (!existsSync(fakeLog)) return [];
      return readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean);
    },
  };
  return sb;
}

/** 解包后目录里的文件名 → 便于断言包内容。 */
export function listTar(pkg: string): string[] {
  const r = spawnSync('tar', ['-tzf', pkg], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar -tzf 失败: ${r.stderr}`);
  return (r.stdout || '').split('\n').filter(Boolean).map((l: string) => l.replace(/^\.\//, ''));
}

export function extractTar(pkg: string, dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('tar', ['-xzf', pkg, '-C', dir], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar -xzf 失败: ${r.stderr}`);
  return listTar(pkg);
}

export function readJson<T = any>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}
