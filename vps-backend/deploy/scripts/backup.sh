#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# SullyOS VPS · 三通道自动备份
#
# 通道 1（GitHub · 代码）：/opt/sullyos/sullyos-repo 自动 commit + push
#   origin（.env / *.sqlite 已由 .gitignore 排除，永不入库）。
#
# 通道 2（WebDAV/dufs · 本机盘）：备份源来自 vps-backend/config/services.js
#   里真实登记的数据库路径（db.pathEnv / defaultPath / enableIf），不是
#   数据目录 glob。逐个 VACUUM INTO 一致性快照 → 校验 SQLite 完整性 →
#   生成 manifest.json（含每个库的 size / sha256 / 缺失清单）→ tar →
#   AES-256-CBC 加密 → 滚动保留 BACKUP_KEEP（默认 7）份，落在 DUFS_ROOT
#   （默认 /opt/sullyos/backups/webdav），由 main-agent /webdav/* 认证注入
#   中转对外提供。
#
#   不完整即失败：任何一个库快照或完整性校验失败，本轮不产出备份包、
#   不轮转（旧的完整备份一份都不会被删），并以非零码退出。只有「打包 +
#   解包复验」都通过的包才会被发布、上传和轮转。
#
# 通道 3（GitHub 备份仓 · 异机容灾）：把同一份已验证的加密包经 contents API
#   上传到 GITHUB_BACKUP_REPO 的 vps/ 目录（时间戳命名的新增文件，
#   绝不覆盖备份仓既有内容；滚动保留 BACKUP_KEEP 份）。
#
# 建议 cron（避开 04:30 的 cove 清理任务）：
#   15 4 * * * /opt/sullyos/vps-backend/deploy/scripts/backup.sh >> /var/log/sullyos-backup.log 2>&1
#
# 可用环境变量覆盖（默认值即生产布局；测试/迁移时使用）：
#   SULLYOS_ENV_FILE    默认 /opt/sullyos/.env
#   SULLYOS_REPO_DIR    默认 /opt/sullyos/sullyos-repo
#   SULLYOS_DATA_DIR    默认 /opt/sullyos/data
#   SULLYOS_BACKUP_DIR  默认 DUFS_ROOT 或 /opt/sullyos/backups/webdav
#   SULLYOS_LOG_FILE    默认 /var/log/sullyos-backup.log（日志防膨胀只截断这个文件）
# ═══════════════════════════════════════════════════════════════════
set -uo pipefail

ENV_FILE=${SULLYOS_ENV_FILE:-/opt/sullyos/.env}
if [ ! -f "$ENV_FILE" ]; then
  echo "[backup] 缺少 $ENV_FILE，退出" >&2
  exit 1
fi
# 安全读取（不 source：值可能含 JSON/空格/引号，避免被 shell 重新解析）
get_env() {
  sed -n "s/^$1=//p" "$ENV_FILE" | head -1 | tr -d "\"'"
}
GITHUB_PAT=$(get_env GITHUB_PAT)
GITHUB_BACKUP_REPO=$(get_env GITHUB_BACKUP_REPO)
GITHUB_BACKUP_PAT=$(get_env GITHUB_BACKUP_PAT)
DUFS_ROOT=$(get_env DUFS_ROOT)
BACKUP_KEEP=$(get_env BACKUP_KEEP)
BACKUP_ENCRYPT_PASSPHRASE=$(get_env BACKUP_ENCRYPT_PASSPHRASE)
REPO=${SULLYOS_REPO_DIR:-/opt/sullyos/sullyos-repo}
DATA_DIR=${SULLYOS_DATA_DIR:-${AMSG_DATA_DIR:-/opt/sullyos/data}}
BACKUP_DIR=${SULLYOS_BACKUP_DIR:-${DUFS_ROOT:-/opt/sullyos/backups/webdav}}
SCRIPTS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MANIFEST_TOOL="$SCRIPTS_DIR/db-manifest.mjs"
KEEP=${BACKUP_KEEP:-7}
TS=$(date -u '+%Y%m%d-%H%M%S')
FAIL=0
PKG_OK=0        # 只有「已发布 + 复验通过」的完整包才置 1
PKG_PATH=""

