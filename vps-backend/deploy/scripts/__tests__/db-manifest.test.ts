// vps-backend/deploy/scripts/__tests__/db-manifest.test.ts
// 备份源 manifest 工具：以真实服务配置枚举数据库，不靠数据目录 glob。
import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeSandbox, readJson, type Sandbox } from './sandbox';

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const shaBuf = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

let sb: Sandbox;
afterEach(() => sb?.cleanup());

describe('db-manifest list：备份源来自服务配置', () => {
  it('按 services.js 的 db.pathEnv 解析真实路径，并报告未入清单的库', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const alphaPath = path.join(sb.dataDir, 'alpha.sqlite');
    const betaPath = path.join(sb.dataDir, 'beta.sqlite');
    const orphanPath = path.join(sb.dataDir, 'orphan.sqlite');
    sb.writeEnv({ ALPHA_DB_PATH: alphaPath, BETA_DB_PATH: betaPath, BETA_ENABLE: 'true' });
    sb.makeDb(alphaPath, 'alpha');
    sb.makeDb(betaPath, 'beta');
    sb.makeDb(orphanPath, 'orphan'); // 不在服务配置里 → 不应成为备份源

    const r = sb.runTool(['list', '--env-file', sb.envFile]);
    expect(r.status, r.output).toBe(0);
    const out = JSON.parse(r.stdout) as { sources: { service: string; path: string; name: string }[]; unlisted: string[] };

    expect(out.sources.map((s) => s.service)).toEqual(['alpha', 'beta']);
    expect(out.sources.map((s) => s.path)).toEqual([alphaPath, betaPath]);
    expect(out.sources.map((s) => s.name)).toEqual(['alpha.sqlite', 'beta.sqlite']);
    expect(out.unlisted).toEqual(['orphan.sqlite']);
  });

  it('用真实 config/services.js 枚举：enableIf=false 的库不进清单', () => {
    sb = makeSandbox({ servicesConfig: 'real' });
    sb.writeEnv({
      AMSG_DB_PATH: path.join(sb.dataDir, 'amsg.sqlite'),
      PROACTIVE_DB_PATH: path.join(sb.dataDir, 'proactive-push.sqlite'),
      HEARTBEAT_DB_PATH: path.join(sb.dataDir, 'heartbeat.sqlite'),
      HOME_DB_PATH: path.join(sb.dataDir, 'sullyos-home.sqlite'),
      // 未设置 AMSG_ENABLE_D1_BLOBSTORE → instant-push 的 DB 不启用
    });
    const r = sb.runTool(['list', '--env-file', sb.envFile]);
    expect(r.status, r.output).toBe(0);
    const out = JSON.parse(r.stdout) as { sources: { service: string }[] };
    const names = out.sources.map((s) => s.service);
    expect(names).toContain('amsg');
    expect(names).toContain('heartbeat');
    expect(names).toContain('sullyos-home');
    expect(names).not.toContain('instant-push');
  });
});

