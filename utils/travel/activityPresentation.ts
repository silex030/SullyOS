/**
 * 顶部出行状态（灵动岛式）· 纯展示决策
 *
 * 只做「能不能显示、显示哪几个字」这一件事，不碰网络、不碰 React、不推进任何状态。
 * 规则来源（`notes/ethernet-branch-context.md`「位置共享界面」）：
 * - 只有真的在出行（在路上 / 在停留 / 回程）才出现；未出发的「计划出门」「正在想去哪」不冒充；
 * - 终态（已回家 / 在外停下 / 取消 / 过期）与共享关闭、共享未知、读失败一律立刻隐藏；
 * - 过期数据（stale）与暂停（paused）要写明，并且**不给 ETA**——不拿旧数字装实时；
 * - ETA 只认服务端给的可信值，没有就整段不出现，不用距离÷步速凑。
 */
import type { TravelTripStatus } from '../../contracts/travel';

export interface TravelCharacterView {
    id: string;
    name: string;
    /** 头像 URL（可为空 → 用名字首字兜底）。 */
    avatarUrl?: string | null;
}

export interface TravelIslandEntry {
    char: TravelCharacterView;
    phase: TravelTripStatus | null;
    /** 目的地（在路上 / 停留时显示）。 */
    destinationLabel?: string | null;
    /** 起点（回程时显示「回 …」）。 */
    originLabel?: string | null;
    /** 服务端可信 ETA；null = 不给数字。 */
    etaMs?: number | null;
    updatedAt?: number | null;
    /** 共享被暂停（授权边界）：显示但明确「已暂停」，不给 ETA。 */
    paused?: boolean;
    /** 快照没刷新成功：显示但标「未更新」。 */
    stale?: boolean;
    shareEnabled: boolean;
    /** 共享态是否读到可信值（读失败 → 不显示）。 */
    shareKnown: boolean;
}

export type TravelIslandTone = 'ok' | 'warn';

export interface TravelIslandSlide {
    charId: string;
    name: string;
    avatarUrl: string | null;
    phase: TravelTripStatus;
    phaseLabel: string;
    /** 地名短句（可为 null：还没定目的地）。 */
    placeLabel: string | null;
    /** 可信到达时间文案；stale / paused 恒为 null。 */
    etaLabel: string | null;
    tone: TravelIslandTone;
    stale: boolean;
    paused: boolean;
}

/** 只有这三种相位算「真的在出行」。 */
export const ACTIVE_TRAVEL_PHASES: readonly TravelTripStatus[] = ['en_route', 'dwelling', 'returning'];

/** 岛上一行字的相位名（比面板文案更短，面板才是完整口径）。 */
export const ISLAND_PHASE_COPY: Partial<Record<TravelTripStatus, string>> = {
    en_route: '在路上',
    dwelling: '在停留',
    returning: '回程中',
};

export const isActiveTravelPhase = (phase: TravelTripStatus | null | undefined): boolean =>
    !!phase && (ACTIVE_TRAVEL_PHASES as readonly string[]).includes(phase);

/** 地名压成一行短句：去掉括号补充、后续分隔段，超长截断加省略号。 */
export const shortPlaceLabel = (label: string | null | undefined, max = 10): string | null => {
    const raw = String(label ?? '').trim();
    if (!raw) return null;
    const head = raw.split(/[（(·|]/)[0]!.trim() || raw;
    const chars = Array.from(head);
    return chars.length > max ? `${chars.slice(0, max).join('')}…` : head;
};

/** 可信 ETA 文案。没有数就不给（返回 null，调用方不渲染那一段）。 */
export const formatEtaShort = (etaMs: number | null | undefined): string | null => {
    if (typeof etaMs !== 'number' || !Number.isFinite(etaMs) || etaMs < 0) return null;
    if (etaMs <= 0) return '即将到达';
    const minutes = Math.max(1, Math.round(etaMs / 60_000));
    if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        return `约 ${hours} 小时 ${minutes % 60} 分`;
    }
    return `约 ${minutes} 分钟`;
};

