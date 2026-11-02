import React, { useMemo, useState } from 'react';
import { Sparkle } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import { useLayoutMode } from '../../utils/layoutMode';
import { CARDS, type TarotArcana, type TarotCard } from '../../utils/tarotData';
import { TarotThumb } from './TarotCards';

const SUITS: { id: TarotArcana; name: string }[] = [
  { id: 'major', name: '大阿尔卡纳' },
  { id: 'wands', name: '权杖 · 火' },
  { id: 'cups', name: '圣杯 · 水' },
  { id: 'swords', name: '宝剑 · 风' },
  { id: 'pentacles', name: '星币 · 土' },
];

const SectionHead: React.FC<{ title: string; count: string }> = ({ title, count }) => (
  <div className="group flex items-center gap-2">
    <Sparkle size={11} weight="fill" className="text-[#c9a227]/70" />
    <span className="font-serif text-xs tracking-[0.3em] text-[#c9a227]">{title}</span>
    <span className="h-px w-4 bg-[#c9a227]/50 transition-all duration-300 group-hover:w-12" />
    <span className="font-serif text-[10px] text-[#f5f0e1]/40">{count}</span>
  </div>
);

const CardTile: React.FC<{ card: TarotCard; isDesktop: boolean; index: number; onOpen: (c: TarotCard) => void }> = ({ card, isDesktop, index, onOpen }) => (
  <button
    onClick={() => onOpen(card)}
    className="tarot-reveal group relative flex h-full w-full flex-col overflow-hidden rounded-md border border-[#8b7355]/30 bg-[#f5f0e1]/[0.05] text-left transition-all duration-300 active:scale-[0.98] hover:z-10 hover:-translate-y-0.5 hover:border-[#c9a227]/60 hover:shadow-[0_12px_30px_rgba(0,0,0,0.5)]"
    style={{ animationDelay: `${Math.min(index * 18, 320)}ms` }}
  >
    <span className="tarot-sweep pointer-events-none absolute inset-y-0 left-0 z-10 w-1/3 bg-gradient-to-r from-transparent via-[#e8c96a]/20 to-transparent opacity-0" />
    <div className="relative overflow-hidden">
      <TarotThumb card={card} className="w-full grayscale-[25%] transition-all duration-300 group-hover:scale-[1.03] group-hover:grayscale-0" />
      <span className="absolute left-1.5 top-1.5 rounded-[3px] border border-[#c9a227]/50 bg-black/45 px-1 py-px font-serif text-[9px] tracking-widest text-[#e8c96a]/90">
        {String(card.num).padStart(2, '0')}
      </span>
    </div>
    <div className="flex flex-1 flex-col px-2 py-2">
      <p className="truncate font-serif text-xs text-[#f5f0e1] transition-colors group-hover:text-[#e8c96a]">{card.nameCn}</p>
      {isDesktop && <p className="mt-0.5 truncate font-serif text-[10px] italic text-[#f5f0e1]/40">{card.nameEn}</p>}
      <p className="mt-0.5 truncate font-serif text-[10px] text-[#f5f0e1]/50">{card.upright.keywords.join(' · ')}</p>
      {isDesktop && (
        <p className="mt-0.5 truncate font-serif text-[10px] text-[#c9a227]/60">
          {[card.element, card.astrology].filter(Boolean).join(' · ')}
        </p>
      )}
    </div>
  </button>
);

const CardDetail: React.FC<{ card: TarotCard; onBack: () => void }> = ({ card, onBack }) => {
  const [face, setFace] = useState<'upright' | 'reversed'>('upright');
  const f = card[face];
  return (
    <div className="tarot-reveal space-y-4">
      <button onClick={onBack} className="font-serif text-xs tracking-widest text-[#f5f0e1]/60 active:scale-95">← 回牌库</button>
      <div className="relative mx-auto w-60">
        <div
          className="pointer-events-none absolute -inset-8 rounded-full opacity-60"
          style={{ background: 'radial-gradient(circle, rgba(201,162,39,0.22) 0%, transparent 70%)' }}
        />
        <TarotThumb card={card} reversed={face === 'reversed'} eager className="relative w-full rounded-md ring-1 ring-[#c9a227]/50 shadow-[0_14px_30px_rgba(0,0,0,0.5)]" />
      </div>
      <div className="text-center font-serif">
        <p className="text-xl tracking-widest text-[#f5f0e1]">{card.nameCn}</p>
        <p className="mt-0.5 text-xs italic text-[#f5f0e1]/50">{card.nameEn}</p>
        {(card.element || card.astrology) && (
          <p className="mt-1 text-[11px] text-[#c9a227]/80">{[card.element, card.astrology].filter(Boolean).join(' · ')}</p>
        )}
      </div>
      <div className="mx-auto grid w-60 grid-cols-2 gap-2">
        {(['upright', 'reversed'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setFace(k)}
            className={`rounded border py-1.5 font-serif text-xs tracking-widest active:scale-95 ${face === k ? 'border-[#c9a227] bg-[#c9a227]/15 text-[#e8c96a]' : 'border-[#8b7355]/40 text-[#f5f0e1]/60'}`}
          >
            {k === 'upright' ? '正位' : '逆位'}
          </button>
        ))}
      </div>
      <div className="rounded border border-[#8b7355]/30 bg-[#f5f0e1]/[0.05] p-4 font-serif">
        <p className="text-xs tracking-widest text-[#c9a227]">{f.keywords.join(' · ')}</p>
        <p className="mt-2 text-sm leading-loose text-[#f5f0e1]/85">{f.meaning}</p>
      </div>
    </div>
  );
};

