/**
 * 自主生活 · 执行器（浏览器侧唯一的「领 → 许可 → 本地事务 → 回执」循环）
 *
 * 为什么单独一层：云端只负责「到点产生动作 + 签发短期许可」，副作用必须发生在
 * 绑定设备上。执行器把这条链串成一次 runOnce()，任何一步失败都**不做本地写**：
 *
 *   1. registerDevice（幂等；换设备由服务端决定要不要显式切换）
 *   2. claim（只登记领取，不产生副作用）
 *   3. commitPermit（服务端条件提交：暂停/边界/预算/参数都过了才给许可）
 *   4. runLocalAction（许可校验 → 本地事务 → 事务内核销许可 → 回执上报）
 *
 * 刻意不做的事：
 *   - 不在没有本地库（老版本 upgrade 没跑过）时执行——宁可显示「能力不可用」；
 *   - 不缓存授权：每次执行都重新读边界（runLocalAction 自己也会再读一次）；
 *   - 不吞回执失败：本地效果已经落库，回执上报失败由下次 runOnce 的「补报」路径重传。
 */

import type { EffectiveBoundaryV1, ExecutionPermit } from '../../contracts/autonomyLife';
import type { ActionRow } from './engine';
import type { AutonomyLifeApi, LifeActionWire } from './api';
import { openAutonomyLocalDb, readReceipt, type LocalDbPort } from './localLedger';
import { reuploadReceipt, runLocalAction, type RunLocalActionResult } from './localRunner';
import { createWorkerExternalWindowPort } from './externalWindow';
import type { ExternalWindowPort } from './adapters';

/** 待补报回执（本地已写、云端未收到）：持久化在 localStorage，重启后仍能补。 */
export interface PendingReceipt {
  actionId: string;
  installationId: string;
  leaseEpoch: number;
  argsHash: string;
  resultRef: string | null;
  status: 'succeeded' | 'failed' | 'unknown';
  errorCode?: string;
  at: number;
}

export interface PendingReceiptStore {
  read(): PendingReceipt[];
  write(items: PendingReceipt[]): void;
}

export interface AutonomyLifeExecutorOptions {
  api: AutonomyLifeApi;
  installationId: string;
  /** 要执行的角色（通常来自当前角色列表；空数组 = 什么都不领）。 */
  charIds: () => string[];
  /** 本地库（默认 openAutonomyLocalDb；测试可注入）。 */
  openPort?: () => Promise<LocalDbPort | null>;
  /** 执行前现读的生效边界；null = 读不到 → 不执行。 */
  boundaryFor: (charId: string) => Promise<EffectiveBoundaryV1 | null>;
  /** 本地总暂停（UI 先本地停再请求云端）。 */
  localPaused?: () => boolean;
  now?: () => number;
  pending?: PendingReceiptStore;
  /** 执行侧第二道门的分类器（可选；与计划侧同一份）。 */
  classify?: (text: string) => { verdict: 'blocked' | 'allowed' } | { error: string };
  /** 外部只读窗口端口（缺省走 worker 的 /external/read；注入 false 可显式禁用）。 */
  external?: ExternalWindowPort | null;
}

export interface AutonomyLifeRunOutcome {
  charId: string;
  claimed: boolean;
  result: RunLocalActionResult | null;
  /** 执行器层面的说明（例如 permit 被服务端拒绝的原因），不伪造业务结果。 */
  note?: string;
}

const asActionRow = (wire: LifeActionWire): ActionRow => wire as unknown as ActionRow;

const memoryPending = (): PendingReceiptStore => {
  let items: PendingReceipt[] = [];
  return {
    read: () => items,
    write: (next) => { items = next; },
  };
};

