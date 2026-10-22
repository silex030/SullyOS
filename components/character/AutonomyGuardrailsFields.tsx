import React, { useEffect, useState } from 'react';
import { WarningCircle } from '@phosphor-icons/react';
import { AUTONOMY_GUARDRAIL_CEILINGS } from '../../utils/airp/autonomyGuardrails';
import { parseGuardrailInput, type GuardrailParseResult } from '../../utils/airp/autonomyGuardrailsClient';

/**
 * 护栏数字输入的唯一控件（角色面板与系统设置共用一份形态）。
 *
 * 语义（与 utils/airp/autonomyGuardrailsClient.parseGuardrailInput 同源）：
 *   - 失焦 / 回车才提交，逐字提交会把用户的手指顶回去；
 *   - 非整数 / 超范围 → **不写盘**，输入框标红 + 下方一句话说明；
 *   - 0 在允许的字段里是合法值（暂停 / 不限），绝不静默夹成 1；
 *   - 清空 → invalid（「跟随默认」用显式按钮表达，不用空串猜）。
 *
 * 视觉沿用 AutonomyPanel 既有的白底 + violet 描边小输入框（不新造控件语言）。
 */

export interface GuardrailNumberInputProps {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  /** 无障碍标签（读屏用；界面上由外层 Row 的标题承担）。 */
  ariaLabel: string;
  onCommit: (next: number) => void;
}

export const GuardrailNumberInput: React.FC<GuardrailNumberInputProps> = ({
  value,
  min,
  max,
  disabled,
  ariaLabel,
  onCommit,
}) => {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(String(value));
    setError(null);
  }, [value]);

  const describe = (parsed: GuardrailParseResult): string => {
    if (parsed.kind === 'empty') return '不能为空';
    if (parsed.kind === 'invalid') {
      if (parsed.reason === 'integer') return `要整数（${min}–${max}）`;
      if (parsed.reason === 'range') return `范围 ${min}–${max}`;
      return '只填数字';
    }
    return '';
  };

  const commit = () => {
    const parsed = parseGuardrailInput(draft, min, max);
    if (parsed.kind !== 'set') {
      setError(describe(parsed));
      return;
    }
    setError(null);
    setDraft(String(parsed.value));
    if (parsed.value !== value) onCommit(parsed.value);
  };

  return (
    <div className="shrink-0 flex flex-col items-end gap-0.5">
      <input
        type="text"
        inputMode="numeric"
        aria-label={ariaLabel}
        aria-invalid={error !== null}
        value={draft}
        disabled={disabled}
        onChange={(e) => {
          setDraft(e.target.value);
          if (error) setError(null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') {
            setDraft(String(value));
            setError(null);
          }
        }}
        className={`w-16 bg-white border rounded-xl px-2 py-1.5 text-sm text-center font-bold outline-none transition-colors ${
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

/** 角色面板里的三个护栏数字（外壳 / 分组标题由宿主给）。 */
export interface CharGuardrailFormValue {
  maxRunsPerDay: number;
  sameKindMinGapHours: number;
  reserveTokensPerRun: number;
}

export type CharGuardrailFormKey = keyof CharGuardrailFormValue;

const ROWS: readonly {
  key: CharGuardrailFormKey;
  label: string;
  hint: string;
  min: number;
  max: number;
}[] = [
  {
    key: 'maxRunsPerDay',
    label: '每天最多几次',
    hint: '0 = 暂停这个角色的自主生活',
    min: 0,
    max: AUTONOMY_GUARDRAIL_CEILINGS.perCharPerDay,
  },
  {
    key: 'sameKindMinGapHours',
    label: '同类动作最少隔多久',
    hint: '小时；同类（冲浪 / 打游戏 / 记笔记…）两次之间至少隔这么久。0 = 不限',
    min: 0,
    max: Math.round(AUTONOMY_GUARDRAIL_CEILINGS.sameKindMinGapMinutes / 60),
  },
  {
    key: 'reserveTokensPerRun',
    label: '每次预留 token',
    hint: '每次执行前先占住的预算，结算时按实际用量改账；超出当天预算就不再生成',
    min: 1,
    max: AUTONOMY_GUARDRAIL_CEILINGS.reserveTokensPerRun,
  },
];

export const AutonomyGuardrailsFields: React.FC<{
  value: CharGuardrailFormValue;
  disabled?: boolean;
  onCommit: (key: CharGuardrailFormKey, next: number) => void;
}> = ({ value, disabled, onCommit }) => (
  <>
    {ROWS.map((row) => (
      <div key={row.key} className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-bold text-slate-700">{row.label}</div>
          <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">{row.hint}</p>
        </div>
        <div className="shrink-0">
          <GuardrailNumberInput
            ariaLabel={row.label}
            value={value[row.key]}
            min={row.min}
            max={row.max}
            disabled={disabled}
            onCommit={(next) => onCommit(row.key, next)}
          />
        </div>
      </div>
    ))}
  </>
);

/** 0 值 / 暂停 的醒目提示（角色面板与全局块共用）。 */
export const GuardrailPauseNote: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex gap-2 bg-amber-50 border border-amber-200 rounded-2xl px-3 py-2">
    <WarningCircle size={14} weight="bold" className="text-amber-500 shrink-0 mt-0.5" />
    <p className="text-[10px] text-amber-700 leading-relaxed">{children}</p>
  </div>
);

export default AutonomyGuardrailsFields;
