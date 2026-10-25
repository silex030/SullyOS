// scripts/deploy-vps.mjs
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { compareAssetSets, run, newestMtimeMs } from './sync-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.SULLYOS_VPS_SSH;
if (!HOST) {
  console.error('缺少 SULLYOS_VPS_SSH（格式 user@host，如 root@156.238.248.237），已停止，未动任何东西。');
  process.exit(1);
}
if (!/^[^-][^@\s]+@[^-][^@\s]+$/.test(HOST)) {
  console.error('SULLYOS_VPS_SSH 格式非法（期望 user@host，且 user/host 不得以 - 开头），已停止，未动任何东西。');
  process.exit(1);
}
const DIST = join(ROOT, 'dist');
const TGZ_LOCAL = join(ROOT, '.tmp-frontend-dist.tgz');
const TGZ_REMOTE = '/tmp/frontend-dist.tgz';
const REMOTE_DIR = '/opt/sullyos/frontend-dist';
// 线上正式地址（2026-10-25：ethernet.bot.cd 那份 Vercel 已弃用，VPS 自托管走 link 子域）
const PUBLIC_URL = process.env.SULLYOS_PUBLIC_URL || 'https://link.ethernet.bot.cd/';

function sh(cmd, args) {
  const r = run(cmd, args, { cwd: ROOT });
  if (!r.ok) { console.error('FAILED: ' + cmd + ' ' + args.join(' ') + '\n' + r.stdout.slice(-2000)); process.exit(1); }
  const m = /backup: (\S+)/.exec(r.stdout);
  if (m) console.log(m[0]);
  return r.stdout;
}
// 新鲜度：源码比 dist 新则先重建，保证推的即所见
if (!existsSync(join(DIST, 'index.html')) || (existsSync(DIST) && newestMtimeMs(ROOT) > newestMtimeMs(DIST))) {
  console.log('dist stale, rebuilding...');
  sh('pnpm', ['build']);
}
sh(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-czf', TGZ_LOCAL, '-C', ROOT, 'dist']);
sh('scp', [TGZ_LOCAL, HOST + ':' + TGZ_REMOTE]);
// stamp 精确到秒（YYYYMMDD-HHMMSS），防一分钟内连推备份同名嵌套
const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
const out = sh('ssh', [HOST, `if [ -d ${REMOTE_DIR} ]; then mv ${REMOTE_DIR} ${REMOTE_DIR}.bak-${stamp} && echo "backup: ${REMOTE_DIR}.bak-${stamp}"; fi && mkdir -p ${REMOTE_DIR} && tar -xzf ${TGZ_REMOTE} -C ${REMOTE_DIR} --strip-components=1 && test -f ${REMOTE_DIR}/index.html && test -d ${REMOTE_DIR}/assets && echo STATIC_OK && rm -f ${TGZ_REMOTE}`]);
if (!out.includes('STATIC_OK')) {
  console.error('REMOTE VERIFY FAILED: STATIC_OK missing, stop.');
  process.exit(1);
}
const remoteHtml = run(process.platform === 'win32' ? 'curl.exe' : 'curl', ['-s', '--noproxy', '*', PUBLIC_URL], { cwd: ROOT });
const cmp = compareAssetSets(readFileSync(join(DIST, 'index.html'), 'utf8'), remoteHtml.stdout);
if (!cmp.ok) {
  console.error('ASSET MISMATCH, stop. onlyLocal=' + JSON.stringify(cmp.onlyLocal) + ' onlyRemote=' + JSON.stringify(cmp.onlyRemote));
  process.exit(1);
}
rmSync(TGZ_LOCAL, { force: true });
sh('ssh', [HOST, `ls -dt ${REMOTE_DIR}.bak-* 2>/dev/null | tail -n +4 | xargs -r rm -rf`]);
console.log('DEPLOY OK. Rollback: ssh ' + HOST + ' "rm -rf ' + REMOTE_DIR + ' && mv <backup-dir> ' + REMOTE_DIR + '"（备份名见上方 backup: 行）');
