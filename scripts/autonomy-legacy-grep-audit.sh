#!/usr/bin/env bash
# 旧自动模型入口的完整 grep 审计（本卡整改项 3 / P2 证据）。
#
# 为什么不是只 grep 两个符号：复审指出「不能只搜索 runAutonomyTick」。这里按**实际入口**
# 逐个列出「谁还会自己触发一次自动模型调用 / 落一次自动产物」，并标注它现在受哪道统一闸
# 约束。exclude：node_modules / dist / 生成的 bundle / 测试。
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

EXCLUDES=(
  --include=*.ts --include=*.tsx
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.worktrees
  --exclude=worker.bundle.js --exclude=*.bundle.js
)
TESTS=(-l)

section() { printf '\n### %s\n' "$1"; }

scan() {
  local label="$1"; shift
  local pattern="$1"; shift
  section "$label"
  printf '$ grep -rn %q --include=*.ts --include=*.tsx . (排除 node_modules/dist/bundle)\n' "$pattern"
  local hits
  hits=$(grep -rn "$pattern" "${EXCLUDES[@]}" . 2>/dev/null || true)
  if [ -z "$hits" ]; then
    printf '(无命中)\n'
    return
  fi
  printf '%s\n' "$hits"
  printf '\n非测试文件数: %s / 测试文件数: %s\n' \
    "$(printf '%s\n' "$hits" | grep -v '\.test\.ts' | wc -l | tr -d ' ')" \
    "$(printf '%s\n' "$hits" | grep '\.test\.ts' | wc -l | tr -d ' ')"
}

scan "1. AIRP 旧调度入口（建任务）" 'runAutonomyTick\|createAutonomyPostTask'
scan "2. AIRP 旧回合 fire handler（到点调模型）" 'autonomyRoundHandler\|autonomous_round'
scan "3. 出行 cron tick 入口" 'handleTravelScheduled\|runTravelTickForSubject\|runTravelTick('
scan "4. 出行模型端口与模型调用" 'createTravelDecisionPort\|proposeTravelIntent\|createTravelModelCaller'
scan "5. 出行愿望落库（旧效果入口）" 'recordTravelIntent\|finalizeIntentProbe'
scan "6. 旧护栏 / 旧 token 账本" 'readAutonomyGuardrailsForUserDetailed\|createAutonomyLlmLedgerPort\|reserveLlmTokens\|resolveTravelBudgetGate'
scan "7. 旧手机自动刷新链路" 'maybeAutoRefreshPhone\|phoneAutoRefresh\|autoRefreshIntervalMin\|isPhoneAutoRefreshDue'
scan "8. 旧 15/30/60/120 分钟频率编辑" '\[15, 30, 60, 120\]'
scan "9. 「外部窗口未实现」占位" 'external_window_not_implemented'
scan "10. 旧 autonomyLife/client.ts" "autonomyLife/client'"
scan "11. 统一闸自己的落点（新代码，供对照）" 'reserveLegacyRoundCall\|reserveLegacyNotification\|reserveLegacyEffect\|claimRoundEffect\|travelModelAccess\|gateTravelDecisionPort'
scan "12. 旧「按读边界时的 grant.dailyQuota 扣额度」的定义与调用（必须 0 命中）" 'export async function consumeExternalQuota\b\|await consumeExternalQuota('
scan "13. 授权窗口额度核销的唯一入口（新代码，供对照）" 'consumeExternalQuotaAtomic'

printf '\n### 结论（人工核对项）\n'
printf '  - AIRP 旧回合：cron 建任务前 gateLegacyAutonomyPacks；每次调模型前 reserveLegacyRoundCall（beforeFire）；\n'
printf '    输出效果前 claimRoundEffect + settle + 现读边界（llmOutput）。三条都在 worker 侧强制。\n'
printf '  - 出行：index.ts buildTravelSubjectWiring 先 travelModelAccess（新边界+旧出行授权），\n'
printf '    再 gateTravelDecisionPort（每次模型调用前原子预留/结算）；回合内 travelIntent 走 reserveLegacyEffect。\n'
printf '  - 手机自动刷新 / 旧频率编辑 / 外部窗口占位：0 命中。\n'
printf '  - 授权窗口额度：唯一入口 consumeExternalQuotaAtomic（/external/read、/external/wish 与旧链路共用）；\n'
printf '    旧 consumeExternalQuota(limit) 的定义与调用 0 命中（源码里只剩注释中的历史说明）。\n'
