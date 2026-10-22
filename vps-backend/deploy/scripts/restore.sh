#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# SullyOS VPS · 备份恢复
#
# 用法：
#   restore.sh <备份文件>                     # 预览：解密/解压/预检 + 打印每库真实落点，不落盘、不停服
#   restore.sh --auto <备份文件>              # 完整恢复：预检 → 停服 → 按真实路径暂存/替换 → 启动
#   restore.sh --auto --allow-partial <备份>  # 显式允许「部分恢复」：缺当前必填库也装，但不当完整成功
#
# 支持 backup.sh 产物：sullyos-data-*.tar.gz 或 .tar.gz.enc
#
# 恢复目标路径的唯一来源是本机服务配置（vps-backend/config/services.js）：
#   registry 子命令按 pathEnv > defaultPath 解析出每个库名的**本机绝对路径**，
#   restore.sh 只按这个映射安装。包内 manifest 只有文件名与哈希，**绝不使用包内路径**。
#   因此 heartbeat.sqlite / sullyos-home.sqlite（默认落在部署仓 vps-backend/data）
#   与 amsg / proactive-push（默认落在 AMSG_DATA_DIR）会各自回到真正被服务读取的位置。
#
# 安全顺序（任何一步失败都不留假成功）：
#   0. 归档预检（解包前）：tar 成员只允许扁平布局里的普通文件；绝对路径、../、
#      symlink、hardlink、设备节点、子目录一律拒绝，连解包都不做。
#   1. 预检：manifest 必须完整；库名必须是纯文件名（拒 ../ 与绝对路径）；
#      每个库的 size/sha256 对得上、SQLite PRAGMA integrity_check 必须 ok；
#      --registry 再与当前服务注册表求差集：包内出现未登记库 → 拒绝；
#      **当前启用的必填库必须全部在包里**（包内 complete/required 不可信）——
#      缺一个默认拒绝并说明，只有显式 --allow-partial 才按「部分恢复」处理。
#      预检不过 → 直接退出，服务不动。
#   2. 目标解析：按本机 registry 映射出每个库的真实绝对路径；找不到映射、
#      映射有歧义、目标目录不存在、目标是符号链接 → 拒绝（仍未停服）。
#   3. 停服：systemctl stop 失败 → 立即退出，一个库都不覆盖。
#   4. 暂存：每个库复制到**自己目标目录**下的 .restore-stage-<ts>（同盘，
#      保证后续 mv 是原子 rename），再对暂存副本复核 sha256。
#   5. 替换：逐库把原库及其 -wal/-shm 移到同目录的 .restore-rollback-<ts>；
#      新库先落 .<name>.restore-new 再 mv 就位。中途任何失败 → 把**所有已触及
#      目标**（含跨目录）的原库与 WAL 搬回原位，尝试拉起服务，非零退出。
#   6. 启动：启动失败也会非零退出，并提示回滚目录位置（数据不谎报成功）。
#
# 旧备份兼容：manifest v1（无 required/optional 字段）仍可恢复，但库名必须命中
# 当前注册表的已知映射；旧包缺当前必填库同样默认拒绝（可用 --allow-partial）。
#
# 可用环境变量覆盖（默认值即生产布局；测试/迁移时使用）：
#   SULLYOS_ENV_FILE         默认 /opt/sullyos/.env
#   SULLYOS_SERVICE          默认 sullyos.service
#   SULLYOS_SYSTEMCTL        默认 systemctl
#   SULLYOS_SERVICES_CONFIG  默认 <脚本目录>/../../config/services.js（必须与 db-manifest 同一个文件）
# ═══════════════════════════════════════════════════════════════════
set -uo pipefail

ENV_FILE=${SULLYOS_ENV_FILE:-/opt/sullyos/.env}
[ -f "$ENV_FILE" ] || { echo "[restore] 缺少 $ENV_FILE" >&2; exit 1; }
export SULLYOS_ENV_FILE="$ENV_FILE"
# 安全读取（不 source：值可能含 JSON/空格/引号）
get_env() {
  sed -n "s/^$1=//p" "$ENV_FILE" | head -1 | tr -d "\"'"
}
BACKUP_ENCRYPT_PASSPHRASE=$(get_env BACKUP_ENCRYPT_PASSPHRASE)
SERVICE=${SULLYOS_SERVICE:-sullyos.service}
SYSTEMCTL=${SULLYOS_SYSTEMCTL:-systemctl}
SCRIPTS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MANIFEST_TOOL="$SCRIPTS_DIR/db-manifest.mjs"
TS=$(date -u '+%Y%m%d-%H%M%S')

