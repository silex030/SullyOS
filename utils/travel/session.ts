/**
 * 角色自主出行 · 会话（B6）
 *
 * 为什么单独一层：出行的读/写端点必须带**服务端签发、且后端强绑定主体**的短期
 * Bearer，而不是本地 `userId`、也不是把主动消息的共享凭据直接当中继令牌。
 *
 * 硬约束（安全 lane 交接前就这样，不放松）：
 * - token 只从服务端登录端点（`/travel/session`，同源、`credentials:'same-origin'`）
 *   或将来 `utils/auth` 的签发结果经 {@link adoptTravelSession} 采用；
 * - `token === userId`、过短、空白、已过期、TTL 超过 {@link TRAVEL_SESSION_MAX_TTL_MS}
 *   一律拒绝 —— 这些形状说明调用方把用户标识当成了凭据；
 * - **只存在内存**：不写 localStorage / sessionStorage / IndexedDB，因此不会进备份、
 *   不会跨标签页复活；页面刷新后重新签发（拿不到就是 fail-closed，不发请求）；
 * - 过期后读取立即失效，且不会因为旧负载仍留在变量里而重新"活过来"。
 *
 * 主动消息那套共享凭据（worker serverToken / masterKey）**不得**在这里复用：
 * 它只用于服务端验证 owner 后签发短期 session，签发实现等安全 lane 的 auth 交接。
 */
import type { TravelSession } from './api';

/** 服务端签发短期会话的同源端点（= auth 的 exchange，摊平回包）。 */
export const TRAVEL_SESSION_ENDPOINT = '/travel/session';

/** 绝对路径版本（供注入 fetch 的宿主/单测使用，与相对路径同一条路由）。 */
export const TRAVEL_SESSION_ENDPOINT_ABSOLUTE = '/travel/session';

/** 短期会话最长 TTL：超过即视为长期凭据，拒绝采用。 */
export const TRAVEL_SESSION_MAX_TTL_MS = 12 * 60 * 60 * 1000;

/** 短期 token 最短长度：短于它的基本是用户 id / 口令占位。 */
const MIN_TOKEN_LENGTH = 16;

interface StoredSession {
    token: string;
    userId?: string;
    expiresAt: number;
}

/** 进程内唯一副本；刻意不落任何浏览器存储。 */
let current: StoredSession | null = null;
/** 曾经成功签发过（用于区分「未登录」与「登录已过期」）。 */
let hadSession = false;

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * 采用服务端签发的会话。返回 false = 负载不可信（调用方必须按未登录处理）。
 * 入参是 `unknown`：登录响应体、将来 auth.ts 的回执都能直接喂进来。
 */
export function adoptTravelSession(raw: unknown, now: number = Date.now()): boolean {
    if (!isRecord(raw)) return false;
    const token = typeof raw.token === 'string' ? raw.token.trim() : '';
    const userId = typeof raw.userId === 'string' ? raw.userId.trim() : undefined;
    const expiresAt = raw.expiresAt;

    if (!token || token.length < MIN_TOKEN_LENGTH) return false;
    // 把用户标识当凭据是最常见的错误接线：即便服务端"签"了也拒。
    if (userId && token === userId) return false;
    if (!isFiniteNumber(expiresAt)) return false;
    if (expiresAt <= now) return false;
    if (expiresAt - now > TRAVEL_SESSION_MAX_TTL_MS) return false;

    current = userId ? { token, userId, expiresAt } : { token, expiresAt };
    hadSession = true;
    return true;
}

/** 读取仍然有效的会话；过期即清空并返回 null（fail-closed）。 */
export function readTravelSession(now: number = Date.now()): TravelSession | null {
    if (!current) return null;
    if (!isFiniteNumber(current.expiresAt) || current.expiresAt <= now) {
        current = null;
        return null;
    }
    return current.userId ? { token: current.token, userId: current.userId } : { token: current.token };
}

/**
 * 'ready' | 'expired'（曾签发过但已过期/被清空）| 'unconfigured'（从未签发）。
 * 设置页只区分"未就绪"和"已就绪"，不展示 token 本身。
 */
export function travelSessionState(now: number = Date.now()): 'ready' | 'expired' | 'unconfigured' {
    if (!current) return hadSession ? 'expired' : 'unconfigured';
    if (!isFiniteNumber(current.expiresAt) || current.expiresAt <= now) {
        current = null;
        return 'expired';
    }
    return 'ready';
}

