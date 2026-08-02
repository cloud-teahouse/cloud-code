import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@cloud-code/agent-core': fileURLToPath(new URL('../agent-core/src/index.ts', import.meta.url)),
      '@cloud-code/oauth': fileURLToPath(
        new URL('../oauth/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'sdk',
    env: {
      KIMI_LOG_LEVEL: 'off',
    },
    include: ['test/**/*.test.ts'],
  },
});
