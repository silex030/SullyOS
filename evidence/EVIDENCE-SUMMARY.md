# 证据摘要（返工卡 t_38463abd · 第 4 轮 · 实现提交 6065dff3）

worktree：`/root/.hermes/kanban/workspaces/t_75dd49a5/repo`，分支 `social-excerpts/t_75dd49a5`。
上一轮 HEAD `86c67854`（实现 `f01fd6a2`），本轮实现提交 **`6065dff3`**：
`utils/socialShareTool.ts` +35/−13、`utils/chatToolLoopBudget.ts`（新，纯函数）、
`hooks/useChatAI.ts` +21/−3、`utils/socialShareTool.test.ts` +146、wiring +45、
`utils/chatToolLoopBudget.test.ts`（新，11 例）、文档 §8.2/§8.4/§8.6/§8.8/§8.13/§9 同提交更新。
本文件与 `EXECUTION-AUDIT.md §10`、`VERIFY-R4-HEAD.txt` 是随后的证据提交（只动 Markdown/txt）。
未合并、未部署；主仓库 `/opt/sullyos/sullyos-repo` 仍为 `259626ae` clean。

## 1. 复跑命令与结果（全部在本轮代码上真实执行，2026-10-25 02:50–03:33 +08:00）

| 命令 | 结果 |
| --- | --- |
| `npx vitest run utils/socialShareTool.test.ts utils/socialShareTool.wiring.test.ts utils/chatToolLoopBudget.test.ts` | 3 files / **73 passed**（45 + 17 + 11） |
| `npx vitest run $(ls utils/*[cC]hat*.test.ts)` | 39 files / **365 passed** |
| 定向 10 目标（上面 3 个 + mcpToolBridge + agenticTools + messageFormat + socialShare + chatRequestPayload + worker/social-content + socialContent） | 30 files / **372 passed** |
| `npx tsc -p tsconfig.json --noEmit` | **EXIT=2，56 个 error TS**；与基线 `evidence/tsc-full.log` 的 error 行集合 `diff` 为空（56 vs 56）；改动文件 **0** 错误 |
| `npx vite build` | **EXIT=0**（2m39s，`dist/` 为 gitignore） |

原始日志：`evidence/vitest-tool-r4.log`、`vitest-chat-r4.log`、`vitest-focused-r4.log`、
`tsc-full-r4.log`、`vite-build-r4.log`（`*.log` 在 `.gitignore` 里，随 worktree 保留、不入库）；
HEAD 与退出码见 `evidence/VERIFY-R4-HEAD.txt`。

## 2. 本轮两条 P1 的对应关系（详情见文档 §8.13）

1. **健康 DB 下也静默删除已成功读取的历史**（P1-1）
   - `attachShareExcerptPairs` 去掉 `pairs.slice(-8)` / `SHARE_EXCERPT_RECORD_KEEP`：本轮收到的
     每一次调用都成对保留，拒绝/超限记录不能挤掉成功证据；落库侧仍按 `toolCallId` 幂等去重。
   - 体量有界改由结构保证（一条消息只装一轮记录 + 成功正文受轮次 2400 token 夹紧 + 失败记录一行）；
     **投影**仍受 600 token 夹紧 —— 「保留完整」与「投影有界」拆开，不再用删记录换投影额度。
   - 待补偿队列单消息上限 16 → 256（16 太近：一批 17+ 条的失败批次会挤掉最旧的未落库记录）。
   - 测试（真实 DB / fake-indexeddb + 生产 committed saver）：seed → 9 次 `dispatch`（1 成功 +
     7 同参重复 + 1 超次数）→ 生产 `flush()` → 读回 **9 条 pair**、顺序与执行顺序一致、
     `pairs[0].result.ok === true` 且含字幕、`pairs[8].result.code === 'TOOL_CALL_LIMIT'`；
     重复提交同一批 + `record` + `flush` 后仍 9 条（幂等，不删已有对）；
     `renderShareExcerptPairProjection` ≤600+160 字符。
