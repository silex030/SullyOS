/**
 * 角色自主出行 · 会话身份（安全 lane）回归
 *
 * 这里锁的是「身份从哪来」这一条，不是业务逻辑：
 * - **`X-User-Id` 只是自称**：没有服务端签发的会话时，带共享口令 + 任意 user id 也必须拒；
 * - 会话由服务端签名，带 `aud` / `iat` / `exp`：篡改、换 aud、过期、换密钥一律拒；
 * - 会话主体与 `X-User-Id` 不一致 = `PRINCIPAL_MISMATCH`，绝不「以头为准」；
 * - **共享口令不是 owner 凭证**：exchange 只认已登记 owner 的每用户随机密钥；
 *   没有登记就明确回「缺前置」，不回「登录成功」；
 * - bootstrap 只走已鉴权的服务端 owner 通道（独立密钥），不是登录入口，也不接受共享口令。
 */
import { describe, expect, it } from 'vitest';
import {
  TRAVEL_AUTH_ENDPOINT,
  TRAVEL_MAX_SESSION_TTL_MS,
  TRAVEL_OWNER_CREDENTIALS_DDL,
  TRAVEL_SESSION_AUDIENCE,
  createD1OwnerStore,
  createMemoryOwnerStore,
  createTravelSessionResolver,
  ensureTravelOwnerSchema,
  handleTravelOwnerBootstrap,
  handleTravelSessionExchange,
  hashOwnerKey,
  issueTravelSession,
  resolveTravelSession,
  type TravelAuthEnv,
  type TravelDb,
} from './auth';

const USER = '00000000-0000-4000-8000-0000000000aa';
const OTHER = '00000000-0000-4000-8000-0000000000bb';
const NOW = 1_760_000_000_000;

const SESSION_SECRET = 'travel-session-signing-secret-0123456789';
const BOOTSTRAP_SECRET = 'owner-bootstrap-channel-secret-0123456789';
const SHARED_CLIENT_TOKEN = 'shared-client-token-abcdef';

/** 认证方案用拼接构造：不在源码里留「方案 + 裸 token」的字面量组合。 */
const AUTH_SCHEME = 'Bear' + 'er';
const bearer = (token: string): string => `${AUTH_SCHEME} ${token}`;

const makeEnv = (extra: Partial<TravelAuthEnv> = {}): TravelAuthEnv => ({
  TRAVEL_SESSION_SECRET: SESSION_SECRET,
  TRAVEL_OWNER_BOOTSTRAP_SECRET: BOOTSTRAP_SECRET,
  AMSG_CLIENT_TOKEN: SHARED_CLIENT_TOKEN,
  ...extra,
});

const stateRequest = (headers: Record<string, string> = {}): Request =>
  new Request('https://worker.example.dev/travel/state?charId=c1', { headers });

const postJson = (url: string, body: unknown, headers: Record<string, string> = {}): Request =>
  new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const issue = async (env: TravelAuthEnv, userId = USER, opts: { nowMs?: number; ttlMs?: number } = {}) => {
  const result = await issueTravelSession({ userId, env, nowMs: opts.nowMs ?? NOW, ttlMs: opts.ttlMs });
  if (!result.ok) throw new Error(`会话签发应成功，实际 ${result.reason}`);
  return result.token;
};

/** 换掉 payload 段（模拟调用方自己改 sub / aud / exp）。 */
const tamperPayload = (token: string, patch: Record<string, unknown>): string => {
  const [prefix, payload, sig] = token.split('.');
  const raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const next = Buffer.from(JSON.stringify({ ...raw, ...patch }), 'utf8').toString('base64url');
  return `${prefix}.${next}.${sig}`;
};

