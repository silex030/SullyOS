import React from 'react';
import type { ActionStatus } from '../../contracts/autonomyLife';
import type { AutonomyLifeSnapshot } from '../../utils/autonomyLife/store';
import {
  KIND_APP,
  KIND_LABELS,
  NOTIFICATION_LABELS,
  SCOPE_LABELS,
  SOURCE_LABELS,
  describeError,
  formatWhen,
  groupActivities,
  statusLabel,
} from '../../utils/autonomyLife/view';
import { Badge, Card, InlineButton, Notice, Skeleton, type Tone } from './AutonomyLifeUi';

export interface ActivityTabProps {
  snapshot: AutonomyLifeSnapshot;
  onOpenApp: (appId: string, context?: Record<string, unknown>) => void;
  onRetry: () => void;
  onLoadMore: () => void;
  onSetFilter: (status: ActionStatus | null) => void;
  now: number;
}

const STATUS_TONE: Partial<Record<ActionStatus, Tone>> = {
  succeeded: 'ok',
  running: 'warn',
  scheduled: 'idle',
  proposed: 'idle',
  waiting_device: 'warn',
  awaiting_confirmation: 'warn',
  blocked: 'warn',
  unknown: 'bad',
  failed: 'bad',
  expired: 'idle',
  cancelled: 'idle',
};

const FILTERS: Array<{ value: ActionStatus | null; label: string }> = [
  { value: null, label: '全部' },
  { value: 'succeeded', label: '做完的' },
  { value: 'running', label: '在做' },
  { value: 'scheduled', label: '排上的' },
  { value: 'unknown', label: '待核对' },
];

const ActivityTab: React.FC<ActivityTabProps> = ({
  snapshot,
  onOpenApp,
  onRetry,
  onLoadMore,
  onSetFilter,
  now,
}) => {
  const timezone = snapshot.boundary?.effective.timezone;
  const { activities, activitiesStatus, activitiesError, activitiesStatusFilter, activitiesCursor } = snapshot;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((filter) => {
          const active = activitiesStatusFilter === filter.value;
          return (
            <button
              key={filter.label}
              type="button"
              aria-pressed={active}
              onClick={() => onSetFilter(filter.value)}
              className={`px-3 py-1 rounded-full border text-[11px] font-bold ${
                active
                  ? 'bg-violet-500 border-violet-500 text-white'
                  : 'bg-white border-slate-200 text-slate-500'
              }`}
            >
              {filter.label}
            </button>
          );
        })}
      </div>

      {activitiesStatus === 'loading' && activities.length === 0 && <Skeleton rows={5} />}

      {activitiesError && (
        <Notice
          tone={activitiesError.code === 'NETWORK' ? 'warn' : 'bad'}
          title={describeError(activitiesError.code).title}
          detail={describeError(activitiesError.code).hint}
          action={<InlineButton onClick={onRetry}>重新读取</InlineButton>}
          role="alert"
        />
      )}

      {activitiesStatus !== 'loading' && activities.length === 0 && !activitiesError && (
        <Card>
          <p className="text-xs font-bold text-slate-500">还没有自主活动记录</p>
          <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
            这里只显示真实发生过的活动：有记录才列出来，没有记录就什么都不显示，也不会补编内容。
          </p>
        </Card>
      )}

      {groupActivities(activities, timezone, now).map((group) => (
        <div key={group.dayKey} className="space-y-1.5">
          <p className="text-[10px] font-bold text-slate-400 tracking-widest">{group.label}</p>
          {group.items.map((item) => {
            const app = KIND_APP[item.kind];
            const tone = STATUS_TONE[item.status] ?? 'idle';
            const unknown = item.status === 'unknown';
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onOpenApp(app.appId, { charId: item.charId, actionId: item.id, resultRef: item.resultRef })}
                className="w-full text-left bg-white rounded-2xl border border-slate-100 shadow-sm px-3 py-2.5 active:scale-[0.995]"
                aria-label={`${KIND_LABELS[item.kind]}，${statusLabel(item.status)}，打开${app.label}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-slate-700">{KIND_LABELS[item.kind]}</span>
                  <span className="text-[10px] text-slate-400">{formatWhen(item.occurredAt, timezone, now)}</span>
                </div>
                <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">{item.reasonSummary}</p>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  <Badge tone={item.scope === 'external_read' ? 'warn' : 'idle'}>{SCOPE_LABELS[item.scope]}</Badge>
                  <Badge tone={tone}>{statusLabel(item.status)}</Badge>
                  <Badge tone="idle" title="动作来源">{SOURCE_LABELS[item.source]}</Badge>
                  {item.kind === 'takeout.order' || item.kind === 'shopping.order' ? (
                    <Badge tone="warn">OS 内模拟订单，不是现实订单</Badge>
                  ) : null}
                  {item.kind === 'external.read' && item.status === 'succeeded' ? (
                    <Badge tone="idle">数据来自外部站点（只读）</Badge>
                  ) : null}
                  {item.notificationState === 'not_delivered' && (
                    <Badge tone="idle">活动已保存，通知未送达</Badge>
                  )}
                  {item.notificationState !== 'none' && item.notificationState !== 'not_delivered' && (
                    <Badge tone="idle">{NOTIFICATION_LABELS[item.notificationState]}</Badge>
                  )}
                </div>
                {unknown && (
                  <p className="text-[10px] text-rose-600 mt-1 leading-relaxed">
                    结果待核对：不确定有没有生效，先别重复操作（没有盲重试按钮）。
                  </p>
                )}
                {item.status === 'failed' && item.errorCode && (
                  <p className="text-[10px] text-rose-600 mt-1 leading-relaxed">
                    失败原因：{describeError(item.errorCode as never).title}
                  </p>
                )}
                {item.status === 'succeeded' && !item.resultRef && (
                  <p className="text-[10px] text-amber-600 mt-1 leading-relaxed">
                    缺少可跳转的记录引用：这条可能来自旧版本，无法核实原始内容。
                  </p>
                )}
              </button>
            );
          })}
        </div>
      ))}

      {activitiesCursor && (
        <div className="flex justify-center">
          <InlineButton onClick={onLoadMore}>加载更早的记录</InlineButton>
        </div>
      )}
    </div>
  );
};

export default ActivityTab;
