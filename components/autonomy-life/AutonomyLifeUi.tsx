import React, { useEffect, useState } from 'react';

/**
 * 自主生活 UI · 共用小控件。
 *
 * 视觉沿用项目既有卡片语言（bg-white rounded-3xl border-slate-100 shadow-sm、violet 主色、
 * 数字输入白底描边），不引入新设计体系、不用动画库。
 * 无障碍：状态不只靠颜色（都有文字标签）、开关用 role=switch、输入框都有 aria-label。
 */

export type Tone = 'ok' | 'idle' | 'warn' | 'bad';

export const TONE_STYLES: Record<Tone, { dot: string; text: string; chip: string }> = {
  ok: { dot: 'bg-emerald-500', text: 'text-emerald-600', chip: 'bg-emerald-50 border-emerald-200 text-emerald-700' },
  idle: { dot: 'bg-slate-400', text: 'text-slate-500', chip: 'bg-slate-50 border-slate-200 text-slate-600' },
  warn: { dot: 'bg-amber-500', text: 'text-amber-600', chip: 'bg-amber-50 border-amber-200 text-amber-700' },
  bad: { dot: 'bg-rose-500', text: 'text-rose-600', chip: 'bg-rose-50 border-rose-200 text-rose-700' },
};

export const StatusDot: React.FC<{ tone: Tone }> = ({ tone }) => (
  <span aria-hidden="true" className={`inline-block w-2 h-2 rounded-full ${TONE_STYLES[tone].dot}`} />
);

