// @vitest-environment jsdom
/**
 * 行程地图面板（B5）。
 *
 * 钉住的行为：
 * - 关闭面板 → 整块卸载（地图实例随之销毁，由 canvas 的 destroy 用例兜底）；
 * - 共享关闭 → 不渲染任何行程内容；
 * - 暂停 / 过期 / 未确认各有明确文案，ETA 未知就写「未知」，不编分钟数；
 * - 不出现遥控人格的按钮（没有「前往 / 改目的地 / 移动 TA」）；
 * - 不在界面上暴露坐标精度（无小数坐标串）。
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import TravelMapPanel, {
    TRAVEL_PHASE_COPY,
    formatEtaLabel,
    formatUpdatedAt,
    resolvePanelStatus,
    type TravelPanelView,
} from './TravelMapPanel';
import type { TravelCharacterView } from '../../utils/travel/activityPresentation';
import type { TravelTripStatus } from '../../contracts/travel';

const chars: TravelCharacterView[] = [
    { id: 'c1', name: '小满' },
    { id: 'c2', name: '阿岚' },
];

const view = (over: Partial<TravelPanelView> = {}): TravelPanelView => ({
    phase: 'en_route',
    origin: { label: '云栖小区', city: '杭州', district: '西湖区' },
    destination: { label: '晓风书屋', city: '杭州', district: '西湖区' },
    position: { lat: 30.2741, lng: 120.1551 },
    routePoints: [
        { lat: 30.2741, lng: 120.1551 },
        { lat: 30.281, lng: 120.162 },
    ],
    distanceM: 860,
    etaMs: 7 * 60 * 1000,
    updatedAt: Date.parse('2026-10-23T10:20:00+08:00'),
    ...over,
});

const render = (props: Partial<React.ComponentProps<typeof TravelMapPanel>> = {}) =>
    renderToStaticMarkup(
        <TravelMapPanel
            open
            characters={chars}
            activeCharId="c1"
            view={view()}
            shareEnabled
            amapJsKey="k"
            amapServiceHost="/_AMapService"
            licensedGeometry
            onClose={() => {}}
            {...props}
        />,
    );

describe('TravelMapPanel · 状态文案', () => {
    it('九种相位都有中文文案，不留 undefined', () => {
        const statuses: TravelTripStatus[] = [
            'considering',
            'planned',
            'en_route',
            'dwelling',
            'returning',
            'returned',
            'stopped',
            'aborted',
            'expired',
            'unavailable',
        ];
        for (const s of statuses) expect(TRAVEL_PHASE_COPY[s]).toBeTruthy();
        expect(TRAVEL_PHASE_COPY.en_route).toContain('路上');
        expect(TRAVEL_PHASE_COPY.dwelling).toContain('停留');
        // 在外结束 ≠ 已回家：文案不能把「停在书店」说成「到家了」。
        expect(TRAVEL_PHASE_COPY.stopped).not.toContain('回家');
    });

    it('暂停优先于过程状态，过期明确写「已过期」', () => {
        expect(resolvePanelStatus(view({ paused: true })).title).toBe('已暂停');
        expect(resolvePanelStatus(view({ paused: true })).tone).toBe('warn');
        expect(resolvePanelStatus(view({ phase: 'expired' })).title).toBe('已过期');
        expect(resolvePanelStatus(view({ phase: 'unavailable' })).tone).toBe('muted');
        // 新终态 stopped：静音、没有 ETA 明细，也不能落进「进行中」分支。
        const stopped = resolvePanelStatus(view({ phase: 'stopped' }));
        expect(stopped.title).toBe(TRAVEL_PHASE_COPY.stopped);
        expect(stopped.detail).toBeNull();
        expect(stopped.tone).toBe('muted');
    });

    it('失败/未确认不伪装成进行中', () => {
        const stale = resolvePanelStatus(view({ stale: true }));
        expect(stale.title).toContain('未确认');
        expect(stale.detail).toContain('最后更新');
    });

    it('ETA 未知就写「未知」，不拿动画帧或直线距离估算', () => {
        expect(formatEtaLabel(null)).toBe('预计到达时间未知');
        expect(formatEtaLabel(undefined)).toBe('预计到达时间未知');
        expect(formatEtaLabel(7 * 60 * 1000)).toBe('约 7 分钟');
        expect(formatEtaLabel(0)).toBe('即将到达');
        expect(formatEtaLabel(-5)).toBe('即将到达');
        expect(formatEtaLabel(59_000)).toBe('约 1 分钟');
    });

    it('最后更新时间格式化带日期分支（跨天不冒充今天）', () => {
        const now = Date.parse('2026-10-23T10:30:00+08:00');
        expect(formatUpdatedAt(now - 10 * 60 * 1000, now)).toMatch(/最后更新 \d{2}:\d{2}/);
        const old = formatUpdatedAt(Date.parse('2026-10-20T09:05:00+08:00'), now);
        expect(old).toContain('10-20');
        expect(formatUpdatedAt(null, now)).toBeNull();
    });
});

describe('TravelMapPanel · 结构', () => {
    it('关闭时不渲染，地图随之卸载', () => {
        expect(render({ open: false })).toBe('');
    });

    it('共享关闭时不渲染任何行程内容', () => {
        expect(render({ shareEnabled: false })).toBe('');
    });

    it('打开时含地图、头像针、底部轻拟物地点卡与两处地名', () => {
        const html = render();
        expect(html).toContain('data-testid="travel-map-panel"');
        expect(html).toContain('data-testid="travel-map-container"');
        expect(html).toContain('data-testid="travel-place-card"');
        expect(html).toContain('云栖小区');
        expect(html).toContain('晓风书屋');
        // 轻拟物材质卡：实心卡片 + 柔和阴影，不是整面板玻璃
        expect(html).toContain('shadow-');
    });

    it('多角色可切换，单角色不显示切换器', () => {
        expect(render()).toContain('data-testid="travel-panel-char-switch"');
        expect(render({ characters: [chars[0]!] })).not.toContain('data-testid="travel-panel-char-switch"');
    });

    it('没有遥控入口：不出现前往/改目的地/移动类按钮', () => {
        const html = render();
        expect(html).not.toContain('前往');
        expect(html).not.toContain('改目的地');
        expect(html).not.toContain('移动');
        expect(html).not.toContain('带 TA 去');
    });

    it('不显示坐标精度，也不自称 GPS', () => {
        const html = render();
        expect(html).not.toMatch(/\d{2,3}\.\d{3,}/);
        expect(html).toContain('模拟行程');
        expect(html).not.toContain('GPS 定位');
    });

    it('ETA 为空时面板明写未知', () => {
        const html = render({ view: view({ etaMs: null }) });
        expect(html).toContain('预计到达时间未知');
    });

    it('暂停态明确写「已暂停」并说明不会推进', () => {
        const html = render({ view: view({ paused: true }) });
        expect(html).toContain('已暂停');
        expect(html).toContain('未确认');
    });

    it('错误码给出面向用户的中文文案并可重试', () => {
        const html = render({ view: null, errorCode: 'PROVIDER_FAILED' });
        expect(html).toContain('地图服务暂时不可用');
        expect(html).toContain('data-testid="travel-panel-retry"');
    });

    it('加载中是三点 dots / 文案，不是假地图', () => {
        const html = render({ view: null, loading: true });
        expect(html).toContain('data-testid="travel-panel-loading"');
        expect(html).not.toContain('data-testid="travel-map-container"');
    });
});
