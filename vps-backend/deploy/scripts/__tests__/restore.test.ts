// vps-backend/deploy/scripts/__tests__/restore.test.ts
// B6：恢复前校验 manifest + SQLite 完整性；停服失败立即退出；暂存 + 失败回滚。
// 全程 fake systemctl / cp + 临时 SQLite，绝不触碰真实服务或生产数据。
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BACKUP_SH, makeSandbox, RESTORE_SH, type Sandbox } from './sandbox';

let sb: Sandbox;
afterEach(() => sb?.cleanup());

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

const dbBytes = (s: Sandbox, marker: string): Buffer => {
  const tmp = path.join(s.root, `tmp-${Math.random().toString(36).slice(2)}.sqlite`);
  s.makeDb(tmp, marker);
  const buf = readFileSync(tmp);
  rmSync(tmp, { force: true });
  return buf;
};

const manifestFor = (files: Record<string, Buffer>, complete = true) => ({
  manifestVersion: 1,
  tool: 'db-manifest',
  createdAt: new Date(0).toISOString(),
  complete,
  sources: Object.entries(files).map(([name, buf], i) => ({
    service: `svc${i}`,
    bindKey: 'DB',
    name,
    sizeBytes: buf.length,
    sha256: sha256(buf),
    integrity: 'ok',
  })),
  absent: [],
  unlisted: [],
});

