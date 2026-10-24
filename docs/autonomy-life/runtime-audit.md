# 实现期执行审计（ds-executor 会话，脱敏）

本文只回答一件事：**这张卡的实现过程本身**用了什么模型/provider、在哪些会话里跑了多久、
调用了哪些工具，以及有没有碰 Hermes 配置 / 网关 / 部署。数据来源是 Hermes 自己的会话库
（`~/.hermes/profiles/ds-executor/state.db` 的 `sessions` / `messages` 表）、默认 profile 的
`~/.hermes/state.db`（只用于定位另一个 desktop 会话）与看板 run 表
（`~/.hermes/kanban.db` 的 `task_runs`）。不是事后自述，也不含任何密钥。

采集时间：2026-10-25 04:10（Asia/Shanghai）。

## 1. run ↔ 会话 ↔ 模型/provider

看板 `task_runs`（task `t_984b3cfc`）：

| run | profile | 状态 / 结果 | 开始 | 结束 | 对应会话 |
| --- | --- | --- | --- | --- | --- |
| 66 | ds-executor | crashed / crashed | 2026-10-24 22:10:27 | 2026-10-24 22:29:03 | `20261024_221058_8a10fa` |
| 68 | ds-executor | review / review_requested | 2026-10-24 22:29:03 | 2026-10-25 01:29:03 | `20261024_222914_83cee9` |
| 77 | arch-reviewer | ready / changes_requested | 2026-10-25 01:30:56 | 2026-10-25 01:34:27 | （arch-reviewer 审查 run，无实现会话） |
| 78 | ds-executor | crashed / crashed | 2026-10-25 01:35:29 | 2026-10-25 02:21:17 | `20261025_013601_e70a16` |
| 83 | ds-executor | review / review_requested | 2026-10-25 02:21:17 | 2026-10-25 03:19:02 | `20261025_022126_6acdff` |
| 89 | arch-reviewer | ready / changes_requested | 2026-10-25 03:19:05 | 2026-10-25 03:21:36 | （arch-reviewer 审查 run，无实现会话） |
| 90 | ds-executor | running / running | 2026-10-25 03:23:10 | — | `20261025_032319_1d928e` |

会话库逐条（标题均命中本卡；`model` / `billing_provider` 是会话实际走的通道）：

| 会话 | model | provider | 起止 | API 调用 | 工具调用 | 主要工具 |
| --- | --- | --- | --- | --- | --- | --- |
| `20261024_221058_8a10fa` | `deepseek-v4.1-flash` | `opencode-go` | 2026-10-24 22:11:08 → 2026-10-24 22:26:41 | 75 | 91 | terminal×37, patch×23, read_file×20, process_manage×8, write_file×2, kanban_show×1 |
| `20261024_222914_83cee9` | `deepseek-v4.1-flash` | `opencode-go` | 2026-10-24 22:29:24 → 2026-10-25 01:29:20 | 248 | 265 | terminal×229, write_file×18, patch×11, read_file×3, kanban_heartbeat×2, kanban_show×1, kanban_request_review×1 |
| `20261025_013601_e70a16` | `deepseek-v4.1-flash` | `opencode-go` | 2026-10-25 01:36:22 → 2026-10-25 02:20:41 | 123 | 141 | terminal×89, patch×25, read_file×17, write_file×5, browser_exec×4, kanban_show×1 |
| `20261025_022126_6acdff` | `deepseek-v4.1-flash` | `opencode-go` | 2026-10-25 02:21:35 → 2026-10-25 03:19:22 | 165 | 185 | terminal×140, process_manage×16, kanban_attach×13, write_file×4, patch×3, kanban_show×2, tool_describe×1 |
| `20261025_032319_1d928e` | `deepseek-v4.1-flash` | `opencode-go` | 2026-10-25 03:23:24 → — | 187 | 188 | terminal×103, patch×60, read_file×16, execute_code×4, write_file×3, kanban_show×1 |

- 五个会话（含两个 **crashed** run 66 / 78 与返工 run 83）的 `model` 全部是
  `deepseek-v4.1-flash`，`billing_provider` 全部是 `opencode-go`；
- 两张崩溃 run 的会话行还在（`end_reason=cli_close`）：崩溃后进程退出，改动留在工作树里，
  下一轮 run 接着做——不存在「换模型 / 换 provider 重跑」的痕迹；
- `model_config` 里的 `reasoning_config.effort=high` 是本 profile 的既有配置
  （mtime 2026-10-24 16:35:36，早于本卡第一次 run 的 22:10:27）。

## 2. 工具操作范围（有没有越界）

对上述五个会话的 `messages.tool_calls` 做精确正则扫描（不是模糊包含）：

- `hermes\s+config\s+set`：**0 命中**
- `hermes\s+gateway` / `gateway\s+(start|run)`：**0 次执行**（run 83 里的命中是
  `ps ... | grep -E "hermes[-_ ]gateway|gateway run"` 这类只读排查与审计文字）
- `wrangler\s+deploy` / `npm\s+publish` / `systemctl\s+(start|restart)` / `hermes\s+serve`：**0 命中**

