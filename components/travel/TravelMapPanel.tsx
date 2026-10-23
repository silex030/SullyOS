/**
 * 行程地图面板（B5）
 *
 * 结构：顶部「在看谁」（单角色一行字 / 多角色可切换的圆片）→ 状态条 → 真地图 →
 * 底部轻拟物地点卡 → 一行「这是模拟行程」的说明。
 *
 * 边界（与 `docs/travel-contract.md` §5/§7 对齐）：
 * - 面板只是「看」，没有推进、改目的地、给角色改心情的入口——人格与出行由角色自己决定；
 * - 暂停 / 过期 / 未确认各有明确文案；ETA 没有可信数据就写「未知」，不用距离÷速度编；
 * - 不显示小数坐标、不写「精度 ±N 米」这类假 GPS 话术；
 * - `open === false` 或共享关闭 → 整块不渲染（地图实例随 canvas 卸载销毁，内容不外露）。
 */
import React from 'react';
import { ArrowsClockwise, MapTrifold, X } from '@phosphor-icons/react';
import TravelMapCanvas, { type TravelMapAdapter } from './TravelMapCanvas';
import type { TravelCharacterView } from './TravelBall';
import type {
    TravelCoordSys,
    TravelErrorCode,
    TravelLatLng,
    TravelTripStatus,
} from '../../contracts/travel';

export interface TravelPanelPlace {
    label: string;
    city?: string;
    district?: string;
}

export interface TravelPanelView {
    phase: TravelTripStatus;
    origin: TravelPanelPlace | null;
    destination: TravelPanelPlace | null;
    /** 角色当前模拟位置（没有可信位置就 null，不拿城市中心顶）。 */
    position?: TravelLatLng | null;
    routePoints?: readonly TravelLatLng[] | null;
    distanceM?: number | null;
    etaMs?: number | null;
    updatedAt?: number | null;
    paused?: boolean;
    /** 快照没刷新成功（离线 / 请求失败）：显示最后快照并标注未确认。 */
    stale?: boolean;
}

export type TravelStatusTone = 'ok' | 'muted' | 'warn';

export interface TravelPanelStatus {
    title: string;
    detail: string | null;
    tone: TravelStatusTone;
}

export const TRAVEL_PHASE_COPY: Record<TravelTripStatus, string> = {
    considering: '正在想去哪',
    planned: '计划出门',
    en_route: '在路上',
    dwelling: '在目的地停留',
    returning: '正在回家',
    returned: '已回家',
    // 闲逛在外正常结束：不是「已回家」，也不说「行程取消」。
    stopped: '在外停下了',
    aborted: '行程已取消',
    expired: '已过期',
    unavailable: '该地区暂不支持路线规划',
};

/** 契约 §5 固定的面向用户文案，不临时造新错误码。 */
export const TRAVEL_ERROR_COPY: Record<TravelErrorCode, string> = {
    UNAUTHORIZED: '登录状态已失效，重新登录后再看 TA 的行程',
    INVALID_CLIENT_TOKEN: '客户端口令不正确',
    PRINCIPAL_MISMATCH: '身份信息不一致，已拒绝本次请求',
    SHARE_REVOKED: '位置共享已关闭，看不到 TA 现在在哪',
    UNKNOWN_CANDIDATE: '这个地点候选已失效，让 TA 重新选一次',
    WISH_EXPIRED: '这次的想法已经过期了',
    INVALID_FIELD: '有一项填写格式不对，请检查后再保存',
    PROVIDER_UNSUPPORTED_REGION: '该地区暂不支持路线规划',
    PROVIDER_FAILED: '地图服务暂时不可用，TA 的愿望还留着，稍后重试',
    BUDGET_BLOCKED: '今天的出行额度已用完或已暂停',
    BUDGET_ZERO: '出行额度为 0，需要你在设置里调整',
    VERSION_CONFLICT: '状态已被其他设备更新，刷新后再试',
    ANCHOR_NOT_CONFIRMED: '先在设置里确认住处或常去地点，TA 才能出门',
    ROUTE_UNAVAILABLE: '暂时拿不到路线，位置未知',
    GEOMETRY_NOT_LICENSED: '地图路线暂不可用（未配置授权）',
    RETENTION_EXPIRED: '这段行程已超出保留期',
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 「最后更新 HH:mm」；跨天补 MM-DD。null = 没有可用时间，调用方自行兜底。 */
export const formatUpdatedAt = (updatedAt: number | null | undefined, now: number = Date.now()): string | null => {
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0) return null;
    const at = new Date(updatedAt);
    const ref = new Date(Number.isFinite(now) ? now : Date.now());
    const clock = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
    const sameDay =
        at.getFullYear() === ref.getFullYear() && at.getMonth() === ref.getMonth() && at.getDate() === ref.getDate();
    return sameDay
        ? `最后更新 ${clock}`
        : `最后更新 ${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${clock}`;
};

