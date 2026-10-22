/**
 * 记忆协商的「接线纪律」回归。
 *
 * 前台那段关键词邻接判定（`resolveClarification`）只是措辞层的死代码：
 * 证据不足时它一律返回未决，但**绝不能**被接进任何写事实的路径，也不能反过来
 * 让关键词命中变成「已确认」。这里用源码扫描钉住这件事，避免将来有人顺手接上
 * 之后没有任何测试报警。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { buildMemoryNegotiationBlock } from './memoryNegotiation';

const ROOT = process.cwd();
const SCAN_DIRS = ['utils', 'worker', 'components', 'hooks', 'apps', 'context', 'features', 'services', 'api'];
const SELF = join('utils', 'memoryNegotiation.ts');

const walk = (dir: string, out: string[] = []): string[] => {
    let entries: string[] = [];
    try {
        entries = readdirSync(dir);
    } catch {
        return out;
    }
    for (const name of entries) {
        if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
        const full = join(dir, name);
        let stat;
        try {
            stat = statSync(full);
        } catch {
            continue;
        }
        if (stat.isDirectory()) walk(full, out);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
};

describe('关键词邻接判定不接事实', () => {
    it('除本模块自身外，没有任何生产代码调用 resolveClarification', () => {
        const callers: string[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(join(ROOT, dir))) {
                const rel = file.slice(ROOT.length + 1);
                if (rel === SELF) continue;
                let source = '';
                try {
                    source = readFileSync(file, 'utf8');
                } catch {
                    continue;
                }
                if (/\bresolveClarification\b/.test(source)) callers.push(rel.split(sep).join('/'));
            }
        }
        expect(callers).toEqual([]);
    });

    it('本模块是纯叶子：不 import 数据库 / 账本 / 记忆节点模块，也不发网络请求', () => {
        const source = readFileSync(join(ROOT, SELF), 'utf8');
        for (const forbidden of [
            /^import[^\n]*from '[^']*\/db'/m,
            /^import[^\n]*from '[^']*memoryPalace/m,
            /\bindexedDB\b/,
            /\bfetch\s*\(/,
        ]) {
            expect(source).not.toMatch(forbidden);
        }
    });

    it('协商提示词只讲判断纪律，不含任何「写记忆」捷径指令', () => {
        const block = buildMemoryNegotiationBlock();
        expect(block).not.toMatch(/\[\[MEMORY/i);
        expect(block).not.toMatch(/必须记住|请记住这条|写入记忆/);
        // 它讲的是「怎么判断」，不是「怎么落库」
        expect(block).toContain('猜测');
    });
});
