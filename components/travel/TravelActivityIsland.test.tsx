// @vitest-environment jsdom
/**
 * 顶部出行状态（灵动岛式）组件：纯 props 驱动，钉住显示矩阵与交互，
 * 不碰 runtime / 不碰网络。
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import TravelActivityIsland from './TravelActivityIsland';
import type { TravelIslandEntry } from '../../utils/travel/activityPresentation';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const char = (id: string, name: string, avatarUrl: string | null = null) => ({ id, name, avatarUrl });

const entry = (patch: Partial<TravelIslandEntry> = {}): TravelIslandEntry => ({
    char: char('c1', '小满'),
    phase: 'en_route',
    destinationLabel: '西湖文化广场',
    originLabel: '阳光花园',
    etaMs: 12 * 60_000,
    shareEnabled: true,
    shareKnown: true,
    ...patch,
});

const render = async (ui: React.ReactElement) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
        root.render(ui);
    });
    return { host, root };
};

const testId = (host: HTMLElement, id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('TravelActivityIsland', () => {
    it('在路上：一个合并条，含角色名、相位、地名与可信 ETA', async () => {
        const { host, root } = await render(
            <TravelActivityIsland entries={[entry()]} activeCharId="c1" onOpen={() => {}} />,
        );
        const island = testId(host, 'travel-island');
        expect(island).not.toBeNull();
        expect(island!.textContent).toContain('小满');
        expect(island!.textContent).toContain('在路上');
        expect(island!.textContent).toContain('西湖文化广场');
        expect(island!.textContent).toContain('约 12 分钟');
        // 不是左下角悬浮球：没有球、也不吸收拖拽
        expect(host.querySelector('[data-testid="travel-ball"]')).toBeNull();
        await act(async () => root.unmount());
    });

    it('共享关闭 / 未出发的计划 / 终态 → 整条不渲染', async () => {
        for (const e of [
            entry({ shareEnabled: false }),
            entry({ shareKnown: false }),
            entry({ phase: 'planned' }),
            entry({ phase: 'returned' }),
            entry({ phase: null }),
        ]) {
            const { host, root } = await render(
                <TravelActivityIsland entries={[e]} activeCharId="c1" onOpen={() => {}} />,
            );
            expect(host.querySelector('[data-testid="travel-island"]')).toBeNull();
            await act(async () => root.unmount());
        }
    });

    it('未确认快照写明「未更新」且不显示任何分钟数', async () => {
        const { host, root } = await render(
            <TravelActivityIsland entries={[entry({ stale: true })]} activeCharId="c1" onOpen={() => {}} />,
        );
        const island = testId(host, 'travel-island')!;
        expect(island.textContent).toContain('未更新');
        expect(island.textContent).not.toMatch(/约\s*\d+\s*分钟/);
        expect(testId(host, 'travel-island-eta')).toBeNull();
        expect(island.getAttribute('data-stale')).toBe('true');
        await act(async () => root.unmount());
    });

    it('暂停时写「已暂停」，不假装还在动', async () => {
        const { host, root } = await render(
            <TravelActivityIsland entries={[entry({ paused: true })]} activeCharId="c1" onOpen={() => {}} />,
        );
        const island = testId(host, 'travel-island')!;
        expect(island.textContent).toContain('已暂停');
        expect(island.textContent).not.toMatch(/约\s*\d+\s*分钟/);
        await act(async () => root.unmount());
    });

    it('点击整条打开既有地图面板；点选头像切人只改「看谁」', async () => {
        const onOpen = vi.fn();
        const onSelect = vi.fn();
        const { host, root } = await render(
            <TravelActivityIsland
                entries={[
                    entry({ char: char('c1', '小满') }),
                    entry({ char: char('c2', '阿岚'), phase: 'dwelling', destinationLabel: '单向空间' }),
                ]}
                activeCharId="c1"
                onOpen={onOpen}
                onSelect={onSelect}
            />,
        );
        // 两条合并成一个顶栏，不叠两个岛
        expect(host.querySelectorAll('[data-testid="travel-island"]')).toHaveLength(1);
        const switchButtons = host.querySelectorAll('[data-testid="travel-island-switch"]');
        expect(switchButtons).toHaveLength(2);
        await act(async () => {
            (switchButtons[1] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(onSelect).toHaveBeenCalledWith('c2');
        expect(onOpen).not.toHaveBeenCalled();

        const main = testId(host, 'travel-island-open')!;
        await act(async () => {
            main.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(onOpen).toHaveBeenCalledWith('c1');
        await act(async () => root.unmount());
    });

    it('切到第二个角色后，条上显示的是那个人的状态', async () => {
        const { host, root } = await render(
            <TravelActivityIsland
                entries={[
                    entry({ char: char('c1', '小满') }),
                    entry({ char: char('c2', '阿岚'), phase: 'dwelling', destinationLabel: '单向空间' }),
                ]}
                activeCharId="c2"
                onOpen={() => {}}
                onSelect={() => {}}
            />,
        );
        const island = testId(host, 'travel-island')!;
        expect(island.textContent).toContain('阿岚');
        expect(island.textContent).toContain('在停留');
        expect(island.textContent).toContain('单向空间');
        expect(island.textContent).not.toContain('西湖文化广场');
        await act(async () => root.unmount());
    });

    it('通话/生成指示条占用顶部时让位：通话隐藏，指示条把岛往下推', async () => {
        const hidden = await render(
            <TravelActivityIsland entries={[entry()]} activeCharId="c1" onOpen={() => {}} callBarActive />,
        );
        expect(hidden.host.querySelector('[data-testid="travel-island"]')).toBeNull();
        await act(async () => hidden.root.unmount());

        const stack = await render(
            <TravelActivityIsland entries={[entry()]} activeCharId="c1" onOpen={() => {}} personaIndicator />,
        );
        const row = testId(stack.host, 'travel-island-row')!;
        expect(row.style.top).toBe('96px');
        await act(async () => stack.root.unmount());
    });

    it('没有头像时用名字首字兜底，不破版', async () => {
        const { host, root } = await render(
            <TravelActivityIsland entries={[entry()]} activeCharId="c1" onOpen={() => {}} />,
        );
        expect(testId(host, 'travel-island')!.textContent).toContain('小');
        await act(async () => root.unmount());
    });
});
