import React, { useEffect, useState } from 'react';
import type { AutonomyLifeApi } from '../../utils/autonomyLife/api';
import { describeError, summarizeAvailability, NOT_AUTONOMOUS_APPS } from '../../utils/autonomyLife/view';
import BoundaryTab from './BoundaryTab';
import { Badge, Card, InlineButton, SectionTitle, StatusDot, TONE_STYLES } from './AutonomyLifeUi';
import { useAutonomyLife } from './useAutonomyLifeStore';
import { createDefaultAutonomyLifeApi } from '../../utils/autonomyLife/endpoint';

/**
 * 设置 → 自主生活（账号总览）。
 *
 * 只做账号层：总暂停、账号总额度、账号级禁止方向/免打扰、外部授权，以及每个角色
 * 当前是否在自主生活（只读）。角色层边界仍然只在「角色详情 → 自主生活 → 边界」里改，
 * 避免两处镜像出两套可漂移的设置（契约 §8）。
 */
export interface AutonomyAccountSectionProps {
  characters: Array<{ id: string; name: string }>;
  onOpenApp: (appId: string, context?: Record<string, unknown>) => void;
  api?: AutonomyLifeApi;
  nowMs?: number;
}

interface CharStatusRow {
  id: string;
  name: string;
  label: string;
  tone: 'ok' | 'idle' | 'warn' | 'bad';
  detail: string;
}

const AutonomyAccountSection: React.FC<AutonomyAccountSectionProps> = ({
  characters,
  onOpenApp,
  api,
  nowMs,
}) => {
  const apiInstance = React.useMemo(() => api ?? createDefaultAutonomyLifeApi(), [api]);
  const { snapshot, store } = useAutonomyLife({ charId: '', api: apiInstance, autoLoad: true, pollIntervalMs: 120_000 });
  const [rows, setRows] = useState<CharStatusRow[]>([]);
  const now = nowMs ?? Date.now();

  useEffect(() => {
    let cancelled = false;
    const loadRows = async () => {
      const targets = characters.slice(0, 12);
      const results = await Promise.all(
        targets.map(async (char) => {
          const res = await apiInstance.readLife(char.id);
          if (!res.ok) {
            return {
              id: char.id,
              name: char.name,
              label: describeError(res.code).title,
              tone: res.code === 'NETWORK' ? 'warn' : 'bad',
              detail: describeError(res.code).hint,
            } satisfies CharStatusRow;
          }
          const summary = summarizeAvailability(res.data.state);
          return {
            id: char.id,
            name: char.name,
            label: summary.label,
            tone: summary.tone,
            detail: summary.detail,
          } satisfies CharStatusRow;
        }),
      );
      if (!cancelled) setRows(results);
    };
    void loadRows();
    return () => {
      cancelled = true;
    };
  }, [apiInstance, characters]);

  return (
    <div className="space-y-3">
      <BoundaryTab
        snapshot={snapshot}
        scope="account"
        charName="账号"
        saving={snapshot.saving}
        now={now}
        onSave={(changes, scope) => void store.saveBoundary(changes, scope)}
        onPause={(paused, scope) => void store.setPause(paused, scope)}
        onOpenApp={onOpenApp}
        onDismissNotice={store.dismissNotice}
        onRetry={() => void store.load()}
      />

      <Card>
        <SectionTitle hint="只读。角色层参与/上限在「角色详情 → 自主生活 → 边界」里改。">
          角色状态
        </SectionTitle>
        {rows.length === 0 ? (
          <p className="text-[11px] text-slate-400">还没有角色，或状态读不到</p>
        ) : (
          <div className="space-y-1">
            {rows.map((row) => (
              <div key={row.id} className="flex items-center justify-between gap-2 py-1">
                <div className="min-w-0">
                  <p className="text-xs font-bold text-slate-700 truncate">{row.name}</p>
                  <p className="text-[10px] text-slate-400 truncate">{row.detail}</p>
                </div>
                <span className={`text-[10px] font-bold ${TONE_STYLES[row.tone].text} flex items-center gap-1 shrink-0`}>
                  <StatusDot tone={row.tone} /> {row.label}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle hint="这些 App 保留手动体验，本期不接入自主调度。">暂未接入自主调度</SectionTitle>
        <div className="flex flex-wrap gap-1.5">
          {NOT_AUTONOMOUS_APPS.map((app) => (
            <Badge key={app.appId} tone="idle">{app.label}</Badge>
          ))}
        </div>
        <div className="mt-2">
          <InlineButton onClick={() => onOpenApp('launcher')}>回到桌面自己打开</InlineButton>
        </div>
      </Card>
    </div>
  );
};

export default AutonomyAccountSection;