export function clearTravelSession(): void {
    current = null;
    hadSession = false;
}

/** 配对凭据的浏览器存储键。**不进备份**（不在 localStorage 镜像白名单里），也不跨站发送。 */
export const TRAVEL_OWNER_STORAGE_KEY = 'travel.owner.v1';

export interface TravelOwnerCredential {
    userId: string;
    ownerKey: string;
}

const isOwnerCredential = (v: unknown): v is TravelOwnerCredential =>
    isRecord(v)
    && typeof v.userId === 'string' && v.userId.trim().length > 0
    && typeof v.ownerKey === 'string' && v.ownerKey.trim().length >= 16;

/**
 * 读配对凭据（运维经已鉴权服务端通道签发，用户只粘贴一次）。
 * 这是「自动刷新登录」的唯一输入：短期 token 过期后用它再换一次，不需要用户重新输入。
 */
export function readTravelOwnerCredential(): TravelOwnerCredential | null {
    try {
        if (typeof localStorage === 'undefined') return null;
        const raw = localStorage.getItem(TRAVEL_OWNER_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as unknown;
        return isOwnerCredential(parsed)
            ? { userId: parsed.userId.trim(), ownerKey: parsed.ownerKey.trim() }
            : null;
    } catch {
        return null;
    }
}

/** 保存配对凭据（只存这一份；token 永远只在内存）。返回 false = 浏览器拒绝写入。 */
export function saveTravelOwnerCredential(credential: TravelOwnerCredential): boolean {
    if (!isOwnerCredential(credential)) return false;
    try {
        if (typeof localStorage === 'undefined') return false;
        localStorage.setItem(
            TRAVEL_OWNER_STORAGE_KEY,
            JSON.stringify({ userId: credential.userId.trim(), ownerKey: credential.ownerKey.trim() }),
        );
        return true;
    } catch {
        return false;
    }
}

export function clearTravelOwnerCredential(): void {
    try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(TRAVEL_OWNER_STORAGE_KEY);
    } catch {
        /* 清不掉也不影响 token 已经是内存态 */
    }
}

export interface RequestTravelSessionOptions {
    /** 注入用（单测 / 非浏览器宿主）；默认同源 fetch。 */
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    now?: number;
    /** 配对凭据（默认从 localStorage 读；测试可直接注入）。 */
    credential?: TravelOwnerCredential | null;
}

/**
 * 向服务端换取短期会话：`POST /travel/session { userId, ownerKey }`。
 *
 * - 凭据来自 {@link readTravelOwnerCredential}（用户粘贴一次，运维签发）；
 * - 没有凭据就不发请求（fail-closed，UI 显示「未配对」）；
 * - 服务端回的是 `{ token, userId, expiresAt }`（`/travel/session` 是 exchange 的摊平别名），
 *   不合法/已过期一律 `adoptTravelSession` 拒收。
 */
export async function requestTravelSession(options: RequestTravelSessionOptions = {}): Promise<boolean> {
    const now = options.now ?? Date.now();
    const credential = options.credential ?? readTravelOwnerCredential();
    if (!credential) return false;
    const doFetch =
        options.fetchImpl ??
        ((url: string, init?: RequestInit) => fetch(url, init));
    let body: unknown = null;
    try {
        const res = await doFetch(TRAVEL_SESSION_ENDPOINT_ABSOLUTE, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ userId: credential.userId, ownerKey: credential.ownerKey }),
        });
        if (!res || !res.ok) return false;
        body = await res.json();
    } catch {
        return false;
    }
    // 兼容两种回包：摊平 `{token,userId,expiresAt}` 与 `{session:{...}}`。
    const flattened = isRecord(body) && !('token' in body) && isRecord(body.session) ? body.session : body;
    return adoptTravelSession(flattened, now);
}

/**
 * 需要时自动续期：有有效会话 → true；快过期/没有 → 用配对凭据再换一次。
 * 页面刷新后第一次调用就能恢复，不需要用户重新输入任何东西。
 */
export async function ensureTravelSession(
    options: RequestTravelSessionOptions & { refreshWindowMs?: number } = {},
): Promise<boolean> {
    const now = options.now ?? Date.now();
    const current2 = current;
    if (current2 && isFiniteNumber(current2.expiresAt)) {
        const window = Math.max(0, Math.trunc(options.refreshWindowMs ?? 60_000));
        if (current2.expiresAt - now > window) return true;
    }
    return requestTravelSession({ ...options, now });
}
