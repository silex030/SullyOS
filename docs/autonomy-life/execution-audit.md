# 自主生活 v1 · 执行边界与审计材料（整改卡 t_984b3cfc）

本文是 P2「执行边界审计」的可复核材料：执行期模型/provider、配置与 schema 变更、
权限与网关边界、旧入口退役证据、真实联调路径与**仍未覆盖**的部分。所有数字/命令都是
在本仓库 `wt/t_984b3cfc` 上实际跑出来的，不含推测值。

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

- 旧定时器键（`RETIRED_LEGACY_TIMERS`）在开机时真正 `removeItem`，并清掉角色上的
  `phoneState.autoRefresh*`；迁移 marker 保证只做一次。
- 迁移的 `allowedKinds` 只做**交集**：旧配置没开 → 不授予任何 kind；有旧能力清单 →
  与首期内部能力取交集；外部窗口永远需要单独授权（`migration.ts` + `migration.test.ts`）。

## 6. 仍未覆盖（residual risk，交付时如实列出）

1. **AIRP 旧自主回合仍在**：`worker/amsg/src/autonomyScheduler.ts` 是另一条产品线
   （amsg2 自主回合，走 `/schedule-message`）。本卡没有把它下线或改道到新引擎——
   两者目前并存，**都受各自预算门约束**，但「统一到一个调度器」尚未做。
2. **外部窗口默认不可用**：需要运营配置 `AUTONOMY_EXTERNAL_*` 端点；真实第三方响应
   schema 未经线上验证（测试用的是假 fetch，覆盖的是拒绝面与投影面）。
3. **浏览器端到端**：执行器已在 OSContext 启动，但本环境没有浏览器可跑，当前证据为
   fake-indexeddb + 假 api 的集成测试；真机首跑需要一次人工冒烟（打开 App → 角色面板
   触发一次 tick 后 claim → 本地日记可见）。
4. **`putCharacterLife` 首次插入**：D1 实现在 `expectedRevision===0` 时 INSERT，若两个
   isolate 同时首插会有一方 changes=0 → 引擎下次 tick 重新读；不会双写，但会多一跳。

## 7. 验证日志（本机真实输出，日志随任务附件 `autonomy-evidence/`）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 自主生活相关用例 | `npx vitest run utils/autonomyLife worker/amsg/src/autonomyLife components/autonomy-life` | **17 文件 / 228 用例全通过**（`focused-tests.log`，EXIT 0） |
| 全量用例（机器空闲时） | `npx vitest run` | **621 文件 / 7541 用例全通过**（`vitest-full-first.log`，EXIT 0） |
| 全量用例（机器 load≈26 时重跑） | `npx vitest run --testTimeout=180000 --hookTimeout=180000` | 7539/7541；失败两条都是**与本卡无关的时序敏感用例**（见下），单独跑均通过（`vitest-full-load.log`） |
| 类型检查（全仓） | `npx tsc --noEmit -p tsconfig.json` | **56 条错误，与基线 `f7f040c7` 同集合；本卡新增 0 条，改动文件零错误**（`tsc.log`） |
| 构建 | `pnpm run build` | **EXIT 0**（7 个 worker bundle + vite build 5m36s，`build.log`） |
| 旧入口 grep | `grep -rn …` | 旧频率编辑 / `external_window_not_implemented` / `autonomyLife/client` 均 **0 命中**；`autoRefresh*` 只剩退役清理代码与其测试（`legacy-grep.log`） |

两条负载敏感用例（本次重跑的失败项，均与自主生活无关、代码未改）：

```bash
$ npx vitest run utils/backupRoundtrip.test.ts
✓ 22 tests  — 4500×1024 真 ZIP 用例 13686ms（用例自带 30s 上限；并发跑时被挤到 >30s）
$ npx vitest run utils/activeMsgRuntime.test.ts
✓ 140 tests  — 失败项是「补收该跳过打字延迟」的 <400ms 断言，负载下实测 568ms
```

机器是共享主机（本卡运行期间 load average 19–26，另有其它 workspace 的 `tsc` 在跑）。
