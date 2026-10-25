# 验证原始日志（本卡 t_33546864 第十轮整改）

全部是**命令的原始 stdout / stderr**（不是手工汇总），跑在交付 HEAD 的工作树上
（`worker/amsg/worker.bundle.js` 由同一次 `pnpm run build` 重新生成）。读取方式：
`gunzip -c <file>.gz`。清单与 sha256 见 `MANIFEST-r10.txt`（r5–r9 保留对照）。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| `focused-r10.log.gz` | 定向：`vitest run` 覆盖 `utils/autonomyLife`、`worker/amsg/src/autonomyLife`、`autonomyFire*`、`travel`、`autonomyScheduler/Store/Retry`、`planLifecycle.wiring`、`index`、`components/autonomy-life` | **52 文件 / 1024 用例通过，`EXIT:0`** |
| `vitest-full-r10.log.gz` | 全仓 `vitest run`（默认 5s 超时） | **632 文件 / 7718 用例通过，`EXIT:0`**（本轮无超时抖动） |
| `tsc-current-r10.log.gz` / `tsc-compare-r10.diff` | `npx tsc --noEmit -p tsconfig.json`（与 `tsc-baseline.log.gz` = `f7f040c7` 基线对比） | 两边各 **56 条 `error TS`**；只归一化两处工作树根路径后逐行 diff **为空**（`tsc-compare-r10.diff` 0 字节）；本卡新增 **0**。**不是类型检查全绿** |
| `build-r10.log.gz` | `pnpm run build`（`build:workers` + `vite build`） | `EXIT:0`（vite built in 54.9s；worker bundle 重新生成且入库） |
| `e2e-run-r10.log.gz` / `e2e-report-r10.json.gz` / `e2e-http-requests-r10.json.gz` | `node scripts/autonomy-e2e/run.mjs`（真 Chromium + 真 worker 路由 + node:sqlite + 原生 IndexedDB + 真实 https 只读） | **91/91 checks，`EXIT:0`**；保留 r9 的 74 项，新增 17 项（见下） |
| `ui-autonomy-activity-r10.png` / `ui-autonomy-boundary-allowed-r10.png` / `ui-autonomy-boundary-paused-r10.png` | 场景 8 的三张截图（无 CSS 的 headless 页面，**版式不代表 App 真机外观**，证据以 DOM 断言为准） | 活动页含生产链那一单；边界页「总暂停」允许→点击→已暂停 |
| `legacy-grep-r10.log.gz` | `bash scripts/autonomy-legacy-grep-audit.sh` | 旧频率编辑 / `phoneAutoRefresh` / `external_window_not_implemented` / 旧 `autonomyLife/client.ts` / 旧 `consumeExternalQuota(limit)` 全 **0 命中**；`EXIT:0` |

## 第十轮（复审第 2 轮）新增 / 加强的用例

1. **日程 → 睡眠窗的结构化解析**（`utils/autonomyLife/personaSignal.test.ts` 13、`rhythm.ts`）
   - `sleepWindowFromSlots` 只认「明确睡眠活动」或「夜间休息」；午休/白天休息/普通上班/起床
     永远不产生睡眠窗；跨零点按次日早间锚点算结束；推不出结束或不足 1 小时 → 不硬造。
   - `buildRhythmProfile` 不再「取日程文本第一段 HH:mm-HH:mm」：只认带睡眠标记的段
     （`睡觉/就寝/入睡/作息/卧床`），并优先使用结构化睡眠窗。
   - `worker/amsg/src/autonomyLife/productionChain.test.ts`（11）从 `handleAutonomyLifeScheduled`
     入口跑三类真实日程：只有工作/起床（→ 23:00–08:00 兜底，白天 `isAsleep=false`、夜间 true）、
     午休+夜睡（→ 23:30–07:00）、跨午夜（22:00–07:00），并验证「人设说早睡早起也不能覆盖
     日程里的明确睡眠」。
2. **能力探测的主机/授权边界**（`worker/amsg/src/autonomyLife/capabilityProbes.test.ts` 8；`tick.ts`）
   - 新增 `authorizeProbe`：暂停、kind 未开、端点未配、URL 不安全、**运营白名单不含目标主机**、
     授权缺失/过期、**grant.allowedHosts 不含目标主机**、read 模式无 `read:search` → 一律不探。
   - `isEndpointConfigured` 现在也要求目标主机在运营白名单里（此前只看「白名单非空」）。
   - 可达性缓存按「端点 + 授权指纹」分键：换授权/撤权后不会命中上一次的「可达」。
   - `productionChain.test.ts` 用真实调度入口 + spy fetch 证明：上面 6 类拒绝场景
     **零网络请求**（同时断言 tick 真的执行到模型失败，不是被 `not_registered` 短路），
     合法配置才有 1 次 GET，10 分钟 TTL 内第二次 tick 不重复出网。
