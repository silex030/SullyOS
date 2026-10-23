/**
 * 高德 JS API 2.0 正式加载器（B5 · 展示面）
 *
 * 只做一件事：按官方要求把 `https://webapi.amap.com/maps?v=2.0&key=...` 加载进来，
 * 并在**脚本进 DOM 之前**写好 `window._AMapSecurityConfig.serviceHost`。
 *
 * 硬约定（依据 `docs/travel-contract.md` 与 `scratch/travel-provider-handoff.md` §1）：
 * - 只支持「代理服务器转发」方案：`serviceHost` 必须以 `/_AMapService` 结尾
 *   （官方原文：该前缀「不可省略或修改」，「必须是在 JS API 脚本加载之前进行设置」）；
 * - **永不在前端写 `securityJsCode`**：那等于把安全密钥打进 bundle，走的是明文方案；
 * - 缺 key / 缺代理 / 脚本失败 / 超时一律抛带码错误，由 UI 显示「地图暂不可用」，
 *   本文件不生成任何 canvas / SVG / 占位底图，也不做「加载失败就画折线」的降级；
 * - 不读 localStorage、不落盘、不缓存底图（协议 3.5：不存储/缓存服务数据）。
 *
 * env 可注入是为了在 Node 里单测「配置先于脚本」这条顺序，不依赖真浏览器。
 */
export const AMAP_JS_VERSION = '2.0';
export const AMAP_JS_ORIGIN = 'https://webapi.amap.com';
export const AMAP_SCRIPT_ID = 'sullyos-amap-js-v2';
/** 官方固定前缀，不可省略或改名。 */
export const AMAP_SERVICE_PREFIX = '/_AMapService';
export const DEFAULT_LOAD_TIMEOUT_MS = 12_000;

export type AmapLoadErrorCode =
    | 'MISSING_KEY'
    | 'NO_SECURITY_CONFIG'
    | 'INVALID_SERVICE_HOST'
    | 'SCRIPT_ERROR'
    | 'TIMEOUT'
    | 'NO_AMAP_GLOBAL'
    | 'NO_DOM';

export class AmapLoadError extends Error {
    readonly code: AmapLoadErrorCode;

    constructor(code: AmapLoadErrorCode, message: string) {
        super(message);
        this.name = 'AmapLoadError';
        this.code = code;
    }
}

/** 官方安全配置形态：只允许 serviceHost（明文 securityJsCode 不在此列）。 */
export interface AmapSecurityConfig {
    serviceHost: string;
}

/** 已加载的高德命名空间。仓库不打包 SDK，所以只约束用到的那几个构造器。 */
export interface AmapNamespace {
    Map: new (container: HTMLElement, options?: Record<string, unknown>) => AmapMapLike;
    Marker?: new (options?: Record<string, unknown>) => AmapOverlayLike;
    Polyline?: new (options?: Record<string, unknown>) => AmapOverlayLike;
    Pixel?: new (x: number, y: number) => unknown;
    [key: string]: unknown;
}

export interface AmapMapLike {
    destroy?: () => void;
    add?: (overlay: unknown) => void;
    remove?: (overlay: unknown) => void;
    setZoomAndCenter?: (zoom: number, center: [number, number]) => void;
    setCenter?: (center: [number, number]) => void;
    setFitView?: (overlays?: unknown[]) => void;
    on?: (event: string, handler: () => void) => void;
    [key: string]: unknown;
}

export interface AmapOverlayLike {
    setPosition?: (position: [number, number]) => void;
    setPath?: (path: Array<[number, number]>) => void;
    show?: () => void;
    hide?: () => void;
    [key: string]: unknown;
}

export interface AmapScriptElementLike {
    id: string;
    src: string;
    async: boolean;
    onload: (() => void) | null;
    onerror: ((event?: unknown) => void) | null;
    remove?: () => void;
}

