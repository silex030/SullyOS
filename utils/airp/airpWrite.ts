/**
 * char.airp 的写回形态（从已退役的 AutonomyPanel 抽出）。
 *
 * 默认值打底 → 现有字段 → patch，保留调用方不负责的字段，避免双写打架。
 * 现在只有 AirpPanel（能力授权旧档位）会用它；AutonomyPanel 里的模板/节奏/护栏
 * 编辑入口已按契约 §9 K1–K3 退役。
 */
import type { AirpSettings } from './settings';

export const buildAirpSettings = (
  current: AirpSettings | undefined,
  patch: Partial<AirpSettings>,
): AirpSettings => ({
  enabled: false,
  autonomyLevel: 2,
  capabilities: [],
  mcpAllow: [],
  writable: false,
  ...(current ?? {}),
  ...patch,
  version: 1,
});
