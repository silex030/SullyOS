# 集成发布与端到端验收 · t_8487919b

执行时间：2026-10-26 23:34–00:30（北京时间）
执行代理：ds-executor（deepseek-v4.1-flash / opencode-go，卡内指定）

## 1. 合入与主干

| 项 | 结果 | 证据 |
|---|---|---|
| ethernet 主干（VPS `/opt/sullyos/sullyos-repo`） | `8a80f0e5`（双父合并：`0da402ac` + `29ca92bc`），工作树 clean | `git log -1 --pretty="%H %P" 8a80f0e5` |
| GitHub 主干 `silex030/SullyOS` `ethernet` | 推送前 `8e597e1b` → 推送后 `8a80f0e5` | `git push origin ethernet:ethernet`（`8e597e1b..8a80f0e5`），`git ls-remote` 读回 |
| 合并改动面 | 17 文件 +3240/−184，集中在 `utils/`、`hooks/`、`docs/`、`evidence/` | `git diff --stat 0da402ac 8a80f0e5` |

推送由 VPS 侧 `git@github-sullyos` 密钥完成；本地 worktree 的 `origin` 指向 VPS SSH 仓库，不是 GitHub，因此 GitHub 侧的读回在 VPS 上执行。

## 2. 测试与静态检查

| 项 | 结果 |
|---|---|
| 合并后全量 vitest（只跑一次） | `663` 文件：`660 passed / 2 failed(timeout) / 1 skipped`；`8121` 用例：`8118 passed / 2 failed / 1 skipped`（`vitest-full.log`） |
| 两个失败项复跑 | `storageOptimize` + `chatPrompts.apprules` → `2 passed / 89 passed`，`EXIT=0`。失败时长为并行满载下的 `5000ms`/`60000ms` 超时，非断言失败（`vitest-retry3.log`） |
| tsc 基线 | `56` 个 `error TS`（与既有基线一致），改动文件 0 错误（`tsc.log`） |
| worker 产物一致 | `pnpm run check:workers` → `✓ worker bundle 与源码一致` |
| 工作树 | clean |

## 3. 发布与三方 SHA256

- 构建在 VPS 完成，发布经 `/root/publish-dist.sh` 闸门；备份保留 `/opt/sullyos/frontend-dist.bak-20261026-205055`（另有 10-25 两份）。
- 线上入口 `https://link.ethernet.bot.cd/`（`SULLYOS_DOMAIN=ethernet-vps.bot.cd` 会 302 到该站）。
- 主包 `assets/index-CghJn7VO.js` 三方 SHA256 一致：`59a4d5ed0027973c72a0a0d157709afa4613b4b51adae52e608bd20a08e827a8`
  - 线上下载 / `dist/`（VPS 构建目录）/ `/opt/sullyos/frontend-dist/assets/`
- 返工版特征串落在懒加载分片 `memory-palace-syVOXkBc.js`（`HISTORY_UNAVAILABLE`、`这一轮没有可确定的持久化位置`、`SHARE_REF_AMBIGUOUS`），说明线上确为 `8a80f0e5` 的构建，不是旧版主包。
- `sullyos.service` 状态 `active`，重启后读回健康。

## 4. 开关与两端健康（重启后读回）

- `main-agent`（127.0.0.1:8830）`/health`：`shareLinks: {configured: true, enabled: true}`，`llmConfigured: true`，`mcpServers` 4 个。
- `social-content`（127.0.0.1:8842）`/health`：`feature.enabled: true`，`maxLinksPerMessage: 5`，`resolveDeadlineMs: 20000`，`cacheAllowed: true`，`sources: bilibili/xiaohongshu/douyin = configured`，`transport: node_pinned`，`persistence: available`。
- 配置来源为既有 `/opt/sullyos/.env`：`SHARE_LINKS_ENABLED=true`、`SOCIAL_CONTENT_URL`、`SOCIAL_SERVICE_TOKEN`（既有值，未新建、未采购）。未改全局审批策略、未启动消息网关。

