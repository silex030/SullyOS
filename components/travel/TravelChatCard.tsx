/**
 * 聊天里的行程卡片（B5）
 *
 * 用于角色在聊天里说「我出门了」时附一张可点开的行程卡：
 * 头像 + 在做什么 + 起点/终点 + ETA + 可选地图缩略图。
 *
 * 隐私与授权（硬约束）：
 * - 缩略图只接受**宿主传入的授权同源服务 URL**（如 `/travel/staticmap?...`，由服务端带
 *   Web 服务 Key 现取现给）。本组件不拼任何高德地址、不接触任何服务 key、不落盘；
 * - 没有缩略图 → 退成纯文字并明写「地图缩略图暂不可用」，只是文字信息，不冒充完整地图；
 * - 共享关闭 → 不渲染；不显示小数坐标、不写 GPS 精度；
 * - ETA 没有可信数据就写「预计到达时间未知」。
 */
import React from 'react';
import { MapTrifold } from '@phosphor-icons/react';
import { TRAVEL_PHASE_COPY, formatEtaLabel } from './TravelMapPanel';
import type { TravelTripStatus } from '../../contracts/travel';

export interface TravelChatCardProps {
    charName: string;
    avatarUrl?: string | null;
    phase: TravelTripStatus;
    originLabel?: string | null;
    destinationLabel?: string | null;
    /** 粗粒度位置名（区/片区），不是坐标。 */
    positionLabel?: string | null;
    etaMs?: number | null;
    paused?: boolean;
    stale?: boolean;
    /** 授权同源服务 URL；缺省或空串 → 文字降级。 */
    mapThumbnailUrl?: string | null;
    shareEnabled: boolean;
    onOpen?: () => void;
    className?: string;
}

const initialOf = (name: string): string => (name || '?').trim().slice(0, 1) || '?';

const chipLabel = (
    phase: TravelTripStatus,
    paused: boolean | undefined,
    stale: boolean | undefined,
): string => {
    if (paused) return '已暂停';
    if (phase === 'expired') return '已过期';
    if (stale) return '未确认';
    return TRAVEL_PHASE_COPY[phase];
};

const TravelChatCard: React.FC<TravelChatCardProps> = ({
    charName,
    avatarUrl = null,
    phase,
    originLabel = null,
    destinationLabel = null,
    positionLabel = null,
    etaMs = null,
    paused = false,
    stale = false,
    mapThumbnailUrl = null,
    shareEnabled,
    onOpen,
    className = '',
}) => {
    if (!shareEnabled) return null;

    const thumbnail = typeof mapThumbnailUrl === 'string' ? mapThumbnailUrl.trim() : '';
    const status = chipLabel(phase, paused, stale);
    const eta = formatEtaLabel(etaMs);

    return (
        <button
            data-testid="travel-card-open"
            onClick={() => onOpen?.()}
            aria-label={`${charName} 的行程，打开行程面板`}
            className={`w-full text-left rounded-[22px] overflow-hidden active:scale-[0.99] transition-transform ${className}`}
            style={{
                background: 'rgba(255,255,255,0.94)',
                border: '1px solid rgba(255,255,255,0.75)',
                boxShadow: '0 6px 20px rgba(15,23,42,0.14)',
            }}
        >
            <div className="flex items-center gap-2 px-2.5 pt-2">
                {avatarUrl ? (
                    <img
                        src={avatarUrl}
                        alt=""
                        draggable={false}
                        className="w-6 h-6 rounded-full object-cover shrink-0"
                    />
                ) : (
                    <span className="w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center text-[10px] font-medium text-slate-600 shrink-0">
                        {initialOf(charName)}
                    </span>
                )}
                <span className="flex-1 min-w-0 text-[11px] font-medium text-slate-700 truncate">
                    {charName} 的行程
                </span>
                <span
                    data-testid="travel-card-status"
                    className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px]"
                    style={{
                        background: paused || stale ? 'rgba(245,158,11,0.16)' : 'rgba(56,189,248,0.14)',
                        color: paused || stale ? '#b45309' : '#0369a1',
                    }}
                >
                    {status}
                </span>
            </div>

            {thumbnail ? (
                <img
                    data-testid="travel-card-thumb"
                    src={thumbnail}
                    alt={`${charName} 的行程地图缩略图`}
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    className="mt-2 w-full h-24 object-cover"
                />
            ) : (
                <div
                    data-testid="travel-card-map-fallback"
                    className="mt-2 mx-2.5 flex items-center gap-1 rounded-xl px-2 py-2"
                    style={{ background: 'rgba(148,163,184,0.12)', border: '1px dashed rgba(148,163,184,0.45)' }}
                >
                    <MapTrifold size={11} weight="bold" className="text-slate-500 shrink-0" aria-hidden />
                    <span className="text-[9px] leading-relaxed text-slate-500">
                        地图缩略图暂不可用 · 仅文字
                    </span>
                </div>
            )}

            <div className="px-2.5 pt-2 pb-2">
                <div className="flex items-center gap-1.5 text-[10px] text-slate-600">
                    <span className="truncate">{originLabel || '起点未知'}</span>
                    <span className="text-slate-300 shrink-0" aria-hidden>
                        →
                    </span>
                    <span className="truncate">{destinationLabel || '目的地还没定'}</span>
                </div>
                <div className="mt-1 flex items-center justify-between text-[9px] text-slate-500">
                    <span className="truncate">
                        {positionLabel ? `现在在 ${positionLabel}` : '位置以行程状态为准'}
                    </span>
                    <span className="shrink-0">{eta}</span>
                </div>
            </div>
        </button>
    );
};

export default TravelChatCard;
