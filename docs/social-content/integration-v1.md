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
| `utils/socialShareTool.ts`（新） | 工具 schema、可读集合、引用解析、预算、执行、成对记录器（`ShareExcerptPairRecorder`）与投影 —— 纯逻辑，可单测 |
| `hooks/useChatAI.ts` | 六处接线：注入工具（**拿不到持久化锚点时不注入**）、工具循环入口、按名分发（`dispatchShareExcerptToolCall`＝执行+立刻落库）、成功尾部与 `finally` 两处收尾 flush（有界重试，仍失败明确上报「未保存·待补偿」）、降级提示 |
| `utils/chatToolLoopBudget.ts`（新） | 工具循环总轮数的**唯一口径**（纯函数）：MCP / 分享-only / 混用三类分开算，分享卡在场不改变混用工具的用户设置（见 §8.4 末条） |
| `utils/messageFormat.ts` | `normalizeMessageContent` 把 `metadata.shareExcerpts` 成对投影进下一轮 |
| `utils/socialShare.ts` | `fetchShareExcerpts` 未改；**只改了模型投影**：`[分享 …]` 用完整 shareRef（见 §8.6） |

### 8.3 权限与入参边界

- 入参只有：`shareRef` 或 `contentId`（至少一个）、`query`、`fields`、`partKey`、`cursor`、
  `maxTokens`，外加仅作提示的 `contentRevision`（实际版本用卡片自己的）。
- 传 `url` / `baseUrl` / `token` / `scope` / `headers` / `cookie` 等 → `ARGUMENT_NOT_ALLOWED`，
  **一次请求都不发**（授权 scope 仍由服务端决定，客户端不传）。
- 可读集合只来自**本轮真正进上下文的消息** `metadata.shares`（服务端落过库的卡）。
  集合外的 shareRef/contentId → `SHARE_NOT_IN_CONTEXT`；两者指向不同卡 → `SHARE_TARGET_MISMATCH`。
- **引用解析只做三件事，宁拒绝不猜**（返工卡 t_38463abd P1）：① 完整 shareRef 精确命中；
  ② 否则按前缀找（只接受 ≥8 字符），**唯一**命中才用；③ 命中多张 → `SHARE_REF_AMBIGUOUS`
  并列出候选完整引用，一次请求都不发。形状不对（URL/路径/空格等）→ `SHARE_REF_INVALID`。
  绝不按相似度/长度挑一张，否则会把 A 卡的内容当成 B 卡的回答。
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
- **工具循环总轮数（返工第 4 轮 P1-2）**：口径收在 `utils/chatToolLoopBudget.resolveChatToolLoopBudget`
  （纯函数，hook 不再自己算），三分支：
  ① 本轮注入了通用 MCP → `max(用户设置, 12)`（保持 master 侧 12 轮预算，原行为）；
  ② **只有**分享片段工具（没有瑞幸/麦当劳/排程/蓝牙/生活工作流）→ `min(用户设置, 4)`：
     分享预算最多两次满额读，4 轮够「读 → 换 query → 续读 → 收口」，且**不放宽**用户设置（设 1 就是 1）；
  ③ 其它所有情形（混用 / 没有分享工具）→ 用户设置原值，**分享卡在场不改变任何东西**。
  旧实现只看 `shareExcerptTurn` 就把混用轮压成 4（需要第 5/6 轮的其它工具链提前停；用户设 1 时又被放宽到 4），
  属「现有工具循环退化」，已按此口径修掉。

### 8.5 结果语义（模型看到什么）

| code | 含义 | 模型被要求怎么做 |
| --- | --- | --- |
| `OK` | 读到了片段（带 `cursor` 可续读） | 用片段内容回答 |
| `NO_SEGMENTS` | 请求成功但该字段/关键词没匹配到 | 别把「没匹配到」说成「读过了」 |
| `SHARE_NOT_IN_CONTEXT` / `SHARE_CONTENT_NOT_READY` / `MISSING_TARGET` / `SHARE_TARGET_MISMATCH` | 目标不合法或没内容 | 基于已有简介回答 |
| `SHARE_REF_AMBIGUOUS` | 抄短的 shareRef 命中多张卡（结果里给候选完整值） | 照抄其中一个完整值重试，或基于简介回答 |
| `SHARE_REF_INVALID` | shareRef 形状不对（URL/路径等） | 照抄上下文里的完整值，别再构造 |
| `TURN_BUDGET_EXHAUSTED` / `TOOL_CALL_LIMIT` / `DUPLICATE_TOOL_CALL` | 超预算/超次数/复读 | 基于已有简介回答 |
| `HISTORY_UNAVAILABLE` | 本轮拿不到确定的持久化锚点（没有触发消息 id），读到的片段没地方成对落库 | 不读取；基于已有简介回答 |
| `VERSION_UNAVAILABLE` / `CONTENT_NOT_FOUND` / `TIMEOUT` / `NETWORK_ERROR` / `SHARE_LINKS_DISABLED` | 服务端透传的真实失败 | 如实说明片段不可用 |

每种失败文本都带同一句收口：「片段没有读到……不要声称自己读过原文/字幕/评论」。

### 8.6 可见标识、历史与下一轮投影

**模型可见标识 = 完整 shareRef**（返工卡 t_38463abd P1 第 1 条）。投影里每一处引用都是
`[分享 shr_<32 位>]`，就是执行器认的那个值；模型照抄即可命中。`shortShareRef()` 退化为
**只给 UI 用**（卡片角标），不再参与任何进模型的文本——旧口径把引用截成 12 字符，
两张同前缀的卡在模型眼里完全一样，照着投影调用必然 `SHARE_NOT_IN_CONTEXT` 或读错卡。

