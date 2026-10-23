/**
 * 出行 · 固定地点的检索与「不透明 placeId」解析
 *
 * 前端只允许传 `placeId`（一个短期签名的、含坐标的令牌），**不传坐标**：
 * - 坐标由服务端在确认锚点时解析并落库，前端拿到的一直只有地名语义；
 * - 令牌是 HMAC 签的，改一个字节就失效；TTL 15 分钟；
 * - **它是完整性签名，不是加密**：payload 是 base64url，拿到的人可以解出坐标。
 *   所以它的安全边界只有三条 —— 短期（15 分钟）、绑定本服务端密钥、只发回**本人**的
 *   配置界面；它**不得**进入模型上下文、日志、推送、备份或任何第三方请求。
 *   需要真正的不可读索引时，得改成服务端短期随机 id（一次性存表），本轮没做。
 * - 检索本身是一次真实 POI 请求 → 走同一本地图预算（`reserveMapCall`），
 *   没有额度就不请求上游，绝不返回伪造候选。
 *
 * 本模块不持有 Key：provider 由调用方注入（服务端 Key 只在 worker 里）。
 */

import type { TravelPlaceRef } from '../../../../contracts/travel';
import { TravelProviderError, type TravelMapProvider } from './provider';

export const TRAVEL_PLACE_TOKEN_TTL_MS = 15 * 60_000;
const TOKEN_LABEL = 'sullyos-travel-place-v1';

const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (text: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  try {
    const binary = atob(padded + pad);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};

const sign = async (secret: string, payload: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${TOKEN_LABEL}.${payload}`))));
};

interface PlaceTokenPayload {
  label: string;
  city: string;
  district?: string;
  lat: number;
  lng: number;
  coordSys: string;
  exp: number;
}

export interface TravelPlaceToken {
  placeId: string;
  label: string;
  city: string;
  district?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** 签一个地点令牌。密钥太短 → null（调用方据此不提供搜索，而不是退化成无签名）。 */
export async function signPlaceToken(
  place: { label: string; city: string; district?: string; lat: number; lng: number; coordSys: string },
  input: { secret: string; nowMs: number; ttlMs?: number },
): Promise<string | null> {
  const secret = (input.secret ?? '').trim();
  if (secret.length < 32) return null;
  const ttl = Math.min(Math.max(Math.trunc(input.ttlMs ?? TRAVEL_PLACE_TOKEN_TTL_MS), 30_000), TRAVEL_PLACE_TOKEN_TTL_MS);
  const payload: PlaceTokenPayload = {
    label: place.label.slice(0, 80),
    city: place.city.slice(0, 40),
    ...(place.district ? { district: place.district.slice(0, 40) } : {}),
    lat: place.lat,
    lng: place.lng,
    coordSys: place.coordSys,
    exp: Math.trunc(input.nowMs) + ttl,
  };
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await sign(secret, body);
  return `${body}.${signature}`;
}

export async function resolvePlaceToken(
  placeId: string,
  input: { secret: string; nowMs: number },
): Promise<TravelPlaceRef | null> {
  const secret = (input.secret ?? '').trim();
  if (secret.length < 32) return null;
  const parts = String(placeId ?? '').split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  const expected = await sign(secret, body);
  if (expected.length !== signature.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (diff !== 0) return null;
  const bytes = fromBase64Url(body);
  if (!bytes) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp <= input.nowMs) return null;
  const lat = Number(payload.lat);
  const lng = Number(payload.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const label = typeof payload.label === 'string' ? payload.label.trim() : '';
  const city = typeof payload.city === 'string' ? payload.city.trim() : '';
  if (!label || !city) return null;
  return {
    label,
    city,
    ...(typeof payload.district === 'string' && payload.district.trim() ? { district: payload.district.trim() } : {}),
    lat,
    lng,
    ...(payload.coordSys === 'wgs84' || payload.coordSys === 'gcj02' ? { coordSys: payload.coordSys } : {}),
    kind: 'anchor',
  };
}

export interface AnchorSearchInput {
  q: string;
  city?: string;
  charId: string;
}

export interface AnchorSearchPort {
  search(input: AnchorSearchInput): Promise<TravelPlaceToken[]>;
  resolve(placeId: string): Promise<TravelPlaceRef | null>;
}

/**
 * 生产端口：检索走注入的 provider（高德/Mapbox），令牌在这里签。
 * provider 为 null（没配 Key / 地区不支持）时搜索返回空数组 —— 前端显示「暂不可搜索」。
 */
export function createAnchorSearchPort(input: {
  provider: TravelMapProvider | null;
  secret: string;
  now: () => number;
}): AnchorSearchPort {
  return {
    async search({ q, city }) {
      const provider = input.provider;
      if (!provider || !q.trim()) return [];
      const hits = await provider.searchCandidates({
        wishText: q.trim(),
        city: city ?? '',
        limit: 8,
      });
      const out: TravelPlaceToken[] = [];
      for (const hit of hits) {
        const placeId = await signPlaceToken(
          {
            label: hit.label,
            city: hit.city ?? city ?? '',
            ...(hit.district ? { district: hit.district } : {}),
            lat: hit.location.lat,
            lng: hit.location.lng,
            coordSys: hit.location.coordSys,
          },
          { secret: input.secret, nowMs: input.now() },
        );
        if (!placeId) {
          throw new TravelProviderError({
            kind: 'not-configured',
            code: 'PROVIDER_FAILED',
            provider: provider.id,
          });
        }
        if (!hit.city && !city) continue;
        out.push({
          placeId,
          label: hit.label,
          city: hit.city ?? city ?? '',
          ...(hit.district ? { district: hit.district } : {}),
        });
      }
      return out;
    },
    resolve(placeId) {
      return resolvePlaceToken(placeId, { secret: input.secret, nowMs: input.now() });
    },
  };
}
