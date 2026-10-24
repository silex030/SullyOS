# 链接分享整合 v1：接线、验证与已知限制（t_babca897）

> 状态：**叶子模块 + 集成接线完成，本机验证通过；未部署生产，未确认任一平台真实内容读取成功。**
> 契约来源：`share-contract-v1.txt`（t_6bca2291 附件）。
> 父卡交付：`utils/socialContent/*`、`worker/social-content/*`（识别器、适配器、SSRF 抓取、状态机）。
> 本卡新增：服务宿主装配、持久化、反代、客户端投影/卡片/发送链路、回归与体检。

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

## 5. 真实网络验证（本机出口，2026-10-24，只读、无账号/Cookie）

用本卡构建的 bundle 起本地宿主（`social-host.mjs`，data: URL 加载，验证自包含），走真实 HTTP API：

| 输入 | 结果 | 说明 |
| --- | --- | --- |
| `https://www.bilibili.com/video/BV1xx411c7mD` | `failed / ACCESS_DENIED` | api.bilibili.com 返回 412（风控预检），映射为 ACCESS_DENIED。**不声称 B 站接通** |
| `https://b23.tv/BV1xx411c7mD` | `failed / ACCESS_DENIED` | 短链展开后同样撞 412 |
| `https://www.xiaohongshu.com/explore/64f0aa11bb` | `failed / AUTH_REQUIRED` | 实现层面 XHS 正文一律不抓（会话桥停用），如实报需要登录 |
| `https://xhslink.com/a/9Kd2Lm` | `failed / CONTENT_NOT_FOUND` | 短链路径非法 → 上游 404，未伪造内容 |
| `https://www.iesdouyin.com/share/video/7300123456789012345/` | `failed / AUTH_REQUIRED` | 分享页 302→www.douyin.com 后返回登录墙页面；与父卡“200 但无 aweme”结论不同，说明**结果随出口/时间变化**，统一映射为 AUTH_REQUIRED |
| `https://www.bilibili.com.evil.example/...` | `failed / UNSUPPORTED_PLATFORM` | 相似域名不进平台白名单 |

结论：**三平台均未取得真实内容**；真实链路的成功形状只有夹具测试覆盖（`adapters.test.ts`），
部署到其它出口后必须重跑本节表格，不能把本表当“已接通”。

## 6. 自动化验证（本机真实执行）

```
npx vitest run worker/social-content utils/socialContent utils/messageFormat
→ Test Files 15 passed | Tests 188 passed

npx vitest run worker/main-agent utils/messageItemModuleLayout.test.ts ... vps-backend
→ Test Files 19 passed | Tests 193 passed

npx vitest run worker/main-agent/src/socialProxy.test.ts      → 7 passed
npx vitest run worker/social-content/src/chain.test.ts        → 4 passed
npx vitest run components/chat/SocialShareCard.test.tsx       → 6 passed
npx vitest run utils/socialShare.test.ts                      → 20 passed
```

覆盖点（与验收矩阵对应）：

- **识别**：三平台长短链、`/discovery/item`、BV/av、分P、重复链接合并、第 6 条起 `SIZE_LIMIT`、相似域名拒绝。
- **状态机与持久化**（真实 SQLite）：唯一约束、revision CAS、跨 scope 404、租约抢占/释放、
  重启恢复（`recoverInterrupted` 幂等）、内容 `content_revision` 单调。
- **接口差异修复**：`nodeTransport` 的 `lookup(all:true)` 形态（父卡实现让三平台全报
  `NETWORK_ERROR` 的根因，修复后真实探测能拿到 412/登录墙）。
- **重复回复/异步竞态**：首屏只等 1500ms；晚到结果只写卡不触发第二次模型调用；合并按
  `(attempt, revision)` 单调丢弃旧事件。
- **安全**：SSRF（相似域名/IP 字面量/私网/重定向跨站/无 pinned 地址拒绝）、正文体积夹紧
  （200000 字符 + `truncated` 标记）、请求体 256KiB + 文本 16000 UTF-16 上限、跨 scope 不可枚举、
  外部文本纯文本渲染 + 转义、跳转仅 https、服务令牌不进 `/health`。
- **凭据**：服务端不接受请求体里的 baseUrl/token/账号；XHS 不读 Cookie；反代不透传客户端 token。

未覆盖的验证：全量 `tsc -p tsconfig.json` 与 `vite build` 在本机未作为发布门禁证据（见 §8）。

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
典型短视频（字幕 1.5k 字，笔记 800 字）  旧 2581 token → 新 515 token（省 80.0%）
长讲座    （字幕 12k 字，笔记 4k 字）    旧 16281 token → 新 515（省 96.8%）
极长      （字幕 80k 字，笔记 20k 字）    旧 100281 token → 新 515（省 99.5%）
```

- 口径：每 Unicode 码点 ≈1 token（保守上限），不是供应商账单数字。
- 投影在重复构建下字节稳定（`projection_stable_across_builds: true`），意味着这条历史消息在
  后续每轮重发时是**稳定前缀的一部分**，不会因解析刷新而抖动；
  每轮额外开销 ≈ 投影大小（515 token 级别），旧链路每轮要重发整段字幕。
- **缓存命中率：not_provided** —— 本机没有供应商 prompt-cache usage 字段，不虚构命中率；
  上线后应看 `promptCacheDiagnostics` / `llmUsage` 的真实 usage 再谈收益。

## 8. 已知限制（必须带着交付）

1. **三平台真实内容读取未验证**：B 站 412、抖音登录墙、XHS 会话停用。代码遇到这些情况给
   `failed/partial` + 结构化错误，不编造内容。
2. **按需检索只有 HTTP API，没有注册成模型工具**：`POST /items/:id/excerpts` 已实现并测试
   （1200 token 夹紧、cursor 续读、`VERSION_UNAVAILABLE`），但 v1 没有把它接进聊天工具循环，
   所以“角色主动翻字幕/评论”这一档目前做不到，只做到“简介进上下文”。这是本卡明确未覆盖的一项。
3. **单进程租约**：租约+唯一约束能防重复建卡与重启卡死，但多进程/多副本同时解析同一内容仍可能
   各跑一次（结果幂等，浪费一次抓取）。真正的跨进程内容单飞未实现。
4. **内容表是最小实现**：`social_content_items` 一行存整条 ContentRecord（JSON），没有拆
   queries/sources/media 表；`cacheAllowed=false` 时不做持久化。
5. **ASR / XHS 实验评论 / RedNote 独立会话**：未实现，开关默认关。
6. **旧链路仍在**：XHS 的 MCP 建卡、通用网页抓取、B 站 `bilibiliCard` 分支保留；新开关打开时
   这三条对本条消息里的平台链接让位（避免双卡），关闭时完全照旧。两套链路并存是有意的回滚面。
7. **发布门禁未执行**：本机全量 `tsc`/`vite build` 未完成（>10 分钟），发布前必须跑并记录；
   自包含 data:URL 加载已由本卡宿主脚本在本地验证（bundle 可加载、health 200），但线上 8842
   的 Caddy/health 读回未做。

## 9. 发布步骤（本卡未执行，交发布流程）

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
