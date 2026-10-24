# 验证原始日志（本卡 t_984b3cfc 第五轮返工）

全部是**命令的原始 stdout / stderr**（不是手工汇总），跑在本次送审 HEAD 前的工作树上
（代码即送审内容；`worker/amsg/worker.bundle.js` 由同一次 `pnpm run build` 重新生成）。
读取方式：`gunzip -c <file>.gz`。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| `vitest-full.log.gz`（全量原始） | `npx vitest run` | **624 文件 / 7624 用例通过，`EXIT:0`**（214.3s） |
| `focused.log.gz` | `npx vitest run worker/amsg/src/autonomyFire.test.ts worker/amsg/src/autonomyFire.integration.test.ts worker/amsg/src/autonomyLife worker/amsg/src/travel worker/amsg/src/autonomyScheduler.test.ts worker/amsg/src/autonomyStore.test.ts worker/amsg/src/planLifecycle.wiring.test.ts worker/amsg/src/index.test.ts worker/amsg/src/autonomyRetry.sqlite.test.ts utils/autonomyLife` | **42 文件 / 909 用例通过，`EXIT:0`** |
| `tsc-current.log.gz` / `tsc-baseline.log.gz` / `tsc-compare.txt` | `npx tsc --noEmit -p tsconfig.json`（当前 vs 基线 `f7f040c7`） | 两边各 **56 条**；归一化 worktree / 基线临时目录路径后逐行 diff **为空**（`EXIT:2` 是既有基线的同值退出码）；本卡范围 **0 条** |
| `build.log.gz` | `pnpm run build`（= `build:workers` + `vite build`） | `EXIT:0`（worker bundle 重新生成，vite built in 1m 33s；`grep -c autonomy_life_effect_claims worker/amsg/worker.bundle.js` = 5） |
| `e2e-run.log.gz` / `e2e-report.json.gz` / `e2e-http-requests.json.gz` | `AUTONOMY_E2E_EVIDENCE=/tmp/r5-e2e node scripts/autonomy-e2e/run.mjs` | **40/40 checks，`EXIT:0`**（真 Chromium + 真 HTTP + 真 SQLite/IDB） |
| `legacy-grep.log.gz` | `bash scripts/autonomy-legacy-grep-audit.sh` | 按**实际入口**逐个列：AIRP 调度/fire、出行 tick/模型端口/愿望落库、旧护栏账本、手机自动刷新、旧频率编辑、外部占位、新闸落点；旧频率编辑 / `external_window_not_implemented` / 旧 `autonomyLife/client.ts` 均 0 命中 |

## 第五轮新增 / 加强的用例

- `worker/amsg/src/autonomyFire.integration.test.ts`（真 SQLite + 真 handler，22 例）：
  - 一次性执行门：顺序回放、并发回放、旧形状 state、伪造 owner、伪造凭据 id、换角色凭据、
    已释放、已过期、认领写失败、认领记录可追溯；
  - **执行期时钟**：state 与 `expires_at` 都不动、只把执行时钟推过 6h TTL → 第一次输出也进不来
    （零经历 / 零下发 / 零认领）；**跨日执行** → 通知额度落在 `w:2026-10-25`，旧窗口 0；
  - 通知上限：0 / 排队后收紧 / **读完边界后收紧+暂停（钩子注入）** / 成功 +1 后被挡；
  - 出行愿望：未授权零愿望、无 amap 授权零愿望、**读完边界后撤授权零愿望**、
    授权时落一条并占 kind 配额、模型跑完那一刻暂停零愿望。
- `worker/amsg/src/autonomyLife/legacyGate.test.ts`（真 SQLite，23 例）：
  通知额度 0、两角色抢最后一格、并发抢一格、`travel.wish` 未授权 / 额度 1 / 暂停不占额；
  **本轮新增**：缺 amap 授权、授权到期、授权窗口额度 0 / 耗尽、
  `beforeStatement` 注入「收紧通知额度+暂停」与「撤 amap 授权」→ `boundary_changed` 且零预算行。
- `worker/amsg/src/travel/legacyGate.integration.test.ts`（真 SQLite + 真 tick，17 例）：
  8 种拒绝场景零模型请求零愿望（含「没有 amap 外部授权」「授权到期」）、额度 0 时模型可问但愿望不落、
  **模型返回那一刻暂停 / 关角色 / 新增禁区 / 撤授权 → 零愿望（模型调用照常记账）**、
  结算失败 fail closed、允许时 `used_calls=1` / `used_tokens=321` 进统一预算。

这些文件同时作为任务附件上传（`kanban_attachments`）；入库是为了让复审在任何时候都能
`git show` 到同一份字节，不受 scratch 清理影响。
