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
      // Never sign test commits: a developer shell with global
      // commit.gpgsign=true and an unavailable key would fail every git
      // commit the suites create.
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'commit.gpgsign',
      GIT_CONFIG_VALUE_0: 'false',
    },
  },
});
