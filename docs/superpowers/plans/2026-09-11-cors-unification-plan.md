# CORS 统一 · 执行计划（2026-09-11）

> 设计：`docs/superpowers/specs/2026-09-11-cors-unification-design.md`。
> 本计划按「弱执行者」标准编写：每步有文件路径、定位、代码意图/代码块、验收命令与预期。禁止凭感觉补全。
> 用户已批准方案 A（契约统一 + 语义化入口，不做自动重试/自愈）。

> 🔻 2026-10-22 追记：外部 agent 桥（桌面「终端」App）整块退役，`worker/opencode-proxy/`、
> `scripts/opencode-proxy.mjs`、`docs/opencode-terminal.md` 已下线。本计划里涉及 opencode-proxy
> 的 Step 1.8 / 1.14 / 部署清单均属**历史记录**，不再执行。

## 0. 执行前提（每阶段开工前重读）

- 分支必须是 `ethernet`。工作区已有**另一条线**未提交改动：`apps/TarotApp.tsx`、`apps/tarot/LibraryView.tsx`、`apps/tarot/RitualView.tsx`、`apps/tarot/TarotParticles.tsx`、`plans/2026-09-11-tarot-mystic-redesign.md`。
  - **全程禁止读写触碰上述塔罗文件**；每次提交只 `git add` 本计划点名的文件。
- 命令环境：`corepack pnpm@9.15.9`（pnpm 不在 PATH）；写文件只用工具，不用 shell 重定向；含中文的 oldString 只从 Read 输出取。
- 铁律：
  1. 不引入任何自动重试/自动降级（LLM 计费红线）。
  2. 不合并/删除任何通道。
  3. 不破坏 `worker/index.js`、`worker/mcp-proxy/worker.js`、`worker/opencode-proxy/worker.js` 的单文件复制部署承诺（可以内联，不可以要求构建）。
  4. 预检放宽 ≠ 鉴权放宽：各端点仍按名取头校验 token，鉴权逻辑一行不改。
  5. 改到 `worker/<x>/src/index.js` 的单文件 worker 必须同步 bundle（本计划 Step 3.3 前手动 `cp`，3.3 后走脚本）。
- 门禁命令（阶段收尾跑）：
  - 全量：`corepack pnpm@9.15.9 vitest run`（预期：全部通过；已知 storageOptimize / networkFailureDiagnosis 全量并发抖动，单独复跑该文件能过即视为通过，需在汇报里写明）
  - 构建：`corepack pnpm@9.15.9 build:workers`
  - 类型：`corepack pnpm@9.15.9 exec tsc --noEmit`（判据：本次触碰文件零命中）
  - 乱码：`corepack pnpm@9.15.9 vitest run utils/mojibakeGuard.test.ts`

## 阶段 0：文档落地

**Step 0.1** 把设计文档原样写入 `docs/superpowers/specs/2026-09-11-cors-unification-design.md`。
**Step 0.2** 本计划复制到 `docs/superpowers/plans/2026-09-11-cors-unification-plan.md`。
**Step 0.3** 提交：`git add docs/superpowers/specs/2026-09-11-cors-unification-design.md docs/superpowers/plans/2026-09-11-cors-unification-plan.md` → commit message：`docs: cors unification design and plan`。
验收：`git log --oneline -1` 显示该提交；`git status` 中塔罗改动仍未提交（不误收）。

## 阶段 1：服务端契约（核心）

### Step 1.1 新建 `worker/shared/cors.ts`（参考实现）

完整内容：

