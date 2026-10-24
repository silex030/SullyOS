/**
 * 自主生活 HTTP 服务的逻辑层（契约 §7）。这里是**唯一**实现这组语义的地方：
 * worker 路由（D1 端口）与测试（内存端口）都调它，避免两边各写一份规则。
 *
 * 返回形状固定为 `{status, body}`：body 要么是带 schemaVersion/requestId/serverTime 的成功体，
 * 要么是契约 §7 的错误信封。业务「已登记但受限」用 200 + status/reason，不塞进错误。
 *
 * 刻意不做的事：这里不碰 D1 / HTTP 细节，也不做鉴权（ownerId 必须由路由层从会话派生，
 * 绝不信任 body 里的 ownerId）。
 */

import {
  AUTONOMY_LIFE_SCHEMA_VERSION,
  buildErrorBody,
  httpStatusForError,
  isActivityKind,
  type ActivityRecord,
  type AutonomyLifeErrorCode,
  type BoundaryScope,
  type BoundaryV1,
  type Capability,
  type CharacterLifeState,
  type EffectiveBoundaryV1,
  type LifeEvent,
} from '../../contracts/autonomyLife';
import { applyBoundaryPatch, boundaryMetadata, mergeEffectiveBoundary } from './boundary';
import { projectBudgetUsage, type BudgetPort, type BudgetRow } from './budget';
import {
  actionCursor,
  cancelAction,
  claimAction,
  commitPermit,
  describeCapabilities,
  projectActivity,
  projectCharacterState,
  reportReceipt,
  requestPause,
  type ActionRow,
  type EngineDeps,
  type LifeStorePort,
} from './engine';
import type { CapabilityProbeState } from './adapters';

export interface BoundaryRepo {
  getAccount(): Promise<BoundaryV1>;
  getCharacter(charId: string): Promise<BoundaryV1 | null>;
  /** CAS：仅当当前 revision 等于 expectedRevision 时写入。 */
  put(
    target: { scope: 'account' } | { scope: 'character'; charId: string },
    boundary: BoundaryV1,
    expectedRevision: number,
  ): Promise<boolean>;
}

export interface AutonomyLifeServiceDeps {
  engine: EngineDeps;
  store: LifeStorePort;
  budget: BudgetPort;
  boundaries: BoundaryRepo;
  probes: (charId: string) => Promise<CapabilityProbeState>;
  /** 当前窗口的预算行（由部署侧的预算表读出；缺省视为 0）。 */
  budgetRows: (charId: string, nowMs: number) => Promise<{ account: BudgetRow | null; char: BudgetRow | null }>;
  now: () => number;
  requestId: () => string;
}

export interface ServiceResponse {
  status: number;
  body: Record<string, unknown>;
}

const ok = (deps: AutonomyLifeServiceDeps, data: Record<string, unknown>, status = 200): ServiceResponse => ({
  status,
  body: {
    schemaVersion: AUTONOMY_LIFE_SCHEMA_VERSION,
    requestId: deps.requestId(),
    serverTime: deps.now(),
    ...data,
  },
});

const fail = (
  deps: AutonomyLifeServiceDeps,
  code: AutonomyLifeErrorCode,
  message: string,
  extra?: { retryAt?: number; details?: Record<string, unknown> },
): ServiceResponse => ({
  status: httpStatusForError(code),
  body: buildErrorBody(code, message, { requestId: deps.requestId(), serverTime: deps.now(), ...extra }) as unknown as Record<string, unknown>,
});