/** 手工组装一个备份包（tar.gz），用于构造各种坏包。 */
function pack(
  s: Sandbox,
  tag: string,
  files: Record<string, Buffer>,
  manifest: unknown | null,
): string {
  const stage = path.join(s.root, `craft-${tag}`);
  mkdirSync(stage, { recursive: true });
  for (const [name, buf] of Object.entries(files)) writeFileSync(path.join(stage, name), buf);
  if (manifest !== null) writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const pkg = path.join(s.root, `${tag}.tar.gz`);
  const r = spawnSync('tar', ['-czf', pkg, '-C', stage, '.'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar 打包失败: ${r.stderr}`);
  return pkg;
}

/** 目标数据目录：放旧库 + 旧 WAL，模拟线上现状。 */
function seedLive(s: Sandbox) {
  const oldAlpha = dbBytes(s, 'old-alpha');
  const oldBeta = dbBytes(s, 'old-beta');
  writeFileSync(path.join(s.dataDir, 'alpha.sqlite'), oldAlpha);
  writeFileSync(path.join(s.dataDir, 'alpha.sqlite-wal'), 'old-wal-bytes');
  writeFileSync(path.join(s.dataDir, 'beta.sqlite'), oldBeta);
  return { oldAlpha, oldBeta };
}

const systemctlLines = (s: Sandbox) => s.fakeLogLines().filter((l) => l.startsWith('systemctl'));
const cpLines = (s: Sandbox) => s.fakeLogLines().filter((l) => l.startsWith('cp'));

describe('restore.sh · 预检（校验先于停服）', () => {
  it('预览模式：合法包只解包，不调用 systemctl、不写数据目录', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const files = { 'alpha.sqlite': dbBytes(sb, 'alpha-new') };
    const pkg = pack(sb, 'good', files, manifestFor(files));

    const r = sb.run(RESTORE_SH, [pkg]);
    expect(r.status, r.output).toBe(0);
    expect(systemctlLines(sb)).toEqual([]);
    expect(existsSync(path.join(sb.dataDir, 'alpha.sqlite'))).toBe(false);
  });

  it('包内没有 manifest：拒绝恢复，连停服都不做', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const files = { 'alpha.sqlite': dbBytes(sb, 'alpha-new') };
    const pkg = pack(sb, 'no-manifest', files, null);
    const { oldAlpha } = seedLive(sb);

    const r = sb.run(RESTORE_SH, ['--auto', pkg]);
    expect(r.status, r.output).not.toBe(0);
    expect(systemctlLines(sb)).toEqual([]);
    expect(readFileSync(path.join(sb.dataDir, 'alpha.sqlite')).equals(oldAlpha)).toBe(true);
  });

  it('包内库与 manifest 的 sha256 不符：拒绝恢复（停服前）', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const real = { 'alpha.sqlite': dbBytes(sb, 'alpha-new') };
    const pkg = pack(sb, 'tampered', { 'alpha.sqlite': dbBytes(sb, 'someone-else') }, manifestFor(real));
    const { oldAlpha } = seedLive(sb);

    const r = sb.run(RESTORE_SH, ['--auto', pkg]);
    expect(r.status, r.output).not.toBe(0);
    expect(systemctlLines(sb)).toEqual([]);
    expect(readFileSync(path.join(sb.dataDir, 'alpha.sqlite')).equals(oldAlpha)).toBe(true);
  });

  it('hash 对得上但不是有效 SQLite：完整性检查拒绝，停服前退出', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const garbage = Buffer.from('definitely not a sqlite file\n'.repeat(16));
    const files = { 'alpha.sqlite': garbage };
    const pkg = pack(sb, 'garbage', files, manifestFor(files));
    seedLive(sb);

    const r = sb.run(RESTORE_SH, ['--auto', pkg]);
    expect(r.status, r.output).not.toBe(0);
    expect(systemctlLines(sb)).toEqual([]);
  });
});

describe('restore.sh · 加密包（生产默认路径）', () => {
  const encEnv = (s: Sandbox, alpha: string, pass: string) => ({
    ALPHA_DB_PATH: alpha,
    BETA_ENABLE: 'false',
    BACKUP_ENCRYPT_PASSPHRASE: pass,
    BACKUP_KEEP: '3',
    DUFS_ROOT: s.backupDir,
  });

  it('加密封装可以解密恢复；口令错误则直接失败且不停服', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const alpha = path.join(sb.dataDir, 'alpha.sqlite');
    sb.writeEnv(encEnv(sb, alpha, 'right-pass'));
    sb.makeDb(alpha, 'alpha-enc');
    const b = sb.run(BACKUP_SH, []);
    expect(b.status, b.output).toBe(0);
    const enc = readdirSync(sb.backupDir).find((n: string) => n.endsWith('.tar.gz.enc'));
    expect(enc).toBeTruthy();
    const pkg = path.join(sb.backupDir, enc as string);

    // 预览能解密 + 通过预检
    const preview = sb.run(RESTORE_SH, [pkg]);
    expect(preview.status, preview.output).toBe(0);
    expect(preview.output).toContain('预检通过');

    // 口令错误：解密失败 → 非零退出，且没有任何 systemctl 调用
    sb.writeEnv(encEnv(sb, alpha, 'wrong-pass'));
    const bad = sb.run(RESTORE_SH, ['--auto', pkg]);
    expect(bad.status, bad.output).not.toBe(0);
    expect(systemctlLines(sb)).toEqual([]);

    // 正确口令 --auto：真的换掉库
    sb.writeEnv(encEnv(sb, alpha, 'right-pass'));
    writeFileSync(path.join(sb.dataDir, 'alpha.sqlite'), dbBytes(sb, 'alpha-old'));
    const ok = sb.run(RESTORE_SH, ['--auto', pkg]);
    expect(ok.status, ok.output).toBe(0);
    expect(sb.dbMarker(path.join(sb.dataDir, 'alpha.sqlite'))).toBe('alpha-enc');
  });
});

describe('restore.sh · 停服与失败回滚', () => {
  it('停服失败：立即非零退出，不覆盖任何库、不启动服务', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const files = { 'alpha.sqlite': dbBytes(sb, 'alpha-new') };
    const pkg = pack(sb, 'good', files, manifestFor(files));
    const { oldAlpha } = seedLive(sb);

    const r = sb.run(RESTORE_SH, ['--auto', pkg], { FAKE_STOP_EXIT: '1' });
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toContain('停服');
    // 只有把包复制到 /tmp 的那一下允许发生；数据目录一个字节都没动
    expect(cpLines(sb).filter((l) => l.includes(sb.dataDir))).toEqual([]);
    expect(readFileSync(path.join(sb.dataDir, 'alpha.sqlite')).equals(oldAlpha)).toBe(true);
    expect(systemctlLines(sb).some((l) => l.startsWith('systemctl start'))).toBe(false);
  });

  it('安装中途失败：回滚到旧库（含 WAL），不输出假成功', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const files = { 'alpha.sqlite': dbBytes(sb, 'alpha-new'), 'beta.sqlite': dbBytes(sb, 'beta-new') };
    const pkg = pack(sb, 'good2', files, manifestFor(files));
    const { oldAlpha, oldBeta } = seedLive(sb);

    const r = sb.run(RESTORE_SH, ['--auto', pkg], { FAKE_CP_FAIL_MATCH: '.beta.sqlite.restore-new' });
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).not.toContain('✔ 恢复完成');
    // alpha 已装好又被回滚
    expect(readFileSync(path.join(sb.dataDir, 'alpha.sqlite')).equals(oldAlpha)).toBe(true);
    expect(existsSync(path.join(sb.dataDir, 'alpha.sqlite-wal'))).toBe(true);
    expect(readFileSync(path.join(sb.dataDir, 'beta.sqlite')).equals(oldBeta)).toBe(true);
    expect(systemctlLines(sb).some((l) => l.startsWith('systemctl start'))).toBe(true);
  });

  it('服务启动失败：不谎报成功，原库仍留在回滚目录', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const files = { 'alpha.sqlite': dbBytes(sb, 'alpha-new') };
    const pkg = pack(sb, 'good4', files, manifestFor(files));
    seedLive(sb);

    const r = sb.run(RESTORE_SH, ['--auto', pkg], { FAKE_START_EXIT: '1' });
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).not.toContain('✔ 恢复完成');
    expect(r.output).toContain('启动失败');
    const rollbackDir = readdirSync(sb.dataDir).find((n: string) => n.startsWith('.restore-rollback'));
    expect(rollbackDir).toBeTruthy();
  });

  it('成功恢复：替换数据、清 WAL、保留回滚目录、stop 先于 start', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const files = { 'alpha.sqlite': dbBytes(sb, 'alpha-new') };
    const pkg = pack(sb, 'good3', files, manifestFor(files));
    const { oldAlpha } = seedLive(sb);

    const r = sb.run(RESTORE_SH, ['--auto', pkg]);
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('恢复完成');
    expect(sb.dbMarker(path.join(sb.dataDir, 'alpha.sqlite'))).toBe('alpha-new');
    expect(existsSync(path.join(sb.dataDir, 'alpha.sqlite-wal'))).toBe(false);

    const rollbackDir = readdirSync(sb.dataDir).find((n: string) => n.startsWith('.restore-rollback'));
    expect(rollbackDir).toBeTruthy();
    const kept = path.join(sb.dataDir, rollbackDir as string);
    expect(readFileSync(path.join(kept, 'alpha.sqlite')).equals(oldAlpha)).toBe(true);
    expect(existsSync(path.join(kept, 'alpha.sqlite-wal'))).toBe(true);

    const lines = systemctlLines(sb);
    const stopIdx = lines.findIndex((l) => l.startsWith('systemctl stop'));
    const startIdx = lines.findIndex((l) => l.startsWith('systemctl start'));
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(stopIdx);
  });
});

// ───────────────────── 包内文件名白名单 / 路径穿越 / 未知库 ─────────────────────
const v2Manifest = (files: Record<string, Buffer>, extra: Record<string, unknown> = {}) => ({
  manifestVersion: 2,
  tool: 'db-manifest',
  createdAt: new Date(0).toISOString(),
  complete: true,
  sources: Object.entries(files).map(([name, buf], i) => ({
    service: `svc${i}`,
    bindKey: 'DB',
    name,
    sizeBytes: buf.length,
    sha256: sha256(buf),
    integrity: 'ok',
  })),
  required: Object.keys(files).map((name) => ({ service: 'svc', name })),
  optional: [],
  absent: [],
  problems: [],
  ...extra,
});

const v1Manifest = (files: Record<string, Buffer>) => ({
  manifestVersion: 1,
  tool: 'db-manifest',
  createdAt: new Date(0).toISOString(),
  complete: true,
  sources: Object.entries(files).map(([name, buf], i) => ({
    service: `svc${i}`,
    bindKey: 'DB',
    name,
    sizeBytes: buf.length,
    sha256: sha256(buf),
    integrity: 'ok',
  })),
  absent: [],
  unlisted: [],
});

const tarFromStage = (stage: string, pkg: string, tarArgs: string[] = []) => {
  const r = spawnSync('tar', ['-czf', pkg, ...tarArgs, '-C', stage, '.'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar 打包失败: ${r.stderr}`);
  return pkg;
};

const realEnv = (s: Sandbox) => s.writeEnv({
  AMSG_DB_PATH: path.join(s.dataDir, 'amsg.sqlite'),
  PROACTIVE_DB_PATH: path.join(s.dataDir, 'proactive-push.sqlite'),
  HEARTBEAT_DB_PATH: path.join(s.dataDir, 'heartbeat.sqlite'),
  HOME_DB_PATH: path.join(s.dataDir, 'sullyos-home.sqlite'),
});

describe('restore.sh · 只认注册表认识的库，拒一切外来库名', () => {
  it('包里的 alpha.sqlite 不在服务注册表：停服前拒绝，数据目录零改动', () => {
    sb = makeSandbox({ servicesConfig: 'real' });
    realEnv(sb);
    const files = { 'alpha.sqlite': dbBytes(sb, 'alpha-from-incident') };
    const pkg = pack(sb, 'unknown-db', files, v1Manifest(files));
    const live = dbBytes(sb, 'live-amsg');
    writeFileSync(path.join(sb.dataDir, 'amsg.sqlite'), live);

    const r = sb.run(RESTORE_SH, ['--auto', pkg]);
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toContain('unknown_db:alpha.sqlite');
    expect(systemctlLines(sb)).toEqual([]);
    expect(readFileSync(path.join(sb.dataDir, 'amsg.sqlite')).equals(live)).toBe(true);
    expect(existsSync(path.join(sb.dataDir, 'alpha.sqlite'))).toBe(false);
  });

  it('manifest 里的库名带 ../：按 bad_name 拒绝，且不往数据目录外写文件', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const buf = dbBytes(sb, 'alpha-escaped');
    const stage = path.join(sb.root, 'craft-badname');
    mkdirSync(stage, { recursive: true });
    writeFileSync(path.join(stage, 'alpha.sqlite'), buf);
    const manifest = {
      manifestVersion: 1, complete: true,
      sources: [{ service: 'alpha', bindKey: 'DB', name: '../evil.sqlite', sizeBytes: buf.length, sha256: sha256(buf) }],
      absent: [], unlisted: [],
    };
    writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest));
    const pkg = tarFromStage(stage, path.join(sb.root, 'badname.tar.gz'));

    const r = sb.run(RESTORE_SH, ['--auto', pkg]);
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toContain('bad_name');
    expect(systemctlLines(sb)).toEqual([]);
    expect(existsSync(path.join(sb.root, 'evil.sqlite'))).toBe(false);
    expect(existsSync(path.join(sb.dataDir, 'evil.sqlite'))).toBe(false);
  });

  it('tar 成员是绝对路径：解包前拒绝，绝不在根外落地', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const buf = dbBytes(sb, 'alpha-abs');
    const stage = path.join(sb.root, 'craft-abs');
    mkdirSync(stage, { recursive: true });
    writeFileSync(path.join(stage, 'alpha.sqlite'), buf);
    writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(v1Manifest({ 'alpha.sqlite': buf })));
    const escapee = `/tmp/sullyos-escape-${process.pid}-${Date.now()}.sqlite`;
    const pkg = path.join(sb.root, 'abs.tar.gz');
    const t = spawnSync('tar', ['-czf', pkg, '-P', '-C', stage, '--transform', `s|^\\./alpha\\.sqlite$|${escapee}|`, '.'], { encoding: 'utf8' });
    expect(t.status, t.stderr).toBe(0);

    const r = sb.run(RESTORE_SH, ['--auto', pkg]);
    try {
      expect(r.status, r.output).not.toBe(0);
      expect(r.output).toContain('unsafe_member');
      expect(systemctlLines(sb)).toEqual([]);
      expect(existsSync(escapee)).toBe(false);
    } finally {
      rmSync(escapee, { force: true });
    }
  });

  it('tar 成员是符号链接：拒绝（不跟随链接写出解包目录）', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const buf = dbBytes(sb, 'alpha-link');
    const stage = path.join(sb.root, 'craft-symlink');
    mkdirSync(stage, { recursive: true });
    writeFileSync(path.join(stage, 'alpha.sqlite'), buf);
    writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(v1Manifest({ 'alpha.sqlite': buf })));
    spawnSync('ln', ['-s', '/etc/passwd', path.join(stage, 'alpha-link.sqlite')]);
    const pkg = tarFromStage(stage, path.join(sb.root, 'pack-links.tar.gz'));

    const r = sb.run(RESTORE_SH, ['--auto', pkg]);
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toContain('unsafe_member:symlink');
    expect(systemctlLines(sb)).toEqual([]);
  });

  it('tar 成员是硬链接：拒绝', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const buf = dbBytes(sb, 'alpha-hard');
    const stage = path.join(sb.root, 'craft-hardlink');
    mkdirSync(stage, { recursive: true });
    writeFileSync(path.join(stage, 'alpha.sqlite'), buf);
    writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(v1Manifest({ 'alpha.sqlite': buf })));
    spawnSync('ln', [path.join(stage, 'alpha.sqlite'), path.join(stage, 'alpha-copy.sqlite')]);
    const pkg = tarFromStage(stage, path.join(sb.root, 'pack-hard.tar.gz'));

    const r = sb.run(RESTORE_SH, ['--auto', pkg]);
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toContain('unsafe_member:hardlink');
    expect(systemctlLines(sb)).toEqual([]);
  });

  it('包里有 manifest 之外的 sqlite（夹带 alpha/beta）：拒绝恢复', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const alpha = dbBytes(sb, 'alpha-ok');
    const smuggled = dbBytes(sb, 'smuggled-db');
    const stage = path.join(sb.root, 'craft-smuggle');
    mkdirSync(stage, { recursive: true });
    writeFileSync(path.join(stage, 'alpha.sqlite'), alpha);
    writeFileSync(path.join(stage, 'beta.sqlite'), smuggled);
    writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(v1Manifest({ 'alpha.sqlite': alpha })));
    const pkg = tarFromStage(stage, path.join(sb.root, 'smuggle.tar.gz'));

    const r = sb.run(RESTORE_SH, ['--auto', pkg]);
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toContain('extra_sqlite:beta.sqlite');
    expect(systemctlLines(sb)).toEqual([]);
  });
});

