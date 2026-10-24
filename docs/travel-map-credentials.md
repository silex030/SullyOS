# 出行 · 地图服务凭据（用户自己填，后台加密保存）

> 目标：用户已有高德 Web 服务 Key / JS API Key / 安全密钥 jscode，**不需要改 `.env`、不需要重新构建前端**。
> 在「设置 → 角色自主出行 → 地图服务凭据」填一次，之后按账号持久化、刷新和换设备都不用重填。

## 一、为什么不是把 Key 放前端

| 凭据 | 谁能看到 | 用途 |
|------|----------|------|
| 高德 **Web 服务 Key** | 只在服务端解密后使用 | 地理编码、地点检索、步行路线、静态图 |
| 高德 **安全密钥 jscode** | 只在服务端代理里注入 | `_AMapService` 反代补参 |
| 高德 **JS API Key** | 浏览器必需（官方设计如此） | 底图展示，靠高德控制台域名白名单约束 |
| Mapbox `pk.` 公钥 | 浏览器必需（公开 token） | 国外底图展示，可选 |

因此 `GET /travel/map/credentials` **只回存在性与公开展示 Key**；Web 服务 Key 与 jscode 不出现在任何 HTTP 响应、URL、日志、localStorage、备份里。
构建期 `VITE_AMAP_JS_KEY` 等只作为「未登录 / 老部署」时的兜底，不再是唯一来源；用户清除后会**立即停止**使用旧值。

## 二、数据与加密

- 表：`travel_map_credentials(user_id PK, encrypted_value, version, updated_at)`，DDL 在 `contracts/travel.ts` 的 `TRAVEL_SCHEMA_SQL`。
- 整份 JSON（五个字段）用 `deriveUserEncryptionKey(userId, AMSG_MASTER_KEY)` 派生的每用户密钥 + `encryptForStorage` 加密；与 `llm_credentials`、护栏状态同一条 crypto 路径，**没有新建全局 owner**。
- 读取：`readTravelMapCredentialRow` → 解密；解不开（换过 masterKey）→ `unreadable`，保存被拒（`UNREADABLE`），**不会拿空对象覆盖用户配置**。
- 并发：已有行按 `version` CAS；0 行 = `VERSION_CONFLICT`（409），不会静默覆盖另一台设备的写入。
- 保存语义：空字符串 / 未提交的字段 = **保持不变**；清除必须显式 `clear: ['amapWebKey' | ...]`。

## 三、端点（都要求出行短期 Bearer，主体只来自会话）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/travel/map/credentials` | 存在性 + `amapJsKey` / `mapboxToken` + 短期 `serviceHost` |
| PUT | `/travel/map/credentials` | `{ amapWebKey?, amapJsKey?, amapJsCode?, mapboxToken?, mapboxStyleUrl?, clear?: [] }` |
| POST | `/travel/map/credentials/test` | 显式测试连接：单次请求、30 秒冷却、不扣自主出行预算 |
| GET | **`/_AMapService/t/<token>/v3/...`** | 高德官方前缀的安全代理（见下） |

`PUT` 里带 `geometryPersistence` / `basemapDisplay` / `licensedGeometry` 一律 400 `GEOMETRY_NOT_LICENSED`：
**填 Key 不能解锁几何落库许可**，那条线仍然只读 `TRAVEL_GEOMETRY_LICENSE`。

## 四、jscode 代理（官方 `_AMapService`）

SDK 的请求来自 `<script>` / XHR，跨脚本**带不了 Bearer**，所以：

1. `GET /travel/map/credentials` 签发 `serviceHost = /_AMapService/t/<token>`（HMAC 绑定 `userId` + 过期时间，默认 30 分钟，签名钥复用 `TRAVEL_SESSION_SECRET`，域分隔标签不同）。
2. 浏览器把地图请求发到 `serviceHost + /v3/place/text` 等路径。
3. Worker（`worker/amsg/src/travel/mapProxy.ts`）验签 → 按 userId 解密该用户的 `jscode` / `jsKey` → 只允许白名单端点 → 上游固定 `https://restapi.amap.com` → **覆盖** `key` / 注入 `jscode` → 回传。
4. 不做开放转发：非白名单路径 403、非 GET 405、过期/篡改 token 403、无凭据 503、按用户每分钟限流（默认 40，可 `rpm` 注入）。

白名单：`/v3/place/text`、`/v3/place/around`、`/v3/geocode/geo`、`/v3/geocode/regeo`、`/v3/direction/walking`、`/v3/direction/driving`、`/v3/distance`。

## 五、部署（Caddy 反代，**本仓未实际改生产 Caddy**）

前端站点（`link.ethernet.bot.cd`）需要把 `/_AMapService/*` 原样转给 amsg worker（8832）。
**必须用 `handle`，不能用 `handle_path`**：worker 自己按 `/_AMapService` 前缀解析，剥掉前缀会 404（与 `/home/*` 同一类坑）。

```caddyfile
# 放在前端站点的 site block 里，与既有 (SULLYOS_BACKEND) import 并列
handle /_AMapService/* {
    reverse_proxy 127.0.0.1:8832
}
```

改完：`caddy validate` → `systemctl reload caddy` → 浏览器打开行程面板确认底图出现；没有配置时面板保持「地图暂不可用」，不画假地图。

