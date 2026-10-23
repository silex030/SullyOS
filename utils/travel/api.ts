/**
 * 角色自主出行 · 前端 API 客户端（B4）
 *
 * 设计约束（评审要求，别放宽）：
 * - **身份只来自注入的会话**：`session()` 返回由既有登录/主体机制签发的 token，
 *   请求只带 `Authorization: Bearer <token>`。绝不发送 `X-User-Id` 这种自报头来
 *   「证明」自己是谁 —— 服务端 `resolvePrincipal()` 只把它当一致性断言，冒充不了认证。
 * - **未配置就 fail-closed**：没有会话或没有后端地址时直接返回 `UNAUTHORIZED`，
 *   不猜同源路径、不带空 token 试一次。地址与 token 都由调用方注入，本文件不读
 *   localStorage（前端设置读取失败不能变成「默认连某个后端」）。
 * - **共享读口自带第二道脱敏**：服务端回什么都在客户端再过一次
 *   `redactSharedSnapshot()`。共享关闭 / 服务端已撤销时出参里没有地名、目的地、
 *   时间戳、坐标 —— 唯一可信来源是服务端权威位，本地 `share=true` 不作数。
 * - **请求走既有通道** `utils/externalRequest.ts` 的 `externalFetch`（默认 route `worker`），
 *   不新开裸 fetch，也不为出行单独加 CORS 面。
 *
 * 端点路径集中在本文件的 `TRAVEL_ENDPOINTS`：B3 后端路由按同一份契约落地，若最终
 * 路径不同只改这一处（UI/state 不感知）。
 */
import { TRAVEL_ERROR_CODES, type TravelBudgetState, type TravelErrorCode, type TravelShareState, type TravelStateSnapshot } from '../../contracts/travel';
import { externalFetch } from '../externalRequest';
import { redactSharedSnapshot, type TravelPublicSnapshot } from './core';

/** 后端路径（B3 契约）。集中一处，便于集成时对齐。 */
export const TRAVEL_ENDPOINTS = {
    state: '/travel/state',
    share: '/travel/share',
    budget: '/travel/budget',
} as const;

/**
 * 客户端本地失败码（**不是** `TRAVEL_ERROR_CODES` 的成员，永不发给服务端）：
 * - `NETWORK`：请求没拿到响应（断网 / CORS / 传输层异常）；
 * - `MALFORMED_RESPONSE`：拿到响应但形状不符合契约（宁可不显示，也不半截渲染）。
 */
export type TravelClientErrorCode = 'NETWORK' | 'MALFORMED_RESPONSE';
export type TravelApiErrorCode = TravelErrorCode | TravelClientErrorCode;

export type TravelApiResult<T> =
    | { ok: true; data: T }
    | { ok: false; code: TravelApiErrorCode; status: number };

export interface TravelSession {
    /** 由既有登录/主体机制派生的会话令牌。空串等同于未登录。 */
    token: string;
    /** 仅用于本地展示/断言，**不会**写进任何请求头。 */
    userId?: string;
}

export interface TravelRequestInit extends RequestInit {
    route?: 'worker' | 'direct';
    purpose?: string;
}

/** 传输层可注入（单测用假 transport，运行期默认走统一外部请求入口）。 */
export type TravelTransport = (url: string, init: TravelRequestInit) => Promise<Response>;

export interface TravelApiDeps {
    /** 会话来源。返回 null / 空 token → UNAUTHORIZED。 */
    session: () => TravelSession | null | undefined;
    /** 后端根地址（如设置里的 agentUrl）。返回空串 → UNAUTHORIZED。 */
    baseUrl: () => string;
    transport?: TravelTransport;
    /** 统一外部请求的通道语义，默认 worker。 */
    route?: 'worker' | 'direct';
    now?: () => number;
}

export interface TravelStatePayload {
    snapshot: TravelStateSnapshot;
    share: TravelShareState;
}

export interface TravelApi {
    readSharedView: (charId: string) => Promise<TravelApiResult<TravelPublicSnapshot>>;
    readState: (charId: string) => Promise<TravelApiResult<TravelStatePayload>>;
    setShare: (charId: string, enabled: boolean, baseVersion: number) => Promise<TravelApiResult<TravelShareState>>;
    readBudget: () => Promise<TravelApiResult<TravelBudgetState>>;
}

