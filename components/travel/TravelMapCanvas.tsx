/**
 * 行程地图画布（B5）：真地图，不造图。
 *
 * 三条路径，全部由 props 决定，组件不去猜：
 * 1. `adapter`（国外 / 以后换 provider）→ 走可注入的 {@link TravelMapAdapter}；
 * 2. 高德 JS API 2.0（国内默认）→ `utils/travel/amapJsLoader` 加载官方脚本，
 *    `_AMapService` 同源反代已经在 loader 里先于脚本设置；
 * 3. 其它情况 → 明确的「地图暂不可用 + 原因」文字态。
 *
 * 硬红线：
 * - **不画假地图**：不可用时不产出 canvas / SVG / 折线占位，也不加载任何公共瓦片；
 * - **不画假路线**：`routePoints` 只有 `licensedGeometry` 为真才接受；没有几何就只是没有线，
 *   绝不拿两点连直线、也不按动画帧插值；
 * - **不遮官方标识**：容器只预留底部归属位，logo / 审图号由官方 JS 自己画，我们不覆盖；
 * - 卸载即 `destroy()`：面板一关，地图实例必须真的被拆掉（协议 3.5：不缓存服务数据）。
 */
import React, { useEffect, useRef } from 'react';
import type { TravelCoordSys, TravelLatLng } from '../../contracts/travel';
import {
    AMAP_SERVICE_PREFIX,
    loadAmapJs,
    normalizeServiceHost,
    type AmapMapLike,
    type AmapNamespace,
    type AmapOverlayLike,
} from '../../utils/travel/amapJsLoader';

/** 国外 / 换源用：宿主注入一个正式地图实现（例如 Mapbox GL），本文件不打包任何 SDK。 */
export interface TravelMapAdapterContext {
    container: HTMLElement;
    center: TravelLatLng;
    zoom: number;
    coordSys: TravelCoordSys;
}

export interface TravelMapAdapterHandle {
    setCenter: (center: TravelLatLng, zoom?: number) => void;
    setPosition: (position: TravelLatLng | null) => void;
    setRoute: (points: readonly TravelLatLng[] | null) => void;
    destroy: () => void;
}

export interface TravelMapAdapter {
    id: string;
    coordSys: TravelCoordSys;
    mount: (context: TravelMapAdapterContext) => Promise<TravelMapAdapterHandle>;
}

export type TravelMapUnavailableReason =
    | 'NO_KEY'
    | 'NO_SECURITY_CONFIG'
    | 'INVALID_SERVICE_HOST'
    | 'NO_POSITION'
    | 'COORD_SYS_MISMATCH'
    | 'ADAPTER_MISSING';

export type TravelMapProvider = 'amap' | 'adapter';

export type TravelMapCanvasState =
    | { state: 'ready'; provider: TravelMapProvider }
    | { state: 'unavailable'; reason: TravelMapUnavailableReason };

export interface TravelMapCanvasProps {
    /** 地图中心（一般就是角色当前位置；null = 没有可信位置）。 */
    center: TravelLatLng | null;
    position?: TravelLatLng | null;
    routePoints?: readonly TravelLatLng[] | null;
    /** 未取得几何展示/保存许可时传 false：不画路线、不插值。 */
    licensedGeometry?: boolean;
    zoom?: number;
    coordSys?: TravelCoordSys;
    avatarUrl?: string | null;
    charName?: string;
    amapJsKey?: string | null;
    /** 同源反代，形如 `/_AMapService`；jscode 只在服务端。 */
    amapServiceHost?: string | null;
    adapter?: TravelMapAdapter | null;
    interactive?: boolean;
    onReady?: () => void;
    onError?: (info: { reason: TravelMapUnavailableReason | 'MOUNT_FAILED'; message: string }) => void;
    className?: string;
}

const UNAVAILABLE_COPY: Record<TravelMapUnavailableReason, string> = {
    NO_KEY: '尚未配置地图展示密钥',
    NO_SECURITY_CONFIG: `尚未配置同源安全代理（${AMAP_SERVICE_PREFIX}）`,
    INVALID_SERVICE_HOST: `安全代理地址不合法，必须以 ${AMAP_SERVICE_PREFIX} 结尾`,
    NO_POSITION: '还没有可信的位置',
    COORD_SYS_MISMATCH: '坐标系与地图不匹配，已拒绝绘制',
    ADAPTER_MISSING: '该地区的地图服务暂未接入',
};