| 层 | 用的是什么 |
| --- | --- |
| 消息投影（进模型）`buildShareMessageProjection` / `renderShareCardProjection` | 完整 shareRef |
| 工具结果标题（进模型）`[read_share_excerpts · OK] …` | 完整 shareRef（模型后续引用不会抄到不可执行的值） |
| 卡片 UI（`SocialShareCard`） | `shortShareRef`（纯展示） |

**历史**（返工卡 t_38463abd P1 第 2 条，改为「不依赖最终回复」）：

- **请求内**：`assistant(tool_calls)` + `role:tool`（`tool_call_id` 相同）成对进消息数组，
  下一跳请求与最终回复都基于这份成对记录。
- **落库时机**：每执行完一次工具就成对写一次（`dispatchShareExcerptToolCall` → `ShareExcerptPairRecorder.record`），**不等**最终自然语言回复、也不等后处理成功。
  模型失败 / 用户取消 / 空回复 / 后处理抛错时，已经读过的调用都已经在库里。
- **落库位置**：**本轮触发消息**（`contextMsgs` 里的最后一条**非 `system` 背景**消息；正常情况下就是
  发送前刚落库的那条用户消息）的 `metadata.shareExcerpts`。不用「生成开始后最近 30 条里找 assistant」
  这种时间戳猜锚点，因此也不会挂到并发的其它轮次上。
  锚点判定（第 5 轮校正）：从尾部反向扫描，只跳过 `system` 背景项；跳过后遇到的那条**就是**触发消息，
  它的 `id` 必须是合法的正整数字面量，**否则返回 `null`**，绝不继续往前找「上一条有 id 的 user/assistant」
  （`tool` 等中间态角色同样 `null`）。所以「最后一条是没 id 的新用户消息、历史里还有一条有 id 的旧消息」
  不会被悄悄写进旧消息——那是「健康提交到别的轮次」的静默串轮，比不落库更难发现。
  三道门（有卡 / 卡可读 / 触发消息有可持久化 id）统一在 `prepareShareExcerptTurn()` 里判定，
  hook 与测试走同一份实现，不再各写一遍。
- **无锚不读**（返工第 2 轮，第 5 轮收紧到「不许回退」）：拿不到**本轮触发消息**的 id 时**不读**——
  `useChatAI` 直接不注入工具，`dispatchShareExcerptToolCall` 也返回 `HISTORY_UNAVAILABLE` 且一次请求都不发。
  理由：读到了却没有确定落库位置，就是「读过却没有记录」，下一轮回放不出来，模型只能凭记忆复述，
  等于给了一个无法追溯的来源。宁可不给片段，也不给不留痕的片段。
- **幂等与串行（第 3 轮校正）**：去重键是 **（锚点, toolCallId）**，且去重状态放在**共享的待补偿队列**里
  （`ShareExcerptPairOutbox.hasWritten/markWritten`），不是每个记录器各存一份裸 id。
  原因：共享队列里不同轮次完全可能撞上同一个 `toolCallId`（模型每轮都从 `call_1` 开始），
  裸 id 去重会在「先写成功上一轮的 101」之后把这一轮 404 的记录当成已写直接清掉——404 一条没落库，
  统计却是 `pending=0 / unsaved=false`。`attachShareExcerptPairs` 落库侧仍按 id 去重，
  重复提交/DB 重试不产生重复对；同一记录器内的写入排在同一条 promise 链上，避免并发
  read-modify-write 互相覆盖。`snapshot().recorded` 只算本锚点、`recordedAll` 是共享队列已写总数，
  `has(toolCallId)` 默认问本锚点，问别的轮次必须显式给锚点。
- **落库必须等事务提交（第 3 轮，P1）**：生产 saver 用 `DB.updateMessageMetadataCommitted`
  （专用入口，**不改**旧 `updateMessageMetadata`——它在 `store.put()` 之后就 resolve，
  配额/abort 这类 put 之后的失败会静默丢失，而全仓库大量旧调用点依赖它当前行为）。
  新入口以 `transaction.oncomplete` 为成功、`onerror/onabort` 为失败，`updater` 抛错或消息不存在
  会中止事务并 reject。于是「写成功」= 真的提交了；失败批次才不会在队列里被误清。
- **写库失败 = 未保存 + 待补偿**（返工第 2 轮，`ShareExcerptPairOutbox`）：
  失败的批次**留在待补偿队列**里，不标记已写、也不当作已保存；下一次工具调用（`record`）
  与收尾 `flush` 会按原始锚点**有界重试**（每次 flush 最多 `SHARE_EXCERPT_OUTBOX_LIMITS.flushAttempts = 3` 轮，
  hook 有两个收尾点，所以一整轮最多 6 轮 + 每次调用自带 1 轮）。队列按「每条消息 ≤256 条 / ≤8 条消息」封顶，
  已写集合按 512 条封顶，超限丢最旧并 `console.error`。重试用尽仍失败 →
  `snapshot().unsaved === true`（= 队列里还有任何未落库记录，含往轮遗留）+
  `console.error`「工具记录未能写入历史（待补偿）」，**不承诺已保存**；下一轮收尾还会用同一份队列补写。
  待补偿队列是进程内内存结构：应用重启后这些记录确实会丢（这在日志里是可见的失败，不是静默）。