3. **真实 UI 组件证据**（`scripts/autonomy-e2e/harness-entry.ts`、`run.mjs` 场景 8）
   - 联调页现在 `createRoot` 挂载仓库里的 `components/autonomy-life/AutonomyLifePanel`
     （活动页 + 边界页都是组件本身渲染的 DOM），API 是本轮真实 worker 路由。
   - 断言：`role=dialog` 标题、活动页出现场景 6 生产链排出的「点外卖」卡片、
     「OS 内模拟订单，不是现实订单」徽标、以及该动作 `reasonSummary` 出现在组件文本里
     （不是「有任意一条活动」）。
   - 边界页：无任何频率/间隔输入控件（控件层证据）+ 只读提示；点组件自己的 `role=switch`
     「总暂停」→ 真的发出 `POST /pause` 200 → 开关 `aria-checked=false`、文案「已暂停」；
     随后设备候选 409、`/tick` 跳过（`account_disabled`）、动作数不变；再点一次恢复
     （第二次 `/pause` 200）。

## 第十轮顺带修掉的两个阻塞「UI 边界交互」的真实缺陷

- `utils/autonomyLife/service.ts`：`/pause` 以前把 store 原始行当 `state` 回包（缺
  `schemaVersion`/`budget`），客户端按契约判 `malformed`，于是用户按了暂停界面报格式错误；
  账号级暂停也不回状态。现在统一投影成合法的 `CharacterLifeState`，并把真实暂停
  （`accounts.paused` / `pauseRequestedAt`）叠到 `availability`/`reasonCodes` 与
  `GET /boundaries` 的 `effective.globalPaused` 上（与 `runtime.boundaryFor` 同一口径）。
- `utils/autonomyLife/api.ts` + `store.ts` + `contracts`：`PausePayload.state` 允许缺省
  （账号级暂停且该角色还没有状态行时服务端确实没有那一行），客户端不再因此判格式错误；
  store 在账号级暂停时也带上 `charId`，以便拿到这个角色的最新状态。

第九轮及更早的日志、清单原样保留（下面这份是历史记录，未覆盖）。

---

# 验证原始日志（本卡 t_33546864 第九轮整改：历史，保留对照）

全部是**命令的原始 stdout / stderr**（不是手工汇总），跑在交付 HEAD `56d82eeb` 的工作树上
（`worker/amsg/worker.bundle.js` 由同一次 `pnpm run build` 重新生成）。读取方式：
`gunzip -c <file>.gz`。清单与 sha256 见 `MANIFEST-r9.txt`（r5–r8 保留对照）。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| `focused-r9.log.gz` | 定向：`vitest run utils/autonomyLife worker/amsg/src/autonomyLife` + 既有 42 文件集合 | **49 文件 / 987 用例通过，`EXIT:0`** |
| `vitest-full-r9.log.gz` | 全仓 `vitest run`（默认 5s 超时，共享机器负载 ~18） | **631 文件 / 7698 通过 / 4 超时失败**（`storageOptimize` ×3、`travelBackupSecrets` ×1，均为 5s 超时/维护锁，两个模块与本次改动无依赖；见下行） |
| `vitest-full-r9-timeout60.log.gz` | 全仓 `vitest run --testTimeout=60000`（同一份代码、同一时刻） | **631 文件 / 7702 用例通过，`EXIT:0`**（证明那 4 条只是 5s 超时抖动，不是逻辑失败） |
| `tsc-current-r9.log.gz` / `tsc-compare-r9.diff` | `npx tsc --noEmit -p tsconfig.json`（与 r8 基线 `tsc-baseline.log.gz` 对比） | 两边各 **56 条 `error TS`**；归一化绝对路径后逐行 diff **为空**（`tsc-compare-r9.diff` 0 字节）；本卡新增 **0** |
| `build-r9.log.gz` | `pnpm run build` | `EXIT:0`（worker bundle 重新生成；vite built in 2m 8s） |
| `e2e-run-r9.log.gz` / `e2e-report-r9.json.gz` / `e2e-http-requests-r9.json.gz` | `node scripts/autonomy-e2e/run.mjs`（真 Chromium + 真 worker 路由 + node:sqlite + 原生 IndexedDB + 真实 https 只读） | **74/74 checks，`EXIT:0`**；含两条**不 seed 目标动作**的生产链路场景（6：真实目录候选 → tick → 执行 → 既有业务表/UI；7：外部只读配置+授权+可达） |

第九轮新增/加强的用例（全部从生产入口进，不注入预设 profile/候选）：

- `worker/amsg/src/autonomyLife/productionChain.test.ts`（9）：`handleAutonomyLifeScheduled`
  同角色/同种子/同时间早鸟 vs 夜猫 → 睡眠窗与下次机会不同；换当天日程 profile 落库更新；
  空模板 fallback；`POST /proposals` → 生产 tick 排出外卖/购物（参数逐字一致、额度核销、候选回收）；
  超上限/类目/kind/暂停 422/422/403/409；外部只读三者成立才排出、三种不成立都排不出。
- `utils/autonomyLife/engine.personaMarket.test.ts`（10）：人设失效重建、`personaFor` 抛错不判死、
  模型失败 + 设备候选仍排单、消费额度计划期核销、超单笔上限零写入、外部候选的能力门。
- `utils/autonomyLife/marketCatalog.test.ts`（10）/ `marketProposalSource.test.ts`（6）/
  `worker/amsg/src/autonomyLife/proposals.test.ts`（7）：真实目录价格、额度门槛、上报节流、
  服务端整包校验、D1 幂等/隔离/过期/回收。
- `utils/autonomyLife/personaSignal.test.ts`（7）/ `ambientCandidates.test.ts`（4）：日程→睡眠窗
  （「睡觉」不能变成「起床」）、人设哈希、外部候选只取兴趣标签。

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
