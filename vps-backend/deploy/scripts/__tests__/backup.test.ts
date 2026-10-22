// vps-backend/deploy/scripts/__tests__/backup.test.ts
// B5：备份源来自真实服务配置 + manifest；部分失败非零退出；不完整包不轮转。
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BACKUP_SH, extractTar, listTar, makeSandbox, readJson, type Sandbox } from './sandbox';

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const tarGzIn = (dir: string) =>
  readdirSync(dir).filter((n: string) => n.startsWith('sullyos-data-') && n.includes('.tar.gz')).sort();

let sb: Sandbox;
afterEach(() => sb?.cleanup());

describe('backup.sh · 备份源与 manifest', () => {
  it('只打包服务配置里登记的库，并在 manifest 里写 sha256', () => {
    sb = makeSandbox({ servicesConfig: 'fixture', env: { BACKUP_KEEP: '7' } });
    const alpha = path.join(sb.dataDir, 'alpha.sqlite');
    const beta = path.join(sb.dataDir, 'beta.sqlite');
    sb.writeEnv({
      ALPHA_DB_PATH: alpha,
      BETA_DB_PATH: beta,
      BETA_ENABLE: 'true',
      BACKUP_KEEP: '7',
      DUFS_ROOT: sb.backupDir,
    });
    sb.makeDb(alpha, 'alpha-v1');
    sb.makeDb(beta, 'beta-v1');
    sb.makeDb(path.join(sb.dataDir, 'orphan.sqlite'), 'orphan'); // 未登记 → 只警告不打包

    const r = sb.run(BACKUP_SH, []);
    expect(r.status, r.output).toBe(0);

    const pkgs = tarGzIn(sb.backupDir);
    expect(pkgs.length).toBe(1);
    const pkg = path.join(sb.backupDir, pkgs[0]);
    const entries = listTar(pkg);
    expect(entries).toContain('manifest.json');
    expect(entries.sort()).toEqual(['alpha.sqlite', 'beta.sqlite', 'manifest.json']);

    const outDir = path.join(sb.root, 'unpacked');
    extractTar(pkg, outDir);
    const manifest = readJson<{ complete: boolean; sources: { name: string; sha256: string }[] }>(path.join(outDir, 'manifest.json'));
    expect(manifest.complete).toBe(true);
    expect(manifest.sources.map((s) => s.name).sort()).toEqual(['alpha.sqlite', 'beta.sqlite']);
    for (const src of manifest.sources) {
      expect(src.sha256).toBe(sha256(path.join(outDir, src.name)));
    }
    // 未登记的库不能进包，但必须提醒运维
    expect(r.output).toContain('orphan.sqlite');
  });

  it('单个库快照失败：非零退出、不产出新包、既有完整备份一个都不删', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const alpha = path.join(sb.dataDir, 'alpha.sqlite');
    const beta = path.join(sb.dataDir, 'beta.sqlite');
    // AMSG_BACKUP_KEEP=2：如果脚本错误地轮转，老包会被删掉
    sb.writeEnv({ ALPHA_DB_PATH: alpha, BETA_DB_PATH: beta, BETA_ENABLE: 'true', BACKUP_KEEP: '2', DUFS_ROOT: sb.backupDir });
    sb.makeDb(alpha, 'alpha-v1');
    sb.makeGarbageDb(beta);
    const seeded = [
      sb.seedPackage('sullyos-data-20261020-000003.tar.gz', 300),
      sb.seedPackage('sullyos-data-20261020-000002.tar.gz', 200),
      sb.seedPackage('sullyos-data-20261020-000001.tar.gz', 100),
    ];

    const r = sb.run(BACKUP_SH, []);
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toContain('beta.sqlite');
    for (const pkg of seeded) expect(existsSync(pkg)).toBe(true);
    expect(tarGzIn(sb.backupDir).length).toBe(3); // 没有新包
  });

  it('完整包才轮转：成功后按 BACKUP_KEEP 只保留最新 N 份', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const alpha = path.join(sb.dataDir, 'alpha.sqlite');
    sb.writeEnv({ ALPHA_DB_PATH: alpha, BETA_ENABLE: 'false', BACKUP_KEEP: '3', DUFS_ROOT: sb.backupDir });
    sb.makeDb(alpha, 'alpha-v1');
    const old = [
      sb.seedPackage('sullyos-data-20261019-000004.tar.gz', 400),
      sb.seedPackage('sullyos-data-20261019-000003.tar.gz', 300),
      sb.seedPackage('sullyos-data-20261019-000002.tar.gz', 200),
      sb.seedPackage('sullyos-data-20261019-000001.tar.gz', 100),
    ];

    const r = sb.run(BACKUP_SH, []);
    expect(r.status, r.output).toBe(0);
    const pkgs = tarGzIn(sb.backupDir);
    expect(pkgs.length).toBe(3);
    expect(pkgs.some((n) => !old.some((o) => path.basename(o) === n))).toBe(true); // 新包在
    expect(existsSync(old[2])).toBe(true); // 较新的两份保留
    expect(existsSync(old[3])).toBe(true);
    expect(existsSync(old[0])).toBe(false); // 最老的两份被轮转
    expect(existsSync(old[1])).toBe(false);
  });

  it('配置了口令时产出 .enc 包（生产路径：AES-256 加密）', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const alpha = path.join(sb.dataDir, 'alpha.sqlite');
    sb.writeEnv({
      ALPHA_DB_PATH: alpha,
      BETA_ENABLE: 'false',
      BACKUP_ENCRYPT_PASSPHRASE: 'test-passphrase',
      BACKUP_KEEP: '3',
      DUFS_ROOT: sb.backupDir,
    });
    sb.makeDb(alpha, 'alpha-v1');

    const r = sb.run(BACKUP_SH, []);
    expect(r.status, r.output).toBe(0);
    const encs = readdirSync(sb.backupDir).filter((n: string) => n.endsWith('.tar.gz.enc'));
    expect(encs.length).toBe(1);
    // 加密包里不能出现明文 SQLite 头
    const raw = readFileSync(path.join(sb.backupDir, encs[0]));
    expect(raw.includes('SQLite format 3')).toBe(false);
  });

  it('用真实 config/services.js 跑通：四个真实库全部进包', () => {
    sb = makeSandbox({ servicesConfig: 'real' });
    const paths = {
      amsg: path.join(sb.dataDir, 'amsg.sqlite'),
      proactive: path.join(sb.dataDir, 'proactive-push.sqlite'),
      heartbeat: path.join(sb.dataDir, 'heartbeat.sqlite'),
      home: path.join(sb.dataDir, 'sullyos-home.sqlite'),
    };
    sb.writeEnv({
      AMSG_DB_PATH: paths.amsg,
      PROACTIVE_DB_PATH: paths.proactive,
      HEARTBEAT_DB_PATH: paths.heartbeat,
      HOME_DB_PATH: paths.home,
      BACKUP_KEEP: '7',
      DUFS_ROOT: sb.backupDir,
    });
    for (const [marker, file] of Object.entries(paths)) sb.makeDb(file, marker);

    const r = sb.run(BACKUP_SH, []);
    expect(r.status, r.output).toBe(0);
    const pkgs = tarGzIn(sb.backupDir);
    expect(pkgs.length).toBe(1);
    const entries = listTar(path.join(sb.backupDir, pkgs[0]));
    expect(entries.sort()).toEqual([
      'amsg.sqlite',
      'heartbeat.sqlite',
      'manifest.json',
      'proactive-push.sqlite',
      'sullyos-home.sqlite',
    ]);
  });

  it('一个库都取不到时非零退出，不产出空包', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    sb.writeEnv({
      ALPHA_DB_PATH: path.join(sb.dataDir, 'missing-alpha.sqlite'),
      BETA_ENABLE: 'false',
      DUFS_ROOT: sb.backupDir,
    });
    const r = sb.run(BACKUP_SH, []);
    expect(r.status, r.output).not.toBe(0);
    expect(tarGzIn(sb.backupDir).length).toBe(0);
  });
});

