/**
 * 首次连接 · 浏览器侧申请/轮询/认领
 *
 * 端点都是同源相对路径（Caddy → amsg worker）。安全约束：
 * - 申请体为空，**不带 userId**：账号绑定只能由管理员本机批准；
 * - `clientSecret` 证明认领来自发起申请的同一个浏览器，只放内存 + sessionStorage，
 *   不进 localStorage（因此不进备份）、不进 URL；
 * - owner 密钥只在 claim 响应体里出现一次，调用方立即交给 session.ts 保存，日志不落。
 */

export interface PairRequestState {
  requestId: string;
  code: string;
  clientSecret: string;
  expiresAt: number;
}

export type PairStatus = 'pending' | 'approved' | 'claimed' | 'expired' | 'invalid';

export interface PairClientDeps {
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  /** 默认 sessionStorage；注入用。 */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

const STORAGE_KEY = 'travel.pair.v1';

const resolveFetch = (deps: PairClientDeps) =>
  deps.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));

const resolveStorage = (deps: PairClientDeps): PairClientDeps['storage'] => {
  if (deps.storage !== undefined) return deps.storage;
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
};

const readStored = (deps: PairClientDeps): PairRequestState | null => {
  const storage = resolveStorage(deps);
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PairRequestState>;
    if (typeof parsed.requestId !== 'string' || typeof parsed.code !== 'string'
      || typeof parsed.clientSecret !== 'string' || typeof parsed.expiresAt !== 'number') return null;
    return parsed as PairRequestState;
  } catch {
    return null;
  }
};

const store = (deps: PairClientDeps, state: PairRequestState | null): void => {
  const storage = resolveStorage(deps);
  if (!storage) return;
  try {
    if (state) storage.setItem(STORAGE_KEY, JSON.stringify(state));
    else storage.removeItem(STORAGE_KEY);
  } catch { /* 存不下就只用内存态 */ }
};

export async function requestPairCode(
  deps: PairClientDeps = {},
): Promise<{ ok: true; state: PairRequestState } | { ok: false; code: string }> {
  const res = await resolveFetch(deps)('/travel/pair/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    credentials: 'same-origin',
  }).catch(() => null);
  if (!res) return { ok: false, code: 'NETWORK' };
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: { code?: string } } | null;
    return { ok: false, code: body?.error?.code ?? `HTTP_${res.status}` };
  }
  const body = await res.json().catch(() => null) as { request?: Partial<PairRequestState> } | null;
  const request = body?.request;
  if (!request || typeof request.requestId !== 'string' || typeof request.code !== 'string'
    || typeof request.clientSecret !== 'string' || typeof request.expiresAt !== 'number') {
    return { ok: false, code: 'MALFORMED_RESPONSE' };
  }
  const state: PairRequestState = {
    requestId: request.requestId,
    code: request.code,
    clientSecret: request.clientSecret,
    expiresAt: request.expiresAt,
  };
  store(deps, state);
  return { ok: true, state };
}

export async function readPairStatus(
  state: PairRequestState,
  deps: PairClientDeps = {},
): Promise<{ status: PairStatus }> {
  const res = await resolveFetch(deps)('/travel/pair/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: state.requestId, clientSecret: state.clientSecret }),
    credentials: 'same-origin',
  }).catch(() => null);
  if (!res || !res.ok) return { status: 'invalid' };
  const body = await res.json().catch(() => null) as { status?: PairStatus } | null;
  const status = body?.status;
  return {
    status: status === 'pending' || status === 'approved' || status === 'claimed'
      || status === 'expired' || status === 'invalid' ? status : 'invalid',
  };
}

export async function claimPairCode(
  state: PairRequestState,
  deps: PairClientDeps = {},
): Promise<{ ok: true; userId: string; ownerKey: string } | { ok: false; code: string }> {
  const res = await resolveFetch(deps)('/travel/pair/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId: state.requestId,
      code: state.code,
      clientSecret: state.clientSecret,
    }),
    credentials: 'same-origin',
  }).catch(() => null);
  if (!res) return { ok: false, code: 'NETWORK' };
  const body = await res.json().catch(() => null) as {
    credential?: { userId?: string; ownerKey?: string };
    error?: { code?: string };
  } | null;
  if (!res.ok) return { ok: false, code: body?.error?.code ?? `HTTP_${res.status}` };
  const credential = body?.credential;
  if (!credential || typeof credential.userId !== 'string' || typeof credential.ownerKey !== 'string') {
    return { ok: false, code: 'MALFORMED_RESPONSE' };
  }
  store(deps, null);
  return { ok: true, userId: credential.userId, ownerKey: credential.ownerKey };
}

/** 设置页重开时恢复未完成的申请（同标签页），换标签页不复活。 */
export function readPendingPairRequest(deps: PairClientDeps = {}): PairRequestState | null {
  const pending = readStored(deps);
  if (!pending) return null;
  const now = deps.now ? deps.now() : Date.now();
  if (pending.expiresAt <= now) {
    store(deps, null);
    return null;
  }
  return pending;
}