export function createAutonomyLifeService(deps: AutonomyLifeServiceDeps) {
  const effectiveFor = async (charId: string): Promise<EffectiveBoundaryV1> => {
    const account = await deps.boundaries.getAccount();
    const character = await deps.boundaries.getCharacter(charId);
    return mergeEffectiveBoundary({ account, character, charId, nowMs: deps.now() });
  };

  return {
    /** GET /characters/{charId}/state */
    async getState(charId: string): Promise<ServiceResponse> {
      if (!charId) return fail(deps, 'VALIDATION_FAILED', 'charId_required');
      const nowMs = deps.now();
      const row = (await deps.store.getCharacterLife(charId))
        ?? (await deps.engine.store.getCharacterLife(charId));
      const effective = await effectiveFor(charId);
      const probes = await deps.probes(charId);
      const capabilities: Capability[] = describeCapabilities({ boundary: effective, probes, nowMs });
      const rows = await deps.budgetRows(charId, nowMs);
      if (!row) {
        // 还没有任何自主状态：给「尚无自主活动」的空状态，不编一个假进度。
        const empty: CharacterLifeState = {
          schemaVersion: AUTONOMY_LIFE_SCHEMA_VERSION,
          charId,
          revision: 0,
          observedAt: nowMs,
          lifePhase: 'idle',
          availability: effective.globalPaused ? 'paused' : 'ready',
          reasonCodes: effective.globalPaused ? ['GLOBAL_PAUSED'] : [],
          nextOpportunityAt: null,
          nextCheckAt: null,
          scheduleConfidence: 'fallback',
          activeActionId: null,
          pendingCount: 0,
          budgetWindowId: null,
          budget: projectBudgetUsage(rows.account, rows.char, effective.limits),
        };
        return ok(deps, { state: empty, capabilities });
      }
      const state = projectCharacterState({ row, capabilities, budgetRows: rows, limits: effective.limits, nowMs });
      return ok(deps, { state, capabilities });
    },

    /** GET /boundaries?charId= */
    async getBoundaries(charId?: string | null): Promise<ServiceResponse> {
      const account = await deps.boundaries.getAccount();
      const character = charId ? await deps.boundaries.getCharacter(charId) : null;
      const effective = mergeEffectiveBoundary({ account, character, charId: charId ?? '', nowMs: deps.now() });
      const meta = boundaryMetadata();
      return ok(deps, {
        account,
        characterOverrides: character,
        effective,
        revision: effective.revision,
        defaults: meta.defaults,
        maximums: meta.maximums,
      });
    },

    /** PATCH /boundaries */
    async patchBoundaries(input: {
      scope: BoundaryScope;
      charId?: string | null;
      expectedRevision: number;
      changes: unknown;
    }): Promise<ServiceResponse> {
      if (input.scope === 'character' && !input.charId) {
        return fail(deps, 'VALIDATION_FAILED', 'charId_required');
      }
      const current = input.scope === 'account'
        ? await deps.boundaries.getAccount()
        : (await deps.boundaries.getCharacter(input.charId!));
      if (!current) return fail(deps, 'NOT_FOUND', 'character_boundary_not_found');
      const patched = applyBoundaryPatch({
        current,
        changes: input.changes,
        expectedRevision: input.expectedRevision,
        nowMs: deps.now(),
      });
      if (!patched.ok) {
        if (patched.code === 'REVISION_CONFLICT') {
          return fail(deps, 'REVISION_CONFLICT', 'boundary_revision_conflict', { details: patched.details });
        }
        if (patched.code === 'DEPRECATED_FIELD') {
          return fail(deps, 'DEPRECATED_FIELD', 'frequency_fields_removed', { details: patched.details });
        }
        return fail(deps, 'VALIDATION_FAILED', 'boundary_invalid', { details: patched.details });
      }
      const saved = await deps.boundaries.put(
        input.scope === 'character' ? { scope: 'character', charId: input.charId! } : { scope: 'account' },
        patched.boundary,
        current.revision,
      );
      if (!saved) return fail(deps, 'REVISION_CONFLICT', 'boundary_revision_conflict');
      const account = await deps.boundaries.getAccount();
      const character = input.scope === 'character' ? await deps.boundaries.getCharacter(input.charId!) : null;
      const effective = mergeEffectiveBoundary({ account, character, charId: input.charId ?? '', nowMs: deps.now() });
      return ok(deps, { effective, revision: effective.revision });
    },

    /** POST /pause */
    async pause(input: {
      scope: BoundaryScope;
      charId?: string | null;
      paused: boolean;
      expectedRevision?: number;
    }): Promise<ServiceResponse> {
      if (input.scope === 'character') {
        if (!input.charId) return fail(deps, 'VALIDATION_FAILED', 'charId_required');
        const row = await deps.store.getCharacterLife(input.charId);
        if (!row) return fail(deps, 'NOT_FOUND', 'character_life_not_found');
        const saved = await deps.store.putCharacterLife(
          { ...row, revision: row.revision + 1, pauseRequestedAt: input.paused ? deps.now() : null, availability: input.paused ? 'paused' : 'ready', reasonCodes: input.paused ? ['GLOBAL_PAUSED'] : [] },
          row.revision,
        );
        if (!saved) return fail(deps, 'REVISION_CONFLICT', 'state_conflict');
        return ok(deps, { acknowledged: true, quiesced: input.paused ? (await deps.store.inflightPermits(deps.engine.accountId ?? 'account', deps.now())) === 0 : true, paused: input.paused, revision: row.revision + 1 });
      }
      const result = await requestPause(deps.engine, {
        accountId: deps.engine.accountId ?? 'account',
        paused: input.paused,
        nowMs: deps.now(),
      });
      const state = input.charId ? await deps.store.getCharacterLife(input.charId) : null;
      return ok(deps, {
        acknowledged: result.acknowledged,
        quiesced: result.quiesced,
        paused: result.paused,
        revision: result.revision,
        ...(state ? { state } : {}),
      });
    },

    /** GET /activities */
    async activities(input: {
      charId: string;
      status?: string | null;
      limit?: number;
      cursor?: string | null;
    }): Promise<ServiceResponse> {
      if (!input.charId) return fail(deps, 'VALIDATION_FAILED', 'charId_required');
      const limit = Math.min(100, Math.max(1, input.limit ?? 20));
      const list = deps.store.listActions
        ? await deps.store.listActions({ charId: input.charId, status: input.status ?? null, limit: limit + 1, cursor: input.cursor ?? null })
        : { items: [], nextCursor: null };
      const items: ActivityRecord[] = list.items.slice(0, limit).map(projectActivity);
      // 游标取「本页最后一条」，而不是 store 返回的最后一条（我们多取了一条探边界）。
      const nextCursor = list.items.length > limit ? actionCursor(list.items[limit - 1]) : null;
      return ok(deps, { items, nextCursor });
    },

    /** POST /actions/{id}/cancel */
    async cancel(input: { actionId: string; expectedRevision: number }): Promise<ServiceResponse> {
      const result = await cancelAction(deps.engine, {
        accountId: deps.engine.accountId ?? 'account',
        actionId: input.actionId,
        expectedRevision: input.expectedRevision,
        nowMs: deps.now(),
      });
      if (!result.ok) {
        if (result.code === 'NOT_FOUND') return fail(deps, 'NOT_FOUND', 'action_not_found');
        if (result.code === 'REVISION_CONFLICT') return fail(deps, 'REVISION_CONFLICT', 'action_revision_conflict');
        return fail(deps, 'CANNOT_CANCEL', 'action_cannot_cancel');
      }
      return ok(deps, { action: result.action });
    },

    /** POST /devices/register */
    async registerDevice(input: { installationId: string; capabilitiesVersion?: string }): Promise<ServiceResponse> {
      if (!input.installationId) return fail(deps, 'VALIDATION_FAILED', 'installationId_required');
      const accountId = deps.engine.accountId ?? 'account';
      const bound = await deps.store.getBoundInstallation(accountId);
      if (bound && bound !== input.installationId) {
        // 不自动抢占：换设备是显式操作，且要先对账在途动作。
        const inflight = await deps.store.inflightPermits(accountId, deps.now());
        return ok(deps, {
          bindingState: inflight > 0 ? 'switch_blocked' : 'not_bound',
          boundInstallationId: bound,
          requiresExplicitSwitch: true,
        });
      }
      const already = bound === input.installationId;
      if (!already) await deps.store.bindInstallation(accountId, input.installationId, deps.now());
      return ok(deps, { bindingState: already ? 'already_bound' : 'bound', boundInstallationId: input.installationId });
    },

    /** POST /execution/claim */
    async claim(input: { installationId: string; charId: string; leaseMs?: number }): Promise<ServiceResponse> {
      const result = await claimAction(deps.engine, {
        accountId: deps.engine.accountId ?? 'account',
        installationId: input.installationId,
        charId: input.charId,
        leaseMs: input.leaseMs,
      });
      if (!result.action) return ok(deps, { action: null, leaseEpoch: 0, leaseExpiresAt: null });
      return ok(deps, { action: result.action, leaseEpoch: result.leaseEpoch, leaseExpiresAt: result.leaseExpiresAt });
    },

    /** POST /actions/{id}/commit-permit */
    async commitPermit(input: {
      actionId: string;
      installationId: string;
      leaseEpoch: number;
      argsHash: string;
      policyVersion: string;
    }): Promise<ServiceResponse> {
      const result = await commitPermit(deps.engine, {
        accountId: deps.engine.accountId ?? 'account',
        ...input,
        nowMs: deps.now(),
      });
      if (!result.ok) {
        const code: AutonomyLifeErrorCode = result.code ?? 'STATE_CONFLICT';
        return fail(deps, code, 'permit_denied');
      }
      // 必须把条件提交后的**动作行**一起回给执行器：许可 nonce/租约到期都在这份行里，
      // 执行器不能拿 claim 时的旧快照去执行（旧快照没有 nonce，本地许可校验会失败）。
      return ok(deps, { permit: result.permit, action: result.action });
    },

    /** POST /actions/{id}/receipt */
    async receipt(input: {
      actionId: string;
      installationId: string;
      leaseEpoch: number;
      argsHash: string;
      status: 'succeeded' | 'failed' | 'unknown';
      resultRef?: string | null;
      errorCode?: AutonomyLifeErrorCode;
    }): Promise<ServiceResponse> {
      const result = await reportReceipt(deps.engine, {
        accountId: deps.engine.accountId ?? 'account',
        ...input,
        nowMs: deps.now(),
      });
      if (!result.ok) return fail(deps, result.code ?? 'STATE_CONFLICT', 'receipt_rejected');
      return ok(deps, { action: result.action });
    },

    /** 供 POST /actions 场景复用：动作参数必须是已实现 kind。 */
    isKnownKind(kind: string): boolean {
      return isActivityKind(kind);
    },

    /** 内部：给路由层做事件分页时用（事件由引擎 appendEvent 写入）。 */
    eventPage(events: LifeEvent[], after: number, limit = 50): { items: LifeEvent[]; nextSequence: number; hasMore: boolean } {
      const items = events.filter((event) => event.sequence > after).slice(0, limit);
      const nextSequence = items.length ? items[items.length - 1].sequence : after;
      return { items, nextSequence, hasMore: events.some((event) => event.sequence > nextSequence) };
    },

    /** 只读：把动作行投影成 UI 记录（路由层复用时避免重复实现）。 */
    projectAction(action: ActionRow): ActivityRecord {
      return projectActivity(action);
    },
  };
}

export type AutonomyLifeService = ReturnType<typeof createAutonomyLifeService>;
export type { LifeEvent };
