/**
 * 角色自主出行 · 运行时接线层（B6）
 *
 * 为什么要有这一层：B4 的 `api.ts` / `state.ts` 是数据层，B5 的组件是纯 props；
 * 中间缺的是「谁持有 store、谁开面板、设置和锚点走哪个端点、聊天提示词块从哪来」。
 * 这些都在这里，且**不改 B4 的 api.ts**（端点新增属于跨 lane 契约，等 B3 对齐）。
 *
 * 边界：
 * - 会话与地址都靠注入：没有短期 Bearer（`session.ts`）或没有后端地址 → 不发请求，
 *   读取按 fail-closed 处理（不是"默认放行"）。
 * - 设置与锚点写服务端、读回才算数；**本层只有内存缓存**，不写 localStorage、
 *   不进备份。刷新页面重新读。
 * - 聊天用的角色内部上下文（`/travel/context`）与公开共享快照是两条线：
 *   共享关闭时公开快照没有任何地名/坐标，但角色自知仍要能说"我在去哪"，
 *   所以这里单独读鉴权后的脱敏上下文并缓存成提示词块；读不到就不注入。
 * - 面板开关只是 UI 状态，不改行程；角色想去哪由角色与服务端状态机决定。
 */
import type { TravelPlaceAnchor } from '../../contracts/travel';
import { ensureTravelSession, readTravelOwnerCredential } from './session';
import { TRAVEL_ERROR_CODES, type TravelBudgetState, type TravelErrorCode } from '../../contracts/travel';
import {
    createTravelApi,
    type TravelApi,
    type TravelApiErrorCode,
    type TravelRequestInit,
    type TravelSession,
    type TravelTransport,
} from './api';
import { readBudgetView, type TravelBudgetView } from './budgetClient';
import { createTravelStateStore, type TravelStateStore } from './state';
import { buildTravelPromptBlock } from './prompt';
import { readAgentRoutingConfig } from '../agentRouting';
import { externalFetch } from '../externalRequest';
import { readTravelSession } from './session';

/**
 * B6 新增端点（与 B3 后端对齐后落地；改路径只改这里）。
 * 这些**没有**加进 B4 的 `TRAVEL_ENDPOINTS` —— 那是 B4 的契约文件。
 */
export const TRAVEL_RUNTIME_ENDPOINTS = {
    settings: '/travel/settings',
    /** 角色级启用位（账号总开关之外的第二道闸）。 */
    char: '/travel/char',
    /** 地图额度（与 state 读的同一本账；这里只用来改上限）。 */
    budget: '/travel/budget',
    anchor: '/travel/anchor',
    anchorSearch: '/travel/anchor/search',
    /** 角色内部（鉴权后）脱敏上下文：共享关闭也返回，用于角色自知，不含坐标。 */
    context: '/travel/context',
    /** 地图服务凭据：用户自己填，服务端按主体加密保存。 */
    mapCredentials: '/travel/map/credentials',
    /** 显式「测试连接」（单次、有冷却，不扣自主出行预算）。 */
    mapCredentialsTest: '/travel/map/credentials/test',
} as const;

/** 凭据存在性：**没有**任何密钥值，只有布尔。 */
export interface TravelMapCredentialPresence {
    amapWebKey: boolean;
    amapJsKey: boolean;
    amapJsCode: boolean;
    mapboxToken: boolean;
}

/**
 * 服务端回给前端的凭据视图：只有存在性 + 浏览器必需的公开 Key。
 * `amapJsKey` / `mapboxToken` 是官方设计上就要进浏览器的公开展示 Key；
 * Web 服务 Key 与 securityJsCode 不在这个形状里（也永远不会被加进来）。
 */
export interface TravelMapCredentialView {
    configured: boolean;
    unreadable: boolean;
    has: TravelMapCredentialPresence;
    amapJsKey: string | null;
    mapboxToken: string | null;
    mapboxStyleUrl: string | null;
    updatedAt: number | null;
    serviceHost: string | null;
    serviceHostExpiresAt: number | null;
}

export interface TravelMapCredentialsView {
    known: boolean;
    credentials: TravelMapCredentialView | null;
    error: TravelApiErrorCode | null;
}

