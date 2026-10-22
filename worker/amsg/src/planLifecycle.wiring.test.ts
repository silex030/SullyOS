/**
 * 计划生命周期 · 静态约束（发布阻断项 5）。
 *
 * 「超时 / unknown 不自动重试」「人工重试只能由人开新代」这两条，光靠运行时用例
 * 容易被后来新增的一条自动重试路径悄悄破坏。这里直接扫源码钉住。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC_DIR = __dirname;

const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (name.endsWith('.ts')) out.push(full);
    }
    return out;
};

const productionSources = () => walk(SRC_DIR).filter((file) => !file.endsWith('.test.ts')
    && !file.includes(`${path.sep}test${path.sep}`));

describe('计划生命周期 · 不自动重试', () => {
    it('retryAutonomyPlanManually 只有定义、没有生产调用方（人工入口不是自动链）', () => {
        const callers = productionSources().filter((file) => {
            const src = readFileSync(file, 'utf8');
            return src.includes('retryAutonomyPlanManually')
                && !file.endsWith(`${path.sep}autonomyStore.ts`);
        });
        expect(callers).toEqual([]);
    });

    it('到点队列只捞 proposed：failed / unknown / cancelled 不会被下一跳再跑一次', () => {
        const store = readFileSync(path.join(SRC_DIR, 'autonomyStore.ts'), 'utf8');
        const fnAt = store.indexOf('export async function listDueAutonomyPlans');
        expect(fnAt).toBeGreaterThan(-1);
        const body = store.slice(fnAt, fnAt + 1200);
        expect(body).toContain("status = 'proposed'");
        expect(body).not.toContain("'unknown'");
        expect(body).not.toContain("'failed'");
        expect(body).not.toContain("'cancelled'");
    });

    it('released 的认领行是改名让位，不是删除（历史审计留得住）', () => {
        const store = readFileSync(path.join(SRC_DIR, 'autonomyStore.ts'), 'utf8');
        expect(store).not.toMatch(/DELETE FROM autonomy_plan_runs/);
        expect(store).toContain("idempotency_key = idempotency_key || ':released:' || id");
    });

    it('取消待办要求没被租约占住（running 不能被撤）', () => {
        const store = readFileSync(path.join(SRC_DIR, 'autonomyStore.ts'), 'utf8');
        const fnAt = store.indexOf('export async function cancelPendingAutonomyPlans');
        const body = store.slice(fnAt, fnAt + 900);
        expect(body).toContain("status IN ('proposed', 'scheduled')");
        expect(body).toContain('lease_until');
    });
});
