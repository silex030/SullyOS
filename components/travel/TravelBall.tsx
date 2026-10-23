/**
 * 角色自主出行 · 共享位置悬浮球（B5）
 *
 * 视觉：轻拟物的「头像地图针」——实心材质头像球 + 下方小尾针 + 内高光，
 * 不是整块玻璃面板（全玻璃留给面板本体）。沿用设计规范里的圆角档位与
 * `--m2-*` 时长，动画只用 transform / opacity。
 *
 * 行为（全部 props 驱动，不依赖任何未完成的数据层）：
 * - 拖拽 / 点击阈值：位移超过 {@link TRAVEL_BALL_TAP_SLOP} 才算拖动，否则点开面板；
 * - 安全区（刘海 / home 条）由 `utils/floatingBallBounds` 的同一套算法夹紧；
 * - 容器尺寸变化（Rotate / 窗口缩放）后把记忆位置重新夹回来，不会飘到屏幕外；
 * - 记忆位置写 localStorage，坏数据当没记过；
 * - 与音乐球（GlobalMiniPlayer 小球）避让：重叠时叠到它上方；
 * - 共享关闭 / 手动隐藏 / 无角色 → 直接不渲染，内容不外露。
 *
 * 明确不做：不改角色打算、不显示假 GPS 精度、不在这里推进任何服务端状态。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    clampBubblePos,
    resolveInsets,
} from '../../utils/floatingBallBounds';
import { readSafeAreaInsets } from '../../utils/iosStandalone';
import type { TravelTripStatus } from '../../contracts/travel';

export const TRAVEL_BALL_SIZE = 52;
/** 像素：位移超过它算拖动，否则算点击（与音乐球同一手感）。 */
export const TRAVEL_BALL_TAP_SLOP = 6;
export const TRAVEL_BALL_STORAGE_KEY = 'travel.ball.pos.v1';
export const TRAVEL_BALL_AVOID_GAP = 6;
const LONG_PRESS_MS = 600;

export interface TravelCharacterView {
    id: string;
    name: string;
    /** 头像 URL（可为空 → 用名字首字兜底）。 */
    avatarUrl?: string | null;
}

export interface BallPoint {
    x: number;
    y: number;
}

export interface BallBounds {
    parentW: number;
    parentH: number;
    insetTop: number;
    insetBottom: number;
    size?: number;
    pad?: number;
}

/** 需要避让的其它悬浮球（目前是音乐球）：x/y 同为左上角坐标。 */
export interface BallObstacle {
    x: number;
    y: number;
    size: number;
}

