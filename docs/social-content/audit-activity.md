# SullyOS 自由活动 / 社交内容生成 · 只读审计报告

- 仓库：`/root/SullyOS`（分支 `ethernet`，HEAD `30df593c`，工作区有未提交改动，本报告未触碰）
- 工作区：`/root/.hermes/kanban/workspaces/t_1964e5f8`
- 方式：纯静态阅读（file:line）+ 15 个既有定向单测实跑（无网络、无生产库、无真实 LLM）
- 约束遵守：未改任何功能/服务/生产数据；未跑全量测试 / tsc / build；未连接 VPS、数据库、平台接口；报告内无凭据

---

## 0. 范围界定（先消除歧义）

这个仓库里挂着「自由活动」四个字的东西有 **三套**，性质完全不同，混在一起看必然得出错误结论：

| # | 名称 | 入口 | 是否真实外部动作 | 是否被调度 | 本文定位 |
|---|------|------|------------------|-----------|----------|
| A | **自由活动 App**（`AppID.XhsFreeRoam`，小红书自由漫游） | `constants.tsx:125` 桌面图标；`apps/XhsFreeRoamApp.tsx` | **是**（真实小红书发帖/评论/回复） | **否**（纯手动按钮） | 主对象 |
| B | 彼方 VR「自由活动」 | `utils/vrWorld/runSession.ts` 自动登入 | 否（纯 LLM 叙事） | **是**（前台定时器） | 作为对照/同名冲突 |
| C | 后台自主生活（自主回合） | amsg2 `autonomous_round` | 否（叙事 + 事件落库） | **是**（云端调度） | 作为对照/交汇 |

「不是仅出行」按此落实：**出行/移动（`movement` 事件、外卖配送、地点系统）不在本文主线**，只在与自由活动/社交生成有数据交汇处（AIRP 事件投影）出现。A 的引擎自带四种动作 `post / browse / search / check_profile`（`utils/xhsFreeRoam.ts:42`），没有「出行」。

> 一个必须先记下的事实：A 和 B 在 API 调用记录里用的是**同一个 purpose 文案**「自由活动」（`utils/xhsFreeRoam.ts:88` 与 `utils/vrWorld/runSession.ts:463`）。任何按 purpose 统计调用量的口径都会把这两套混成一条（详见 §6.4）。

---

## 1. 结论速览

1. **自由活动（A）没有预算、没有冷却、没有每日次数上限**。全仓唯一带硬预算的是后台自主生活（默认 2 次/角色/天、同类间隔 120 min、全局 6 次/天、每日 token 100k）。同一个「角色自己玩」的产品语义，两套治理强度差一个数量级。
2. **A 只在整轮成功收尾时落库**：活动记录在 `try` 末尾的循环里写（`utils/xhsFreeRoam.ts:770-771`），异常路径直接 `catch` 返回 partial session（`:850-854`），**中途关页/报错 → 本轮活动全丢**。例外是发帖归属：发布成功立刻单独保存（`:560-565`）。B/C 都是逐条幂等落库，A 不是。
3. **A 会真写真实账号**：`publishNote / comment / replyComment` 直连小红书后端（`:541 / :438 / :409`），发帖无二次确认；评论/回复只允许在「自己的帖子」下（`:402 / :433` + prompt 约束 `:162`）。每轮还有两次 5 秒反爬等待（`:407`、`:436`）。
4. **A 完全不进后台调度**：amsg 的 kind 注册表只有两个 handler（`worker/amsg/src/fireKinds.ts:106-113`：门牌整理、自主回合），没有任何 xhs/free-roam 线程；`XhsFreeRoamEngine.run` 的唯一调用方是 App 按钮（`apps/XhsFreeRoamApp.tsx:150`，按钮 `:782`）。
5. 真正「到点自己动」的是 B 和 C，且都**只在页面开着时生效**（B 前台 setTimeout + 20s 轮询 `utils/vrWorld/scheduler.ts:91,107-130`；C 在云端 worker，但触发依赖 fire_pack 与客户端上云状态）。
6. **最大的隐藏调用量放大器不是自由活动，是查手机自动刷新**：`utils/phoneAutoRefresh.ts` 失败时**不写** `lastAutoRefreshAt`（`:206-213` 只在成功分支写），而 `OSContext` 每 60 秒 tick 一次（`context/OSContext.tsx:3262`）→ 持续失败时每角色每分钟一次计费调用，静态上限 1440 次/天/角色。
7. LLM 调用入口全部是「裸 `fetch` + `__sullyMeta`」，靠 `OSContext` 的全局 fetch patch 才拿到日志/流式升级/主代理中转（`context/OSContext.tsx:1142-1230`）；A 的调用**没有超时、没有 max_tokens、没有重试**（`utils/xhsFreeRoam.ts:72-89`），MCP 传输层也没有 AbortSignal（`utils/xhsMcpClient.ts:402-426`）。
8. 社交侧（Spark/SocialApp）一轮刷新 = **1 次 LLM 生成 6-8 帖 + 最多 2 张 AI 首图**（`apps/SocialApp.tsx:626-632`、`:639`），评论/回复各 1 次（`:786-792`、`:887-893`）；无每日额度、无限流，帖子**只增不删**（`utils/db.ts:1070-1074`）。
9. 自由活动与 Spark 之间**没有直接数据通道**：XHS 产物落 `xhs_activities / xhs_owned_posts`，Spark 落 `social_posts`；两者的唯一间接桥是 AIRP 事件（§5.1）。
10. 15 个定向测试文件 / **184 个用例全绿，两次运行退出码均 0**（§9）。但**自由活动引擎本体（`utils/xhsFreeRoam.ts`）零直接测试**——测试只覆盖它的纯函数邻件与 XHS 客户端。

---

## 2. 自由活动 App（A）调用链

### 2.1 入口与门

