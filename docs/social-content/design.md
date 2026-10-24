# SPARK 与自由活动共用真实内容服务设计

任务：t_1964e5f8。状态：设计交付，未实现、未部署。审计快照：ethernet / 30df593c；工作树另有语音相关改动，不属于本任务。

## 1. 目标与边界

SPARK 推荐流使用可合法使用的真实图文，不再让模型生成帖子、路人评论、回复或封面。刷新、详情、评论分页、筛选、排序、缓存链路必须零 LLM、零生图。来源不可用时显示明确状态或允许范围内的旧缓存，禁止 AI/虚构内容补位。

整合对象是 apps/XhsFreeRoamApp.tsx 的小红书自由活动，不是彼方 VR，也不是后台自主生活/出行。自由活动与 SPARK 共用读取服务、内容 ID、缓存及来源配置，默认浏览不调用模型，仅记实际浏览事件。角色独立感想如后续保留，必须作为默认关闭、受授权/次数/token 护栏限制的独立动作，不改写原作者内容、不声称角色就是原作者。对外发帖、点赞、评论保留在独立写入能力，不因本设计自动启用或扩大授权。

保留用户本地发帖/收藏/隐藏/分享、旧数据、朋友圈 Mastodon 同步、聊天、AIRP 账本与隐私投影、通用生图模块的其他消费者、VR、自主回合与出行。停止 AIRP 素材合成新 SPARK 帖子，不删除旧帖 airpEventIds，不改变其他消费者的可见性和 offered-anchoring 语义。查手机重试隐患为范围外发现，不在本次改功能。

## 2. 现状调用链及替换落点

详细只读证据见 audit-spark.md、audit-activity.md；这些是原始审计，若建议冲突以本设计为准。

| 链路 | 当前实现 | 处理 |
| --- | --- | --- |
| SPARK 桌面与懒加载 | constants.tsx:112；components/PhoneShell.tsx；apps/SocialApp.tsx | 保留入口/视觉 |
| 推荐刷新 | SocialApp.tsx:500-715，先豆瓣后模型；:626 发 chat/completions | 换 shared client.feed，无 API Key 前置 |
| 评论/回复 | SocialApp.tsx:786、:887 | 删伪造生成，仅真实评论或本地用户注释，明确不已发布 |
| 首图 | SocialApp.tsx:639-704 → utils/imageGenFlow.ts → utils/latentImageGen.ts | 切断此入口；保留其他 App 通用能力 |
| 隐含外貌提取 | imageGenFlow.ts:111-176 | 不再由推荐刷新触发 |
| 真实豆瓣 | utils/doubanSource.ts → worker/index.js:2951-3100 | 复用归一化和图片安全策略，端点权限/稳定性由来源评估确认。（**2026-10-24 起此实现已随 Spark 删除**：`utils/doubanSource.ts` 与 `/social/*` 路由都不在了，若真做本方案需另建来源适配器） |
| 自由活动 | XhsFreeRoamApp.tsx:150 → utils/xhsFreeRoam.ts:463；:497 决策，:620/:741/:365 反应 | 只读 browse/search/detail 接 shared client；不再为取内容运行这几轮模型 |
| 真实外部写入 | xhsFreeRoam.ts:541 发布、:438/:409 评论/回复 | 与只读服务隔离，不自动调用，不增加发布授权 |
| 活动与主页 | utils/db.ts xhs_activities/xhs_owned_posts | 保留主页归属，新增内容引用，不重复持久化全文 |
| 共享帖子表 | utils/db.ts:1058-1086，social_posts；types.ts:4001-4046 | 兼容迁移，禁止清空 SPARK 时误删朋友圈 |
| AIRP 投影 | utils/airp/projection.ts:121-134 → SocialApp.tsx:553-569 | 退出新推荐生成，不动账本/其他消费者 |
| API 日志 | context/OSContext.tsx:1100-1232；utils/llmUsage.ts | 保留观测；缺失 usage 不当成零 |
| 后台 | worker/amsg/src/fireKinds.ts:106-113 无自由活动 kind | 本次不增加后台生成任务 |

注意：XHS 产物与 SPARK 当前无直接数据通道；AIRP → SPARK 是另一条自主生活素材通道，不代表 XHS 已接通。云端自主回合可由已同步的 fire_pack 工作，不应称为只能页面打开才能执行。

