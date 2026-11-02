# SullyOS Android 框架（仅框架，未打包）

本目录已生成真实 Android 工程框架（已验证文件存在），**框架已保留**。
本次只做框架，不做安装包：未运行任何 Gradle 编译，未生成 APK/AAB，
未安装 JDK/Android SDK，未签名，未接 CI，未执行 adb 安装。

## 位置与隔离

- 位置：主目录的 `native/android-shell/`（独立子包，已随集成卡进入主工作区）。
- （生成阶段记录：执行 `npx cap add` 当时）根 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` / PWA 图标 /
  网页代码 / CI / 构建配置一律未改。根 workspace 仅包含 `.` 与 `worker/*`，
  本子包不在 workspace 内；安装时另加了实际受支持的 `--ignore-workspace`
  参数做隔离，生成了本包自己的 `pnpm-lock.yaml`。
  集成到主目录后另有 `tsconfig.json` exclude 隔离原生子包及文档更新，不代表整合后 git 根零改动。
- 后续同步不再经过 worktree：主目录网页构建产物通过下述未来入口同步进入原生工程。

## 固定版本（已核对官方 registry，不用 @latest）

- `@capacitor/core` / `@capacitor/cli` / `@capacitor/android` 全部固定为 **8.6.0**
 （精确版本，无 `^`；`npx cap --version` 复核一致）。
- `package.json` 中为精确版本号（无 `^`），与本包 `pnpm-lock.yaml` 内记录一致。
- Node v22.15.0 / pnpm 9.15.9（现场实测）。

## 关键标识

- `appId`: `com.sullyos.app`（复用旧项目有据 ID，未耦合个人域名/账户/本机路径）
- `appName`: `SullyOS ethernet`
- `namespace` / `applicationId`：`com.sullyos.app`（见 `android/app/build.gradle`）
- `MainActivity`：`android/app/src/main/java/com/sullyos/app/MainActivity.java`
 （`package com.sullyos.app`，继承 `BridgeActivity`）
- `AndroidManifest.xml`：`android/app/src/main/AndroidManifest.xml`
- Gradle：`settings.gradle` / `build.gradle` / `variables.gradle` /
  `gradle.properties` / `gradle/wrapper/`（wrapper 固定 gradle-8.14.3）
- `variables.gradle`：`minSdkVersion 24`，`compileSdkVersion 36`，
  `targetSdkVersion 36`（Capacitor 8 官方工具链要求）。

## 网页构建 → 同步（未来入口，本次未同步）

- 最终配置 `capacitor.config.ts`：`webDir: '../../dist'`，
  即相对本包的 `native/android-shell/../../dist` = 主仓库未来真实 `dist/`。
- 本次**没有**运行主网页生产构建，主仓库当前也没有 `dist/`；
  生成时曾有框架占位页同步副本（`android/app/src/main/assets/public/` 与
  `assets/capacitor.config.json` 生成时刻快照，`webDir: web-placeholder`），
  未随框架源码复制交付（按同步产物忽略规则排除，实际交付无 `assets/` 目录，
  已静态核验缺失），待未来真实 Web 构建后同步覆盖。
  **不得宣称网页已完整加载到该原生工程中**。
- 未来入口（需另行授权/排期，不在本卡范围内，本轮不执行以下任何命令）：
  1. 主仓库执行真实 Web 构建，产出 `dist/index.html`；
  2. 在本子包执行 `pnpm install --ignore-workspace --frozen-lockfile` 装好子包依赖；
  3. 在本子包执行 `pnpm exec cap sync android`，把构建输出复制进原生工程；
  4. 之后才进入需 JDK 21 + SDK platform-36 的 Gradle 打包阶段（另卡授权）。

## 生成器占位页说明

- `web-placeholder/index.html` 是为满足 `cap add android` 对 webDir 存在性
  要求而设的框架占位页，页面内已明确标注“不是 SullyOS 业务产物”。
- 真实生成命令与退出码（现场实测）：
  - `pnpm install --ignore-workspace` → 退出码 0（约 1m31s，中途有 registry
    ECONNRESET 自动重试后成功；详见 `android-framework-only/`）。
  - `npx cap add android` → 退出码 0（约 133ms，`[success] android platform added!`）。
- 未运行 `cap sync`（`../../dist` 缺失时同步无意义）、未运行任何
  `gradlew` / `assemble` / 原生编译。

## 静态验证结论（未执行 Gradle，仅静态检查）

- `AndroidManifest.xml` 可 XML 解析；`capacitor.config.json` 可 JSON 解析。
- `package.json` 与本包锁文件版本一致（core/android/cli 均为 8.6.0）。
- `capacitor.settings.gradle` 静态引用本包 `node_modules` 内的
  `@capacitor/android/capacitor`（`../node_modules/.pnpm/@capacitor+android@8.6.0_…`），
  未来 Gradle 可引用子包依赖，无需动根依赖。
- 无 APK/AAB、无 `local.properties`、无签名密钥、无 `build/` 产物缓存进入交付差异
 （`android/app/build/` 仅有模板自带的 0 字节 `.npmkeep`；`build/`、`.gradle/`、
  `local.properties`、`*.apk/*.aab` 均被本包与官方模板 `.gitignore` 排除）。
- 全工程无绝对个人路径（生成阶段已 grep `C:/Users`、用户名目录、`local.properties`、
  `keystore`，零命中）；生成阶段当时 `git status` 仅 `?? native/` 一条新增、根文件零修改。
  集成到主目录后另有 `tsconfig.json` exclude 隔离原生子包及文档更新，不代表整合后 git 根零改动。

## 准确限制（未验证项，不伪报设备可用）

- 未打包、未上机：本框架**未编译、未在任何设备上运行验证**。
- 推送通知 / 后台音频（含 TTS）/ 文件桥（Filesystem/Share、WebDAV 导入导出、
  媒体权限）/ 同源代理适配（`/agent/*`、`/amsg/*` 等在 Web 部署存在、
  在 APK 内不存在的路由，需直连后端 + CORS 或 Capacitor HTTP 方案）——
  以上均**未验证**，不宣称设备可用。
- 原生图标扩展（如 activity-alias 双图标切换）仅预留扩展点方向，
  未编译、未接入任何图标插件；本文档不写任何未测插件为“可用”。
- 本机工具链缺口（生成阶段只读核对，未安装，仅记文档）：
  当时 PATH 默认 `java` 为 1.8，`JAVA_HOME` 为 jdk-17，均低于 Capacitor 8 / AGP
  要求的 Java 21；SDK `platforms` 仅有 `android-35`，缺框架声明的
  `compileSdk 36` 对应的 platform-36。真到打包阶段需用户另行授权安装，
  不属本卡范围，本卡未为 doctor 警告安装任何工具链。

## 目录结构

```
native/android-shell/
  package.json            独立子包（capacitor 8.6.0 精确版本）
  pnpm-lock.yaml          本包自己的锁文件
  capacitor.config.ts     最终 webDir: ../../dist（未来真实 dist）
  web-placeholder/        生成器占位页（非业务产物）
  android/                真实 Android 工程（Manifest/MainActivity/Gradle/wrapper）
  android-framework-only/ 生成命令、文件清单、静态检查与限制的证据
  .gitignore              排除 node_modules/build/.gradle/APK/签名/凭据
  README.md               本文件
```

无 commit/push/PR/部署权限；本目录已进入主目录，未同步业务网页、未编译、未打包。