# 服务配置决定「每个库落到哪里」，必须在预检与安装里是同一个文件：
# 默认按脚本位置推导（不吃调用方环境里随手指的 .js），显式覆盖时也必须是存在的绝对路径。
DEFAULT_SERVICES_CONFIG="$(cd "$SCRIPTS_DIR/../.." && pwd)/config/services.js"
if [ -n "${SULLYOS_SERVICES_CONFIG:-}" ]; then
  case "$SULLYOS_SERVICES_CONFIG" in
    /*) ;;
    *) echo "[restore] ✘ SULLYOS_SERVICES_CONFIG 必须是绝对路径（当前: $SULLYOS_SERVICES_CONFIG）" >&2; exit 1 ;;
  esac
  [ -f "$SULLYOS_SERVICES_CONFIG" ] || { echo "[restore] ✘ 找不到服务配置: $SULLYOS_SERVICES_CONFIG" >&2; exit 1; }
else
  SULLYOS_SERVICES_CONFIG="$DEFAULT_SERVICES_CONFIG"
fi
[ -f "$SULLYOS_SERVICES_CONFIG" ] || { echo "[restore] ✘ 找不到服务配置: $SULLYOS_SERVICES_CONFIG" >&2; exit 1; }
export SULLYOS_SERVICES_CONFIG

usage() {
  echo "用法: restore.sh [--auto] [--allow-partial] <sullyos-data-*.tar.gz|.tar.gz.enc>" >&2
}

AUTO=0
ALLOW_PARTIAL=0
TARGET=""
for arg in "$@"; do
  case "$arg" in
    --auto) AUTO=1 ;;
    --allow-partial) ALLOW_PARTIAL=1 ;;
    -h|--help) usage; exit 0 ;;
    --*) echo "[restore] 未知参数: $arg" >&2; usage; exit 2 ;;
    *) if [ -n "$TARGET" ]; then echo "[restore] 只能指定一个备份文件" >&2; exit 2; fi; TARGET="$arg" ;;
  esac
done
if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
  usage
  exit 2
fi
case "$TARGET" in
  *.tar.gz.enc|*.tar.gz) ;;
  *) echo "[restore] 不支持的备份格式（需 .tar.gz 或 .tar.gz.enc）" >&2; exit 2 ;;
esac

TMP=$(mktemp -d) || { echo "[restore] 无法创建临时目录" >&2; exit 1; }
trap 'rm -rf "$TMP"' EXIT
PLAIN="$TMP/data.tar.gz"
EXTRACT="$TMP/extract"
PLAN="$TMP/plan.txt"          # name <TAB> 真实绝对路径
MISSING="$TMP/missing.txt"    # 包里缺的当前必填库
: > "$TMP/staged.txt"         # name <TAB> 暂存副本路径
: > "$TMP/installed.txt"      # name <TAB> 真实目标路径（含已部分触及的）

# ── 解密 / 解包 ─────────────────────────────────────────────────
case "$TARGET" in
  *.tar.gz.enc)
    [ -n "${BACKUP_ENCRYPT_PASSPHRASE:-}" ] || { echo "[restore] 需要 BACKUP_ENCRYPT_PASSPHRASE 解密" >&2; exit 1; }
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -salt \
      -pass "pass:${BACKUP_ENCRYPT_PASSPHRASE}" -in "$TARGET" -out "$PLAIN" \
      || { echo "[restore] 解密失败（口令错误或包损坏）" >&2; exit 1; }
    ;;
  *.tar.gz)
    cp "$TARGET" "$PLAIN" || { echo "[restore] 读取备份包失败" >&2; exit 1; }
    ;;
esac

mkdir -p "$EXTRACT"

# ── 0. 归档预检：解包之前就把恶意成员挡掉 ──────────────────────
if ! node "$MANIFEST_TOOL" archive-check --file "$PLAIN" > "$TMP/archive-check.json" 2> "$TMP/archive-check.log"; then
  echo "[restore] ✘ 归档预检失败：包内成员不安全（unsafe_member / 非扁平布局）；已中止（未解包、未停服）" >&2
  grep -F '[manifest]' "$TMP/archive-check.log" >&2 || cat "$TMP/archive-check.log" >&2 || true
  exit 1
fi

tar --no-same-owner --no-same-permissions -xzf "$PLAIN" -C "$EXTRACT" \
  || { echo "[restore] 解压失败" >&2; exit 1; }

# ── 1. 预检：manifest + 库名 + 注册表（含当前必填库全集）+ size/sha256 + 完整性 ──
echo "[restore] 预检备份包：$TARGET"
VERIFY_ARGS=(verify --dir "$EXTRACT" --manifest "$EXTRACT/manifest.json" --registry --env-file "$ENV_FILE")
[ "$ALLOW_PARTIAL" -eq 1 ] && VERIFY_ARGS+=(--allow-partial)
if ! node "$MANIFEST_TOOL" "${VERIFY_ARGS[@]}" > "$TMP/verify.json" 2> "$TMP/verify.log"; then
  echo "[restore] ✘ 预检失败：备份包不完整（含缺少当前必填库）、库名不安全，或包含未登记的业务库；已中止（未停服、未改动任何数据库）" >&2
  grep -F '[manifest]' "$TMP/verify.log" >&2 || cat "$TMP/verify.log" >&2 || true
  exit 1
fi
# 通过但带告警（例如恢复一个当前未启用的已知库）必须显式说出来
grep -F '[manifest]' "$TMP/verify.log" >&2 || true

DB_LIST=$(node -e '
const fs=require("fs");
const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
for (const s of m.sources) process.stdout.write(`${s.name}\t${s.sizeBytes}\n`);
' "$EXTRACT/manifest.json") || { echo "[restore] 读取 manifest 失败" >&2; exit 1; }
DB_COUNT=$(printf '%s\n' "$DB_LIST" | grep -c . || true)
if [ "$DB_COUNT" -eq 0 ]; then
  echo "[restore] ✘ 包内没有任何库；已中止" >&2
  exit 1
fi

# 纵深防御：即使 verify 有 bug，安装循环也只接受纯文件名 *.sqlite
while IFS=$'\t' read -r name _size; do
  [ -n "$name" ] || continue
  case "$name" in
    */*|*\\*|.*|*..*) echo "[restore] ✘ 包内库名不安全（$name）；已中止" >&2; exit 1 ;;
  esac
  case "$name" in
    *.sqlite) ;;
    *) echo "[restore] ✘ 包内库名不是 *.sqlite（$name）；已中止" >&2; exit 1 ;;
  esac
