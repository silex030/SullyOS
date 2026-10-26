# t_8a040287 · 链接摘录工具最终返工修复合入报告

执行者：ds-executor（模型 deepseek-v4.1-flash / provider opencode-go，钉在本卡 override 上，未切换）
执行时间：2026-10-26 19:50–20:2x +08:00
worktree：`D:\hermesspace\repo\SullyOS\.worktrees\t_8a040287`（分支 `sullyos/t_8a040287`）

## 1. 结果

| 项 | 值 |
| --- | --- |
| 合并提交 | `23952eb6cc8fa949a2a8c54c9be30ec36df40c98` |
| 父提交 1（ethernet 主干） | `8e597e1b6d203306dc04dfc0ea66f6f6eafc6eb9` |
| 父提交 2（最终返工修复） | `e5fa570b16a4fbc973ea238a3f265acd9bd3daeb` |
| 工作树状态 | clean（`git status --porcelain` 空） |
| GitHub 分支 tip | `23952eb6`（`refs/heads/sullyos/t_8a040287`，已 `ls-remote` 读回） |
| GitHub `ethernet` | `8e597e1b`（**未动**，合入/部署留给末卡按闸门执行） |
| 相对 ethernet 父 | 16 文件 +3168/−184 |
| 相对修复父 | 37 文件 +3538/−483（保留 ethernet 侧地图/语音/自主生活等） |

合并方式：真双父合并（非整分支覆盖），6 个冲突文件逐个三方合并。

## 2. 冲突解决口径（保留双方真实意图）

| 文件 | 处理 |
| --- | --- |
| `utils/socialShare.ts` | 保留 ethernet 的外部内容低信任隔离（`EXTERNAL_UNTRUSTED_NOTICE` / `externalBlockOpen` / `sanitizeExternalText` / `wrapUntrustedContent`）、字幕语义提示、A‑B‑A 全 span 倒序替换；套用本轮修复：`renderShareCardProjection` 与 `buildShareMessageProjection` 的模型可见标识一律用**完整 shareRef**。`shortShareRef` 降级为仅 UI（`components/chat/SocialShareCard.tsx` 角标）。 |
| `utils/socialShareTool.ts` | 整块采纳修复（引用解析 exact > 唯一前缀 > 歧义拒绝 / 无锚读取前拒绝 / 逐次成对落库 Recorder+Outbox / 不按条数截断 / dispatch 收口），并保留 ethernet 的外部内容净化与低信任块包裹（`segmentLine` 净化、片段整体包裹、未信任开销计入单次额度以免硬切掉闭合标记）。 |
| `hooks/useChatAI.ts` | 采纳修复（`prepareShareExcerptTurn` 三道门、`ShareExcerptPairRecorder` 走 `DB.updateMessageMetadataCommitted`、逐次 `dispatchShareExcerptToolCall` 落库、成功尾部 + finally 双收尾 `flush`、`resolveChatToolLoopBudget`）；保留 ethernet 的排程工具降级提示；删除因锚点改造失去唯一使用点的 `const turnStartedAt = Date.now()`（1 行）。 |
| `utils/db.ts` | 新增 `updateMessageMetadataCommitted`：以 `transaction.oncomplete` 才算写成功，`onerror`/`onabort` 均 reject。 |
| `docs/social-content/integration-v1.md` | 两侧文档合并（ethernet 侧隔离章节 + 本轮修复章节都在）。 |
| `utils/socialShareTool.test.ts` / `wiring.test.ts` | 取修复侧用例；wiring 钉 hook 的传参形状与「必须用 committed saver」。 |

**未丢 ethernet 行为（逐行核对）**：把 ethernet 相对基线 `259626ae` 新增的每一行拿到合并结果里做整行匹配——
`utils/socialShare.ts` 94/94 在、`docs/.../integration-v1.md` 393/393 在、`hooks/useChatAI.ts` 141/143 整行命中；
剩余 2 行是同一处状态文案（`'🔌 [MCP] …'` / `'🔗 [分享] …'`，见 `hooks/useChatAI.ts:1590-1591`）因缩进变化未整行匹配，内容与位置均在。

## 3. 定向验证（本卡实跑，未跑全量、未开服务、未部署）

| 命令 | 结果 |
| --- | --- |
| `npx vitest run utils/socialShareTool.test.ts utils/socialShareTool.wiring.test.ts utils/chatToolLoopBudget.test.ts utils/socialShare.test.ts utils/messageFormat.share.test.ts` | **5 files / 113 tests passed**，EXIT=0（提交后复跑一次，同样 113 passed；stderr 两行为用例故意制造的「待补偿」日志） |
| `npx tsc -p tsconfig.json --noEmit` | **56 error TS = 既有基线**（与卡面/前序记录一致），**改动文件 0 错误**（`utils/socialShare*`、`utils/chatToolLoopBudget*`、`utils/db.ts`、`hooks/useChatAI.ts`、`utils/messageFormat.ts` 均无 error 行） |
| `git ls-remote`（VPS 侧对 GitHub） | `sullyos/t_8a040287 = 23952eb6`、`ethernet = 8e597e1b` |

