import { defineConfig } from 'vitest/config';

// 协作接线定向测试配置（t_40feeeaa）：只收本域 readingStyle 单测，不改根配置。
// 手法同 features/appearance-sharing/vitest.local.config.ts。
export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': new URL('../../test/stubs/cloudflare-workers.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    setupFiles: [new URL('../../test-setup.ts', import.meta.url).pathname],
    include: ['features/collaboration/*.readingStyle.test.ts'],
  },
});
