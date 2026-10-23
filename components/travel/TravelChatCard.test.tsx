// @vitest-environment jsdom
/**
 * 聊天里的行程卡片（B5）。
 *
 * 关键约束：
 * - 缩略图必须是**宿主传入的授权同源服务 URL**（比如 `/travel/staticmap?...`），
 *   组件自己绝不拼高德地址、不碰任何服务 key（key 只在服务端）；
 * - 没有缩略图时退成纯文字，并明确写「缩略图暂不可用」，不装作地图完整；
 * - 共享关闭 → 什么都不渲染；
 * - ETA 未知写未知，不编数字；不出现坐标串。
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import TravelChatCard, { type TravelChatCardProps } from './TravelChatCard';

const base: TravelChatCardProps = {
    charName: '小满',
    phase: 'en_route',
    originLabel: '云栖小区',
    destinationLabel: '晓风书屋',
    etaMs: 7 * 60 * 1000,
    shareEnabled: true,
    onOpen: () => {},
};

const render = (over: Partial<TravelChatCardProps> = {}) =>
    renderToStaticMarkup(<TravelChatCard {...base} {...over} />);

describe('TravelChatCard · 真实缩略图与降级', () => {
    it('有授权同源 URL 时原样作为 img src，不额外拼参数', () => {
        const url = '/travel/staticmap/trip-t1.png?sig=abc';
        const html = render({ mapThumbnailUrl: url });
        expect(html).toContain('data-testid="travel-card-thumb"');
        expect(html).toContain(`src="${url}"`);
        // 组件不拼服务 key、不直连高德 REST
        expect(html).not.toContain('restapi.amap.com');
        expect(html).not.toContain('webapi.amap.com');
        expect(html).not.toContain('key=');
    });

    it('没有缩略图时退成文字，并明说地图缩略图不可用', () => {
        const html = render();
        expect(html).not.toContain('<img');
        expect(html).toContain('data-testid="travel-card-map-fallback"');
        expect(html).toContain('地图缩略图暂不可用');
        // 只是文字信息，不能暗示「完整地图」
        expect(html).not.toContain('查看地图');
        expect(html).toContain('仅文字');
    });

    it('空串 URL 也走降级分支', () => {
        const html = render({ mapThumbnailUrl: '   ' });
        expect(html).toContain('data-testid="travel-card-map-fallback"');
        expect(html).not.toContain('<img');
    });
});

describe('TravelChatCard · 状态与隐私', () => {
    it('共享关闭时不渲染任何内容', () => {
        expect(render({ shareEnabled: false })).toBe('');
    });

    it('ETA 未知明写未知', () => {
        const html = render({ etaMs: null });
        expect(html).toContain('预计到达时间未知');
    });

    it('暂停与过期各自有明确状态字', () => {
        expect(render({ paused: true })).toContain('已暂停');
        expect(render({ phase: 'expired' })).toContain('已过期');
    });

    it('不泄露坐标精度，也不自称 GPS', () => {
        const html = render({
            mapThumbnailUrl: '/travel/staticmap/trip-t1.png',
            positionLabel: '西湖区',
        });
        expect(html).not.toMatch(/\d{2,3}\.\d{3,}/);
        expect(html).not.toContain('GPS');
        expect(html).toContain('西湖区');
    });

    it('卡片本身可点开面板，但不提供任何遥控按钮', () => {
        const html = render({ mapThumbnailUrl: '/travel/staticmap/trip-t1.png' });
        expect(html).toContain('data-testid="travel-card-open"');
        expect(html).toContain('aria-label');
        expect(html).not.toContain('前往');
        expect(html).not.toContain('改目的地');
    });

    it('点击卡片触发 onOpen（jsdom 事件）', () => {
        const onOpen = vi.fn();
        const act = (React as unknown as { act: (cb: () => void) => void }).act;
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        act(() => {
            root.render(<TravelChatCard {...base} onOpen={onOpen} />);
        });
        const btn = host.querySelector('[data-testid="travel-card-open"]') as HTMLElement | null;
        expect(btn).not.toBeNull();
        act(() => {
            btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(onOpen).toHaveBeenCalledTimes(1);
        act(() => root.unmount());
        host.remove();
    });
});
