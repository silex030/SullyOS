# CLAUDE.md

给 Claude Code 的项目导航。SullyOS 是装在浏览器里的虚拟手机系统（React + TS + Vite，local-first，IndexedDB 存储）。详细介绍见 [`README.md`](./README.md)。

这份文件只做一件事：**告诉你遇到某类问题该去翻哪份文档**，别在代码里瞎逛。

> 包管理器统一用 **pnpm**：装依赖 `pnpm install`、跑测试 `pnpm vitest run`、跑脚本 `pnpm <script>`。别用 npm / yarn（仓库里是 `pnpm-lock.yaml`）。

## 文档地图

| 主题 | 文档 | 什么时候看 |
|------|------|-----------|
| **ethernet 分支 · 项目背景与约定** | [`notes/ethernet-branch-context.md`](./notes/ethernet-branch-context.md) | **每次开工前先读**：这是二改仓库（原版 qegj567-cloud/SullyOS），ethernet 分支的侧重点、与上游的同步惯例（cherry-pick 等价提交）、以及「新增功能必须保持 ethernet 现有 UI/动效风格」的硬约定。仓库现状与坑也在里面 |
| **ethernet 新功能记录（相对上游）** | [`notes/ethernet-features.md`](./notes/ethernet-features.md) | **每完成一个新功能（或阶段收尾）就补记**：开发者自用的功能账本——ethernet 相对上游新增了什么、各功能用的数据源/外部服务，防止改多了自己也不记得。新功能落地后顺手更新 |
| **设计与动效风格契约** | [`docs/design-system.md`](./docs/design-system.md) | **动任何 UI 前先对照**：玻璃风两套写法、圆角阴影档位、动效时长、分 App 隔离清单、番茄钟例外边界、新功能对照流程。保证风格稳定的唯一入口 |
| **CORS 统一契约 · 前端外部请求入口** | [`docs/superpowers/specs/2026-09-11-cors-unification-design.md`](./docs/superpowers/specs/2026-09-11-cors-unification-design.md) | 改任何 worker / 代理的 CORS 预检、`worker/shared/cors.ts`、`worker/corsContract.test.ts`、`utils/externalRequest.ts`，或给「浏览器→第三方服务」新增调用前必读（执行计划：`docs/superpowers/plans/2026-09-11-cors-unification-plan.md`） |
| **开发调试面板 / 开关** | [`docs/dev-debug.md`](./docs/dev-debug.md) | 加 dev-only 开关、加调试日志、排查"角色怎么又不说话了"。含逐步指南 |
| **记忆系统** | [`docs/memory-system-overview.md`](./docs/memory-system-overview.md) | 涉及长期记忆、月度总结、向量化记忆宫殿、情感空间。改记忆相关逻辑前必读 |
| **查手机 · 人际关系系统** | [`docs/relationship-system.md`](./docs/relationship-system.md) | 改「查手机」聊天/通讯录、角色联系人/好感、真假甄别、真角色双向对话、虚构 NPC 约束前必读 |
| **见面 · 观测协议 OBSERVE** | [`docs/date-observe.md`](./docs/date-observe.md) | 改见面（DateApp）的角色观测面板：提示词注入、掉格式解析容错（两层）、全息 HUD 渲染前必读 |
| **彼方 · 信号坠落处（跨用户接龙诗）** | [`docs/signal-poetry.md`](./docs/signal-poetry.md) | 改彼方(VRWorld)「信号坠落处」房间：跨实例合写现代诗、复用漂流瓶后端、`po_poems`/`po_poem_lines` 表与 `/poem/*` 端点、两层容错解析、并发安全前必读 |
| **捏人器 PSD 导入 / 部件投影层** | [`docs/char-creator-psd-import.md`](./docs/char-creator-psd-import.md) | 改捏人器素材管线、部件阴影（正片叠底预转）、PSD 图层组约定前必读 |
| **QQ捏人工坊（神经链接手办柜）** | [`docs/chibi-studio.md`](./docs/chibi-studio.md) | 改小小窝/彼方/520 三处 Q 版形象、捏人器 savedState 还原、`chibiStudio` 字段前必读 |
| **角色自定义时区** | [`docs/character-timezone.md`](./docs/character-timezone.md) | **写任何跟时间有关的代码前先扫一眼**：prompt 里的「现在是」、角色作息/夜间判断、日期 key、界面上的钟。分清「角色那边几点」和「用户自己的时间」，别自己手搓时差。文末列了还没接时区的几处（主动消息 + 几块界面上的钟），**正式发版前记得过一遍** |
| **角色自主出行 · 地图服务凭据** | [`docs/travel-map-credentials.md`](./docs/travel-map-credentials.md) | 改设置页「地图服务凭据」、`worker/amsg/src/travel/mapCredentials.ts` / `mapProxy.ts`、`/_AMapService` 反代，或排查「填了 Key 但地图不出图」前必读：加密存储、只回存在性、短期签名代理、Caddy 样板与未验证项 |
| **通用 MCP 工具服务器** | [`docs/mcp-client.md`](./docs/mcp-client.md)（开发者）、[`docs/mcp-user-guide.md`](./docs/mcp-user-guide.md)（用户教程，设置「?」弹窗跳转的就是它，改接入行为要同步） | 改用户自配 MCP 接入（设置板块、握手/session、工具循环、`?target=` 代理约定、worker/mcp-proxy）或排查「工具连不上/角色不调工具」前必读；主动消息 2.0 的后台 MCP 路径（配置上云 / fire 时注入 / worker 直连执行）也在这份 |
| **终端 · 本机 opencode 远程控制台** | [`docs/opencode-terminal.md`](./docs/opencode-terminal.md) | 改桌面「终端」App（会话/文件/遥控三 Tab）、设置连接板块、`utils/opencodeClient.ts`、两条代理（`scripts/opencode-proxy.mjs` / `worker/opencode-proxy/`）或排查「连不上电脑/审批不弹」前必读；与角色聊天零耦合 |
| **主动消息 2.0 · 即时对话** | [`plans/amsg2-instant-chat.md`](./plans/amsg2-instant-chat.md)（设计与取舍）、[`plans/amsg2-instant-chat-contract.md`](./plans/amsg2-instant-chat-contract.md)(端点/信封/fire_pack v7 契约) | 改「聊天在用户自己的 CF Worker 上生成」这条路（`POST /instant-chat`、`utils/amsgInstantChat.ts`、fire_pack 的 `chat` 段、chat_outbox 补收、「正在输入」超时）前必读 |
| **主动消息 2.0 · 后台任务（不说话的活儿）** | [`plans/amsg2-expansion.md`](./plans/amsg2-expansion.md) | 改「页面关着也能跑完」的后台活儿前必读：`metadata.amsgKind` → handler 注册表（`worker/amsg/src/fireKinds.ts`）、一次性输入的 `amsg:job` 命名空间与 TTL、`ctx.emitResult` 的结果回程与客户端分发（`utils/amsgResults.ts`）。文首「现状」是实况，正文是「还有哪些调用点值得搬、哪些不该搬」的取舍 |
| **主动消息 2.0 · API 凭据引用 credRefs** | [`plans/amsg2-llm-credentials-contract.md`](./plans/amsg2-llm-credentials-contract.md) | 改凭据上云（`llm_credentials` 表、任务 `credRefs`、`utils/amsgLlmCredentials.ts` 的每角色三行）或排查「换 Key 后主动消息 401 / 不来了」前必读；文末「SullyOS 侧落地」是实况 |
| **Instant Push SSE↔Push 契约** | [`docs/instant-push-dual-channel.md`](./docs/instant-push-dual-channel.md) | **改 instant push 路径或排查「报错但收到消息」类 bug 前必读**。SSE ≠ 送达判定通道、catch 不能直接判 send-failed |
| **Instant Push 通道** | [`docs/instant-push-branch-notes.md`](./docs/instant-push-branch-notes.md)、[`worker/instant-push/README.md`](./worker/instant-push/README.md) | LLM-driven Web Push、worker 端 agentic loop / reasoning / 副作用 directive |
| **蓝牙外设** | [`docs/bluetooth.md`](./docs/bluetooth.md) | 改设置页蓝牙板块、BLE 引擎、角色蓝牙感知/工具前必读 |
| **自主生活 v1（autonomy-life）** | [`docs/autonomy-life/execution-audit.md`](./docs/autonomy-life/execution-audit.md)（执行边界/证据）、[`docs/autonomy-life/entry-migration.md`](./docs/autonomy-life/entry-migration.md)（入口迁移） | 改 `utils/autonomyLife/`、`worker/amsg/src/autonomyLife/`、执行许可 / 本地核销 / 回执、旧频率退役或受控外部只读前必读 |
| **AIRP 幕后导演（一~五阶段）** | [`docs/superpowers/plans/2026-09-15-airp-runtime-plan.md`](./docs/superpowers/plans/2026-09-15-airp-runtime-plan.md)（执行计划）、[`docs/superpowers/specs/2026-09-15-presence-layer-architecture.md`](./docs/superpowers/specs/2026-09-15-presence-layer-architecture.md)（总图） | 改私聊导演闭环（`utils/airp/`）、事实提交（`airp_events`/`airp_world`）、离线自主生活、现实工具接线、跨 App 投影与 AirpPanel 前必读；截至 2026-09-18 仍在本地、待 push |
| **音乐 · 酷狗双音源** | [`docs/superpowers/specs/2026-09-08-kugou-music-source-design.md`](./docs/superpowers/specs/2026-09-08-kugou-music-source-design.md)（设计）、[`docs/superpowers/plans/2026-09-08-kugou-music-source.md`](./docs/superpowers/plans/2026-09-08-kugou-music-source.md)（执行计划） | 改音乐 App 音源切换（`MusicCfg.source`）、`utils/kugouCore.ts`、酷狗登录面板、`worker` 的 `/kugou/*` 路由或 `KUGOU_UPSTREAMS` 前必读；本地待 push，worker 重部署才生效 |
| **塔罗四波视觉** | [`plans/2026-09-11-tarot-mystic-redesign.md`](./plans/2026-09-11-tarot-mystic-redesign.md)、[`plans/2026-09-12-tarot-aurora-reading-plan.md`](./plans/2026-09-12-tarot-aurora-reading-plan.md)、[`plans/2026-09-12-tarot-depth-parallax-plan.md`](./plans/2026-09-12-tarot-depth-parallax-plan.md)、[`plans/2026-09-12-tarot-sky-constellation-plan.md`](./plans/2026-09-12-tarot-sky-constellation-plan.md) 等 | 改塔罗牌库/解读页星空（极光/星座/WebGL 天空/牌库网格）前必读 |
| **桌面演进（Frameless/半屏/FitPage/动效）** | [`plans/2026-09-11-remove-phone-frame.md`](./plans/2026-09-11-remove-phone-frame.md)、[`plans/2026-09-11-desktop-polish-button-motion.md`](./plans/2026-09-11-desktop-polish-button-motion.md)、[`plans/2026-09-11-wheel-pager-scroller-detect.md`](./plans/2026-09-11-wheel-pager-scroller-detect.md)、[`plans/2026-09-11-app-view-motion-coverage.md`](./plans/2026-09-11-app-view-motion-coverage.md)、[`plans/2026-09-11-launcher-dock-motion-plan.md`](./plans/2026-09-11-launcher-dock-motion-plan.md) | 改 `DesktopHost` 两态、`utils/layoutMode.ts` 半屏规则、`FitPage`/紧凑档、按钮过渡、滚轮翻页、全 App 视图动效前必读 |
| **中心 worker 默认与白名单** | [`docs/superpowers/specs/2026-09-12-worker-default-origin-guard-design.md`](./docs/superpowers/specs/2026-09-12-worker-default-origin-guard-design.md)（设计）、[`docs/superpowers/plans/2026-09-12-worker-default-origin-guard-plan.md`](./docs/superpowers/plans/2026-09-12-worker-default-origin-guard-plan.md)（执行计划） | 改 `utils/proxyWorker.ts` 默认 worker、`worker/index.js` 的 `ALLOWED_ORIGINS`、CF 限速前必读；名单值只存 CF 侧 |
| **主动消息链路补强** | [`docs/superpowers/specs/2026-09-12-amsg-push-collapse-multidevice-design.md`](./docs/superpowers/specs/2026-09-12-amsg-push-collapse-multidevice-design.md)、[`docs/superpowers/specs/2026-09-12-api-base-url-endpoint-suffix-design.md`](./docs/superpowers/specs/2026-09-12-api-base-url-endpoint-suffix-design.md)、[`docs/superpowers/specs/2026-09-13-stream-terminal-close-design.md`](./docs/superpowers/specs/2026-09-13-stream-terminal-close-design.md)（各有同名 plan） | 改推送折叠/多设备（`push_subscriptions_multi`）、推送测试按钮、心跳、`apiConfigNormalize`、`streamUpgrade`/`readBodyTextUntilTerminal` 前必读 |
| **小红书 VPS 会话桥（WIP）** | [`docs/superpowers/specs/2026-09-15-xhs-vps-session-bridge-design.md`](./docs/superpowers/specs/2026-09-15-xhs-vps-session-bridge-design.md)（设计）、[`docs/superpowers/plans/2026-09-15-xhs-vps-session-bridge-plan.md`](./docs/superpowers/plans/2026-09-15-xhs-vps-session-bridge-plan.md)（执行计划） | 进行中、未落地：改小红书会话模式/桥接 token 前看，落地后再补功能账本 |
| **二改 / 加 App / 数据流 / 后端 Worker** | [`README.md`](./README.md) 「给想二改的人」一节 | 新增 App、build badge、sfworker 代理替换、开源协议 |

> README 的「给想二改的人」区域信息量很大（数据流、ContextBuilder、Instant Push Phase 2、sfworker 清单），动后端 / 加功能前先扫一遍。

## 发版前改一下版本号

[`utils/buildInfo.ts`](./utils/buildInfo.ts) 里的 `APP_VERSION`（形如 `v3.0 (Ambient Presence)`）是手工维护的，**做完一轮大功能或者性能优化就改一下**。若只是小修复则不用提起。

它有两个用处：设置页底部显示的就是它；统计还拿版本号那半截当标签，面板按它切分数据。不改的话新旧版本的数字堆在同一个标签下，「这次优化有没有让首屏变快」「新版铺开多少了」就都答不出来。括号里的代号只在界面上显示，不进标签。构建 hash（`BUILD_LABEL`）是自动生成的，不用管。