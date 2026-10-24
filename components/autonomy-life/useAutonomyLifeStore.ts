import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createDefaultAutonomyLifeApi } from '../../utils/autonomyLife/endpoint';
import type { AutonomyLifeApi } from '../../utils/autonomyLife/api';
import { createAutonomyLifeStore, type AutonomyLifeSnapshot, type AutonomyLifeStore } from '../../utils/autonomyLife/store';

/**
 * 把 store 接到 React。轮询按契约 §7：前台 30 秒一次短轮询，后台暂停；
 * 页面重新可见时先拉一次 state + activities（不靠事件补），
 * 避免后台期间攒下的事件把界面推成过期状态。
 */
export interface UseAutonomyLifeOptions {
  charId: string;
  /** 测试/预览注入 fixture api；不传就用 worker 默认实例。 */
  api?: AutonomyLifeApi;
  pollIntervalMs?: number;
  /** 可见性判定（默认看 document.visibilityState；测试可注入）。 */
  isVisible?: () => boolean;
  autoLoad?: boolean;
}

export interface UseAutonomyLifeResult {
  snapshot: AutonomyLifeSnapshot;
  store: AutonomyLifeStore;
}

const defaultIsVisible = (): boolean => {
  if (typeof document === 'undefined') return true;
  return document.visibilityState !== 'hidden';
};

export function useAutonomyLife(options: UseAutonomyLifeOptions): UseAutonomyLifeResult {
  const { charId, api, pollIntervalMs = 30_000, isVisible = defaultIsVisible, autoLoad = true } = options;

  const apiInstance = useMemo(() => api ?? createDefaultAutonomyLifeApi(), [api]);
  const store = useMemo(
    () => createAutonomyLifeStore({ api: apiInstance, charId }),
    [apiInstance, charId],
  );

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    if (autoLoad) {
      // 首屏除了 state/boundary/activities，还要立刻拉一次事件：
      // 待外传确认（awaiting_confirmation）只从事件投影里来，等 30 秒轮询才出现
      // 会让人以为「没有待确认」，所以这里不等定时器。
      void store.load().then(() => store.pollEventsOnce()).catch(() => {});
    }
    return () => store.dispose();
  }, [store, autoLoad]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      if (!isVisible()) return;
      void store.pollEventsOnce();
    };

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(tick, pollIntervalMs);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibilityChange = () => {
      if (isVisible()) {
        // 回到前台：先读一遍权威状态，再恢复轮询。
        void store.refreshState();
        void store.loadActivities({ reset: true });
        start();
      } else {
        stop();
      }
    };

    if (isVisible()) start();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [store, pollIntervalMs, isVisible]);

  return { snapshot, store };
}
