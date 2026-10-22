import React, { useEffect, useRef, useState } from 'react';
import { ArrowClockwise, ShieldCheck, WarningCircle } from '@phosphor-icons/react';
import {
  AUTONOMY_GUARDRAIL_CEILINGS,
  AUTONOMY_GUARDRAIL_DEFAULTS,
  type AirpAutonomyGuardrails,
} from '../../utils/airp/autonomyGuardrails';
import {
  getGlobalGuardrailsSnapshot,
  refreshGlobalGuardrailsFromRemote,
  saveGlobalGuardrails,
  subscribeGlobalGuardrails,
  type GlobalGuardrailsSnapshot,
  type GuardrailsSyncState,
} from '../../utils/airp/autonomyGuardrailsClient';
import { connectAutonomyGuardrailCloud } from '../../utils/airp/autonomyGuardrailTransport';
import { GuardrailNumberInput, GuardrailPauseNote } from '../character/AutonomyGuardrailsFields';

/**
 * 设置 → 自主生活护栏（全局）。
 *
 * 权威副本在后台共享行（`amsg:global/autonomy_guardrails`，worker 调度器直接读）。
 * 这一页的三条纪律：
 *   1. **读不到云端真实值时不展示可保存的 paused:false** —— 那会把用户按下的总暂停
 *      悄悄覆盖掉；此时整页显示「未确认」，保存按钮不可用，只留「重新同步」。
 *   2. 保存只提交用户真改过的那两项（globalPerDay / paused），基线是上次确认值；
 *      「解除暂停」需要一次明确的总开关点击，否则暂停会被保住。
 *   3. 另一台设备同时改过 → 显示冲突并采用云端值，绝不覆盖。
 *
 * 全局只做契约里真正生效的两项：每天合计次数（globalPerDay）与总暂停（paused）。
 * 每角色的次数 / 同类间隔 / 预留 token 是角色级字段，在角色的自主生活面板里调。
 */

interface FormValue {
  paused: boolean;
  globalPerDay: number;
}

const toForm = (value: AirpAutonomyGuardrails): FormValue => ({
  paused: value.paused,
  globalPerDay: value.globalPerDay,
});

const STATUS_TEXT: Record<GuardrailsSyncState['status'], string> = {
  unknown: '未确认：还没读到后台保存的护栏配置',
  synced: '已同步到后台',
  pending: '待同步：本机已保存，等后台确认',
  error: '同步失败：本机草稿已保留，可重试',
  conflict: '冲突：云端已被另一台设备修改，已采用云端值',
};

const STATUS_TINT: Record<GuardrailsSyncState['status'], string> = {
  unknown: 'bg-rose-50 text-rose-700 border-rose-200',
  synced: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  error: 'bg-rose-50 text-rose-700 border-rose-200',
  conflict: 'bg-amber-50 text-amber-700 border-amber-200',
};

const Switch: React.FC<{ checked: boolean; disabled?: boolean; onChange: (next: boolean) => void }> = ({
  checked,
  disabled,
  onChange,
}) => (
  <label className={`relative inline-flex items-center shrink-0 ${disabled ? 'opacity-40' : 'cursor-pointer'}`}>
    <input
      type="checkbox"
      className="sr-only peer"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
    <div className="w-11 h-6 bg-slate-200 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-violet-500"></div>
  </label>
);