| 环节 | 证据 |
|------|------|
| App 注册 | `constants.tsx:125`（名称「自由活动」，图标 `XhsFreeRoam`，色 rose） |
| 懒加载/预载 | `components/PhoneShell.tsx:43,70,90,894`；`components/os/appPreload.ts:58` |
| 全屏壳（竖屏小程序） | `utils/safeAreaApps.ts:31` |
| 起跑门 1：MCP 已配置且开启 | `apps/XhsFreeRoamApp.tsx:78-79,118-121` |
| 起跑门 2：主 API 有 baseUrl | `:122-125` |
| 起跑门 3：单飞（`isRunning`） | `:117`；引擎侧无并发锁 |
| 起跑前探活 | `:108-113` `XhsMcpClient.testConnection`（挂载时一次） |
| 触发点 | `:782` 按钮 → `handleStart` `:116-161` → `XhsFreeRoamEngine.run` `:150` |
| 角色级门 | **无**。`char.xhsEnabled`（`utils/agenticTools.ts:110-125`）只约束聊天里的 XHS 工具，自由活动不看这个字段 |

### 2.2 引擎主流程（`utils/xhsFreeRoam.ts`）

```
run(char,user,apiConfig,realtimeConfig,callbacks)   :463
 ├─ mcpUrl 取自 realtimeConfig.xhsMcpConfig.serverUrl          :470-471
 ├─ setCookie(...)  ← 只注入 cookie，不注入 bridgeToken        :472
 ├─ resetSession() + ensureInitialized()  ← 每轮重置握手        :485-486
 ├─ DB.getXhsActivities(char,10)    ← 最近 10 条历史活动         :491
 ├─ getRecentChatContext(char, contextLimit||500)               :292-307, 492
 ├─ buildFreeRoamSystemPrompt(coreContext+时区+历史+规则)        :109-167
 ├─ callLlm(决策)                                               :497
 ├─ 分支：idle / post / search|browse / check_profile           :507 / 521 / 586 / 657
 └─ 收尾：summary → 逐条 saveXhsActivity → 写聊天系统消息/xhs_card → onComplete
                                                                 :763-847
```

关键细节：

- **上下文成本**：`ContextBuilder.buildCoreContext(char, user, true)`（`:116`）——`true` = 带详细记忆；再拼「最近对话」**原文**（`:298-303`，注释明确写 "no summarization, no truncation"）；条数取 `char.contextLimit || 500`（`:294`），而 `DB.getRecentMessagesByCharId` 只取「记忆宫殿水位 `mp_lastMsgId_*` 之上、且非群聊」的消息（`utils/db.ts:691-714`）。本地无任何缓存，每轮重建。
- **时间口径**：`resolveCharTimeZone` + `nowInTimeZone`（`:119-123`、`:129`），历史活动时间也按角色时区回显——这块做对了（`docs/character-timezone.md:52` 也把「角色自由活动」列在已接入时区清单里）。
- **动作能力**：`idle` 也算一条记录（`:507-520`），因此「什么都不做」同样会消耗 1 次 LLM 调用。
- **发帖配图**：从本地小红书图库按关键词打分选 1 张（`:527-537`），`usedCount` 越低越优先；**不调 LLM、不调生图**（零额外计费，符合项目红线）。
- **评论限制**：浏览/搜索路径显式传 `canInteract=false`（`:652`），只有 `check_profile` 里 noteId 命中「自己拥有的帖子」集合才允许互动（`:718-720, 750-757`）。
- **反爬等待**：回复/评论前 `setTimeout 5000`（`:407`、`:436`）——单轮最长可多出 10 秒纯等待。
- **失败语义**：`catch` 里只 `callbacks.onError` 并返回 partial session（`:850-854`）；**不落库**，UI 只弹 toast（`apps/XhsFreeRoamApp.tsx:142-146`）。
- **落库与聊天同步**：每条活动 `DB.saveXhsActivity`（`:771`）→ 成功且非 idle 时写一条 `role:'system'` 的消息（`:811-816`，文案「📕 {name}的自由活动: …」）→ 保存的话题再写 `xhs_card` 消息（`:820-843`，`metadata.fromFreeRoam=true`）。也就是说**自由活动的产物会进私聊上下文**，这是它与聊天侧的主要交汇。

### 2.3 传输层（`utils/xhsMcpClient.ts`）

| 事实 | 证据 |
|------|------|
| 协议按 URL 猜：含 `/api` → REST(bridge)，否则 MCP(JSON-RPC) | `:35-38` |
| 部署模式另有 `local / lite / vps` 三态（与协议正交） | `utils/xhsMcpConfig.ts:3-20`；`types.ts:4703` |
| bridge 每请求 20s 超时 | `:226-228` |
| **MCP 每请求无超时** | `:402-426`（`fetch` 无 signal）；`:484-528` 同 |
| 会话失效分类 + 只读命令单飞重试；写命令永不重试 | `:262-297`（`classifyXhsBridgeFailure` / `RETRYABLE_COMMANDS`） |
| 每轮握手 = 3 个 HTTP（initialize / notifications.initialized / tools/list） | `:428-466` |
| 握手并发去重（同 isolate 内） | `:476-482` |
| cookie 缺省从 `os_realtime_config` 兜底读取 | `:54-61` |
| `setBridgeToken` 只在两处调用 | `apps/Settings.tsx:2151`（仅「测试连接」按钮内）、`worker/amsg/src/index.ts:2520`（fire 路径） |

> ⚠️ **静态推断（未运行验证）**：vps 模式下 bridge 校验 `X-Bridge-Token`（`:215`、`:640-643`），而自由活动引擎只 `setCookie`（`utils/xhsFreeRoam.ts:472`）。冷启动直接进自由活动时 `liteBridgeToken` 为空 → 预期 401「未登录」。同一问题对聊天 XHS 工具同样存在，除非本次会话里先点过设置页「测试连接」。

---

## 3. 前后台调度

### 3.1 前台定时器清单（只在页面打开时有效）