```ts
/**
 * CORS 契约参考实现（见 docs/superpowers/specs/2026-09-11-cors-unification-design.md）。
 * 行为：OPTIONS 204（鉴权前）+ ACAO * + 净化回显请求头/方法 + Max-Age 86400。
 * 单文件 worker 内联同一段逻辑（保持复制即部署）；一致性由 worker/corsContract.test.ts 锁死。
 */

export const CORS_BASE_HEADERS = ['Content-Type', 'Authorization', 'X-Client-Token', 'Accept'];
export const CORS_BASE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

const MAX_ECHO_HEADERS = 16;
const MAX_HEADER_LENGTH = 64;
const MAX_METHOD_LENGTH = 16;
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;
const METHOD_RE = /^[A-Z]+$/;

export function sanitizeRequestedHeaders(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
    .slice(0, MAX_ECHO_HEADERS)
    .filter((s) => s.length <= MAX_HEADER_LENGTH && HEADER_NAME_RE.test(s));
}

export function sanitizeRequestedMethod(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.trim();
  return m.length <= MAX_METHOD_LENGTH && METHOD_RE.test(m) ? m : null;
}

export function corsHeaders(
  request: Request,
  opts: { expose?: string; extraHeaders?: string[] } = {},
): Record<string, string> {
  const requested = sanitizeRequestedHeaders(request.headers.get('Access-Control-Request-Headers'));
  const method = sanitizeRequestedMethod(request.headers.get('Access-Control-Request-Method'));
  const allowHeaders = Array.from(new Set([...CORS_BASE_HEADERS, ...(opts.extraHeaders || []), ...requested]));
  const allowMethods = Array.from(new Set([...CORS_BASE_METHODS, ...(method ? [method] : [])]));
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': allowHeaders.join(', '),
    'Access-Control-Allow-Methods': allowMethods.join(', '),
    'Access-Control-Max-Age': '86400',
  };
  if (opts.expose) headers['Access-Control-Expose-Headers'] = opts.expose;
  return headers;
}

export function preflightResponse(
  request: Request,
  opts: { expose?: string; extraHeaders?: string[] } = {},
): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request, opts) });
}
```

### Step 1.2 新建 `worker/corsContract.test.ts`（契约测试）

工具 + 首批覆盖中心 worker。关键断言（对每个通道跑同一组）：

```ts
import { describe, expect, it } from 'vitest';

export interface CorsTestableHandler {
  fetch(request: Request, env?: any, ctx?: any): Promise<Response>;
}

export function assertCorsContract(
  name: string,
  load: () => Promise<{ default: CorsTestableHandler }> | { default: CorsTestableHandler },
  opts: { expose?: string; env?: any } = {},
) {
  describe(`CORS contract: ${name}`, () => {
    const run = async (headers: Record<string, string>, url = 'https://probe.invalid/any/path') => {
      const mod = await load();
      return mod.default.fetch(
        new Request(url, { method: 'OPTIONS', headers: { Origin: 'https://sully.test', ...headers } }),
        opts.env ?? {},
        { waitUntil() {} },
      );
    };

    it('echoes arbitrary custom request headers', async () => {
      const res = await run({
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-future-feature, x-another-header',
      });
      expect(res.status).toBe(204);
      const allow = (res.headers.get('Access-Control-Allow-Headers') || '').toLowerCase();
      expect(allow).toContain('x-future-feature');
      expect(allow).toContain('x-another-header');
      expect(res.headers.get('Access-Control-Allow-Methods') || '').toContain('POST');
      const acao = res.headers.get('Access-Control-Allow-Origin');
      expect(acao === '*' || acao === 'https://sully.test').toBe(true);
      expect(res.headers.get('Access-Control-Max-Age')).toBeTruthy();
      if (opts.expose) expect(res.headers.get('Access-Control-Expose-Headers') || '').toContain(opts.expose);
    });

    it('echoes arbitrary method and drops malformed ones', async () => {
      const ok = await run({ 'Access-Control-Request-Method': 'PROPFIND' });
      expect(ok.headers.get('Access-Control-Allow-Methods') || '').toContain('PROPFIND');
      const bad = await run({ 'Access-Control-Request-Method': 'POST; DROP' });
      expect(bad.headers.get('Access-Control-Allow-Methods') || '').not.toContain('DROP');
    });

    it('drops malformed request headers but keeps base list', async () => {
      const res = await run({
        'Access-Control-Request-Headers': 'x-ok-header, bad header!, ' + 'a'.repeat(80),
      });
      const allow = res.headers.get('Access-Control-Allow-Headers') || '';
      expect(allow.toLowerCase()).toContain('x-ok-header');
      expect(allow).not.toContain('bad header!');
      expect(allow).not.toContain('a'.repeat(80));
      expect(allow).toContain('Content-Type');
    });

    it('answers preflight without auth', async () => {
      const res = await run({ 'Access-Control-Request-Method': 'GET' });
      expect(res.status).toBe(204);
    });
  });
}

// 中心 worker
assertCorsContract('center worker/index.js', async () => (await import('../index.js')) as any, {
  expose: 'Mcp-Session-Id',
});
```

