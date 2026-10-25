# 自主生活 · 隔离环境真实联调

把「浏览器执行器 → worker 路由 → D1 持久化 → 本地 IndexedDB → 回执」整条链在**本机**跑通，
用于验收证据。它 **不是** 单测替身：页面 import 的是仓库里的真实
`utils/autonomyLife/{api,executor,localLedger}`，服务端是真实 `worker/amsg/src/autonomyLife/routes.ts`。

## 组成

- `server.mjs` —— 本机 HTTP 服务：`/` 联调页、`/harness.js`、`/seed`、`/inspect`、
  `/health`、`/setup`、`/tick`、`/mock-llm/*`、`/shopping/*`，以及把
  `/autonomy-life/v1/*` 交给真实 worker 路由。
  持久化用 `node:sqlite` 文件（`./.data/autonomy-e2e.sqlite`），通过一层薄 D1 适配器提供
  `prepare/bind/first/all/run`。
- `server-core.ts` —— 只做 re-export，确保跑的是仓库模块，不是联调专用副本。
- `harness-entry.ts` —— 浏览器入口：真实 `fetch` + 真实 `IndexedDB`，暴露
  `window.__AUTONOMY_E2E__.run/readLocal/resetLocal`，以及生产链路用的
  `seedLocalIdentity/submitCatalogProposals/runExecutorOnce/readUiView`。
- `public/shopping/*.json`（仓库里的真实目录）由 server 原样提供；页面用真实
  `marketCatalog.buildMarketProposal` 选单，价格全部来自目录。
- `run.mjs` —— 驱动：起 server、开 Chromium、按 5 个场景断言并写证据。

`./.data/`（SQLite + 打包产物）已在 `.gitignore` 里，可随时删掉重跑。

## 前置

- Node ≥ 22（用到 `node:sqlite`）。
- 一个 Chrome/Chromium 可执行文件（默认
  `~/.hermes/tools/chromium-1208/chrome-linux64/chrome`，可用 `AUTONOMY_E2E_CHROME` 覆盖）。
- `playwright-core`（仅驱动浏览器，不下载浏览器）：

  ```bash
  mkdir -p ~/.hermes/profiles/ds-executor/cache/scratch/autonomy-e2e-deps
  cd ~/.hermes/profiles/ds-executor/cache/scratch/autonomy-e2e-deps
  npm init -y && npm i playwright-core@1.55.0
  ```

  默认从该目录 `require('playwright-core')`；可用 `AUTONOMY_E2E_DEPS` 指向别处。
  它只用于联调，**不进** `package.json` / lockfile。

## 跑

```bash
AUTONOMY_E2E_EVIDENCE=/tmp/autonomy-e2e node scripts/autonomy-e2e/run.mjs
```

- `--port 4321` 可换端口（只监听 `127.0.0.1`）。
- 产物：`e2e-run.log`、`e2e-report.json`（逐条 check）、`e2e-http-requests.json`（真实请求路径/状态）。
- 退出码 0 = 全部 check 通过。

## 场景

1. `journal.write` 真实落本地日记 + 回执，服务端动作收敛 `succeeded`；
2. 重启 server（同一 SQLite）后状态仍在；
3. `external.read` 真实 https 出网（默认 `https://api.github.com/users/octocat/repos`），
   只回白名单字段并计入服务端配额；
4. 撤销授权 / 账号暂停后，同一张已签许可在出网前被拒（403 / 409），零出网零落库；
5. `travel.wish` 落一行；配额耗尽后第二笔 429 且不落第二行；
6. **生产链路（消费类，不 seed 目标动作）**：`/setup` 落用户边界 → 页面从仓库真实目录
   （`/shopping/*.json`）+ 角色地址 + 角色卡余额选单 → 真实 `POST /proposals` 登记 →
   `/tick` 调真实 `handleAutonomyLifeScheduled`（模型走本机 mock 且**故意失败**）→
   引擎按目录价格排出外卖/购物动作 → 真实执行器 claim/permit/本地事务/回执 →
   `shopping_orders` / `bank_transactions` / 卡余额 / 回执 / `GET /activities`（UI 数据源）
   全部核对；暂停后 `/proposals` 409、`/tick` 不再排动作；
7. **生产链路（外部只读）**：`/setup` 配好外部只读 + 授权 → 不可达时排不出动作 →
   可达时由真实 tick 排出 `external.read`（查询词来自人设兴趣）→ 真实 https 出网 +
   字段投影 + 本地落库 + 配额 +1。用另一个角色避免与场景 3 的同类冷却冲突。

不部署、不连生产 worker、不读任何密钥。
