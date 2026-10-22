# CORS 统一 · 设计文档（2026-09-11）

> 状态：用户已批准（方案 A：契约统一 + 语义化入口，不做自动重试/自愈）。
> 范围：服务端 CORS 契约统一 + 前端统一外部请求入口 + 结构债清理。
> 不包含：自动降级/自愈、通道合并、鉴权模型变更、计费行为变更。
> 执行计划：`docs/superpowers/plans/2026-09-11-cors-unification-plan.md`。

> 🔻 2026-10-22 追记：外部 agent 桥（桌面「终端」App）整块退役，`worker/opencode-proxy/`、
> `scripts/opencode-proxy.mjs`、`docs/opencode-terminal.md` 随之下线，`worker/corsContract.test.ts`
> 里对应的两条契约断言已删。下文提到 opencode-proxy 的位置均属**历史记录**，不再有该通道；
> 契约实现方式（净化回显）对剩余通道不变。

## 1. 背景

SullyOS 是纯浏览器静态应用（页面源 vercel.app），第三方 API 默认由浏览器直发、受同源策略约束；多数第三方服务不回 CORS 头。历史上为此撞出多层通道：主代理中转（VPS main-agent）、中心 worker（`worker/index.js`，公共实例可自部署）、mcp-proxy、opencode-proxy。

2026-09-11 全仓盘点结论：

- **无统一抽象**：至少 12 份独立 CORS 实现（各 worker / `api/*` / `scripts/*`），已实测漂移：
  - `worker/main-agent/src/index.js` 内 `json()` 与 `corsPreflight()` 两份允许头列表不一致；
  - `api/minimax` 同族端点：`t2a.ts` 放行 `X-MiniMax-Group-Id`，`get-voice.ts` / `voice-clone.ts` / `upload.ts` 不放行。
- **预检回显策略四种并存**：净化回显（中心 worker `worker/index.js:2438-2450`）、白名单回显（`worker/mcp-proxy/worker.js:73-85`、`worker/opencode-proxy/worker.js:76-87`）、原样回显（`scripts/mcp-proxy.mjs:133-141`）、完全不回显（amsg / instant-push / main-agent / post-office / proactive-push / heartbeat / wake-bridge / `api/*`）。新请求头在回显类通道零改动能用，在硬编码类通道被预检拦死——`X-Amsg-Request-Encoding`（instant-push）与 gzip 头（amsg）都是这样踩出来的，且只能靠手写预检补救。
- **前端无统一请求入口**：`getProxyWorkerUrl()`（中心 worker）与 `agentRouting`（主代理）只是地址提供者；各模块自己拼 URL、自己决定直连或走通道。全局拦截器（`context/OSContext.tsx:1088-1156`）只改写 `/chat/completions`，`/embeddings`（记忆宫殿走硅基流动）等新端点默认直连、无兜底。
- **双实现/孤儿副本**：`cloudflare/github-handler.ts`、`cloudflare/webdav-handler.ts` 全仓无导入（线上为 `worker/index.js` 内联版，测试却指向孤儿）；`worker/proactive-push/worker.bundle.js` 与 `src/index.ts` 各自维护；`main-agent` / `heartbeat` / `wake-bridge` 的 bundle 靠手工 `cp`。

用户确认的四类高频出错场景：二改接新服务、日常功能使用、用户自配服务连接、出错排查定位。

## 2. 目标与非目标

**目标**

1. 新自定义请求头/请求方法在全部通道零配置放行（预检净化回显）。
2. 各通道 CORS 行为由同一组契约测试锁死，杜绝漂移。
3. 前端新增统一外部请求入口（语义化路由 + 统一诊断），新代码接服务只在一处登记走向。
4. 清理结构债：孤儿副本、双实现、手工 bundle 同步。

**非目标**

- 不做自动重试/自动降级（守住「LLM 计费请求不自动重发」红线）。
- 不改鉴权模型：预检放宽只是 CORS 层放行，服务端仍按名取头校验 token（预检不等于授权）。
- 不合并通道：MCP 流量刻意不经过项目方公共实例等隐私边界保持不变。
- 不破坏 `worker/index.js` / `worker/mcp-proxy/worker.js` / `worker/opencode-proxy/worker.js` 的「单文件复制即可部署」对外承诺（不为共享代码强迫用户跑构建）。

## 3. 服务端 CORS 契约

### 3.1 行为定义

