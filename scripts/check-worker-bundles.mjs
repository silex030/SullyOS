#!/usr/bin/env node
// 检查「入库的 worker bundle」是否跟源码同步。
//
// 为什么要这个：worker/<name>/worker.bundle.js 是构建产物，但它跟着 git 一起提交（CF 面板
// 手动上传用）。2026-10-21 实测踩过：入库的 amsg bundle 比 src 落后 590 行 / 8 个文件，而
// 两边的 AMSG_BUNDLE_VERSION 常量还都写着同一个日期——程序「以为」自己是最新的，用户装上去
// 跑的是三天前的代码，测试也一条不会红（全仓 0 个用例校验 bundle）。
//
// 做法：跑一遍 build:workers，然后看产物有没有变化。有变化 = 有人在改了 src 之后忘了重建，
// 退出码 1 并列出文件清单。变化本身就是修法（把重建后的 bundle 一起提交），所以这里不自动还原。

import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

try {
    execFileSync(process.execPath, [resolve(root, 'scripts/build-workers.mjs')], {
        cwd: root,
        stdio: 'inherit',
    });
} catch (e) {
    console.error('[check:workers] build:workers 自身失败', e?.message ?? e);
    process.exit(1);
}

let status = '';
try {
    status = execFileSync('git', ['status', '--porcelain', '--', 'worker', 'public'], {
        cwd: root,
        encoding: 'utf8',
    }).trim();
} catch (e) {
    console.warn('[check:workers] 没有 git 或不在仓库里，跳过比对', e?.message ?? e);
    process.exit(0);
}

if (status) {
    console.error('\n[check:workers] ❌ 入库的 worker bundle 与源码不同步：\n');
    console.error(status);
    console.error('\n修法：把重建后的产物一起提交（git add worker public && git commit）。');
    console.error('别只改 src 就收工——线上跑的是这些 bundle。');
    process.exit(1);
}

console.log('[check:workers] ✓ worker bundle 与源码一致');