const ERROR_CODES = new Set<string>(TRAVEL_ERROR_CODES as readonly string[]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const isShareState = (v: unknown): v is TravelShareState =>
    isRecord(v) && typeof v.shareEnabled === 'boolean' && isFiniteNumber(v.version) && typeof v.charId === 'string';

const isSnapshot = (v: unknown): v is TravelStateSnapshot =>
    isRecord(v) &&
    (v.code === 'OK' || v.code === 'SHARE_REVOKED') &&
    isFiniteNumber(v.serverNow) &&
    isRecord(v.budget) &&
    isFiniteNumber(v.budget.mapCallsUsed) &&
    isFiniteNumber(v.budget.mapCallsLimit) &&
    Array.isArray(v.history) &&
    (v.trip === null || isRecord(v.trip));

const isBudget = (v: unknown): v is TravelBudgetState =>
    isRecord(v) &&
    isFiniteNumber(v.mapCallsUsed) &&
    isFiniteNumber(v.mapCallsLimit) &&
    isFiniteNumber(v.llmTokensUsed) &&
    isFiniteNumber(v.llmTokensLimit) &&
    typeof v.dayKey === 'string' &&
    typeof v.paused === 'boolean' &&
    isFiniteNumber(v.version);

const joinUrl = (base: string, path: string): string => {
    const b = base.replace(/\/+$/, '');
    return `${b}${path}`;
};

/** 从错误响应体里取错误码：只认冻结集合，别的一律当授权失败。 */
const readErrorCode = (body: unknown, status: number): TravelErrorCode => {
    const raw = isRecord(body)
        ? isRecord(body.error)
            ? body.error.code
            : body.code
        : undefined;
    if (typeof raw === 'string' && ERROR_CODES.has(raw)) return raw as TravelErrorCode;
    return 'UNAUTHORIZED';
};

export function createTravelApi(deps: TravelApiDeps): TravelApi {
    const route = deps.route ?? 'worker';
    const transport: TravelTransport =
        deps.transport ??
        ((url, init) => externalFetch(url, { ...init, route: init.route ?? route }));

    /** 认证/地址前置检查；返回 null 表示可以发请求。 */
    const preflight = (): TravelApiResult<never> | null => {
        const token = String(deps.session()?.token ?? '').trim();
        const base = String(deps.baseUrl() ?? '').trim();
        if (!token || !base) return { ok: false, code: 'UNAUTHORIZED', status: 0 };
        return null;
    };

    const request = async (
        path: string,
        init: { method: 'GET' | 'POST'; body?: unknown; purpose: string },
    ): Promise<TravelApiResult<unknown>> => {
        const blocked = preflight();
        if (blocked) return blocked;

        const token = String(deps.session()?.token ?? '').trim();
        const url = joinUrl(String(deps.baseUrl()).trim(), path);
        const headers: Record<string, string> = {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
        };
        let body: string | undefined;
        if (init.body !== undefined) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(init.body);
        }

        let res: Response;
        try {
            res = await transport(url, {
                method: init.method,
                headers,
                body,
                route,
                purpose: init.purpose,
            });
        } catch {
            return { ok: false, code: 'NETWORK', status: 0 };
        }

        let parsed: unknown = null;
        try {
            parsed = await res.json();
        } catch {
            parsed = null;
        }

        if (!res.ok) {
            return { ok: false, code: readErrorCode(parsed, res.status), status: res.status };
        }
        if (parsed === null) {
            return { ok: false, code: 'MALFORMED_RESPONSE', status: res.status };
        }
        return { ok: true, data: parsed };
    };

    const readState = async (charId: string): Promise<TravelApiResult<TravelStatePayload>> => {
        const id = String(charId ?? '').trim();
        if (!id) return { ok: false, code: 'UNAUTHORIZED', status: 0 };
        const raw = await request(`${TRAVEL_ENDPOINTS.state}?charId=${encodeURIComponent(id)}`, {
            method: 'GET',
            purpose: '读取出行状态快照',
        });
        if (!raw.ok) return raw;
        const body = raw.data;
        if (!isRecord(body) || !isSnapshot(body.snapshot) || !isShareState(body.share)) {
            return { ok: false, code: 'MALFORMED_RESPONSE', status: 200 };
        }
        return { ok: true, data: { snapshot: body.snapshot, share: body.share } };
    };

    return {
        readState,

        /**
         * 地图/共享卡片唯一读口。永远返回脱敏后的 `TravelPublicSnapshot`：
         * 共享关闭或服务端撤销 → `SHARE_REVOKED` + `trip:null`（无事可泄）。
         */
        readSharedView: async (charId: string): Promise<TravelApiResult<TravelPublicSnapshot>> => {
            const state = await readState(charId);
            if (!state.ok) return state;
            return {
                ok: true,
                data: redactSharedSnapshot(state.data.snapshot, state.data.share),
            };
        },

        setShare: async (charId, enabled, baseVersion): Promise<TravelApiResult<TravelShareState>> => {
            const id = String(charId ?? '').trim();
            if (!id) return { ok: false, code: 'UNAUTHORIZED', status: 0 };
            const raw = await request(TRAVEL_ENDPOINTS.share, {
                method: 'POST',
                body: { charId: id, shareEnabled: !!enabled, baseVersion },
                purpose: enabled ? '开启位置共享' : '关闭位置共享',
            });
            if (!raw.ok) return raw;
            const body = raw.data;
            if (!isRecord(body) || !isShareState(body.share)) {
                return { ok: false, code: 'MALFORMED_RESPONSE', status: 200 };
            }
            return { ok: true, data: body.share };
        },

        readBudget: async (): Promise<TravelApiResult<TravelBudgetState>> => {
            const raw = await request(TRAVEL_ENDPOINTS.budget, {
                method: 'GET',
                purpose: '读取出行预算账本',
            });
            if (!raw.ok) return raw;
            const body = raw.data;
            if (!isRecord(body) || !isBudget(body.budget)) {
                return { ok: false, code: 'MALFORMED_RESPONSE', status: 200 };
            }
            // 原样返回，不在客户端「修正」负数 used：判定交给 budgetClient/core 的 fail-closed 闸。
            return { ok: true, data: body.budget };
        },
    };
}
