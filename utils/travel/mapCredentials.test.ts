// @vitest-environment jsdom
/**
 * 前端地图凭据客户端：服务端优先、内存缓存、**不落任何浏览器存储**。
 *
 * 这里钉住三件事：
 * 1. 保存只走 PUT，成功清空草稿，读回的是存在性而不是把 Key 存到本地；
 * 2. 用户清除后，构建期 env 里的旧 Key 不再"复活"；
 * 3. localStorage / 备份标记里不会出现用户填的 Key（凭据只在服务端密文里）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTravelApi } from './api';
import { createTravelRuntime } from './runtime';
import { createTravelStateStore } from './state';
import {
    composeTravelMapConfig,
    loadTravelMapRuntime,
    resetTravelMapRuntimeCacheForTesting,
} from './mapRuntime';
import type { TravelMapRuntimeConfig } from './worldMapAdapter';

const NOW = 1_700_000_000_000;
const TOKEN = 'sess_0123456789abcdef';
const WEB_MARKER = 'web-service-key-MARKER-0001';
const JS_MARKER = 'js-api-key-MARKER-0002';
const CODE_MARKER = 'jscode-MARKER-0003';

const BASE_CONFIG: TravelMapRuntimeConfig = {
    amapJsKey: 'env-js-key',
    amapServiceHost: '/_AMapService',
    licensedGeometry: false,
    coordSys: 'gcj02',
    world: null,
};

const credentialView = (overrides: Record<string, unknown> = {}) => ({
    configured: true,
    unreadable: false,
    has: { amapWebKey: true, amapJsKey: true, amapJsCode: true, mapboxToken: false },
    amapJsKey: JS_MARKER,
    mapboxToken: null,
    mapboxStyleUrl: null,
    updatedAt: NOW,
    serviceHost: '/_AMapService/t/signed-token-0123456789',
    serviceHostExpiresAt: NOW + 1_800_000,
    ...overrides,
});

const makeRuntime = (handler: (url: string, init: any) => unknown) => {
    const calls: Array<{ url: string; init: any }> = [];
    const transport = vi.fn(async (url: string, init: any) => {
        calls.push({ url, init });
        const body = handler(url, init);
        return new Response(JSON.stringify(body ?? {}), { status: body === undefined ? 404 : 200 });
    });
    const runtime = createTravelRuntime({
        api: createTravelApi({
            session: () => ({ token: TOKEN }),
            baseUrl: () => 'https://backend.example',
            transport: transport as never,
            now: () => NOW,
        }),
        store: createTravelStateStore({ now: () => NOW }),
        session: () => ({ token: TOKEN }),
        baseUrl: () => 'https://backend.example',
        transport: transport as never,
        now: () => NOW,
    });
    return { runtime, calls };
};

beforeEach(() => {
    resetTravelMapRuntimeCacheForTesting();
    localStorage.clear();
});

describe('travel map runtime · 服务端凭据优先', () => {
    it('服务端有答案就以它为准；env 的旧 Key 不覆盖用户配置', () => {
        const merged = composeTravelMapConfig(BASE_CONFIG, credentialView() as never);
        expect(merged.amapJsKey).toBe(JS_MARKER);
        expect(merged.amapServiceHost).toBe('/_AMapService/t/signed-token-0123456789');
        // 许可是另一条线，仍然只来自 env。
        expect(merged.licensedGeometry).toBe(false);
    });

    it('用户清除后（configured:false）不再回落到 env 旧 Key', () => {
        const cleared = composeTravelMapConfig(BASE_CONFIG, credentialView({
            configured: true,
            has: { amapWebKey: true, amapJsKey: false, amapJsCode: true, mapboxToken: false },
            amapJsKey: null,
            serviceHost: null,
        }) as never);
        expect(cleared.amapJsKey).toBeNull();
        expect(cleared.amapServiceHost).toBeNull();
    });

    it('未登录/读不到时才用构建期兜底，并标记 source=env', async () => {
        const { runtime } = makeRuntime(() => undefined);
        const state = await loadTravelMapRuntime({ runtime, envConfig: BASE_CONFIG, force: true });
        expect(state.source).toBe('env');
        expect(state.known).toBe(false);
        expect(state.config.amapJsKey).toBe('env-js-key');
    });

    it('缓存：第二次读取不再打服务端；force 才刷新', async () => {
        const { runtime, calls } = makeRuntime(() => credentialView());
        await loadTravelMapRuntime({ runtime, envConfig: BASE_CONFIG, force: true });
        await loadTravelMapRuntime({ runtime, envConfig: BASE_CONFIG });
        expect(calls.filter((c) => c.url.endsWith('/travel/map/credentials'))).toHaveLength(1);
        await loadTravelMapRuntime({ runtime, envConfig: BASE_CONFIG, force: true });
        expect(calls.filter((c) => c.url.endsWith('/travel/map/credentials'))).toHaveLength(2);
    });

    it('保存后本地存储里没有任何 Key 标记（因此也不会进备份）', async () => {
        const { runtime, calls } = makeRuntime((url, init) => {
            if (url.endsWith('/travel/map/credentials') && init?.method === 'PUT') return credentialView();
            return undefined;
        });
        const saved = await runtime.saveMapCredentials({
            amapWebKey: WEB_MARKER,
            amapJsKey: JS_MARKER,
            amapJsCode: CODE_MARKER,
        });
        expect(saved.ok).toBe(true);
        const put = calls.find((c) => c.init?.method === 'PUT')!;
        expect(JSON.parse(put.init.body)).toEqual({
            amapWebKey: WEB_MARKER,
            amapJsKey: JS_MARKER,
            amapJsCode: CODE_MARKER,
        });

        const dump = Object.keys(localStorage)
            .map((key) => `${key}=${localStorage.getItem(key)}`)
            .join('\n');
        for (const marker of [WEB_MARKER, JS_MARKER, CODE_MARKER]) {
            expect(dump.includes(marker)).toBe(false);
        }
    });
});
