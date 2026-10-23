// @vitest-environment jsdom
/**
 * 真地图画布（B5）。
 *
 * 硬约束（来自交接文档 §3/§5/§7）：
 * - 只用官方 JS API 2.0 / 可注入 adapter；**缺 key、缺 jscode 代理、跨坐标系、
 *   无位置 → 显示「不可用」文字态，绝不画 canvas / SVG 假图、不画直线**；
 * - 路线几何只在有许可时画；无许可连点串都不接受；
 * - 卸载即 destroy（关闭面板必须真的把地图实例拆掉）。
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import TravelMapCanvas, {
    resolveCanvasState,
    routePathOf,
    type TravelMapAdapter,
    type TravelMapAdapterHandle,
} from './TravelMapCanvas';

const act = (React as unknown as { act: (cb: () => void) => void }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const center = { lat: 30.2741, lng: 120.1551 };

describe('TravelMapCanvas · 可用性判定', () => {
    it('注入了 adapter（国外）时优先生效，不需要高德 key', () => {
        const adapter: TravelMapAdapter = {
            id: 'world',
            coordSys: 'wgs84',
            mount: async () => ({ setCenter() {}, setPosition() {}, setRoute() {}, destroy() {} }),
        };
        expect(resolveCanvasState({ adapter, center, coordSys: 'wgs84' })).toEqual({
            state: 'ready',
            provider: 'adapter',
        });
    });

    it('高德 key + 同源 jscode 代理齐全才算 ready', () => {
        expect(resolveCanvasState({ amapJsKey: 'k', amapServiceHost: '/_AMapService', center })).toEqual({
            state: 'ready',
            provider: 'amap',
        });
    });

    it('缺 key / 缺代理各给明确原因（UI 据此说「暂不可用」）', () => {
        expect(resolveCanvasState({ center })).toEqual({ state: 'unavailable', reason: 'NO_KEY' });
        expect(resolveCanvasState({ amapJsKey: 'k', center })).toEqual({
            state: 'unavailable',
            reason: 'NO_SECURITY_CONFIG',
        });
        expect(resolveCanvasState({ amapJsKey: 'k', amapServiceHost: '/amap', center })).toEqual({
            state: 'unavailable',
            reason: 'INVALID_SERVICE_HOST',
        });
    });

    it('没有位置也不硬撑一张空地图', () => {
        expect(resolveCanvasState({ amapJsKey: 'k', amapServiceHost: '/_AMapService', center: null })).toEqual({
            state: 'unavailable',
            reason: 'NO_POSITION',
        });
    });

    it('坐标系不匹配（wgs84 坐标喂高德）直接判不可用，不混datum', () => {
        expect(
            resolveCanvasState({
                amapJsKey: 'k',
                amapServiceHost: '/_AMapService',
                center,
                coordSys: 'wgs84',
            }),
        ).toEqual({ state: 'unavailable', reason: 'COORD_SYS_MISMATCH' });
    });

    it('国外（wgs84）且没有注入 adapter 时如实说「该地区暂未接入」', () => {
        expect(resolveCanvasState({ center, coordSys: 'wgs84' })).toEqual({
            state: 'unavailable',
            reason: 'ADAPTER_MISSING',
        });
    });
});

describe('TravelMapCanvas · 路线几何闸门', () => {
    const points = [center, { lat: 30.28, lng: 120.17 }];

    it('有许可才返回点串', () => {
        expect(routePathOf(points, true)).toEqual(points);
    });

    it('无许可返回空数组——不画直线、不拿两点凑一条路', () => {
        expect(routePathOf(points, false)).toEqual([]);
        expect(routePathOf(null, true)).toEqual([]);
        expect(routePathOf([center], true)).toEqual([]);
        expect(routePathOf(points, false)).toHaveLength(0);
    });
});

describe('TravelMapCanvas · 静态结构（无假图）', () => {
    it('不可用时不产出 canvas / svg，只给文字态', () => {
        const html = renderToStaticMarkup(<TravelMapCanvas center={center} />);
        expect(html).toContain('data-testid="travel-map-unavailable"');
        expect(html).toContain('地图暂不可用');
        expect(html).not.toContain('<canvas');
        expect(html).not.toContain('<svg');
        expect(html).not.toContain('data-testid="travel-map-container"');
    });

    it('未授权时明确写「未配置授权」，而不是装作地图可用', () => {
        const html = renderToStaticMarkup(
            <TravelMapCanvas center={center} amapJsKey="k" amapServiceHost="/_AMapService" licensedGeometry={false} />,
        );
        expect(html).toContain('data-testid="travel-map-container"');
        expect(html).toContain('data-testid="travel-map-geometry-unlicensed"');
        expect(html).toContain('路线暂不可用');
        expect(html).not.toContain('<canvas');
    });

    it('有 key 且同源代理时挂载容器，并预留官方归属位（不遮挡 logo）', () => {
        const html = renderToStaticMarkup(
            <TravelMapCanvas center={center} amapJsKey="k" amapServiceHost="/_AMapService" licensedGeometry />,
        );
        expect(html).toContain('data-testid="travel-map-container"');
        expect(html).toContain('data-testid="travel-map-attribution"');
        expect(html).toContain('高德');
        // 容器自身不叠任何自绘底图
        expect(html).not.toContain('<canvas');
    });

    it('渲染的图像只有角色头像针，且头像 URL 原样属性写出（不拼 key）', () => {
        const html = renderToStaticMarkup(
            <TravelMapCanvas
                center={center}
                amapJsKey="k"
                amapServiceHost="/_AMapService"
                avatarUrl="https://cdn.example.com/a.png"
                charName="小满"
            />,
        );
        expect(html).toContain('https://cdn.example.com/a.png');
        expect(html).not.toContain('restapi.amap.com');
        expect(html).not.toContain('key=');
    });
});

describe('TravelMapCanvas · 生命周期（jsdom 挂载）', () => {
    it('mount 用注入 adapter，卸载时 destroy 真的被调用', async () => {
        const handle: TravelMapAdapterHandle = {
            setCenter: vi.fn(),
            setPosition: vi.fn(),
            setRoute: vi.fn(),
            destroy: vi.fn(),
        };
        const mount = vi.fn(async () => handle);
        const adapter: TravelMapAdapter = { id: 'world', coordSys: 'gcj02', mount };

        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <TravelMapCanvas
                    center={center}
                    coordSys="gcj02"
                    adapter={adapter}
                    licensedGeometry
                    position={center}
                    routePoints={[center, { lat: 30.28, lng: 120.17 }]}
                />,
            );
        });

        await vi.waitFor(() => expect(mount).toHaveBeenCalledTimes(1));
        expect(handle.setPosition).toHaveBeenCalled();
        expect(handle.setRoute).toHaveBeenCalled();

        act(() => root.unmount());
        host.remove();
        expect(handle.destroy).toHaveBeenCalledTimes(1);
    });

    it('无 adapter 且缺 key 时不 mount 任何东西（不偷偷挂第三方脚本）', () => {
        const before = document.querySelectorAll('script').length;
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        act(() => {
            root.render(<TravelMapCanvas center={center} />);
        });
        expect(document.querySelectorAll('script').length).toBe(before);
        expect(host.querySelector('[data-testid="travel-map-container"]')).toBeNull();
        act(() => root.unmount());
        host.remove();
    });
});
