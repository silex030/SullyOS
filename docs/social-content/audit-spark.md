# SullyOS · Spark（社交 App）只读审计报告

> **历史文档（2026-10-24 更新）**：Spark 已按用户要求整块退役，本报告中的代码路径多数已不存在
> （`apps/SocialApp.tsx`、`utils/doubanSource.ts`、`worker/index.js` 的 `/social/*`、`visibleInSpark`、
> `selectMomentsMaterial` 等全部删除）。本文件只作**盘点留档**，别再按它去改代码；
> 退役清单、刻意保留项与迁移说明见 `notes/spark-removal-2026-10-24.md`。

- 审计对象：`/root/SullyOS`，分支 `ethernet`，HEAD `30df593c`（2026-10-23 22:34:56 +0800，`feat(tts): MOSS-TTS-Nano local voice end-to-end (v3.21)`）
- 工作树状态：`git status` 有 12 个已改 + 6 个未跟踪文件，全部属于 TTS/语音/worker bundle/文档那条线（`CLAUDE.md`、`notes/*`、`apps/Character.tsx`、`apps/Settings.tsx`、`utils/*tts*`、`worker/main-agent/*`、`components/voice/MossVoicePicker*`）；**Spark 相关文件（`apps/SocialApp.tsx` / `utils/doubanSource.ts` / `utils/socialFeedMerge.ts` / `utils/momentsFeed.ts` / `worker/index.js` / `utils/db.ts`）对 HEAD 零差异**，本报告描述的就是可提交内容。
- 只读约束执行：未改任何源码/配置/数据，未跑全量测试、`tsc`、`build`，未请求真实豆瓣 / LLM / latent.moe / VPS，未读取或输出任何密钥。仓库里的 `latentImageKey`、`apiKey` 只按字段名引用。
- Spark 的真实路径：**`apps/SocialApp.tsx`**（1586 行，AppID `social`，UI 名「Spark」，常量表注释 `constants.tsx:112`）。仓库里不存在 `apps/Spark*` 目录或文件。

---

## 0. 结论摘要（按严重度）

| 级别 | 结论 | 证据 |
|---|---|---|
| P1 成本 | **首图链路有一次隐藏 LLM 调用**：角色没有 `imageGenProfile` 时，生图前会先跑「外貌提取」LLM（`temperature 0.2` / `max_tokens 300`）。Spark 刷新触发配图就等于间接触发它，且它不属于 Spark 自己的 3 个调用点，容易被成本核算漏掉 | `utils/imageGenFlow.ts:146-176`、`:111-144`、`apps/SocialApp.tsx:480-485` |
| P1 可测性 | **Spark 主流程零行为测试**：刷新解析、封面作业门禁、身份过滤、评论/回复单飞、清空，全部没有单测；唯一覆盖 Spark 的用例是「源码锚」（读文件断言字符串） | `utils/socialAppBlobRefs.test.ts:1-56`，全仓无 `SocialApp` 行为测试 |
| P1 生命周期 | **`social_posts` 没有保留策略、没有分页**：启动 `getAll()` 全量进内存，每次刷新再追加 8–24 行，帖子与评论数组只增不减，且整表进备份 | `apps/SocialApp.tsx:240-249`、`utils/db.ts:1058-1068`、`utils/db.ts:3466`/`:3524`、`context/OSContext.tsx:4018`/`:4636` |
| P2 配置 | 三段提示词全硬编码，未进 `promptPresetCatalog`（全仓 0 条 `spark*`/`social*` sourceKey）；调用地图只有 1 行 `social-feed`，anchor 只指刷新流，评论/回复两处未单列 | `apps/SocialApp.tsx:582-625`、`:760-785`、`:868-886`；`utils/promptCallRegistry.ts:60`；`utils/promptPresetCatalog.ts` 无对应键 |
| P2 数据 | 两个个性化 localStorage 键（`spark_douban_groups` / `spark_douban_hidden`）**不在备份里**；`spark_char_handles` 被 Spark 与朋友圈 MomentsApp 双写、无合并 | `utils/doubanSource.ts:34-35`、`context/OSContext.tsx:4103-4106`、`apps/MomentsApp.tsx:220-244` |
| P2 安全 | 豆瓣真实标题/正文/评论原样拼进 prompt，无分隔与「以下为外部不可信内容」声明；作者昵称作为 seed 外发 `api.dicebear.com`，且 strangers 的 seed 带 `Math.random()` → 每次刷新都是新 URL，缓存必失效 | `apps/SocialApp.tsx:515`、`:597-600`、`:761-767`、`:648`、`:662` |
| P2 容错 | 三个 `fetch` 只有「卸载/清空/重开」abort，**无超时、无重试**；`data.choices[0].message.content` 无保护；模型多给的配图超 2 张静默丢弃 | `apps/SocialApp.tsx:626-637`、`:786-796`、`:887-897`、`:687` |
| P3 UI | 「我的」页三个统计数字写死（142 / 12.5k / 8902）；个人页分享按钮无 `onClick`（死按钮）；删帖按钮仅 hover 可见（触屏不可达）；`docs/design-system.md` 的「分 App 隔离清单」里没有 Spark 条目 | `apps/SocialApp.tsx:1531-1533`、`:1489`、`:1146`；`docs/design-system.md:60-71` |

---

## 1. 模块地图（真实路径）

