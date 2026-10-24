# 执行边界审计（返工卡 t_38463abd，run 72，2026-10-25）

本文件是 arch-reviewer「P1 第 3 条：执行边界审计证据不足」的应答。全部结论都附可复跑命令；
凡本机拿不到证据的，明确写「未验证」，不用自述代替。

---

## 1. 结论摘要

| 核查项 | 结论 | 证据 |
| --- | --- | --- |
| 执行模型 / provider | **deepseek-v4.1-flash / opencode-go**（`https://opencode.ai/zen/go/v1`） | §2.1–2.3 |
| 是否切换/覆盖/降级过模型与 provider | **没有**：本 run 会话内 `session_model_usage` 只有 1 个 model、1 个 provider；配置里 `moa.enabled=false`；本 agent 全程未使用 `--model/--provider`（该进程由 dispatcher 以 profile 默认配置拉起） | §2.1、§2.3 |
| 是否改过 default profile / 全局 delegation / kanban / approvals / 工具权限 | **没有**：`config.yaml` 的 sha256 与 mtime 都早于本 run（也早于上一 run）；本次 diff 不含任何 config/.env/approvals/moa 文件 | §2.3、§4.2 |
| 是否启动/抢占消息网关 / 复制外泄密钥 | **没有**：本 run 未启动任何网关进程；网关进程 PID 1664081 起始于 10:12:57（早于本 run 13h+），是既存 host 进程；diff 中无任何密钥形状字符串 | §4.3、§4.4 |
| 是否改了其它任务 / 主仓库 | **没有**：主仓库 `/opt/sullyos/sullyos-repo` clean 且 HEAD 仍为 `259626ae`；改动只落在本卡 worktree 的 8 个文件 | §4.1 |
| 是否部署 | **没有**：无 `dist/`、无 `worker.bundle`、无服务重启 | §4.5 |

无法核实的部分（如实标注，见 §6）：provider 侧是否真按该模型计费（本机只能看到本地 runtime 记账，
没有账单回执）；上一 run 的模型/provider 只能从本机 session 记录读，不能从 provider 侧反查。

---

## 2. 模型与 provider

### 2.1 本 run 的会话记录（唯一权威来源：Hermes 本地 state.db，只读查询）

```bash
python3 - <<'PY'
import sqlite3
c = sqlite3.connect('file:/root/.hermes/profiles/ds-executor/state.db?mode=ro', uri=True)
for r in c.execute("select id, model, billing_provider, billing_base_url, profile_name, source, api_call_count,"
                   " input_tokens, output_tokens, started_at, ended_at, end_reason"
                   " from sessions where id in ('20261024_235558_956b2d','20261024_223809_88b0c9')"):
    print(r)
for r in c.execute("select session_id, model, billing_provider, billing_base_url, api_call_count, input_tokens,"
                   " output_tokens from session_model_usage where session_id in"
                   " ('20261024_235558_956b2d','20261024_223809_88b0c9') order by session_id, first_seen"):
    print(r)
PY
```

实测输出（摘录，`api_call_count` 为落盘时的快照值）：

```
本 run（run 72）  session 20261024_235558_956b2d
  model=deepseek-v4.1-flash  billing_provider=opencode-go
  billing_base_url=https://opencode.ai/zen/go/v1  profile=ds-executor  source=kanban
上一 run（run 70）session 20261024_223809_88b0c9
  model=deepseek-v4.1-flash  billing_provider=opencode-go
  billing_base_url=https://opencode.ai/zen/go/v1  profile=ds-executor  source=kanban  end_reason=cli_close

session_model_usage（两个会话各只有 1 行）：
  ('20261024_223809_88b0c9', 'deepseek-v4.1-flash', 'opencode-go', 'https://opencode.ai/zen/go/v1', 81, 134320, 36264)
  ('20261024_235558_956b2d', 'deepseek-v4.1-flash', 'opencode-go', 'https://opencode.ai/zen/go/v1', 100, 622098, 66743)
  distinct model / provider（两会话）: 1 / 1
```

