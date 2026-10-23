// @vitest-environment jsdom
/**
 * 出行悬浮层（B6 接线）：球 / 面板 / 结束共享的真实入口。
 *
 * 钉住的行为：
 * - 共享态未知或关闭 → 球与面板都不渲染（不泄露内容），设置入口保留；
 * - 球点击 → 打开面板（面板由 runtime 的 overlay 状态驱动，不改行程）；
 * - 面板「结束共享」需要二次确认，确认后调 setShare(false) 并收起；
 * - 没有 JS Key 时面板如实显示「地图未就绪」，不造假底图。
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

const snapshot = {
    code: 'OK' as const,
    serverNow: NOW,
    trip: {
        id: 't1',
        status: 'en_route' as const,
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
};

const makeRuntime = (opts: { shareEnabled: boolean; shareEnabledAfter?: boolean }) => {
    let shareEnabled = opts.shareEnabled;
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
                    snapshot: shareEnabled ? snapshot : { ...snapshot, code: 'SHARE_REVOKED', trip: null },
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

describe('TravelOverlay', () => {
    it('共享关闭时不渲染球与面板，但保留设置入口', async () => {
        const { runtime } = makeRuntime({ shareEnabled: false });
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        await act(async () => {
            root.render(<TravelOverlay characters={CHARS} runtime={runtime} onOpenSettings={() => {}} />);
        });
        const opened = runtime.overlay.get();
        expect(opened.open).toBe(false);
        expect(host.querySelector('[data-testid="travel-ball"]')).toBeNull();
        expect(host.querySelector('[data-testid="travel-overlay-settings"]')).not.toBeNull();
        await act(async () => root.unmount());
    });

    it('共享开启：球出现，点击打开面板并渲染真实行程（无 JS Key 显示未就绪）', async () => {
        const { runtime } = makeRuntime({ shareEnabled: true });
        await runtime.refreshShare('c1');
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        await act(async () => {
            root.render(<TravelOverlay characters={CHARS} runtime={runtime} onOpenSettings={() => {}} />);
        });
        const ball = host.querySelector('[data-testid="travel-ball"]') as HTMLElement | null;
        expect(ball).not.toBeNull();
        await act(async () => {
            ball!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 400 }));
            ball!.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 101, clientY: 401 }));
        });
        expect(runtime.overlay.get()).toEqual({ open: true, charId: 'c1' });
        const panel = host.querySelector('[data-testid="travel-map-panel"]');
        expect(panel).not.toBeNull();
        expect(host.textContent).toContain('阳光花园');
        await act(async () => root.unmount());
    });

    it('结束共享需要二次确认，确认后才调 setShare(false)', async () => {
        const { runtime, posted } = makeRuntime({ shareEnabled: true });
        await runtime.refreshShare('c1');
        runtime.overlay.open('c1');
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        await act(async () => {
            root.render(<TravelOverlay characters={CHARS} runtime={runtime} onOpenSettings={() => {}} />);
        });
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
    });

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
    });
});