| 层 | 文件 | 职责 |
|---|---|---|
| App / UI | `apps/SocialApp.tsx` | 全部界面 + 三段 LLM 生成 + 豆瓣混排 + 首图作业（单文件 1586 行，无子组件拆分） |
| 豆瓣数据源（前端） | `utils/doubanSource.ts`（286 行） | 归一化 / 小组配置 / 隐藏 id / 图片代理 URL / worker 调用 |
| 信息流合并纯函数 | `utils/socialFeedMerge.ts`（37 行） | 去重前置、按 live 版本更新、评论合并 |
| 跨 App 可见性 | `utils/momentsFeed.ts:36-40` | `visibleInSpark` 排除 `mastodon` / `moments` |
| AIRP 投影 | `utils/airp/projection.ts:121-134` | `selectMomentsMaterial`：只要 `public` + `disclosedToUser` |
| 存储 | `utils/db.ts:63`、`:307`、`:1058-1086` | `social_posts` store（keyPath `id`），CRUD |
| 后端代理 | `worker/index.js:2951-3100` | `/social/douban/topics|topic|comments`、`/social/img` |
| 生图内核 | `utils/imageGenFlow.ts:274-312`、`utils/latentImageGen.ts:120-245` | 外貌档案替换、串行队列、latent.moe 轮询 |
| 聊天侧读取 | `utils/chatPrompts.ts:1580-1610`、`components/chat/MessageItem.tsx:3080` | 分享到聊天后的 `social_card` 渲染与身份提示 |
| 注册与入口 | `constants.tsx:112`/`:145`、`components/PhoneShell.tsx:33`/`:85`/`:881`、`components/os/appPreload.ts:44`、`utils/safeAreaApps.ts:12` | Dock 第 3 格、懒加载、预加载、安全区列表 |

**边界说明（不在本报告范围）**：`apps/CheckPhone.tsx` 的「查手机 → 朋友圈」是另一套按角色生成 2 条动态的系统（`apps/CheckPhone.tsx:940-942`、`:2855`），记录存在 CheckPhone 自己的 records 里，与 Spark 无数据往来；`apps/MomentsApp.tsx` 是朋友圈（mastodon/本地），与 Spark 通过 `origin` 过滤隔离（2026-09-23 决策，`docs/superpowers/specs/2026-09-23-mastodon-moments-design.md:18-25`）。两者与 Spark 只有「共用同一 localStorage 马甲键 + 复制了同一套 prompt」两处耦合。

---

## 2. 内容生成：调用点、触发、频率、参数

### 2.1 调用点清单

| # | 位置 | 用途 | 触发方式 | 实际频率 | 参数 | 上下文规模 |
|---|---|---|---|---|---|---|
| 1 | `apps/SocialApp.tsx:626-632` | 刷新推荐流，一次产出 6–8 条帖子 | 手动点「点击刷新推荐流」（`:1444`） | 每次点击 1 次；请求在飞时重复点击被 `refreshRequestRef` 挡掉（`:501`） | `temperature 0.95`、`max_tokens 8000`、`stream` 未声明（全局限流器可能升级为流式） | 3 个随机角色的 `buildCoreContext(..., false)`（轻量，不含详细记忆）+ 各角色最近一条私聊前 20 字 + AIRP 素材 + 豆瓣热点标题 + 全部角色马甲表 |
| 2 | `apps/SocialApp.tsx:786-792` | 帖子评论 4–6 条（角色 + 路人混排） | 首次打开帖子（`:1017-1026`）；豆瓣帖在拉完真实详情/评论后兜底调用（`:1052`） | 每帖**至多 1 次/会话**：`livePost.comments.length > 0` 直接返回（`:720`）；打开另一帖会 abort 上一帖（`:722`） | `temperature 0.8`，无 `max_tokens` | 2 个随机角色 coreContext + 帖标题/正文全文 |
| 3 | `apps/SocialApp.tsx:887-893` | 回复用户刚发的评论 1–3 条 | 用户发送评论后（`:1014`） | 每条用户评论 1 次；**全局单飞**（`:843`，同时只能有一个回复请求） | `temperature 0.9`，无 `max_tokens` | 全角色马甲表 + 帖正文 + 用户评论原文 |
| 4（间接） | `utils/imageGenFlow.ts:123-135` | 角色外貌 danbooru tag 提取 | 首图生成且 `char.imageGenProfile` 为空 | 每角色每会话最多 1 次（成功写回角色；失败进 `extractFailedProfiles` 负缓存） | `temperature 0.2`、`max_tokens 300` | `systemPrompt + writerPersona + worldview` |
| 5（间接） | `utils/latentImageGen.ts:120-245` | 帖子首图 | 刷新时模型给出 `image` 字段 | 每轮 ≤2 张（`:639`、`:687`），模块级串行队列（`:240-245`），单张最多轮询 5 分钟 | 采样器 `er_sde` / 调度器 `linear_quadratic` / 12 步 | 由 4 的 tag + 画风/质量词/性别拼装 |

**成本画像（按设计推断，非实测）**：一次「刷新」= 1 次 LLM（8000 输出上限）+ 2 次豆瓣 HTTP + 最多 2 张生图（每张可能先触发 1 次外貌提取 LLM）。生图是 fire-and-forget（`:704-705`），不阻塞刷新流，因此失败只以 toast 出现（`:491`），不重试。

### 2.2 提示词与解析容错