/**
 * ETA 文案。没有可信到达时间就明写「未知」——不拿步速或直线距离凑一个数字出来。
 */
export const formatEtaLabel = (etaMs: number | null | undefined): string => {
    if (typeof etaMs !== 'number' || !Number.isFinite(etaMs)) return '预计到达时间未知';
    if (etaMs <= 0) return '即将到达';
    const minutes = Math.max(1, Math.round(etaMs / 60_000));
    return `约 ${minutes} 分钟`;
};

export const formatDistanceLabel = (distanceM: number | null | undefined): string => {
    if (typeof distanceM !== 'number' || !Number.isFinite(distanceM) || distanceM <= 0) return '距离未知';
    if (distanceM < 1000) return `约 ${Math.round(distanceM)} 米`;
    return `约 ${(distanceM / 1000).toFixed(1)} 公里`;
};

/**
 * 状态汇总。优先级刻意是「暂停 > 过期 > 未确认 > 过程相位」：
 * 暂停是授权边界，过期是终态，未确认代表数据可能旧了，都不能被「看起来在走」盖住。
 */
export const resolvePanelStatus = (
    view: TravelPanelView,
    now: number = Date.now(),
): TravelPanelStatus => {
    if (view.paused) {
        return { title: '已暂停', detail: '未确认 · 暂停期间不会推进位置', tone: 'warn' };
    }
    if (view.phase === 'expired') {
        return { title: '已过期', detail: '这段行程已超出保留期', tone: 'muted' };
    }
    if (view.stale) {
        return { title: '未确认行程', detail: formatUpdatedAt(view.updatedAt, now) ?? '最后更新未知', tone: 'warn' };
    }
    if (view.phase === 'unavailable') {
        return { title: TRAVEL_PHASE_COPY.unavailable, detail: '接入后同一个想法还能再试', tone: 'muted' };
    }
    if (view.phase === 'en_route' || view.phase === 'returning') {
        return {
            title: TRAVEL_PHASE_COPY[view.phase],
            detail: `${formatEtaLabel(view.etaMs)} · ${formatUpdatedAt(view.updatedAt, now) ?? '最后更新未知'}`,
            tone: 'ok',
        };
    }
    if (view.phase === 'returned' || view.phase === 'aborted' || view.phase === 'stopped') {
        return { title: TRAVEL_PHASE_COPY[view.phase], detail: null, tone: 'muted' };
    }
    return {
        title: TRAVEL_PHASE_COPY[view.phase],
        detail: formatUpdatedAt(view.updatedAt, now) ?? '最后更新未知',
        tone: 'ok',
    };
};

const toneStyle: Record<TravelStatusTone, { bg: string; text: string }> = {
    ok: { bg: 'rgba(56,189,248,0.14)', text: '#0369a1' },
    muted: { bg: 'rgba(148,163,184,0.18)', text: '#475569' },
    warn: { bg: 'rgba(245,158,11,0.16)', text: '#b45309' },
};

export interface TravelMapPanelProps {
    open: boolean;
    characters: readonly TravelCharacterView[];
    activeCharId?: string | null;
    /** 一次只展示一个角色的行程；切换由宿主决定（角色自己不会因此改变计划）。 */
    view: TravelPanelView | null;
    shareEnabled: boolean;
    loading?: boolean;
    errorCode?: TravelErrorCode | null;
    now?: number;
    coordSys?: TravelCoordSys;
    amapJsKey?: string | null;
    amapServiceHost?: string | null;
    licensedGeometry?: boolean;
    adapter?: TravelMapAdapter | null;
    onClose: () => void;
    onSelectCharacter?: (charId: string) => void;
    onRetry?: () => void;
    className?: string;
}

const initialOf = (name: string): string => (name || '?').trim().slice(0, 1) || '?';