2. **新分享卡改变其它工具的总循环预算**（P1-2）
   - 新增 `utils/chatToolLoopBudget.ts::resolveChatToolLoopBudget`（纯函数）作为唯一口径：
     ① 有通用 MCP → `max(用户设置, 12)`；② 只有分享片段工具 → `min(用户设置, 4)`（不放宽用户设置）；
     ③ 混用 / 没有分享工具 → 用户设置原值。
   - `hooks/useChatAI.ts` 的 `MAX_LOOPS` 改为调用它，并如实传入
     `mcpToolsAvailable / shareExcerptsAvailable / otherToolsAvailable`（瑞幸 / 麦当劳 / 排程 /
     蓝牙 / 生活工作流任一在场即算「有别的工具」）。旧的 `shareExcerptTurn ? 4 : …` 已删除。
   - 测试：`utils/chatToolLoopBudget.test.ts`（11 例）**真调用**决策函数 + 与 hook 3.6 循环同形的
     驱动器：默认 6 时有/无分享卡对同一条 6 轮工具链执行序列逐项相同且都跑完；`maxToolLoops=1`
     的混用轮只跑 1 轮（不再被放宽到 4）；12 轮保持 12；MCP 恒为 `max(用户设置,12)`；
     分享-only 6→4 / 12→4 / 2→2 / 1→1；分享-only 的 5 轮链条只发 4 次请求。
     wiring 测试钉 hook 走该函数、旧三元已消失、六类工具标志都传进去了。

## 3. 判别性验证（mutation，跑完立即从备份恢复，未留在提交里）

| mutation | 结果 |
| --- | --- |
| `attachShareExcerptPairs` 的 `pairs` 改回 `pairs.slice(-8)` | 新「一批 9 个不同 id」用例失败：`expected length 9 but got 8` —— 与审查给出的复现路径一致；恢复后通过 |
| 轮数口径换回旧表达式 `shareExcerptTurn ? 4 : maxToolLoops` | 混用 + 分享卡场景会得 4，而 `chatToolLoopBudget.test.ts` 断言 6 且 6 轮工具链跑完 —— 行为回归能抓住这个退化 |

## 4. 执行边界（本 run 87，session `20261025_025053_29e758`）

- `session_model_usage`：本 session **仅 1 行** → `deepseek-v4.1-flash` / `opencode-go` /
  `https://opencode.ai/zen/go/v1`；未用 `--model/--provider`，未改 MoA/profile/权限。
- `config.yaml`：sha256 `6b005711624c4adfd6d64bd77833c8e2d993e92967d926b5744c173a40176113`、
  mtime `2026-10-24 16:35:36`（早于本 run 02:50）；未改任何 profile 配置/approvals/delegation/kanban。
- 未启动网关：`ps` 里只有既存 PID 1664081（起于 2026-10-24 10:12:57）。
- 改动范围只有本 worktree 的 7 个代码/测试/文档文件 + `evidence/`；未部署、未合并。
- 完整命令与只读/写路径清单见 `evidence/EXECUTION-AUDIT.md` §10。

## 5. 未验证 / 残余风险（如实标注）

- 历史体量随「本轮调用条数」增长：模型一次吐很多 tool_calls 时该消息的 `metadata.shareExcerpts`
  会带同样多的记录（成功正文仍受 2400 token 夹紧、失败各一行）。这是「不丢证据」的代价；
  投影仍 ≤600 token，不影响后续上下文预算。
- 待补偿队列 256 条仍是**有界丢弃**：真到了会 `console.error` 丢最旧，且不标已写（不谎报已保存）。
- 轮数口径是纯函数，hook 侧只负责把「谁在场」传对；**没有**在真实 React 运行里跑整条 hook
  （仓库 vitest 是纯 Node，`useChatAI` 绑死 React）——wiring 钉传参形状，行为测试钉决策函数。
- 真实供应商模型是否**主动调用**该工具仍未验证（fixture 模型链路）；无灰度数据。
- 平台真实内容仍未打通（B 站 412 / 抖音登录墙 / XHS 停用），工具只会如实返回失败。
- 待补偿队列与「已写成功」集合都是**进程内内存**结构：应用重启后未落库记录会丢
  （丢时 `console.error` 明确可见），已写集合归零只影响统计与短期幂等精度。
- 「已写成功」以事务提交为准，但没有读回校验；提交失败时工具结果仍照常返回模型
  （模型侧无法感知该次读在库里处于「待补偿」）。
- `updateMessageMetadataCommitted` 是新增入口，旧调用点未迁移；两条路径对「写成功」定义不同
  （wiring 测试已钉住本工具必须用新入口）。
- `user` 消息会带 ≤600 token 的片段记录投影（有界但可见增长）；片段未做提示注入消毒。
- 热点 `hooks/useChatAI.ts` 本轮净 +21/−3（只换轮数决策，无重构）；未跑 `pnpm run check:workers`
  （无 worker 改动）；未部署、未合并。
