# Spark（社交 App）退役记录 · 2026-10-24

任务：`t_995b91f3`「移除 Spark 软件及其专属入口和残留配置」。
前置依据：只读盘点报告 `docs/social-content/audit-spark.md`（2026-10-23，HEAD `30df593c`）。
本文件是本轮**变更清单 + 迁移说明 + 验证证据**，供独立审查（`arch-reviewer`）核对。

- 实现分支：`spark-removal/t_995b91f3`（基于 `f7f040c7`，即 `origin/ethernet` HEAD）
- 工作树：`/root/SullyOS-spark-removal`（**未**直接改主检出 `/root/SullyOS`，避免与并行线互相覆盖）
- 未推送远端、未合并 `ethernet`、未部署（合并与部署由整合卡 `t_33546864` 决定）

---

## 0. 一句话结论

Spark（`AppID.Social`，UI 名「Spark」，实现 `apps/SocialApp.tsx`）在**代码层整块删除**：App 实现、注册表/桌面/动效主题图标/Dock/懒加载/预加载/安全区/render 分支、豆瓣内容源与其 worker 代理、AIRP 的「投到推荐流」投影、提示词调用地图条目全部下线；**共享数据与历史消息保持可读**（`social_posts` 表、`SocialPost` 类型、`spark_char_handles` 马甲表、历史 `social_card` 消息、备份字段）。设备上 Spark 独占的 3 个 localStorage 键由启动期一次性迁移精确清理，IndexedDB 里的用户数据不做破坏性删除。

---

## 1. 删除清单（文件级）

| 文件 | 行数 | 为什么删 |
|---|---|---|
| `apps/SocialApp.tsx` | 1586 | Spark 全部 UI + 三段 LLM 生成 + 豆瓣混排 + 首图作业 |
| `utils/doubanSource.ts` | 286 | 只有 Spark 用的豆瓣小组数据源（归一化/小组管理/隐藏 id/图片代理） |
| `utils/doubanSource.test.ts` | 200 | 上者的单测 |
| `utils/socialAppBlobRefs.test.ts` | 47 | 对 `apps/SocialApp.tsx` 的源码锚测试，随实现一起失效 |
| `worker/doubanProxy.test.ts` | 160 | 已删的 `/social/douban/*` + `/social/img` 契约测试 |

被删代码总计 **2279 行**（含 4 个 Spark 专属测试文件）。

## 2. 编辑清单（按层）

**注册与入口**
- `types.ts`：删 `AppID.Social`；`SocialPost.origin` 注释改为「`douban` 起不再新增，仅历史数据」。
- `constants.tsx`：删 `INSTALLED_APPS` 的 `{ id: AppID.Social, name: 'Spark' }`；删 `Icons.Social` 与其唯一使用者 `Fire` 图标导入（避免未用导入）；`DOCK_APPS` 去掉 `AppID.Social`。
- `components/PhoneShell.tsx`：删 lazy import、`APP_IDLE_PRELOAD_ORDER`、`APP_BY_ID` 映射、`renderApp` 的 `case AppID.Social`。
- `components/os/appPreload.ts`：删 `importers[AppID.Social]`。
- `utils/safeAreaApps.ts`（+`utils/safeAreaApps.test.ts`）：从自理安全区名单与断言列表移除 `AppID.Social`（该测试双向一致断言会强制两处同步）。
- `components/os/acnhIcons.tsx`：删动森风 `AppID.Social` 图标。
- `components/os/MobileGameHome.tsx`：底部 Dock 原「动态 = Spark」改为「朋友圈 = `AppID.Moments`」（保留 4 格 Dock 的视觉平衡，不新增别的入口）。

**内容与投影**
- `worker/index.js`：删 `/social/douban/topics|topic|comments`、`/social/img` 整段与模块级 `doubanListCache`（163 行）；`node --check` 通过。
- `utils/proxyWorker.ts`：能力清单注释去掉豆瓣条目。
- `utils/airp/projection.ts`（+`projection.test.ts`）：删 `selectMomentsMaterial` 与 `MOMENTS_MATERIAL_LIMIT`（唯一调用方是 Spark）及其 11 个用例；`airp_events` 账本与其它投影函数（`selectCheckPhoneMaterial` 等）原样保留。
- `utils/momentsFeed.ts`（+测试）：删 `visibleInSpark`（Spark 专用）；`visibleInMoments` 不动，测试改为断言「`douban`/`gen` 旧来源不进朋友圈」。
- `utils/promptCallRegistry.ts`：删 `social-feed` 站点（锚指向已删文件，`promptCallRegistry.test.ts` 会读文件校验）。

**文案与注释（行为不变）**
- `components/chat/MessageItem.tsx`：历史 `social_card` 卡片底部标签由「Spark • 笔记分享」改为「笔记分享」（渲染逻辑保留）。
- `utils/chatPrompts.ts`：历史 `social_card` 注入文案里的「Spark 笔记 / 在 Spark 上的马甲」改为「笔记 / 动态里的马甲」；马甲表读取逻辑不变。
- `utils/imageGenFlow.ts`：三处注释里的「Spark 首图」改为场景描述（`generateImageBlobOnly` 本身仍被朋友圈使用，函数不删）。

