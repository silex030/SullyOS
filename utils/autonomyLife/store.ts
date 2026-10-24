/**
 * 自主生活 UI · 状态仓库（无 React，可单测）。
 *
 * 单一事实来源：state/capabilities/boundary/activities/events 全部来自服务端投影，
 * 这里只做「读 → 合并 → 通知订阅者」。用户点的每一次写都走 api，写成功后才更新快照；
 * 暂停允许先本地显示「仅本设备已停，云端待确认」，但绝不显示「已暂停」直到服务端 ack。
 *
 * 事件轮询：契约要求前台 30 秒短轮询、后台暂停；定时器由 React 层持有，
 * 这里只暴露 `pollEventsOnce()` 与 `resync()`，方便在测试里直接驱动。
 */

import type {
  ActionStatus,
  ActivityRecord,
  AutonomyLifeErrorCode,
  BoundaryScope,
  Capability,
  CharacterLifeState,
  LifeEvent,
} from '../../contracts/autonomyLife';
import type { AutonomyLifeApi, LifeBoundaryPayload } from './api';
import { pendingConfirmationsFromEvents, mergeEvents, sortActivities, type PendingConfirmation } from './view';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface StoreError {
  code: AutonomyLifeErrorCode | 'NOT_CONFIGURED' | 'NETWORK' | 'MALFORMED_RESPONSE' | 'DEPRECATED_FIELD_SENT';
  status: number;
  message?: string;
  at: number;
}

export interface PauseProgress {
  /** idle = 没有进行中的暂停请求。 */
  phase: 'idle' | 'stopping' | 'starting';
  /** 服务端 acknowledged：不再发新许可。 */
  acknowledged: boolean;
  /** 服务端 quiesced：在途许可已收尾，可以显示「全部已暂停」。 */
  quiesced: boolean;
}

export interface AutonomyLifeSnapshot {
  charId: string;
  status: LoadStatus;
  error: StoreError | null;
  state: CharacterLifeState | null;
  capabilities: Capability[];
  boundary: LifeBoundaryPayload | null;
  boundaryStatus: LoadStatus;
  boundaryError: StoreError | null;
  activities: ActivityRecord[];
  activitiesStatus: LoadStatus;
  activitiesError: StoreError | null;
  activitiesCursor: string | null;
  activitiesStatusFilter: ActionStatus | null;
  lastSequence: number;
  lastSyncedAt: number | null;
  /** 最近一次写操作（边界/暂停）的错误；成功后会清掉。 */
  writeError: StoreError | null;
  saving: boolean;
  pause: PauseProgress;
  /** 本地乐观暂停：屏幕先显示「正在停止」，等云端 acd/quiesced。 */
  localPauseRequested: boolean;
  pendingConfirmations: PendingConfirmation[];
  /** 一次性提示（保存成功、冲突后已刷新等）；由 UI 消费后清空。 */
  notice: string | null;
}

export interface AutonomyLifeStore {
  getSnapshot: () => AutonomyLifeSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** 首屏：并行读 state / boundary / activities。 */
  load: (opts?: { charId?: string }) => Promise<void>;
  refreshState: () => Promise<void>;
  refreshBoundary: () => Promise<void>;
  loadActivities: (opts?: { reset?: boolean; status?: ActionStatus | null }) => Promise<void>;
  loadMoreActivities: () => Promise<void>;
  /** 拉一次事件；自动处理 resyncRequired（丢弃增量并全量刷新）。 */
  pollEventsOnce: () => Promise<void>;
  resync: () => Promise<void>;
  saveBoundary: (changes: Record<string, unknown>, scope?: BoundaryScope) => Promise<boolean>;
  setPause: (paused: boolean, scope?: BoundaryScope) => Promise<boolean>;
  resolveConfirmation: (input: {
    id: string;
    decision: 'approve' | 'reject';
    payloadHash: string;
    nonce: string;
    expectedRevision: number;
  }) => Promise<boolean>;
  dismissNotice: () => void;
  dispose: () => void;
}

export interface AutonomyLifeStoreDeps {
  api: AutonomyLifeApi;
  charId: string;
  now?: () => number;
}

const initialSnapshot = (charId: string): AutonomyLifeSnapshot => ({
  charId,
  status: 'idle',
  error: null,
  state: null,
  capabilities: [],
  boundary: null,
  boundaryStatus: 'idle',
  boundaryError: null,
  activities: [],
  activitiesStatus: 'idle',
  activitiesError: null,
  activitiesCursor: null,
  activitiesStatusFilter: null,
  lastSequence: 0,
  lastSyncedAt: null,
  writeError: null,
  saving: false,
  pause: { phase: 'idle', acknowledged: false, quiesced: false },
  localPauseRequested: false,
  pendingConfirmations: [],
  notice: null,
});

const toStoreError = (code: string, status: number, message: string | undefined, at: number): StoreError => ({
  code: code as StoreError['code'],
  status,
  message,
  at,
});

