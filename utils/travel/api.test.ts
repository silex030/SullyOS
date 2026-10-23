/**
 * 前端出行数据 · API 客户端（B4）
 *
 * 三条硬约束：
 * - 身份只来自注入的会话（`session()`），**不发送 `X-User-Id`** 这类自报头冒充认证；
 * - 未配置会话 / 地址 → `UNAUTHORIZED`，一个请求都不发（fail-closed）；
 * - 共享读口在客户端再过一遍 `redactSharedSnapshot`：服务端就算回错，也不把地名/坐标漏出去。
 */
import { describe, expect, it, vi } from 'vitest';
import type { TravelBudgetState, TravelShareState, TravelStateSnapshot, TravelTrip } from '../../contracts/travel';
import { createTravelApi, type TravelTransport } from './api';

const trip = (): TravelTrip => ({
    id: 't1',
    userId: 'u_1',
    charId: 'c_1',
    status: 'en_route',
    planVersion: 1,
    revision: 2,
    coordSys: 'gcj02',
    provider: 'amap',
    origin: { label: '阳光花园', city: '杭州', district: '西湖区', lat: 30.26, lng: 120.13, kind: 'home' },
    dest: { label: '西湖公园', city: '杭州', district: '西湖区', lat: 30.25, lng: 120.15, kind: 'public' },
    departAt: 1_000,
    arriveAt: 2_000,
    dwellUntil: 3_000,
    returnAt: 4_000,
});

const snapshot = (over: Partial<TravelStateSnapshot> = {}): TravelStateSnapshot => ({
    code: 'OK',
    serverNow: 1_500,
    trip: trip(),
    position: { lat: 30.255, lng: 120.14, coordSys: 'gcj02' },
    route: { points: [{ lat: 30.26, lng: 120.13 }], distanceM: 120 },
    history: [{ lat: 30.26, lng: 120.13 }],
    budget: { mapCallsUsed: 1, mapCallsLimit: 30 },
    ...over,
});

const share = (enabled: boolean, version = 1): TravelShareState => ({
    userId: 'u_1',
    charId: 'c_1',
    shareEnabled: enabled,
    version,
});

const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('认证只来自注入的会话', () => {
    it('没配置会话 → UNAUTHORIZED，且一个请求都不发', async () => {
        const transport = vi.fn();
        const api = createTravelApi({
            baseUrl: () => 'https://backend.example',
            session: () => null,
            transport: transport as unknown as TravelTransport,
        });
        const res = await api.readSharedView('c_1');
        expect(res).toEqual({ ok: false, code: 'UNAUTHORIZED', status: 0 });
        expect(transport).not.toHaveBeenCalled();
    });

    it('有会话但没后端地址 → 同样 fail-closed，不退回同源猜路径', async () => {
        const transport = vi.fn();
        const api = createTravelApi({
            baseUrl: () => '',
            session: () => ({ token: 'sess-token' }),
            transport: transport as unknown as TravelTransport,
        });
        expect(await api.readBudget()).toEqual({ ok: false, code: 'UNAUTHORIZED', status: 0 });
        expect(transport).not.toHaveBeenCalled();
    });

    it('只带 Authorization，不发送 X-User-Id 冒充身份', async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        const transport: TravelTransport = async (url, init) => {
            calls.push({ url, init });
            return jsonResponse({ snapshot: snapshot(), share: share(true) });
        };
        const api = createTravelApi({
            baseUrl: () => 'https://backend.example',
            session: () => ({ token: 'sess-token', userId: 'u_1' }),
            transport,
            now: () => 42,
        });
        const res = await api.readSharedView('c_1');
        expect(res.ok).toBe(true);

        expect(calls).toHaveLength(1);
        const headers = calls[0].init.headers as Record<string, string>;
        const keys = Object.keys(headers).map((k) => k.toLowerCase());
        expect(keys).toContain('authorization');
        expect(headers.Authorization).toBe('Bearer sess-token');
        expect(keys).not.toContain('x-user-id');
        expect(headers['X-User-Id']).toBeUndefined();
        expect(String(calls[0].url)).toContain('/travel/state');
        expect(String(calls[0].url)).toContain('charId=c_1');
    });
});

