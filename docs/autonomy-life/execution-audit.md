# 自主生活 v1 · 执行边界与审计材料（整改卡 t_984b3cfc）

本文是 P2「执行边界审计」的可复核材料：执行期模型/provider、配置与 schema 变更、
权限与网关边界、旧入口退役证据、真实联调路径与**仍未覆盖**的部分。所有数字/命令都是
在本仓库 `wt/t_984b3cfc`（本文件所在提交）上实际跑出来的，不含推测值；验证日志跑在 `9db93fd0`，之后只改本文件。

> 更新（本卡）：`docs/autonomy-life/entry-migration.md` 里「后端 D1 端口与 worker 路由
> 尚未接线」的限制已解除，见第 4 节。

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

上面讲的是**产品运行时**的模型来源；实现这张卡的 agent 会话本身用的是：

| 项目 | 值 | 证据 |
| --- | --- | --- |
| 模型 | `deepseek-v4.1-flash` | `~/.hermes/profiles/ds-executor/config.yaml` → `model.default` |
| provider | `opencode-go` | 同上 → `model.provider`（`api_mode: chat_completions`，MoA 关闭） |
| 本卡 model/provider 覆盖 | 无（`model_override=null` / `provider_override=null`） | kanban `tasks` 行 |
| 两次实现 run | 68（首次交付）与 83（返工），均为 ds-executor | kanban `task_runs` |

配置文件 mtime（`2026-10-24 22:50:17` / `2026-10-24 16:35:36`）都早于本 run 起点
`2026-10-25T02:21:17+08:00`：本卡没有改 Hermes 配置、delegation / kanban / approvals / 工具权限，
没有启动网关、没有部署。完整脱敏审计见附件 `runtime-audit.md`。

## 2. 配置与 schema 变更（都是 additive）

| 变更 | 位置 | 说明 |
| --- | --- | --- |
| IDB `DB_VERSION` 80 → **81** | `utils/db.ts` | 新增 `autonomy_action_permits`（keyPath `actionId`，`expiresAt` 索引）；不做数据搬迁 |
| D1 新表（懒建，`CREATE TABLE IF NOT EXISTS`） | `worker/amsg/src/autonomyLife/store.ts` 的 `AUTONOMY_LIFE_DDL` | `autonomy_life_accounts / characters / actions / events / boundaries / budget / external_usage / wishes`；不改上游表 |
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
  policyVersion / nonce / 过期时刻；服务端条件提交把「账号暂停 + 角色暂停 + 动作 CAS」放进
  **同一句 UPDATE**（`store.ts:commitPermitAtomic`）；本地事务内核销（`localLedger.ts`）。
