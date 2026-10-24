/**
 * 自主生活 UI · 运行期接线。
 *
 * 后端地址与认证头全部复用现有主动消息后台（worker）配置：
 *   - 地址：`ActiveMsgStore.getGlobalConfig().workerUrl`；
 *   - 认证：沿用 worker 既有约定（`X-Client-Token` 共享密钥；`X-User-Id` 只作一致性断言，
 *     服务端不得据此认定身份 —— 契约 §6/§7）。
 * 未配置地址时返回 null（fail-closed），界面显示「还没连上后台」，绝不猜默认后端。
 */

import { ActiveMsgStore } from '../activeMsgStore';
import { createAutonomyLifeApi, type AutonomyLifeApi, type AutonomyLifeEndpoint } from './api';

export async function resolveActiveMsgEndpoint(): Promise<AutonomyLifeEndpoint | null> {
  try {
    const config = await ActiveMsgStore.getGlobalConfig();
    const baseUrl = String(config.workerUrl ?? '').trim();
    if (!baseUrl) return null;
    const headers: Record<string, string> = {};
    const token = String(config.serverToken ?? '').trim();
    if (token) headers['X-Client-Token'] = token;
    const userId = String(config.userId ?? '').trim();
    // 一致性断言，不是身份凭据：服务端必须自己从会话派生 ownerId。
    if (userId) headers['X-User-Id'] = userId;
    return { baseUrl, headers };
  } catch {
    return null;
  }
}

/** 页面默认实例：一条请求一个 Idempotency-Key，地址在每次请求前解析。 */
export function createDefaultAutonomyLifeApi(): AutonomyLifeApi {
  return createAutonomyLifeApi({ resolveEndpoint: resolveActiveMsgEndpoint });
}
