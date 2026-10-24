/**
 * 执行许可的**唯一**校验器（契约 §4.2）。
 *
 * 为什么单独一个文件：许可校验以前散落在「谁想起来就校验一下」的地方，于是最危险的
 * 那条路径（localRunner → adapters.executeAction → 本地事务）实际上从来没校验过 permit。
 * 现在所有副作用入口都调这里，规则只有一份：
 *
 *   1. 许可必须存在（没有许可 → 拒绝，绝不「先做后补」）；
 *   2. actionId / installationId / leaseEpoch / policyVersion 必须与本次执行一致；
 *   3. argsHash 必须等于**本次真正要执行的参数**（重新算，不信调用方传的旧 hash）；
 *   4. 未过期（短期一次性令牌，默认 60 秒）；
 *   5. nonce 必须与服务端动作行里的那一份相同（防「换个许可复用同一动作」）。
 *
 * 这里只做纯校验，不写任何东西：消费（consumedAt）发生在业务事务里
 * （utils/autonomyLife/localLedger.ts），因为只有事务能保证「用了就不会再用第二次」。
 */

import {
  hashArgs,
  type AutonomyLifeErrorCode,
  type ExecuteContext,
  type ExecutionPermit,
} from '../../contracts/autonomyLife';
import type { LocalPermitRecord } from './localLedger';

export interface PermitCheckInput {
  /** 本次要执行的上下文（args 是**注入身份字段之后**的最终参数）。 */
  ctx: ExecuteContext;
  /** 服务端签发的许可；null/undefined = 无许可。 */
  permit: ExecutionPermit | null | undefined;
  /**
   * 服务端动作行里的 nonce。调用方从 claim/commit 结果拿到；没拿到就必须给 null
   * （= 证明不了这是本次许可 → 拒绝）。
   */
  expectedNonce: string | null;
  nowMs: number;
  /** 本次执行的安装 id（与许可互校）。 */
  installationId: string;
}

export type PermitCheckResult =
  | { ok: true; permit: ExecutionPermit }
  | { ok: false; code: AutonomyLifeErrorCode; reason: string };

/**
 * 参数签名口径：不计 top-level charId（执行器注入的身份字段不参与许可签名）。
 * 与 localLedger.hashOf 必须完全一致，否则「已批准参数」与「实际写入参数」会错位。
 */
export function signedArgsHash(args: Record<string, unknown>): string {
  const { charId: _identity, ...signed } = args;
  void _identity;
  return hashArgs(signed);
}

export function checkExecutionPermit(input: PermitCheckInput): PermitCheckResult {
  const { permit } = input;
  if (!permit) return { ok: false, code: 'STATE_CONFLICT', reason: 'permit_missing' };
  if (permit.actionId !== input.ctx.actionId) {
    return { ok: false, code: 'FORBIDDEN', reason: 'permit_action_mismatch' };
  }
  if (permit.charId !== input.ctx.charId || input.ctx.args.charId !== permit.charId) {
    return { ok: false, code: 'FORBIDDEN', reason: 'permit_character_mismatch' };
  }
  if (permit.installationId !== input.installationId || input.ctx.installationId !== input.installationId) {
    return { ok: false, code: 'FORBIDDEN', reason: 'permit_device_mismatch' };
  }
  if (permit.leaseEpoch !== input.ctx.leaseEpoch) {
    return { ok: false, code: 'STATE_CONFLICT', reason: 'permit_epoch_mismatch' };
  }
  if (permit.policyVersion !== input.ctx.policyVersion) {
    return { ok: false, code: 'STATE_CONFLICT', reason: 'permit_policy_mismatch' };
  }
  if (!permit.nonce || !input.expectedNonce || permit.nonce !== input.expectedNonce) {
    return { ok: false, code: 'STATE_CONFLICT', reason: 'permit_nonce_mismatch' };
  }
  if (input.nowMs > permit.expiresAt) {
    return { ok: false, code: 'STATE_CONFLICT', reason: 'permit_expired' };
  }
  // 参数自证：以**本次真正要写的参数**重算，不信 ctx.argsHash（那是计划期的值）。
  if (signedArgsHash(input.ctx.args) !== permit.argsHash || permit.argsHash !== input.ctx.argsHash) {
    return { ok: false, code: 'STATE_CONFLICT', reason: 'permit_args_mismatch' };
  }
  return { ok: true, permit };
}

/** 许可 → 本地许可行（事务里核销用）。 */
export function toLocalPermit(permit: ExecutionPermit): LocalPermitRecord {
  return {
    actionId: permit.actionId,
    charId: permit.charId,
    installationId: permit.installationId,
    leaseEpoch: permit.leaseEpoch,
    argsHash: permit.argsHash,
    policyVersion: permit.policyVersion,
    nonce: permit.nonce,
    issuedAt: permit.issuedAt,
    expiresAt: permit.expiresAt,
    consumedAt: null,
  };
}