const Row: React.FC<{ label: string; hint?: string; children?: React.ReactNode }> = ({ label, hint, children }) => (
  <div className="flex items-start justify-between gap-3">
    <div className="min-w-0">
      <div className="text-xs font-bold text-slate-700">{label}</div>
      {hint && <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">{hint}</p>}
    </div>
    {children && <div className="shrink-0 flex items-center gap-2">{children}</div>}
  </div>
);

const AutonomyGuardrailsSettings: React.FC = () => {
  const [snapshot, setSnapshot] = useState<GlobalGuardrailsSnapshot>(() => getGlobalGuardrailsSnapshot());
  const [form, setForm] = useState<FormValue | null>(() => {
    const initial = getGlobalGuardrailsSnapshot();
    return initial.value ? toForm(initial.value) : null;
  });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pauseHint, setPauseHint] = useState(false);
  const [unpauseIntent, setUnpauseIntent] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const syncState = snapshot.syncState;
  const confirmed = snapshot.value !== null;

  const adoptSnapshot = () => {
    const next = getGlobalGuardrailsSnapshot();
    setSnapshot(next);
    if (!dirtyRef.current) setForm(next.value ? toForm(next.value) : null);
    return next;
  };

  useEffect(() => {
    // 别的标签页改了 / 后台回读成功 → 没在编辑就跟上，正在编辑就不抢用户的手。
    return subscribeGlobalGuardrails(() => {
      const next = getGlobalGuardrailsSnapshot();
      setSnapshot(next);
      if (!dirtyRef.current && next.value) setForm(toForm(next.value));
    });
  }, []);

  useEffect(() => {
    let alive = true;
    void connectAutonomyGuardrailCloud()
      .then(() => refreshGlobalGuardrailsFromRemote())
      .then(() => {
        if (!alive) return;
        const next = getGlobalGuardrailsSnapshot();
        setSnapshot(next);
        if (!dirtyRef.current) setForm(next.value ? toForm(next.value) : null);
      })
      .catch(() => {
        if (alive) setSnapshot(getGlobalGuardrailsSnapshot());
      });
    return () => {
      alive = false;
    };
  }, []);

  const patch = (next: Partial<FormValue>) => {
    setDirty(true);
    setActionError(null);
    setForm((prev) => ({
      paused: next.paused ?? prev?.paused ?? true,
      globalPerDay: next.globalPerDay ?? prev?.globalPerDay ?? AUTONOMY_GUARDRAIL_DEFAULTS.globalPerDay,
    }));
  };

  const handleSave = async () => {
    if (!form || !confirmed) return;
    setSaving(true);
    setActionError(null);
    try {
      const result = await saveGlobalGuardrails(
        { paused: form.paused, globalPerDay: form.globalPerDay },
        { allowUnpause: unpauseIntent && form.paused === false },
      );
      if (result.ok) {
        setForm(result.value ? toForm(result.value) : null);
        setDirty(false);
        setPauseHint(false);
        setUnpauseIntent(false);
        setActionError(null);
      } else {
        setActionError(result.error ?? '保存没有完成');
        // 冲突时放弃本机草稿、采用云端值，避免再点一次覆盖别人的暂停。
        if (result.conflict) {
          setDirty(false);
          setUnpauseIntent(false);
        }
        if (result.value) setForm(toForm(result.value));
      }
      setSnapshot(getGlobalGuardrailsSnapshot());
    } finally {
      setSaving(false);
    }
  };

  const resync = async () => {
    // 有待同步草稿时，「重新同步」应该是重发草稿（refresh 会主动跳过草稿，避免覆盖）。
    if (getGlobalGuardrailsSnapshot().pendingSync && form) {
      await handleSave();
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      await connectAutonomyGuardrailCloud();
      await refreshGlobalGuardrailsFromRemote();
      const next = adoptSnapshot();
      if (next.value) setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  const allowed = form ? !form.paused : false;

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 bg-violet-50 border border-violet-100 rounded-2xl px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-xs font-bold text-slate-700">允许角色自主生活</p>
          <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">
            总开关（对应契约里的 paused）：关掉后所有角色都不再自己安排生活，已有记录保留；
            各角色面板里的开关仍然各自有效。
          </p>
        </div>
        <Switch
          checked={allowed}
          disabled={!confirmed || saving}
          onChange={(next) => {
            if (!next) {
              setUnpauseIntent(false);
              patch({ paused: true });
              return;
            }
            // 明确打开 = 允许未来的解暂停；次数为 0 时先恢复一个可运行的次数。
            setUnpauseIntent(true);
            setPauseHint(false);
            patch(form && form.globalPerDay === 0
              ? { paused: false, globalPerDay: AUTONOMY_GUARDRAIL_DEFAULTS.globalPerDay }
              : { paused: false });
          }}
        />
      </div>

      <div className="space-y-3 bg-slate-50/70 rounded-2xl px-3 py-2.5">
        {confirmed && form ? (
          <Row label="全部角色每天合计" hint="全局上限，所有角色加起来最多这么多次；0 = 全部暂停（等同关掉上面开关）">
            <GuardrailNumberInput
              ariaLabel="全部角色每天合计次数"
              value={form.globalPerDay}
              min={0}
              max={AUTONOMY_GUARDRAIL_CEILINGS.globalPerDay}
              disabled={saving}
              onCommit={(next) => {
                if (next === 0) {
                  // 0 次/天在契约里就是总暂停，直接落成 0 + 暂停（不是 6）。
                  setPauseHint(true);
                  setUnpauseIntent(false);
                  patch({ paused: true, globalPerDay: 0 });
                  return;
                }
                setPauseHint(false);
                patch({ globalPerDay: next });
              }}
            />
          </Row>
        ) : (
          <Row label="全部角色每天合计" hint="还没读到后台那一行，所以这里不显示任何默认次数（默认值不代表你的真实设置）">
            <span className="text-[11px] font-bold text-rose-500">未确认</span>
          </Row>
        )}
        <Row
          label="每角色默认"
          hint={`${AUTONOMY_GUARDRAIL_DEFAULTS.perCharPerDay} 次/天、同类间隔 ${Math.round(AUTONOMY_GUARDRAIL_DEFAULTS.sameKindMinGapMinutes / 60)} 小时、每次预留 ${AUTONOMY_GUARDRAIL_DEFAULTS.reserveTokensPerRun} token`}
        />
      </div>

      {pauseHint && (
        <GuardrailPauseNote>
          次数填 0 = 全部暂停：已把总开关关掉。要恢复就把次数改回大于 0，再打开上面的开关。
        </GuardrailPauseNote>
      )}

      {form?.paused && confirmed && (
        <GuardrailPauseNote>
          当前是暂停状态（paused）：调度器不会排任何自主生成；每角色的单独设置不会被清掉。
        </GuardrailPauseNote>
      )}

      {!confirmed && (
        <div className="flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-[10px] text-rose-700 leading-relaxed">
          <WarningCircle size={14} weight="bold" className="shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="font-bold">不同步：后台的护栏配置读不出来</p>
            <p className="mt-0.5 opacity-90">
              网络、密钥或那一行数据有问题。为了不把云端的「暂停」覆盖成「未暂停」，这里暂时不许保存；
              恢复后点「重新同步」即可。
            </p>
          </div>
        </div>
      )}

      <p className="text-[10px] text-slate-400 leading-relaxed">
        每角色的次数 / 同类间隔 / 预留 token 在「神经链接 → 角色 → 自主背景生活 → 生活护栏」里调；
        这里是所有角色共享的那一份。
      </p>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!confirmed || !dirty || saving}
          className="flex-1 py-2.5 rounded-2xl text-xs font-bold text-white bg-violet-500 shadow-sm shadow-violet-500/20 transition active:scale-[.98] disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none"
        >
          {saving ? '保存中…' : !confirmed ? '未确认（先同步）' : dirty ? '保存护栏' : syncState.status === 'synced' ? '已保存' : '保存护栏'}
        </button>
        {(syncState.status !== 'synced' || !confirmed) && (
          <button
            type="button"
            onClick={() => void resync()}
            disabled={saving}
            className="shrink-0 px-3 py-2.5 rounded-2xl text-[11px] font-bold bg-white border border-slate-200 text-slate-500 active:scale-95 transition-transform disabled:opacity-40"
          >
            <ArrowClockwise size={12} weight="bold" className="inline -mt-0.5" /> 重新同步
          </button>
        )}
      </div>

      <div className={`flex items-start gap-2 rounded-2xl border px-3 py-2 ${STATUS_TINT[syncState.status]}`}>
        <ShieldCheck size={14} weight="bold" className="shrink-0 mt-0.5" />
        <div className="min-w-0 text-[10px] leading-relaxed">
          <p className="font-bold">{STATUS_TEXT[syncState.status]}</p>
          <p className="opacity-80 mt-0.5">
            后台那份才是权威：本机只留一份草稿，换设备 / 清缓存以后台为准。
            {actionError ? ` 最近一次操作：${actionError}` : syncState.lastError ? ` 最近一次失败：${syncState.lastError}` : ''}
          </p>
        </div>
      </div>
    </div>
  );
};

export default AutonomyGuardrailsSettings;