export interface TravelBallProps {
    characters: readonly TravelCharacterView[];
    activeCharId?: string | null;
    /** 共享关闭时必须传 false —— 球与内容一起消失。 */
    shareEnabled: boolean;
    /** 只影响状态点颜色，不参与任何状态推进。 */
    phase?: TravelTripStatus | null;
    hidden?: boolean;
    initialPosition?: BallPoint | null;
    storageKey?: string;
    musicBall?: BallObstacle | null;
    /** 轻点：打开行程面板（必须由宿主决定面板开合）。 */
    onOpen: (charId: string) => void;
    /** 长按：收起本球（不等于关闭共享）。 */
    onHide?: (charId: string) => void;
    className?: string;
    style?: React.CSSProperties;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 夹进安全区。容器比球还小的时候也不产出负数。 */
export const clampBallPosition = (point: BallPoint, bounds: BallBounds): BallPoint =>
    clampBubblePos(point.x, point.y, {
        parentW: Math.max(0, bounds.parentW),
        parentH: Math.max(0, bounds.parentH),
        insetTop: Math.max(0, bounds.insetTop),
        insetBottom: Math.max(0, bounds.insetBottom),
        bubble: bounds.size ?? TRAVEL_BALL_SIZE,
        pad: bounds.pad ?? 8,
    });

const boxesOverlap = (a: BallPoint, aSize: number, b: BallPoint, bSize: number, gap: number): boolean =>
    a.x < b.x + bSize + gap && a.x + aSize + gap > b.x && a.y < b.y + bSize + gap && a.y + aSize + gap > b.y;

/**
 * 与音乐球避让：重叠就把出行球叠到音乐球上方；结果再过一遍安全区夹紧。
 * 不做逐帧碰撞，避免打开面板/转动屏幕时球来回抖。
 */
export const avoidObstacle = (
    point: BallPoint,
    bounds: BallBounds,
    obstacle: BallObstacle | null | undefined,
): BallPoint => {
    const size = bounds.size ?? TRAVEL_BALL_SIZE;
    if (!obstacle || !isFiniteNumber(obstacle.x) || !isFiniteNumber(obstacle.y)) return point;
    const oSize = isFiniteNumber(obstacle.size) ? obstacle.size : size;
    if (!boxesOverlap(point, size, { x: obstacle.x, y: obstacle.y }, oSize, TRAVEL_BALL_AVOID_GAP)) return point;
    const lifted = { x: point.x, y: obstacle.y - size - TRAVEL_BALL_AVOID_GAP };
    return clampBallPosition(lifted, bounds);
};

/** 位移在阈值内算点击。 */
export const isTapGesture = (dx: number, dy: number, slop: number = TRAVEL_BALL_TAP_SLOP): boolean =>
    Math.hypot(Number.isFinite(dx) ? dx : 0, Number.isFinite(dy) ? dy : 0) <= slop;

export const readStoredBallPosition = (
    storage: Pick<Storage, 'getItem'> | null | undefined,
    key: string = TRAVEL_BALL_STORAGE_KEY,
): BallPoint | null => {
    if (!storage) return null;
    try {
        const raw = storage.getItem(key);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        const { x, y } = parsed as { x?: unknown; y?: unknown };
        return isFiniteNumber(x) && isFiniteNumber(y) ? { x, y } : null;
    } catch {
        return null;
    }
};

export const writeStoredBallPosition = (
    storage: Pick<Storage, 'setItem'> | null | undefined,
    point: BallPoint,
    key: string = TRAVEL_BALL_STORAGE_KEY,
): void => {
    if (!storage) return;
    try {
        storage.setItem(key, JSON.stringify({ x: point.x, y: point.y }));
    } catch {
        // 隐私模式 / 配额满：记忆失败不影响本轮拖拽
    }
};

const safeLocalStorage = (): Storage | null => {
    if (typeof window === 'undefined') return null;
    try {
        return window.localStorage;
    } catch {
        return null;
    }
};

const readSafeTop = (): number => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return 0;
    try {
        const raw = parseFloat(
            window.getComputedStyle(document.documentElement).getPropertyValue('--safe-top'),
        );
        if (Number.isFinite(raw) && raw > 0) return raw;
    } catch {
        // 读不到样式就退回探针
    }
    try {
        return readSafeAreaInsets().top || 0;
    } catch {
        return 0;
    }
};

/** 父容器 padding box 的可用边界（含安全区）。 */
const measureBounds = (parent: HTMLElement, size: number = TRAVEL_BALL_SIZE): BallBounds => {
    const rect = parent.getBoundingClientRect();
    let padTop = 0;
    let padBottom = 0;
    if (typeof window !== 'undefined') {
        const cs = window.getComputedStyle(parent);
        padTop = parseFloat(cs.paddingTop) || 0;
        padBottom = parseFloat(cs.paddingBottom) || 0;
    }
    const { insetTop, insetBottom } = resolveInsets({ padTop, padBottom, safeTop: readSafeTop() });
    return { parentW: rect.width, parentH: rect.height, insetTop, insetBottom, size };
};

const initialOf = (name: string): string => (name || '?').trim().slice(0, 1) || '?';

