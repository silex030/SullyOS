import type { CapacitorConfig } from '@capacitor/cli';

// 最终配置：webDir 指向主仓库未来真实 Web 构建输出（配置值不变）。
// 相对本包 native/android-shell 的 ../../dist 即主仓库 <root>/dist。
// 未来入口（本轮不执行）：“主仓库真实 Web 构建（→ dist/）→ 在本子包 pnpm install --ignore-workspace --frozen-lockfile → pnpm exec cap sync android → 另行授权原生打包”。
// 生成时曾有框架占位页同步副本，未随框架源码复制交付（实际无 assets/ 目录），
// 不得宣称为 SullyOS 业务产物已同步/已加载。
const config: CapacitorConfig = {
  appId: 'com.sullyos.app',
  appName: 'SullyOS ethernet',
  webDir: '../../dist',
  server: {
    androidScheme: 'https'
  }
};

export default config;
