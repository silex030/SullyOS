# 链接分享整合 v1：接线、验证与已知限制（t_babca897）

> 状态：**叶子模块 + 集成接线完成；返工 t_42231e16 后 B 站已读到真实内容（抖音/XHS 仍受限，见 §5）；
> 未部署生产。**
> 契约来源：`share-contract-v1.txt`（t_6bca2291 附件）。
> 父卡交付：`utils/socialContent/*`、`worker/social-content/*`（识别器、适配器、SSRF 抓取、状态机）。
> 本卡新增：服务宿主装配、持久化、反代、客户端投影/卡片/发送链路、回归与体检。
> 后续执行卡 t_75dd49a5：把按需检索（excerpts）接入聊天工具循环 `read_share_excerpts`，见 §8。

## 0. 一句话交付

用户在聊天里发小红书/抖音/B站链接 → 消息原样落库 → 后台解析成卡片（状态/标题/作者/简介/打开/重试）
→ 角色在当轮与后续轮次看到的是 **`shareRef + 有界简介`** 而不是原始长链接和整段字幕/正文。
总开关默认关闭，关闭时行为与集成前完全一致。

## 1. 架构与数据流

```
浏览器 Chat.tsx
  ├─ planShareText()            识别混合文本里的平台链接（纯函数）
  ├─ 落库（原文不动，metadata.shares 存卡状态）
  ├─ POST /agent/v1/social/shares/resolve   ← main-agent 鉴权后反代
  │      └─ social-content(8842, 127.0.0.1)
  │             ├─ resolver 状态机（queued→resolving→ready/partial/failed）
  │             ├─ adapters（bilibili / xiaohongshu / douyin）
  │             ├─ safeFetch + nodePinnedTransport（每跳 DNS/IP 复验、连接绑定）
  │             └─ D1(SQLite)：social_share_attachments / social_content_items
  ├─ metadata.shares.attachments[]  ← 首屏等 ≤1500ms，晚到只补卡不再调模型
  └─ 下一轮：messageFormat.normalizeMessageContent → 投影（shareRef + 简介 + 覆盖）
```

新增服务：`social-content`（`worker/social-content/src/*`，端口 8842，仅 127.0.0.1）。
main-agent 只做**鉴权后的反代**；外部契约仍是 `/agent/v1/social/*`（Caddy 剥 `/agent` 后到 `/v1/social/*`）。

## 2. 文件清单（本卡改动）

| 文件 | 作用 |
| --- | --- |
| `worker/social-content/src/config.ts` | env → 配置（开关/预算/来源/服务令牌），默认值对齐契约 7.2 |
| `worker/social-content/src/store.ts` | D1 持久化：`(scope,message,occurrence)` 唯一、revision CAS、租约、重启恢复、内容版本单调 |
| `worker/social-content/src/service.ts` | 编排：开关门控、幂等、{503 未持久化}、retry 真重跑、excerpts、内容落库装饰器 |
| `worker/social-content/src/runtime.ts` | 真实能力注入：`node:dns` 解析 + 连接绑定 transport + 三平台适配器 |
| `worker/social-content/src/index.ts` | Worker 入口与路由、鉴权、请求体上限、惰性启动恢复 |
| `worker/social-content/schema.sql` | 追加 `social_content_items`（内容库，content_revision 单调） |
| `worker/social-content/nodeTransport.js` | **修** lookup 的 `all:true` 形态（父卡实现会 ERR_INVALID_IP_ADDRESS） |
| `worker/social-content/handlers.ts` | 只把错误码→HTTP 表导出复用（无行为变更） |
| `utils/socialShare.ts` | 客户端：识别、resolve/retry/excerpts、状态合并、投影、安全跳转、历史恢复 |
| `utils/messageFormat.ts` | 带 `metadata.shares` 的消息 → 模型投影（链接换 shareRef） |
| `apps/Chat.tsx` | 发送链路：识别→落库→解析（首屏 1500ms）→写卡；开启时跳过旧 xhs/webpage 卡片链路 |
| `components/chat/SocialShareCard.tsx` | 卡片 UI（纯文本、状态、打开、重试） |
| `components/chat/MessageItem.tsx` | `metadata.shares` → 渲染分享卡片 |
| `worker/main-agent/src/index.js` | `/v1/social/*` 鉴权后反代 + `/health` 暴露 `shareLinks` 开关 |
| `vps-backend/config/services.js` | 注册 `social-content` 服务（8842，D1 绑定 + schema） |
| `scripts/build-workers.mjs` | 构建清单加入 `social-content`（`node:*` 外置） |
| `scripts/audit/socialShareTokenAudit.ts` | 上下文体积审计（可复算） |

## 3. 配置