export interface TravelMapCredentialPatch {
    amapWebKey?: string;
    amapJsKey?: string;
    amapJsCode?: string;
    mapboxToken?: string;
    mapboxStyleUrl?: string;
    clear?: readonly ('amapWebKey' | 'amapJsKey' | 'amapJsCode' | 'mapboxToken' | 'mapboxStyleUrl')[];
}

/**
 * 设置形状**以后端为准**（`GET /travel/settings`）：
 * - `enabled` 是账号总开关；缺行 = 未开启，不默认打开；
 * - 地图额度不在这里（它在 `/travel/budget` 的同一本账上），LLM 额度也不在这里
 *   （走既有 autonomy 账本）—— 设置页不能凭一个数字就「提额」。
 */
export interface TravelSettings {
    enabled: boolean;
    budgetTz: string;
    tripRetentionDays: number;
    eventRetentionDays: number;
    version: number;
    updatedAt: number;
}

/** 固定地点的对外形状：**没有坐标**（服务端只回地名语义）。 */
export interface TravelAnchorView {
    label: string;
    city: string;
    district?: string;
    precision: 'area';
    confirmedAt: number;
}

export interface TravelSettingsView {
    known: boolean;
    settings: TravelSettings | null;
    error: TravelApiErrorCode | null;
}

export interface TravelAnchorCandidate {
    label: string;
    city: string;
    district?: string;
    placeId?: string;
}

export interface TravelOverlayState {
    open: boolean;
    charId: string | null;
}

export interface TravelRuntimeDeps {
    api?: TravelApi;
    store?: TravelStateStore;
    session?: () => TravelSession | null | undefined;
    baseUrl?: () => string;
    transport?: TravelTransport;
    now?: () => number;
}

export interface TravelRuntimeResult<T> {
    ok: boolean;
    data: T | null;
    code?: TravelApiErrorCode;
}

