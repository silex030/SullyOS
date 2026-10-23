import { describe, expect, it, vi } from 'vitest';
import { createTravelApi } from './api';
import { createTravelStateStore } from './state';
import { createTravelRuntime, type TravelRuntimeDeps } from './runtime';

const NOW = 1_700_000_000_000;

const makeDeps = (opts: {
    responses: Record<string, unknown> | ((url: string, init: any) => unknown);
    token?: string;
}): TravelRuntimeDeps => {
    const lookup = (url: string): unknown => {
        if (typeof opts.responses === 'function') return opts.responses(url, {});
        const hit = Object.entries(opts.responses).find(([key]) => url.endsWith(key));
        return hit ? hit[1] : undefined;
    };
    const transport = vi.fn(async (url: string, init: any) => {
        const body = typeof opts.responses === 'function' ? opts.responses(url, init) : lookup(url);
        return new Response(JSON.stringify(body ?? {}), { status: body === undefined ? 404 : 200 });
    });
    const api = createTravelApi({
        session: () => (opts.token === undefined ? null : { token: opts.token }),
        baseUrl: () => 'https://backend.example',
        transport: transport as never,
        now: () => NOW,
    });
    return {
        api,
        store: createTravelStateStore({ now: () => NOW }),
        session: () => (opts.token === undefined ? null : { token: opts.token }),
        baseUrl: () => 'https://backend.example',
        transport: transport as never,
        now: () => NOW,
    };
};

const OK_SNAPSHOT = {
    code: 'OK',
    serverNow: NOW,
    trip: {
        id: 't1',
        status: 'en_route',
        planVersion: 1,
        revision: 1,
        origin: { label: '阳光花园', city: '杭州', district: '西湖区' },
        dest: { label: '西湖文化广场', city: '杭州' },
        departAt: NOW - 60_000,
        arriveAt: NOW + 600_000,
        dwellUntil: null,
        returnAt: null,
    },
    position: { lat: 30.27, lng: 120.15, coordSys: 'gcj02' },
    route: { points: [{ lat: 30.27, lng: 120.15 }, { lat: 30.28, lng: 120.16 }], distanceM: 1200 },
    history: [],
    budget: { mapCallsUsed: 1, mapCallsLimit: 30 },
};