export interface AmapLoaderDocument {
    getElementById(id: string): AmapScriptElementLike | null;
    createElement(tag: 'script'): AmapScriptElementLike;
    head: { appendChild(node: AmapScriptElementLike): unknown };
}

export interface AmapLoaderWindow {
    AMap?: unknown;
    _AMapSecurityConfig?: AmapSecurityConfig;
}

export interface AmapLoaderEnv {
    window: AmapLoaderWindow;
    document: AmapLoaderDocument;
}

export interface LoadAmapJsOptions {
    key?: string | null;
    /** 同源反代地址，形如 `/_AMapService`；只在服务端注入 jscode。 */
    serviceHost?: string | null;
    version?: string;
    timeoutMs?: number;
    env?: AmapLoaderEnv;
}

/** 脚本地址（key 只来自宿主配置，不从任何存储读）。 */
export const buildAmapScriptUrl = (input: { key: string; version?: string }): string =>
    `${AMAP_JS_ORIGIN}/maps?v=${encodeURIComponent(input.version ?? AMAP_JS_VERSION)}&key=${encodeURIComponent(
        input.key,
    )}`;

/**
 * 归一化 serviceHost：接受同源 `/_AMapService`、绝对 `https://host/_AMapService`，
 * 以及带**短期签名会话**的 `.../_AMapService/t/<token>`（SDK 跨脚本带不了 Bearer，
 * 租户与过期时间都在 token 里，官方前缀不变）。
 * 返回 null 表示「不合法」，调用方应判不可用，而不是猜一个能用的前缀。
 */
export const normalizeServiceHost = (raw: string | null | undefined): string | null => {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return null;
    const withoutTrailing = value.replace(/\/+$/, '');
    if (!withoutTrailing) return null;
    const tokenSuffix = /\/_AMapService\/t\/([A-Za-z0-9_.-]{16,512})$/.exec(withoutTrailing);
    if (tokenSuffix) {
        const base = withoutTrailing.slice(0, tokenSuffix.index ?? 0);
        // 只允许同源路径或单一 https 主机的绝对地址；不放 http、不放协议相对。
        if (base === '') return withoutTrailing;
        if (base.startsWith('/') && !base.startsWith('//')) return withoutTrailing;
        if (/^https:\/\/[^\s/]+$/.test(base)) return withoutTrailing;
        return null;
    }
    if (!withoutTrailing.endsWith(AMAP_SERVICE_PREFIX)) return null;
    if (withoutTrailing === AMAP_SERVICE_PREFIX) return AMAP_SERVICE_PREFIX;
    // 允许 https://host/_AMapService 与 /_AMapService；其余（协议、相对路径）一律拒。
    if (withoutTrailing.startsWith('/') && !withoutTrailing.startsWith('//')) return withoutTrailing;
    if (/^https:\/\/[^\s/]+\/_AMapService$/.test(withoutTrailing)) return withoutTrailing;
    return null;
};

/** 安全配置对象。serviceHost 不合法 → null（绝不退回明文 securityJsCode）。 */
export const buildAmapSecurityConfig = (serviceHost: string | null | undefined): AmapSecurityConfig | null => {
    const host = normalizeServiceHost(serviceHost);
    return host ? { serviceHost: host } : null;
};

/** 判定「这台设备上能不能真的出图」。 */
export const isAmapAvailable = (key: string | null | undefined, serviceHost: string | null | undefined): boolean =>
    Boolean((key ?? '').trim()) && normalizeServiceHost(serviceHost) !== null;

const resolveEnv = (injected?: AmapLoaderEnv): AmapLoaderEnv | null => {
    if (injected) return injected;
    if (typeof window === 'undefined' || typeof document === 'undefined') return null;
    return {
        window: window as unknown as AmapLoaderWindow,
        document: document as unknown as AmapLoaderDocument,
    };
};

interface InflightEntry {
    signature: string;
    promise: Promise<AmapNamespace>;
}

let inflight: InflightEntry | null = null;
let cached: { signature: string; namespace: AmapNamespace } | null = null;