describe('db-manifest snapshot/verify：不完整包必须失败', () => {
  const fixtureEnv = (s: Sandbox, alpha: string, beta: string) => {
    s.writeEnv({ ALPHA_DB_PATH: alpha, BETA_DB_PATH: beta, BETA_ENABLE: 'true' });
  };

  it('有库快照失败时非零退出且 manifest 标记不完整', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const alphaPath = path.join(sb.dataDir, 'alpha.sqlite');
    const betaPath = path.join(sb.dataDir, 'beta.sqlite');
    sb.makeDb(alphaPath, 'alpha');
    sb.makeGarbageDb(betaPath);
    fixtureEnv(sb, alphaPath, betaPath);

    const dir = path.join(sb.root, 'snap-fail');
    const manifestPath = path.join(dir, 'manifest.json');
    const r = sb.runTool(['snapshot', '--dir', dir, '--env-file', sb.envFile, '--manifest-out', manifestPath]);
    expect(r.status, r.output).not.toBe(0);
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = readJson<{ complete: boolean }>(manifestPath);
    expect(manifest.complete).toBe(false);
  });

  it('成功快照给出 sha256/size，verify 能识破被篡改的库', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const alphaPath = path.join(sb.dataDir, 'alpha.sqlite');
    const betaPath = path.join(sb.dataDir, 'beta.sqlite');
    sb.makeDb(alphaPath, 'alpha');
    sb.makeDb(betaPath, 'beta');
    fixtureEnv(sb, alphaPath, betaPath);

    const dir = path.join(sb.root, 'snap-ok');
    const manifestPath = path.join(dir, 'manifest.json');
    const r = sb.runTool(['snapshot', '--dir', dir, '--env-file', sb.envFile, '--manifest-out', manifestPath]);
    expect(r.status, r.output).toBe(0);
    const manifest = readJson<{ complete: boolean; sources: { name: string; sha256: string; sizeBytes: number; integrity: string }[] }>(manifestPath);
    expect(manifest.complete).toBe(true);
    expect(manifest.sources.map((s) => s.name).sort()).toEqual(['alpha.sqlite', 'beta.sqlite']);
    for (const src of manifest.sources) {
      const file = path.join(dir, src.name);
      expect(src.sha256).toBe(sha256(file));
      expect(src.sizeBytes).toBe(readFileSync(file).length);
      expect(src.integrity).toBe('ok');
    }

    const ok = sb.runTool(['verify', '--dir', dir, '--manifest', manifestPath]);
    expect(ok.status, ok.output).toBe(0);

    // 篡改一个库：字节变了但 manifest 没变 → verify 必须拒绝
    writeFileSync(path.join(dir, 'beta.sqlite'), Buffer.concat([readFileSync(path.join(dir, 'beta.sqlite')), Buffer.from('tamper')]));
    const bad = sb.runTool(['verify', '--dir', dir, '--manifest', manifestPath]);
    expect(bad.status, bad.output).not.toBe(0);
    expect(bad.stdout + bad.stderr).toContain('beta.sqlite');
  });

  it('manifest 缺失或 complete=false 时 verify 失败', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const alphaPath = path.join(sb.dataDir, 'alpha.sqlite');
    sb.makeDb(alphaPath, 'alpha');
    fixtureEnv(sb, alphaPath, path.join(sb.dataDir, 'beta.sqlite'));

    const dir = path.join(sb.root, 'empty-dir');
    mkdirSync(dir, { recursive: true });
    const missing = sb.runTool(['verify', '--dir', dir, '--manifest', path.join(dir, 'manifest.json')]);
    expect(missing.status, missing.output).not.toBe(0);
    expect(missing.stdout + missing.stderr).toContain('manifest');

    const incomplete = path.join(dir, 'manifest.json');
    writeFileSync(incomplete, JSON.stringify({ manifestVersion: 1, complete: false, sources: [] }));
    const r = sb.runTool(['verify', '--dir', dir, '--manifest', incomplete]);
    expect(r.status, r.output).not.toBe(0);
  });
});

