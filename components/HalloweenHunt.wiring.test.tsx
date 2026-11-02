// @vitest-environment jsdom
/**
 * 本次接线新增组件用例（显式测试时钟）：
 * - 窗口内 todayKey：收集 6 点 → 领取 → onReward 恰一次 → 重开仍 claimed 且不再发 intent。
 * - 窗口外 todayKey：未开始 / 已结束如实展示，不冒充开放。
 * - 生产路径（不传 todayKey）：按设备本地真实今天展示阶段，不伪造日期。
 */
import { describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HalloweenHunt } from '../features/seasonal-events/HalloweenHunt';
import { SharedMemoryMutex } from '../features/room3d/mutex';
import { HALLOWEEN_SPOTS, type HalloweenRewardIntent } from '../features/seasonal-events/types';
import { getHalloweenPhase } from '../features/seasonal-events/halloween';
import { getLocalDateKey } from '../utils/localDate';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class MemStore {
    private m = new Map<string, string>();
    getItem(k: string): string | null {
        return this.m.has(k) ? this.m.get(k)! : null;
    }
    setItem(k: string, v: string): void {
        this.m.set(k, String(v));
    }
    removeItem(k: string): void {
        this.m.delete(k);
    }
}

const SPOT_LABEL: Record<string, string> = {
    pumpkin: '南瓜',
    ghost: '幽灵',
    bat: '蝙蝠',
    candy: '糖果',
    lantern: '灯笼',
    hat: '巫师帽',
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(ui: React.ReactElement): void {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
        root!.render(ui);
    });
}

function unmount(): void {
    act(() => {
        root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
}

const text = (): string => container?.textContent ?? '';

async function flushUntil(predicate: () => boolean, tries = 120): Promise<void> {
    for (let i = 0; i < tries && !predicate(); i++) {
        await act(async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
        });
    }
    expect(predicate()).toBe(true);
}

function clickCollect(spot: string): void {
    const btn = container?.querySelector(
        `[aria-label="收集${SPOT_LABEL[spot]}"]`,
    ) as HTMLElement | null;
    expect(btn, `collect button for ${spot}`).toBeTruthy();
    act(() => {
        btn!.click();
    });
}

describe('HalloweenHunt 接线（显式时钟）', () => {
    it('窗口内：收 6 点 → 领取 → onReward 恰一次 → 重开仍 claimed 且不重发', async () => {
        const storage = new MemStore();
        const mutex = new SharedMemoryMutex();
        const intents: HalloweenRewardIntent[] = [];
        const onReward = vi.fn((intent: HalloweenRewardIntent) => {
            intents.push(intent);
        });
        mount(
            <HalloweenHunt
                charId="charT"
                storage={storage}
                mutex={mutex}
                todayKey="2026-10-30"
                onReward={onReward}
            />,
        );
        expect(text()).toContain('进行中');
        for (const spot of HALLOWEEN_SPOTS) {
            clickCollect(spot);
            await flushUntil(() => text().includes(`${SPOT_LABEL[spot]} ✓`));
        }
        expect(text()).toContain('6/6');
        const claimBtn = Array.from(
            container!.querySelectorAll('button'),
        ).find((b) => b.textContent?.includes('集齐啦')) as HTMLElement | undefined;
        expect(claimBtn, 'claim button').toBeTruthy();
        act(() => {
            claimBtn!.click();
        });
        await flushUntil(() => text().includes('hw2026-charT'));
        expect(onReward).toHaveBeenCalledTimes(1);
        expect(intents[0]).toMatchObject({
            kind: 'halloween-candy',
            eventId: 'halloween-2026',
            charId: 'charT',
            claimId: 'hw2026-charT',
            collectedCount: 6,
        });
        unmount();

        // 重开：持久 claimed 可见，不再发 intent（刷新 / 重放不重复记奖）
        const onReward2 = vi.fn();
        mount(
            <HalloweenHunt
                charId="charT"
                storage={storage}
                mutex={mutex}
                todayKey="2026-10-30"
                onReward={onReward2}
            />,
        );
        await flushUntil(() => text().includes('hw2026-charT'));
        expect(text()).toContain('已完成');
        // 同一实例再次挂载不触发领取回调
        await act(async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 30));
        });
        expect(onReward2).not.toHaveBeenCalled();
        unmount();
    });

    it('窗口外如实展示阶段：未开始 / 已结束，不冒充开放', async () => {
        const storage = new MemStore();
        const mutex = new SharedMemoryMutex();
        mount(
            <HalloweenHunt
                charId="charT"
                storage={storage}
                mutex={mutex}
                todayKey="2026-10-28"
            />,
        );
        await flushUntil(() => text().includes('10 月 29 日'));
        expect(text()).toContain('10-29 开启');
        unmount();

        mount(
            <HalloweenHunt
                charId="charT"
                storage={storage}
                mutex={mutex}
                todayKey="2026-11-05"
            />,
        );
        await flushUntil(() => text().includes('已结束'));
        // 已结束且未集齐：无领取按钮
        expect(
            Array.from(container!.querySelectorAll('button')).some((b) =>
                b.textContent?.includes('集齐啦'),
            ),
        ).toBe(false);
        unmount();
    });

    it('生产路径（不传 todayKey）按设备本地真实今天展示阶段', async () => {
        const storage = new MemStore();
        const mutex = new SharedMemoryMutex();
        mount(<HalloweenHunt charId="charT" storage={storage} mutex={mutex} />);
        const realToday = getLocalDateKey(new Date());
        const phase = getHalloweenPhase(realToday);
        const marker =
            phase === 'active' ? '进行中' : phase === 'before' ? '10-29 开启' : '已结束';
        await flushUntil(() => text().includes(marker));
        expect(text()).toContain(`今天 ${realToday}`);
        unmount();
    });
});