// ───────────────────── 多目录：真实注册表映射（heartbeat/home 不在 DATA_DIR） ─────────────────────
const REQUIRED4 = ['amsg.sqlite', 'proactive-push.sqlite', 'heartbeat.sqlite', 'sullyos-home.sqlite'];

/** 生产形态：amsg/proactive 在数据目录，heartbeat/home 在部署仓的 vps-backend/data。 */
function realMultiDirEnv(s: Sandbox) {
  const altDir = path.join(s.root, 'repo/vps-backend/data');
  mkdirSync(altDir, { recursive: true });
  s.writeEnv({
    AMSG_DB_PATH: path.join(s.dataDir, 'amsg.sqlite'),
    PROACTIVE_DB_PATH: path.join(s.dataDir, 'proactive-push.sqlite'),
    HEARTBEAT_DB_PATH: path.join(altDir, 'heartbeat.sqlite'),
    HOME_DB_PATH: path.join(altDir, 'sullyos-home.sqlite'),
    // 不设置 AMSG_ENABLE_D1_BLOBSTORE：instant-push 的库保持 optional
  });
  return { altDir };
}

function seedLiveMulti(s: Sandbox, altDir: string) {
  const old: Record<string, Buffer> = {};
  for (const name of REQUIRED4) {
    const dir = name === 'heartbeat.sqlite' || name === 'sullyos-home.sqlite' ? altDir : s.dataDir;
    const buf = dbBytes(s, `old-${name}`);
    writeFileSync(path.join(dir, name), buf);
    old[name] = buf;
  }
  // 原库的 WAL 也必须跟着回滚
  writeFileSync(path.join(altDir, 'sullyos-home.sqlite-wal'), 'old-home-wal');
  writeFileSync(path.join(s.dataDir, 'amsg.sqlite-wal'), 'old-amsg-wal');
  return old;
}

