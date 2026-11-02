# 生成命令与退出码（现场实测，非手造）

## 版本核对（先查 registry，不猜）

- `npm view @capacitor/core version` → `8.6.0`
- `npm view @capacitor/cli version` → `8.6.0`
- `npm view @capacitor/android version` → `8.6.0`
- `npm dist-tag ls @capacitor/core` → `latest: 8.6.0`（v8 稳定最新；`next` 为 9.0.0-beta，不采用）
- 本包固定 `8.6.0` 精确版本（无 `^`），见 `03-pnpm-list.txt` 与本包 `pnpm-lock.yaml`。

## 安装生成器依赖（仅本子包）

- 命令（在本包目录执行）：`pnpm install --ignore-workspace`
- 退出码：`0`
- 耗时：约 1m31s；中途 registry 有数次 `ECONNRESET`，pnpm 自动重试后成功。
- `--ignore-workspace` 为 pnpm 实际受支持的隔离参数（`pnpm install --help` 可查）；
  根 `pnpm-workspace.yaml`（仅 `.` 与 `worker/*`）未改，本包不在 workspace 内，
  另生成本包自己的 `pnpm-lock.yaml`（约 24KB）。
- 根 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` 零修改（见 `05-git-status.txt`）。

## 生成 Android 工程（官方入口）

- 前置：`capacitor.config.ts` 生成阶段临时 `webDir: 'web-placeholder'`
  （占位页见 `web-placeholder/index.html`，页内已声明非业务产物），
  `appId: com.sullyos.app`，`appName: SullyOS ethernet`。
- 命令（在本包目录执行）：`npx cap add android`
- 退出码：`0`
- 实际输出（逐行）：
  ```
  √ Adding native android project in android in 132.66ms
  √ add in 133.20ms
  √ Copying web assets from web-placeholder to android\app\src\main\assets\public in 6.21ms
  √ Creating capacitor.config.json in android\app\src\main\assets in 1.39ms
  √ copy android in 19.70ms
  √ Updating Android plugins in 1.58ms
  √ update android in 35.63ms
  √ Syncing Gradle in 281.00μs
  [success] android platform added!
  Follow the Developer Workflow guide to get building:
  https://capacitorjs.com/docs/basics/workflow
  ```
- 生成后已将 `capacitor.config.ts` 切换为最终 `webDir: '../../dist'`；
  `assets/` 下的占位副本为生成时刻快照，待未来真实同步覆盖（见 README）。
- 未执行：`cap sync`（`../../dist` 缺失时无意义）、任何 `gradlew`/`assemble`、
  主网页生产构建、JDK/SDK 安装、签名、CI、adb。
