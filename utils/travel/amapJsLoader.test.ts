/**
 * 高德 JS API 2.0 正式加载器（B5）
 *
 * 这组用例只钉三件事，全部可在 Node 里跑（env 注入，不碰真浏览器）：
 * 1. 脚本 URL / 安全配置的构造规则（`securityJsCode` 永不进前端）；
 * 2. `_AMapSecurityConfig.serviceHost` **必须写在脚本进 DOM 之前**（官方原文要求）；
 * 3. 缺 key / 缺代理 / 脚本报错 → 抛带码错误，让 UI 显示「地图暂不可用」，
 *    而不是自己造一张假图。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
    AMAP_JS_VERSION,
    AMAP_SCRIPT_ID,
    AMAP_SERVICE_PREFIX,
    AmapLoadError,
    buildAmapScriptUrl,
    buildAmapSecurityConfig,
    isAmapAvailable,
    loadAmapJs,
    normalizeServiceHost,
    resetAmapJsLoader,
    type AmapLoaderEnv,
    type AmapScriptElementLike,
} from './amapJsLoader';

// 模块级缓存跨用例共享，每例前清一次，保证「缺 key / 脚本失败 / 超时」各自独立取证。
beforeEach(() => resetAmapJsLoader());

interface FakeEnv {
    env: AmapLoaderEnv;
    events: string[];
    scripts: AmapScriptElementLike[];
    windowRef: { AMap?: unknown; _AMapSecurityConfig?: Record<string, unknown> };
    fireLoad: () => void;
    fireError: () => void;
}

const makeEnv = (): FakeEnv => {
    const events: string[] = [];
    const scripts: AmapScriptElementLike[] = [];
    const windowRef: { AMap?: unknown; _AMapSecurityConfig?: Record<string, unknown> } = {};

    const documentRef = {
        getElementById: (id: string) => scripts.find((s) => s.id === id) ?? null,
        createElement: (_tag: 'script') => {
            const el: AmapScriptElementLike = {
                id: '',
                src: '',
                async: false,
                onload: null,
                onerror: null,
                remove: () => {
                    const at = scripts.indexOf(el);
                    if (at >= 0) scripts.splice(at, 1);
                },
            };
            return el;
        },
        head: {
            appendChild: (node: AmapScriptElementLike) => {
                scripts.push(node);
                // 关键取证点：脚本挂进 DOM 的这一瞬间，安全配置必须已经在 window 上
                events.push(`append:${node.id}`);
                events.push(
                    `config-at-append:${String(
                        (windowRef._AMapSecurityConfig as { serviceHost?: string } | undefined)?.serviceHost ?? 'none',
                    )}`,
                );
                return node;
            },
        },
    };

    return {
        env: { window: windowRef as AmapLoaderEnv['window'], document: documentRef as unknown as AmapLoaderEnv['document'] },
        events,
        scripts,
        windowRef,
        fireLoad: () => scripts[0]?.onload?.(),
        fireError: () => scripts[0]?.onerror?.(new Error('network')),
    };
};

const KEY = 'js-key-abc';
const HOST = '/_AMapService';

describe('amapJsLoader · URL 与安全配置构造', () => {
    it('按官方格式拼脚本地址，key 走 encodeURIComponent', () => {
        expect(buildAmapScriptUrl({ key: 'a+b/c' })).toBe(
            `https://webapi.amap.com/maps?v=${AMAP_JS_VERSION}&key=a%2Bb%2Fc`,
        );
    });

    it('脚本地址可指定 version，但默认 2.0', () => {
        expect(buildAmapScriptUrl({ key: KEY })).toContain(`v=${AMAP_JS_VERSION}`);
        expect(buildAmapScriptUrl({ key: KEY, version: '2.0' })).toContain('v=2.0');
    });

    it('serviceHost 只接受官方固定前缀结尾（同源或 https 绝对地址）', () => {
        expect(AMAP_SERVICE_PREFIX).toBe('/_AMapService');
        expect(normalizeServiceHost('/_AMapService')).toBe('/_AMapService');
        expect(normalizeServiceHost('/_AMapService/')).toBe('/_AMapService');
        expect(normalizeServiceHost('https://link.example.com/_AMapService')).toBe(
            'https://link.example.com/_AMapService',
        );
        // 前缀不可省、不可改名
        expect(normalizeServiceHost('/amap')).toBeNull();
        expect(normalizeServiceHost('/_AMapServiceX')).toBeNull();
        expect(normalizeServiceHost('')).toBeNull();
        expect(normalizeServiceHost(null)).toBeNull();
    });

    it('安全配置只出 serviceHost，永远不出 securityJsCode', () => {
        expect(buildAmapSecurityConfig(HOST)).toEqual({ serviceHost: '/_AMapService' });
        expect(buildAmapSecurityConfig('/wrong')).toBeNull();
        expect(buildAmapSecurityConfig(null)).toBeNull();
        const cfg = buildAmapSecurityConfig(HOST)!;
        expect(Object.keys(cfg)).toEqual(['serviceHost']);
        expect(JSON.stringify(cfg)).not.toContain('securityJsCode');
    });

    it('缺 key 或缺口令代理都算「不可用」，不降级成别的东西', () => {
        expect(isAmapAvailable(KEY, HOST)).toBe(true);
        expect(isAmapAvailable('', HOST)).toBe(false);
        expect(isAmapAvailable(KEY, null)).toBe(false);
        expect(isAmapAvailable(KEY, '/nope')).toBe(false);
    });
});

describe('amapJsLoader · 加载顺序与失败态', () => {
    it('缺少 key 时抛 MISSING_KEY，且一个脚本都不挂', async () => {
        const fake = makeEnv();
        await expect(loadAmapJs({ key: '', serviceHost: HOST, env: fake.env })).rejects.toMatchObject({
            name: 'AmapLoadError',
            code: 'MISSING_KEY',
        });
        expect(fake.scripts).toHaveLength(0);
        await expect(loadAmapJs({ key: '', serviceHost: HOST, env: fake.env })).rejects.toBeInstanceOf(AmapLoadError);
    });

    it('缺少 serviceHost 时抛 NO_SECURITY_CONFIG（不偷偷用明文 securityJsCode）', async () => {
        const fake = makeEnv();
        await expect(loadAmapJs({ key: KEY, env: fake.env })).rejects.toMatchObject({ code: 'NO_SECURITY_CONFIG' });
        expect(fake.scripts).toHaveLength(0);
        expect(fake.windowRef._AMapSecurityConfig).toBeUndefined();
    });

    it('serviceHost 不合法时抛 INVALID_SERVICE_HOST，不挂脚本', async () => {
        const fake = makeEnv();
        await expect(loadAmapJs({ key: KEY, serviceHost: '/foo', env: fake.env })).rejects.toMatchObject({
            code: 'INVALID_SERVICE_HOST',
        });
        expect(fake.scripts).toHaveLength(0);
    });

    it('先写 window._AMapSecurityConfig，再 appendChild 脚本', async () => {
        const fake = makeEnv();
        const pending = loadAmapJs({ key: KEY, serviceHost: HOST, env: fake.env });
        expect(fake.events).toEqual(['append:' + AMAP_SCRIPT_ID, 'config-at-append:/_AMapService']);
        expect(fake.windowRef._AMapSecurityConfig).toEqual({ serviceHost: '/_AMapService' });
        expect(fake.scripts[0]!.src).toContain(encodeURIComponent(KEY).slice(0, 3));
        fake.windowRef.AMap = { Map: class {} };
        fake.fireLoad();
        await expect(pending).resolves.toBe(fake.windowRef.AMap);
    });

    it('脚本 onload 但没有 window.AMap → NO_AMAP_GLOBAL', async () => {
        const fake = makeEnv();
        const pending = loadAmapJs({ key: KEY, serviceHost: HOST, env: fake.env });
        fake.fireLoad();
        await expect(pending).rejects.toMatchObject({ code: 'NO_AMAP_GLOBAL' });
    });

    it('脚本 onerror → SCRIPT_ERROR（可重试）', async () => {
        const fake = makeEnv();
        const pending = loadAmapJs({ key: KEY, serviceHost: HOST, env: fake.env });
        fake.fireError();
        await expect(pending).rejects.toMatchObject({ code: 'SCRIPT_ERROR' });
    });

    it('并发调用共用同一个脚本与同一个 promise', async () => {
        const fake = makeEnv();
        const a = loadAmapJs({ key: KEY, serviceHost: HOST, env: fake.env });
        const b = loadAmapJs({ key: KEY, serviceHost: HOST, env: fake.env });
        expect(fake.scripts).toHaveLength(1);
        fake.windowRef.AMap = { Map: class {} };
        fake.fireLoad();
        await expect(Promise.all([a, b])).resolves.toHaveLength(2);
        expect(fake.scripts).toHaveLength(1);
    });

    it('超时抛 TIMEOUT（脚本一直不回）', async () => {
        const fake = makeEnv();
        await expect(
            loadAmapJs({ key: KEY, serviceHost: HOST, env: fake.env, timeoutMs: 5 }),
        ).rejects.toMatchObject({ code: 'TIMEOUT' });
    });
});