// ───────────────────────── 必填 / 可选 与路径配置 ─────────────────────────
describe('db-manifest：required 与 optional 必须分清', () => {
  const realEnv = (s: Sandbox, over: Record<string, string> = {}) => {
    s.writeEnv({
      AMSG_DB_PATH: path.join(s.dataDir, 'amsg.sqlite'),
      PROACTIVE_DB_PATH: path.join(s.dataDir, 'proactive-push.sqlite'),
      HEARTBEAT_DB_PATH: path.join(s.dataDir, 'heartbeat.sqlite'),
      HOME_DB_PATH: path.join(s.dataDir, 'sullyos-home.sqlite'),
      ...over,
    });
  };

  it('必填库缺失：snapshot 非零、complete=false、manifest 明确列出 required 与 absent', () => {
    sb = makeSandbox({ servicesConfig: 'real' });
    realEnv(sb);
    // 只建 3 个，amsg 缺失（模拟 .env 写错路径或挂载没起来）
    sb.makeDb(path.join(sb.dataDir, 'proactive-push.sqlite'), 'proactive');
    sb.makeDb(path.join(sb.dataDir, 'heartbeat.sqlite'), 'heartbeat');
    sb.makeDb(path.join(sb.dataDir, 'sullyos-home.sqlite'), 'home');

    const dir = path.join(sb.root, 'snap-missing-required');
    const manifestPath = path.join(dir, 'manifest.json');
    const r = sb.runTool(['snapshot', '--dir', dir, '--env-file', sb.envFile, '--manifest-out', manifestPath]);
    expect(r.status, r.output).not.toBe(0);

    const m = readJson<{
      complete: boolean;
      required: { service: string; name: string }[];
      absent: { service: string; name: string; required: boolean; code: string }[];
    }>(manifestPath);
    expect(m.complete).toBe(false);
    // required 列表必须显式，而不是「能拿到什么算什么」
    expect(m.required.map((x) => x.name).sort()).toEqual([
      'amsg.sqlite',
      'heartbeat.sqlite',
      'proactive-push.sqlite',
      'sullyos-home.sqlite',
    ]);
    const amsgAbsent = m.absent.find((a) => a.name === 'amsg.sqlite');
    expect(amsgAbsent).toBeTruthy();
    expect(amsgAbsent?.required).toBe(true);
    expect(amsgAbsent?.code).toBe('missing_required');
  });

  it('显式未启用的可选库（instant-push D1 blobstore 关闭）不算缺库、也不要求文件存在', () => {
    sb = makeSandbox({ servicesConfig: 'real' });
    realEnv(sb, { AMSG_ENABLE_D1_BLOBSTORE: 'false' });
    for (const n of ['amsg', 'proactive-push', 'heartbeat', 'sullyos-home']) {
      sb.makeDb(path.join(sb.dataDir, `${n}.sqlite`), n);
    }

    const dir = path.join(sb.root, 'snap-optional');
    const manifestPath = path.join(dir, 'manifest.json');
    const r = sb.runTool(['snapshot', '--dir', dir, '--env-file', sb.envFile, '--manifest-out', manifestPath]);
    expect(r.status, r.output).toBe(0);

    const m = readJson<{
      complete: boolean;
      required: { name: string }[];
      optional: { name: string; reason: string }[];
      absent: { name: string }[];
      problems: unknown[];
    }>(manifestPath);
    expect(m.complete).toBe(true);
    expect(m.required.map((x) => x.name)).not.toContain('instant-push.sqlite');
    expect(m.optional.map((x) => x.name)).toContain('instant-push.sqlite');
    expect(m.optional.find((x) => x.name === 'instant-push.sqlite')?.reason).toContain('enableIf');
    expect(m.absent).toEqual([]);
    expect(m.problems).toEqual([]);
  });

  it('配置成相对路径：报 path_error 并不算完整（cwd 一变就会指向别处）', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    sb.writeEnv({ ALPHA_DB_PATH: 'data/alpha.sqlite', BETA_ENABLE: 'false' });
    const rel = path.join(sb.root, 'data/alpha.sqlite');
    sb.makeDb(rel, 'alpha'); // 就算这个相对路径在 cwd 下碰巧存在，也不能当作「配对了」

    const dir = path.join(sb.root, 'snap-relpath');
    const manifestPath = path.join(dir, 'manifest.json');
    const r = sb.runTool(['snapshot', '--dir', dir, '--env-file', sb.envFile, '--manifest-out', manifestPath]);
    expect(r.status, r.output).not.toBe(0);
    const m = readJson<{ complete: boolean; problems: { code?: string; name: string }[] }>(manifestPath);
    expect(m.complete).toBe(false);
    expect(m.problems.map((p) => p.code)).toContain('path_error');
  });

  it('两个服务解析到同名不同目录的库：报 path_error（恢复时无法无歧义映射）', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const aDir = path.join(sb.root, 'dir-a');
    const bDir = path.join(sb.root, 'dir-b');
    mkdirSync(aDir, { recursive: true });
    mkdirSync(bDir, { recursive: true });
    sb.makeDb(path.join(aDir, 'shared.sqlite'), 'a');
    sb.makeDb(path.join(bDir, 'shared.sqlite'), 'b');

    const custom = path.join(sb.root, 'dup-services.js');
    writeFileSync(custom, [
      'export const services = [',
      `  { name: 'svc-a', port: 9101, enabled: true, db: { bindKey: 'DB', pathEnv: 'A_PATH', defaultPath: ${JSON.stringify(path.join(aDir, 'shared.sqlite'))}, enableIf: () => true } },`,
      `  { name: 'svc-b', port: 9102, enabled: true, db: { bindKey: 'DB', pathEnv: 'B_PATH', defaultPath: ${JSON.stringify(path.join(bDir, 'shared.sqlite'))}, enableIf: () => true } },`,
      '];',
    ].join('\n'));
    sb.writeEnv({ A_PATH: path.join(aDir, 'shared.sqlite'), B_PATH: path.join(bDir, 'shared.sqlite') });

    const dir = path.join(sb.root, 'snap-dup');
    const manifestPath = path.join(dir, 'manifest.json');
    const r = sb.runTool(['snapshot', '--dir', dir, '--env-file', sb.envFile, '--manifest-out', manifestPath], { SULLYOS_SERVICES_CONFIG: custom });
    expect(r.status, r.output).not.toBe(0);
    const m = readJson<{ complete: boolean; problems: { code?: string }[] }>(manifestPath);
    expect(m.complete).toBe(false);
    expect(m.problems.map((p) => p.code)).toContain('path_error');
    expect(r.output).toContain('shared.sqlite');
  });

  it('registry：给出当前配置认识的库名与启用状态，未知库不在其中', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    sb.writeEnv({ ALPHA_DB_PATH: path.join(sb.dataDir, 'alpha.sqlite') });
    const r = sb.runTool(['registry', '--env-file', sb.envFile]);
    expect(r.status, r.output).toBe(0);
    const out = JSON.parse(r.stdout) as {
      required: string[];
      optional: string[];
      names: { name: string; service: string; enabled: boolean; path: string }[];
    };
    expect(out.required).toEqual(['alpha.sqlite']);
    // beta / gamma 的 enableIf 均为 false → 已知但当前未启用
    expect(out.optional.sort()).toEqual(['beta.sqlite', 'gamma.sqlite']);
    expect(out.names.map((n) => n.name)).not.toContain('unknown.sqlite');
    expect(out.names.find((n) => n.name === 'gamma.sqlite')?.enabled).toBe(false);
    expect(out.names.find((n) => n.name === 'gamma.sqlite')?.path).toBe(path.join(sb.dataDir, 'gamma.sqlite'));
  });
});