- **不按条数截断（返工第 4 轮 P1-1）**：本轮收到的**每一次**调用都成对保留，拒绝/超限记录不能挤掉成功证据。
  旧实现每次写库 `pairs.slice(-8)`，而次数上限只挡「第 9 次网络读取」、不挡产生 call/result：一批 9 个不同 id
  的调用（第 1 条真读到字幕、第 2–8 条同参被 `DUPLICATE_TOOL_CALL` 拒、第 9 条 `TOOL_CALL_LIMIT`）会把**唯一成功的
  片段**挤出历史；outbox 那边已 `markWritten`、`pending=0`，收尾 flush 也不会补回来——健康 DB 下的静默丢证据。
  现在体量有界不靠条数：一条消息只装**这一轮**的记录（锚点 = 本轮触发消息，不跨轮累积）+ 成功正文受轮次
  2400 token 夹紧 + 失败记录只有一行结构化说明；**投影**（下一轮进模型）另受 600 token 夹紧。
  「保留完整」与「投影有界」是两件事，不再用持久化删记录去换投影额度。
- **下一轮投影**：`normalizeMessageContent` 把这对记录渲染成
  `[read_share_excerpts 记录 · N 次调用]`（≤600 token），`user` 与 `assistant` 角色都会投影
  （正常是 user——记录挂在触发消息上），`system`/`tool` 不背。
- **明确**：片段会占未来上下文（不承诺它们不占），只是有界且成对，不会只剩一段孤立片段
  让模型误以为自己读过更多。

### 8.7 开关与回滚

- 默认关：不注入工具，行为与集成前完全一致（清掉 `os_social_share_config` 即回滚）。
- 服务端 `SHARE_LINKS_ENABLED=false` 时工具仍在，但调用返回 503 系错误，模型如实说片段不可用。
- 只有模型/中转支持 function calling 时有效：中转拒绝 `tools` 的轮次会退回无工具，
  并显式告诉模型「这一轮外部工具不可用：不要声称读过分享片段」。
- 若同一轮还注入了主动消息 2.0 排程工具，降级时这些工具也随 `tools` 一起被删；同样补一句
  「这一轮排程工具不可用：不要声称已经记下、修改或撤销任何提醒/安排」，避免角色用正文假装登记成功。

### 8.8 本机验证（真实执行，2026-10-24 / 返工复跑 2026-10-25）

```
npx vitest run utils/socialShareTool.test.ts utils/socialShareTool.wiring.test.ts \
  utils/chatToolLoopBudget.test.ts          → 3 files / 79 passed（51 + 17 + 11）
npx vitest run $(ls utils/*[cC]hat*.test.ts) → 39 files / 365 passed
npx vitest run utils/socialShareTool.test.ts utils/socialShareTool.wiring.test.ts \
  utils/chatToolLoopBudget.test.ts utils/mcpToolBridge utils/agenticTools \
  utils/messageFormat utils/socialShare utils/chatRequestPayload \
  worker/social-content utils/socialContent  → 30 files / 378 passed
```

> 计数口径：返工第 5 轮（2026-10-25，按 arch-reviewer 第 5 次复核意见）为 79 / 365 / 378；
> 第 4 轮为 73 / 365 / 372，第 3 轮为 56 / 354 / 355，第 2 轮为 51 / 354 / 350，第 1 轮为 45 / 354 / 344。
> 第 5 轮新增 6 例（锚点不回退：picker 反例、`prepareShareExcerptTurn` 三道门、真实 DB 的
> 「旧消息在库 + 最新触发消息没 id」零读、非法 id 零读、有效新 id 只写新消息、两轮并发不串）。
> 执行卡最初记的 22 + 8 = 30 例、定向 329 例是更早的数字，
> 旧数字不再作为门禁依据。全量 `tsc` 与 `vite build` 结果记在 `evidence/`（提交内），
> 第 5 轮为 `evidence/*-r5.log`。

覆盖点：

- **真实代码链路**：分享卡在上下文 → 工具 schema → 模型 `tool_calls`（fixture 模型）→ 执行器 →
  `fetchShareExcerpts` 的 HTTP 契约 → 服务端真实 `buildExcerpts`（fixture 内容记录）生成响应 →
  `role:tool` 结果 → 下一跳请求成对 → 最终回复 → 落 metadata → 下一轮投影读得回来。
  桩只在 `fetch` 与模型输出上；响应体不是手写 JSON，是仓库真实服务端函数算出来的。
- **可见标识（返工 P1）**：主链路用 `normalizeMessageContent` 输出里提取的引用来驱动调用
  （不偷看 metadata 的完整 ID）；两张同 12 字符前缀的卡 → 可见的是两个不同完整引用；
  抄短成公共前缀 → `SHARE_REF_AMBIGUOUS` 且列出候选、零请求；唯一前缀 → 命中且读到的是
  **那张卡**的内容（断言不含另一张卡的字幕）；URL 形状 → `SHARE_REF_INVALID`；太短/集合外 →
  `SHARE_NOT_IN_CONTEXT`。
- **落库（返工 P1 第 2 条 + 第 2 轮）**：每执行一次就落一次（`dispatchShareExcerptToolCall`）；
  取消/网络失败（`AbortError` → `TIMEOUT`）也成对留；两轮并发各写各自触发消息、同 `toolCallId`
  不串；重复提交与落库侧重放都只留一条；并发 `record` 的 read-modify-write 串行化
  （最大并发写 = 1，两条记录都在）。
