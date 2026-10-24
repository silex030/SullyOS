/**
 * 自主生活 v1 · worker 接线回归（**真 SQL**，不是记 SQL 文本的假库）
 *
 * 钉住四件事：
 *   1. 许可条件提交是原子的：暂停与动作 CAS 在同一句 UPDATE 里，读完之后才按暂停
 *      也必须整笔失败（用 D1 钩子在 UPDATE 前插入「另一台设备按了暂停」）；
 *   2. 回执只认已发许可 + 同 argsHash + 同设备；没有许可的回执是伪造；
 *   3. HTTP 层：共享口令缺失/错误 401、角色按 owner 隔离、claim→commit→receipt 全链路；
 *   4. cron：未登记角色不 tick、账号关着不调模型、真实模型返回的候选能落成 scheduled 动作。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { createSqliteD1, openTestSqlite, type TestSqlite } from '../test/d1-sqlite';
import { commitPermit, claimAction, emptyCharacterLife, reportReceipt, tickCharacter } from '../../../../utils/autonomyLife/engine';
import { mergeEffectiveBoundary, normalizeBoundary } from '../../../../utils/autonomyLife/boundary';
import { handleAutonomyLifeRequest, resolveOwnerFromSharedToken } from './routes';
import { handleAutonomyLifeScheduled } from './tick';
import { createAutonomyLifeRuntime, defaultAccountBoundary } from './runtime';
import {
  createD1LifeStore,
  ensureAutonomyLifeSchema,
  resetAutonomyLifeSchemaCacheForTesting,
  type LifeDb,
} from './store';

const NOW = Date.parse('2026-10-24T04:00:00.000Z');
const USER = 'user-1';
const CHAR = 'char-1';
const TOKEN = 'shared-token';
const WINDOW = 'w:2026-10-24';
/** 合法预留 id：服务端受理前会校验它自证「本窗口 + 本角色」。 */
const reservationFor = (charId = CHAR) => `rsv_${WINDOW}_${charId}_${NOW}_1`;

let sql: TestSqlite;
let db: LifeDb;

const fresh = (hooks: Parameters<typeof createSqliteD1>[1] = {}) => {
  db = createSqliteD1(sql, hooks) as unknown as LifeDb;
  return db;
};

beforeEach(async () => {
  sql = openTestSqlite();
  fresh();
  resetAutonomyLifeSchemaCacheForTesting();
  await ensureAutonomyLifeSchema(db);
  // 账号行懒建：先读一次，避免测试里第一条 UPDATE 没有行。
  await createD1LifeStore({ db, ownerId: USER, now: () => NOW }).getAccountPause(USER);
  // 预算行：许可条件提交会核对「预留 id 有本窗口的预算依据」。
  await seedBudgetHold();
});

const boundaryRow = (overrides: Record<string, unknown> = {}) => normalizeBoundary(
  {
    enabled: true,
    globalPaused: false,
    timezone: 'Asia/Shanghai',
    allowedKinds: ['journal.write'],
    externalGrants: [],
    ...overrides,
  },
  { scope: 'account', nowMs: NOW, revision: 1 },
);