describe('db-manifest registry/verify：本机路径映射 + 当前必填库全集', () => {
  const multiEnv = (s: Sandbox) => {
    const altDir = path.join(s.root, 'repo/vps-backend/data');
    mkdirSync(altDir, { recursive: true });
    s.writeEnv({
      AMSG_DB_PATH: path.join(s.dataDir, 'amsg.sqlite'),
      PROACTIVE_DB_PATH: path.join(s.dataDir, 'proactive-push.sqlite'),
      HEARTBEAT_DB_PATH: path.join(altDir, 'heartbeat.sqlite'),
      HOME_DB_PATH: path.join(altDir, 'sullyos-home.sqlite'),
    });
    return altDir;
  };

  it('registry：每个库名映射到本机绝对路径（heartbeat/home 与 amsg/proactive 不同目录）', () => {
    sb = makeSandbox({ servicesConfig: 'real' });
    const altDir = multiEnv(sb);
    const r = sb.runTool(['registry', '--env-file', sb.envFile]);
    expect(r.status, r.output).toBe(0);
    const out = JSON.parse(r.stdout) as {
      required: string[];
      targets: Record<string, { path: string; dir: string; enabled: boolean; ambiguous: boolean }>;
      localOnly: boolean;
    };
    expect(out.localOnly).toBe(true);
    expect(out.required.sort()).toEqual(['amsg.sqlite', 'heartbeat.sqlite', 'proactive-push.sqlite', 'sullyos-home.sqlite']);
    expect(out.targets['amsg.sqlite'].path).toBe(path.join(sb.dataDir, 'amsg.sqlite'));
    expect(out.targets['proactive-push.sqlite'].path).toBe(path.join(sb.dataDir, 'proactive-push.sqlite'));
    expect(out.targets['heartbeat.sqlite'].path).toBe(path.join(altDir, 'heartbeat.sqlite'));
    expect(out.targets['sullyos-home.sqlite'].path).toBe(path.join(altDir, 'sullyos-home.sqlite'));
    expect(out.targets['heartbeat.sqlite'].dir).toBe(altDir);
    expect(Object.values(out.targets).some((t) => t.ambiguous)).toBe(false);
  });

  it('snapshot 的 manifest 不带任何本机绝对路径（路径只留在本机 registry 输出）', () => {
    sb = makeSandbox({ servicesConfig: 'real' });
    const altDir = multiEnv(sb);
    for (const [dir, n] of [[sb.dataDir, 'amsg'], [sb.dataDir, 'proactive-push'], [altDir, 'heartbeat'], [altDir, 'sullyos-home']] as const) {
      sb.makeDb(path.join(dir, `${n}.sqlite`), n);
    }
    const dir = path.join(sb.root, 'snap-nopaths');
    const manifestPath = path.join(dir, 'manifest.json');
    const r = sb.runTool(['snapshot', '--dir', dir, '--env-file', sb.envFile, '--manifest-out', manifestPath]);
    expect(r.status, r.output).toBe(0);
    const raw = readFileSync(manifestPath, 'utf8');
    expect(raw).not.toContain(sb.root);
    expect(raw).not.toContain(altDir);
    expect(raw).not.toContain(sb.dataDir);
  });

  const packageDir = (s: Sandbox, tag: string, names: string[]) => {
    const dir = path.join(s.root, tag);
    mkdirSync(dir, { recursive: true });
    const sources: { service: string; bindKey: string; name: string; sizeBytes: number; sha256: string; integrity: string }[] = [];
    for (const name of names) {
      const buf = Buffer.from('not really sqlite but hash-checked');
      // 用真 SQLite，完整性检查才有意义
      const tmp = path.join(s.root, `pkg-${tag}-${name}`);
      s.makeDb(tmp, name);
      const bytes = readFileSync(tmp);
      writeFileSync(path.join(dir, name), bytes);
      sources.push({ service: name, bindKey: 'DB', name, sizeBytes: bytes.length, sha256: shaBuf(bytes), integrity: 'ok' });
    }
    const manifest = {
      manifestVersion: 2, tool: 'db-manifest', complete: true,
      sources,
      required: names.map((name) => ({ service: name, name })),
      optional: [], absent: [], problems: [], unlisted: [],
    };
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    return { dir, manifestPath: path.join(dir, 'manifest.json') };
  };

  it('伪 complete 包（只含 amsg）：默认拒绝并说明缺哪个必填库', () => {
    sb = makeSandbox({ servicesConfig: 'real' });
    multiEnv(sb);
    const { dir, manifestPath } = packageDir(sb, 'fake-complete', ['amsg.sqlite']);
    const r = sb.runTool(['verify', '--dir', dir, '--manifest', manifestPath, '--registry', '--env-file', sb.envFile]);
    expect(r.status, r.output).not.toBe(0);
    const out = JSON.parse(r.stdout) as { ok: boolean; problems: string[]; partial: boolean };
    expect(out.ok).toBe(false);
    expect(out.partial).toBe(false);
    expect(out.problems).toEqual(expect.arrayContaining([
      'missing_required_db:heartbeat.sqlite',
      'missing_required_db:proactive-push.sqlite',
      'missing_required_db:sullyos-home.sqlite',
    ]));
    expect(r.stderr).toContain('--allow-partial');
  });

  it('--allow-partial：放行但标记 partial，并逐条列出缺的必填库', () => {
    sb = makeSandbox({ servicesConfig: 'real' });
    multiEnv(sb);
    const { dir, manifestPath } = packageDir(sb, 'partial', ['amsg.sqlite']);
    const r = sb.runTool(['verify', '--dir', dir, '--manifest', manifestPath, '--registry', '--env-file', sb.envFile, '--allow-partial']);
    expect(r.status, r.output).toBe(0);
    const out = JSON.parse(r.stdout) as { ok: boolean; partial: boolean; warnings: string[] };
    expect(out.ok).toBe(true);
    expect(out.partial).toBe(true);
    expect(out.warnings).toEqual(expect.arrayContaining(['partial_missing_required:heartbeat.sqlite']));
  });

  it('四个必填库齐全：verify --registry 通过且 partial=false', () => {
    sb = makeSandbox({ servicesConfig: 'real' });
    multiEnv(sb);
    const { dir, manifestPath } = packageDir(sb, 'full', ['amsg.sqlite', 'proactive-push.sqlite', 'heartbeat.sqlite', 'sullyos-home.sqlite']);
    const r = sb.runTool(['verify', '--dir', dir, '--manifest', manifestPath, '--registry', '--env-file', sb.envFile]);
    expect(r.status, r.output).toBe(0);
    const out = JSON.parse(r.stdout) as { partial: boolean; problems: string[] };
    expect(out.partial).toBe(false);
    expect(out.problems).toEqual([]);
  });

  it('包内 unknown 库仍然拒绝（--registry），即使包自称 complete', () => {
    sb = makeSandbox({ servicesConfig: 'real' });
    multiEnv(sb);
    const { dir, manifestPath } = packageDir(sb, 'unknown', ['amsg.sqlite', 'proactive-push.sqlite', 'heartbeat.sqlite', 'sullyos-home.sqlite', 'alpha.sqlite']);
    const r = sb.runTool(['verify', '--dir', dir, '--manifest', manifestPath, '--registry', '--env-file', sb.envFile]);
    expect(r.status, r.output).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('unknown_db:alpha.sqlite');
  });
});

