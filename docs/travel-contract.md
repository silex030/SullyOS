# 角色自主出行 · 共享契约（B0 冻结版）

> 状态：**已冻结（B0）**。本文件与 `contracts/travel.ts`、`utils/travel/core.ts` 是后续 B1–B6 的唯一接口来源。
> 本批只落契约与纯逻辑：**没有**存储、provider、HTTP 路由、UI、接线，**没有**部署，**没有**调用高德或模型。
> 计划原文见 `.omh/plans/2026-10-23T082415841288Z-...-33c4a7.md`；执行计划见 `角色自主出行执行计划.md`。

## 0. 落点与为什么放这里

| 文件 | 角色 | 谁改 |
|---|---|---|
| `contracts/travel.ts` | 类型 + 错误码 + 状态机常量 + 冻结 DDL 字符串 | 仅契约所有者（本批） |
| `utils/travel/core.ts` | 纯逻辑：状态机判定、沿折线插值、脱敏白名单、主体绑定、预算闸、共享快照 | 仅契约所有者（本批） |
| `utils/travel/core.test.ts` | 上述规则的回归（34 例） | 仅契约所有者（本批） |
| `docs/travel-contract.md` | 本文件 | 仅契约所有者（本批） |

- **不放进 `types.ts`**：`types.ts` 是公共入口，归集成执行者独占，且当前工作区有 TTS 未提交改动；放进去会让 B0 与 TTS 在同一个文件上打架。`contracts/` 在仓库根，`tsconfig.json` 的 `include: ["**/*.ts"]` 天然覆盖，前端与 `worker/amsg` 都能直接 import，不需要 Vite alias。
- **零运行时依赖**：`contracts/travel.ts` 只导出类型/常量/DDL 字符串；`utils/travel/core.ts` 不 import 任何仓库模块（连 `utils/amapCore` 都不引，避免把浏览器侧依赖带进 worker bundle）。坐标系转换仍只在 provider 边界复用 `utils/amapCore` 的 `wgs84ToGcj02` / `gcj02ToWgs84`。

## 1. 人格与情绪：用户管设定，角色管自己

**正确表述**（本文件为权威，计划文档里旧句已同步修正）：

- 用户拥有的是**初始设定、世界设定、能力授权、隐私与预算**，以及随时暂停的权利；
- 角色的**想法、情绪、愿望与人格发展**由角色自身的记忆、经历与对话自然形成，用户不需要、也不应该逐次审批；
- 系统**不提供**强制改心情、改亲密度、指定目的地、「拖到某地」的干预面板；也不把随机心情或交互计数伪造成情绪/亲密度；
- 情绪/亲密度系统尚未实现处**只留空接口**（`TravelEmotionPort` 位置见 §7），界面与提示词都不得出现分值、虚构心情或「TA 现在很开心」这类系统注脚；
- 接口失败、预算用尽、provider 不可用**不等于**角色改变心意：愿望保留、如实记录原因，不写成「不想出门」。

## 2. 隐私与坐标（结构性约束，不靠宽泛正则）

1. 坐标必须带 `coordSys: 'gcj02' | 'wgs84'`；缺 `coordSys` 的旧数据不得用于路线。跨 provider 只在边界转换。
2. 坐标**只**存在于服务端与前端地图渲染层，**不进模型上下文、不进日志明文、不进备份导出**。
3. 固定锚点（用户住处 / 角色住处）落库只有白名单字段：
   `label, city, district?, lat, lng, coordSys, precision:'area', confirmedAt, source:'user'`。
   **结构上没有 `address` 字段**；POI 响应必须经 `pickAnchorFields()` 才可落库，禁止整对象直存。
4. 输入侧 `sanitizeAnchorLabel()` 只拒**住户级组合**：`\d+\s*(栋|幢|单元|层|室|房|户)`、`\d+号楼\d+`、含「门牌」。
   **不用 `\d+号` 一刀切**：`中山路100号`、`中山路100号的商店`、`XX社区3号门`、`阳光花园` 必须通过且原文保留；`3栋2单元501`、`阳光花园5号楼2单元`、`人民路8号3室` 必须被拒，文案指回「只填到小区/楼群或公共地点名」。