| 项 | 统一行为 |
|---|---|
| OPTIONS 预检 | 鉴权之前返回 204，无 body；任何路径一视同仁 |
| `Access-Control-Allow-Origin` | `*`；例外：中心 worker 保持回显 Origin（现状），补 `Vary: Origin` |
| `Access-Control-Allow-Headers` | 基础并集 ∪ 净化回显的 `Access-Control-Request-Headers` |
| `Access-Control-Allow-Methods` | 基础并集 ∪ 净化回显的 `Access-Control-Request-Method` |
| `Access-Control-Max-Age` | `86400` |
| `Access-Control-Expose-Headers` | 按通道保留关键头：MCP 通道 `Mcp-Session-Id`；opencode 通道 `WWW-Authenticate`；中心 worker 保持现值 |

基础并集（方法）：`GET, POST, PUT, PATCH, DELETE, OPTIONS`。
基础并集（请求头）：`Content-Type, Authorization, X-Client-Token, Accept`；各通道原有必要头保留（如 amsg 的 `X-User-Id`、`X-Payload-Encrypted` 等）。

### 3.2 净化规则

沿用中心 worker 已验证实现（`worker/index.js:2441-2443`）：

- 请求头：`split(',')` → `trim` → 过滤空 → 最多 16 项 → 单项长度 ≤ 64 → `^[A-Za-z0-9-]+$`；
- 请求方法：`trim` → 长度 ≤ 16 → `^[A-Z]+$`；
- 完全匹配才回显，不匹配的静默丢弃。

### 3.3 实现分布

- **参考实现**：新建 `worker/shared/cors.ts`，导出：
  - `sanitizeRequestedHeaders(raw: string | null): string[]`
  - `sanitizeRequestedMethod(raw: string | null): string | null`
  - `corsHeaders(request: Request, opts?: { expose?: string; extraHeaders?: string[] }): Record<string, string>`
  - `preflightResponse(request: Request, opts?): Response`
- **走 esbuild 的 worker 直接 import 共享模块**：`worker/amsg`、`worker/instant-push`、`worker/post-office`、`worker/proactive-push`（bundle 由 `scripts/build-workers.mjs` 生成，构建时内联）。
- **单文件 worker 内联同一段逻辑**（保持复制即部署）：`worker/index.js`、`worker/mcp-proxy/worker.js`、`worker/opencode-proxy/worker.js`、`worker/main-agent/src/index.js`、`worker/heartbeat/src/index.js`、`worker/wake-bridge/src/index.js`、`worker/amsg/deno-proxy.ts`。
- **脚本代理**导出纯函数并保持直接运行：`scripts/mcp-proxy.mjs`、`scripts/opencode-proxy.mjs`、`scripts/xhs-bridge.mjs`。
- **Vercel 函数**共享 `api/_cors.ts`（沿用 `api/minimax/_bakeVoiceCore.ts` 的 `_` 约定）。

一致的保证来自契约测试（3.5），不依赖「共享同一份代码」。

### 3.4 改造清单（15 处）

| # | 文件 | 现状 | 改法 |
|---|---|---|---|
| 1 | `worker/index.js:18-26` | 已回显头；ACAO 回显 Origin，无 Vary | 补 `Vary: Origin`；方法改「基础 ∪ 回显」；其余不动 |
| 2 | `worker/amsg/src/index.ts:2535`、`:2670-2679` | 包装层硬编码 + 库静态配置 | 入口最前统一拦截 OPTIONS 返回契约预检（沿用 instant-push 已验证模式），库 config 保留 `origin:'*'`；`CORS_ALLOW_HEADERS` 不再承担预检职责 |
| 3 | `worker/instant-push/src/index.ts:68-75`、`:561-563` | 硬编码 `UTILITY_CORS_HEADERS` | 改契约实现（外层拦截保留） |
| 4 | `worker/main-agent/src/index.js:23-33`、`:35-45` | 两套列表 | `corsPreflight()` 改契约实现；`json()` 头列表收敛为基础并集 |
| 5 | `worker/mcp-proxy/worker.js:29-35`、`:73-85` | 白名单回显 | 改契约实现，Expose 保留 `Mcp-Session-Id` |
| 6 | `worker/opencode-proxy/worker.js:32-38`、`:76-87` | 白名单回显 | 改契约实现，Expose 保留 `WWW-Authenticate` |
| 7 | `worker/post-office/src/index.ts:80-85`、`:369` | 硬编码 | 改共享模块 |
| 8 | `worker/proactive-push/src/index.ts:57-67`、`:242-251` | 硬编码；另手写 bundle | 改共享模块；bundle 改由构建产出（见 5.2） |
| 9 | `worker/heartbeat/src/index.js:18-28`、`:90` | 硬编码 | 内联契约 |
| 10 | `worker/wake-bridge/src/index.js:18-28`、`:98` | 硬编码 | 内联契约 |
| 11 | `worker/amsg/deno-proxy.ts:133-138` | 自造 `Allow-Headers: '*'`（Safari 不支持） | 改契约；`public/amsg-deno-proxy.ts` 由构建脚本原样复制 |
| 12 | `scripts/mcp-proxy.mjs:43-49`、`:133-141` | 原样回显（无净化） | 导出纯函数、改契约 |
| 13 | `scripts/opencode-proxy.mjs:42-48`、`:66-78` | 白名单回显 | 同上 |
| 14 | `scripts/xhs-bridge.mjs:69-74`、`:369-370` | 硬编码、不回显 | 同上 |
| 15 | `api/*`（7 个函数 + `backend-proxy.ts`） | 各自 `setCors`，已实测漂移 | 共享 `api/_cors.ts`，统一契约 |

