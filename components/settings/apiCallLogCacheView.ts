import { apiCallCacheHitRate } from '../../utils/apiCallLog';
import type { ApiCallLogEntry } from '../../utils/apiCallLog';

/**
 * API 调用记录里的缓存读数展示（纯函数）。
 *
 * 契约来自 utils/llmUsage.ts + utils/apiCallLog.ts：缺失 ≠ 0。
 * 只有 `cachedTokens`（prompt 的子集）与 `promptTokens` 同时提供才算命中率；
 * Anthropic 式 cacheRead / cacheWrite 只展示原始计数，绝不拿来除以输入 token。
 * 所以这里的每个缺值都写「未提供」，不写 0 / 0%。
 */

export type CacheBearingEntry = Pick<
    ApiCallLogEntry,
    'promptTokens' | 'cachedTokens' | 'cacheReadTokens' | 'cacheWriteTokens'
>;

export const CACHE_MISSING_TEXT = '未提供';

const fmt = (n: number) => n.toLocaleString('en-US');

/** token 计数：null/undefined = 未提供，0 是供应商真的报了 0。 */
export const formatCacheTokens = (value?: number): string =>
    value == null || !Number.isFinite(value) ? CACHE_MISSING_TEXT : fmt(value);

/** 命中率：null（缺分子/分母/语义不明）= 未提供；真实 0 才显示 0%。 */
export const formatCacheRate = (hit: { rate: number } | null): string => {
    if (!hit || !Number.isFinite(hit.rate)) return CACHE_MISSING_TEXT;
    const pct = Math.max(0, hit.rate * 100);
    const rounded = Math.round(pct * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
};

export interface EntryCacheView {
    /** 供应商这次有没有给任何缓存读数（决定整行是详细展示还是「未提供」）。 */
    hasAny: boolean;
    hitTokens: string;
    hitRate: string;
    readTokens: string;
    writeTokens: string;
    /** 单行摘要，缺值时只有「未提供」没有 0。 */
    summary: string;
}

export function describeEntryCache(entry: CacheBearingEntry): EntryCacheView {
    const hit = apiCallCacheHitRate({
        promptTokens: entry.promptTokens,
        cachedTokens: entry.cachedTokens,
    });
    const hitTokens = formatCacheTokens(entry.cachedTokens);
    const hitRate = formatCacheRate(hit);
    const readTokens = formatCacheTokens(entry.cacheReadTokens);
    const writeTokens = formatCacheTokens(entry.cacheWriteTokens);
    const hasAny = entry.cachedTokens != null || entry.cacheReadTokens != null || entry.cacheWriteTokens != null;

    return {
        hasAny,
        hitTokens,
        hitRate,
        readTokens,
        writeTokens,
        summary: hasAny
            ? `命中 ${hitTokens} · 命中率 ${hitRate} · 读 ${readTokens} · 写 ${writeTokens}`
            : '缓存读数未提供（供应商这次没有返回缓存字段）',
    };
}

export interface CacheTotalView {
    hitTokens: string;
    hitRate: string;
    /** 「提供了缓存命中的记录数 / 总记录数」——汇总只覆盖这一部分，别当成全局命中率。 */
    coverage: string;
    /** 「能同时提供输入与命中的记录数 / 总记录数」——命中率的分母覆盖范围。 */
    rateCoverage: string;
}

export function describeCacheTotal(entries: CacheBearingEntry[]): CacheTotalView {
    const total = entries.length;
    const withCache = entries.filter(entry => entry.cachedTokens != null);
    const withRate = entries.filter(entry => apiCallCacheHitRate(entry) != null);

    const cachedSum = withCache.reduce((sum, entry) => sum + (entry.cachedTokens ?? 0), 0);
    const rateNumerator = withRate.reduce((sum, entry) => sum + (entry.cachedTokens ?? 0), 0);
    const rateDenominator = withRate.reduce((sum, entry) => sum + (entry.promptTokens ?? 0), 0);

    return {
        hitTokens: withCache.length > 0 ? fmt(cachedSum) : CACHE_MISSING_TEXT,
        hitRate: rateDenominator > 0 ? formatCacheRate({ rate: rateNumerator / rateDenominator }) : CACHE_MISSING_TEXT,
        coverage: `${withCache.length}/${total}`,
        rateCoverage: `${withRate.length}/${total}`,
    };
}