5. 进提示词/日志/备份统一走 `maskPlace()`：只出 `label + city (+district)`；正常公共门牌与 POI/商家名保留原样。
5b. **`placeId` 令牌是完整性签名，不是加密**：`tvp1.<base64url(payload)>.<hmac>` 的 payload
   可被任何拿到它的人 base64url 解出坐标（含 `lat/lng`）。它的作用只是「前端不自己拼坐标、
   服务端能验证未被篡改、15 分钟过期」。因此：只回给**本人**配置界面（Bearer 主体校验），
   **禁止**注入模型提示词、日志、推送、备份或第三方瓦片请求；也不要把它描述成「隐私加密」。
   若将来确实需要不可读的服务端索引，应改存短期随机 id 的查表实现（未做）。
6. **不读 `navigator.geolocation`**，不根据实时数据推断用户此刻位置。用户城市仍只用 `UserProfile.location.city`。
7. 「固定锚点」与「角色当前模拟位置」是**两个字段**：禁止用固定地址回填当前位置，禁止把历史位置写成用户实时位置。
8. 备份默认**不导出锚点 `lat/lng`**；恢复后锚点需用户重新确认，进行中的行程恢复为 `aborted(restored)`，共享态不复活。

## 3. 状态机（服务端权威）

```
wish(角色说愿望/类别) ──search ok──▶ considering(候选冻结) ──choose──▶ planned ──depart_at──▶ en_route
   │                                    │                              │                    │
   │ provider 失败/越预算                │ 换一批(more)                  │ 改计划(任意非终态)   │ 到达
   ▼                                    ▼                              ▼                    ▼
wish 保持 open(待重试)            candidates_ready              新代 planned(version+1)   dwelling
                                                                        │                    │
                                              改计划/闲逛分段 ◀──────────┴──────────┐ dwell_until
                                                                                   ▼   ▼
                        returned ◀──返程到达── returning ◀──返程出发── 同上 ──▶ en_route(return)
                             │
                             └─ 超过 depart_at + 4h 未推进 → expired；显式中止 → aborted
```

`TRAVEL_TRANSITIONS` 里只列合法边，其余一律非法（含终态自环）：

| from | 允许到 |
|---|---|
| `considering` | `planned`, `aborted`, `expired`, `unavailable` |
| `planned` | `en_route`, `aborted`, `expired`, `unavailable` |
| `en_route` | `dwelling`, `aborted`, `expired` |
| `dwelling` | `returning`, `stopped`, `en_route`, `aborted`, `expired` |
| `returning` | `returned`, `aborted`, `expired` |
| `returned` / `stopped` / `aborted` / `expired` | 无（终态） |
| `unavailable` | `considering`, `planned`, `aborted`, `expired` |

规则：

1. **只有服务端 tick 推进时间相位**（`en_route → dwelling → returning → returned`）；客户端没有任何推进接口，`tripProgress()` 只用于展示，不改变服务端状态。
2. **改计划允许任何非终态**（`considering/planned/en_route/dwelling/returning`）：插入新行（新 `id`、`plan_version+1`、`dedupe_key = 旧键:gen:新id`），旧行 `aborted(reason:plan_changed)`，不原地改旧行。闲逛 = `dest_json = null` 的分段 + `wandered` 事件，可连续多段。
3. `unavailable` **不是终态**：国外 provider 未接入时用它，接入后同一 wish 可重试；不得写成「角色不想出门」。
4. 位置展示分层：获几何许可（G1b）才按 `route.points` 累计距离插值；未获许可**只推阶段**，`licensedPositionAt()` 返回 `null`，ETA 无可信数据即 `null`（UI 显示「未知」），**不返回城市中心、不返回直线插值、不编造 ETA**。

## 4. 数据表（10 张，全部 additive）

完整 DDL 在 `contracts/travel.ts` 的 `TRAVEL_SCHEMA_SQL`，与本节一致。所有表都带 `user_id`；所有唯一索引都含 `user_id`，防跨租户 `char_id/dedupe_key` 碰撞。

