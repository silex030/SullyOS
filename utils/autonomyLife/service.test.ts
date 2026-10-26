/**
 * HTTP 逻辑层与前端传输封装（契约 §7）：
 *   - 所有响应带 schemaVersion/requestId/serverTime；
 *   - PATCH 旧频率字段 422、revision 冲突 409；
 *   - 暂停返回 acknowledged/quiesced（不是「已撤销在途」）；
 *   - activities 稳定降序分页；
 *   - cancel 冲突 409 CANNOT_CANCEL。
 *
 * 传输层（不手拼 URL / Idempotency-Key / 错误映射）只在 utils/autonomyLife/api.ts 的
 * api.test.ts 里测一份，这里不再重复第二个客户端。
 */
import { describe, expect, it } from 'vitest';

import type { BoundaryV1, EffectiveBoundaryV1 } from '../../contracts/autonomyLife';
import { normalizeBoundary } from './boundary';
import { budgetWindowId } from './time';
import { createMemoryBudgetPort, reserveBudget } from './budget';
import type { BudgetPort } from './budget';
import { buildActionRow, createInMemoryLifeStore, emptyCharacterLife, reportReceipt, type EngineDeps } from './engine';
import { createAutonomyLifeService, type AutonomyLifeServiceDeps, type BoundaryRepo } from './service';

const NOW = Date.UTC(2026, 9, 24, 4, 0, 0);
const TZ = 'Asia/Shanghai';
const CHAR = 'char-http';

const BASE_LIMITS: EffectiveBoundaryV1['limits'] = {
  accountModelCallsPerDay: 6,
  charModelCallsPerDay: 2,
  accountTokensPerDay: 10_000,
  charTokensPerDay: 4_000,
  notificationsPerDay: 1,
  perKindActionsPerDay: 3,
  virtualSpendPerDayMinor: 20_000,
  virtualOrderMaxMinor: 5_000,
};

const accountBoundary = (raw: Record<string, unknown> = {}, revision = 1): BoundaryV1 => normalizeBoundary(
  { enabled: true, globalPaused: false, timezone: TZ, allowedKinds: ['journal.write'], ...raw },
  { scope: 'account', nowMs: NOW, revision },
);

function memoryBoundaries(initial = accountBoundary()): BoundaryRepo & { current: { account: BoundaryV1; characters: Map<string, BoundaryV1> } } {
  const state = { account: initial, characters: new Map<string, BoundaryV1>() };
  return {
    current: state,
    async getAccount() { return state.account; },
    async getCharacter(charId) { return state.characters.get(charId) ?? null; },
    async put(target, boundary, expectedRevision) {
      if (target.scope === 'character') {
        const current = state.characters.get(target.charId);
        if (current && current.revision !== expectedRevision) return false;
        state.characters.set(target.charId, boundary);
        return true;
      }
      if (state.account.revision !== expectedRevision) return false;
      state.account = boundary;
      return true;
    },
  };
}

function serviceDeps(opts?: { account?: BoundaryV1 }): { deps: AutonomyLifeServiceDeps; store: ReturnType<typeof createInMemoryLifeStore>; boundaries: ReturnType<typeof memoryBoundaries> } {
  const clock = { now: () => NOW };
  const store = createInMemoryLifeStore();
  const budget = createMemoryBudgetPort();
  const boundaries = memoryBoundaries(opts?.account);
  const engine: EngineDeps = {
    store,
    budget: budget as BudgetPort,
    clock,
    seed: 'seed-http',
    accountId: 'acct-http',
    deviceOnline: async () => true,
    probes: async () => ({
      localStoresReady: true,
      deviceBound: true,
      hasModelCredentials: true,
      externalRead: { configured: false, reachable: false },
      map: { configured: false, reachable: false },
    }),
    boundaryFor: async () => {
      const account = await boundaries.getAccount();
      return {
        ...account,
        scope: 'account',
        enabled: account.enabled ?? true,
        globalPaused: account.globalPaused ?? false,
        charEnabled: account.charEnabled ?? true,
        timezone: account.timezone ?? TZ,
        allowedKinds: account.allowedKinds ?? ['journal.write'],
        allowFictionalNpc: account.allowFictionalNpc ?? false,
        limits: { ...BASE_LIMITS, ...account.limits },
      } as EffectiveBoundaryV1;
    },
    candidatesFor: () => [{ kind: 'journal.write', semanticPurpose: 'note', args: { title: 't', body: 'b' } }],
    model: { request: async () => ({ candidates: [{ kind: 'journal.write', semanticPurpose: 'note', args: { title: 't', body: 'b' } }], tokensUsed: 10 }) },
  };
  let counter = 0;
  const deps: AutonomyLifeServiceDeps = {
    engine,
    store,
    budget: budget as BudgetPort,
    boundaries,
    probes: async () => ({
      localStoresReady: true,
      deviceBound: true,
      hasModelCredentials: true,
      externalRead: { configured: false, reachable: false },
      map: { configured: false, reachable: false },
    }),
    budgetRows: async () => ({ account: null, char: null }),
    now: () => NOW,
    requestId: () => `req-${++counter}`,
  };
  return { deps, store, boundaries };
}

