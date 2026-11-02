# 准确限制（本次未做 = 未验证，不伪报）

1. 未打包、未上机：本框架未编译，未在任何设备运行验证。
2. 以下均未验证：推送通知、后台音频/TTS、文件桥（Filesystem/Share、
   WebDAV 导入导出、Android 13+ 颗粒度媒体权限）、同源代理适配
   （`/agent/*`、`/_AMapService`、`/amsg/*` 等 Web 部署路由在 APK 内不存在，
   需直连后端 + CORS 或 Capacitor HTTP 方案，另行设计）。
3. 原生图标扩展仅预留方向，未编译未接入任何图标插件；不宣称可用。
4. 工具链缺口（只读核对，未安装）：PATH 默认 `java` 为 1.8，
   `JAVA_HOME` 为 jdk-17，均低于 Capacitor 8 / AGP 要求的 Java 21；
   SDK `platforms` 仅有 `android-35`，缺 `compileSdk 36` 对应的 platform-36。
   打包阶段需用户另行授权安装，不属本卡。
5. 网页尚未同步：`android/app/src/main/assets/public/` 为框架占位页副本，
   不得宣称 SullyOS 网页已完整加载；未来入口为“主仓库构建 → `npx cap sync android`”。
6. 交付差异仅 `native/android-shell/` 新增；`node_modules`、`build/`、
   `.gradle/`、APK/AAB、签名、`local.properties`、凭据均 excluded（本包
   `.gitignore` + Capacitor 官方模板 `.gitignore` 双重排除）。