| 表 | 用途 | 关键约束 |
|---|---|---|
| `travel_settings` | 账号级策略 | `budget_tz`（默认 `Asia/Shanghai`，角色不可覆盖）、`trip_retention_days`、`event_retention_days`、`version` |
| `travel_wishes` | 角色愿望 | `state ∈ open/candidates_ready/chosen/completed/dropped/expired`（`completed` = 这一趟走完已闭环，不再重排）；`(user,char,state,expires_at)` 索引 |
| `travel_candidates` | 有界候选（≤8） | 坐标只在此表；前端/模型只看 `id/label/category/distanceM`；`expires_at` |
| `travel_trips` | 行程（服务端权威） | `status`/`phase`、`plan_version`、`revision`（CAS）、`coord_sys`、`provider`、`origin_json`/`dest_json`、`route_json`（**仅 G1b 许可可写**）、`dedupe_key`；唯一索引 `(user_id, char_id, dedupe_key)` |
| `travel_trip_events` | 追加写事件 | 唯一索引 `(user_id, trip_id, seq)`；按 `expires_at` 清理（默认 7 天） |
| `travel_budget_state` | 账号级单一账本 | `map_calls_used/limit`、`map_attempts_used`、`llm_tokens_used/limit`、`day_key`、`paused`、`version` |
| `travel_share_state` | 共享位 | 主键 `(user_id, char_id)`；**不存通知频率** |
| `travel_char_settings` | 角色级启用位 | 主键 `(user_id, char_id)`；**缺行 = 不允许出行**（不因账号总开关打开而自动放开） |
| `travel_anchors` | 用户确认的固定地点 | 主键 `(user_id, char_id)`；只有 `label/city/district/lat/lng/coord_sys/precision/confirmed_at`，**结构上没有 address**；读接口不回坐标 |
| `travel_trip_positions` | 本次共享代际的位置采样 | `(user_id, trip_id, at)` 索引；**只有 G1b 许可且拿到 provider 真实折线时才写**；`share_generation` 记录写入时的共享版本 |

### 4.1 明确不建的表

`travel_place_cache` / `travel_route_cache` **不存在**，也不得新增：高德协议 3.5/7.3/4.12.3 明文禁止存储/缓存/抓取服务数据，且没有「会话内存必定允许」的原文。许可前 provider 结果只在单次请求/单次 tick 的内存作用域内使用，不落盘、不进备份。**这是工程选择，不代表条款已允许内存使用**；是否允许以 G1b 书面答复为准。

缓存许可未定 **≠** 真实底图不能做：展示授权（G1a：独立 JS Key + jscode + 域名白名单 + 审图号/归属）与「后台能否持久化几何」（G1b）是两条线，缺 G1a 时该视图显示「地图暂不可用（未配置授权）」，**不得用 SVG/折线冒充地图**。

## 5. 错误码与 UI 文案

固定集合在 `TRAVEL_ERROR_CODES`，不得临时新增字符串码。

| 错误码 | 触发条件 | UI 文案（面向用户的中文） |
|---|---|---|
| `UNAUTHORIZED` | 无已验证主体 | 登录状态已失效，重新登录后再看 TA 的行程 |
| `INVALID_CLIENT_TOKEN` | 已配置共享口令但校验失败 | 客户端口令不正确 |
| `PRINCIPAL_MISMATCH` | `X-User-Id` 与主体不一致 | 身份信息不一致，已拒绝本次请求 |
| `SHARE_REVOKED` | 共享关闭（撤销即权威位） | 位置共享已关闭，看不到 TA 现在在哪 |
| `UNKNOWN_CANDIDATE` | 候选不属于该 wish 或已过期 | 这个地点候选已失效，让 TA 重新选一次 |
| `WISH_EXPIRED` | wish 超过 `expires_at` | 这次的想法已经过期了 |
| `PROVIDER_UNSUPPORTED_REGION` | provider 不支持该地区（国外未接入） | 该地区暂不支持路线规划 |
| `PROVIDER_FAILED` | provider 业务失败（含 200 但 `status:0`） | 地图服务暂时不可用，TA 的愿望还留着，稍后重试 |
| `BUDGET_BLOCKED` | 额度耗尽 / 暂停 / 账本读失败（fail-closed） | 今天的出行额度已用完或已暂停 |
| `BUDGET_ZERO` | `limit = 0`（硬零） | 出行额度为 0，需要你在设置里调整 |
| `VERSION_CONFLICT` | CAS 的 `baseVersion/baseRevision` 过期 | 状态已被其他设备更新，刷新后再试 |
| `ANCHOR_NOT_CONFIRMED` | 固定地点缺失/未确认 | 先在设置里确认住处或常去地点，TA 才能出门 |
| `ROUTE_UNAVAILABLE` | 无路线数据 | 暂时拿不到路线，位置未知 |
| `GEOMETRY_NOT_LICENSED` | 未取得几何保存许可 | 地图路线暂不可用（未配置授权） |
| `RETENTION_EXPIRED` | 超过保留期已清理 | 这段行程已超出保留期 |

