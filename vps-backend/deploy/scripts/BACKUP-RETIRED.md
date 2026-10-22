# VPS 备份链路已退役（2026-10-22）

**结论先说：这台 VPS 上不再有任何「自动备份 / 自动上传 / 自动 git 提交」的代码。**
需要备份请用前端「云端备份」（GitHub Releases / WebDAV）；需要恢复请用前端「备份导入」。

## 退役了什么

已从仓库删除（历史提交里仍可查到，但工作树里不再有可执行文件）：

| 文件 | 原来的职责 | 为什么删 |
| --- | --- | --- |
| `backup.sh` | 三通道备份：① 在部署仓 `git add -A` + commit + push 到 public 代码仓 ② VACUUM 快照 + tar + AES-256-CBC 落本机 dufs ③ 经 contents API 上传到 GitHub 备份仓，并按 `BACKUP_KEEP` 远端轮转 | 会在 public 仓制造 `backup: auto snapshot` 假提交；把数据包推第三方仓；与前端 Releases 链路重复且无调度（远端自 2026-09-15 起未更新） |
| `restore.sh` | 解密 → 归档预检 → manifest 校验 → 停服 → 按服务注册表逐库原子换入 → 起服 | 唯一入口依赖已退役的 `db-manifest.mjs`；留在机器上就是一把「一条命令覆盖生产库」的枪 |
| `db-manifest.mjs` | snapshot / verify / registry / archive-check 子命令 | 只服务于上面两条脚本 |
| `vacuum-snapshot.cjs` | 单库 better-sqlite3 在线快照 | 只服务于备份链路 |
| `__tests__/{backup,restore,db-manifest,sandbox-isolation}.test.ts`、`__tests__/sandbox.ts` | 上述脚本的沙箱回归 | 被 `__tests__/backup-retired.test.ts`（退役守卫）取代 |

同时从 `vps-backend/package.json` 删掉 `backup` / `restore` 两个 npm script，从 `.env.example`
删掉 `GITHUB_PAT` / `GITHUB_BACKUP_REPO` / `GITHUB_BACKUP_PAT` / `BACKUP_KEEP` /
`BACKUP_ENCRYPT_PASSPHRASE`（这些变量只被退役脚本读取）。

**没有动的东西**（刻意保留）：

- 前端「云端备份 → GitHub Releases / WebDAV」整条链路（`utils/githubClient.ts`、
  `context/OSContext.tsx` 的 `cloudBackupToWebDAV`）——这是现在唯一受支持的备份通道。
- 历史备份**资产**：`/opt/sullyos/backups/webdav/` 与本机 dufs 里的旧包、GitHub 备份仓
  `silex030/sully-backup` 的 `vps/*.enc` 与 Releases 资产，一个都没删、没轮转、没上传。
- `sullyos-dufs.service` 与主代理 `/webdav/*` 认证注入中转——它们只是「读已有文件」的存储面，
  不产生新备份；删了旧包就没法再取。

## 旧包怎么离线读（只读，不写生产）

旧包有两种形态，都在**临时目录**里展开，绝不覆盖运行中的数据库：

```bash
# 0) 复制到临时目录再操作，原件保持只读（不要原地解密/解压）
tmp=$(mktemp -d) && cp /opt/sullyos/backups/webdav/sullyos-data-<时间戳>.tar.gz.enc "$tmp/pkg.enc"

# 1) 加密包（口令只在 /opt/sullyos/.env 的 BACKUP_ENCRYPT_PASSPHRASE，不要写进命令行历史）
openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -salt \
  -pass "pass:$(grep '^BACKUP_ENCRYPT_PASSPHRASE=' /opt/sullyos/.env | cut -d= -f2-)" \
  -in "$tmp/pkg.enc" -out "$tmp/pkg.tar.gz"

# 2) 看目录结构（扁平布局：每个库一个 .sqlite + manifest.json）
tar -tzf "$tmp/pkg.tar.gz"

# 3) 解到临时目录，只读查看 manifest（每库 size / sha256 / complete / absent）
mkdir -p "$tmp/x" && tar -xzf "$tmp/pkg.tar.gz" -C "$tmp/x"
cat "$tmp/x/manifest.json"          # 或 jq . "$tmp/x/manifest.json"
sha256sum "$tmp/x/"*.sqlite         # 与 manifest 里记录的 sha256 逐个对比

# 4) 想查某个库的内容：用 sqlite3 只读打开副本（加 -readonly 或用 immutable=1）
sqlite3 "file:$tmp/x/amsg.sqlite?mode=ro" '.tables'
```

要点：

- `manifest.json` 里的 `sources[].name` 只是纯文件名；**旧包的库名 → 真实落点**当年由
  `vps-backend/config/services.js` 决定（`amsg.sqlite` 在 `AMSG_DATA_DIR`；`heartbeat.sqlite` /
  `sullyos-home.sqlite` 默认在部署仓 `vps-backend/data/`）。现在没有脚本替你算这个映射了，
  要落盘请人工确认目标绝对路径。
- 未加密包（`.tar.gz`）跳过第 1 步即可。

## 明确不要做的事

- **不要再跑任何「restore / 恢复」脚本**：仓库里没有了；网上抄来的、旧文档里的、
  VPS 上残留副本里的都不要跑。它们会 `systemctl stop sullyos` 并直接换掉生产库文件。
- 不要把旧包解压进 `/opt/sullyos/data` 或 `vps-backend/data`。
- 不要为了「省事」给 `backup.sh` 做一份本地副本再挂 cron——这条链路是刻意退役的。

需要真正恢复数据时，唯一受支持的路径是前端「设置 → 备份与恢复 → 导入备份包」
（`importFullData`，会先校验 manifest 再 clear-and-add，并在带后端连接时先弹确认）。

## 残留（不在本仓库范围内，需运维手工处理）

- VPS 部署副本 `/opt/sullyos/vps-backend/deploy/scripts/backup.sh`、`restore.sh` 等
  属于旧部署产物，**下次 `git pull` + 重建部署副本后消失**；在那之前不要执行它们。
- 生产 `/opt/sullyos/.env` 里可能仍有上面那些 `GITHUB_BACKUP_*` / `BACKUP_KEEP` /
  `BACKUP_ENCRYPT_PASSPHRASE` 键：现在是死配置，删不删都不影响运行，但容易误导排障
  （尤其 `BACKUP_ENCRYPT_PASSPHRASE` 仍是旧包解密口令，删掉旧包就再也解不开了）。
- 从未有过 systemd timer / crontab 触发过这条链路（2026-10-22 已复核），退役不影响任何调度。
