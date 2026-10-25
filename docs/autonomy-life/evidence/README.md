# 验证原始日志（本卡 t_984b3cfc 第八轮返工）

全部是**命令的原始 stdout / stderr**（不是手工汇总），跑在本次送审 HEAD 前的工作树上
（代码即送审内容；`worker/amsg/worker.bundle.js` 由同一次 `pnpm run build` 重新生成）。
读取方式：`gunzip -c <file>.gz`。清单与 sha256 见 `MANIFEST-r8.txt`
（前几轮的 `MANIFEST-r5.txt` / `MANIFEST-r6.txt` / `MANIFEST-r7.txt` 保留对照）。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| `vitest-full.log.gz`（全量原始） | `npx vitest run` | **624 文件 / 7649 用例通过，`EXIT:0`**（154.5s） |
| `focused.log.gz` | `npx vitest run worker/amsg/src/autonomyFire.test.ts worker/amsg/src/autonomyFire.integration.test.ts worker/amsg/src/autonomyLife worker/amsg/src/travel worker/amsg/src/autonomyScheduler.test.ts worker/amsg/src/autonomyStore.test.ts worker/amsg/src/planLifecycle.wiring.test.ts worker/amsg/src/index.test.ts worker/amsg/src/autonomyRetry.sqlite.test.ts utils/autonomyLife` | **42 文件 / 934 用例通过，`EXIT:0`**（第八轮 +8） |
| `tsc-current.log.gz` / `tsc-baseline.log.gz` / `tsc-compare.txt` | `npx tsc --noEmit -p tsconfig.json`（当前 vs 基线 `f7f040c7`） | 两边各 **56 条 `error TS`**；归一化绝对路径后逐行 diff **为空**（`EXIT:2` 与基线同值）；本卡范围 **0 条** |
| `build.log.gz` | `pnpm run build`（= `build:workers` + `vite build`） | `EXIT:0`（worker bundle 重新生成，vite built in 1m 35s；`grep -c`：`consumeExternalQuotaAtomic` = 3、`autonomy_life_effect_claims` = 5、`pauseRequestedAt` = 16） |
| `e2e-run.log.gz` / `e2e-report.json.gz` / `e2e-http-requests.json.gz` | `AUTONOMY_E2E_EVIDENCE=<scratch>/r8/e2e node scripts/autonomy-e2e/run.mjs` | **41/41 checks，`EXIT:0`**（真 Chromium + 真 HTTP + 真 SQLite/IDB；本轮新增「账号总暂停不改边界 revision（暂停落在 accounts.paused）」） |
| `legacy-grep.log.gz` | `bash scripts/autonomy-legacy-grep-audit.sh` | 按**实际入口**逐个列：旧频率编辑 / `external_window_not_implemented` / 旧 `autonomyLife/client.ts` / 旧 `consumeExternalQuota(limit)` 均 **0 命中**；唯一额度入口仍是 `consumeExternalQuotaAtomic` |
| `mutation-real-pause.log.gz` | ① 删掉 `legacyGate.readEffectiveBoundary` 的真实暂停折叠 → `npx vitest run worker/amsg/src/autonomyFire.integration.test.ts worker/amsg/src/travel/legacyGate.integration.test.ts -t "真实 POST /pause"`；② 把 `store.BOUNDARY_ATOMIC_GUARD` 的暂停条件换成恒真占位 → `npx vitest run worker/amsg/src/autonomyLife/wiring.test.ts -t "真实暂停"` | ① **4 failed / 2 passed / 47 skipped，`EXIT:1`**（AIRP 返回 `messages`、travel 模型调用 1 次）→ 还原后 **6 passed，`EXIT:0`**；② **2 failed / 32 skipped，`EXIT:1`**（请求不再在额度门被拒，走到出网被 mock fetch 拦下）→ 还原后 **2 passed，`EXIT:0`**。证明这批用例钉住本轮修复，不是恒真断言 |
| `mutation-old-quota.log.gz` | （第七轮保留）把 `routes.ts` 的额度核销临时改回旧 `grant.dailyQuota` 实现再跑 `wiring.test.ts -t "许可 CAS 之后"` | 第七轮原文：**4 failed / 28 skipped，`EXIT:1`** → 还原后 **4 passed，`EXIT:0`** |
| `runtime-audit.md.gz` | 见 [`../runtime-audit.md`](../runtime-audit.md) | run 103 会话 `20261025_083338_7461a4` 为 `deepseek-v4.1-flash` / `opencode-go`；§6 记录本轮工具直方图与六类禁用模式扫描（命中项只有审计脚本自身的正则字面量）；§5 原样保留 run 99 的 shell 看板写删与保护绕过历史 |

## 第八轮新增 / 加强的用例

- `worker/amsg/src/autonomyLife/wiring.test.ts`（+2）：注入语句与 `POST /pause` 落点**逐字一致**
  （`autonomy_life_accounts.paused=1` / `autonomy_life_characters.payload.pauseRequestedAt`），
  精确卡在「许可 CAS 之后、`external_usage` 语句之前」；read / wish 各一组 →
  409 `boundary_changed`、`fetch` 0、愿望 0、`external_usage` 0。
- `worker/amsg/src/autonomyFire.integration.test.ts`（+3）：**真路由** `POST /pause`（账号 / 角色）
  → boundaries 快照不变、`beforeFire` 直接 skip（不调模型）、预算行/经历 0；`pause:false`
  经同一入口恢复；「模型已返回、落效果前按下真实 /pause」→ 零经历/零愿望/零下发/零认领。
- `worker/amsg/src/travel/legacyGate.integration.test.ts`（+3）：wiring 建好后按真实 `/pause`
  （账号 / 角色）→ 真 tick 模型 0 次、愿望 0、预算 0；解除后恢复（模型 1 次、愿望 1 条）；
  `proposeIntent` 内 await 真实 `/pause` → 零愿望、`used_calls=1`。
- `scripts/autonomy-e2e/run.mjs`：新增 check「账号总暂停不改边界 revision（暂停落在
  accounts.paused）」→ 联调 41/41（真 Chromium 打真 worker）。

前几轮的用例仍在同一批日志里（一次性执行门、通知上限、执行期时钟、出行 grant/额度/TTL、
per-kind 单次计数、正式端点原子额度等）。