**fail-closed**：预算/护栏/主体绑定**读失败** → `BUDGET_BLOCKED` 或 401/403，不默认放行，并写对应事件。`ANCHOR_NOT_CONFIRMED` 时不出门，不用城市中心当住处。

## 6. 预算（0 / 缺省 / 跨日）

- 账号级**单一权威账本**，同一 `user_id` 的全部角色共用；`day_key` 由 `travel_settings.budget_tz` + **服务端时间**计算（`dayKey(nowMs, tz)`），角色/设备时区不能绕过。
- **`limit = 0` 是硬零**（`BUDGET_ZERO`），不是「用默认值」；缺行/读失败 → `BUDGET_BLOCKED`，**不用任何正数默认值补**（代码里禁止 `?? 30` 这类兜底）。
- 跨日**只清 `used`**，不重置 `limit`、不清 `paused`；`paused` 优先于额度判断。
- 地图调用与 LLM token 同表两列、分别计量：地图额度耗尽不影响 LLM，反之亦然；两者在同一事务/同一计数点写入，不双计不漏计。
- LLM 沿用现有可调预算，token 计入本账本，不新设「每天 N 次」硬编码；地图建议初始值 30 次/天/账号属**待控制台核定后落设置**，代码里不写死。

## 7. 共享 / 告知 / 出行 三态独立

- 三个态互不写对方字段：关共享只写 `travel_share_state` 并让前端清缓存，**不改 trip**；出行不因共享关闭而停止；**是否主动告知由角色决定**，没有频率设置，用户只控制通知渠道授权与免打扰。
- 撤销共享是**服务端权威位**：`redactSharedSnapshot()` 之后快照只留 `code:'SHARE_REVOKED'` + 地名/阶段/时间 + 预算，`position/route/history` 一律 `null`/`[]`，trip 也用无坐标视图（`TravelTripView`）。
- 重新共享**不自动**恢复撤销前轨迹；已披露给用户看过的内容无法远程抹除，UI 如实写「已查看的内容无法撤回」。
- 前端离线/请求失败：显示最后快照并标「未确认·最后更新 HH:mm」，**不推进位置**，不把本地插值当服务端事实。
- 情绪/亲密度空接口：`travel` 不写任何 `mood` / `affinity` 字段，也不从交互次数推算；将来接入时新增独立 port，不改本契约的 trip/wish 结构。

## 8. 已导出 API（后续批次按此签名实现，不得另造）

`contracts/travel.ts`

```ts
TravelCoordSys, TravelLatLng, TravelGeoPoint
TravelTripStatus, TravelWishState, TravelProviderId, TravelBudgetKind
TravelPlaceRef, TravelPlaceAnchor, TravelTrip, TravelWish
TravelCandidateView, TravelShareState, TravelBudgetState, TravelStateSnapshot
TravelErrorCode, TRAVEL_ERROR_CODES
TRAVEL_TRANSITIONS, TRAVEL_TERMINAL_STATUSES, TRAVEL_PLAN_CHANGEABLE_STATUSES
MAX_CANDIDATES, DEFAULT_BUDGET_TZ, TRAVEL_RETENTION_DEFAULTS
TRAVEL_WALK_SPEED_MPS, TRAVEL_STALE_TRIP_MS, TRAVEL_SCHEMA_SQL
```

`utils/travel/core.ts`