export interface CanvasStateInput {
    adapter?: TravelMapAdapter | null;
    amapJsKey?: string | null;
    amapServiceHost?: string | null;
    center?: TravelLatLng | null;
    coordSys?: TravelCoordSys;
}

/**
 * 判定能否出图。顺序是刻意的：
 * adapter > 坐标系 > key > 安全代理 > 位置。每一档都给可解释的原因。
 */
export const resolveCanvasState = (input: CanvasStateInput): TravelMapCanvasState => {
    const coordSys = input.coordSys ?? 'gcj02';
    if (input.adapter) {
        return input.center ? { state: 'ready', provider: 'adapter' } : { state: 'unavailable', reason: 'NO_POSITION' };
    }
    if (!String(input.amapJsKey ?? '').trim()) {
        // 国外坐标走的是另一套 provider：没有 adapter 就是「暂未接入」，不是 key 没配。
        return { state: 'unavailable', reason: coordSys === 'wgs84' ? 'ADAPTER_MISSING' : 'NO_KEY' };
    }
    if (!String(input.amapServiceHost ?? '').trim()) return { state: 'unavailable', reason: 'NO_SECURITY_CONFIG' };
    if (!normalizeServiceHost(input.amapServiceHost)) {
        return { state: 'unavailable', reason: 'INVALID_SERVICE_HOST' };
    }
    if (coordSys !== 'gcj02') return { state: 'unavailable', reason: 'COORD_SYS_MISMATCH' };
    if (!input.center) return { state: 'unavailable', reason: 'NO_POSITION' };
    return { state: 'ready', provider: 'amap' };
};

/**
 * 路线点串闸门：无许可 / 点不够 → 空数组（地图上没有线）。
 * 注意这不叫「降级成直线」——空数组就是不画。
 */
export const routePathOf = (
    points: readonly TravelLatLng[] | null | undefined,
    licensed: boolean,
): TravelLatLng[] => {
    if (!licensed || !points || points.length < 2) return [];
    return points
        .filter((p) => typeof p?.lat === 'number' && typeof p?.lng === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lng))
        .map((p) => ({ lat: p.lat, lng: p.lng }));
};

const toAmapLngLat = (p: TravelLatLng): [number, number] => [p.lng, p.lat];

const initialOf = (name?: string): string => (name || '?').trim().slice(0, 1) || '?';

/** 头像地图针：轻拟物材质（与悬浮球同基因），不用 glass 面板。 */
const createPinElement = (avatarUrl: string | null | undefined, charName?: string): HTMLElement | null => {
    if (typeof document === 'undefined') return null;
    const wrap = document.createElement('div');
    wrap.setAttribute('data-travel-pin', '1');
    wrap.style.cssText = [
        'width:38px',
        'height:46px',
        'display:flex',
        'align-items:flex-start',
        'justify-content:center',
        'filter:drop-shadow(0 6px 12px rgba(15,23,42,0.35))',
    ].join(';');

    const ball = document.createElement('div');
    ball.style.cssText = [
        'width:36px',
        'height:36px',
        'border-radius:9999px',
        'overflow:hidden',
        'background:linear-gradient(165deg,#ffffff 0%,#e9edf3 100%)',
        'border:2px solid rgba(255,255,255,0.95)',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'font:500 15px/1 system-ui,sans-serif',
        'color:#475569',
    ].join(';');

    if (avatarUrl) {
        const img = document.createElement('img');
        img.src = avatarUrl;
        img.alt = '';
        img.setAttribute('draggable', 'false');
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;pointer-events:none;';
        ball.appendChild(img);
    } else {
        ball.textContent = initialOf(charName);
    }
    wrap.appendChild(ball);
    return wrap;
};

interface ActiveMapHandle {
    setCenter: (center: TravelLatLng, zoom?: number) => void;
    setPosition: (position: TravelLatLng | null) => void;
    setRoute: (points: readonly TravelLatLng[] | null) => void;
    destroy: () => void;
}

