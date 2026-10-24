import React from 'react';
import type { AutonomyLifeSnapshot } from '../../utils/autonomyLife/store';
import {
  BOUNDARY_QUICK_LINKS,
  KIND_APP,
  KIND_LABELS,
  NOT_AUTONOMOUS_APPS,
  budgetRows,
  describeError,
  formatWhen,
  latestActivity,
  nextOpportunityHint,
  statusLabel,
  summarizeAvailability,
} from '../../utils/autonomyLife/view';
import { Badge, Card, InlineButton, Notice, Row, SectionTitle, Skeleton, StatusDot, TONE_STYLES } from './AutonomyLifeUi';

export interface OverviewTabProps {
  snapshot: AutonomyLifeSnapshot;
  charName: string;
  onOpenApp: (appId: string, context?: Record<string, unknown>) => void;
  onOpenSettings: () => void;
  onOpenTab: (tab: 'activity' | 'boundary') => void;
  onRetry: () => void;
  onResolveConfirmation: (input: {
    id: string;
    decision: 'approve' | 'reject';
    payloadHash: string;
    nonce: string;
    expectedRevision: number;
  }) => void;
  now: number;
}

/**
 * 概况：TA 现在什么状态、为什么、上次做了什么、下次大概什么时候、还剩多少额度。
 * 所有「为什么」都直接用服务端 reasonCodes，不写成角色改变心意（契约 §1.7）。
 */