### 3.1 服务端（`social-content` 进程）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SHARE_LINKS_ENABLED` | `false` | 总开关。false 时所有 `/v1/social/*` 返回 503 `SHARE_LINKS_DISABLED` |
| `SOCIAL_SERVICE_TOKEN` | 空 | 内部服务令牌；空且未开匿名 → 403 fail-closed |
| `SOCIAL_SERVICE_ALLOW_ANONYMOUS` | `false` | 仅本机调试用；生产不要开 |
| `SOCIAL_CONTENT_DB_PATH` | `vps-backend/data/social-content.sqlite` | SQLite 落盘位置（D1 兼容层） |
| `SOCIAL_SOURCE_ID_BILIBILI` / `_XIAOHONGSHU` / `_DOUYIN` | `public` | 来源标识；置空 = 未配置来源（`SOURCE_NOT_CONFIGURED`） |
| `SOCIAL_MAX_LINKS_PER_MESSAGE` | 5 | 单条消息进解析队列上限，超出逐项 `SIZE_LIMIT` |
| `SOCIAL_MAX_CONCURRENT_PER_SCOPE` | 2 | 同 scope 并发解析上限 |
| `SOCIAL_RESOLVE_DEADLINE_MS` | 20000 | 单次 resolve 总期限 |
| `SOCIAL_PER_REQUEST_TIMEOUT_MS` | 8000 | 单次出站请求超时 |
| `SOCIAL_MAX_REDIRECTS` | 5 | 逐跳复验的重定向上限 |
| `SOCIAL_CONTENT_CACHE_ALLOWED` | `true` | 是否把正文/字幕/评论样本落到本机内容库。**false 时 excerpts 不可用**（契约 5.6 的“不持久正文”由它承担） |
| `TRANSCRIPTION_ENABLED` | `false` | ASR；v1 未实现（见 §7） |
| `EXPERIMENTAL_XHS_COMMENTS` | `false` | XHS 实验评论；v1 未实现 |
| `REDNOTE_INDEPENDENT_SESSION` | `false` | rednote.com 独立会话（未验证） |
| `SOCIAL_DEPLOYMENT_SCOPE` | `deployment` | 可信 scope，仅服务端决定；**从不读 body/query** |

### 3.2 main-agent

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SOCIAL_CONTENT_URL` | 空 | 内部服务地址（如 `http://127.0.0.1:8842`）。空 → 503 `social_content_unavailable` |
| `SOCIAL_SERVICE_TOKEN` | 空 | 与 social-content 同一把；反代时注入 `X-Social-Service-Token` |
| `SHARE_LINKS_ENABLED` | `false` | 仅用于 `/health` 展示（真正的门控在 social-content） |

### 3.3 前端（浏览器）

`localStorage['os_social_share_config']` = `{ "enabled": true }`（可带 `baseUrl`/`token` 覆盖 `os_api_config.agentUrl`）。
**默认关闭**：未设置时 `isSocialShareEnabled()` 为 false，发送链路与集成前一致。

## 4. 开关与回滚

- **灰度/回滚（不改代码）**：把 `SHARE_LINKS_ENABLED=false`（服务端）或清掉前端
  `os_social_share_config`（前端）任一关掉，即回到旧行为；已存在的旧消息卡片仍按 metadata 渲染，不影响历史。
- **完全回滚**：`services.js` 里把 `social-content` 的 `enabled` 置 false，main-agent 的
  `SOCIAL_CONTENT_URL` 置空；代码层无需改动（路由存在但 503，旧卡片不动）。
- **注意**：前端开关打开、服务端关闭时，发送不会被阻塞，但会收到一次“消息已按原文发送”的提示，
  并保留原文（不建半成品卡）。

## 5. 真实网络验证（本机出口在海外，2026-10-24，只读、无账号/Cookie）

**返工后（t_42231e16）新增：真实网络探针测试**，默认跳过，只有显式开启才跑，避免把真网络混进
CI 的 mock 测试里：

```
SOCIAL_REAL_NETWORK=1 npx vitest run worker/social-content/realNetwork.probe.test.ts --reporter=verbose
→ REAL_NETWORK_PROBE [ {...}, {...}, {...} ]   # 每平台一行：outcome/ms/title/bodyChars/transcript/errorCode
```

最近一次原始输出（完整日志见附件 `real-network-probe.log`）：

| 输入 | 结果 | 说明 |
| --- | --- | --- |
| `https://www.bilibili.com/video/BV1xx411c7mD` | **`ok`**（1.7s） | 真实读到：标题「字幕君交流场所」、正文 3 字符、原生字幕 `not_available`、评论样本 `available`。**B 站真实接通（该样例内容极少，但确为真实响应）** |
| `https://www.iesdouyin.com/share/video/7300123456789012345/` | `failed / AUTH_REQUIRED`（2.6s） | 分享页 302→www.douyin.com 后返回登录墙；结构化错误如实返回。ID 为探针输入，不保证视频存在 |
| `https://www.xiaohongshu.com/explore/64f0aa11bb` | `failed / AUTH_REQUIRED`（0ms，不出站） | XHS 会话桥停用（缺 camofox），detail 能力为 false：**实现层面就不抓正文**，直接如实报需要登录 |

### 5.1 一个真实的适配器缺陷（本轮修掉）

上一轮探测把 B 站 412 归因为「风控不可绕」。本轮把请求头拆开重测，发现**恰恰是伪装的
Chrome UA 触发 412**（同一 URL、同一出口、同一时间点）：

