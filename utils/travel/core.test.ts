/**
 * 角色自主出行 · 共享契约纯逻辑（B0 批次）
 *
 * 这批只测「不碰 IO 的规则」：状态机、沿折线距离插值、脱敏白名单、
 * 主体绑定、预算 0/缺省语义、撤销共享快照。存储、provider、UI 不在本批。
 */
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_BUDGET_TZ,
    MAX_CANDIDATES,
    TRAVEL_ERROR_CODES,
    TRAVEL_RETENTION_DEFAULTS,
    TRAVEL_SCHEMA_SQL,
    type TravelBudgetState,
    type TravelPlaceAnchor,
    type TravelShareState,
    type TravelTrip,
} from '../../contracts/travel';
import {
    canChangePlan,
    canTransition,
    clampCandidates,
    dayKey,
    isTerminalStatus,
    maskPlace,
    pickAnchorFields,
    positionAt,
    redactSharedSnapshot,
    resolveBudgetGate,
    resolvePrincipal,
    resolveWishOutcome,
    routeDistanceMeters,
    sanitizeAnchorLabel,
    sanitizeWishText,
    tripProgress,
} from './core';

const trip = (over: Partial<TravelTrip> = {}): TravelTrip => ({
    id: 'trip_1',
    userId: 'u_1',
    charId: 'c_1',
    status: 'planned',
    planVersion: 1,
    revision: 1,
    coordSys: 'gcj02',
    provider: 'amap',
    origin: { label: '阳光花园', city: '杭州', district: '西湖区', lat: 30.26, lng: 120.13, kind: 'home' },
    dest: { label: '西湖公园', city: '杭州', district: '西湖区', lat: 30.25, lng: 120.15, kind: 'public' },
    departAt: 1_000,
    arriveAt: 2_000,
    dwellUntil: 3_000,
    returnAt: 4_000,
    ...over,
});

// 三段等距折线：沿经线每段约 111m（0.001° ≈ 111.19m）
const line = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 0.001 },
    { lat: 0, lng: 0.002 },
];

describe('行程状态机', () => {
    it('只允许正向推进与显式中止', () => {
        expect(canTransition('planned', 'en_route')).toBe(true);
        expect(canTransition('en_route', 'dwelling')).toBe(true);
        expect(canTransition('dwelling', 'returning')).toBe(true);
        expect(canTransition('returning', 'returned')).toBe(true);
        expect(canTransition('en_route', 'aborted')).toBe(true);
        expect(canTransition('considering', 'planned')).toBe(true);
    });

    it('终态不能再被推进，也不能回到出行中', () => {
        for (const s of ['returned', 'aborted', 'expired'] as const) {
            expect(isTerminalStatus(s)).toBe(true);
            expect(canTransition(s, 'en_route')).toBe(false);
            expect(canTransition(s, 'planned')).toBe(false);
            expect(canChangePlan(s)).toBe(false);
        }
        expect(isTerminalStatus('unavailable')).toBe(false);
    });

    it('改计划允许在任何非终态发生，但必须走新代而不是原地改', () => {
        for (const s of ['considering', 'planned', 'en_route', 'dwelling', 'returning'] as const) {
            expect(canChangePlan(s)).toBe(true);
        }
    });
});

