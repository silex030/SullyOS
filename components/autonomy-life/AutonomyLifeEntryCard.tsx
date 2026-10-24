import React from 'react';
import { ArrowRight, Sparkle } from '@phosphor-icons/react';
import type { AutonomyLifeApi } from '../../utils/autonomyLife/api';
import { describeError, latestActivity, nextOpportunityHint, summarizeAvailability, KIND_LABELS, formatWhen } from '../../utils/autonomyLife/view';
import { Badge, InlineButton, StatusDot, TONE_STYLES } from './AutonomyLifeUi';
import { useAutonomyLife } from './useAutonomyLifeStore';

/**
 * 角色详情页里唯一的「自主生活」入口卡（替代原 AutonomyPanel 的模板/节奏/护栏一堆控件）。
 *
 * 只读展示：TA 现在什么状态、上次做了什么、下次大概什么时候；点进去才是完整工作区。
 * 这一层不再拥有任何频率设置，用户在这里只能看状态和跳转（契约 §8）。
 */
export interface AutonomyLifeEntryCardProps {
  charId: string;
  charName: string;
  onOpen: () => void;
  onOpenAccountSettings: () => void;
  api?: AutonomyLifeApi;
  /** 固定「现在」用于截图/测试；不传则每次渲染取真实时间。 */
  nowMs?: number;
}

const AutonomyLifeEntryCard: React.FC<AutonomyLifeEntryCardProps> = ({
  charId,
  charName,
  onOpen,
  onOpenAccountSettings,
  api,
  nowMs,
}) => {
  const { snapshot } = useAutonomyLife({ charId, api, pollIntervalMs: 60_000 });
  const state = snapshot.state;
  const timezone = snapshot.boundary?.effective.timezone;
  const now = nowMs ?? Date.now();

  const availability = state ? summarizeAvailability(state) : null;
  const last = latestActivity(snapshot.activities);

  return (
    <section className="bg-white rounded-3xl border border-slate-100 shadow-sm p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">自主生活</p>
          {availability ? (
            <>
              <p className={`text-sm font-black mt-1 ${TONE_STYLES[availability.tone].text}`}>
                <StatusDot tone={availability.tone} /> {availability.label}
              </p>
              <p className="text-[11px] text-slate-500 mt-1 leading-relaxed line-clamp-2">{availability.detail}</p>
            </>
          ) : snapshot.status === 'loading' ? (
            <p className="text-xs text-slate-400 mt-1">正在读取 TA 的状态…</p>
          ) : (
            <p className="text-xs text-rose-600 mt-1">
              {snapshot.error ? describeError(snapshot.error.code).title : '还没读到状态'}
            </p>
          )}
        </div>
        <Sparkle size={18} className="text-violet-400 shrink-0" weight="duotone" />
      </div>

      {state && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Badge tone={state.scheduleConfidence === 'persona' ? 'ok' : 'warn'}>
            {state.scheduleConfidence === 'persona' ? '按人设节奏' : '暂用基础作息'}
          </Badge>
          {state.availability === 'paused' && <Badge tone="idle">已暂停</Badge>}
          {state.reasonCodes.length > 0 && <Badge tone="warn">{availability?.detail.slice(0, 18)}…</Badge>}
        </div>
      )}

      <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
        {state ? nextOpportunityHint(state.nextOpportunityAt, timezone, now) : '什么时候做什么，由 TA 的人设和当下情境决定'}
      </p>

      {last && (
        <p className="text-[10px] text-slate-500 mt-1 leading-relaxed">
          最近：{KIND_LABELS[last.kind]} · {formatWhen(last.occurredAt, timezone, now)}
        </p>
      )}

      <div className="flex items-center gap-2 mt-3">
        <button
          type="button"
          onClick={onOpen}
          className="flex-1 flex items-center justify-center gap-1 px-3 py-2 rounded-2xl bg-violet-500 text-white text-xs font-bold shadow-sm shadow-violet-500/30 active:scale-95 transition-transform"
        >
          进入自主生活 <ArrowRight size={13} weight="bold" />
        </button>
        <InlineButton onClick={onOpenAccountSettings}>账号总边界</InlineButton>
      </div>
    </section>
  );
};

export default AutonomyLifeEntryCard;
