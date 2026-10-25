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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

/**
 * 预留凭据：与 `insertAction` 一起落，模拟「引擎 reserveBudget 写了记录 → 绑定到动作」。
 * 之后许可签发/外部副作用会按 id 查这一条（不再靠预算行的历史用量）。
 */
let reservationSeq = 0;
async function seedReservationRow(charId: string, reservationId: string, actionId: string | null, counter: number) {
  await db.prepare(`INSERT OR REPLACE INTO autonomy_life_budget_reservations
    (owner_id, reservation_id, window_id, char_id, counter, kind, plan_ref, calls, tokens, state, action_id, created_at, expires_at, settled_at, revision)
    VALUES (?, ?, ?, ?, ?, NULL, ?, 1, 10, 'settled', ?, ?, ?, ?, 1)`)
    .bind(USER, reservationId, WINDOW, charId, counter, `rhythm-plan:${charId}`, actionId, NOW, NOW + 6 * 60 * 60_000, NOW)
    .run();
}

/** 登记角色边界（客户端打开过该角色的自主生活）。 */
async function registerCharacter(charId = CHAR) {
  const row = normalizeBoundary({}, { scope: 'character', nowMs: NOW, revision: 0 });
  await db.prepare('INSERT OR IGNORE INTO autonomy_life_boundaries (owner_id, scope, char_id, revision, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(USER, 'character', charId, row.revision, JSON.stringify(row), NOW)
    .run();
}

/** 直接造一个 due 的动作行（等价于 cron tick 产出的结果）。 */
async function insertAction(
  actionId: string,
  options: {
    charId?: string;
    installationId?: string | null;
    kind?: 'journal.write' | 'external.read' | 'travel.wish';
    args?: Record<string, unknown>;
  } = {},
) {
  const row = {
    id: actionId,
    charId: options.charId ?? CHAR,
    kind: (options.kind ?? 'journal.write') as 'journal.write' | 'external.read' | 'travel.wish',
    windowId: 'w:2026-10-24',
    executionMode: 'local' as const,
    scope: 'os_simulation' as const,
    source: 'rhythm' as const,
    sourceRef: null,
    purposeKey: 'purpose-journal',
    semanticPurpose: 'daily_note',
    args: options.args ?? { title: '今天', body: '雨停之后去楼下走了走。' },
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
  // 每条动作一张独立凭据（同一测试里可能有多条动作，共用一个 id 会互相借走）。
  reservationSeq += 1;
  const counter = 1000 + reservationSeq;
  row.reservationId = `rsv_${WINDOW}_${row.charId}_${NOW}_${counter}`;
  await seedReservationRow(row.charId, row.reservationId, actionId, counter);
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
      // 预留凭据也进同一条条件 UPDATE：凭证未绑定/被释放/过期时这里 changes=0。
      expectedReservationRevision: 1,
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
  it('合法形状但从未签发 / 借用别人的 / 已释放 / 已过期 的凭据都签不出许可（零写入）', async () => {
    await seedAccountBoundary();
    await registerCharacter();
    await createD1LifeStore({ db, ownerId: USER, now: () => NOW }).bindInstallation(USER, 'install-1', NOW);
    const runtime = createAutonomyLifeRuntime({ db, userId: USER, charId: CHAR, now: () => NOW });

    // 借用：act-borrower 指向 act-owner 的凭据（那条记录绑定的是 act-owner）。
    const ownerRow = await insertAction('act-owner');
    const borrower = await insertAction('act-borrower');
    await db.prepare("UPDATE autonomy_life_actions SET payload = json_set(payload, '$.reservationId', ?) WHERE owner_id = ? AND id = ?")
      .bind(ownerRow.reservationId, USER, 'act-borrower')
      .run();

    // 合法形状但从未签发：同窗口/同角色/同时间戳，counter 随便挑一个没发过的。
    const ghost = await insertAction('act-ghost');
    const ghostId = `rsv_${WINDOW}_${CHAR}_${NOW}_999999`;
    await db.prepare("UPDATE autonomy_life_actions SET payload = json_set(payload, '$.reservationId', ?) WHERE owner_id = ? AND id = ?")
      .bind(ghostId, USER, 'act-ghost')
      .run();

    // 已释放：记录改成 released（额度也还回去了）。
    const releasedRow = await insertAction('act-released');
    await db.prepare('UPDATE autonomy_life_budget_reservations SET state = ? WHERE owner_id = ? AND reservation_id = ?')
      .bind('released', USER, releasedRow.reservationId)
      .run();

    // 已过期：凭据 TTL 过了。
    const expiredRow = await insertAction('act-expired-rsv');
    await db.prepare('UPDATE autonomy_life_budget_reservations SET expires_at = ? WHERE owner_id = ? AND reservation_id = ?')
      .bind(NOW - 1, USER, expiredRow.reservationId)
      .run();

    const cases: Array<{ id: string; argsHash: string; policyVersion: string }> = [
      { id: 'act-borrower', argsHash: borrower.argsHash, policyVersion: borrower.policyVersion },
      { id: 'act-ghost', argsHash: ghost.argsHash, policyVersion: ghost.policyVersion },
      { id: 'act-released', argsHash: releasedRow.argsHash, policyVersion: releasedRow.policyVersion },
      { id: 'act-expired-rsv', argsHash: expiredRow.argsHash, policyVersion: expiredRow.policyVersion },
    ];
    for (const item of cases) {
      // insertAction 已经给了合法的「已 claim」形状（installationId + leaseEpoch=1 + 未过期租约），
      // 所以拒绝只能来自凭据本身。
      const result = await commitPermit(runtime.engine, {
        accountId: USER,
        actionId: item.id,
        installationId: 'install-1',
        leaseEpoch: 1,
        argsHash: item.argsHash,
        policyVersion: item.policyVersion,
        nowMs: NOW,
      });
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/reservation_/);
      const after = await runtime.store.getAction(item.id);
      expect(after?.permitIssuedAt).toBeNull();
      expect(after?.permitNonce).toBeNull();
      expect(after?.status).toBe('scheduled');
    }
  });
  it('读完凭据后、许可 UPDATE 之前凭据被释放 → 条件 UPDATE 让整笔失败（并发失效）', async () => {
    const action = await insertAction('act-rsv-race');
    await seedAccountBoundary();
    await registerCharacter();
    await createD1LifeStore({ db, ownerId: USER, now: () => NOW }).bindInstallation(USER, 'install-1', NOW);
    const reservationId = action.reservationId!;
    let injected = false;
    fresh({
      beforeStatement: (text) => {
        if (!injected && /UPDATE autonomy_life_actions/.test(text)) {
          injected = true;
          // 另一台设备/对账任务在 verify 之后把这个凭据释放掉（revision 一起变）。
          sql.prepare("UPDATE autonomy_life_budget_reservations SET state = 'released', revision = revision + 1 WHERE owner_id = ? AND reservation_id = ?")
            .run(USER, reservationId);
        }
      },
    });
    resetAutonomyLifeSchemaCacheForTesting();
    await ensureAutonomyLifeSchema(db);
    const runtime = createAutonomyLifeRuntime({ db, userId: USER, charId: CHAR, now: () => NOW });
    const result = await commitPermit(runtime.engine, {
      accountId: USER,
      actionId: 'act-rsv-race',
      installationId: 'install-1',
      leaseEpoch: 1,
      argsHash: action.argsHash,
      policyVersion: action.policyVersion,
      nowMs: NOW,
    });
    expect(injected).toBe(true);
    expect(result.ok).toBe(false);
    const after = await runtime.store.getAction('act-rsv-race');
    expect(after?.permitIssuedAt).toBeNull();
    expect(after?.status).toBe('scheduled');
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
    // 执行器要用服务端返回的**许可后**动作行（含 permitNonce），不能拿 claim 的旧快照。
    expect(permitBody.action.permitNonce).toBe(permitBody.permit.nonce);
    expect(permitBody.action.status).toBe('running');

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

describe('HTTP 路由：受控外部只读窗口（绑定已 claim 动作 + 一次性许可）', () => {
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

  const call = (
    path: string,
    body: unknown,
    extraEnv: Record<string, unknown> = {},
    opts: { token?: string; nowMs?: number } = {},
  ) => {
    const headers = new Headers({ 'Content-Type': 'application/json', 'X-User-Id': USER });
    if (opts.token !== null) headers.set('X-Client-Token', opts.token ?? TOKEN);
    const request = new Request(`https://worker.example${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    return handleAutonomyLifeRequest(request, env(extraEnv), {
      now: () => opts.nowMs ?? NOW,
      resolveOwner: (req) => resolveOwnerFromSharedToken(req, env(extraEnv)),
      respond: (status, payload) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } }),
      hasModelCredentials: async () => true,
      requestId: () => 'req-ext',
    });
  };

  /** 造一个已 claim + 已签许可的外部动作，返回请求时要带的绑定。 */
  async function prepareExternalAction(input: {
    kind: 'external.read' | 'travel.wish';
    args: Record<string, unknown>;
    actionId: string;
    grantOverrides?: Record<string, unknown>;
    seedGrant?: boolean;
  }) {
    await seedAccountBoundary({
      allowedKinds: [input.kind],
      externalGrants: input.seedGrant === false
        ? []
        : [grant(input.kind === 'external.read' ? 'xhs' : 'amap', input.grantOverrides)],
    });
    await registerCharacter();
    await createD1LifeStore({ db, ownerId: USER, now: () => NOW }).bindInstallation(USER, 'install-1', NOW);
    const row = await insertAction(input.actionId, { kind: input.kind, args: input.args });
    const runtime = createAutonomyLifeRuntime({ db, userId: USER, charId: CHAR, now: () => NOW });
    const claimed = await claimAction(runtime.engine, { accountId: USER, installationId: 'install-1', charId: CHAR });
    expect(claimed.action?.id).toBe(input.actionId);
    const permit = await commitPermit(runtime.engine, {
      accountId: USER,
      actionId: input.actionId,
      installationId: 'install-1',
      leaseEpoch: claimed.leaseEpoch,
      argsHash: row.argsHash,
      policyVersion: row.policyVersion,
      nowMs: NOW,
    });
    expect(permit.ok).toBe(true);
    return {
      actionId: input.actionId,
      installationId: 'install-1',
      leaseEpoch: claimed.leaseEpoch,
      argsHash: row.argsHash,
      nonce: permit.permit!.nonce,
    };
  }

  const readArgs = { query: '咖啡', fields: ['title', 'author'] };
  const wishArgs = { wishText: '想去海边看一次日出' };

  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // 默认：任何出网都算失败（负面用例要求 fetch 零调用）。
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('不该出网');
    }) as never;
    // vi.spyOn 会让上面的 mock 成为实现；计数从 0 开始。
    fetchSpy.mockClear();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('裸调用（没有动作/许可绑定）→ 400，零出网、零落库', async () => {
    await seedAccountBoundary({ allowedKinds: ['external.read'], externalGrants: [grant('xhs')] });
    const res = await call('/autonomy-life/v1/external/read', { charId: CHAR, query: '咖啡' });
    expect(res?.status).toBe(400);
    expect((await res!.json() as any).error.message).toBe('permit_binding_required');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('直接调用编造 actionId → 404；未 claim/未签许可 → 409；两种情况都不出网', async () => {
    await seedAccountBoundary({ allowedKinds: ['external.read'], externalGrants: [grant('xhs')] });
    await registerCharacter();
    const fabricated = { charId: CHAR, query: '咖啡', actionId: 'act_nope', installationId: 'install-1', leaseEpoch: 1, argsHash: 'x', nonce: 'n' };
    expect((await call('/autonomy-life/v1/external/read', fabricated))?.status).toBe(404);

    // 只建行、不 claim、不签许可：状态是 scheduled，permitIssuedAt=null。
    await insertAction('act-unpermitted', { kind: 'external.read', args: readArgs });
    const unpermitted = await call('/autonomy-life/v1/external/read', {
      charId: CHAR, query: '咖啡', actionId: 'act-unpermitted', installationId: 'install-1', leaseEpoch: 1, argsHash: 'x', nonce: 'n',
    });
    expect(unpermitted?.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('错 argsHash / 错 nonce / 过期许可 / 请求参数不是被批准的那一组 → 拒绝且不出网', async () => {
    const binding = await prepareExternalAction({ kind: 'external.read', args: readArgs, actionId: 'act-ext-neg' });
    const base = { charId: CHAR, query: '咖啡', fields: ['title'], ...binding };

    const wrongHash = await call('/autonomy-life/v1/external/read', { ...base, argsHash: 'deadbeef' });
    expect(wrongHash?.status).toBe(409);

    const wrongNonce = await call('/autonomy-life/v1/external/read', { ...base, nonce: 'nonce_forged' });
    expect(wrongNonce?.status).toBe(409);

    const wrongQuery = await call('/autonomy-life/v1/external/read', { ...base, query: '别的关键词' });
    expect(wrongQuery?.status).toBe(422);
    expect((await wrongQuery!.json() as any).error.message).toBe('query_not_approved');

    const expired = await call('/autonomy-life/v1/external/read', base, { AUTONOMY_EXTERNAL_XHS_URL: 'https://xhs.example/read' }, { nowMs: NOW + 10 * 60_000 });
    expect(expired?.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('授权被撤销/过期、账号暂停、角色暂停 → 403/409，仍不出网', async () => {
    // 许可先正常签出来（签发时有授权），随后用户撤销授权：路由必须按**现读边界**拒。
    const revoked = await prepareExternalAction({ kind: 'external.read', args: readArgs, actionId: 'act-ext-revoked' });
    await seedAccountBoundary({ allowedKinds: ['external.read'], externalGrants: [] });
    const revokedRes = await call('/autonomy-life/v1/external/read', { charId: CHAR, query: '咖啡', fields: ['title'], ...revoked });
    expect(revokedRes?.status).toBe(403);
    expect((await revokedRes!.json() as any).error.code).toBe('GRANT_REQUIRED');

    const expiredGrant = await prepareExternalAction({ kind: 'external.read', args: readArgs, actionId: 'act-ext-expired-grant' });
    await seedAccountBoundary({ allowedKinds: ['external.read'], externalGrants: [grant('xhs', { expiresAt: NOW - 1 })] });
    const expiredRes = await call('/autonomy-life/v1/external/read', { charId: CHAR, query: '咖啡', fields: ['title'], ...expiredGrant });
    expect(expiredRes?.status).toBe(403);

    const accountPaused = await prepareExternalAction({ kind: 'external.read', args: readArgs, actionId: 'act-ext-account-paused' });
    await createD1LifeStore({ db, ownerId: USER, now: () => NOW }).setAccountPause(USER, true, NOW);
    const pausedRes = await call('/autonomy-life/v1/external/read', { charId: CHAR, query: '咖啡', fields: ['title'], ...accountPaused });
    expect(pausedRes?.status).toBe(409);
    await createD1LifeStore({ db, ownerId: USER, now: () => NOW }).setAccountPause(USER, false, NOW);

    const charPaused = await prepareExternalAction({ kind: 'external.read', args: readArgs, actionId: 'act-ext-char-paused' });
    const runtime = createAutonomyLifeRuntime({ db, userId: USER, charId: CHAR, now: () => NOW });
    const life = (await runtime.store.getCharacterLife(CHAR)) ?? emptyCharacterLife(CHAR, NOW, 'Asia/Shanghai');
    await runtime.store.putCharacterLife({ ...life, pauseRequestedAt: NOW, revision: life.revision + 1 }, life.revision);
    const charPausedRes = await call('/autonomy-life/v1/external/read', { charId: CHAR, query: '咖啡', fields: ['title'], ...charPaused });
    expect(charPausedRes?.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('正向：绑定许可后只出网一次、只回白名单字段；重放被拒且不再出网', async () => {
    const binding = await prepareExternalAction({ kind: 'external.read', args: readArgs, actionId: 'act-ext-ok' });
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({
      items: [{ title: '咖啡地图', author: 'a', excerpt: 'e', likes: 3, secret: 'token' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }) as never);

    const res = await call(
      '/autonomy-life/v1/external/read',
      { charId: CHAR, query: '咖啡', fields: ['title', 'author'], ...binding },
      { AUTONOMY_EXTERNAL_XHS_URL: 'https://xhs.example/read', AUTONOMY_EXTERNAL_READ_HOSTS: 'xhs.example' },
    );
    expect(res?.status).toBe(200);
    const body = await res!.json() as any;
    expect(body.items).toEqual([{ title: '咖啡地图', author: 'a' }]);
    expect(JSON.stringify(body)).not.toContain('token');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = String((fetchSpy.mock.calls[0] as unknown[])[0]);
    expect(calledUrl).toContain('q=%E5%92%96%E5%95%A1');

    // 重放同一个请求：permit 已在服务端核销 → 409，且再次出网不会发生。
    const replay = await call(
      '/autonomy-life/v1/external/read',
      { charId: CHAR, query: '咖啡', fields: ['title', 'author'], ...binding },
      { AUTONOMY_EXTERNAL_XHS_URL: 'https://xhs.example/read', AUTONOMY_EXTERNAL_READ_HOSTS: 'xhs.example' },
    );
    expect(replay?.status).toBe(409);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const after = await createD1LifeStore({ db, ownerId: USER, now: () => NOW }).getAction('act-ext-ok');
    expect(after?.permitConsumedAt).not.toBeNull();
  });

  it('出行愿望：绑定许可落一行；重放不出第二行；配额耗尽 → 429 且零落库', async () => {
    const binding = await prepareExternalAction({ kind: 'travel.wish', args: wishArgs, actionId: 'act-wish-ok' });
    const res = await call('/autonomy-life/v1/external/wish', { charId: CHAR, text: '想去海边看一次日出', ...binding });
    expect(res?.status).toBe(200);
    const body = await res!.json() as any;
    expect(body.wishId).toMatch(/^wish_/);
    const count = async () => Number((await db.prepare('SELECT COUNT(*) AS n FROM autonomy_life_wishes WHERE owner_id = ?').bind(USER).first())?.n ?? 0);
    expect(await count()).toBe(1);

    const replay = await call('/autonomy-life/v1/external/wish', { charId: CHAR, text: '想去海边看一次日出', ...binding });
    expect(replay?.status).toBe(409);
    expect(await count()).toBe(1);

    // 第二条动作：grant.dailyQuota=1 已耗尽 → 429，且不会落第二行。
    const second = await prepareExternalAction({ kind: 'travel.wish', args: wishArgs, actionId: 'act-wish-quota' });
    const quota = await call('/autonomy-life/v1/external/wish', { charId: CHAR, text: '想去海边看一次日出', ...second });
    expect(quota?.status).toBe(429);
    expect(await count()).toBe(1);
  });

  it('许可签发之后新增匹配的禁区/回避话题 → 副作用前按当前策略拒绝（fetch=0、愿望零新增）', async () => {
    const wishBinding = await prepareExternalAction({ kind: 'travel.wish', args: wishArgs, actionId: 'act-wish-avoid' });
    const readBinding = await prepareExternalAction({ kind: 'external.read', args: readArgs, actionId: 'act-read-avoid' });

    // 保留 grant 与 allowedKinds，只加 avoidTopics（许可已经签好了）。
    await seedAccountBoundary({
      allowedKinds: ['external.read', 'travel.wish'],
      externalGrants: [grant('xhs', { dailyQuota: 5 }), grant('amap', { dailyQuota: 5 })],
      avoidTopics: ['咖啡', '海边'],
    });
    const wishCount = async () => Number((await db.prepare('SELECT COUNT(*) AS n FROM autonomy_life_wishes WHERE owner_id = ?').bind(USER).first())?.n ?? 0);
    const before = await wishCount();

    const readRes = await call(
      '/autonomy-life/v1/external/read',
      { charId: CHAR, query: '咖啡', fields: ['title'], ...readBinding },
      { AUTONOMY_EXTERNAL_XHS_URL: 'https://xhs.example/read', AUTONOMY_EXTERNAL_READ_HOSTS: 'xhs.example' },
    );
    expect(readRes?.status).toBe(403);
    expect((await readRes!.json() as any).error.code).toBe('POLICY_DENIED');

    const wishRes = await call('/autonomy-life/v1/external/wish', { charId: CHAR, text: '想去海边看一次日出', ...wishBinding });
    expect(wishRes?.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await wishCount()).toBe(before);
    // 许可未被核销：拒的是「当前策略」，不是「许可坏了」。
    const untouched = await createD1LifeStore({ db, ownerId: USER, now: () => NOW }).getAction('act-wish-avoid');
    expect(untouched?.permitConsumedAt).toBeNull();
  });

  it('许可签发之后把同类动作上限收紧到 0 → 按当前 limits 拒绝（零副作用）', async () => {
    const binding = await prepareExternalAction({ kind: 'external.read', args: readArgs, actionId: 'act-read-limit' });
    await seedAccountBoundary({
      allowedKinds: ['external.read'],
      externalGrants: [grant('xhs', { dailyQuota: 5 })],
      limits: { perKindActionsPerDay: 0 },
    });
    const res = await call(
      '/autonomy-life/v1/external/read',
      { charId: CHAR, query: '咖啡', fields: ['title'], ...binding },
      { AUTONOMY_EXTERNAL_XHS_URL: 'https://xhs.example/read', AUTONOMY_EXTERNAL_READ_HOSTS: 'xhs.example' },
    );
    expect(res?.status).toBe(429);
    expect((await res!.json() as any).error.code).toBe('RATE_LIMITED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('读完边界、核销 UPDATE 之前才加禁区 → 边界 revision CAS 让整笔失败（真 SQL 竞态）', async () => {
    const binding = await prepareExternalAction({ kind: 'external.read', args: readArgs, actionId: 'act-read-race-policy' });
    let injected = false;
    fresh({
      beforeStatement: (text) => {
        if (!injected && /UPDATE autonomy_life_actions/.test(text)) {
          injected = true;
          // 另一台设备在这个空隙里加了匹配当前 query 的回避话题（revision 一起变）。
          sql.prepare(`UPDATE autonomy_life_boundaries
            SET revision = revision + 1,
                payload = json_set(payload, '$.avoidTopics', json('["咖啡"]'))
            WHERE owner_id = ? AND scope = 'account' AND char_id = ''`)
            .run(USER);
        }
      },
    });
    resetAutonomyLifeSchemaCacheForTesting();
    await ensureAutonomyLifeSchema(db);

    const res = await call(
      '/autonomy-life/v1/external/read',
      { charId: CHAR, query: '咖啡', fields: ['title'], ...binding },
      { AUTONOMY_EXTERNAL_XHS_URL: 'https://xhs.example/read', AUTONOMY_EXTERNAL_READ_HOSTS: 'xhs.example' },
    );
    expect(injected).toBe(true);
    expect(res?.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
    const after = await createD1LifeStore({ db, ownerId: USER, now: () => NOW }).getAction('act-read-race-policy');
    expect(after?.permitConsumedAt).toBeNull();
  });

  it('读完凭据、核销 UPDATE 之前凭据被释放 → 核销失败（零出网）', async () => {
    const binding = await prepareExternalAction({ kind: 'external.read', args: readArgs, actionId: 'act-read-race-rsv' });
    const runtime = createAutonomyLifeRuntime({ db, userId: USER, charId: CHAR, now: () => NOW });
    const row = (await runtime.store.getAction('act-read-race-rsv'))!;
    let injected = false;
    fresh({
      beforeStatement: (text) => {
        if (!injected && /UPDATE autonomy_life_actions/.test(text)) {
          injected = true;
          sql.prepare("UPDATE autonomy_life_budget_reservations SET state = 'released', revision = revision + 1 WHERE owner_id = ? AND reservation_id = ?")
            .run(USER, row.reservationId);
        }
      },
    });
    resetAutonomyLifeSchemaCacheForTesting();
    await ensureAutonomyLifeSchema(db);

    const res = await call(
      '/autonomy-life/v1/external/read',
      { charId: CHAR, query: '咖啡', fields: ['title'], ...binding },
      { AUTONOMY_EXTERNAL_XHS_URL: 'https://xhs.example/read', AUTONOMY_EXTERNAL_READ_HOSTS: 'xhs.example' },
    );
    expect(injected).toBe(true);
    expect(res?.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * 上一轮退回的第 1 项：正式端点的**最终授权额度核销**也必须带当前边界条件。
   *
   * 场景固定为「许可 CAS 已经成功 → external_usage 语句执行之前」，用真 SQLite 的
   * `beforeStatement` 钩子插入另一台设备的写入（收紧额度 / 撤权 / 暂停）。
   * 期望：本轮零出网、零愿望；额度行不被占用；不是按「读边界时的旧 grant.dailyQuota」放行。
   */
  const injectBeforeQuotaStatement = async (statements: string[]) => {
    let permitConsumed = false;
    const injected = { value: false };
    fresh({
      beforeStatement: (text) => {
        if (/UPDATE autonomy_life_actions/.test(text)) {
          permitConsumed = true;
          return;
        }
        if (!injected.value && permitConsumed && /autonomy_life_external_usage/.test(text)) {
          injected.value = true;
          for (const statement of statements) sql.prepare(statement).run(USER);
        }
      },
    });
    resetAutonomyLifeSchemaCacheForTesting();
    await ensureAutonomyLifeSchema(db);
    return injected;
  };

  const usageRows = async (provider: 'xhs' | 'amap') => Number(
    (await db.prepare('SELECT COALESCE(SUM(used), 0) AS used FROM autonomy_life_external_usage WHERE owner_id = ? AND provider = ?')
      .bind(USER, provider).first())?.used ?? 0,
  );
  const wishRows = async () => Number(
    (await db.prepare('SELECT COUNT(*) AS n FROM autonomy_life_wishes WHERE owner_id = ?').bind(USER).first())?.n ?? 0,
  );
  const readEnv = { AUTONOMY_EXTERNAL_XHS_URL: 'https://xhs.example/read', AUTONOMY_EXTERNAL_READ_HOSTS: 'xhs.example' };

  it('许可 CAS 之后把授权额度收紧到 0（不动 revision）→ 终局核销拒绝、零出网、零额度占用', async () => {
    const binding = await prepareExternalAction({
      kind: 'external.read',
      args: readArgs,
      actionId: 'act-read-quota-tighten',
      grantOverrides: { dailyQuota: 5 },
    });
    const injected = await injectBeforeQuotaStatement([
      `UPDATE autonomy_life_boundaries
        SET payload = json_set(payload, '$.externalGrants[0].dailyQuota', 0)
        WHERE owner_id = ? AND scope = 'account' AND char_id = ''`,
    ]);
    const res = await call('/autonomy-life/v1/external/read', { charId: CHAR, query: '咖啡', fields: ['title'], ...binding }, readEnv);
    expect(injected.value).toBe(true);
    // 旧实现会按读边界时的 dailyQuota=5 放行；现在按执行那一刻的额度判 → 429。
    expect(res?.status).toBe(429);
    expect((await res!.json() as any).error.message).toBe('external_daily_quota_exhausted');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await usageRows('xhs')).toBe(0);
    // 许可 CAS 已成功、额度这一关才拒：许可被烧掉，动作不可重放（fail closed，执行器按失败回执）。
    // 这是有意的保守方向：宁可这一笔作废，也不让「许可已核销 → 效果被拒」的窗口可重试。
    const burned = await createD1LifeStore({ db, ownerId: USER, now: () => NOW }).getAction('act-read-quota-tighten');
    expect(burned?.permitConsumedAt).toBe(NOW);
  });

  it('许可 CAS 之后撤销授权（bump revision）→ 409，读取零出网、愿望零新增', async () => {
    const readBinding = await prepareExternalAction({
      kind: 'external.read',
      args: readArgs,
      actionId: 'act-read-grant-revoked-race',
      grantOverrides: { dailyQuota: 5 },
    });
    const readInjected = await injectBeforeQuotaStatement([
      `UPDATE autonomy_life_boundaries
        SET revision = revision + 1,
            payload = json_set(payload, '$.externalGrants', json('[]'))
        WHERE owner_id = ? AND scope = 'account' AND char_id = ''`,
    ]);
    const readRes = await call('/autonomy-life/v1/external/read', { charId: CHAR, query: '咖啡', fields: ['title'], ...readBinding }, readEnv);
    expect(readInjected.value).toBe(true);
    expect(readRes?.status).toBe(409);
    expect((await readRes!.json() as any).error.message).toBe('boundary_changed');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await usageRows('xhs')).toBe(0);

    const wishBinding = await prepareExternalAction({
      kind: 'travel.wish',
      args: wishArgs,
      actionId: 'act-wish-grant-revoked-race',
      grantOverrides: { dailyQuota: 5 },
    });
    const wishInjected = await injectBeforeQuotaStatement([
      `UPDATE autonomy_life_boundaries
        SET revision = revision + 1,
            payload = json_set(payload, '$.externalGrants', json('[]'))
        WHERE owner_id = ? AND scope = 'account' AND char_id = ''`,
    ]);
    const wishRes = await call('/autonomy-life/v1/external/wish', { charId: CHAR, text: '想去海边看一次日出', ...wishBinding });
    expect(wishInjected.value).toBe(true);
    expect(wishRes?.status).toBe(409);
    expect(await wishRows()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('许可 CAS 之后账号总暂停（bump revision）→ 读取 409 零出网、愿望零新增', async () => {
    const readBinding = await prepareExternalAction({
      kind: 'external.read',
      args: readArgs,
      actionId: 'act-read-pause-race',
      grantOverrides: { dailyQuota: 5 },
    });
    const readInjected = await injectBeforeQuotaStatement([
      `UPDATE autonomy_life_boundaries
        SET revision = revision + 1,
            payload = json_set(payload, '$.globalPaused', json('true'))
        WHERE owner_id = ? AND scope = 'account' AND char_id = ''`,
    ]);
    const readRes = await call('/autonomy-life/v1/external/read', { charId: CHAR, query: '咖啡', fields: ['title'], ...readBinding }, readEnv);
    expect(readInjected.value).toBe(true);
    expect(readRes?.status).toBe(409);
    expect((await readRes!.json() as any).error.message).toBe('boundary_changed');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await usageRows('xhs')).toBe(0);

    const binding = await prepareExternalAction({
      kind: 'travel.wish',
      args: wishArgs,
      actionId: 'act-wish-pause-race',
      grantOverrides: { dailyQuota: 5 },
    });
    const injected = await injectBeforeQuotaStatement([
      `UPDATE autonomy_life_boundaries
        SET revision = revision + 1,
            payload = json_set(payload, '$.globalPaused', json('true'))
        WHERE owner_id = ? AND scope = 'account' AND char_id = ''`,
    ]);
    const res = await call('/autonomy-life/v1/external/wish', { charId: CHAR, text: '想去海边看一次日出', ...binding });
    expect(injected.value).toBe(true);
    expect(res?.status).toBe(409);
    expect((await res!.json() as any).error.message).toBe('boundary_changed');
    expect(await wishRows()).toBe(0);
    expect(await usageRows('amap')).toBe(0);
  });

  it('许可 CAS 之后把出行授权额度收紧到 0（不动 revision）→ 429，愿望零新增', async () => {
    const binding = await prepareExternalAction({
      kind: 'travel.wish',
      args: wishArgs,
      actionId: 'act-wish-quota-tighten',
      grantOverrides: { dailyQuota: 5 },
    });
    const injected = await injectBeforeQuotaStatement([
      `UPDATE autonomy_life_boundaries
        SET payload = json_set(payload, '$.externalGrants[0].dailyQuota', 0)
        WHERE owner_id = ? AND scope = 'account' AND char_id = ''`,
    ]);
    const res = await call('/autonomy-life/v1/external/wish', { charId: CHAR, text: '想去海边看一次日出', ...binding });
    expect(injected.value).toBe(true);
    expect(res?.status).toBe(429);
    expect((await res!.json() as any).error.message).toBe('external_daily_quota_exhausted');
    expect(await wishRows()).toBe(0);
    expect(await usageRows('amap')).toBe(0);
  });

  it('正向：授权额度 1 时第一次读取成功并出网一次，第二次 429 且不再出网', async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ items: [{ title: '咖啡地图' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }) as never);
    const first = await prepareExternalAction({ kind: 'external.read', args: readArgs, actionId: 'act-read-quota-first' });
    const firstRes = await call('/autonomy-life/v1/external/read', { charId: CHAR, query: '咖啡', fields: ['title'], ...first }, readEnv);
    expect(firstRes?.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await usageRows('xhs')).toBe(1);

    const second = await prepareExternalAction({ kind: 'external.read', args: readArgs, actionId: 'act-read-quota-second' });
    const secondRes = await call('/autonomy-life/v1/external/read', { charId: CHAR, query: '咖啡', fields: ['title'], ...second }, readEnv);
    expect(secondRes?.status).toBe(429);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await usageRows('xhs')).toBe(1);
  });

  it('并发抢授权窗口的最后一格：只允许一笔出网，额度不超卖', async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ items: [{ title: '咖啡地图' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }) as never);
    const a = await prepareExternalAction({ kind: 'external.read', args: readArgs, actionId: 'act-read-race-quota-a' });
    const b = await prepareExternalAction({ kind: 'external.read', args: readArgs, actionId: 'act-read-race-quota-b' });
    const results = await Promise.all([
      call('/autonomy-life/v1/external/read', { charId: CHAR, query: '咖啡', fields: ['title'], ...a }, readEnv),
      call('/autonomy-life/v1/external/read', { charId: CHAR, query: '咖啡', fields: ['title'], ...b }, readEnv),
    ]);
    expect(results.map((res) => res?.status).sort()).toEqual([200, 429]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await usageRows('xhs')).toBe(1);
  });
});