| 模块 | 频率 | 预算/闸 | 证据 |
|------|------|---------|------|
| 查手机自动刷新 | 60s tick，角色级 due（默认 30 min） | 单飞 `inFlight` + staleness；**无每日上限** | `context/OSContext.tsx:3227-3269`；`utils/phoneAutoRefresh.ts:38-48,64-65` |
| 彼方 VR 自动登入 | 每角色 interval（默认 120 min），精确 setTimeout + 20s 轮询 + visibilitychange 补火 | 最小间隔 = interval/2，地板 5 min；连续失败 3 次自停 | `utils/vrWorld/scheduler.ts:40,91,93-130`；`utils/vrWorld/runSession.ts:94,103-107,204-212`；`utils/vrWorld/constants.ts:107` |
| 主动消息（本地兜底） | 角色级定时 | 见 `context/OSContext.tsx` runProactive | `utils/promptCallRegistry.ts:26` |
| 自由活动 App | **无定时器** | — | `apps/XhsFreeRoamApp.tsx` 全文无 `setInterval`；仅 3 个 `useEffect`（load/scroll/探活） |

### 3.2 云端调度（amsg2 worker）

| 事实 | 证据 |
|------|------|
| kind 注册表只有 2 个 handler | `worker/amsg/src/fireKinds.ts:106-113`（`PLATE_CONSOLIDATE_KIND`、`AUTONOMOUS_ROUND_KIND`） |
| 未注册 kind = 硬失败（防旧 bundle 静默跑主干） | `:90-105` 注释 |
| 自主回合入口 | `worker/amsg/src/autonomyFire.ts`（`autonomyRoundHandler`，注册表 `:110`） |
| 计划队列与预算门 | `worker/amsg/src/autonomyScheduler.ts:566`（`runAutonomyPlanQueue`）、`:612-695`（读护栏 → `evaluateWorkflowBudget` → 全局额度 claim → 失败 release） |
| 扫描 pack（7 天窗口等） | `:168-232` |
| 日期按角色时区切日 | `:306-320`（`autonomyDateKey` / `startOfAutonomyDayMs`） |
| 结果回程（转述账本/事件/日记/心跳/工作流计划） | `utils/autonomyResultApply.ts:303-397`；`:400-406` 明确「不写 airp_events 以外的社交产物」 |

**结论**：自由活动（A）**没有任何后台形态**；角色「离线自己过」的活儿走 C（自主回合），产出是 outbox/日记/心跳/事件，**不会生成小红书或 Spark 内容**。

### 3.3 前后台边界的一个具体后果

A 的落库发生在会话末尾（`utils/xhsFreeRoam.ts:770`）。用户切走/刷新页面即中断 → 小红书侧可能**已经真实发帖**，但本地无活动记录，只有 `xhs_owned_posts`（发布成功即写，`:560-565`）留下痕迹，`check_profile` 下次会把它迁回来（`:666-674`）。这是「真实副作用已发生、本地账本缺失」的不对称，B/C 都用确定性 id put 避免了这一点（`utils/autonomyResultApply.ts:12`）。

---

## 4. 预算与限额

### 4.1 后台自主生活（唯一有硬预算的路径）

| 项 | 默认 | 天花板 | 证据 |
|----|------|--------|------|
| 每角色每日次数 | 2 | 12 | `utils/airp/autonomyGuardrails.ts:35-42,48-53` |
| 同类动作最小间隔 | 120 min | 24 h | 同上 |
| 全局每日次数（云端共享行） | 6 | 24 | 同上；`autonomyScheduler.ts:322-395` |
| 每次预留 token | 1600 | 8000 | 同上 |
| 每日 token 预算 | 100,000 | — | `utils/airp/autonomySettings.ts:39`（`AUTONOMY_DAILY_TOKEN_BUDGET`），`:251` |
| 总暂停 | false | — | `autonomyGuardrails.ts:31,41` |
| 预算评估（5 种拒绝原因） | — | — | `utils/airp/lifeWorkflow.ts:460-505` |
| 云端额度行 CAS 写 | — | — | 存放位置 `amsg:global / autonomy_guardrails`（`utils/airp/autonomyGuardrails.ts:55-57`），专用写路由见 `worker/amsg/src/guardrailPatch.ts` |

> 设计纪律（值得在别处复用）：护栏模型输出永远不参与（`autonomyGuardrails.ts:11-12`）；显式 `perCharPerDay:0` 保真为 0 而不是回落默认（`:105-110`）；owner 解析失败一律 fail-closed（见 `notes/ethernet-branch-context.md:151`）。

### 4.2 其余路径的预算空白

| 路径 | LLM 次数闸 | token 闸 | 写入闸 | 证据 |
|------|-----------|----------|--------|------|
| 自由活动 A | 无 | 无（无 max_tokens） | 真实发帖/评论（无确认） | `utils/xhsFreeRoam.ts:72-89, 541, 438, 409` |
| Spark 刷新 | 单飞 `refreshRequestRef` | 无（max_tokens 8000 是单次上限，不是额度） | 落 `social_posts` 无上限 | `apps/SocialApp.tsx:501-503,629,451` |
| Spark 评论 / 回复 | 单飞 ref | 无 | 同上 | `:786-792, :887-893` |
| 查手机自动刷新 | 角色级单飞 + 30 min due | 无 | 无记录条数上限 | `utils/phoneAutoRefresh.ts:38-48,64-65,206-213` |
| 彼方 VR | interval/2 + 失败 3 次 | 无 | 无 | `utils/vrWorld/runSession.ts:94-107`；`scheduler.ts:40` |
| 生图（Spark 首图 / 朋友圈配图） | **全局串行队列**（一次只跑一张） | latent.moe 按周配额（外部） | 每轮最多 2 张 | `utils/latentImageGen.ts:234-245`；`apps/SocialApp.tsx:639` |

### 4.3 一个真实的调用量放大点

`utils/phoneAutoRefresh.ts`：

- due 判定只看 `lastAutoRefreshAt`（`:42-48`）；
- `lastAutoRefreshAt` **只在成功分支写**（`:206-213`）；
- 失败只清 `inFlight`（`:215-217`），调用方每 tick 静默重试（`context/OSContext.tsx:3254-3256` 注释原文「下轮重试」）。