注意：
- 中心 worker 的 `origin` 回显使其 ACAO 是探测 Origin，断言已兼容两种。
- `env` 传 `{}`：OPTIONS 分支在各 handler 中均在读取 env 之前返回；若某 worker 报 env 相关错误，为该 worker 提供 opts.env 最小 stub（在各自的 `assertCorsContract` 调用里给）。

验收：`corepack pnpm@9.15.9 vitest run worker/corsContract.test.ts`（预期先只跑通中心 worker，此后每改一处通道往本文件加一行覆盖，逐步变绿）。

### Step 1.3 中心 worker：补 `Vary: Origin`

- 文件：`worker/index.js`，`corsHeaders(origin)`（18-26 行）。
- 在 headers 对象加 `"Vary": "Origin"`；方法列表改为基础并集 ∪ 回显（在 2438-2450 的 OPTIONS 分支里追加：读 `Access-Control-Request-Method` 净化后并入）。
- 其余行为（回显头）不动。
- 验收：契约测试中心 worker 用例全绿；`worker/preflightEcho.test.ts` 全绿。

### Step 1.4 `worker/amsg/src/index.ts`：入口最前统一拦截 OPTIONS

- 定位：`export default {...}` 的 `fetch` 入口（在 3049 行 `/health` 处理之前）。
- 改法：入口第一段即
  ```ts
  if (request.method === 'OPTIONS') {
    return preflightResponse(request, { extraHeaders: ['Content-Encoding', 'X-User-Id', 'X-Payload-Encrypted', 'X-Encryption-Version', 'X-Response-Encrypted'] });
  }
  ```
  import 自 `../../shared/cors`（相对路径按实际目录调整）。
- 保留 `config.cors = { origin: '*', allowHeaders: CORS_ALLOW_HEADERS }`（库实际响应用），但 `CORS_ALLOW_HEADERS` 注释更新为「仅库配置用；预检由入口统一处理」。
- 同步更新 `worker/amsg/src/index.test.ts:804-813` 的断言：不再断言静态相等，改为断言 OPTIONS 回显任意头（直接复用 `assertCorsContract`，见 1.2 模式）。
- 验收：`corepack pnpm@9.15.9 vitest run worker/amsg/src/index.test.ts worker/corsContract.test.ts`。

### Step 1.5 `worker/instant-push/src/index.ts`：改契约

- 定位：`UTILITY_CORS_HEADERS`（68-75）、入口 OPTIONS（561-563）、`/version`（565+）、`/capabilities` 分支（568+）、解压失败 400（577-583）。
- 改法：删除 `UTILITY_CORS_HEADERS` 常量，所有响应头改用 `corsHeaders(request, { extraHeaders: ['X-Amsg-Request-Encoding'] })`；入口 OPTIONS 用 `preflightResponse`。
- 保留库（amsg-instant）调用路径不改；外层拦截继续抢在库之前。
- 更新相关单测（`worker/instant-push/src/*.test.ts` 中断言旧头的地方）。
- 验收：对应测试 + 契约测试（往 1.2 文件加覆盖）。

### Step 1.6 `worker/main-agent/src/index.js`：两套列表合一

- 定位：`json()`（23-33）、`corsPreflight()`（35-45）。
- 改法：以内联契约逻辑实现 `corsPreflight(request)`（净化回显 + 基础并集 + PROPFIND/MKCOL 等 webdav 方法随回显自动放行）；`json()` 的 `access-control-allow-headers` 改为基础并集即可（实际响应不被浏览器检查 ACAH），两处引用同一常量避免再次漂移。
- 同步 bundle：`cp worker/main-agent/src/index.js worker/main-agent/worker.bundle.js`（阶段 3.3 前手动；注意保持 UTF-8 无 BOM，用 `Copy-Item`）。
- 更新 `worker/main-agent/src/index.test.ts` 断言（回显任意头）。
- 验收：`vitest run worker/main-agent/src/index.test.ts worker/corsContract.test.ts`。

