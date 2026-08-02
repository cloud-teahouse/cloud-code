import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

const appRoot = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(appRoot, 'src'),
    },
  },
  test: {
    name: 'cli',
    env: {
      KIMI_LOG_LEVEL: 'off',
      // Never sign test commits: a developer shell with global
      // commit.gpgsign=true and an unavailable key would fail every git
      // commit the suites create.
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'commit.gpgsign',
      GIT_CONFIG_VALUE_0: 'false',
    },
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