export function createAutonomyLifeStore(deps: AutonomyLifeStoreDeps): AutonomyLifeStore {
  const now = deps.now ?? (() => Date.now());
  let snapshot = initialSnapshot(deps.charId);
  const listeners = new Set<() => void>();
  let inFlight: Promise<void> | null = null;
  let disposed = false;

  const emit = () => {
    if (disposed) return;
    for (const listener of [...listeners]) listener();
  };

  const patch = (next: Partial<AutonomyLifeSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    emit();
  };

  const applyState = (state: CharacterLifeState, capabilities: Capability[]) => {
    patch({
      state,
      capabilities,
      status: 'ready',
      error: null,
      lastSyncedAt: now(),
      // 服务端状态已落地就把「本地乐观暂停」收掉，避免两套真相并存。
      ...(snapshot.pause.phase === 'idle' && snapshot.localPauseRequested && state.availability !== 'pausing'
        ? { localPauseRequested: false }
        : {}),
    });
  };

  const readState = async (): Promise<boolean> => {
    // 账号总览页（Settings）没有角色维度：只读边界，不假装读到一个角色状态。
    if (!snapshot.charId) return false;
    const res = await deps.api.readLife(deps.charId);
    if (res.ok) {
      applyState(res.data.state, res.data.capabilities);
      return true;
    }
    patch({
      status: snapshot.state ? 'ready' : 'error',
      error: toStoreError(res.code, res.status, res.message, now()),
    });
    return false;
  };

  const readBoundary = async (): Promise<boolean> => {
    const res = await deps.api.readBoundaries(deps.charId);
    if (res.ok) {
      patch({ boundary: res.data, boundaryStatus: 'ready', boundaryError: null });
      return true;
    }
    patch({
      boundaryStatus: snapshot.boundary ? 'ready' : 'error',
      boundaryError: toStoreError(res.code, res.status, res.message, now()),
    });
    return false;
  };

  const readActivities = async (opts: { reset?: boolean; status?: ActionStatus | null } = {}): Promise<boolean> => {
    const reset = opts.reset ?? true;
    const status = opts.status === undefined ? snapshot.activitiesStatusFilter : opts.status;
    patch({ activitiesStatus: 'loading' });
    const res = await deps.api.readActivities({
      charId: deps.charId,
      status: status ?? undefined,
      limit: 20,
    });
    if (res.ok) {
      const items = reset
        ? sortActivities(res.data.items)
        : sortActivities([...snapshot.activities, ...res.data.items.filter((a) => !snapshot.activities.some((b) => b.id === a.id))]);
      patch({
        activities: items,
        activitiesCursor: res.data.nextCursor,
        activitiesStatus: 'ready',
        activitiesError: null,
        activitiesStatusFilter: status,
      });
      return true;
    }
    patch({
      activitiesStatus: snapshot.activities.length > 0 ? 'ready' : 'error',
      activitiesError: toStoreError(res.code, res.status, res.message, now()),
    });
    return false;
  };

  const load = async (opts: { charId?: string } = {}): Promise<void> => {
    if (opts.charId && opts.charId !== snapshot.charId) {
      snapshot = initialSnapshot(opts.charId);
    }
    patch({ status: 'loading', boundaryStatus: 'loading', activitiesStatus: 'loading' });
    inFlight = (async () => {
      if (!snapshot.charId) {
        // 账号层页面只读账号边界。
        await readBoundary();
        patch({ status: 'ready', activitiesStatus: 'ready' });
        return;
      }
      await Promise.all([readState(), readBoundary(), readActivities({ reset: true })]);
    })();
    await inFlight;
    inFlight = null;
  };

  const pollEventsOnce = async (): Promise<void> => {
    if (disposed) return;
    const res = await deps.api.readEvents(snapshot.lastSequence);
    if (!res.ok) {
      // 轮询失败不改主体状态：界面继续显示上次同步结果（并保留 lastSyncedAt）。
      if (res.code === 'NETWORK' || res.code === 'NOT_CONFIGURED') {
        patch({ error: toStoreError(res.code, res.status, res.message, now()) });
      }
      return;
    }
    const merged = mergeEvents(
      { events: [], lastSequence: snapshot.lastSequence },
      res.data,
    );
    if (merged.needsResync) {
      patch({ lastSequence: 0 });
      await resync();
      return;
    }
    if (!merged.changed) return;
    patch({
      lastSequence: merged.lastSequence,
      pendingConfirmations: pendingConfirmationsFromEvents(merged.events),
    });
    // 事件只用来触发刷新：具体状态仍以 state/activities 读回为准（契约 §7）。
    await Promise.all([
      readState(),
      readActivities({ reset: true }),
      res.data.items.some((e) => e.type === 'boundary.changed' || e.type === 'grant.changed')
        ? readBoundary()
        : Promise.resolve(true),
    ]);
  };

  const resync = async (): Promise<void> => {
    patch({ lastSequence: 0, pendingConfirmations: [] });
    await Promise.all([readState(), readBoundary(), readActivities({ reset: true })]);
  };

  const saveBoundary = async (
    changes: Record<string, unknown>,
    scope: BoundaryScope = 'character',
  ): Promise<boolean> => {
    const current = snapshot.boundary;
    if (!current) {
      patch({ writeError: toStoreError('NOT_CONFIGURED', 0, '还没读到云端边界', now()) });
      return false;
    }
    patch({ saving: true, writeError: null });
    const res = await deps.api.writeBoundaries({
      scope,
      ...(scope === 'character' ? { charId: snapshot.charId } : {}),
      expectedRevision: current.revision,
      changes,
    });
    if (res.ok) {
      patch({
        boundary: res.data,
        boundaryStatus: 'ready',
        boundaryError: null,
        saving: false,
        notice: '已保存',
      });
      await readState();
      return true;
    }
    const conflict = res.code === 'REVISION_CONFLICT';
    patch({
      saving: false,
      writeError: toStoreError(res.code, res.status, res.message, now()),
      notice: conflict ? '别处已经改过，已重新读取最新设置' : null,
    });
    if (conflict) await readBoundary();
    return false;
  };

  const setPause = async (paused: boolean, scope: BoundaryScope = 'character'): Promise<boolean> => {
    const current = snapshot.boundary;
    if (!current) {
      patch({ writeError: toStoreError('NOT_CONFIGURED', 0, '还没读到云端边界', now()) });
      return false;
    }
    // 先本地「仅本设备已停」，再请求云端；确认后才显示已暂停（契约 §8）。
    patch({
      localPauseRequested: paused,
      pause: { phase: paused ? 'stopping' : 'starting', acknowledged: false, quiesced: false },
      writeError: null,
    });
    const res = await deps.api.setPause({
      scope,
      ...(scope === 'character' ? { charId: snapshot.charId } : {}),
      paused,
      expectedRevision: current.revision,
    });
    if (res.ok) {
      patch({
        state: res.data.state,
        pause: {
          phase: 'idle',
          acknowledged: res.data.acknowledged,
          quiesced: res.data.quiesced,
        },
        localPauseRequested: false,
        lastSyncedAt: now(),
        boundary: { ...current, revision: res.data.revision },
        notice: res.data.quiesced
          ? paused ? '全部已暂停' : '已恢复'
          : paused ? '正在停止，还有一些动作在收尾' : '恢复请求已提交',
      });
      await readBoundary();
      return true;
    }
    patch({
      pause: { phase: 'idle', acknowledged: false, quiesced: false },
      writeError: toStoreError(res.code, res.status, res.message, now()),
    });
    if (res.code === 'REVISION_CONFLICT') await readBoundary();
    return false;
  };

  const resolveConfirmation = async (input: {
    id: string;
    decision: 'approve' | 'reject';
    payloadHash: string;
    nonce: string;
    expectedRevision: number;
  }): Promise<boolean> => {
    patch({ saving: true, writeError: null });
    const res = await deps.api.resolveConfirmation(input);
    if (res.ok) {
      patch({
        saving: false,
        pendingConfirmations: snapshot.pendingConfirmations.filter((item) => item.id !== input.id),
        notice: input.decision === 'approve' ? '已批准这次数据外传' : '已拒绝',
      });
      await readActivities({ reset: true });
      return true;
    }
    patch({
      saving: false,
      writeError: toStoreError(res.code, res.status, res.message, now()),
    });
    return false;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,
    refreshState: async () => {
      await readState();
    },
    refreshBoundary: async () => {
      await readBoundary();
    },
    loadActivities: async (opts) => {
      await readActivities(opts);
    },
    loadMoreActivities: async () => {
      if (!snapshot.activitiesCursor) return;
      const res = await deps.api.readActivities({
        charId: snapshot.charId,
        status: snapshot.activitiesStatusFilter ?? undefined,
        cursor: snapshot.activitiesCursor,
        limit: 20,
      });
      if (res.ok) {
        patch({
          activities: sortActivities([
            ...snapshot.activities,
            ...res.data.items.filter((a) => !snapshot.activities.some((b) => b.id === a.id)),
          ]),
          activitiesCursor: res.data.nextCursor,
        });
      }
    },
    pollEventsOnce,
    resync,
    saveBoundary,
    setPause,
    resolveConfirmation,
    dismissNotice: () => patch({ notice: null }),
    dispose: () => {
      disposed = true;
      listeners.clear();
    },
  };
}

/** 事件里带的动作变更（用于详情抽屉/时间线原地更新，不重新读整表）。 */
export function eventActionId(event: LifeEvent): string | null {
  return event.type === 'action.changed' ? event.actionId : null;
}
