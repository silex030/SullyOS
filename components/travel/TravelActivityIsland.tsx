/**
 * 顶部出行状态条（灵动岛式）
 *
 * 为什么长这样：用户不要左下角悬浮球，改成跟状态栏同一层的一条轻量胶囊——
 * 深色材质 + 细内高光 + 一层柔和外阴影（与 PersonaSim / DreamSim 指示条同族的深玻璃写法，
 * 不引新视觉语言），只在真的在出行时出现，点开还是既有地图面板。
 *
 * 边界：
 * - 纯 props：显隐、文案、ETA 全部由 `utils/travel/activityPresentation` 算好，本组件不读网络；
 * - 多条角色状态合成**一个**顶栏，头像可切人，不叠多个球；
 * - 暂停 / 未确认不出数字；通话时整条让位；生成指示条在显示时往下让行；
 * - 不挡底部触摸导航（只占顶部一行），不放大小数坐标、不写假 GPS 精度。
 */
import React, { useMemo } from 'react';
import { CaretRight } from '@phosphor-icons/react';
import {
    resolveIslandSlides,
    resolveIslandStack,
    type TravelIslandEntry,
    type TravelIslandSlide,
} from '../../utils/travel/activityPresentation';

export interface TravelActivityIslandProps {
    entries: readonly TravelIslandEntry[];
    /** 当前展示谁（多角色时的选中项）；null → 取第一条可见的。 */
    activeCharId?: string | null;
    /** 轻点整条：打开既有行程地图面板（不改任何人的行程）。 */
    onOpen: (charId: string) => void;
    /** 多角色切人：只改「在看谁」。 */
    onSelect?: (charId: string) => void;
    /** 通话条在顶（通话优先级最高）→ 整条不渲染。 */
    callBarActive?: boolean;
    /** 「演出生成中」指示条在显示。 */
    personaIndicator?: boolean;
    /** 「梦正在成形」指示条在显示。 */
    dreamIndicator?: boolean;
    /** 额外让位（宿主已自行算好顶部占用时传；不传按上面的优先级算）。 */
    offsetPx?: number;
    hidden?: boolean;
    className?: string;
}

const initialOf = (name: string): string => (name || '?').trim().slice(0, 1) || '?';

const toneDot: Record<TravelIslandSlide['tone'], string> = {
    ok: '#38bdf8',
    warn: '#f59e0b',
};

const Avatar: React.FC<{ name: string; avatarUrl: string | null; size: number }> = ({ name, avatarUrl, size }) => (
    <span
        className="shrink-0 rounded-full overflow-hidden flex items-center justify-center"
        style={{
            width: size,
            height: size,
            background: 'linear-gradient(165deg, #f8fafc 0%, #dbe3ee 100%)',
            boxShadow: '0 1px 0 rgba(255,255,255,0.55) inset',
        }}
        aria-hidden
    >
        {avatarUrl ? (
            <img src={avatarUrl} alt="" draggable={false} className="w-full h-full object-cover" />
        ) : (
            <span className="text-[9px] font-semibold text-slate-600">{initialOf(name)}</span>
        )}
    </span>
);

const TravelActivityIsland: React.FC<TravelActivityIslandProps> = ({
    entries,
    activeCharId = null,
    onOpen,
    onSelect,
    callBarActive = false,
    personaIndicator = false,
    dreamIndicator = false,
    offsetPx,
    hidden = false,
    className = '',
}) => {
    const slides = useMemo(() => resolveIslandSlides(entries), [entries]);
    const stack = useMemo(
        () => resolveIslandStack({ callBarActive, personaIndicator, dreamIndicator }),
        [callBarActive, personaIndicator, dreamIndicator],
    );

    if (hidden || stack.hidden || slides.length === 0) return null;

    const active = slides.find((s) => s.charId === activeCharId) ?? slides[0]!;
    const multi = slides.length > 1;
    const top = offsetPx ?? stack.offsetPx;
    const statusHint = `${active.name} · ${active.phaseLabel}${active.placeLabel ? ` · ${active.placeLabel}` : ''}${
        active.etaLabel ? ` · ${active.etaLabel}` : ''
    }`;

    return (
        <div
            className={`absolute left-0 right-0 z-[56] flex justify-center px-3 pointer-events-none ${className}`}
            style={{ top }}
            data-testid="travel-island-row"
        >
            <div
                data-testid="travel-island"
                data-stale={active.stale ? 'true' : 'false'}
                data-paused={active.paused ? 'true' : 'false'}
                className="pointer-events-auto flex items-center gap-1 rounded-full pl-1 pr-1.5 py-1 max-w-[min(88vw,340px)] animate-fade-in transition-transform active:scale-[0.98]"
                style={{
                    background: 'linear-gradient(160deg, rgba(30,27,38,0.94) 0%, rgba(16,15,21,0.96) 100%)',
                    border: '1px solid rgba(255,255,255,0.14)',
                    boxShadow:
                        '0 6px 20px rgba(0,0,0,0.32), 0 1px 0 rgba(255,255,255,0.16) inset, 0 -1px 4px rgba(0,0,0,0.22) inset',
                }}
            >
                {multi && (
                    <div className="flex items-center gap-0.5 shrink-0" data-testid="travel-island-switcher">
                        {slides.map((slide) => {
                            const selected = slide.charId === active.charId;
                            return (
                                <button
                                    key={slide.charId}
                                    data-testid="travel-island-switch"
                                    data-selected={selected ? 'true' : 'false'}
                                    onClick={() => onSelect?.(slide.charId)}
                                    aria-pressed={selected}
                                    aria-label={`看 ${slide.name} 的行程`}
                                    className="rounded-full transition-transform active:scale-90"
                                    style={{
                                        padding: 1,
                                        boxShadow: selected ? '0 0 0 1.5px rgba(255,255,255,0.85)' : 'none',
                                        opacity: selected ? 1 : 0.55,
                                    }}
                                >
                                    <Avatar name={slide.name} avatarUrl={slide.avatarUrl} size={16} />
                                </button>
                            );
                        })}
                    </div>
                )}

                <button
                    data-testid="travel-island-open"
                    onClick={() => onOpen(active.charId)}
                    aria-label={`${statusHint}，打开地图`}
                    title="行程 · 轻点看地图"
                    className="min-w-0 flex items-center gap-1.5 pl-0.5 pr-0.5 text-left"
                >
                    {!multi && <Avatar name={active.name} avatarUrl={active.avatarUrl} size={20} />}
                    <span className="shrink-0 text-[11px] font-semibold text-white/92 max-w-[64px] truncate">
                        {active.name}
                    </span>
                    <span className="shrink-0 flex items-center gap-1">
                        <span
                            className="w-1.5 h-1.5 rounded-full"
                            style={{ background: toneDot[active.tone] }}
                            aria-hidden
                        />
                        <span data-testid="travel-island-phase" className="text-[10px] text-white/70 whitespace-nowrap">
                            {active.phaseLabel}
                        </span>
                    </span>
                    {active.placeLabel && (
                        <span
                            data-testid="travel-island-place"
                            className="min-w-0 truncate text-[10px] text-white/55"
                        >
                            {active.placeLabel}
                        </span>
                    )}
                    {active.etaLabel && (
                        <span
                            data-testid="travel-island-eta"
                            className="shrink-0 text-[10px] font-medium text-white/80 whitespace-nowrap"
                        >
                            {active.etaLabel}
                        </span>
                    )}
                    <CaretRight size={10} weight="bold" className="shrink-0 text-white/35" aria-hidden />
                </button>
            </div>
        </div>
    );
};

export default TravelActivityIsland;
