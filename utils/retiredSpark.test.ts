import { describe, expect, it } from 'vitest';
import {
    RETIRED_SPARK_STORAGE_KEYS,
    retireSparkStorage,
    type RetiredStorageLike,
} from './retiredSpark';

/**
 * Spark（社交 App）整块退役后的启动期清理。
 *
 * 代码删干净了，但浏览器里可能还留着 Spark 自己的键。这里锁死四件事：
 *   1. 只删 Spark 独占的那几个键，朋友圈共用的 `spark_char_handles` 一个字节都不动；
 *   2. 别的键（用户其它设置）绝不被误删；
 *   3. 幂等：第二次调用返回 0；
 *   4. 存储不可用时不抛、不阻断启动。
 */

const makeStorage = (seed: Record<string, string> = {}): RetiredStorageLike & { dump: () => Record<string, string> } => {
    const map = new Map(Object.entries(seed));
    return {
        getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
        removeItem: (key: string) => { map.delete(key); },
        dump: () => Object.fromEntries(map),
    };
};

describe('retiredSpark · 启动期一次性清理', () => {
    it('删掉 Spark 独占的三个键，并返回清掉的键数', () => {
        const storage = makeStorage({
            spark_douban_groups: '["hangzhou"]',
            spark_douban_hidden: '["123"]',
            spark_user_id: '95279527',
        });

        expect(retireSparkStorage(storage)).toBe(3);
        expect(storage.dump()).toEqual({});
    });

    it('保留朋友圈共用的 spark_char_handles（Moments 仍在读写）', () => {
        const handles = JSON.stringify({ 'char-1': [{ handle: '小号A', note: '' }] });
        const storage = makeStorage({ spark_char_handles: handles, spark_user_id: '1' });

        expect(retireSparkStorage(storage)).toBe(1);
        expect(storage.getItem('spark_char_handles')).toBe(handles);
    });

    it('不误删其它 Spark 前缀或无关设置的键（精确键名匹配）', () => {
        const storage = makeStorage({
            'spark_social_profile': '{}', // 同名前缀但属于 assets，不走这里
            'spark_': 'x',
            os_api_config: '{"apiKey":"k"}',
            user_profile: '{}',
        });

        expect(retireSparkStorage(storage)).toBe(0);
        expect(Object.keys(storage.dump()).sort()).toEqual(
            ['os_api_config', 'spark_', 'spark_social_profile', 'user_profile'].sort(),
        );
    });

    it('幂等：没有残留时返回 0', () => {
        const storage = makeStorage();
        expect(retireSparkStorage(storage)).toBe(0);
        expect(retireSparkStorage(storage)).toBe(0);
    });

    it('存储不可用（null / 抛错）时不抛异常也不阻断启动', () => {
        expect(() => retireSparkStorage(null)).not.toThrow();
        expect(retireSparkStorage(null)).toBe(0);

        const boom: RetiredStorageLike = {
            getItem: () => { throw new Error('SecurityError'); },
            removeItem: () => { throw new Error('SecurityError'); },
        };
        expect(() => retireSparkStorage(boom)).not.toThrow();
        expect(retireSparkStorage(boom)).toBe(0);
    });

    it('清单本身只含 Spark 独占键，防止以后手滑把共用键加进来', () => {
        expect([...RETIRED_SPARK_STORAGE_KEYS]).toEqual([
            'spark_douban_groups',
            'spark_douban_hidden',
            'spark_user_id',
        ]);
        expect(RETIRED_SPARK_STORAGE_KEYS).not.toContain('spark_char_handles');
    });
});
