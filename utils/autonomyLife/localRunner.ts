/**
 * 本地执行器：把「云端签发许可的动作」真正落到 IndexedDB 的那一层（契约 §4.2/§4.3/§6）。
 *
 * 为什么需要它：engine 只发动作与许可，adapters 只会校验/执行单个 kind，localLedger 只会写
 * 事务。三者之间的连线（注入服务端持有的 charId、在线复核许可与边界、执行、回执上报的
 * actionId/leaseEpoch/argsHash 绑定）必须有唯一一处实现，否则 UI 或旧入口很容易绕过其中
 * 一道门。这个文件就是那条唯一的线。
 *
 * 副作用之前必须全部成立（任一失败 → 不执行、零业务写入、如实上报）：
 *   1. 本地库可用（没有 store = 能力不可用，绝不假装执行）；
 *   2. 本地总暂停没开；
 *   3. **生效边界是刚刚读到的**（不是调用方传进来的旧快照）：未暂停、角色开启、kind 被允许；
 *   4. 一次性许可存在且与 (actionId, installationId, leaseEpoch, policyVersion, argsHash,
 *      nonce, 到期时刻) 全对齐——`checkExecutionPermit`；
 *   5. 执行侧第二次强校验（封闭 schema / 禁止方向 / PII）；
 *   6. 本地事务里核销许可 + 写业务 + 写回执（同一个事务，见 localLedger）。
 */

import { hashArgs, type ActivityKind, type AutonomyLifeErrorCode, type EffectiveBoundaryV1, type ExecuteContext, type ExecutionPermit } from '../../contracts/autonomyLife';
import { executeAction, validateAndPrepare, type ExecuteOutcome, type ExecuteDeps } from './adapters';
import { boundaryGate } from './boundary';
import { reportReceipt, type ActionRow, type EngineDeps } from './engine';
import { checkExecutionPermit, signedArgsHash } from './executionPermit';
import { installLocalPermit, type LocalDbPort } from './localLedger';

