import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { APIConfig, CharacterProfile, UserProfile } from '../../types';
import { CARDS, SPREADS, type TarotSpread } from '../../utils/tarotData';
import { drawSpread } from '../../utils/tarotEngine';
import { buildLocalSummary, newReadingId, type ResolvedDrawn, type TarotReadingRecord } from '../../utils/tarotReading';
import { DB } from '../../utils/db';
import { CardBack, FlipCard } from './TarotCards';
import { ReadingView } from './ReadingView';
import { ZodiacRing } from './ZodiacRing';

type Phase = 'setup' | 'shuffling' | 'dealing' | 'revealing' | 'reading';

interface Props {
  characters: CharacterProfile[];
  activeCharacterId: string | null;
  userProfile: UserProfile;
  apiConfig: APIConfig;
  addToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
  dateKey: string;
  onSaved: (record: TarotReadingRecord) => void;
  onSkyNavigation?: () => void;
}

const QUICK_QUESTIONS = ['最近的感情走向', '事业上该注意什么', '这件事该如何选择', '我现在的状态怎么样'];

const cardWidthFor = (count: number): string => {
  if (count <= 1) return '44%';
  if (count <= 3) return '30%';
  if (count <= 5) return '25%';
  if (count <= 6) return '20%';
  if (count <= 7) return '19%';
  return '17%';
};

const TableFelt: React.FC = () => (
  <>
    <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(70% 60% at 50% 45%, rgba(32,62,52,0.55) 0%, rgba(10,14,18,0.15) 70%)' }} />
    <ZodiacRing size={230} durationS={90} reverse glyphColor="rgba(232,201,106,0.75)" className="opacity-25" />
    <div className="tarot-ring-spin pointer-events-none absolute left-1/2 top-1/2 h-60 w-60 -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-[#c9a227]/20" />
    <div className="pointer-events-none absolute left-1/2 top-1/2 h-44 w-44 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#c9a227]/15" />
  </>
);