describe('backup.sh · 缺必填库即失败、日志路径可注入', () => {
  it('必填库缺失：非零退出、不产出新包、既有完整备份一份都不轮转', () => {
    sb = makeSandbox({ servicesConfig: 'real' });
    sb.writeEnv({
      AMSG_DB_PATH: path.join(sb.dataDir, 'amsg.sqlite'), // 故意不创建
      PROACTIVE_DB_PATH: path.join(sb.dataDir, 'proactive-push.sqlite'),
      HEARTBEAT_DB_PATH: path.join(sb.dataDir, 'heartbeat.sqlite'),
      HOME_DB_PATH: path.join(sb.dataDir, 'sullyos-home.sqlite'),
      BACKUP_KEEP: '1',
      DUFS_ROOT: sb.backupDir,
    });
    for (const n of ['proactive-push', 'heartbeat', 'sullyos-home']) {
      sb.makeDb(path.join(sb.dataDir, `${n}.sqlite`), n);
    }
    const a = sb.seedPackage('sullyos-data-20261021-000002.tar.gz', 200);
    const b = sb.seedPackage('sullyos-data-20261021-000001.tar.gz', 100);

    const r = sb.run(BACKUP_SH, []);
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toContain('amsg.sqlite');
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
    expect(tarGzIn(sb.backupDir).length).toBe(2); // 没有新包
  });

  it('日志路径由 SULLYOS_LOG_FILE 注入：只截断注入的日志，不碰 /var/log 硬编码路径', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const alpha = path.join(sb.dataDir, 'alpha.sqlite');
    sb.writeEnv({ ALPHA_DB_PATH: alpha, BETA_ENABLE: 'false', DUFS_ROOT: sb.backupDir });
    sb.makeDb(alpha, 'alpha-v1');
    // 6MB 日志，末尾留标记：只有真的读了注入路径才会保留
    const filler = 'x'.repeat(1024 * 1024);
    writeFileSync(sb.logFile, `${filler.repeat(6)}TAIL-MARKER\n`);

    const r = sb.run(BACKUP_SH, []);
    expect(r.status, r.output).toBe(0);
    const size = statSync(sb.logFile).size;
    expect(size).toBeLessThan(6 * 1024 * 1024);
    expect(size).toBeGreaterThan(0);
    expect(readFileSync(sb.logFile, 'utf8')).toContain('TAIL-MARKER');
  });

  it('库路径配错（相对路径）：非零退出、不产出新包、不轮转', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    sb.writeEnv({ ALPHA_DB_PATH: 'data/alpha.sqlite', BETA_ENABLE: 'false', BACKUP_KEEP: '1', DUFS_ROOT: sb.backupDir });
    const a = sb.seedPackage('sullyos-data-20261021-000001.tar.gz', 100);

    const r = sb.run(BACKUP_SH, []);
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toContain('path_error');
    expect(existsSync(a)).toBe(true);
    expect(tarGzIn(sb.backupDir).length).toBe(1);
  });
});
