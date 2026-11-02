import React, { useState } from 'react';
import { Sparkle } from '@phosphor-icons/react';
import type { CharacterProfile, UserProfile } from '../../types';
import { cardById, spreadById } from '../../utils/tarotData';
import { requestTarotReading, type TarotLlmApi } from '../../utils/tarotLlm';
import type { TarotReadingRecord } from '../../utils/tarotReading';
import { TarotThumb } from './TarotCards';

interface Props {
  record: TarotReadingRecord;
  /** 解读者：char 目标即 TA 自己；自己目标则为当前活跃角色；拿不到则不显示解读按钮 */
  reader?: CharacterProfile;
  api: TarotLlmApi;
  user: UserProfile;
  addToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
  onRecordChange: (next: TarotReadingRecord) => void;
  onSkyNavigation?: () => void;
  /** 今日运势等牌面已在别处展示时，隐藏逐张牌义与速览，避免重复 */
  hideCardList?: boolean;
}

/** 四角 L 形纹样：hover 时向外舒展，reduced-motion 下不动。 */
const CornerMarks: React.FC = () => (
  <>
    <span className="pointer-events-none absolute left-0 top-0 h-3.5 w-3.5 rounded-tl-[4px] border-l-2 border-t-2 border-[#c9a227]/80 transition-transform duration-300 group-hover:-translate-x-1 group-hover:-translate-y-1 motion-reduce:transform-none motion-reduce:transition-none" />
    <span className="pointer-events-none absolute right-0 top-0 h-3.5 w-3.5 rounded-tr-[4px] border-r-2 border-t-2 border-[#c9a227]/80 transition-transform duration-300 group-hover:translate-x-1 group-hover:-translate-y-1 motion-reduce:transform-none motion-reduce:transition-none" />
    <span className="pointer-events-none absolute bottom-0 left-0 h-3.5 w-3.5 rounded-bl-[4px] border-b-2 border-l-2 border-[#c9a227]/80 transition-transform duration-300 group-hover:-translate-x-1 group-hover:translate-y-1 motion-reduce:transform-none motion-reduce:transition-none" />
    <span className="pointer-events-none absolute bottom-0 right-0 h-3.5 w-3.5 rounded-br-[4px] border-b-2 border-r-2 border-[#c9a227]/80 transition-transform duration-300 group-hover:translate-x-1 group-hover:translate-y-1 motion-reduce:transform-none motion-reduce:transition-none" />
  </>
);

/** 一次占卜的完整解读页：本地速览永远可用，「让 TA 解读」按需调 LLM。 */
export const ReadingView: React.FC<Props> = ({ record, reader, api, user, addToast, onRecordChange, onSkyNavigation, hideCardList = false }) => {
  const [asking, setAsking] = useState(false);
  const spread = spreadById(record.spreadId);
  const summaryLines = record.localSummary.split('\n');
  const rollup = summaryLines.length > 1 ? summaryLines[summaryLines.length - 1] : '';

  const askReader = async () => {
    if (!reader) { addToast('还没有可解读的角色', 'error'); return; }
    if (!api.apiKey) { addToast('请先在设置里配置 API Key', 'error'); return; }
    if (!spread) return;
    onSkyNavigation?.();
    setAsking(true);
    try {
      const text = await requestTarotReading(api, reader, user, {
        querentName: record.targetName,
        question: record.question,
        spread,
        drawn: record.cards.map((c) => {
          const card = cardById(c.cardId)!;
          const pos = spread.positions.find((p) => p.name === c.positionName);
          return {
            card,
            reversed: c.reversed,
            positionName: c.positionName,
            positionMeaning: pos?.meaning ?? '',
          };
        }),
      });
      onRecordChange({ ...record, charReading: text, readerId: reader.id, readerName: reader.name });
    } catch {
      addToast('TA 暂时没回应，稍后再试（本地速览不受影响）', 'error');
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="space-y-4">
      {record.question && (
        <p className="font-serif text-[#f5f0e1]/90 text-sm leading-relaxed border-l-2 border-[#c9a227]/60 pl-3">
          问：{record.question}
        </p>
      )}
      {!hideCardList && (
        <>
          <div className="space-y-3">
            {record.cards.map((c, i) => {
              const card = cardById(c.cardId);
              if (!card) return null;
              const face = c.reversed ? card.reversed : card.upright;
              return (
                <div
                  key={`${c.cardId}-${i}`}
                  className="tarot-reveal flex gap-3 rounded border border-[#8b7355]/30 bg-[#f5f0e1]/[0.06] p-3"
                  style={{ animationDelay: `${Math.min(i * 90, 600)}ms` }}
                >
                  <TarotThumb card={card} reversed={c.reversed} className="w-12 shrink-0 rounded-[4px] ring-1 ring-[#c9a227]/40" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-serif">
                      <span className="text-[11px] text-[#c9a227]">{c.positionName}</span>
                      <span className="text-sm text-[#f5f0e1]">{card.nameCn}</span>
                      <span className={`text-[10px] px-1.5 py-px rounded border ${c.reversed ? 'text-[#e0a080] border-[#e0a080]/40' : 'text-[#a8c69f] border-[#a8c69f]/40'}`}>
                        {c.reversed ? '逆位' : '正位'}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-[#c9a227]/80 font-serif">{face.keywords.join(' · ')}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-[#f5f0e1]/80 font-serif">{face.meaning}</p>
                  </div>
                </div>
              );
            })}
          </div>
          {rollup && (
            <p className="font-serif text-xs leading-relaxed text-[#f5f0e1]/60 px-1">{rollup}</p>
          )}
        </>
      )}
      {record.charReading ? (
        <div className="tarot-reveal">
          <div className="relative flex items-center gap-2 font-serif">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-[#c9a227]/70 bg-[#c9a227]/15 text-xs font-bold text-[#e8c96a]">印</span>
            <span className="text-sm text-[#e8c96a]">{record.readerName ?? 'TA'} 的解读</span>
            <span className="h-px flex-1 bg-gradient-to-r from-[#c9a227]/45 to-transparent" />
            <Sparkle size={12} weight="fill" className="tarot-twinkle text-[#e8c96a]/80" />
          </div>
          <p className="mt-3 whitespace-pre-wrap font-serif text-sm leading-loose text-[#f5f0e1]/95" style={{ textShadow: '0 1px 12px rgba(0,0,0,0.65)' }}>{record.charReading}</p>
        </div>
      ) : (
        reader && (
          <button
            onClick={askReader}
            disabled={asking}
            className="group relative mx-auto block w-[88%] max-w-[420px] px-8 py-3.5 font-serif text-sm tracking-[0.3em] text-[#e8c96a] transition-all active:scale-[0.98] disabled:opacity-60"
            style={{ background: 'linear-gradient(180deg, rgba(24,18,49,0.6) 0%, rgba(24,18,49,0.12) 100%)' }}
          >
            <span
              className="tarot-sheen pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
              style={{ background: 'linear-gradient(100deg, transparent 35%, rgba(232,201,106,0.16) 50%, transparent 65%)', backgroundSize: '250% 100%' }}
            />
            <CornerMarks />
            <span className={`relative inline-flex items-center justify-center gap-3 ${asking ? 'tarot-glow' : ''}`}>
              <span className="text-[10px] text-[#c9a227]/70">◇</span>
              {asking ? `${reader.name} 正在凝视星象…` : `让${reader.name}解读`}
              <span className="text-[10px] text-[#c9a227]/70">◇</span>
            </span>
          </button>
        )
      )}
    </div>
  );
};
