import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'oauth',
    include: ['test/**/*.test.ts'],
  },
});
