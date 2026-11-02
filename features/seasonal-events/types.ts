/**
 * seasonal-events · types
 * 季节活动模块 schema。首批：本地万圣节 2026（自绘素材、本地可玩）。
 * 日期一律用用户设备本地日历 key（YYYY-MM-DD），与角色时区无关。
 */

export const HALLOWEEN_EVENT_ID = 'halloween-2026';
/** 活动窗口（用户本地日期）：2026-10-29 至 2026-10-31。 */
export const HALLOWEEN_START_KEY = '2026-10-29';
export const HALLOWEEN_END_KEY = '2026-10-31';
export const HALLOWEEN_SCHEMA_VERSION = 1;

/** 可收集点位（自绘 SVG，无外部资源）。 */
export const HALLOWEEN_SPOTS = [
  'pumpkin',
  'ghost',
  'bat',
  'candy',
  'lantern',
  'hat',
] as const;

export type HalloweenSpotId = (typeof HALLOWEEN_SPOTS)[number];

export interface HalloweenStateV1 {
  version: 1;
  eventId: typeof HALLOWEEN_EVENT_ID;
  charId: string;
  collected: HalloweenSpotId[];
  claimed: boolean;
  claimId: string | null;
  updatedAt: number;
}

/**
 * 奖励意图：交给集成者的 typed callback，由集成者决定如何落库
 *（本模块绝不直接写全局货币 / 捕鱼存档）。
 */
export interface HalloweenRewardIntent {
  kind: 'halloween-candy';
  eventId: typeof HALLOWEEN_EVENT_ID;
  charId: string;
  claimId: string;
  collectedCount: number;
}

export type HalloweenPhase = 'before' | 'active' | 'ended';

/** 同角色隔离的 localStorage key。 */
export function halloweenStorageKey(charId: string): string {
  return `sully-seasonal-${HALLOWEEN_EVENT_ID}-${charId}`;
}
