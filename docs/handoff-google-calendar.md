# Google 日历接入 — 交接文档

> 供新窗口接手续做。写给弱执行者：每步自带路径、行号、意图、验收判据。
> 生成时间：2026-09-25 · 分支 `ethernet` · 全部改动已提交，未推送远端

## 一、当前进度

### 已完成并验证 ✅

**只读链路**
- VPS 桥服务跑在 `127.0.0.1:8841`（systemd `google-bridge.service`，开机自启）
- 公网入口 `https://ethernet-vps.bot.cd/google-api`（Caddy 反代）
- 已连接账号 `plasmavendorlia@gmail.com`，accountId `114175418317903421104`
- 日历 tab 叠加 Google 事件（蓝点）+ 待办 + 节假日
- char 被动注入（`chatPrompts.ts` volatile 槽位）+ 主动查询工具（AIRP）
- char 主动创建（propose → 用户点头 → execute 确认环）

**时区统一**
- 桥拉取带 `timeZone=Asia/Shanghai`，写入补 `timeZone`
- 前端用 `Intl` 按北京时区换算（`utils/googleCalendar.ts`）
- 测试锁死：同一时刻的 EDT/UTC/+08:00 三种写法都显示 `14:39`

**权限（5 个 scope，已在 Google 后台勾选）**
```
https://www.googleapis.com/auth/calendar.readonly              # 列日历
https://www.googleapis.com/auth/calendar.events.owned           # 读自有事件 + char 创建
https://www.googleapis.com/auth/tasks                           # 读待办 + char 创建
https://www.googleapis.com/auth/calendar.events.public.readonly # 官方节假日
https://www.googleapis.com/auth/userinfo.email                  # 显示账号邮箱
```

**OAuth 回调地址（Google 后台登记了 2 条）**
```
http://localhost:5173/settings/google/callback.html
https://ethernet.bot.cd/settings/google/callback.html
```

### 未完成 ❌

**核心待办：日程读写路由切换**（用户新窗口要做的事，见第三节）

## 二、关键文件地图

| 文件 | 行数锚点 | 职责 |
|---|---|---|
| `vps-backend/src/google/googleBridge.js` | 14 `startGoogleBridge` / 26 `finish`(带 CORS) / 166 exchange / 227 events GET / 257 events POST | 桥主体。token 门 + 转发 + 错误透传 |
| `vps-backend/src/google/googleStore.js` | 35 `createGoogleStore` | refresh token AES-GCM 加密落盘 |
| `vps-backend/src/google/run.js` | 26 端口 8841 | 启动入口，读 `/opt/sullyos/.env` |
| `utils/googleCalendar.ts` | 2 scopes / 62 normalizeEvents / 100 `formatGoogleEventTime` / 130 `googleEventLocalDateKey` | 纯函数层，无网络 |
| `utils/googleBridge.ts` | 10 `DEFAULT_GOOGLE_BRIDGE_URL` | 前端调桥客户端 |
| `apps/Settings.tsx` | 843 Google state / 795 postMessage 监听 / 2051 `connectGoogle` / 4730 配置区块 | 设置页 |
| `apps/ScheduleApp.tsx` | 133 Google 数据拉取 / 695 dots / 679 当日过滤 / 778 面板渲染 | 日历 UI |
| `utils/realtimeContext.ts` | 568 `getUpcomingDigest` | char 被动注入 |
| `utils/agenticTools.ts` | 866 四个 Google case / 1093+ 四个实现 | char 主动工具 |
| `utils/airp/capabilityCatalog.ts` | 11-12 两项 Google 能力 | 模型可见的能力目录 |
| `public/settings/google/callback.html` | 全文 | OAuth 回调页（Vite 原样拷贝） |
| `vps-backend/deploy/google-bridge.service` | 全文 | systemd unit |
| `vps-backend/deploy/caddy/SullyOS.Caddyfile` | 78 google-api 路由 | 部署模板 |

## 三、下一阶段：日程读写路由切换

### 用户需求（已确认）

1. **只搬「日程」，不搬「心愿」**。心愿清单（`types.ts:4087` 的 `Task` 接口：`title/supervisorId/tone/deadline/isCompleted`）保持本地不变。
2. **连上 Google 后，日程 tab 全切到 Google**，小手机不再本地创建日程。
3. **小手机能自动创建一个专用 Google 日历**（如命名「SullyOS」），小手机创建的日程都进这里。
4. **完全双向同步**：Google 网页上改，小手机跟着变；小手机改，Google 也变。

### 已定的技术决策

- 现有「日程」在小手机里其实是 `Anniversary`（`types.ts:4098` 时光契约，含重复规则），不是 `Task`。**动手前先确认到底哪个类型对应用户看到的「日程 tab」**。
- Google 日历自动创建需要 `calendar` 写 scope（当前 5 个 scope 不含），要在 `utils/googleCalendar.ts:2` 的 `GOOGLE_SCOPES` 加 `https://www.googleapis.com/auth/calendar`，并让用户在 Google 后台勾上。
- 桥需要新增 `POST /api/calendars`（创建日历）与 `PUT/DELETE /api/events/:id`（改/删），现有只有 GET events 和 POST events。