```ts
metersBetween(a, b): number
routeDistanceMeters(points): number
positionAt(points, ratio): TravelLatLng | null            // 沿累计距离插值，越界夹紧，空折线 null
tripProgress(trip, now): { phase, outboundRatio, returnRatio, etaMs | null }
isTerminalStatus(status): boolean
canTransition(from, to): boolean
canChangePlan(status): boolean
sanitizeAnchorLabel(raw): {ok,label} | {ok:false,code:'HOUSEHOLD_DETAIL',message}
maskPlace(place): { label, city, district? }
pickAnchorFields(poi, confirmedAt): TravelPlaceAnchor | null
sanitizeWishText(raw): {ok,text} | {ok:false,code,message}
resolvePrincipal({principalUserId, headerUserId}): {ok,userId} | {ok:false,code}
resolveBudgetGate(state|null, 'map'|'llm'): {allowed} | {allowed:false,code}
dayKey(nowMs, tz): string                                  // 'YYYY-MM-DD'
resolveWishOutcome('provider_failed'|'budget_blocked'|'none'|'chosen'): {state,event}
clampCandidates(list): list                                // ≤8，按 id 去重
redactSharedSnapshot(snapshot, share): TravelPublicSnapshot
geometryGate(licensed): {ok} | {ok:false,code:'GEOMETRY_NOT_LICENSED'}
licensedPositionAt(points, ratio, licensed): TravelLatLng | null
requireAnchor(anchor|null): {ok,anchor} | {ok:false,code:'ANCHOR_NOT_CONFIRMED'}
```

## 9. 后续批次所有权（互不重叠）

| 批次 | 独占文件（新文件；只列本批冻结的边界） | 依赖 | 不得触碰 |
|---|---|---|---|
| **B1 存储与预算** | `worker/amsg/src/travel/{store,budget}.ts` + `*.test.ts` | 本契约 | `worker/amsg/src/index.ts`、`autonomy*` 既有预算 |
| **B2 provider** | `worker/amsg/src/travel/{provider,providerAmap,providerWorld}.ts` + 测试 | 本契约 | 任何持久化缓存表；`utils/amapCore.ts` 只读复用 |
| **B3 tick / 状态推进** | `worker/amsg/src/travel/{tick,state,routes}.ts` + 测试 | B1、B2 | `index.ts` 的挂载行（集成执行者加） |
| **B4 前端数据** | `utils/travel/{state,api,privacy,budgetClient,prompt}.ts` + 测试 | 本契约、B3 只读接口 | `types.ts`、`utils/db.ts`、`utils/backupCoverage.ts`、`context/OSContext.tsx`、`utils/buildInfo.ts` |
| **B5 UI** | `components/travel/{TravelBall,TravelMapPanel,TravelMapCanvas,TravelChatCard}.tsx`、`utils/travel/amapJsLoader.ts` + 测试 | B4 | `components/PhoneShell.tsx`（挂载行归集成执行者）、**任何 TTS 文件与 `apps/Settings.tsx`** |
| **B6 设置与接线（集成执行者）** | `components/settings/TravelSettings.tsx`、`components/settings/TravelAnchorCard.tsx`、`utils/airp/travelPrompt.ts`、`worker/amsg/src/autonomyFire.ts` | B3–B5 | TTS 12 项未提交改动（`utils/ttsRouter.*`、`utils/genieTts.*`、`worker/main-agent/src/index.*`、`utils/mossTtsStatus.*` 等） |

**公共入口只由集成执行者最后改**：`worker/amsg/src/index.ts`、`components/PhoneShell.tsx`、`apps/Settings.tsx`、`utils/db.ts`、`utils/backupCoverage.ts`、`context/OSContext.tsx`、`types.ts`、`utils/buildInfo.ts`、`notes/ethernet-features.md`。

B1 的 `store.ts` 直接用 `TRAVEL_SCHEMA_SQL` 建表，不另抄一份 DDL；B2 的 provider 返回值必须是 `TravelPlaceRef`/路线点数组，坐标系在边界显式声明。

## 10. 本批验证（真实输出）

