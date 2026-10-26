/**
 * 聊天工具循环的「总轮数」决策（返工卡 t_38463abd P1-2，第 4 轮）。
 *
 * 背景：`hooks/useChatAI.ts` 的 3.6 客户端工具循环一个循环骨架同时服务瑞幸点单 / 麦当劳 /
 * 通用 MCP / 主动消息 2.0 排程 / 蓝牙 / 生活工作流 / 分享片段七类工具。原来的写法是
 *
 *     const MAX_LOOPS = mcpToolResolve ? Math.max(mcpSettings.maxToolLoops, 12)
 *                                      : shareExcerptTurn ? 4 : mcpSettings.maxToolLoops;
 *
 * 注释说「只有分享片段工具时才给 4 轮」，但条件只看了 `shareExcerptTurn`：只要**有一张分享卡在场**
 * 且没有 MCP，混用轮次也被压成 4 —— 原本需要第 5/6 轮的其它工具链提前停；用户把
 * `maxToolLoops` 设成 1 时又反过来被放宽到 4。这是「现有工具循环退化」。
 *
 * 现在的口径（本模块是唯一口径，hook 不再自己算）：
 *  1. 有通用 MCP 工具 → `max(用户设置, MCP_CHAT_MAX_TOOL_LOOPS)`（保持原行为：master 侧 12 轮预算）。
 *  2. 否则**只有**分享片段工具在场（没有其它任何工具）→ `min(用户设置, 4)`：
 *     分享工具单轮最多两次满额读（2400 token），4 轮足够纠错；但**绝不放宽用户设置**（设 1 就是 1）。
 *  3. 其它所有情形（混用 / 没有分享工具）→ 用户设置原值，分享卡在场不改变任何东西。
 *
 * 纯函数：输入都是布尔/数字，输出轮数；没有 React、没有 DB、没有网络，可以直接跑行为回归。
 */

import { MCP_CHAT_MAX_TOOL_LOOPS } from './mcpToolBridge';

/** 用户设置缺失/非法时的默认值（与 `utils/mcpClient.ts` 的 `DEFAULT_MCP_SETTINGS` 一致）。 */
export const DEFAULT_CHAT_MAX_TOOL_LOOPS = 6;
/** 用户设置允许的范围（与 `utils/mcpClient.ts` 的 `clampInt(..., 1, 12, 6)` 一致）。 */
export const CHAT_MAX_TOOL_LOOPS_FLOOR = 1;
export const CHAT_MAX_TOOL_LOOPS_CEILING = 12;
/**
 * 「只有分享片段工具」时的轮数上限。分享工具一轮最多两次满额读（单次 1200 / 轮次 2400 token），
 * 4 轮足够「读 → 换 query → 续读 → 收口」，再多也只是空转。**只在该工具是唯一工具时生效**。
 */
export const SHARE_ONLY_MAX_TOOL_LOOPS = 4;

export interface ChatToolLoopBudgetInput {
  /** 用户设置（`mcpSettings.maxToolLoops`）。缺失/非法按默认 6；越界夹到 1..12。 */
  maxToolLoops?: number | null;
  /** 本轮真的注入了通用 MCP 工具（`mcpToolResolve` 非空）。 */
  mcpToolsAvailable?: boolean;
  /** 本轮真的注入了 `read_share_excerpts`（分享卡在场 + 总开关开 + 有可读卡 + 有锚点）。 */
  shareExcerptsAvailable?: boolean;
  /**
   * 本轮还注入了**别的**工具（瑞幸 / 麦当劳 / 主动消息排程 / 蓝牙 / 生活工作流任一）。
   * 为 true 时分享片段工具**无权**调整总轮数。
   */
  otherToolsAvailable?: boolean;
}

function normalizeUserLoops(value: number | null | undefined): number {
  // null/undefined 是「没设置」→ 默认值；数字才夹到 1..12（Number(null) === 0，不能直接吃）。
  if (value == null) return DEFAULT_CHAT_MAX_TOOL_LOOPS;
  const raw = Math.floor(Number(value));
  if (!Number.isFinite(raw)) return DEFAULT_CHAT_MAX_TOOL_LOOPS;
  return Math.max(CHAT_MAX_TOOL_LOOPS_FLOOR, Math.min(CHAT_MAX_TOOL_LOOPS_CEILING, raw));
}

/**
 * 本轮工具循环的总轮数。分享片段工具只在自己的轮次里收紧上限，**永远不覆盖**混用工具的
 * 用户设置，也永远不会把用户设置调大。
 */
export function resolveChatToolLoopBudget(input: ChatToolLoopBudgetInput = {}): number {
  const userLoops = normalizeUserLoops(input.maxToolLoops);
  // 1) 通用 MCP：保持既有语义（用户设置与 master 侧 12 轮取大）。
  if (input.mcpToolsAvailable) return Math.max(userLoops, MCP_CHAT_MAX_TOOL_LOOPS);
  // 2) 分享片段是**唯一**工具：可以按分享预算收紧，但不放宽用户设置。
  const shareOnly = !!input.shareExcerptsAvailable && !input.otherToolsAvailable;
  if (shareOnly) return Math.min(userLoops, SHARE_ONLY_MAX_TOOL_LOOPS);
  // 3) 混用或没有分享工具：原样用用户设置（分享卡在场不产生任何影响）。
  return userLoops;
}
