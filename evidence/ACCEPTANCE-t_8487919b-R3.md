# t_8487919b · 第 3 轮（修复后部署态复验：分享 → 卡片 → 本轮摘录 → 角色上下文）

时间：2026-10-27 11:08–11:22（本地 CST）｜模型路由：deepseek-v4.1-flash / opencode-go（未改）
客户端：真实浏览器打开 `https://link.ethernet.bot.cd`（线上入口，加载主包 `assets/index-ACSmMZhw.js`），
角色 `preset-sully-v2`（应用自建库里的真实角色），
`os_social_share_config={enabled:true, baseUrl:https://link.ethernet.bot.cd}` + 既有 `AMSG_CLIENT_TOKEN`
（只写入浏览器 `localStorage`，全程未打印）。

本轮只做复验取证，**未改任何仓库代码、未重新构建、未重新部署**；部署态仍是上一轮的 `5719b238` 构建。

## 1. 部署态基线（本轮重读，不是引用）

| 项 | 实测 |
|---|---|
| 线上主包 | `assets/index-ACSmMZhw.js`，sha256 `8c537e774b95c030734474219bf73ed5e8a29d56860e355f3d8af7908e6bd060` |
| 三方一致（主包） | 线上下载 / `/opt/sullyos/frontend-dist/` / `/opt/sullyos/sullyos-repo/dist/` 同值 |
| 承载修复的懒加载分片 | `assets/memory-palace-DQsYOpLg.js`，sha256 `669807ab4bab694b447735d33a63a593b2bd89816d0672b71dd6a8c0ebce36d7`（线上 / frontend-dist / repo dist 同值），内含 `read_share_excerpts 记录` 投影串 1 处 |
| VPS 仓库 | `/opt/sullyos/sullyos-repo` HEAD `5719b238`，工作树 clean；`sullyos.service` = active |
| main-agent:8830 `/health` | `shareLinks{configured:true,enabled:true}`、`llmConfigured:true`、`providers:1` |
| social-content:8842 `/health` | `feature.enabled:true`、三源 configured、`persistence:available`、`transport:node_pinned` |
| Spark 退役 | 线上主包 `SparkApp` 命中 0 次 |
| 新自主生活接线 | VPS 主干存在 `utils/autonomyLife/`、`worker/amsg/src/autonomyLife/`（运行期端到端未另测） |

## 2. ① 分享链接 → 卡片（真实 UI + 生产接口）

真实 UI 发送：`帮我看看这个视频讲了什么 https://www.bilibili.com/video/BV1U3n46GEzY`。

- 网络：`POST /agent/v1/social/shares/resolve` → **202**（线上 origin，既有 `X-Client-Token`）。
- UI：卡片渲染「B站 / shr_573be392 / 已读取 /《绝区零》先导演示丨挽昼 / @绝区零 / 简介…」。
- 库内 `IndexedDB AetherOS_Data/messages`，`id=1`：`charId=preset-sully-v2`、`role=user`、
  `metadata.shares.attachments[0]` = `shareRef=shr_573be392fe71cb2dd98cb38bc199e60a`、`state=ready`、
  `contentId=bilibili:bilibili-public:BV1U3n46GEzY`、`characterId=preset-sully-v2`、`conversationId=preset-sully-v2`、
  `messageId="1"`、`contextProjection.contentRevision=1`。
- **模型上下文投影**（本轮第一跳请求体，`/chat/completions` messages 里的 user 项）：
  `[分享 shr_573be392fe71cb2dd98cb38bc199e60a] 哔哩哔哩 · 已读取 / 标题 / 作者 / 简介`，
  并包在 `<<<EXTERNAL_CONTENT share=shr_573be392>>>` 低信任块里；**原始长链接已不在历史中**。
  该轮 `tools=["read_share_excerpts"]`、`tool_choice="auto"`（分享卡在场才注入）。

## 3. ② 本轮摘录：成对落库 + 刷新后仍在

- 工具回合 `read_share_excerpts({shareRef:shr_573be392…, fields:["text"]})`：
  `POST /agent/v1/social/items/bilibili%3Abilibili-public%3ABV1U3n46GEzY/excerpts` → **200**。
- 结果文本（库内 `metadata.shareExcerpts.pairs[0].result.text`）：
  `[read_share_excerpts · OK] shr_573be392… · contentRevision=1 · 字段=text · 段数=2 · 预算剩余≈759t`
  + 2 段真实字幕/简介 + `<<<END_EXTERNAL_CONTENT>>>`。