const ERROR_CODES = new Set<string>(TRAVEL_ERROR_CODES as readonly string[]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const isSettings = (v: unknown): v is TravelSettings =>
    isRecord(v) &&
    typeof v.enabled === 'boolean' &&
    typeof v.budgetTz === 'string' &&
    isFiniteNumber(v.tripRetentionDays) &&
    isFiniteNumber(v.eventRetentionDays) &&
    isFiniteNumber(v.version) &&
    isFiniteNumber(v.updatedAt);

/** 凭据视图形状校验：只认布尔与公开展示 Key，出现「看起来像密钥」的额外字段也照形状拒绝。 */
const isMapCredentialView = (v: unknown): v is TravelMapCredentialView =>
    isRecord(v) &&
    typeof v.configured === 'boolean' &&
    typeof v.unreadable === 'boolean' &&
    isRecord(v.has) &&
    typeof (v.has as Record<string, unknown>).amapWebKey === 'boolean' &&
    typeof (v.has as Record<string, unknown>).amapJsKey === 'boolean' &&
    typeof (v.has as Record<string, unknown>).amapJsCode === 'boolean' &&
    typeof (v.has as Record<string, unknown>).mapboxToken === 'boolean' &&
    (v.amapJsKey === null || typeof v.amapJsKey === 'string') &&
    (v.mapboxToken === null || typeof v.mapboxToken === 'string') &&
    (v.mapboxStyleUrl === null || typeof v.mapboxStyleUrl === 'string') &&
    (v.updatedAt === null || isFiniteNumber(v.updatedAt)) &&
    (v.serviceHost === null || typeof v.serviceHost === 'string') &&
    (v.serviceHostExpiresAt === null || isFiniteNumber(v.serviceHostExpiresAt));

const isAnchor = (v: unknown): v is TravelAnchorView =>
    isRecord(v) &&
    typeof v.label === 'string' &&
    v.label.trim().length > 0 &&
    typeof v.city === 'string' &&
    v.city.trim().length > 0 &&
    v.precision === 'area' &&
    isFiniteNumber(v.confirmedAt) &&
    // 门面：前端**不该**再看到坐标；真出现了就当形状不对（宁可显示未确认）。
    v.lat === undefined && v.lng === undefined;

/** 默认后端地址：优先设置里的主代理地址；没有就用同源（再由 Bearer 决定能不能用）。 */
const defaultBaseUrl = (): string => {
    const configured = String(readAgentRoutingConfig().agentUrl ?? '').trim();
    if (configured) return configured;
    try {
        return typeof window !== 'undefined' ? window.location.origin : '';
    } catch {
        return '';
    }
};

const joinUrl = (base: string, path: string): string => `${base.replace(/\/+$/, '')}${path}`;

export function createTravelRuntime(deps: TravelRuntimeDeps = {}) {
    const now = deps.now ?? (() => Date.now());
    const session = deps.session ?? (() => readTravelSession(now()));
    const baseUrl = deps.baseUrl ?? defaultBaseUrl;
    const transport: TravelTransport =
        deps.transport ?? ((url, init) => externalFetch(url, { ...init, route: init.route ?? 'worker' }));
    const api =
        deps.api ??
        createTravelApi({ session: session as () => TravelSession | null, baseUrl, transport, now });
    const store = deps.store ?? createTravelStateStore({ now });

    let stopPolling: (() => void) | null = null;
    let settings: TravelSettings | null = null;
    const contextBlocks = new Map<string, string>();

    // 注意：useSyncExternalStore 要求 getSnapshot 返回稳定引用，所以这里是不可变对象，
    // 只在 open/close 时整体替换（每次新建对象会触发 React 无限重渲染）。
    let overlayState: TravelOverlayState = { open: false, charId: null };
    const overlayListeners = new Set<(s: TravelOverlayState) => void>();
    const emitOverlay = () => {
        for (const fn of overlayListeners) fn({ ...overlayState });
    };

    const request = async (
        path: string,
        init: { method: 'GET' | 'POST' | 'PUT'; body?: unknown; purpose: string },
    ): Promise<TravelRuntimeResult<unknown>> => {
        const base = String(baseUrl() ?? '').trim();
        if (!base) return { ok: false, data: null, code: 'UNAUTHORIZED' };
        // 自动续期：短期 token 过期/快过期就用已保存的配对凭据再换一次，不让用户重输。
        if (!String(session()?.token ?? '').trim() && !readTravelOwnerCredential()) {
            return { ok: false, data: null, code: 'UNAUTHORIZED' };
        }
        if (!String(session()?.token ?? '').trim()) {
            try {
                await ensureTravelSession({ now: now() });
            } catch {
                /* 续期失败按未登录处理 */
            }
        }
        const token = String(session()?.token ?? '').trim();
        if (!token) return { ok: false, data: null, code: 'UNAUTHORIZED' };

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
            res = await transport(joinUrl(base, path), {
                method: init.method,
                headers,
                body,
                route: 'worker',
                purpose: init.purpose,
            } as TravelRequestInit);
        } catch {
            return { ok: false, data: null, code: 'NETWORK' };
        }
        let parsed: unknown = null;
        try {
            parsed = await res.json();
        } catch {
            parsed = null;
        }
        if (!res.ok) {
            const raw = isRecord(parsed)
                ? isRecord(parsed.error)
                    ? parsed.error.code
                    : parsed.code
                : undefined;
            const code = typeof raw === 'string' && ERROR_CODES.has(raw) ? (raw as TravelErrorCode) : 'UNAUTHORIZED';
            return { ok: false, data: null, code };
        }
        if (parsed === null) return { ok: false, data: null, code: 'MALFORMED_RESPONSE' };
        return { ok: true, data: parsed };
    };

    const startPollingFor = (charId: string) => {
        stopPolling?.();
        stopPolling = store.startPolling({ charId, api });
    };

    const stopPollingNow = () => {
        stopPolling?.();
        stopPolling = null;
    };

    return {
        api,
        store,

        overlay: {
            get: (): TravelOverlayState => overlayState,
            subscribe: (fn: (s: TravelOverlayState) => void) => {
                overlayListeners.add(fn);
                return () => overlayListeners.delete(fn);
            },
            open: (charId: string) => {
                overlayState = { open: true, charId };
                emitOverlay();
            },
            close: () => {
                overlayState = { open: false, charId: null };
                emitOverlay();
            },
        },

        /** 读共享位；开启时自动开始轮询（UI 收起也继续，共享本身不因收起结束）。 */
        async refreshShare(charId: string): Promise<boolean> {
            const res = await api.readState(charId);
            if (!res.ok) {
                store.applyShareUnavailable();
                stopPollingNow();
                return false;
            }
            store.applyShare(res.data.share);
            if (res.data.share.shareEnabled) startPollingFor(charId);
            else stopPollingNow();
            return true;
        },

        /** 写共享位（CAS）。成功后才改本地；失败不改。 */
        async setShare(charId: string, enabled: boolean): Promise<{ ok: boolean; code?: TravelApiErrorCode }> {
            const baseVersion = store.getState().shareVersion;
            const res = await api.setShare(charId, enabled, baseVersion);
            if (!res.ok) return { ok: false, code: res.code };
            store.applyShare(res.data);
            if (res.data.shareEnabled) startPollingFor(charId);
            else stopPollingNow();
            return { ok: true };
        },

        polling: { start: startPollingFor, stop: stopPollingNow },

        /** 预算只读视图（读失败两列全关）。 */
        async readBudget(): Promise<TravelBudgetView> {
            return readBudgetView(api);
        },

        /** 地图额度：写服务端同一本账（0 = 暂停），不在这里自己算默认值。 */
        async saveBudgetLimit(limit: number): Promise<{ ok: boolean; code?: TravelApiErrorCode }> {
            const n = Math.trunc(Number(limit));
            if (!Number.isFinite(n) || n < 0) return { ok: false, code: 'BUDGET_BLOCKED' };
            const res = await request(TRAVEL_RUNTIME_ENDPOINTS.budget, {
                method: 'PUT',
                body: { mapCallsLimit: n },
                purpose: '保存地图额度',
            });
            return res.ok ? { ok: true } : { ok: false, code: res.code };
        },

        /** 设置：服务端权威，读不到 known:false。 */
        async readSettings(): Promise<TravelSettingsView> {
            const res = await request(TRAVEL_RUNTIME_ENDPOINTS.settings, {
                method: 'GET',
                purpose: '读取出行设置',
            });
            if (!res.ok) return { known: false, settings: null, error: res.code ?? null };
            const payload = isRecord(res.data) ? res.data.settings : null;
            if (!isSettings(payload)) return { known: false, settings: null, error: 'MALFORMED_RESPONSE' };
            settings = payload;
            return { known: true, settings, error: null };
        },

        /** 保存设置：带 baseVersion，冲突不改本地。 */
        async saveSettings(
            patch: Partial<Omit<TravelSettings, 'version' | 'updatedAt'>>,
            baseVersion: number,
        ): Promise<{ ok: boolean; code?: TravelApiErrorCode }> {
            const res = await request(TRAVEL_RUNTIME_ENDPOINTS.settings, {
                method: 'PUT',
                body: { ...patch, baseVersion },
                purpose: '保存出行设置',
            });
            if (!res.ok) return { ok: false, code: res.code };
            const payload = isRecord(res.data) ? res.data.settings : null;
            if (!isSettings(payload)) return { ok: false, code: 'MALFORMED_RESPONSE' };
            settings = payload;
            return { ok: true };
        },

        /** 内存缓存（刷新页面重新读；不进备份）。 */
        settingsCache: (): TravelSettings | null => settings,

        /**
         * 读地图凭据状态（只有存在性与公开展示 Key）。
         * 读不到就 known:false —— 设置页写「未确认」，不按「未配置」覆盖用户判断。
         */
        async readMapCredentials(): Promise<TravelMapCredentialsView> {
            const res = await request(TRAVEL_RUNTIME_ENDPOINTS.mapCredentials, {
                method: 'GET',
                purpose: '读取地图服务凭据状态',
            });
            if (!res.ok) return { known: false, credentials: null, error: res.code ?? null };
            if (!isMapCredentialView(res.data)) {
                return { known: false, credentials: null, error: 'MALFORMED_RESPONSE' };
            }
            return { known: true, credentials: res.data, error: null };
        },

        /**
         * 保存 / 替换 / 清除。空字段表示「保持不变」，清除必须显式放进 `clear`。
         * 保存动作本身**不发**任何收费的地图请求（测试连接是另一个显式动作）。
         */
        async saveMapCredentials(
            patch: TravelMapCredentialPatch,
        ): Promise<{ ok: boolean; code?: TravelApiErrorCode; credentials?: TravelMapCredentialView }> {
            const res = await request(TRAVEL_RUNTIME_ENDPOINTS.mapCredentials, {
                method: 'PUT',
                body: { ...patch },
                purpose: '保存地图服务凭据',
            });
            if (!res.ok) return { ok: false, code: res.code };
            if (!isMapCredentialView(res.data)) return { ok: false, code: 'MALFORMED_RESPONSE' };
            return { ok: true, credentials: res.data };
        },

        /** 显式测试连接：一次请求、服务端有冷却；返回布尔与错误码，不回显任何 Key。 */
        async testMapConnection(): Promise<{ ok: boolean; code: string }> {
            const res = await request(TRAVEL_RUNTIME_ENDPOINTS.mapCredentialsTest, {
                method: 'POST',
                purpose: '测试地图服务连接',
            });
            if (!res.ok) return { ok: false, code: res.code ?? 'NETWORK' };
            const payload = isRecord(res.data) ? res.data : null;
            return {
                ok: payload?.ok === true,
                code: typeof payload?.code === 'string' ? payload.code : 'PROVIDER_FAILED',
            };
        },

        /** 地址搜索：服务端代理（地图 Key 只在服务端），前端不接触 Web 服务 Key。 */
        async searchAnchor(
            query: string,
            city?: string,
        ): Promise<TravelRuntimeResult<TravelAnchorCandidate[]>> {
            const q = String(query ?? '').trim();
            if (!q) return { ok: true, data: [] };
            const cityParam = String(city ?? '').trim();
            const suffix = cityParam ? `&city=${encodeURIComponent(cityParam)}` : '';
            const res = await request(
                `${TRAVEL_RUNTIME_ENDPOINTS.anchorSearch}?q=${encodeURIComponent(q)}${suffix}`,
                { method: 'GET', purpose: '搜索固定地点' },
            );
            if (!res.ok) return { ok: false, data: null, code: res.code };
            const list = isRecord(res.data) && Array.isArray(res.data.results) ? res.data.results : null;
            if (!list) return { ok: false, data: null, code: 'MALFORMED_RESPONSE' };
            const results = list.filter(
                (item): item is TravelAnchorCandidate =>
                    isRecord(item) && typeof item.label === 'string' && typeof item.city === 'string',
            );
            return { ok: true, data: results };
        },

        /** 读当前固定地点（锚点）。读失败 known:false，不拿城市中心顶。 */
        async readAnchor(): Promise<{ known: boolean; anchor: TravelAnchorView | null; error?: TravelApiErrorCode }> {
            const res = await request(TRAVEL_RUNTIME_ENDPOINTS.anchor, {
                method: 'GET',
                purpose: '读取固定地点',
            });
            if (!res.ok) return { known: false, anchor: null, error: res.code };
            const payload = isRecord(res.data) ? res.data.anchor : null;
            if (payload === null) return { known: true, anchor: null };
            if (!isAnchor(payload)) return { known: false, anchor: null, error: 'MALFORMED_RESPONSE' };
            return { known: true, anchor: payload };
        },

        /**
         * 用服务端搜索结果确认锚点：前端只传不透明 `placeId`，坐标由服务端解析/校验，
         * 保证「住户级门牌」不会因为前端拼字段而落库。
         */
        async confirmAnchorCandidate(
            placeId: string,
            fallback?: { label?: string; city?: string; district?: string },
        ): Promise<{ ok: boolean; code?: TravelApiErrorCode }> {
            const id = String(placeId ?? '').trim();
            if (!id) return { ok: false, code: 'MALFORMED_RESPONSE' };
            const res = await request(TRAVEL_RUNTIME_ENDPOINTS.anchor, {
                method: 'POST',
                body: { placeId: id, ...fallback },
                purpose: '按候选确认固定地点',
            });
            return res.ok ? { ok: true } : { ok: false, code: res.code };
        },

        /** 确认固定地点：只走 placeId（坐标由服务端解析）；没有坐标就不该由前端拼。 */
        async confirmAnchor(anchor: TravelAnchorView): Promise<{ ok: boolean; code?: TravelApiErrorCode }> {
            if (!isAnchor(anchor)) return { ok: false, code: 'MALFORMED_RESPONSE' };
            const res = await request(TRAVEL_RUNTIME_ENDPOINTS.anchor, {
                method: 'POST',
                body: { anchor },
                purpose: '确认固定地点',
            });
            return res.ok ? { ok: true } : { ok: false, code: res.code };
        },

        /** 读角色级启用位（缺行 = 未启用）。 */
        async readCharEnabled(charId: string): Promise<{ known: boolean; enabled: boolean }> {
            const id = String(charId ?? '').trim();
            if (!id) return { known: false, enabled: false };
            const res = await request(
                `${TRAVEL_RUNTIME_ENDPOINTS.char}?charId=${encodeURIComponent(id)}`,
                { method: 'GET', purpose: '读取角色出行开关' },
            );
            if (!res.ok || !isRecord(res.data) || !isRecord(res.data.char)) {
                return { known: false, enabled: false };
            }
            return { known: true, enabled: res.data.char.enabled === true };
        },

        /** 写角色级启用位。 */
        async saveCharEnabled(charId: string, enabled: boolean): Promise<{ ok: boolean; code?: TravelApiErrorCode }> {
            const id = String(charId ?? '').trim();
            if (!id) return { ok: false, code: 'MALFORMED_RESPONSE' };
            const res = await request(TRAVEL_RUNTIME_ENDPOINTS.char, {
                method: 'PUT',
                body: { charId: id, enabled: enabled === true },
                purpose: '保存角色出行开关',
            });
            return res.ok ? { ok: true } : { ok: false, code: res.code };
        },

        /**
         * 角色内部脱敏上下文 → 提示词块。共享关闭也照读（角色知道自己要去哪），
         * 但出参必须是 `buildTravelPromptBlock` 的脱敏结果；形状不对就不注入。
         */
        async refreshContext(charId: string): Promise<boolean> {
            const id = String(charId ?? '').trim();
            if (!id) return false;
            const res = await request(`${TRAVEL_RUNTIME_ENDPOINTS.context}?charId=${encodeURIComponent(id)}`, {
                method: 'GET',
                purpose: '读取角色出行上下文',
            });
            if (!res.ok || !isRecord(res.data)) {
                contextBlocks.delete(id);
                return false;
            }
            const payload = res.data;
            const trip = isRecord(payload.trip) ? payload.trip : null;
            const etaMinutes = trip && isFiniteNumber(trip.etaMinutes) ? trip.etaMinutes : null;
            const built = buildTravelPromptBlock({
                trip: trip
                    ? ({
                          status: String(trip.phase ?? ''),
                          origin: { label: String(trip.originLabel ?? ''), city: '' },
                          dest: trip.destinationLabel
                              ? { label: String(trip.destinationLabel), city: '' }
                              : null,
                      } as never)
                    : undefined,
                shareEnabled: payload.shareEnabled === true,
                shareKnown: payload.shareKnown === true,
                progress: trip
                    ? ({
                          phase: String(trip.phase ?? ''),
                          etaMs: etaMinutes === null ? null : etaMinutes * 60_000,
                      } as never)
                    : null,
                budget:
                    isRecord(payload.budget) &&
                    isFiniteNumber(payload.budget.mapCallsUsed) &&
                    isFiniteNumber(payload.budget.mapCallsLimit)
                        ? {
                              mapCallsUsed: payload.budget.mapCallsUsed,
                              mapCallsLimit: payload.budget.mapCallsLimit,
                          }
                        : null,
            });
            if (!built.ok || !built.text) {
                contextBlocks.delete(id);
                return false;
            }
            contextBlocks.set(id, built.text);
            return true;
        },

        /** 聊天注入用：同步读缓存，没有就返回 null（不在这里发请求、不新增调用）。 */
        promptBlock: (charId: string): string | null => contextBlocks.get(String(charId ?? '').trim()) ?? null,

        /** 预算账本原样（设置页展示；不可信时不展示数字）。 */
        budgetState: (): TravelBudgetState | null => store.getState().view?.budget
            ? {
                  userId: '',
                  dayKey: '',
                  mapCallsUsed: store.getState().view!.budget.mapCallsUsed,
                  mapCallsLimit: store.getState().view!.budget.mapCallsLimit,
                  llmTokensUsed: 0,
                  llmTokensLimit: 0,
                  paused: false,
                  version: 0,
              }
            : null,

        dispose: () => {
            stopPollingNow();
            overlayListeners.clear();
            contextBlocks.clear();
        },
    };
}

export type TravelRuntime = ReturnType<typeof createTravelRuntime>;

let singleton: TravelRuntime | null = null;

/** 默认单例（首次使用时创建，模块 import 不产生网络/存储副作用）。 */
export function getTravelRuntime(): TravelRuntime {
    if (!singleton) singleton = createTravelRuntime();
    return singleton;
}

/** 仅测试：丢弃单例。 */
export function resetTravelRuntimeForTests(): void {
    singleton?.dispose();
    singleton = null;
}
