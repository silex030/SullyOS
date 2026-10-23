/**
 * 角色自主出行 · 前端预算读口（B4）
 *
 * 前端不写账本、不调额度，只把服务端的权威数字翻译成「现在能不能用」。
 * 三条不能让步的规则：
 *
 * - **读不到就是不可用**：`readBudget()` 失败 / 形状不对 → `known:false` + 两个闸都关，
 *   绝不出现 `?? 30` 这类默认额度，也不把「读失败」画成「新用户还有 30 次」。
 * - **写坏的账本按不可用处理**：`used` 为负、`NaN`、`Infinity` 都不是「还没用」，
 *   该列直接关闸；另一列没坏就照常用（地图用尽不影响 LLM，反之亦然）。
 * - **展示不承诺重置**：只报今天还剩多少，不写「明天重置」「无限」这类前端无权保证的话。
 */
import type { TravelBudgetState, TravelBudgetKind } from '../../contracts/travel';
import type { TravelApiErrorCode, TravelApiResult } from './api';
import { resolveBudgetGate, type BudgetGate } from './core';

export interface TravelBudgetApi {
    readBudget: () => Promise<TravelApiResult<TravelBudgetState>>;
}

export interface TravelBudgetGateView {
    map: BudgetGate;
    llm: BudgetGate;
}

export interface TravelBudgetView {
    /** 是否读到结构完整的账本（单列写坏不影响这个值）。 */
    known: boolean;
    state: TravelBudgetState | null;
    error: TravelApiErrorCode | null;
    gate: TravelBudgetGateView;
    /** 剩余额度；null = 该列数据不可信（不是 0）。 */
    remaining: { map: number | null; llm: number | null };
    /** 给人看的短句（设置页/诊断用，不写进给用户的聊天）。 */
    summary: string;
}

const blocked: BudgetGate = { allowed: false, code: 'BUDGET_BLOCKED' };

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 账本形状校验：任一计价列缺字段都算没读到。 */
export const isValidBudgetState = (raw: unknown): raw is TravelBudgetState => {
    if (!raw || typeof raw !== 'object') return false;
    const b = raw as Record<string, unknown>;
    return (
        isFiniteNumber(b.mapCallsUsed) &&
        isFiniteNumber(b.mapCallsLimit) &&
        isFiniteNumber(b.llmTokensUsed) &&
        isFiniteNumber(b.llmTokensLimit) &&
        typeof b.dayKey === 'string' &&
        b.dayKey.length > 0 &&
        typeof b.paused === 'boolean' &&
        isFiniteNumber(b.version)
    );
};

/**
 * 单列闸：字段不可信（负数 / 非有限）直接关；否则交给 core 的统一判定
 * （paused 优先、limit=0 硬零、用尽即拦）。
 */
const columnGate = (
    state: TravelBudgetState,
    kind: TravelBudgetKind,
): { gate: BudgetGate; remaining: number | null } => {
    const used = kind === 'map' ? state.mapCallsUsed : state.llmTokensUsed;
    const limit = kind === 'map' ? state.mapCallsLimit : state.llmTokensLimit;
    if (!isFiniteNumber(used) || used < 0 || !isFiniteNumber(limit) || limit < 0) {
        return { gate: blocked, remaining: null };
    }
    return {
        gate: resolveBudgetGate(state, kind),
        remaining: Math.max(0, limit - Math.min(limit, used)),
    };
};

const describe = (gate: TravelBudgetGateView, remaining: { map: number | null; llm: number | null }): string => {
    if (remaining.map === null && remaining.llm === null) return '出行预算暂不可用（没读到账本）';
    const mapText = remaining.map === null ? '地图额度暂不可用' : `地图今天还能用 ${remaining.map} 次`;
    const llmText = remaining.llm === null ? '模型额度暂不可用' : `模型额度还剩 ${remaining.llm} tokens`;
    const tail = gate.map.allowed || gate.llm.allowed ? '' : '（已暂停或已用完）';
    return `${mapText}；${llmText}${tail}`;
};

/** 读一次预算视图。任何异常都落到 fail-closed，不 throw 到 UI。 */
export const readBudgetView = async (api: TravelBudgetApi): Promise<TravelBudgetView> => {
    let res: TravelApiResult<TravelBudgetState>;
    try {
        res = await api.readBudget();
    } catch {
        res = { ok: false, code: 'NETWORK', status: 0 };
    }

    if (!res.ok || !isValidBudgetState(res.data)) {
        return {
            known: false,
            state: null,
            error: res.ok ? 'MALFORMED_RESPONSE' : res.code,
            gate: { map: blocked, llm: blocked },
            remaining: { map: null, llm: null },
            summary: describe({ map: blocked, llm: blocked }, { map: null, llm: null }),
        };
    }

    const state = res.data;
    const map = columnGate(state, 'map');
    const llm = columnGate(state, 'llm');
    const gate = { map: map.gate, llm: llm.gate };
    const remaining = { map: map.remaining, llm: llm.remaining };

    return {
        known: true,
        state,
        error: null,
        gate,
        remaining,
        summary: describe(gate, remaining),
    };
};

/** UI 侧便捷判断：这一列现在能不能发起调用。 */
export const canUseBudget = (view: TravelBudgetView, kind: TravelBudgetKind): boolean => view.gate[kind].allowed;