/** localStorage 持久化（缺 localStorage 的环境退化成内存，不报错）。 */
export function createLocalStoragePendingStore(key = 'os_autonomy_pending_receipts_v1'): PendingReceiptStore {
  const fallback = memoryPending();
  const storage = (): Storage | null => {
    try {
      return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch {
      return null;
    }
  };
  return {
    read() {
      const store = storage();
      if (!store) return fallback.read();
      try {
        const raw = store.getItem(key);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? (parsed as PendingReceipt[]) : [];
      } catch {
        return [];
      }
    },
    write(items) {
      const store = storage();
      if (!store) {
        fallback.write(items);
        return;
      }
      try {
        store.setItem(key, JSON.stringify(items.slice(-50)));
      } catch {
        fallback.write(items);
      }
    },
  };
}

export function createAutonomyLifeExecutor(options: AutonomyLifeExecutorOptions) {
  const now = options.now ?? (() => Date.now());
  const pending = options.pending ?? createLocalStoragePendingStore();
  const external = options.external === undefined
    ? createWorkerExternalWindowPort(options.api)
    : options.external;
  let registered = false;

  const openPort = async (): Promise<LocalDbPort | null> => {
    if (options.openPort) return options.openPort();
    const opened = await openAutonomyLocalDb();
    return opened.ok ? opened.port : null;
  };

  /** 先补报上次没送达的回执（本地有回执 = 效果已发生，不能重做业务动作）。 */
  async function flushPending(port: LocalDbPort): Promise<void> {
    const items = pending.read();
    if (items.length === 0) return;
    const survivors: PendingReceipt[] = [];
    for (const item of items) {
      const receipt = await readReceipt(port, item.actionId).catch(() => null);
      // 本地回执在：按原 actionId 补报，argsHash 必须是同一份（服务端会再校验一次）。
      const res = receipt
        ? await options.api.receipt({
          actionId: item.actionId,
          installationId: item.installationId,
          leaseEpoch: item.leaseEpoch,
          argsHash: item.argsHash,
          status: item.status,
          resultRef: item.resultRef,
          ...(item.errorCode ? { errorCode: item.errorCode as never } : {}),
        })
        : null;
      if (res?.ok) continue;
      // 动作已被服务端收口（409/404）也视为结清：不能永远堵在队列里。
      if (res && (res.status === 409 || res.status === 404)) continue;
      survivors.push(item);
    }
    pending.write(survivors);
  }

  async function runOnce(): Promise<AutonomyLifeRunOutcome[]> {
    const outcomes: AutonomyLifeRunOutcome[] = [];
    if (!registered) {
      const device = await options.api.registerDevice(options.installationId).catch(() => null);
      // 设备注册失败（未配置/网络）就整轮不动：不猜一个「应该能行」。
      if (!device?.ok) return outcomes;
      registered = true;
    }

    const port = await openPort();
    // 老版本库缺 store → 能力不可用。不做「假装执行」，也不在 UI 侧造回执。
    if (!port) return outcomes;

    await flushPending(port);

    for (const charId of options.charIds()) {
      if (!charId) continue;
      const claim = await options.api.claim(charId, options.installationId).catch(() => null);
      if (!claim?.ok || !claim.data.action) continue;
      const action = asActionRow(claim.data.action);

      const permitRes = await options.api.commitPermit({
        actionId: action.id,
        installationId: options.installationId,
        leaseEpoch: claim.data.leaseEpoch,
        argsHash: action.argsHash,
        policyVersion: action.policyVersion,
      }).catch(() => null);
      if (!permitRes?.ok) {
        outcomes.push({ charId, claimed: true, result: null, note: permitRes?.code ?? 'permit_failed' });
        continue;
      }

      const boundary = await options.boundaryFor(charId).catch(() => null);
      if (!boundary) {
        outcomes.push({ charId, claimed: true, result: null, note: 'boundary_unavailable' });
        continue;
      }

      const permitted = asActionRow(permitRes.data.action);
      const permit: ExecutionPermit = permitRes.data.permit;
      const nowMs = now();
      // 回执是否真的送到了云端（由 runLocalAction 的回执口回报）。
      let receiptDelivered = false;
      const result = await runLocalAction({
        port,
        action: permitted,
        installationId: options.installationId,
        nowMs,
        policyVersion: permitted.policyVersion,
        permit,
        boundaryFor: async () => boundary,
        localPaused: options.localPaused?.() ?? false,
        classify: options.classify,
        external,
        report: async (report) => {
          const res = await options.api.receipt({
            actionId: report.actionId,
            installationId: report.installationId,
            leaseEpoch: report.leaseEpoch,
            argsHash: report.argsHash,
            status: report.status,
            resultRef: report.resultRef ?? null,
            ...(report.errorCode ? { errorCode: report.errorCode } : {}),
          });
          receiptDelivered = res.ok;
          return res.ok ? { ok: true } : { ok: false, code: res.code as never };
        },
      });

      // 本地成功但回执没送到：记进待补报（下次 runOnce 用原 actionId 重传，不重做业务）。
      if (result.status === 'succeeded' && result.effectVerified && !receiptDelivered) {
        const items = pending.read();
        if (!items.some((item) => item.actionId === permitted.id)) {
          pending.write([
            ...items,
            {
              actionId: permitted.id,
              installationId: options.installationId,
              leaseEpoch: permitted.leaseEpoch,
              argsHash: permitted.argsHash,
              resultRef: result.resultRef,
              status: 'succeeded',
              at: nowMs,
            },
          ]);
        }
      }
      outcomes.push({ charId, claimed: true, result });
    }
    return outcomes;
  }

  return {
    runOnce,
    flushPending: async () => {
      const port = await openPort();
      if (port) await flushPending(port);
    },
  };
}

export type AutonomyLifeExecutor = ReturnType<typeof createAutonomyLifeExecutor>;
