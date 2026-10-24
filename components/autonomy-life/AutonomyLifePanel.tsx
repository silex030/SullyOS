import React, { useEffect, useMemo, useState } from 'react';
import { CaretLeft } from '@phosphor-icons/react';
import type { ActionStatus } from '../../contracts/autonomyLife';
import type { AutonomyLifeApi } from '../../utils/autonomyLife/api';
import { formatWhen } from '../../utils/autonomyLife/view';
import OverviewTab from './OverviewTab';
import ActivityTab from './ActivityTab';
import BoundaryTab from './BoundaryTab';
import { FixtureBanner, Badge } from './AutonomyLifeUi';
import { createFixtureAutonomyLifeApi, type FixtureScenario } from './fixtures';
import { useAutonomyLife } from './useAutonomyLifeStore';

/**
 * 统一「自主生活」工作区：概况 / 活动 / 边界。
 *
 * 入口只有一个：神经链接 → 角色详情 → 自主生活（状态入口卡打开这个面板）。
 * 设置页只放账号总览与总边界，并复用同一个组件（scope='account'），
 * 两处读的都是服务端 effective/revision，不做双向镜像（契约 §8）。
 */
export type AutonomyTab = 'overview' | 'activity' | 'boundary';

export interface AutonomyLifePanelProps {
  charId: string;
  charName: string;
  onClose: () => void;
  /** 由宿主提供（Character / Settings 里已有 useOS）。 */
  onOpenApp: (appId: string, context?: Record<string, unknown>) => void;
  onOpenSettings: () => void;
  api?: AutonomyLifeApi;
  /** 仅预览/测试：红色横幅会一直显示「测试数据」。 */
  fixtureScenario?: FixtureScenario;
  initialTab?: AutonomyTab;
  /** 固定「现在」用于截图/测试；不传则每分钟走一次真实时间。 */
  nowMs?: number;
}

const TABS: Array<{ id: AutonomyTab; label: string }> = [
  { id: 'overview', label: '概况' },
  { id: 'activity', label: '活动' },
  { id: 'boundary', label: '边界' },
];

const AutonomyLifePanel: React.FC<AutonomyLifePanelProps> = ({
  charId,
  charName,
  onClose,
  onOpenApp,
  onOpenSettings,
  api,
  fixtureScenario,
  initialTab = 'overview',
  nowMs,
}) => {
  const [tab, setTab] = useState<AutonomyTab>(initialTab);
  const [now, setNow] = useState(() => nowMs ?? Date.now());

  useEffect(() => {
    if (nowMs !== undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [nowMs]);

  const fixtureApi = useMemo(
    () =>
      fixtureScenario
        ? createFixtureAutonomyLifeApi(fixtureScenario, { now: () => nowMs ?? Date.now() })
        : undefined,
    [fixtureScenario, nowMs],
  );

  const { snapshot, store } = useAutonomyLife({ charId, api: fixtureApi ?? api });
  const timezone = snapshot.boundary?.effective.timezone;

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-slate-50" role="dialog" aria-modal="true" aria-label={`${charName} 的自主生活`}>
      <header className="shrink-0 bg-white/95 backdrop-blur border-b border-slate-100">
        <div className="max-w-2xl mx-auto px-3 py-2.5 flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            aria-label="返回角色详情"
            className="p-1.5 rounded-full hover:bg-slate-100 active:scale-90 transition-transform"
          >
            <CaretLeft size={18} className="text-slate-500" />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-black text-slate-800 truncate">自主生活 · {charName}</h2>
            <p className="text-[10px] text-slate-400 truncate">
              {snapshot.lastSyncedAt
                ? `上次同步 ${formatWhen(snapshot.lastSyncedAt, timezone, now)}`
                : '还在读取状态'}
            </p>
          </div>
          {snapshot.state?.availability === 'paused' && <Badge tone="idle">已暂停</Badge>}
          {snapshot.state?.availability === 'pausing' && <Badge tone="warn">正在停止</Badge>}
          {snapshot.state?.availability === 'limited' && <Badge tone="warn">受限</Badge>}
        </div>
        <div className="max-w-2xl mx-auto px-3 pb-2 flex gap-1.5">
          {TABS.map((item) => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(item.id)}
                className={`px-3 py-1 rounded-full text-[11px] font-bold border ${
                  active
                    ? 'bg-violet-500 border-violet-500 text-white shadow-sm shadow-violet-500/30'
                    : 'bg-white border-slate-200 text-slate-500'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-3 py-3 space-y-3">
          {fixtureScenario && <FixtureBanner scenario={fixtureScenario} />}

          {tab === 'overview' && (
            <OverviewTab
              snapshot={snapshot}
              charName={charName}
              now={now}
              onOpenApp={onOpenApp}
              onOpenSettings={onOpenSettings}
              onOpenTab={(next) => setTab(next)}
              onRetry={() => void store.load()}
              onResolveConfirmation={(input) => void store.resolveConfirmation(input)}
            />
          )}

          {tab === 'activity' && (
            <ActivityTab
              snapshot={snapshot}
              now={now}
              onOpenApp={onOpenApp}
              onRetry={() => void store.loadActivities({ reset: true })}
              onLoadMore={() => void store.loadMoreActivities()}
              onSetFilter={(status: ActionStatus | null) => void store.loadActivities({ reset: true, status })}
            />
          )}

          {tab === 'boundary' && (
            <BoundaryTab
              snapshot={snapshot}
              scope="character"
              charName={charName}
              saving={snapshot.saving}
              now={now}
              onSave={(changes, scope) => void store.saveBoundary(changes, scope)}
              onPause={(paused, scope) => void store.setPause(paused, scope)}
              onOpenApp={onOpenApp}
              onDismissNotice={store.dismissNotice}
              onRetry={() => void store.load()}
            />
          )}
        </div>
      </main>
    </div>
  );
};

export default AutonomyLifePanel;
