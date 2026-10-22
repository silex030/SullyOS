# SullyOS：可靠记忆、缓存与角色连续生活总体计划

状态：用户已明确批准完整执行；默认护栏须在前端合适位置可自定义。按分阶段验收、发布和回滚实施；真实计费缓存探针仍须先明确调用数与预算，不使用未知凭据盲测。
基线：ethernet / fd4e0926；准备时工作树干净。此前全量测试513文件/6303用例通过，此数字不是本计划实施后的结果。

## 目标

1. 修复已审计的记忆清空、能力选择及备份恢复风险。
2. 保留实时信息完整与新鲜度，扩大实际请求的可复用前缀，真实记录缓存读写而非凭速度猜命中。
3. 记忆协商融入正常对话：猜测不直接成为用户事实、临时状态不直接成为长期偏好。
4. 角色依据经历、兴趣和对话自行形成、调整、暂停低风险虚拟生活工作流；回复与后台生成严格分离。
5. 天气、时间、兴趣、已有计划共同作用于持续生活，允许不行动，不通过频繁消息制造存在感。

## 明确不做

不接入jevos/Laya，不启动本地决策服务；保留隔离试验文件但不自启。暂不做BLE/实体设备、手动“只在此刻”、大规模新App或全仓重构。不冻结天气/时间、不删除记忆换命中、不为了共享缓存扩大权限或合并前后台生成。不静默移动用户自定义预设/深度世界书。不擅自更换模型供应商、读取密钥或调用付费API。

## 已接受的产品约束

- 子代理统一使用用户指定deepseekv4.1flash；必须先核实工具实际可路由的provider及精确model ID。未核实时父代理自行推进，不擅自落回默认模型。
- 当前回复先结束，后台日记等另起请求；后台新增调用是用户接受的限定例外，不是无限调用许可。
- 用户掌握总授权、预算、暂停；角色只能在范围内修改自己的虚拟生活。对外发布、消费、真实资料变更必须另行授权。
- 真实观测、角色推断、角色虚拟经历分层保存。模型不能确认现实发生，也不能替用户确认情绪。
- 不新建另一套AIRP/日记/调度系统：复用utils/airp及worker/amsg/src/autonomy*，补最小契约和落点。

## 执行分期与依赖

### P0：冻结验收基线与安全底座

任务：
- B1 为wipe/highWaterMark补“清空两份水位后旧聊天可重新处理”的失败回归；同时清除对应IndexedDB资产镜像，不清无关assets。
- B2 远端清空结果用成功/失败/跳过显式区分，错误不能显示为0行成功；本地完成、云端失败允许独立重试。
- B3 记忆正文与向量在同一事务提交；故障注入验证旧正文/旧向量同时保留，或新正文/新向量同时生效。失败不得遗留embedded=true的假完成状态。
- B4 能力权限支持显式all/allowlist/none；旧空数组迁移保留原all含义，新的none不得变all，前端和后台同契约。
- B5 备份源由实际服务数据库路径清单生成manifest；部分失败非零退出，不以不完整包轮转最近完整备份。
- B6 恢复先校验manifest和SQLite完整性，停服失败立即退出；复制到暂存位置、保留原库和WAL，失败回滚，不输出假成功。
- B7 主代理未设置token的生产路径fail-closed，显式开发选项才可匿名；不改现有凭据值。先mock鉴权测试，部署配置只核查是否存在，不记录内容。

验收：新增回归先红后绿；故障测试只在临时数据库和fake systemctl/cp上运行；不对生产清空、恢复或注入故障。B5/B6可独立开发，但持久化和权限变更必须先于自主写入启用。

### P1：缓存可观测性（先测得出来）

任务：
- C1 定义allowlist usage结构：普通输入/输出/总token、已确认语义的缓存读/写计数、字段缺失状态；未知不写0。普通字段向后兼容。
- C2 main-agent、amsg即时/自主回程、apiCallLog保留上述字段；按attempt和工具loop分开记录，末轮与总和不混用。实际provider/model用脱敏身份标识记录。
- C3 流式正文完成与usage结束分开；已有正文及时显示，只在后台有界收集尾部usage，保留DONE/超时/不关闭连接的退出路径；不增加自动付费重试。
- C4 在最终发送边界生成稳定段/工具指纹、路径类别、首次差异段、TTFT和总耗时；不持久化原始prompt、凭据、完整endpoint查询参数。
- C5 mock上游验证usage同块/后块/缺失/延迟/多轮/fallback。合成响应仅用于明确标注的测试fixture，不作为真实缓存命中证据。