```
curl -A "Mozilla/5.0"        → HTTP 412（风控页）
curl -A "Mozilla/5.0 ... Chrome/120 Safari/537.36" → HTTP 412
curl -A "curl/8.5.0"         → HTTP 200 {"code":0,...}
curl -A "SullyOS/1.0 (...)"  → HTTP 200 {"code":0,...}
```

适配器原先把 UA 伪装成桌面 Chrome → 每次都 412。改为说明用途的中性 UA（`SullyOS/1.0
(social-content; read-only link resolver)`）后，真实探针拿到了 `code:0` 的真实内容。
这不改任何契约/权限，只是不再冒用浏览器身份。

### 5.2 仍然受限的部分（不许写成“已接通”）

- 抖音：登录墙，一次出口一个时间点，未尝试账号/Cookie 绕过。
- 小红书：会话桥停用是**产品决策**，不是网络问题；正文能力恒为 `AUTH_REQUIRED`。
- 字幕/评论的二次 URL（`aisubtitle.hdslb.com`、reply 接口）本轮样例没有字幕轨，
  故真实字幕内容仍未验证；只有夹具覆盖。

## 6. 自动化验证（本机真实执行）

返工 t_42231e16 后的定向回归（真实执行，原始输出见附件 `vitest-focused.log`）：

```
npx vitest run worker/social-content utils/socialContent utils/socialShare.test.ts \
  utils/messageFormat.share.test.ts utils/socialShareTool.test.ts utils/socialShareTool.wiring.test.ts \
  worker/main-agent/src/socialProxy.test.ts components/chat/SocialShareCard.test.tsx
→ Test Files 19 passed | 1 skipped (20)
→ Tests      263 passed | 1 skipped (264)
（跳过的那 1 个是真实网络探针：只有 SOCIAL_REAL_NETWORK=1 才跑，避免把真网络混进默认 CI）
```

真实网络（单独跑、单独留证）：

```
SOCIAL_REAL_NETWORK=1 npx vitest run worker/social-content/realNetwork.probe.test.ts --reporter=verbose
→ 1 passed；REAL_NETWORK_PROBE 三行见 §5
```

全量门禁（原始日志见附件，失败也要如实留档）：

```
npx tsc -p tsconfig.json --noEmit        → TSC_EXIT=2；56 个错误，与返工前基线**逐条相同**
                                           （vps-backend/mastodon-mcp、components/os、utils/* 等），
                                           本次改动/新增文件 0 个错误（附件 tsc-full.log）
npx vite build                           → VITE_EXIT=0，built in 5m 31s（复审返工轮重跑；附件 vite-build.log）
node scripts/build-workers.mjs           → 8 个 bundle 重建；只有 social-content/worker.bundle.js 变化
node scripts/check-worker-bundles.mjs    → CHECK_EXIT=0「worker bundle 与源码一致」（附件 check-workers.log）
```

覆盖点（与验收矩阵对应）：

- **识别**：三平台长短链、`/discovery/item`、BV/av、分 P、重复链接合并、第 6 条起 `SIZE_LIMIT`、相似域名拒绝。
- **状态机与持久化**（真实 SQLite）：唯一约束、revision CAS、跨 scope 404、租约抢占/释放、
  **幂等入口**（终态复用/在途复用/过期接管）、重启恢复（`includeLive`）、迟到写入不覆盖。
- **接口差异修复**：`nodeTransport` 的 `lookup(all:true)` 形态、**中性 UA**（412 风控）。
- **重复回复/异步竞态**：首屏只等 1500ms；占位先落库；晚到结果只写卡不触发第二次模型调用；
  合并按 `(attempt, revision)` 单调丢弃旧事件。
- **安全**：SSRF（相似域名/IP 字面量/私网/重定向跨站/无 pinned 地址拒绝）、**全链路期限**
  （DNS/正文/重定向链都在预算内、非正文响应显式 discard）、正文体积夹紧（200000 字符 + `truncated`）、
  请求体 256KiB + 文本 16000 UTF-16 上限、跨 scope 不可枚举、外部文本低信任隔离 + 边界伪造中和、
  跳转仅 https、服务令牌不进 `/health`。
- **字幕语义**：available/failed/not_available/not_requested/absent 五态，只有 failed 降级为 partial，
  其余状态在投影里显式说明「没有字幕，只能按简介讨论」。
- **凭据**：服务端不接受请求体里的 baseUrl/token/账号；XHS 不读 Cookie；反代不透传客户端 token。

### 6.1 联调实测（本机两进程：main-agent 18830 → social-content 18842，真实外网 + 真实 SQLite）

用本卡构建的 bundle 起两个本地宿主（`social-host.mjs`），走浏览器同款契约（`/agent/v1/social/*`）：