- **写库失败的收尾路径（返工第 2 轮，不再手工 record 代替生产行为）**：
  ① dispatch → 首次 `savePairs` 失败 → 只调生产收尾 `flush()` → 第二次写成功并读回完整 call/result；
  ② 收尾两个 flush 各自有界重试（第一次用尽仍失败、第二次补上）；
  ③ 后续新调用不遗漏旧失败批次（一次写成功把旧+新按顺序补上，仍挂原锚点）；
  ④ 持续失败 → `unsaved` + 上报「未保存·待补偿」，下一轮用同一队列写回**原**锚点、不挂新轮次。
- **无锚点（返工第 2 轮）**：`anchorId = null` 时**读取前**就拒绝（`HISTORY_UNAVAILABLE`）——
  零 HTTP 请求、零落库、`turn.calls` 里有这条被拒的调用但没有片段；无 recorder 同样拒绝；
  无锚点轮与有锚点轮并发时只有有锚点那条消息被写，不串轮。
- **跨锚点补偿（返工第 3 轮 P1-1）**：共享待补偿队列里旧锚点失败的 `call_1` + 新锚点同 id 的
  `call_1` → 两份都写回**各自**消息（断言 A 卡/B 卡字幕互不串）；只对某个锚点持续失败时，
  别的锚点写成功也不会把它从队列里抹掉（`outboxPending=1 / unsaved=true` 可见）；
  同 id 两轮并发（共享队列）各自成对、队列清空、`has` 按锚点隔离。
- **事务提交（返工第 3 轮 P1-2）**：走真实 DB 层（fake-indexeddb，不是注入 saver）。
  正常路径：dispatch → 提交后从真实库里读回成对 call/result，且下一轮投影真读得回来；
  故障路径：`get` 成功后 `put` 被事务 abort（配额/中断语义）→ `updateMessageMetadataCommitted`
  reject、记录**不**标 recorded、`pendingRecords=1 / unsaved=true`、库里没有该 metadata；
  生产收尾 `flush()` 一次提交成功后读回完整 pair。该用例在旧 `updateMessageMetadata`
  （put 后立即 resolve）上会失败，是本轮修复的判别性证据。
- 预算：单次夹紧、轮次累计、并发不超卖、小额直接拒绝、同参去重、次数上限、收费按自身重算。
- 权限：URL/baseUrl/token/scope 拒绝且不发请求；集合外 shareRef/contentId 拒绝；状态不符拒绝；
  cursor 格式校验；shareRef/contentId 映射与错配。
- 失败：`VERSION_UNAVAILABLE`、`CONTENT_NOT_FOUND`、`NO_SEGMENTS`；失败文本都要求如实说没读到。
- 投影：call/result 成对落 metadata、投影有界、`user`/`assistant` 投影而 `system`/`tool` 不投影。

### 8.9 未验证 / 未部署（必须带着交付）

1. **真实模型是否会用这个工具**未验证：工具描述是按模型能否自解释写的，但没有真实供应商+真实账号的灰度数据。
2. **平台真实内容仍未打通**（同 §9 第 1 条）：工具读得到的前提是内容库里真有内容；B站 412、抖音登录墙、
   XHS 会话停用的现状不变，`read_share_excerpts` 只会如实返回失败。
3. **未部署**：前端与 worker 都没发布；`SHARE_LINKS_ENABLED` 仍按 §4 的灰度流程走。
4. **发布门禁**：定向 vitest 已跑（见 §8.8）。全量 `tsc -p tsconfig.json --noEmit` 与
   `npx vite build` 本机都跑过（日志在 `evidence/`）：`tsc` EXIT=2、**56 个错误**，
   与返工前基线（父卡 `evidence/tsc-full.log`）的 `error TS` 行集合 **逐行一致**
   （`diff` 空、56 vs 56），改动文件 0 错误；`vite build` EXIT=0（5m49s，产物在 gitignore 的 `dist/`）。
   返工第 2 轮在 `43721c4e` 上复跑同一套门禁：`tsc` 仍 EXIT=2 / 56 个 / 错误集 `diff` 空，
   `vite build` EXIT=0（2m57s），vitest 51 / 354 / 350 全绿（原始日志 `evidence/*-r2.log`）。
   仍不等于发布验收：没有跑 `pnpm run check:workers`，也没有部署。
5. 可读集合取自本轮装载的历史消息（`contextMsgs`）的 `metadata.shares`，没有和最终
   `cleanedApiMessages` 再求一次交集：被上下文裁掉、但仍留在 `contextMsgs` 里的卡理论上可被点名
   （模型看不到 ref，实际不可达）。属已知边界，未额外收紧。
6. **片段是外部内容，未做提示注入消毒**：字幕/正文/评论样本由平台提供，可能夹带「忽略以上指令」
   之类文本。本卡只保证它是纯文本、有界、来源可追溯（shareRef + contentRevision），与旧链路
   直接注入字幕全文同级；没有额外过滤，也没有让模型据此获得任何工具/权限。

### 8.10 返工记录（验收卡 t_38463abd，2026-10-25）

arch-reviewer 在 `70cdd836` 上发现三处阻塞验收的问题，本节记录修法与复验口径。