### Step 1.7 `worker/mcp-proxy/worker.js`

- 定位：`CORS_HEADERS`（29-35）、OPTIONS 白名单回显（73-85）。
- 改法：内联契约；Expose 保留 `Mcp-Session-Id, WWW-Authenticate`；`PROXY_KEY` fail-closed 逻辑不动。
- 更新 `worker/mcp-proxy/worker.test.ts`（65、95 行附近断言）。
- 验收：`vitest run worker/mcp-proxy/worker.test.ts worker/corsContract.test.ts`。

### Step 1.8 `worker/opencode-proxy/worker.js`

- 定位：`CORS_HEADERS`（32-38）、白名单回显（76-87）。
- 改法：内联契约；Expose 保留 `WWW-Authenticate`。
- 更新 `worker/opencode-proxy/worker.test.ts`（65、89 行附近）。
- 验收：同上文件跑绿。

### Step 1.9 `worker/post-office/src/index.ts`

- 定位：`CORS`（80-85）、OPTIONS（369）。
- 改法：import 共享模块；OPTIONS 用 `preflightResponse`。
- 验收：`vitest run worker/corsContract.test.ts`（加覆盖）。

### Step 1.10 `worker/proactive-push/src/index.ts`

- 定位：json 头（57-67）、OPTIONS（242-251）。
- 改法：import 共享模块。**注意**：本步只改 src；bundle 到 Step 3.2 统一用构建脚本再生成（届时验证 CORS 行为一致）。
- 验收：契约测试加覆盖。

### Step 1.11 `worker/heartbeat/src/index.js`

- 定位：`json()`（18-28）、OPTIONS（90）。
- 改法：内联契约（`OPTIONS → 204 + 契约头`，普通响应保留 json 头但列表与契约一致）。
- 同步 bundle（`Copy-Item`）。
- 验收：契约测试加覆盖。

### Step 1.12 `worker/wake-bridge/src/index.js`

- 定位：`json()`（18-28）、OPTIONS（98）。
- 改法：同 1.11，`extraHeaders: ['X-Wake-Token']`。
- 同步 bundle。
- 验收：契约测试加覆盖。

### Step 1.13 `worker/amsg/deno-proxy.ts`

- 定位：`SELF_RESPONSE_HEADERS`（133-138，含 `Access-Control-Allow-Headers: '*'`）。
- 改法：改为契约内联（无 Request 对象时用等价逻辑：这里也要处理 OPTIONS 分支——现文件没有 OPTIONS 分支，需在转发前加 `if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: ... })`）。
- 同步 `public/amsg-deno-proxy.ts`（构建脚本 `VERBATIM_COPIES` 会复制；跑 `build:workers` 或 `Copy-Item`）。
- 更新 `worker/amsg/deno-proxy.test.ts`（149 行附近）。
- 验收：`vitest run worker/amsg/deno-proxy.test.ts`。

### Step 1.14 `scripts/mcp-proxy.mjs`、`scripts/opencode-proxy.mjs`、`scripts/xhs-bridge.mjs`

- 改法：各自把 CORS 段替换为契约内联；文件顶部/底部导出纯函数便于测试：
  - `export function corsHeadersFor(req)`（Node IncomingMessage 形态，取 `req.headers['access-control-request-headers']` 等小写键）；
  - OPTIONS 分支改为 `res.writeHead(204, corsHeadersFor(req)); res.end();`。
- 新建/扩展单测：`scripts/` 下无既有测试目录惯例，统一放 `worker/corsContract.test.ts` 内做「导入纯函数断言」。
- 验收：契约测试覆盖三个脚本函数 + 手动冒烟（可选）。

### Step 1.15 `api/*`（7 个函数 + backend-proxy）

- 新建 `api/_cors.ts`：
  ```ts
  export function applyCors(req: { headers: Record<string, any> }, res: { setHeader(k: string, v: string): void }): void
  ```
  内部实现契约逻辑（回显 `access-control-request-headers`，Node 头键小写）。
