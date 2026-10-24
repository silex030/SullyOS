# 链接分享解析 v1 实现与验证记录（t_2c2dba79）

状态：**叶子模块实现完成，未接线**。契约见 `share-contract-v1.txt`（父任务 t_6bca2291 附件）。
本文件只记录本卡真实做过的事与真实拿到的结果；没有做过的写"未验证"，不冒充接通。

## 1. 交付范围

新增（全部是新文件，没有改任何既有文件）：

| 路径 | 作用 |
| --- | --- |
| `utils/socialContent/types.ts` | 共享纯契约类型（ShareAttachment / ContentRecord / Transcript / commentsSample / error code / 预算与限额常量） |
| `utils/socialContent/links.ts` | 混合文本链接识别：UTF-16 span、包裹标点剥离、长短链、BV/分P、rednote 开关、TikTok/bilibili.tv 明确不支持、同链接合并、5 链接上限、contentId 生成/反解 |
| `utils/socialContent/index.ts` | 桶文件（只有类型与纯函数） |
| `worker/social-content/security.ts` | SSRF 策略：IPv4/IPv6 分类、DNS 结果校验、精确域名白名单、userinfo/端口/IP 字面量/punycode/控制字符拒绝 |
| `worker/social-content/safeFetch.ts` | 受控抓取：每跳复验、redirect manual + 逐跳白名单、跨站剥离 Cookie/Authorization、最多 5 跳、https 降级拒绝、大小截断、超时 |
| `worker/social-content/nodeTransport.js` / `.d.ts` | 把连接绑定到已验证 IP 的 Node transport（`lookup` 固定，抗 DNS 重绑定）；拿不到绑定时拒绝而不是退化成裸 fetch |
| `worker/social-content/errors.ts` | 契约错误码映射、Retry-After 解析、不可自动重试集合、RevisionConflictError / VersionUnavailableError |
| `worker/social-content/adapter.ts` | 适配器接口、SourcePolicy 默认值、纯文本化、时间戳归一 |
| `worker/social-content/record.ts` | ContentRecord 唯一构造点（text/body.text 同源、images/media 同引用） |
| `worker/social-content/adapters/bilibili.ts` | B 站：view / player 字幕 / reply 评论样本；b23 短链展开；分 P partKey |
| `worker/social-content/adapters/xiaohongshu.ts` | 小红书：短链展开可用；正文/评论一律 AUTH_REQUIRED（会话桥停用，不恢复） |
| `worker/social-content/adapters/douyin.ts` | 抖音：`_ROUTER_DATA` HTML 分享页解析，标 `unverified`；不下载视频字节 |
| `worker/social-content/resolver.ts` | shares/resolve 编排：queued→resolving→ready/partial/failed、20s 期限、每 scope 2 并发、上限、CAS 落库、planRetry |
| `worker/social-content/excerpts.ts` | items/:id/excerpts：字段夹紧、1200 token 上限、cursor 续读、contentRevision 校验 |
| `worker/social-content/handlers.ts` | `/v1/social/*` 协议层（resolve/list/get/retry/item/excerpts），不挂路由 |
| `worker/social-content/schema.sql` | 待集成的最小 share 关联表草案 |
| `worker/social-content/fixtures/*` | 全虚构脱敏夹具（README 已标注，不代表真实平台响应） |
| `worker/social-content/*.test.ts`、`utils/socialContent/links.test.ts` | 契约测试 |

刻意未做（属集成人/其他卡）：路由挂载（`worker/main-agent/src/index.js`）、DB 绑定与迁移（`utils/db.ts`、`vps-backend/config/services.js`）、共享总类型导出（`types.ts`）、UI（t_bd0a9f65）、上下文投影接线（t_7d03b5d5）。这些文件都是契约 8 列的共享热点。

## 2. 自动化验证（本机真实执行）

```
cd /opt/sullyos/sullyos-repo
npx vitest run utils/socialContent worker/social-content
→ Test Files 7 passed (7) | Tests 136 passed (136)
```

类型门禁（定向，不含全量项目基线）：

```
npx tsc --noEmit -p <scratch>/tsconfig.social.json   # include 本题新增文件
→ exit 0（无错误）
```

全量 `tsc -p tsconfig.json` 在本机跑 >10 分钟未完成，本次未作为证据；release 门禁仍由集成人在发布卡执行。

提交：`3bf02e88 feat(social): share link parsing, SSRF-safe fetch and three platform adapters`（分支 ethernet，只新增文件，未改热点）。

覆盖：

- 识别：三平台长短链、`/discovery/item`、`av` 号、裸 BV、b23/v.douyin/xhslink、分 P、重复链接合并 span、第 6 条起逐项 `SIZE_LIMIT`、>16000 字符拒绝。
- 恶意输入：userinfo 混淆、相似域名、IP 字面量/整型 IP、异常端口、非 http(s)、控制/零宽字符、反斜杠。
- SSRF：私网/回环/链路本地/元数据/ULA/CGNAT/文档段/IPv4 映射、DNS 混入私网即整体拒绝、跳转到私网或白名单外、5 跳上限、https→http 降级、跨站不转发 Cookie。
- 适配器：B 站成功路径（标题/作者/封面/统计/原生字幕时间轴/5 条评论样本/总数字段）、无字幕 `not_available`、评论 403 → `failed` 且正文保留、稿件不可见 62002、b23 展开；XHS 短链展开且签名参数不落 resolvedUrl、正文 `AUTH_REQUIRED`；抖音夹具解析、登录墙 `AUTH_REQUIRED`、无 `_ROUTER_DATA` = `UPSTREAM_CHANGED`、有 router 数据无 aweme = `CONTENT_NOT_FOUND`。
- 状态机：混合三平台顺序、ready/partial（评论失败）、未配置来源、20s 期限 → TIMEOUT 且无残留 resolving、store 有无 -> persistence available/unavailable、planRetry 单调递增与 409 冲突。
- 事件：`social-share.updated` 形状 + (attempt, revision) 单调丢弃规则；`SHARE_FEATURE_DEFAULTS` 默认关总开关/ASR/实验评论/RedNote 会话。
- 摘录：1200 预算夹紧、cursor 续读不重不漏且能读完、query 过滤、partKey 分轨、版本过期 `VERSION_UNAVAILABLE`。
- Node transport：对本机 http server 真实收发一次，验证 `pinnedAddresses` 生效；空 pinned 数组直接拒绝。

