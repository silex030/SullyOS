import { resolveAirpCapabilityPolicy } from './settings';
import type { AutonomyWorkflowKind } from './lifeWorkflow';

/**
 * 私人虚拟生活（自己的日记/计划/兴趣笔记）不写用户的真实数据，也不调用外部工具，
 * 因此不要求 `writable`（那是真实写入类能力的总闸）。但它仍必须尊重用户的能力
 * 白名单/全禁：显式 none 一律不允许，allowlist 需包含对应动作，旧空数组保持 all。
 */
export function canRunPrivateLifeAction(
 config: {capabilityMode?: unknown; capabilities?: unknown},
 kind: AutonomyWorkflowKind,
): boolean {
 const policy=resolveAirpCapabilityPolicy(config);
 if(policy.mode==='none') return false;
 if(policy.mode==='all') return true;
 const needed=kind==='plan' ? 'schedule_write' : 'diary_write';
 return policy.allow.includes(needed);
}