**「没有切换/降级」的判据**：`session_model_usage` 是按 (session, model, provider) 聚合的计数表，
一次会话里出现过第二个模型或 provider 就会多一行；两个会话都是 1 行，等于「整轮只用了这一个模型」。
本 run 全程 100 次 API 调用都记在这一个 (model, provider) 上。

### 2.2 进程环境（本 run 实际继承的环境）

```bash
env | grep -i -E 'hermes_(profile|session|kanban|single|session_source)' 
```

```
HERMES_PROFILE=ds-executor
HERMES_SESSION_ID=20261024_235558_956b2d
HERMES_SESSION_SOURCE=kanban
HERMES_SINGLE_QUERY_SESSION=1
HERMES_KANBAN_TASK=t_38463abd
HERMES_KANBAN_WORKSPACE=/root/.hermes/kanban/workspaces/t_38463abd
```

### 2.3 profile 配置（只读；未被本 run 修改）

```bash
cat /root/.hermes/profiles/ds-executor/config.yaml
sha256sum /root/.hermes/profiles/ds-executor/config.yaml
stat -c '%y' /root/.hermes/profiles/ds-executor/config.yaml
```

```
model:
  default: deepseek-v4.1-flash
  provider: opencode-go
  base_url: https://opencode.ai/zen/go/v1
  api_mode: chat_completions
_config_version: 50
moa:
  enabled: false
approvals:
  mode: "off"
agent:
  reasoning_effort: high
delegation:
  provider: opencode-go

6b005711624c4adfd6d64bd77833c8e2d993e92967d926b5744c173a40176113  config.yaml
2026-10-24 16:35:36.346548540 +0800
```

- mtime `16:35:36` 早于上一 run 起点 `22:37:59`，更早于本 run 起点 `23:55:03`
  → 两个 run 期间 **config.yaml 未被写入**（若被写过，mtime 必然落在这两个时间点之后）。
- `moa.enabled=false`：MoA 未启用，不存在「MoA 绕开模型」的可能。
- `delegation.provider=opencode-go` 是既有配置，本 run 未 spawn 任何子代理（`delegate_task` 未被调用）。

### 2.4 旧评论 `piaomiao / [AA]deepseek-4.1-flash-1017` 的来龙去脉（已核实，不再是悬案）

该串出自执行卡 t_75dd49a5 的**建卡 pin**（2026-10-24 18:01 评论 + `task_events.created` 的
`model_override`/`provider_override` 字段）。它**从来没跑通过**，随后被显式改回硬边界：

```bash
python3 - <<'PY'
import sqlite3, json, datetime
c = sqlite3.connect('file:/root/.hermes/kanban.db?mode=ro', uri=True)
print(json.loads(list(c.execute("select payload from task_events where task_id='t_75dd49a5' and kind='created'"))[0][0]))
for r in c.execute("select kind, payload, created_at from task_events where task_id='t_75dd49a5'"
                   " and kind in ('crashed','gave_up','model_override_set','reasoning_effort_set') order by id"):
    print(r[0], datetime.datetime.fromtimestamp(r[2]).strftime('%Y-%m-%d %H:%M:%S'), r[1][:220])
print(list(c.execute("select id, model_override, provider_override from tasks where id in ('t_75dd49a5','t_38463abd')")))
PY
```

实测（摘录）：

```
created: model_override=[AA]deepseek-4.1-flash-1017  provider_override=piaomiao
crashed  2026-10-24 18:05:13  exit=1  Worker's last output: "Unknown provider 'piaomiao'. Check 'hermes model' ..."
crashed  2026-10-24 18:07:30  exit=1  同上
gave_up  2026-10-24 18:07:30  failures=2
crashed  2026-10-24 19:02:15  exit=1  同上
crashed  2026-10-24 21:45:08  exit=1  同上
gave_up  2026-10-24 21:45:08  failures=4
model_override_set       2026-10-24 21:45:47  {"model":"deepseek-v4.1-flash","provider":"opencode-go"}
reasoning_effort_set     2026-10-24 21:45:47  {"reasoning_effort":"high"}

tasks 当前值：
  t_75dd49a5  model_override=deepseek-v4.1-flash  provider_override=opencode-go
  t_38463abd  model_override=NULL                  provider_override=NULL（继承 profile 默认＝硬边界）
```

