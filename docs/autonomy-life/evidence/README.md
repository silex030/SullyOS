# 验证原始日志（本卡 t_984b3cfc 第六轮返工）

全部是**命令的原始 stdout / stderr**（不是手工汇总），跑在本次送审 HEAD 前的工作树上
（代码即送审内容；`worker/amsg/worker.bundle.js` 由同一次 `pnpm run build` 重新生成）。
读取方式：`gunzip -c <file>.gz`。清单与 sha256 见 `MANIFEST-r6.txt`。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| `vitest-full.log.gz`（全量原始） | `npx vitest run` | **624 文件 / 7636 用例通过，`EXIT:0`**（166.0s） |
| `focused.log.gz` | `npx vitest run worker/amsg/src/autonomyFire.test.ts worker/amsg/src/autonomyFire.integration.test.ts worker/amsg/src/autonomyLife worker/amsg/src/travel worker/amsg/src/autonomyScheduler.test.ts worker/amsg/src/autonomyStore.test.ts worker/amsg/src/planLifecycle.wiring.test.ts worker/amsg/src/index.test.ts worker/amsg/src/autonomyRetry.sqlite.test.ts utils/autonomyLife` | **42 文件 / 921 用例通过，`EXIT:0`** |
| `tsc-current.log.gz` / `tsc-baseline.log.gz` / `tsc-compare.txt` | `npx tsc --noEmit -p tsconfig.json`（当前 vs 基线 `f7f040c7`） | 两边各 **56 条**；归一化 worktree / 基线临时目录路径后逐行 diff **为空**（`EXIT:2` 是既有基线的同值退出码）；本卡范围 **0 条** |
| `build.log.gz` | `pnpm run build`（= `build:workers` + `vite build`） | `EXIT:0`（worker bundle 重新生成，vite built in 2m 5s；`grep -c autonomy_life_effect_claims worker/amsg/worker.bundle.js` = 5，`consumeExternalQuotaAtomic` = 2） |
| `e2e-run.log.gz` / `e2e-report.json.gz` / `e2e-http-requests.json.gz` | `AUTONOMY_E2E_EVIDENCE=<scratch>/r6/e2e node scripts/autonomy-e2e/run.mjs` | **40/40 checks，`EXIT:0`**（真 Chromium + 真 HTTP + 真 SQLite/IDB；含第三方只读窗口正向与「撤权/暂停后同一许可被拒」） |
| `legacy-grep.log.gz` | `bash scripts/autonomy-legacy-grep-audit.sh` | 按**实际入口**逐个列：AIRP 调度/fire、出行 tick/模型端口/愿望落库、旧护栏账本、手机自动刷新、旧频率编辑、外部占位、新闸落点；旧频率编辑 / `external_window_not_implemented` / 旧 `autonomyLife/client.ts` 均 0 命中 |
| `runtime-audit.md.gz` | 见 [`../runtime-audit.md`](../runtime-audit.md) | 实现/返工会话（含崩溃 run）的 `model` = `deepseek-v4.1-flash`、`billing_provider` = `opencode-go`；`hermes config set` / 网关启动 / 部署 0 命中 |

## 第六轮新增 / 加强的用例

- `worker/amsg/src/travel/legacyGate.integration.test.ts`（真 SQLite + 真 tick，24 例，本轮 +7）：
  - **per-kind 只占一格**：真 tick 额度 1 → 一条愿望、`kind_counts['travel.wish']=1`、授权额度 1、
    `used_calls=1`；第二次端口直调在**调模型之前**被拒；
  - 模型 `none` / 端口抛错 → 不占 kind、不落愿望；
  - **TTL 到期**（state / `expires_at` 不变、只把执行时钟推过 7h）：intent 真 tick → 零愿望、
    凭据仍 `held`、`used_calls=0`；`choose` / `nextSegment` 同口径负例（零效果许可）；
  - 期限内 `choose` / `nextSegment` 正向（各签出一次效果许可）；
  - **授权额度最终核销**：kind 核销后、`external_usage` UPDATE 前收紧额度（同 revision）→
    `external_quota_exhausted`、额度零新增；撤权/暂停 → `boundary_changed`、额度零新增。
- `worker/amsg/src/autonomyLife/legacyGate.test.ts`（真 SQLite，27 例，本轮 +4）：
  正向 kind=1 / 额度=1；收紧额度（不 bump revision）→ 按当前 payload 额度拒；
  撤权 / 暂停（bump revision）→ `boundary_changed`；额度 1 时第二笔被同一条语句挡住。
- `worker/amsg/src/autonomyFire.integration.test.ts`（真 SQLite + 真 handler，23 例，本轮 +1）：
  kind 核销后、授权额度核销前收紧 amap 额度 → 零愿望、`autonomy_life_external_usage` 零新增，
  其余产物照常。

前几轮的用例仍在同一批日志里（`autonomyFire.integration` 的一次性执行门 / 通知上限 / 执行期时钟，
`legacyGate.test` 的授权与竞态注入，`travel/legacyGate.integration` 的 8 种拒绝场景与模型返回后的效果门）。

这些文件同时作为任务附件上传（`kanban_attachments`）；入库是为了让复审在任何时候都能
`git show` 到同一份字节，不受 scratch 清理影响。
