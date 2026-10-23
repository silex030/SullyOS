import { describe, expect, it, vi } from 'vitest';
import {
    createWorldMapAdapter,
    isWorldMapConfigured,
    WORLD_MAP_SCRIPT_URL,
    type WorldMapLoader,
} from './worldMapAdapter';

const CONFIGURED = { token: 'pk.eyJ1Ijoic3VsbHkiLCJhIjoiZmFrZSJ9.0000000000', styleUrl: 'mapbox://styles/mapbox/streets-v12' };

const makeFakeMapbox = () => {
    const instances: any[] = [];
    class FakeMap {
        opts: any;
        removed = false;
        sources: Record<string, any> = {};
        constructor(opts: any) {
            this.opts = opts;
            instances.push(this);
        }
        addControl() {}
        on() {}
        remove() {
            this.removed = true;
        }
        setCenter() {}
        addSource(id: string, def: any) {
            const self = this;
            this.sources[id] = {
                ...def,
                data: def.data,
                setData(next: any) {
                    self.sources[id].data = next;
                },
            };
        }
        getSource(id: string) {
            return this.sources[id];
        }
        addLayer() {}
        addSource$ = 0;
    }
    class FakeMarker {
        setLngLat() {
            return this;
        }
        addTo() {
            return this;
        }
        remove() {}
    }
    return { mapboxgl: { Map: FakeMap, Marker: FakeMarker }, instances };
};

describe('world map adapter（国外 provider，Mapbox JS）', () => {
    it('缺凭证 / 缺样式时不算已配置，且永远不加载脚本（不伪地图）', () => {
        expect(isWorldMapConfigured({ token: '', styleUrl: CONFIGURED.styleUrl })).toBe(false);
        expect(isWorldMapConfigured({ token: CONFIGURED.token, styleUrl: '' })).toBe(false);
        expect(isWorldMapConfigured(CONFIGURED)).toBe(true);

        const loader = vi.fn(async () => makeFakeMapbox().mapboxgl);
        expect(createWorldMapAdapter({ token: '', styleUrl: '' }, { loader })).toBeNull();
        expect(createWorldMapAdapter({ token: 'short', styleUrl: '' }, { loader })).toBeNull();
        expect(loader).not.toHaveBeenCalled();
    });

    it('已配置时按注入的 loader 动态加载官方脚本并保留坐标体系', async () => {
        const fake = makeFakeMapbox();
        const loader: WorldMapLoader = vi.fn(async () => fake.mapboxgl);
        const adapter = createWorldMapAdapter(CONFIGURED, { loader });
        expect(adapter).not.toBeNull();

        const container = {} as HTMLElement;
        const handle = await adapter!.mount({
            container,
            center: { lat: 31.23, lng: 121.47 },
            zoom: 13,
            coordSys: 'wgs84',
        });

        expect(loader).toHaveBeenCalledWith(WORLD_MAP_SCRIPT_URL);
        expect(adapter!.coordSys).toBe('wgs84');
        const map = fake.instances[0];
        expect(map.opts.accessToken).toBe(CONFIGURED.token);
        expect(map.opts.style).toBe(CONFIGURED.styleUrl);
        expect(map.opts.center).toEqual([121.47, 31.23]);

        handle.setPosition({ lat: 31.24, lng: 121.48 });
        handle.setRoute([{ lat: 31.24, lng: 121.48 }, { lat: 31.25, lng: 121.5 }]);
        expect(map.sources['travel-route']?.data?.geometry?.coordinates).toHaveLength(2);
        // 少于 2 个点不画线（不拿直线冒充路线）
        handle.setRoute([{ lat: 31.24, lng: 121.48 }]);
        expect(map.sources['travel-route']?.data?.geometry?.coordinates ?? []).toHaveLength(0);

        handle.destroy();
        expect(map.removed).toBe(true);
    });

    it('脚本加载失败时 mount 明确失败，不留半张图', async () => {
        const loader: WorldMapLoader = async () => {
            throw new Error('blocked');
        };
        const adapter = createWorldMapAdapter(CONFIGURED, { loader });
        await expect(
            adapter!.mount({
                container: {} as HTMLElement,
                center: { lat: 0, lng: 0 },
                zoom: 12,
                coordSys: 'wgs84',
            }),
        ).rejects.toThrow(/WORLD_MAP_UNAVAILABLE/);
    });

    it('没有 token 的短串（userId 风格）当未配置，不发外网请求', () => {
        const loader = vi.fn();
        expect(createWorldMapAdapter({ token: 'u_1', styleUrl: CONFIGURED.styleUrl }, { loader })).toBeNull();
        expect(loader).not.toHaveBeenCalled();
    });
});