- RED：`pnpm vitest run utils/travel/core.test.ts --minWorkers=1 --maxWorkers=2` → `Failed to load url ../../contracts/travel`，退出码 **1**（契约尚不存在）。
- GREEN：同命令 → `34 passed (34)`，退出码 **0**。
- `npx tsc --noEmit`（工作树 HEAD 基线，未含本批文件）：**56** 条存量诊断，退出码 2；本批两文件单独严格检查（`--strict --skipLibCheck --moduleResolution bundler`）退出码 **0**。
- `pnpm vitest run utils/mojibakeGuard.test.ts` → 1 passed，退出码 **0**。

---

## 11. 集成版（前后端真实接线的当前事实）

> 本节描述 **`/root/SullyOS-travel`（分支 `ethernet-travel`）工作树**里已经落地的实现，
> 不是计划。凡未接通的项在 §11.5 单独列出，不在此节写成已完成。

### 11.1 挂载点（`worker/amsg/src/index.ts`）

| 顺序 | 位置 | 内容 |
|---|---|---|
| 1 | `fetch` 的配置门之后（`inspectWorkerEnv` 通过处） | `POST /travel/session`、`POST /travel/session/exchange`、`GET /travel/staticmap`、`handleTravelRequest(...)` |
| 2 | `fetch` 末尾的未知 fallback **之前** | 所以 `/travel/*` 不会被 upstream 的 404 吃掉 |
| 3 | `scheduled()` 内、自主生活 tick 之后 | `handleTravelScheduled(null, env, { wiringForSubject })`：页面关着也推进，不读推送订阅 |
| 4 | 首次请求 / 首次 cron | `ensureTravelSchema`（10 表）+ `ensureTravelOwnerSchema`（owner 凭证表，只存哈希） |

**owner bootstrap 不挂 HTTP**。`handleTravelOwnerBootstrap` 只在服务端运维通道调用（见 §11.4）；
公开挂出去等于给任意人签发身份，因此这里连路由都没有。

### 11.2 端点（前缀 `/travel`，后缀匹配，挂在 `/amsg` 反代下同样命中）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/travel/session` | 无 Bearer，body `{userId, ownerKey}` | exchange 的**摊平别名**：回 `{success,token,userId,expiresAt,session}`，前端会话层用它自动续期 |
| POST | `/travel/session/exchange` | 同上 | 安全 lane 的正式形状：`{success,session:{token,userId,audience,issuedAt,expiresAt}}` |
| GET | `/travel/staticmap` | **URL 短签**（无 Bearer） | 同源缩略图；验签 + 回查共享 + 扣地图额度；`Cache-Control: no-store` |
| GET | `/travel/state?charId=` | Bearer | `{snapshot, share, staticMapUrl?}`；共享关闭 → `SHARE_REVOKED` 且 `trip/position/route/history` 全空 |
| POST | `/travel/share` | Bearer | `{charId, shareEnabled, baseVersion}`，CAS 失败 409 |
| GET/PUT | `/travel/budget` | Bearer | 额度只读 / 改上限（`mapCallsLimit`，0 = 暂停） |
| GET/PUT | `/travel/settings` | Bearer | `enabled`/`budgetTz`/保留期；`version` CAS；请求体里的许可字段一律 400 |
| GET/PUT | `/travel/char` | Bearer | 角色级启用位（缺行 = 不允许） |
| GET/POST/PUT | `/travel/anchor` | Bearer | 读回**没有坐标**；确认收 `{placeId}`（服务端解坐标）或显式 `{anchor}`（再验住户级文本） |
| GET | `/travel/anchor/search?q=&city=` | Bearer | 城市内检索；只回 `{placeId,label,city,district}`；无城市不发请求（`reason:'city_required'`） |
| GET | `/travel/context?charId=` | Bearer | **角色内部**脱敏上下文（地名/相位/ETA），**不依赖共享开关**、**不含坐标**；只给提示词用 |
| GET | `/travel/config` | Bearer | 许可、`pushRequired:false`、预算摘要 |

### 11.3 预算与许可（防止「看着在跑、其实没记账」）

- **每个真实地图请求扣一格**：扣费发生在 provider 出口（`providerAmap/providerWorld` 的
  `reserveMapCall`）。tick 只做**只读闸门**检查，不预留 —— 两边都扣就是双扣。