const OverviewTab: React.FC<OverviewTabProps> = ({
  snapshot,
  charName,
  onOpenApp,
  onOpenSettings,
  onOpenTab,
  onRetry,
  onResolveConfirmation,
  now,
}) => {
  const { state, status, error, pause, localPauseRequested } = snapshot;
  const timezone = snapshot.boundary?.effective.timezone;

  if (status === 'loading' && !state) {
    return (
      <div className="space-y-3">
        <Skeleton rows={4} />
      </div>
    );
  }

  if (!state) {
    const copy = error ? describeError(error.code) : { title: '还没读到状态', hint: '点下面的按钮重新读取。', retryable: true };
    return (
      <Notice
        tone={error?.code === 'NETWORK' ? 'warn' : 'bad'}
        title={copy.title}
        detail={`${copy.hint}${snapshot.lastSyncedAt ? `（上次同步：${formatWhen(snapshot.lastSyncedAt, timezone, now)}）` : ''}`}
        role="alert"
        action={<InlineButton onClick={onRetry}>重新读取</InlineButton>}
      />
    );
  }

  const availability = summarizeAvailability(state);
  const budget = budgetRows(state);
  const last = latestActivity(snapshot.activities);
  const offline = error?.code === 'NETWORK';

  return (
    <div className="space-y-3">
      {offline && (
        <Notice
          tone="warn"
          title="状态暂无法确认"
          detail={`网络或后台不可达，下面显示的是 ${formatWhen(snapshot.lastSyncedAt ?? now, timezone, now)} 的结果。`}
          action={<InlineButton onClick={onRetry}>重试</InlineButton>}
        />
      )}

      <Card>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">TA 现在</p>
            <p className={`text-sm font-black mt-1 ${TONE_STYLES[availability.tone].text}`}>
              <StatusDot tone={availability.tone} /> {availability.label}
            </p>
            <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">{availability.detail}</p>
          </div>
          <div className="shrink-0 text-right space-y-1">
            <Badge tone={state.scheduleConfidence === 'persona' ? 'ok' : 'warn'}>
              {state.scheduleConfidence === 'persona' ? '按人设节奏' : '暂用基础作息'}
            </Badge>
            {state.activeActionId && <Badge tone="warn">正在做一件事</Badge>}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-2xl bg-slate-50/70 px-3 py-2">
            <p className="text-[10px] font-bold text-slate-400">下次自然机会</p>
            <p className="text-[11px] font-bold text-slate-600 mt-0.5">
              {nextOpportunityHint(state.nextOpportunityAt, timezone, now)}
            </p>
          </div>
          <div className="rounded-2xl bg-slate-50/70 px-3 py-2">
            <p className="text-[10px] font-bold text-slate-400">排队中的事</p>
            <p className="text-[11px] font-bold text-slate-600 mt-0.5">
              {state.pendingCount > 0 ? `${state.pendingCount} 件` : '没有'}
            </p>
          </div>
        </div>

        <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
          什么时候做什么，由 TA 的人设、作息和眼下情境决定；你只设边界，不排时间表。
        </p>
      </Card>

      {(localPauseRequested || pause.phase !== 'idle') && (
        <Notice
          tone="warn"
          title={pause.phase === 'idle' ? '正在停止' : '正在请求停止/恢复…'}
          detail="仅本设备已停，云端待确认。确认全部停止后这里会显示「已暂停」。"
        />
      )}
      {state.availability === 'paused' && (
        <Notice
          tone="idle"
          title="已暂停"
          detail="暂停期间不会产生新动作；恢复后不会补跑过期计划。"
          action={<InlineButton onClick={() => onOpenTab('boundary')}>去边界恢复</InlineButton>}
        />
      )}

      {state.reasonCodes.includes('MISSING_CREDENTIALS') && (
        <Notice
          tone="bad"
          title="模型凭据还没配置"
          detail="没有云端模型凭据时，日记、外卖等需要生成内容的活动都无法执行。"
          action={<InlineButton onClick={onOpenSettings}>去配置</InlineButton>}
        />
      )}
      {state.reasonCodes.includes('WAITING_DEVICE') && (
        <Notice
          tone="warn"
          title="执行设备不在线"
          detail="有些动作要等这台设备上线才会真正写入，不会假装已经完成。"
        />
      )}

      {snapshot.pendingConfirmations.map((pending) => (
        <Card key={pending.id}>
          <SectionTitle hint="外部只读查询会把下面这些字段发出去，批准前可以核对。">待确认的外部数据请求</SectionTitle>
          <div className="rounded-2xl bg-amber-50 border border-amber-200 px-3 py-2 space-y-1">
            <p className="text-[11px] font-bold text-amber-800">{pending.purpose}</p>
            {pending.host && <p className="text-[10px] text-amber-700">目标：{pending.host}</p>}
            <p className="text-[10px] text-amber-700">会发送：{pending.fields.length > 0 ? pending.fields.join('、') : '（服务端未提供字段预览）'}</p>
            {pending.expiresAt > 0 && (
              <p className="text-[10px] text-amber-600">有效期到 {formatWhen(pending.expiresAt, timezone, now)}</p>
            )}
          </div>
          <div className="flex gap-2 mt-2">
            <InlineButton
              tone="primary"
              onClick={() => onResolveConfirmation({ ...pending, decision: 'approve' })}
            >
              批准这次外传
            </InlineButton>
            <InlineButton
              tone="danger"
              onClick={() => onResolveConfirmation({ ...pending, decision: 'reject' })}
            >
              拒绝
            </InlineButton>
          </div>
        </Card>
      ))}

      <Card>
        <SectionTitle hint="按真实记录跳转；记录不可用时不会编内容。">最近一件事</SectionTitle>
        {last ? (
          <button
            type="button"
            onClick={() => onOpenApp(KIND_APP[last.kind].appId, { charId: last.charId, actionId: last.id, resultRef: last.resultRef })}
            className="w-full text-left rounded-2xl border border-slate-100 bg-slate-50/70 px-3 py-2"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold text-slate-700">{KIND_LABELS[last.kind]}</span>
              <span className="text-[10px] text-slate-400">{formatWhen(last.occurredAt, timezone, now)}</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">{last.reasonSummary}</p>
            <div className="flex gap-1.5 mt-1">
              <Badge tone="idle">{last.scope === 'os_simulation' ? 'OS 内模拟' : '外部只读'}</Badge>
              <Badge tone="ok">{statusLabel(last.status)}</Badge>
            </div>
          </button>
        ) : (
          <p className="text-[11px] text-slate-400">尚无自主活动</p>
        )}
        <div className="mt-2">
          <InlineButton onClick={() => onOpenTab('activity')}>查看全部活动</InlineButton>
        </div>
      </Card>

      <Card>
        <SectionTitle hint="上限只是天花板，不要求用满；数字来自服务端账本。">今日额度</SectionTitle>
        {budget.length === 0 ? (
          <p className="text-[11px] text-slate-400">服务端还没给出预算账本</p>
        ) : (
          <div className="space-y-1">
            {budget.map((row) => (
              <Row key={row.dim} label={row.label} hint={row.exhausted ? '今天已经用完' : undefined}>
                <span className={`text-[11px] font-bold ${row.exhausted ? 'text-rose-600' : 'text-slate-600'}`}>
                  {row.text}
                </span>
              </Row>
            ))}
          </div>
        )}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {state.reasonCodes
            .filter((code) => code === 'BUDGET_EXHAUSTED' || code === 'TOKEN_BUDGET_EXHAUSTED')
            .map((code) => (
              <Badge key={code} tone="warn">今天额度用完，明天自动重置</Badge>
            ))}
        </div>
        <div className="mt-2">
          <InlineButton onClick={() => onOpenTab('boundary')}>调整上限</InlineButton>
        </div>
      </Card>

      <Card>
        <SectionTitle hint="保留手动入口；这里只做快捷跳转，不在各处重复设频率。">就地入口</SectionTitle>
        <div className="flex flex-wrap gap-1.5">
          {BOUNDARY_QUICK_LINKS.map((link) => (
            <InlineButton key={link.appId} onClick={() => onOpenApp(link.appId, { charId: snapshot.charId })}>
              {link.label}
            </InlineButton>
          ))}
        </div>
        <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
          暂未接入自主调度：{NOT_AUTONOMOUS_APPS.map((app) => app.label).join('、')}。这些 App 的手动体验照旧。
        </p>
      </Card>
    </div>
  );
};

export default OverviewTab;
