import { describe, expect, it, beforeEach } from 'vitest';
import {
    adoptTravelSession,
    clearTravelSession,
    readTravelSession,
    travelSessionState,
    TRAVEL_SESSION_ENDPOINT,
    TRAVEL_SESSION_MAX_TTL_MS,
    requestTravelSession,
} from './session';

const NOW = 1_700_000_000_000;
const CRED = 'owner-key-0123456789abcdef';
const TOKEN = 'sess_0123456789abcdef';

describe('travel session（短期 Bearer，fail-closed）', () => {
    beforeEach(() => clearTravelSession());

    it('未签发时没有会话（不拿 userId 冒充 token）', () => {
        expect(readTravelSession(NOW)).toBeNull();
        expect(travelSessionState(NOW)).toBe('unconfigured');
    });

    it('接受服务端签发的短期 token', () => {
        expect(adoptTravelSession({ token: TOKEN, userId: 'u1', expiresAt: NOW + 60_000 }, NOW)).toBe(true);
        expect(readTravelSession(NOW)).toEqual({ token: TOKEN, userId: 'u1' });
        expect(travelSessionState(NOW)).toBe('ready');
    });

    it('拒绝把 userId 当 token 的负载', () => {
        expect(adoptTravelSession({ token: 'u1', userId: 'u1', expiresAt: NOW + 60_000 }, NOW)).toBe(false);
        expect(readTravelSession(NOW)).toBeNull();
    });

    it('拒绝过短 / 空白 token 与非有限过期时间', () => {
        expect(adoptTravelSession({ token: 'short', expiresAt: NOW + 60_000 }, NOW)).toBe(false);
        expect(adoptTravelSession({ token: '   ', expiresAt: NOW + 60_000 }, NOW)).toBe(false);
        expect(adoptTravelSession({ token: TOKEN, expiresAt: Number.NaN }, NOW)).toBe(false);
    });

    it('拒绝已过期与超长（非短期）token', () => {
        expect(adoptTravelSession({ token: TOKEN, expiresAt: NOW - 1 }, NOW)).toBe(false);
        expect(
            adoptTravelSession({ token: TOKEN, expiresAt: NOW + TRAVEL_SESSION_MAX_TTL_MS + 1 }, NOW),
        ).toBe(false);
    });

    it('过期后读取立即失效（fail-closed，不返回旧 token）', () => {
        adoptTravelSession({ token: TOKEN, expiresAt: NOW + 1_000 }, NOW);
        expect(readTravelSession(NOW + 999)?.token).toBe(TOKEN);
        expect(readTravelSession(NOW + 1_000)).toBeNull();
        expect(travelSessionState(NOW + 1_000)).toBe('expired');
    });

    it('失效后的会话不能被旧负载重新读回', () => {
        adoptTravelSession({ token: TOKEN, expiresAt: NOW + 1_000 }, NOW);
        readTravelSession(NOW + 2_000);
        expect(readTravelSession(NOW + 3_000)).toBeNull();
    });

    it('同源登录端点：失败时不签发任何 token', async () => {
        const fetchImpl = async () => new Response('nope', { status: 401 });
        await expect(
            requestTravelSession({ fetchImpl, now: NOW, credential: { userId: 'u1', ownerKey: CRED } }),
        ).resolves.toBe(false);
        expect(readTravelSession(NOW)).toBeNull();
    });

    it('没有配对凭据 → 不发请求（fail-closed）', async () => {
        let called = false;
        const fetchImpl = async () => {
            called = true;
            return new Response('{}', { status: 200 });
        };
        await expect(requestTravelSession({ fetchImpl, now: NOW, credential: null })).resolves.toBe(false);
        expect(called).toBe(false);
    });

    it('同源登录端点：成功响应经同一校验后才采用，且打到固定路径', async () => {
        const calls: Array<{ url: string; init?: RequestInit }> = [];
        const fetchImpl = async (url: string, init?: RequestInit) => {
            calls.push({ url, init });
            return new Response(JSON.stringify({ token: TOKEN, userId: 'u1', expiresAt: NOW + 60_000 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        };
        await expect(
            requestTravelSession({ fetchImpl, now: NOW, credential: { userId: 'u1', ownerKey: CRED } }),
        ).resolves.toBe(true);
        expect(calls[0]?.url).toBe(TRAVEL_SESSION_ENDPOINT);
        expect(calls[0]?.init?.credentials).toBe('same-origin');
        // 凭据在 body 里，不在 URL 里（URL 会进历史/日志）
        expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ userId: 'u1', ownerKey: CRED });
        expect(readTravelSession(NOW)?.token).toBe(TOKEN);
    });

    it('同源登录端点返回 userId-as-token 也不采用', async () => {
        const fetchImpl = async () =>
            new Response(JSON.stringify({ token: 'u1', userId: 'u1', expiresAt: NOW + 60_000 }), { status: 200 });
        await expect(
            requestTravelSession({ fetchImpl, now: NOW, credential: { userId: 'u1', ownerKey: CRED } }),
        ).resolves.toBe(false);
        expect(readTravelSession(NOW)).toBeNull();
    });
});
