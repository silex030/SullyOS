/**
 * 角色自主出行 · 悬浮层（B6 集成入口）
 *
 * 把 B5 的球 / 面板接到真实运行时上，并补齐 B5 刻意没做的两件事：
 * 1. **结束共享**：面板只负责看，授权开关放在这里（二次确认，避免误触）；
 * 2. **设置入口**：共享关闭时球消失，但仍要能进设置把共享/地址/预算配好。
 *
 * 边界：
 * - 共享未知（读失败）按「不可见」处理：不渲染球、不渲染面板，也不拿本地缓存补内容；
 * - 面板数据只来自 `runtime.store` 的脱敏快照；UI 不推进相位、不改目的地、不写心情；
 * - 地图未配置（缺 JS Key / 同源安全代理 / 国外凭证）时由画布自己显示「未就绪」，
 *   这里不提供任何假底图；
 * - 多角色共享时球显示计数，面板顶部切换；切换只是「看谁」，不改任何人的行程。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { GearSix, ShieldSlash } from '@phosphor-icons/react';
import { TRAVEL_ERROR_CODES, type TravelErrorCode } from '../../contracts/travel';
import { getTravelRuntime, type TravelRuntime } from '../../utils/travel/runtime';
import { readTravelMapConfig, type TravelMapRuntimeConfig } from '../../utils/travel/worldMapAdapter';
import TravelBall, { type TravelCharacterView } from './TravelBall';
import TravelMapPanel, { TRAVEL_PHASE_COPY, type TravelPanelView } from './TravelMapPanel';
import TravelChatCard from './TravelChatCard';
import type { TravelMapAdapter } from './TravelMapCanvas';

export interface TravelOverlayProps {
    /** 只读角色源（PhoneShell 从 OSContext 传入；本组件不改角色）。 */
    characters: readonly TravelCharacterView[];
    /** 测试 / 特殊宿主注入；默认用全局单例。 */
    runtime?: TravelRuntime;
    mapConfig?: TravelMapRuntimeConfig;
    adapter?: TravelMapAdapter | null;
    onOpenSettings?: () => void;
    className?: string;
}

const ERROR_SET = new Set<string>(TRAVEL_ERROR_CODES as readonly string[]);

const toErrorCode = (code: string | null | undefined): TravelErrorCode | null =>
    code && ERROR_SET.has(code) ? (code as TravelErrorCode) : null;