既有测试同步更新（断言口径变化）：`worker/amsg/src/index.test.ts:804-813`、`worker/mcp-proxy/worker.test.ts`、`worker/opencode-proxy/worker.test.ts`、`worker/main-agent/src/index.test.ts`、`worker/preflightEcho.test.ts`、`worker/amsg/deno-proxy.test.ts` 等。

### 3.5 契约测试

新建 `worker/corsContract.test.ts`，提供 `assertCorsContract(handler, opts)`，对每个通道跑同一组断言：

1. 带任意合法自定义头（如 `X-Future-Feature`）的 OPTIONS → 204，且该头出现在 `Access-Control-Allow-Headers`；
2. 任意合法方法（如 `PROPFIND`）的 OPTIONS → 出现在 `Access-Control-Allow-Methods`；
3. 非法头（长度 > 64、含非 `[A-Za-z0-9-]` 字符）不回显；
4. 无 token 的 OPTIONS 也返回 204（预检先于鉴权）；
5. ACAO 为 `*` 或等于请求 Origin；`Access-Control-Max-Age` 存在；
6. 传 `expose` 的通道断言 `Access-Control-Expose-Headers` 含关键头。

覆盖对象：所有 `export default { fetch }` 的 worker（可直接 import 用 Request 驱动）；`scripts/*.mjs` 与 `api/*` 通过导出的纯函数断言；`worker/index.js` 直接驱动。

## 4. 前端统一外部请求入口

### 4.1 模块与 API

新建 `utils/externalRequest.ts`：

```ts
export type ExternalRoute = 'llm' | 'worker' | 'mcp' | 'direct';

export interface ExternalRequestInit extends RequestInit {
  route: ExternalRoute;
  /** 诊断用用途说明，例如「拉取模型列表」 */
  purpose?: string;
}

/** 纯函数：决定最终 URL / headers / 通道名，可单测 */
export function resolveExternalRequest(
  url: string,
  init: ExternalRequestInit,
  cfg?: Partial<ExternalRoutingConfig>,
): { url: string; init: RequestInit; channel: string };

/** 包装 fetch：路由 + 失败诊断（复用 networkFailureDiagnosis）+ 通道检查清单 */
export async function externalFetch(url: string, init: ExternalRequestInit): Promise<Response>;
```

路由规则：

- `llm`：配置了主代理（`readAgentRoutingConfig().agentUrl`）→ 改写 `${agentUrl}/agent/v1/...`（复用共享中转函数，见 4.2）；未配置 → 直连。支持已有中转端点的路径（`/chat/completions`、`/models`）；暂无中转末端的端点直连并在失败诊断中提示。
- `worker`：`/` 开头的相对路径拼 `getProxyWorkerUrl()`；完整 URL 原样。
- `mcp`：暂不接管请求构造（`mcpClient` 已有 relay 决策），仅纳入统一诊断。
- `direct`：直连第三方，统一诊断。

### 4.2 与全局拦截器的关系

- 从 `context/OSContext.tsx:1088-1156` 抽出 LLM 中转改写（body.llm 包装、apiKey 提取、X-Client-Token）为共享函数 `buildAgentRelayRequest`；拦截器与 `externalFetch` 共用。
- 拦截器保留：采样参数兼容、透明流式升级、blobref 还原、API 调用记录、对未迁移裸 fetch 的兜底诊断。路由职责逐步移交给 `externalFetch`（拦截器改写条件 `!urlStr.includes(agentUrl)` 天然避免双重改写）。
- `safeFetchJson`（`utils/safeApi.ts:360`）增加可选 `route` 参数；不传时保持现状（`isChatCompletionUrl` 判断），新代码显式传。

### 4.3 迁移策略与首批清单

新代码一律使用 `externalFetch`；存量渐进迁移。首批（当前最易出错/路径清晰）：

