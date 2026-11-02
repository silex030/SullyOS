/**
 * seasonal-events · HalloweenHunt
 * 本地万圣节可玩互动：收集 6 个自绘糖果点位 → 领取 → 已完成。
 * - 日期与展示用用户本地时间（todayKey 缺省时取设备今天），与角色时区无关。
 * - todayKey 仅测试/preview 注入；生产调用不传，绝不伪造当前日期。
 * - 奖励通过 onReward(typed intent) 交集成者落库，本模块不写全局货币/捕鱼存档。
 * - 进度（含 claimed）持久化在模块 key 下，关页重开不重复领取。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { getLocalDateKey } from '../../utils/localDate';
import {
  allCollected,
  clearHalloweenCorrupt,
  createHalloweenState,
  getHalloweenPhase,
  isHalloweenActive,
  loadHalloweenMeta,
  tryClaimPersisted,
  tryPersistCollect,
  type HalloweenLoadStatus,
} from './halloween';
import {
  HALLOWEEN_EVENT_ID,
  HALLOWEEN_SPOTS,
  type HalloweenRewardIntent,
  type HalloweenSpotId,
  type HalloweenStateV1,
} from './types';
import type { StorageLike } from '../room3d/storage';
import type { CrossDocMutex } from '../room3d/mutex';
import { UiOperationLeaseManager } from '../shared/uiOperationLease';

export interface HalloweenHuntProps {
  charId: string;
  storage: StorageLike;
  /**
   * 跨文档互斥能力（redesign-v1 写协议）：
   * - 不传 → getDefaultMutex()；传 null → 收集/领取一律 fail closed。
   */
  mutex?: CrossDocMutex | null;
  /** 仅测试/preview 注入；生产不传（用设备本地今天）。 */
  todayKey?: string;
  onReward?: (intent: HalloweenRewardIntent) => void;
}

const spotLabel: Record<HalloweenSpotId, string> = {
  pumpkin: '南瓜',
  ghost: '幽灵',
  bat: '蝙蝠',
  candy: '糖果',
  lantern: '灯笼',
  hat: '巫师帽',
};

const spotColor: Record<HalloweenSpotId, string> = {
  pumpkin: '#e07b2e',
  ghost: '#e8ecf3',
  bat: '#5b5b7a',
  candy: '#e0507e',
  lantern: '#f2b63c',
  hat: '#7a5fc0',
};

function SpotArt({ spot }: { spot: HalloweenSpotId }): ReactNode {
  const c = spotColor[spot];
  return (
    <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden="true">
      {spot === 'pumpkin' && (
        <g>
          <ellipse cx="24" cy="28" rx="14" ry="11" fill={c} />
          <ellipse cx="17" cy="28" rx="5" ry="10" fill="#c9661f" opacity="0.7" />
          <ellipse cx="31" cy="28" rx="5" ry="10" fill="#c9661f" opacity="0.7" />
          <rect x="22" y="12" width="4" height="7" rx="2" fill="#5d8a4a" />
          <circle cx="19" cy="27" r="1.8" fill="#3a2a1a" />
          <circle cx="29" cy="27" r="1.8" fill="#3a2a1a" />
          <path d="M19 32 Q24 36 29 32" stroke="#3a2a1a" strokeWidth="1.8" fill="none" strokeLinecap="round" />
        </g>
      )}
      {spot === 'ghost' && (
        <g>
          <path d="M14 40 L14 22 Q14 12 24 12 Q34 12 34 22 L34 40 L30 36 L26 40 L22 36 L18 40 Z" fill={c} />
          <circle cx="20" cy="23" r="2" fill="#2b2f3a" />
          <circle cx="28" cy="23" r="2" fill="#2b2f3a" />
          <ellipse cx="24" cy="29" rx="2.4" ry="3" fill="#2b2f3a" />
        </g>
      )}
      {spot === 'bat' && (
        <g>
          <path d="M6 22 Q14 10 22 20 L24 16 L26 20 Q34 10 42 22 Q34 20 30 26 Q27 30 24 28 Q21 30 18 26 Q14 20 6 22 Z" fill={c} />
          <circle cx="22" cy="23" r="1.2" fill="#ffd166" />
          <circle cx="26" cy="23" r="1.2" fill="#ffd166" />
        </g>
      )}
      {spot === 'candy' && (
        <g>
          <circle cx="24" cy="24" r="9" fill={c} />
          <path d="M17 19 Q24 24 31 29 M31 19 Q24 24 17 29" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
          <path d="M15 24 L8 19 L10 26 Z M33 24 L40 19 L38 26 Z" fill="#f2b63c" />
        </g>
      )}
      {spot === 'lantern' && (
        <g>
          <rect x="20" y="8" width="8" height="4" rx="1.5" fill="#4a3b2a" />
          <ellipse cx="24" cy="26" rx="11" ry="13" fill={c} />
          <ellipse cx="24" cy="26" rx="6" ry="9" fill="#e0952b" />
          <circle cx="21" cy="24" r="1.8" fill="#4a2c10" />
          <circle cx="27" cy="24" r="1.8" fill="#4a2c10" />
          <path d="M20 29 Q24 32 28 29" stroke="#4a2c10" strokeWidth="1.8" fill="none" strokeLinecap="round" />
          <rect x="20" y="38" width="8" height="3" rx="1.5" fill="#4a3b2a" />
        </g>
      )}
      {spot === 'hat' && (
        <g>
          <path d="M26 6 L30 26 L12 30 Z" fill={c} />
          <path d="M26 6 Q28 12 26 18" stroke="#5a4890" strokeWidth="2" fill="none" />
          <rect x="14" y="16" width="14" height="4" rx="2" fill="#f2b63c" transform="rotate(8 21 18)" />
          <ellipse cx="24" cy="34" rx="16" ry="5" fill="#6a54a8" />
        </g>
      )}
    </svg>
  );
}

