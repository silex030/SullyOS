import { describe, expect, it } from 'vitest';
import {
    ISLAND_BASE_TOP_PX,
    ISLAND_LADDER_PX,
    LEGACY_TRAVEL_BALL_STORAGE_KEY,
    clearLegacyTravelBallStorage,
    formatEtaShort,
    isActiveTravelPhase,
    resolveIslandSlides,
    resolveIslandStack,
    shortPlaceLabel,
    type TravelIslandEntry,
} from './activityPresentation';

const char = (id: string, name: string, avatarUrl: string | null = null) => ({ id, name, avatarUrl });

const entry = (patch: Partial<TravelIslandEntry> = {}): TravelIslandEntry => ({
    char: char('c1', '小满'),
    phase: 'en_route',
    destinationLabel: '西湖文化广场',
    originLabel: '阳光花园',
    etaMs: 12 * 60_000,
    shareEnabled: true,
    shareKnown: true,
    ...patch,
});

describe('activityPresentation · 相位与文案', () => {
    it('只有在路上/停留/回程算在出行，未出发的计划和终态都不算', () => {
        expect(isActiveTravelPhase('en_route')).toBe(true);
        expect(isActiveTravelPhase('dwelling')).toBe(true);
        expect(isActiveTravelPhase('returning')).toBe(true);
        expect(isActiveTravelPhase('planned')).toBe(false);
        expect(isActiveTravelPhase('considering')).toBe(false);
        expect(isActiveTravelPhase('returned')).toBe(false);
        expect(isActiveTravelPhase('stopped')).toBe(false);
        expect(isActiveTravelPhase(null)).toBe(false);
    });

    it('地名压成一行短句，超长截断；没有地名就是 null', () => {
        expect(shortPlaceLabel('西湖文化广场')).toBe('西湖文化广场');
        expect(shortPlaceLabel('  阳光花园（北门） ')).toBe('阳光花园');
        expect(shortPlaceLabel('')).toBeNull();
        expect(shortPlaceLabel(null)).toBeNull();
        expect(shortPlaceLabel('一个特别特别长的地名广场东侧入口')).toBe('一个特别特别长的地名…');
    });

    it('ETA 只认可信数字，缺失不编', () => {
        expect(formatEtaShort(12 * 60_000)).toBe('约 12 分钟');
        expect(formatEtaShort(0)).toBe('即将到达');
        expect(formatEtaShort(null)).toBeNull();
        expect(formatEtaShort(Number.NaN)).toBeNull();
        expect(formatEtaShort(-1)).toBeNull();
        expect(formatEtaShort(95 * 60_000)).toBe('约 1 小时 35 分');
    });
});

describe('activityPresentation · 显示矩阵', () => {
    it('共享关闭 / 共享未知 / 没数据 → 一个都不显示', () => {
        expect(resolveIslandSlides([])).toEqual([]);
        expect(resolveIslandSlides(null)).toEqual([]);
        expect(resolveIslandSlides([entry({ shareEnabled: false })])).toEqual([]);
        expect(resolveIslandSlides([entry({ shareKnown: false })])).toEqual([]);
    });

    it('未出发的计划与所有终态都不显示（不冒充在出行）', () => {
        const phases = ['considering', 'planned', 'returned', 'stopped', 'aborted', 'expired', 'unavailable'] as const;
        for (const phase of phases) {
            expect(resolveIslandSlides([entry({ phase })])).toEqual([]);
        }
    });

    it('在路上：给角色名、相位、目的地和可信 ETA', () => {
        const [slide] = resolveIslandSlides([entry()]);
        expect(slide).toMatchObject({
            charId: 'c1',
            name: '小满',
            phaseLabel: '在路上',
            placeLabel: '西湖文化广场',
            etaLabel: '约 12 分钟',
            tone: 'ok',
        });
    });

    it('回程显示「回 起点」而不是目的地', () => {
        const [slide] = resolveIslandSlides([entry({ phase: 'returning' })]);
        expect(slide.phaseLabel).toBe('回程中');
        expect(slide.placeLabel).toBe('回 阳光花园');
    });

    it('未确认快照：明确标「未更新」并且不给 ETA', () => {
        const [slide] = resolveIslandSlides([entry({ stale: true })]);
        expect(slide.phaseLabel).toBe('在路上 · 未更新');
        expect(slide.stale).toBe(true);
        expect(slide.etaLabel).toBeNull();
        expect(slide.tone).toBe('warn');
        expect(slide.placeLabel).toBe('西湖文化广场');
    });

    it('暂停：写「已暂停」并清掉 ETA，不装实时', () => {
        const [slide] = resolveIslandSlides([entry({ paused: true, stale: true })]);
        expect(slide.phaseLabel).toBe('已暂停');
        expect(slide.paused).toBe(true);
        expect(slide.etaLabel).toBeNull();
        expect(slide.tone).toBe('warn');
    });

    it('没有可信 ETA 时整段不出现', () => {
        const [slide] = resolveIslandSlides([entry({ etaMs: null })]);
        expect(slide.etaLabel).toBeNull();
        expect(slide.placeLabel).toBe('西湖文化广场');
    });

    it('多角色按传入顺序合并，跳过不满足条件的、去重', () => {
        const slides = resolveIslandSlides([
            entry({ char: char('c1', '小满') }),
            entry({ char: char('c2', '阿岚'), phase: 'planned' }),
            entry({ char: char('c3', '林岸'), phase: 'dwelling', destinationLabel: '单向空间' }),
            entry({ char: char('c1', '小满') }),
        ]);
        expect(slides.map((s) => s.charId)).toEqual(['c1', 'c3']);
        expect(slides[1]!.phaseLabel).toBe('在停留');
    });
});

describe('activityPresentation · 顶部优先级', () => {
    it('通话时整条隐藏（通话优先级最高）', () => {
        expect(resolveIslandStack({ callBarActive: true })).toEqual({ hidden: true, offsetPx: 0 });
    });

    it('生成指示条在显示时往下让行，不让两条叠在一起', () => {
        expect(resolveIslandStack({}).offsetPx).toBe(ISLAND_BASE_TOP_PX);
        expect(resolveIslandStack({ personaIndicator: true }).offsetPx).toBe(ISLAND_BASE_TOP_PX + ISLAND_LADDER_PX);
        expect(resolveIslandStack({ dreamIndicator: true }).offsetPx).toBe(ISLAND_BASE_TOP_PX + 2 * ISLAND_LADDER_PX);
        expect(resolveIslandStack({}).hidden).toBe(false);
    });
});

describe('activityPresentation · 旧悬浮球清理', () => {
    it('只删旧球位置键，不动其它 localStorage', () => {
        const store = new Map<string, string>([
            [LEGACY_TRAVEL_BALL_STORAGE_KEY, '{"x":12,"y":480}'],
            ['sully-other', 'keep-me'],
        ]);
        const storage = {
            removeItem: (key: string) => void store.delete(key),
        };
        expect(clearLegacyTravelBallStorage(storage)).toBe(true);
        expect(store.has(LEGACY_TRAVEL_BALL_STORAGE_KEY)).toBe(false);
        expect(store.get('sully-other')).toBe('keep-me');
        expect(LEGACY_TRAVEL_BALL_STORAGE_KEY).toBe('travel.ball.pos.v1');
    });

    it('没有 storage 或写失败时不抛错', () => {
        expect(clearLegacyTravelBallStorage(null)).toBe(false);
        expect(
            clearLegacyTravelBallStorage({
                removeItem: () => {
                    throw new Error('quota');
                },
            }),
        ).toBe(false);
    });
});
