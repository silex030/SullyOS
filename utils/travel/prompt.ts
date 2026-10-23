/**
 * 前端出行数据 · 提示词视图（B4）
 *
 * 给角色的出行注入块。规矩只有三条：
 * 1. **只出地名语义**：小区/公共地点名 + 城市 + 区，绝不出小数坐标、原始 address、
 *    楼栋单元楼层房号（这些由 `privacy.ts` 结构性拦，不靠换行拼接时「记得别写」）；
 * 2. **不编情绪与亲密度**：本模块的入参类型里没有 mood / affinity / 心情分，
 *    也不从出门次数推算「TA 今天心情不错」；角色的感受由角色自己在对话里表达；
 * 3. **没有可信数据就不说**：没有 ETA 就说「还不知道」，没有行程就返回空串 ——
 *    宁可少一段，也不编一个看起来完整的行程。
 */
import type { TravelLatLng } from '../../contracts/travel';
import type { MaskedPlace, TravelTripView, TravelTripProgress } from './core';
import { assertPromptSafe, maskPlaceForPrompt, type LeakReason } from './privacy';

export interface TravelPromptTrip {
    origin: MaskedPlace & { kind?: string };
    dest: (MaskedPlace & { kind?: string }) | null;
    status: TravelTripView['status'];
    departAt?: number | null;
    arriveAt?: number | null;
    dwellUntil?: number | null;
    returnAt?: number | null;
}

export interface TravelPromptInput {
    /** 已脱敏的行程视图；没有行程传 null。 */
    trip?: TravelPromptTrip | null;
    /** 服务端共享位。未知（读失败）按关闭写，不能写成「用户能看到」。 */
    shareEnabled?: boolean;
    shareKnown?: boolean;
    progress?: Pick<TravelTripProgress, 'phase' | 'etaMs'> | null;
    /** 角色原话愿望（已过 sanitizeWishText）。 */
    wishText?: string | null;
    budget?: { mapCallsUsed: number; mapCallsLimit: number } | null;
}

const PHASE_LABEL: Record<string, string> = {
    considering: '还在想',
    planned: '已经定好计划',
    en_route: '正在路上',
    dwelling: '已经到了，在那边待着',
    returning: '正在往回走',
    returned: '已经回到住处',
    stopped: '今天在这边停下了，没回家',
    aborted: '这趟没去成',
    expired: '这趟计划过期了',
    unavailable: '这个地区暂时去不了',
};

const placeText = (place: MaskedPlace | null): string => {
    if (!place) return '';
    const area = [place.city, place.district].filter(Boolean).join('·');
    if (!place.label) return area;
    return area ? `${place.label}（${area}）` : place.label;
};

const etaText = (etaMs: number | null | undefined): string => {
    if (etaMs === null || etaMs === undefined || !Number.isFinite(etaMs)) return '还要多久还不知道';
    const minutes = Math.max(1, Math.round(etaMs / 60_000));
    return `大概还要 ${minutes} 分钟`;
};

/** 只保留地名语义的坐标剥离：调用方误塞 points 也不会进句子。 */
const dropPoints = (points: readonly TravelLatLng[] | undefined): never[] => {
    void points;
    return [];
};

export type TravelPromptResult =
    | { ok: true; text: string }
    | { ok: false; reasons: LeakReason[] };

/**
 * 生成注入块。返回值再过 `assertPromptSafe`：一旦命中坐标/门牌就整段不注入，
 * 并把原因交给调用方记录（不要「删掉那半句继续发」）。
 */
export const buildTravelPromptBlock = (input: TravelPromptInput): TravelPromptResult => {
    const lines: string[] = [];
    const trip = input.trip ?? null;

    if (trip) {
        // 入参里即使混进了坐标字段（points/lat/lng），也在这里被结构性地丢掉。
        dropPoints((trip as { points?: TravelLatLng[] }).points);
        const origin = maskPlaceForPrompt(trip.origin as never);
        const dest = trip.dest ? maskPlaceForPrompt(trip.dest as never) : null;
        const phase = PHASE_LABEL[trip.status] ?? PHASE_LABEL[input.progress?.phase ?? ''] ?? '';

        if (dest) {
            lines.push(`你${phase || '正在出门'}：从${placeText(origin)}去${placeText(dest)}。`);
        } else {
            lines.push(`你${phase || '正在出门'}：从${placeText(origin)}出来随便走走。`);
        }
        if (input.progress?.etaMs !== undefined && input.progress?.phase === 'en_route') {
            lines.push(`路上${etaText(input.progress.etaMs)}。`);
        }
    } else if (input.wishText) {
        const wish = String(input.wishText).trim();
        if (wish) lines.push(`你最近想去：${wish}（还没定地方）。`);
    }

    if (trip || lines.length) {
        if (input.shareEnabled === true && input.shareKnown !== false) {
            lines.push('位置共享：开着。用户能在 SullyOS 的地图上看到你走到哪，这不会改变你的行程。');
        } else {
            lines.push('位置共享：关着（或状态未知）。用户看不到你的地图位置；这不代表你没出门，也不代表你不想出门。');
        }
    }

    if (input.budget && Number.isFinite(input.budget.mapCallsLimit) && Number.isFinite(input.budget.mapCallsUsed)) {
        const left = Math.max(0, input.budget.mapCallsLimit - input.budget.mapCallsUsed);
        lines.push(`（系统自用：今天地图额度还剩 ${left} 次，不要向用户提这个数字。）`);
    }

    const text = lines.join('\n').trim();
    if (!text) return { ok: true, text: '' };
    return assertPromptSafe(text);
};
