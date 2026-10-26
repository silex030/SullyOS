# 自主生活 · 第十轮整改交付说明（总卡 t_33546864，复审第 2 轮）

范围：**只做复审第 2 轮点名的三条 P1**，以及为拿到「真实 UI 边界交互」证据而必须修掉的
两个接口契约缺陷。没有新增人工频率设置、没有扩大角色权限、没有改模型/提供方、没有部署、
没有合主干、没有动 default profile 或全局配置。

## 1. P1-a 日程 → 睡眠窗的结构化解析

**问题**：`personaSignal.scheduleTextFromSlots` 在没有睡眠 slot 时仍把普通活动渲染成
`HH:mm-HH:mm`，`rhythm.buildRhythmProfile` 又无条件把日程文本第一段范围当整夜睡眠
（「09:00 上班 / 18:00 下班」→ 睡眠 09:00–18:00，白天长期休息）；`SLEEP_SLOT_RE` 里的
「休息」还会让 12:00 午休抢在 23:30 睡觉前面。

**改动**

- `utils/autonomyLife/personaSignal.ts`
  - 新增 `sleepWindowFromSlots()`：候选只来自「明确睡眠活动（睡觉/就寝/入睡/睡眠/睡下/熟睡/安睡）」
    或「夜间（≥20:00 或 ≤06:00）的休息/小憩」；同类里优先夜间、再优先更长；结束时刻取
    下一条开始（跨零点 +24h），睡眠是最后一条时用次日早间第一条作为起床锚点；推不出结束
    或时长 < 1 小时 → 返回 `null`（不硬造）。
  - `scheduleTextFromSlots()` 只在确实推出睡眠窗时渲染并前置换成「睡觉」行；否则按时序
    输出普通活动，午休保持「午休」。
  - `PersonaSignal` 增加结构化 `sleepWindow`；新增 `sleepWindowFromScene()`（与
    `scheduleTextFromScene` 共用同一条「只看当天」门槛）。
- `utils/autonomyLife/rhythm.ts`：`BuildProfileInput.scheduleSleepWindow` 可选；文本兜底
  改为**只认带睡眠标记的段**（`睡/就寝/入睡/作息/卧床/安眠`），不再取「第一段时间范围」。
- `worker/amsg/src/autonomyLife/tick.ts` + `runtime.ts` + `utils/autonomyLife/engine.ts`：
  生产入口把 `sleepWindowFromScene(...)` 经 runtime 传到 `buildRhythmProfile`，结构化优先。

**验收**（`worker/amsg/src/autonomyLife/productionChain.test.ts`，从 `handleAutonomyLifeScheduled` 进）

| 日程 | 断言 |
| --- | --- |
| 07:00 起床 / 09:00 上班 / 18:00 下班 | `sleepWindows[0] = {23:00, 08:00}`（兜底），12:00 `isAsleep=false`、01:00 `isAsleep=true` |
| 07:00 起床 / 09:00 上班 / 12:00 午休 / 18:00 下班 / 23:30 睡觉 | `{23:30, 07:00}`，午休不抢整夜；人设「早睡早起」也不覆盖日程明确睡眠 |
| 07:00 起床 / 09:00 上班 / 22:00 睡觉 | `{22:00, 07:00}`（跨午夜），12:00 醒着、23:00 在睡 |

另保留第九轮已有的：真实人设变更 → profile 版本更新/落库、缺信息才 fallback、确定性对照。

## 2. P1-b 可达性探测的主机/授权边界

**问题**：`isEndpointConfigured` 只判断「白名单非空 + URL 结构安全」，`resolveProbes` 只看
「同 provider grant 未过期」，随后 `probeEndpointOnce` 直接 GET。于是
`readHosts=['allowed.example']` + `endpoint=https://other.example/` + 一张有效但只授权
`allowed.example` 的 grant，仍会向 `other.example` 发探测请求 —— 正式 `/external/read`
之外的**新出网口**。

**改动**

- `capabilityProbes.isEndpointConfigured`：目标主机必须真的在运营白名单里。
- 新增 `authorizeProbe()`（与正式 read 出口同一套判定）：暂停、kind 未开、端点未配、
  URL 不安全、运营白名单不含主机、grant 缺失/provider 不符、过期、`grant.allowedHosts`
  不含主机、read 模式 scopes 非空但无 `read:search` → 返回具体拒绝原因，**不发请求**。
- `createReachabilityProbe`：缓存键 = 端点 + **授权指纹**（主机/有效期/授权主机/scopes/mode），
  撤权或换授权不会命中旧的「可达」。
- `resolveProbes`：先 `authorizeProbe` 再探测，并显式接收 `paused`；拒绝原因写入
  `capability.reason`（UI 能区分「没配」「没授权」「暂停」）。
- 探测语义（写进代码注释与 README）：独立健康检查，只发一次 GET、不跟随重定向、不读 body、
  不带 query、不落内容；每端点每授权 10 分钟最多 1 次、每次 3s 超时、每跳最多两个端点；
  **不消耗** `external_usage` 每日读取额度，也不进模型预算。

**验收**（`capabilityProbes.test.ts` 8 条 + `productionChain.test.ts` 真实入口 + spy fetch）

- 运营主机不符 / grant 主机不符 / scope 不符 / 已过期 / 已撤权 / 账号暂停 → **0 次 fetch**，
  且断言 tick 确实执行到（`status: 'ticked'` 或 `skipped: account_disabled`），不是被
  `not_registered` 之类短路出来的假阴性。
