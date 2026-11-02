import React, { useCallback, useEffect, useState } from 'react';
import { Books, CaretLeft, Scroll, Sparkle, Sun } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { useLocalDateKey } from '../hooks/useLocalDateKey';
import { CARDS, cardById, spreadById } from '../utils/tarotData';
import { drawDailyCard } from '../utils/tarotEngine';
import { buildLocalSummary, newReadingId, type TarotReadingRecord } from '../utils/tarotReading';
import { DB } from '../utils/db';
import { resolveNavigationPose } from '../utils/tarotSky';
import ConfirmDialog from '../components/os/ConfirmDialog';
import { TarotThumb } from './tarot/TarotCards';
import { TarotDomeCanvas } from './tarot/TarotDomeCanvas';
import { TarotSkyShader } from './tarot/TarotSkyShader';
import { TarotBokeh } from './tarot/TarotBokeh';
import { ZodiacRing } from './tarot/ZodiacRing';
import { RitualView } from './tarot/RitualView';
import { LibraryView } from './tarot/LibraryView';
import { ReadingView } from './tarot/ReadingView';

const TAROT_CSS = `
.tarot-flip-inner { transform-style: preserve-3d; transition: transform .65s cubic-bezier(.25,.8,.3,1.1); }
.tarot-flip-face { backface-visibility: hidden; -webkit-backface-visibility: hidden; }
@keyframes tarotShuffle { 0%,100% { transform: translate(0,0) rotate(0deg); } 25% { transform: translate(-10px,-6px) rotate(-6deg); } 50% { transform: translate(8px,4px) rotate(5deg); } 75% { transform: translate(-6px,6px) rotate(-3deg); } }
.tarot-shuffle { animation: tarotShuffle .65s ease-in-out infinite; }
@keyframes tarotDealIn { from { opacity: 0; transform: translate(-50%,-50%) scale(.35); } to { opacity: 1; transform: translate(-50%,-50%) scale(1); } }
.tarot-deal { opacity: 0; animation: tarotDealIn .55s cubic-bezier(.2,.8,.3,1.1) forwards; }
@keyframes tarotRevealUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
.tarot-reveal { opacity: 0; animation: tarotRevealUp .5s ease-out forwards; }
@keyframes tarotGlow { 0%,100% { opacity: .45; } 50% { opacity: .85; } }
.tarot-glow { animation: tarotGlow 4s ease-in-out infinite; }
@keyframes tarotTwinkle { 0%,100% { opacity: .25; transform: scale(.85); } 50% { opacity: .9; transform: scale(1.1); } }
.tarot-twinkle { animation: tarotTwinkle 2.8s ease-in-out infinite; }
@keyframes tarotDrift { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(14px,-10px) scale(1.08); } }
.tarot-drift { animation: tarotDrift 60s ease-in-out infinite; }
@keyframes tarotAurora { 0%,100% { transform: translate(0,0) scale(1); opacity: .7; } 50% { transform: translate(12%,8%) scale(1.16); opacity: 1; } }
.tarot-aurora { animation: tarotAurora 34s ease-in-out infinite; }
@keyframes tarotCurtain { 0% { transform: translateX(-14%) skewX(-9deg) scaleY(.94); opacity: .55; } 100% { transform: translateX(12%) skewX(-3deg) scaleY(1.1); opacity: .95; } }
.tarot-curtain { animation: tarotCurtain 18s ease-in-out infinite alternate; }
.tarot-curtain-rev { animation: tarotCurtain 26s ease-in-out infinite alternate-reverse; }
@keyframes tarotBand { 0% { transform: translateX(-12%) rotate(-2deg) scaleY(1); opacity: .55; } 50% { opacity: .9; } 100% { transform: translateX(10%) rotate(1deg) scaleY(1.14); opacity: .65; } }
.tarot-band { animation: tarotBand 30s ease-in-out infinite alternate; }
@keyframes tarotSheen { from { background-position-x: 120%; } to { background-position-x: -30%; } }
.group:hover .tarot-sheen { animation: tarotSheen .85s ease-out; }
@keyframes tarotSweep { from { transform: translateX(0) skewX(-12deg); opacity: 0; } 15% { opacity: 1; } to { transform: translateX(420%) skewX(-12deg); opacity: 0; } }
.group:hover .tarot-sweep { animation: tarotSweep .7s ease-out; }
@keyframes tarotAuraPulse { 0%,100% { opacity: .35; transform: scale(.92); } 50% { opacity: .8; transform: scale(1.06); } }
.tarot-aura { animation: tarotAuraPulse 2.6s ease-in-out infinite; }
@keyframes tarotSpark { 0% { opacity: 0; transform: translateY(8px) scale(.6); } 30% { opacity: .9; } 100% { opacity: 0; transform: translateY(-46px) scale(1); } }
.tarot-spark { animation: tarotSpark 2.4s ease-out infinite; }
@keyframes tarotLit { 0% { filter: drop-shadow(0 0 0 rgba(232,201,106,0)); } 40% { filter: drop-shadow(0 0 16px rgba(232,201,106,.6)); } 100% { filter: drop-shadow(0 0 7px rgba(232,201,106,.22)); } }
.tarot-lit { animation: tarotLit .65s ease-out forwards; }
@keyframes tarotSpin { from { transform: translate(-50%,-50%) rotate(0deg); } to { transform: translate(-50%,-50%) rotate(360deg); } }
.tarot-ring-spin { animation: tarotSpin 80s linear infinite; }
@media (prefers-reduced-motion: reduce) {
  .tarot-shuffle, .tarot-deal, .tarot-reveal, .tarot-glow, .tarot-twinkle, .tarot-drift, .tarot-aura, .tarot-aurora, .tarot-curtain, .tarot-curtain-rev, .tarot-band { animation: none !important; opacity: 1 !important; }
  .tarot-spark { animation: none !important; opacity: 0 !important; }
  .tarot-sweep { animation: none !important; opacity: 0 !important; }
  .tarot-sheen { animation: none !important; opacity: 0 !important; }
  .tarot-sky-attitude { transition: none !important; }
  .tarot-lit, .tarot-ring-spin { animation: none !important; }
  .tarot-flip-inner { transition: none; }
}
`;