## 5. 端到端（真实已授权客户端）

真实内容：`https://www.bilibili.com/video/BV1U3n46GEzY`（B站排行榜实时条目，非构造链接）。

### 5.1 部署前端 · 浏览器内（originating `https://link.ethernet.bot.cd`）

用已授权的 `X-Client-Token` 在页面内直接走前端同款请求（`shareRequest` 的 URL/头/体一致）：

| 步骤 | 结果 |
|---|---|
| `POST /agent/v1/social/shares/resolve` | `202`，`state=ready`，`shareRef=shr_b605c9056cd2c022b7ba86a3bbbbb7cd`，`contentId=bilibili:bilibili-public:BV1U3n46GEzY`，`preview.title=《绝区零》先导演示丨挽昼`，`occurrenceSpans=1`，`contextProjection.contentRevision=1`，`summaryText` 103 字符 |
| `POST /agent/v1/social/items/<contentId>/excerpts` | `200`，`segments=2`，`tokenEstimate=78`，首段正文可读 |

同路径服务端复核也通过（`202` → `ready`；`excerpts` `200`），并用错误版本号验证 `409 VERSION_UNAVAILABLE` 的负向分支。

### 5.2 未测项（明确标注，不是通过）

- **聊天 UI 里的模型工具回合（模型自主调 `read_share_excerpts` → 片段成对写回消息 metadata → 下一轮注入角色上下文）本轮未在部署前端实跑。** 原因：该流程需要一个带角色的真实对话回合，本轮窗口内只完成到「授权客户端 → 生产 API → 卡片 + 摘录」这一段；机制侧由父卡定向用例覆盖（`utils/socialShareTool*.test.ts` 113 例，含无锚点拒绝、成对落库、跨轮隔离）。
- 收费生成与第三方账号登录态风控路径（小红书/抖音需登录态、B站部分内容 412）未测；本次只用公开只读来源 `sourceId=public`。
- 真实推送送达未测（沿用既有结论）。

## 6. 需求对齐

| 项 | 结论 |
|---|---|
| 三方 SHA256 | 通过（见 §3） |
| GitHub 主干 | 通过：`ethernet` 已从 `8e597e1b` 推进到 `8a80f0e5` |
| 页面入口 | 通过：线上入口可打开，桌面/应用列表加载，主包为本次构建 |
| Spark 退役 | 通过：`apps/Spark*.tsx` 不存在，线上主包 `SparkApp` 命中 0 次 |
| 新自主生活接线 | 通过（合入侧）：`utils/autonomyLife`、`worker/amsg/src/autonomyLife/*` 在主干与 worker 产物中；运行期端到端未另测 |
| 链接分享启用 | 通过：两端开关为 true 且实际解析/摘录成功 |

## 7. 风险与观察

1. **凭据意外回显（需处置）**：一次 `Runtime.evaluate` 超时的工具报错把 `X-Client-Token` 明文带进了执行日志。后续调用改为从页面 `localStorage` 读取，未再出现明文。该 token 是自部署实例的共享客户端令牌（浏览器侧本来就需要持有），未用于采购或第三方账号；是否轮换由 owner 决定——轮换需要同步改所有已配置客户端。
2. 两个全量测试超时项只在满载时复现，单独跑 89 例全过；属环境抖动，不是本次改动引入的断言失败。
3. `outbox`/`written` 集合是进程内内存，重启丢失未落库记录（父卡已接受）。
4. `externalBlockOpen()` 的低信任块边界标签仍用 12 字符短 `shareRef`；解析按「唯一前缀 / 歧义拒绝」兜底，不串卡（父卡已记录，未改）。
5. VPS `~/.ssh/known_hosts` 之前追加过 github.com 主机密钥（父卡声明）；本次未再改，VPS 侧使用既有 `git@github-sullyos` 别名推送。

## 8. 证据文件

- `/d/hermes/tmp/sshcfg/vitest-full.log`、`vitest-retry3.log`、`tsc.log`
- 本文件：`evidence/ACCEPTANCE-t_8487919b.md`