- **失败不退款**：`settleMapCall` 默认 `refund:false`。只有「一个字节都没发出去」（缺 Key、
  坐标非法、闸门拒绝）才允许显式 `refund:true`；否则失败重试就是不受额度的免费循环。
- **attempts 有上限侧证**：`map_attempts_used` 只增不减，`map_calls_used` 受 `map_calls_limit`
  硬约束，重试每次都要再花一格；额度耗尽即停。
- **几何许可**只读 `TRAVEL_GEOMETRY_LICENSE === 'allowed'`；**底图展示**只读
  `TRAVEL_BASEMAP_LICENSE === 'licensed'`。两条线互不顶替，请求体无法解锁（有用例）。
- **LLM 不另立额度**：走既有 autonomy 账本（`createAutonomyLlmLedgerPort`）；护栏读不出来
  就 fail-closed。`travel_budget_state.llm_*` 只是镜像，不参与判定。

### 11.4 运维配置（缺一项即 fail-closed，不是「支持完成」）

| 变量 | 作用 | 缺了会怎样 |
|---|---|---|
| `TRAVEL_SESSION_SECRET`（≥32） | 会话 + 短签 URL + 地点令牌的 HMAC 钥 | 缺则回落 `AMSG_MASTER_KEY` 派生；两者都缺 → 503 `session-secret-unconfigured`，出行全不可用 |
| `TRAVEL_OWNER_BOOTSTRAP_SECRET`（≥32 且 ≠ 共享口令） | 只在服务端签发 owner 密钥 | 缺则无法给任何账号配对（**不开放公开注册**） |
| `AMAP_WEB_KEY` | 高德 **Web 服务** Key（地理编码/POI/步行/静态图） | 缺 → 锚点搜索、路线、缩略图全部 honest 503/空结果 |
| `MAPBOX_TOKEN`（`pk.`） | 国外地图 | 缺 → 国外行程标 `unavailable`（不是终态，wish 保留） |
| `TRAVEL_GEOMETRY_LICENSE=allowed` | 几何落库/回放许可 | 缺 → 路线只在内存，历史为空（不伪造轨迹） |
| `TRAVEL_BASEMAP_LICENSE=licensed` | 底图/静态图展示许可 | 缺 → 面板与聊天卡不给图（不改用 SVG 假地图） |
| `TRAVEL_LLM_BASE_URL/API_KEY/MODEL`（或 `LLM_*`） | 决策模型 | 缺 → `decisionPort` 缺席，tick 停在 `wait`（愿望保留，不编造选择） |
| `TRAVEL_LLM_DAILY_TOKENS`（可选） | 收紧模型日额度 | 缺省沿用自主生活默认值；调大不生效 |
| `TRAVEL_INTENT_PROBE_MINUTES`（可选） | 意图探针窗口（分钟）：同一角色窗口内最多问一次「想不想出去」 | 缺省沿用用户自己配的 autonomy「同类动作最小间隔」（`sameKindMinGapMinutes`），两者都没有才 3h 兜底；夹在 1 分钟–24h |

**给某个账号配对（服务端执行，不是 HTTP 端点）**：

```ts
// 在 VPS/本地、用同一套 env，直接调 handler（不经过公网）
const res = await handleTravelOwnerBootstrap(
  new Request('https://internal/travel/owner/bootstrap', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TRAVEL_OWNER_BOOTSTRAP_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: '<账号主体>' }),
  }),
  env,
  { ownerStore: createD1OwnerStore(env.DB), nowMs: Date.now() },
);
// 201 → { credential: { userId, ownerKey } }：ownerKey 只显示这一次，交给用户在设置里粘贴
```

设置页的「配对码」把 `{userId, ownerKey}` 存进 `localStorage['travel.owner.v1']`（**不在镜像/备份
白名单里**），之后 `POST /travel/session` 自动换短期 Bearer，到期自动续期 —— 用户不需要每次输 token。

### 11.5 仍未接通（不写成已完成）

1. **高德 Key 的真实权限/配额/海外能力**：本轮零真实调用，全部契约测试用注入 fetch。
2. **`/_AMapService` 同源反代 + 服务端 `jscode`**：代码侧只读 `VITE_AMAP_SERVICE_HOST`，
   Caddy 反代尚未配置（属部署工作，本轮不部署）。