describe('db-manifest verify：包内文件名与旧包兼容', () => {
  it('拒绝 ../、绝对路径、含路径分隔符的库名（bad_name），即使 hash/size 都对', () => {
    for (const bad of ['../evil.sqlite', '/tmp/evil.sqlite', 'sub/evil.sqlite', '..\\evil.sqlite', '']) {
      sb = makeSandbox({ servicesConfig: 'fixture' });
      const dir = path.join(sb.root, 'bad-name');
      mkdirSync(dir, { recursive: true });
      const buf = Buffer.from('SQLite format 3\u0000' + 'x'.repeat(64));
      writeFileSync(path.join(dir, 'evil.sqlite'), buf);
      writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        manifestVersion: 2,
        complete: true,
        sources: [{ service: 'x', bindKey: 'DB', name: bad, sizeBytes: buf.length, sha256: shaBuf(buf) }],
        required: [],
        absent: [],
        problems: [],
      }));
      const r = sb.runTool(['verify', '--dir', dir, '--manifest', path.join(dir, 'manifest.json')]);
      expect(r.status, `name=${JSON.stringify(bad)} ${r.output}`).not.toBe(0);
      expect(r.output).toContain('bad_name');
      sb.cleanup();
    }
  });

  it('旧版 v1 manifest（无 required/optional 字段）仍可作为合法旧包通过 verify', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const alpha = path.join(sb.dataDir, 'alpha.sqlite');
    sb.makeDb(alpha, 'legacy');
    const dir = path.join(sb.root, 'legacy-v1');
    mkdirSync(dir, { recursive: true });
    const buf = readFileSync(alpha);
    writeFileSync(path.join(dir, 'alpha.sqlite'), buf);
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      manifestVersion: 1,
      tool: 'db-manifest',
      complete: true,
      sources: [{ service: 'alpha', name: 'alpha.sqlite', sizeBytes: buf.length, sha256: shaBuf(buf), integrity: 'ok' }],
      absent: [],
      unlisted: [],
    }));
    const r = sb.runTool(['verify', '--dir', dir, '--manifest', path.join(dir, 'manifest.json')]);
    expect(r.status, r.output).toBe(0);
  });

  it('包内出现 manifest 之外的 sqlite（夹带）必须让 verify 失败', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const alpha = path.join(sb.dataDir, 'alpha.sqlite');
    sb.makeDb(alpha, 'a');
    const dir = path.join(sb.root, 'extra-db');
    mkdirSync(dir, { recursive: true });
    const buf = readFileSync(alpha);
    writeFileSync(path.join(dir, 'alpha.sqlite'), buf);
    writeFileSync(path.join(dir, 'smuggled.sqlite'), buf);
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      manifestVersion: 2,
      complete: true,
      sources: [{ service: 'alpha', name: 'alpha.sqlite', sizeBytes: buf.length, sha256: shaBuf(buf) }],
      required: [{ service: 'alpha', name: 'alpha.sqlite' }],
      optional: [],
      absent: [],
      problems: [],
    }));
    const r = sb.runTool(['verify', '--dir', dir, '--manifest', path.join(dir, 'manifest.json')]);
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toContain('smuggled.sqlite');
  });
});