describe('positionAt 沿折线按距离插值', () => {
    it('端点与中点落在折线顶点上', () => {
        expect(positionAt(line, 0)).toEqual({ lat: 0, lng: 0 });
        const mid = positionAt(line, 0.5)!;
        expect(mid.lat).toBeCloseTo(0, 9);
        expect(mid.lng).toBeCloseTo(0.001, 9);
        const end = positionAt(line, 1)!;
        expect(end.lat).toBeCloseTo(0, 9);
        expect(end.lng).toBeCloseTo(0.002, 9);
    });

    it('按累计距离插值，不是按顶点序号', () => {
        // 不等长两段：0 → 0.0002 → 0.001（第一段短很多），ratio 0.5 应落在第二段起点之前
        const uneven = [
            { lat: 0, lng: 0 },
            { lat: 0, lng: 0.0002 },
            { lat: 0, lng: 0.001 },
        ];
        const p = positionAt(uneven, 0.5)!;
        // 总长 0.001°，半程 0.0005°，落在第二段中间
        expect(p.lng).toBeGreaterThan(0.0002);
        expect(p.lng).toBeCloseTo(0.0005, 6);
    });

    it('ratio 越界被夹紧，退化折线不产生 NaN', () => {
        expect(positionAt(line, -1)).toEqual({ lat: 0, lng: 0 });
        expect(positionAt(line, 9)!.lng).toBeCloseTo(0.002, 9);
        expect(positionAt([{ lat: 1, lng: 2 }], 0.5)).toEqual({ lat: 1, lng: 2 });
        const dup = positionAt([{ lat: 1, lng: 2 }, { lat: 1, lng: 2 }], 0.5)!;
        expect(Number.isFinite(dup.lat)).toBe(true);
        expect(Number.isFinite(dup.lng)).toBe(true);
    });

    it('空折线返回 null（无几何就不给点，不编造）', () => {
        expect(positionAt([], 0.5)).toBeNull();
        expect(routeDistanceMeters([])).toBe(0);
    });

    it('幂等：同一 ratio 两次调用全等', () => {
        const a = positionAt(line, 0.37);
        const b = positionAt(line, 0.37);
        expect(a).toEqual(b);
    });
});

describe('tripProgress 只在有时间依据时给 ETA', () => {
    it('按 depart/arrive/dwell/return 推阶段', () => {
        expect(tripProgress(trip(), 500).phase).toBe('planned');
        expect(tripProgress(trip(), 1_500).phase).toBe('en_route');
        expect(tripProgress(trip(), 2_500).phase).toBe('dwelling');
        expect(tripProgress(trip(), 3_500).phase).toBe('returning');
        expect(tripProgress(trip(), 4_500).phase).toBe('returned');
    });

    it('出行中给剩余毫秒，缺失时间戳给 null 而不是 0 或估算', () => {
        expect(tripProgress(trip(), 1_500).etaMs).toBe(500);
        const noArrive = tripProgress(trip({ arriveAt: null }), 1_500);
        expect(noArrive.etaMs).toBeNull();
        expect(noArrive.phase).toBe('en_route');
    });

    it('往返两段比例各自 0..1，用于独立插值', () => {
        expect(tripProgress(trip(), 1_500).outboundRatio).toBeCloseTo(0.5, 6);
        expect(tripProgress(trip(), 3_500).returnRatio).toBeCloseTo(0.5, 6);
        expect(tripProgress(trip(), 500).outboundRatio).toBe(0);
    });
});

describe('地址与提示词脱敏（结构性白名单，不靠宽泛正则）', () => {
    it('maskPlace 只输出地名/城市/区，坐标与门牌一律不出', () => {
        const out = maskPlace({
            label: '中山路100号的商店',
            city: '杭州',
            district: '上城区',
            address: '中山路100号3栋2单元501室',
            lat: 30.1234567,
            lng: 120.7654321,
        });
        expect(out.label).toBe('中山路100号的商店');
        expect(out.city).toBe('杭州');
        expect(out.district).toBe('上城区');
        expect(Object.keys(out).sort()).toEqual(['city', 'district', 'label']);
        expect(JSON.stringify(out)).not.toMatch(/\d+\.\d{3,}/);
        expect(JSON.stringify(out)).not.toMatch(/栋|单元|室/);
    });

    it('公共地点名原样保留：中山路100号 / 3号门 不被误杀', () => {
        for (const ok of ['中山路100号', 'XX社区3号门', '阳光花园', '中山路100号的商店']) {
            const r = sanitizeAnchorLabel(ok);
            expect(r.ok, ok).toBe(true);
            if (r.ok) expect(r.label).toBe(ok);
        }
    });

    it('住户级组合被拒，文案指回小区/公共地点名', () => {
        for (const bad of ['3栋2单元501', '阳光花园5号楼2单元', '人民路8号3室', '翠苑一区12幢1单元102房', '某小区8号门牌']) {
            const r = sanitizeAnchorLabel(bad);
            expect(r.ok, bad).toBe(false);
            if (!r.ok) {
                expect(r.code).toBe('HOUSEHOLD_DETAIL');
                expect(r.message).toContain('小区');
            }
        }
    });

    it('锚点落库只走 pickAnchorFields 白名单，结构上没有 address', () => {
        const anchor = pickAnchorFields(
            {
                name: '阳光花园',
                city: '杭州',
                district: '西湖区',
                address: '阳光花园5号楼2单元',
                lat: 30.26,
                lng: 120.13,
                coordSys: 'gcj02',
            },
            1_700_000_000_000,
        );
        expect(anchor).not.toBeNull();
        const a = anchor as TravelPlaceAnchor;
        expect(a.label).toBe('阳光花园');
        expect(a.precision).toBe('area');
        expect(a.source).toBe('user');
        expect(a.coordSys).toBe('gcj02');
        expect('address' in a).toBe(false);
        expect('adcode' in a).toBe(false);
    });

    it('缺 coordSys 或住户级地址的 POI 不进锚点', () => {
        expect(pickAnchorFields({ name: '阳光花园', city: '杭州', lat: 30.26, lng: 120.13 }, 1)).toBeNull();
        expect(pickAnchorFields({ name: '3栋2单元501', city: '杭州', lat: 30.26, lng: 120.13, coordSys: 'gcj02' }, 1)).toBeNull();
    });

    it('愿望文本过同一道闸：拒坐标、拒门牌，保留自然语言', () => {
        expect(sanitizeWishText('想去公园坐一会儿').ok).toBe(true);
        const named = sanitizeWishText('想去中山路100号的商店逛逛');
        expect(named.ok).toBe(true);
        if (named.ok) expect(named.text).toBe('想去中山路100号的商店逛逛');

        expect(sanitizeWishText('去 30.1234,120.5678').ok).toBe(false);
        expect(sanitizeWishText('回阳光花园5号楼2单元').ok).toBe(false);
        expect(sanitizeWishText('   ').ok).toBe(false);
    });
});

