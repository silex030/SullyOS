# t_8487919b · 第 2 轮（部署态实跑 + 发现的缺口 + 修复）

时间：2026-10-27 00:27–01:20（本地 CST）｜模型路由：deepseek-v4.1-flash / opencode-go（未改）
客户端：真实浏览器打开 https://link.ethernet.bot.cd （部署前端），角色 `preset-sully-v2`（应用自建库里的真实角色），
`os_social_share_config={enabled:true,baseUrl:https://link.ethernet.bot.cd}` + 既有 `AMSG_CLIENT_TOKEN`（只写入浏览器 localStorage，未打印）。

## 1. 已完成：分享链接 → 卡片（①）

真实 UI 发送 `帮我看看这个视频讲了什么 https://www.bilibili.com/video/BV1U3n46GEzY`。

- 网络：`POST /agent/v1/social/shares/resolve` → **202**，附件
  `shareRef=shr_573be392fe71cb2dd98cb38bc199e60a`、`contentId=bilibili:bilibili-public:BV1U3n46GEzY`、
  `state=ready`、`contextProjection.contentRevision=1`、`characterId=preset-sully-v2`、`messageId="1"`。
- 库内（IndexedDB `AetherOS_Data/messages`）：`id=1, charId=preset-sully-v2, role=user, metadata.shares`，
  `attachments[0].shareRef` 为完整 32-hex ref，`state=ready`，`contextProjection.contentRevision=1`。
- UI：卡片渲染出「B站 / shr_573be392 / 已读取 /《绝区零》先导演示丨挽昼 / @绝区零 / 简介…」。

## 2. 已完成：本轮摘录成对落库 + 刷新后仍在（②）

同一会话里，工具回合 `read_share_excerpts({shareRef:shr_573be392…, fields:['text']})`：

- 网络：`POST /agent/v1/social/items/bilibili%3Abilibili-public%3ABV1U3n46GEzY/excerpts` → **200**，
  `segments=2`、`tokenEstimate=78`、`contentRevision=1`、`nextCursor=null`。
- 库内：**触发消息 `id=4`（user）** 的 `metadata.shareExcerpts.pairs[0]` =
  `{call:{toolCallId:"call_e2e_share_2",name:"read_share_excerpts",args:{shareRef,fields:["text"]}}, result:{ok:true,code:"OK",chargedTokens:335,text:"[read_share_excerpts · OK] …段数=2…"}}`。
- 幂等/去重口径同卡内自述（同一 toolCallId 只留一条）。
- **整页刷新后重读 IndexedDB：`id=4` 的 pair 仍在**（`ok=true/code=OK/tokens=335`），走的是
  `DB.updateMessageMetadataCommitted`（transaction.oncomplete）这条生产写入路径。

另有一条负向记录（同样真实写入）：故意用 `maxTokens:120`（低于 `minGrantTokens=320`）调用时，
工具如实返回 `TURN_BUDGET_EXHAUSTED` 并成对落库 `ok:false`，模型侧文案要求「不要声称自己读过原文」——预算门是生效的。

## 3. 发现的缺口：下一轮请求体里没有片段（③ 未通过）

刷新后（同一角色、同一会话、同一部署构建 `index-CghJn7VO.js`）再触发一轮，抓到的 `POST /chat/completions` 请求体（7 条消息）：

- `user` 消息仍是**原始长链接**：`[2026-10-27 00:52] [聊天] 帮我看看这个视频讲了什么 https://www.bilibili.com/video/BV1U3n46GEzY`
  （没有 `[分享 shr_…]`、没有 `Title/简介` 投影）；
- `user#4`（挂着 `metadata.shareExcerpts` 的那条）内容为 `[2026-10-27 00:56] [聊天] 那这个视频大概讲了什么`，
  **没有** `[read_share_excerpts 记录 · 1 次调用]` 段落。

