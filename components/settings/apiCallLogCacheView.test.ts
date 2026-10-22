import { describe, it, expect } from 'vitest';
import { describeCacheTotal, describeEntryCache } from './apiCallLogCacheView';

/**
 * 缓存读数展示：缺失 ≠ 0。
 * 只有「输入 Token 与缓存命中 Token 同时提供」才算得出命中率，其余一律「未提供」。
 */

describe('describeEntryCache —— 缺值不显示 0', () => {
    it('供应商一个缓存字段都没给 → 全部未提供，命中率未提供', () => {
        const view = describeEntryCache({ promptTokens: 1200 });
        expect(view.hasAny).toBe(false);
        expect(view.hitTokens).toBe('未提供');
        expect(view.hitRate).toBe('未提供');
        expect(view.readTokens).toBe('未提供');
        expect(view.writeTokens).toBe('未提供');
        expect(view.summary).toContain('未提供');
        expect(view.summary).not.toMatch(/0\s*%/);
    });

    it('给了缓存命中与输入 Token → 算出命中率', () => {
        const view = describeEntryCache({ promptTokens: 2000, cachedTokens: 1500 });
        expect(view.hasAny).toBe(true);
        expect(view.hitTokens).toBe('1,500');
        expect(view.hitRate).toBe('75%');
    });

    it('只有缓存命中、没有输入 Token → 展示原始计数，命中率未提供', () => {
        const view = describeEntryCache({ cachedTokens: 900 });
        expect(view.hitTokens).toBe('900');
        expect(view.hitRate).toBe('未提供');
    });

    it('Anthropic 式缓存读/写单独展示，不拿它当命中率', () => {
        const view = describeEntryCache({ promptTokens: 1000, cacheReadTokens: 800, cacheWriteTokens: 120 });
        expect(view.hitTokens).toBe('未提供');
        expect(view.hitRate).toBe('未提供');
        expect(view.readTokens).toBe('800');
        expect(view.writeTokens).toBe('120');
        expect(view.hasAny).toBe(true);
    });

    it('供应商真的报了 0 命中 → 0% 是真实值，不是缺值', () => {
        const view = describeEntryCache({ promptTokens: 1000, cachedTokens: 0 });
        expect(view.hitTokens).toBe('0');
        expect(view.hitRate).toBe('0%');
    });
});

describe('describeCacheTotal —— 汇总只算提供了缓存读数的记录', () => {
    it('没有一条带缓存字段 → 未提供 + 覆盖 0', () => {
        const total = describeCacheTotal([{ promptTokens: 100 }, { promptTokens: 200 }]);
        expect(total.hitTokens).toBe('未提供');
        expect(total.hitRate).toBe('未提供');
        expect(total.coverage).toBe('0/2');
    });

    it('按「缓存命中 / 输入」汇总，缺分母的记录不进比例', () => {
        const total = describeCacheTotal([
            { promptTokens: 2000, cachedTokens: 1000 },
            { promptTokens: 2000, cachedTokens: 500 },
            { cachedTokens: 300 },
            { promptTokens: 800 },
        ]);
        expect(total.hitTokens).toBe('1,800');
        // 分母只取前两条（各 2000），分子只取能算比例的部分
        expect(total.hitRate).toBe('37.5%');
        expect(total.coverage).toBe('3/4');
    });
});