## 3. 部署与文件所有权（冻结）

选择复用实际已托管、已有鉴权的 main-agent，而非假定 VPS 托管了中央 worker/index.js。后者现有豆瓣接口作为兼容旧版保留，不在第一阶段移除。

新增：

- utils/socialContent/types.ts：前后端同源纯契约。
- utils/socialContent/client.ts：通过 utils/externalRequest.ts 的现有外部请求通道访问后端；不把平台 Cookie、源密钥传到浏览器。
- worker/social-content/service.ts：只读编排；store.ts：D1 SQL；cache.ts：缓存/租约；adapters/{import,douban,xiaohongshu,douyin}.ts：来源实现，未验证平台不得伪称可用。
- worker/social-content/schema.sql：独立持久表及索引。
- worker/main-agent/src/index.js：在 :1413-1414 checkAuth 之后挂 /v1/social/*，复用现有 CORS。外部地址 /agent/v1/social/*，裸 worker 路径 /v1/social/*，沿 :1395 的 /agent 前缀兼容规则。
- vps-backend/config/services.js：给 main-agent 服务增加 db={bindKey:'SOCIAL_CONTENT_DB',pathEnv:'SOCIAL_CONTENT_DB_PATH',defaultPath:显式数据目录路径,schemaPath:新schema}。不要使用仓库目录内的默认数据库路径。
- vps-backend/bin/sullyos-service.js:77-103 和 src/shim/d1.js：已支持 svc.db 的 D1 适配及 schema 初始化，复用，不创建新端口/新常驻服务。
- main-agent 的 Cloudflare 部署配置增加 D1 绑定 SOCIAL_CONTENT_DB；VPS 配置 SOCIAL_CONTENT_DB_PATH=/opt/sullyos/data/social-content.sqlite。这是拟新增配置，当前未创建数据库。

持久绑定缺失时返回 SOURCE_NOT_CONFIGURED；不可用内存 Map 冒充持久缓存。无 need 时不新增定时器，缓存惰性刷新/清理。

鉴权：main-agent/src/index.js:64 使用 AMSG_CLIENT_TOKEN，入口 :1413 统一 checkAuth。此密钥证明部署访问权限，并不证明任意客户端提交的 ownerId。第一阶段只启用部署共享 public 来源；private 来源默认关闭。未来私有来源只有接入可信多用户身份校验并从服务端解析 owner 后才能开启，不能用 query/body ownerId 或角色 ID 隔离。import 写入额外配置 SOCIAL_CONTENT_IMPORT_ENABLED=false（缺省关闭），打开后仍须 checkAuth 且仅管理端使用；不新增匿名写入口。不接受 MAIN_AGENT_ALLOW_ANONYMOUS 开发绕过来写入/导入。

## 4. 标准内容契约

以下是拟实现接口，不是现存代码。时间均 UTC 毫秒，缺失发布/更新时间 null，不用采集时间冒充发布时间。

```ts
type Platform = 'xiaohongshu' | 'douyin' | 'douban' | 'import';
type Availability = 'available' | 'deleted' | 'unavailable' | 'restricted';
interface ContentItem {
  schemaVersion: 1;
  id: string; // platform:encoded(sourceId):encoded(externalId)，各段编码防碰撞
  platform: Platform;
  sourceId: string;
  externalId: string; // 非空原始平台 ID；导入也保留其原平台 ID
  author: { id?: string; name: string; avatarUrl?: string; profileUrl?: string };
  title?: string;
  text: string;
  media: Array<{ id: string; type: 'image'|'video'; url: string;
    thumbnailUrl?: string; expiresAt?: number; status: Availability;
    attribution?: string }>;
  canonicalUrl: string;
  publishedAt: number|null;
  fetchedAt: number;
  updatedAt: number|null;
  attribution: { platformName: string; authorName: string; sourceUrl: string;
    license?: string; retrievalMethod: string };
  status: Availability;
  visibility: 'public'|'private';
  counts?: { likes: number|null; comments: number|null };
}
interface ContentComment {
  id: string; itemId: string; externalId: string;
  author: ContentItem['author']; text: string;
  publishedAt: number|null; fetchedAt: number; canonicalUrl?: string;
  status: Availability;
}
```

作者/平台/原文链接在卡片、详情、分享卡都保留。正文仅按文本渲染，不执行 HTML/脚本；来源文本是不可信外部材料，禁止转换成模型系统指令。原始互动统计不可得则 null，不生成随机数。无图显示真实无图样式，不生图补位。受限/删除内容不展示遗留全文、缩略图或缓存评论。

## 5. 来源适配器与 HTTP 契约

```ts
interface SourcePolicy {
  cacheAllowed: boolean; ttlMs: number; staleMs: number;
  mediaStorageAllowed: boolean; publicRedistributionAllowed: boolean;
  maxPageSize: number; minIntervalMs: number; requestTimeoutMs: number;
}
interface SourceContext {
  scope: string; // 服务端确定的 public 或可信 owner 域
  signal: AbortSignal;
}
interface ContentQuery { query?: string; tags?: string[]; limit: number }
interface ContentPage { items: ContentItem[]; nextCursor: string|null; fetchedAt: number }
interface ContentAdapter {
  id: string; platform: Platform; version: string;
  capabilities: { list: boolean; detail: boolean; comments: boolean; import: boolean };
  policy: SourcePolicy;
  health(): Promise<'configured'|'auth_required'|'disabled'|'degraded'>;
  list(q: ContentQuery, cursor: string|null, ctx: SourceContext): Promise<ContentPage>;
  detail(externalId: string, ctx: SourceContext): Promise<ContentItem>;
  // comments 可选，能力不支持时不调用且不补虚构评论
  comments?(externalId: string, cursor: string|null, ctx: SourceContext):
    Promise<{items: ContentComment[]; nextCursor: string|null; fetchedAt: number}>;
}
```

| 方法与路径（外部统一加 /agent） | 请求及响应 |
| --- | --- |
| GET /v1/social/sources | {sources:[{id,platform,status,capabilities,policySummary}]}，不暴露密钥 |
| GET /v1/social/feed?sourceId=&query=&cursor=&limit= | {items,nextCursor,cache:{state,ageMs},sourceStatus} |
| GET /v1/social/items/:id | {item,cache,sourceStatus}；ID 各段编码且服务端解码验证 |
| GET /v1/social/items/:id/comments?cursor= | {items,nextCursor,cache}，不支持则 422 CAPABILITY_UNSUPPORTED |
| POST /v1/social/import | {sourceId,items,authorization:{basis,redistributionAllowed}}；管理端授权、体积/数量上限、真实原ID/URL/作者必填；响应 {imported,duplicates,rejected} |

统一错误 {error:{code,retryable,retryAfterMs?}}：401 AUTH_REQUIRED，403 SOURCE_RESTRICTED，404 CONTENT_NOT_FOUND，410 CONTENT_DELETED，422 INVALID_QUERY/CAPABILITY_UNSUPPORTED，429 RATE_LIMITED，503 SOURCE_NOT_CONFIGURED/SOURCE_UNAVAILABLE。正文与错误日志不得带 Cookie、签名 URL 查询秘密、账号凭据。

先实现经过授权的真实内容导入；导入不等于公开再分发授权。小红书/抖音只有来源研究和授权均通过后才标 configured；否则 sources 返回 auth_required/disabled，前端提供配置/导入提示。不存在一套代码就能保证不封号；不在本任务安装浏览器、扫码、恢复已停会话或绕过风控。豆瓣旧解析器可以复用，但非公开接口不等于获许可，未确认前不默认扩大请求。

## 6. 共享缓存与数据库

缓存键：SHA-256(stableJSON({schemaVersion,adapterVersion,platform,sourceId,scope,operation,query,cursor}))。query 规范化仅 trim/NFC、tags 排序去重、limit 校验；不随意大小写折叠有语义的搜索词。cursor 是不透明串，不修改；operation 区分 feed/detail/comments。消费者 App、角色 ID、当前时间不入键；scope、adapterVersion 必须入键，凭据原值不得入键。同一查询跨 App 复用，权限域不同绝不复用。

```ts
interface CacheRecord<T> { value:T; fetchedAt:number; freshUntil:number; staleUntil:number }
interface ContentCache {
  get<T>(key:string, now:number): Promise<{state:'fresh'|'stale'|'miss';record?:CacheRecord<T>}>;
  put<T>(key:string, record:CacheRecord<T>): Promise<void>;
  invalidate(ref:{sourceId:string;itemId?:string}): Promise<void>;
  singleFlight<T>(key:string, work:()=>Promise<T>): Promise<T>;
}
```

- social_content_items：scope/source_id/external_id 唯一；JSON 归一正文、版本、状态、时间；唯一约束跨重试去重。
- social_content_queries：cache_key 主键，规范 query、cursor、next_cursor、fresh/stale 时间、payload、lease_owner/lease_until；供多进程 DB CAS 租约。进程内 Map 只减少 Promise 重复，不替代租约。
- social_content_query_items：cache_key/item_id/position，分页结果稳定排序，页间可引用同一内容；展示按 stable id 去重。
- social_content_sources：source_id/scope/policy/version/status、next_allowed_at、failure_count、circuit_until；凭据放服务端 secret，不存明文在此表。
- social_content_media：scope/source/item/media ID、规范 URL 的安全引用、到期/状态、可选 blob hash；仅授权允许时下载存储，按字节 hash 去重；不重复拉相同媒体。临时签名 URL 不剥签名强行认为永久链接。

并发刷新：读 fresh 直接返回；miss/stale 获取 DB 租约，重读确认，唯一持有者访问上游并事务 upsert 内容与页，finally 释放。其他进程仅在策略允许时返 stale，否则有限等待并重读；不得各自再打上游。租约过期可恢复，长请求需续租且不能无条件覆盖别人的结果。

TTL 由来源许可约束而非统一拍脑袋；cacheAllowed=false 时不得持久留正文或伪装缓存命中。stale 只在 staleUntil 内、许可允许且非 deleted/restricted 时使用。源返回删除/撤权立即清理正文媒体评论并保留最小 tombstone，不能用 stale 复活。媒体到期显示失效，可在 detail 刷新时按许可更新，不循环自动续签。

限速按 sourceId+scope：持久 token/时间窗；遵循 Retry-After，指数退避加抖动，连续失败熔断；401/403 不自动重试；读取网络错误只有限重试，外部写操作绝不自动重放。用户刷新不得绕过服务端限速。缺配置返回配置态，不无限重试。缓存条目/容量上限和惰性 GC 可配置；有收藏不等于有权无限保留原文。

指标：cache_hit/miss/stale、upstream_requests、upstream_errors、rate_limited、singleflight_wait、refresh_latency、media_downloads，标签只含来源/操作/消费者类别和安全 scope 分类，不记搜索原文/账号。命中率分母使用有效缓存读取次数，另报上游请求数；禁止把浏览器 HTTP 缓存、LLM 前缀缓存与本服务缓存混成一个比率。

## 7. 配置与可复用组件

现有配置仅识别字段名，不复制值：os_api_config 的 apiKey/baseUrl/model（新真实内容读取不依赖）；imageGenEnabled/latentImageKey（其他功能保留）；os_realtime_config.xhsMcpConfig 的 enabled/serverUrl/deployMode/cookie/bridgeToken（后续读适配器不从客户端传 Cookie）；characters[].xhsEnabled（外部工具授权保留）；spark_douban_groups/hidden、spark_char_handles、spark_social_profile、spark_user_bg（本地用户状态保留）。详见审计配置表，不能把停用 xhs-session 或缺 camofox 描述成已在线。

新增部署配置：SOCIAL_CONTENT_DB、SOCIAL_CONTENT_DB_PATH、SOCIAL_CONTENT_IMPORT_ENABLED（false）；来源 sourceId/platform/enabled、许可策略、限速/熔断阈值、缓存条目/字节上限。无来源配置默认空列表，凭据在服务器端 secret 配置并仅输出存在性。不能让模型或客户端请求修改配额/政策。

复用 socialFeedMerge 的 live 合并防覆盖、momentsFeed 的隔离、doubanSource 归一化及 worker 图片白名单/体积限制、xhsMcpClient 的解析与错误分类（不能直接保留每轮 reset 造成重复握手）、xhsFreeRoamOwnership 的归属、blobRef/blobGc 读写配对、autonomyGuardrails 的零值/暂停语义、externalRequest 的路由、llmUsage 的真实用量字段。抓取服务不依赖 ContextBuilder，不生成大上下文。

## 8. 迁移与回滚

1. 先加 types/service/store/cache/import 及真实 SQL 测试，不触 UI。明确数据库绑定/鉴权/来源配置就绪状态。后端未部署则客户端显示不可用，不恢复 AI。
2. 新增本地 social_content_refs（收藏/隐藏/已读及 sourceId/itemId）、social_browse_events（id/characterId/itemId/action/time/status，实际行为，不编造内心活动）。实施时读取 utils/db.ts 当前 DB_VERSION（审计为79）再递增，不能在并行工作中硬写固定80。缓存正文不进个人备份；收藏引用与用户行为可备份，凭据不随备份传播。
3. SocialApp 替换推荐/详情/评论调用；扩展 types.ts origin 时同步 momentsFeed 可见性枚举及测试，防止真实来源漏进朋友圈。旧 origin 缺失或 gen 归类历史AI，默认新流不混入，可在历史视图查看；不删用户旧数据。删除 SPARK 仅删除所选源或本地引用，禁止 DB.clearSocialPosts 清全表误伤朋友圈。
4. XhsFreeRoamApp 共用同一 client 与查询缓存；浏览事件逐步落库，中断保存状态；真实写入不作为浏览后的默认动作。原有主页/已发布帖子归属不迁为新外部作者，不删除。
5. 迁移分享卡保留 source/author/canonicalUrl/status，旧 social_card 可读。收藏原文失效显示来源不可用，不恢复缓存全文；用户本地笔记与原文分别标识。同步 blob GC、备份白名单与恢复逻辑。
6. 上线前在同一冻结快照完成定向测试、完整仓库门禁与真实授权后的小范围来源连通验证；真实平台验证须另行具备凭据/许可，不能用 mock 宣称接通。

回滚只回退服务/client 版本或展示旧历史，不删除新表，不把新真实内容伪装成 gen，不恢复 AI 补位。切换期间同一稳定内容 ID 不重复插入；适配器版本变更使缓存键变化，保留旧引用兼容读取。

## 9. 基线与验收

真实已执行的离线现存测试（日志放 evidence）：第一批9文件52例，第二批6文件132例，均通过。合计15文件184例。不是全仓测试，未跑 tsc/build，也未验证小红书/抖音真实获取和授权。

静态调用基线，不是线上计费量：SPARK 刷新1次 LLM + 最多2张生图，首次角色外貌可能额外LLM；打开空评论1次、每次用户评论回复1次。自由活动每轮1–3次LLM及MCP握手/业务请求。现有豆瓣列表120秒 worker 内存缓存，详情评论不缓存；自由活动每轮 reset MCP。无新内容服务真实缓存命中率/实际token数据。运行记录位于用户浏览器 api_call_log，本任务未读取生产数据；不能因为没有服务器统计就声称完全不存在请求日志。

审计修正：phoneAutoRefresh.ts:206-217 仅成功写 lastAutoRefreshAt，失败清单飞；OSContext 60秒tick 可造成反复请求。理想化单角色全天/快速失败/前台持续活动下约1440次请求尝试上界，不是实测、更不是一定计费；耗时/页面状态会降低，供应商是否收费未知。自由活动两条 purpose 实际分别为“自由活动生成”和“自由活动”，不能说完全相同；appName/调用入口一起聚合，自动刷新缺meta的归因风险另列。

后续实现验收必须具备：

- 两个真实生产消费者相同query/页在TTL内只打一次上游；并发跨进程/冷热缓存/过期租约恢复使用真实SQLite/D1实例测试，非固定changes的假库。
- 游标分页重复打开复用；不同owner/来源/版本绝不串缓存，客户端自报owner被拒。
- 失效凭据、缺绑定、429 Retry-After、上游超时、熔断、媒体过期、删除/撤权清理与禁止stale复活。
- 各读取链路拦截 LLM/生图请求断言0次；评论不支持/内容为空不能触发AI兜底。
- 原作者/发布时间/原文链接真实保留；未知值为null；未授权外部写入为0次；关闭/暂停/零额度保真。
- 新旧origin隔离、收藏隐藏/备份恢复/分享卡/清空不伤朋友圈；真实来源可用状态与mock测试结果分开报告。

## 10. 原始审计证据的解释优先级

附录是两位执行者的只读快照，包含较宽的优化建议，不是实施授权。本设计不采纳“把Spark三段prompt继续目录化”“保留详情不缓存作为不可改契约”等建议，明确由真实内容服务替代。任何费用节省百分比、线上命中率、平台稳定性/账号安全保证均未测量，禁止据此承诺。此任务仅交付设计文档，后续来源评估与实现按原任务图衔接，不追加范围外修复。
