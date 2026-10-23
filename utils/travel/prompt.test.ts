/**
 * 前端出行数据 · 提示词注入（B4）
 *
 * 断言的重点不是文案好不好听，而是「不许出现什么」：小数坐标、原始地址、楼栋户号，
 * 以及任何凭空造出来的情绪/亲密度。
 */
import { describe, expect, it } from 'vitest';
import { buildTravelPromptBlock } from './prompt';
import { scanTextForLeak } from './privacy';

const trip = (over: Record<string, unknown> = {}) => ({
    origin: { label: '阳光花园', city: '杭州', district: '西湖区' },
    dest: { label: '西湖公园', city: '杭州', district: '西湖区' },
    status: 'en_route' as const,
    departAt: 1_000,
    arriveAt: 2_000,
    ...over,
});

describe('只出地名语义', () => {
    it('正常行程：有地名、有阶段，没有小数坐标/原始地址/楼栋户号', () => {
        const res = buildTravelPromptBlock({
            trip: trip(),
            shareEnabled: true,
            shareKnown: true,
            progress: { phase: 'en_route', etaMs: 8 * 60_000 },
        });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.text).toContain('阳光花园');
        expect(res.text).toContain('西湖公园');
        expect(res.text).toContain('8 分钟');
        expect(res.text).not.toMatch(/\d{1,3}\.\d{3,}/);
        expect(res.text).not.toMatch(/address|栋|单元|室|门牌/);
        expect(scanTextForLeak(res.text)).toEqual([]);
    });

    it('住户级地名降级：label 不出，只保留城市/区', () => {
        const res = buildTravelPromptBlock({
            trip: trip({ origin: { label: '阳光花园5号楼2单元', city: '杭州', district: '西湖区' } }),
            shareEnabled: false,
            shareKnown: true,
        });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.text).not.toContain('5号楼');
        expect(res.text).not.toContain('2单元');
        expect(res.text).toContain('杭州');
        expect(scanTextForLeak(res.text)).toEqual([]);
    });

    it('调用方误塞坐标字段也不会进句子', () => {
        const res = buildTravelPromptBlock({
            trip: {
                ...trip(),
                points: [{ lat: 30.1234, lng: 120.5678 }],
                position: { lat: 30.1234, lng: 120.5678, coordSys: 'gcj02' },
            } as never,
            shareEnabled: true,
            shareKnown: true,
        });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.text).not.toMatch(/30\.1234|120\.5678/);
        expect(res.text).not.toContain('lat');
        expect(res.text).not.toContain('coordSys');
    });

    it('没有 ETA 就说不知道，不编分钟数', () => {
        const res = buildTravelPromptBlock({
            trip: trip(),
            shareEnabled: true,
            shareKnown: true,
            progress: { phase: 'en_route', etaMs: null },
        });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.text).toContain('还不知道');
        expect(res.text).not.toMatch(/\d+\s*分钟/);
    });
});

describe('共享态如实写，不夸大', () => {
    it('共享关闭：明说看不到，并区分「没出门」与「没共享」', () => {
        const res = buildTravelPromptBlock({ trip: trip(), shareEnabled: false, shareKnown: true });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.text).toContain('关着');
        expect(res.text).not.toContain('能看到你走到哪');
        expect(res.text).toContain('不代表');
    });

    it('共享态读失败：按关闭写，不默认「用户能看到」', () => {
        const res = buildTravelPromptBlock({ trip: trip(), shareEnabled: true, shareKnown: false });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.text).toContain('状态未知');
        expect(res.text).not.toContain('能看到你走到哪');
    });
});

describe('不伪造情绪与亲密度', () => {
    it('传入 mood / affinity / 心情分也不会被渲染', () => {
        const res = buildTravelPromptBlock({
            trip: trip(),
            shareEnabled: true,
            shareKnown: true,
            mood: '开心',
            affinity: 88,
            moodScore: 0.92,
        } as never);
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.text).not.toContain('开心');
        expect(res.text).not.toContain('88');
        expect(res.text).not.toMatch(/亲密度|心情|好感/);
    });
});

describe('没有可信数据就不注入', () => {
    it('没有行程也没有愿望 → 空串', () => {
        expect(buildTravelPromptBlock({})).toEqual({ ok: true, text: '' });
        expect(buildTravelPromptBlock({ trip: null, shareEnabled: true })).toEqual({ ok: true, text: '' });
    });

    it('只有愿望：只说想去，不编目的地与阶段', () => {
        const res = buildTravelPromptBlock({ wishText: '想去公园坐一会儿' });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.text).toContain('想去公园坐一会儿');
        expect(res.text).not.toContain('西湖公园');
        expect(res.text).not.toContain('正在路上');
    });
});