### 执行前必须先读的三个文件

1. `apps/ScheduleApp.tsx:400-460` — 看 `handleAddTask` / `handleToggleTask` 现在怎么写本地，确认「日程」的实际类型
2. `utils/db.ts:1841-1880` — `saveTask` / `saveAnniversary` 的存储形状
3. `vps-backend/src/google/googleBridge.js:227-280` — 现有 events GET/POST 的路由写法，新路由照抄这个形状

## 四、踩过的坑（别再踩）

1. **端口**：8838 是 mastodon-mcp，8839 是 voice-relay，Google 只能用 **8841**。
2. **Caddy 路由要加在 `ethernet-vps.bot.cd` 块里**，不是 `ethernet.bot.cd`（后者 DNS 指向 Vercel，这个块根本没用）。仓库模板 `vps-backend/deploy/caddy/SullyOS.Caddyfile` 和线上 `/etc/caddy/Caddyfile` **两处都要改**。
3. **CORS**：预检和业务响应**都要**带 `Access-Control-Allow-Origin`，只给预检会让真实请求被浏览器拦成 `Failed to fetch`。
4. **`userinfo` 端点要 `userinfo.email` scope**，否则 403。桥已做容错（拿不到邮箱就用 refresh token 哈希当 accountId）。
5. **calendarList 要 `calendar.readonly`**，`calendar.events.owned` 只管事件不管日历元数据。
6. **`promptCallRegistry.ts` 的 anchor 改成按符号全文搜索了**（`utils/promptCallRegistry.test.ts`），行号不再参与断言，多窗口并行不会再误报。
7. **Google 授权页卡住不动**：多半是代理 IP 触发风控，换网络或等 10-15 分钟。

## 五、测试与验证命令

```powershell
# 单测（46 条 Google 相关，全绿）
pnpm vitest run utils/googleCalendar.test.ts utils/googleBridge.test.ts utils/agenticTools.google.test.ts utils/chatPrompts.google.test.ts utils/backupSecrets.test.ts vps-backend/src/google/ utils/airp/

# 全量（已知 3 个既有失败：corsContract Windows CRLF、mallData 未跟踪、mojibakeGuard 命中别人 scratch）
pnpm vitest run

# 编码护栏
python -c "import glob,os;fs=[f for f in glob.glob('**/*.ts',recursive=True)+glob.glob('**/*.tsx',recursive=True)+glob.glob('**/*.js',recursive=True) if os.path.isfile(f) and 'node_modules' not in f];bad=[f for f in fs if '\ufffd' in open(f,encoding='utf-8').read()];print('BAD:',bad) if bad else print('CLEAN')"
```

## 六、VPS 运维

```bash
# 服务状态
systemctl status google-bridge
journalctl -u google-bridge -n 20 --no-pager

# 改完桥代码后
systemctl restart google-bridge

# 健康检查
curl -s https://ethernet-vps.bot.cd/google-api/api/health

# 账号列表
curl -s -H 'X-Google-Bridge-Token: <见 /opt/sullyos/.env 的 GOOGLE_BRIDGE_TOKEN>' \
  https://ethernet-vps.bot.cd/google-api/api/accounts

# 部署新代码：按仓库惯例在本地改 → push origin/ethernet → VPS pull（VPS 不再是自动快照提交）
# 不要在 VPS 上直接改仓库文件：本地改 → push → VPS `git pull` → restart（运行时只有 .env / systemd unit / Caddyfile 在 VPS 上改）
```

**重要凭据（在 `/opt/sullyos/.env`，不在仓库）**
- `GOOGLE_CLIENT_ID=349693036921-d93seuvobpng1aiq40hcl0m0msbbscrb.apps.googleusercontent.com`
- `GOOGLE_BRIDGE_TOKEN`：见 `/opt/sullyos/.env`（**唯一生产源是服务器 .env**；2026-10-22 已轮换，别再贴进仓库）
- `GOOGLE_SESSION_KEY=<64 hex>`
- `GOOGLE_REDIRECT_URI=http://localhost:5173/settings/google/callback.html`

## 七、遗留事项

1. **代码未推远端**：`ethernet` 分支比 `origin/ethernet` 领先约 20 个提交（含全部 Google 改动）。推之前先确认其他窗口的工作已完成。
2. **线上版还是旧代码**：`ethernet.bot.cd`（Vercel）上跑的是没有 Google 功能的版本，需要推代码 + 重新部署。
3. **工作树未清理**：`.worktrees/google-calendar`（分支 `feat/google-calendar`，HEAD `9821c71e`）已被 `ethernet` 超越，可删。
4. **配对码机制未实现**：spec `docs/superpowers/specs/2026-09-24-google-vps-bridge-design.md` 里设计了「一次性配对码 + 设备登记」，用户仍需手动填桥 Token 到设置页。
5. **未提交文档**：`docs/superpowers/specs/2026-09-24-google-vps-bridge-design.md`（VPS 化设计）、`docs/superpowers/plans/2026-09-23-google-calendar.md`、`2026-09-24-google-calendar-write.md`、`docs/superpowers/specs/2026-09-23-google-calendar-design.md` 尚未 commit。