export interface RunLocalActionInput {
  deps: EngineDeps;
  /** 本地库端口；null = 没有可用本地库（能力不可用，绝不假装执行）。 */
  port: LocalDbPort | null;
  action: ActionRow;
  installationId: string;
  nowMs: number;
  policyVersion: string;
  /** 云端签发的短期一次性许可；null = 没有许可 → 拒绝执行。 */
  permit: ExecutionPermit | null;
  /**
   * 执行时刻重新读取的生效边界。**必填**：调用方不能拿一份旧快照当「现在还允许」。
   * 边界读不出来（抛错）按 fail closed 处理。
   */
  boundaryFor: (charId: string) => Promise<EffectiveBoundaryV1>;
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
 *   1. 本地库/暂停/生效边界闸（边界现读）；
 *   2. 许可校验（存在、绑定、未过期、参数一致、nonce 与动作行一致）；
 *   3. 执行前策略与参数强校验（`validateAndPrepare`）；
 *   4. 落本地许可；
 *   5. 本地事务执行（adapters.executeAction → 事务内核销许可）；
 *   6. 拿回执上报（engine.reportReceipt）；上报失败不回滚本地效果，但结果保持 succeeded +
 *      由调用方在下次用原 actionId 重传。
 */
export async function runLocalAction(input: RunLocalActionInput): Promise<RunLocalActionResult> {
  const { action } = input;

  if (!input.port) {
    return { status: 'failed', code: 'CAPABILITY_UNAVAILABLE', message: 'local_stores_missing', effectVerified: false };
  }
  if (input.localPaused) {
    return { status: 'failed', code: 'GLOBAL_PAUSED', message: 'local_paused', effectVerified: false };
  }

  // 生效边界现读：调用方传一份旧快照说「允许」不作数。
  let boundary: EffectiveBoundaryV1;
  try {
    boundary = await input.boundaryFor(action.charId);
  } catch {
    return { status: 'failed', code: 'CAPABILITY_UNAVAILABLE', message: 'boundary_unavailable', effectVerified: false };
  }
  const gate = boundaryGate(boundary, action.kind as ActivityKind);
  if (!gate.ok) {
    return { status: 'failed', code: gate.code, message: gate.code, effectVerified: false };
  }

  // 动作行本身的可执行状态：没领到/已终态/已过期都不执行。
  if (action.status !== 'running') {
    return {
      status: 'failed',
      code: action.status === 'unknown' ? 'UNKNOWN_EFFECT' : 'STATE_CONFLICT',
      message: 'action_not_running',
      effectVerified: false,
    };
  }
  if (action.permitIssuedAt === null) {
    return { status: 'failed', code: 'STATE_CONFLICT', message: 'action_not_permitted', effectVerified: false };
  }
  if (action.permitConsumedAt !== null) {
    return { status: 'failed', code: 'STATE_CONFLICT', message: 'permit_consumed', effectVerified: false };
  }
  if (input.nowMs > (action.leaseExpiresAt ?? 0)) {
    return { status: 'failed', code: 'STATE_CONFLICT', message: 'permit_expired', effectVerified: false };
  }
  if (action.installationId && action.installationId !== input.installationId) {
    return { status: 'failed', code: 'FORBIDDEN', message: 'device_mismatch', effectVerified: false };
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
    leaseEpoch: action.leaseEpoch,
    policyVersion: input.policyVersion,
    installationId: input.installationId,
    nowMs: input.nowMs,
    permit: input.permit,
  };

  // 许可门：把「本次真正要写的参数」重算一遍再比，不信任何旧 hash。
  const permitCheck = checkExecutionPermit({
    ctx,
    permit: input.permit,
    expectedNonce: action.permitNonce,
    nowMs: input.nowMs,
    installationId: input.installationId,
  });
  if (!permitCheck.ok) {
    return { status: 'failed', code: permitCheck.code, message: permitCheck.reason, effectVerified: false };
  }
  // 动作行自证：行里的参数必须等于行里登记的 hash（防「只改参数不改 hash」），
  // 且许可签的就是这个 hash（checkExecutionPermit 已重算并比对）。
  if (hashArgs(action.args) !== action.argsHash || signedArgsHash(ctx.args) !== action.argsHash) {
    return { status: 'failed', code: 'STATE_CONFLICT', message: 'action_args_tampered', effectVerified: false };
  }

  // 落本地许可：即使这一步成功但事务失败，许可也只会在过期后失效，不会被第二次使用。
  const installed = await installLocalPermit(input.port, {
    actionId: input.permit!.actionId,
    charId: input.permit!.charId,
    installationId: input.permit!.installationId,
    leaseEpoch: input.permit!.leaseEpoch,
    argsHash: input.permit!.argsHash,
    policyVersion: input.permit!.policyVersion,
    nonce: input.permit!.nonce,
    issuedAt: input.permit!.issuedAt,
    expiresAt: input.permit!.expiresAt,
    consumedAt: null,
  });
  if (!installed.ok) {
    return { status: 'failed', code: installed.code, message: installed.reason, effectVerified: false };
  }

  const deps: ExecuteDeps = { port: input.port, policyVersion: input.policyVersion, tz: boundary.timezone };
  const outcome = await executeAction(ctx, deps);

  // 回执绑定：action.id 是业务幂等键，leaseEpoch/argsHash 证明「就是这一次许可」。
  // 上报失败不回滚本地效果（效果已经落库），但把结果如实交给调用方。
  let receiptOk = true;
  try {
    const reported = await reportReceipt(input.deps, {
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
    receiptOk = reported.ok;
  } catch {
    receiptOk = false;
  }
  if (!receiptOk && outcome.status === 'succeeded') {
    // 本地成功、云端没收到：仍报 succeeded（效果为真），由调用方用原 actionId 重传回执。
    return { status: 'succeeded', resultRef: outcome.resultRef, effectVerified: true, outcome };
  }

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
  // 回执必须对齐该动作已发许可的参数：换个 hash 的重传不算「同一件事」。
  if (input.receipt.argsHash !== input.action.argsHash) {
    return { ok: false, code: 'STATE_CONFLICT' };
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
