import { useCallback, useEffect, useState } from 'react';
import { probeMossVoiceStatus } from './genieTts';
import type { MossVoiceStatus } from './mossTtsStatus';

/**
 * 只在「本机语音」是当前服务商时才去读音色目录。
 * 其他 provider 下不探测、不渲染音色列表，也就不会打扰原有配置。
 */
export function useMossVoiceCatalog(enabled: boolean) {
  const [status, setStatus] = useState<MossVoiceStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setRefreshing(true);
    try {
      const probe = await probeMossVoiceStatus();
      setStatus(probe.status);
    } finally {
      setRefreshing(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  return { status, refreshing, refresh };
}
