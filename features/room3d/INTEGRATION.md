# 3D 家园 + 季节活动 · 集成者手册（handoff）

> 本卡只交付隔离模块，不接线、不进主网页。集成是另一个任务的事。
> 本手册是唯一的后续集成者接入口与共享存档说明。

## 一、模块位置（本卡唯一可写域）

- `features/room3d/`：3D 小家园
  - `types.ts`：`Room3DStateV1`（schema v1）、`FurnitureKind`、bounds 常量、
    `room3DStorageKey(charId)`、`Room3DBackupEnvelope`
  - `validate.ts`：`validateRoomState(input, expectedCharId?)` 严格校验
  - `storage.ts`：`createRoom3DStore(storage: StorageLike)` 生产可用 adapter
  - `furniture.ts`：`FURNITURE_CATALOG`（桌/椅/床/灯/书架/圆毯，全自制几何）、
    `createDefaultLayout()`、`moveItemClamped()`、`rotateItem()`
  - `camera.ts`：`OrbitState`、`applyDrag/applyZoom/resetOrbit`、`prefersReducedMotion()`
  - `chibiAdapter.ts`：`resolveChibiMarker(charData)` 只读（见 §五）
  - `Room3DHome.tsx`：`Room3DHome` 组件（见 §二）
  - `room3d.test.ts`：23 单测；`room3d.behavior.test.tsx`：2 组件行为；
  `room3d.redesign-red.test.ts`：3 新协议 RED→GREEN；
  `room3d.redesign-r2.test.ts`：10 复审返工回归（归属/无锁/锁键/持锁/双realm）；
  `room3d.stale-ops.test.tsx`：6 迟到槽位绑定组件行为；
  `room3d.ordered-ack.test.tsx`：4 有序确认栅栏（review267 saved/conflict 参数化 +
  编辑不断链 + 跨槽代次边界）；
  `vitmod.config.ts`：模块测试配置
    （根 vitest include 不覆盖 `features/**`，跑单测用
    `vitest run --config features/room3d/vitmod.config.ts --root features/room3d`）
  - `preview/`：`standalone.tsx` 隔离 preview、`build.mjs` 模块级构建、
    `serve.mjs` 冒烟静态服务器（跑完即关，不进生产）
- `features/seasonal-events/`：季节活动
  - `types.ts`：`HalloweenStateV1`、`HalloweenRewardIntent`、`HALLOWEEN_SPOTS`、
    `halloweenStorageKey(charId)`；窗口常量 `2026-10-29..2026-10-31`
  - `halloween.ts`：`isHalloweenActive/getHalloweenPhase/collectSpot/allCollected/`
    `claimReward/halloweenClaimId/serialize/deserializeHalloween`
  - `HalloweenHunt.tsx`：`HalloweenHunt` 组件（自绘 SVG）
  - `seasonal.test.ts`：13 单测；`seasonal.behavior.test.tsx`：4 组件行为；
  `halloween.redesign-red.test.ts`：3 状态单调 RED→GREEN；
  `halloween.redesign-r2.test.ts`：10 复审返工回归；
  `seasonal.stale-ops.test.tsx`：11 迟到槽位绑定/双实例/挂载后损坏组件行为；
  `vitmod.config.ts`：同上（`--config features/seasonal-events/vitmod.config.ts --root features/seasonal-events`）

## 二、组件 props（精确契约）

```tsx
// 3D 家园
<Room3DHome
  charId={charId}                 // 必填：同角色隔离
  storage={window.localStorage}   // StorageLike 端口（getItem/setItem/removeItem）
  mutex={undefined}               // 可选：跨文档互斥。不传→getDefaultMutex()
                                  // （浏览器 Web Locks）；传 null→写一律拒绝；
                                  // 测试跨 tab 传共享 SharedMemoryMutex 实例
  chibi={resolveChibiMarker(char)}// 只读标记（§五）
  fallback2D={<RoomApp2DView />}  // 可选：WebGL 失败时渲染的既有 2D 小窝
  onSaved={(state) => {...}}      // 可选：保存成功回调（async 写成功后触发）
  onFallback={(reason) => {...}}  // 可选：降级原因（'webgl-unavailable' 等）
  // forceFallback/autoSelectFirst/motionProbe 只给 preview/测试用，生产永远不传
/>

// 万圣节
<HalloweenHunt
  charId={charId}
  storage={window.localStorage}
  mutex={undefined}               // 可选：同上（不传→默认锁；null→收集/领取 fail closed）
  onReward={(intent) => {
    // intent: { kind:'halloween-candy', eventId, charId, claimId, collectedCount }
    // 由集成者决定如何落库；本模块绝不写全局货币/捕鱼存档
  }}
  // todayKey 只给 preview/测试注入；生产不传（组件取设备本地今天）
/>
```

