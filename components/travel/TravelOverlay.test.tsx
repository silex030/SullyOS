// @vitest-environment jsdom
/**
 * 出行悬浮层（B6 接线）：顶部灵动岛 / 面板 / 结束共享的真实入口。
 *
 * 钉住的行为：
 * - 共享态未知或关闭 → 顶部条与面板都不渲染（不泄露内容），也不再留左下角小球/小胶囊；
 * - 只有真的在出行（在路上/停留/回程）才出现在顶部，未出发的计划与终态都不出现；
 * - 未确认快照写明「未更新」，不给分钟数；
 * - 顶部条点击 → 打开既有地图面板（面板由 runtime 的 overlay 状态驱动，不改行程）；
 * - 面板「结束共享」需要二次确认，确认后调 setShare(false) 并收起；
 * - 挂载时清掉旧球的位置记忆键，不碰别的 localStorage。
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createTravelApi } from '../../utils/travel/api';
import { createTravelStateStore } from '../../utils/travel/state';
import { createTravelRuntime } from '../../utils/travel/runtime';
import TravelOverlay, { TravelChatEntry } from './TravelOverlay';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_700_000_000_000;
const TOKEN = 'sess_0123456789abcdef';

const snapshotOf = (status: string) => ({
    code: 'OK' as const,
    serverNow: NOW,
    trip: {
        id: 't1',
        status: status as never,
        planVersion: 1,
        revision: 1,
        origin: { label: '阳光花园', city: '杭州' },
        dest: { label: '西湖文化广场', city: '杭州' },
        departAt: NOW - 60_000,
        arriveAt: null,
        dwellUntil: null,
        returnAt: null,
    },
    position: null,
    route: null,
    history: [],
    budget: { mapCallsUsed: 1, mapCallsLimit: 30 },
});

const makeRuntime = (opts: { shareEnabled: boolean; status?: string }) => {
    let shareEnabled = opts.shareEnabled;
    const status = opts.status ?? 'en_route';
    const posted: any[] = [];
    const transport = vi.fn(async (url: string, init: any) => {
        if (url.includes('/travel/share') && init?.method === 'POST') {
            const body = JSON.parse(init.body);
            posted.push(body);
            shareEnabled = !!body.shareEnabled;
            return new Response(JSON.stringify({ share: { userId: 'u1', charId: body.charId, shareEnabled, version: 2 } }), {
                status: 200,
            });
        }
        if (url.includes('/travel/state')) {
            return new Response(
                JSON.stringify({
                    snapshot: shareEnabled ? snapshotOf(status) : { ...snapshotOf(status), code: 'SHARE_REVOKED', trip: null },
                    share: { userId: 'u1', charId: 'c1', shareEnabled, version: 1 },
                }),
                { status: 200 },
            );
        }
        return new Response(JSON.stringify({}), { status: 404 });
    });
    const store = createTravelStateStore({ now: () => NOW });
    const api = createTravelApi({
        session: () => ({ token: TOKEN }),
        baseUrl: () => 'https://backend.example',
        transport: transport as never,
        now: () => NOW,
    });
    const runtime = createTravelRuntime({ api, store, session: () => ({ token: TOKEN }), baseUrl: () => 'https://backend.example', transport: transport as never, now: () => NOW });
    return { runtime, transport, posted, store };
};

const CHARS = [{ id: 'c1', name: '小满', avatarUrl: null }];

const mount = async (runtime: ReturnType<typeof makeRuntime>['runtime']) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
        root.render(<TravelOverlay characters={CHARS} runtime={runtime} onOpenSettings={() => {}} />);
    });
    return { host, root };
};

describe('TravelOverlay · 顶部出行状态条', () => {
    it('共享关闭时不渲染顶部条与面板，也不再留左下角出行胶囊', async () => {
        const { runtime } = makeRuntime({ shareEnabled: false });
        const { host, root } = await mount(runtime);
        expect(host.querySelector('[data-testid="travel-island"]')).toBeNull();
        expect(host.querySelector('[data-testid="travel-ball"]')).toBeNull();
        // 旧实现里那个常驻左下角小胶囊随球一起删了：设置改在设置 App
        expect(host.querySelector('[data-testid="travel-overlay-settings"]')).toBeNull();
        await act(async () => root.unmount());
        host.remove();
    });

    it('共享开启且在路上：顶部出现一条状态，点击打开既有地图面板', async () => {
        const { runtime } = makeRuntime({ shareEnabled: true });
        await runtime.refreshShare('c1');
        const { host, root } = await mount(runtime);
        const island = host.querySelector('[data-testid="travel-island"]') as HTMLElement | null;
        expect(island).not.toBeNull();
        expect(island!.textContent).toContain('小满');
        expect(island!.textContent).toContain('在路上');
        expect(island!.textContent).toContain('西湖文化广场');

        await act(async () => {
            (host.querySelector('[data-testid="travel-island-open"]') as HTMLElement).dispatchEvent(
                new MouseEvent('click', { bubbles: true }),
            );
        });
        expect(runtime.overlay.get()).toEqual({ open: true, charId: 'c1' });
        expect(host.querySelector('[data-testid="travel-map-panel"]')).not.toBeNull();
        expect(host.textContent).toContain('阳光花园');
        await act(async () => root.unmount());
        host.remove();
    });

    it('未确认快照：顶部写明「未更新」，不给任何分钟数', async () => {
        const { runtime, store } = makeRuntime({ shareEnabled: true });
        await runtime.refreshShare('c1');
        const { host, root } = await mount(runtime);
        expect(host.querySelector('[data-testid="travel-island"]')).not.toBeNull();
        // 挂载后掉线：显示最后快照，但必须标「未更新」，不拿旧数字装实时
        await act(async () => {
            store.markUnconfirmed('NETWORK');
        });
        const island = host.querySelector('[data-testid="travel-island"]') as HTMLElement | null;
        expect(island).not.toBeNull();
        expect(island!.textContent).toContain('未更新');
        expect(island!.textContent).not.toMatch(/约\s*\d+\s*分钟/);
        expect(island!.getAttribute('data-stale')).toBe('true');
        await act(async () => root.unmount());
        host.remove();
    });

    it('终态与未出发的计划都不占用顶部', async () => {
        for (const status of ['returned', 'stopped', 'planned']) {
            const { runtime } = makeRuntime({ shareEnabled: true, status });
            await runtime.refreshShare('c1');
            const { host, root } = await mount(runtime);
            expect(host.querySelector('[data-testid="travel-island"]')).toBeNull();
            await act(async () => root.unmount());
            host.remove();
        }
    });

    it('挂载时只清旧球的位置记忆，不动其它 localStorage', async () => {
        window.localStorage.setItem('travel.ball.pos.v1', '{"x":10,"y":700}');
        window.localStorage.setItem('sully-keep', 'yes');
        const { runtime } = makeRuntime({ shareEnabled: false });
        const { host, root } = await mount(runtime);
        expect(window.localStorage.getItem('travel.ball.pos.v1')).toBeNull();
        expect(window.localStorage.getItem('sully-keep')).toBe('yes');
        await act(async () => root.unmount());
        host.remove();
        window.localStorage.removeItem('sully-keep');
    });
});

describe('TravelOverlay · 结束共享', () => {
    it('结束共享需要二次确认，确认后才调 setShare(false)', async () => {
        const { runtime, posted } = makeRuntime({ shareEnabled: true });
        await runtime.refreshShare('c1');
        runtime.overlay.open('c1');
        const { host, root } = await mount(runtime);
        const end = host.querySelector('[data-testid="travel-end-share"]') as HTMLElement;
        expect(end).not.toBeNull();
        await act(async () => {
            end.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(posted).toHaveLength(0);
        const confirm = host.querySelector('[data-testid="travel-end-share-confirm"]') as HTMLElement;
        await act(async () => {
            confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(posted[0]).toMatchObject({ charId: 'c1', shareEnabled: false });
        expect(runtime.overlay.get().open).toBe(false);
        await act(async () => root.unmount());
        host.remove();
    });
});

describe('TravelOverlay · 聊天入口', () => {
    it('聊天入口只显示状态并打开面板，不伪造行程内容', async () => {
        const { runtime } = makeRuntime({ shareEnabled: true });
        await runtime.refreshShare('c1');
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        await act(async () => {
            root.render(<TravelChatEntry charId="c1" charName="小满" runtime={runtime} />);
        });
        const chip = host.querySelector('[data-testid="travel-chat-entry"]') as HTMLElement;
        expect(chip).not.toBeNull();
        expect(chip.textContent).toContain('在路上');
        await act(async () => {
            chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(runtime.overlay.get()).toEqual({ open: true, charId: 'c1' });
        await act(async () => root.unmount());
        host.remove();
    });

    it('共享关闭时聊天入口不渲染', async () => {
        const { runtime } = makeRuntime({ shareEnabled: false });
        await runtime.refreshShare('c1');
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        await act(async () => {
            root.render(<TravelChatEntry charId="c1" charName="小满" runtime={runtime} />);
        });
        expect(host.querySelector('[data-testid="travel-chat-entry"]')).toBeNull();
        await act(async () => root.unmount());
        host.remove();
    });
});
