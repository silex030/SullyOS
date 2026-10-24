/**
 * 神经链接 · 角色设置 → 自主出行（只作用于当前角色）
 *
 * 所有权：出行「具体设置」只在这里和角色自己的城市卡里：
 * - 能不能出门：本卡（角色级开关，写入服务端；不是账号级大面板）；
 * - 固定地点：复用本页已有的城市卡（角色所在城市），不另造第三份位置权威；
 * - 账号级的账号预算 / 地图凭据 / 首次连接：全局设置 → 实时感知 →「地图服务」。
 *
 * 本卡只读/写当前角色的开关，不能改别的角色，也不出现时区与保留期输入
 * （账号预算按确定账号时区，保留策略服务端自动 bounded prune）。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { MapPin } from '@phosphor-icons/react';
import { getTravelRuntime, type TravelRuntime } from '../../utils/travel/runtime';
import { readTravelOwnerCredential, travelSessionState } from '../../utils/travel/session';

export interface TravelCharCardProps {
  charId: string;
  runtime?: TravelRuntime;
  className?: string;
}

const TravelCharCard: React.FC<TravelCharCardProps> = ({ charId, runtime: injected, className = '' }) => {
  const runtime = injected ?? getTravelRuntime();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [known, setKnown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!charId) return;
    const res = await runtime.readCharEnabled(charId);
    setKnown(res.known);
    setEnabled(res.known ? res.enabled : null);
  }, [runtime, charId]);

  useEffect(() => { void load(); }, [load]);

  const toggle = useCallback(async () => {
    if (!charId || enabled === null) return;
    setBusy(true);
    const res = await runtime.saveCharEnabled(charId, !enabled);
    setBusy(false);
    if (!res.ok) {
      setNote('没写进服务端，开关保持原状');
      return;
    }
    setEnabled(!enabled);
    setNote(!enabled ? '已允许 TA 自己出门；去哪、什么时候不想去由 TA 决定' : '已暂停 TA 的自主出行，其它角色不受影响');
  }, [charId, enabled, runtime]);

  const unpaired = !readTravelOwnerCredential() && travelSessionState() !== 'ready';

  return (
    <div data-testid="travel-char-card" className={className}>
      <div className="flex items-center gap-2">
        <div className="p-1.5 bg-sky-100/70 rounded-lg text-sky-600">
          <MapPin size={13} weight="bold" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-slate-700">自主出行</div>
          <div className="text-[10px] text-slate-400">只作用于这个角色；固定地点用上面的城市卡</div>
        </div>
        <button
          type="button"
          data-testid="travel-char-toggle"
          role="switch"
          aria-checked={enabled === true}
          disabled={!known || busy || enabled === null || !charId}
          onClick={() => void toggle()}
          className={`w-9 h-5 rounded-full transition-colors duration-200 shrink-0 disabled:opacity-40 ${enabled ? 'bg-sky-500' : 'bg-slate-300'}`}
        >
          <span
            className="block w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200"
            style={{ transform: `translateX(${enabled ? 18 : 2}px)`, marginTop: 2 }}
          />
        </button>
      </div>
      <div className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
        {!known
          ? '未确认：还没读到这个角色的服务端设置，不会用默认值覆盖。'
          : enabled
            ? 'TA 可以自己出门、中途改主意、自己回家；地图服务由全局那一份凭据提供。'
            : '当前暂停。开启后 TA 会按自己的作息与心情决定是否出门。'}
      </div>
      <div data-testid="travel-char-authorization" className="mt-0.5 text-[9px] leading-relaxed text-slate-400">
        去哪、什么时候出门由 TA 自己决定；你只在这里给一个总授权，不需要逐次批准。
      </div>
      {unpaired && (
        <div data-testid="travel-char-needs-connect" className="mt-1 text-[9px] text-amber-700">
          还没连接账号：到设置 → 实时感知 →「地图服务」点「申请连接」。
        </div>
      )}
      {note && <div className="mt-1 text-[9px] text-slate-500">{note}</div>}
    </div>
  );
};

export default TravelCharCard;
