/**
 * 出行 · 地图运行期配置（服务端凭据优先，构建期 env 只作未登录时的兜底）
 *
 * 以前面板只读 `import.meta.env` 里的 `VITE_AMAP_JS_KEY`：用户想换 Key 就得重构建，
 * 而且和「设置页能填」自相矛盾。现在：
 *
 * - 已登录且服务端有答案 → **完全以服务端为准**（用户清除后不会又冒出 env 里的旧 Key）；
 * - 服务端读不到（未登录 / 断网 / 老部署）→ 才用构建期 env 的值，并明确标 `source:'env'`；
 * - 结果只放**内存缓存**：不进 localStorage / IndexedDB / 备份，刷新页面重新取；
 * - serviceHost 是服务端签发的短期代理地址，jscode 只存在服务端。
 */
import { readTravelMapConfig, type TravelMapRuntimeConfig } from './worldMapAdapter';
import type { TravelMapCredentialView, TravelRuntime } from './runtime';

export type TravelMapConfigSource = 'server' | 'env';

export interface TravelMapRuntimeState {
    config: TravelMapRuntimeConfig;
    source: TravelMapConfigSource;
    /** 服务端是否确实答复过（决定设置页文案：未确认 ≠ 未配置）。 */
    known: boolean;
    updatedAt: number | null;
}

let cache: TravelMapRuntimeState | null = null;

/** 仅测试用：清掉进程内缓存。 */
export function resetTravelMapRuntimeCacheForTesting(): void {
    cache = null;
}

/**
 * 纯函数：把服务端凭据视图合成为地图运行期配置。
 * 许可（geometry / basemap 授权）**不**受这里影响，仍来自 env。
 */
export function composeTravelMapConfig(
    base: TravelMapRuntimeConfig,
    view: TravelMapCredentialView | null,
): TravelMapRuntimeConfig {
    if (!view) return base;
    const jsKey = (view.amapJsKey ?? '').trim();
    const serviceHost = (view.serviceHost ?? '').trim();
    const mapboxToken = (view.mapboxToken ?? '').trim();
    const mapboxStyle = (view.mapboxStyleUrl ?? '').trim() || base.world?.styleUrl || '';
    return {
        ...base,
        amapJsKey: jsKey || null,
        amapServiceHost: serviceHost || null,
        world: mapboxToken && mapboxStyle ? { token: mapboxToken, styleUrl: mapboxStyle } : null,
    };
}

export interface LoadTravelMapRuntimeOptions {
    runtime: Pick<TravelRuntime, 'readMapCredentials'>;
    /** 注入构建期配置（单测）；默认读 `import.meta.env`。 */
    envConfig?: TravelMapRuntimeConfig;
    /** 强制刷新。 */
    force?: boolean;
}

/**
 * 读运行期地图配置。并发调用共享同一个 in-flight Promise（面板 + 设置页同时开会打两次
 * 服务端，没必要）。
 */
let inflight: Promise<TravelMapRuntimeState> | null = null;

export async function loadTravelMapRuntime(
    options: LoadTravelMapRuntimeOptions,
): Promise<TravelMapRuntimeState> {
    if (cache && !options.force) return cache;
    if (inflight && !options.force) return inflight;
    const base = options.envConfig ?? readTravelMapConfig();
    inflight = (async (): Promise<TravelMapRuntimeState> => {
        let view: TravelMapCredentialView | null = null;
        let known = false;
        try {
            const res = await options.runtime.readMapCredentials();
            known = res.known;
            view = res.known ? res.credentials : null;
        } catch {
            known = false;
            view = null;
        }
        const state: TravelMapRuntimeState = {
            config: composeTravelMapConfig(base, view),
            source: view ? 'server' : 'env',
            known,
            updatedAt: view?.updatedAt ?? null,
        };
        cache = state;
        return state;
    })();
    try {
        return await inflight;
    } finally {
        inflight = null;
    }
}

/** 同步兜底（首帧用）：只给 env 值，别拿它判断「已配置」。 */
export function peekTravelMapRuntime(envConfig: TravelMapRuntimeConfig = readTravelMapConfig()): TravelMapRuntimeState {
    return cache ?? { config: envConfig, source: 'env', known: false, updatedAt: null };
}