| # | 问题 | 修法 | 复验 |
| --- | --- | --- | --- |
| P1-1 | 模型可见引用被截成 12 字符，执行器只索引完整 shareRef → 照投影调用必然失败；测试用 fixture 注入不可见完整 ID，掩盖缺陷 | 投影与工具结果标题一律用完整 shareRef（`shortShareRef` 只留 UI）；执行器加前缀解析，**歧义即拒绝并给候选**；主链路测试改为从 `normalizeMessageContent` 输出提取引用驱动调用 | §8.8「可见标识」5 例：单卡成功、多卡同前缀歧义、唯一前缀命中且读到正确卡、URL/太短/未知拒绝、纯函数解析口径 |
| P1-2 | call/result 只在「最终回复后处理成功」后从最近 30 条 assistant 里找锚点落库 → 模型失败/取消/空回复/无锚点时记录丢失 | 新增 `ShareExcerptPairRecorder`：锚在本轮触发消息（`contextMsgs` 最后一条，发送前已落库），**每执行一次工具成对写一次**；幂等 + 串行 + 失败可重试 + 无锚不猜；成功尾部与 `finally` 各 flush 一次 | §8.8「落库」7 例：逐次落库（无 assistant 也在）、取消/网络失败成对留、两轮并发隔离、幂等/重放、写库失败不阻断且可重试、并发串行、无锚不写 |
| P1-3 | 执行边界（模型/provider/授权/回滚面）没有可核验证据 | 交付 `evidence/EXECUTION-AUDIT.md`：本 run 的 session 模型/provider（`state.db` 的 sessions/session_model_usage 只读查询）、`config.yaml` 的 model/provider 与 mtime（早于本轮，未改动）、改动文件清单、未启动网关、未部署 | 审计文件随卡提交；旧评论里的 `piaomiao/[AA]deepseek-4.1-flash-1017` 是建卡时的模型钉值记录，与本 run 实际跑的不是同一层证据，已在审计里标明 |

返工对既有行为的可见影响：

- 模型投影每张卡多 ~24 字符（完整引用）——由 §8.6 的 350/1200 预算继续夹紧；定向回归全部通过。
- 记录不再挂在助手消息上，而是挂在**触发消息**上，因此 `user` 角色的消息也会带
  `[read_share_excerpts 记录]` 投影（≤600 token）。

### 8.11 返工记录（第 2 轮，2026-10-25）

arch-reviewer 在 `fd65b32e` 上复核，认定 P1-2 未闭环（另外两条 P1 已核验通过，保持不变）。修法与复验：

| # | 问题 | 修法 | 复验 |
| --- | --- | --- | --- |
| P1-2a | `record` 在 `savePairs` 失败后只 `failures++ / console.warn`，失败批次没保存；`flush()` 只 `return this.queue`，hook 的两处 flush 与下一次 dispatch 都不会补写 → 瞬时故障下记录永久丢失，而文档却承诺「下一批会重试」 | 新增 `ShareExcerptPairOutbox`（待补偿队列）：失败批次留在队列、不标已写；`record` 与 `flush` 都从队列按**原始锚点**写；`flush` 做**有界重试**（每次最多 3 轮）；重试用尽仍失败 → `snapshot().unsaved = true` + `console.error`「未保存·待补偿」，不承诺已保存；队列有界（每消息 16 条 / 8 条消息，超限丢最旧并报错） | `utils/socialShareTool.test.ts`：首次失败→只走生产 `flush()` 补写；两个 flush 各自重试；新调用带走旧失败批次；持续失败→unsaved+上报→下一轮同队列写回原锚点。§8.8 计数 51 |
| P1-2b | `anchorId = null` 时 `record` 直接跳过存储，`dispatch` 仍返回成功片段（旧测试把这种违约当成功断言） | 无确定锚点**不读**：hook 不注入工具 + `dispatchShareExcerptToolCall` 在读取前返回 `HISTORY_UNAVAILABLE`（零请求）；`snapshot().unsaved` 与 `pendingRecords` 让「没保存」可见 | 同文件：零锚点零请求零落库、无 recorder 同样拒绝、无锚点轮与有锚点轮并发不串轮 |

本轮**未**改模型 / provider / 配置 / 审批 / 权限，未启动任何消息网关，未部署、未合并。
`evidence/EXECUTION-AUDIT.md` 保持第 1 轮的口径（模型 `deepseek-v4.1-flash` / provider `opencode-go`，
本 run 同样只有一条 `session_model_usage`），本轮新增证据是测试与构建日志（`evidence/*-r2.log`）。

本轮新增的残余风险（与 §8.9 一起交付）：

- 待补偿队列是**进程内内存**结构：应用重启后未落库的记录确实会丢；丢的时候日志里有明确的
  `console.error`（不是静默），但不会自动补写到服务端。
- 两次写库尝试之间没有事务锁：同一 `toolCallId` 若被两个记录器同时写，靠
  `attachShareExcerptPairs` 落库侧按 id 去重，最多浪费一次写，不会产生重复对。
  > 第 3 轮修正：这句只对「同一条消息」成立；跨轮同 id 必须按（锚点, toolCallId）隔离，见 §8.12。

### 8.12 返工记录（第 3 轮，2026-10-25）

arch-reviewer 在 `62569fd1` 上复核，判定「失败批次不重试」「无锚点仍返回片段」已修好（保持不变），
但历史成对保留还有两条 P1：