const TravelOverlay: React.FC<TravelOverlayProps> = ({
    characters,
    runtime: injected,
    mapConfig,
    adapter = null,
    onOpenSettings,
    className = '',
}) => {
    const runtime = injected ?? getTravelRuntime();
    const state = useSyncExternalStore(runtime.store.subscribe, runtime.store.getState, runtime.store.getState);
    const overlay = useSyncExternalStore(runtime.overlay.subscribe, runtime.overlay.get, runtime.overlay.get);
    const [confirmEnd, setConfirmEnd] = useState(false);
    const refreshedFor = useRef<string | null>(null);
    const config = useMemo(() => mapConfig ?? readTravelMapConfig(), [mapConfig]);

    const shareVisible = state.shareEnabled && state.shareKnown;
    const activeCharId = overlay.charId ?? characters[0]?.id ?? null;

    // 打开面板 / 首次拿到角色时读一次共享位；之后交给轮询。失败 → fail-closed。
    useEffect(() => {
        const target = overlay.open ? activeCharId : characters[0]?.id ?? null;
        if (!target || refreshedFor.current === target) return;
        refreshedFor.current = target;
        void runtime.refreshShare(target);
    }, [runtime, overlay.open, activeCharId, characters]);

    /**
     * 角色自知（提示词块）**不依赖共享开关**：共享关闭时公开快照是空的，但角色当然知道
     * 自己在去哪。这里在挂载后与每 60 秒（页面可见时）刷新一次内部脱敏上下文；
     * 它是本地后端请求，不调模型、不调地图，读完缓存在内存供聊天注入同步取。
     */
    useEffect(() => {
        const ids = characters.map((c) => c.id).filter(Boolean);
        if (ids.length === 0) return;
        let cancelled = false;
        const pull = () => {
            if (cancelled) return;
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            for (const id of ids) void runtime.refreshContext(id);
        };
        pull();
        const timer = setInterval(pull, 60_000);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [runtime, characters]);

    useEffect(() => {
        if (!overlay.open) setConfirmEnd(false);
    }, [overlay.open]);

    const view: TravelPanelView | null = useMemo(() => {
        const snapshot = state.view;
        if (!snapshot || snapshot.code !== 'OK' || !snapshot.trip) return null;
        return {
            phase: snapshot.trip.status,
            origin: snapshot.trip.origin
                ? {
                      label: snapshot.trip.origin.label,
                      city: snapshot.trip.origin.city,
                      district: snapshot.trip.origin.district,
                  }
                : null,
            destination: snapshot.trip.dest
                ? {
                      label: snapshot.trip.dest.label,
                      city: snapshot.trip.dest.city,
                      district: snapshot.trip.dest.district,
                  }
                : null,
            position: snapshot.position,
            routePoints: snapshot.route?.points ?? null,
            distanceM: snapshot.route?.distanceM ?? null,
            // 契约：没有可信到达时间就 null，面板写「未知」，不拿距离÷步速编。
            etaMs: null,
            updatedAt: state.confirmedAt || state.receivedAt || null,
            paused: false,
            stale: state.status === 'unconfirmed',
        };
    }, [state]);

    const handleSelect = useCallback(
        (charId: string) => {
            runtime.overlay.open(charId);
            refreshedFor.current = charId;
            void runtime.refreshShare(charId);
        },
        [runtime],
    );

    const handleRetry = useCallback(() => {
        if (activeCharId) void runtime.refreshShare(activeCharId);
    }, [runtime, activeCharId]);

    const handleEndShare = useCallback(async () => {
        if (!activeCharId) return;
        const res = await runtime.setShare(activeCharId, false);
        if (res.ok) {
            setConfirmEnd(false);
            runtime.overlay.close();
        }
    }, [runtime, activeCharId]);

    return (
        <>
            {shareVisible && (
                <TravelBall
                    characters={characters}
                    activeCharId={activeCharId}
                    shareEnabled={shareVisible}
                    phase={state.view?.trip?.status ?? null}
                    onOpen={(id) => {
                        runtime.overlay.open(id);
                        refreshedFor.current = id;
                        void runtime.refreshShare(id);
                    }}
                />
            )}

            <button
                data-testid="travel-overlay-settings"
                onClick={() => onOpenSettings?.()}
                aria-label="打开出行设置"
                className="absolute left-2 bottom-2 z-[57] flex items-center gap-1 px-2 py-1 rounded-full text-[10px] text-slate-600 active:scale-95 transition-transform"
                style={{
                    background: 'rgba(255,255,255,0.82)',
                    border: '1px solid rgba(255,255,255,0.7)',
                    boxShadow: '0 2px 8px rgba(15,23,42,0.12)',
                }}
            >
                <GearSix size={11} weight="bold" aria-hidden />
                出行
            </button>

            <TravelMapPanel
                open={overlay.open && shareVisible}
                characters={characters}
                activeCharId={activeCharId}
                view={view}
                shareEnabled={shareVisible}
                errorCode={toErrorCode(state.error)}
                coordSys={config.coordSys}
                amapJsKey={config.amapJsKey}
                amapServiceHost={config.amapServiceHost}
                licensedGeometry={config.licensedGeometry}
                adapter={adapter}
                onClose={() => runtime.overlay.close()}
                onSelectCharacter={handleSelect}
                onRetry={handleRetry}
                className={className}
            />

            {overlay.open && shareVisible && (
                <div className="absolute right-3 top-3 z-[75] flex items-center gap-1.5">
                    {confirmEnd ? (
                        <>
                            <button
                                data-testid="travel-end-share-confirm"
                                onClick={() => void handleEndShare()}
                                className="px-2 py-1 rounded-full text-[10px] font-medium text-white active:scale-95 transition-transform"
                                style={{ background: 'rgba(190,18,60,0.92)' }}
                            >
                                确认结束共享
                            </button>
                            <button
                                onClick={() => setConfirmEnd(false)}
                                className="px-2 py-1 rounded-full text-[10px] text-slate-600 active:scale-95 transition-transform"
                                style={{ background: 'rgba(255,255,255,0.9)' }}
                            >
                                再想想
                            </button>
                        </>
                    ) : (
                        <button
                            data-testid="travel-end-share"
                            onClick={() => setConfirmEnd(true)}
                            aria-label="结束位置共享（不取消 TA 的出行）"
                            className="flex items-center gap-1 px-2 py-1 rounded-full text-[10px] text-slate-600 active:scale-95 transition-transform"
                            style={{
                                background: 'rgba(255,255,255,0.9)',
                                border: '1px solid rgba(255,255,255,0.7)',
                                boxShadow: '0 2px 8px rgba(15,23,42,0.12)',
                            }}
                        >
                            <ShieldSlash size={11} weight="bold" aria-hidden />
                            结束共享
                        </button>
                    )}
                </div>
            )}
        </>
    );
};

/**
 * 聊天里的紧凑入口：只显示当前相位并打开面板。
 * 共享关闭 / 没有行程 → 不渲染（不在聊天里泄露「TA 在哪」）。
 */
export const TravelChatEntry: React.FC<{
    charId: string;
    charName: string;
    runtime?: TravelRuntime;
    className?: string;
}> = ({ charId, charName, runtime: injected, className = '' }) => {
    const runtime = injected ?? getTravelRuntime();
    const state = useSyncExternalStore(runtime.store.subscribe, runtime.store.getState, runtime.store.getState);
    const phase = state.view?.code === 'OK' ? state.view?.trip?.status ?? null : null;
    if (!state.shareEnabled || !state.shareKnown || !phase) return null;
    return (
        <button
            data-testid="travel-chat-entry"
            onClick={() => runtime.overlay.open(charId)}
            aria-label={`${charName} 的行程，打开地图`}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] text-slate-600 active:scale-95 transition-transform ${className}`}
            style={{
                background: 'rgba(255,255,255,0.9)',
                border: '1px solid rgba(255,255,255,0.75)',
                boxShadow: '0 2px 8px rgba(15,23,42,0.10)',
            }}
        >
            <span className="w-1.5 h-1.5 rounded-full bg-sky-400" aria-hidden />
            {charName} · {TRAVEL_PHASE_COPY[phase]}
        </button>
    );
};

/**
 * 聊天消息里的行程卡（`travel_card`）。作为独立组件持有 store 订阅，
 * 这样 MessageItem 不需要为它加 hook（MessageItem 有大量早退分支）。
 * 共享关闭 / metadata 缺阶段 → 不渲染。
 */
export const TravelCardMessage: React.FC<{
    charId: string;
    charName: string;
    avatarUrl?: string | null;
    travel: {
        phase?: string | null;
        originLabel?: string | null;
        destinationLabel?: string | null;
        positionLabel?: string | null;
        etaMs?: number | null;
        paused?: boolean;
        stale?: boolean;
        mapThumbnailUrl?: string | null;
    };
    runtime?: TravelRuntime;
}> = ({ charId, charName, avatarUrl = null, travel, runtime: injected }) => {
    const runtime = injected ?? getTravelRuntime();
    const state = useSyncExternalStore(runtime.store.subscribe, runtime.store.getState, runtime.store.getState);
    const phase = travel.phase as never;
    if (!state.shareEnabled || !state.shareKnown || !travel.phase) return null;
    return (
        <TravelChatCard
            charName={charName}
            avatarUrl={avatarUrl}
            phase={phase}
            originLabel={travel.originLabel ?? null}
            destinationLabel={travel.destinationLabel ?? null}
            positionLabel={travel.positionLabel ?? null}
            etaMs={typeof travel.etaMs === 'number' ? travel.etaMs : null}
            paused={!!travel.paused}
            stale={!!travel.stale}
            mapThumbnailUrl={travel.mapThumbnailUrl ?? null}
            shareEnabled
            onOpen={() => runtime.overlay.open(charId)}
        />
    );
};

export default TravelOverlay;