describe('错误映射 fail-closed', () => {
    const make = (transport: TravelTransport) =>
        createTravelApi({
            baseUrl: () => 'https://backend.example',
            session: () => ({ token: 'sess-token' }),
            transport,
        });

    it('网络异常 → NETWORK（不冒充当 ok）', async () => {
        const api = make(async () => {
            throw new Error('Failed to fetch');
        });
        expect(await api.readSharedView('c_1')).toEqual({ ok: false, code: 'NETWORK', status: 0 });
    });

    it('HTTP 401 即使 body 自称 OK 也判 UNAUTHORIZED', async () => {
        const api = make(async () => jsonResponse({ ok: true, code: 'OK' }, 401));
        const res = await api.readSharedView('c_1');
        expect(res).toEqual({ ok: false, code: 'UNAUTHORIZED', status: 401 });
    });

    it('服务端错误码原样上抛（只接受冻结集合里的码）', async () => {
        const api = make(async () => jsonResponse({ error: { code: 'SHARE_REVOKED' } }, 403));
        expect(await api.readSharedView('c_1')).toEqual({ ok: false, code: 'SHARE_REVOKED', status: 403 });
    });

    it('未知错误码不猜语义，按授权失败处理', async () => {
        const api = make(async () => jsonResponse({ error: { code: 'SOMETHING_NEW' } }, 400));
        expect((await api.readSharedView('c_1')).ok).toBe(false);
        const res = await api.readSharedView('c_1');
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.code).toBe('UNAUTHORIZED');
    });

    it('200 但 body 形状不对 → MALFORMED_RESPONSE，不返回半个对象', async () => {
        const api = make(async () => jsonResponse({ snapshot: { code: 'OK' } }));
        expect(await api.readSharedView('c_1')).toEqual({
            ok: false,
            code: 'MALFORMED_RESPONSE',
            status: 200,
        });
    });
});

describe('共享读口在客户端再过一道脱敏', () => {
    const make = (payload: unknown) =>
        createTravelApi({
            baseUrl: () => 'https://backend.example',
            session: () => ({ token: 'sess-token' }),
            transport: async () => jsonResponse(payload),
        });

    it('共享关闭：即使服务端回了完整行程+坐标，出参也不含地名/目的地/时间', async () => {
        const api = make({ snapshot: snapshot(), share: share(false, 2) });
        const res = await api.readSharedView('c_1');
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.data.code).toBe('SHARE_REVOKED');
        expect(res.data.trip).toBeNull();
        expect(res.data.position).toBeNull();
        expect(res.data.route).toBeNull();
        expect(res.data.history).toEqual([]);
        const wire = JSON.stringify(res.data);
        expect(wire).not.toContain('阳光花园');
        expect(wire).not.toContain('西湖公园');
        expect(wire).not.toContain('杭州');
        expect(wire).not.toMatch(/"lat"|"lng"|"coordSys"/);
    });

    it('服务端已撤销但本地 share=true：仍 fail-closed', async () => {
        const api = make({ snapshot: snapshot({ code: 'SHARE_REVOKED' }), share: share(true, 3) });
        const res = await api.readSharedView('c_1');
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.data.code).toBe('SHARE_REVOKED');
        expect(res.data.trip).toBeNull();
        expect(res.data.position).toBeNull();
    });

    it('共享开启：保留位置，但 trip 里没有地址字段', async () => {
        const api = make({ snapshot: snapshot(), share: share(true, 4) });
        const res = await api.readSharedView('c_1');
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.data.code).toBe('OK');
        expect(res.data.position).not.toBeNull();
        expect(JSON.stringify(res.data.trip)).not.toMatch(/address|栋|单元/);
    });
});

describe('共享开关与预算读口', () => {
    it('切换共享带上 baseVersion，避免多设备互相覆盖', async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        const api = createTravelApi({
            baseUrl: () => 'https://backend.example/',
            session: () => ({ token: 'sess-token' }),
            transport: async (url, init) => {
                calls.push({ url, init });
                return jsonResponse({ share: share(false, 5) });
            },
        });
        const res = await api.setShare('c_1', false, 4);
        expect(res.ok).toBe(true);
        expect(calls[0].url).toBe('https://backend.example/travel/share');
        expect(JSON.parse(String(calls[0].init.body))).toEqual({
            charId: 'c_1',
            shareEnabled: false,
            baseVersion: 4,
        });
    });

    it('预算读不到账本时返回失败，不给默认额度', async () => {
        const api = createTravelApi({
            baseUrl: () => 'https://backend.example',
            session: () => ({ token: 'sess-token' }),
            transport: async () => jsonResponse({ budget: {} }),
        });
        const res = await api.readBudget();
        expect(res.ok).toBe(false);
    });

    it('预算正常时原样解析，不做「负数补零」修正', async () => {
        const budget: TravelBudgetState = {
            userId: 'u_1',
            dayKey: '2026-10-23',
            mapCallsUsed: -3,
            mapCallsLimit: 30,
            llmTokensUsed: 0,
            llmTokensLimit: 10_000,
            paused: false,
            version: 2,
        };
        const api = createTravelApi({
            baseUrl: () => 'https://backend.example',
            session: () => ({ token: 'sess-token' }),
            transport: async () => jsonResponse({ budget }),
        });
        const res = await api.readBudget();
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.data.mapCallsUsed).toBe(-3);
    });
});