/** 直接把账号边界写进 D1（模拟用户在设置页保存过）。 */
async function seedAccountBoundary(overrides: Record<string, unknown> = {}) {
  const boundary = boundaryRow(overrides);
  await db.prepare('INSERT OR REPLACE INTO autonomy_life_boundaries (owner_id, scope, char_id, revision, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(USER, 'account', '', boundary.revision, JSON.stringify(boundary), NOW)
    .run();
  return boundary;
}

/** 预算行：账号层与角色层各一条，证明本窗口真的预留/结算过模型调用。 */
async function seedBudgetHold(charId = CHAR) {
  for (const scope of ['account', charId]) {
    await db.prepare(`INSERT OR REPLACE INTO autonomy_life_budget
      (owner_id, window_id, scope, used_calls, reserved_calls, used_tokens, reserved_tokens, notifications, kind_counts, spend_minor, revision, updated_at)
      VALUES (?, ?, ?, 1, 0, 10, 0, 0, '{}', 0, 1, ?)`)
      .bind(USER, WINDOW, scope, NOW)
      .run();
  }
}

/** 登记角色边界（客户端打开过该角色的自主生活）。 */
async function registerCharacter(charId = CHAR) {
  const row = normalizeBoundary({}, { scope: 'character', nowMs: NOW, revision: 0 });
  await db.prepare('INSERT OR IGNORE INTO autonomy_life_boundaries (owner_id, scope, char_id, revision, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(USER, 'character', charId, row.revision, JSON.stringify(row), NOW)
    .run();
}

/** 直接造一个 due 的动作行（等价于 cron tick 产出的结果）。 */
async function insertAction(actionId: string, options: { charId?: string; installationId?: string | null } = {}) {
  const row = {
    id: actionId,
    charId: options.charId ?? CHAR,
    kind: 'journal.write' as const,
    windowId: 'w:2026-10-24',
    executionMode: 'local' as const,
    scope: 'os_simulation' as const,
    source: 'rhythm' as const,
    sourceRef: null,
    purposeKey: 'purpose-journal',
    semanticPurpose: 'daily_note',
    args: { title: '今天', body: '雨停之后去楼下走了走。' },
    argsHash: '',
    basis: 'virtual' as const,
    reasonSummary: '想把今天记下来',
    createdAt: NOW,
    notBefore: NOW,
    expiresAt: NOW + 6 * 60 * 60_000,
    status: 'scheduled' as const,
    revision: 0,
    policyVersion: 'autonomy-life-v1',
    dedupeKey: 'abc12345',
    reservationId: reservationFor(options.charId ?? CHAR),
    installationId: options.installationId === undefined ? 'install-1' : options.installationId,
    resultRef: null,
    errorCode: null,
    leaseEpoch: 1,
    leaseExpiresAt: NOW + 5 * 60_000,
    permitIssuedAt: null,
    permitNonce: null,
    permitConsumedAt: null,
    notified: false,
  };
  const { hashArgs } = await import('../../../../contracts/autonomyLife');
  row.argsHash = hashArgs(row.args);
  const store = createD1LifeStore({ db, ownerId: USER, now: () => NOW });
  await store.insertAction(row);
  return row;
}

describe('D1 许可条件提交：暂停与动作 CAS 同一句', () => {
  it('正常提交：写 nonce / running / 租约到期，并把动作行返回给执行器', async () => {
    const action = await insertAction('act-ok');
    await seedAccountBoundary();
    const store = createD1LifeStore({ db, ownerId: USER, now: () => NOW });
    const result = await store.commitPermitAtomic({
      accountId: USER,
      actionId: 'act-ok',
      charId: CHAR,
      installationId: 'install-1',
      leaseEpoch: action.leaseEpoch,
      argsHash: action.argsHash,
      policyVersion: action.policyVersion,
      nowMs: NOW,
      expiresAt: NOW + 60_000,
      nonce: 'nonce-1',
      expectedRevision: 0,
      expectedWindowId: WINDOW,
      expectedAccountBoundaryRevision: 1,
      expectedCharacterBoundaryRevision: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.status).toBe('running');
    expect(result.action.permitNonce).toBe('nonce-1');
    expect(result.action.permitIssuedAt).toBe(NOW);
    expect(result.action.leaseExpiresAt).toBe(NOW + 60_000);
  });

  it('读完之后、UPDATE 之前被暂停 → 整笔失败且动作行一个字节不改（暂停竞态）', async () => {
    const action = await insertAction('act-race');
    await seedAccountBoundary();
    // 在 UPDATE 语句执行前，另一台设备把账号暂停写进库。
    let pauseInjected = false;
    fresh({
      beforeStatement: (text) => {
        if (!pauseInjected && /UPDATE autonomy_life_actions/.test(text)) {
          pauseInjected = true;
          sql.prepare('UPDATE autonomy_life_accounts SET paused = 1, pause_requested_at = ?, updated_at = ? WHERE owner_id = ?')
            .run(NOW, NOW, USER);
        }
      },
    });
    resetAutonomyLifeSchemaCacheForTesting();
    await ensureAutonomyLifeSchema(db);
    const store = createD1LifeStore({ db, ownerId: USER, now: () => NOW });

    const result = await store.commitPermitAtomic({
      accountId: USER,
      actionId: 'act-race',
      charId: CHAR,
      installationId: 'install-1',
      leaseEpoch: action.leaseEpoch,
      argsHash: action.argsHash,
      policyVersion: action.policyVersion,
      nowMs: NOW,
      expiresAt: NOW + 60_000,
      nonce: 'nonce-race',
      expectedRevision: 0,
      expectedWindowId: WINDOW,
      expectedAccountBoundaryRevision: 1,
      expectedCharacterBoundaryRevision: null,
    });
    expect(result).toMatchObject({ ok: false, code: 'GLOBAL_PAUSED' });

    const after = await store.getAction('act-race');
    expect(after?.status).toBe('scheduled');
    expect(after?.permitNonce).toBeNull();
    expect(after?.permitIssuedAt).toBeNull();
    expect(after?.revision).toBe(0);
  });

  it('角色暂停写在角色状态里 → 同样被同一句 UPDATE 拦住', async () => {
    const action = await insertAction('act-charpause');
    await seedAccountBoundary();
    await registerCharacter();
    const runtime = createAutonomyLifeRuntime({ db, userId: USER, charId: CHAR, now: () => NOW });
    const before = (await runtime.engine.store.getCharacterLife(CHAR))
      ?? emptyCharacterLife(CHAR, NOW, 'Asia/Shanghai');
    await runtime.engine.store.putCharacterLife({ ...before, pauseRequestedAt: NOW, revision: before.revision + 1 }, before.revision);
    const store = createD1LifeStore({ db, ownerId: USER, now: () => NOW });
    const result = await store.commitPermitAtomic({
      accountId: USER,
      actionId: 'act-charpause',
      charId: CHAR,
      installationId: 'install-1',
      leaseEpoch: action.leaseEpoch,
      argsHash: action.argsHash,
      policyVersion: action.policyVersion,
      nowMs: NOW,
      expiresAt: NOW + 60_000,
      nonce: 'nonce-x',
      expectedRevision: 0,
      expectedWindowId: WINDOW,
      expectedAccountBoundaryRevision: 1,
      expectedCharacterBoundaryRevision: 0,
    });
    expect(result).toMatchObject({ ok: false, code: 'GLOBAL_PAUSED' });
    expect((await store.getAction('act-charpause'))?.status).toBe('scheduled');
  });

  it('未 claim 的原始 scheduled 行不能签许可（没有设备/租约 → 直接拒，零写入）', async () => {
    const raw = await insertAction('act-unclaimed', { installationId: null });
    await seedAccountBoundary();
    // 模拟「跳过 claim 直接 commit」：租约字段是动作创建时的初值。
    await db.prepare("UPDATE autonomy_life_actions SET payload = json_set(payload, '$.leaseEpoch', 0, '$.leaseExpiresAt', NULL) WHERE owner_id = ? AND id = ?")
      .bind(USER, 'act-unclaimed')
      .run();
    const runtime = createAutonomyLifeRuntime({ db, userId: USER, charId: CHAR, now: () => NOW });
    const result = await commitPermit(runtime.engine, {
      accountId: USER,
      actionId: 'act-unclaimed',
      installationId: 'install-1',
      leaseEpoch: 0,
      argsHash: raw.argsHash,
      policyVersion: raw.policyVersion,
      nowMs: NOW,
    });
    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    const after = await runtime.store.getAction('act-unclaimed');
    expect(after?.permitIssuedAt).toBeNull();
    expect(after?.permitNonce).toBeNull();
    expect(after?.status).toBe('scheduled');
  });

  it('伪造/缺失的预算依据不能通过：伪造 reservationId → 拒；本窗口没有预算行 → 拒', async () => {
    await seedAccountBoundary();
    await registerCharacter();
    const runtime = createAutonomyLifeRuntime({ db, userId: USER, charId: CHAR, now: () => NOW });

    const forgedRow = await insertAction('act-forged-rsv');
    await db.prepare("UPDATE autonomy_life_actions SET payload = json_set(payload, '$.reservationId', 'rsv_made_up') WHERE owner_id = ? AND id = ?")
      .bind(USER, 'act-forged-rsv')
      .run();
    await createD1LifeStore({ db, ownerId: USER, now: () => NOW }).bindInstallation(USER, 'install-1', NOW);
    const claimed = await claimAction(runtime.engine, { accountId: USER, installationId: 'install-1', charId: CHAR });
    expect(claimed.action?.id).toBe('act-forged-rsv');
    const forged = await commitPermit(runtime.engine, {
      accountId: USER,
      actionId: 'act-forged-rsv',
      installationId: 'install-1',
      leaseEpoch: claimed.leaseEpoch,
      argsHash: forgedRow.argsHash,
      policyVersion: forgedRow.policyVersion,
      nowMs: NOW,
    });
    expect(forged).toMatchObject({ ok: false, code: 'STATE_CONFLICT' });
    expect((await runtime.store.getAction('act-forged-rsv'))?.permitIssuedAt).toBeNull();

    // 本窗口没有任何预算记账（连预留/结算都没有）→ 同样没有依据。
    await db.prepare('DELETE FROM autonomy_life_budget WHERE owner_id = ?').bind(USER).run();
    await db.prepare("UPDATE autonomy_life_actions SET payload = json_set(payload, '$.reservationId', ?) WHERE owner_id = ? AND id = ?")
      .bind(reservationFor(), USER, 'act-forged-rsv')
      .run();
    const noBasis = await commitPermit(runtime.engine, {
      accountId: USER,
      actionId: 'act-forged-rsv',
      installationId: 'install-1',
      leaseEpoch: claimed.leaseEpoch,
      argsHash: forgedRow.argsHash,
      policyVersion: forgedRow.policyVersion,
      nowMs: NOW,
    });
    expect(noBasis).toMatchObject({ ok: false, code: 'STATE_CONFLICT' });
    expect((await runtime.store.getAction('act-forged-rsv'))?.permitIssuedAt).toBeNull();
  });

  it('读完边界之后、UPDATE 之前撤销授权 → revision CAS 让整笔失败（真 SQL 回归）', async () => {
    await seedAccountBoundary();
    await registerCharacter();
    const row = await insertAction('act-revoke-race');
    let injected = false;
    fresh({
      beforeStatement: (text) => {
        if (!injected && /UPDATE autonomy_life_actions/.test(text)) {
          injected = true;
          // 另一台设备在同一时刻撤销外部授权（边界 payload 与 revision 一起变）。
          sql.prepare("UPDATE autonomy_life_boundaries SET revision = revision + 1, payload = json_set(payload, '$.externalGrants', json('[]')) WHERE owner_id = ? AND scope = 'account' AND char_id = ''")
            .run(USER);
        }
      },
    });
    resetAutonomyLifeSchemaCacheForTesting();
    await ensureAutonomyLifeSchema(db);
    await createD1LifeStore({ db, ownerId: USER, now: () => NOW }).bindInstallation(USER, 'install-1', NOW);
    const runtime = createAutonomyLifeRuntime({ db, userId: USER, charId: CHAR, now: () => NOW });
    const claimed = await claimAction(runtime.engine, { accountId: USER, installationId: 'install-1', charId: CHAR });
    expect(claimed.action?.id).toBe('act-revoke-race');
    const result = await commitPermit(runtime.engine, {
      accountId: USER,
      actionId: 'act-revoke-race',
      installationId: 'install-1',
      leaseEpoch: claimed.leaseEpoch,
      argsHash: row.argsHash,
      policyVersion: row.policyVersion,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    expect(injected).toBe(true);
    const after = await runtime.store.getAction('act-revoke-race');
    expect(after?.permitIssuedAt).toBeNull();
    expect(after?.permitNonce).toBeNull();
  });

  it('revision / hash / 设备 / 窗口 任一不符 → 拒绝（零写入）', async () => {
    const action = await insertAction('act-mismatch');
    await seedAccountBoundary();
    const store = createD1LifeStore({ db, ownerId: USER, now: () => NOW });
    const base = {
      accountId: USER,
      actionId: 'act-mismatch',
      charId: CHAR,
      installationId: 'install-1',
      leaseEpoch: action.leaseEpoch,
      argsHash: action.argsHash,
      policyVersion: action.policyVersion,
      nowMs: NOW,
      expiresAt: NOW + 60_000,
      nonce: 'nonce-y',
      expectedRevision: 0,
      expectedWindowId: WINDOW,
      expectedAccountBoundaryRevision: 1,
      expectedCharacterBoundaryRevision: null,
    };
    expect(await store.commitPermitAtomic({ ...base, expectedRevision: 9 })).toMatchObject({ ok: false });
    expect(await store.commitPermitAtomic({ ...base, argsHash: 'deadbeef' })).toMatchObject({ ok: false });
    expect(await store.commitPermitAtomic({ ...base, installationId: 'other-device' })).toMatchObject({ ok: false });
    expect((await store.getAction('act-mismatch'))?.permitIssuedAt).toBeNull();
  });
});

describe('D1 上的引擎全链路：claim → permit → receipt', () => {
  it('没有许可的动作不能报成功；正确回执落终态并写 consumedAt', async () => {
    const action = await insertAction('act-e2e');
    await seedAccountBoundary();
    await registerCharacter();
    const runtime = createAutonomyLifeRuntime({ db, userId: USER, charId: CHAR, now: () => NOW });

    const forged = await reportReceipt(runtime.engine, {
      accountId: USER,
      actionId: 'act-e2e',
      installationId: 'install-1',
      leaseEpoch: action.leaseEpoch,
      argsHash: action.argsHash,
      status: 'succeeded',
      resultRef: 'diaries:forged',
      nowMs: NOW,
    });
    expect(forged.ok).toBe(false);

    const claimed = await claimAction(runtime.engine, { accountId: USER, installationId: 'install-1', charId: CHAR });
    expect(claimed.action?.id).toBe('act-e2e');
    const permit = await commitPermit(runtime.engine, {
      accountId: USER,
      actionId: 'act-e2e',
      installationId: 'install-1',
      leaseEpoch: claimed.leaseEpoch,
      argsHash: action.argsHash,
      policyVersion: action.policyVersion,
      nowMs: NOW,
    });
    expect(permit.ok).toBe(true);
    expect(permit.permit?.nonce).toBeTruthy();

    const wrongHash = await reportReceipt(runtime.engine, {
      accountId: USER,
      actionId: 'act-e2e',
      installationId: 'install-1',
      leaseEpoch: claimed.leaseEpoch,
      argsHash: 'deadbeef',
      status: 'succeeded',
      resultRef: 'diaries:x',
      nowMs: NOW,
    });
    expect(wrongHash.ok).toBe(false);

    const ok = await reportReceipt(runtime.engine, {
      accountId: USER,
      actionId: 'act-e2e',
      installationId: 'install-1',
      leaseEpoch: claimed.leaseEpoch,
      argsHash: action.argsHash,
      status: 'succeeded',
      resultRef: 'diaries:real',
      nowMs: NOW,
    });
    expect(ok.ok).toBe(true);
    const saved = await runtime.store.getAction('act-e2e');
    expect(saved?.status).toBe('succeeded');
    expect(saved?.permitConsumedAt).not.toBeNull();
  });

  it('第二台设备领不走动作；换设备提交许可被 FORBIDDEN', async () => {
    await insertAction('act-device', { installationId: 'install-1' });
    await seedAccountBoundary();
    await registerCharacter();
    const store = createD1LifeStore({ db, ownerId: USER, now: () => NOW });
    await store.bindInstallation(USER, 'install-1', NOW);
    const runtime = createAutonomyLifeRuntime({ db, userId: USER, charId: CHAR, now: () => NOW });

    const other = await claimAction(runtime.engine, { accountId: USER, installationId: 'install-2', charId: CHAR });
    expect(other.action).toBeNull();

    const mine = await claimAction(runtime.engine, { accountId: USER, installationId: 'install-1', charId: CHAR });
    expect(mine.action?.id).toBe('act-device');
    const permit = await commitPermit(runtime.engine, {
      accountId: USER,
      actionId: 'act-device',
      installationId: 'install-2',
      leaseEpoch: mine.leaseEpoch,
      argsHash: mine.action!.argsHash,
      policyVersion: mine.action!.policyVersion,
      nowMs: NOW,
    });
    expect(permit).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });
});

describe('HTTP 路由：认证 / 归属 / 全链路', () => {
  const env = (extra: Record<string, unknown> = {}) => ({
    DB: db,
    AMSG_SERVER_TOKEN: TOKEN,
    ...extra,
  }) as never;

  const call = (path: string, init: RequestInit & { token?: string; user?: string } = {}) => {
    const { token = TOKEN, user = USER, ...rest } = init;
    const headers = new Headers(rest.headers ?? {});
    if (token) headers.set('X-Client-Token', token);
    if (user) headers.set('X-User-Id', user);
    if (rest.body) headers.set('Content-Type', 'application/json');
    const request = new Request(`https://worker.example${path}`, { ...rest, headers });
    return handleAutonomyLifeRequest(request, env(), {
      now: () => NOW,
      resolveOwner: (req) => resolveOwnerFromSharedToken(req, env()),
      respond: (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
      hasModelCredentials: async () => true,
      requestId: () => 'req-test',
    });
  };

  it('缺/错共享口令 → 401（不会退化成「谁都能签许可」）', async () => {
    const none = await call('/autonomy-life/v1/boundaries', { token: '' });
    expect(none?.status).toBe(401);
    const wrong = await call('/autonomy-life/v1/boundaries', { token: 'wrong' });
    expect(wrong?.status).toBe(401);
  });

  it('GET state 会登记角色；PATCH 边界走 revision CAS', async () => {
    const state = await call(`/autonomy-life/v1/characters/${CHAR}/state`);
    expect(state?.status).toBe(200);
    const body = await state!.json() as any;
    expect(body.state.charId).toBe(CHAR);
    expect(body.state.availability).toBe('ready');

    const registered = await db
      .prepare("SELECT 1 AS ok FROM autonomy_life_boundaries WHERE owner_id = ? AND scope = 'character' AND char_id = ?")
      .bind(USER, CHAR)
      .first();
    expect(registered).toBeTruthy();

    await seedAccountBoundary();
    const patched = await call('/autonomy-life/v1/boundaries', {
      method: 'PATCH',
      body: JSON.stringify({ scope: 'account', expectedRevision: 1, changes: { globalPaused: true } }),
    });
    expect(patched?.status).toBe(200);
    const after = await patched!.json() as any;
    expect(after.effective.globalPaused).toBe(true);

    const stale = await call('/autonomy-life/v1/boundaries', {
      method: 'PATCH',
      body: JSON.stringify({ scope: 'account', expectedRevision: 1, changes: { globalPaused: false } }),
    });
    expect(stale?.status).toBe(409);
  });

  it('claim → commit-permit → receipt 走同一套路由；别人的 owner 看不到这条动作', async () => {
    const action = await insertAction('act-http');
    await seedAccountBoundary();
    await registerCharacter();
    const device = await call('/autonomy-life/v1/devices/register', {
      method: 'POST',
      body: JSON.stringify({ installationId: 'install-1' }),
    });
    expect(device?.status).toBe(200);

    const claimed = await call('/autonomy-life/v1/execution/claim', {
      method: 'POST',
      body: JSON.stringify({ charId: CHAR, installationId: 'install-1' }),
    });
    const claimedBody = await claimed!.json() as any;
    expect(claimedBody.action.id).toBe('act-http');

    const permit = await call('/autonomy-life/v1/actions/act-http/commit-permit', {
      method: 'POST',
      body: JSON.stringify({
        installationId: 'install-1',
        leaseEpoch: claimedBody.leaseEpoch,
        argsHash: action.argsHash,
        policyVersion: action.policyVersion,
      }),
    });
    expect(permit?.status).toBe(200);
    const permitBody = await permit!.json() as any;
    expect(permitBody.permit.nonce).toBeTruthy();
    expect(permitBody.permit.charId).toBe(CHAR);

    const receipt = await call('/autonomy-life/v1/actions/act-http/receipt', {
      method: 'POST',
      body: JSON.stringify({
        installationId: 'install-1',
        leaseEpoch: claimedBody.leaseEpoch,
        argsHash: action.argsHash,
        status: 'succeeded',
        resultRef: 'diaries:http-1',
      }),
    });
    expect(receipt?.status).toBe(200);

    // 另一个 owner 读同一个 charId：看到的是空状态，动作列表为空。
    const other = await call(`/autonomy-life/v1/activities?charId=${CHAR}`, { user: 'user-2' });
    const otherBody = await other!.json() as any;
    expect(otherBody.items).toEqual([]);
  });
});

describe('cron：只推进已登记且开着的角色', () => {
  const pack = (charId: string) => ({
    userId: USER,
    charId,
    charName: '小夏',
    pack: { template: '你叫小夏，是个安静的人。', tzId: 'Asia/Shanghai' },
  }) as any;

  it('未登记 / 账号关着 → 不调模型、不写动作', async () => {
    const unregistered = await handleAutonomyLifeScheduled({
      db,
      packs: [pack('char-unknown')],
      nowMs: NOW,
      credentialsFor: async () => ({ baseUrl: 'https://llm.example/v1', apiKey: 'k', model: 'm' }),
      fetch: async () => { throw new Error('不该调模型'); },
    });
    expect(unregistered.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'not_registered' });

    await registerCharacter();
    // 账号边界默认关闭（没 seedAccountBoundary）：明确 skip，而不是偷偷跑。
    const disabled = await handleAutonomyLifeScheduled({
      db,
      packs: [pack(CHAR)],
      nowMs: NOW,
      credentialsFor: async () => ({ baseUrl: 'https://llm.example/v1', apiKey: 'k', model: 'm' }),
      fetch: async () => { throw new Error('不该调模型'); },
    });
    expect(disabled.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'account_disabled' });
  });

  it('开着且有凭据 → 真模型调用后落一个 scheduled 动作（D1 可领）', async () => {
    await seedAccountBoundary();
    await registerCharacter();
    // 绑定设备在线是「动作可执行」的前提（没设备 → waiting_device，也不会调模型外的写）。
    await createD1LifeStore({ db, ownerId: USER, now: () => NOW }).bindInstallation(USER, 'install-1', NOW);
    const requests: string[] = [];
    const result = await handleAutonomyLifeScheduled({
      db,
      packs: [pack(CHAR)],
      nowMs: NOW,
      credentialsFor: async () => ({ baseUrl: 'https://llm.example/v1', apiKey: 'k', model: 'm' }),
      fetch: async (_url, init) => {
        requests.push(String((init as RequestInit).body ?? ''));
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                candidates: [
                  { kind: 'journal.write', semanticPurpose: 'daily_note', args: { title: '今天', body: '雨停之后去楼下走了走。' } },
                  { kind: 'shopping.order', semanticPurpose: 'buy', args: { bogus: true } },
                ],
              }),
            },
          }],
          usage: { total_tokens: 120 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });
    expect(result.outcomes[0]).toMatchObject({ status: 'ticked', tick: 'scheduled' });
    expect(requests.length).toBe(1);
    // 提示词带上了角色设定与封闭 schema（不是空提示词）。
    expect(requests[0]).toContain('小夏');
    expect(requests[0]).toContain('journal.write');

    const store = createD1LifeStore({ db, ownerId: USER, now: () => NOW });
    const due = await store.dueActions(CHAR, NOW + 1, 5);
    expect(due.length).toBe(1);
    expect(due[0].kind).toBe('journal.write');
    // 非法候选（不认识的 kind / 越权参数）被丢弃，不会落成动作。
    expect(due.some((row) => row.kind === 'shopping.order')).toBe(false);
  });
});

describe('HTTP 路由：受控外部只读窗口', () => {
  const env = (extra: Record<string, unknown> = {}) => ({
    DB: db,
    AMSG_SERVER_TOKEN: TOKEN,
    ...extra,
  }) as never;

  const grant = (provider: 'xhs' | 'amap', over: Record<string, unknown> = {}) => ({
    provider,
    scopes: ['read:search', 'read:geo'],
    allowedHosts: ['xhs.example'],
    allowedMethods: ['GET'],
    allowedFieldKeys: ['query'],
    purpose: '只读',
    expiresAt: NOW + 3_600_000,
    dailyQuota: 1,
    ...over,
  });

  const call = (path: string, body: unknown, extraEnv: Record<string, unknown> = {}, token = TOKEN) => {
    const headers = new Headers({ 'Content-Type': 'application/json', 'X-User-Id': USER });
    if (token) headers.set('X-Client-Token', token);
    const request = new Request(`https://worker.example${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    return handleAutonomyLifeRequest(request, env(extraEnv), {
      now: () => NOW,
      resolveOwner: (req) => resolveOwnerFromSharedToken(req, env(extraEnv)),
      respond: (status, payload) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } }),
      hasModelCredentials: async () => true,
      requestId: () => 'req-ext',
    });
  };

  it('没有授权 → 403 GRANT_REQUIRED（连外部端点都不看）', async () => {
    await seedAccountBoundary({ allowedKinds: ['external.read'] });
    const res = await call('/autonomy-life/v1/external/read', { charId: CHAR, query: '咖啡' });
    expect(res?.status).toBe(403);
    const body = await res!.json() as any;
    expect(body.error.code).toBe('GRANT_REQUIRED');
  });

  it('授权有效但端点未配置 → 503 CAPABILITY_UNAVAILABLE（不编造结果）', async () => {
    await seedAccountBoundary({ allowedKinds: ['external.read'], externalGrants: [grant('xhs')] });
    await registerCharacter();
    const res = await call('/autonomy-life/v1/external/read', { charId: CHAR, query: '咖啡' });
    expect(res?.status).toBe(503);
    const body = await res!.json() as any;
    expect(body.error.code).toBe('CAPABILITY_UNAVAILABLE');
  });

  it('配额按 grant.dailyQuota 原子扣减：第二次 429', async () => {
    await seedAccountBoundary({ allowedKinds: ['external.read'], externalGrants: [grant('xhs')] });
    await registerCharacter();
    const first = await call('/autonomy-life/v1/external/read', { charId: CHAR, query: '咖啡' });
    // 第一次通过授权与配额，卡在「端点未配置」。
    expect(first?.status).toBe(503);
    const second = await call('/autonomy-life/v1/external/read', { charId: CHAR, query: '咖啡' });
    expect(second?.status).toBe(429);
  });

  it('出行愿望：有 amap 授权就落库并返回 wishId', async () => {
    await seedAccountBoundary({ allowedKinds: ['travel.wish'], externalGrants: [grant('amap')] });
    await registerCharacter();
    const res = await call('/autonomy-life/v1/external/wish', { charId: CHAR, text: '想去海边看一次日出' });
    expect(res?.status).toBe(200);
    const body = await res!.json() as any;
    expect(body.wishId).toMatch(/^wish_/);
    const row = await db
      .prepare('SELECT text FROM autonomy_life_wishes WHERE owner_id = ? AND id = ?')
      .bind(USER, body.wishId)
      .first();
    expect(row?.text).toBe('想去海边看一次日出');
  });
});
