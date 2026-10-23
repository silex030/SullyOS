/**
 * 前端出行数据 · 预算读口（B4）
 *
 * 前端只读、只展示：真正的限额由服务端账本执行。这里唯一的职责是**不要撒谎**——
 * 读不到账本就当不可用（fail-closed），不拿任何默认额度补；
 * 负数 / NaN / Infinity 的 used 视为账本被写坏，同样不可用。
 */
import { describe, expect, it, vi } from 'vitest';
import type { TravelBudgetState } from '../../contracts/travel';
import { readBudgetView } from './budgetClient';
import type { TravelApiResult } from './api';

const budget = (over: Partial<TravelBudgetState> = {}): TravelBudgetState => ({
    userId: 'u_1',
    dayKey: '2026-10-23',
    mapCallsUsed: 3,
    mapCallsLimit: 30,
    llmTokensUsed: 100,
    llmTokensLimit: 10_000,
    paused: false,
    version: 1,
    ...over,
});

const ok = (b: TravelBudgetState): TravelApiResult<TravelBudgetState> => ({ ok: true, data: b });

describe('读不到账本一律 fail-closed', () => {
    it('API 失败：不返回任何默认额度，两个闸都关', async () => {
        const api = { readBudget: vi.fn(async (): Promise<TravelApiResult<TravelBudgetState>> => ({ ok: false, code: 'NETWORK', status: 0 })) };
        const out = await readBudgetView(api);
        expect(out.known).toBe(false);
        expect(out.state).toBeNull();
        expect(out.error).toBe('NETWORK');
        expect(out.gate.map).toEqual({ allowed: false, code: 'BUDGET_BLOCKED' });
        expect(out.gate.llm).toEqual({ allowed: false, code: 'BUDGET_BLOCKED' });
        expect(out.remaining.map).toBeNull();
        expect(out.remaining.llm).toBeNull();
    });

    it('设置/账本字段缺失也不补默认值（不出现 30 这种兜底）', async () => {
        const api = { readBudget: vi.fn(async () => ok({ ...budget(), mapCallsLimit: undefined } as unknown as TravelBudgetState)) };
        const out = await readBudgetView(api);
        expect(out.known).toBe(false);
        expect(out.gate.map.allowed).toBe(false);
        expect(out.remaining.map).toBeNull();
    });

    it('负数 used 视为写坏的账本，判不可用（不是「还有额度」）', async () => {
        const api = { readBudget: vi.fn(async () => ok(budget({ mapCallsUsed: -1 }))) };
        const out = await readBudgetView(api);
        expect(out.gate.map.allowed).toBe(false);
        expect(out.remaining.map).toBeNull();
        // LLM 那一列没被写坏，仍可用
        expect(out.gate.llm.allowed).toBe(true);
    });

    it('非有限 used（NaN / Infinity）整份账本不可读，两列都关', async () => {
        for (const used of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            const api = { readBudget: vi.fn(async () => ok(budget({ mapCallsUsed: used }))) };
            const out = await readBudgetView(api);
            expect(out.known, String(used)).toBe(false);
            expect(out.gate.map.allowed, String(used)).toBe(false);
            expect(out.gate.llm.allowed, String(used)).toBe(false);
            expect(out.remaining.map).toBeNull();
            expect(out.remaining.llm).toBeNull();
        }
    });
});

describe('额度语义与展示数字', () => {
    it('正常账本：还剩 limit-used，暂停优先', async () => {
        const api = { readBudget: vi.fn(async () => ok(budget())) };
        const out = await readBudgetView(api);
        expect(out.known).toBe(true);
        expect(out.gate.map).toEqual({ allowed: true });
        expect(out.remaining.map).toBe(27);
        expect(out.remaining.llm).toBe(9_900);

        const paused = await readBudgetView({ readBudget: vi.fn(async () => ok(budget({ paused: true }))) });
        expect(paused.gate.map.allowed).toBe(false);
        expect(paused.gate.llm.allowed).toBe(false);
    });

    it('limit=0 是硬零，不是「用默认值」', async () => {
        const out = await readBudgetView({ readBudget: vi.fn(async () => ok(budget({ mapCallsLimit: 0 }))) });
        expect(out.gate.map).toEqual({ allowed: false, code: 'BUDGET_ZERO' });
        expect(out.gate.llm.allowed).toBe(true);
        expect(out.remaining.map).toBe(0);
    });

    it('用完即拦，剩余不为负', async () => {
        const out = await readBudgetView({ readBudget: vi.fn(async () => ok(budget({ mapCallsUsed: 31 }))) });
        expect(out.gate.map.allowed).toBe(false);
        expect(out.remaining.map).toBe(0);
    });

    it('展示文案只说「今天还能用几次」，不承诺额度会重置', async () => {
        const out = await readBudgetView({ readBudget: vi.fn(async () => ok(budget())) });
        expect(out.summary).toContain('地图');
        expect(out.summary).not.toMatch(/明天|重置|无限|默认/);
    });
});
