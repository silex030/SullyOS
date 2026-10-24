import { useCallback, useEffect, useState } from 'react';
import { probeMossVoiceStatus } from './genieTts';
import type { MossVoiceStatus } from './mossTtsStatus';

/**
 * 只在「本机语音」是当前服务商时才去读音色目录。
 * 其他 provider 下不探测、不渲染音色列表，也就不会打扰原有配置。
 *
 * 2026-10-24：把 probe 的 `reachable` / `error` 一起交出去。
 * 之前只留 status，UI 拿不到「连不上」这个事实，只能把「探活失败」「服务端没注册音色」
 * 合并成一句「还没有可选音色」——用户看不出该去改地址/令牌还是该去注册参考音频。
 */
export function useMossVoiceCatalog(enabled: boolean) {
  const [status, setStatus] = useState<MossVoiceStatus | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setRefreshing(true);
    try {
      const probe = await probeMossVoiceStatus();
      setStatus(probe.status);
      setReachable(probe.reachable);
      setError(probe.error || '');
    } finally {
      setRefreshing(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      setReachable(null);
      setError('');
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  return { status, reachable, error, refreshing, refresh };
}
