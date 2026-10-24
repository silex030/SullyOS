# 自主生活 v1 · 执行边界与审计材料（整改卡 t_984b3cfc）

本文是 P2「执行边界审计」的可复核材料：执行期模型/provider、配置与 schema 变更、
权限与网关边界、旧入口退役证据、真实联调路径与**仍未覆盖**的部分。所有数字/命令都是
在本仓库 `wt/t_984b3cfc`（本文件所在提交）上实际跑出来的，不含推测值；本轮全部日志在
最终代码上重跑（见 §7 与 [`evidence/`](./evidence/README.md)）。

> 更新（本卡）：`docs/autonomy-life/entry-migration.md` 里「后端 D1 端口与 worker 路由
> 尚未接线」的限制已解除，见第 4 节。

## 0. 本轮（第五轮）返工摘要（对应第五轮复审 comment 的四个阻断项）

| 复审意见 | 本轮改动 | 证据（真 SQLite / 真 handler / 真 tick） |
| --- | --- | --- |
| 1. 出行链路把 `allowedKinds` 当外部授权：不看 amap grant 的缺失/到期/撤权与授权窗口额度 | 新增 `legacyGrantDenial()` / `effectiveGrantFor()`（`legacyGate.ts`）：`travel.wish` 与 `/external/wish` 同口径，必须有未过期的 amap grant；`travelModelAccess()`、`reserveLegacyRoundCall()`、`reserveLegacyEffect()` 全部加这道闸；授权窗口的 `dailyQuota` 由 `consumeExternalQuota` 原子扣（0 / 耗尽 → 拒）。旧的「只加 allowedKinds 就成功」测试已改成**先给 grant**，并补了缺 grant / 到期 / 撤权 / 额度 0 / 额度耗尽五类负例 | `worker/amsg/src/autonomyLife/legacyGate.ts`、`travelGate.ts`、`autonomyFire.ts`；`legacyGate.test.ts`（+5 例）、`travel/legacyGate.integration.test.ts`（+6 例，真 tick）、`autonomyFire.integration.test.ts`（缺授权零愿望、授权时落一条） |
| 2. 出行模型返回后没有当前效果门：模型执行期间暂停/撤权仍能写愿望/行程 | `gateTravelDecisionPort()` 的 `gated()` 改为「预留 → 调模型 → **结算（失败即 fail closed）** → 现读边界 + 当前授权复核 → 一次性效果核销 → 才把结果交给 tick」；意图探针要出门时按 `reserveLegacyEffect('travel.wish')` 占 kind 配额，选点/分段走 `claimTravelDecisionAtomic()`（一条 `INSERT … SELECT`，边界 revision + amap 授权在同一条 WHERE，`claim_ref` 主键去重）。被拒时抛错 → tick 记 `llm_unavailable`：**模型调用照常记账，业务零写入** | `travelGate.ts`、`store.ts`；`travel/legacyGate.integration.test.ts` 新增「模型返回那一刻暂停 / 关角色 / 新增禁区 / 撤授权 / 结算失败」5 例（都断言零愿望、`used_calls` 仍为 1） |
| 3. 旧回合许可期限用排队时的旧时钟：过期后第一次输出仍可通过 | `llmOutput` 新增 `currentServerTimeMs(ctx)`（`ctx.now` 注入 / 服务端时钟），`claimRoundEffect`、`settleLegacyRoundCall`、`legacyRoundStillAllowed`、`reserveLegacyEffect`、`reserveLegacyNotification` 全部改用它；`settleBudget` 增加可选 `nowMs`，按当前时钟复核凭据到期；`carried.nowMs` 只留给展示字段（经历 `createdAt`、推送冷却） | `autonomyFire.ts`、`legacyGate.ts`、`utils/autonomyLife/budget.ts`；`autonomyFire.integration.test.ts` 新增「state 与 `expires_at` 都不动、只把执行时钟推过 6h TTL → 零经历/零下发/零认领」与「跨日执行 → 通知额度落在 `w:2026-10-25`、旧窗口 0」两例 |
| 4. 通知/愿望配额仍有「读完边界再写预算」的竞态 | 新增 `consumeLegacyQuotaAtomic()`（`store.ts`）：判额 + 占额 + **账号/角色 revision + 暂停/开关标志 + amap 授权**全部放进**同一条**条件 UPDATE/INSERT 的 WHERE；`chargeLegacyQuota` 不再走「先读边界再 reserveBudget」。读完边界后用户收紧额度/暂停/撤权 → 语句 0 行 → 零提醒 / 零愿望 | `store.ts`、`legacyGate.ts`；`legacyGate.test.ts` 新增 2 例 `beforeStatement` 注入（收紧通知额度+暂停 / 撤授权）→ `boundary_changed` 且预算行 0；`autonomyFire.integration.test.ts` 新增同口径的 handler 级 2 例（零提醒、零愿望，私人活动照落） |

上一轮（第四轮）的返工摘要保留在下面，便于对照。

## 0.1 第四轮返工摘要（对应第四轮复审 comment 的四个阻断项）

