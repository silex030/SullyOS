# 自主生活：入口迁移与验证说明（UI 卡 t_c621b16a）

本卡把散落在角色设定页、设置页与若干 App 里的「自主功能」收敛成一个入口，并按
`autonomous-life-contract-v1.md` §8 接入 `/autonomy-life/v1`。**这里不含真实联调结果**：
后端 D1 端口与 worker 路由尚未接线（见引擎卡 t_62985966 的已知限制），所以界面在未配置
worker 地址时按 fail-closed 显示「状态暂无法确认」，不会退化成演示数据。

## 1. 入口迁移

| 旧入口 | 位置 | 现状 |
| --- | --- | --- |
| `components/character/AutonomyPanel.tsx`（模板 / 节奏 / 护栏 / 活跃度） | 角色详情 · 身份页 | **删除**。功能拆到「自主生活 → 概况 / 活动 / 边界」 |
| `components/character/AutonomyGuardrailsFields.tsx` | 同上 | **删除**（仅被 AutonomyPanel 使用） |
| `components/settings/AutonomyGuardrailsSettings.tsx`（全局护栏 / 频率） | 设置 · 自主生活护栏 | **替换**为 `components/autonomy-life/AutonomyAccountSection.tsx`：账号总览、总暂停、总额度、禁止方向、外部只读授权；角色层不再在这里改 |
| `components/character/AirpPanel.tsx`（L0–L3 档位 + 能力白名单 + 事件记录） | 角色详情 · 身份页 | **不再挂载**（文件保留，仍被 `utils/airp/airpPanelLogic.test.ts` 作为纯逻辑使用）。能力与允许窗口去「边界」，活动记录去「活动」，避免第二套用户可调入口 |
| `utils/airp/autonomyPanelLogic.test.ts` | — | **删除**（随 AutonomyPanel 一起退役） |

新增：

| 新入口 | 位置 | 说明 |
| --- | --- | --- |
| `AutonomyLifeEntryCard` | 角色详情 · 身份页（唯一一张状态卡） | 只读：TA 现在的状态、最近一件事、下次自然机会；无任何输入控件 |
| `AutonomyLifePanel`（概况 / 活动 / 边界） | 由入口卡打开的全屏工作区 | 唯一可设置的地方；深链回原 App 的真实记录 |
| `AutonomyAccountSection` | 设置 → 自主生活 | 仅账号层：总暂停 / 总额度 / 角色只读状态 / 未接入 App 说明 |

「何时行动」的解释统一为：**什么时候做什么由 TA 的人设和当下情境决定**，用户只设边界。
代码里不存在任何频率 / 活跃度 / 同类冷却的写入口（`contracts/autonomyLife.ts` 的
`DEPRECATED_BOUNDARY_FIELDS` + `utils/autonomyLife/api.ts` 的本地硬闸，以及
`components/autonomy-life/entryMigration.test.ts` 的源码级守卫）。

### Dock 第 4 格

Spark 清理卡（t_995b91f3）把 `DOCK_APPS` 减到 3 项，第 4 格由 `normalizeDockOrder` 按
`INSTALLED_APPS` 顺序补满，默认落「朋友圈（Moments）」。本卡**没有再改 Dock**，也不再引入
新的桌面 App —— 契约明确「不新增桌面 App」，自主生活不是 App 而是角色详情里的工作区。

## 2. 组件与数据层

```
contracts/autonomyLife.ts          共享契约（与引擎卡逐字节一致，已 diff 校验）
utils/autonomyLife/api.ts          /autonomy-life/v1 客户端：形状校验 + fail-closed + 旧字段硬闸
utils/autonomyLife/endpoint.ts     运行期接线：复用 workerUrl / X-Client-Token，不猜默认后端
utils/autonomyLife/store.ts        revision/CAS、轮询、暂停先本地后云端确认、保存乐观回滚
utils/autonomyLife/view.ts         纯展示映射（状态、原因码、预算行、时间、App 名称）
components/autonomy-life/*         入口卡 + 工作区三个 tab + 账号总览 + fixtures
```

数据来源只有一条：服务端 `effective` / `revision`。设置页与角色页读同一份，不做双向镜像。

## 3. 测试数据（fixtures）的边界

`components/autonomy-life/fixtures.ts` 是**演示 API**，只在 `fixtureScenario` 显式传入时生效
（测试、`docs/autonomy-life/preview/` 截图壳）。任何情况下都会渲染红色横幅
「测试数据（fixture: …）· 不是真实活动，禁止当作验收证据」。
运行期组件默认走 `createDefaultAutonomyLifeApi()`，未配置 worker 即为「状态暂无法确认」，
不会回落到 fixture。**因此截图只能证明 UI 状态机与文案，不能证明后端联调。**

## 4. 复现步骤