export function HalloweenHunt({
  charId,
  storage,
  mutex,
  todayKey,
  onReward,
}: HalloweenHuntProps): ReactNode {
  // 生产路径：设备本地今天；todayKey 只用于测试/preview。
  const today = todayKey ?? getLocalDateKey(new Date());
  const phase = getHalloweenPhase(today);
  // 槽位快照：state + 读取状态 + 原始字节。charId/storage 变化即重载，
  // 同一 mounted 实例 A→B→A 不串档；损坏/不可读绝不自动覆写。
  const [slot, setSlot] = useState<{
    status: HalloweenLoadStatus;
    state: HalloweenStateV1;
    raw: string | null;
  }>(() => {
    const meta = loadHalloweenMeta(storage, charId);
    return {
      status: meta.status,
      state: meta.state ?? createHalloweenState(charId),
      raw: meta.raw,
    };
  });
  const [notice, setNotice] = useState<string>('');
  // UI 操作租约（operation-lease-v2 唯一协议）：slot 代次 + 操作序号。
  // charId/storage 切换 → rotateSlot；卸载 → 失效；每次 async 开始 → begin。
  // 接纳唯一条件 isOperationCurrent；sameSlotAs 身份相等已废除（A→B→A 误接纳）。
  // mountedRef 仅用于避免卸载后 setState/回调，绝不代替代次判定。
  const leaseRef = useRef<UiOperationLeaseManager | null>(null);
  if (!leaseRef.current) leaseRef.current = new UiOperationLeaseManager();
  const prevSlotRef = useRef<{ charId: string; storage: StorageLike } | null>(null);
  useEffect(() => {
    const prev = prevSlotRef.current;
    if (prev && (prev.charId !== charId || prev.storage !== storage)) {
      leaseRef.current!.rotateSlot();
    }
    prevSlotRef.current = { charId, storage };
    const meta = loadHalloweenMeta(storage, charId);
    setSlot({
      status: meta.status,
      state: meta.state ?? createHalloweenState(charId),
      raw: meta.raw,
    });
    setNotice('');
  }, [charId, storage]);
  const state = slot.state;
  // ref 镜像：快速连点时每个 handler 都读到最新态，避免批量更新互相覆盖。
  const stateRef = useRef(state);
  stateRef.current = state;

  const done = allCollected(state);
  const active = isHalloweenActive(today);

  const mutexOpt = mutex; // undefined → 函数内 getDefaultMutex()；null → fail closed
  // 迟到结果一律按租约判定；奖励 intent 与 UI 分开（见各 handler）。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      leaseRef.current!.invalidateForUnmount();
    };
  }, []);
  const onRewardRef = useRef(onReward);
  onRewardRef.current = onReward;

  const onCollect = (spot: HalloweenSpotId): void => {
    if (slot.status !== 'ok' && slot.status !== 'missing') {
      setNotice('存档不可写（损坏或不可读），先恢复后再收集');
      return;
    }
    const myCharId = charId;
    const myStorage = storage;
    const cur = stateRef.current;
    const lease = leaseRef.current!.beginOperation();
    void (async () => {
      const r = await tryPersistCollect(myStorage, myCharId, cur, spot, today, Date.now(), mutexOpt);
      if (!mountedRef.current) return; // 卸载：盘已写旧槽，无回调可投递
      if (!leaseRef.current!.isOperationCurrent(lease)) return; // 迟到：槽切换/新操作/卸载，UI不动
      if (r.ok) {
        stateRef.current = r.state;
        setSlot((s) => ({ ...s, status: 'ok', raw: s.raw, state: r.state }));
      } else if (r.error === 'not-collectible') {
        setNotice(
          cur.collected.includes(spot) ? '这个已经收集过啦' : '活动未开始或已结束',
        );
      } else if (r.error === 'already-claimed') {
        stateRef.current = r.state;
        setSlot((s) => ({ ...s, status: 'ok', state: r.state }));
        setNotice('已经领取过啦，不会重复发放');
      } else if (r.error === 'corrupt-blocked') {
        setSlot((s) => ({ ...s, status: 'corrupt' }));
        setNotice('存档已损坏，未覆写。请用下方恢复按钮处理');
      } else if (r.error === 'read-error') {
        setSlot((s) => ({ ...s, status: 'read-error' }));
        setNotice('存储不可读，收集已中止（未产生写入）');
      } else if (r.error === 'owner-mismatch') {
        setNotice('状态归属异常（已中止写入以保护其他角色存档）');
      } else {
        setNotice(
          r.error === 'no-cross-tab-mutex'
            ? '无跨文档互斥能力，收集已中止（未写入以保护旧数据）'
            : '收集保存失败（存储不可写），本次未计入',
        );
      }
    })();
  };

  const onClaim = (): void => {
    const myCharId = charId;
    const myStorage = storage;
    const cur = stateRef.current;
    const lease = leaseRef.current!.beginOperation();
    void (async () => {
      const r = await tryClaimPersisted(myStorage, myCharId, cur, today, Date.now(), mutexOpt);
      if (r.status === 'claimed') {
        if (!mountedRef.current) return; // 卸载：盘已claimed，重开可见；无回调可投递
        if (!leaseRef.current!.isOperationCurrent(lease)) {
          onRewardRef.current?.(r.intent); // 迟到成功：UI不动，intent按正确角色投递
          return;
        }
        stateRef.current = r.state;
        setSlot((s) => ({ ...s, status: 'ok', state: r.state }));
        setNotice('领取成功！奖励已交由集成者发放');
        onRewardRef.current?.(r.intent);
      } else if (!mountedRef.current) {
        return; // 卸载：UI不动
      } else if (!leaseRef.current!.isOperationCurrent(lease)) {
        return; // 迟到失败/保护态：UI不动，不误报（不复活旧错误）
      } else if (r.status === 'already-claimed') {
        stateRef.current = r.state;
        setSlot((s) => ({ ...s, status: 'ok', state: r.state }));
        setNotice('已经领取过啦，不会重复发放');
      } else if (r.status === 'not-ready') {
        stateRef.current = r.state;
        setSlot((s) => ({ ...s, status: 'ok', state: r.state }));
        setNotice('还没集齐，先去收集吧');
      } else if (r.status === 'persist-failed') {
        setNotice(
          r.error === 'no-cross-tab-mutex'
            ? '无跨文档互斥能力，领取已中止（未产生奖励）'
            : `领取保存失败，未发放奖励：${r.error}（可重试）`,
        );
      } else if (r.status === 'corrupt-blocked') {
        setSlot((s) => ({ ...s, status: 'corrupt', raw: r.raw }));
        setNotice('存档已损坏，未覆写。请用下方恢复按钮处理');
      } else {
        setSlot((s) => ({ ...s, status: 'read-error', raw: null }));
        setNotice('存储不可读，领取已中止（未产生奖励）');
      }
    })();
  };

  const onRecover = (): void => {
    const myCharId = charId;
    const myStorage = storage;
    const myRaw = slot.raw;
    const lease = leaseRef.current!.beginOperation();
    void (async () => {
      const ok = await clearHalloweenCorrupt(myStorage, myCharId, myRaw, mutexOpt);
      if (!mountedRef.current) return; // 卸载：盘已处理，无回调
      if (!leaseRef.current!.isOperationCurrent(lease)) return; // 迟到：盘已处理，UI不动（不清空新进度）
      if (ok) {
        const fresh = createHalloweenState(myCharId);
        stateRef.current = fresh;
        setSlot({ status: 'missing', state: fresh, raw: null });
        setNotice('已清除损坏数据，从空白进度重新开始');
      } else {
        const meta = loadHalloweenMeta(myStorage, myCharId);
        setSlot({
          status: meta.status,
          state: meta.state ?? createHalloweenState(myCharId),
          raw: meta.raw,
        });
        setNotice('恢复失败：存档可能已被其他页面改动，已重新读取');
      }
    })();
  };

  return (
    <div className="flex flex-col gap-4 rounded-[2.5rem] bg-white/80 p-5 backdrop-blur-xl">
      <div className="flex items-center px-1">
        <div>
          <h2 className="text-base font-semibold text-slate-800">
            万圣节收集 <span className="text-xs font-normal text-slate-400">{HALLOWEEN_EVENT_ID}</span>
          </h2>
          <p className="text-xs text-slate-500">
            今天 {today}（用户本地时间）
            {phase === 'active' && ' · 进行中'}
            {phase === 'before' && ' · 10-29 开启'}
            {phase === 'ended' && ' · 已结束'}
          </p>
        </div>
        <div className="ml-auto text-xs text-slate-500">
          {state.collected.length}/{HALLOWEEN_SPOTS.length}
        </div>
      </div>

      {phase === 'before' && (
        <p className="rounded-2xl bg-slate-900/5 px-4 py-3 text-sm text-slate-600">
          小幽灵们还在路上，10 月 29 日（按你手机上的日期）再来收集吧。
        </p>
      )}

      {(slot.status === 'corrupt' || slot.status === 'read-error') && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm text-red-700">
            {slot.status === 'corrupt'
              ? '这份活动存档已损坏（原字节已保留，未被覆盖）'
              : '活动存档不可读（可能存储被禁用），已停止写入以防丢失数据'}
          </p>
          {slot.status === 'corrupt' && (
            <button
              type="button"
              onClick={onRecover}
              className="mt-2 rounded-xl bg-red-600 px-3 py-1.5 text-xs text-white transition-all duration-200 active:scale-90"
            >
              清除损坏数据并重新开始
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        {HALLOWEEN_SPOTS.map((spot) => {
          const got = state.collected.includes(spot);
          return (
            <button
              key={spot}
              type="button"
              disabled={!active || got || slot.status === 'corrupt' || slot.status === 'read-error'}
              onClick={() => onCollect(spot)}
              className={`flex flex-col items-center gap-1 rounded-2xl border px-2 py-3 transition-all duration-200 ${
                got
                  ? 'border-emerald-200 bg-emerald-50 opacity-80'
                  : active
                    ? 'border-white/60 bg-white/60 active:scale-90'
                    : 'border-slate-200 bg-slate-100 opacity-60'
              }`}
              aria-label={got ? `${spotLabel[spot]}（已收集）` : `收集${spotLabel[spot]}`}
            >
              <SpotArt spot={spot} />
              <span className="text-xs text-slate-600">
                {spotLabel[spot]} {got ? '✓' : ''}
              </span>
            </button>
          );
        })}
      </div>

      {done && !state.claimed && (
        <button
          type="button"
          onClick={onClaim}
          className="rounded-2xl bg-emerald-600 px-4 py-2.5 text-sm text-white shadow-md shadow-emerald-600/30 transition-all duration-200 active:scale-90"
        >
          集齐啦，领取糖果奖励
        </button>
      )}
      {state.claimed && (
        <p className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          已完成 ✓ 奖励领取凭证 {state.claimId ?? ''}（重开不会重复发放）
        </p>
      )}
      {phase === 'ended' && !done && (
        <p className="rounded-2xl bg-slate-900/5 px-4 py-3 text-sm text-slate-500">
          本次活动已结束，下次再来。
        </p>
      )}
      {notice && <p className="px-1 text-xs text-slate-500">{notice}</p>}
    </div>
  );
}