done <<< "$DB_LIST"

# ── 2. 目标解析：本机 registry 的 name → 绝对路径（唯一映射来源） ──
if ! node "$MANIFEST_TOOL" registry --env-file "$ENV_FILE" > "$TMP/registry.json" 2> "$TMP/registry.log"; then
  echo "[restore] ✘ 无法读取本机服务注册表（$SULLYOS_SERVICES_CONFIG）；已中止（未停服）" >&2
  cat "$TMP/registry.log" >&2 || true
  exit 1
fi
if ! node -e '
const fs = require("fs");
const [regPath, mfPath, planPath, missingPath] = process.argv.slice(1);
const reg = JSON.parse(fs.readFileSync(regPath, "utf8"));
const mf = JSON.parse(fs.readFileSync(mfPath, "utf8"));
const targets = reg.targets || {};
const sources = Array.isArray(mf.sources) ? mf.sources : [];
const names = [];
const bad = [];
const lines = [];
const seen = new Map();
for (const s of sources) {
  const name = String((s && s.name) || "");
  if (!name) { bad.push("(empty):no_name"); continue; }
  const t = targets[name];
  if (!t) { bad.push(`${name}:not_in_registry`); continue; }
  if (t.ambiguous || !t.path || !t.dir) { bad.push(`${name}:ambiguous_target`); continue; }
  if (seen.has(t.path)) { bad.push(`${name}:duplicate_target`); continue; }
  seen.set(t.path, name);
  names.push(name);
  lines.push(`${name}\t${t.path}`);
}
const missing = (reg.required || []).filter((n) => !names.includes(n));
if (bad.length) {
  console.error(`[restore] 无法确定恢复目标: ${bad.join(",")}`);
  process.exit(1);
}
fs.writeFileSync(planPath, lines.length ? `${lines.join("\n")}\n` : "");
fs.writeFileSync(missingPath, missing.length ? `${missing.join("\n")}\n` : "");
process.stdout.write(`MISSING_REQUIRED=${missing.join(",")}\n`);
' "$TMP/registry.json" "$EXTRACT/manifest.json" "$PLAN" "$MISSING" > "$TMP/plan.meta" 2> "$TMP/plan.log"; then
  echo "[restore] ✘ 恢复目标映射失败（注册表与包内库名对不上 / 同名歧义）；已中止（未停服）" >&2
  cat "$TMP/plan.log" >&2 || true
  exit 1