| 复审意见 | 本轮改动 | 证据（真 SQLite / 真 handler） |
| --- | --- | --- |
| 1. 旧回合输出不是强制的一次性执行门：缺 `budgetPermit`/`ownerUserId` 的旧形状 state 被放行；结算失败只 warn 后继续；同一 state 回放会再写一批经历/再下发 | 新增 `autonomy_life_round_claims` + `claimRoundEffect()`：**一条条件 INSERT** 同时校验「预留记录真实存在 + owner/角色匹配 + held/settled + 未过期」并 `(owner_id, round_ref)` 主键去重；`llmOutput` 顺序改为 **可信 owner/凭据/回合引用 → 认领 → 结算 → 现读边界 → 产物**，任一步失败即零业务效果、零下发；结算被拒不再放行 | `worker/amsg/src/autonomyLife/store.ts`、`autonomyFire.ts`；`autonomyFire.integration.test.ts` 新增 7 例：顺序回放 / 并发回放 / 旧形状 state / 伪造 owner / 伪造凭据 id / 换角色凭据 / 已释放 / 已过期 / 认领写失败 / 认领记录可追溯 |
| 2. 旧回合绕过用户新通知上限（`notificationsPerDay`） | 新增 `reserveLegacyNotification()`：强推之前按**账号层** `notificationsPerDay` 原子占一格（多角色共享），失败**只关提醒**（`notification.show=false`），私人活动照常落库 | `legacyGate.test.ts`（额度 0 / 只剩 1 条时两角色竞争 / 并发抢最后一格）、`autonomyFire.integration.test.ts`（上限 0、排队后收紧到 0、成功 +1 后再来一轮被挡） |
| 3. 出行链路（cron tick 的意图探针 / 决策 / 分段）与回合内 `travelIntent` 完全旁路新边界 | 新增 `travelModelAccess()`（**新边界 + 旧出行授权**两套都要过）与 `gateTravelDecisionPort()`（每次模型调用前按当前边界重判 + 原子预留/结算）；`index.ts` 的 `buildTravelSubjectWiring` 过不了就不装 `decisionPort`；回合内愿望落库改走 `reserveLegacyEffect('travel.wish')`（kind 白名单 + per-kind 配额） | `travelGate.ts`、`index.ts`；`travel/legacyGate.integration.test.ts`（真 SQLite + 真 tick：7 种拒绝场景零模型请求零愿望、中途暂停仍被拦、允许时 used_calls/usage 进统一预算）、`autonomyFire.integration.test.ts`（travel.wish 未授权/暂停零愿望，授权时落一条并占 kind 配额） |
| 4. 证据未持久化、交付树不一致 | 本轮所有日志**重新在最终代码上跑**并入库 `docs/autonomy-life/evidence/`（提交在送审 HEAD 内），同时作为本任务 durable attachments 上传；新增完整 grep 审计脚本（按实际入口逐个列） | 见 §7 与本文件同提交的 `evidence/`；附件 id 见 handoff |

上一轮（第三轮）的返工摘要保留在下面，便于对照。

## 0.2 第三轮返工摘要（第三轮复审 comment 的四条）

| 复审意见 | 本轮改动 | 证据 |
| --- | --- | --- |
| 1. 旧 AIRP 只读写筛包、消费不进新预算、fire 不复核 | 把统一边界 + **原子预算预留/结算**接进 `autonomyRoundHandler.beforeFire` / `llmOutput`：每跳调模型前 `reserveLegacyRoundCall()`（当前边界重判 + 账号/角色两层原子预留 + 预留下再读一次边界，变了就释放），llmOutput 结算真实 usage，落产物前再复核暂停/禁区 | `legacyGate.ts`、`autonomyFire.ts`；`legacyGate.test.ts`（真 SQLite：多角色抢最后 1 次额度、结算进新预算、排队后暂停/关角色/撤 kind/禁区 + 重启零写入、预留期间被暂停释放）；`autonomyFire.integration.test.ts`（真 handler + 真 SQLite） |
| 2. reservation 只是解析 id + 看历史 usedCalls，不是可信依据 | 新增 `autonomy_life_budget_reservations`：owner/角色/窗口/counter/kind/planRef/state/actionId 绑定/expiresAt/revision；许可签发与外部核销都按 id 查记录，并把 **revision 放进同一条条件 UPDATE**；同一凭据只能结算一次 | `budget.ts`（`verifyReservationHold(port, …)`、`bindReservation`）、`store.ts`（DDL + 条件 UPDATE + 结算）、`engine.ts`（落动作即绑定）；`budget.test.ts`、`wiring.test.ts`（伪造/借用/释放/过期/并发失效） |
| 3. 外部副作用前不重验当前内容策略/limits | `/external/read`、`/external/wish` 在核销前按当前边界重跑 `checkIntentPolicy`（禁区/回避话题/参数封闭/授权），并按当前 `perKindActionsPerDay` 在同一条核销 UPDATE 里核验 | `routes.ts`、`store.ts`；`wiring.test.ts`（许可后加 avoidTopics → 403 零出网零落愿；限额收紧 → 429；读完边界后加禁区 → revision CAS 全败） |
| 4. 原始日志与执行期审计材料不足 | 附完整原始 `npx vitest run` 输出（623 文件 / 7577 用例）；新增 `runtime-audit.md`：用 `state.db` + `kanban.db` 的 `task_runs` 证明五个实现会话（含两次崩溃 run）都是 `deepseek-v4.1-flash` / `opencode-go`，并定位全局 config 变更属于另一个 desktop 会话 | `vitest-full.log`、`runtime-audit.md`、`tsc-compare.txt`、`build.log`、`e2e/` |


## 1. 执行期模型与 provider