验收：每条已覆盖路径保留缓存字段，缺失可辨；流式不增加正文首字等待，尾部有界退出；每轮总账可追溯。缓存指标未提供时显示“未提供”，不显示0%命中。

### P2：缓存稳定结构（不牺牲感知）

任务：
- C6 离线fixture拦截最终attemptedBody，mock网络/DB/时钟/随机，捕获后禁止发送；输出完整相同消息数、字节LCP代理和首次差异。只有有精确模板/tokenizer时才报token LCP。
- C7 MCP近期结果、生活实时摘要、契约相对倒计时移到动态尾段；固定说明与持久手册留在固定/低频段。保留钢印最后及排程插入位置。
- C8 固定人设与规则优先，低频背景版本化，动态观测/召回置尾；同一角色、工具权限域内稳定工具名称映射、顺序和schema对象序列化，不重排schema语义数组。
- C9 对stable中的动态宏/关键词及概率世界书提供诊断，不默认改变用户语义位置。保留depth和手动历史上限；历史分块、深度坐标统一列为后续可选改造，不混进本期。
- C10 前台、即时后台及自主任务共用固定角色前缀构造契约，任务目标仍放各自尾部；只在同provider/model/权限域比较，不承诺跨供应商缓存。

验收：仅分钟/天气/任务状态/MCP近期结果变化，固定system指纹不变；正常未满窗追加历史不重写旧消息；工具集合相同而发现顺序变化时暴露名称与规范化schema稳定。保留功能信息清单，回归差异必须解释。不能把离线LCP改善宣称真实命中率改善。

### P3：自然记忆协商

任务：
- M1 扩展记忆候选的来源消息、主体、时间范围、证据等级（用户明确/角色猜测/未决）、短期/长期范围；旧数据迁移不臆造证据。
- M2 在现有正常回复中加入简短协商策略，不额外启动情绪分析请求、不要求每次提问；允许用户主动澄清、拒答、改变话题。
- M3 候选与后续澄清以消息ID及议题绑定；多议题和指代不明确时保持未决，不能将下一句任意回答当确认。
- M4 用户明确纠正时按来源追加修正/失效关系，不抹掉历史经过；暂时疲劳不晋升永久性格。所有写入经过主体、权限和版本校验。

验收：否定、引用、昨日/现在、多角色、用户拒答、重复回调、页面刷新、旧版本备份迁移均有离线回归。正常聊天不新增专门判断调用；不存在固定问卷和强制弹窗。自然程度最终需用户试用，离线测试只能证明数据与流程契约。

### P4：感知事件与生活连续性

任务：
- L1 在现有天气/角色时区/热点/日历/活动入口归一感知事件：source、subject、observedAt、expiresAt、permissions、version、dedupeKey；不新增持续监控。
- L2 本地规则过滤无变化、过期、重复、无权限和无关联候选；只把相关小快照放动态尾段，不让LLM定时回答“现在做什么”。
- L3 扩展AIRP事实/投影与autonomyStore，保存意愿/计划的proposed、scheduled、running、completed、cancelled、failed、unknown状态；实际未完成不转述为完成。
- L4 更新后的计划保留前身与来源；模型可以建议延期/放弃，不用用户日历空白证明空闲，不凭天气或设备轨迹断言用户情绪。

验收：双城市/双时区不串台；过期天气不当当前事实；热点只有标题不声称读完全文；用户离线/任务错过不补发大量积压；虚拟经历与现实观测保持可区分。

### P5：角色自主生活工作流

任务：
- W1 在已有回复/自主轮产物中允许低风险生活工作流提议（目的、触发条件、动作、有效期、来源）；不增加独立前置规划请求，不让用户画流程图。
- W2 规则校验器将模型提议转换为有类型白名单动作；模型文本不是脚本，不允许任意HTTP、shell、权限变更或自我扩展工具。
- W3 复用autonomyScheduler/autonomyFire执行后台生成，与前台请求分离；持久化任务状态、租约、幂等键和预算预留，多设备重报不重复生成。
- W4 用户重新开口取消尚未开始的收尾；运行中的结果可标记不再适用，不假称取消就能撤销供应商计费。未知送达/超时禁止盲目自动重发。
- W5 首版仅开放私人日记、个人计划调整、阅读/兴趣笔记候选；保留现有权限总闸，默认不新增推送，不生成面向用户的“任务完成报告”。
- W6 角色可自然提出修改/暂停自己的习惯；用户可查看来源与记录、全局暂停和恢复，不需要逐次审批低风险动作。