fi

PARTIAL=0
if [ -s "$MISSING" ]; then
  if [ "$ALLOW_PARTIAL" -ne 1 ]; then
    # verify 已经拦过；这里再兜一层，任何路径都不得把「缺必填库」当完整恢复
    echo "[restore] ✘ 包内缺少当前启用的必填库：" >&2
    sed 's/^/  - /' "$MISSING" >&2
    echo "[restore] 已中止（未停服、未改动任何数据库）。如确为部分恢复，请显式加 --allow-partial。" >&2
    exit 1
  fi
  PARTIAL=1
fi

# 目标路径的纵深校验（不信任 registry 之外任何来源，也不接受可疑路径）
declare -A SEEN_DIRS=()
while IFS=$'\t' read -r name target; do
  [ -n "$name" ] || continue
  case "$target" in
    /*) ;;
    *) echo "[restore] ✘ $name 的恢复目标不是绝对路径（$target）；已中止" >&2; exit 1 ;;
  esac
  if [ "$(basename "$target")" != "$name" ]; then
    echo "[restore] ✘ $name 的恢复目标文件名不一致（$target）；已中止" >&2; exit 1
  fi
  case "/$target/" in
    */../*|*/./*) echo "[restore] ✘ $name 的恢复目标含路径穿越（$target）；已中止" >&2; exit 1 ;;
  esac
  if [ -L "$target" ]; then
    echo "[restore] ✘ $name 的恢复目标是指向别处的符号链接（$target）；已中止" >&2; exit 1
  fi
  dir=$(dirname "$target")
  if [ ! -d "$dir" ]; then
    echo "[restore] ✘ $name 的目标目录不存在（$dir）；已中止（未停服）" >&2; exit 1
  fi
  SEEN_DIRS["$dir"]=1
done < "$PLAN"
TARGET_DIRS=("${!SEEN_DIRS[@]}")

if [ "$AUTO" -ne 1 ]; then
  echo "[restore] 预检通过：将恢复 $DB_COUNT 个库（按本机注册表的真实路径）"
  while IFS=$'\t' read -r name target; do
    [ -n "$name" ] || continue
    printf '  %-24s -> %s\n' "$name" "$target"
  done < "$PLAN"
  if [ "$PARTIAL" -eq 1 ]; then
    echo "[restore] ⚠ 该包缺少当前必填库（--allow-partial 下才会真正安装）："
    sed 's/^/  - /' "$MISSING"
  fi
  echo "[restore] 预览模式完成（未停服、未写数据目录）。确认后执行: restore.sh --auto $TARGET"
  [ "$PARTIAL" -eq 1 ] && echo "[restore] 部分恢复需显式: restore.sh --auto --allow-partial $TARGET"
  exit 0
fi

# ── 3. 停服：失败立即退出，绝不覆盖 ─────────────────────────────
if ! "$SYSTEMCTL" stop "$SERVICE"; then
  echo "[restore] ✘ 停服失败（$SYSTEMCTL stop $SERVICE）；恢复中止：未覆盖任何数据库，服务未重启" >&2
  exit 1
fi

# 所有目标的暂存/回滚目录都先建好；任何一个失败都还没动过数据库
CREATE_FAILED=0
for dir in "${TARGET_DIRS[@]}"; do
  mkdir -p "$dir/.restore-stage-$TS" "$dir/.restore-rollback-$TS" || CREATE_FAILED=1
done
if [ "$CREATE_FAILED" -ne 0 ]; then
  echo "[restore] ✘ 无法创建暂存/回滚目录；恢复中止（数据库未改动）" >&2
  "$SYSTEMCTL" start "$SERVICE" >/dev/null 2>&1 || true
  exit 1
fi
ROLLBACK_READY=0

# 回滚：把所有已触及目标（可能跨多个目录）的原库与 WAL/SHM 搬回原位，再尽力拉起服务
restore_failed() {
  local reason="$1"
  echo "[restore] ✘ 恢复失败：$reason" >&2
  if [ "$ROLLBACK_READY" -eq 1 ]; then
    echo "[restore] 回滚：把已触及目标的原库（含 WAL/SHM）放回原位 ..." >&2
    while IFS=$'\t' read -r name target; do
      [ -n "$name" ] || continue
      local tdir rollback
      tdir=$(dirname "$target")
      rollback="$tdir/.restore-rollback-$TS"
      for suffix in '' '-wal' '-shm'; do
        if [ -f "$rollback/$name$suffix" ]; then
          mv -f "$rollback/$name$suffix" "$target$suffix" \
            || echo "[restore] 回滚未完成：$name$suffix 仍在 $rollback" >&2
        fi
      done
      rm -f "$tdir/.$name.restore-new" 2>/dev/null || true
    done < "$TMP/installed.txt"
  fi
  "$SYSTEMCTL" start "$SERVICE" >/dev/null 2>&1 \
    || echo "[restore] 警告：回滚后启动 $SERVICE 失败，请人工检查" >&2
  echo "[restore] ✘ 恢复未完成（原库保留在各目标目录的 .restore-rollback-$TS 下；服务已尝试重启）" >&2
  exit 1
}

# ── 4. 暂存：复制到各目标目录（同盘），再复核 sha256 ────────────
while IFS=$'\t' read -r name target; do
  [ -n "$name" ] || continue
  dir=$(dirname "$target")
  stage="$dir/.restore-stage-$TS/$name"
  if ! cp -f "$EXTRACT/$name" "$stage"; then
    restore_failed "暂存 $name 失败"
  fi
  printf '%s\t%s\n' "$name" "$stage" >> "$TMP/staged.txt"
done < "$PLAN"

if ! node -e '
const fs = require("fs");
const crypto = require("crypto");
const [mfPath, listPath] = process.argv.slice(1);
const mf = JSON.parse(fs.readFileSync(mfPath, "utf8"));
const want = new Map((mf.sources || []).map((s) => [s.name, s.sha256]));
const bad = [];
for (const line of fs.readFileSync(listPath, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const [name, file] = line.split("\t");
  const got = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (want.get(name) !== got) bad.push(name);
}
if (bad.length) { console.error(`[restore] 暂存副本哈希不符: ${bad.join(",")}`); process.exit(1); }
' "$EXTRACT/manifest.json" "$TMP/staged.txt"; then
  restore_failed "暂存副本复验失败（磁盘或复制过程出错）"
fi

# ── 5. 替换：原库先入同目录回滚目录，新库落临时名后 mv 就位（原子 rename） ──
ROLLBACK_READY=1
while IFS=$'\t' read -r name target; do
  [ -n "$name" ] || continue
  dir=$(dirname "$target")
  rollback="$dir/.restore-rollback-$TS"
  # 先记账：即使下面只搬了一半，回滚也会覆盖这个目标
  printf '%s\t%s\n' "$name" "$target" >> "$TMP/installed.txt"
  echo "[restore] 恢复 $name → $target"
  if ! cp -f "$dir/.restore-stage-$TS/$name" "$dir/.$name.restore-new"; then
    restore_failed "写入 $name 临时文件失败"
  fi
  for suffix in '' '-wal' '-shm'; do
    if [ -f "$target$suffix" ]; then
      mv -f "$target$suffix" "$rollback/$name$suffix" \
        || restore_failed "备份原库 $name$suffix 失败（保留原库与 WAL）"
    fi
  done
  if ! mv -f "$dir/.$name.restore-new" "$target"; then
    restore_failed "替换 $name 失败"
  fi
  chmod 600 "$target" 2>/dev/null || true
done < "$PLAN"

# ── 6. 启动 ────────────────────────────────────────────────────
if ! "$SYSTEMCTL" start "$SERVICE"; then
  echo "[restore] ✘ 数据库已替换但 $SERVICE 启动失败：请人工检查（原库保留在 .restore-rollback-$TS）" >&2
  for dir in "${TARGET_DIRS[@]}"; do echo "  $dir/.restore-rollback-$TS" >&2; done
  exit 1
fi
for dir in "${TARGET_DIRS[@]}"; do
  rm -rf "$dir/.restore-stage-$TS" 2>/dev/null || true
done

if [ "$PARTIAL" -eq 1 ]; then
  # 显式 --allow-partial：绝不能出现「完整成功」措辞
  echo "[restore] ⚠ 部分恢复完成（非完整恢复）：$SERVICE 已重启"
  echo "[restore] 以下当前启用的必填库未包含在包内，仍保持原状："
  sed 's/^/  - /' "$MISSING"
else
  echo "[restore] ✔ 恢复完成，$SERVICE 已重启；原库与 WAL 保留在："
fi
for dir in "${TARGET_DIRS[@]}"; do echo "  $dir/.restore-rollback-$TS"; done
exit 0