即：实现过程只做「读文件 / 改仓库文件 / 跑测试与构建 / 写看板」，没有改 Hermes 配置、
没有启动消息网关、没有部署。工具直方图见上表（terminal / patch / read_file / write_file /
execute_code / browser_exec 与 kanban_* 协调工具）。

## 3. 全局 `~/.hermes/config.yaml` 在 run 68 期间变化（22:50:17）的归属

结论：**不是本卡的执行会话改的**，而是同一台机器上另一个 **desktop 会话**：

- 会话 `20261024_214632_52aa58`，`source=desktop`，
  标题「修改子代理默认模型为 ds v4.1flash」，模型 `deepseek-v4.1-flash` / `opencode-go`，
  工具调用 65 次；
- 该会话的 tool 记录（原文，未打印任何密钥）：

```
2026-10-24 21:51:25   {"success": true, "name": "hermes-agent", "description": "Use, configure, theme, extend, and orchestrate Hermes Agent.", "tags": ["hermes", "setup", "configuration", "multi-agent", "spawning", "cli", "gateway", "bots", "bot-mode", "features", "themes", "skins", "desktop-plugins", "tui-widgets", "petdex", "development"], "related_skills": ["claude-code", "codex", "opencode"], "content": "--- name: hermes-agent descri
2026-10-24 21:52:05  [{"id": "call_00_h1ut274xkqmo358pyynjspb1", "call_id": "call_00_h1ut274xkqmo358pyynjspb1", "response_item_id": "fc_00_h1ut274xkqmo358pyynjspb1", "type": "function", "function": {"name": "terminal", "arguments": "{\"command\": \"cd /root && cp /root/.hermes/config.yaml /root/.hermes/config.yaml.bak-deleg-$(date +%Y%m%d-%H%M%S) && hermes config set delegation.provider opencode-go 2>&1 | tail -3 && hermes config set del
2026-10-24 22:48:59   {"output": "/root/.hermes/hermes-agent hermes_cli/kanban_db_dispatch.py:1:\"\"\"Dispatcher: crash/stale/orphan detection, failure accounting and the respawn circuit breaker, memory-aware concurrency caps, the one-shot ``dispatch_once`` pass, worker spawning (``_default_spawn``), worker-log rotation and the long-lived ``run_daemon`` loop. hermes_cli/kanban_db_dispatch.py:1848:    \"\"\"Effective global concurrency ca
2026-10-24 22:49:04   {"output": "Local import keeps ``kanban_db`` importable without the gateway package.     Module-level indirection is also the test seam — conftest patches this to     ``{}`` so results don't depend on the CI runner's live memory.     \"\"\"     try:         from gateway.lifecycle_ledger import sample_memory         return sample_memory() or {}     except Exception:         return {}   def derive_default_max_in_progr
2026-10-24 22:49:43  [{"id": "call_2652d97fd21e46969306c305", "call_id": "call_2652d97fd21e46969306c305", "response_item_id": "fc_2652d97fd21e46969306c305", "type": "function", "function": {"name": "terminal", "arguments": "{\"command\":\"cd /root && hermes config set kanban.max_in_progress 2 2>&1 | grep -v \\\"manual restart\\\" | grep -v \\\"Ask its owner\\\"; echo \\\"--- swappiness: \u5f53\u524d $(cat /proc/sys/vm/swappiness) \u2192 
2026-10-24 22:50:29   {"output": "✓ Set kanban.max_in_progress = 2 in /root/.hermes/config.yaml --- swappiness: 当前 0 → 30（临时，重启回默认/可改回） 30 --- 内存现状 MemTotal: 15982520 kB MemAvailable: 3938000 kB SwapTotal: 4194300 kB SwapFree: 4192228 kB Mem:            15Gi        11Gi       3.3Gi       2.9Mi       897Mi       3.7Gi Swap:          4.0Gi       2.0Mi       4.0Gi", "exit_code": 0, "error": null}
```

- 它在 21:52 执行了 `hermes config set delegation.provider/model/reasoning_effort`
  （改的是**子代理默认模型**），并在 22:50 执行了
  `hermes config set kanban.max_in_progress = 2`——后者与 `config.yaml` 的
  mtime `2026-10-24 22:50:17` 对得上；
- 本卡五个会话在同一分钟没有任何 config 写操作（§2 正则 0 命中）。

因此「全局配置在 run 68 窗口内变过」有据可查、归属明确：用户侧 desktop 会话调整子代理 /
看板并发配置，不是 ds-executor 实现会话改的；也没有改变本卡使用的
`deepseek-v4.1-flash` / `opencode-go`（profile 配置 mtime 早于本卡所有 run）。

## 4. 不能证明的部分（如实列出）

- 会话库记录的是**会话级** model/provider 与工具名；逐次请求的证据在
  `~/.hermes/logs/agent.log` 的 `API call #N: model=... provider=...` 行（本会话同类记录可见），
  本文不粘贴整份日志。
- run 66 / 78 的崩溃原因见 `task_runs.error`（协议违规 / pid 不存活），与会话库对得上，
  但进程级堆栈已不在日志里。
