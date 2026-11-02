import { defineConfig } from 'vitest/config';

// 本模块独立测试配置（仅本地运行用，不改根 vitest.config.ts）。
// 根配置的 include 只收 utils/worker/scripts/api/apps/components，
// features/** 不在其中；用此配置显式收本模块单测。
export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': new URL('../../test/stubs/cloudflare-workers.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    setupFiles: [new URL('../../test-setup.ts', import.meta.url).pathname],
    include: ['features/appearance-sharing/*.test.ts', 'features/appearance-sharing/*.test.tsx'],
  },
});