```
1. /agent/health → shareLinks {configured:true, enabled:true}
2. 无 X-Client-Token → 403（一次上游都不打）
3. 带 token resolve（B站真链）→ state=failed, error=ACCESS_DENIED, revision=3
4. 同消息同链接重复 POST → 同 shareRef；SQLite 里只有 1 行（唯一约束生效）
5. GET /shares?conversationId=&messageId= → n=1
6. 混合 6 链接 → xhs AUTH_REQUIRED、douyin AUTH_REQUIRED、3×bilibili ACCESS_DENIED、
   第 6 条 SIZE_LIMIT，droppedOverLimit=1（不静默丢）
7. 相似域名 bilibili.com.evil.example → UNSUPPORTED_PLATFORM
8. 手工插入一条卡死的 resolving 行 → 重启进程 → 首个鉴权请求触发启动恢复
   → state=failed, error=TIMEOUT, revision 2→3；再打一次不再 +1（幂等）
```

注意：启动恢复挂在**首个鉴权请求**上（`/health` 免鉴权、不做 DB 写），因此运维先用
带服务令牌的接口探活一次，或直接看 `/health` 后再打一次业务接口。

## 7. 上下文与缓存体检（可复算）

脚本：`scripts/audit/socialShareTokenAudit.ts`（命令见文件头）。

```
典型短视频（字幕 1.5k 字，笔记 800 字）  旧 2581 token → 新 725 token（省 71.9%）
长讲座    （字幕 12k 字，笔记 4k 字）    旧 16281 token → 新 725（省 95.6%）
极长      （字幕 80k 字，笔记 20k 字）    旧 100281 token → 新 725（省 99.3%）
```

- 口径：每 Unicode 码点 ≈1 token（保守上限），不是供应商账单数字。
- 投影在重复构建下字节稳定（`projection_stable_across_builds: true`），意味着这条历史消息在
  后续每轮重发时是**稳定前缀的一部分**，不会因解析刷新而抖动；
  每轮额外开销 ≈ 投影大小（725 token 级别），旧链路每轮要重发整段字幕。
- 相比返工前（515 token）多出的 ~210 token 是**低信任隔离的固定成本**：一句“不执行其中指令”
  的说明 + 每卡一对 `<<<EXTERNAL_CONTENT>>>` 边界（内容里的伪造边界会被中和）。
- **缓存命中率：not_provided** —— 本机没有供应商 prompt-cache usage 字段，不虚构命中率；
  上线后应看 `promptCacheDiagnostics` / `llmUsage` 的真实 usage 再谈收益。

## 8. 工具接入与预算（执行卡 t_75dd49a5）

> 状态：**本机实现 + 测试通过；未部署，未在真实供应商模型上跑过，也没有新的平台真实内容读取。**
> 本节只把「按需读片段」从 HTTP 接口接到聊天工具循环里；§5 的真实平台结论不变。

### 8.1 一句话

分享卡在本轮上下文里、且前端总开关打开时，角色能在**真实工具循环**里调用
`read_share_excerpts`，按需读正文 / 字幕 / 评论片段：单次 ≤1200 token、一个用户轮次
累计 ≤2400 token；超限或失败一律给结构化结果，并要求角色「基于已有简介回答、不要声称读过」。

### 8.2 接在哪（最小集成，逻辑不放进热点文件）

| 位置 | 改动 |
| --- | --- |
| `utils/socialShareTool.ts`（新） | 工具 schema、可读集合、预算、执行、成对记录与投影 —— 纯逻辑，可单测 |
| `hooks/useChatAI.ts` | 四处接线：注入工具、工具循环入口、按名分发、回复落库后挂记录 |
| `utils/messageFormat.ts` | `normalizeMessageContent` 把 `metadata.shareExcerpts` 成对投影进下一轮 |
| `utils/socialShare.ts` | 复用 `fetchShareExcerpts`（未改动）；没有新造抓取/URL 接口 |

### 8.3 权限与入参边界

- 入参只有：`shareRef` 或 `contentId`（至少一个）、`query`、`fields`、`partKey`、`cursor`、
  `maxTokens`，外加仅作提示的 `contentRevision`（实际版本用卡片自己的）。
- 传 `url` / `baseUrl` / `token` / `scope` / `headers` / `cookie` 等 → `ARGUMENT_NOT_ALLOWED`，
  **一次请求都不发**（授权 scope 仍由服务端决定，客户端不传）。
- 可读集合只来自**本轮真正进上下文的消息** `metadata.shares`（服务端落过库的卡）。
  集合外的 shareRef/contentId → `SHARE_NOT_IN_CONTEXT`；两者指向不同卡 → `SHARE_TARGET_MISMATCH`。
- 卡片状态不是 `ready`/`partial`、或没有 `contentId`/版本 → `SHARE_CONTENT_NOT_READY`，不读。
- 只读：不写服务端、不改配置、不落业务数据；唯一副作用是本轮预算记账。

### 8.4 预算口径（硬约束）