1. `utils/modelList.ts`（`/models` 中转分支收口）；
2. 记忆宫殿 embeddings 直连（`MemoryPalaceApp` 硅基流动）→ `llm`；
3. `utils/webdavClient.ts`、`utils/githubClient.ts` → `worker`；
4. `utils/realtimeContext.ts` 的 Hacker News 直连点 → `direct`；
5. TTS 系列（`elevenLabsTts.ts`、`fishAudioTts.ts`、`minimax*`）→ `worker`；
6. `utils/webpageExtractor.ts` 直连点 → `direct`。

### 4.4 失败诊断

`externalFetch` 捕获失败时：复用 `classifyFetchFailure` / `buildFetchFailureDetail` / no-cors 复检（`utils/networkFailureDiagnosis.ts`），按 route 追加通道检查清单：

- `llm`：「检查设置→主代理地址/Token；或供应商是否需走中转」；
- `worker`：「检查设置→网络代理地址是否可达；公共实例可能未部署该端点」；
- `direct`：「该服务可能不支持浏览器直连；确认是否应走 worker/主代理通道」。

## 5. 结构债清理

1. 删除 `cloudflare/github-handler.ts`、`cloudflare/webdav-handler.ts`（全仓无导入）；迁移 `worker/github-handler.test.ts` 为测 `worker/index.js` 内联版（`webdavProxy.test.ts` 已是内联版测试的范例）。
2. `worker/proactive-push`：bundle 纳入 `scripts/build-workers.mjs` 构建（src 已含全部逻辑，bundle 系打包产物），验证行为一致后删除手写维护路径；更新 `build-workers.mjs:13-17` 的排除注释。
3. `main-agent` / `heartbeat` / `wake-bridge` 的 `cp src/index.js worker.bundle.js` 纳入构建脚本（`VERBATIM_COPIES` 或同类清单），防手工遗忘。
4. 文档更新：`notes/ethernet-branch-context.md` 的「CORS 系统规则」段、`CLAUDE.md` 文档地图（如新增 docs）、`docs/mcp-user-guide.md` / `docs/opencode-terminal.md` 排查章节中对旧行为的描述（若有）。

## 6. 测试与验收

- 新增：`worker/corsContract.test.ts`、`utils/externalRequest.test.ts`、`api/_cors` 相关单测、脚本代理的纯函数单测。
- 更新：3.4 节列出的既有断言。
- 门禁（每阶段收尾）：`corepack pnpm@9.15.9 vitest run` 全量、`pnpm build:workers`（有 bundle 变化时）、`tsc --noEmit`（触碰文件零命中）、`utils/mojibakeGuard.test.ts`（动过含中文文件时）。
- 真机冒烟（push 后）：即时对话、MCP 工具、模型列表、TTS、备份、终端连接各一遍。

## 7. 部署

- **CF worker**（amsg、instant-push、post-office、中心 worker 自建实例、用户自部署的 mcp-proxy/opencode-proxy）：执行时经 Cloudflare API/MCP 重新部署；凭据来源执行时确认。
- **VPS**：`push origin/ethernet` → VPS `git pull` + `systemctl restart sullyos`（main-agent、proactive-push、wake-bridge、heartbeat 的 bundle 变化需要 pull 后才生效）。
- **前端**：push 后 Vercel 自动构建，用户手机端验证。
- 部署顺序：先服务端（契约宽松方向，旧前端不受影响）→ 再前端。

## 8. 风险与边界

- 预检回显是「放宽 CORS 层放行」，不改变服务端鉴权（各端仍按名取头校验；未带 token 的请求照旧 401/403）。
- 中心 worker ACAO 保留回显以避免无谓行为变化（其 CDN 缓存风险用 `Vary: Origin` 消除）。
- 契约测试对单文件 worker 是「行为锁」而非「实现锁」：允许实现内联，禁止行为偏离。
- 不改计费路径：`externalFetch` 不引入任何重试。
- VPS services 加载的是 bundle 产物：凡改到 `src/index.js` 的单文件 worker，必须同步 bundle（本设计已将其纳入构建脚本）。

## 9. 分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| 0 | 本文档 + 执行计划文档 | 文档进仓库 |
| 1 | 服务端：共享模块 + 契约测试 + 15 处改造 + 测试更新 | 契约测试全绿 + 全量 vitest + build:workers |
| 2 | 前端：`externalRequest.ts` + 共享中转函数 + 首批迁移 | 新单测 + 全量 + tsc 触碰零命中 |
| 3 | 清理：孤儿副本、proactive-push、bundle 同步；文档更新 | 全量门禁 + push + 真机冒烟 |