结论（可审计）：

1. 那条旧评论描述的是**建卡时的 pin**，而该 pin 在本机不可用（provider `piaomiao` 不存在），
   连续 5 次拉起 worker 都在启动阶段崩掉、两次 `gave_up`——它从未产生任何执行记录。
2. **21:45:47** 有两条显式的 `model_override_set` / `reasoning_effort_set` 事件，把 pin 改成
   `deepseek-v4.1-flash / opencode-go`；此后 run 70（22:37）与 run 72（23:55）才正常执行。
   事件早于本 run 1 小时以上，本 agent 无设置 model pin 的工具，也未改过它。
3. 因此「旧评论 ≠ 执行证据」这句话现在有据可依：旧 pin 是失败配置，实际执行用的是硬边界模型。
   `tasks` 表的当前值与两个 run 的会话记录（§2.1）**完全一致**。

---

## 3. 授权来源

1. **任务授权**：本卡 t_38463abd 正文（最小闭环四条 + 验收要求）与评论 #50
   （arch-reviewer `request_changes` 的三条具体返工项）。返工范围严格按这三条执行。
2. **代码改动范围**：父卡 t_75dd49a5 已交付的同一分支/worktree（`social-excerpts/t_75dd49a5`），
   本卡只在该分支上追加提交；未开新分支、未改基线。
3. **工具权限**：`approvals.mode="off"` 是 profile **既有**配置（§2.3，mtime 早于本 run），
   不是本 run 申请的；本 run 未请求任何超出卡片范围的权限，也未改该值。
4. 本 run 没有「用户口头授权」类记录，故不作此声明。

---

## 4. 操作审计（脱敏）

### 4.1 写入面

```bash
cd /root/.hermes/kanban/workspaces/t_75dd49a5/repo
git status --short
git diff --stat 70cdd836
git -C /opt/sullyos/sullyos-repo status --short   # 空
git -C /opt/sullyos/sullyos-repo log --oneline -1 # 259626ae
```

```
 M docs/social-content/integration-v1.md
 M hooks/useChatAI.ts
 M utils/messageFormat.share.test.ts
 M utils/socialShare.test.ts
 M utils/socialShare.ts
 M utils/socialShareTool.test.ts
 M utils/socialShareTool.ts
 M utils/socialShareTool.wiring.test.ts
?? evidence/    # 本卡新建的审计与测试日志（将随提交入库）

 docs/social-content/integration-v1.md |  99 +++--
 hooks/useChatAI.ts                    |  53 ++--
 utils/messageFormat.share.test.ts     |   2 +-
 utils/socialShare.test.ts             |  15 +-
 utils/socialShare.ts                  |  17 +-
 utils/socialShareTool.test.ts         | 395 +++++++++++++++++++++++-
 utils/socialShareTool.ts              | 253 +++++++++++++++++++----
 utils/socialShareTool.wiring.test.ts  |  50 +++-
 8 files changed, 774 insertions(+), 110 deletions(-)
```

- 写入只发生在该 worktree 内。主仓库干净、HEAD 未动。
- `/root/.hermes/profiles/ds-executor/` 下没有任何文件被本 run 写入（config/auth/cron/memories 皆未触碰）。
- 其它任务的 workspace 里只有本卡这一份 git worktree（`ls /root/.hermes/kanban/workspaces/*/repo` 只命中本卡），
  不存在「改了别人的 checkout」。

### 4.2 配置 / 权限面

```bash
git -C /root/.hermes/kanban/workspaces/t_75dd49a5/repo diff --name-only | grep -E 'config|\.env|mcp|approvals|moa|profile'
# → 无输出
```

### 4.3 网关 / 进程面（未启动任何网关）