| 路径 | 模型来源 | 备注 |
| --- | --- | --- |
| 自主生活 cron 规划（`worker/amsg/src/autonomyLife/tick.ts`） | **用户自己的** `llm_credentials` 行 `char:<charId>/chat`，经 `resolveTravelModelCredentialsForUser`（同一份加解密链路）解出 `{apiUrl, apiKey, primaryModel}` | 没凭据 → `skipped: missing_credentials`，**不回落到 worker 级 env**、不假装有模型 |
| 请求出口（`worker/amsg/src/autonomyLife/model.ts`） | OpenAI 兼容 `POST {apiUrl}/chat/completions`，`temperature 0.8`、`stream:false`、超时 20s | 只实现 `kind: 'plan'`；其它 kind 返回 null（引擎按模型失败退避） |
| 浏览器执行器 | **不调用模型** | 只做 register/claim/commit-permit/本地事务/回执（`utils/autonomyLife/executor.ts`） |

- 没有任何「前端切换模型」的入口：`api.ts` 里不存在 model/provider 字段，URL 与凭据头
  全部由 `resolveActiveMsgEndpoint()` 从既有主动消息配置派生。
- 本卡没有修改任何模型/provider 配置，也没有引入新的 provider 依赖。

### 1.1 实现期（ds-executor）会话的模型 / provider

上面讲的是**产品运行时**的模型来源；实现这张卡的 agent 会话本身用的是
`deepseek-v4.1-flash` / `opencode-go`。这一条现在有**执行期证据**（不是配置快照推断）：

- 数据源：`~/.hermes/profiles/ds-executor/state.db` 的 `sessions` / `messages` 表，
  以及 `~/.hermes/kanban.db` 的 `task_runs`；逐条表格与工具直方图见
  [`runtime-audit.md`](./runtime-audit.md)；
- 本卡五个实现会话（run 66 / 68 / 78 / 83 / 90，含两次 **crashed** run）的
  `sessions.model` 全是 `deepseek-v4.1-flash`、`sessions.billing_provider` 全是
  `opencode-go`；
- 精确正则扫描这五个会话的工具调用：`hermes config set` / `hermes gateway` /
  `gateway start|run` / `wrangler deploy` / `npm publish` / `systemctl start|restart`
  / `hermes serve` **0 次执行**（run 83 里的命中是 `ps|grep` 只读排查与审计文字）；
- 全局 `~/.hermes/config.yaml` 在 run 68 期间的 mtime `2026-10-24 22:50:17` 已定位到
  **另一个 desktop 会话** `20261024_214632_52aa58`（标题「修改子代理默认模型为 ds v4.1flash」，
  21:52 `hermes config set delegation.*`、22:50 `hermes config set kanban.max_in_progress=2`）；
  本卡实现会话没有写过配置。详见 `runtime-audit.md` §3。

本卡没有改 Hermes 配置、delegation / kanban / approvals / 工具权限，没有启动网关、没有部署。

## 2. 配置与 schema 变更（都是 additive）

| 变更 | 位置 | 说明 |
| --- | --- | --- |
| IDB `DB_VERSION` 80 → **81** | `utils/db.ts` | 新增 `autonomy_action_permits`（keyPath `actionId`，`expiresAt` 索引）；不做数据搬迁 |
| D1 新表（懒建，`CREATE TABLE IF NOT EXISTS`） | `worker/amsg/src/autonomyLife/store.ts` 的 `AUTONOMY_LIFE_DDL` | `autonomy_life_accounts / characters / actions / events / boundaries / budget / budget_reservations / external_usage / wishes / round_claims`；不改上游表。`autonomy_life_budget_reservations`（预留凭据：owner、窗口、角色、counter、kind、planRef、state=held/settled/released、actionId 绑定、expiresAt、revision）；**本卡新增** `autonomy_life_round_claims`（输出效果的一次性认领：主键 `(owner_id, round_ref)`、绑定 `reservation_id`、`output_hash`、`state=claimed`、`expires_at`、`revision`） |
| Worker 路由 | `worker/amsg/src/index.ts`（`/autonomy-life/v1/*`） | 挂在既有 amsg worker 的配置门之后；**没有**新增网关/进程/bot |
| 新增环境变量 | `AMSG_SERVER_TOKEN`（**必须配置**，否则路由 401/拒绝启动能力） | `AUTONOMY_EXTERNAL_XHS_URL` / `AUTONOMY_EXTERNAL_AMAP_URL` / `AUTONOMY_EXTERNAL_READ_HOSTS` 可选；未配置 = 外部只读能力明确不可用 |
| 删除 | `utils/phoneAutoRefresh.ts` 及其测试、`CharacterProfile.phoneState.autoRefresh*` 三个字段 | 旧「按分钟自动生成手机记录」链路整条退役 |

## 3. 权限与网关边界

- **认证**：`AMSG_SERVER_TOKEN` + `X-Client-Token`（SHA-256 定长比较，避免长度/前缀时序泄露）；
  未配置 token 时路由直接拒绝（不是「默认开」）。
- **归属**：`X-User-Id` 只作主体断言；每条 SQL 都带 `WHERE owner_id = ?`；动作行里的
  `charId` 与路径/许可/设备逐层校验。跨 owner 读同 charId 的用例见
  `worker/amsg/src/autonomyLife/wiring.test.ts`（返回空活动列表）。
- **设备**：`POST /devices/register` 不自动抢占；claim/commit-permit 都校验 `installationId`，
  换设备提交许可返回 `FORBIDDEN`（用例同文件）。
- **许可**：`ExecutionPermit` 绑定 actionId / charId / installationId / leaseEpoch / argsHash /
  policyVersion / nonce / 过期时刻；服务端条件提交把「账号暂停 + 角色暂停 + 动作 CAS +
  账号/角色两层边界 revision」放进**同一句 UPDATE**（`store.ts:commitPermitAtomic`）；
  本地事务内核销（`localLedger.ts`）。