echo "════════ $(date -u '+%Y-%m-%d %H:%M:%S UTC') 备份开始 ════════"

# ── 通道 1：GitHub ──────────────────────────────────────────────
if [ -d "$REPO/.git" ]; then
  if (cd "$REPO" && git add -A 2>/dev/null && ! git diff --cached --quiet); then
    (cd "$REPO" && git -c user.name='sullyos-backup' -c user.email='backup@sullyos.local' \
      commit -m "backup: auto snapshot $(date -u '+%Y-%m-%d %H:%M:%S UTC')" >/dev/null 2>&1)
    echo "[backup] 通道1(GitHub): 本地已提交自动快照"
  else
    echo "[backup] 通道1(GitHub): 无本地变更"
  fi
  # 代码连续性：推送自身 origin（PAT 内联；.git-credentials 可能存有旧令牌）
  BR=$(cd "$REPO" && git rev-parse --abbrev-ref HEAD)
  if [ -n "${GITHUB_PAT:-}" ]; then
    ORIGIN_URL=$(cd "$REPO" && git config --get remote.origin.url | sed 's|^https://||')
    if (cd "$REPO" && git push "https://${GITHUB_PAT}@${ORIGIN_URL}" "HEAD:${BR}" >/dev/null 2>&1); then
      echo "[backup] 通道1(GitHub): 已推送到 origin（PAT 内联）"
    else
      echo "[backup] 通道1(GitHub): origin 推送失败" >&2; FAIL=1
    fi
  else
    if (cd "$REPO" && git push origin "HEAD:${BR}" >/dev/null 2>&1); then
      echo "[backup] 通道1(GitHub): 已推送到 origin"
    else
      echo "[backup] 通道1(GitHub): origin 推送失败" >&2; FAIL=1
    fi
  fi
else
  echo "[backup] 通道1(GitHub): 仓库不存在，跳过" >&2
fi

# ── 通道 2：WebDAV 加密快照（manifest 驱动）─────────────────────
mkdir -p "$BACKUP_DIR"
TMP=$(mktemp -d) || { echo "[backup] 通道2(WebDAV): 无法创建临时目录" >&2; exit 1; }
VERIFY_DIR="$TMP.verify"
trap 'rm -rf "$TMP" "$VERIFY_DIR"' EXIT
SNAP_DIR="$TMP/snap"
MANIFEST="$SNAP_DIR/manifest.json"
SNAP_LOG="$TMP/snapshot.log"