**旧配置迁移（新增）**
- `utils/retiredSpark.ts` + `utils/retiredSpark.test.ts`（新文件，6 个用例）：启动期一次性删掉 Spark 独占的 `spark_douban_groups` / `spark_douban_hidden` / `spark_user_id`（**精确键名**，不做前缀通配、绝不 `clear()`）；存储不可用时不抛、不阻断启动；幂等。
- `context/OSContext.tsx`：在既有退役清理链（`retireExternalAgentStorage` 之后、内置提示词播种之前）挂上 `retireSparkStorage()`；`socialAppData` 导出块补注释说明「为什么这堆 Spark 字段还留着」。

**文档**
- `notes/ethernet-features.md`：删/改 4 处 Spark 描述（生图、图片工作室、豆瓣数据源），并在「十六、减法项」新增 Spark 退役条目（含保留项与「不要加回来」）。
- `notes/ethernet-branch-context.md`：原「Spark 混入豆瓣」条目改写为「已整块退役」。
- `docs/social-content/audit-spark.md`：顶部加「历史文档，路径已不存在」横幅（留档不改正文）。
- `docs/social-content/design.md`：「复用 doubanSource」一行加注「实现已随 Spark 删除，若做该方案需另建适配器」。
- 本文件 `notes/spark-removal-2026-10-24.md`。

## 3. 刻意保留（审查时请当作「不是漏删」）

| 保留项 | 位置 | 理由 |
|---|---|---|
| `social_posts` store / `SocialPost` / `SocialComment` | `utils/db.ts`、`types.ts` | **朋友圈 MomentsApp 写同一张表**；且已落库 + 已进备份，改形状要写迁移 |
| `spark_char_handles`（角色马甲表） | `apps/MomentsApp.tsx`、`utils/chatPrompts.ts` | Spark 与 Moments 双写共享键；Moments 仍在用。**启动清理刻意不清它**（有测试锁死） |
| 历史 `social_card` 消息渲染 + 提示词分支 | `components/chat/MessageItem.tsx`、`utils/chatPrompts.ts` | 用户聊天记录里已存在这类消息，删渲染会让旧消息白屏/不可读 |
| `socialAppData` 备份字段（`charHandles` / `userProfile` / `userId` / `userBg`） | `context/OSContext.tsx`、`types.ts` | 老备份还原与「资料/背景图不因减法从备份里消失」；删字段等于让 `spark_social_profile` / `spark_user_bg` 两个 assets 行再也导不出去 |
| `isRedundantManagedAssetId` 的 `spark_social_profile` / `spark_user_bg` | `context/OSContext.tsx` | 同上，与 `socialAppData` 的托管方式配套 |
| `storageOptimize` / `blobGc` 对 `social_posts`、`spark_*` 的处理 | `utils/storageOptimize.ts`、`utils/blobGc.ts` | 处理的是**存量数据**（令牌化/GC 引用面），删了会让老图变孤儿 |
| `utils/socialFeedMerge.ts` | —— | 朋友圈在用（`mergeSocialComments` / `prependUniqueSocialPosts` / `updateSocialPost`） |
| `generateImageBlobOnly` / `queueLatentGeneration` | `utils/imageGenFlow.ts`、`utils/latentImageGen.ts` | 朋友圈封面等仍在用，只改注释 |

## 4. 持久数据与迁移

**本地设备（升级后的第一次启动）**
- 删：`spark_douban_groups`（小组清单）、`spark_douban_hidden`（已删豆瓣帖 id，≤500）、`spark_user_id`（Spark 内展示用 id）。三者都不在任何备份字段之外被读取，删掉不影响其它 App。
- 不动：`spark_char_handles`、IndexedDB `social_posts` 行（含 `origin:'gen'|'douban'` 的旧帖）、`assets` 里的 `spark_social_profile` / `spark_user_bg`。**没有做任何 `DB.clearSocialPosts()` 之类的破坏性删除**。

**旧备份包（导入）**
- `socialAppData` 字段继续按原样恢复（`charHandles` 回写 localStorage，`userProfile`/`userBg` 回写 assets）；未知/多余字段不报错。
- 老备份里的 `userId` 回写后，下次启动会被 `retireSparkStorage()` 再清一次——幂等，无副作用。

**可见性**
- 旧帖来源 `origin:'gen'|'douban'` 已无任何界面展示（Spark 是唯一入口，朋友圈只认 `mastodon` / `moments`），但**数据保留**：万一以后要做「历史帖查看」或数据导出，行还在。
- 旧启动器布局里残留的 `'social'` id 由 `normalizeDockOrder` / `normalizeAppOrder` 按「可用 id 集合」过滤掉，不会出现点不开的图标（`AppID` 枚举已删，字符串残留只被当未知 id）。

## 5. 部署 / 回滚

- 前端：重建即可生效（`pnpm build`），无需数据迁移脚本。
- 后端：`worker/index.js` 的 `/social/*` 是**先在源码里删、部署后才消失**。未部署前旧路由仍可访问（纯只读公开接口，无鉴权面无数据写入），不影响新前端；部署后旧缓存包调用会拿到 404，Spark 本来就会静默降级，不会出现初始化报错。
- 回滚：`git revert` 本次提交即可；因为没删任何用户数据、没写迁移标记，回滚后旧 Spark 代码能看到原有帖子/马甲表（小组清单与 hidden 列表已被清，属可接受损失，且这两个键从未进备份）。

## 6. 验证证据

见第 7 节「执行记录」（命令 + 真实输出摘要）。

## 7. 执行记录（本轮实测）

（下节由执行者按实际命令输出填写）