- 改 `api/minimax/t2a.ts`、`get-voice.ts`、`voice-clone.ts`、`upload.ts`、`bake-voice.ts`、`api/elevenlabs/tts.ts`、`api/fishaudio/tts.ts`：`setCors` 段替换为 `applyCors(req, res)`。
- 改 `api/backend-proxy.ts`：OPTIONS 补 `applyCors`（同源部署本不需要，统一口径）。
- 更新 `api/backend-proxy.test.ts` 及新增 `_cors` 单测。
- 验收：`vitest run api/`。

### Step 1.16 阶段 1 门禁 + 提交

- 跑全量 vitest、`build:workers`（amsg/instant-push/post-office 的 bundle 会在本步变化——确认 diff 只含 CORS 相关）、mojibake。
- 提交（仅点名文件）：
  - `worker/shared/cors.ts`、`worker/corsContract.test.ts`
  - `worker/index.js`、`worker/amsg/src/index.ts`、`worker/amsg/worker.bundle.js`（构建产物）、`public/amsg-worker.bundle.js`
  - `worker/instant-push/src/index.ts` + bundle + public 副本
  - `worker/main-agent/src/index.js` + `worker.bundle.js`
  - `worker/mcp-proxy/worker.js`、`worker/opencode-proxy/worker.js`
  - `worker/post-office/src/index.ts` + bundle、`worker/proactive-push/src/index.ts`
  - `worker/heartbeat/src/index.js` + bundle、`worker/wake-bridge/src/index.js` + bundle
  - `worker/amsg/deno-proxy.ts` + `public/amsg-deno-proxy.ts`
  - `scripts/*.mjs` 三个、`api/_cors.ts` + 7 个函数 + 测试
  - 各更新过的测试文件
- commit message：`feat(cors): unify server-side preflight contract across all channels`。

### Step 1.17 部署（阶段 1 完成后）

- VPS：`git push origin ethernet` → SSH `git pull` + `systemctl restart sullyos`（`vps_execute-command`，workdir `/opt/sullyos/sullyos-repo`）。
- CF worker：amsg / instant-push / post-office / 用户自建中心 worker / 用户自部署 mcp-proxy / opencode-proxy —— 用 Cloudflare API（用户提供 token 或已配置 MCP）。凭据来源执行时与用户确认。
- 冒烟：VPS 侧 curl 各服务 `/health`；契约行为抽查（OPTIONS 带自定义头 → 回显）。

## 阶段 2：前端统一入口

### Step 2.1 新建 `utils/externalRequest.ts`

- 内容按设计 4.1：`ExternalRoute`、`resolveExternalRequest`（纯函数）、`externalFetch`（包装 + 诊断）。
- `resolveExternalRequest` 的路由：
  - `worker`：`/` 开头 → `getProxyWorkerUrl() + url`；完整 URL 原样。
  - `llm`：`readAgentRoutingConfig()`；有 agentUrl 时对 `/chat/completions` 与 `/models` 走既有中转形态（chat 走共享函数 2.2，models 走 `/agent/v1/models?target=`），其余端点直连。
  - `direct`：原样。
  - `mcp`：原样（诊断包装）。
- `externalFetch`：try/catch 包 fetch；失败时用 `classifyFetchFailure` + `buildFetchFailureDetail`（`utils/networkFailureDiagnosis.ts`）+ route 检查清单，写调试日志（复用 OSContext 现有网络失败日志入口，参照其调用方式）。

### Step 2.2 抽 `buildAgentRelayRequest`

- 从 `context/OSContext.tsx:1130-1155` 抽出纯函数到 `utils/agentRelayRequest.ts`（或并入 externalRequest.ts——实施时选简单者）：
  - 入参：`urlStr`、`init`、`agentCfg`；出参：`{ url, init }` 或 null（不需要改写）。
- OSContext 拦截器改为调用它（行为不变）；`externalFetch` 的 llm 路由复用它。

### Step 2.3 单测

- `utils/externalRequest.test.ts`：纯函数路由分支（worker 相对路径/完整 URL、llm 有/无 agentUrl、direct 原样）。
- 验收：`vitest run utils/externalRequest.test.ts utils/agentRelayRequest.test.ts`。

