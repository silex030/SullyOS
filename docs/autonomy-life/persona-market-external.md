# 人设时序 · 真实目录消费 · 外部窗口：生产接线说明（第九轮整改）

本文件对应总卡 `t_33546864` 复审提出的三条 P1，逐条说明**改了什么、从哪个生产入口进、
怎么验证、还剩什么风险**。所有结论都以代码位置 + 可重跑命令为准，不以「已经改道」的口头
声明代替证据。

## 1. 真实人设/日程 → RhythmProfile（不再全员基础作息）

**问题**：`engine.ts` 的 `ensureProfile` 把旧 `profile.personaHash/summaryHash` 与**自己**
比较，生产上永远「没变」；`fallbackProfile` 固定传空文本，正常角色长期按 23:00–08:00 生活。

**改动**

| 位置 | 内容 |
| --- | --- |
| `utils/autonomyLife/personaSignal.ts`（新） | 把 fire_pack 模板与**当天**日程整理成 `{personaText, scheduleText, city}`；`personaHashOf` 用真实文本算哈希，空文本才落 `${charId}:fallback`；`scheduleTextFromSlots` 把「睡觉」时段放最前（rhythm 只认第一段 `HH:mm-HH:mm` 为睡眠窗），跨天日程整段丢弃 |
| `utils/autonomyLife/engine.ts` | `EngineDeps.personaFor` 读真实信号；`resolveProfile` 用**当前信号**的 (personaHash, timezone, summaryHash) 判断失效并重建；重建后立刻落库（未到期也会更新），下一次同人设不再重建 |
| `worker/amsg/src/autonomyLife/tick.ts` | 从 `pack.pack.template` 取人设、`pack.pack.scene` 取当天日程（`scheduleTextFromScene` 比 dateKey）、`scene.charCity` 取城市；读失败=没有信号 |
| `worker/amsg/src/autonomyLife/runtime.ts` | `persona` 透传到 `EngineDeps.personaFor`（路由层不传 = 没有信号） |

**验证**（全部从生产入口 `handleAutonomyLifeScheduled` 进，不注入 profile）

- `worker/amsg/src/autonomyLife/productionChain.test.ts`
  - 同角色/同安装种子/同时间（当地 01:00），早鸟包 → `resting/SLEEPING`、睡眠窗 `22:30–06:30`；
    夜猫包 → `scheduled`、睡眠窗 `01:30–09:30`、下次机会不同；
  - 换当天日程后 profile 落库更新（`summaryHash`/`revision` 变化），跨天日程不被采用；
  - 空模板 → `confidence=fallback`、`personaHash=<charId>:fallback`（明确「没有信号」）。
- `utils/autonomyLife/engine.personaMarket.test.ts`：同人设复跑不重建、人设改后重建、
  `personaFor` 抛错按无信号处理且本跳不被判死。

**没有新增人工频率**：`BoundaryTab` 无频率输入、契约无频率字段，这一点由既有测试继续钉住。

## 2. 外卖/购物：真实目录 + 真实价格 + 模拟钱包（价格不经过模型）

**问题**：`model.ts` 刻意不开放 `takeout.order/shopping.order`（模型编价=伪造消费），但生产
也没有别的生成路径，结果「窗口」只存在于契约枚举里；`tick.ts` 还把外部能力写死 false。

**改动（设备上报 → 服务端只做校验/打分/许可）**