describe('travel runtime（B6 接线层）', () => {
    it('没有会话时不发请求，读取状态 fail-closed 为未确认', async () => {
        const deps = makeDeps({ responses: {}, token: undefined });
        const runtime = createTravelRuntime(deps);
        await runtime.refreshShare('c1');
        expect(deps.store!.getState().shareEnabled).toBe(false);
        expect(deps.store!.getState().shareKnown).toBe(false);
        expect((deps.transport as any)).not.toHaveBeenCalled();
    });

    it('读到共享位后开启轮询，并在关闭共享时停轮询且清空行程', async () => {
        const deps = makeDeps({
            token: 'sess_0123456789abcdef',
            responses: {
                ['/travel/state?charId=c1']: {
                    snapshot: OK_SNAPSHOT,
                    share: { userId: 'u1', charId: 'c1', shareEnabled: false, version: 3 },
                },
            },
        });
        const runtime = createTravelRuntime(deps);
        await runtime.refreshShare('c1');
        expect(deps.store!.getState().shareKnown).toBe(true);
        expect(deps.store!.getState().shareEnabled).toBe(false);
        expect(deps.store!.getState().view?.trip).toBeNull();
    });

    it('overlay 只保存打开状态与当前角色，不改行程', () => {
        const deps = makeDeps({ responses: {}, token: 'sess_0123456789abcdef' });
        const runtime = createTravelRuntime(deps);
        const seen: boolean[] = [];
        runtime.overlay.subscribe((s) => seen.push(s.open));
        runtime.overlay.open('c2');
        expect(runtime.overlay.get()).toEqual({ open: true, charId: 'c2' });
        runtime.overlay.close();
        expect(runtime.overlay.get()).toEqual({ open: false, charId: null });
        // 订阅收到的是「开 / 关」两次状态变化，不是重复的 true
        expect(seen).toEqual([true, false]);
        expect(deps.store!.getState().view).toBeNull();
    });

    it('设置读失败 → known:false，不编默认预算', async () => {
        const deps = makeDeps({ responses: {}, token: 'sess_0123456789abcdef' });
        const runtime = createTravelRuntime(deps);
        const view = await runtime.readSettings();
        expect(view.known).toBe(false);
        expect(view.settings).toBeNull();
    });

    it('设置读到后按 version 保存（CAS），保存成功回填', async () => {
        const settings = {
            enabled: true,
            budgetTz: 'Asia/Shanghai',
            tripRetentionDays: 30,
            eventRetentionDays: 7,
            version: 4,
            updatedAt: NOW,
        };
        const deps = makeDeps({
            token: 'sess_0123456789abcdef',
            responses: (url, init) => {
                if (url.endsWith('/travel/settings') && init.method === 'GET') {
                    return { settings };
                }
                if (url.endsWith('/travel/settings') && init.method === 'PUT') {
                    return { settings: { ...settings, ...JSON.parse(init.body), version: 5 } };
                }
                return undefined;
            },
        });
        const runtime = createTravelRuntime(deps);
        const view = await runtime.readSettings();
        expect(view.known).toBe(true);
        expect(view.settings?.version).toBe(4);
        const saved = await runtime.saveSettings({ tripRetentionDays: 12 }, 4);
        expect(saved.ok).toBe(true);
        const posted = (deps.transport as any).mock.calls.find((c: any[]) => c[1]?.method === 'PUT');
        expect(JSON.parse(posted[1].body)).toMatchObject({ tripRetentionDays: 12, baseVersion: 4 });
        expect(runtime.settingsCache()?.tripRetentionDays).toBe(12);
        expect(runtime.settingsCache()?.version).toBe(5);
    });

    it('锚点搜索与确认走独立端点，无坐标不当作已确认', async () => {
        const deps = makeDeps({
            token: 'sess_0123456789abcdef',
            responses: (url) => {
                if (url.includes('/travel/anchor/search')) {
                    return { results: [{ label: '阳光花园', city: '杭州', district: '西湖区' }] };
                }
                if (url.endsWith('/travel/anchor')) {
                    return { anchor: null };
                }
                return undefined;
            },
        });
        const runtime = createTravelRuntime(deps);
        const res = await runtime.searchAnchor('阳光花园');
        expect(res.ok).toBe(true);
        expect(res.ok && res.data![0]?.label).toBe('阳光花园');
        // 没有坐标 / 没有确认字段的候选不能当锚点
        const confirmed = await runtime.confirmAnchor({ label: '阳光花园', city: '杭州' } as never);
        expect(confirmed.ok).toBe(false);
    });

    it('角色内部上下文即使共享关闭也能读到，并缓存为提示词块', async () => {
        const deps = makeDeps({
            token: 'sess_0123456789abcdef',
            responses: {
                ['/travel/context?charId=c1']: {
                    shareEnabled: false,
                    shareKnown: true,
                    trip: {
                        phase: 'planned',
                        originLabel: '阳光花园',
                        destinationLabel: '西湖文化广场',
                        etaMinutes: 10,
                        paused: false,
                    },
                    budget: { mapCallsUsed: 0, mapCallsLimit: 30, paused: false },
                },
            },
        });
        const runtime = createTravelRuntime(deps);
        await expect(runtime.refreshContext('c1')).resolves.toBe(true);
        const block = runtime.promptBlock('c1');
        expect(block).toContain('阳光花园');
        expect(block).not.toContain('30.27');
        expect(runtime.promptBlock('other')).toBeNull();
    });

    it('上下文形状不对时不注入（不拿公开共享快照补）', async () => {
        const deps = makeDeps({
            token: 'sess_0123456789abcdef',
            responses: { ['/travel/context?charId=c1']: { nope: true } },
        });
        const runtime = createTravelRuntime(deps);
        await expect(runtime.refreshContext('c1')).resolves.toBe(false);
        expect(runtime.promptBlock('c1')).toBeNull();
    });
});