/**
 * 把一批角色状态压成「岛上要显示的几行」。顺序固定按传入顺序（宿主决定，例如最近活跃优先），
 * 不做随机排序，避免每次重渲染换人。
 */
export const resolveIslandSlides = (entries: readonly TravelIslandEntry[] | null | undefined): TravelIslandSlide[] => {
    if (!entries || entries.length === 0) return [];
    const out: TravelIslandSlide[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
        if (!entry || !entry.char || !entry.char.id || seen.has(entry.char.id)) continue;
        // 共享是授权边界：未读到可信值、或明确关闭 → 一个字都不显示。
        if (!entry.shareKnown || !entry.shareEnabled) continue;
        // 未出发的计划 / 终态 / 服务商不可用：都不是「正在出行」，不占顶部。
        if (!isActiveTravelPhase(entry.phase)) continue;
        const phase = entry.phase as TravelTripStatus;
        const paused = !!entry.paused;
        const stale = !!entry.stale;
        const placeSource = phase === 'returning' ? entry.originLabel ?? entry.destinationLabel : entry.destinationLabel;
        const place = shortPlaceLabel(placeSource);
        const phaseCopy = ISLAND_PHASE_COPY[phase] ?? null;
        if (!phaseCopy) continue;
        const phaseLabel = paused ? '已暂停' : stale ? `${phaseCopy} · 未更新` : phaseCopy;
        // 暂停 / 未更新时不给 ETA：旧数字看起来像实时，比不显示更糟。
        const etaLabel = paused || stale ? null : formatEtaShort(entry.etaMs);
        seen.add(entry.char.id);
        out.push({
            charId: entry.char.id,
            name: entry.char.name || '?',
            avatarUrl: entry.char.avatarUrl ?? null,
            phase,
            phaseLabel,
            placeLabel: phase === 'returning' && place ? `回 ${place}` : place,
            etaLabel,
            tone: paused || stale ? 'warn' : 'ok',
            stale,
            paused,
        });
    }
    return out;
};

/** 顶部布局基准：状态栏 + 通话条都留在岛的上面，岛自身从这一行往下排。 */
export const ISLAND_BASE_TOP_PX = 56;
/** 每条生成指示条占用的行高（PersonaSim 在 top-12、DreamSim 在 top-24）。 */
export const ISLAND_LADDER_PX = 40;

export interface IslandStackInput {
    /** 通话条在顶（通话优先级最高，岛让位）。 */
    callBarActive?: boolean;
    /** 「演出生成中」指示条在显示。 */
    personaIndicator?: boolean;
    /** 「梦正在成形」指示条在显示。 */
    dreamIndicator?: boolean;
}

export interface IslandStackResult {
    hidden: boolean;
    /** 相对安全区/内容区顶部的像素偏移。 */
    offsetPx: number;
}

/**
 * 优先级：通话 > 生成指示条 > 出行岛。
 * 通话时整条不渲染（不跟通话条抢注意力，也不挡「点击返回」）；
 * 生成指示条在显示时，岛往下让一行，不叠在一起。
 */
export const resolveIslandStack = (input: IslandStackInput = {}): IslandStackResult => {
    if (input.callBarActive) return { hidden: true, offsetPx: 0 };
    const ladder = input.dreamIndicator ? 2 : input.personaIndicator ? 1 : 0;
    return { hidden: false, offsetPx: ISLAND_BASE_TOP_PX + ladder * ISLAND_LADDER_PX };
};

/** 旧左下悬浮球的位置记忆键：球已退役，只清这一把，不动用户其它数据。 */
export const LEGACY_TRAVEL_BALL_STORAGE_KEY = 'travel.ball.pos.v1';

export const clearLegacyTravelBallStorage = (
    storage: Pick<Storage, 'removeItem'> | null | undefined,
): boolean => {
    if (!storage) return false;
    try {
        storage.removeItem(LEGACY_TRAVEL_BALL_STORAGE_KEY);
        return true;
    } catch {
        return false;
    }
};
