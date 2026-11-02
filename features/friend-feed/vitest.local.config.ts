import { defineConfig } from 'vitest/config';

// Bibi 本地定向测试配置（仅本卡运行用，不改根 vitest.config.ts）。
// 根配置 include 只收 utils/worker/scripts/api/apps/components，
// features/** 不在其中；用此配置显式收本模块最小接线单测。
export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': new URL('../../test/stubs/cloudflare-workers.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    setupFiles: [new URL('../../test-setup.ts', import.meta.url).pathname],
    include: ['features/friend-feed/bibiWiring.min.test.ts', 'features/friend-feed/bibiAppWiring.fix.test.ts'],
  },
});