3. **Mapbox**：未注册、未采购、未调用；`MAPBOX_TOKEN` 缺失时按未授权处理。
4. **per-user `llm_credentials`**（已接）：决策端口按 `char:<charId>/chat` 取该用户自己的行，
   用上游同一条信封路径解密（`deriveUserEncryptionKey(userId, AMSG_MASTER_KEY)` +
   `decryptFromStorage`）；解不开/没这行 → 端口缺席 → tick 落 `wait`。worker 级
   `TRAVEL_LLM_*`/`LLM_*` 只在显式 `TRAVEL_LLM_WORKER_ENV_FALLBACK=allow` 时兜底
   （线上那份 env 实测已失效，默认不看）。回归：`worker/amsg/src/travel/intent.test.ts`。
4b. **愿望由角色自己产生**（已接）：自主回合 JSON 里可选的 `travel:{want:"go|wander|none",wish?,category?}`
   经严格解析 → 授权/预算复核 → 落 `travel_wishes(open)`；后台枚举包含「已授权但还没有愿望」的
   角色，所以用户不必手写愿望。**没有愿望是正常结果**，不按次数强制出门。
4c. **闲逛分段（已接，2026-10-23）**：`want:"wander"` 建 `category='wander'` 的真实愿望；走到一处、
   停留到点之后，由 `TravelDecisionPort.nextSegment()`（生产实现 `travel/modelDecision.ts`）
   在**一次模型 + 最多一次候选搜索 + 一次路线**内决定：
   - `next`：用当前落脚点作起点、真实候选作终点，`planVersion+1` 新开一代（旧代 `aborted` +
     `segment_changed` 事件），路线沿真实道路折线；
   - `stay`：只延长 `dwellUntil`（10–180 分钟夹紧），不排路线；
   - `return`：以 `returning` 相位新开一代，`origin`=当前站、`dest`=用户确认的锚点，
     `returnAt` 到点才变 `returned`（沿真实路线走回去，不是原地翻状态）；
   - `stop`：终态 **`stopped`**（在外结束）——与 `returned`（已到家）语义不同，
     行程行保留 `dest`，快照按终态剥离，不会把「停在书店」画成「已经到家」。
   没有模型端口 / LLM 额度不足 / 暂停 → **零状态写入**：行程留在 `dwelling`、愿望保留，
   下一跳还能恢复（不写「角色想回家」）。并发重放：分段前先 CAS bump revision 认领，
   输的一方不调模型；新代 dedupe 键唯一索引兜底，最多一次模型与一次地图。
   一段结束（`returned`/`stopped`/`expired`）会把愿望闭环成 `completed`，否则 `chosen`
   会让下一跳再排一次（无限重排 = 反复烧地图）。回归：`worker/amsg/src/travel/wander.test.ts`。
4d. **没有推送订阅也能产生愿望（已接）**：上游自主回合在 `autonomyScheduler` 的闸 1.5
   （`hasAutonomyPushSubscription`）没过时整跳跳过，因为上游对无订阅任务无条件回
   409 `PUSH_SUBSCRIPTION_MISSING`。所以 tick 在没有愿望、没有在途行程时，走一条
   **不依赖推送**的探针回合：`claimIntentProbe()` 用「确定性 id + INSERT OR IGNORE」
   抢窗口（缺省 3 小时一次，`wiring.intentWindowMs` 可调，夹在 ≥1 分钟），
   预留既有 autonomy 账本 token 后问一次「想不想出去」；`want:none` → 占位行标
   `expired`、**不写愿望**；`go/wander` → 占位行变成 `open` 愿望交给原状态机。
   授权前提仍是既有的总开关 + 角色启用位 + 账本行 + 未暂停 + 地图额度 > 0，
   **没有新造默认授权，也没有默认每小时强制出门**。
5. **真机/真浏览器视觉验收**：本机 Chromium 起不来（缺 `libatk-1.0.so.0`，按约束不装系统库），
   悬浮球/面板/聊天卡只做了 jsdom + 组件级验证，**未做像素级验收**。
6. **位置历史密度**：只在 tick 跑到 `en_route/returning` 时采样一次，密度取决于 tick 间隔；
   不插值、不补点。
