import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchMossVoicePreview } from '../../utils/genieTts';
import { voiceOptionById, type MossVoiceStatus } from '../../utils/mossTtsStatus';

/**
 * 本机 MOSS-TTS-Nano 音色选择器（设置页全局 / 角色编辑共用）。
 *
 * 硬约束：
 *   - 音色列表**只来自**鉴权主代理 `/agent/v1/tts/health` 的 voiceOptions，前端不硬编码 ID；
 *   - 试听点哪个音色就取哪个音色的约 2 秒参考副本（不是统一 demo:true、不跑模型）；
 *   - 同一时刻只播一段，换音色/卸载时暂停并 revoke objectURL；
 *   - 没有参考音频 / 没有试听片段都明确说明，不静默换别的音色。
 */
export interface MossVoicePickerProps {
  /** '' = 继承全局（角色页）；设置页不使用继承项。 */
  value: string;
  onChange: (id: string) => void;
  status: MossVoiceStatus | null;
  /** 全局音色 ID，用于「继承全局（当前：…）」的说明。 */
  globalVoiceId?: string;
  /**
   * 探活是否成功（null/undefined = 还没探测完）。
   * 用来区分「连不上主代理」和「连上了但服务端没注册音色」——两种空态要用户做的事完全不同。
   */
  reachable?: boolean | null;
  /** 探活失败的原因（人话，不含地址/令牌原值）。 */
  probeError?: string;
  showInherit?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  disabled?: boolean;
  /** 是否显示组件内部的「本机音色」小标题（外层已有标题时关掉，避免重复）。 */
  showLabel?: boolean;
}

type PreviewPhase = 'loading' | 'playing';
interface PreviewState {
  voiceId: string;
  phase: PreviewPhase;
}