建议首版预算（待用户确认，未配置）：沿用现有更严格上限，新增自主生成最多每角色每日2次、同类动作至少间隔2小时、全局每日最多6次；不累计补跑，不自动重试计费请求。现有token预算继续生效，次数与token双门禁；角色不能自行提高限额。后续依据实际用量再调。

验收：晚安引用/否定不触发；第二次告别不重复；“等等”可中止排队；日记新请求不增加聊天首字等待；故障/刷新/重启/两设备上报不重复执行；未授权对外动作全部拒绝；没有值得做的事允许不生成。

### P6：统一验收与分批发布

- 每批先针对回归，再全量 pnpm vitest run --minWorkers=1 --maxWorkers=4；触碰中文跑mojibakeGuard。
- worker源码变动重建bundle并执行pnpm check:workers；tsc按前后错误集合比较，不只比较数量；构建成功后核查产物。
- 先发布P0及P1/P2，记忆协商和自主生活分别独立开关、默认关闭。部署前保存对应前后端产物、schema版本与数据备份；新增表/字段用向后兼容迁移。
- 经明确授权再做真实缓存验证：先核实当前provider官方规则，约定最大调用数和预算；冷/温配对只改一个变量，按实际cache usage解读，不凭TTFT宣称命中。
- 前端验线上chunk特征，后台验health及实际加载bundle；无真实付费验收时明确写未执行，不以单测代替端到端。
- 每阶段补notes/ethernet-features.md和branch-context；回滚关闭功能开关并恢复兼容产物，不删除新表或用户数据。

## 并行边界

确认子代理模型路由后，可并行B1-B4记忆权限、B5-B7后端安全、C1-C5观测、C6离线fixture准备。chatPrompts/chatRequestPayload/worker/amsg主入口由单一集成人负责，禁止多个代理同时写。M/L/W依赖公共schema先合并再拆叶子；正式门禁由父代理一次运行，子代理不并行跑全量测试。

## Review Focus（最多5项）

1. 流式usage尾部到达与finish/DONE次序：C3/C5负责，必须既不丢字段又不无限等候。
2. 未知计费状态导致重复后台生成：W3/W4负责，unknown不自动重试并保留人工恢复入口。
3. 澄清误绑定到别的议题/角色：M3负责，证据不足保持未决，不写长期事实。
4. 老空白名单与新none迁移冲突：B4负责，前端/worker/备份往返均验证语义。
5. 供应商工具转码与缓存规则不可见：C4/P6负责，无法确认时只报告结构指标，不保证命中比例。

## 批次停止条件

新引入测试失败、触碰文件新增类型错误、usage不保真、后台可能重复计费、权限扩大或不可逆数据迁移未验证，均停止本批发布。已知历史测试抖动须单独重现记录，不能用“存量”掩盖新失败。

## 准备状态与下一步

审计与模型试跑证据：/srv/model-tests/cache-audit-prompt.md、cache-audit-transport.md、comprehensive/REPORT.md。该计划文件是本轮唯一项目改动，不包含实现或部署。待用户确认范围与建议预算后，从P0和P1并行准备进入实现；任何真实计费探针或线上变更再单独明确范围。

---

## 实施验收表（2026-10-22 集成收尾填）

状态口径：**✅ 落地并自测** = 有代码 + 有回归且本轮跑过；**🟡 落地但有保留** = 能跑但语义/入口有已知边界；**⛔ 未做** = 明确没做，原因写在备注。所有门禁的真实数字见 `/srv/model-tests/implementation/FINAL-INTEGRATION.md`。

### P0 安全底座

