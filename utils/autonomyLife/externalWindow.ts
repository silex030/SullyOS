/**
 * 外部只读窗口的浏览器侧端口。
 *
 * 浏览器**不直接访问外部服务**（那会绕过服务端白名单、也带不出 SSRF 防线）：
 * 这里只把「provider + query + fields」交给 worker 的 `/external/read`，返回的已经是
 * 服务端投影过的字段。没有 worker 地址 → NOT_CONFIGURED（执行侧照实报不可用）。
 */

import type { AutonomyLifeApi } from './api';
import type { ExternalProvider, ExternalWindowPort } from './adapters';

export function createWorkerExternalWindowPort(api: AutonomyLifeApi): ExternalWindowPort {
  return {
    async read(input) {
      // 许可绑定一并交给服务端：worker 在出网前用它核销一次性许可（重放不会再出网）。
      const res = await api.externalRead({
        charId: input.charId,
        query: input.query,
        fields: [...input.fields],
        permit: input.permit,
      });
      if (!res.ok) {
        // 客户端错误码（NOT_CONFIGURED/NETWORK/…）映射成「能力不可用」，不伪装成成功。
        return { ok: false, code: 'CAPABILITY_UNAVAILABLE', reason: String(res.code) };
      }
      if (res.data.provider !== input.provider) {
        return { ok: false, code: 'VALIDATION_FAILED', reason: 'provider_mismatch' };
      }
      return { ok: true, items: res.data.items, fetchedAt: res.data.fetchedAt };
    },
    async submitWish(input) {
      const res = await api.submitWish({ charId: input.charId, text: input.text, permit: input.permit });
      if (!res.ok) return { ok: false, code: 'CAPABILITY_UNAVAILABLE', reason: String(res.code) };
      return { ok: true, wishId: res.data.wishId };
    },
  };
}

export type { ExternalProvider };
