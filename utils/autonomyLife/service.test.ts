/**
 * HTTP 逻辑层与前端传输封装（契约 §7）：
 *   - 所有响应带 schemaVersion/requestId/serverTime；
 *   - PATCH 旧频率字段 422、revision 冲突 409；
 *   - 暂停返回 acknowledged/quiesced（不是「已撤销在途」）；
 *   - activities 稳定降序分页；
 *   - cancel 冲突 409 CANNOT_CANCEL；
 *   - 客户端不手拼 URL、自动带 Idempotency-Key、错误映射成 AutonomyLifeApiError。
 */
import { describe, expect, it } from 'vitest';

import type { BoundaryV1, EffectiveBoundaryV1 } from '../../contracts/autonomyLife';
import { normalizeBoundary } from './boundary';
import { createMemoryBudgetPort } from './budget';
import type { BudgetPort } from './budget';
import { buildActionRow, createInMemoryLifeStore, emptyCharacterLife, reportReceipt, type EngineDeps } from './engine';
import { createAutonomyLifeService, type AutonomyLifeServiceDeps, type BoundaryRepo } from './service';
import { AutonomyLifeApiError, createAutonomyLifeClient, type TransportRequest } from './client';
import { AUTONOMY_LIFE_API_BASE } from '../../contracts/autonomyLife';

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
      budgetWindowId: 'w:1',
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
        budgetWindowId: 'w:1',
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
      budgetWindowId: 'w:1',
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
    const action = buildActionRow({
      charId: CHAR,
      chosen: { kind: 'journal.write', semanticPurpose: 'c', purposeKey: 'pc', args: { title: 't', body: 'b' }, reasonSummary: 'r', candidate: { kind: 'journal.write', semanticPurpose: 'c' } },
      nowMs: NOW,
      budgetWindowId: 'w:1',
      reservationId: 'rsv',
      policyVersion: 'autonomy-life-v1',
      tz: TZ,
      installationId: 'install-1',
      online: true,
    });
    await store.insertAction(action);
    await store.bindInstallation('acct-http', 'install-1', NOW);
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

describe('客户端：只走封装，不手拼 URL（§7 / §8）', () => {
  it('生成 base 路径、自动带 Idempotency-Key，并把错误信封映射成 AutonomyLifeApiError', async () => {
    const seen: TransportRequest[] = [];
    const client = createAutonomyLifeClient({
      installationId: 'install-9',
      transport: async (request) => {
        seen.push(request);
        if (request.path.includes('/boundaries') && request.method === 'PATCH') {
          return {
            status: 422,
            body: {
              schemaVersion: 1,
              requestId: 'req-x',
              serverTime: NOW,
              error: { code: 'DEPRECATED_FIELD', message: 'frequency_fields_removed', retryable: false, details: { fields: ['cadence'] } },
            },
          };
        }
        return { status: 200, body: { schemaVersion: 1, requestId: 'req-y', serverTime: NOW, items: [], nextCursor: null } };
      },
    });

    await client.activities({ charId: CHAR, limit: 20 });
    expect(seen[0].path).toBe(`${AUTONOMY_LIFE_API_BASE}/activities?charId=${CHAR}&limit=20`);
    expect(seen[0].method).toBe('GET');

    const failure = client.patchBoundaries({ scope: 'account', expectedRevision: 1, changes: { cadence: {} } });
    await expect(failure).rejects.toBeInstanceOf(AutonomyLifeApiError);
    await expect(failure).rejects.toMatchObject({ status: 422, code: 'DEPRECATED_FIELD', details: { fields: ['cadence'] } });
    const patchRequest = seen[1];
    expect(patchRequest.headers?.['Idempotency-Key']).toBeTruthy();
    expect(patchRequest.path).toBe(`${AUTONOMY_LIFE_API_BASE}/boundaries`);
    expect(JSON.stringify(patchRequest.body)).toContain('expectedRevision');
  });

  it('claim / receipt 自动带 installationId（服务端不必信任 body 里的 ownerId）', async () => {
    const seen: TransportRequest[] = [];
    const client = createAutonomyLifeClient({
      installationId: 'install-9',
      transport: async (request) => {
        seen.push(request);
        return { status: 200, body: { schemaVersion: 1, requestId: 'r', serverTime: NOW, action: null } };
      },
    });
    await client.claim(CHAR);
    await client.receipt({ actionId: 'act-1', leaseEpoch: 2, argsHash: 'h', status: 'succeeded', resultRef: 'diaries:1' });
    expect((seen[0].body as any).installationId).toBe('install-9');
    expect((seen[1].body as any).installationId).toBe('install-9');
    expect(seen[1].headers?.['Idempotency-Key']).toBe('receipt-act-1');
  });

  it('schemaVersion 不一致时按升级处理（旧客户端不能继续制造副作用）', async () => {
    const client = createAutonomyLifeClient({
      installationId: 'i',
      transport: async () => ({ status: 200, body: { schemaVersion: 0, requestId: 'r', serverTime: NOW } }),
    });
    await expect(client.getState(CHAR)).rejects.toMatchObject({ code: 'AUTONOMY_UPGRADE_REQUIRED' });
  });
});
