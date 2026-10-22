import React, { useState } from 'react';
import { useOS } from '../../context/OSContext';
import type { MemoryPalaceFeatureFlags } from '../../types';
import {
  clearConflictingMemoryNegotiationDebugOverrides,
  clearMemoryNegotiationDebugOverrides,
  getMemoryNegotiationGate,
} from '../../utils/memoryNegotiation';

/**
 * 设置 → 记忆协商（全局）。
 *
 * 开关只有一个权威位置：记忆宫殿全局配置的 featureFlags.epistemicState
 * （OSContext.updateMemoryPalaceConfig 落 localStorage，前台纪律与后台提取读同一个值）。
 * 直读 localStorage 只为显示「本机调试值正在压过开关」，不作第二份真相。
 *
 * 说明文案刻意讲清三件事：自然确认、不是问卷、短期状态不升级 —— 这是协商，不是设置项收集。
 */

const STATUS_TINT = {
  on: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  off: 'bg-slate-50 text-slate-500 border-slate-200',
  overridden: 'bg-amber-50 text-amber-700 border-amber-200',
  warn: 'bg-rose-50 text-rose-700 border-rose-200',
} as const;

const SOURCE_TEXT: Record<string, string> = {
  config: '系统设置开关',
  dev_override: '本机调试值',
  legacy_key: '旧版本地调试值',
  config_unreadable: '配置文件读不出来（按关闭处理）',
  default_off: '默认关闭',
};

const MemoryNegotiationSettings: React.FC = () => {
  const { memoryPalaceConfig, updateMemoryPalaceConfig } = useOS();
  // 清掉调试值后 localStorage 变了但 context 没变，用它强制重读一次开关来源。
  const [, setRevision] = useState(0);

  const flags = memoryPalaceConfig?.featureFlags;
  const enabled = flags?.epistemicState === true;
  const gate = getMemoryNegotiationGate();
  const unreadable = gate.source === 'config_unreadable';
  const overridden = gate.source === 'dev_override' || gate.source === 'legacy_key';
  const effective = overridden ? gate.enabled : enabled && !unreadable;
  const tone = unreadable ? 'warn' : overridden ? 'overridden' : effective ? 'on' : 'off';

  const handleToggle = (next: boolean) => {
    const nextFlags: MemoryPalaceFeatureFlags = {
      recallRouter: flags?.recallRouter === true,
      interactionAdaptation: flags?.interactionAdaptation === true,
      deepEngagement: flags?.deepEngagement === true,
      epistemicState: next,
    };
    updateMemoryPalaceConfig({ featureFlags: nextFlags });
    // 与这次选择相反的调试值留着只会让「关了却还开着」，切换时顺手清掉。
    clearConflictingMemoryNegotiationDebugOverrides(next);
    setRevision(revision => revision + 1);
  };

  const handleClearDebug = () => {
    clearMemoryNegotiationDebugOverrides();
    setRevision(revision => revision + 1);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 bg-violet-50 border border-violet-100 rounded-2xl px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-xs font-bold text-slate-700">允许角色自然确认</p>
          <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">
            记忆协商：角色对没把握的事顺口问一句，而不是直接当成事实记住。默认关闭，关闭时聊天行为与升级前一样。
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="记忆协商"
          onClick={() => handleToggle(!enabled)}
          className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${
            enabled ? 'bg-violet-500' : 'bg-slate-200'
          }`}
        >
          <span
            className={`absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
              enabled ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      <div className={`flex items-start gap-2 rounded-2xl border px-3 py-2 text-[10px] leading-relaxed ${STATUS_TINT[tone]}`}>
        <span className="shrink-0 font-bold">记忆协商：{effective ? '已开启' : '已关闭'}</span>
        <span className="opacity-80">
          来源：{SOURCE_TEXT[gate.source] ?? SOURCE_TEXT.default_off}
          {gate.source === 'default_off' ? '（这台设备还没保存过这项配置）' : ''}
        </span>
      </div>

      {unreadable && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-[10px] text-rose-700 leading-relaxed">
          <p className="font-bold">读不到这项配置，按关闭处理</p>
          <p className="mt-0.5 opacity-90">
            记忆宫殿配置这一行读不出来（损坏或版本不兼容），所以不会把残留的旧开关当成「已开启」。
            重新保存一次上面的开关即可写入正式字段。
          </p>
        </div>
      )}

      <ul className="space-y-1.5 rounded-2xl bg-slate-50/70 px-3 py-2.5 text-[10px] text-slate-500 leading-relaxed">
        <li>
          <b className="text-slate-600">自然确认</b>：在正常回复里顺口问一句「你是说……？」，一次只问一件，不为了记住而打断聊天。
        </li>
        <li>
          <b className="text-slate-600">不是问卷</b>：可以拒答、说不想聊、直接换话题；角色会停下，不追问，也不要你填任何东西。
        </li>
        <li>
          <b className="text-slate-600">问过 ≠ 已确认</b>：角色问了不代表你答应了；只有你明确回答的那件事才算确认，含糊、只回一个「嗯」、岔开话题都保持待确认。
        </li>
        <li>
          <b className="text-slate-600">短期不升级</b>：今天累 ≠ 一直累；当下的状态不会被写成性格、偏好或长期结论。
        </li>
      </ul>

      <p className="text-[10px] text-slate-400 leading-relaxed">
        开关写入记忆宫殿的全局实验配置（featureFlags.epistemicState），前台提示词与记忆提取读的是同一个配置字段。
        旧备份没有这个字段时按关闭处理；被记成猜测的内容不会直接落成事实，只留作待确认。
      </p>

      {overridden && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] text-amber-700 leading-relaxed">
          <p className="font-bold">
            检测到本机调试值：当前实际{effective ? '已开启' : '已关闭'}
          </p>
          <p className="mt-0.5 opacity-90">
            {gate.source === 'dev_override'
              ? '本机调试值（mp_negotiation_dev）优先于这里的开关，所以实际状态可能和上面的开关不一致。'
              : '正式配置里还没有这个字段，所以沿用了旧版本地开关（sullyos.memoryNegotiation.v1）。'}
            清除后完全以系统设置为准。
          </p>
          <button
            type="button"
            onClick={handleClearDebug}
            className="mt-1.5 rounded-xl border border-amber-300 bg-white px-2.5 py-1 font-bold text-amber-700 active:scale-95 transition-transform"
          >
            清除调试值
          </button>
        </div>
      )}
    </div>
  );
};

export default MemoryNegotiationSettings;