| 项 | 状态 | 落点 / 证据 | 备注 |
|---|---|---|---|
| B1 清空两份水位 + 只清相关 assets 镜像 | ✅ | `utils/memoryPalace/highWaterMark.ts`、`wipe.ts`；`highWaterMark.test.ts`、`wipe.test.ts` | 镜像删除失败显式抛错，不静默 |
| B2 云端清空成功/失败/跳过三态 + 独立重试 | ✅ | `wipe.ts`（`RemoteWipeOutcome`）、`MemoryPalaceApp.tsx` 结构化展示 + 重试按钮 | 行数未知显示「未提供」，不写 0 |
| B3 正文与向量同事务 + 故障注入 | ✅ | `db.saveNodeWithVector`、`vectorStoreAtomic.test.ts`（5 例） | 失败不留 `embedded=true` 假完成 |
| B4 能力 all/allowlist/none + 旧空数组仍是 all | ✅ | `utils/airp/settings.ts`、`snapshot.ts`、`AirpPanel.tsx`；`capabilityPolicy.test.ts`（19 例） | 前后端同契约；显式 none 不会被迁移成 all |
| B5 备份源由服务配置生成 manifest，不完整不轮转 | ✅ | `db-manifest.mjs`、`backup.sh`；沙箱 6 例 | 只在临时目录 + fake `systemctl`/`cp` 跑 |
| B6 恢复先校验、停服失败即退、暂存/回滚 | ✅ | `restore.sh`；沙箱 9 例（含口令错误不停服、启动失败不谎报） | 未做真实演练（按约束） |
| B7 主代理生产路径 fail-closed | ✅ | `worker/main-agent/src/index.js` `checkAuth`；`auth.test.ts`（5 例） | 默认拒绝；`MAIN_AGENT_ALLOW_ANONYMOUS=true` 仅开发显式开启 |

### P1/P2 缓存

| 项 | 状态 | 落点 / 证据 | 备注 |
|---|---|---|---|
| C1 usage allowlist 契约（缺失≠0） | ✅ | `utils/llmUsage.ts` + 9 例 | 含缓存语义三态 |
| C2 各路径保留字段（前台/amsg 回程/main-agent/调用记录） | ✅ | `apiCallLog.ts`、`cloudUsageMetadata.ts`、`worker/main-agent/src/index.js`、`autonomyResultApply.ts` | 自主回程的心跳用量也带缓存字段（本轮补） |
| C3 流式正文先出 + 尾部有界收 usage | ✅ | `safeApi.ts`（`LLM_USAGE_TAIL_MS`）、`streamUpgrade.ts` | 超时/EOF/DONE 都 cancel，不留悬挂连接 |
| C4 发送边界段指纹/首次差异/TTFT | ✅ | `utils/promptCacheDiagnostics.ts`、`requestPrefixObserver.ts`（接在 `useChatAI` 最终发送处） | 不持久化原始 prompt/凭据 |
| C5 mock 上游覆盖同块/后块/缺失/延迟/多轮 | ✅ | `safeApi.usageTail.test.ts`、`streamUpgrade.usage.test.ts` | 合成响应只作 fixture |
| C6 离线 fixture 拦截 attemptedBody | 🟡 | `utils/chatRequestPayload.cachePrefix.test.ts`（12 例） | 已有相邻请求前缀/LCP 代理断言；未做「完整 attemptBody 捕获 + 禁发送」的独立 harness |
| C7 动态材料后移到尾段 | ✅ | `chatPrompts.ts`（时光契约/生活记录摘要/MCP 近期结果/否决反馈）、`chatRequestPayload.ts` | 世界书与预设位置一律不动；钢印仍最后 |
| C8 工具名映射/schema 序列化稳定 | ✅ | `mcpToolBridge.ts` + `mcpToolBridge.stableOrder.test.ts` | 不重排 enum/required；跨服务器重名归属不变 |
| C9 稳定段动态宏诊断（不改语义位置） | ✅ | `promptCacheDiagnostics.inspectStableShape` | 只诊断 |
| C10 前台/即时/自主共用固定前缀构造 | ✅ | 三条路径同读 `chatPrompts` 的角色前缀 + 各自尾段 | 不承诺跨供应商命中 |

### P3 记忆协商

| 项 | 状态 | 落点 / 证据 | 备注 |
|---|---|---|---|
| M1 证据等级/主体/时间范围/来源 + 旧数据不臆造 | ✅ | `memoryPalace/negotiation*.ts`、`extraction.ts` | 旧记录落 `unrecorded`，不补造 |
| M2 正常回复内协商（零额外请求） | ✅ | `chatRequestPayload.ts` 9f 固定文案（开关关时不注入） | 无问卷、无弹窗 |
| M3 消息 ID + 议题绑定，证据不足保持未决 | ✅ | `negotiationResolve.ts`、`negotiationEvidence.test.ts` | 无关键词启发式（`grep` 已核） |
| M4 纠正追加失效关系、短期不升级 | ✅ | `negotiationLedger.ts`、`negotiationProvenance.test.ts` | 原正文保留 |
| 开关与前台读法一致 | ✅ | `getMemoryNegotiationGate`（dev override > 正式 config > 旧 key > 默认关）、`resolveMemoryNegotiationEnabled` | 本轮补上缺失的 `resolveMemoryNegotiationEnabled` 导出（`chatRequestPayload`/测试都在等它） |