export const RitualView: React.FC<Props> = ({
  characters, activeCharacterId, userProfile, apiConfig, addToast, dateKey, onSaved, onSkyNavigation,
}) => {
  const [phase, setPhase] = useState<Phase>('setup');
  const [targetId, setTargetId] = useState<string>('user');
  const [question, setQuestion] = useState('');
  const [spreadId, setSpreadId] = useState('three');
  const [drawn, setDrawn] = useState<ResolvedDrawn[]>([]);
  const [flipped, setFlipped] = useState<boolean[]>([]);
  const [record, setRecord] = useState<TarotReadingRecord | null>(null);
  const timers = useRef<number[]>([]);

  const spread: TarotSpread = useMemo(
    () => SPREADS.find((s) => s.id === spreadId) ?? SPREADS[1],
    [spreadId],
  );
  const userName = userProfile?.name?.trim() || '你';
  const targetName = targetId === 'user' ? userName : characters.find((c) => c.id === targetId)?.name ?? 'TA';
  const reader: CharacterProfile | undefined =
    targetId === 'user'
      ? characters.find((c) => c.id === activeCharacterId) ?? characters[0]
      : characters.find((c) => c.id === targetId);

  useEffect(() => () => { timers.current.forEach(clearTimeout); timers.current = []; }, []);
  const later = (ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, ms)); };

  const startShuffle = () => {
    onSkyNavigation?.();
    const picks = drawSpread(CARDS.length, spread.cardCount);
    const resolved: ResolvedDrawn[] = picks.map((p, i) => ({
      card: CARDS[p.cardIndex],
      reversed: p.reversed,
      positionName: spread.positions[i].name,
      positionMeaning: spread.positions[i].meaning,
    }));
    setDrawn(resolved);
    setFlipped(new Array(spread.cardCount).fill(false));
    setRecord(null);
    setPhase('shuffling');
    later(1900, () => setPhase('dealing'));
  };

  useEffect(() => {
    if (phase !== 'dealing') return;
    later(drawn.length * 140 + 700, () => setPhase('revealing'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const flipAll = () => setFlipped(new Array(drawn.length).fill(true));

  const openReading = async () => {
    onSkyNavigation?.();
    const rec: TarotReadingRecord = {
      id: newReadingId(),
      kind: 'spread',
      dateKey,
      targetId,
      targetName,
      spreadId: spread.id,
      question: question.trim() || undefined,
      cards: drawn.map((d) => ({ cardId: d.card.id, reversed: d.reversed, positionName: d.positionName })),
      localSummary: buildLocalSummary(spread, drawn),
      createdAt: Date.now(),
    };
    try {
      await DB.saveTarotReading(rec);
    } catch {
      addToast('记录保存失败，但不影响本次解读', 'error');
    }
    setRecord(rec);
    onSaved(rec);
    setPhase('reading');
  };

  const reset = () => {
    onSkyNavigation?.();
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setPhase('setup');
    setRecord(null);
  };

  // ── setup ──
  if (phase === 'setup') {
    return (
      <div className="space-y-5">
        <section>
          <h3 className="font-serif text-xs tracking-[0.3em] text-[#c9a227]/80">为 谁 而 占</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              onClick={() => setTargetId('user')}
              className={`rounded-full border px-4 py-1.5 font-serif text-sm transition-all active:scale-95 ${targetId === 'user' ? 'border-[#c9a227] bg-[#c9a227]/15 text-[#e8c96a]' : 'border-[#8b7355]/40 text-[#f5f0e1]/70'}`}
            >
              {userName}（自己）
            </button>
            {characters.map((c) => (
              <button
                key={c.id}
                onClick={() => setTargetId(c.id)}
                className={`rounded-full border px-4 py-1.5 font-serif text-sm transition-all active:scale-95 ${targetId === c.id ? 'border-[#c9a227] bg-[#c9a227]/15 text-[#e8c96a]' : 'border-[#8b7355]/40 text-[#f5f0e1]/70'}`}
              >
                {c.name}
              </button>
            ))}
          </div>
        </section>
        <section>
          <h3 className="font-serif text-xs tracking-[0.3em] text-[#c9a227]/80">心 中 所 问</h3>
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="不写也可以，随缘一问"
            maxLength={60}
            className="mt-2 w-full rounded border border-[#8b7355]/40 bg-[#f5f0e1]/[0.07] px-3 py-2 font-serif text-sm text-[#f5f0e1] placeholder:text-[#8b7355]/60 focus:outline-none focus:border-[#c9a227]/70"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {QUICK_QUESTIONS.map((q) => (
              <button
                key={q}
                onClick={() => setQuestion(q)}
                className="rounded-full border border-[#8b7355]/30 px-3 py-1 font-serif text-[11px] text-[#f5f0e1]/60 active:scale-95"
              >
                {q}
              </button>
            ))}
          </div>
        </section>
        <section>
          <h3 className="font-serif text-xs tracking-[0.3em] text-[#c9a227]/80">选 择 牌 阵</h3>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {SPREADS.filter((s) => s.id !== 'daily').map((s) => (
              <button
                key={s.id}
                onClick={() => setSpreadId(s.id)}
                className={`rounded border p-3 text-left transition-all active:scale-[0.98] ${spreadId === s.id ? 'border-[#c9a227]/70 bg-[#c9a227]/10' : 'border-[#8b7355]/30 bg-[#f5f0e1]/[0.04]'}`}
              >
                <div className="flex items-baseline justify-between font-serif">
                  <span className="text-sm text-[#f5f0e1]">{s.nameCn}</span>
                  <span className="text-[10px] text-[#c9a227]/80">{s.cardCount} 张 · {s.level}</span>
                </div>
                <p className="mt-1 font-serif text-[11px] leading-relaxed text-[#f5f0e1]/55">{s.bestFor}</p>
              </button>
            ))}
          </div>
        </section>
        <button
          onClick={startShuffle}
          className="w-full rounded border border-[#c9a227]/70 bg-gradient-to-b from-[#c9a227]/25 to-[#c9a227]/10 py-3 font-serif text-sm tracking-[0.4em] text-[#e8c96a] transition-all active:scale-[0.98]"
        >
          开 始 洗 牌
        </button>
      </div>
    );
  }

  // ── shuffling ──
  if (phase === 'shuffling') {
    return (
      <div className="flex h-[380px] flex-col items-center justify-center" onClick={() => { onSkyNavigation?.(); setPhase('dealing'); }}>
        <div className="relative h-44 w-28">
          <div className="tarot-aura pointer-events-none absolute -inset-12 rounded-full" style={{ background: 'radial-gradient(circle, rgba(201,162,39,0.30) 0%, transparent 70%)' }} />
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="tarot-shuffle absolute inset-0" style={{ animationDelay: `${i * 130}ms` }}>
              <CardBack className="h-full w-full rounded-[6px] ring-1 ring-[#c9a227]/50" />
            </div>
          ))}
          {Array.from({ length: 10 }).map((_, i) => (
            <span
              key={`spark-${i}`}
              className="tarot-spark pointer-events-none absolute h-1 w-1 rounded-full bg-[#e8c96a]"
              style={{
                left: `${10 + (i % 5) * 20}%`,
                top: `${70 - Math.floor(i / 5) * 18}%`,
                animationDelay: `${i * 240}ms`,
                boxShadow: '0 0 6px rgba(232,201,106,0.9)',
              }}
            />
          ))}
        </div>
        <p className="mt-6 font-serif text-sm tracking-[0.3em] text-[#f5f0e1]/70">洗牌中…轻点可跳过</p>
        <p className="mt-1 font-serif text-[11px] text-[#f5f0e1]/40">为「{targetName}」· {spread.nameCn}</p>
      </div>
    );
  }

  // ── dealing ──
  if (phase === 'dealing') {
    return (
        <div className="relative h-[460px] overflow-hidden rounded-md border border-[#c9a227]/20 bg-[#0f231d]">
        <TableFelt />
        {spread.positions.map((p, i) => (
          <div
            key={i}
            className="tarot-deal absolute"
            style={{
              left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: cardWidthFor(spread.cardCount),
              transform: 'translate(-50%, -50%)', animationDelay: `${i * 140}ms`,
            }}
          >
            <CardBack className="w-full rounded-[6px] ring-1 ring-[#c9a227]/50" />
          </div>
        ))}
        <p className="absolute bottom-2 w-full text-center font-serif text-[11px] tracking-[0.3em] text-[#f5f0e1]/50">发牌中</p>
      </div>
    );
  }

  // ── revealing ──
  if (phase === 'revealing') {
    const flippedCount = flipped.filter(Boolean).length;
    const allFlipped = flippedCount === drawn.length;
    return (
      <div className="space-y-3">
      <div className="relative h-[460px] overflow-hidden rounded-md border border-[#c9a227]/20 bg-[#0f231d]">
          <TableFelt />
          {drawn.map((d, i) => (
            <div
              key={i}
              className={`absolute ${flipped[i] ? 'tarot-lit' : ''}`}
              style={{
                left: `${spread.positions[i].x * 100}%`, top: `${spread.positions[i].y * 100}%`,
                width: cardWidthFor(spread.cardCount),
                transform: `translate(-50%, -50%)${spread.positions[i].crossed ? ' rotate(90deg)' : ''}`,
              }}
            >
              <FlipCard
                card={d.card}
                reversed={d.reversed}
                flipped={flipped[i]}
                onFlip={flipped[i] ? undefined : () => setFlipped((f) => f.map((v, j) => (j === i ? true : v)))}
                width="100%"
              />
              <p className="mt-1 text-center font-serif text-[10px] text-[#e8c96a]/80">
                {flipped[i] ? `${d.card.nameCn}${d.reversed ? ' · 逆' : ''}` : spread.positions[i].name}
              </p>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <p className="font-serif text-xs text-[#f5f0e1]/60">已翻开 {flippedCount}/{drawn.length}</p>
          <div className="flex-1" />
          {!allFlipped && (
            <button onClick={flipAll} className="rounded border border-[#8b7355]/40 px-3 py-1.5 font-serif text-xs text-[#f5f0e1]/70 active:scale-95">
              全部翻开
            </button>
          )}
          <button
            onClick={openReading}
            disabled={!allFlipped}
            className="rounded border border-[#c9a227]/70 bg-[#c9a227]/15 px-4 py-1.5 font-serif text-xs tracking-widest text-[#e8c96a] active:scale-95 disabled:opacity-40"
          >
            查看解读
          </button>
        </div>
      </div>
    );
  }

  // ── reading ──
  return (
    <div className="space-y-4">
      {record && (
        <ReadingView
          record={record}
          reader={reader}
          api={{ baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model }}
          user={userProfile}
          addToast={addToast}
          onSkyNavigation={onSkyNavigation}
          onRecordChange={async (next) => {
            setRecord(next);
            try { await DB.saveTarotReading(next); } catch { /* 展示优先，落库失败不打断 */ }
            onSaved(next);
          }}
        />
      )}
      <button
        onClick={reset}
        className="w-full rounded border border-[#8b7355]/40 py-2.5 font-serif text-sm tracking-[0.4em] text-[#f5f0e1]/70 active:scale-[0.98]"
      >
        再 占 一 次
      </button>
    </div>
  );
};
