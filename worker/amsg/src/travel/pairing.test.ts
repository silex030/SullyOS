import { describe, expect, it } from 'vitest';
import {
  approvePairRequest,
  claimPairRequest,
  createMemoryPairStore,
  createPairRequest,
  formatPairCode,
  readPairStatus,
  TRAVEL_PAIR_MAX_ATTEMPTS,
  TRAVEL_PAIR_RATE_MAX,
  TRAVEL_PAIR_REQUEST_TTL_MS,
} from './pairing';

const NOW = 1_760_000_000_000;

const make = async (ipHash: string | null = 'ip-1') => {
  const store = createMemoryPairStore();
  const created = await createPairRequest({ store, nowMs: NOW, ipHash });
  if (!created.ok) throw new Error('unexpected rate limit');
  return { store, request: created.request };
};

describe('travel pairing request', () => {
  it('发起申请不接受客户端 userId，返回与账号无关的短码与浏览器凭证', async () => {
    const { store, request } = await make();
    expect(request.requestId.length).toBeGreaterThanOrEqual(20);
    expect(request.code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
    expect(request.codeDisplay).toBe(formatPairCode(request.code));
    expect(request.clientSecret.length).toBeGreaterThanOrEqual(20);
    const row = store.rows.get(request.requestId)!;
    // 库里只有哈希：短码与浏览器凭证的明文都不能落库。
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.clientHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.codeHash).not.toContain(request.code);
    expect(row.status).toBe('pending');
    expect(row.userId).toBeNull();
    expect(row.expiresAt).toBe(NOW + TRAVEL_PAIR_REQUEST_TTL_MS);
  });

  it('同一来源短时间刷申请会被限流', async () => {
    const store = createMemoryPairStore();
    for (let i = 0; i < TRAVEL_PAIR_RATE_MAX; i += 1) {
      const r = await createPairRequest({ store, nowMs: NOW + i, ipHash: 'ip-1' });
      expect(r.ok).toBe(true);
    }
    const blocked = await createPairRequest({ store, nowMs: NOW + 10, ipHash: 'ip-1' });
    expect(blocked).toEqual({ ok: false, code: 'RATE_LIMITED' });
    // 换来源不受同一窗口影响
    const other = await createPairRequest({ store, nowMs: NOW + 11, ipHash: 'ip-2' });
    expect(other.ok).toBe(true);
  });

  it('状态查询必须带同一浏览器的 clientSecret，不能凭 requestId 窥探', async () => {
    const { store, request } = await make();
    expect((await readPairStatus({ store, nowMs: NOW + 1, requestId: request.requestId, clientSecret: 'wrong-secret' })).status)
      .toBe('invalid');
    expect((await readPairStatus({ store, nowMs: NOW + 1, requestId: request.requestId, clientSecret: request.clientSecret })).status)
      .toBe('pending');
  });

  it('未批准时认领失败，且不会顺带签发 owner 密钥', async () => {
    const { store, request } = await make();
    const result = await claimPairRequest({
      store,
      nowMs: NOW + 1,
      requestId: request.requestId,
      code: request.code,
      clientSecret: request.clientSecret,
    });
    expect(result).toEqual({ ok: false, code: 'NOT_APPROVED' });
  });

  it('管理员批准时绑定的是管理员给出的 userId，认领只得到该用户；不能跨账号', async () => {
    const { store, request } = await make();
    // 客户端不能自带 userId：批准接口由本机脚本调用，userId 由管理员决定。
    expect(await approvePairRequest({ store, nowMs: NOW + 1, requestId: request.requestId, userId: 'user-a' }))
      .toEqual({ ok: true, userId: 'user-a' });
    const claimed = await claimPairRequest({
      store,
      nowMs: NOW + 2,
      requestId: request.requestId,
      code: request.code,
      clientSecret: request.clientSecret,
    });
    expect(claimed.ok).toBe(true);
    if (claimed.ok) {
      expect(claimed.userId).toBe('user-a');
      expect(claimed.ownerKey.length).toBeGreaterThanOrEqual(32);
    }
    // 另一个申请绝不可能认领到 user-a 的绑定
    const second = await createPairRequest({ store, nowMs: NOW + 3, ipHash: 'ip-2' });
    if (!second.ok) throw new Error('unexpected');
    await approvePairRequest({ store, nowMs: NOW + 4, requestId: second.request.requestId, userId: 'user-b' });
    const claimedB = await claimPairRequest({
      store,
      nowMs: NOW + 5,
      requestId: second.request.requestId,
      code: second.request.code,
      clientSecret: second.request.clientSecret,
    });
    expect(claimedB.ok && claimedB.userId).toBe('user-b');
  });

  it('短码错误会计数，超过上限后即使短码正确也拒绝', async () => {
    const { store, request } = await make();
    await approvePairRequest({ store, nowMs: NOW + 1, requestId: request.requestId, userId: 'user-a' });
    for (let i = 0; i < TRAVEL_PAIR_MAX_ATTEMPTS; i += 1) {
      const r = await claimPairRequest({
        store,
        nowMs: NOW + 2,
        requestId: request.requestId,
        code: 'AAAAAAAA',
        clientSecret: request.clientSecret,
      });
      expect(r).toEqual({ ok: false, code: 'CODE_INVALID' });
    }
    const blocked = await claimPairRequest({
      store,
      nowMs: NOW + 3,
      requestId: request.requestId,
      code: request.code,
      clientSecret: request.clientSecret,
    });
    expect(blocked).toEqual({ ok: false, code: 'TOO_MANY_ATTEMPTS' });
  });

  it('过期请求不能批准也不能认领', async () => {
    const { store, request } = await make();
    const after = NOW + TRAVEL_PAIR_REQUEST_TTL_MS + 1;
    expect(await approvePairRequest({ store, nowMs: after, requestId: request.requestId, userId: 'user-a' }))
      .toEqual({ ok: false, code: 'EXPIRED' });
    const claim = await claimPairRequest({
      store,
      nowMs: after,
      requestId: request.requestId,
      code: request.code,
      clientSecret: request.clientSecret,
    });
    expect(claim).toEqual({ ok: false, code: 'EXPIRED' });
  });

  it('认领是一次性的：重放同一短码不会二次签发', async () => {
    const { store, request } = await make();
    await approvePairRequest({ store, nowMs: NOW + 1, requestId: request.requestId, userId: 'user-a' });
    const first = await claimPairRequest({
      store,
      nowMs: NOW + 2,
      requestId: request.requestId,
      code: request.code,
      clientSecret: request.clientSecret,
    });
    expect(first.ok).toBe(true);
    const replay = await claimPairRequest({
      store,
      nowMs: NOW + 3,
      requestId: request.requestId,
      code: request.code,
      clientSecret: request.clientSecret,
    });
    expect(replay).toEqual({ ok: false, code: 'ALREADY_CLAIMED' });
  });

  it('别的浏览器拿到 requestId 与短码也无法认领（clientSecret 不匹配）', async () => {
    const { store, request } = await make();
    await approvePairRequest({ store, nowMs: NOW + 1, requestId: request.requestId, userId: 'user-a' });
    const stolen = await claimPairRequest({
      store,
      nowMs: NOW + 2,
      requestId: request.requestId,
      code: request.code,
      clientSecret: 'attacker-secret',
    });
    expect(stolen).toEqual({ ok: false, code: 'INVALID_REQUEST' });
  });

  it('非法 userId 不允许批准', async () => {
    const { store, request } = await make();
    for (const bad of ['', '  ', 'a b', 'x'.repeat(129)]) {
      expect((await approvePairRequest({ store, nowMs: NOW + 1, requestId: request.requestId, userId: bad })).ok)
        .toBe(false);
    }
  });
});