export const Badge: React.FC<{
  tone?: Tone;
  children: React.ReactNode;
  title?: string;
}> = ({ tone = 'idle', children, title }) => (
  <span
    title={title}
    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-bold ${TONE_STYLES[tone].chip}`}
  >
    {children}
  </span>
);

export const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <section className={`bg-white rounded-3xl border border-slate-100 shadow-sm p-4 ${className ?? ''}`}>
    {children}
  </section>
);

export const SectionTitle: React.FC<{ children: React.ReactNode; hint?: string }> = ({ children, hint }) => (
  <div className="mb-2">
    <h3 className="text-xs font-bold text-slate-600 tracking-wide">{children}</h3>
    {hint && <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">{hint}</p>}
  </div>
);

export const Notice: React.FC<{
  tone: Tone;
  title: string;
  detail?: string;
  action?: React.ReactNode;
  role?: 'status' | 'alert';
}> = ({ tone, title, detail, action, role = 'status' }) => (
  <div className={`rounded-2xl border px-3 py-2.5 ${TONE_STYLES[tone].chip}`} role={role}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs font-bold flex items-center gap-1.5">
          <StatusDot tone={tone} />
          {title}
        </p>
        {detail && <p className="text-[10px] mt-1 leading-relaxed opacity-90">{detail}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  </div>
);

export const InlineButton: React.FC<{
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  tone?: 'primary' | 'quiet' | 'danger';
  ariaLabel?: string;
}> = ({ onClick, children, disabled, tone = 'quiet', ariaLabel }) => {
  const cls =
    tone === 'primary'
      ? 'bg-violet-500 text-white border-violet-500 shadow-sm shadow-violet-500/30'
      : tone === 'danger'
        ? 'bg-white text-rose-600 border-rose-200'
        : 'bg-white text-slate-600 border-slate-200';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`px-3 py-1.5 rounded-xl border text-[11px] font-bold active:scale-95 transition-transform disabled:opacity-40 ${cls}`}
    >
      {children}
    </button>
  );
};

export const Toggle: React.FC<{
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}> = ({ checked, onChange, label, disabled }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`w-11 h-6 rounded-full transition-colors duration-200 shrink-0 disabled:opacity-40 ${
      checked ? 'bg-violet-500' : 'bg-slate-300'
    }`}
  >
    <span
      className="block w-5 h-5 rounded-full bg-white shadow-sm transition-transform duration-200"
      style={{ transform: `translateX(${checked ? 22 : 2}px)`, marginTop: 2 }}
    />
  </button>
);

export const Row: React.FC<{
  label: string;
  hint?: string;
  children: React.ReactNode;
}> = ({ label, hint, children }) => (
  <div className="flex items-center justify-between gap-3 py-1.5">
    <div className="min-w-0">
      <div className="text-xs font-bold text-slate-700">{label}</div>
      {hint && <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">{hint}</p>}
    </div>
    <div className="shrink-0 flex items-center gap-2">{children}</div>
  </div>
);

/**
 * 边界数字输入：失焦/回车才提交；空值 = 继承（只对允许继承的字段）；
 * 非法值只标红、不写盘。0 是合法值（明确禁止），绝不静默夹成 1。
 */
export const BoundaryNumberInput: React.FC<{
  value: number | null;
  min?: number;
  max: number;
  inheritedText?: string;
  disabled?: boolean;
  ariaLabel: string;
  onCommit: (next: number | null) => void;
}> = ({ value, min = 0, max, inheritedText = '跟随账号', disabled, ariaLabel, onCommit }) => {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(value === null ? '' : String(value));
    setError(null);
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      setError(null);
      setDraft('');
      if (value !== null) onCommit(null);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      setError('要整数');
      return;
    }
    if (parsed < min || parsed > max) {
      setError(`范围 ${min}–${max}`);
      return;
    }
    setError(null);
    setDraft(String(parsed));
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <div className="flex flex-col items-end gap-0.5">
      <input
        type="text"
        inputMode="numeric"
        aria-label={ariaLabel}
        aria-invalid={error !== null}
        placeholder={inheritedText}
        value={draft}
        disabled={disabled}
        onChange={(event) => {
          setDraft(event.target.value);
          if (error) setError(null);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
          if (event.key === 'Escape') {
            setDraft(value === null ? '' : String(value));
            setError(null);
          }
        }}
        className={`w-20 bg-white border rounded-xl px-2 py-1.5 text-sm text-center font-bold outline-none transition-colors ${
          error
            ? 'border-rose-300 text-rose-600 focus:ring-1 focus:ring-rose-300'
            : 'border-violet-200 text-violet-700 focus:ring-1 focus:ring-violet-300'
        } disabled:opacity-40`}
      />
      {error && (
        <span role="alert" className="text-[9px] font-bold text-rose-500 leading-none">
          {error}
        </span>
      )}
    </div>
  );
};

/** HH:mm 输入（免打扰窗口用）；非法只标红不提交。 */
export const ClockInput: React.FC<{
  value: string;
  ariaLabel: string;
  disabled?: boolean;
  onCommit: (next: string) => void;
}> = ({ value, ariaLabel, disabled, onCommit }) => {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(value);
    setError(null);
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed)) {
      setError('HH:mm');
      return;
    }
    setError(null);
    setDraft(trimmed);
    if (trimmed !== value) onCommit(trimmed);
  };

  return (
    <div className="flex flex-col items-end gap-0.5">
      <input
        type="text"
        aria-label={ariaLabel}
        aria-invalid={error !== null}
        value={draft}
        disabled={disabled}
        onChange={(event) => {
          setDraft(event.target.value);
          if (error) setError(null);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
        className={`w-16 bg-white border rounded-xl px-2 py-1.5 text-sm text-center font-mono font-bold outline-none ${
          error ? 'border-rose-300 text-rose-600' : 'border-violet-200 text-violet-700'
        } disabled:opacity-40`}
      />
      {error && (
        <span role="alert" className="text-[9px] font-bold text-rose-500 leading-none">
          {error}
        </span>
      )}
    </div>
  );
};

/** 禁止方向 / 回避话题的标签编辑（用户只能追加；平台硬禁不可删）。 */
export const ChipsEditor: React.FC<{
  items: string[];
  locked?: string[];
  labelOf?: (value: string) => string;
  addPlaceholder: string;
  ariaLabel: string;
  disabled?: boolean;
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
}> = ({ items, locked = [], labelOf, addPlaceholder, ariaLabel, disabled, onAdd, onRemove }) => {
  const [draft, setDraft] = useState('');
  const submit = () => {
    const value = draft.trim();
    if (!value) return;
    onAdd(value);
    setDraft('');
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {locked.map((value) => (
          <span
            key={`locked-${value}`}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-slate-200 bg-slate-100 text-[10px] font-bold text-slate-500"
            title="平台硬禁，不能取消"
          >
            {labelOf ? labelOf(value) : value}
            <span className="text-[9px] font-normal text-slate-400">平台硬禁</span>
          </span>
        ))}
        {items.map((value) => (
          <span
            key={value}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-violet-200 bg-violet-50 text-[10px] font-bold text-violet-700"
          >
            {labelOf ? labelOf(value) : value}
            <button
              type="button"
              aria-label={`删除 ${value}`}
              disabled={disabled}
              onClick={() => onRemove(value)}
              className="text-violet-400 hover:text-violet-600 disabled:opacity-40"
            >
              ×
            </button>
          </span>
        ))}
        {items.length === 0 && locked.length === 0 && (
          <span className="text-[10px] text-slate-400">还没添加</span>
        )}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          aria-label={ariaLabel}
          value={draft}
          disabled={disabled}
          placeholder={addPlaceholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
          className="flex-1 min-w-0 bg-slate-50 border border-slate-200 rounded-xl px-3 py-1.5 text-[11px] text-slate-700"
        />
        <InlineButton onClick={submit} disabled={disabled || draft.trim().length === 0}>
          添加
        </InlineButton>
      </div>
    </div>
  );
};

/** 测试数据横幅：只要界面在跑 fixture，就必须一眼看出来不是真实活动。 */
export const FixtureBanner: React.FC<{ scenario: string }> = ({ scenario }) => (
  <div className="rounded-2xl border border-dashed border-rose-300 bg-rose-50 px-3 py-2 text-[10px] font-bold text-rose-700" role="alert">
    测试数据（fixture: {scenario}）· 不是真实活动，禁止当作验收证据
  </div>
);

/** 加载中的骨架（不用动画库，静态灰条）。 */
export const Skeleton: React.FC<{ rows?: number }> = ({ rows = 3 }) => (
  <div className="space-y-2" aria-hidden="true">
    {Array.from({ length: rows }).map((_, index) => (
      <div key={index} className="h-10 rounded-2xl bg-slate-100" />
    ))}
  </div>
);