## 3. 真实网络探测（2026-10-24，本机出口，仅 READ，无账号/Cookie）

| 目标 | 结果 | 说明 |
| --- | --- | --- |
| `api.bilibili.com/x/web-interface/view?bvid=BV1xx411c7mD` | HTTP 412（带/不带 UA+Referer 都一样） | 被风控预检拦截；已把 412 映射为 `ACCESS_DENIED`，**不声称 B 站真实接通** |
| `www.xiaohongshu.com/explore/64f0aa11bb` | 302 → `/website-login/error?error_code=300015`（"浏览环境异常"） | 与"会话桥停用、正文 AUTH_REQUIRED"的实现一致；未尝试绕过 |
| `www.iesdouyin.com/share/video/7300123456789012345/` | 302 → `www.douyin.com/video/...`；跟随后 200，页面含 1 处 `_ROUTER_DATA`，`loaderData`/`errors` 中无 aweme 节点 | 说明分享页结构可读但该 id 无内容；据此把"有 router 无 aweme"映射成 `CONTENT_NOT_FOUND`，仅在完全抠不到 `_ROUTER_DATA` 时判 `UPSTREAM_CHANGED` |
| `xhslink.com/a/9Kd2Lm`（随手构造的路径） | 404 | 说明短链路径非法时上游直接 404，适配器会得到 `CONTENT_NOT_FOUND` 而非伪造 |

以上只是**一次出口、一个时间点**的探测，不等于平台可用性结论。

## 4. 未验证范围（交付时必须带着这段话）

1. 三平台**均未完成真实内容成功读取**。B 站被 412 风控拦截；抖音只验证到分享页可读、无真实成功样本；XHS 无会话且不恢复会话，正文永远 `AUTH_REQUIRED`。
2. RedNote 独立会话未验证（开关默认 false，代码路径只有 host 白名单变化）。
3. 字幕二次 URL（`aisubtitle.hdslb.com`）与评论接口的真实响应形状未验证，只有夹具。
4. Cloudflare Workers / VPS 实际部署：未挂路由、未绑定 `SOCIAL_CONTENT_DB`、未跑 `tsc`/构建门禁结论（见下）、未验证自包含 data:URL bundle。
5. 多进程租约、唯一索引冲突、跨进程旧持有者类型门禁（定向，不含全量项目基线）：

```
npx tsc --noEmit -p <scratch>/tsconfig.social.json   # include 本题新增文件
→ exit 0（无错误）
```

全量 `tsc -p tsconfig.json` 在本机跑 >10 分钟未完成，本次未作为证据；release 门禁仍由集成人在发布卡执行。

提交：`3bf02e88 feat(social): share link parsing, SSRF-safe fetch and three platform adapters`（分支 ethernet，只新增文件，未改热点）。

覆盖：只有 schema 草案与单进程 CAS 语义测试，真实 D1/SQLite 未测。
6. ASR（`TRANSCRIPTION_ENABLED=false`）、XHS 实验评论（`EXPERIMENTAL_XHS_COMMENTS=false`）：未实现、未开启。
7. UI/事件总线/轮询与上下文投影预算：不在本卡范围。
8. 图片 CDN 白名单 `i0/i1/i2.hdslb.com`、抖音 `p3.douyinpic.com` 未在部署出口验证可达性（代码里封面 URL 只做 https + 来源字段透传，未回源校验）。

## 5. 集成人接线要点

- `worker/main-agent/src/index.js`：在 `checkAuth` 之后挂 `/v1/social/*`，外部 `/agent/v1/social/*` 沿用既有前缀剥离；先 `POST /shares/resolve`、`GET /shares`、`GET /shares/:ref`、`POST /shares/:ref/retry`、`GET /items/:id`、`POST /items/:id/excerpts`。
- 依赖注入：`resolveShares(req, {adapters, sourceIdFor, store, ...})`；`createSocialHandlers({store, getContent, ...})`。`scope` 必须来自服务端鉴权上下文，禁止读 body/query。
- 持久化：`ShareStore` 的 `put(att, expectedRevision)`；`0` 表示只插入。缺持久绑定时 handler 返回 503 `PERSISTENCE_UNAVAILABLE` 并附内存结果，不允许把进程 Map 当持久层。
- 安全：运行环境必须提供能绑定解析地址的 transport（Node 用 `nodeTransport.js`）。**Workers 若无法绑定 DNS 结果，必须拒绝该路径并返回 `UNSAFE_URL`，不能退回裸 fetch。**
- 配置默认值：`SHARE_LINKS_ENABLED=false`、5 链接、评论 1 页 5 条、20s 总期限、8s 单请求、5 跳、2 次尝试、ASR/实验评论关闭——均已在 `types.ts` 常量里给出，读取环境变量与开关仍由集成人做。
