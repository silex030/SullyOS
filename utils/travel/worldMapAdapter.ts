/**
 * 角色自主出行 · 国外地图适配（B6）
 *
 * 国内走高德（B5 的 `amapJsLoader` + 同源 `/_AMapService` 反代）；国外保留正式
 * **Mapbox GL JS** 适配器：
 * - 凭证（`token`）与样式（`styleUrl`）都由宿主从构建期配置 / 服务端下发，**不写
 *   localStorage、不进备份**；
 * - 缺凭证就返回 `null`（面板显示「国外地图暂未接入」），**绝不**加载脚本、绝不用
 *   SVG/瓦片拼一张假地图，也不代为注册任何付费账号；
 * - 坐标体系原样带到 canvas（`coordSys`），跨源转换只在 provider 边界做；
 * - 脚本只在真正 mount 时动态加载，卸载即 `remove()`，失败明确抛 `WORLD_MAP_UNAVAILABLE`。
 */
import type { TravelCoordSys, TravelLatLng } from '../../contracts/travel';
import type { TravelMapAdapter, TravelMapAdapterHandle } from '../../components/travel/TravelMapCanvas';

/** 官方 CDN；只在有凭证时加载。 */
export const WORLD_MAP_SCRIPT_URL = 'https://api.mapbox.com/mapbox-gl-js/v3.7.0/mapbox-gl.js';
export const WORLD_MAP_CSS_URL = 'https://api.mapbox.com/mapbox-gl-js/v3.7.0/mapbox-gl.css';
const ROUTE_SOURCE_ID = 'travel-route';

export interface WorldMapConfig {
    token: string;
    styleUrl: string;
}

export type WorldMapLoader = (url: string) => Promise<any>;

export const isWorldMapConfigured = (cfg: Partial<WorldMapConfig> | null | undefined): boolean => {
    const token = String(cfg?.token ?? '').trim();
    const style = String(cfg?.styleUrl ?? '').trim();
    // Mapbox 公钥以 pk. 开头；短串基本是 userId 占位，按未配置处理。
    return token.startsWith('pk.') && token.length >= 20 && !!style;
};

/**
 * 默认加载器：插 `<script>` 后等 onload，返回全局 `mapboxgl`。
 * 仅浏览器可用；非浏览器宿主必须注入 loader（单测都注入）。
 */
export const loadMapboxGlobal: WorldMapLoader = (url) =>
    new Promise((resolve, reject) => {
        const w = typeof window !== 'undefined' ? (window as any) : null;
        if (!w) {
            reject(new Error('WORLD_MAP_UNAVAILABLE:no_window'));
            return;
        }
        if (w.mapboxgl) {
            resolve(w.mapboxgl);
            return;
        }
        const script = w.document.createElement('script');
        script.src = url;
        script.async = true;
        script.onload = () => (w.mapboxgl ? resolve(w.mapboxgl) : reject(new Error('WORLD_MAP_UNAVAILABLE:no_global')));
        script.onerror = () => reject(new Error('WORLD_MAP_UNAVAILABLE:script_error'));
        w.document.head.appendChild(script);
    });

const toLngLat = (p: TravelLatLng): [number, number] => [p.lng, p.lat];

/** 地图运行期配置（展示用，全部来自构建期环境变量；不进 localStorage / 备份）。 */
export interface TravelMapRuntimeConfig {
    /** 高德 **JS API（展示）** Key。**不能**拿实时感知那把 Web 服务 Key 顶替。 */
    amapJsKey: string | null;
    /** 同源安全代理前缀（Caddy `/_AMapService` 反代 + 服务端注入 jscode）。 */
    amapServiceHost: string | null;
    /** 路线几何展示许可（G1b）；未取得时只在内存画，不落盘。 */
    licensedGeometry: boolean;
    coordSys: TravelCoordSys;
    /** 国外 provider（Mapbox）；缺凭证即 null。 */
    world: WorldMapConfig | null;
}

interface ViteEnvLike {
    VITE_AMAP_JS_KEY?: string;
    VITE_AMAP_SERVICE_HOST?: string;
    VITE_TRAVEL_GEOMETRY_LICENSED?: string;
    VITE_TRAVEL_COORD_SYS?: string;
    VITE_MAPBOX_TOKEN?: string;
    VITE_MAPBOX_STYLE_URL?: string;
}

