import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { server: 'src/index.ts' },
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  external: ['@cloud-code/agent-core', '@cloud-code/kosong', '@cloud-code/kaos'],
});