- **预算凭据**：许可签发前按 `reservationId` 查**真实预留记录**（`autonomy_life_budget_reservations`），
  核 owner / 窗口 / 角色 / counter / actionId 绑定 / 生命周期（held/settled 可用、released 与过期拒绝）；
  不再用「本窗口有过任意 usedCalls」给格式合法的 id 背书；同一凭据只能结算一次。
- **外部窗口**：浏览器不直连外部服务；worker `/external/read` 只做「运营白名单 ∩ 用户授权
  主机」的 https GET，不跟 3xx、限 256KB、只回白名单字段投影；**副作用之前**再跑一次
  `checkIntentPolicy`（当前禁区/回避话题）与当前 `perKindActionsPerDay` 限额，并把读到的
  边界 revision 留在同一条核销 UPDATE 的 WHERE 里；SSRF 用例见
  `worker/amsg/src/autonomyLife/external.test.ts`（IP 字面量 / localhost / .internal /
  云元数据 / 非默认端口 / URL 内凭据全部不发请求）。
- **审计材料本身**：本文件与测试日志不含任何密钥；worker 日志只打计数与状态，不打凭据、
  不打动作正文。

## 4. 真实联调路径（不再只是定义）

```
浏览器                                                      worker (amsg)
executor.runOnce()
  ├─ POST /autonomy-life/v1/devices/register ───────────▶  service.registerDevice → D1 accounts
  ├─ POST /execution/claim ─────────────────────────────▶  engine.claimAction → D1 actions
  ├─ POST /actions/:id/commit-permit ───────────────────▶  engine.commitPermit
  │                                                         → store.commitPermitAtomic（暂停+CAS 单句）
  ├─ runLocalAction()（本地 IDB 事务 + 许可核销 + 回执）  │
  └─ POST /actions/:id/receipt ─────────────────────────▶  engine.reportReceipt（argsHash/设备校验）
cron（每分钟）
  └─ handleAutonomyLifeScheduled
       ├─ 只对「登记过的角色 + 账号开着 + 角色开着」调模型（否则 skip，不烧预算）
       ├─ engine.tickCharacter → 预算预留 → 模型 → 候选选择 → D1 动作行
       └─ 不建上游任务、不发推送；副作用等设备上线后 claim
```

验证用例（真 SQL + 真 IDB，不是记录 SQL 文本的假库）：

- `worker/amsg/src/autonomyLife/wiring.test.ts` —— D1 许可提交、暂停竞态（在 UPDATE 前
  注入暂停，断言动作行零改动）、claim→permit→receipt 全链路、跨 owner 隔离、cron 真模型
  调用后落 `scheduled` 动作、外部窗口授权/配额/愿望落库。
- `utils/autonomyLife/localRunner.test.ts` —— 无许可/过期/错 hash/未 claim/已消费/换设备
  全部零业务写入；外部只读与出行愿望。
- `utils/autonomyLife/executor.test.ts` —— 浏览器执行器一轮真实 IDB 写入 + 回执；回执丢失
  进待补报、下一轮用原 actionId 补报且不重做业务。
- `utils/autonomyLife/localLedger.test.ts` / `utils/autonomyLife/localRunner.test.ts` —— 许可在业务事务内核销、重放幂等、跨角色拒绝；无许可/过期/错 hash/未 claim/已消费/换设备全部零业务写入。
- `utils/autonomyLife/budget.test.ts` —— 预留凭据：格式合法但从未签发（`reservation_missing`）、
  借用别的动作（`reservation_not_bound`）、已释放 / 已过期被拒、同一凭据不能重复结算、并发绑定只有一个成功。
- `worker/amsg/src/autonomyLife/wiring.test.ts` —— 新增「合法形状伪造 / 借用 / 已释放 / 已过期
  凭据都签不出许可且零写入」；外部窗口新增「许可签发后加匹配禁区/回避话题 → 403 零副作用」、
  「收紧 perKind 限额 → 429」、「读完边界、核销 UPDATE 前才加禁区 → revision CAS 让整笔失败」。
- `worker/amsg/src/autonomyLife/legacyGate.test.ts` —— 旧自动回合的执行期硬门（真 SQLite）：
  同账号多角色只剩一次额度时最多一个拿到预许可、结算后新预算 used_calls+1/used_tokens 记真实值、
  排队后暂停/关角色/新增禁区（含重启）零预留零业务写入、预留与二次复核之间被暂停 → 释放预留零消费。
- `worker/amsg/src/autonomyFire.integration.test.ts` —— **真 handler + 真 SQLite**：
  `autonomyRoundHandler.beforeFire` 在调模型前过统一边界 + 原子预留（第二跳 budget_exhausted）、
  `llmOutput` 结算真实 usage 并落经历、模型跑动期间新增禁区 → 只结算、零业务产物。

### 4.1 隔离环境真实联调（真浏览器 → 真 worker 路由 → 真 SQLite/IndexedDB）

`scripts/autonomy-e2e/` 不是单测替身，而是把**仓库里的真实模块**串起来跑：

| 组成 | 实现 | 是否真实 |
| --- | --- | --- |
| 浏览器 | Chromium 145（HeadlessChrome），页面 import `utils/autonomyLife/{api,executor,localLedger}` | 真浏览器 + 原生 IndexedDB（断言 `indexedDB._fake` 不存在） |
| 执行器 | `createAutonomyLifeExecutor` → register → claim → commit-permit → 本地事务 → 回执 | 真实 HTTP（`fetch`），无假 api |
| worker | `worker/amsg/src/autonomyLife/routes.ts` + D1 端口（esbuild 打包真实代码） | 真实路由 + 真实 `AMSG_SERVER_TOKEN` 校验 |
| 持久化 | `node:sqlite` 文件 `scripts/autonomy-e2e/.data/autonomy-e2e.sqlite`（D1 适配 1:1 语义） | 真 SQL；重启进程后可复查 |
| 外部只读 | 真实 https GET `https://api.github.com/users/octocat/repos`（匿名） | 真第三方响应，不是 fixture |

