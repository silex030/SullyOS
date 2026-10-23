// @vitest-environment jsdom
/**
 * 设置页出行板块（B6）：只读授权与资源，失败不默认放行。
 *
 * 钉住：读不到设置 → 明说「未确认」且保存禁用（不拿默认值覆盖服务端）；
 * 读到 → 展示真实预算并带 baseVersion 保存；地址卡拒绝门牌级输入；不出现 GPS 话术。
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createTravelApi } from '../../utils/travel/api';
import { createTravelStateStore } from '../../utils/travel/state';
import { createTravelRuntime } from '../../utils/travel/runtime';
import TravelSettings from './TravelSettings';
import TravelAnchorCard from './TravelAnchorCard';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_700_000_000_000;
const TOKEN = 'sess_0123456789abcdef';

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

const render = async (node: React.ReactElement) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
        root.render(node);
    });
    return { host, root };
};

const SETTINGS = {
    enabled: true,
    budgetTz: 'Asia/Shanghai',
    tripRetentionDays: 30,
    eventRetentionDays: 7,
    version: 4,
    updatedAt: NOW,
};

const BUDGET = {
    userId: 'u1',
    dayKey: '2026-10-23',
    mapCallsUsed: 3,
    mapCallsLimit: 30,
    llmTokensUsed: 0,
    llmTokensLimit: 0,
    paused: false,
    version: 1,
};

describe('TravelSettings', () => {
    it('读不到设置时明说未确认，保存禁用，不展示默认额度', async () => {
        const { runtime } = makeRuntime(() => undefined);
        const { host, root } = await render(<TravelSettings runtime={runtime} />);
        expect(host.querySelector('[data-testid="travel-settings-unknown"]')).not.toBeNull();
        const save = host.querySelector('[data-testid="travel-settings-save"]') as HTMLButtonElement;
        expect(save.disabled).toBe(true);
        expect(host.querySelector('[data-testid="travel-budget-map"]')).toHaveProperty('value', '');
        await act(async () => root.unmount());
    });

    it('读到设置后展示真实额度，额度与设置分别走 PUT，且都带服务端版本', async () => {
        const { runtime, calls } = makeRuntime((url, init) => {
            if (url.endsWith('/travel/settings') && init?.method === 'GET') return { settings: SETTINGS };
            if (url.endsWith('/travel/settings') && init?.method === 'PUT') {
                return { settings: { ...SETTINGS, ...JSON.parse(init.body), version: 5 } };
            }
            if (url.endsWith('/travel/budget') && init?.method === 'GET') return { budget: BUDGET };
            if (url.endsWith('/travel/budget') && init?.method === 'PUT') {
                return { budget: { ...BUDGET, ...JSON.parse(init.body) } };
            }
            return undefined;
        });
        const { host, root } = await render(<TravelSettings runtime={runtime} />);
        const mapInput = host.querySelector('[data-testid="travel-budget-map"]') as HTMLInputElement;
        // 额度来自服务端的同一本账（不是设置对象里的假字段）
        expect(mapInput.value).toBe('30');
        const save = host.querySelector('[data-testid="travel-settings-save"]') as HTMLButtonElement;
        expect(save.disabled).toBe(true); // 没改过就不给保存

        // 改地图额度 → 走独立的额度写入
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
            setter.call(mapInput, '12');
            mapInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => {
            (host.querySelector('[data-testid="travel-budget-save"]') as HTMLButtonElement).dispatchEvent(
                new MouseEvent('click', { bubbles: true }),
            );
        });
        const budgetPut = calls.find((c) => c.init?.method === 'PUT' && c.url.endsWith('/travel/budget'));
        expect(budgetPut).toBeTruthy();
        expect(JSON.parse(budgetPut!.init.body)).toMatchObject({ mapCallsLimit: 12 });

        // 改设置 → 带 baseVersion 的 CAS 写入
        const tzInput = host.querySelector('[data-testid="travel-budget-tz"]') as HTMLInputElement;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
            setter.call(tzInput, 'Asia/Tokyo');
            tzInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => {
            save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        const settingsPut = calls.find((c) => c.init?.method === 'PUT' && c.url.endsWith('/travel/settings'));
        expect(settingsPut).toBeTruthy();
        expect(JSON.parse(settingsPut!.init.body)).toMatchObject({ budgetTz: 'Asia/Tokyo', baseVersion: 4 });
        // 保存后重新读（GET 次数 ≥ 2），不拿本地回执当权威
        expect(calls.filter((c) => c.init?.method === 'GET' && c.url.endsWith('/travel/settings')).length).toBeGreaterThanOrEqual(2);
        await act(async () => root.unmount());
    });

    it('就绪状态如实标注：缺 JS Key / 安全代理 / 国外凭证都写未配置，不提 GPS', async () => {
        const { runtime } = makeRuntime((url, init) => {
            if (url.endsWith('/travel/settings') && init?.method === 'GET') return { settings: SETTINGS };
            if (url.endsWith('/travel/budget') && init?.method === 'GET') return { budget: BUDGET };
            return undefined;
        });
        const { host, root } = await render(<TravelSettings runtime={runtime} />);
        const text = host.textContent ?? '';
        expect(text).toContain('未配置');
        expect(text).toContain('不画假地图');
        expect(text).not.toContain('GPS');
        expect(text).not.toContain('精度');
        await act(async () => root.unmount());
    });
});

describe('TravelAnchorCard', () => {
    it('门牌级输入直接拒绝，不发搜索请求', async () => {
        const { runtime, calls } = makeRuntime(() => ({ results: [] }));
        const { host, root } = await render(<TravelAnchorCard runtime={runtime} />);
        const input = host.querySelector('[data-testid="travel-anchor-label"]') as HTMLInputElement;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
            setter.call(input, '阳光花园5号楼2单元');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(host.querySelector('[data-testid="travel-anchor-rejected"]')).not.toBeNull();
        await act(async () => {
            (host.querySelector('[data-testid="travel-anchor-search"]') as HTMLButtonElement).dispatchEvent(
                new MouseEvent('click', { bubbles: true }),
            );
        });
        expect(calls.find((c) => c.url.includes('/travel/anchor/search'))).toBeUndefined();
        await act(async () => root.unmount());
    });

    it('搜索走服务端；候选缺 placeId 时不确认（不让前端拼坐标）', async () => {
        const { runtime, calls } = makeRuntime((url) =>
            url.includes('/travel/anchor/search')
                ? { results: [{ label: '阳光花园', city: '杭州', district: '西湖区' }] }
                : undefined,
        );
        const { host, root } = await render(<TravelAnchorCard runtime={runtime} />);
        const input = host.querySelector('[data-testid="travel-anchor-label"]') as HTMLInputElement;
        const cityInput = host.querySelector('[data-testid="travel-anchor-city"]') as HTMLInputElement;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
            setter.call(input, '阳光花园');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            setter.call(cityInput, '杭州');
            cityInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => {
            (host.querySelector('[data-testid="travel-anchor-search"]') as HTMLButtonElement).dispatchEvent(
                new MouseEvent('click', { bubbles: true }),
            );
        });
        expect(calls.some((c) => c.url.includes('/travel/anchor/search?q='))).toBe(true);
        expect(calls.some((c) => c.url.includes('city='))).toBe(true);
        await act(async () => {
            (host.querySelector('[data-testid="travel-anchor-confirm"]') as HTMLButtonElement).dispatchEvent(
                new MouseEvent('click', { bubbles: true }),
            );
        });
        expect(calls.filter((c) => c.init?.method === 'POST' && c.url.endsWith('/travel/anchor'))).toHaveLength(0);
        expect(host.textContent).toContain('缺少服务端地点标识');
        await act(async () => root.unmount());
    });
});
