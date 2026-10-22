# 本地记忆（v3.20 Local Memory）实施清单与发布验收

- 代码快照：`/root/SullyOS`（`ethernet`，起点 `4ca9e649`，工作区含本轮未提交改动）
- 状态：**候选**——代码与运行环境已就绪并过门禁；**未 commit、未 push、未 deploy、未重启主后端**
- 上游结论来源：`/srv/model-tests/next-phase/{SECURITY-BACKUP,REMOVE-EXTERNAL-AGENT,LOCAL-EMBEDDING,RERANKER-SELECTION,GPT-SOVITS}.md`
- 集成验收报告：`/srv/model-tests/next-phase/INTEGRATION-CANDIDATE.md`

## 一、已落地（本轮，逐项有回归/读回）

- [x] 主代理挂载本地 embedding 路由：`worker/main-agent/src/index.js` 在 `checkAuth` 之后，精确匹配 `/v1/local-embedding`、`/v1/local-embedding/embeddings`、`/v1/local-embedding/health`（三个路径，`/agent` 前缀兼容）
- [x] 路由安全边界：无匿名（health 也要 token）、上游地址与 key 只来自 env、浏览器自带 `Authorization` 不透传、`body.url/baseUrl` 被忽略（SSRF 回归 7 例）
- [x] main-agent bundle 部署面完整：`scripts/build-workers.mjs` 追加 `src/local-embedding-route.js → worker/main-agent/local-embedding-route.js` 的 verbatim 复制（bundle 是原样副本，缺这条线上直接 `ERR_MODULE_NOT_FOUND`）
- [x] `vps-backend/config/services.js`：main-agent 的 `envKeys` 补 `LOCAL_EMBEDDING_*`（文档用途；实际 env 全量直通）
- [x] `sullyos.service`：增加 `EnvironmentFile=/opt/sullyos/secrets/local-embedding.env`；改前备份（600）、`systemd-analyze verify` 通过、`systemctl show -p EnvironmentFiles` 读回两条；**未重启**
- [x] 向量空间指纹正式收编进 `utils/memoryPalace/types.ts`（`EmbeddingConfig.provider/prefixScheme/modelRevision/task/mrlDimensions`、`MemoryVector.fingerprint`）
- [x] 检索严格指纹分区：`partitionVectorsForQuery`（同维度异模型/异前缀不混检；legacy 只允许云端同名同维度）；`hybridSearch` / `relatedMemories`（含本地快路径）都传指纹
- [x] 写入侧同空间去重：`vectorizeAndStore` 只在同指纹子集里比 0.9 阈值（跨维度不再 throw、跨模型不再误判重复）
- [x] 远端边界：`upsertVector*` 维度不兼容显式 `false` + 告警一次（不是「已同步」）；`searchVectors` 显式报错；远端迁移 SQL 只产出文本，**零 DDL**
- [x] 记忆宫殿 UI：本地模型卡（一键填入不覆盖云配置）、索引状态、重建（可取消/可续/逐条落库、无删除路径）；老数据只标「待重建」
- [x] 外部 agent 退役收尾：`backupSecrets` 的 `opencodeLocal` 死分支与 obsolete 断言删除（旧包导入静默忽略）
- [x] 本机语音如实降级：设置页「MOSS 自建语音」改标「未启用 · 试验未达标」+ 警告；`gpt-sovits-tts` 保持 `disabled`/`inactive`
- [x] 版本号 `v3.20 (Local Memory)`

## 二、门禁（本轮实测，日志在 `/srv/model-tests/next-phase/integration-*`）

- [x] 全量 `pnpm vitest run --minWorkers=1 --maxWorkers=4`：**566 文件 / 6853 用例全绿，EXIT=0**（135.3s）
- [x] `npx tsc --noEmit`：**55 条，0 新增**（按 (文件, 错误码, 消息) 与 `4ca9e649` 逐条比对；基线实跑 56 条）
- [x] `pnpm build:workers` ×2：15 个产物逐文件 sha256 相同
- [x] `utils/mojibakeGuard.test.ts`：1/1
- [x] `npx vite build`：通过（~60s）
- [ ] `pnpm check:workers`：**未提交状态下必红**（脚本按 `git status worker public` 判定）；提交后重跑

## 三、发布前必须做（父代理/发布轮）

- [ ] `git add` 明确路径（**包含新产物 `worker/main-agent/local-embedding-route.js`**），不要 `-A`
- [ ] 提交后重跑 `pnpm check:workers`（应转绿）
- [ ] `git push origin ethernet` → VPS `/opt/sullyos/sullyos-repo` `git pull`
- [ ] `systemctl restart sullyos.service`（这一步同时让新 unit 的 `EnvironmentFile` 与新 bundle 生效）
- [ ] 读回部署面：`ls /opt/sullyos/sullyos-repo/worker/main-agent/` 应有 `local-embedding-route.js`；`curl` 带 token 的 `GET /agent/v1/local-embedding/health` 应 200，无 token 应 403
- [ ] 前端产物 `rsync dist/ → /opt/sullyos/frontend-dist/`，抓 chunk 比对 `v3.20 (Local Memory)` 与「未启用」文案
- [ ] 部署后确认 amsg 进程内 `GOOGLE_BRIDGE_TOKEN` 已是新值（重启前它一直是旧值 → Google 工具 401）

## 四、明确不做 / 仍缺

- 前端备份 ZIP **仍未加密**（口令派生 + AEAD 属下一阶段，本轮不擅加）
- Cloudflare 侧 `GOOGLE_BRIDGE_TOKEN` secret 未同步（本机无 wrangler、无 CF token，无法验证是否部署过）
- 本地 reranker 不接入、不常驻；云 `BAAI/bge-reranker-v2-m3` 保持唯一默认（本地候选未证明更好）
- 本机语音不接通（性能/内存不达标，且缺用户授权参考音频）
- Supabase 远端向量表迁移（768）需用户手工执行 DDL，本轮只给文本方案
