/**
 * 全局护栏的云端端口（鉴权 client_state 那一行）。
 *
 * 写入的保证全部在**服务端**：走专用路由 `POST /autonomy-guardrails/patch`，
 * 那边用 D1 条件 UPDATE（CAS）落库，并强制「当前是暂停时，没有明确解暂停意图就保不住
 * `paused:false`」。客户端不再靠「读一遍再写」假装原子 —— 那是 TOCTOU 窗口，
 * 多设备同时保存时后写的那种仍然会覆盖（评审里那条）。
 *
 * 老端口（没有专用路由方法）仍走兼容路径（读基线 → 写 → 读回），但那条路也会被
 * worker 的泛写闸拦下「把远端暂停改回未暂停」的请求（见
 * `worker/amsg/src/guardrailPatch.ts` 的 `screenClientStateWrite`）。
 */

import {
  AUTONOMY_GUARDRAIL_STATE_KEY,
  AUTONOMY_GUARDRAIL_STATE_NAMESPACE,
  guardrailValuesEqual,
  readAutonomyGuardrailStateValue,
} from './autonomyGuardrails';
import {
  GuardrailSyncError,
  bindGuardrailCloudSync,
  type GuardrailCloudSyncPort,
  type GuardrailSaveAck,
  type GuardrailSaveOptions,
  type GuardrailWriteExpectation,
} from './autonomyGuardrailsClient';

export interface CloudStateClient {
  readClientStateValue(namespace: string, key: string): Promise<string | null>;
  writeClientStateValue(namespace: string, key: string, value: string): Promise<void>;
  /**
   * 专用护栏写入（原子条件写）。老端口没有这个能力时可以缺省 —— 会退回兼容路径，
   * 那条路的安全性由 worker 的泛写闸兜底。
   */
  patchGlobalGuardrails?(body: {
    patch: Record<string, unknown>;
    expected?: { kind: 'absent' } | { kind: 'value'; value: Record<string, unknown> } | null;
    allowUnpause?: boolean;
  }): Promise<{ status: number; body: any }>;
}

const CONFLICT_MESSAGE = '云端护栏配置已被另一台设备修改（或读不出来），本次没有写入；请先刷新。';
const UNREADABLE_MESSAGE = '云端护栏现在读不出来，本次没有写入；请稍后重试。';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function createGuardrailCloudPort(client: CloudStateClient): GuardrailCloudSyncPort {
  return {
    async save(
      entry,
      expectation?: GuardrailWriteExpectation,
      options?: GuardrailSaveOptions,
    ): Promise<GuardrailSaveAck> {
      // ── 首选：服务端原子条件写 ──
      if (typeof client.patchGlobalGuardrails === 'function') {
        const patch = (() => {
          try {
            const parsed: unknown = JSON.parse(entry.value);
            return isRecord(parsed) ? parsed : null;
          } catch {
            return null;
          }
        })();
        if (!patch) throw new GuardrailSyncError('conflict', '要写入的护栏内容不合法（没有上传）。', null);

        let response: { status: number; body: any };
        try {
          response = await client.patchGlobalGuardrails({
            patch,
            expected: expectation
              ? expectation.kind === 'absent'
                ? { kind: 'absent' }
                : { kind: 'value', value: { ...expectation.value } }
              : null,
            allowUnpause: options?.allowUnpause === true,
          });
        } catch (error) {
          throw new GuardrailSyncError(
            'network',
            error instanceof Error ? error.message : '保存护栏失败（没有确认）。',
            null,
          );
        }

        const code = isRecord(response.body) && isRecord(response.body.error)
          && typeof response.body.error.code === 'string'
          ? response.body.error.code
          : '';
        const remoteValue = (() => {
          const data = isRecord(response.body) && isRecord(response.body.data) ? response.body.data : null;
          const value = data?.value;
          return isRecord(value) ? JSON.stringify(value) : null;
        })();

        if (response.status === 409 || code === 'GUARDRAIL_CONFLICT') {
          throw new GuardrailSyncError('conflict', CONFLICT_MESSAGE, remoteValue);
        }
        if (response.status === 503 || code === 'GUARDRAIL_UNREADABLE') {
          throw new GuardrailSyncError('network', UNREADABLE_MESSAGE, remoteValue);
        }
        if (response.status < 200 || response.status >= 300
          || !isRecord(response.body) || response.body.success !== true) {
          const message = isRecord(response.body) && isRecord(response.body.error)
            && typeof response.body.error.message === 'string'
            ? response.body.error.message
            : '后台没有确认这次保存。';
          throw new GuardrailSyncError('network', message, remoteValue);
        }

        const data = isRecord(response.body.data) ? response.body.data : {};
        const stored = readAutonomyGuardrailStateValue(
          isRecord(data.value) ? JSON.stringify(data.value) : null,
        );
        return {
          ...(data.unpauseIgnored === true ? { unpauseIgnored: true } : {}),
          ...(stored.kind === 'ok' ? { value: stored.value } : {}),
        };
      }

      // ── 兼容路径（老端口）：读基线 → 写 → 读回比对 ──
      // 不是原子 CAS；安全性由 worker 泛写闸兜底（远端暂停不会被普通保存解掉）。
      if (expectation) {
        const currentRaw = await client.readClientStateValue(entry.namespace, entry.key);
        const current = readAutonomyGuardrailStateValue(currentRaw);
        if (expectation.kind === 'absent') {
          if (current.kind !== 'absent') {
            throw new GuardrailSyncError('conflict', CONFLICT_MESSAGE, currentRaw);
          }
        } else if (current.kind !== 'ok' || !guardrailValuesEqual(current.value, expectation.value)) {
          throw new GuardrailSyncError('conflict', CONFLICT_MESSAGE, currentRaw);
        }
      }
      await client.writeClientStateValue(entry.namespace, entry.key, entry.value);
      const readBack = await client.readClientStateValue(entry.namespace, entry.key);
      if (readBack !== entry.value) {
        throw new GuardrailSyncError('unconfirmed', '后台未确认此次护栏配置，请重试同步。', readBack);
      }
      return {};
    },
    load: () => client.readClientStateValue(AUTONOMY_GUARDRAIL_STATE_NAMESPACE, AUTONOMY_GUARDRAIL_STATE_KEY),
  };
}

/** 使用既有鉴权客户端；动态加载避免设置页首屏引入整套主动消息依赖。 */
export async function connectAutonomyGuardrailCloud(): Promise<void> {
  const { ActiveMsgClient } = await import('../activeMsgClient');
  bindGuardrailCloudSync(createGuardrailCloudPort(ActiveMsgClient));
}
