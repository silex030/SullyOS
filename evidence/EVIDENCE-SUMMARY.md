# 证据摘要（返工卡 t_38463abd · 第 2 轮 · 提交 43721c4e）

worktree：`/root/.hermes/kanban/workspaces/t_75dd49a5/repo`，分支 `social-excerpts/t_75dd49a5`。
基线 `300cfa28`（第 1 轮证据提交），本轮实现提交 **`43721c4e`**：`utils/socialShareTool.ts`
+240/−24、`utils/socialShareTool.test.ts` +187/−35、wiring +19/−2、`hooks/useChatAI.ts` +24/−7，
文档 `docs/social-content/integration-v1.md` 与 `evidence/EXECUTION-AUDIT.md` 同提交更新
（本文件是随后的证据提交，仅改 Markdown，不触碰代码/测试）。未合并、未部署，主仓库
`/opt/sullyos/sullyos-repo` 仍为 `259626ae` clean。

## 1. 复跑命令与结果（全部在 `43721c4e` 上真实执行，2026-10-25 02:00–02:13 +08:00）

| 命令 | 结果 |
| --- | --- |
| `npx vitest run utils/socialShareTool.test.ts utils/socialShareTool.wiring.test.ts` | 2 files / **51 passed**（38 + 13） |
| `npx vitest run $(ls utils/*[cC]hat*.test.ts)` | 38 files / **354 passed** |
| `npx vitest run utils/socialShareTool.test.ts utils/socialShareTool.wiring.test.ts utils/mcpToolBridge utils/agenticTools utils/messageFormat utils/socialShare utils/chatRequestPayload worker/social-content utils/socialContent` | 29 files / **350 passed** |
| `npx tsc -p tsconfig.json --noEmit` | **EXIT=2，56 个 error TS**；与基线 `evidence/tsc-full.log` 的 error 行集合 `diff` 为空（56 vs 56）；改动文件 **0** 错误 |
| `npx vite build` | **EXIT=0**（2m57s，`dist/` 为 gitignore） |

原始日志：`evidence/vitest-tool-r2.log`、`vitest-chat-r2.log`、`vitest-focused-r2.log`、
`tsc-full-r2.log`、`vite-build-r2.log`；各命令退出码与 HEAD 记录在 `evidence/VERIFY-R2-HEAD.txt`
（`HEAD=43721c4e`、五个 `*_EXIT`、`DONE=2026-10-25T02:13:01+08:00`）。

## 2. 本轮两条 P1 的对应关系（详情见文档 §8.11）

1. **失败批次不保留 / flush 不重试** → 新增 `ShareExcerptPairOutbox` 待补偿队列：
   - 失败批次留在队列、不标已写；`record`（下一次工具调用）与 `flush`（成功尾部 + `finally`）
     都从队列按**原始锚点**写；`flush` 有界重试（每次最多 3 轮，常量封顶）。
   - 重试用尽仍失败 → `snapshot().unsaved === true` + `console.error`「未保存·待补偿」，
     文档不再承诺「已保存」；下一轮收尾用同一份进程内队列补写（跨轮补偿）。
   - 测试走**生产路径**（不再手工 `record` 第二次）：dispatch → 首次 `savePairs` 失败 →
     只调 `flush()` → 第二次成功并读回完整 call/result；另有「两个 flush 各自重试」、
     「新调用带走旧失败批次」、「持续失败 → unsaved + 上报 + 下一轮写回原锚点」。
2. **anchorId=null 仍返回片段、零历史** → 无锚点**读取前**拒绝：
   - hook 在注入前把 `shareExcerptTurn` 置空（`shareExcerptAnchorId == null`）；
   - `dispatchShareExcerptToolCall` 在预算与网络之前返回 `HISTORY_UNAVAILABLE`（零请求）；
   - 测试：零锚点零请求零落库、无 recorder 同样拒绝、无锚点轮与有锚点轮并发不串轮。

## 3. 执行边界（本 run 76，session `20261025_013601_e70a16`）

- `session_model_usage`：本 run 只有 1 行 → `deepseek-v4.1-flash` / `opencode-go` /
  `https://opencode.ai/zen/go/v1`；最近 8 个会话全部同模型同 provider。
- `config.yaml`：sha256 `6b005711624c4adfd6d64bd77833c8e2d993e92967d926b5744c173a40176113`、
  mtime `2026-10-24 16:35:36`（早于本 run）；未改任何 profile 配置/approvals/delegation/kanban。
- 未启动网关：`ps` 里只有既存 PID 1664081（起于 2026-10-24 10:12:57，早于本 run 15h+）。
- 改动范围只有本 worktree 的 5 个代码/文档文件 + `evidence/`；未部署（无 worker bundle 重建、无服务重启）。
- 完整命令与只读/写路径清单见 `evidence/EXECUTION-AUDIT.md` §8。

## 4. 未验证 / 残余风险（如实标注）

- 真实供应商模型是否**主动调用**该工具仍未验证（fixture 模型链路）；无灰度数据。
- 平台真实内容仍未打通（B 站 412 / 抖音登录墙 / XHS 停用），工具只会如实返回失败。
- 待补偿队列是**进程内内存**结构：应用重启后未落库记录会丢（丢时 `console.error` 明确可见）。
- 同一 `toolCallId` 被两个记录器并发写时靠落库侧 id 去重，最多浪费一次写，不产生重复对。
- `user` 消息会带 ≤600 token 的片段记录投影（有界但可见增长）；片段未做提示注入消毒。
- 热点 `hooks/useChatAI.ts` 本轮净 +24/−7（无重构）；未跑 `pnpm run check:workers`（无 worker 改动）。