代码定位：私聊主历史由 `utils/chatPrompts.ts` 的 `buildMessageHistory` 生成，文本分支原为
`else content = \`${timeStr} ${sourceTag} ${content}\`;`，直接使用 `m.content`，从未调用
`messageFormat.normalizeMessageContent`（该函数才是 `metadata.shares` / `metadata.shareExcerpts` 的投影实现，
`docs/social-content/integration-v1.md` 描述的「下一轮：normalizeMessageContent → 投影」在私聊主历史这条路上没有接线）。
工具注入侧（`prepareShareExcerptTurn` 读 `contextMsgs.metadata`）是好的，所以出现「模型被给了工具、但历史里既没有 shareRef 也没有上一轮片段」的不对称。

## 4. 修复（已提交并部署，复验未完成）

- 修复：`utils/chatPrompts.ts` 文本兜底分支，消息带 `metadata.shares` 或 `metadata.shareExcerpts` 时改走
  `normalizeMessageContent`；其余消息行为不变。
- 测试：新增 `utils/chatPrompts.shareProjection.test.ts` 3 例（投影出 shareRef+简介且原始链接消失 / 成对片段进下一轮 / 普通消息不受影响）
  → **3 passed**；相邻 `chatPrompts.webpageCard|quote|test` **19 passed**。
- 提交/主干：`5719b238 fix(social): 私聊历史投影分享卡与成对片段（t_8487919b 部署实跑缺口）`，
  已 ff 合入 VPS `/opt/sullyos/sullyos-repo` 的 `ethernet`（HEAD=5719b238）。
- 构建/发布：VPS `pnpm run build` EXIT=0 → `dist/assets/index-ACSmMZhw.js`（sha256 `8c537e774b95c030734474219bf73ed5e8a29d56860e355f3d8af7908e6bd060`）；
  备份 `/opt/sullyos/frontend-dist.bak-20261027-011345`；复制到 `/opt/sullyos/frontend-dist` 后 `systemctl restart sullyos.service` → **active**；
  两端 health 读回：main-agent `shareLinks{configured:true,enabled:true}` / social-content `feature.enabled:true`、三源 configured、persistence available。
- 浏览器侧已确认加载的是新构建 `index-ACSmMZhw.js`。

**未完成**：修复后的部署态复验（再走一次「分享→卡片→片段→下一轮请求体含片段」）没有跑完 ——
在浏览器 harness 重载新构建时 daemon 两次超时，随后 IndexedDB 被重置为空（profile 被新 session 顶掉），
手里已没有可复用的会话数据。因此本卡要求的第 ③ 项**在修复后仍未取得部署态证据**，不能算通过。

## 5. 未测项（不编造通过）

- 模型自发调用 `read_share_excerpts`（本轮是**网络层强制触发**：在 `/chat/completions` 返回里合成一条
  `tool_calls(read_share_excerpts)`，其余全链路——分享解析、工具注入、dispatch、成对落库、下一轮拼包——都是部署前端真实代码）。
  之所以这样触发：`agentUrl` 配置存在时前端会把 chat 请求改写到主代理，主代理对假 baseUrl 返回 500，
  为避免动 owner 的 LLM Key/计费，没有走真实模型。
- 收费生成路径、小红书/抖音登录态风控、真实推送送达。
- 修复后的部署态复验（见 §4 末）。

## 6. owner 决策项：X-Client-Token 明文回显

第 1 轮执行日志里一次浏览器 `Runtime.evaluate` 超时错误把 `X-Client-Token` 明文回显进了执行日志（只写路径，不写值）：

- 该次运行的工具输出日志目录：`D:\hermes\profiles\ds-executor\cache\browser-use\workspace\`（本次为 `103a7226-8424-4a52-9571-0ceee442a70e` 会话目录下的运行输出；Hermes 侧对应 session 日志/kanban run 输出存档）。

轮换涉及面（若 owner 决定轮换 `/opt/sullyos/.env` 的 `AMSG_CLIENT_TOKEN`）：VPS 的 main-agent/instant-push/amsg 等本机服务共用该 token 校验；
每台已配置客户端的浏览器 `localStorage`（`os_api_config.agentToken` / `os_social_share_config.token`）都要同步更新，
否则这些客户端会 403（本卡严禁把 403 当服务故障）。本卡未轮换、未改任何密钥。