const signatureOf = (key: string, serviceHost: string): string => `${key}@${serviceHost}`;

/** 单测 / 热重载用：清掉进程内缓存，下一次调用重新挂脚本。 */
export const resetAmapJsLoader = (): void => {
    inflight = null;
    cached = null;
};

/**
 * 加载官方 JS API。成功 resolve 高德命名空间；任何不可用都 reject `AmapLoadError`。
 * 并发调用共用同一个脚本与 promise（同一个 signature）。
 */
export const loadAmapJs = (options: LoadAmapJsOptions): Promise<AmapNamespace> => {
    const key = (options.key ?? '').trim();
    if (!key) {
        return Promise.reject(
            new AmapLoadError('MISSING_KEY', '未配置高德 JS API Key，地图展示不可用'),
        );
    }

    const rawHost = options.serviceHost;
    if (!String(rawHost ?? '').trim()) {
        return Promise.reject(
            new AmapLoadError(
                'NO_SECURITY_CONFIG',
                `缺少同源安全代理（${AMAP_SERVICE_PREFIX}），地图展示不可用`,
            ),
        );
    }
    const serviceHost = normalizeServiceHost(rawHost);
    if (!serviceHost) {
        return Promise.reject(
            new AmapLoadError(
                'INVALID_SERVICE_HOST',
                `安全代理地址不合法：必须以 ${AMAP_SERVICE_PREFIX} 结尾`,
            ),
        );
    }

    const env = resolveEnv(options.env);
    if (!env) {
        return Promise.reject(new AmapLoadError('NO_DOM', '当前环境没有 DOM，无法加载地图脚本'));
    }

    const signature = signatureOf(key, serviceHost);
    if (cached && cached.signature === signature) return Promise.resolve(cached.namespace);
    if (inflight && inflight.signature === signature) return inflight.promise;

    const promise = new Promise<AmapNamespace>((resolve, reject) => {
        const existing = (() => {
            try {
                return env.document.getElementById(AMAP_SCRIPT_ID);
            } catch {
                return null;
            }
        })();

        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (inflight && inflight.promise === promise) inflight = null;
            fn();
        };

        const failWith = (code: AmapLoadErrorCode, message: string) => {
            settle(() => {
                try {
                    existing?.remove?.();
                } catch {
                    // 清理失败不影响错误语义
                }
                reject(new AmapLoadError(code, message));
            });
        };

        // 1) 安全配置先落 window：官方要求脚本加载之前设置，否则设置无效。
        env.window._AMapSecurityConfig = { serviceHost };

        // 2) 已经加载过（热重载 / 二次挂载）就直接复用全局命名空间。
        if (env.window.AMap) {
            const namespace = env.window.AMap as AmapNamespace;
            cached = { signature, namespace };
            settle(() => resolve(namespace));
            return;
        }

        const script =
            existing ??
            (() => {
                const el = env.document.createElement('script');
                el.id = AMAP_SCRIPT_ID;
                el.src = buildAmapScriptUrl({ key, version: options.version });
                el.async = true;
                return el;
            })();

        script.onload = () => {
            const namespace = env.window.AMap as AmapNamespace | undefined;
            if (!namespace) {
                failWith('NO_AMAP_GLOBAL', '地图脚本已加载，但没有拿到 AMap 命名空间');
                return;
            }
            cached = { signature, namespace };
            settle(() => resolve(namespace));
        };
        script.onerror = () => {
            failWith('SCRIPT_ERROR', '地图脚本加载失败（网络或域名白名单），可稍后重试');
        };

        if (!existing) {
            try {
                env.document.head.appendChild(script);
            } catch {
                failWith('SCRIPT_ERROR', '地图脚本无法插入页面');
                return;
            }
        }

        const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : DEFAULT_LOAD_TIMEOUT_MS;
        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                failWith('TIMEOUT', '地图脚本加载超时，稍后再试');
            }, timeoutMs);
        }
    });

    inflight = { signature, promise };
    return promise;
};