→ 当 API Key 失效/上游 5xx 持续时，每个角色**每 60 秒**产生一次计费请求且永远不前进。按 1 角色计，静态上限 **1440 次/天**；N 个角色线性放大。对照：彼方用 `VR_FAIL_LIMIT=3` 直接停机（`utils/vrWorld/scheduler.ts:33-40`），自主生活用 `AUTONOMY_FAIL_LIMIT=3` 熔断（`worker/amsg/src/autonomyScheduler.ts:86,920`）。**同一个仓库里三种失败策略，只有查手机自动刷新没有熔断。**

---

## 5. 与 SPARK / 小红书 / 社交浏览的交汇

### 5.1 交汇 A：后台自主回合 → AIRP 事件 → Spark 发帖素材

```
自主回合（云端 1 次 LLM，输出 experiences / proposedEvents）
  └─ utils/autonomyResultApply.ts:303-350  落 outbox + airp_events（type 含 social_trace）
       └─ utils/airp/projection.ts:121-131  selectMomentsMaterial：只要 public + disclosed
            └─ apps/SocialApp.tsx:553-569   喂进本次发帖 prompt（"最近真实发生过的事"）
                 └─ :641-673               产物写 SocialPost.airpEventIds 做无状态去重
```

- 事件→可见性判定顺序被锁死：先 major/关系/对话 → private，再 `social_trace` → trace（`utils/airp/projection.ts:42-49`）。**私密与痕迹永不进朋友圈**，即使已对用户交代（`:121-128`）。
- 去重锚点：`SocialPost.airpEventIds`（`:553-561`），扫内存 feed 求并集，零额外读。
- 素材上限：`MOMENTS_MATERIAL_LIMIT`（默认 3，`:121-131`）。
- **反向不成立**：Spark 生成的帖子不会回流成 AIRP 事件，也不进记忆/世界观。

### 5.2 交汇 B：后台自主回合 → 查手机「浏览记录」

- 映射表锁定：`social → social_trace`、`order/delivery → activity`、`chat → relationship`、`call/contacts 不映射`（`utils/airp/projection.ts:137-155`）。
- 消费点：`utils/phoneAutoRefresh.ts:107-118`（自动刷新只取 `chat` 类），上限 5 条（`:137`）。
- 时间戳与事件 id 写回记录（`utils/phoneAutoRefresh.ts:195-201`），修掉「全堆在写入时刻」。
- 手动「查手机刷新」走另一条 prompt（`apps/CheckPhone.tsx:1219` 附近的 LLM 入口），与自动刷新同源不同参。

### 5.3 交汇 C：自由活动 → 私聊上下文

- 每条成功活动写 `role:'system'` 文本消息（`utils/xhsFreeRoam.ts:811-816`），内容含标题/正文/标签/内心想法。
- 保存的话题写 `type:'xhs_card'` 的 assistant 消息（`:820-843`），带 `metadata.fromFreeRoam`，与聊天里分享的小红书卡同一渲染路径。
- 因此**自由活动会持续抬高私聊消息表体积**，而私聊上下文构建逻辑会读到这些 system 消息（讨论口径见 §7.3）。

### 5.4 交汇 D：聊天内 XHS 指令（同引擎、不同路径）

| 指令 | 出处 | 额外 LLM 轮次 |
|------|------|---------------|
| `XHS_SEARCH` / `XHS_BROWSE` | `utils/applyAssistantPostProcessing.ts:1569-1613`、`:1615-1625` | +1（续跑） |
| `XHS_DETAIL` / `XHS_MY_PROFILE` | 同上 `:2103-2154` 区段 | +1 |
| `XHS_POST` / `XHS_COMMENT` / `XHS_REPLY` / `XHS_LIKE` / `XHS_FAV` / `XHS_SHARE` | 指令拼装 `:344-359` | 纯副作用，不重生（`:1002-1003` 注释） |
| 工具声明与执行 | `utils/agenticTools.ts:428-600`（`xhsCaches`、`lastXhsNotesRef` 跨轮共享） | — |
| 云端重放包 | `worker/amsg/src/agentic.ts:158-200`（`buildXhsSessionPayload`）、`:127-128`（`XHS_SHARE` 正则） | — |

聊天侧**有**角色级开关（`char.xhsEnabled`，必须显式打开，且**不回退**到全局 `realtimeConfig.xhsEnabled`——全局默认也是 false，`context/OSContext.tsx:246`；门在 `utils/agenticTools.ts:110-125`），自由活动**没有**任何角色级开关。

### 5.5 交汇 E：不是交汇，是容易误判的地方

| 误判 | 事实 |
|------|------|
| 「自由活动的帖子会出现在 Spark/朋友圈」 | 不会。`social_posts` 与 `xhs_*` 是两套 store（`utils/db.ts:63,77-79`）；Spark/Moments 用 `origin` 互斥（`utils/momentsFeed.ts:35-41`：`mastodon/moments` 只进朋友圈，其余进 Spark） |
| 「朋友圈由 AI 生成」 | 朋友圈只做评论/回复生成（`apps/MomentsApp.tsx:524,625`）；帖源是 Mastodon 同步 + 手发（`utils/momentsFeed.ts:6-35`） |
| 「自由活动有后台版」 | 没有。见 §3.2 |
| 「自由活动 = 出行」 | 不是。四种动作里无移动；`movement` 是 AIRP 事件类型（`utils/airp/types.ts:61-63`） |

---

## 6. LLM 入口与静态调用量

### 6.1 入口分层