| # | 问题 | 修法 | 复验（真实执行） |
| --- | --- | --- | --- |
| P1-1 | `writePending` 遍历**共享** outbox，却只用裸 `toolCallId` 记「已写」：旧锚点 101/call_1 与新锚点 404/call_1 同在队列时，先写成功 101 就把 404 的 call_1 当成已写清掉（`pending=0/unsaved=false`），404 一条没落库 | 去重键改为 **（anchorId, toolCallId）**，且去重状态从「每个记录器一份」移到**共享 outbox**（`hasWritten/markWritten/writtenCount`，512 条封顶）；`record/writePending/has/snapshot` 全部按锚点校准（`recorded`=本锚点、`recordedAll`=队列已写总数、`has(id)` 默认本锚点、`has(id, anchor)` 才能问别轮）；`unsaved` = 队列里还有任何未落库记录（含往轮） | 新增「旧锚点失败 call_1 + 新锚点同 id call_1」：两份都写回各自消息、A/B 卡字幕互不串、队列清空；「只对 101 持续失败」时 404 写成功也不会抹掉 101；原同 id 并发测试改为**传共享 outbox** 并断言队列清空 + `has` 按锚点隔离。判别性证据：把 key 临时改回裸 id（mutation）→ 该用例立刻失败（404 无 pair、pending=0），恢复后通过 |
| P1-2 | hook 的 saver 走 `DB.updateMessageMetadata`，`utils/db.ts` 在 `store.put()` 之后**立即 resolve**（不等 `transaction.oncomplete`、不处理 onerror/onabort）→ 配额/abort 这类提交期失败被 recorder 当成功，done 标记 + outbox 清空，收尾也无法重试 | 新增**专用**入口 `DB.updateMessageMetadataCommitted`：成功 = `transaction.oncomplete`，失败 = `onerror/onabort`，`updater` 抛错/消息不存在则 abort+reject；hook 的 saver 改用它。**旧 `updateMessageMetadata` 行为保持不变**（全仓库大量调用点依赖其当前语义，属共享热点，不做静默改语义） | 走真实 DB 层（fake-indexeddb）：正常路径 dispatch → 提交后从库里读回成对 call/result 且下一轮投影读得回来；故障路径把 `IDBObjectStore.prototype.put` 包装成「put 后立即 `transaction.abort()`」（配额/中断语义，写回滚）→ 专用接口 reject、`recorder.has()` 仍为 false、`recorded=0/pendingRecords=1/unsaved=true`、库里没有该 metadata；仅调生产 `flush()` 后提交成功、读回完整 pair。判别性证据：把 saver 临时换回 `updateMessageMetadata`（mutation）→ 该用例失败（recorded 被提前标成 1），恢复后通过 |

本轮**未**改模型 / provider / 配置 / 审批 / 权限，未启动任何消息网关，未部署、未合并。
边界材料继续放在 `evidence/EXECUTION-AUDIT.md`（第 3 轮 run 见该文件 §9）。

本轮新增/变化的残余风险：

- `written`（已写成功）集合是**进程内**结构：只在本次运行内跨轮共享，重启后归零（归零只影响统计与
  幂等去重的短期精度，不影响「已落库的数据」；队列里也不会因为归零而重写已落库记录）。
- 「已写成功」以事务提交为准，但**没有**做读回校验（提交成功即认为落库成功）；IndexedDB 提交后回滚
  的极端情况（连接被强制 abort 之后）不在覆盖范围。
- `updateMessageMetadataCommitted` 是新增入口，旧调用点未迁移；两条路径对「写成功」的定义不同，
  后续若有人把本工具改回旧入口，wiring 测试会失败（已钉）。
- 事务提交失败时工具结果仍照常返回给模型（不阻断对话），所以模型可能读到片段、而该次读在库里
  处于「待补偿」；这与「不承诺工具片段不占未来上下文」一致，但**模型侧无法感知**该差异。


### 8.13 返工记录（第 4 轮，2026-10-25）

arch-reviewer 在 `86c67854` 上复核，第 3 轮两项修复（共享 outbox 去重键带锚点、saver 等事务提交）核验通过，
但按原卡「历史必须成对保留」「现有工具循环不得退化」仍判两处 P1：