| 位置 | 内容 |
| --- | --- |
| `contracts/autonomyLife.ts` | `MARKET_PROPOSAL_KINDS`、`ClientProposal` 形状、`MAX_CLIENT_PROPOSALS=4`、`CLIENT_PROPOSAL_TTL_MS=2h`、`CLIENT_PROPOSAL_ID_RE` |
| `utils/autonomyLife/marketCatalog.ts`（新） | 目录归一化（元→分）、类目白名单映射、`orderTotalMinorFromArgs`、`buildMarketProposal`：确定性选店/选商品，价格只取自目录，总额 ≤ min(单笔上限, 今日剩余额度, 卡余额)，并带 `orderId/cardId/shopCat` 三样执行期身份 |
| `utils/autonomyLife/marketProposalSource.ts`（新） | 设备侧来源：`loadShoppingData/loadMallData` + `DB.getAllCharacters()`（收货地址）+ `DB.getBankState()`（角色默认卡余额）+ `GET /boundaries|state`（额度口径）→ `submitProposals`；同角色 10 分钟最多一次 |
| `worker/amsg/src/autonomyLife/proposals.ts`（新） | 服务端校验：只收市场 kind、封闭 schema、类目已审核、价格整数分、总额 ≤ 单笔上限、地址/卡号/订单号形状；幂等落库（同 proposalId 覆盖）、过期不可用、排单后回收 |
| `worker/amsg/src/autonomyLife/routes.ts` | `POST /autonomy-life/v1/proposals`：暂停 409 / 角色关 403 / 形状 422 / kind 未开或策略拒 403；整包拒绝 |
| `utils/autonomyLife/engine.ts` | 候选合并（模型 + 设备 + 外部）；**模型失败但设备候选存在时仍照常排单**；消费类动作在**计划期**用同一次原子预留核销 `virtualSpendPerDayMinor` / `virtualOrderMaxMinor` / `perKindActionsPerDay`（以前订单金额从不进账本） |
| `utils/autonomyLife/startExecutor.ts` | 前台 tick 先上报设备候选（节流在模块内），再跑执行器 |
| `utils/autonomyLife/policy.ts` | `takeout.order/shopping.order` 的封闭 schema 增加 `orderId/cardId/shopCat`（执行层本来就需要，缺了会在执行期失败） |

**验证**

- `marketCatalog.test.ts`：价格逐项等于目录夹具、受限类目永不入选、三类额度任一不足即不生成、
  同输入确定性、跨天换单。
- `marketProposalSource.test.ts`：真实数据源 + 假 api 的上报链、缺地址/没钱/额度 0 不上报、
  kind 不在白名单不生成、节流、失败如实上报；`api.submitProposals` 的 HTTP 形状。
- `proposals.test.ts`：校验拒绝矩阵（日记 kind、未知键、浮点价、超上限、重复 id…）、D1 真 SQL 的
  幂等/隔离/过期/回收。
- `engine.personaMarket.test.ts`：模型失败 + 设备候选 → 排出外卖单；参数原样、`spend_minor` / 同类计数
  当场核销、候选回收；超单笔上限 → `BUDGET_EXHAUSTED` 且零写入。
- `productionChain.test.ts`：`POST /proposals` → 生产 tick → 服务端动作参数与候选逐字一致；
  超上限/类目/未开 kind/暂停分别 422/422/403/409，整包不半收。
- e2e 场景 6（真实 Chromium）：从 `public/shopping/*.json` 选单 → 上报 → 生产 tick（模型故意 500）→
  执行 → `shopping_orders`/`bank_transactions`/卡余额/回执/`GET /activities` 全部核对；暂停后
  `/proposals` 409 且 tick 不再排动作。

**刻意不做**：不开放模型提议这两类；不做真实支付/真实下单；执行仍是 OS 内模拟（订单与流水都标
`simulated: true`），页面文案「点外卖/买东西」来自既有 `view.ts`。

## 3. 外部窗口：配置 + 授权 + 可达性（不再写死 false）

**改动**