const TravelMapPanel: React.FC<TravelMapPanelProps> = ({
    open,
    characters,
    activeCharId,
    view,
    shareEnabled,
    loading = false,
    errorCode = null,
    now = Date.now(),
    coordSys = 'gcj02',
    amapJsKey = null,
    amapServiceHost = null,
    licensedGeometry = false,
    adapter = null,
    onClose,
    onSelectCharacter,
    onRetry,
    className = '',
}) => {
    if (!open || !shareEnabled || characters.length === 0) return null;

    const active = characters.find((c) => c.id === activeCharId) ?? characters[0]!;
    const status = view ? resolvePanelStatus(view, now) : null;
    const tone = toneStyle[status?.tone ?? 'muted'];

    return (
        <div className={`absolute inset-0 z-[70] flex flex-col justify-end ${className}`} data-testid="travel-map-panel">
            <div
                className="absolute inset-0 bg-black/35 backdrop-blur-sm animate-fade-soft"
                onClick={onClose}
                aria-hidden
            />
            <div
                role="dialog"
                aria-modal="true"
                aria-label={`${active.name} 的行程`}
                className="relative mx-1 mb-1 rounded-3xl overflow-hidden animate-slide-up"
                style={{
                    background: 'rgba(255,255,255,0.94)',
                    backdropFilter: 'blur(24px) saturate(1.4)',
                    WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
                    border: '1px solid rgba(255,255,255,0.65)',
                    boxShadow: '0 12px 40px rgba(15,23,42,0.22)',
                }}
            >
                {/* 顶部：在看谁（多角色可切换） */}
                <div className="flex items-start gap-2 px-3 pt-3">
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                            <MapTrifold size={13} weight="bold" className="text-slate-500" aria-hidden />
                            <span className="text-[13px] font-medium text-slate-800 truncate">
                                {active.name} 的行程
                            </span>
                        </div>
                        {status && (
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                <span
                                    data-testid="travel-panel-status"
                                    className="px-1.5 py-0.5 rounded-full text-[9px] font-medium"
                                    style={{ background: tone.bg, color: tone.text }}
                                >
                                    {status.title}
                                </span>
                                {status.detail && (
                                    <span className="text-[9px] text-slate-500 truncate">{status.detail}</span>
                                )}
                            </div>
                        )}
                    </div>
                    <button
                        data-testid="travel-panel-close"
                        onClick={onClose}
                        aria-label="关闭行程面板"
                        className="p-1.5 rounded-full text-slate-500 active:scale-90 transition-transform"
                        style={{ background: 'rgba(148,163,184,0.16)' }}
                    >
                        <X size={13} weight="bold" />
                    </button>
                </div>

                {characters.length > 1 && (
                    <div
                        data-testid="travel-panel-char-switch"
                        className="mt-2 px-3 flex items-center gap-1.5 overflow-x-auto no-scrollbar"
                    >
                        {characters.map((char) => {
                            const selected = char.id === active.id;
                            return (
                                <button
                                    key={char.id}
                                    onClick={() => onSelectCharacter?.(char.id)}
                                    aria-pressed={selected}
                                    className={`shrink-0 flex items-center gap-1 pl-0.5 pr-2 py-0.5 rounded-full text-[10px] transition-all duration-200 ${
                                        selected ? 'text-slate-800' : 'text-slate-500'
                                    }`}
                                    style={{
                                        background: selected ? 'rgba(255,255,255,0.98)' : 'rgba(255,255,255,0.55)',
                                        border: selected ? '1px solid rgba(148,163,184,0.45)' : '1px solid rgba(255,255,255,0.6)',
                                        boxShadow: selected ? '0 1px 4px rgba(15,23,42,0.10)' : 'none',
                                    }}
                                >
                                    {char.avatarUrl ? (
                                        <img
                                            src={char.avatarUrl}
                                            alt=""
                                            draggable={false}
                                            className="w-4 h-4 rounded-full object-cover"
                                        />
                                    ) : (
                                        <span className="w-4 h-4 rounded-full bg-slate-200 flex items-center justify-center text-[8px] font-medium text-slate-600">
                                            {initialOf(char.name)}
                                        </span>
                                    )}
                                    <span className="max-w-[64px] truncate">{char.name}</span>
                                </button>
                            );
                        })}
                    </div>
                )}

                {/* 地图：只有拿到可信位置才画；关闭面板整块卸载 */}
                {loading ? (
                    <div data-testid="travel-panel-loading" className="px-3">
                        <div className="flex items-center justify-center gap-1 py-10">
                            {[0, 1, 2].map((i) => (
                                <span
                                    key={i}
                                    className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-pulse"
                                    style={{ animationDelay: `${i * 0.2}s` }}
                                />
                            ))}
                        </div>
                        <div className="pb-4 text-center text-[10px] text-slate-500">正在读取行程</div>
                    </div>
                ) : (
                    <>
                        {errorCode && (
                            <div
                                data-testid="travel-panel-error"
                                className="mx-3 mt-2 flex items-center gap-2 rounded-2xl px-2.5 py-2"
                                style={{ background: 'rgba(254,243,199,0.85)', border: '1px solid rgba(245,158,11,0.35)' }}
                            >
                                <span className="flex-1 text-[10px] leading-relaxed text-amber-700">
                                    {TRAVEL_ERROR_COPY[errorCode]}
                                </span>
                                <button
                                    data-testid="travel-panel-retry"
                                    onClick={() => onRetry?.()}
                                    aria-label="重新读取行程"
                                    className="shrink-0 flex items-center gap-0.5 px-1.5 py-1 rounded-full text-[9px] font-medium text-amber-800 active:scale-95 transition-transform"
                                    style={{ background: 'rgba(255,255,255,0.9)' }}
                                >
                                    <ArrowsClockwise size={10} weight="bold" aria-hidden />
                                    重试
                                </button>
                            </div>
                        )}

                        <div className="mt-2 px-3">
                            <TravelMapCanvas
                                className="h-52"
                                center={view?.position ?? null}
                                position={view?.position ?? null}
                                routePoints={view?.routePoints ?? null}
                                licensedGeometry={licensedGeometry}
                                coordSys={coordSys}
                                avatarUrl={active.avatarUrl ?? null}
                                charName={active.name}
                                amapJsKey={amapJsKey}
                                amapServiceHost={amapServiceHost}
                                adapter={adapter}
                                interactive
                            />
                        </div>

                        {/* 底部轻拟物地点卡：实心材质 + 细描边 + 一层软阴影，不是玻璃 */}
                        <div className="px-3 pt-2 pb-1">
                            <div
                                data-testid="travel-place-card"
                                className="rounded-2xl px-3 py-2.5 shadow-sm"
                                style={{
                                    background: 'linear-gradient(180deg, #ffffff 0%, #fbfcfe 100%)',
                                    border: '1px solid rgba(226,232,240,0.9)',
                                    boxShadow:
                                        '0 2px 10px rgba(15,23,42,0.08), 0 1px 0 rgba(255,255,255,0.9) inset',
                                }}
                            >
                                <div className="flex items-center gap-2">
                                    <span className="w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0" aria-hidden />
                                    <span className="text-[11px] text-slate-700 truncate">
                                        {view?.origin ? view.origin.label : '起点未知'}
                                    </span>
                                    {view?.origin?.district && (
                                        <span className="text-[9px] text-slate-500 shrink-0">{view.origin.district}</span>
                                    )}
                                </div>
                                <div className="ml-[2.5px] my-1 h-3 border-l border-dashed border-slate-200" aria-hidden />
                                <div className="flex items-center gap-2">
                                    <span className="w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0" aria-hidden />
                                    <span className="text-[11px] text-slate-700 truncate">
                                        {view?.destination ? view.destination.label : '目的地还没定'}
                                    </span>
                                    {view?.destination?.district && (
                                        <span className="text-[9px] text-slate-500 shrink-0">
                                            {view.destination.district}
                                        </span>
                                    )}
                                </div>
                                <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-500">
                                    <span>{formatDistanceLabel(view?.distanceM)}</span>
                                    <span>{formatEtaLabel(view?.etaMs)}</span>
                                </div>
                            </div>
                        </div>

                        {!view && !errorCode && (
                            <div className="px-3 pb-1 text-center text-[10px] text-slate-500">暂无进行中的行程</div>
                        )}

                        <div className="px-3 pb-2.5 pt-1 text-center text-[9px] leading-relaxed text-slate-500">
                            这是角色的模拟行程，来自行程状态而不是设备定位
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default TravelMapPanel;