describe('用户身份只来自已验证主体', () => {
    it('没有主体授权一律拒绝，自报头不算身份', () => {
        expect(resolvePrincipal({ principalUserId: null, headerUserId: 'u_1' })).toEqual({
            ok: false,
            code: 'UNAUTHORIZED',
        });
        expect(resolvePrincipal({ principalUserId: '', headerUserId: null })).toEqual({
            ok: false,
            code: 'UNAUTHORIZED',
        });
    });

    it('自报头与主体不一致 → PRINCIPAL_MISMATCH，不偷偷用头值', () => {
        expect(resolvePrincipal({ principalUserId: 'u_1', headerUserId: 'u_2' })).toEqual({
            ok: false,
            code: 'PRINCIPAL_MISMATCH',
        });
    });

    it('一致时才放行，且 userId 取主体值', () => {
        expect(resolvePrincipal({ principalUserId: 'u_1', headerUserId: 'u_1' })).toEqual({
            ok: true,
            userId: 'u_1',
        });
        // 不带头也允许：头只是可选的一致性断言
        expect(resolvePrincipal({ principalUserId: 'u_1', headerUserId: null })).toEqual({
            ok: true,
            userId: 'u_1',
        });
    });
});

describe('预算 0 / 缺省 / 读失败语义', () => {
    const budget = (over: Partial<TravelBudgetState> = {}): TravelBudgetState => ({
        userId: 'u_1',
        dayKey: '2026-10-23',
        mapCallsUsed: 0,
        mapCallsLimit: 30,
        llmTokensUsed: 0,
        llmTokensLimit: 10_000,
        paused: false,
        version: 1,
        ...over,
    });

    it('缺行按 fail-closed 处理，绝不用正数默认值补', () => {
        expect(resolveBudgetGate(null, 'map')).toEqual({ allowed: false, code: 'BUDGET_BLOCKED' });
    });

    it('limit=0 是硬零，不是「用默认值」', () => {
        expect(resolveBudgetGate(budget({ mapCallsLimit: 0 }), 'map')).toEqual({
            allowed: false,
            code: 'BUDGET_ZERO',
        });
    });

    it('用完即拦；暂停即拦（暂停优先于额度）', () => {
        expect(resolveBudgetGate(budget({ mapCallsUsed: 30 }), 'map').allowed).toBe(false);
        expect(resolveBudgetGate(budget({ mapCallsUsed: 31 }), 'map').allowed).toBe(false);
        expect(resolveBudgetGate(budget({ paused: true }), 'map').allowed).toBe(false);
        expect(resolveBudgetGate(budget({ paused: true, llmTokensLimit: 0 }), 'llm').allowed).toBe(false);
    });

    it('用负数或非有限值伪造 used 不算「还有额度」，一律 fail-closed', () => {
        for (const used of [-1, -30, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            expect(resolveBudgetGate(budget({ mapCallsUsed: used }), 'map'), String(used)).toEqual({
                allowed: false,
                code: 'BUDGET_BLOCKED',
            });
            expect(resolveBudgetGate(budget({ llmTokensUsed: used }), 'llm'), String(used)).toEqual({
                allowed: false,
                code: 'BUDGET_BLOCKED',
            });
        }
        expect(resolveBudgetGate(budget({ mapCallsLimit: Number.NaN }), 'map').allowed).toBe(false);
    });

    it('地图与 LLM 分列：一边用尽不影响另一边', () => {
        const b = budget({ mapCallsUsed: 30 });
        expect(resolveBudgetGate(b, 'map').allowed).toBe(false);
        expect(resolveBudgetGate(b, 'llm').allowed).toBe(true);
    });

    it('日键由账号固定时区决定，跨日只清 used 不动 limit', () => {
        // 15:59Z = 23:59 CST → 同一账号日；16:00Z 进入下一日
        expect(dayKey(Date.UTC(2026, 9, 23, 15, 59), DEFAULT_BUDGET_TZ)).toBe('2026-10-23');
        expect(dayKey(Date.UTC(2026, 9, 23, 16, 0), DEFAULT_BUDGET_TZ)).toBe('2026-10-24');
        expect(dayKey(Date.UTC(2026, 9, 23, 16, 0), 'UTC')).toBe('2026-10-23');
    });
});

describe('共享 / 出行 / 告知三态独立，撤销即脱敏', () => {
    const snapshot = {
        code: 'OK' as const,
        serverNow: 1_500,
        trip: trip({ status: 'en_route' }),
        position: { lat: 30.255, lng: 120.14, coordSys: 'gcj02' as const },
        route: { points: line, distanceM: 222 },
        history: [{ lat: 30.26, lng: 120.13 }],
        budget: { mapCallsUsed: 1, mapCallsLimit: 30 },
    };

    it('共享关闭时快照不含坐标/路线/历史，并给出 SHARE_REVOKED', () => {
        const share: TravelShareState = { userId: 'u_1', charId: 'c_1', shareEnabled: false, version: 3 };
        const out = redactSharedSnapshot(snapshot, share);
        expect(out.code).toBe('SHARE_REVOKED');
        expect(out.position).toBeNull();
        expect(out.route).toBeNull();
        expect(out.history).toEqual([]);
        expect(JSON.stringify(out)).not.toMatch(/"lat"|"lng"|"coordSys"/);
        expect(out.shareEnabled).toBe(false);
    });

    it('共享关闭时连 trip 一起清空：不出地名/目的地/时间（地名能反查位置）', () => {
        const share: TravelShareState = { userId: 'u_1', charId: 'c_1', shareEnabled: false, version: 3 };
        const out = redactSharedSnapshot(snapshot, share);
        expect(out.trip).toBeNull();
        const wire = JSON.stringify(out);
        expect(wire).not.toContain('阳光花园');
        expect(wire).not.toContain('西湖公园');
        expect(wire).not.toContain('杭州');
        expect(wire).not.toContain('2026');
        // origin/dest/时间戳一个都不许跟着出去
        expect(out.position).toBeNull();
        expect(out.route).toBeNull();
        expect(wire).not.toMatch(/departAt|arriveAt|dwellUntil|returnAt/);
    });

    it('服务端已判 SHARE_REVOKED 时，即使本地 share=true 也 fail-closed', () => {
        const share: TravelShareState = { userId: 'u_1', charId: 'c_1', shareEnabled: true, version: 5 };
        const out = redactSharedSnapshot({ ...snapshot, code: 'SHARE_REVOKED' }, share);
        expect(out.code).toBe('SHARE_REVOKED');
        expect(out.trip).toBeNull();
        expect(out.position).toBeNull();
        expect(out.route).toBeNull();
        expect(out.history).toEqual([]);
    });

    it('共享开启时保留位置，且不改调用方入参', () => {
        const share: TravelShareState = { userId: 'u_1', charId: 'c_1', shareEnabled: true, version: 4 };
        const before = JSON.stringify(snapshot);
        const out = redactSharedSnapshot(snapshot, share);
        expect(out.code).toBe('OK');
        expect(out.position).toEqual(snapshot.position);
        expect(out.route?.points.length).toBe(3);
        expect(JSON.stringify(snapshot)).toBe(before);
    });

    it('关共享不写行程态：入参行程保持原状，撤销只发生在出参', () => {
        const on = redactSharedSnapshot(snapshot, { userId: 'u_1', charId: 'c_1', shareEnabled: true, version: 1 });
        const off = redactSharedSnapshot(snapshot, { userId: 'u_1', charId: 'c_1', shareEnabled: false, version: 2 });
        expect(on.trip?.status).toBe('en_route');
        expect(off.trip).toBeNull();
        expect(snapshot.trip.status).toBe('en_route');
        expect(snapshot.trip.revision).toBe(1);
    });
});

describe('愿望失败 vs 角色放弃必须分开', () => {
    it('provider 失败保留愿望待重试，不写成不想出门', () => {
        expect(resolveWishOutcome('provider_failed')).toEqual({ state: 'open', event: 'provider_failed' });
        expect(resolveWishOutcome('budget_blocked')).toEqual({ state: 'open', event: 'budget_blocked' });
    });

    it('角色选 none 才是放弃', () => {
        expect(resolveWishOutcome('none')).toEqual({ state: 'dropped', event: 'dropped' });
    });

    it('选中即进入 chosen', () => {
        expect(resolveWishOutcome('chosen')).toEqual({ state: 'chosen', event: 'chosen' });
    });
});

describe('共享契约常量与 DDL', () => {
    it('候选上限 8 且按 id 去重', () => {
        expect(MAX_CANDIDATES).toBe(8);
        const many = Array.from({ length: 12 }, (_, i) => ({ id: `c${i % 10}`, label: `p${i}` }));
        const out = clampCandidates(many);
        expect(out.length).toBe(8);
        expect(new Set(out.map((c) => c.id)).size).toBe(out.length);
        expect(clampCandidates([]).length).toBe(0);
    });

    it('7 张表都在，且不存在地点/路线持久化缓存表', () => {
        for (const t of [
            'travel_settings',
            'travel_wishes',
            'travel_candidates',
            'travel_trips',
            'travel_trip_events',
            'travel_budget_state',
            'travel_share_state',
        ]) {
            expect(TRAVEL_SCHEMA_SQL).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
        }
        expect(TRAVEL_SCHEMA_SQL).not.toContain('travel_place_cache');
        expect(TRAVEL_SCHEMA_SQL).not.toContain('travel_route_cache');
        expect(TRAVEL_SCHEMA_SQL).toContain('budget_tz');
        // 唯一键必须含 user_id，防跨租户碰撞
        expect(TRAVEL_SCHEMA_SQL).toMatch(/UNIQUE INDEX IF NOT EXISTS travel_trips_dedupe ON travel_trips \(user_id, char_id, dedupe_key\)/);
        expect(TRAVEL_SCHEMA_SQL).toMatch(/UNIQUE INDEX IF NOT EXISTS travel_events_seq ON travel_trip_events \(user_id, trip_id, seq\)/);
    });

    it('错误码是固定集合，含 fail-closed 与几何许可码', () => {
        for (const code of [
            'UNAUTHORIZED',
            'INVALID_CLIENT_TOKEN',
            'PRINCIPAL_MISMATCH',
            'SHARE_REVOKED',
            'UNKNOWN_CANDIDATE',
            'WISH_EXPIRED',
            'PROVIDER_UNSUPPORTED_REGION',
            'PROVIDER_FAILED',
            'BUDGET_BLOCKED',
            'BUDGET_ZERO',
            'VERSION_CONFLICT',
            'ANCHOR_NOT_CONFIRMED',
            'ROUTE_UNAVAILABLE',
            'GEOMETRY_NOT_LICENSED',
            'RETENTION_EXPIRED',
        ]) {
            expect(TRAVEL_ERROR_CODES).toContain(code as never);
        }
        expect(TRAVEL_RETENTION_DEFAULTS).toEqual({ tripDays: 30, eventDays: 7 });
        expect(DEFAULT_BUDGET_TZ).toBe('Asia/Shanghai');
    });
});