- 单次 1200 / 轮次 2400，直接复用 `SHARE_BUDGETS.excerptsPerCallTokens / excerptsPerUserTurnTokens`。
- 预算对象**一轮一个**，工具循环里多次模型迭代、同批多个调用共享同一份，不随 handler 重置。
- 并发调用先「预留」再发请求：同一批 tool_calls 不会各自按剩余额度算全额（不超卖）。
- 不信任模型传的 `maxTokens`（夹紧），也不信任响应自报的 `tokenEstimate`：按仓库既有保守口径
  （每 Unicode 码点 ≈1 token）重算，并把交给模型的文本夹进额度。
- 请求服务端时先扣掉「结果信封 + 服务端可能多回的那一条切片」（单条上限 400 字符），
  避免为了砍溢出片段而丢掉 `nextCursor`；真溢出时由客户端截断并在结果里说明。
- 剩余额度连一条切片都放不下（<320）→ `TURN_BUDGET_EXHAUSTED`，不发请求。
- 同参重复调用 → `DUPLICATE_TOOL_CALL`（不再打网络、不再扣额度）；一轮最多 8 次调用（`TOOL_CALL_LIMIT`）。

### 8.5 结果语义（模型看到什么）

| code | 含义 | 模型被要求怎么做 |
| --- | --- | --- |
| `OK` | 读到了片段（带 `cursor` 可续读） | 用片段内容回答 |
| `NO_SEGMENTS` | 请求成功但该字段/关键词没匹配到 | 别把「没匹配到」说成「读过了」 |
| `SHARE_NOT_IN_CONTEXT` / `SHARE_CONTENT_NOT_READY` / `MISSING_TARGET` / `SHARE_TARGET_MISMATCH` | 目标不合法或没内容 | 基于已有简介回答 |
| `TURN_BUDGET_EXHAUSTED` / `TOOL_CALL_LIMIT` / `DUPLICATE_TOOL_CALL` | 超预算/超次数/复读 | 基于已有简介回答 |
| `VERSION_UNAVAILABLE` / `CONTENT_NOT_FOUND` / `TIMEOUT` / `NETWORK_ERROR` / `SHARE_LINKS_DISABLED` | 服务端透传的真实失败 | 如实说明片段不可用 |

每种失败文本都带同一句收口：「片段没有读到……不要声称自己读过原文/字幕/评论」。

### 8.6 历史与下一轮投影

- **实际历史**（请求里）：`assistant(tool_calls)` + `role:tool`（`tool_call_id` 相同）成对进消息数组，
  下一跳请求与最终回复都基于这份成对记录。
- **落库**：回复落库后把本轮 call/result 成对写进该条助手消息的 `metadata.shareExcerpts`；
  下一轮 `normalizeMessageContent` 渲染成 `[上轮 read_share_excerpts 记录 · N 次调用]`（≤600 token）。
- **明确**：片段会占未来上下文（不承诺它们不占），只是有界且成对，不会只剩一段孤立片段
  让模型误以为自己读过更多。

### 8.7 开关与回滚

- 默认关：不注入工具，行为与集成前完全一致（清掉 `os_social_share_config` 即回滚）。
- 服务端 `SHARE_LINKS_ENABLED=false` 时工具仍在，但调用返回 503 系错误，模型如实说片段不可用。
- 只有模型/中转支持 function calling 时有效：中转拒绝 `tools` 的轮次会退回无工具，
  并显式告诉模型「这一轮外部工具不可用：不要声称读过分享片段」。

### 8.8 本机验证（真实执行，2026-10-24）

```
npx vitest run utils/socialShareTool.test.ts          → 22 passed
npx vitest run utils/socialShareTool.wiring.test.ts   → 8 passed
npx vitest run $(ls utils/*[cC]hat*.test.ts)          → 38 files / 354 passed
npx vitest run utils/mcpToolBridge utils/agenticTools utils/messageFormat \
  utils/socialShare utils/chatRequestPayload worker/social-content utils/socialContent
                                                       → 29 files / 326 tests passed
```

覆盖点：

- **真实代码链路**：分享卡在上下文 → 工具 schema → 模型 `tool_calls`（fixture 模型）→ 执行器 →
  `fetchShareExcerpts` 的 HTTP 契约 → 服务端真实 `buildExcerpts`（fixture 内容记录）生成响应 →
  `role:tool` 结果 → 下一跳请求成对 → 最终回复 → 落 metadata → 下一轮投影读得回来。
  桩只在 `fetch` 与模型输出上；响应体不是手写 JSON，是仓库真实服务端函数算出来的。
- 预算：单次夹紧、轮次累计、并发不超卖、小额直接拒绝、同参去重、次数上限、收费按自身重算。
- 权限：URL/baseUrl/token/scope 拒绝且不发请求；集合外 shareRef/contentId 拒绝；状态不符拒绝；
  cursor 格式校验；shareRef/contentId 映射与错配。
- 失败：`VERSION_UNAVAILABLE`、`CONTENT_NOT_FOUND`、`NO_SEGMENTS`；失败文本都要求如实说没读到。
- 历史：call/result 成对落 metadata、投影有界、只对助手消息生效、锚点只挑本轮之后的消息。

### 8.9 未验证 / 未部署（必须带着交付）