```
业务调用点（裸 fetch + __sullyMeta，或 safeFetchJson）
  └─ context/OSContext.tsx:1100-1230 全局 fetch patch
       ├─ :1142-1148  透明流式升级（stream:false → SSE，回包 assembleUpgradedResponse）
       ├─ :1169-1172  主代理中转改写（agentUrl → /agent/v1/chat/completions，凭据进 body.llm）
       ├─ :1178-1181  请求抓取（一次）
       ├─ :1192-1194  升级流拼回标准 JSON
       └─ :1203-1232  统一记录（recordApiCall：状态/耗时/usage/meta）
  └─ worker/main-agent/src/index.js  llmStream（云端中转，4 处 chat/completions 字面）
  └─ worker/amsg/src/index.ts:206-210,2520（worker 侧 fetch 补丁 + XHS bridge token 注入）
```

- 统一语义入口 `utils/externalRequest.ts:96-106`（`externalFetch(url,{route})`，把 purpose/route 挂进 `__sullyMeta`）；**自由活动与 Spark/Moments 都没走它**，仍是裸 fetch（`utils/xhsFreeRoam.ts:72`；`apps/SocialApp.tsx:626,786,887`；`apps/MomentsApp.tsx:524,625`）。
- usage 字段口径 `utils/llmUsage.ts:33-39`（普通 token / 缓存读 / 缓存写，缺失≠0）。

### 6.2 每轮静态调用量（按代码分支推导，未运行）

**自由活动 A（`utils/xhsFreeRoam.ts`）**

| 决策分支 | LLM 请求 | XHS/平台请求 | 说明 |
|----------|---------|--------------|------|
| `idle` | 1 | 0（+3 握手） | `:497` 后直接 `:507-520` |
| `post` | 1 | 1（publish） | `:521-585`，无「反应」调用 |
| `search` / `browse` | 2 | 1（search/recommend） | `:497` + `:620` |
| `search`/`browse` + 看详情 | 3 | 2（+getNoteDetail） | `:646-654` → `:365` |
| 详情内回复/评论 | 3 | +1（reply 或 comment） | `:409` / `:438`，各带 5s 等待 |
| `check_profile`（有帖子） | 2 | 1-2（getUserProfile） | `:682` + `:741` |
| `check_profile` + 详情 | 3 | +1 | `:750-757` |

→ **每轮 1–3 次 LLM 调用（典型 2）**；MCP 侧 **3 握手 + 1–4 业务请求**；两次 5s 反爬等待。
→ 每次 LLM 都携带完整 `coreContext` + 最多 500 条「水位之上、非群聊」的历史原文（`:116, :294, :493`；过滤逻辑 `utils/db.ts:691-714`）——两次调用**重复携带同一份大 prompt**，而没有任何 prompt 缓存复用机制（`utils/promptCacheDiagnostics.ts` 只做结构观测，不改发送）。

**Spark（`apps/SocialApp.tsx`）**

| 动作 | LLM | 生图 | 证据 |
|------|-----|------|------|
| 刷新推荐流 | 1（一次生成 6-8 帖，最多 3 角色） | ≤2 张首图（异步、串行队列） | `:530-531,583,626-632,639-640` |
| 打开帖子评论 | 1（4-6 条） | 0 | `:769,786-792` |
| 用户评论后的回复 | 1（1-3 条） | 0 | `:877,887-893` |
| 豆瓣混入 | 0 | 0 | `:505-519`（worker 侧 120s 缓存） |

**其余相邻路径（同一「自由活动/社交浏览」语义域）**

| 路径 | LLM/次 | 频率闸 | 证据 |
|------|--------|--------|------|
| 彼方 VR 自动登入 | 1 | interval/2（默认 60 min，地板 5 min） | `utils/vrWorld/runSession.ts:452-464` |
| 查手机自动刷新 | 1 | 30 min/角色（失败时 60s） | `utils/phoneAutoRefresh.ts:44-47,140-144` |
| 后台自主回合 | 1 | 2/角色/天 + 6/天 + 120 min | §4.1 |
| 聊天 XHS 指令 | +1/指令 | 每轮最多一条同类指令（代码只取首个 match） | `utils/applyAssistantPostProcessing.ts:1570,1616` |

### 6.3 仓库静态基线（可复现口径）

口径：`.ts/.tsx/.js`，排除 `*.test.*`、`node_modules`、`dist`、`*.bundle.js`。

| 指标 | 数值 |
|------|------|
| 出现 `/chat/completions` 字面的文件数 | **98** |
| 出现次数合计 | **199** |
| `safeFetchJson(` 调用点 | **78**，分布在 **39** 个文件 |
| 裸 `fetch(\`…/chat/completions\`)` 调用点 | **62**，分布在 **41** 个文件 |
| 单文件最多 | `utils/applyAssistantPostProcessing.ts` 17（全部为二轮/续跑真实调用点） |

本次相关文件明细：

| 文件 | `/chat/completions` 处数 |
|------|--------------------------|
| `utils/applyAssistantPostProcessing.ts` | 17 |
| `apps/SocialApp.tsx` | 3 |
| `apps/MomentsApp.tsx` | 2 |
| `utils/xhsFreeRoam.ts` | 1 |
| `utils/phoneAutoRefresh.ts` | 1 |
| `utils/vrWorld/runSession.ts` | 1 |
| `utils/airp/directorClient.ts` | 1 |
| `worker/amsg/src/index.ts` | 1 |
| `worker/main-agent/src/index.js` | 4 |

**调用地图（`utils/promptCallRegistry.ts`）登记情况**：`xhs-freeroam`（`:53`，锚 `utils/xhsFreeRoam.ts:72`）、`social-feed`（`:60`，锚 `apps/SocialApp.tsx:625`）、聊天侧 `tool-xhs-search`（`:84`）、`tool-xhs-detail`（`:85`）。
→ 登记粒度是**站点级**：自由活动的「决策/反应/详情反应」三次调用共用一条登记，直播里按站点看会低估 1.5–2 倍。`utils/promptCallRegistry.test.ts` 只校验锚点文件与 pin 符号存在，不校验调用次数。

### 6.4 同名 purpose 冲突（可测量性缺陷）