- **外部窗口**：浏览器不直连外部服务；worker `/external/read` 只做「运营白名单 ∩ 用户授权
  主机」的 https GET，不跟 3xx、限 256KB、只回白名单字段投影；SSRF 用例见
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
- `utils/autonomyLife/localLedger.test.ts` —— 许可在业务事务内核销、重放幂等、跨角色拒绝。

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
# 旧 AIRP 自动回合（runAutonomyTick / createAutonomyPostTask）：入口仍在，但已被统一边界闸改道
$ grep -rn "runAutonomyTick\|createAutonomyPostTask" --include=*.ts worker/ | grep -v node_modules
worker/amsg/src/autonomyScheduler.ts:745   # 旧实现本身（保留执行能力）
worker/amsg/src/index.ts:179/182/4077/4084 # cron 入口：packs 先过 gateLegacyAutonomyPacks
worker/amsg/src/autonomyLife/legacyGate.ts  # 统一边界闸
worker/amsg/src/autonomyLife/legacyGate.test.ts
worker/amsg/src/autonomyScheduler.test.ts
```

- **改道而不是旁路**：`worker/amsg/src/index.ts` 的 cron 先用 `gateLegacyAutonomyPacks()` 按
  **新边界**筛包（账号 enabled/globalPaused、角色登记与 charEnabled、`allowedKinds` 含
  `interaction.message`、用户新增禁区/回避话题 fail closed、当前窗口 calls used+reserved 未到上限），
  被拦下的包不会进 `runAutonomyTick`，只进日志 `gated: [...]`。
- **存量旧配置不再能用**：没有新账号边界行 = 不跑（`account_disabled`）；角色没登记 = 不跑；
  读边界/预算失败也按不跑处理（fail closed）。
- 集成测试（真 SQLite）：`legacyGate.test.ts` 覆盖「只有旧 fire_pack + client_state 护栏 → 全不跑」、
  「暂停 / 关角色 / allowedKinds 不含消息」、「用户新增禁区 → fail closed」、「used+reserved 到上限」、
  「进程重启后再判一次结果一致」。
- 旧定时器键（`RETIRED_LEGACY_TIMERS`）在开机时真正 `removeItem`，并清掉角色上的
  `phoneState.autoRefresh*`；迁移 marker 保证只做一次。
- 迁移的 `allowedKinds` 只做**交集**：旧配置没开 → 不授予任何 kind；有旧能力清单 →
  与首期内部能力取交集；外部窗口永远需要单独授权（`migration.ts` + `migration.test.ts`）。

## 6. 仍未覆盖（residual risk，交付时如实列出）

1. **AIRP 旧自主回合是「改道」不是「删除」**：`worker/amsg/src/autonomyScheduler.ts` 的实现
   仍在，cron 入口已先过 `gateLegacyAutonomyPacks()`（见 §5）；两个调度器仍并存，只是旧链路
   不再能绕过新边界。彻底合并成一个调度器不在本卡范围。
2. **外部窗口默认不可用**：需要运营配置 `AUTONOMY_EXTERNAL_XHS_URL` / `_AMAP_URL` /
   `AUTONOMY_EXTERNAL_READ_HOSTS`；联调用的是真实第三方（api.github.com），但**线上要接的
   平台响应 schema 仍需部署时验证**（字段投影会丢弃不在白名单/非标量的字段）。
3. **真机首跑（真实 App 壳）仍缺一次人工冒烟**：本卡证据是 Chromium + 真实 IDB/worker，
   但 App 里 OSContext 的启动时机、角色列表为空、浏览器权限策略等只在真实 App 里出现。
4. **`putCharacterLife` 首次插入**：D1 实现在 `expectedRevision===0` 时 INSERT，若两个
   isolate 同时首插会有一方 changes=0 → 引擎下次 tick 重新读；不会双写，但会多一跳。
5. **联调环境用的是 node:sqlite 适配器**（与 D1 API 语义 1:1，但不是 Cloudflare D1 本体）；
   D1 特有的行为（如 `meta.changes` 返回形状）已在适配器里对齐并有测试，但生产首跑仍需观察。

## 7. 验证日志（本机真实输出，日志随任务附件 `autonomy-evidence/`）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 真实浏览器联调 | `node scripts/autonomy-e2e/run.mjs` | **40/40 checks 通过，EXIT 0**（`e2e/e2e-run.log`、`e2e/e2e-report.json`、`e2e/e2e-http-requests.json`） |
| 自主生活相关用例 | `npx vitest run utils/autonomyLife worker/amsg/src/autonomyLife components/autonomy-life` | **18 文件 / 245 用例全通过，EXIT 0**（`focused-tests.log`） |
| 全量用例 | `npx vitest run` | **622 文件 / 7558 用例全通过，EXIT 0**（`vitest-full.log`，最终 HEAD 上实跑） |
| 类型检查（全仓） | `npx tsc --noEmit -p tsconfig.json` | **56 条错误，与基线 `f7f040c7` 逐行 diff 为空；本卡新增 0 条，本卡范围内 0 条**（`tsc-current.log`、`tsc-baseline.log`、`tsc-compare.txt`） |
| 构建 | `pnpm run build` | 见 `build.log`（最终 HEAD 上重跑） |
| 旧入口 grep | `grep -rn …` | 旧频率编辑 / `external_window_not_implemented` / `autonomyLife/client` 均 **0 命中**；`autoRefresh*` 只剩退役清理代码与其测试（`legacy-grep.log`） |

说明：首次交付（提交 `617e598f`）时有两条负载敏感用例在**高负载重跑**里失败过
（`utils/backupRoundtrip.test.ts` 的 30s 自带上限、`utils/activeMsgRuntime.test.ts` 的
`<400ms` 时序断言），单独跑均通过。本次返工在最终 HEAD 上跑全量时机器为负载 3–7，
622 文件 / 7558 用例一次全通过，没有再出现；两处用例的代码本卡未改。
