// vps-backend/deploy/scripts/__tests__/sandbox-isolation.test.ts
// 证明测试隔离本身成立：不是「环境变量 + 假 PATH」，而是 mount+net 命名空间遮蔽。
// 这些用例保护的是「测试不再有可能写生产」这条前提，而不是业务逻辑。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ISOLATION, diffSnapshots, makeSandbox, prodSnapshot, type Sandbox } from './sandbox';

let sb: Sandbox | undefined;
afterEach(() => {
  if (sb) {
    sb.cleanup();
    sb = undefined;
  }
});

describe('测试沙箱隔离（mount + net namespace）', () => {
  it('本机支持 unshare -m -n，且 /opt/sullyos 能在命名空间内被 tmpfs 遮蔽', () => {
    expect(ISOLATION.available, `隔离不可用，必须报告不能跑而不是退回假 PATH：${ISOLATION.detail}`).toBe(true);
  });

  it('命名空间内对 /opt/sullyos 与 /var/log 的写入不落到真实文件（内容哈希前后一致）', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    const before = prodSnapshot();
    const realLog = '/var/log/sullyos-backup.log';
    let realLogBefore: string | null = null;
    try {
      realLogBefore = `${statSync(realLog).size}:${readFileSync(realLog).length}`;
    } catch {
      realLogBefore = null;
    }

    // 在隔离命名空间里“恶意”写生产路径：如果遮蔽失效，这里会真的改到生产库/日志。
    const r = sb.runIsolated('/bin/bash', ['-c', `
set -e
echo 'ESCAPE-ATTEMPT' >> /opt/sullyos/data/amsg.sqlite 2>/dev/null || echo no-data-dir
echo 'ESCAPE-ATTEMPT' >> /var/log/sullyos-backup.log 2>/dev/null || echo no-log-dir
mkdir -p /opt/sullyos/data && echo x > /opt/sullyos/data/should-not-exist.sqlite
ls /opt/sullyos/data
`]);
    expect(r.status, r.output).toBe(0);
    // 命名空间里看到的是遮蔽后的空 tmpfs，不是真实数据目录
    expect(r.stdout).not.toContain('amsg.sqlite-wal');
    expect(r.stdout).toContain('should-not-exist.sqlite');

    const after = prodSnapshot();
    const diff = diffSnapshots(before, after);
    expect(diff.added, `命名空间写穿透: ${diff.added.join(',')}`).toEqual([]);
    expect(diff.changed, `命名空间写穿透: ${diff.changed.join(',')}`).toEqual([]);
    expect(diff.removed).toEqual([]);
    if (realLogBefore !== null) {
      expect(`${statSync(realLog).size}:${readFileSync(realLog).length}`).toBe(realLogBefore);
    }
  });

  it('子进程环境拒绝携带疑似生产凭据（GITHUB_*_PAT 等）', () => {
    sb = makeSandbox({ servicesConfig: 'fixture' });
    expect(() => sb!.run('/bin/true', [], { GITHUB_BACKUP_PAT: 'ghp_fake' })).toThrow(/凭据/);
    expect(() => sb!.runTool(['list'], { GITHUB_PAT: 'ghp_fake' })).toThrow(/凭据/);
  });

  it('生产快照比较的是内容哈希，而不只是文件名（内容被覆盖也能发现）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snap-probe-'));
    const file = path.join(dir, 'db.sqlite');
    writeFileSync(file, 'AAAA');
    const before = { [file]: `4:${'a'.repeat(8)}:0` };
    // 直接验证 diff 语义：同名同大小、内容不同 → changed
    const afterSameName = { [file]: `4:${'b'.repeat(8)}:0` };
    const diff = diffSnapshots(before, afterSameName);
    expect(diff.changed).toEqual([file]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('在线库自身的 -wal/-shm 抖动被单独归类为 tolerated，不与真实越界混淆', () => {
    const diff = diffSnapshots(
      { '/opt/sullyos/data/amsg.sqlite': '1:a:0', '/opt/sullyos/data/amsg.sqlite-wal': '2:b:0' },
      { '/opt/sullyos/data/amsg.sqlite': '1:a:0', '/opt/sullyos/data/amsg.sqlite-wal': '3:c:0' },
    );
    expect(diff.changed).toEqual([]);
    expect(diff.tolerated).toEqual(['/opt/sullyos/data/amsg.sqlite-wal']);
  });
});