### 二之一、异步完成归属（第1轮新架构复审，迟到结果绑定槽位）

所有 async 写（家园 `save`/`recoverCorrupt`、活动 `onCollect`/`onClaim`/
`onRecover`）在发起时绑定 `charId + storage`；`await` 返回后：

- 已卸载 → 一律不触 UI、不调回调（盘已正确写入旧槽，重开可见）；
- 仍挂载但槽已变（切到别的角色/端口）→ 不触当前槽 UI；
  其中活动迟到 **claim 成功** 仍按 intent 自带的正确 `charId` 投递
  `onReward`（绝不因丢弃迟到回调而静默丢奖，`claimId` 去重保证幂等）；
  家园迟到 `save` 成功则连 `onSaved` 也不触发（盘即真相，重开可见）；
- 回到发起槽（A→B→A 中途返回）→ 不按同槽正常处理：必须满足
  ordered-ack-closeout 有序栅栏（同实例/同代次内 op 严格递增）才允许更新
  slotMeta，旧 ack 不得回退已接纳的 rev；跨代次确认永不更新新槽。
  旧手册“中途返回同槽即接纳 / 迟到 rev 任意同步”已废除。
- 家园迟到 `save`/`conflict` 的 rev 同步只走有序栅栏：
  尚未被新确认超越且仍属当前槽的已提交写 ack 可静默同步 rev/raw
  （维持下一次 `expectedRev` 链不断），但绝不触碰 items/选择/notice/`onSaved`；
  已被超越的旧 ack 一律丢弃。确认成功同步 ref，不等下一次 render。
- 卸载后落盘的 claim：无回调可投递，盘已 `claimed` 且 `claimId` 稳定，
  由集成者以 `claimId` 接收幂等/对账（见 §三）。
- 持久化入口独立校验调用者归属：与目标槽不同 `charId`/版本/活动的
  本地态在触及锁与存储之前拒绝（`owner-mismatch`），零写入、零 intent，
  `missing` 槽不得采用过期跨角色 local。
- 家园场景就绪的 `setStatus(ready)` 保留已存在的保存/恢复 notice，
  不因完成顺序吞提示。

## 三、持久化与备份（不新增主 DB store，不降 v81）

- key：`sully-home3d-{charId}`、`sully-seasonal-halloween-2026-{charId}`，
  均为 localStorage 字符串 JSON，与主 IndexedDB v81 零耦合。
- 家园保存写协议（redesign-v1 真实跨文档互斥，不再是同步 get/compare/set）：
  - 实际公开写入口（全部 async、全部锁内、缺锁 fail closed）：
    家园 `save` / `importModule` / `clearCorrupt`，
    活动 `tryPersistCollect` / `tryClaimPersisted` / `clearHalloweenCorrupt`，
    均在对应稳定资源键（家园 `sully-home3d-{charId}`、
    活动 `sully-seasonal-halloween-2026-{charId}`）的跨文档互斥内执行：
    fresh-read → validate → compare → mutate → save → 写后读回确认，
    整个区间持锁。生产锁 = 同源 Web Locks（`features/room3d/mutex.ts`，
    exclusive）；测试注入共享 `SharedMemoryMutex`（同一实例传给所有参与者
    才算共享）。`load`/`loadMeta`/`exportModule` 为只读，保持同步。
    同步裸 `clear` 已按复审要求移除（唯一的删除路径是锁内重验的
    `clearCorrupt`，无互斥能力返回 `false` 且 0 写入）。
  - 无安全能力（mutex 解析为 null，如缺 Web Locks 的浏览器）时写入口
    一律 fail closed：`save`/`importModule` 返回 rejected（`no-cross-tab-mutex`），
    `clearCorrupt` 返回 false，绝不报假成功、不覆盖旧数据。
  - `loadMeta()` 区分 missing/ok/corrupt/read-error 四态；
  - `save(items, {expectedRev})`：`null` = 仅空槽可写（双实例首次保存只赢一个，
    锁内串行化保证）；字符串 = 当前字节必须逐字节相等，否则 `conflict`
    （失败方永不覆盖胜出方，组件侧自动载入胜出版本并提示）；不传 = 盲写
    （仅兼容旧调用，组件生产路径永远传 rev）；
  - 时间戳单调：`now <= 已存 updatedAt` 时自动抬到 `stored+1`，
    同毫秒/时钟回退不会产生旧版本覆盖问题（版本判定只看 rev，不看时间）；
  - 当前槽 corrupt/read-error 时普通 save 拒绝写入（`corrupt-blocked`/rejected），
    原字节保留，只允许用户显式 `clearCorrupt(charId, expectedRaw)` 后重建
    （clear 同样在锁内重验）。
  - 写后确认：落盘后立即读回比对，逐字节不一致 → rejected（`写后确认失败`），
    调用方按失败处理、提示重试。