const supportsWebGL = (): boolean => {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
};

type Tab = 'daily' | 'ritual' | 'library' | 'history';

const TABS: { id: Tab; name: string; Icon: typeof Sun }[] = [
  { id: 'daily', name: '今日', Icon: Sun },
  { id: 'ritual', name: '占卜', Icon: Sparkle },
  { id: 'library', name: '牌库', Icon: Books },
  { id: 'history', name: '记录', Icon: Scroll },
];

const DailyView: React.FC<{
  records: TarotReadingRecord[];
  recordsLoaded: boolean;
  refresh: () => void;
  onSkyNavigation: () => void;
}> = ({ records, recordsLoaded, refresh, onSkyNavigation }) => {
  const { characters, activeCharacterId, userProfile, apiConfig, addToast } = useOS();
  const dateKey = useLocalDateKey();
  const [targetId, setTargetId] = useState('user');
  const [record, setRecord] = useState<TarotReadingRecord | null>(null);
  // 同一天同一目标只建一次：首轮库读完之前不建；建过/删过的 key 当天不再自动重建。
  const createdRef = React.useRef<string | null>(null);
  const tombstoneRef = React.useRef<Set<string>>(new Set());
  const [tombstoneTick, setTombstoneTick] = useState(0);

  const userName = userProfile?.name?.trim() || '你';
  const targetName = targetId === 'user' ? userName : characters.find((c) => c.id === targetId)?.name ?? 'TA';
  const reader =
    targetId === 'user'
      ? characters.find((c) => c.id === activeCharacterId) ?? characters[0]
      : characters.find((c) => c.id === targetId);

  useEffect(() => {
    if (!recordsLoaded) return;
    const key = `${dateKey}|${targetId}`;
    let cancelled = false;
    const ensure = async () => {
      const existing = records.find((r) => r.kind === 'daily' && r.dateKey === dateKey && r.targetId === targetId);
      if (existing) {
        createdRef.current = key;
        if (!cancelled) setRecord(existing);
        return;
      }
      // 之前有展示记录、现在库里没了 = 用户在记录页删掉了，当天不再自动重建。
      if (record && record.dateKey === dateKey && record.targetId === targetId) {
        tombstoneRef.current.add(key);
        if (!cancelled) {
          setRecord(null);
          setTombstoneTick((t) => t + 1);
        }
        return;
      }
      if (tombstoneRef.current.has(key)) {
        if (!cancelled) setRecord(null);
        return;
      }
      // 同一 key 只建一次：防 StrictMode 双跑与 refresh 回流重跑。
      if (createdRef.current === key) return;
      createdRef.current = key;
      const pick = drawDailyCard(dateKey, targetId, CARDS.length);
      const card = CARDS[pick.cardIndex];
      const spread = spreadById('daily')!;
      const rec: TarotReadingRecord = {
        id: newReadingId(),
        kind: 'daily',
        dateKey,
        targetId,
        targetName,
        spreadId: 'daily',
        cards: [{ cardId: card.id, reversed: pick.reversed, positionName: '今日运势' }],
        localSummary: buildLocalSummary(spread, [{
          card, reversed: pick.reversed, positionName: '今日运势', positionMeaning: spread.positions[0].meaning,
        }]),
        createdAt: Date.now(),
      };
      try {
        await DB.saveTarotReading(rec);
        refresh();
      } catch { /* 展示优先 */ }
      if (!cancelled) setRecord(rec);
    };
    ensure();
    return () => { cancelled = true; };
    // recordsLoaded 守住首轮空数组误建；tombstoneTick 让删除后停在空态不重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateKey, targetId, records, recordsLoaded, tombstoneTick]);

  const dailyKey = `${dateKey}|${targetId}`;
  const isTombstoned = tombstoneRef.current.has(dailyKey);
  if (!recordsLoaded || (!record && !isTombstoned) || (record && (record.dateKey !== dateKey || record.targetId !== targetId))) {
    return <p className="py-16 text-center font-serif text-sm text-[#f5f0e1]/50">正在为{targetName}取今日之牌…</p>;
  }
  if (!record) {
    return (
      <div className="space-y-4 py-16 text-center">
        <p className="font-serif text-sm text-[#f5f0e1]/55">今日记录已删除</p>
        <button
          onClick={() => { tombstoneRef.current.delete(dailyKey); createdRef.current = null; setTombstoneTick((t) => t + 1); }}
          className="rounded-full border border-[#c9a227]/60 px-5 py-1.5 font-serif text-sm text-[#e8c96a] active:scale-95"
        >
          重新抽今日之牌
        </button>
      </div>
    );
  }
  const saved = record.cards[0];
  const card = cardById(saved.cardId);
  if (!card) return null;
  const [mm, dd] = dateKey.split('-').slice(1);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setTargetId('user')}
          className={`rounded-full border px-4 py-1.5 font-serif text-sm active:scale-95 ${targetId === 'user' ? 'border-[#c9a227] bg-[#c9a227]/15 text-[#e8c96a]' : 'border-[#8b7355]/40 text-[#f5f0e1]/70'}`}
        >
          {userName}
        </button>
        {characters.map((c) => (
          <button
            key={c.id}
            onClick={() => setTargetId(c.id)}
            className={`rounded-full border px-4 py-1.5 font-serif text-sm active:scale-95 ${targetId === c.id ? 'border-[#c9a227] bg-[#c9a227]/15 text-[#e8c96a]' : 'border-[#8b7355]/40 text-[#f5f0e1]/70'}`}
          >
            {c.name}
          </button>
        ))}
      </div>
      <div className="tarot-reveal relative text-center">
        <p className="font-serif text-[11px] tracking-[0.35em] text-[#c9a227]/80">{mm} 月 {dd} 日 · {targetName}的运势</p>
        <div className="relative mx-auto mt-4 w-40">
          <div className="pointer-events-none absolute -inset-7 rounded-full opacity-50" style={{ background: 'radial-gradient(circle, rgba(232,201,106,0.16) 0%, transparent 70%)' }} />
          <TarotThumb card={card} reversed={saved.reversed} eager className="relative w-full rounded-[6px] ring-1 ring-[#c9a227]/40 shadow-[0_10px_26px_rgba(0,0,0,0.55)]" />
        </div>
        <p className="mt-4 font-serif text-lg tracking-widest text-[#f5f0e1]" style={{ textShadow: '0 1px 12px rgba(0,0,0,0.55)' }}>
          {card.nameCn}
          <span className={`ml-2 align-middle text-[10px] tracking-normal px-1.5 py-px rounded border ${saved.reversed ? 'text-[#e0a080] border-[#e0a080]/40' : 'text-[#a8c69f] border-[#a8c69f]/40'}`}>
            {saved.reversed ? '逆位' : '正位'}
          </span>
        </p>
        <p className="mt-1 font-serif text-xs text-[#c9a227]/85">{(saved.reversed ? card.reversed : card.upright).keywords.join(' · ')}</p>
        <p className="mx-auto mt-2 max-w-[26rem] font-serif text-sm leading-loose text-[#f5f0e1]/85" style={{ textShadow: '0 1px 10px rgba(0,0,0,0.5)' }}>{(saved.reversed ? card.reversed : card.upright).meaning}</p>
      </div>
      <ReadingView
        record={record}
        reader={reader}
        api={{ baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model }}
        user={userProfile}
        addToast={addToast}
        hideCardList
        onSkyNavigation={onSkyNavigation}
        onRecordChange={async (next) => {
          setRecord(next);
          try { await DB.saveTarotReading(next); } catch { /* 展示优先 */ }
          refresh();
        }}
      />
    </div>
  );
};

