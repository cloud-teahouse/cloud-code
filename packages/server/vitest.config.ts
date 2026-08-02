import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server',
    env: {
      KIMI_LOG_LEVEL: 'off',
    },
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