### P4/P5 感知与自主生活

| 项 | 状态 | 落点 / 证据 | 备注 |
|---|---|---|---|
| L1 感知事件归一（source/subject/时间/权限/去重键） | ✅ | `utils/airp/perception.ts`（13 例） | 零额外请求 |
| L2 本地过滤 + 只放相关小快照到动态尾段 | 🟡 | `perceptionPrompt.ts`（10 例）已接进 `chatPrompts` 动态尾段 | **当前三条路径上该段恒为空**：天气/热搜/日程/当前槽位都已由既有段落渲染，按「禁止重复注入」只能缺席省略；只有「现拉失败但缓存还在」才会出内容 |
| L3 计划状态机 proposed→…→unknown + 来源/证据 | ✅ | `lifeWorkflow.ts`、`autonomyStore.ts`（D1 表）、`AutonomyPanel` 客户端记录 | unknown 是终态 |
| L4 前身/来源保留，不用日历空白证空闲 | ✅ | `predecessorId`、提示词边界句 | — |
| W1 在已有生成里提提议（不新增前置规划请求） | ✅ | `autonomyFire`（回合内 `workflows`）+ 聊天工具 `propose_life_workflow` | 聊天工具本轮才真正接线（模块补写 + 路由 + 客户端方法 + 工具循环） |
| W2 白名单动作校验器（禁 URL/代码/权限/预算/情绪断言） | ✅ | `validateAutonomyWorkflowProposal` + 23 例 | 键闸与文本闸都过；报错更具体的那一句 |
| W3 复用调度器执行 + 幂等/租约/预算预留 | ✅ | `autonomyScheduler.runAutonomyPlanQueue`、`autonomyFire.handleWorkflowOutput` | 与前台请求分离 |
| W4 用户开口取消 pending；运行中不假称撤销 | 🟡 | `cancelPendingAutonomyPlans`（只 pending）、`isCancelableByUserSpeech` | running 中途无法取消（无可靠信号入口），已在代码注释里写明 |
| W5 只开私人日记/计划/兴趣笔记，默认不推送 | ✅ | `lifeWorkflowPermissions`、`emitResult` 默认 `show:false` | 不生成「任务完成报告」 |
| W6 用户可查看来源与记录、全局暂停/恢复 | ✅ | `AutonomyPanel`「TA 自己的小事」+ 设置页全局护栏（云端权威 + 回读确认） | 人工重试 HTTP 入口未做（store 已导出 `retryAutonomyPlanManually`） |

### P6 门禁

| 项 | 状态 | 证据 |
|---|---|---|
| 全量 `vitest --minWorkers=1 --maxWorkers=4` | ✅ | 见 FINAL-INTEGRATION.md（本轮两次全量，末次 0 失败） |
| `tsc --noEmit` 按错误集合比较 | ✅ | 55 条存量、键集合与基线完全相同（0 新增 / 0 消失） |
| `build:workers` + `check:workers` | 🟡 | 构建 OK；`check:workers` 按 `git status worker public` 判定，**未提交时必红**，用「重建前后 bundle sha256 相同」等价验证 |
| `vite build` + 产物特征 | ✅ | 构建成功；`dist` 内含 `propose_life_workflow` / `TA 自己的小事` / `v3.19 (Grounded Life)` |
| `mojibakeGuard` | ✅ | 全仓源码无 U+FFFD |
| 真实计费缓存探针 | ⛔ | 按约束未执行（无授权、无预算）；离线只报结构指标 |

---

## 发布候选收尾验收表（2026-10-22 最终集成轮填）

口径同上：**✅** = 有代码 + 有回归且本轮跑过；**🟡** = 落地但有已知边界；**⛔** = 明确没做。
真实门禁数字、产物哈希与回滚计划见 `/srv/model-tests/implementation/RELEASE-CANDIDATE.md`，
RED（缺陷层证据）见同目录 `final-candidate-red.log`。