复跑命令与结果（本机实跑，日志见附件 `e2e/e2e-run.log` + `e2e/e2e-report.json` +
`e2e/e2e-http-requests.json`）：

```bash
$ AUTONOMY_E2E_EVIDENCE=... node scripts/autonomy-e2e/run.mjs
[e2e] 40/40 checks passed        # EXIT 0
```

覆盖的 5 个场景（每条都断言服务端落库与本地效果一致）：

1. **本地副作用**：`journal.write` → 本地 `diaries` 行 + `autonomy_action_receipts` +
   `autonomy_action_permits.consumedAt`；服务端动作 `status=succeeded`、
   `permitConsumedAt` 有值、`resultRef=diaries:...`。
2. **重启持久化**：SIGTERM 停 server 再起（同一 SQLite 文件），动作行仍为 succeeded、许可核销时间仍在。
3. **外部只读**：`external.read` → 真实出网 → 只回白名单字段（`{"url":"https://api.github.com/repos/..."}`）
   → 本地 `external_read` 记录（`source=external_read_only`）→ 服务端配额 `xhs used=1`。
4. **撤销 / 暂停**：先 claim + commit-permit 拿到一次性许可，再 `PATCH /boundaries` 撤销授权
   → `/external/read` 返回 **403 GRANT_REQUIRED**；`POST /pause` 后同许可 → **409 GLOBAL_PAUSED**。
   两次都断言：动作未被消费、配额未增加、愿望表零写入、请求日志只多一条被拒记录（没有出网痕迹）。
5. **出行愿望**：`travel.wish` → 服务端落 1 行 + 本地 `travel_wish`；第二笔在配额耗尽后
   `/external/wish` 返回 **429**，愿望表仍只有 1 行、第二笔动作不是 succeeded。

请求日志（`e2e-http-requests.json`）里可见的路径/状态：`devices/register 200`、
`execution/claim 200`、`actions/<id>/commit-permit 200`、`boundaries GET/PATCH 200`、
`external/read 200 / 403 / 409`、`external/wish 200 / 429`、`actions/<id>/receipt 200`。

## 5. 旧入口退役证据

```bash
# 旧「手机自动刷新」的读取方/定时器：只剩退役代码与它的测试
$ grep -rn "autoRefreshIntervalMin|maybeAutoRefreshPhone|isPhoneAutoRefreshDue|phoneAutoRefresh" \
    --include=*.ts --include=*.tsx . | grep -v node_modules
./context/OSContext.tsx:3238        # 注释：说明旧链路已退役
./utils/autonomyLife/startup.ts     # 清理旧字段的退役代码
./utils/autonomyLife/startup.test.ts

# 旧的 15/30/60/120 分钟频率编辑：0
$ grep -rn "\[15, 30, 60, 120\]" --include=*.tsx . | grep -v node_modules
（无输出）

# 旧的「外部窗口未实现」占位：0
$ grep -rn "external_window_not_implemented" --include=*.ts . | grep -v node_modules
（无输出）
```

```bash
# 旧 AIRP 自动回合（runAutonomyTick / createAutonomyPostTask）：建任务入口先筛包；
# **真正的硬门在 fire 时**（autonomyFire.beforeFire → reserveLegacyRoundCall）
$ grep -rn "runAutonomyTick\|createAutonomyPostTask" --include=*.ts worker/ | grep -v node_modules
worker/amsg/src/autonomyScheduler.ts:745   # 旧实现本身（保留执行能力，不再有绕过路径）
worker/amsg/src/index.ts:179/182/4077/4084 # cron 入口：packs 先过 gateLegacyAutonomyPacks
worker/amsg/src/autonomyLife/legacyGate.ts  # 统一边界闸 + 原子预算预留/结算
worker/amsg/src/autonomyLife/legacyGate.test.ts
worker/amsg/src/autonomyScheduler.test.ts
```

> 第四轮返工起，**完整**的入口审计不再是「只搜这两个符号」，而是一个可复跑的脚本
> `scripts/autonomy-legacy-grep-audit.sh`（原始输出见 `evidence/legacy-grep.log.gz`）：
> 按实际入口逐个列 AIRP 调度 / AIRP fire handler / 出行 cron tick / 出行模型端口 /
> 出行愿望落库 / 旧护栏与旧 token 账本 / 手机自动刷新 / 旧频率编辑 / 外部占位 / 旧
> `autonomyLife/client.ts` / 新闸自己的落点，并给出「非测试 / 测试」命中计数。
> 本轮结论：手机自动刷新只剩退役代码与测试、旧频率编辑 0 命中、`external_window_not_implemented`
> 0 命中、`autonomyLife/client.ts` 0 命中；两条旧自动链路（AIRP 回合、出行 tick）都已在
> **每次真正调模型之前**与**每次落业务效果之前**接上统一闸。