| 位置 | 内容 |
| --- | --- |
| `worker/amsg/src/autonomyLife/capabilityProbes.ts`（新） | 从 `AUTONOMY_EXTERNAL_XHS_URL/AMAP_URL/READ_HOSTS` 读真实配置；`isEndpointConfigured` 复用 URL 结构安全校验；`createReachabilityProbe` 做 3s、10 分钟缓存、最多 16 条的真实 HTTP 可达性探测（任何 HTTP 响应=可达，网络错误/超时=不可达） |
| `worker/amsg/src/autonomyLife/tick.ts` | `resolveProbes`：`配置 ∧ 该 kind 在 allowedKinds ∧ 对应 grant 未过期` 才去探测；探测结果填 `externalRead/map`；设备绑定状态也取真实值 |
| `utils/autonomyLife/ambientCandidates.ts`（新） | 外部只读/出行愿望的**确定性候选**：查询词只取人设兴趣标签（不外传别的字段）、出行愿望用真实城市 + 兴趣；零模型、零 IO |
| `utils/autonomyLife/engine.ts` | 能力门进入**候选筛选**（不只是 UI 文案）：`describeCapabilities` 不可用的 kind 不参与打分；模型失败但有外部候选时照常排单 |
| `worker/amsg/src/index.ts` | cron 把 `AUTONOMY_EXTERNAL_*` 传给 tick（真实环境变量，不猜默认端点） |

**验证**

- `engine.personaMarket.test.ts`：三者成立 → 排出 `external.read`（query=天文）；不可达 → 不生成；
  没授权 → 即便可达也不生成。
- `productionChain.test.ts`：生产 tick 三者成立 → `external.read`；没配端点 / 不可达 / 没授权
  分别排不出；`resolveProbes` 在没授权时**不发送探测请求**。
- e2e 场景 7：`/setup` 配好外部只读 + 授权 → 不可达 tick 排不出 → 可达 tick 排出
  `external.read`（query=天文）→ 真实 https 出网 + 字段投影 + 本地落库 + 配额 +1 +
  `GET /activities` 读到「看外部内容」。

## 4. 认证与重跑

```bash
# 定向（41 项既有 + 新增）
npx vitest run utils/autonomyLife worker/amsg/src/autonomyLife \
  worker/amsg/src/autonomyFire{,.integration}.test.ts worker/amsg/src/travel \
  worker/amsg/src/autonomyScheduler.test.ts worker/amsg/src/autonomyStore.test.ts \
  worker/amsg/src/planLifecycle.wiring.test.ts worker/amsg/src/index.test.ts \
  worker/amsg/src/autonomyRetry.sqlite.test.ts

# 生产链路联调（真 Chromium + 真 worker 路由 + node:sqlite + 原生 IndexedDB + 真实 https 只读）
AUTONOMY_E2E_EVIDENCE=/tmp/autonomy-e2e node scripts/autonomy-e2e/run.mjs
```

## 5. 残余风险（如实）

1. **未合主干**：交付在 `wt/t_984b3cfc`；`/root/SullyOS` 有另一会话未提交改动，合并由协调方在干净树上做。
2. **未部署**：`worker/amsg/worker.bundle.js` 要重新部署后才生效（本轮未部署），外部窗口还要运营配
   `AUTONOMY_EXTERNAL_*`；`travel.wish` 仍需未过期 amap grant 且地图端点可达。
3. **目录是快照语义**：设备每次上报用当时的真实目录；TTL 2h 内若目录调价，服务端不会重新核价
   （执行事务仍按订单金额核余额，不会超额扣款，但可能与最新价不同）。
4. **卡余额在设备侧**：worker 不知道角色卡余额，候选只保证 ≤ 单笔上限与「服务端额度剩余」；
   余额不足由执行期同一事务拒绝（`BUDGET_EXHAUSTED`，零写入）。
5. **同类冷却**：同一角色 2 小时内不会重复做同一件事（e2e 场景 7 因此换角色验证，而不是删历史）。
6. **认领/许可表无 GC**；D1 无跨 isolate 事务；tsc 仍有 56 条基线错误（本卡新增 0，非全绿）。
7. **e2e 不是生产部署**：外部只读打的是公开 `api.github.com`；模型是可控 mock；真实第三方
   （小红书/高德）仍需运营端点与授权后才能验。