describe('服务：状态与边界（§7）', () => {
  it('没有自主记录时返回空状态（尚无自主活动），并带 schemaVersion/requestId/serverTime', async () => {
    const { deps } = serviceDeps();
    const service = createAutonomyLifeService(deps);
    const response = await service.getState(CHAR);
    expect(response.status).toBe(200);
    const body = response.body as any;
    expect(body.schemaVersion).toBe(1);
    expect(body.requestId).toMatch(/^req-/);
    expect(body.serverTime).toBe(NOW);
    expect(body.state.lifePhase).toBe('idle');
    expect(body.capabilities.find((item: any) => item.kind === 'journal.write').available).toBe(true);
    expect(body.capabilities.find((item: any) => item.kind === 'external.read').unavailableReason).toBe('external_adapter_not_configured');
  });

  it('总暂停时 state.availability=paused 且 reasonCodes 带 GLOBAL_PAUSED（不是「角色不想动」）', async () => {
    const { deps } = serviceDeps({ account: accountBoundary({ globalPaused: true, charEnabled: false }) });
    const service = createAutonomyLifeService(deps);
    const body = (await service.getState(CHAR)).body as any;
    expect(body.state.availability).toBe('paused');
    expect(body.state.reasonCodes).toContain('GLOBAL_PAUSED');
  });

  it('GET /boundaries 返回 defaults/maximums/effective（UI 只读元数据）', async () => {
    const { deps } = serviceDeps();
    const service = createAutonomyLifeService(deps);
    const body = (await service.getBoundaries(CHAR)).body as any;
    expect(body.defaults.accountModelCallsPerDay).toBe(6);
    expect(body.maximums.accountModelCallsPerDay).toBeGreaterThanOrEqual(6);
    expect(body.effective.timezone).toBe(TZ);
    expect(body.revision).toBe(1);
  });

  it('PATCH 旧频率字段 → 422 DEPRECATED_FIELD；revision 冲突 → 409', async () => {
    const { deps } = serviceDeps();
    const service = createAutonomyLifeService(deps);
    const deprecated = await service.patchBoundaries({
      scope: 'account', expectedRevision: 1, changes: { cadence: { minHours: 2 } },
    });
    expect(deprecated.status).toBe(422);
    expect((deprecated.body as any).error.code).toBe('DEPRECATED_FIELD');

    const conflict = await service.patchBoundaries({
      scope: 'account', expectedRevision: 9, changes: { timezone: 'Asia/Tokyo' },
    });
    expect(conflict.status).toBe(409);
    expect((conflict.body as any).error.code).toBe('REVISION_CONFLICT');

    const success = await service.patchBoundaries({
      scope: 'account', expectedRevision: 1, changes: { timezone: 'Asia/Tokyo' },
    });
    expect(success.status).toBe(200);
    expect((success.body as any).revision).toBe(2);
  });

  it('暂停：有在途许可时 acknowledged=true 但 quiesced=false（如实显示「正在停止」）', async () => {
    const { deps, store } = serviceDeps();
    const service = createAutonomyLifeService(deps);
    // 造一个已获许可的 running 动作。
    const action = buildActionRow({
      charId: CHAR,
      chosen: { kind: 'journal.write', semanticPurpose: 'note', purposeKey: 'pk', args: { title: 't', body: 'b' }, reasonSummary: 'r', candidate: { kind: 'journal.write', semanticPurpose: 'note' } },
      nowMs: NOW,
      budgetWindowId: budgetWindowId(NOW, TZ),
      reservationId: 'rsv',
      policyVersion: 'autonomy-life-v1',
      tz: TZ,
      installationId: 'install-1',
      online: true,
    });
    await store.insertAction({ ...action, status: 'running', permitIssuedAt: NOW, leaseEpoch: 1, leaseExpiresAt: NOW + 60_000 });
    const paused = await service.pause({ scope: 'account', paused: true });
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({ acknowledged: true, quiesced: false, paused: true });

    await reportReceipt(deps.engine, {
      accountId: 'acct-http', actionId: action.id, installationId: 'install-1', leaseEpoch: 1, argsHash: action.argsHash,
      status: 'succeeded', resultRef: 'diaries:1', nowMs: NOW + 1000,
    });
    const quiesced = await service.pause({ scope: 'account', paused: true });
    expect(quiesced.body).toMatchObject({ acknowledged: true, quiesced: true });
  });

  it('activities 稳定降序分页（limit+游标，不重复不跳条）', async () => {
    const { deps, store } = serviceDeps();
    const service = createAutonomyLifeService(deps);
    for (let i = 0; i < 3; i += 1) {
      const action = buildActionRow({
        charId: CHAR,
        chosen: { kind: 'journal.write', semanticPurpose: `note-${i}`, purposeKey: `pk-${i}`, args: { title: 't', body: 'b' }, reasonSummary: 'r', candidate: { kind: 'journal.write', semanticPurpose: `note-${i}` } },
        nowMs: NOW + i * 1000,
        budgetWindowId: budgetWindowId(NOW, TZ),
        reservationId: `rsv-${i}`,
        policyVersion: 'autonomy-life-v1',
        tz: TZ,
        installationId: 'install-1',
        online: true,
      });
      await store.insertAction(action);
    }
    const first = await service.activities({ charId: CHAR, limit: 2 });
    const firstBody = first.body as any;
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.items[0].occurredAt).toBeGreaterThan(firstBody.items[1].occurredAt);
    expect(firstBody.nextCursor).toBeTruthy();
    const second = await service.activities({ charId: CHAR, limit: 2, cursor: firstBody.nextCursor });
    const secondBody = second.body as any;
    expect(secondBody.items).toHaveLength(1);
    const ids = new Set([...firstBody.items, ...secondBody.items].map((item: any) => item.id));
    expect(ids.size).toBe(3);
  });

  it('cancel：scheduled 可取消；running 返回 409 CANNOT_CANCEL', async () => {
    const { deps, store } = serviceDeps();
    const service = createAutonomyLifeService(deps);
    const makeAction = (suffix: string) => buildActionRow({
      charId: CHAR,
      chosen: { kind: 'journal.write', semanticPurpose: suffix, purposeKey: `p-${suffix}`, args: { title: 't', body: 'b' }, reasonSummary: 'r', candidate: { kind: 'journal.write', semanticPurpose: suffix } },
      nowMs: NOW,
      budgetWindowId: budgetWindowId(NOW, TZ),
      reservationId: 'rsv',
      policyVersion: 'autonomy-life-v1',
      tz: TZ,
      installationId: 'install-1',
      online: true,
    });
    const scheduled = makeAction('a');
    await store.insertAction(scheduled);
    const cancelled = await service.cancel({ actionId: scheduled.id, expectedRevision: scheduled.revision });
    expect(cancelled.status).toBe(200);
    expect((cancelled.body as any).action.status).toBe('cancelled');

    const running = { ...makeAction('b'), status: 'running' as const, permitIssuedAt: NOW };
    await store.insertAction(running);
    const cannot = await service.cancel({ actionId: running.id, expectedRevision: running.revision });
    expect(cannot.status).toBe(409);
    expect((cannot.body as any).error.code).toBe('CANNOT_CANCEL');
  });

  it('claim → commit-permit → receipt：错误租约被拒，正确回执落终态', async () => {
    const { deps, store } = serviceDeps();
    const service = createAutonomyLifeService(deps);

    // 伪造的预留 id（没有本窗口的预算依据）不能换来许可：先把它钉住。
    const forged = buildActionRow({
      charId: CHAR,
      chosen: { kind: 'journal.write', semanticPurpose: 'c', purposeKey: 'pc', args: { title: 't', body: 'b' }, reasonSummary: 'r', candidate: { kind: 'journal.write', semanticPurpose: 'c' } },
      nowMs: NOW,
      budgetWindowId: budgetWindowId(NOW, TZ),
      reservationId: 'rsv-made-up',
      policyVersion: 'autonomy-life-v1',
      tz: TZ,
      installationId: 'install-1',
      online: true,
    });
    await store.insertAction(forged);
    await store.bindInstallation('acct-http', 'install-1', NOW);
    const forgedClaim = await service.claim({ installationId: 'install-1', charId: CHAR });
    const forgedPermit = await service.commitPermit({
      actionId: forged.id,
      installationId: 'install-1',
      leaseEpoch: (forgedClaim.body as any).leaseEpoch,
      argsHash: forged.argsHash,
      policyVersion: 'autonomy-life-v1',
    });
    expect(forgedPermit.status).toBe(409);
    // 让它退出「可领取」，免得后面 claim 又碰到它（伪造许可不该改变它的状态）。
    const stillScheduled = (await store.getAction(forged.id))!;
    expect(stillScheduled.status).toBe('scheduled');
    await store.putAction({ ...stillScheduled, status: 'cancelled' }, stillScheduled.revision);

    // 真预留（reserveBudget 写的预算行 + 正规 id）才发得出许可。
    const reserved = await reserveBudget(deps.budget, {
      nowMs: NOW,
      windowTimezone: TZ,
      accountId: 'acct-http',
      charId: CHAR,
      limits: BASE_LIMITS,
      tokens: 100,
      kind: 'journal.write',
    });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    const reservedAction = buildActionRow({
      charId: CHAR,
      chosen: { kind: 'journal.write', semanticPurpose: 'c', purposeKey: 'pc2', args: { title: 't', body: 'b' }, reasonSummary: 'r', candidate: { kind: 'journal.write', semanticPurpose: 'c' } },
      nowMs: NOW,
      budgetWindowId: budgetWindowId(NOW, TZ),
      reservationId: reserved.grant.reservationId,
      policyVersion: 'autonomy-life-v1',
      tz: TZ,
      installationId: 'install-1',
      online: true,
    });
    // 引擎在落动作时把凭据绑定到动作（这里手动补同一步：只认绑定过的那条）。
    expect(await deps.budget.bindReservation({
      reservationId: reserved.grant.reservationId,
      actionId: reservedAction.id,
      charId: CHAR,
      windowId: budgetWindowId(NOW, TZ),
      nowMs: NOW,
    })).toBe(true);
    await store.insertAction(reservedAction);
    const action = reservedAction;
    const claimed = await service.claim({ installationId: 'install-1', charId: CHAR });
    const claimedBody = claimed.body as any;
    expect(claimedBody.action.id).toBe(action.id);

    const wrongLease = await service.commitPermit({
      actionId: action.id, installationId: 'install-1', leaseEpoch: 99, argsHash: action.argsHash, policyVersion: 'autonomy-life-v1',
    });
    expect(wrongLease.status).toBe(409);

    const permit = await service.commitPermit({
      actionId: action.id, installationId: 'install-1', leaseEpoch: claimedBody.leaseEpoch, argsHash: action.argsHash, policyVersion: 'autonomy-life-v1',
    });
    expect(permit.status).toBe(200);
    expect((permit.body as any).permit.expiresAt).toBe(NOW + 60_000);

    const receipt = await service.receipt({
      actionId: action.id, installationId: 'install-1', leaseEpoch: claimedBody.leaseEpoch, argsHash: action.argsHash,
      status: 'succeeded', resultRef: 'diaries:7',
    });
    expect(receipt.status).toBe(200);
  });

  it('设备注册不自动抢占已绑定设备（requiresExplicitSwitch）', async () => {
    const { deps, store } = serviceDeps();
    const service = createAutonomyLifeService(deps);
    await store.bindInstallation('acct-http', 'install-1', NOW);
    const body = (await service.registerDevice({ installationId: 'install-2' })).body as any;
    expect(body.bindingState).toBe('not_bound');
    expect(body.requiresExplicitSwitch).toBe(true);
    expect(await store.getBoundInstallation('acct-http')).toBe('install-1');
  });
});