- `resolveProbes({paused:true})` → 0 次 fetch，`reason: 'paused'`。
- 全部成立 → 1 次 GET 到 `https://allowed.example/read`；同进程 10 分钟 TTL 内第二次 tick
  仍为 1 次（有界）。

## 3. P1-c 真实 UI 组件证据（不是「API + 标签映射」）

**问题**：`readUiView` 只是 `GET /activities` + `KIND_LABELS` 组装普通对象，没有渲染任何组件。

**改动**（`scripts/autonomy-e2e/harness-entry.ts`、`run.mjs` 场景 8）

- 用 `react-dom/client` 的 `createRoot` 挂载仓库里的 `components/autonomy-life/AutonomyLifePanel`
  （活动页 `ActivityTab`、边界页 `BoundaryTab` 都是组件自己渲染），`api` 指向本轮真实
  worker 路由；数据来自场景 6 的**生产链**（真实目录候选 → `handleAutonomyLifeScheduled`
  → 真实执行器 → `shopping_orders` / `bank_transactions` / 回执），**不为 UI 单独 seed 动作**。
- DOM 断言：`role=dialog` 标题含角色名；活动页出现「点外卖」卡片、
  「OS 内模拟订单，不是现实订单」徽标，且该动作的 `reasonSummary` 出现在组件文本里
  （对齐到具体 actionId，而不是「有任意一条活动」）。
- 边界页：所有 `input/select/textarea` 的标签都不含频率/间隔（控件层证据），并有
  「不提供人工频率输入」只读提示；点组件自己的 `role=switch`「总暂停」→
  `POST /pause` 200 → 开关 `aria-checked=false` +「已暂停」；随后设备候选 409、
  `/tick` 跳过（`account_disabled`）、动作数不变；再点一次恢复（第二次 `/pause` 200）。
- 截图三张（`ui-autonomy-activity-r10.png` 等）。**页面没有 Tailwind CSS，截图版式不代表
  App 真实外观**，只作为「组件确实渲染出这些节点」的可视化旁证，验收以 DOM 断言与请求日志为准。

## 4. 为打通 UI 边界交互顺带修掉的两个真实缺陷（不是范围扩张）

- `/pause` 回包里的 `state` 以前是 store 原始行：缺 `schemaVersion`/`budget`，客户端按契约
  判 `malformed` → 用户点了暂停看到格式错误、开关不翻；账号级暂停且该角色还没状态行时
  干脆没有 `state`。现在 `utils/autonomyLife/service.ts` 统一投影成合法
  `CharacterLifeState`，并把真实暂停（`accounts.paused` / `pauseRequestedAt`）叠到
  `availability`/`reasonCodes` 以及 `GET /boundaries` 的 `effective.globalPaused` 上，
  与 `runtime.boundaryFor` 同一口径（此前「tick 认为暂停、界面认为允许」）。
- `PausePayload.state` 改为可选（contracts + api.ts），store 在账号级暂停时也带 `charId`
  以取到该角色状态；缺 `state` 不再被当成格式错误。

## 5. 实测证据（原始日志在 `docs/autonomy-life/evidence/`，清单 `MANIFEST-r10.txt`）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 定向 | `vitest run`（autonomyLife / autonomyFire / travel / scheduler / components/autonomy-life 等 52 文件） | **1024 用例通过，EXIT 0** |
| 全量 | `vitest run` | **632 文件 / 7718 用例通过，EXIT 0** |
| 类型 | `tsc --noEmit -p tsconfig.json` vs `f7f040c7` 基线 | 各 **56 条**既有错误；归一化两处根路径后逐行 diff **为空**，本轮新增 **0**（**不是全绿**） |
| 构建 | `pnpm run build` | EXIT 0，`worker/amsg/worker.bundle.js` 重新生成并入库 |
| 联调 | `node scripts/autonomy-e2e/run.mjs`（真 Chromium/真路由/真 SQLite/原生 IDB/真实 https 只读） | **91/91，EXIT 0**（保留 r9 的 74 项，新增 17 项） |
| 旧入口审计 | `bash scripts/autonomy-legacy-grep-audit.sh` | EXIT 0；旧频率/旧外部占位/旧 client 等 **0 命中** |

## 6. 证据层级（哪些不能从这个仓库里证明）

- **没有**生产 D1 实测、没有真机 App 外壳、没有运营方第三方端点/凭据的真实联调；
  外部只读的「真实出网」只用公开只读端点（GitHub / jsonplaceholder）证明链路与投影，
  不代表小红书/高德的实际响应结构。
- 未合 `ethernet` 主干（工作树里有其他会话未提交的改动），未部署 worker bundle；
  合并与部署由协调方在干净树上完成。
- 场景 8 的页面没有 CSS，截图只证明节点与文案；真机视觉验收需要 App 外壳。
- `tsc` 仍有 56 条历史错误（非本卡范围），因此不声称「类型全绿」。
- 认领/许可表没有 GC、D1 无跨 isolate 事务、跨设备钱包不同步等既有风险照旧。
- 历史 run 99 的保护绕过记录继续保留（见 `runtime-audit.md`），本轮未重复。

## 7. 仍未改的既有取舍（与本轮无关，如实列出）

- 旧 AIRP 回合与出行链路是「改道到统一闸门」，不是删除。
- 外部只读依赖运营配置端点 + 用户授权；`travel.wish` 需要未过期的 amap 授权。
- 平台硬禁方向（赌博等）不可由用户取消；用户只能把范围改窄。
