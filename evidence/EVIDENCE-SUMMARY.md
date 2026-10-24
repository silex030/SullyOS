# 证据摘要（返工卡 t_38463abd · 第 3 轮 · 实现提交 f01fd6a2）

worktree：`/root/.hermes/kanban/workspaces/t_75dd49a5/repo`，分支 `social-excerpts/t_75dd49a5`。
上一轮 HEAD `62569fd1`（实现 `43721c4e`），本轮实现提交 **`f01fd6a2`**：
`utils/socialShareTool.ts` +79/−16、`utils/db.ts` +63（新增专用入口）、`hooks/useChatAI.ts` +7/−2、
`utils/socialShareTool.test.ts` +265/−3、wiring +19/−2、文档 §8.6/§8.8/§8.12 同提交更新。
本文件与 `EXECUTION-AUDIT.md §9`、`VERIFY-R3-HEAD.txt` 是随后的证据提交（只动 Markdown/日志）。
未合并、未部署；主仓库 `/opt/sullyos/sullyos-repo` 仍为 `259626ae` clean。

## 1. 复跑命令与结果（全部在本轮代码上真实执行，2026-10-25 02:25–02:47 +08:00）

| 命令 | 结果 |
| --- | --- |
| `npx vitest run utils/socialShareTool.test.ts utils/socialShareTool.wiring.test.ts` | 2 files / **56 passed**（42 + 14） |
| `npx vitest run $(ls utils/*[cC]hat*.test.ts)` | 38 files / **354 passed** |
| 定向 9 目标（socialShareTool×2 + mcpToolBridge + agenticTools + messageFormat + socialShare + chatRequestPayload + worker/social-content + socialContent） | 29 files / **355 passed** |
| `npx tsc -p tsconfig.json --noEmit` | **EXIT=2，56 个 error TS**；与基线 `evidence/tsc-full.log` 的 error 行集合 `diff` 为空（56 vs 56）；改动文件 **0** 错误 |
| `npx vite build` | **EXIT=0**（2m50s，`dist/` 为 gitignore） |

原始日志：`evidence/vitest-tool-r3.log`、`vitest-chat-r3.log`、`vitest-focused-r3.log`、
`tsc-full-r3.log`、`vite-build-r3.log`、文档提交后重跑 `vitest-tool-r3-postdocs.log`；
HEAD 与退出码见 `evidence/VERIFY-R3-HEAD.txt`。

## 2. 本轮两条 P1 的对应关系（详情见文档 §8.12）

1. **跨锚点补偿用裸 toolCallId 去重 → 能静默清掉别的轮次未落库记录**（P1-1）
   - `ShareExcerptPairOutbox` 持有「已写成功」集合，键 = **（anchorId, toolCallId）**
     （NUL 分隔、512 条封顶）；`record` / `writePending` / `has` / `snapshot` 全部按锚点校准。
   - 语义：`recorded` = 本锚点已写条数；`recordedAll` = 队列已知已写总数；
     `has(id)` 默认本锚点、`has(id, anchor)` 才能问别轮；`unsaved` = 队列里还有任何未落库记录。
   - 测试：旧锚点 101 失败的 `call_1` + 新锚点 404 同 id 的 `call_1` → 两份都写回各自消息
     （A 卡/B 卡字幕互不串、队列清空）；只对 101 持续失败时 404 写成功也不会把 101 抹掉；
     原同 id 并发用例改为**传共享 outbox** 并断言队列清空 + `has` 按锚点隔离。
2. **生产 saver 不等 IndexedDB 事务提交 → 失败被当成已保存**（P1-2）
   - `utils/db.ts` 新增**专用**入口 `DB.updateMessageMetadataCommitted`：成功 = `transaction.oncomplete`，
     失败 = `onerror/onabort`，`updater` 抛错/消息不存在则 abort + reject。
     **旧 `updateMessageMetadata` 语义不动**（共享热点，旧调用点依赖「put 后立即 resolve」）。
   - `hooks/useChatAI.ts` 的 saver 改走该入口。
   - 测试（真实 DB 层 / fake-indexeddb）：正常路径 dispatch → 提交后从库里读回成对 call/result，
     且下一轮投影读得回来；故障路径把 `IDBObjectStore.prototype.put` 包装成「put 后立刻
     `transaction.abort()`」→ 接口 reject、`has()` 仍 false、`recorded=0 / pendingRecords=1 /
     unsaved=true`、库里没有该 metadata；仅调生产 `flush()` 后提交成功、读回完整 pair。

## 3. 判别性验证（mutation，跑完立即从备份恢复，未留在提交里）

| mutation | 结果 |
| --- | --- |
| `ShareExcerptPairOutbox.key()` 改回裸 `toolCallId` | 新跨锚点用例失败：`store.get(404)` 无 metadata，而队列 `pendingCount()===0` —— 与审查给出的复现路径一致 |
| saver 改回 `DB.updateMessageMetadata` | 新事务用例失败：`recorder.has(toolCallId)` 为 true（记录被提前标成已保存） |

两处恢复后用例通过，说明这两条测试抓的确实是本轮修复点，不是靠断言宽松过关。

## 4. 执行边界（本 run 82，session `20261025_021714_c5e427`）

- `session_model_usage`：本 session **仅 1 行** → `deepseek-v4.1-flash` / `opencode-go` /
  `https://opencode.ai/zen/go/v1`；未用 `--model/--provider`，未改 MoA/profile/权限。
- `config.yaml`：sha256 `6b005711624c4adfd6d64bd77833c8e2d993e92967d926b5744c173a40176113`、
  mtime `2026-10-24 16:35:36`（早于本 run 02:17）；未改任何 profile 配置/approvals/delegation/kanban。
- 未启动网关：`ps` 里只有既存 PID 1664081（起于 2026-10-24 10:12:57）。
- 改动范围只有本 worktree 的 6 个代码/测试/文档文件 + `evidence/`；未部署、未合并。
- 完整命令与只读/写路径清单见 `evidence/EXECUTION-AUDIT.md` §9。

## 5. 未验证 / 残余风险（如实标注）

- 真实供应商模型是否**主动调用**该工具仍未验证（fixture 模型链路）；无灰度数据。
- 平台真实内容仍未打通（B 站 412 / 抖音登录墙 / XHS 停用），工具只会如实返回失败。
- 待补偿队列与「已写成功」集合都是**进程内内存**结构：应用重启后未落库记录会丢
  （丢时 `console.error` 明确可见），已写集合归零只影响统计与短期幂等精度。
- 「已写成功」以事务提交为准，但没有读回校验；提交失败时工具结果仍照常返回模型
  （模型侧无法感知该次读在库里处于「待补偿」）。
- `updateMessageMetadataCommitted` 是新增入口，旧调用点未迁移；两条路径对「写成功」定义不同
  （wiring 测试已钉住本工具必须用新入口）。
- `user` 消息会带 ≤600 token 的片段记录投影（有界但可见增长）；片段未做提示注入消毒。
- 热点 `hooks/useChatAI.ts` 本轮净 +7/−2（无重构）；未跑 `pnpm run check:workers`（无 worker 改动）。
