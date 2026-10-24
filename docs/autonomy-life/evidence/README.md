# 验证原始日志（本卡 t_984b3cfc 第四轮返工）

全部是**命令的原始 stdout / stderr**（不是手工汇总），跑在本次送审 HEAD 前的工作树上
（代码即送审内容；`worker/amsg/worker.bundle.js` 由同一次 `pnpm run build` 重新生成）。
读取方式：`gunzip -c <file>.gz`。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| `vitest-full.log.gz`（全量原始） | `pnpm exec vitest run` | **624 文件 / 7606 用例通过，`EXIT:0`**（212.7s） |
| `focused.log.gz` | `pnpm exec vitest run worker/amsg/src/autonomyFire.test.ts worker/amsg/src/autonomyFire.integration.test.ts worker/amsg/src/autonomyLife worker/amsg/src/travel worker/amsg/src/autonomyScheduler.test.ts worker/amsg/src/autonomyStore.test.ts worker/amsg/src/planLifecycle.wiring.test.ts worker/amsg/src/index.test.ts worker/amsg/src/autonomyRetry.sqlite.test.ts utils/autonomyLife` | **42 文件 / 891 用例通过，`EXIT:0`** |
| `tsc-current.log.gz` / `tsc-baseline.log.gz` / `tsc-compare.txt` | `pnpm exec tsc -p tsconfig.json --noEmit`（当前 vs 基线 `f7f040c7`） | 两边各 **56 条**；归一化 worktree 路径后逐行 diff **为空**（`EXIT:2` 是既有基线的同值退出码） |
| `build.log.gz` | `pnpm run build`（= `build:workers` + `vite build`） | `EXIT:0`（worker bundle 重新生成，vite built in 2m 13s） |
| `e2e-run.log.gz` / `e2e-report.json.gz` / `e2e-http-requests.json.gz` | `AUTONOMY_E2E_EVIDENCE=/tmp/ev/e2e node scripts/autonomy-e2e/run.mjs` | **40/40 checks，`EXIT:0`**（真 Chromium + 真 HTTP + 真 SQLite/IDB） |
| `legacy-grep.log.gz` | `bash scripts/autonomy-legacy-grep-audit.sh` | 按**实际入口**逐个列：AIRP 调度/fire、出行 tick/模型端口/愿望落库、旧护栏账本、手机自动刷新、旧频率编辑、外部占位、新闸落点 |

本轮新增/加强的用例（都在上面 focused / full 里）：

- `worker/amsg/src/autonomyFire.integration.test.ts`：输出效果的**一次性执行门**（顺序回放、
  并发回放、旧形状 state、伪造 owner、伪造凭据 id、换角色凭据、已释放、已过期、认领写失败、
  认领记录可追溯）+ **通知上限**（0 / 排队后收紧 / 成功 +1 后被挡）+ **出行愿望**
  （未授权零愿望 / 授权落一条并占 kind 配额 / 暂停后零愿望），全部真 SQLite + 真 handler。
- `worker/amsg/src/autonomyLife/legacyGate.test.ts`：统一配额（通知 0、两角色抢最后一格、
  并发抢一格、travel.wish 未授权/额度 1/暂停）——真 SQLite。
- `worker/amsg/src/travel/legacyGate.integration.test.ts`：出行 tick 的真集成负例/正例
  （7 种拒绝场景零模型请求零愿望、中途暂停仍被拦、允许时 `used_calls`/`used_tokens` 进统一预算）。

这些文件同时作为任务附件上传（`kanban_attachments`）；入库是为了让复审在任何时候都能
`git show` 到同一份字节，不受 scratch 清理影响。
