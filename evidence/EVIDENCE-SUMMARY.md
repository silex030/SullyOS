# 证据摘要（返工卡 t_38463abd / 提交 fd65b32e）

完整审计与原始日志在分支 `social-excerpts/t_75dd49a5` 的 `evidence/` 目录：
`EXECUTION-AUDIT.md`、`vitest-tool.log`、`vitest-focused.log`、`vitest-chat.log`、
`tsc-full.log`、`vite-build.log`。worktree：`/root/.hermes/kanban/workspaces/t_75dd49a5/repo`。

## 复跑命令与结果（2026-10-25，本机真实执行）

| 命令 | 结果 |
| --- | --- |
| `npx vitest run utils/socialShareTool.test.ts utils/socialShareTool.wiring.test.ts` | 2 files / **45 passed**（34 + 11） |
| `npx vitest run $(ls utils/*[cC]hat*.test.ts)` | 38 files / **354 passed** |
| `npx vitest run utils/socialShareTool.test.ts utils/socialShareTool.wiring.test.ts utils/mcpToolBridge utils/agenticTools utils/messageFormat utils/socialShare utils/chatRequestPayload worker/social-content utils/socialContent` | 29 files / **344 passed** |
| `npx tsc -p tsconfig.json --noEmit` | **EXIT=2，56 个 error TS**；与父卡基线 `evidence/tsc-full.log` 的 error 行 `diff` 为空（56 vs 56）；改动文件 0 错误 |
| `npx vite build` | **EXIT=0**（5m49s，`dist/` 为 gitignore） |

## 三条返工项的验收锚点

1. **可见引用可执行**：投影 `[分享 shr_<32位>]` 用的是完整 shareRef；执行器精确匹配 +
   ≥8 字符**唯一**前缀容错；歧义 → `SHARE_REF_AMBIGUOUS`（列候选、零请求）；非法 → `SHARE_REF_INVALID`；
   集合外 → `SHARE_NOT_IN_CONTEXT`。主链路测试从真实 `normalizeMessageContent` 输出提取引用驱动调用。
2. **记录成对留存不依赖最终回复**：`ShareExcerptPairRecorder` 锚在本轮触发消息（`contextMsgs`
   最后一条，发送前已落库），每执行一次工具即写一次；幂等（toolCallId 去重）×2、串行、
   写失败不阻断且可重试、无锚不猜。覆盖：无 assistant、取消/网络失败、并发隔离、重复提交、
   落库失败、串行化。
3. **执行边界**：本 run（`20261024_235558_956b2d`）与上一 run（`20261024_223809_88b0c9`）在
   `session_model_usage` 里各只有 1 行 → `deepseek-v4.1-flash / opencode-go /
   https://opencode.ai/zen/go/v1`；`config.yaml` sha256 `6b005711624c4adfd6d64bd77833c8e2d993e92967d926b5744c173a40176113`、
   mtime `2026-10-24 16:35:36`（早于两个 run）；`moa.enabled=false`；主仓库 `259626ae` clean；
   未启动网关（既存 PID 1664081 起于 10:12:57）；无密钥/部署动作。
   旧评论里的 `piaomiao/[AA]deepseek-4.1-flash-1017` 是建卡 pin，5 次启动崩溃后于
   **21:45:47** 由 `model_override_set` 改为 `deepseek-v4.1-flash/opencode-go`。

## 未验证（如实标注）

真实供应商模型是否主动调用该工具；平台真实内容（B站 412 / 抖音登录墙 / XHS 停用）；
未合并、未部署；`user` 消息现在也会带 ≤600 token 的片段记录投影；片段未做提示注入消毒。