| # | 问题 | 修法 | 复验（真实执行） |
| --- | --- | --- | --- |
| P1-1 | **健康 DB 下也静默删除已成功读取的历史**：`attachShareExcerptPairs` 每次写库 `pairs.slice(-8)`（`SHARE_EXCERPT_RECORD_KEEP = 8`），而 `maxToolCallsPerTurn` 只挡「第 9 次网络读取」、不挡产生 call/result。一批 9 个不同 id（第 1 条真读到字幕、第 2–8 条同参 `DUPLICATE_TOOL_CALL`、第 9 条 `TOOL_CALL_LIMIT`）会把唯一成功的片段挤出历史，outbox 却已 `markWritten`、`pending=0`，flush 不会补 | **不再按条数截断**：本轮收到的每一次调用都成对保留（拒绝记录不能抹掉成功证据），落库侧仍按 `toolCallId` 幂等去重。体量有界改由结构保证：一条消息只装一轮记录（锚点 = 触发消息）+ 成功正文受轮次 2400 token 夹紧 + 失败记录只有一行；**投影**另受 600 token 夹紧。同时把待补偿队列的单消息上限从 16 提到 256（次数上限只挡网络读取，一批 >16 条的失败批次会被 16 挤掉最旧的未落库记录；256 是内存安全阀） | 新增「一批 9 个不同 id」真实 DB 用例：seed 消息 → 9 次 `dispatchShareExcerptToolCall`（1 成功 + 7 重复 + 1 超次数）→ 生产 `flush()` → 从库里读回 **9 条 pair**、顺序与执行顺序一致、`pairs[0].result.ok === true` 且含字幕、`pairs[8].result.code === 'TOOL_CALL_LIMIT'`；再重复提交同一批 + `record` + `flush` → 仍 9 条（幂等，不删已有对）；`renderShareExcerptPairProjection` 仍 ≤600+160 字符。判别性证据：把 `pairs` 临时改回 `slice(-8)`（mutation）→ 该用例立刻失败（`length 9` 实际 8），恢复后通过。另加纯函数用例（12 条不截断 + 按 id 去重）与队列用例（20 条未落库批次不被挤掉） |
| P1-2 | **新分享卡改变其它工具的总循环预算**：`useChatAI` 的 `MAX_LOOPS` 写成 `shareExcerptTurn ? 4 : mcpSettings.maxToolLoops`，注释却说「只有分享片段工具时」——只要没有 MCP、有一张分享卡在场，瑞幸 / amsg2 / bt / 生活工作流混用轮也被强制 4 轮（原本需要第 5/6 轮的链提前停）；用户设 `maxToolLoops = 1` 时又被反向放宽到 4 | 轮数口径收进新模块 `utils/chatToolLoopBudget.ts` 的纯函数 `resolveChatToolLoopBudget`，hook 不再自己算：① 有通用 MCP → `max(用户设置, 12)`（原行为）；② **只有**分享片段工具 → `min(用户设置, 4)`（不放宽用户设置）；③ 混用或没有分享工具 → 用户设置原值。hook 传入 `mcpToolsAvailable / shareExcerptsAvailable / otherToolsAvailable`（瑞幸/麦当劳/排程/蓝牙/生活工作流任一即算「有别的工具」） | 新增 `utils/chatToolLoopBudget.test.ts`（11 例，**真调用**决策函数 + 与 hook 3.6 循环同形的驱动器）：默认 6 时有/无分享卡对同一条 6 轮工具链的执行序列逐项相同且都跑完；`maxToolLoops=1` 的混用轮只跑 1 轮（不再变 4）；12 轮设置保持 12；MCP 在场恒为 `max(用户设置,12)`；分享-only 时 6→4、12→4、2→2、1→1（不放宽）；分享-only 的 5 轮链条只发 4 次请求。wiring 测试钉 hook 走该函数、旧三元表达式已消失、六类工具标志都传进去了 |

本轮**未**改模型 / provider / 配置 / 审批 / 权限，未启动任何消息网关，未部署、未合并。
边界材料继续放在 `evidence/EXECUTION-AUDIT.md`。

本轮新增/变化的残余风险：

- **历史体量随本轮调用条数增长**：不再截断意味着「模型一次吐 50 个 tool_calls」时，该消息的
  `metadata.shareExcerpts` 会带 50 条记录（成功正文仍受 2400 token 夹紧，失败记录各一行）。
  这是「不丢证据」的代价；投影（进模型）仍 ≤600 token，不影响后续上下文预算。
- 待补偿队列单消息上限 256 条仍是**有界丢弃**：真实一轮远到不了，但真到了会 `console.error` 丢最旧，
  不标已写（不会谎报已保存）。
- 轮数口径是纯函数，hook 侧只负责把「谁在场」传对；**没有**在真实 React 运行里跑过整条 hook
  （仓库 vitest 是纯 Node，`useChatAI` 绑死 React）。wiring 测试钉住传参形状，行为测试钉住决策函数。


### 8.14 返工记录（第 5 轮，2026-10-25）

arch-reviewer 在 `6178e166` 上复核，第 4 轮两项（成对历史不按条数截断、工具循环轮数不被分享卡压低）
核验通过；仍判一处 P1：**锚点选择会回退到旧历史**，`pickShareExcerptTurnAnchor` 跳过最新触发消息的
无效/缺失 id 后返回「整个历史里最后一个有效 user/assistant id」。确定性输入
`[{id:101,role:'user'}, {role:'user',metadata:{本轮卡}}]` 会返回 101 → hook 的门不生效，
`committed saver` 把本轮读取**健康地**写进另一个轮次的消息，`unsaved=false`、没有任何告警
（比「没落库」更难发现：记录在、位置错）。现有零锚用例只覆盖「所有消息都没 id」。

| # | 问题 | 修法 | 复验（真实执行） |
| --- | --- | --- | --- |
| P1 | `pickShareExcerptTurnAnchor` 回退到历史里较早的有效 id → 记录挂到别的轮次，门形同虚设 | 改为**反向扫描、只跳过 `system` 背景项**；跳过后遇到的那条就是本轮触发消息，其 id 必须是正整数，否则返回 `null`，**不再继续往前找**（`tool` 等中间态角色也返回 `null`）。同时把「有卡 / 卡可读 / 触发消息有可持久化 id」三道门收进新导出 `prepareShareExcerptTurn()`（返回 `{turn, anchorId, reason}`），`useChatAI` 只消费它，hook 不再自己拼判定（两处口径分叉正是本轮缺陷来源）；dispatch 侧原有的 `HISTORY_UNAVAILABLE` 拒绝（在预算/网络之前）保留 | 新增 6 例（`utils/socialShareTool.test.ts`）：① picker 覆盖「缺 id / 0 / 负数 / 非数字 / 小数 / null / 尾部 system 后可疑 / tool 角色」全部 `null`、而合法新 id 只认它；② `prepareShareExcerptTurn` 的 `ok / no_target / no_readable_target / no_anchor`；③ **真实 DB + 生产 committed saver**：旧消息在库里 + 最新触发消息没 id → `no_anchor`、零 HTTP 请求、旧消息 metadata 逐字节不变；④ 最新触发消息 id 为 `0` / `'oops'` 同样零请求、旧消息不变；⑤ 最新触发消息有有效新 id → 只写新消息（旧消息仍是原 metadata，没多 `shareExcerpts`）、提交后读回成对记录；⑥ 两轮**并发**各写各自触发消息（A/B 卡字幕互不串，`unsaved=false`）。判别性证据：把 picker 临时改回「跳过无效 id 继续往前找」（mutation）→ 新增用例 4 条立刻失败（`47 passed / 4 failed`），恢复后 51 passed |

