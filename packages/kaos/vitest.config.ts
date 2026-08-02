import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'kaos',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    env: {
      // Shell error-message assertions are written against C-locale output;
      // pin it so localized system messages (e.g. zh_CN `ls`) don't drift.
      LC_ALL: 'C',
    },
  },
});
