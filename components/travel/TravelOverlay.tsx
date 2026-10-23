/**
 * 角色自主出行 · 悬浮层（顶部灵动岛式，B6 集成入口）
 *
 * 与 B5 的区别（2026-10-24 用户要求）：**取消左下角悬浮球**，改成挂在状态栏下方的
 * 一条顶部状态胶囊（`TravelActivityIsland`）——只有真的在出行、且位置共享允许展示时才出现，
 * 轻点展开既有地图面板。设置不再靠底部小胶囊，而是走设置 App 里的出行板块
 * （`components/settings/TravelMapServiceCard.tsx` + 角色页 `TravelCharCard`）。
 *
 * 边界：
 * - 共享未知（读失败）按「不可见」处理：不渲染岛、不渲染面板，也不拿本地缓存补内容；
 * - 面板数据只来自 `runtime.store` 的脱敏快照；UI 不推进相位、不改目的地、不写心情；
 * - 地图未配置（缺 JS Key / 同源安全代理 / 国外凭证）时由画布自己显示「未就绪」，
 *   这里不提供任何假底图；
 * - 顶部优先级：通话 > 生成指示条（演出/梦境）> 出行岛；岛只占顶部一行，不挡底部触摸导航；
 * - 旧悬浮球的位置记忆键在这里一次性清掉（只删那一把，不动用户其它 localStorage）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ShieldSlash } from '@phosphor-icons/react';
import { TRAVEL_ERROR_CODES, type TravelErrorCode } from '../../contracts/travel';
import { getTravelRuntime, type TravelRuntime } from '../../utils/travel/runtime';
import { readTravelMapConfig, type TravelMapRuntimeConfig } from '../../utils/travel/worldMapAdapter';
import { loadTravelMapRuntime } from '../../utils/travel/mapRuntime';
import { clearLegacyTravelBallStorage, type TravelCharacterView, type TravelIslandEntry } from '../../utils/travel/activityPresentation';
import { usePersonaSim } from '../../utils/personaSimStore';
import { useDreamSim } from '../../utils/dreamSimStore';
import TravelActivityIsland from './TravelActivityIsland';
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
    /** 保留给外壳的兼容入口（设置已迁到设置 App，这里不再画底部胶囊）。 */
    onOpenSettings?: () => void;
    /** 通话条在顶时整条让位；外壳可直接传，默认 false。 */
    callBarActive?: boolean;
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
    callBarActive = false,
    className = '',
}) => {
    const runtime = injected ?? getTravelRuntime();
    const state = useSyncExternalStore(runtime.store.subscribe, runtime.store.getState, runtime.store.getState);
    const overlay = useSyncExternalStore(runtime.overlay.subscribe, runtime.overlay.get, runtime.overlay.get);
    const personaSim = usePersonaSim();
    const dreamSim = useDreamSim();
    const [confirmEnd, setConfirmEnd] = useState(false);
    const refreshedFor = useRef<string | null>(null);
    // 地图配置：先在首帧用构建期兜底，随后按已签名会话拉服务端凭据（用户自己填的优先）。
    const [config, setConfig] = useState<TravelMapRuntimeConfig>(
        () => mapConfig ?? readTravelMapConfig(),
    );
    useEffect(() => {
        if (mapConfig) {
            setConfig(mapConfig);
            return;
        }
        let alive = true;
        void loadTravelMapRuntime({ runtime, force: true })
            .then((state) => {
                if (alive) setConfig(state.config);
            })
            .catch(() => {
                /* 读不到就保持兜底，不画假地图 */
            });
        return () => {
            alive = false;
        };
    }, [runtime, mapConfig]);

    // 旧左下悬浮球退役：只清它自己的位置记忆，别动用户其它数据。
    useEffect(() => {
        try {
            clearLegacyTravelBallStorage(window.localStorage);
        } catch {
            /* 隐私模式没有 localStorage：无需清理 */
        }
    }, []);

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

    /**
     * 顶部状态条的输入。当前 runtime 的 store 一次只跟一个角色（谁在被轮询就是谁），
     * 所以这里给出一条可信条目；多角色合并由不满足条件的条目被过滤掉自然退化，
     * 换人/合并逻辑在 `TravelActivityIsland` 里已就绪（等 store 支持多角色时直接接上）。
     */
    const islandEntries: TravelIslandEntry[] = useMemo(() => {
        if (!shareVisible) return [];
        const trip = state.view?.code === 'OK' ? state.view.trip : null;
        if (!trip) return [];
        const chars = activeCharId ? characters.filter((c) => c.id === activeCharId) : characters.slice(0, 1);
        return chars.map((char) => ({
            char,
            phase: trip.status,
            destinationLabel: trip.dest?.label ?? null,
            originLabel: trip.origin?.label ?? null,
            // 面板与岛都不编 ETA：契约没有可信到达时间就空着。
            etaMs: null,
            updatedAt: state.confirmedAt || state.receivedAt || null,
            paused: false,
            stale: state.status === 'unconfirmed',
            shareEnabled: state.shareEnabled,
            shareKnown: state.shareKnown,
        }));
    }, [shareVisible, state, characters, activeCharId]);

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

    // 外壳目前没传 callBarActive（PhoneShell 只读），默认放在通话条下沿之外，不压住「点击返回」。
    const islandTop = callBarActive ? 0 : undefined;

    return (
        <>
            <TravelActivityIsland
                entries={islandEntries}
                activeCharId={activeCharId}
                onOpen={(id) => {
                    runtime.overlay.open(id);
                    refreshedFor.current = id;
                    void runtime.refreshShare(id);
                }}
                onSelect={handleSelect}
                callBarActive={callBarActive}
                personaIndicator={personaSim.status === 'loading' || personaSim.status === 'ready'}
                dreamIndicator={dreamSim.status === 'loading' || dreamSim.status === 'ready'}
                offsetPx={islandTop}
            />

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