> 状态：样板已写入文档，**尚未在 VPS 上应用**。未加这条路由时，设置页仍能保存凭据（服务端全链路可用），但浏览器拿不到同源代理，面板不会出图。

## 六、与 env 的关系

- 默认**只看用户凭据**。只有显式设置 `TRAVEL_MAP_ENV_FALLBACK=allow` 时，`AMAP_WEB_KEY` / `MAPBOX_TOKEN` 才作为兜底参与。
- 原因：清除 Key 后旧 env 神秘复活会被误判成「已配置」，而线上那把老 Key 也可能已失效。
- `TRAVEL_SESSION_SECRET`（≥32 字符）同时用于出行会话、静态图签名与代理 token；缺它时 `serviceHost` 不签发（面板明确不可用）。

## 七、自检

```bash
cd /root/SullyOS-travel
pnpm vitest run worker/amsg/src/travel/mapCredentials.test.ts worker/amsg/src/travel/mapProxy.test.ts \
  worker/amsg/src/travel/mapProviders.test.ts worker/amsg/src/travel/routes.test.ts \
  components/settings/TravelSettings.test.tsx utils/travel/mapCredentials.test.ts
```

真实端到端（需用户填入自己的 Key，本仓测试全部用合成 Key，**不发真实收费请求**）：

1. 设置页填 Web 服务 Key + JS API Key + jscode → 保存 → 输入框清空、状态「已加密保存」。
2. 点「测试连接（1 次）」→ 30 秒内再点应提示冷却；服务端只发一次 `/v3/geocode/geo`。
3. 刷新页面 / 重开面板 → 凭据仍在（服务端解密），无需重填。
4. 打开行程地图 → 底图出现且 jscode 在浏览器 Network 里不可见（只有 `/_AMapService/...` 请求）。
5. 点某个字段「清除」→ 状态变未保存，地图相应降级；刷新后不会恢复。

## 八、页面里的填写帮助（新手步骤）

用户不会填时，帮助就在同一张卡片里（`components/settings/TravelMapServiceCard.tsx`，唯一 owner；别处不再加外站链接）：

- 总「第一次填写顺序」：申请连接（本站按钮，不在高德找配对码）→ 短码 `XXXX-XXXX` + userId 交管理员批准 → 复用已有 Web 服务 Key → 同一应用加「Web端(JS API)」Key + 安全密钥 → Mapbox 可留空 → 保存 / 测试。
- 每个 Key 字段下「不会填？查看步骤」折叠块，官方入口只这四个（`TRAVEL_MAP_HELP_LINKS`，均 `target="_blank" rel="noopener noreferrer"`）：
  - `https://console.amap.com/dev/key/app`（控制台 · 我的应用）
  - `https://lbs.amap.com/api/webservice/get-key`（Web 服务 Key 申请，官方："需要申请应用Key"）
  - `https://lbs.amap.com/api/javascript-api-v2/guide/abc/prepare`（JS API 的 key 与安全密钥，官方："web 平台（JS API）"）
  - `https://account.mapbox.com/access-tokens/`（Mapbox `pk.` token，可选）
- 文案护栏：密钥只粘进输入框，禁止发聊天/截图；Web 服务 Key 与 JS Key 类型不混；jscode 只存服务端；Mapbox 可选、不承诺永久免费；保存 ≠ 已出图或已开通高德权限，测试连接可能耗额度。
- 域名白名单文案取运行时 `window.location.host`（独立部署后自动显示自己的域名），不写死任何人的站点域名。
- 回归：`pnpm vitest run components/settings/TravelMapServiceCard.help.test.tsx`（含外链 host 白名单与 `rel` 属性）。

## 九、本人独立部署（自己的实例）

自部署实例没有「找原作者」这一步：站点跑在谁的机器上，owner 就由谁在这台机器上初始化。
本批**不提供匿名自助 bootstrap**，也不要求你去翻未知的 secret；第一台设备的连接由本机脚本批准一次：

```bash
# 1) 看有哪些待批准的连接申请（只输出 requestId 短前缀 / 状态 / 时间）
node scripts/travel-pair-admin.mjs list

# 2) 批准一次：<userId> 是设置页卡片上展示的账号 ID，不是密钥
node scripts/travel-pair-admin.mjs approve <requestId> <userId>

# 3) 清理过期申请（可选）
node scripts/travel-pair-admin.mjs purge
```

- 批准只是 `pending → approved` 并绑定 userId；真正的 owner 密钥在用户浏览器的**一次性 claim**
  里生成，服务端只存哈希。脚本只读本机 SQLite（`AMSG_DB_PATH`，默认 `/opt/sullyos/data/amsg.sqlite`），
  不监听端口、不开放公网接口。
- 之后换设备 / 新浏览器，用户在设置页点「申请连接」（次入口）再批准一次即可；不需要重新部署。
- 服务端还需要 `AMSG_MASTER_KEY`（每用户密钥派生用）；没有它时卡片会显示「读取失败」，保存会被拒绝。
- 未来的完整自助初始化（部署 AI 一条命令完成 owner + 凭据初始化）仍未提供，别在文案里承诺已有。

