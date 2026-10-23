// @vitest-environment jsdom
/**
 * 出行悬浮球（B5）：轻拟物头像针，不是玻璃面板。
 *
 * 钉住的行为：
 * - 拖动 / 点击阈值（挪了几像素就不算点开面板）；
 * - 安全区与容器尺寸变化后重新夹紧（记忆位置不越界）；
 * - 与音乐球避让、位置记忆；
 * - 共享关闭 / 隐藏 / 无角色 → 完全不渲染（不泄露内容）。
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import TravelBall, {
    TRAVEL_BALL_STORAGE_KEY,
    TRAVEL_BALL_TAP_SLOP,
    avoidObstacle,
    clampBallPosition,
    isTapGesture,
    readStoredBallPosition,
    writeStoredBallPosition,
    type TravelCharacterView,
} from './TravelBall';

const act = (React as unknown as { act: (cb: () => void) => void }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const chars: TravelCharacterView[] = [
    { id: 'c1', name: '小满', avatarUrl: 'https://cdn.example.com/a.png' },
    { id: 'c2', name: '阿岚' },
];

const baseProps = {
    characters: chars,
    activeCharId: 'c1',
    shareEnabled: true,
    onOpen: () => {},
};

describe('TravelBall · 位置纯函数', () => {
    const bounds = { parentW: 393, parentH: 852, insetTop: 44, insetBottom: 34, size: 52, pad: 8 };

    it('夹进安全区（顶部不钻刘海、底部不压 home 条）', () => {
        expect(clampBallPosition({ x: -50, y: -50 }, bounds)).toEqual({ x: 8, y: 52 });
        expect(clampBallPosition({ x: 9999, y: 9999 }, bounds)).toEqual({
            x: 393 - 52 - 8,
            y: 852 - 52 - 8 - 34,
        });
    });

    it('容器变小（窗口缩窄/横屏回竖屏）时旧位置被重新夹紧，不留到屏幕外', () => {
        const shrunk = { ...bounds, parentW: 220, parentH: 400 };
        const kept = clampBallPosition({ x: 333, y: 700 }, shrunk);
        expect(kept.x).toBe(220 - 52 - 8);
        expect(kept.y).toBe(400 - 52 - 8 - 34);
        expect(kept.x).toBeGreaterThanOrEqual(8);
        expect(kept.y).toBeGreaterThanOrEqual(44 + 8);
    });

    it('容器比球还小时不产出负数坐标', () => {
        const tiny = { ...bounds, parentW: 30, parentH: 40 };
        const p = clampBallPosition({ x: 10, y: 10 }, tiny);
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(0);
    });

    it('避开音乐球：重叠时移到它上方，仍受安全区约束', () => {
        const music = { x: 300, y: 700, size: 40 };
        const moved = avoidObstacle({ x: 300, y: 700 }, bounds, music);
        expect(moved.y).toBeLessThanOrEqual(700 - 40 - 4);
        expect(clampBallPosition(moved, bounds)).toEqual(moved);
    });

    it('没有音乐球时位置原样返回', () => {
        const p = { x: 40, y: 300 };
        expect(avoidObstacle(p, bounds, null)).toEqual(p);
    });

    it('点击阈值：位移在阈值内算点击，超过算拖动', () => {
        expect(TRAVEL_BALL_TAP_SLOP).toBeGreaterThan(0);
        expect(isTapGesture(0, 0)).toBe(true);
        expect(isTapGesture(TRAVEL_BALL_TAP_SLOP, 0)).toBe(true);
        expect(isTapGesture(TRAVEL_BALL_TAP_SLOP + 1, 0)).toBe(false);
        expect(isTapGesture(0, -40)).toBe(false);
    });

    it('位置记忆：坏数据/缺字段一律当没记过', () => {
        const store = new Map<string, string>();
        const storage = {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
        };
        expect(readStoredBallPosition(storage)).toBeNull();
        writeStoredBallPosition(storage, { x: 12, y: 34 });
        expect(readStoredBallPosition(storage)).toEqual({ x: 12, y: 34 });
        store.set(TRAVEL_BALL_STORAGE_KEY, '{oops');
        expect(readStoredBallPosition(storage)).toBeNull();
        store.set(TRAVEL_BALL_STORAGE_KEY, '{"x":"12","y":34}');
        expect(readStoredBallPosition(storage)).toBeNull();
    });
});

describe('TravelBall · 静态结构', () => {
    it('常态渲染一枚可点击的头像针（不是整块玻璃面板）', () => {
        const html = renderToStaticMarkup(<TravelBall {...baseProps} />);
        expect(html).toContain('data-testid="travel-ball"');
        expect(html).toContain('aria-label');
        expect(html).toContain('行程');
        // 头像球：圆形 + 轻拟物阴影，无 backdrop-blur 全玻璃面
        expect(html).toContain('rounded-full');
        expect(html).not.toContain('backdrop-blur-xl');
    });

    it('多角色共享时给计数角标，只显示当前角色头像', () => {
        const html = renderToStaticMarkup(<TravelBall {...baseProps} />);
        expect(html).toContain('data-testid="travel-ball-count"');
        expect(html).toContain('2');
        expect(html).toContain('https://cdn.example.com/a.png');
        expect(html).not.toContain('阿岚');
    });

    it('单角色不显示计数角标', () => {
        const html = renderToStaticMarkup(<TravelBall {...baseProps} characters={[chars[0]!]} />);
        expect(html).not.toContain('data-testid="travel-ball-count"');
    });

    it('没有头像时用名字首字兜底，不出破图', () => {
        const html = renderToStaticMarkup(<TravelBall {...baseProps} characters={[chars[1]!]} activeCharId="c2" />);
        expect(html).not.toContain('<img');
        expect(html).toContain('阿');
    });

    it('共享关闭 / 手动隐藏 / 没角色 → 一律不渲染（内容不暴露）', () => {
        expect(renderToStaticMarkup(<TravelBall {...baseProps} shareEnabled={false} />)).toBe('');
        expect(renderToStaticMarkup(<TravelBall {...baseProps} hidden />)).toBe('');
        expect(renderToStaticMarkup(<TravelBall {...baseProps} characters={[]} />)).toBe('');
    });

    it('本组件不提供改人格/改目的地的入口（只有打开面板）', () => {
        const html = renderToStaticMarkup(<TravelBall {...baseProps} />);
        expect(html).not.toContain('前往');
        expect(html).not.toContain('改目的地');
        expect(html).not.toContain('移动');
    });
});

describe('TravelBall · 交互（jsdom 挂载）', () => {
    const mount = (props: Partial<React.ComponentProps<typeof TravelBall>> = {}) => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        const onOpen = vi.fn();
        act(() => {
            root.render(<TravelBall {...baseProps} {...props} onOpen={onOpen} />);
        });
        const ball = host.querySelector('[data-testid="travel-ball"]') as HTMLElement | null;
        return { host, root, onOpen, ball };
    };

    const pointer = (type: string, x: number, y: number) => {
        const ev = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
        return ev;
    };

    it('轻点算点击：打开面板', () => {
        const { ball, onOpen, root, host } = mount();
        expect(ball).not.toBeNull();
        act(() => {
            ball!.dispatchEvent(pointer('pointerdown', 100, 400));
            ball!.dispatchEvent(pointer('pointerup', 101, 401));
        });
        expect(onOpen).toHaveBeenCalledTimes(1);
        act(() => root.unmount());
        host.remove();
    });

    it('拖过阈值算拖动：移动位置但不打开面板', () => {
        const { ball, onOpen, root, host } = mount();
        act(() => {
            ball!.dispatchEvent(pointer('pointerdown', 100, 400));
            ball!.dispatchEvent(pointer('pointermove', 180, 560));
            ball!.dispatchEvent(pointer('pointerup', 180, 560));
        });
        expect(onOpen).not.toHaveBeenCalled();
        expect(host.querySelector('[data-testid="travel-ball"]')).not.toBeNull();
        act(() => root.unmount());
        host.remove();
    });
});