- 家园导入排序：已存 ok 且 `incoming.updatedAt <= stored.updatedAt` → `conflict`
  （旧备份不得覆盖胜出版本）；损坏槽允许显式导入恢复；跨槽/非法一律 rejected。
- 活动写入同样走锁（`halloween.ts` 内 `tryPersistCollect`/`tryClaimPersisted`/
  `clearHalloweenCorrupt` 现均为 async，锁键 `sully-seasonal-halloween-2026-{charId}`）：
  1. 锁内先 fresh-read 当前槽位：已 claimed（即使本地态过期）→ 已领取保护，
     收集返回 `already-claimed`（不写盘、不撤销），领取返回 `already-claimed`，
     零新 intent（覆盖双实例/双 tab 过期认领）；
  2. collected 取“盘上与本地并集”再推进，过期本地快照不得覆盖，进度不倒退；
     时间戳同样单调递增；
  3. 损坏/不可读（即使 mount 后才出现）→ `corrupt-blocked`/`read-error`，
     不写盘、不发奖，原字节保留，组件显示保护态；
  4. 写 claimed 落盘（含写后确认）成功后才返回 intent；写失败 → `persist-failed`，
     组件不显示成功、不调用 `onReward`；无互斥能力 → `persist-failed(no-cross-tab-mutex)`。
  5. 同角色同活动终身只成功一次（`claimId = hw2026-{charId}` 稳定），
     失败路径不 emit。
- 导出：`store.exportModule(charId)` 得 `{module:'room3d',version:1,charId,state}`，
  供后续整包备份拼装；导入 `store.importModule(json, charId, {expectedRev?})`
  跨槽/损坏非法一律拒绝且不动现有存档（排序见上）。

## 四、2D 保留与未实现（诚实清单）

- 2D 保留：WebGL 初始化失败（或 `forceFallback`）→ 渲染 `fallback2D` 插槽
  （集成者传入既有 2D 小窝即可），加载失败不挡 2D；Q 版形象读不到可用
  chibi 兜底图时明确显示“沿用 2D 展示”，不伪称完成上游全套 avatar。