```bash
cd /root/SullyOS-autonomy-ui

# 组件/状态测试 + 客户端契约测试
./node_modules/.bin/vitest run components/autonomy-life utils/autonomyLife

# 截图壳（只在 dev 下按路径访问，不进构建产物）
./node_modules/.bin/vite --port 5199 --host 127.0.0.1
# 浏览器 390×844 打开：
#   /docs/autonomy-life/preview/preview.html?mode=card&scenario=ready
#   /docs/autonomy-life/preview/preview.html?mode=panel&tab=overview&scenario=ready
#   /docs/autonomy-life/preview/preview.html?mode=panel&tab=activity&scenario=ready
#   /docs/autonomy-life/preview/preview.html?mode=panel&tab=boundary&scenario=ready
#   /docs/autonomy-life/preview/preview.html?mode=account&scenario=ready
#   scenario 还支持 empty / paused / budget_exhausted / waiting_device /
#   pending_confirmation / capability_unavailable / load_error
```

截图作为本卡的审查附件提交（13 张，移动端 390px / `deviceScaleFactor=2`），不进仓库；
按上面命令可原样重拍。

## 5. 覆盖矩阵

| 契约要求 | 截图 | 断言 |
| --- | --- | --- |
| 初次启用 / 无数据 | 06、07 | 「尚无自主活动」/「还没有自主活动记录」 |
| 加载失败 | 08 | 「状态暂无法确认」+「重新读取」，不出现「一切正常」 |
| 额度耗尽 | 09 | 「受限」「今天已经用完」「今天额度用完，明天自动重置」 |
| 等待设备 | 13 | 「执行设备不在线」「不会假装已经完成」 |
| 已暂停 | 12 | 「已暂停」「暂停期间不会产生新动作」「去边界恢复」 |
| 暂停中（未 quiesced） | 04 + 测试 | 点总暂停后先「正在停止，还有一些动作在收尾」，不显示「全部已暂停」 |
| 待外传确认 | 10 | 用途 / 目标站点 / 字段 / 有效期 + 批准/拒绝；批准后卡片消失 |
| 能力不可用 | 11 | 地图未配置、未授予只读、本期未开放；无假确认按钮 |
| unknown 结果 | 03 | 「结果待核对」+ 明确不提供盲重试 |
| 活动深链 | 03 + 测试 | 点行回原 App，带 `charId/actionId/resultRef` |
| 只设边界不设频率 | 01、04、05 | 源码级零频率输入；入口卡 0 个 input / 0 个 switch |
| 空状态不编内容 | 06、07 | 无「今天写日记」等编造行 |

## 6. 已知缺口（不在本卡范围，如实记录）

1. **后端未接线**：`/autonomy-life/v1` 尚无 D1 端口与 worker 路由，界面目前只能到达
   「状态暂无法确认」。真实联调需引擎卡补齐后复验。
2. **`AirpPanel.tsx` 变成未引用组件**：本卡只摘掉挂载点，未删除文件与其纯逻辑测试。
   建议在迁移收尾卡里连同 `utils/airp` 旧档位一起退役，避免留下第二套能力配置代码。
3. **两套前端传输层**：引擎卡另写了 `utils/autonomyLife/client.ts`（当前无任何引用），
   本卡用的是 `utils/autonomyLife/api.ts`。合并后应保留 `api.ts` 并删除未被引用的 `client.ts`，
   否则同一契约出现两个 SDK。
4. **截图只覆盖 fixture 状态**：真实账号数据（含多角色、真实 worker）未验证。

## 7. 本次验证记录（在本机真实执行）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 组件/页面/客户端测试 | `vitest run components/autonomy-life utils/autonomyLife` | **3 文件 / 37 用例全绿** |
| 相关既有测试（airp / wiring / 设置） | `vitest run components/autonomy-life utils/airp utils/activeMsgClient.wiring.test.ts utils/exportShareAudit.test.ts utils/apiPresetSwitch.wiring.test.ts utils/settingsLocalVoiceLabel.test.ts utils/amsgStateSync.wiring.test.ts utils/journalAppearance.test.ts` | **39 文件 / 794 用例全绿** |
| 类型检查（全仓） | `tsc --noEmit -p tsconfig.json` | 56 条错误，**与基线（`f7f040c7` 干净副本）逐行同集合，本卡新增 0 条** |
| 生产构建 | `vite build` | 见本次提交说明/日志；`docs/autonomy-life/preview/` 不是入口，不进产物 |

客户端测试覆盖的是「失败时怎么办」而不是后端语义：未配置不发请求、缺信封/形状不符/串号
一律 `MALFORMED_RESPONSE`、401/429 原样透传、旧频率字段本地拒发、写请求带 `expectedRevision`
与幂等键。其中一条测试当场暴露了 `isBudgetUsage` 只校验 `typeof dimension === 'string'` 的漏洞
（未知维度会一路传到展示层），已改为白名单校验。