1. **真实模型是否会用这个工具**未验证：工具描述是按模型能否自解释写的，但没有真实供应商+真实账号的灰度数据。
2. **平台真实内容仍未打通**（同 §9 第 1 条）：工具读得到的前提是内容库里真有内容；B站 412、抖音登录墙、
   XHS 会话停用的现状不变，`read_share_excerpts` 只会如实返回失败。
3. **未部署**：前端与 worker 都没发布；`SHARE_LINKS_ENABLED` 仍按 §4 的灰度流程走。
4. **发布门禁**：定向 vitest 已跑（见 §8.8）。全量 `tsc -p tsconfig.json --noEmit` 与
   `npx vite build` 本机都跑过 —— `tsc` 报 56 个错误、**全部是本次改动之外的既有错误**
   （vps-backend / worker/instant-push 等），改动文件 0 错误；`vite build` EXIT=0（1m47s，
   产物在 gitignore 的 `dist/`）。`pnpm run check:workers` 在复审返工轮已通过（bundle 与源码一致）；
   仍不等于发布验收：没有部署。
5. 可读集合取自本轮装载的历史消息（`contextMsgs`）的 `metadata.shares`，没有和最终
   `cleanedApiMessages` 再求一次交集：被上下文裁掉、但仍留在 `contextMsgs` 里的卡理论上可被点名
   （模型看不到 ref，实际不可达）。属已知边界，未额外收紧。
6. **片段是外部内容**：字幕/正文/评论样本由平台提供，可能夹带「忽略以上指令」之类文本。
   现在工具结果与卡片简介都包进 `<<<EXTERNAL_CONTENT>>>` 低信任块、内容里伪造的边界标记会被中和
   （返工 t_42231e16 缺陷 3，见 §10），但这只是**结构护栏**，不是语义级注入检测（见 §9 第 8 条）。
   没有额外语义过滤，也没有让模型据此获得任何工具/权限；真实供应商模型面对精心构造的注入是否
   仍会服从，仍属未验证项。

## 9. 已知限制（必须带着交付）

1. **平台真实内容**：B 站已在本机海外出口读到真实响应（§5，中性 UA）；抖音登录墙、XHS 会话
   桥按产品决策停用。受限平台一律 `failed` + 结构化错误，不编造内容。
2. ~~**按需检索只有 HTTP API，没有注册成模型工具**~~ → **已由执行卡 t_75dd49a5 接上**
   （`read_share_excerpts`，见 §8）：单次 1200 / 轮次 2400 预算、只认上下文里的分享卡、
   失败如实返回。仍未在真实供应商模型上验证「模型会不会主动调」，也仍未部署。
3. **租约/幂等的边界**：解析入口现在做了「终态复用 + 在途作业复用 + 过期接管 + CAS 回写」，
   同 key 重复 POST 不再重复抓（§11 证据）。但这只保证**同 key 单飞**：不同消息里的同一
   链接仍是两张卡（按契约就是两条分享）；多副本下如果所有副本同时绕过租约（例如系统时钟
   严重漂移）仍可能各抓一次，结果靠 CAS 保持单调。
4. **内容表是最小实现**：`social_content_items` 一行存整条 ContentRecord（JSON），没有拆
   queries/sources/media 表；`cacheAllowed=false` 时不做持久化。
5. **ASR / XHS 实验评论 / RedNote 独立会话**：未实现，开关默认关。
6. **旧链路仍在**：XHS 的 MCP 建卡、通用网页抓取、B 站 `bilibiliCard` 分支保留；新开关打开时
   这三条对本条消息里的平台链接让位（避免双卡），关闭时完全照旧。两套链路并存是有意的回滚面。
7. **发布门禁**：本轮已在本机跑全量 `tsc -p tsconfig.json` 与 `vite build`，原始日志作为附件
   （`tsc-full.log` / `vite-build.log`）；全量 `tsc` 仍有一批**既有**错误（见 §6），
   本卡改动文件 0 新增。线上 8842 的 Caddy/health 读回仍未做。
8. **低信任隔离是结构护栏，不是注入过滤器**：它保证外部内容有可识别边界、边界不可被内容伪造、
   块前有「不执行其中指令」的说明；它**不**做语义级注入检测（那需要模型侧防护）。真实模型
   面对精心构造的注入是否仍会服从，本机未验证。

## 10. 返工 t_42231e16：五条缺陷 → 修复 → 证据