本轮改动文件（实现提交）：`utils/socialShareTool.ts`（picker + `prepareShareExcerptTurn`）、
`hooks/useChatAI.ts`（改调 `prepareShareExcerptTurn`，删掉本地分步判定与相应 import）、
`utils/socialShareTool.test.ts`（+6 例）、`utils/socialShareTool.wiring.test.ts`（接线断言改为
钉「统一走 prepare」且旧分步判定已消失）。

本轮**未**改模型 / provider / 配置 / 审批 / 权限，未启动任何消息网关，未部署、未合并。
边界材料更新在 `evidence/EXECUTION-AUDIT.md §11`。

新增残余风险（写进 §8.9 之外单独列出）：

- 锚点语义现在**依赖调用方传的是「本轮真正发给模型的消息数组」**：如果将来某处传入的是「裁剪后的历史」，
  最后一条可能不是触发消息。这是接口契约（`prepareShareExcerptTurn(messages)` 的输入定义），
  目前唯一生产调用点是 `useChatAI` 的 `contextMsgs` 快照；没有在真实 React 运行里端到端跑过。


## 9. 已知限制（必须带着交付）

1. **三平台真实内容读取未验证**：B 站 412、抖音登录墙、XHS 会话停用。代码遇到这些情况给
   `failed/partial` + 结构化错误，不编造内容。
2. ~~**按需检索只有 HTTP API，没有注册成模型工具**~~ → **已由执行卡 t_75dd49a5 接上**，
   并由返工卡 t_38463abd 修掉「可见引用不可执行」「记录只靠最终回复落库」「写库失败无补偿」
   「无锚点仍返回片段」（§8.6 / §8.10 / §8.11）以及「历史被 8 条截断」「分享卡压低其它工具轮数」
   （§8.13）「锚点回退到旧历史、记录写进别的轮次」（§8.14）七处缺陷：
   单次 1200 / 轮次 2400 预算、只认上下文里的分享卡、引用歧义即拒绝、每次调用即时成对落库且**不按条数截断**、
   写库失败有界重试并在失败时明确「未保存·待补偿」、拿不到**本轮触发消息**的 id 就不读且**不回退到更早消息**、
   失败如实返回、工具循环轮数只在自己是唯一工具时收紧。
   仍未在真实供应商模型上验证「模型会不会主动调」，也仍未部署。
3. **单进程租约**：租约+唯一约束能防重复建卡与重启卡死，但多进程/多副本同时解析同一内容仍可能
   各跑一次（结果幂等，浪费一次抓取）。真正的跨进程内容单飞未实现。
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

### 10.3 复审返工（arch-reviewer comment #84）：到期来源统一（连接 timer 移交正文 timer）

| # | 复审意见 | 修复 | 证据 |
| --- | --- | --- | --- |
| 1 | `safeFetch.ts` 的连接 timer 在进入正文读取后仍存活到外层 `finally` 才清；到期时它只 `controller.abort()`、不设正文 helper 的 `timedOut`，于是「响应头立即返回 + 正文响应 `AbortSignal` 并拒绝」的合法 transport 会把真正的期限到期映射成 `NETWORK_ERROR/body_read_failed`（或透传 transport 自己的码），而不是 `TIMEOUT/body_timeout` | `safeFetch.ts`：响应头到达、算完剩余 `bodyBudget` 后**先 `clearTimeout(connectTimer)` 再进入 `readBodyWithinBudget`**，把该跳剩余预算的到期责任整体移交给正文 helper（任一时刻只有一个 timer 是本阶段的到期来源，`timedOut` 不会因别的 timer abort 而漏设）；另加一道防御：transport 忽略 `signal` 在到期后才交出响应头时，直接 `discard()` 并按 `TIMEOUT/upstream_timeout` 结束，不再读正文 | `safeFetch.test.ts` 新增 2 例（describe「期限来源统一（响应头后连接 timer 移交正文 timer）」）：① 响应头立即返回、`readBody` 只在 `abort` 事件里同步以 `AbortError` 拒绝 → `TIMEOUT/body_timeout`、`readBody` 调用 1 次、abort/discard 各恰好 1 次、`vi.getTimerCount()===0`、推进 2s 无二次副作用；② 忽略 signal 的 transport 在预算后 resolve → `TIMEOUT/upstream_timeout`、`readBody` 0 次、discard 1 次。**RED 证据**：把 `safeFetch.ts` 退回 `57f05a9c`、保留新测试 → `2 failed | 33 passed`（`safeFetch-red-r84.log`，RED_EXIT=1），失败正是 `NETWORK_ERROR/body_read_failed` 与「迟到响应被当成 200 成功」 |

本轮改动文件：`worker/social-content/safeFetch.ts`、`worker/social-content/safeFetch.test.ts`、`worker/social-content/worker.bundle.js`（重建）、本文。

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