const targetOf = (s: Sandbox, altDir: string, name: string) =>
  path.join(name === 'heartbeat.sqlite' || name === 'sullyos-home.sqlite' ? altDir : s.dataDir, name);

describe('restore.sh · 真实注册表路径（跨目录安装）', () => {
  it('四个库分别装到心跳/家在部署仓、amsg/proactive 在数据目录；不做平铺', () => {
    sb = makeSandbox({ servicesConfig: 'real' });
    const { altDir } = realMultiDirEnv(sb);
    const files: Record<string, Buffer> = {};
    for (const name of REQUIRED4) files[name] = dbBytes(sb, `new-${name}`);
    const pkg = pack(sb, 'multidir', files, v2Manifest(files));
    seedLiveMulti(sb, altDir);

    const r = sb.run(RESTORE_SH, ['--auto', pkg]);
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('✔ 恢复完成');
    for (const name of REQUIRED4) {
      expect(sb.dbMarker(targetOf(sb, altDir, name)), `${name} 未落到注册表路径`).toBe(`new-${name}`);
    }
    // 不再把心跳/家平铺进 DATA_DIR（那正是旧缺陷）
    expect(existsSync(path.join(sb.dataDir, 'heartbeat.sqlite'))).toBe(false);
    expect(existsSync(path.join(sb.dataDir, 'sullyos-home.sqlite'))).toBe(false);
    // 每个目标目录各自有暂存/回滚目录，暂存目录成功后清掉
    for (const dir of [sb.dataDir, altDir]) {
      const entries = readdirSync(dir);
      expect(entries.some((n: string) => n.startsWith('.restore-rollback-'))).toBe(true);
      expect(entries.some((n: string) => n.startsWith('.restore-stage-'))).toBe(false);
    }
    // 旧库（含 WAL）在两个目录都保留在回滚目录里
    const rb1 = readdirSync(sb.dataDir).find((n: string) => n.startsWith('.restore-rollback-')) as string;
    const rb2 = readdirSync(altDir).find((n: string) => n.startsWith('.restore-rollback-')) as string;
    expect(existsSync(path.join(sb.dataDir, rb1, 'amsg.sqlite-wal'))).toBe(true);
    expect(existsSync(path.join(altDir, rb2, 'sullyos-home.sqlite-wal'))).toBe(true);
  });

  it('跨目录替换中途失败：所有已触及目标（含另一目录）的原库与 WAL 全部回滚', () => {
    sb = makeSandbox({ servicesConfig: 'real' });
    const { altDir } = realMultiDirEnv(sb);
    const files: Record<string, Buffer> = {};
    for (const name of REQUIRED4) files[name] = dbBytes(sb, `new-${name}`);
    const pkg = pack(sb, 'multidir-fail', files, v2Manifest(files));
    const old = seedLiveMulti(sb, altDir);

    // 最后一个库（sullyos-home，另一个目录）替换时暴雷
    const r = sb.run(RESTORE_SH, ['--auto', pkg], { FAKE_CP_FAIL_MATCH: '.sullyos-home.sqlite.restore-new' });
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).not.toContain('✔ 恢复完成');
    for (const name of REQUIRED4) {
      expect(readFileSync(targetOf(sb, altDir, name)).equals(old[name]), `${name} 未回滚`).toBe(true);
    }
    expect(readFileSync(path.join(sb.dataDir, 'amsg.sqlite-wal'), 'utf8')).toBe('old-amsg-wal');
    expect(readFileSync(path.join(altDir, 'sullyos-home.sqlite-wal'), 'utf8')).toBe('old-home-wal');
    expect(systemctlLines(sb).some((l) => l.startsWith('systemctl start'))).toBe(true);
  });

  it('包内自带 targetDir/path 字段一律忽略：只按本机注册表落盘', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const buf = dbBytes(sb, 'alpha-rogue');
    const evil = path.join(sb.root, 'rogue-target');
    mkdirSync(evil, { recursive: true });
    const manifest = v2Manifest({ 'alpha.sqlite': buf }, {
      sources: [{
        service: 'alpha', name: 'alpha.sqlite', sizeBytes: buf.length, sha256: sha256(buf),
        targetDir: evil, path: path.join(evil, 'alpha.sqlite'), dir: evil,
      }],
    });
    const pkg = pack(sb, 'rogue-path', { 'alpha.sqlite': buf }, manifest);

    const r = sb.run(RESTORE_SH, ['--auto', pkg]);
    expect(r.status, r.output).toBe(0);
    expect(sb.dbMarker(path.join(sb.dataDir, 'alpha.sqlite'))).toBe('alpha-rogue');
    expect(existsSync(path.join(evil, 'alpha.sqlite'))).toBe(false);
  });
});

