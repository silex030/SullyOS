/**
 * 前端出行数据 · 隐私脱敏（B4）
 *
 * 这一层的职责：坐标 / 原始 address / 住户级门牌永远不离开「地图渲染层」。
 * 提示词、日志、备份、聊天卡片都只能拿 masked 语义（地名 + 城市 + 区）。
 */
import { describe, expect, it } from 'vitest';
import {
    assertPromptSafe,
    containsDecimalCoordinates,
    containsHouseholdDetail,
    maskAnchorForPrompt,
    maskPlaceForPrompt,
    scanTextForLeak,
    stripLocationFieldsDeep,
} from './privacy';

describe('stripLocationFieldsDeep 结构性剥离', () => {
    it('连嵌套对象里的坐标、路线、历史、address 一起剥掉', () => {
        const input = {
            trip: {
                id: 't1',
                origin: { label: '阳光花园', city: '杭州', lat: 30.26, lng: 120.13, coordSys: 'gcj02', address: '阳光花园5号楼2单元' },
                dest: { label: '西湖公园', city: '杭州', lat: 30.25, lng: 120.15, coordSys: 'gcj02' },
                departAt: 1,
            },
            position: { lat: 30.255, lng: 120.14, coordSys: 'gcj02' },
            route: { points: [{ lat: 1, lng: 2 }], distanceM: 10 },
            history: [{ lat: 3, lng: 4 }],
            budget: { mapCallsUsed: 1, mapCallsLimit: 30 },
        };
        const out = stripLocationFieldsDeep(input);
        const wire = JSON.stringify(out);
        expect(wire).not.toMatch(/"lat"|"lng"|"coordSys"|"address"|"position"|"route"|"history"/);
        expect(wire).toContain('阳光花园');
        expect(wire).toContain('西湖公园');
        expect(out.budget.mapCallsUsed).toBe(1);
        // 不改入参
        expect(input.trip.origin.lat).toBe(30.26);
    });

    it('数组里的元素也被剥，不放过 route.points 这种形态', () => {
        const out = stripLocationFieldsDeep({ points: [{ lat: 1, lng: 2, label: 'a' }, { lat: 3, lng: 4 }] });
        expect(JSON.stringify(out)).not.toMatch(/"lat"|"lng"/);
        expect(out.points[0].label).toBe('a');
    });
});

describe('文本级泄露检测', () => {
    it('小数坐标对能被认出来（3 位以上小数）', () => {
        expect(containsDecimalCoordinates('去 30.1234,120.5678 那边')).toBe(true);
        expect(containsDecimalCoordinates('30.1234，120.5678')).toBe(true);
        expect(containsDecimalCoordinates('中山路100号')).toBe(false);
        expect(containsDecimalCoordinates('30号门')).toBe(false);
    });

    it('住户级门牌能被认出来，公共门牌不误伤', () => {
        for (const bad of ['3栋2单元501', '阳光花园5号楼2单元', '人民路8号3室', '门牌12']) {
            expect(containsHouseholdDetail(bad), bad).toBe(true);
        }
        for (const ok of ['中山路100号', 'XX社区3号门', '西湖公园']) {
            expect(containsHouseholdDetail(ok), ok).toBe(false);
        }
    });

    it('scanTextForLeak 给出原因，干净文本返回空数组', () => {
        expect(scanTextForLeak('去西湖公园坐一会儿')).toEqual([]);
        expect(scanTextForLeak('30.1234,120.5678')).toContain('COORDINATES');
        expect(scanTextForLeak('3栋2单元501')).toContain('HOUSEHOLD_DETAIL');
        expect(scanTextForLeak('')).toEqual([]);
    });

    it('assertPromptSafe 宁可拒绝也不发送可疑文本', () => {
        expect(assertPromptSafe('TA 现在在西湖公园附近散步')).toEqual({
            ok: true,
            text: 'TA 现在在西湖公园附近散步',
        });
        const bad = assertPromptSafe('坐标 30.1234,120.5678');
        expect(bad.ok).toBe(false);
        if (!bad.ok) expect(bad.reasons).toContain('COORDINATES');
    });
});

describe('只出地名语义', () => {
    it('maskPlaceForPrompt 不吃 address / 坐标字段', () => {
        const out = maskPlaceForPrompt({
            label: '阳光花园',
            city: '杭州',
            district: '西湖区',
            address: '阳光花园5号楼2单元',
            lat: 30.26,
            lng: 120.13,
        } as never);
        expect(Object.keys(out).sort()).toEqual(['city', 'district', 'label']);
        expect(JSON.stringify(out)).not.toMatch(/30\.26|120\.13|号楼/);
    });

    it('maskPlaceForPrompt 遇到住户级 label 直接降级成城市级，不原样透出', () => {
        const out = maskPlaceForPrompt({ label: '阳光花园5号楼2单元', city: '杭州' });
        expect(out.label).toBe('');
        expect(out.city).toBe('杭州');
    });

    it('maskAnchorForPrompt 只保留白名单字段', () => {
        const out = maskAnchorForPrompt({
            label: '阳光花园',
            city: '杭州',
            district: '西湖区',
            lat: 30.26,
            lng: 120.13,
            coordSys: 'gcj02',
            precision: 'area',
            confirmedAt: 1,
            source: 'user',
        });
        expect(out).toEqual({ label: '阳光花园', city: '杭州', district: '西湖区' });
    });
});