- **两道闸，执行期那道才是硬门**：
  1. cron 建任务前 `gateLegacyAutonomyPacks()` 按新边界筛包（省一次上游往返，挡掉明显不该建的）；
  2. **每一跳真正调模型之前** `autonomyRoundHandler.beforeFire` 调 `reserveLegacyRoundCall()`：
     按当前生效边界重判（开关/总暂停/角色/allowedKinds/用户新增禁区/回避话题 fail closed），
     并在统一账本里**原子预留下一次调用**（账号 + 角色两层一起判）。预留下再读一次边界，
     revision 变了就把预留全额释放（零消费）。
  “只读筛包”证明不了「新预算只剩一次时多个角色不会一起调模型」——现在第二个角色会在
  预留下被预算判定拒掉（`legacyGate.test.ts` 真 SQLite 用例）。
- **旧链路的消费进新预算**：`llmOutput` 里 `settleLegacyRoundCall()` 按真实 usage 结算
  （usage 不明按预留上界），`used_calls` / `used_tokens` 增量在 `autonomy_life_budget` 里可查。
- **执行期暂停复核**：`llmOutput` 落业务产物之前再读一次边界，用户在这几秒里按了暂停 /
  关了角色 / 加了禁区就只结算、不写经历/愿望/计划。
- **存量旧配置不再能用**：没有新账号边界行 = 不跑（`account_disabled`）；角色没登记 = 不跑；
  读边界/预算失败也按不跑处理（fail closed）。
- 集成测试（真 SQLite）：
  `legacyGate.test.ts` 覆盖「只有旧 fire_pack + client_state 护栏 → 全不跑」、「暂停 / 关角色 /
  allowedKinds 不含消息」、「用户新增禁区 → fail closed」、「used+reserved 到上限」、
  「进程重启后再判一次结果一致」，以及**执行期**的「多角色额度竞争」「结算进新预算」
  「排队后暂停/关角色/禁区 + 重启 → 零预留零业务写入」「预留期间被暂停 → 释放」；
  `autonomyFire.integration.test.ts` 用**真 handler** 跑通 beforeFire（预留）→ llmOutput（结算/复核）。
- 旧定时器键（`RETIRED_LEGACY_TIMERS`）在开机时真正 `removeItem`，并清掉角色上的
  `phoneState.autoRefresh*`；迁移 marker 保证只做一次。
- 迁移的 `allowedKinds` 只做**交集**：旧配置没开 → 不授予任何 kind；有旧能力清单 →
  与首期内部能力取交集；外部窗口永远需要单独授权（`migration.ts` + `migration.test.ts`）。

### 5.1 第四轮补的三道闸（对应的复现用例见 §7 与 `evidence/`）

1. **输出效果一次性执行门**（`worker/amsg/src/autonomyFire.ts` 的 `llmOutput` +
   `worker/amsg/src/autonomyLife/store.ts` 的 `claimRoundEffect`）：
   - 顺序固定为「可信 owner + 预留凭据 + 稳定 `roundRef`（缺一 fail closed）→
     `claimRoundEffect` 条件 INSERT 认领 → `settleLegacyRoundCall` 结算 → 现读边界 → 写产物」；
   - 认领是一条 `INSERT ... SELECT ... WHERE EXISTS(预留记录可用)`，主键 `(owner_id, round_ref)`：
     同一回合的第二次（回放/并发）、伪造 owner、伪造凭据 id、凭据已释放/已过期、认领表写失败
     **全部零新增经历、零再次 `emitResult`、不重复结算**（以前缺凭据也能继续写，重放会写第二批）；
   - 结算被拒（`STATE_CONFLICT` / 存储不可用）不再只 `console.warn` 后放行，直接零业务效果。
2. **提醒受用户新通知上限约束**（`reserveLegacyNotification`）：强推之前按账号层
   `notificationsPerDay` 在统一账本里原子占一格（多角色共享，D1 侧条件 UPDATE）；
   额度 0 / 已耗尽 → **只关提醒**（`notification.show=false`、经历 `pushed=0`），
   私人活动照常落库（与新 UI「通知关闭只影响提醒」的承诺一致）。
3. **出行链路纳入统一边界/预算**（`worker/amsg/src/autonomyLife/travelGate.ts`）：
   - `travelModelAccess()`：新边界（`travel.wish` 必须在 allowedKinds、未暂停、未关角色、
     无未验证禁区）**与**旧出行授权（账号/角色开关、地图预算未暂停且额度 > 0）两套都要过；
   - `index.ts` 的 `buildTravelSubjectWiring` 过不了就**不装 `decisionPort`** → tick 的意图探针 /
     选点决策 / 闲逛分段零模型请求、零新增愿望；
   - `gateTravelDecisionPort()`：每次模型调用前再按当前边界重判 + 原子预留、调用后按真实
     usage 结算（tick 中途被暂停也拦得住）；旧的隐私脱敏 / 地图额度 / 旧 travel 账本原样保留；
   - 回合内 `travelIntent` 落库改走 `reserveLegacyEffect('travel.wish')`：kind 白名单 +
     `perKindActionsPerDay` 配额，边界暂停/未授权时零愿望。

> 行为变更（有意为之，与 §5 的口径一致）：**升级后没有新建 `autonomy_life_boundaries`
> 的存量用户，出行链路也不再调模型**（`travelModelAccess` 的 `account_disabled`）。想要
> 继续，必须在新入口里显式打开总开关、允许 `travel.wish`、不设未验证禁区、且额度有余量。
> 已有行程的时间相位推进、地图候选/路线（旧地图额度）不受影响。

### 5.2 第五轮补的四道闸（复现用例见 §7 与 `evidence/`）

