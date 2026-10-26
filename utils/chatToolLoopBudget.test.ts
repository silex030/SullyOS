/**
 * 工具循环总轮数的行为回归（返工卡 t_38463abd P1-2，第 4 轮）。
 *
 * 这一组不读源码字符串，而是**真的调用** `resolveChatToolLoopBudget`（hook 3.6 循环用的就是它），
 * 再用一个与 hook 循环同形的极小驱动器跑「其它工具序列」，断言：
 *  - 分享卡在场**不会**改变混用工具链的总轮数（用户设置 / MCP 12 轮口径都不变）；
 *  - `maxToolLoops = 1` 时不会被分享卡反向放宽到 4；
 *  - 只有分享片段工具时才收紧到 4，且不放宽用户设置；
 *  - 原来需要第 5/6 轮的其它工具链，在有分享卡时仍然能跑完（完成能力不退化）。
 */
import { describe, expect, it } from 'vitest';
import {
  CHAT_MAX_TOOL_LOOPS_CEILING,
  CHAT_MAX_TOOL_LOOPS_FLOOR,
  DEFAULT_CHAT_MAX_TOOL_LOOPS,
  resolveChatToolLoopBudget,
  SHARE_ONLY_MAX_TOOL_LOOPS,
} from './chatToolLoopBudget';
import { MCP_CHAT_MAX_TOOL_LOOPS } from './mcpToolBridge';

/** 与 hook 3.6 循环同形的驱动器：每轮取一批 tool_calls，空批即收口。 */
function driveToolLoop(maxLoops: number, rounds: string[][]): { executed: string[]; completed: boolean } {
  const executed: string[] = [];
  for (let it = 0; it < maxLoops; it++) {
    const batch = rounds[it];
    if (!batch || batch.length === 0) break;
    executed.push(...batch);
  }
  const expected = rounds.flat();
  return { executed, completed: executed.length === expected.length };
}

describe('resolveChatToolLoopBudget · 混用工具时分享卡不改变总轮数', () => {
  it('默认设置 6：带分享卡 / 不带分享卡，其它工具链的总轮数完全一样（都是 6）', () => {
    const withShare = resolveChatToolLoopBudget({
      maxToolLoops: DEFAULT_CHAT_MAX_TOOL_LOOPS,
      shareExcerptsAvailable: true,
      otherToolsAvailable: true,
    });
    const withoutShare = resolveChatToolLoopBudget({
      maxToolLoops: DEFAULT_CHAT_MAX_TOOL_LOOPS,
      shareExcerptsAvailable: false,
      otherToolsAvailable: true,
    });
    expect(withShare).toBe(DEFAULT_CHAT_MAX_TOOL_LOOPS);
    expect(withoutShare).toBe(DEFAULT_CHAT_MAX_TOOL_LOOPS);
    expect(withShare).toBe(withoutShare);
  });

  it('用户设置 1：分享卡在场仍是 1（不再被反向放宽到 4）', () => {
    expect(resolveChatToolLoopBudget({
      maxToolLoops: 1,
      shareExcerptsAvailable: true,
      otherToolsAvailable: true,
    })).toBe(1);
    expect(resolveChatToolLoopBudget({
      maxToolLoops: 1,
      shareExcerptsAvailable: true,
      otherToolsAvailable: false,
    })).toBe(1);
  });

  it('用户设置 12 + 分享卡 + 其它工具：保持 12', () => {
    expect(resolveChatToolLoopBudget({
      maxToolLoops: 12,
      shareExcerptsAvailable: true,
      otherToolsAvailable: true,
    })).toBe(12);
  });

  it('通用 MCP 在场：仍是 max(用户设置, 12)，分享卡不影响', () => {
    for (const share of [true, false]) {
      for (const other of [true, false]) {
        expect(resolveChatToolLoopBudget({
          maxToolLoops: 6,
          mcpToolsAvailable: true,
          shareExcerptsAvailable: share,
          otherToolsAvailable: other,
        })).toBe(Math.max(6, MCP_CHAT_MAX_TOOL_LOOPS));
      }
    }
    expect(resolveChatToolLoopBudget({ maxToolLoops: 12, mcpToolsAvailable: true })).toBe(MCP_CHAT_MAX_TOOL_LOOPS);
  });

  it('没有分享工具时：原样返回用户设置（含缺省与越界夹紧）', () => {
    expect(resolveChatToolLoopBudget({})).toBe(DEFAULT_CHAT_MAX_TOOL_LOOPS);
    expect(resolveChatToolLoopBudget({ maxToolLoops: null })).toBe(DEFAULT_CHAT_MAX_TOOL_LOOPS);
    expect(resolveChatToolLoopBudget({ maxToolLoops: Number.NaN })).toBe(DEFAULT_CHAT_MAX_TOOL_LOOPS);
    expect(resolveChatToolLoopBudget({ maxToolLoops: 0 })).toBe(CHAT_MAX_TOOL_LOOPS_FLOOR);
    expect(resolveChatToolLoopBudget({ maxToolLoops: 99 })).toBe(CHAT_MAX_TOOL_LOOPS_CEILING);
    expect(resolveChatToolLoopBudget({ maxToolLoops: 6, otherToolsAvailable: true })).toBe(6);
  });
});