- 刷新提示词（`:582-625`）：三段结构 —— 任务/内容构成（角色帖 30%、路人 70%）、真实热点（豆瓣标题，注明「禁止照抄标题原文、禁止冒充豆瓣用户」）、身份表 + 三条禁令（禁止扮演用户、路人不得冒用角色马甲、禁止上帝视角），输出要求纯 JSON 数组。
- 评论/回复提示词（`:760-785`、`:868-886`）：明确要求「回应正文内容而不是标题」「禁止与用户昵称相同」「路人昵称不得与马甲重合」。
- 解析：`safeParseJSON`（`:90-119`）两级容错 —— 先剥 ```json 围栏后 `JSON.parse`；失败则从第一个 `[` 起，从后往前逐个 `}` 尝试补 `]`；单键对象包数组也能救出。
- 身份回填：`isCharacter` 为真但按 `charId`/handle 都匹配不上时**降级为路人**（`:658-663`），避免错误归属；`authorType` 落库供评论区与分享卡片使用。
- 用户防冒用是**后置过滤**：`name !== socialProfile.name`（`:645`、`:802`、`:902`）。只做 trim 后全等比较，没有归一化（大小写/全半角/形近字），提示词里说的「近似」在代码层没有对应判定。
- 空/异常响应：`choices[0].message.content` 无可选链（`:636`、`:796`、`:897`），provider 返回 200 但没有 `choices` 时会抛 TypeError，被 catch 成「刷新失败: Cannot read properties…」，属于可读性差的失败信息。

### 2.3 AIRP 素材投影（真实事件 → 帖子）

- 每个被选中角色先 `listAirpEventsByChar(char.id)`（DB 读），再 `selectMomentsMaterial(events, projectedEventIds)` 过滤「公开 + 已向用户交代 + 未投影过」（`utils/airp/projection.ts:121-134`），上限 `MOMENTS_MATERIAL_LIMIT`。
- 去重是无状态的：从 `feedRef` 扫该角色已有帖子的 `airpEventIds` 求并集（`apps/SocialApp.tsx:553-557`），没有独立账本。
- 锚定粒度 = 「这一轮喂给模型的整批事件」，只要该角色本轮有帖子就整批写回（`:692-702`），代码注释明确这是评审裁决过的「offered-anchoring」而非窄匹配。副作用：模型没用素材也算消费掉，宁可少喂。
- 没有任何配置开关能单独关闭这条投影；只要 AIRP 有公开且已交代的事件，它就进 prompt。

### 2.4 配图门禁

`imageGenReady = apiConfig.imageGenEnabled === true && latentImageKey 非空`（`:574`）。门关时提示词里连 `image` 字段都不出现（`:622`），模型不会写；门开时才在输出格式里加一行，并在落库时二次校验「必须是角色帖」（`:687`）。这套「提示词与执行路径同进同退」的写法值得保留。

---

## 3. 缓存与去重（键、TTL、失效面）

| 层 | 键 | TTL / 生命周期 | 失效与风险 | 证据 |
|---|---|---|---|---|
| 后端（worker isolate） | `` `${group}:${start}` `` | 120s（`DOUBAN_LIST_TTL_MS`） | 模块级 `Map`，只对同键覆盖，**过期项不主动清理、无条目上限**；跨用户共享（缓存的是豆瓣公开数据，不含用户信息） | `worker/index.js:16-18`、`:3013-3019` |
| 后端 | 详情 / 评论 | 不缓存 | 每次打开都打豆瓣，评论端点「形态未经长期验证」失败即 502，前端静默跳过 | `worker/index.js:2955-2956`、`:3031-3060` |
| 前端（内存） | `doubanDetailLoadedRef` | 单次 App 会话 | 只要调过一次就永不再拉（`:1020-1023`）；本次失败也不重试，正文停留在 abstract | `apps/SocialApp.tsx:224`、`:1020` |
| 前端（DB） | 帖子 `id` | 永久 | `douban:${tid}` 稳定；AI 帖 `post-${Date.now()}-${Math.random()}`（`:668`）、用户帖 `user-post-${ts}`（`:955`）→ **AI 帖内容重复不会被去重** | `utils/doubanSource.ts:247`、`utils/socialFeedMerge.ts:8-12` |
| 前端（DB） | 评论 `id` | 永久 | AI 评论 `cmt-${Math.random()}`（`:816`）、回复 `cmt-reply-${ts}-${rand}`（`:915`）；真实豆瓣评论 `douban-cmt:${id}`，无服务端 id 时按索引兜底 | `utils/doubanSource.ts:277` |
| 前端 | AIRP 去重 | 随帖子生命周期 | 键是「角色已有帖子的 `airpEventIds` 并集」，帖子被删则锚点一起消失（删帖会重新喂素材） | `apps/SocialApp.tsx:553-557`、`:464-470` |
| 图片 | blob 令牌 | 永久（孤儿靠 GC） | `putImageBlob` 不去重，每张 AI 首图都是新 Blob；只有迁移路径 `putImageBlobDeduped` 按内容 hash 复用 | `utils/blobRef.ts:201-218`、`utils/blobGc.ts:78` |
| HTTP | `/social/img` | `public, max-age=86400` | 只放行 `doubanio.com`，>3MB 截断；worker 换地址后旧 URL 失效 | `worker/index.js:3062-3100` |
| 外链头像 | `api.dicebear.com/7.x/<style>/svg?seed=…` | 无本地缓存 | 路人 seed `authorName + Math.random()`（`:662`）→ 每次刷新 URL 变，浏览器缓存必不命中；昵称外发给第三方 | `apps/SocialApp.tsx:648`、`:662`、`:806`、`:906` |

**没有的东西**（属于设计选择，需知悉）：没有 LLM 结果的本地缓存/复用（每次刷新都是新内容、新计费）；没有豆瓣列表的客户端缓存（只有 worker 的 120s）；封面图没有「同一帖子只生成一次」的持久标记——重开 App 不会重生（令牌已入库），但同一轮刷新重复点会因 `refreshRequestRef` 被挡。

---

## 4. 存储与数据生命周期

### 4.1 表与字段

`social_posts`（IndexedDB，keyPath `id`，`utils/db.ts:63`/`:307`，DB 版本 `79`）：

```
SocialPost  types.ts:4012-4046
  id / authorName / authorAvatar / title / content / images[] / likes
  isCollected / isLiked / comments:SocialComment[] / timestamp / tags[] / bgStyle?
  authorType? 'user'|'character'|'stranger'   authorCharId?
  origin? 'gen'|'douban'|'mastodon'|'moments'   ← Spark 只看 gen/douban
  sourceId? sourceUrl? groupTitle? groupId?    ← 豆瓣
  mastodonStatusId? mastodonInstance? mastodonOwnerId?  ← 朋友圈，Spark 过滤
  airpEventIds? []                             ← AIRP 投影锚点