const adaptHandle = (handle: TravelMapAdapterHandle): ActiveMapHandle => ({
    setCenter: (center, zoom) => handle.setCenter?.(center, zoom),
    setPosition: (position) => handle.setPosition?.(position),
    setRoute: (points) => handle.setRoute?.(points),
    destroy: () => handle.destroy?.(),
});

const TravelMapCanvas: React.FC<TravelMapCanvasProps> = ({
    center,
    position = null,
    routePoints = null,
    licensedGeometry = false,
    zoom = 15,
    coordSys = 'gcj02',
    avatarUrl = null,
    charName,
    amapJsKey = null,
    amapServiceHost = null,
    adapter = null,
    interactive = true,
    onReady,
    onError,
    className = '',
}) => {
    const state = resolveCanvasState({ adapter, amapJsKey, amapServiceHost, center, coordSys });
    const containerRef = useRef<HTMLDivElement | null>(null);
    const handleRef = useRef<ActiveMapHandle | null>(null);
    const callbacksRef = useRef({ onReady, onError });
    callbacksRef.current = { onReady, onError };

    const provider = state.state === 'ready' ? state.provider : null;
    const host = normalizeServiceHost(amapServiceHost);
    const mountKey = `${provider ?? 'none'}|${adapter?.id ?? ''}|${amapJsKey ?? ''}|${host ?? ''}|${coordSys}`;

    // 挂载 / 卸载：面板关闭时组件卸载 = 地图实例 destroy（不缓存任何服务数据）
    useEffect(() => {
        if (!provider || !center) return;
        const container = containerRef.current;
        if (!container || typeof window === 'undefined') return;

        let cancelled = false;
        let disposed = false;

        const dispose = () => {
            if (disposed) return;
            disposed = true;
            try {
                handleRef.current?.destroy();
            } catch {
                // destroy 失败不应阻断卸载流程
            }
            handleRef.current = null;
        };

        const mount = async () => {
            if (adapter) {
                const mounted = await adapter.mount({ container, center, zoom, coordSys });
                if (cancelled) {
                    try {
                        mounted.destroy?.();
                    } catch {
                        // 忽略
                    }
                    return;
                }
                handleRef.current = adaptHandle(mounted);
                handleRef.current.setPosition(position ?? center);
                handleRef.current.setRoute(routePathOf(routePoints, licensedGeometry));
                callbacksRef.current.onReady?.();
                return;
            }

            const AMap: AmapNamespace = await loadAmapJs({
                key: amapJsKey,
                serviceHost: amapServiceHost,
            });
            if (cancelled) return;

            const map: AmapMapLike = new AMap.Map(container, {
                center: toAmapLngLat(center),
                zoom,
                viewMode: '2D',
                resizeEnable: true,
                dragEnable: interactive,
                zoomEnable: interactive,
                doubleClickZoom: interactive,
                scrollWheel: interactive,
            });

            const overlays: Array<AmapOverlayLike | unknown> = [];
            let marker: AmapOverlayLike | null = null;
            let line: AmapOverlayLike | null = null;

            const pin = createPinElement(avatarUrl, charName);
            if (AMap.Marker) {
                marker = new AMap.Marker({
                    position: toAmapLngLat(position ?? center),
                    content: pin ?? undefined,
                    anchor: 'bottom-center',
                    zIndex: 130,
                    ...(AMap.Pixel ? { offset: new AMap.Pixel(0, 0) } : {}),
                });
                overlays.push(marker);
            }
            if (AMap.Polyline) {
                line = new AMap.Polyline({
                    path: routePathOf(routePoints, licensedGeometry).map(toAmapLngLat),
                    strokeColor: '#3b82f6',
                    strokeWeight: 6,
                    strokeOpacity: 0.9,
                    lineJoin: 'round',
                    lineCap: 'round',
                    showDir: true,
                    zIndex: 120,
                });
                overlays.push(line);
            }
            if (overlays.length) map.add?.(overlays);
            try {
                map.setFitView?.(overlays);
            } catch {
                // setFitView 在只有一个点时可能抛错，保持 center 即可
            }

            handleRef.current = {
                setCenter: (next, nextZoom) => {
                    map.setZoomAndCenter?.(nextZoom ?? zoom, toAmapLngLat(next));
                },
                setPosition: (next) => {
                    if (next) {
                        marker?.show?.();
                        marker?.setPosition?.(toAmapLngLat(next));
                    } else {
                        marker?.hide?.();
                    }
                },
                setRoute: (next) => {
                    const path = routePathOf(next, licensedGeometry).map(toAmapLngLat);
                    if (path.length >= 2) {
                        line?.show?.();
                        line?.setPath?.(path);
                    } else {
                        line?.hide?.();
                    }
                },
                destroy: () => {
                    try {
                        map.destroy?.();
                    } catch {
                        // 忽略
                    }
                },
            };
            callbacksRef.current.onReady?.();
        };

        mount().catch((error: unknown) => {
            if (cancelled) return;
            const message = error instanceof Error ? error.message : '地图初始化失败';
            callbacksRef.current.onError?.({ reason: 'MOUNT_FAILED', message });
        });

        return () => {
            cancelled = true;
            dispose();
        };
        // 只在「换 provider / 换 key / 换坐标系」时重建；位置与路线走下面的增量 effect
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mountKey]);

    // 位置增量更新（不重建地图）
    useEffect(() => {
        handleRef.current?.setPosition(position ?? null);
    }, [position?.lat, position?.lng]);

    // 路线增量更新（无许可时仍是空数组 → 不画线）
    useEffect(() => {
        handleRef.current?.setRoute(routePathOf(routePoints, licensedGeometry));
    }, [routePoints, licensedGeometry]);

    if (state.state === 'unavailable') {
        return (
            <div
                data-testid="travel-map-unavailable"
                className={`relative flex flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center ${className}`}
            >
                <div className="text-[12px] font-medium text-slate-600">地图暂不可用</div>
                <div className="text-[10px] leading-relaxed text-slate-500">
                    {UNAVAILABLE_COPY[state.reason]}
                </div>
            </div>
        );
    }

    return (
        <div
            data-testid="travel-map-canvas"
            className={`relative rounded-2xl overflow-hidden border border-white/70 bg-slate-100 ${className}`}
        >
            {/* 官方 JS API 自己画底图与 logo/审图号；这里只给容器，不铺任何自绘底图 */}
            <div ref={containerRef} data-testid="travel-map-container" className="absolute inset-0" />

            {/* 跟随对象提示：不是第二枚地图针，只是「在看谁」 */}
            {(avatarUrl || charName) && (
                <div
                    data-testid="travel-map-follow-chip"
                    className="absolute left-1.5 top-1.5 flex items-center gap-1.5 rounded-full pl-0.5 pr-2 py-0.5"
                    style={{
                        background: 'rgba(255,255,255,0.92)',
                        boxShadow: '0 2px 8px rgba(15,23,42,0.16)',
                        border: '1px solid rgba(255,255,255,0.9)',
                    }}
                >
                    {avatarUrl ? (
                        <img
                            src={avatarUrl}
                            alt=""
                            draggable={false}
                            className="w-5 h-5 rounded-full object-cover"
                        />
                    ) : (
                        <span className="w-5 h-5 rounded-full bg-slate-200 flex items-center justify-center text-[9px] font-medium text-slate-600">
                            {initialOf(charName)}
                        </span>
                    )}
                    <span className="text-[9px] text-slate-600">{charName ?? '当前行程'}</span>
                </div>
            )}

            {!licensedGeometry && (
                <div
                    data-testid="travel-map-geometry-unlicensed"
                    className="absolute right-1.5 top-1.5 max-w-[60%] rounded-xl px-2 py-1 text-[9px] leading-relaxed text-slate-600"
                    style={{ background: 'rgba(255,255,255,0.92)', border: '1px solid rgba(148,163,184,0.35)' }}
                >
                    路线暂不可用（未配置授权）
                </div>
            )}

            {/* 归属位：右下角，避开官方 logo（左下）与审图号，不覆盖任何官方标识 */}
            <div
                data-testid="travel-map-attribution"
                className="absolute right-1 bottom-0.5 text-[8px] leading-none text-slate-500/90 pointer-events-none"
            >
                {state.provider === 'amap' ? '地图数据 © 高德地图' : '地图归属见服务提供方'}
            </div>
        </div>
    );
};

export default TravelMapCanvas;