export default function MossVoicePicker({
  value,
  onChange,
  status,
  globalVoiceId = '',
  reachable = null,
  probeError = '',
  showInherit = false,
  onRefresh,
  refreshing = false,
  disabled = false,
  showLabel = true,
}: MossVoicePickerProps) {
  const options = status?.voiceOptions ?? [];
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewError, setPreviewError] = useState('');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const stopPreview = useCallback(() => {
    if (audioRef.current) {
      try { audioRef.current.pause(); } catch { /* 忽略停止失败 */ }
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPreview(), [stopPreview]);

  const playPreview = useCallback(async (voiceId: string) => {
    if (!voiceId || disabled) return;
    // 再点同一个正在播/加载的音色 = 停止
    if (preview?.voiceId === voiceId) {
      stopPreview();
      setPreview(null);
      return;
    }
    stopPreview();
    setPreviewError('');
    setPreview({ voiceId, phase: 'loading' });
    try {
      const { url } = await fetchMossVoicePreview(voiceId);
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        stopPreview();
        setPreview(null);
      };
      audio.onerror = () => {
        stopPreview();
        setPreview(null);
        setPreviewError('试听播放失败（浏览器不支持该音频格式）');
      };
      setPreview({ voiceId, phase: 'playing' });
      await audio.play();
    } catch (e) {
      stopPreview();
      setPreview(null);
      setPreviewError(e instanceof Error ? e.message : '试听失败');
    }
  }, [disabled, preview?.voiceId, stopPreview]);

  const inheritLabel = globalVoiceId
    ? (voiceOptionById(status, globalVoiceId)?.label ?? globalVoiceId)
    : '';
  const inheritHint = globalVoiceId
    ? `当前：${inheritLabel}`
    : '当前：服务端默认音色';

  if (options.length === 0) {
    // 三种空态必须分开说，否则用户无法判断该去改地址/令牌、还是去注册参考音频：
    //   1. 还在探测（status 为空）      → 正在检测
    //   2. 探活失败（reachable=false）  → 连不上主代理，给原因 + 重新检测
    //   3. 探活成功但没有音色           → 服务端没注册参考音频（不是网络问题）
    const probing = status === null && reachable === null;
    const unreachable = reachable === false;
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          {showLabel && <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">本机音色</span>}
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing || disabled}
              className="px-2 py-0.5 rounded-lg bg-white border border-slate-200 text-[10px] font-semibold text-slate-600 disabled:opacity-50"
            >
              {refreshing ? '检测中…' : '重新检测'}
            </button>
          )}
        </div>
        <p className="text-[11px] text-slate-500 leading-relaxed">
          {probing
            ? '正在检测本机音色…（读取主代理的音色目录，不跑模型）'
            : unreachable
              ? `读不到本机音色目录：${probeError || '连不上主代理'}。点「重新检测」重试；仍不行就去「设置 → 其他 API → 主代理中转」核对地址与令牌。`
              : '已连上主代理，但服务端还没有注册任何参考音频：把 3-15 秒干净中文 WAV 放到本机音色的参考目录后，点「重新检测」。'}
          {!probing && !unreachable && ' 这一步不会自己编一个音色出来。'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        {showLabel && <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">本机音色</span>}
        <span className="text-[10px] text-slate-400">{options.length} 个已授权音色</span>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing || disabled}
            className="px-2 py-0.5 rounded-lg bg-white border border-slate-200 text-[10px] font-semibold text-slate-600 disabled:opacity-50"
          >
            {refreshing ? '检测中…' : '重新检测'}
          </button>
        )}
      </div>

      <div className="space-y-1.5">
        {showInherit && (
          <label className="flex items-start gap-2 rounded-xl border border-slate-200 bg-white px-2.5 py-2 cursor-pointer">
            <input
              type="radio"
              name="moss-voice"
              value=""
              className="mt-0.5 accent-primary"
              checked={value === ''}
              disabled={disabled}
              onChange={() => onChange('')}
            />
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-slate-700">继承全局音色</span>
              <span className="block text-[10px] text-slate-500">{inheritHint}；以后改全局设置，这个角色跟着变</span>
            </span>
          </label>
        )}

        {options.map((opt) => {
          const playingThis = preview?.voiceId === opt.id;
          return (
            <div
              key={opt.id}
              data-voice-row={opt.id}
              className={`flex items-start gap-2 rounded-xl border px-2.5 py-2 ${value === opt.id ? 'border-primary/40 bg-primary/5' : 'border-slate-200 bg-white'}`}
            >
              <input
                type="radio"
                name="moss-voice"
                value={opt.id}
                className="mt-0.5 accent-primary"
                checked={value === opt.id}
                disabled={disabled}
                onChange={() => onChange(opt.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-semibold text-slate-700 break-words">{opt.label}</span>
                <span className="block text-[10px] text-slate-500 break-words">
                  {opt.origin || '来源未标注'}
                  {!opt.registered && <span className="text-amber-600"> · 未注册参考音频（选中后合成会提示待配置）</span>}
                  {!opt.preview && <span className="text-slate-400"> · 无试听</span>}
                </span>
              </span>
              <button
                type="button"
                disabled={disabled || !opt.preview}
                onClick={() => { void playPreview(opt.id); }}
                title={opt.preview ? '播放该音色约 2 秒的参考副本' : '该音色没有可试听的片段'}
                className="shrink-0 px-2 py-0.5 rounded-lg bg-white border border-slate-200 text-[10px] font-semibold text-slate-600 active:bg-slate-100 disabled:opacity-40"
              >
                {playingThis ? (preview?.phase === 'playing' ? '停止' : '加载中…') : '试听 2 秒'}
              </button>
            </div>
          );
        })}
      </div>

      {previewError && <p className="text-[11px] text-rose-600">{previewError}</p>}
      <p className="text-[10px] text-slate-400 leading-relaxed">
        试听是「音色示例」：从该音色已授权的参考音频裁出的约 2 秒副本，不跑模型，也不代表实际合成质量。
        同一时刻只播一段；参考音频只经鉴权主代理转发，网页端不显示、也拿不到文件路径。
      </p>
    </div>
  );
}