- 未实现（留给后续卡，勿当成本卡已做）：
  1. 接入 RoomApp/HomelyHome 的真实入口（附加入口、路由、按钮）；
  2. 真实角色 `chibiStudio` 的生产接线验证（本卡只用 `resolveChibiMarker` 单元验证，
     生产 char  Shape 未动一行）；
  3. `onReward` 之后向货币/捕鱼存档的真实落库（有意留给集成者；
    失败路径责任见 §三，本模块只保证“落盘成功才发 intent”，
    落库幂等由集成者以 `claimId` 去重）；
  4. 资源包机制（`sully-home-resource-packs` 按需再议，本卡零外部资源）；
  5. 日程补全/LLM 调用（本卡零新增 LLM 调用）。
  6. 家具点拖拽位移（pointermove 直接搬家具）的真机截图留给集成卡补；
    本卡已用真实 UI 验证：选中→方向键点移（→→↑）→保存→重开坐标
    (0.4,-0.6)→(0.8,-0.8) 逐字节一致（见 redesign-v1/smoke-redesign.md），
    方向键与点拖拽共用同一 moveItemClamped 钳制路径。

  ## 七、残余风险（诚实声明）

  - 生产 char 的 `chibiStudio` 真实接线未验证（只读 adapter 仅单测覆盖），留给集成卡。
  - 跨 tab/跨文档写保护依赖同源 Web Locks（`navigator.locks`，exclusive）：
    锁内 fresh-read→validate→compare→mutate→save→写后确认全程串行化，
    交错写不再双方成功；但同一浏览器缺 Web Locks（如非安全上下文旧浏览器）
    时写入口 fail closed（明确提示、绝不静默覆盖），该环境需集成者另行处理。
    SharedMemoryMutex 仅用于同进程测试/同 tab，不跨进程。
  - 领取 intent 发出后、集成者落库前的崩溃窗口：盘里已是 claimed，
    重开不会重发（`claimId` 稳定），集成者需以 `claimId` 接收幂等。

## 五、只读 chibi 映射规则

`resolveChibiMarker(charData)`：`vr.img → room.img → like520.img`
（`data:image/` 且长度>32 才算可用）→ `{kind:'sprite',img,slot}`；
否则 `{kind:'fallback2d', reason}`。绝不写回 `chibiStudio.*`。

## 六、性能/生命周期（已实现）

- DPR 上限 1.75；rAF 60fps 节流；`document.hidden` 自动暂停；
  卸载释放 renderer/geometries/materials/textures/listeners（含强制失联兜底）。
- reduced-motion：待机浮动关闭（`matchMedia` 动态监听，运行中切换即时生效，
  已在真机冒烟验证 load 期 reduce/no-preference 与运行中切换无崩溃/持续渲染）；
  按钮过渡沿用全局 `transition-all`（已有 reduced-motion 降级）。
- 触屏：Pointer Events 统一鼠标/触屏（拖家具/拖镜头/滚轮/双指缩放）；
  390px 与 1440px 均验证。
- 组件状态归属：`charId`/`storage` 切换时同一 mounted 实例重载对应槽位
  （A→B→A 不串档，storage 端口切换不把 A 态写入 B）；
- operation-lease-v2（`features/shared/uiOperationLease.ts`，唯一共享协议，
  已替代 charId/storage 身份相等与 saveEpoch）：
  - `slotGeneration` 单调代次：每次已提交的 charId/storage 切换、卸载失效
    时递增；A→B→A 的第二个 A 是新代次，旧租约永不复活；新 manager 实例号
    全局唯一，key 重挂载/StrictMode 重生命周期亦失效；
  - async collect/claim/recover/save 起始 `beginOperation()` 捕获租约，
    迟到结果一律按 `isOperationCurrent` 接纳；同槽新操作
    （`op` 递增）与房间新本地编辑（`notifyLocalEdit` → `edit` 递增）
    使旧 UI 快照失效；旧 save 成功/冲突/失败、旧恢复一律不更新当前
    items/选择/notice/onSaved（旧失败不复活错误，旧恢复不清空新进度）；
  - 跨槽迟到只静默不同步（slotMeta 已属于另一槽）；同槽迟到 save 成功/
    冲突仅静默同步 rev/raw 指针（不断链），绝不碰 items/notice；
  - 已落盘 claim intent 仍按其自带 charId+claimId 投递（同实例仍挂载时），
    卸载后靠盘 claimed+claimId 由集成者对账，绝不发给当前其他角色；
    `mountedRef` 仅用于避免卸载后 setState，绝不代替代次判定。
- 删除恢复写后确认（与保存同一协议）：`clearCorrupt`/`clearHalloweenCorrupt`
  锁内 `removeItem` 后立即读回同一 key，确认为 missing/null 才成功；
  残留字节/删除后读异常/remove 抛错一律 false，不重建默认值、不提示已清除；
  正常存档拒删、`expectedRaw` 比较、无锁拒绝保持。
  场景 effect cleanup 只移除本 effect 追加的 canvas，
  不碰 React 管理的 loading spinner（加载中切换不崩溃）。
