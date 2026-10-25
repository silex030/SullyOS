# 验证原始日志（本卡 t_984b3cfc 第七轮返工）

全部是**命令的原始 stdout / stderr**（不是手工汇总），跑在本次送审 HEAD 前的工作树上
（代码即送审内容；`worker/amsg/worker.bundle.js` 由同一次 `pnpm run build` 重新生成）。
读取方式：`gunzip -c <file>.gz`。清单与 sha256 见 `MANIFEST-r7.txt`
（前几轮的 `MANIFEST-r5.txt` / `MANIFEST-r6.txt` 保留对照）。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| `vitest-full.log.gz`（全量原始） | `npx vitest run` | **624 文件 / 7641 用例通过，`EXIT:0`**（115.2s） |
| `focused.log.gz` | `npx vitest run worker/amsg/src/autonomyFire.test.ts worker/amsg/src/autonomyFire.integration.test.ts worker/amsg/src/autonomyLife worker/amsg/src/travel worker/amsg/src/autonomyScheduler.test.ts worker/amsg/src/autonomyStore.test.ts worker/amsg/src/planLifecycle.wiring.test.ts worker/amsg/src/index.test.ts worker/amsg/src/autonomyRetry.sqlite.test.ts utils/autonomyLife` | **42 文件 / 926 用例通过，`EXIT:0`** |
| `tsc-current.log.gz` / `tsc-baseline.log.gz` / `tsc-compare.txt` | `npx tsc --noEmit -p tsconfig.json`（当前 vs 基线 `f7f040c7`） | 两边各 **56 条**；归一化 worktree / 基线临时目录路径后逐行 diff **为空**（`EXIT:2` 是既有基线的同值退出码）；本卡范围 **0 条** |
| `build.log.gz` | `pnpm run build`（= `build:workers` + `vite build`） | `EXIT:0`（worker bundle 重新生成，vite built in 1m 12s；`grep -c consumeExternalQuotaAtomic worker/amsg/worker.bundle.js` = 3） |
| `e2e-run.log.gz` / `e2e-report.json.gz` / `e2e-http-requests.json.gz` | `AUTONOMY_E2E_EVIDENCE=<scratch>/r7/e2e node scripts/autonomy-e2e/run.mjs` | **40/40 checks，`EXIT:0`**（真 Chromium + 真 HTTP + 真 SQLite/IDB；含第三方只读窗口正向、「撤权/暂停后同一许可被拒」、授权额度耗尽第二笔 429） |
| `legacy-grep.log.gz` | `bash scripts/autonomy-legacy-grep-audit.sh` | 按**实际入口**逐个列（本轮新增第 12/13 项）：旧 `consumeExternalQuota(limit)` 的定义与调用 **0 命中**，唯一入口 `consumeExternalQuotaAtomic`；旧频率编辑 / `external_window_not_implemented` / 旧 `autonomyLife/client.ts` 仍 0 命中 |
| `mutation-old-quota.log.gz` | 把 `routes.ts` 的额度核销临时改回「旧 `grant.dailyQuota` + `used < limit`」，再跑 `npx vitest run worker/amsg/src/autonomyLife/wiring.test.ts -t "许可 CAS 之后"` | **4 failed / 28 skipped，`EXIT:1`**（RED：收紧额度/撤权/暂停四个用例全部失败）→ 还原后同一命令 **4 passed，`EXIT:0`**（GREEN）。证明这些用例真的钉住本轮修复，而不是恒真断言 |
| `runtime-audit.md.gz` | 见 [`../runtime-audit.md`](../runtime-audit.md) | 实现/返工会话（含崩溃 run 与 run 101）的 `model` = `deepseek-v4.1-flash`、`billing_provider` = `opencode-go`；§5 如实记录了 run 99 的 shell 看板写删与 delegate 上下文保护绕过，并给出本轮的做法与能力限制 |

## 第七轮新增 / 加强的用例

- `worker/amsg/src/autonomyLife/wiring.test.ts`（真 SQLite + 真路由，32 例，本轮 +6）：
  - `beforeStatement` 钩子精确卡在「**许可 CAS（`UPDATE autonomy_life_actions`）成功之后、
    任何 `autonomy_life_external_usage` 语句之前**」，注入另一台设备的写入：
    - `dailyQuota` 收紧到 0（**不动 revision**）→ `/external/read` 429、`/external/wish` 429，
      `fetch` 零调用、愿望零新增、`external_usage` 零占用（证明不是按读边界时的旧额度放行）；
    - 撤权 `externalGrants=[]`（bump revision）→ 两端点 409 `boundary_changed`；
    - 账号 `globalPaused=true`（bump revision）→ 读取 409 零出网、愿望 409 零新增；
  - 正向：授权额度 1 时第一笔 200（只出网一次）、第二笔 429；
  - 并发：两笔同时抢最后一格 → 恰好一个 200、一个 429，`used=1`（不超卖）；
  - 许可被消费但额度这一关拒绝时，动作 `permitConsumedAt` 已写入（见 execution-audit §6 residual 16）。
- `external.test.ts`：删掉已被删除的 `consumeExternalQuota(旧 limit)` 的单测（该函数的额度语义
  现在只在 `store.consumeExternalQuotaAtomic` 一处实现，由上面路由级与 `legacyGate` 级用例覆盖）。

前几轮的用例仍在同一批日志里（一次性执行门、通知上限、执行期时钟、出行 grant/额度/TTL、
per-kind 单次计数等）。