const HistoryView: React.FC<{
  records: TarotReadingRecord[];
  refresh: () => void;
  onSkyNavigation: () => void;
}> = ({ records, refresh, onSkyNavigation }) => {
  const { characters, activeCharacterId, userProfile, apiConfig, addToast } = useOS();
  const [openId, setOpenId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const remove = async (id: string) => {
    try {
      await DB.deleteTarotReading(id);
      if (openId === id) setOpenId(null);
      refresh();
    } catch {
      addToast('删除失败', 'error');
    }
  };

  if (records.length === 0) {
    return (
      <div className="py-16 text-center">
        <p className="font-serif text-sm text-[#f5f0e1]/55">还没有占卜记录</p>
        <p className="mt-1 font-serif text-xs text-[#f5f0e1]/35">去「占卜」抽第一组牌，或看看「今日」运势</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ConfirmDialog
        isOpen={pendingDeleteId != null}
        title="删除记录"
        message="删掉这次占卜记录？"
        variant="danger"
        confirmText="删除"
        onConfirm={() => { if (pendingDeleteId != null) remove(pendingDeleteId); setPendingDeleteId(null); }}
        onCancel={() => setPendingDeleteId(null)}
      />
      {records.map((r) => {
        const spread = spreadById(r.spreadId);
        const open = openId === r.id;
        const reader =
          r.targetId === 'user'
            ? characters.find((c) => c.id === activeCharacterId) ?? characters[0]
            : characters.find((c) => c.id === r.targetId);
        return (
          <div key={r.id} className="overflow-hidden rounded border border-[#8b7355]/30 bg-[#f5f0e1]/[0.045]">
            <button onClick={() => { setOpenId(open ? null : r.id); onSkyNavigation(); }} className="w-full p-3 text-left active:bg-[#f5f0e1]/[0.03]">
              <div className="flex items-center gap-2 font-serif">
                <span className={`shrink-0 rounded border px-1.5 py-px text-[10px] ${r.kind === 'daily' ? 'border-[#c9a227]/50 text-[#e8c96a]' : 'border-[#8b7355]/50 text-[#f5f0e1]/60'}`}>
                  {r.kind === 'daily' ? '每日' : '牌阵'}
                </span>
                <span className="truncate text-sm text-[#f5f0e1]">{r.question || spread?.nameCn || '占卜'}</span>
                <span className="ml-auto shrink-0 text-[10px] text-[#f5f0e1]/40">{r.dateKey.slice(5)} · {r.targetName}</span>
              </div>
              <div className="mt-2 flex gap-1.5">
                {r.cards.slice(0, 7).map((c, i) => {
                  const card = cardById(c.cardId);
                  return card ? (
                    <TarotThumb key={i} card={card} reversed={c.reversed} className="w-8 rounded-[3px] ring-1 ring-[#c9a227]/30" />
                  ) : null;
                })}
                {r.cards.length > 7 && <span className="self-center font-serif text-[10px] text-[#f5f0e1]/40">+{r.cards.length - 7}</span>}
              </div>
            </button>
            {open && (
              <div className="border-t border-[#8b7355]/25 p-3 animate-fade-soft">
                <ReadingView
                  record={r}
                  reader={reader}
                  api={{ baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model }}
                  user={userProfile}
                  addToast={addToast}
                  onSkyNavigation={onSkyNavigation}
                  onRecordChange={async (next) => {
                    try { await DB.saveTarotReading(next); } catch { /* 展示优先 */ }
                    refresh();
                  }}
                />
                <button
                  onClick={() => setPendingDeleteId(r.id)}
                  className="mt-3 w-full rounded border border-[#8b1a1a]/50 py-1.5 font-serif text-xs text-[#e08080]/80 active:scale-[0.98]"
                >
                  删除这条记录
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export const TarotApp: React.FC = () => {
  const { closeApp, characters, activeCharacterId, userProfile, apiConfig, addToast } = useOS();
  const [tab, setTab] = useState<Tab>('daily');
  const [navigationSignal, setNavigationSignal] = useState(0);
  const signalSkyNavigation = useCallback(() => setNavigationSignal((current) => (current + 1) % 8), []);
  const [records, setRecords] = useState<TarotReadingRecord[]>([]);
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  const [skyOff, setSkyOff] = useState(() => !supportsWebGL());
  const todayKey = useLocalDateKey();
  const navigationPose = resolveNavigationPose(navigationSignal);

  const refresh = useCallback(async () => {
    try {
      const list = await DB.getTarotReadings();
      setRecords(list.sort((a, b) => b.createdAt - a.createdAt).slice(0, 200));
    } catch {
      setRecords([]);
    } finally {
      setRecordsLoaded(true);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div
      className="relative flex h-full w-full flex-col overflow-hidden font-serif"
      style={{ background: 'radial-gradient(130% 100% at 50% 0%, #2b2249 0%, #1a1428 45%, #0b0914 100%)' }}
    >
      <style>{TAROT_CSS}</style>
      <div
        className="tarot-sky-attitude pointer-events-none absolute inset-0"
        style={{ transform: `rotate(${navigationPose.roll}rad)`, transition: 'transform 1.6s cubic-bezier(.22,.8,.24,1)' }}
      >
        <div className="tarot-glow absolute -top-24 left-1/2 h-64 w-64 -translate-x-1/2 rounded-full" style={{ background: 'radial-gradient(circle, rgba(201,162,39,0.26) 0%, transparent 70%)' }} />
        <div className="tarot-drift absolute -left-20 top-1/3 h-64 w-64 rounded-full" style={{ background: 'radial-gradient(circle, rgba(92,70,160,0.26) 0%, transparent 70%)', animationDelay: '-30s' }} />
        <div className="tarot-drift absolute -right-16 bottom-10 h-72 w-72 rounded-full" style={{ background: 'radial-gradient(circle, rgba(92,70,160,0.2) 0%, transparent 70%)', animationDelay: '-14s' }} />
      </div>
      <div
        className="tarot-sky-attitude pointer-events-none absolute inset-0 overflow-hidden"
        style={{ transform: `rotate(${navigationPose.roll * 0.55}rad)`, transition: 'transform 1.6s cubic-bezier(.22,.8,.24,1)' }}
      >
        <div className="tarot-aurora absolute -left-[18%] -top-[12%] h-[52%] w-[86%] rounded-full" style={{ background: 'radial-gradient(circle, rgba(122,92,205,0.30) 0%, transparent 70%)', filter: 'blur(48px)' }} />
        <div className="tarot-aurora absolute -right-[22%] -top-[6%] h-[46%] w-[80%] rounded-full" style={{ background: 'radial-gradient(circle, rgba(74,160,140,0.22) 0%, transparent 70%)', filter: 'blur(54px)', animationDelay: '-14s', animationDirection: 'reverse', animationDuration: '42s' }} />
        <div className="tarot-aurora absolute -top-[4%] left-[8%] h-[30%] w-[70%] rounded-full" style={{ background: 'radial-gradient(circle, rgba(232,201,106,0.14) 0%, transparent 70%)', filter: 'blur(40px)', animationDelay: '-8s', animationDuration: '26s' }} />
        <div style={{ opacity: skyOff ? 1 : 0, transition: 'opacity .8s ease' }}>
          <div
            className="tarot-curtain absolute -left-[40%] -top-[10%] h-[120%] w-[180%]"
            style={{
              background: 'repeating-linear-gradient(90deg, rgba(122,92,205,0.22) 0px, transparent 52px, rgba(74,160,140,0.17) 110px, transparent 168px, rgba(232,201,106,0.08) 216px, transparent 268px, rgba(122,92,205,0.22) 320px)',
              backgroundSize: '320px 100%',
              WebkitMaskImage: 'linear-gradient(180deg, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.5) 50%, rgba(0,0,0,0.22) 82%, rgba(0,0,0,0.05) 100%)',
              maskImage: 'linear-gradient(180deg, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.5) 50%, rgba(0,0,0,0.22) 82%, rgba(0,0,0,0.05) 100%)',
              filter: 'blur(12px)',
              mixBlendMode: 'screen',
            }}
          />
          <div
            className="tarot-curtain-rev absolute -left-[40%] -top-[8%] h-[116%] w-[180%]"
            style={{
              background: 'repeating-linear-gradient(90deg, rgba(74,160,140,0.19) 0px, transparent 48px, rgba(122,92,205,0.16) 100px, transparent 156px, rgba(232,201,106,0.06) 200px, transparent 260px, rgba(74,160,140,0.19) 320px)',
              backgroundSize: '320px 100%',
              WebkitMaskImage: 'linear-gradient(180deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.42) 55%, rgba(0,0,0,0.18) 84%, rgba(0,0,0,0.04) 100%)',
              maskImage: 'linear-gradient(180deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.42) 55%, rgba(0,0,0,0.18) 84%, rgba(0,0,0,0.04) 100%)',
              filter: 'blur(14px)',
              mixBlendMode: 'screen',
              animationDelay: '-12s',
            }}
          />
          <div
            className="tarot-band absolute -left-[35%] -top-[8%] h-[116%] w-[170%]"
            style={{
              background: 'linear-gradient(100deg, transparent 0%, rgba(122,92,205,0.20) 30%, rgba(74,160,140,0.15) 58%, rgba(232,201,106,0.06) 72%, transparent 100%)',
              WebkitMaskImage: 'linear-gradient(180deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.4) 55%, rgba(0,0,0,0.15) 85%, transparent 100%)',
              maskImage: 'linear-gradient(180deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.4) 55%, rgba(0,0,0,0.15) 85%, transparent 100%)',
              filter: 'blur(26px)',
              mixBlendMode: 'screen',
            }}
          />
        </div>
      </div>
      {!skyOff && <TarotSkyShader navigationSignal={navigationSignal} onFallback={() => setSkyOff(true)} />}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-72 overflow-hidden">
        <ZodiacRing size={300} durationS={140} glyphColor="rgba(201,162,39,0.55)" className="opacity-[0.13]" />
      </div>
      <TarotDomeCanvas navigationSignal={navigationSignal} />
      <div className="pointer-events-none absolute inset-0 z-20" style={{ background: 'radial-gradient(120% 95% at 50% 42%, transparent 58%, rgba(0,0,0,0.30) 100%)' }} />

      <div className="relative z-10 shrink-0 px-4" style={{ paddingTop: 'calc(var(--chrome-top) + 0.25rem)' }}>
        <div className="flex items-center gap-3">
          <button
            onClick={closeApp}
            aria-label="返回桌面"
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#8b7355]/40 text-[#f5f0e1]/80 active:scale-95"
          >
            <CaretLeft size={16} weight="bold" />
          </button>
          <div className="flex items-center gap-2">
            <Sparkle size={13} weight="fill" className="tarot-twinkle text-[#e8c96a]" style={{ animationDelay: '-0.9s' }} />
            <div>
              <h1 className="text-lg tracking-[0.35em] text-[#f5f0e1]" style={{ textShadow: '0 0 18px rgba(232,201,106,0.35)' }}>塔 罗</h1>
              <p className="text-[10px] tracking-[0.25em] text-[#c9a227]/70">A R C A N A</p>
            </div>
            <Sparkle size={13} weight="fill" className="tarot-twinkle text-[#e8c96a]" />
          </div>
        </div>
      </div>

      <div key={tab} className="no-scrollbar relative z-10 min-h-0 flex-1 overflow-y-auto px-4 py-4 animate-fade-soft">
        {tab === 'daily' && <DailyView records={records} recordsLoaded={recordsLoaded} refresh={refresh} onSkyNavigation={signalSkyNavigation} />}
        {tab === 'ritual' && (
          <RitualView
            characters={characters}
            activeCharacterId={activeCharacterId}
            userProfile={userProfile}
            apiConfig={apiConfig}
            addToast={addToast}
            dateKey={todayKey}
            onSaved={refresh}
            onSkyNavigation={signalSkyNavigation}
          />
        )}
        {tab === 'library' && <LibraryView onSkyNavigation={signalSkyNavigation} />}
        {tab === 'history' && <HistoryView records={records} refresh={refresh} onSkyNavigation={signalSkyNavigation} />}
      </div>

      <nav
        className="relative z-10 grid shrink-0 grid-cols-4 border-t border-[#c9a227]/25 bg-[#0e0b18]/95"
        style={{ paddingBottom: 'calc(var(--safe-bottom) + 0.5rem)', paddingTop: '0.5rem' }}
      >
        {TABS.map(({ id, name, Icon }) => (
          <button
            key={id}
            onClick={() => { if (tab !== id) signalSkyNavigation(); setTab(id); }}
            className={`flex flex-col items-center gap-0.5 py-1 active:scale-95 ${tab === id ? 'text-[#e8c96a]' : 'text-[#f5f0e1]/45'}`}
          >
            <Icon
              size={20}
              weight={tab === id ? 'fill' : 'regular'}
              style={tab === id ? { filter: 'drop-shadow(0 0 6px rgba(232,201,106,0.7))' } : undefined}
            />
            <span className="text-[10px] tracking-widest">{name}</span>
            <span className={`h-1 w-1 rounded-full transition-all duration-200 ${tab === id ? 'bg-[#e8c96a] shadow-[0_0_6px_rgba(232,201,106,0.9)]' : 'bg-transparent'}`} />
          </button>
        ))}
      </nav>
      <TarotBokeh />
    </div>
  );
};

export default TarotApp;