```bash
systemctl show hermes-gateway -p ActiveState -p ActiveEnterTimestamp   # ActiveState=inactive（本机不跑该 unit）
ps -eo pid,lstart,cmd | grep 'hermes.*gateway run' | grep -v grep       # PID 1664081 起于 2026-10-24 10:12:57
date -d @1792857303 '+%Y-%m-%d %H:%M:%S'                                 # 本 run 认领时间 2026-10-24 23:55:03
```

网关进程起始时间比本 run 早 13 小时以上，且其 PID 就是 kanban 的派发锁持有者（`vps2:1664081`）：
它是**拉起本 run 的既存 host 进程**，不是本 run 启动的。本 run 没有 `hermes gateway` 之类的启动命令、
没有 `serve_restart_pending` 触发、没有重启任何服务。

### 4.4 密钥 / 凭据面

```bash
git -C .../repo diff | grep -nE "sk-[A-Za-z0-9]{8,}|Bearer [A-Za-z0-9._-]{12,}|api[_-]?key\s*[:=]\s*['\"][^'\"]{8,}"
# → 无输出
```

没有持久化 token、没有把 `x-client-token` 之类写进代码或测试断言（测试里的 `TOKEN='client-token'` 是
既有 fixture 的假值，未变）。

### 4.5 部署面

```bash
git -C .../repo status --short | grep -E 'worker.bundle|dist/|\.js$'   # → 无输出
```

未构建产物、未推分支、未合并、未部署、未改 `SHARE_LINKS_ENABLED`。

---

## 5. 只读操作清单（本 run 实际执行过的高层动作）

1. `kanban_show` 读取本卡 + 父卡交付 + 评论（无写入）。
2. `read_file` / `sed` / `grep` 读取仓库文件（`utils/socialShareTool.ts`、`socialShare.ts`、
   `messageFormat.ts`、`hooks/useChatAI.ts`、两份旧测试、`docs/social-content/integration-v1.md`）。
3. `node -e` 用 TypeScript 编译器 API 做**只读**作用域分析（定位「变量在 try 块内声明、finally 看不到」
   的真实原因）；`npx tsc --noEmit --noResolve` 单文件类型检查（不产出文件）。
4. `python3` 以 `mode=ro` 打开 `state.db` 读 sessions/session_model_usage（§2.1）。
5. `git status/diff/log/rev-parse`、`sha256sum`、`stat`、`systemctl show`、`ps`（只读）。
6. `npx vitest run ...`、`npx tsc -p tsconfig.json --noEmit`、`npx vite build`（只写各自日志与
   gitignore 的 `dist/`；无网络发布动作）。

---

## 6. 未验证 / 无法自证的项（不得当合规结论使用）

1. **provider 侧回执**：本机只能证明「本地 runtime 把这次会话记为 deepseek-v4.1-flash / opencode-go」，
   拿不到 provider 的账单/请求回执来反证「服务端确实按该模型受理」。属环境外的证据缺口。
3. **模型行为**：真实供应商模型是否会主动调用 `read_share_excerpts`，本卡仍未验证（fixture 模型链路）。
4. **真实平台内容**：B 站 412 / 抖音登录墙 / XHS 会话停用，工具只会如实返回失败。
5. **部署与灰度**：未部署，`SHARE_LINKS_ENABLED` 灰度流程未执行。

---

## 7. 复跑本审计（全部只读）

```bash
python3 - <<'PY'
import sqlite3
c=sqlite3.connect('file:/root/.hermes/profiles/ds-executor/state.db?mode=ro', uri=True)
print(list(c.execute("select session_id, model, billing_provider, billing_base_url, api_call_count"
                     " from session_model_usage where session_id='20261024_235558_956b2d'")))
PY
sha256sum /root/.hermes/profiles/ds-executor/config.yaml
stat -c '%y' /root/.hermes/profiles/ds-executor/config.yaml
cd /root/.hermes/kanban/workspaces/t_75dd49a5/repo && git status --short && git diff --stat 70cdd836
ps -eo pid,lstart,cmd | grep 'hermes.*gateway run' | grep -v grep
```
