/**
 * 自主生活 · 执行器启动（应用级，一个进程一份）
 *
 * 调用点：OSContext 在数据加载完之后启动一次；页面卸载时 stop。
 *
 * 节奏（**不是用户设置的频率**）：
 *   - 前台每 60 秒跑一轮 runOnce()：claim 只能领到「已经到点、并且服务端签了许可」
 *     的动作，所以这个间隔只是「多久看一眼」，不决定角色多久生活一次；
 *   - 页面隐藏时不做 claim（省电、也避免后台被浏览器节流的半死状态）；
 *   - 回到前台立刻跑一轮（把离线期间到点的动作处理掉）。
 *
 * 失败策略：整轮失败只记录、不弹窗（下一轮自然重试）；任何「没许可/边界读不到」
 * 都已在 runOnce 内部按 fail-closed 处理。
 */

import type { EffectiveBoundaryV1 } from '../../contracts/autonomyLife';
import { createDefaultAutonomyLifeApi } from './endpoint';
import type { AutonomyLifeApi } from './api';
import { createAutonomyLifeExecutor } from './executor';
import { getAutonomyInstallationId } from './installation';

export interface StartAutonomyLifeExecutorOptions {
  /** 测试注入；缺省用 worker 默认实例。 */
  api?: AutonomyLifeApi;
  /** 要执行的角色（通常 = 角色列表）。 */
  getCharIds: () => string[];
  /** 本地总暂停（与设置页/角色面板共用同一份状态时可传）。 */
  isLocallyPaused?: () => boolean;
  isVisible?: () => boolean;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

const defaultVisible = (): boolean => {
  if (typeof document === 'undefined') return true;
  return document.visibilityState !== 'hidden';
};

export function startAutonomyLifeExecutor(options: StartAutonomyLifeExecutorOptions): () => void {
  const api = options.api ?? createDefaultAutonomyLifeApi();
  const installationId = getAutonomyInstallationId();
  const isVisible = options.isVisible ?? defaultVisible;
  const intervalMs = Math.max(15_000, options.intervalMs ?? 60_000);

  const executor = createAutonomyLifeExecutor({
    api,
    installationId,
    charIds: options.getCharIds,
    localPaused: options.isLocallyPaused,
    boundaryFor: async (charId): Promise<EffectiveBoundaryV1 | null> => {
      const boundaries = await api.readBoundaries(charId).catch(() => null);
      return boundaries?.ok ? boundaries.data.effective : null;
    },
  });

  let stopped = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopped || running || !isVisible()) return;
    running = true;
    try {
      await executor.runOnce();
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  void tick();

  const onVisibility = (): void => {
    if (isVisible()) void tick();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  return () => {
    stopped = true;
    clearInterval(timer);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}