describe('restore.sh · 缺当前必填库：默认拒绝，partial 需显式', () => {
  it('伪 complete 包（只含 amsg，自称 complete=true）：预检拒绝，零 stop', () => {
    sb = makeSandbox({ servicesConfig: 'real' });
    const { altDir } = realMultiDirEnv(sb);
    const files = { 'amsg.sqlite': dbBytes(sb, 'amsg-only') };
    const pkg = pack(sb, 'fake-complete', files, v2Manifest(files));
    const old = seedLiveMulti(sb, altDir);

    const r = sb.run(RESTORE_SH, ['--auto', pkg]);
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toContain('missing_required_db:heartbeat.sqlite');
    expect(r.output).toContain('--allow-partial');
    expect(systemctlLines(sb)).toEqual([]);
    expect(readFileSync(path.join(sb.dataDir, 'amsg.sqlite')).equals(old['amsg.sqlite'])).toBe(true);
  });

  it('--allow-partial：只装包内的库并明确说「部分恢复」，绝不说恢复完成', () => {
    sb = makeSandbox({ servicesConfig: 'real' });
    const { altDir } = realMultiDirEnv(sb);
    const files = { 'amsg.sqlite': dbBytes(sb, 'amsg-partial') };
    const pkg = pack(sb, 'partial', files, v2Manifest(files));
    const old = seedLiveMulti(sb, altDir);

    const r = sb.run(RESTORE_SH, ['--auto', '--allow-partial', pkg]);
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('部分恢复');
    expect(r.output).not.toContain('✔ 恢复完成');
    expect(sb.dbMarker(path.join(sb.dataDir, 'amsg.sqlite'))).toBe('amsg-partial');
    // 缺的库保持原状，不被清掉也不被平铺
    expect(readFileSync(path.join(altDir, 'heartbeat.sqlite')).equals(old['heartbeat.sqlite'])).toBe(true);
    expect(readFileSync(path.join(sb.dataDir, 'proactive-push.sqlite')).equals(old['proactive-push.sqlite'])).toBe(true);
  });
});