| 位置 | purpose 文案 |
|------|--------------|
| `utils/xhsFreeRoam.ts:88` | `appName:'自由活动', purpose:'自由活动生成'` |
| `utils/vrWorld/runSession.ts:463` | `appName:'彼方', purpose:'自由活动'` |
| `apps/SocialApp.tsx:631,791,892` | `appName:'Spark', purpose:'刷新推荐流 / 生成帖子评论 / 回复用户评论'` |
| `apps/MomentsApp.tsx:524,625` | `appName:'朋友圈'` |
| `utils/phoneAutoRefresh.ts:140-144` | **无 `__sullyMeta`** → 落 `ambientMetaAtStart`（用户当时打开的 App），无法归因 |

→ 两个后果：① 按 purpose「自由活动」聚合会把 XHS 与彼方混在一起；② 查手机自动刷新在调用记录里会被记成「用户当时打开的 App」，静默污染归因。这两条都影响后续「自由活动到底花了多少」的可测量性。

---

## 7. 数据库与缓存

### 7.1 本地（IndexedDB，DB v79）

| store | 角色 | 键/索引 | 证据 |
|-------|------|---------|------|
| `xhs_activities` | 自由活动日志（可清空） | `id`，index `characterId` | `utils/db.ts:78,345-348` |
| `xhs_owned_posts` | 角色伪主页（持久归属） | `id`，index `characterId`/`noteId` | `:79,349-353`；类型 `types.ts:4676-4693` |
| `xhs_stock` | 发帖配图库（含 `usedCount`） | `id` | `:77,343`；用法 `utils/xhsFreeRoam.ts:527-537` |
| `social_posts` | Spark + 朋友圈共用 | `id`（`SocialPost`），`origin` 区隔 | `:63`；`utils/db.ts:1058-1084`；`utils/momentsFeed.ts:35-41` |
| `messages` | 自由活动的 system / `xhs_card` 落点 | `charId` index | `utils/xhsFreeRoam.ts:811-843` |
| `airp_events` / `airp_world` | 后台事件与事实 | — | v75/v76，`utils/db.ts:41-42` |
| `airp_workflow_plans` | 自主生活工作流可查看记录 | `id`（与 D1 同 id，put 幂等） | v79，`utils/db.ts:42-43,76,409`；`:2423` 区段 |
| `autonomous_outbox` / `autonomous_heartbeats` | 转述账本/心跳 | — | v77；`utils/autonomyResultApply.ts:362-397` |

**版本演进**：`DB_VERSION = 79`（`utils/db.ts:43`）；v71 = 角色小红书伪主页（`:34`）；v75/v76 = AIRP 事件/世界；v77 = outbox/心跳；v79 = 工作流记录。

**备份覆盖**：`xhs_activities / xhs_owned_posts / xhs_stock` 均在 `utils/backupCoverage.ts:56-58`；`social_posts` 在 `:45`。`xhs_owned_posts` 曾经漏在导出清单外（`utils/backupCoverage.ts:3` 注释「本轮实查 xhs_owned_posts 仍在漏」），现已在 `context/OSContext.tsx:4051-4053` 显式登记，并有 `ensureBackupStoresCovered` 动态兜底（`:4066-4068`）。导入白名单见 `utils/db.ts:3626`。

### 7.2 云端（D1 / SQLite）

| 表 | 用途 | 证据 |
|----|------|------|
| `autonomy_plans` | 计划状态机（proposed/scheduled/running/…），`UNIQUE(char_id,dedupe_key)` | `worker/amsg/src/autonomyStore.ts:94-124` |
| `autonomy_plan_runs` | 每次运行（含 released 审计行） | `:127` |
| `autonomy_state` | 回合计数/上次推送 | `:68` |
| `autonomy_experiences` | 经历 | `:51` |
| `autonomy_tick` | tick 幂等 | `:86` |
| `autonomy_global_state` | 全局额度/日期 | `:147` |
| `autonomy_perception` | 感知快照 | `:155` |
| `client_state` | fire_pack 与全局护栏行（`amsg:global/autonomy_guardrails`） | `autonomyScheduler.ts:168-232,351-395` |

→ **自由活动在云端零落点**：没有远端表、没有跨设备同步、没有服务端审计。它的一切只在本机 IndexedDB + 真实小红书账号上。

### 7.3 容量与生命周期（缺失的闸）

| 数据 | 上限/TTL | 后果 |
|------|----------|------|
| `social_posts` | **无**（`put` 直写，只增不删；App 打开 `getAll` 全量） | `utils/db.ts:1058-1074`；`apps/SocialApp.tsx:450-451`。每轮刷新 +6~8 行，长期线性膨胀 |
| `xhs_activities` | **无**（`getXhsActivities` 走 `index.getAll` 再排序，`limit` 只影响返回切片；UI 另 slice 50） | `utils/db.ts:1675-1690`；`apps/XhsFreeRoamApp.tsx:94`；引擎 `utils/xhsFreeRoam.ts:663` 全量读 |
| `phoneState.records` | **无**（每次刷新 +3 条对话） | `utils/phoneAutoRefresh.ts:206-213` |
| `api_call_log` | 近 5 天 + 硬上限 | `utils/apiCallLog.ts:16`；`utils/db.ts:103,113,3000` |
| 备份 | 动态枚举 + 排除 `blob_assets`/`api_call_log` | `utils/backupCoverage.ts:15-18` |

### 7.4 缓存清单（这些模块真正用到的）