1. **外部授权不再是 `allowedKinds` 的同义词**（`legacyGate.ts` 的 `legacyGrantDenial` /
   `effectiveGrantFor`）：`travel.wish` / `external.read` 分别要求当前生效边界里有未过期的
   `amap` / `xhs` grant。出行 tick 的 `travelModelAccess`、旧回合的 `reserveLegacyRoundCall`
   （`kind` 参数）与 `reserveLegacyEffect` 都走这道闸；`reserveLegacyEffect` 另外用
   `consumeExternalQuota` 原子扣授权窗口的 `dailyQuota`（0 / 耗尽 → 拒）。
   授权窗口的当日额度用完时，`travelModelAccess` 在**建 wiring 时**就直接不装 `decisionPort`
   ——连模型都不问（问了也落不了愿望，白烧一次调用）。
2. **出行模型返回后的当前效果门**（`travelGate.ts` 的 `gated`）：
   预留 → 调模型 → 结算（`settleLegacyRoundCall`，被拒即抛错）→ 现读边界 + 授权复核 →
   一次性效果核销（意图探针走 `reserveLegacyEffect` 占 kind 配额；选点/分段走
   `claimTravelDecisionAtomic` 的一条 `INSERT … SELECT`，边界 revision + amap 授权在 WHERE 里，
   `claim_ref` 主键去重）→ 才把结果交给 tick。被拒时 tick 记 `llm_unavailable`：
   **模型调用已经记账，业务效果为零**。
3. **执行期时钟**（`autonomyFire.ts` 的 `currentServerTimeMs`）：许可到期、外部授权到期、
   预算窗口一律用当前服务端时钟；`carried.nowMs`（排队时）只用于展示字段。`settleBudget`
   也接受 `nowMs`，按当前时钟复核凭据是否过期。
4. **配额核销的原子条件**（`store.ts` 的 `consumeLegacyQuotaAtomic`）：通知 / per-kind 效果
   的「判额 + 占额」与「账号/角色 revision + 暂停/开关标志 + amap 授权」在同一条
   条件 UPDATE/INSERT 的 WHERE 里；读完边界之后发生的收紧/暂停/撤权会让语句 0 行。


## 6. 仍未覆盖（residual risk，交付时如实列出）

1. **AIRP 旧自主回合是「改道」不是「删除」**：`worker/amsg/src/autonomyScheduler.ts` 的实现
   仍在，cron 建任务前筛包，**每一跳真正调模型前**再走统一边界 + 原子预算预留/结算（见 §5）。
   两个调度器仍并存，但旧链路已不能绕过新边界/预算/暂停。彻底合并成一个调度器不在本卡范围。
2. **D1 没有交互式事务**：预算行与预留记录的写入是「同一临界区内的多条条件语句 + revision CAS」，
   跨 isolate 冲突时按 fail closed 返回失败（可能留下已扣额度但未签许可的预留，等窗口日切或对账）；
   不会超额、不会签出无依据的许可。单 isolate（D1 常规部署形态）下由串行队列保证不交错。
3. **外部窗口默认不可用**：需要运营配置 `AUTONOMY_EXTERNAL_XHS_URL` / `_AMAP_URL` /
   `AUTONOMY_EXTERNAL_READ_HOSTS`；联调用的是真实第三方（api.github.com），但**线上要接的
   平台响应 schema 仍需部署时验证**（字段投影会丢弃不在白名单/非标量的字段）。
4. **真机首跑（真实 App 壳）仍缺一次人工冒烟**：本卡证据是 Chromium + 真实 IDB/worker，
   但 App 里 OSContext 的启动时机、角色列表为空、浏览器权限策略等只在真实 App 里出现。
5. **`putCharacterLife` 首次插入**：D1 实现在 `expectedRevision===0` 时 INSERT，若两个
   isolate 同时首插会有一方 changes=0 → 引擎下次 tick 重新读；不会双写，但会多一跳。
6. **联调环境用的是 node:sqlite 适配器**（与 D1 API 语义 1:1，但不是 Cloudflare D1 本体）；
   D1 特有的行为（如 `meta.changes` 返回形状）已在适配器里对齐并有测试，但生产首跑仍需观察。
7. **旧链路预留泄漏窗口**：`beforeFire` 预落后若上游根本没回调 `llmOutput`（进程被杀/上游丢任务），
   那次预留会停在 held 直到凭据 TTL（6h）或窗口日切；额度只会少不会多。
8. **认领表只增不减**：`autonomy_life_round_claims` 每次旧回合/计划执行写一行（带 `expires_at`），
   本卡没有做清理任务；单用户每天几行，量级可忽略，但**没有自动 GC**（与 `autonomy_life_events`
   同属待补的运维项）。过期认领不会放行任何新效果（主键决定一次性），只是占行。
9. **旧回合被拒后在途凭据的处理**：认领失败/边界拒绝时凭据按「请求已发出」结算（不白嫖）；
   只有认领表本身写失败时才停在 held 等对账（见 residual 7 的同一处理路径）。
10. **出行 tick 的 token 结算口径**：`TravelDecisionPort.lastUsageTokens()` 是「最近一次调用」
    的用量（旧端口语义），一次 tick 里先 `proposeIntent` 再 `nextSegment` 时，第二次结算可能
    按同一次 usage 记账 → **只多算不少算**；调用次数（`used_calls`）是逐次准确的。
    该口径与旧 travel 账本一致，本卡没有改它。
11. **出行愿望现在必须同时有 amap 外部授权**（第五轮）：`allowedKinds` 只表示能力允许。
    没有 grant / grant 过期 / 授权窗口额度为 0 或耗尽 → 出行探针不调模型、愿望不落。
    这是有意的收紧（与 `/external/wish` 同口径），但对「只在新入口勾了 travel.wish 却没配
    外部授权」的用户是行为变更：需要在设置里授予 amap 只读授权。
