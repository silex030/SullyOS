import { describe, it, expect } from 'vitest';
import { safeParseJson, tryParseJson } from './safeJson';

describe('safeParseJson', () => {
    it('正常解析对象与数组', () => {
        expect(safeParseJson('{"a":1}', {})).toEqual({ a: 1 });
        expect(safeParseJson('[1,2]', [] as number[])).toEqual([1, 2]);
    });

    it('坏 JSON 返回 fallback 而不是抛错（导出路径上不允许一个坏键炸掉整条链路）', () => {
        expect(safeParseJson('{坏掉的', { a: 1 })).toEqual({ a: 1 });
        expect(safeParseJson('undefined', null)).toBeNull();
        expect(safeParseJson('{"a":', [])).toEqual([]);
    });

    it('null / undefined / 空串直接给 fallback', () => {
        expect(safeParseJson(null, 'fb')).toBe('fb');
        expect(safeParseJson(undefined, 'fb')).toBe('fb');
        expect(safeParseJson('', 'fb')).toBe('fb');
    });

    it('JSON 里的 null 也走 fallback（调用方约定 fallback 才是"没有值"）', () => {
        expect(safeParseJson('null', {})).toEqual({});
    });

    it('合法但为假值的内容不被当成失败（0 / false / "" 要保留）', () => {
        expect(safeParseJson('0', 99)).toBe(0);
        expect(safeParseJson('false', true)).toBe(false);
        expect(safeParseJson('""', 'fb')).toBe('');
    });
});

describe('tryParseJson', () => {
    it('成功时给出 value', () => {
        expect(tryParseJson<{ a: number }>('{"a":2}')).toEqual({ ok: true, value: { a: 2 } });
    });

    it('失败时给出 error，调用方可以报警', () => {
        const r = tryParseJson('{坏');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBeInstanceOf(Error);
    });

    it('空输入算失败（与 safeParseJson 的 fallback 语义区分开）', () => {
        expect(tryParseJson(null).ok).toBe(false);
        expect(tryParseJson('').ok).toBe(false);
    });
});