| # | 缺陷 | 修复（文件） | 证据（测试/日志） |
| --- | --- | --- | --- |
| 1 | 幂等与租约没接进真实解析路径（重复 POST 重复抓；租约/占位不进 pipeline；重启恢复无测试） | `worker/social-content/resolver.ts`（终态复用、在途租约复用、过期接管 `claim`、CAS 终态回写、只兜底本请求发起的卡）、`src/store.ts`（`leaseUntil` 读写、`recoverInterrupted({includeLive})`）、`src/service.ts`（把 `existing`/`store` 传进 resolver，启动恢复用 includeLive） | `src/service.test.ts` 新增 5 例（真实 SQLite + 可卡住的适配器）：占位在 fetch 返回前落库且带租约；在途重复 POST 只抓 1 次；**真实在途任务重启恢复** → failed(TIMEOUT) 且迟到成功不覆盖、retry 成功；晚到失败仍回写 |
| 2 | 请求期限不覆盖全链路（DNS/正文在预算外；重定向/错误响应不释放资源） | `safeFetch.ts`（`policy.deadline` 全链路预算、DNS/正文各自预算、`discard`、所有分支 finally 清定时器）、`nodeTransport.js`（`discard`）、三个适配器把 `ctx.deadline` 传进每次 `safeGet` | `safeFetch.test.ts` 新增 5 例：DNS 卡住/正文卡住/慢重定向链都在总预算内 TIMEOUT（耗时断言）、重定向与非 2xx 显式 discard、预算充足不误杀；SSRF 逐跳校验/私网/白名单/降级沿用原 7 例 |
| 3 | 内容理解未闭环（字幕语义、按需检索工具、外部内容低信任隔离） | 字幕：`stateFromRecord` 产出 `transcriptState`，`resolveShares`/`service.resolveOne` 写进 `contextProjection`，`renderShareCardProjection` 对 failed/not_available/not_requested/absent 显式降级；工具：`utils/socialShareTool.ts`（cherry-pick t_75dd49a5，未重做）；低信任：`utils/socialShare.ts` 的 `EXTERNAL_UNTRUSTED_NOTICE` / `externalBlockOpen` / `sanitizeExternalText` / `wrapUntrustedContent`，`buildShareMessageProjection` 每卡包块，工具片段同样包块 | `utils/socialShare.test.ts` 新增 8 例（3 例注入边界 + 5 例字幕五态）；`utils/socialShareTool.test.ts` 新增 1 例（片段包块 + 伪造标记中和 + 预算不超卖）；`src/service.test.ts`/`chain.test.ts` 断言投影含字幕降级说明 |
| 4 | `socialShare.ts` A-B-A 交错重复链接的 span 替换偏移 | `buildShareMessageProjection`：全局按起点升序做合法性/重叠裁剪，再**倒序一次性替换**（不再按卡片分组） | `utils/socialShare.test.ts` 新增 2 例：A-B-A 精确输出（`先看[分享 a]，再看[分享 b]，最后回到[分享 a]。`，a 出现 3 次、b 2 次）、越界/重叠 span 跳过不写错位置 |
| 5 | 证据不完整（无类型检查/构建原始日志；真实网络与 mock 不分；无三平台真实证据） | 新增 `worker/social-content/realNetwork.probe.test.ts`（仅 `SOCIAL_REAL_NETWORK=1` 跑）、B 站 UA 修复（中性 UA，见 §5.1） | 附件 `tsc-full.log`、`vite-build.log`、`real-network-probe.log`；本文 §5/§6 引用。三平台里 B 站真实成功，抖音/XHS 如实失败并说明原因 |

### 10.1 复审返工（arch-reviewer comment #51）：两条 P1 阻断项

| # | 复审意见 | 修复 | 证据 |
| --- | --- | --- | --- |
| A | 内容理解真实链路被 `light()` 截断：`service.ts` 把所有响应卡的 `contextProjection` 清成 null，Chat 存进 `metadata.shares` 后丢 `contentRevision`/`transcriptState`，`socialShareTool` 把真实成功卡判为 unreadable、投影写成“解析中/字幕未取得”。测试直接手造完整卡不能证明聊天工具真实可用 | 新增 `worker/social-content/src/delivery.ts`：`boundedProjection()` 交付**有界**冻结投影（summary ≤400 字符、coverage ≤8 项 ×24 字符、reason ≤200，不补造缺失的 transcriptState），`lightAttachment()` 由 `service.ts`（resolve/list/get/retry）与 `handlers.ts` 共用；完整正文仍只在内容库，经 excerpts 按需取 | `src/delivery.test.ts`（新增 3 例）走真实 service（真实 SQLite）→ 真实客户端 `resolveSharesForMessage`（真实 `shareRequest` 拼 URL/header/JSON）→ Chat 同款 `metadata.shares` → `buildShareMessageProjection` → `createShareExcerptTurn`/`hasReadableShareExcerptTarget` → `executeShareExcerptToolCall` → 真实 `buildExcerpts`：断言投影带 contentRevision=1 与 transcriptState、响应不含正文深处标记、工具可注入、片段带低信任块、预算不超卖；字幕五态（available/failed/not_available/not_requested/absent）逐态断言投影文案；有界投影对脏数据夹紧 |
| B | `safeFetch` 总期限没覆盖 DNS 后的连接阶段：DNS 花掉预算后 transport 又领一份完整 `hopBudget`，慢 DNS + 慢响应头可越过 absolute deadline（外层 resolver 的竞速不取消底层连接） | `safeFetch.ts`：连接/响应头 timer 只用 `min(hopBudget - DNS耗时, deadline - now)` 的**剩余**预算；正文到期时除 abort 外显式 `discard()` 释放底层连接；头注释写清按阶段扣减的语义 | `safeFetch.test.ts` 新增 2 例：慢 DNS(300ms)+慢响应头在总预算 400ms 内 TIMEOUT 且断言 abort 发生时刻不越过 deadline（旧实现 ≈700ms，测试会失败）、正文到期 discard 记录 `['200']`；原有 DNS/正文/慢重定向链/SSRF/discard 回归全保留 |

