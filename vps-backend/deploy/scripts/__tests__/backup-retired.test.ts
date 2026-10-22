// vps-backend/deploy/scripts/__tests__/backup-retired.test.ts
//
// 退役守卫（2026-10-22）：VPS 侧「三通道自动备份」整条链路刻意下线，只保留前端
// GitHub Releases / WebDAV 备份。这组用例不做功能验证，只锁住三件事：
//   ① 不再存在可被误跑的备份/恢复脚本入口（文件、npm script、install.sh 都不许重建它）；
//   ② 退役说明在，且写清了「旧包只读离线查看」与「别跑恢复脚本」；
//   ③ 前端备份链路没有被顺手砍掉（它是现在唯一受支持的备份通道）。
// 纯文件系统断言：不连网、不碰数据库、不执行任何 shell。
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(HERE, '..');
const BACKEND = path.resolve(SCRIPTS, '../..');
const REPO = path.resolve(BACKEND, '..');

const read = (p: string) => readFileSync(p, 'utf8');

describe('VPS 备份链路已退役（守卫）', () => {
  it('备份/恢复脚本与清单工具都不在仓库里', () => {
    for (const name of ['backup.sh', 'restore.sh', 'db-manifest.mjs', 'vacuum-snapshot.cjs']) {
      expect(existsSync(path.join(SCRIPTS, name)), `${name} 不应存在`).toBe(false);
    }
  });

  it('package.json 不再暴露 backup / restore 入口（secret-scan 保留）', () => {
    const pkg = JSON.parse(read(path.join(BACKEND, 'package.json')));
    const scripts = pkg.scripts || {};
    expect(scripts.backup).toBeUndefined();
    expect(scripts.restore).toBeUndefined();
    expect(scripts['secret-scan']).toBe('bash deploy/scripts/secret-scan.sh');
  });

  it('.env.example 不再宣传只被退役脚本读取的备份变量', () => {
    const env = read(path.join(BACKEND, '.env.example'));
    for (const key of [
      'GITHUB_BACKUP_REPO',
      'GITHUB_BACKUP_PAT',
      'BACKUP_KEEP',
      'BACKUP_ENCRYPT_PASSPHRASE',
    ]) {
      expect(env.includes(key), `${key} 应已从模板移除`).toBe(false);
    }
    // 历史上 GITHUB_PAT 只给 backup.sh 的代码通道用；模板里不该再出现它的赋值行
    expect(/^GITHUB_PAT=/m.test(env)).toBe(false);
  });

  it('install.sh 不会顺手装回备份脚本或定时任务', () => {
    const install = read(path.join(SCRIPTS, 'install.sh'));
    expect(install.includes('backup.sh')).toBe(false);
    expect(install.includes('crontab')).toBe(false);
    expect(install.includes('timer')).toBe(false);
  });

  it('退役说明在，并写清「旧包只读离线查看」与「不要再跑恢复脚本」', () => {
    const doc = path.join(SCRIPTS, 'BACKUP-RETIRED.md');
    expect(existsSync(doc)).toBe(true);
    const text = read(doc);
    for (const needle of ['openssl enc -d', 'tar -xzf', 'manifest.json', '不要', 'mktemp -d']) {
      expect(text.includes(needle), `退役说明缺少：${needle}`).toBe(true);
    }
    // 说明里必须给出「唯一受支持的恢复路径」
    expect(text.includes('导入备份包')).toBe(true);
  });

  it('前端 GitHub Releases 备份链路仍在（唯一受支持的备份通道）', () => {
    const client = read(path.join(REPO, 'utils/githubClient.ts'));
    expect(client.includes('uploadBackup')).toBe(true);
    const osContext = read(path.join(REPO, 'context/OSContext.tsx'));
    expect(osContext.includes('cloudBackupToWebDAV')).toBe(true);
    // 出包前的脱敏仍在同一条路径上
    expect(osContext.includes('stripBackupSecrets')).toBe(true);
  });

  it('部署目录里不再有指向已删脚本的引用', () => {
    const deployRoot = path.resolve(SCRIPTS, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(sh|service|md|js|mjs|json|toml)$/.test(entry.name)) continue;
        if (full === path.join(SCRIPTS, 'BACKUP-RETIRED.md')) continue;
        if (read(full).includes('deploy/scripts/backup.sh')) offenders.push(path.relative(REPO, full));
      }
    };
    walk(deployRoot);
    expect(offenders).toEqual([]);
  });
});
