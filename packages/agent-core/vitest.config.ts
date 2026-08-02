import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'agent-core',
    include: ['test/**/*.{test,e2e}.ts'],
    // Media transcode tests (jimp encode/decode of multi-megapixel images)
    // legitimately exceed the 5s default on slow or heavily parallel runners.
    testTimeout: 30_000,
    setupFiles: ['test/setup.ts'],
  },
});