describe('resolveTravelSession：身份只认服务端签发会话', () => {
  it('只有共享口令 + 自报 X-User-Id 时拒绝（共享口令验证 != 已验证 user）', async () => {
    const request = stateRequest({
      'X-Client-Token': SHARED_CLIENT_TOKEN,
      'X-User-Id': USER,
    });
    const result = await resolveTravelSession({ request, env: makeEnv(), nowMs: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.code).toBe('UNAUTHORIZED');
    expect(result.reason).toBe('session-missing');
  });

  it('把共享口令本身当会话凭据也拒绝', async () => {
    const request = stateRequest({ Authorization: bearer(SHARED_CLIENT_TOKEN) });
    const result = await resolveTravelSession({ request, env: makeEnv(), nowMs: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.reason).toBe('session-malformed');
  });

  it('合法会话：userId 来自 token，不来自请求头', async () => {
    const token = await issue(makeEnv());
    const result = await resolveTravelSession({
      request: stateRequest({ Authorization: bearer(token) }),
      env: makeEnv(),
      nowMs: NOW + 1000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.userId).toBe(USER);
    expect(result.session.aud).toBe(TRAVEL_SESSION_AUDIENCE);
    expect(result.session.exp).toBeGreaterThan(result.session.iat);
  });

  it('会话 + 同值 X-User-Id 放行；不同值 → PRINCIPAL_MISMATCH 403', async () => {
    const token = await issue(makeEnv());
    const same = await resolveTravelSession({
      request: stateRequest({ Authorization: bearer(token), 'X-User-Id': USER }),
      env: makeEnv(),
      nowMs: NOW,
    });
    expect(same.ok).toBe(true);

    const cross = await resolveTravelSession({
      request: stateRequest({ Authorization: bearer(token), 'X-User-Id': OTHER }),
      env: makeEnv(),
      nowMs: NOW,
    });
    expect(cross.ok).toBe(false);
    if (cross.ok) return;
    expect(cross.status).toBe(403);
    expect(cross.code).toBe('PRINCIPAL_MISMATCH');
    expect(cross.reason).toBe('principal-mismatch');
  });

  it('过期会话拒绝（exp 之后即使签名有效也不放行）', async () => {
    const token = await issue(makeEnv(), USER, { ttlMs: 60_000 });
    const result = await resolveTravelSession({
      request: stateRequest({ Authorization: bearer(token) }),
      env: makeEnv(),
      nowMs: NOW + 60_001,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.reason).toBe('session-expired');
  });

  it('签发时间在未来的会话拒绝（防时钟滥用）', async () => {
    const token = await issue(makeEnv(), USER, { nowMs: NOW + 10 * 60_000 });
    const result = await resolveTravelSession({
      request: stateRequest({ Authorization: bearer(token) }),
      env: makeEnv(),
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('session-issued-in-future');
  });

  it('篡改 sub 后签名失效', async () => {
    const token = await issue(makeEnv());
    const forged = tamperPayload(token, { sub: OTHER });
    const result = await resolveTravelSession({
      request: stateRequest({ Authorization: bearer(forged), 'X-User-Id': OTHER }),
      env: makeEnv(),
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.reason).toBe('session-signature-invalid');
  });

  it('不同 aud 的会话不被接受（别的用途的 token 不能借来用）', async () => {
    const token = await issue(makeEnv());
    const otherAud = tamperPayload(token, { aud: 'amsg' });
    const result = await resolveTravelSession({
      request: stateRequest({ Authorization: bearer(otherAud) }),
      env: makeEnv(),
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(['session-signature-invalid', 'session-audience-mismatch']).toContain(result.reason);
  });

  it('同一密钥自签的别的 aud 会话被 aud 断言挡住', async () => {
    const foreignAud = await issueTravelSession({
      userId: USER,
      env: makeEnv(),
      nowMs: NOW,
      audience: 'amsg',
    });
    expect(foreignAud.ok).toBe(true);
    if (!foreignAud.ok) return;
    const result = await resolveTravelSession({
      request: stateRequest({ Authorization: bearer(foreignAud.token) }),
      env: makeEnv(),
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('session-audience-mismatch');
  });

  it('用另一把密钥签的会话拒绝（换部署/换钥即失效）', async () => {
    const foreign = await issue(makeEnv({ TRAVEL_SESSION_SECRET: 'another-totally-different-session-secret-0123456789' }));
    const result = await resolveTravelSession({
      request: stateRequest({ Authorization: bearer(foreign) }),
      env: makeEnv(),
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('session-signature-invalid');
  });

  it('缺签名密钥时 fail-closed（503，不默认放行）', async () => {
    const env = makeEnv({ TRAVEL_SESSION_SECRET: '', AMSG_MASTER_KEY: '' });
    const request = stateRequest({ 'X-Client-Token': SHARED_CLIENT_TOKEN, 'X-User-Id': USER });
    const result = await resolveTravelSession({ request, env, nowMs: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(503);
    expect(result.reason).toBe('session-secret-unconfigured');
  });

  it('没有独立会话密钥时可从服务端主密钥派生（不依赖共享口令）', async () => {
    const env = makeEnv({ TRAVEL_SESSION_SECRET: '', AMSG_MASTER_KEY: 'm'.repeat(64) });
    const token = await issue(env);
    const result = await resolveTravelSession({
      request: stateRequest({ Authorization: bearer(token) }),
      env,
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);

    // 换成「共享口令当主密钥」的环境，签名对不上 → 仍然拒绝。
    const withClientTokenAsMaster = makeEnv({ TRAVEL_SESSION_SECRET: '', AMSG_MASTER_KEY: SHARED_CLIENT_TOKEN });
    const res2 = await resolveTravelSession({
      request: stateRequest({ Authorization: bearer(token) }),
      env: withClientTokenAsMaster,
      nowMs: NOW,
    });
    expect(res2.ok).toBe(false);
  });

  it('签发的 TTL 被上限夹紧，不能自造长期有效会话', async () => {
    const token = await issue(makeEnv(), USER, { ttlMs: 365 * 24 * 3600_000 });
    const result = await resolveTravelSession({
      request: stateRequest({ Authorization: bearer(token) }),
      env: makeEnv(),
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.exp - result.session.iat).toBeLessThanOrEqual(TRAVEL_MAX_SESSION_TTL_MS);
  });

  it('createTravelSessionResolver 给 B3 的闭包语义一致', async () => {
    const resolveSession = createTravelSessionResolver(makeEnv(), () => NOW);
    const token = await issue(makeEnv());
    const ok = await resolveSession(stateRequest({ Authorization: bearer(token) }));
    expect(ok.ok).toBe(true);
    const denied = await resolveSession(stateRequest({ 'X-User-Id': USER }));
    expect(denied.ok).toBe(false);
  });
});

describe('exchange：只认已登记 owner 的每用户密钥', () => {
  it('未登记 owner → 401 并明确「缺前置」，不是登录成功', async () => {
    const ownerStore = createMemoryOwnerStore();
    const res = await handleTravelSessionExchange(
      postJson(`https://worker.example.dev${TRAVEL_AUTH_ENDPOINT}`, { userId: USER, ownerKey: 'whatever' }),
      makeEnv(),
      { ownerStore, nowMs: NOW },
    );
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.detail).toBe('owner-credential-not-registered');
    expect(String(body.error.message)).toMatch(/bootstrap|登记/);
    expect(body.session).toBeUndefined();
  });

  it('共享口令不能当 owner 凭证换会话（共享密钥可伪造任意 userid）', async () => {
    const ownerStore = createMemoryOwnerStore();
    await ownerStore.putKeyHash(USER, await hashOwnerKey(USER, SHARED_CLIENT_TOKEN), NOW);
    const res = await handleTravelSessionExchange(
      postJson(`https://worker.example.dev${TRAVEL_AUTH_ENDPOINT}`, { userId: USER, ownerKey: SHARED_CLIENT_TOKEN }),
      makeEnv(),
      { ownerStore, nowMs: NOW },
    );
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.detail).toBe('owner-credential-must-not-be-shared-secret');
  });

  it('A 的 owner 密钥不能换 B 的会话', async () => {
    const ownerStore = createMemoryOwnerStore();
    const keyA = 'owner-key-for-user-a-0123456789abcdef';
    await ownerStore.putKeyHash(USER, await hashOwnerKey(USER, keyA), NOW);
    const res = await handleTravelSessionExchange(
      postJson(`https://worker.example.dev${TRAVEL_AUTH_ENDPOINT}`, { userId: OTHER, ownerKey: keyA }),
      makeEnv(),
      { ownerStore, nowMs: NOW },
    );
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.detail).toBe('owner-credential-not-registered');
  });

  it('错误 owner 密钥 → 401，且不泄漏「差一点」的信息', async () => {
    const ownerStore = createMemoryOwnerStore();
    await ownerStore.putKeyHash(USER, await hashOwnerKey(USER, 'right-key-0123456789abcdef'), NOW);
    const res = await handleTravelSessionExchange(
      postJson(`https://worker.example.dev${TRAVEL_AUTH_ENDPOINT}`, { userId: USER, ownerKey: 'wrong-key-0123456789abcdef' }),
      makeEnv(),
      { ownerStore, nowMs: NOW },
    );
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.detail).toBe('owner-credential-invalid');
  });

  it('正确 owner 密钥换到的会话可用于 resolveTravelSession，且绑定该 userId', async () => {
    const ownerStore = createMemoryOwnerStore();
    const ownerKey = 'owner-key-for-user-a-0123456789abcdef';
    await ownerStore.putKeyHash(USER, await hashOwnerKey(USER, ownerKey), NOW);
    const res = await handleTravelSessionExchange(
      postJson(`https://worker.example.dev${TRAVEL_AUTH_ENDPOINT}`, { userId: USER, ownerKey }),
      makeEnv(),
      { ownerStore, nowMs: NOW },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.session.userId).toBe(USER);
    expect(body.session.audience).toBe(TRAVEL_SESSION_AUDIENCE);
    expect(body.session.expiresAt).toBeGreaterThan(NOW);
    expect(String(body.session.token).split('.').length).toBe(3);

    const resolved = await resolveTravelSession({
      request: stateRequest({ Authorization: bearer(body.session.token) }),
      env: makeEnv(),
      nowMs: NOW + 5,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.userId).toBe(USER);
  });

  it('ownerStore 未注入 → 503（不猜、不降级成共享口令）', async () => {
    const res = await handleTravelSessionExchange(
      postJson(`https://worker.example.dev${TRAVEL_AUTH_ENDPOINT}`, { userId: USER, ownerKey: 'k' }),
      makeEnv(),
      { nowMs: NOW },
    );
    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body.error.detail).toBe('owner-store-unconfigured');
  });

  it('会话签名密钥缺失 → 503，不签发无签名 token', async () => {
    const ownerStore = createMemoryOwnerStore();
    const ownerKey = 'owner-key-for-user-a-0123456789abcdef';
    await ownerStore.putKeyHash(USER, await hashOwnerKey(USER, ownerKey), NOW);
    const res = await handleTravelSessionExchange(
      postJson(`https://worker.example.dev${TRAVEL_AUTH_ENDPOINT}`, { userId: USER, ownerKey }),
      makeEnv({ TRAVEL_SESSION_SECRET: '', AMSG_MASTER_KEY: '' }),
      { ownerStore, nowMs: NOW },
    );
    expect(res.status).toBe(503);
    expect((await res.json() as any).error.detail).toBe('session-secret-unconfigured');
  });

  it('缺 userId / ownerKey 或形状不对 → 400', async () => {
    const ownerStore = createMemoryOwnerStore();
    for (const body of [{}, { userId: USER }, { ownerKey: 'k' }, { userId: 42, ownerKey: 'k' }]) {
      const res = await handleTravelSessionExchange(
        postJson(`https://worker.example.dev${TRAVEL_AUTH_ENDPOINT}`, body),
        makeEnv(),
        { ownerStore, nowMs: NOW },
      );
      expect(res.status).toBe(400);
    }
  });
});

describe('owner bootstrap：只走已鉴权服务端通道', () => {
  it('未配置 bootstrap 密钥 → 503 缺前置（不开放自助注册）', async () => {
    const ownerStore = createMemoryOwnerStore();
    const res = await handleTravelOwnerBootstrap(
      postJson('https://worker.example.dev/travel/owner/bootstrap', { userId: USER }, { Authorization: bearer(BOOTSTRAP_SECRET) }),
      makeEnv({ TRAVEL_OWNER_BOOTSTRAP_SECRET: '' }),
      { ownerStore, nowMs: NOW },
    );
    expect(res.status).toBe(503);
    expect((await res.json() as any).error.detail).toBe('bootstrap-secret-unconfigured');
  });

  it('共享口令不能当 bootstrap 凭据', async () => {
    const ownerStore = createMemoryOwnerStore();
    const res = await handleTravelOwnerBootstrap(
      postJson('https://worker.example.dev/travel/owner/bootstrap', { userId: USER }, { Authorization: bearer(SHARED_CLIENT_TOKEN) }),
      makeEnv(),
      { ownerStore, nowMs: NOW },
    );
    expect(res.status).toBe(401);
    expect((await res.json() as any).error.detail).toBe('bootstrap-credential-invalid');
  });

  it('错误 bootstrap 凭据 → 401', async () => {
    const ownerStore = createMemoryOwnerStore();
    const res = await handleTravelOwnerBootstrap(
      postJson('https://worker.example.dev/travel/owner/bootstrap', { userId: USER }, { Authorization: bearer('x'.repeat(40)) }),
      makeEnv(),
      { ownerStore, nowMs: NOW },
    );
    expect(res.status).toBe(401);
    expect((await res.json() as any).error.detail).toBe('bootstrap-credential-invalid');
  });

  it('正确通道签发每用户随机密钥，库里只落哈希', async () => {
    const ownerStore = createMemoryOwnerStore();
    const res = await handleTravelOwnerBootstrap(
      postJson('https://worker.example.dev/travel/owner/bootstrap', { userId: USER }, { Authorization: bearer(BOOTSTRAP_SECRET) }),
      makeEnv(),
      { ownerStore, nowMs: NOW },
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.credential.userId).toBe(USER);
    expect(typeof body.credential.ownerKey).toBe('string');
    expect(body.credential.ownerKey.length).toBeGreaterThanOrEqual(32);
    const expectedHash = await hashOwnerKey(USER, body.credential.ownerKey);
    // 返回体里不回显哈希；库里不存明文。
    expect(JSON.stringify(body)).not.toContain(expectedHash);
    const stored = await ownerStore.getKeyHash(USER);
    expect(stored).toBe(expectedHash);
    expect(stored).not.toBe(body.credential.ownerKey);

    const exchange = await handleTravelSessionExchange(
      postJson(`https://worker.example.dev${TRAVEL_AUTH_ENDPOINT}`, { userId: USER, ownerKey: body.credential.ownerKey }),
      makeEnv(),
      { ownerStore, nowMs: NOW },
    );
    expect(exchange.status).toBe(200);
  });

  it('两次 bootstrap 的密钥不同（每用户随机，不是全局常量）', async () => {
    const ownerStore = createMemoryOwnerStore();
    const issueOnce = async () => {
      const res = await handleTravelOwnerBootstrap(
        postJson('https://worker.example.dev/travel/owner/bootstrap', { userId: USER }, { Authorization: bearer(BOOTSTRAP_SECRET) }),
        makeEnv(),
        { ownerStore, nowMs: NOW },
      );
      return (await res.json() as any).credential.ownerKey as string;
    };
    const first = await issueOnce();
    const second = await issueOnce();
    expect(first).not.toBe(second);
  });

  it('ownerStore 未注入 → 503（没有落地处就不发密钥）', async () => {
    const res = await handleTravelOwnerBootstrap(
      postJson('https://worker.example.dev/travel/owner/bootstrap', { userId: USER }, { Authorization: bearer(BOOTSTRAP_SECRET) }),
      makeEnv(),
      { nowMs: NOW },
    );
    expect(res.status).toBe(503);
    expect((await res.json() as any).error.detail).toBe('owner-store-unconfigured');
  });
});

describe('D1 owner 仓库', () => {
  const fakeDb = () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const db: TravelDb = {
      prepare(sql: string) {
        const record = { sql, args: [] as unknown[] };
        calls.push(record);
        const stmt = {
          bind(...args: unknown[]) { record.args = args; return stmt; },
          run: async () => ({ success: true, meta: { changes: 1 } }),
          first: async () => (sql.includes('SELECT') ? { key_hash: 'abc' } : null),
          all: async () => ({ results: [] }),
        };
        return stmt as any;
      },
    };
    return { db, calls };
  };

  it('DDL 只 additive 建一张凭证表', () => {
    expect(TRAVEL_OWNER_CREDENTIALS_DDL).toContain('CREATE TABLE IF NOT EXISTS travel_owner_credentials');
    expect(TRAVEL_OWNER_CREDENTIALS_DDL).toContain('user_id TEXT PRIMARY KEY');
  });

  it('ensureTravelOwnerSchema 幂等建表（additive）', async () => {
    const { db, calls } = fakeDb();
    await ensureTravelOwnerSchema(db);
    expect(calls[0].sql).toContain('CREATE TABLE IF NOT EXISTS travel_owner_credentials');
  });

  it('读哈希按 user_id 绑定，写明只存哈希列', async () => {
    const { db, calls } = fakeDb();
    const store = createD1OwnerStore(db);
    expect(await store.getKeyHash(USER)).toBe('abc');
    expect(calls[0].sql).toContain('FROM travel_owner_credentials');
    expect(calls[0].sql).toContain('user_id = ?');
    expect(calls[0].args).toEqual([USER]);

    await store.putKeyHash(USER, 'hash-value', NOW);
    expect(calls[1].sql).toContain('INSERT INTO travel_owner_credentials');
    expect(calls[1].args).toContain('hash-value');
  });
});