describe('restore.sh · 旧备份兼容（显式已知映射）', () => {
  it('旧 v1 manifest（四库齐全、已知库名）可以按注册表路径恢复', () => {
    sb = makeSandbox({ servicesConfig: 'real' });
    const { altDir } = realMultiDirEnv(sb);
    const files: Record<string, Buffer> = {};
    for (const name of REQUIRED4) files[name] = dbBytes(sb, `legacy-${name}`);
    const stage = path.join(sb.root, 'craft-legacy');
    mkdirSync(stage, { recursive: true });
    for (const [name, buf] of Object.entries(files)) writeFileSync(path.join(stage, name), buf);
    writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(v1Manifest(files)));
    const pkg = tarFromStage(stage, path.join(sb.root, 'legacy.tar.gz'));
    seedLiveMulti(sb, altDir);

    const r = sb.run(RESTORE_SH, ['--auto', pkg]);
    expect(r.status, r.output).toBe(0);
    for (const name of REQUIRED4) {
      expect(sb.dbMarker(targetOf(sb, altDir, name))).toBe(`legacy-${name}`);
    }
  });

  it('旧 v1 单库包（只含 amsg）：缺当前必填库 → 默认拒绝并说明', () => {
    sb = makeSandbox({ servicesConfig: 'real' });
    const { altDir } = realMultiDirEnv(sb);
    const buf = dbBytes(sb, 'amsg-from-2026-09');
    const stage = path.join(sb.root, 'craft-legacy-one');
    mkdirSync(stage, { recursive: true });
    writeFileSync(path.join(stage, 'amsg.sqlite'), buf);
    writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(v1Manifest({ 'amsg.sqlite': buf })));
    const pkg = tarFromStage(stage, path.join(sb.root, 'legacy-one.tar.gz'));
    const old = seedLiveMulti(sb, altDir);

    const r = sb.run(RESTORE_SH, ['--auto', pkg]);
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toContain('missing_required_db:sullyos-home.sqlite');
    expect(systemctlLines(sb)).toEqual([]);
    expect(readFileSync(path.join(sb.dataDir, 'amsg.sqlite')).equals(old['amsg.sqlite'])).toBe(true);
  });

  it('注册表里存在但当前未启用的库（gamma）：允许恢复但必须警告', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const files = { 'alpha.sqlite': dbBytes(sb, 'alpha-ok'), 'gamma.sqlite': dbBytes(sb, 'gamma-legacy') };
    const pkg = pack(sb, 'disabled', files, v1Manifest(files));

    const r = sb.run(RESTORE_SH, ['--auto', pkg]);
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('未启用');
    expect(sb.dbMarker(path.join(sb.dataDir, 'gamma.sqlite'))).toBe('gamma-legacy');
  });
});