const readEnv = (): ViteEnvLike => {
    try {
        return ((import.meta as any).env ?? {}) as ViteEnvLike;
    } catch {
        return {};
    }
};

/**
 * 读构建期地图配置。刻意**不**读实时感知的 `amapApiKey`：那是 Web 服务 Key（地理编码/POI），
 * 拿来当 JS 地图 Key 会直接被高德拒；jscode 也不能进前端 bundle，只能由服务端反代注入。
 */
export function readTravelMapConfig(env: ViteEnvLike = readEnv()): TravelMapRuntimeConfig {
    const amapJsKey = String(env.VITE_AMAP_JS_KEY ?? '').trim() || null;
    const amapServiceHost = String(env.VITE_AMAP_SERVICE_HOST ?? '').trim() || null;
    const token = String(env.VITE_MAPBOX_TOKEN ?? '').trim();
    const styleUrl = String(env.VITE_MAPBOX_STYLE_URL ?? '').trim();
    const world = isWorldMapConfigured({ token, styleUrl }) ? { token, styleUrl } : null;
    const coordSys: TravelCoordSys = env.VITE_TRAVEL_COORD_SYS === 'wgs84' ? 'wgs84' : 'gcj02';
    return {
        amapJsKey,
        amapServiceHost,
        licensedGeometry: env.VITE_TRAVEL_GEOMETRY_LICENSED === 'true',
        coordSys,
        world,
    };
}

/** 造一个 Mapbox 适配器；未配置 → null（调用方按「暂未接入」展示）。 */
export function createWorldMapAdapter(
    cfg: Partial<WorldMapConfig> | null | undefined,
    options: { loader?: WorldMapLoader } = {},
): TravelMapAdapter | null {
    if (!isWorldMapConfigured(cfg)) return null;
    const token = String(cfg!.token).trim();
    const styleUrl = String(cfg!.styleUrl).trim();
    const loader = options.loader ?? loadMapboxGlobal;

    return {
        id: 'mapbox',
        coordSys: 'wgs84' as TravelCoordSys,
        async mount(ctx): Promise<TravelMapAdapterHandle> {
            let mapboxgl: any;
            try {
                mapboxgl = await loader(WORLD_MAP_SCRIPT_URL);
            } catch {
                throw new Error('WORLD_MAP_UNAVAILABLE:loader');
            }
            if (!mapboxgl?.Map) throw new Error('WORLD_MAP_UNAVAILABLE:no_map');

            mapboxgl.accessToken = token;
            const map = new mapboxgl.Map({
                container: ctx.container,
                style: styleUrl,
                accessToken: token,
                center: toLngLat(ctx.center),
                zoom: ctx.zoom,
                attributionControl: true,
            });
            const marker = new mapboxgl.Marker({ element: ctx.container.ownerDocument?.createElement('div') ?? undefined });

            const ensureRouteSource = (features: unknown[]) => {
                if (!map.getSource(ROUTE_SOURCE_ID)) {
                    map.addSource(ROUTE_SOURCE_ID, {
                        type: 'geojson',
                        data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} },
                    });
                    map.addLayer({
                        id: ROUTE_SOURCE_ID,
                        type: 'line',
                        source: ROUTE_SOURCE_ID,
                        layout: { 'line-cap': 'round', 'line-join': 'round' },
                        paint: { 'line-color': '#0ea5e9', 'line-width': 3 },
                    });
                }
                const source = map.getSource(ROUTE_SOURCE_ID);
                source?.setData?.({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: features },
                    properties: {},
                });
            };

            return {
                setCenter(center, zoom) {
                    map.setCenter?.(toLngLat(center));
                    if (typeof zoom === 'number') map.setZoom?.(zoom);
                },
                setPosition(position) {
                    if (!position) {
                        marker.remove?.();
                        return;
                    }
                    marker.setLngLat(toLngLat(position)).addTo(map);
                },
                setRoute(points) {
                    const list = (points ?? []).filter(
                        (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng),
                    );
                    // 少于两点不画线：不拿直线/插值冒充真实路线。
                    ensureRouteSource(list.length >= 2 ? list.map(toLngLat) : []);
                },
                destroy() {
                    try {
                        marker.remove?.();
                    } catch {
                        /* 已随 map 一起销毁 */
                    }
                    map.remove?.();
                },
            };
        },
    };
}