| # | 要求 | 状态 | 落点 / 证据 | 备注 |
|---|---|---|---|---|
| 1 | 记忆协商：后台改用前台统一 gate；正式 false 高于旧 localkey；严禁循环 import；保留 explicit 语义 | ✅ | `utils/memoryPalace/negotiation.ts` 委派 `getMemoryNegotiationGate()`；`negotiationGate.test.ts`（12 例，含「config false 压过 localkey」「config 读坏不回落」「前台叶子零 import」） | 诊断来源改为诚实三态：无配置 = `default_off`（不再冒充 `feature_flag`） |
| 2 | 导入成功后清协商账本；失败不谎报；`db.ts` 独立导入路径同样清（幂等） | ✅ | `context/OSContext.tsx` importSystem 收尾、`utils/db.ts` `importFullData` 末尾；`db.importLedger.test.ts`（4 例，真 localStorage + 真 IndexedDB 往返） | 清不掉单独 toast 说明，导入本身仍继续（不因清理失败回滚已写数据） |
| 3 | 角色面板全局提示改权威快照；unknown 不显示 6；0 语义同契约；refresh 对象/状态类型各消费者适配 | ✅ | `AutonomyPanel` 改 `getGlobalGuardrailsSnapshot()` + 「后台未确认」；`AutonomyPanel.guardrails.smoke.test.tsx`（3 例，断言不含「每天最多 6 次」） | 设置页原本就按对象消费 `refresh`（`status/value/error`），本轮复核无需改 |
| 4 | 角色上下文能看到 pending 计划的真实 id/标题/可取消状态；cancel/replacement 后本地对账且有查看入口；同一条用户消息不误撤 | ✅ | `utils/airp/pendingPlansPrompt.ts` + `chatPrompts` 动态尾段（零请求）；`chatLifeWorkflowClient` 写/撤/替换对账本地 `airp_workflow_plans`；`fire_pack.lastUserMessageId` + `isCancelableByUserSpeech(…, {lastUserMessageRef})`；`AutonomyPanel` 显示「撤不了」原因 | `running` 如实标「撤不了」；面板状态标签本来就有 `cancelled: '不做了'` |
| 5 | 人工重试新 id 不清旧 run；released 行不破坏审计；旧 task payload 不执行新计划；超时 unknown 不自动重试 | ✅ | `autonomyStore` released 行改名让位（不 DELETE）；`autonomyFire.test.ts` +2（旧代 payload 只看到自己；unknown 不复跑）；`planLifecycle.wiring.test.ts`（4 例扫源码：无人自动调用重试、到点队列只捞 proposed） | 人工重试仍无 HTTP 入口（按上轮取舍），store 层语义已被钉住 |
| 6 | 全局状态多设备 TOCTOU 防解暂停：专用鉴权 patch 路由 / 原子条件写 / 明确解暂停意图；有回归证明 | ✅ | `worker/amsg/src/guardrailPatch.ts`（D1 CAS + 暂停粘性）、`index.ts` 新增 `POST /autonomy-guardrails/patch` 与泛写闸、`ActiveMsgClient.patchGlobalGuardrails`、transport 优先走专用路由；`guardrailPatch.test.ts`（13 例，真 node:sqlite，含并发 + LWW 对照组） | 泛写闸对「云端读坏」也拒写；老客户端不会再静默解暂停 |
| — | 全量门禁（vitest / tsc / build:workers / mojibake / vite build） | ✅ | `final-candidate-vitest-full.txt`（561 文件 / 6854 用例）、`final-candidate-tsc-2.txt`（55 条，集合与基线逐条相同）、`final-candidate-build-workers-{1,2}.log` + bundle 同哈希、`final-candidate-mojibake.log`、`final-candidate-vite-build.log` | `check:workers` 未提交必红（脚本口径），提交后重跑 |
| — | 真实计费缓存探针 / 真实恢复演练 | ⛔ | — | 无授权、无预算；按约束不做 |

### 最终发布轮（提交 / 部署 / 上线读回）

| 项 | 状态 | 证据 |
|---|---|---|
| 发布前最后两个硬阻断（retry 新代去重键 / owner 未解析 fail-closed） | ✅ | `autonomyRetry.sqlite.test.ts` 2/2（真 UNIQUE，先红后绿）、`autonomyFire.test.ts` 53/53 |
| 恢复多目录落点 + `verify --registry` 必填全集 | ✅ | `vps-backend/deploy/scripts/__tests__` 56/56（`unshare -m -n` 沙箱，生产库只读快照无变化） |
| 发布门禁 | ✅ | 全量 `562 文件 / 6869 用例`、`tsc` 55 条 0 新增、`build:workers` 同哈希 `bbdc966e…`、`mojibakeGuard` 1/1、`vite build` 通过、`check:workers` 提交后 exit 0 |
| 提交 / push / 部署 / 线上读回 | 📄 | 见 `/srv/model-tests/implementation/RELEASE-RESULT.md`（含 commit SHA、远端 HEAD、deployed SHA、chunk sha256） |