| 缓存 | TTL/范围 | 证据 |
|------|----------|------|
| 豆瓣小组话题列表 | 120 s，worker 内存（`Map`，跨请求） | `worker/index.js:16,2969,3013-3016` |
| 豆瓣详情/评论 | **不缓存**（点开才拉） | `worker/index.js:2949-2951` 注释 + 三个 handler |
| 豆瓣图片 | 3 MB 上限白名单透传 `doubanio.com` | `worker/index.js:2971-2973` |
| XHS MCP 会话 | 模块级 `mcpSessionId`，**自由活动每轮 reset** | `utils/xhsMcpClient.ts:315-319,476-482`；`utils/xhsFreeRoam.ts:485` |
| XHS 图库选图 | 打分（关键词 + `usedCount` 衰减），无 TTL | `utils/xhsFreeRoam.ts:527-537` |
| 生图串行队列 | 进程级单条 Promise 链 | `utils/latentImageGen.ts:234-245` |
| 自由活动上下文 | **无缓存**（每轮重建 coreContext + 最近原文） | `utils/xhsFreeRoam.ts:116,292-307` |
| usage/缓存诊断 | 结构指纹、TTFT，仅观测不发请求 | `utils/promptCacheDiagnostics.ts`、`utils/requestPrefixObserver.ts`（见 `notes/ethernet-features.md:186`） |

---

## 8. 可复用模块（改动时优先复用，别再造）

| 模块 | 复用什么 | 证据 |
|------|----------|------|
| `ContextBuilder.buildCoreContext` | 角色身份/记忆/时间感知统一拼装（自由活动、查手机、关系生成共用） | `utils/context.ts:106-160,338-400` |
| `utils/xhsMcpClient.ts` | 双协议传输、工具名别名、会话单飞、失败分类、笔记归一化 | `:322-360,402-528,886-1120` |
| `utils/xhsFreeRoamOwnership.ts` | 发帖归属提取/合并（活动日志与主页解耦） | `collectOwnedPostsFromActivities / extractPublishedNoteId / mergeOwnedNotes / ownedPostToNote` |
| `utils/applyAssistantPostProcessing.ts` | 指令→副作用→续跑的统一后处理（聊天侧 XHS 全走这里） | `:344-359, 1002-1016, 1569-1613` |
| `utils/agenticTools.ts` | 工具声明/执行 + 跨轮 `xhsCaches` | `:53-62, 428-600` |
| `utils/imageGenFlow.ts` + `utils/latentImageGen.ts` | 外貌档案替换、串行队列、统一参数（Spark 首图/朋友圈配图共用） | `utils/imageGenFlow.ts:272-293`；`utils/latentImageGen.ts:234-245` |
| `utils/socialFeedMerge.ts` | 幂等并入（防回包覆盖飞行中的用户/评论） | `:8-37` |
| `utils/airp/projection.ts` | 事件可见性/投影/去重锚点（Spark 与查手机共用） | `:42-49, 98-131, 137-185` |
| `utils/airp/autonomyGuardrails.ts` + `lifeWorkflow.evaluateWorkflowBudget` | 预算/暂停/间隔的纯契约叶子（worker 与前端同源） | `:20-53, 100-140`；`utils/airp/lifeWorkflow.ts:460-505` |
| `utils/externalRequest.ts` | 统一外部请求语义（自由活动/Spark 尚未接入） | `:96-106` |
| `utils/llmUsage.ts` | usage 归一（缓存读写、缺失≠0） | `:33-39, 120-190` |

---

## 9. 测试与验证（真实执行）

### 9.1 运行前的安全核查

- 只选**已存在**的定向用例，全部为纯函数 / mock fetch / fake-indexeddb；
- 逐个 grep：无 `.listen(`、无 `DATABASE_URL`、无 `new Client(`、无真实域名 fetch（仅 `*.test` / `example.test` / mock）；
- 限并发 `--minWorkers=1 --maxWorkers=2`；`TMPDIR` 指向工作区 scratch；
- 未跑全量 vitest / tsc / build；未触碰生产库与任何真实平台/Llm。

### 9.2 第一批：自由活动 + XHS 客户端 + 归属闭环

```
./node_modules/.bin/vitest run \
  utils/xhsFreeRoamOwnership.test.ts utils/xhsMcpClient.test.ts \
  utils/xhsMcpClient.concurrency.test.ts utils/xhsSession.test.ts \
  utils/xhsOwnedPostReference.test.ts utils/xhsOwnedPosts.test.ts \
  utils/xhsMcpConfig.test.ts utils/agenticTools.xhs.test.ts \
  utils/applyAssistantPostProcessing.xhsOwnership.test.ts \
  --minWorkers=1 --maxWorkers=2
```

结果：**Test Files 9 passed / Tests 52 passed，EXIT=0，9.49s**
日志：`/root/.hermes/kanban/workspaces/t_1964e5f8/logs/test-xhs.log`

| 文件 | 用例 |
|------|------|
| `xhsMcpClient.test.ts` | 15 |
| `xhsSession.test.ts` | 11 |
| `xhsMcpConfig.test.ts` | 6 |
| `xhsFreeRoamOwnership.test.ts` | 5 |
| `xhsMcpClient.concurrency.test.ts` | 4 |
| `agenticTools.xhs.test.ts` | 3 |
| `applyAssistantPostProcessing.xhsOwnership.test.ts` | 3 |
| `xhsOwnedPostReference.test.ts` | 3 |
| `xhsOwnedPosts.test.ts` | 2 |

### 9.3 第二批：调度 + 预算 + 社交合并

```
./node_modules/.bin/vitest run \
  utils/socialFeedMerge.test.ts utils/momentsFeed.test.ts \
  utils/airp/lifeWorkflow.test.ts utils/airp/autonomyGuardrails.test.ts \
  utils/airp/chatLifeWorkflow.test.ts worker/amsg/src/autonomyScheduler.test.ts \
  --minWorkers=1 --maxWorkers=2
```

结果：**Test Files 6 passed / Tests 132 passed，EXIT=0，4.53s**
日志：`/root/.hermes/kanban/workspaces/t_1964e5f8/logs/test-sched-social.log`

| 文件 | 用例 |
|------|------|
| `worker/amsg/src/autonomyScheduler.test.ts` | 61 |
| `utils/airp/lifeWorkflow.test.ts` | 25 |
| `utils/airp/autonomyGuardrails.test.ts` | 19 |
| `utils/airp/chatLifeWorkflow.test.ts` | 12 |
| `utils/momentsFeed.test.ts` | 11 |
| `utils/socialFeedMerge.test.ts` | 4 |