```

### 4.2 写入 / 更新 / 删除点（全量）

| 动作 | 位置 | 落库策略 |
|---|---|---|
| 启动载入 | `:239-250` | `getAll()` → 过滤 `visibleInSpark` → 按 `timestamp` 倒序；与请求在飞期间的新内容按 id 合并，不覆盖 |
| 批量插入（刷新 / 豆瓣） | `:445-452` | 只持久化**本批新帖**，刻意不重存请求开始时的旧快照（防丢评论） |
| 单帖更新（点赞/收藏/评论/封面/豆瓣详情） | `:454-462` | 用 `feedRef` 的 live 版本更新，随后 `DB.saveSocialPost` |
| 用户发帖 | `:952-977` | 直接进 feed + 落库 |
| 删单帖 | `:464-470`、`:979-984` | 删 DB；豆瓣帖额外写 `spark_douban_hidden`（只留最近 500 个，`utils/doubanSource.ts:84-92`） |
| 清空推荐流 | `:1062-1079` | `DB.clearSocialPosts()` + 清空内存与 detail 记忆 |
| 备份导入覆盖 | `utils/db.ts:3949-3952` | 整表 clear + 批量写入 |

### 4.3 备份覆盖

- V3 分片导出：`social_posts` 在 `allStores` 清单里（`context/OSContext.tsx:4018`），由 `case 'social_posts'` 映射到 `backupData.socialPosts`（`:4636`），另有 `socialAppData`（马甲表 / 用户资料 / Spark ID / 背景图）单独打包（`:4100-4106`）；两个 assets 行 `spark_social_profile`、`spark_user_bg` 在 `isRedundantManagedAssetId` 名单里（`:4002-4006`，不从 assets store 重复托管，改由 `socialAppData` 携带）。
- 传统整包导出：`social_posts` 与 `assets` 同批读出（`utils/db.ts:3463-3469`、`:3524`）；导入侧 `runSection('动态帖子', …)`（`:3949`）。
- 覆盖声明测试：`utils/backupCoverage.ts:45` 把 `social_posts` 映射到 `socialPosts` 字段。
- **缺口**：`spark_douban_groups`、`spark_douban_hidden` 是纯 localStorage，导出路径只显式带了 `spark_char_handles` / `spark_user_id`（`context/OSContext.tsx:4103-4106`），所以换机/恢复后小组列表回到 8 个预置组、已删豆瓣帖会重新出现。
- blob 旁路：AI 首图的二进制以 `blobs/<id>` 直写 zip，令牌留在 JSON 里（`utils/backupBlobs.ts:1-20`），恢复端按原 id 还原 —— 首图可随备份迁移。

### 4.4 回收与体积

- 孤儿 GC 引用面包含 `social_posts`，且是**整行 `JSON.stringify` 枚举**（不是按字段挑），所以 `authorAvatar` / `comments[].authorAvatar` / `images[]` 里的令牌都被算作「仍被引用」（`utils/blobGc.ts:31-90`）。
- 存储优化只转 `authorAvatar` 与评论头像，**明确不转 `images[]`**，注释理由「读端还没认令牌」（`utils/storageOptimize.ts:686-700`、`:74`）。但读端 `renderPostCover` 已经认 `isBlobRef`（`apps/SocialApp.tsx:1086-1091`），而封面的新令牌本来就会写进 `images[0]`（`:487`）—— 注释与实现已不一致，属于可以安全扩展的点（改前需覆盖 `images[1..]` 的渲染面，目前无处渲染）。
- **无 TTL、无条数上限、无归档**：帖子/评论只增；启动 `getAll()` 全量读；每次刷新再多 8–24 条。按每天刷 5 次估算，一个月约 1200–3600 条帖子进库并同步进每次备份。

---

## 5. 前后端接口

| 方向 | 接口 | 契约要点 | 证据 |
|---|---|---|---|
| 前端 → worker | `GET /social/douban/topics?group=<slug>&start=0` | `group` 必须 `^[A-Za-z0-9_-]{1,64}$`，`start` `^\d{1,6}$`；成功 `{success:true,data:{topics}}`；上游失败 502 / 超时 504；命中缓存附 `cached:true` | `worker/index.js:3008-3029` |
| 前端 → worker | `GET /social/douban/topic?id=<tid>` | `tid` `^\d{1,16}$`；正文/图/点赞；不缓存 | `:3031-3043` |
| 前端 → worker | `GET /social/douban/comments?id=<tid>&start=0` | 三层容错（`comments`/`replies`/`list`）；端点形态未长期验证，失败即 502 由前端静默跳过 | `:3045-3060`、`utils/doubanSource.ts:212-229` |
| 前端 → worker | `GET /social/img?u=<url>` | 只允许 `doubanio.com` 及其子域；SSRF 防护 + 重定向白名单；>3MB 截断；`Cache-Control: public, max-age=86400`；`Referer: www.douban.com` 过图床校验 | `:3062-3100` |
| 前端 → worker | `GET/POST /latent/*` | 首图 4 个端点透传到 `latent.moe/api`，worker 只透传 key、不落盘 | `worker/index.js:4306-4330` |
| 前端 → LLM | `POST {baseUrl}/chat/completions` ×3 | Spark 侧直接 `fetch`，不带 `safeFetchJson`；全局拦截器（`context/OSContext.tsx:1092-1200`）负责采样参数清理、透明流式升级、`blobref` 还原、主代理中转、API 统计，并通过 `__sullyMeta {appId:'social', appName:'Spark', purpose}` 标注用途 | `apps/SocialApp.tsx:626-632`、`:786-792`、`:887-893` |
| 前端 → 第三方 | `api.dicebear.com`、`cdnjs.cloudflare.com`（twemoji） | 直连，不经 worker；不产生费用但泄漏昵称、受第三方可用性影响 | `:26-27`、`:648`、`:662`、`:1405` |
| App → App | `DB.saveMessage({type:'social_card', metadata:{post}})` | 分享帖子进单聊/群聊；聊天侧用 `spark_char_handles` 标注「你自己的马甲 / 用户 / 路人」，防止角色把自己的马甲当陌生人 | `apps/SocialApp.tsx:943-950`、`utils/chatPrompts.ts:1580-1610`、`components/chat/MessageItem.tsx:3080` |

**降级行为**：豆瓣失败不挡 LLM（`:519`）；没有 API Key 时仍展示豆瓣并提示「请配置 API Key」（`:521-527`）；未部署 `/social/*` 的 worker 实例会让豆瓣段整体静默失败（CORS 或 404），表现为「只有 AI 流」——这正是 notes 里记录的降级路径（`notes/ethernet-branch-context.md` Spark 豆瓣条）。

**CORS**：`/social/*` 走 `jsonResponse` 的统一 `corsHeaders`（`worker/index.js:20-35`），OPTIONS 在通用分支统一返回（`:2515`）；但 `worker/corsContract.test.ts` 里**没有** `/social` 通道的断言（文件内搜不到 social），属于契约测试未覆盖的第五条通道。

---

## 6. 配置与开关

| 配置 | 存储 | 作用面 | 证据 |
|---|---|---|---|
| `apiConfig.apiKey/baseUrl/model` | 全局 `os_api_config` | 三段生成都用它；缺 Key 时只跑豆瓣 | `apps/SocialApp.tsx:165`、`:521`、`:626` |
| `apiConfig.imageGenEnabled` + `latentImageKey` | 设置页「AI 生图」 | 首图总开关 + 缺 Key 即关闭；关时提示词不出现 `image` 字段 | `apps/Settings.tsx:673-674`、`:1402`；`apps/SocialApp.tsx:574` |
| `characters[].imageGenStyleTags` / `imageGenGender` / `imageGenProfile` | 角色 App | 画风通用注入、性别仅在 `@角色名` 出现时注入、外貌 tag 自动提取 | `utils/imageGenFlow.ts:281-291`、`:146-176` |
| `characters[].socialProfile.handle` | 角色数据 | 默认马甲名的来源 | `apps/SocialApp.tsx:311` |
| `characterHandles` | localStorage `spark_char_handles` | 每角色多个马甲（handle + note），Spark「管理」弹窗增删改；**朋友圈 MomentsApp 读写同一个键** | `apps/SocialApp.tsx:300-325`、`:1260-1319`；`apps/MomentsApp.tsx:220-244` |
| 豆瓣小组 | localStorage `spark_douban_groups` | 预置 8 组（杭州/深圳/武汉/租房/美食/情感/电影/旅行），增删前先试拉一次校验 | `utils/doubanSource.ts:23-32`、`:37-57`；`apps/SocialApp.tsx:359-376` |
| 已删豆瓣帖 | localStorage `spark_douban_hidden` | 最多 500 条 | `utils/doubanSource.ts:74-92` |
| 用户 Spark 资料 | assets `spark_social_profile`（JSON，头像为 blobref）+ localStorage `spark_user_id` | 「仅在 Spark 生效」，与全局用户档案解耦 | `apps/SocialApp.tsx:202-208`、`:437-443` |
| 用户背景图 | assets `spark_user_bg`（blobref） | 二进制进 blobStore | `apps/SocialApp.tsx:404-420` |

**配置层结论**：
1. **没有独立的 Spark 总开关**，也没有设置页入口；所有配置散在 App 内「管理」弹窗与全局生图设置里。想整体关掉 Spark 的 AI 生成只能靠清空 API Key（会连带影响全系统）。
2. **提示词不可配**：三段 prompt 写死在 TSX 里，`promptPresetCatalog`（内置 sourceKey 目录）与 `snapshotBuiltinPrompts` 中都没有 Spark 条目；`promptCallRegistry` 只有一行 `social-feed`（`utils/promptCallRegistry.ts:60`），`visibility: 'local-uncaptured'` 表示未接入抓取。这与 ethernet「全系统提示词目录化 + 预设 App 三段式」的方向不一致。
3. **`spark_char_handles` 是跨 App 共享可变键**：两个 App 都「读 → 补默认 → 整体写回」，没有版本号或字段级合并；同时开两个 App 编辑马甲时是最后写入者获胜。

---

## 7. UI 实现与风格契约

### 7.1 现状

- 视觉：品牌红 `#ff2442`（`:73`），底 `bg-gradient-to-br from-rose-50 via-slate-50 to-teal-50`（`:1257`），浅玻璃卡 `bg-white/70 backdrop-blur-md rounded-2xl`（`:1120`），双列瀑布流 `columns-2`（`:1453`），封面固定 4:5（`:1121`），随机渐变封面 8 套（`:76-85`）。
- 详情页：整屏覆盖 `absolute inset-0 z-[60] bg-white/90 backdrop-blur-xl` + `animate-slide-up`（`:1157-1165`），安全区手写 `max(12px, var(--safe-top))`（`:1167`）与 `pb-[var(--safe-bottom,0px)]`（`:1225`）。
- 底部导航：浮动玻璃岛 + 中央凸起「+」（`:1569-1578`）；发布页整屏覆盖（`:1363-1412`）。
- 动效：`animate-slide-up` / `animate-fade-soft` / `animate-fade-in` 均为 `index.html` 中央 token，且都在 `prefers-reduced-motion` 降级名单里（`index.html:48`、`:62`、`:327-330`）——这一点合规。
- 三个弹窗都用通用 `Modal`（`:1260`、`:1321`、`:1334`），符合「不新造第 N 种弹窗」。

### 7.2 与 `docs/design-system.md` 的落差

1. **Spark 不在「分 App 隔离清单」**（`docs/design-system.md:60-71` 只有外卖/购物、Bank、Chat、设置、自习室、桌面伴侣、动森）。Spark 的「玫瑰底 + 品红 CTA + 4:5 双列」事实上是一套独立视觉语言，却没有任何契约记录；后续任何人改 Spark 都无表可对，也没有「不许外借」的边界声明。
2. **详情页用了 `z-[60]` + 自定义全屏覆盖**，而不是 `BottomSheet`/`Modal` 两套固定封装之一；虽然动效 token 合规，但层级与关闭手势自成一套。
3. **可访问性**：全部图标按钮无 `aria-label`（如 `:1168`、`:1173`、`:1146`），`img` 的 `alt` 用标题（可接受），收藏/点赞无 `role`/状态播报。
4. **可见的假数据与死控件**：「关注 142 / 粉丝 12.5k / 获赞 8902」写死（`:1531-1533`）且不随任何数据变化；个人页分享按钮无 `onClick`（`:1489`），点了没反应。
5. **触屏可用性**：删帖按钮 `opacity-0 group-hover:opacity-100`（`:1146`），触屏没有稳定的 hover，等于移动端基本删不掉；而删帖对豆瓣帖还承担「写 hidden 列表」的业务语义。
6. 空态只有「空空如也」（`:1561`），没有引导去刷新或配 Key。

---

## 8. 测试现状

### 8.1 已有覆盖（与本模块相关）

| 文件 | 用例数 | 覆盖内容 |
|---|---|---|
| `utils/doubanSource.test.ts` | 17 | 归一化（缺字段/默认值/HTML 转文本/超长截断）、豆瓣时间解析、8 个预置组、load/save 回退、`parseDoubanGroupInput`、hidden id 集合、图片代理判定、`topics` 信封 + 隐藏过滤、上游失败抛错 |
| `worker/doubanProxy.test.ts` | 11 | 三条豆瓣端点的参数校验、UA/Referer、120s 缓存命中、`/social/img` 白名单与截断、非 JSON / 502 分支（上游全 stub，不碰真豆瓣） |
| `utils/socialFeedMerge.test.ts` | 4 | 请求在飞期间新帖不被覆盖、按 live 版本更新、评论重试不重复、豆瓣/AI 同 id 去重 |
| `utils/momentsFeed.test.ts` | 11 | 含 `visibleInSpark` / `visibleInMoments` 的 origin 隔离断言（`:53-59`） |
| `utils/socialAppBlobRefs.test.ts` | 3 | **源码锚**：读 `apps/SocialApp.tsx` 断言写端用 `putImageBlob`、读端用 `TokenImg`、`assets` 在 GC 引用面 |
| `utils/airp/projection.test.ts` | 11（`selectMomentsMaterial` 段） | 只取 public+disclosed、已投影剔除、limit/0/负值、脏输入 |
| `utils/storageOptimize.test.ts` | 多处 | `social_posts` 头像令牌化、`spark_social_profile` 资产处理 |

### 8.2 缺口（按风险排序）

1. **刷新链路零测试**：`safeParseJSON`（两级容错）、6–8 帖映射、身份降级为路人、用户昵称过滤、`imageGenReady` 门、`MAX_COVERS` 截断、`airpEventIds` 写回 —— 全是内联在组件里的逻辑，无法单测。
2. **评论/回复链路零测试**：首次打开才生成、有评论即跳过、abort 上一帖、全局单飞、`mergeSocialComments` 之外的去重语义。
3. **无 DOM 级测试**：`@testing-library` 在该 App 完全没有落点（对比：`apps/CheckPhoneHomeCard.test.tsx` 存在）。
4. **`worker/corsContract.test.ts` 未覆盖 `/social/*`**，新增/改动该通道不会触发契约断言失败。
5. **源码锚测试的脆弱性**：`socialAppBlobRefs.test.ts` 靠字符串存在性，任何一次「整理注释/改写法」都可能假红，同时它无法证明行为正确（例如 `images[0]` 令牌真的渲染出来了没有）。

---

## 9. 应替换 / 应保留的边界

### A. 必须保留（外部契约 / 已有数据 / 已验收行为）

| 项 | 理由 |
|---|---|
| `SocialPost` / `SocialComment` 字段形状与 `origin` 判别式（`types.ts:4001-4046`） | 已落库 + 已进备份 + 朋友圈/Spark 靠 `origin` 隔离；改形状要写迁移 |
| IndexedDB store 名 `social_posts` 与 keyPath `id`（`utils/db.ts:63`/`:307`） | 备份/导入/GC/存储优化四处硬引用 |
| 豆瓣三端点路径与信封 `{success:true,data}`、`/social/img` 白名单 | 已部署的 worker 实例与前端版本可能不同步；改路径等于强制同版本 |
| 120s 列表缓存与「详情/评论不缓存」 | 直接决定豆瓣侧请求量与风控表现 |
| `visibleInSpark` / `visibleInMoments` 的 origin 过滤（`utils/momentsFeed.ts:36-40`） | 2026-09-23 用户决策，Spark 与朋友圈互不影响 |
| AIRP offered-anchoring 语义 + `airpEventIds` 字段（`apps/SocialApp.tsx:692-702`） | 代码注释明确是评审裁决「勿改成窄匹配」 |
| `generateImageBlobOnly` + `queueLatentGeneration` 复用（`utils/imageGenFlow.ts:274-312`） | 与聊天生图共用外貌档案/串行队列/画风注入，是刻意收口 |
| blobref 令牌读写同进同退（`putImageBlob` 写 / `TokenImg` 读） | 有源码锚测试锁定；退回 data URL 会让 assets 行继续膨胀 |
| `spark_char_handles` 的 `Record<charId, SubAccount[]>` 结构 | MomentsApp 与 `chatPrompts` 都在读，改结构要三处同步 |

### B. 建议替换（内部实现，可独立演进）

| 项 | 现状 | 替换方向 | 风险 / 前置条件 |
|---|---|---|---|
| 三段硬编码 prompt | `apps/SocialApp.tsx:582-625`、`:760-785`、`:868-886` | 抽到 `promptPresetCatalog` 的 `sourceKey`（如 `spark.feed` / `spark.comments` / `spark.replies`），走预设体系；`promptCallRegistry` 拆成 3 条 site | 需同步 PresetApp 的 sourceKey 文案与抓取视图；快照文件 `snapshotBuiltinPrompts.ts` 要重生成 |
| `safeParseJSON`（`:90-119`） | 组件内私有，只接受数组 | 抽 `utils/jsonArrayParse.ts` 纯函数 + 单测（围栏/截断/嵌套对象/尾逗号） | 行为必须逐字兼容，否则存量解析路径变化 |
| 三个裸 `fetch`（`:626`/`:786`/`:887`） | 无超时、无重试、无 `max_tokens` 兜底 | 收口到 `safeFetchJson(..., timeoutMs, 0)`（计费红线：chat/completions 不自动重试），并给 `choices[0]` 加保护 | 需确认全局流式升级仍生效（拦截器按 URL 判断，收口后不变） |
| 豆瓣 + LLM 混在同一次 `handleRefresh`（`:500-715`） | 一个函数 200 行，两个数据源、两套错误处理 | 拆 `refreshDouban()` / `refreshGenerated()`，由调用方组合；豆瓣结果与热点标题作为入参 | 需保持「豆瓣先展示、LLM 失败不影响已混入内容」的现有时序 |
| `socialProfile.name` 的后置过滤 | trim + 全等 | 归一化比较（大小写/全半角/零宽）+ 同前缀判定，与提示词「近似」对齐 | 可能误杀合法昵称，需要可配置阈值 |
| AI 帖 id 生成（`:668`） | `Date.now()+Math.random()` | 内容指纹去重（同作者+标题+正文 hash）或 `crypto.randomUUID()` | 指纹去重会改变「同内容不同帖」的现有观感 |
| 封面配额（`:687`） | 超 2 张静默丢弃 | 显式提示/记 devDebug，或按角色去重只留最像「晒图」的一条 | 纯体验改动，低风险 |
| 路人头像（`:648`/`:662`） | dicebear 直连 + 随机 seed | 本地确定性生成（首字母 + 本地调色板）或稳定 seed（仅昵称） | 会改变现有观感；稳定 seed 至少能恢复 HTTP 缓存 |
| 我的页统计（`:1531-1533`） | 硬编码 | 接真实计数（本人帖子数 / 被赞数 / 收藏数）或整体移除 | 低风险，注意空态 |
| 删帖入口（`:1146`） | hover-only | 详情页内提供常驻「删除」入口（长按/菜单） | 需保留豆瓣 hidden 语义 |
| `images[]` 令牌化（`utils/storageOptimize.ts:686-700`） | 注释称读端不认 | 读端已认 `images[0]`；补 `images[1..]` 渲染面（或明确只保留 1 张）后放开转换 | 先确认没有别处按 emoji 语义读 `images[1..]`（当前全仓无渲染点） |

### C. 明确不碰（边界外）

- `apps/CheckPhone.tsx` 的「朋友圈」生成（`:940-942`、`:2855`）：不同数据源、不同存储，Spark 不应接管。
- `apps/MomentsApp.tsx` 的 mastodon 同步与朋友圈手发帖：2026-09-23 决策要求两条线互不影响（`docs/superpowers/specs/2026-09-23-mastodon-moments-design.md:18-25`）。
- `worker/amsg`、主动消息、instant-push：Spark 目前**没有任何云端/后台生成路径**，不要为了「页面关着也能长帖子」把这条链路塞进 Spark（会打破「零额外云端调用」的现状）。
- `utils/blobGc.ts` 的整行枚举策略与 `blobDedupe` 的不可合并清单：改它波及全仓图片生命周期。
- 番茄钟手绘风、动森横切主题：与 Spark 无关，不得借用。

---

## 10. 风险清单（可直接转 issue）

1. **[成本可见性]** 首图触发的「外貌提取」LLM 不在 Spark 的 3 个调用点里，`__sullyMeta` 也只带 `appId:'social'`（`utils/imageGenFlow.ts:123-135` 未挂 meta，只能靠环境上下文归因）。统计面板会把它算进 Spark，但排查「Spark 为什么多了一次调用」时在 `apps/SocialApp.tsx` 里找不到源头。
2. **[数据增长]** `social_posts` 无上限 + 全量 `getAll` + 全量进备份。移动端 IndexedDB 与备份包体积会随时间线性上涨，且 `handleOpenPost` 依赖 `feedRef` 全量在内存。
3. **[恢复完整性]** 豆瓣小组与 hidden 列表不进备份；恢复后用户的自定义小组丢失、删过的豆瓣帖复现。
4. **[双写冲突]** `spark_char_handles` 由 Spark 与 MomentsApp 各自「整体写回」，两个 App 先后打开编辑会互相覆盖。
5. **[注入面]** 豆瓣标题/正文/评论未经分隔直接拼进 prompt（`:515`、`:597-600`、`:761-767`）；`post.content` 也是外部文本。虽然输出只用于展示，但可诱导模型产出冒充用户/角色的内容（现有防护只有后置全等过滤）。
6. **[提示词漂移]** `apps/SocialApp.tsx` 与 `apps/MomentsApp.tsx` 的评论/回复 prompt 近乎逐字重复（`apps/MomentsApp.tsx:493-516` vs `apps/SocialApp.tsx:760-785`），任何一处修 bug 都要手工同步两遍。
7. **[失败不可见]** 三个 fetch 无超时；provider 挂起时「正在获取新鲜事…」一直转（只有卸载/清空能 abort），用户没有「取消」按钮。
8. **[契约测试缺口]** `worker/corsContract.test.ts` 未含 `/social`，CORS 预检回归不会被这条护栏抓到。
9. **[UI 诚实性]** 假统计数字与死分享按钮会被当成功能缺陷上报。

---

## 11. 证据索引（file:line 速查）

- 组件与状态：`apps/SocialApp.tsx:164-224`（state/refs）、`:226-237`（卸载 abort）、`:239-325`（载入 + 马甲持久化）
- 刷新：`:497-498`（豆瓣配额）、`:500-527`（豆瓣段 + 缺 Key 早退）、`:530-570`（角色上下文/AIRP）、`:574-580`（生图门）、`:582-625`（prompt）、`:626-637`（请求/解析）、`:639-691`（映射/降级/封面作业）、`:692-702`（AIRP 锚点）、`:703-714`（落库/fire-and-forget/错误）
- 评论/回复：`:717-839`、`:841-941`；单飞与跳过：`:720-724`、`:843`
- 分享/发帖/删/赞/清空：`:943-950`、`:952-977`、`:979-984`、`:985-992`、`:1062-1079`
- 豆瓣详情：`:1017-1027`、`:1029-1053`
- 渲染：`:1086-1116`（封面分支）、`:1119-1148`（卡片）、`:1154-1253`（详情）、`:1420-1457`（发现页）、`:1459-1566`（我的）、`:1569-1578`（底栏）
- 豆瓣源：`utils/doubanSource.ts:23-35`、`:37-71`、`:74-92`、`:97-124`、`:129-169`、`:172-229`、`:233-286`
- 合并/过滤：`utils/socialFeedMerge.ts:8-43`、`utils/momentsFeed.ts:36-40`
- 投影：`utils/airp/projection.ts:121-134`
- 存储/备份：`utils/db.ts:63`、`:307`、`:1058-1086`、`:3463-3469`、`:3524`、`:3949-3952`；`utils/backupCoverage.ts:45`；`context/OSContext.tsx:4002-4006`、`:4018`、`:4100-4106`、`:4636`、`:5291-5296`
- GC/优化：`utils/blobGc.ts:31-90`；`utils/storageOptimize.ts:74`、`:686-700`
- 后端：`worker/index.js:16-18`、`:2951-2967`、`:3008-3060`、`:3062-3100`、`:4306-4330`
- 生图：`utils/imageGenFlow.ts:111-176`、`:234-257`、`:274-312`；`utils/latentImageGen.ts:120-186`、`:240-245`；`utils/imageGenTags.ts:50-74`
- 配置/注册：`apps/Settings.tsx:673-674`、`:1402`；`constants.tsx:112`/`:145`；`components/PhoneShell.tsx:33`/`:85`/`:881`；`components/os/appPreload.ts:44`；`utils/promptCallRegistry.ts:60`
- 聊天侧：`utils/chatPrompts.ts:1580-1610`；`components/chat/MessageItem.tsx:3080`
- 风格契约：`docs/design-system.md:60-71`（无 Spark 条目）、`index.html:48`/`:62`/`:327-330`
- 文档：`notes/ethernet-branch-context.md`（Spark 豆瓣条）、`notes/ethernet-features.md:49`/`:52`/`:136`、`docs/superpowers/specs/2026-09-23-mastodon-moments-design.md:18-25`