12. **效果核销的顺序代价**：`travel.wish` 先占 per-kind 名额、再扣授权窗口当日额度；
    如果第二步因并发耗尽失败，会浪费一格 per-kind（不会写业务效果，也不会超额）。
    反过来的顺序同样会浪费一格授权额度，本卡选择了「先保证业务配额」的方向。
13. **D1 无跨语句事务的结算残影**：`settleBudget` 先推进预留记录、再写预算行；若预算行
    写入失败（存储异常），预留记录可能已是 `settled` 而预算行仍是 `reserved_calls`。
    两种状态都**不可再用**（fail closed），但对账时需要按预留记录核对；不会超额。

## 7. 验证日志（本机真实输出，日志作为本任务 durable attachments）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 定向用例（含旧回合 fire 真 SQLite 集成、出行 tick 集成） | `npx vitest run worker/amsg/src/autonomyFire.test.ts worker/amsg/src/autonomyFire.integration.test.ts worker/amsg/src/autonomyLife worker/amsg/src/travel worker/amsg/src/autonomyScheduler.test.ts worker/amsg/src/autonomyStore.test.ts worker/amsg/src/planLifecycle.wiring.test.ts worker/amsg/src/index.test.ts worker/amsg/src/autonomyRetry.sqlite.test.ts utils/autonomyLife` | **42 文件 / 909 用例全通过，EXIT 0**（`focused.log.gz`） |
| 全量用例（**完整原始输出**） | `npx vitest run` | **624 文件 / 7624 用例全通过，EXIT 0**（214.3s，`vitest-full.log.gz`，未裁剪） |
| 类型检查（全仓） | `npx tsc --noEmit -p tsconfig.json` | **两边各 56 条；归一化 worktree / 基线临时路径后逐行 diff 为空；本卡新增 0 条**（`tsc-current.log.gz`、`tsc-baseline.log.gz`、`tsc-compare.txt`；`EXIT:2` 与基线同值） |
| 构建 | `pnpm run build`（= `build:workers` + `vite build`） | **EXIT 0**（worker bundle 重新生成，vite built in 1m 41s；`grep -c autonomy_life_effect_claims worker/amsg/worker.bundle.js` = 5；`build.log.gz`） |
| 真实浏览器联调（本轮重跑，最终代码上） | `AUTONOMY_E2E_EVIDENCE=/tmp/r5-e2e node scripts/autonomy-e2e/run.mjs` | **40/40 checks 通过，EXIT 0**（`e2e-run.log.gz`、`e2e-report.json.gz`、`e2e-http-requests.json.gz`） |
| 旧入口完整审计（按实际入口） | `bash scripts/autonomy-legacy-grep-audit.sh` | 见 `legacy-grep.log.gz`：旧频率编辑 / `external_window_not_implemented` / `autonomyLife/client.ts` 均 **0 命中**；AIRP 回合、出行 tick 的模型调用与效果落库都有**执行期**统一闸 |
| 实现期模型/provider 与操作审计 | 见 [`runtime-audit.md`](./runtime-audit.md) | run 66/68/78/83/90 的会话均为 `deepseek-v4.1-flash` / `opencode-go`；无 `hermes config set` / 网关启动 / 部署 |

本轮（第五轮）新增的可复现用例（都在上面两份日志里，真 SQLite / 真 handler / 真 tick）：

- `autonomyFire.integration.test.ts`：执行期时钟越 6h TTL → 零经历/零下发；跨日执行 → 通知落在
  `w:2026-10-25`；读完边界后收紧通知额度+暂停 → 零提醒（私人活动照落）；无 amap 授权 / 读完边界后
  撤授权 → 零愿望。
- `legacyGate.test.ts`：缺 amap 授权 / 授权到期 / 授权窗口额度 0 / 额度耗尽 → 拒且零预算行；
  `beforeStatement` 注入收紧通知额度+暂停 / 撤 amap 授权 → `boundary_changed`。
- `travel/legacyGate.integration.test.ts`：没有 amap 授权（allowedKinds 与旧设置开着）→ 零模型请求、
  零愿望；授权到期 → 同上；额度 0 → 模型可问但愿望不落；**模型返回那一刻暂停 / 关角色 / 新增禁区 /
  撤授权** → 零愿望（`used_calls` 仍为 1）；结算失败 fail closed。

第四轮的可复现用例（同样仍在上面两份日志里）：

- `autonomyFire.integration.test.ts`：顺序回放 / 并发回放 / 旧形状 state / 伪造 owner /
  伪造凭据 id / 换角色凭据 / 已释放 / 已过期 / 认领写失败 / 认领记录可追溯；
  通知上限 0、排队后收紧到 0、成功后 +1 再被挡；出行愿望未授权零愿望 / 授权落一条并占 kind 配额 / 暂停零愿望。
- `legacyGate.test.ts`：通知额度 0、两角色抢最后一格、并发抢一格、`travel.wish` 未授权 /
  额度 1 / 暂停时都不占额、不写行。
- `travel/legacyGate.integration.test.ts`：真 tick + 真闸，7 种拒绝场景零模型请求零愿望、
  wiring 建好后中途暂停仍被拦、允许时 `used_calls=1` / `used_tokens=321` 进统一预算。

说明：`vitest-full.log` 是完整的原始 stdout（600+ KB），不是手工汇总。本轮全部日志都在
**最终代码**上跑（构建里重新生成了 `worker/amsg/worker.bundle.js`，同一提交内）；
同一批原始日志也入库到 [`evidence/`](./evidence/README.md)（`gunzip -c` 读），
并作为本任务 durable attachments 上传。