- `pairs[0].call = {toolCallId:"call_e2e_share_1", name:"read_share_excerpts", args:{shareRef, fields:["text"]}}`，
  `result.ok=true / code=OK / chargedTokens=335`，挂在**触发消息 `id=1`** 上（不是助手消息）。
- **整页刷新后重读 IndexedDB：`id=1` 的 pair 仍在**（`call_e2e_share_1 / ok=true / OK / 335`），
  走的是 `DB.updateMessageMetadataCommitted`（transaction.oncomplete）这条生产写入路径。

## 4. ③ 下一轮请求体里确实带上了该片段（本轮补上的最后一跳）

刷新后同一角色、同一会话再发一条 `那这个视频大概讲了什么` 并手动触发 AI，抓到的 `POST /chat/completions` 请求体
（5 条消息，roles = `system,user,assistant,user,system`）里，命中 **1 处**：

```
[read_share_excerpts 记录 · 1 次调用]
- read_share_excerpts({"shareRef":"shr_573be392fe71cb2dd98cb38bc199e60a","fields":["text"]}) #call_e2e_share_1 → OK · ≈335t
<<<EXTERNAL_CONTENT share=shr_573be392>>>
1. text：挽昼将在《绝区零》3.4版本作为全新虚狩、首位结使代理人正式登场。另外，《绝区零》×《崩坏：星穹铁道》联动也将开启，敬请期待！
2. text：—— 欢迎来到罗斯凯利法！——
<<<END_EXTERNAL_CONTENT>>>
（这是此前真实读到的片段；它们只覆盖当时请求的部分，不代表完整内容）
```

即：上一轮的 call/result 成对投影进了下一轮的角色上下文，片段正文与来源标注都在，且仍按低信任块包裹。
这是上一轮（`index-CghJn7VO.js`）失败、`5719b238` 修复、本次在部署态实测通过的那一跳。

## 5. 触发方式（按要求写明，不拿单测当通过）

模型自发调用**未在本轮发生**：为了避免动 owner 的 LLM Key 与计费，本轮在页面内拦截了
`window.fetch` 的 `/chat/completions` 响应，只把**模型的返回**换成合成的
`tool_calls(read_share_excerpts, shareRef=<从该请求体里 [分享 shr_…] 抄来的完整引用>, fields:["text"])`，
第二次请求再换成一句纯文本回复。`shareRef` 取自真实请求体，不是硬编码。

除这一处替换外，全链路都是部署前端真实代码 + 线上真实服务：
分享解析（`/social/shares/resolve` 202）、工具注入判定（分享卡在场 + 开关 + 锚点 id）、
`dispatchShareExcerptToolCall`、`/social/items/…/excerpts` 200、成对落库（`updateMessageMetadataCommitted`）、
下一轮拼包（`chatPrompts.buildMessageHistory` → `normalizeMessageContent`）。
所以「模型是否会自己决定调这个工具」仍是**未测**项，标记在 §6。

## 6. 未测项（不编造通过）

1. 真实模型自发调用 `read_share_excerpts`（本轮为网络层强制触发，见 §5）。
2. 收费生成路径（图像/语音等计费功能）。
3. 小红书 / 抖音登录态风控（本轮只用 `sourceId=public` 的 B 站链接）。
4. 真实推送送达（Web Push 到端）。

## 7. 结论

卡内三跳在**部署态**全部取得真实证据：①分享链接→卡片进 metadata（带真实 `characterId`）；
②`read_share_excerpts` 成对记录写进消息 metadata 且刷新后仍在；
③下一轮请求体的角色上下文确实含该片段（含来源标注与成对 call 记录）。

## 8. owner 决策项：X-Client-Token 明文回显（补记明确落点）

- 明文落点（只写路径与位置，不写值）：`D:\hermes\profiles\ds-executor\state.db`，
  表 `messages` 的 `content` 列 1 行命中 token 明文（`messages_fts` 全文索引同样命中）。
  来源是第 1 轮一次浏览器 `Runtime.evaluate` 超时的工具报错把请求头连同值一起写进了会话记录。
- 轮换涉及面（若 owner 决定轮换 `/opt/sullyos/.env` 的 `AMSG_CLIENT_TOKEN`）：
  VPS 上 main-agent / instant-push / amsg 等本机服务共用该 token 校验；
  每台已配置客户端的浏览器 `localStorage`（`os_api_config.agentToken` / `os_social_share_config.token`）都要同步更新，
  否则这些客户端会 403（本卡严禁把 403 当服务故障）。
- 本卡未轮换、未改任何密钥、未删除该会话记录（属 owner 数据，留待决定）。