if node "$MANIFEST_TOOL" snapshot --dir "$SNAP_DIR" --env-file "$ENV_FILE" --manifest-out "$MANIFEST" \
     >/dev/null 2>"$SNAP_LOG"; then
  # 工具告警（未登记的库等）转发到备份日志
  grep -F '[manifest]' "$SNAP_LOG" >&2 || true
  DB_COUNT=$(node -e 'const m=require(process.argv[1]); process.stdout.write(String(m.sources.length));' "$MANIFEST" 2>/dev/null || echo 0)
  # 退出码之外再按 manifest 内容复核一遍：complete 必须为 true，required 不能有缺
  # （任何「应有库 missing / 路径配错 / 快照失败」都不许当完整包发布、上传、轮转）
  MANIFEST_STATE=$(node -e '
const fs = require("fs");
try {
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const missing = (m.absent || []).filter((a) => a.required).map((a) => `missing_required:${a.name}`);
  const bad = (m.problems || []).map((p) => `${p.code || "problem"}:${p.name || "*"}`);
  if (m.complete !== true || missing.length || bad.length) {
    process.stdout.write(`incomplete(${[...missing, ...bad].join(",")})`);
  } else {
    process.stdout.write("complete");
  }
} catch (e) {
  process.stdout.write("unreadable");
}
' "$MANIFEST" 2>/dev/null || echo unreadable)
  TARBALL="$TMP/sullyos-data-$TS.tar.gz"
  if [ "$MANIFEST_STATE" != "complete" ]; then
    echo "[backup] 通道2(WebDAV): manifest 不完整 → $MANIFEST_STATE；本轮不打包、不上传、不轮转" >&2
    FAIL=1
  elif [ "${DB_COUNT:-0}" -eq 0 ]; then
    echo "[backup] 通道2(WebDAV): manifest 里没有任何数据库，放弃本轮备份" >&2; FAIL=1
  elif ! (cd "$SNAP_DIR" && tar -czf "$TARBALL" ./*); then
    echo "[backup] 通道2(WebDAV): 打包失败" >&2; FAIL=1
  elif ! mkdir -p "$VERIFY_DIR" || ! tar -xzf "$TARBALL" -C "$VERIFY_DIR" \
       || ! node "$MANIFEST_TOOL" verify --dir "$VERIFY_DIR" --manifest "$VERIFY_DIR/manifest.json" \
            >/dev/null 2>"$TMP/verify.log"; then
    # 自己打的包自己都验不过 → 绝不发布，更不轮转
    echo "[backup] 通道2(WebDAV): 备份包复验失败，不发布、不轮转" >&2
    grep -F '[manifest]' "$TMP/verify.log" >&2 || true
    FAIL=1
  else
    # 先写临时名，成功后才改名，避免半包被当成最新备份
    if [ -n "${BACKUP_ENCRYPT_PASSPHRASE:-}" ]; then
      FINAL="$BACKUP_DIR/sullyos-data-$TS.tar.gz.enc"
      INCOMING="$BACKUP_DIR/.incoming-$TS.tar.gz.enc"
      if openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt \
        -pass "pass:${BACKUP_ENCRYPT_PASSPHRASE}" \
        -in "$TARBALL" -out "$INCOMING" 2>/dev/null && mv -f "$INCOMING" "$FINAL"; then
        echo "[backup] 通道2(WebDAV): $TS → $DB_COUNT 个库，已 AES-256 加密"
        PKG_OK=1; PKG_PATH="$FINAL"
      else
        rm -f "$INCOMING" 2>/dev/null || true
        echo "[backup] 通道2(WebDAV): 加密/发布失败" >&2; FAIL=1
      fi
    else
      FINAL="$BACKUP_DIR/sullyos-data-$TS.tar.gz"
      INCOMING="$BACKUP_DIR/.incoming-$TS.tar.gz"
      if cp "$TARBALL" "$INCOMING" && mv -f "$INCOMING" "$FINAL"; then
        echo "[backup] 通道2(WebDAV): $TS → $DB_COUNT 个库（未加密，建议设置 BACKUP_ENCRYPT_PASSPHRASE）"
        PKG_OK=1; PKG_PATH="$FINAL"
      else
        rm -f "$INCOMING" 2>/dev/null || true
        echo "[backup] 通道2(WebDAV): 拷贝失败" >&2; FAIL=1
      fi
    fi
  fi
else
  # 部分失败 / 一个库都取不到：不打包、不轮转，非零退出
  echo "[backup] 通道2(WebDAV): 备份源不完整，本轮不产出备份包、不轮转旧备份" >&2
  grep -F '[manifest]' "$SNAP_LOG" >&2 || true
  FAIL=1
fi

# ── 通道 3：GitHub 备份仓（只上传复验通过的完整包）──────────────
# 新增文件、时间戳命名：绝不覆盖备份仓既有内容，无需 workflow scope
if [ "$PKG_OK" -eq 1 ] && [ -n "${GITHUB_BACKUP_REPO:-}" ] && [ -n "${GITHUB_BACKUP_PAT:-}" ]; then
  REPO_SLUG=$(printf '%s' "$GITHUB_BACKUP_REPO" | sed -E 's|^https://github.com/||; s|\.git$||; s|/$||')
  ENC_NAME=$(basename "$PKG_PATH")
  ENC_PATH="$PKG_PATH"
  if [ -f "$ENC_PATH" ]; then
    # 大文件经 node 生成 JSON 载荷写入临时文件，避免 ARG_MAX 超限；
    # 响应体含 base64 回显，统一落盘后 grep，避免内存膨胀
    PAYLOAD="$TMP/gh-payload.json"
    node -e "
const fs=require('fs');
const b64=fs.readFileSync('$ENC_PATH').toString('base64');
fs.writeFileSync('$PAYLOAD', JSON.stringify({message:'backup: ${TS}', content:b64}));
" && \
    curl -s -m 300 -X PUT \
          -H "Authorization: Bearer ${GITHUB_BACKUP_PAT}" \
      -H 'User-Agent: sullyos-backup' -H 'Content-Type: application/json' \
      "https://api.github.com/repos/${REPO_SLUG}/contents/vps/${ENC_NAME}" \
      --data-binary "@$PAYLOAD" -o "$TMP/gh-resp.json"
    if grep -q '"sha"' "$TMP/gh-resp.json" 2>/dev/null; then
      echo "[backup] 通道3(GitHub备份仓): 已上传 vps/${ENC_NAME}"
      # 滚动清理：仅删除 vps/ 目录下我们自己上传的过期文件
          LIST=$(curl -s -m 30 -H "Authorization: Bearer ${GITHUB_BACKUP_PAT}" -H 'User-Agent: sullyos-backup' \
        "https://api.github.com/repos/${REPO_SLUG}/contents/vps")
      printf '%s' "$LIST" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  let items=[];
  try{items=JSON.parse(d)}catch(e){}
  items=items.filter(i=>i&&i.name&&i.name.startsWith('sullyos-data-')).sort((a,b)=>a.name<b.name?1:-1);
  items.slice(${KEEP}).forEach(i=>console.log(i.sha+' '+i.name));
});
" | while read -r SHA NAME; do
        curl -s -m 30 -X DELETE \
              -H "Authorization: Bearer ${GITHUB_BACKUP_PAT}" -H 'User-Agent: sullyos-backup' \
          "https://api.github.com/repos/${REPO_SLUG}/contents/vps/${NAME}" \
          -d "{\"message\":\"backup: rotate ${NAME}\",\"sha\":\"${SHA}\"}" >/dev/null 2>&1 \
          && echo "[backup] 通道3(GitHub备份仓): 滚动清理 ${NAME}"
      done
    else
      echo "[backup] 通道3(GitHub备份仓): 上传失败（$(head -c 200 "$TMP/gh-resp.json" 2>/dev/null)）" >&2; FAIL=1
    fi
  fi
elif [ "$PKG_OK" -ne 1 ] && [ -n "${GITHUB_BACKUP_REPO:-}" ]; then
  echo "[backup] 通道3(GitHub备份仓): 本地没有完整包，跳过上传" >&2
fi

# ── 滚动清理（本地 WebDAV）：只有本轮完整包发布成功才轮转 ──────
if [ "$PKG_OK" -eq 1 ]; then
  # shellcheck disable=SC2012
  ls -1t "$BACKUP_DIR"/sullyos-data-*.tar.gz "$BACKUP_DIR"/sullyos-data-*.tar.gz.enc 2>/dev/null \
    | tail -n "+$((KEEP + 1))" | xargs -r rm -f
else
  echo "[backup] 通道2(WebDAV): 本轮无完整包，跳过滚动清理（旧备份全部保留）" >&2
fi

# 日志防膨胀（>5MB 截断）
LOG=${SULLYOS_LOG_FILE:-/var/log/sullyos-backup.log}
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 5242880 ]; then
  tail -c 1048576 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG" 2>/dev/null || rm -f "$LOG.tmp" 2>/dev/null || true
fi

if [ "$FAIL" -eq 0 ]; then
  echo "[backup] ✔ 备份完成（$TS）"
else
  echo "[backup] ⚠ 备份完成但有失败项（$TS）"
fi
exit "$FAIL"