### Step 2.4 首批迁移（逐个文件，行为等价，不加新功能）

1. `utils/modelList.ts` → `externalFetch(..., { route: 'llm' })`；
2. 记忆宫殿 embeddings（`MemoryPalaceApp` 中 siliconflow 调用点）→ `llm`；
3. `utils/webdavClient.ts`、`utils/githubClient.ts` → `worker`；
4. `utils/realtimeContext.ts` HN 直连 → `direct`；
5. `utils/elevenLabsTts.ts`、`utils/fishAudioTts.ts`、`utils/minimax*` → `worker`；
6. `utils/webpageExtractor.ts` 直连点 → `direct`。
- 每迁一个跑其对应测试；有 `safeFetchJson` 调用点的改用带 `route` 的重载。

### Step 2.5 阶段 2 门禁 + 提交

- 全量 vitest + tsc 触碰零命中 + mojibake。
- commit：`feat(network): unified external request entry with channel-aware diagnosis`。

## 阶段 3：结构清理 + 收尾

### Step 3.1 删除孤儿副本

- 删除 `cloudflare/github-handler.ts`、`cloudflare/webdav-handler.ts`。
- `worker/github-handler.test.ts`：改为测 `worker/index.js` 的 `/github` 内联版（参照 `worker/webdavProxy.test.ts` 对内联 `/webdav` 的做法）；若内联版已有等价覆盖则删除该测试文件并在提交信息说明。
- 验收：全量 vitest 绿。

### Step 3.2 proactive-push bundle 构建化

- 确认 src 与现 bundle 的 CORS/路由行为差异（`git diff --no-index`）。
- 把 `{ name: 'proactive-push', skipPublicOut: true }` 加入 `scripts/build-workers.mjs` WORKERS（按 post-office 形态）；删除 `build-workers.mjs:13-17` 的排除注释并更新。
- 跑构建，确认生成的 `worker/proactive-push/worker.bundle.js` 行为与旧手写版一致（CORS 契约断言 + 路由抽测）；VPS services 加载路径不变。
- 验收：`build:workers` + 契约测试。

### Step 3.3 单文件 cp 纳入构建脚本

- 在 `scripts/build-workers.mjs` 增加 `VERBATIM_COPIES` 条目：`worker/main-agent/src/index.js → worker/main-agent/worker.bundle.js`、`worker/heartbeat/src/index.js → worker/heartbeat/worker.bundle.js`、`worker/wake-bridge/src/index.js → worker/wake-bridge/worker.bundle.js`。
- 注意 VERBATIM 分支目前只 `copyFileSync`，保持编码；跑构建验证三份 bundle 内容与 src 一致（哈希相同）。
- 验收：`build:workers` 输出三个复制行；`git diff` 无意外。

### Step 3.4 文档更新

- `notes/ethernet-branch-context.md`：更新「CORS 系统规则」段（加：契约统一 + 新头自动放行 + `worker/shared/cors.ts` 与契约测试的存在；更新日期）。
- `CLAUDE.md` 文档地图：如需，加一行指向设计文档。
- `docs/mcp-user-guide.md` / `docs/opencode-terminal.md`：若排查章节描述旧的白名单行为，同步为新契约（仅改行为描述，不改用户操作指引）。

### Step 3.5 阶段 3 门禁 + push + 真机

- 全量门禁四件套。
- `git push origin ethernet`（Vercel 测试通道生效）。
- 真机冒烟（用户手机端）：即时对话、MCP 工具、模型列表、TTS、备份、终端连接各一遍；异常记录进调试终端（SYSTEM ERROR）后回报。

## 待确认项（执行到再问用户）

1. Cloudflare 部署凭据：本会话无 CF MCP 工具时，用用户提供的 API token（此前会话曾用「用户提供的 API token 现场重部署」）；token 不落盘、不进仓库。
2. 真机冒烟窗口：每个阶段 push 后需要用户操作。
3. 若发现 `worker/index.js` 的 OPTIONS 分支在读取 env 前确有例外（依赖 env 初始化），契约测试需为该 worker 调整 stub——按测试报错现场处理，不猜。