describe('resolveChatToolLoopBudget · 只有分享片段工具时的约定', () => {
  it('默认 6 → 收紧到 4；12 → 4；2 → 2；1 → 1（绝不放宽）', () => {
    const shareOnly = (maxToolLoops: number) => resolveChatToolLoopBudget({
      maxToolLoops,
      shareExcerptsAvailable: true,
      otherToolsAvailable: false,
    });
    expect(shareOnly(6)).toBe(SHARE_ONLY_MAX_TOOL_LOOPS);
    expect(shareOnly(12)).toBe(SHARE_ONLY_MAX_TOOL_LOOPS);
    expect(shareOnly(2)).toBe(2);
    expect(shareOnly(1)).toBe(1);
  });

  it('没有任何工具在场时不收紧（shareExcerptsAvailable=false 就是普通轮次）', () => {
    expect(resolveChatToolLoopBudget({ maxToolLoops: 6, shareExcerptsAvailable: false })).toBe(6);
  });
});

describe('resolveChatToolLoopBudget · 循环行为（不只是数字）', () => {
  /** 一条需要 6 轮才能跑完的其它工具链（瑞幸/排程类混合序列的抽象）。 */
  const sixRoundChain: string[][] = [
    ['queryShopList'],
    ['searchProductForMcp'],
    ['switchProduct'],
    ['previewOrder'],
    ['amsg2_schedule'],
    ['bt_read_sensor'],
    [],
  ];

  it('默认 6 轮：带分享卡的混用轮仍能跑完 6 轮（不提前停在第 4 轮）', () => {
    const loops = resolveChatToolLoopBudget({
      maxToolLoops: DEFAULT_CHAT_MAX_TOOL_LOOPS,
      shareExcerptsAvailable: true,
      otherToolsAvailable: true,
    });
    const run = driveToolLoop(loops, sixRoundChain);
    expect(run.completed).toBe(true);
    expect(run.executed).toHaveLength(6);
    // 与「没有分享卡」的旧行为逐项一致
    const baseline = driveToolLoop(
      resolveChatToolLoopBudget({ maxToolLoops: DEFAULT_CHAT_MAX_TOOL_LOOPS, otherToolsAvailable: true }),
      sixRoundChain,
    );
    expect(run.executed).toEqual(baseline.executed);
  });

  it('maxToolLoops=1 的混用轮：只跑 1 轮（尊重用户设置），不会因为分享卡变成 4 轮', () => {
    const loops = resolveChatToolLoopBudget({
      maxToolLoops: 1,
      shareExcerptsAvailable: true,
      otherToolsAvailable: true,
    });
    const run = driveToolLoop(loops, sixRoundChain);
    expect(run.completed).toBe(false);
    expect(run.executed).toEqual(['queryShopList']);
  });

  it('只有分享工具时：4 轮收口（第 5 轮起不再发请求）', () => {
    const loops = resolveChatToolLoopBudget({ maxToolLoops: 6, shareExcerptsAvailable: true });
    const shareChain: string[][] = [
      ['read_share_excerpts'],
      ['read_share_excerpts'],
      ['read_share_excerpts'],
      ['read_share_excerpts'],
      ['read_share_excerpts'],
    ];
    const run = driveToolLoop(loops, shareChain);
    expect(loops).toBe(4);
    expect(run.executed).toHaveLength(4);
    expect(run.completed).toBe(false); // 第 5 次调用不会被发出 —— 这是有意的收紧
  });

  it('通用 MCP 在场时：12 轮预算仍然生效（分享卡在场也一样）', () => {
    const loops = resolveChatToolLoopBudget({
      maxToolLoops: 6,
      mcpToolsAvailable: true,
      shareExcerptsAvailable: true,
    });
    const twelve: string[][] = Array.from({ length: 12 }, (_, i) => [`mcp_tool_${i}`]);
    expect(driveToolLoop(loops, twelve).completed).toBe(true);
  });
});