本轮改动文件：
`worker/social-content/src/delivery.ts`(新)、`src/delivery.test.ts`(新)、`src/service.ts`、`src/service.test.ts`、
`handlers.ts`、`handlers.test.ts`、`safeFetch.ts`、`safeFetch.test.ts`、`worker/social-content/worker.bundle.js`(重建)、本文。

模型/provider 与边界审计：见附件 `model-boundary-audit.log`（脱敏；未读取任何密钥）。

### 10.2 复审返工（arch-reviewer comment #55）：正文异常路径的资源释放 + 边界审计原始记录

| # | 复审意见 | 修复 | 证据 |
| --- | --- | --- | --- |
| 1 | `safeFetch.ts` 的正文 timer 与异常响应清理没真正收口在 try/finally：`readBody` 异步拒绝只 `clearTimeout` 就 reject（既不 discard 也不 abort）；`readBody` 同步抛出时 `bodyTimer` 不进任何 finally，会一直活到正文期限才触发，给已失败的调用留下延迟副作用 | 抽出 `readBodyWithinBudget()`：到期 / 异步拒绝 / 同步抛出三条路径共用幂等的 `release()`（先 `abort()` 再 `discard()`），并与连接 timer 一起收在明确的 `finally`；错误映射保持原语义（到期 → `TIMEOUT/body_timeout`；`SocialError` 原样透传；其余 → `NETWORK_ERROR/body_read_failed`）。同步抛出过去会原样冒泡非 `SocialError`，现在统一映射为 `NETWORK_ERROR/body_read_failed` | `safeFetch.test.ts` 新增 5 例：异步拒绝（`SocialError`）保留错误码且 abort/discard 各恰好 1 次；异步拒绝（普通错误）→ `NETWORK_ERROR`；同步抛出 → `NETWORK_ERROR` + 即时释放；另两例用 fake timers 断言 `vi.getTimerCount() === 0`、推进 2s 后 abort/discard 不再增加。**返工前用同一组测试跑旧实现：5 failed / 28 passed（`safeFetch-red-old-impl.log`）**；修复后该文件 33 passed |
| 2 | 边界审计缺原始运行记录（“会话元数据同值 / 未执行”是自述，config mtime 只覆盖 run74） | 新增可复跑脚本 `boundary_audit.py`：只读打开 per-profile `state.db`，投影 run69/run74 的 `sessions` + `session_model_usage` + 工具调用直方图与敏感面命中；对 default `config.yaml` 22:50:17 的写入做 hunk 级归档（密钥类值掩码） | `model-boundary-audit.log`：run69/run74 = `deepseek-v4.1-flash` + `opencode-go`（base_url `https://opencode.ai/zen/go/v1`）、237/137 次工具调用；run69 敏感面命中 0；run74 的 config/gateway/caddy 命中原文逐条核对为 `stat`/`grep`/`sed -n`/`ps` 只读；default 配置 22:50:17 的两个 hunk 是 `kanban.max_in_progress` 插入 + `fallback_providers` 首条路由改成 `opencode-go/deepseek-v4.1-flash/high`；gateway 最后一次启动 10:13:15（早于 run69）；`wt/t_42231e16` 无远端跟踪分支、两次 run 无 `git push`。**具体写入进程未验证**（无 config 写入审计日志、`/root/.bash_history` 空），只声明不是本卡 run69/run74 的工具动作 |

本轮改动文件：`worker/social-content/safeFetch.ts`、`worker/social-content/safeFetch.test.ts`、本文。
（`worker/social-content/worker.bundle.js` 由 `safeFetch.ts` 变化需重建，已重建并在门禁里核对一致。）

## 11. 发布步骤（本卡未执行，交发布流程）

1. `pnpm run build`（含 `build:workers`，产出 `worker/social-content/worker.bundle.js`）。
2. 定向门禁：本文件 §6 的 vitest 命令 + `pnpm run check:workers`。
3. 全量 `tsc -p tsconfig.json` 与 `vite build`，记录错误集合基线。
4. `/opt/sullyos/.env` 增加：`SHARE_LINKS_ENABLED=false`（先关）、`SOCIAL_CONTENT_URL=http://127.0.0.1:8842`、
   `SOCIAL_SERVICE_TOKEN=<随机>`；`vps-backend` 侧 `npm install better-sqlite3`（已有）。
5. 启 8842 → `curl 127.0.0.1:8842/health` 读回 `persistence: available`；
   启 main-agent → `curl /agent/health` 读回 `shareLinks.configured=true`。
6. 先对单个测试账号把前端 `os_social_share_config.enabled=true` 打开做灰度；
   观察卡片状态与 §7 的 usage，再考虑把 `SHARE_LINKS_ENABLED` 打开。
7. 回滚见 §4。
