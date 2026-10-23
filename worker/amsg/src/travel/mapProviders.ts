/**
 * 出行 · 地图 provider 的凭据装配
 *
 * 顺序固定：**用户自己保存的加密凭据优先**；worker 级 env（`AMAP_WEB_KEY` /
 * `MAPBOX_TOKEN`）只有在运维显式设置 `TRAVEL_MAP_ENV_FALLBACK=allow` 时才作为兼容
 * 兜底参与。默认不看 env —— 否则「用户在设置里清除了 Key」会神秘地继续可用，
 * 而且老 env 里的失效 Key 会被当成「已配置」。
 */
import { createAmapProvider } from './providerAmap';
import { createWorldProvider } from './providerWorld';
import type { TravelMapProvider, TravelProviderDeps } from './provider';
import type { TravelMapCredentialValues } from './mapCredentials';

export interface TravelMapProviderKeys {
  amapWebKey: string;
  mapboxToken: string;
}

export interface ResolveTravelMapProviderKeysInput {
  /** 服务端已解密的用户凭据；null = 没配 / 解不开。 */
  userCredentials: Partial<Pick<TravelMapCredentialValues, 'amapWebKey' | 'mapboxToken'>> | null;
  env: { AMAP_WEB_KEY?: string; MAPBOX_TOKEN?: string; TRAVEL_MAP_ENV_FALLBACK?: string } | null | undefined;
  nowMs?: number;
}

const envFallbackAllowed = (env: ResolveTravelMapProviderKeysInput['env']): boolean =>
  String(env?.TRAVEL_MAP_ENV_FALLBACK ?? '').trim().toLowerCase() === 'allow';

/** 纯函数：优先级与兼容开关都在这里，provider 自己不知道凭据从哪来。 */
export function resolveTravelMapProviderKeys(input: ResolveTravelMapProviderKeysInput): TravelMapProviderKeys {
  const userWeb = String(input.userCredentials?.amapWebKey ?? '').trim();
  const userMapbox = String(input.userCredentials?.mapboxToken ?? '').trim();
  const allowed = envFallbackAllowed(input.env);
  const envWeb = allowed ? String(input.env?.AMAP_WEB_KEY ?? '').trim() : '';
  const envMapbox = allowed ? String(input.env?.MAPBOX_TOKEN ?? '').trim() : '';
  return {
    amapWebKey: userWeb || envWeb,
    mapboxToken: userMapbox || envMapbox,
  };
}

/** 造两套实现（国内高德 / 国外 Mapbox）。缺 Key 的实现在 resolveKey 里返回 null。 */
export function createTravelMapProviders(
  keys: TravelMapProviderKeys,
  deps: TravelProviderDeps,
): TravelMapProvider[] {
  const amapKey = keys.amapWebKey.trim();
  const mapboxToken = keys.mapboxToken.trim();
  return [
    createAmapProvider({ resolveKey: () => amapKey || null }, deps),
    createWorldProvider({ resolveToken: () => mapboxToken || null }, deps),
  ];
}