### 9.4 覆盖缺口（实测结论）

| 缺口 | 证据 |
|------|------|
| `utils/xhsFreeRoam.ts`（856 行引擎）**无任何直接测试** | `ls utils/xhsFreeRoam*` 只有 `xhsFreeRoam.ts` + `xhsFreeRoamOwnership.test.ts` |
| `apps/XhsFreeRoamApp.tsx` / `apps/SocialApp.tsx` 无组件测试 | `apps/` 下仅 `CheckPhoneHomeCard.test.tsx` |
| `utils/phoneAutoRefresh.ts` 无测试（本次审计发现的最贵路径） | 无同名 `.test.ts` |
| `utils/vrWorld/runSession.ts` 无独立测试 | 仅 `utils/vrWorld/vrWorld.test.ts`（覆盖其他部分） |
| 调用地图只锁锚点，不锁调用次数 | `utils/promptCallRegistry.test.ts:19-27` |
| 生图/评论/回复的 budget（额度）无测试 | 相关测试只覆盖纯函数合并 |

---

## 10. 风险清单（按影响排序，均为静态证据）

| # | 风险 | 影响 | 证据 |
|---|------|------|------|
| R1 | 查手机自动刷新失败无退避，60s 重试一次计费 | 成本失控（最坏 1440 次/天/角色） | `utils/phoneAutoRefresh.ts:42-48,206-217`；`context/OSContext.tsx:3262` |
| R2 | 自由活动无预算/无冷却/无每日上限 | 与自主生活的治理口径不一致；用户可无限触发 | `utils/xhsFreeRoam.ts:463-502`（全流程无额度判定） |
| R3 | 自由活动异常/关页 → 活动全丢；小红书侧却已真实写入 | 账实不一致，用户无法回溯 | `:770-771` vs `:850-854`；例外 `:560-565` |
| R4 | 自由活动直连真实账号发帖/评论，无二次确认 | 真实社区副作用 | `:541, 438, 409`（prompt 只约束「只评自己的帖子」`:162`） |
| R5 | MCP 传输无超时 + 5s×2 反爬等待 | 单轮可无限挂起，UI 只有 `isRunning` 挡着 | `utils/xhsMcpClient.ts:402-426`；`utils/xhsFreeRoam.ts:407,436` |
| R6 | vps 模式 `bridgeToken` 仅设置页「测试连接」注入 | 冷启动自由活动预期 401 | `utils/xhsFreeRoam.ts:472`；`apps/Settings.tsx:2151`；`worker/amsg/src/index.ts:2520` |
| R7 | 自由活动 LLM 无 timeout / 无 max_tokens / 无重试 | 长生成与超长输出无边界 | `utils/xhsFreeRoam.ts:72-89` |
| R8 | purpose「自由活动」被两套功能复用；查手机自动刷新无 meta | 按 purpose 统计不可信 | `utils/xhsFreeRoam.ts:88`；`utils/vrWorld/runSession.ts:463`；`utils/phoneAutoRefresh.ts:140-144` |
| R9 | `social_posts` / `xhs_activities` / `phoneState.records` 无上限、无 TTL，全量 `getAll` | 长期膨胀，首屏与备份变慢 | `utils/db.ts:1058-1062,1691-1700`；`utils/phoneAutoRefresh.ts:206-213` |
| R10 | 引擎零直接测试 | 改动无回归网（本次唯一大面积空白） | §9.4 |

**可做但本轮未做（不属于只读审计范围）**：任何修复都需另开任务；本报告不制定共享契约、不改配置。

---

## 11. 真实运行数据：不可得，说明清楚

- **服务端没有这些模块的调用量**：自由活动、Spark 刷新、查手机自动刷新、彼方 VR 全部在浏览器侧直连 LLM，服务端（`worker/main-agent`、`worker/amsg`）只在中转/云端 fire 时才见到请求。因此**没有可查的服务端计数**。
- 唯一的运行态记录是**用户浏览器 IndexedDB 里的 `api_call_log`**（`utils/db.ts:103`，保留 5 天，`utils/apiCallLog.ts:16`），本次按约束未读取任何生产数据。
- `notes/ethernet-branch-context.md` 与 `notes/ethernet-features.md` 里没有任何「自由活动/Spark 调用次数」的实测数字（已通读，二者只记功能与门禁用例数）。
- 因此本报告的调用量**全部是从分支结构推导的静态值**（§6.2），不是观测值。若要真实数字，需要在用户设备上打开「设置 → API 调用记录」按 purpose 过滤（并先解决 §6.4 的标签冲突），或为这三个入口补齐 `__sullyMeta` 后重新观测。
- 同样未验证的还有：VPS 侧小红书 session 是否在线（`notes/ethernet-branch-context.md:123` 记录 camofox 从未安装、`xhs-session` 已停用）、真实发帖/评论链路。这些都**不能**从仓库静态推断为「可用」。

---

## 12. 一页速查（给下一步动手的人）

```
自由活动按钮  apps/XhsFreeRoamApp.tsx:782 → :150
引擎          utils/xhsFreeRoam.ts:463   (856 行, 0 直接测试)
  ├ 决策 1 次   :497
  ├ 反应 1 次   :620 / :741 / :365
  ├ 发帖真写    :541   （无确认）
  ├ 评论真写    :438 / :409（仅自己的帖子 :402,:433）
  ├ 5s 反爬     :407, :436
  └ 落库        :771（成功后）, :811-843（进私聊）
传输          utils/xhsMcpClient.ts:402-426（MCP 无超时）
预算          无（对照：utils/airp/autonomyGuardrails.ts:35-53）
后台          worker/amsg/src/fireKinds.ts:106-113（只有 2 个 kind）
Spark         apps/SocialApp.tsx:626（1 次生成 6-8 帖）, :639（≤2 张图）
事件桥        utils/airp/projection.ts:121-131 → apps/SocialApp.tsx:553-569
最贵隐路径    utils/phoneAutoRefresh.ts:206-217（失败 60s 重试）
```
