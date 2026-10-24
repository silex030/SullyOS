/**
 * 本地执行器：把「云端领到的动作」真正落到 IndexedDB 的那一层（契约 §4.2/§4.3/§6）。
 *
 * 为什么需要它：engine 只发动作与许可，adapters 只会校验/执行单个 kind，localLedger 只会写
 * 事务。三者之间的连线（注入服务端持有的 charId、二次策略校验、执行前复核边界与暂停、
 * 回执上报的 actionId/leaseEpoch/argsHash 绑定）必须有唯一一处实现，否则 UI 或旧入口
 * 很容易绕过其中一道门。这个文件就是那条唯一的线。
 *
 * 约束：
 *   - 执行前必须再跑一次 validateAndPrepare（执行侧的第二次强校验）；
 *   - 本地前置条件（store 在、设备绑定、总暂停）任一不满足 → 不执行，如实上报；
 *   - 只有本地事务拿到回执才报 succeeded；崩溃/失败如实报 failed/unknown；
 *   - 调用方不能自带 resultRef 越权读资源：resultRef 只来自本地回执。
 */

import type {
  ActivityKind,
  AutonomyLifeErrorCode,
  EffectiveBoundaryV1,
  ExecuteContext,
} from '../../contracts/autonomyLife';
import { executeAction, validateAndPrepare, type ExecuteOutcome, type ExecuteDeps } from './adapters';
import { boundaryGate } from './boundary';
import { reportReceipt, type ActionRow, type EngineDeps } from './engine';
import type { LocalDbPort } from './localLedger';

export interface RunLocalActionInput {
  deps: EngineDeps;
  /** 本地库端口；null = 没有可用本地库（能力不可用，绝不假装执行）。 */
  port: LocalDbPort | null;
  action: ActionRow;
  installationId: string;
  nowMs: number;
  policyVersion: string;
  boundary: EffectiveBoundaryV1;
  /** 本地总暂停（UI 可以先本地停再请求云端）：为 true 时直接拒绝执行。 */
  localPaused?: boolean;
  /**
   * 可选的语义分类器。内部模拟订单靠「封闭类目白名单 + 词表」已经能拦，
   * 分类器是加分项；但一旦配置了就必须可用（否则 fail closed）。
   */
  classify?: (text: string) => { verdict: 'blocked' | 'allowed' } | { error: string };
}

export type RunLocalActionResult =
  | { status: 'succeeded'; resultRef: string; effectVerified: true; outcome: ExecuteOutcome }
  | { status: 'failed' | 'unknown'; code: AutonomyLifeErrorCode; message: string; effectVerified: false };

/**
 * 执行一个已领取的动作。
 *
 * 顺序（每一步失败都直接返回，不做「先做后补」）：
 *   1. 本地库/暂停/边界闸；
 *   2. 执行前策略与参数强校验（`validateAndPrepare`）；
 *   3. 本地事务执行（adapters.executeAction）；
 *   4. 拿回执上报（engine.reportReceipt）；上报失败不回滚本地效果，但结果保持 succeeded +
 *      由调用方在下次用原 actionId 重传。
 */
export async function runLocalAction(input: RunLocalActionInput): Promise<RunLocalActionResult> {
  const { action, boundary } = input;

  if (!input.port) {
    return { status: 'failed', code: 'CAPABILITY_UNAVAILABLE', message: 'local_stores_missing', effectVerified: false };
  }
  if (input.localPaused) {
    return { status: 'failed', code: 'GLOBAL_PAUSED', message: 'local_paused', effectVerified: false };
  }
  const gate = boundaryGate(boundary, action.kind as ActivityKind);
  if (!gate.ok) {
    return { status: 'failed', code: gate.code, message: gate.code, effectVerified: false };
  }

  // 执行侧第二次强校验：**先用动作里原本的参数**（模型能控制的字段）过封闭 schema，
  // 服务端持有的 charId 等身份字段不在这份参数里，校验通过后由执行器注入。
  const prepared = validateAndPrepare({
    kind: action.kind as ActivityKind,
    charId: action.charId,
    args: action.args,
    boundary,
    nowMs: input.nowMs,
    tz: boundary.timezone,
    classify: input.classify,
    requireClassifier: typeof input.classify === 'function',
  });
  if (!prepared.ok) {
    return { status: 'failed', code: prepared.code, message: prepared.reason, effectVerified: false };
  }

  const ctx: ExecuteContext = {
    actionId: action.id,
    charId: action.charId,
    kind: action.kind as ActivityKind,
    // 身份字段只在这里注入：模型/计划提供的参数里没有 ownership 概念。
    args: { ...prepared.args, charId: action.charId },
    argsHash: action.argsHash,
    policyVersion: input.policyVersion,
    installationId: input.installationId,
    nowMs: input.nowMs,
  };
  const deps: ExecuteDeps = { port: input.port, policyVersion: input.policyVersion, tz: boundary.timezone };
  const outcome = await executeAction(ctx, deps);

  // 回执绑定：action.id 是业务幂等键，leaseEpoch/argsHash 证明「就是这一次许可」。
  await reportReceipt(input.deps, {
    accountId: input.deps.accountId ?? 'account',
    actionId: action.id,
    installationId: input.installationId,
    leaseEpoch: action.leaseEpoch,
    argsHash: action.argsHash,
    status: outcome.status,
    resultRef: outcome.status === 'succeeded' ? outcome.resultRef : null,
    errorCode: outcome.status === 'succeeded' ? undefined : outcome.code,
    nowMs: input.nowMs,
  });

  if (outcome.status === 'succeeded') {
    return { status: 'succeeded', resultRef: outcome.resultRef, effectVerified: true, outcome };
  }
  return { status: outcome.status, code: outcome.code, message: outcome.message, effectVerified: false };
}

/**
 * 回执补报（崩溃恢复）：本地有回执但云端仍 running/unknown 时，用**原 actionId** 重传，
 * 绝不重新执行业务动作。
 */
export async function reuploadReceipt(input: {
  deps: EngineDeps;
  action: ActionRow;
  installationId: string;
  nowMs: number;
  receipt: { actionId: string; argsHash: string; resultRef: string | null } | null;
}): Promise<{ ok: boolean; code?: AutonomyLifeErrorCode }> {
  if (!input.receipt) {
    // 没有回执且确认没开始：交回引擎按原 id 重投，不在这里猜。
    return { ok: false, code: 'UNKNOWN_EFFECT' };
  }
  const result = await reportReceipt(input.deps, {
    accountId: input.deps.accountId ?? 'account',
    actionId: input.receipt.actionId,
    installationId: input.installationId,
    leaseEpoch: input.action.leaseEpoch,
    argsHash: input.receipt.argsHash,
    status: 'succeeded',
    resultRef: input.receipt.resultRef,
    nowMs: input.nowMs,
  });
  return result.ok ? { ok: true } : { ok: false, code: result.code };
}