## 4. 六项定向验收 ↔ 用例

| 验收项 | 落地/证据 |
| --- | --- |
| ① 完整引用可消歧 | `resolveShareExcerptTarget`（exact > ≥8 字符唯一前缀 > 歧义拒绝并给候选，绝不猜）＋投影用完整 ref。用例：`可见标识 = 可执行标识（返工 P1 第 1 条）` 4 例（含同 12 字符前缀两卡、唯一前缀命中、形状不合法）。 |
| ② 本轮锚点失败时不读旧内容 | `pickShareExcerptTurnAnchor` 只认最后一条非 system 触发消息，id 不合法即 null（不回退更早消息）；`prepareShareExcerptTurn` 无锚 → 不注入；`dispatchShareExcerptToolCall` 无锚 → `HISTORY_UNAVAILABLE`，预算/网络前返回。用例：`旧消息在库里、最新触发消息没 id：不注入、零请求、旧消息 metadata 一字不改`、`id 非法（0/非数字）同样不读`、`没有确定锚点：读取前就拒绝（零请求零落库）`。 |
| ③ 事务 commit 后成功 | `DB.updateMessageMetadataCommitted`（`transaction.oncomplete`）；hook 的 `savePairs` 只走该入口（wiring 断言正则）。用例：`正常路径：dispatch → 事务提交后成对记录在真实库里读得回来`、`put/提交失败（事务 abort）：reject 且不算已保存，生产 flush 补偿后读回`。 |
| ④ 待补偿队列隔离 | `ShareExcerptPairOutbox` 以（锚点, toolCallId）为键，跨轮共享；失败批次按原锚点重试、不串轮、不误清。用例：`两轮并发各写各自触发消息：同 toolCallId 也不串轮`、`旧锚点失败 call_1 + 新锚点同 id call_1：两份都写回各自消息`、`共享队列跨轮补偿：往轮失败批次写回后本轮进度不影响它`。 |
| ⑤ 超过 8 条历史 | `attachShareExcerptPairs` 去掉 `pairs.slice(-8)`/`SHARE_EXCERPT_RECORD_KEEP`，改按 toolCallId 幂等去重；outbox 单消息上限 16→256。用例：`成功读取不被「同参重复 + 超次数」挤出历史：9 条 pair 全部在库里`、`成对记录不再按条数截断（12 条都在）`、`待补偿队列单消息上限高于一轮可能产生的记录数（20 条不被挤掉）`。 |
| ⑥ 混合工具预算 | `utils/chatToolLoopBudget.ts::resolveChatToolLoopBudget`（MCP→max(设置,12)；分享单独在场→min(设置,4)；混用/无分享→原值），hook 传六类工具标志。用例：`utils/chatToolLoopBudget.test.ts` 11 例（含 `maxToolLoops=1` 混用只跑 1 轮、12 轮保持 12、分享-only 5 轮链只发 4 次）＋ wiring 钉 hook 走该函数。 |

## 5. 未验证 / 残余风险

1. **未合入 ethernet、未部署**（按卡面闸门：部署只在末卡）。下一步需要末卡把本分支 tip（`23952eb6`）合入 `ethernet` 后再构建/部署/开 `SHARE_LINKS_ENABLED`。
2. 未跑全量 vitest / `vite build` / 真浏览器 e2e（卡面禁止；需要真 worker + SQLite）。
3. `tsc` 56 个既有基线错误未修（非本卡验收项，改动文件 0 错误）。
4. 低信任块边界标记里的 `share=` 仍是 12 字符短引用（ethernet 侧既有格式）。它只是边界标签；模型若误抄该前缀，工具按前缀规则解析——唯一则命中、多卡同前缀则 `SHARE_REF_AMBIGUOUS` 明确拒绝，不会串卡。未改成完整 ref 以免改动 ethernet 既有隔离格式与其测试。
5. 待补偿队列与「已写成功」集合仍是进程内内存结构：应用重启后未落库记录会丢（丢时 `console.error` 明确可见）。
6. 真实供应商模型是否主动调用该工具仍未验证（fixture 链路）；平台真实内容（B 站 412 / 抖音登录墙 / XHS 停用）仍只会如实返回失败。
7. 本卡仅改上述文件；未触碰 worker 产物、未改任何 profile/config/approvals/kanban 配置，未启动网关。

## 6. 附：为推送 GitHub 所做的最小环境动作

本机 `origin` 是 VPS 仓库（ssh），GitHub 推送路径在 VPS 侧（`git@github-sullyos` 别名 + `id_ed25519_github_sullyos`）。
VPS 的 `~/.ssh/known_hosts` 原本没有 `github.com` 条目，导致 `Host key verification failed`；本次用
`ssh-keyscan` 取回 github.com 的 rsa/ecdsa/ed25519 公钥，并**与 `https://api.github.com/meta` 公布的
公钥逐字节比对一致**（ed25519 sha256 `f83898df…`、rsa sha256 `b8d895ce…`）后才追加进 known_hosts
（旧文件已备份为 `known_hosts.bak-t8a040287`）。只推了本卡分支，未推 ethernet。