export const LibraryView: React.FC<{ onSkyNavigation?: () => void }> = ({ onSkyNavigation }) => {
  const { theme } = useOS();
  const isDesktop = useLayoutMode(theme.desktopMode) === 'desktop';
  const [query, setQuery] = useState('');
  const [suit, setSuit] = useState<TarotArcana | 'all'>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return CARDS.filter((c) => {
      if (suit !== 'all' && c.arcana !== suit) return false;
      if (!q) return true;
      return (
        c.nameCn.includes(query.trim()) ||
        c.nameEn.toLowerCase().includes(q) ||
        c.upright.keywords.some((k) => k.includes(query.trim()))
      );
    });
  }, [query, suit]);

  const openCard = openId ? CARDS.find((c) => c.id === openId) : undefined;
  if (openCard) return <CardDetail card={openCard} onBack={() => { setOpenId(null); onSkyNavigation?.(); }} />;

  const open = (c: TarotCard) => { onSkyNavigation?.(); setOpenId(c.id); };
  const groups = suit === 'all' ? SUITS : SUITS.filter((s) => s.id === suit);

  return (
    <div className={`space-y-5 ${isDesktop ? 'mx-auto w-full max-w-[1180px]' : ''}`}>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜牌名或关键词，如 月亮 / 选择"
        maxLength={20}
        className="w-full rounded border border-[#8b7355]/40 bg-[#f5f0e1]/[0.07] px-3 py-2 font-serif text-sm text-[#f5f0e1] placeholder:text-[#8b7355]/60 focus:outline-none focus:border-[#c9a227]/70"
      />
      <div className="flex gap-2 overflow-x-auto no-scrollbar">
        {[{ id: 'all' as const, name: '全部' }, ...SUITS].map((s) => (
          <button
            key={s.id}
            onClick={() => setSuit(s.id)}
            className={`shrink-0 rounded-full border px-3.5 py-1 font-serif text-xs active:scale-95 ${suit === s.id ? 'border-[#c9a227] bg-[#c9a227]/15 text-[#e8c96a]' : 'border-[#8b7355]/40 text-[#f5f0e1]/60'}`}
          >
            {s.name}
          </button>
        ))}
      </div>
      {filtered.length === 0 && (
        <p className="py-10 text-center font-serif text-sm text-[#f5f0e1]/50">牌堆里没有这张，换个词试试</p>
      )}
      {groups.map((g) => {
        const list = filtered.filter((c) => c.arcana === g.id);
        if (list.length === 0) return null;
        return (
          <section key={g.id}>
            <div className="sticky top-0 z-20 -mx-1 bg-[#141020]/85 px-1 py-2 backdrop-blur-sm">
              <SectionHead title={g.name} count={`${list.length} 张`} />
            </div>
            <div className="pt-2">
              <div className={isDesktop ? 'grid grid-cols-4 gap-3' : 'grid grid-cols-2 gap-3'}>
                {list.map((c, i) => (
                  <CardTile key={c.id} card={c} isDesktop={isDesktop} index={i} onOpen={open} />
                ))}
              </div>
            </div>
          </section>
        );
      })}
      <p className="pt-2 text-center font-serif text-[10px] leading-relaxed text-[#f5f0e1]/30">牌义以 Waite《Pictorial Key to the Tarot》为准转写 · 牌图为 Smith 韦特公有领域版本</p>
    </div>
  );
};