const phaseDotColor = (phase: TravelTripStatus | null | undefined): string => {
    switch (phase) {
        case 'en_route':
        case 'returning':
            return '#38bdf8';
        case 'dwelling':
            return '#34d399';
        case 'expired':
        case 'aborted':
            return '#94a3b8';
        case 'unavailable':
            return '#f59e0b';
        default:
            return '#a78bfa';
    }
};

const TravelBall: React.FC<TravelBallProps> = ({
    characters,
    activeCharId,
    shareEnabled,
    phase = null,
    hidden = false,
    initialPosition = null,
    storageKey = TRAVEL_BALL_STORAGE_KEY,
    musicBall = null,
    onOpen,
    onHide,
    className = '',
    style,
}) => {
    const active = characters.find((c) => c.id === activeCharId) ?? characters[0] ?? null;

    const [pos, setPos] = useState<BallPoint | null>(
        () => initialPosition ?? readStoredBallPosition(safeLocalStorage(), storageKey),
    );

    const wrapRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{
        startX: number;
        startY: number;
        offX: number;
        offY: number;
        pointerId: number | null;
        moved: boolean;
    } | null>(null);
    const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearLongPress = useCallback(() => {
        if (longPressRef.current) {
            clearTimeout(longPressRef.current);
            longPressRef.current = null;
        }
    }, []);

    // 记忆位置
    useEffect(() => {
        if (!pos) return;
        writeStoredBallPosition(safeLocalStorage(), pos, storageKey);
    }, [pos, storageKey]);

    // 尺寸变化（转屏 / 改窗口 / 键盘弹出）后把记忆位置重新夹回来
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const parent = wrapRef.current?.parentElement ?? null;
        if (!parent) return;

        const reclamp = () => {
            setPos((prev) => (prev ? clampBallPosition(prev, measureBounds(parent)) : prev));
        };
        reclamp();

        let observer: ResizeObserver | null = null;
        if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(reclamp);
            observer.observe(parent);
        }
        window.addEventListener('resize', reclamp);
        window.addEventListener('orientationchange', reclamp);
        return () => {
            observer?.disconnect();
            window.removeEventListener('resize', reclamp);
            window.removeEventListener('orientationchange', reclamp);
        };
    }, []);

    // 音乐球出现 / 挪位时避让
    useEffect(() => {
        if (!musicBall) return;
        setPos((prev) => {
            if (!prev) return prev;
            const parent = wrapRef.current?.parentElement ?? null;
            if (!parent) return prev;
            const bounds = measureBounds(parent);
            return avoidObstacle(prev, bounds, musicBall);
        });
    }, [musicBall?.x, musicBall?.y, musicBall?.size]);

    const onPointerDown = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            const el = wrapRef.current;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            dragRef.current = {
                startX: e.clientX,
                startY: e.clientY,
                offX: e.clientX - rect.left,
                offY: e.clientY - rect.top,
                pointerId: e.pointerId ?? null,
                moved: false,
            };
            clearLongPress();
            if (onHide && active) {
                longPressRef.current = setTimeout(() => {
                    const drag = dragRef.current;
                    if (drag && !drag.moved) {
                        dragRef.current = null;
                        onHide(active.id);
                    }
                }, LONG_PRESS_MS);
            }
            try {
                (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            } catch {
                // jsdom / 老浏览器没有 pointer capture
            }
        },
        [active, clearLongPress, onHide],
    );

    const onPointerMove = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            const drag = dragRef.current;
            if (!drag) return;
            const dx = e.clientX - drag.startX;
            const dy = e.clientY - drag.startY;
            if (!drag.moved && !isTapGesture(dx, dy)) {
                drag.moved = true;
                clearLongPress();
            }
            if (!drag.moved) return;

            const parent = wrapRef.current?.parentElement ?? null;
            if (!parent) return;
            const rect = parent.getBoundingClientRect();
            const next = clampBallPosition(
                { x: e.clientX - rect.left - drag.offX, y: e.clientY - rect.top - drag.offY },
                measureBounds(parent),
            );
            setPos(next);
        },
        [clearLongPress],
    );

    const endDrag = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            const drag = dragRef.current;
            clearLongPress();
            dragRef.current = null;
            try {
                (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
            } catch {
                // 同上
            }
            if (drag && !drag.moved && active) onOpen(active.id);
        },
        [active, clearLongPress, onOpen],
    );

    if (!shareEnabled || hidden || !active) return null;

    const positional: React.CSSProperties = pos ? { left: pos.x, top: pos.y } : { right: 12, bottom: 96 };

    return (
        <div
            ref={wrapRef}
            data-testid="travel-ball"
            role="button"
            tabIndex={0}
            aria-label={`${active.name} 的行程（轻点查看地图，拖动可移位，长按收起）`}
            title="行程 · 轻点查看地图"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpen(active.id);
                }
            }}
            className={`absolute z-[58] touch-none select-none cursor-grab active:cursor-grabbing active:scale-95 transition-transform ${className}`}
            style={{ width: TRAVEL_BALL_SIZE, height: TRAVEL_BALL_SIZE + 8, ...positional, ...style }}
        >
            {/* 尾针：轻拟物材质的一小块，不是玻璃 */}
            <div
                aria-hidden
                className="absolute left-1/2 rounded-[3px]"
                style={{
                    bottom: 0,
                    width: 10,
                    height: 10,
                    transform: 'translateX(-50%) rotate(45deg)',
                    background: 'linear-gradient(160deg, #ffffff 0%, #e9edf3 100%)',
                    boxShadow: '0 3px 6px rgba(15,23,42,0.28)',
                    border: '1px solid rgba(255,255,255,0.85)',
                }}
            />
            {/* 头像球：实心材质 + 内高光 + 柔和外阴影 */}
            <div
                className="relative w-full h-full rounded-full overflow-hidden"
                style={{
                    background: 'linear-gradient(165deg, #ffffff 0%, #eef1f6 62%, #e2e7ef 100%)',
                    boxShadow:
                        '0 8px 20px rgba(15,23,42,0.30), 0 1px 0 rgba(255,255,255,0.9) inset, 0 -2px 6px rgba(15,23,42,0.10) inset',
                    border: '1.5px solid rgba(255,255,255,0.92)',
                }}
            >
                {active.avatarUrl ? (
                    <img
                        src={active.avatarUrl}
                        alt=""
                        draggable={false}
                        className="w-full h-full object-cover pointer-events-none"
                    />
                ) : (
                    <span
                        className="absolute inset-0 flex items-center justify-center text-[17px] font-medium text-slate-600 pointer-events-none"
                        aria-hidden
                    >
                        {initialOf(active.name)}
                    </span>
                )}
                {/* 顶部内高光：一层薄材质，不做 blur */}
                <span
                    aria-hidden
                    className="absolute left-2 right-2 top-1 h-3 rounded-full pointer-events-none"
                    style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.55), rgba(255,255,255,0))' }}
                />
                {/* 相位小点：只表示展示状态，不代表 GPS */}
                <span
                    aria-hidden
                    className="absolute right-0.5 bottom-0.5 w-2.5 h-2.5 rounded-full pointer-events-none"
                    style={{
                        background: phaseDotColor(phase),
                        boxShadow: '0 0 0 2px rgba(255,255,255,0.92)',
                    }}
                />
            </div>
            {/* 多角色共享：右上角计数（点开后在面板顶部切换） */}
            {characters.length > 1 && (
                <span
                    data-testid="travel-ball-count"
                    className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center text-[9px] font-semibold text-white pointer-events-none"
                    style={{ background: 'rgba(51,65,85,0.92)', boxShadow: '0 1px 3px rgba(15,23,42,0.35)' }}
                    aria-hidden
                >
                    {characters.length}
                </span>
            )}
            {/* 尾针已经说明这是地图针，不再叠第二个图标 */}
        </div>
    );
};

export default TravelBall;
