import { fileURLToPath } from 'node:url';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';
import { wasmInlinePlugin } from '../../build/wasm-inline-plugin.mjs';

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  dts: false,
  outDir: 'dist',
  clean: true,
  plugins: [rawTextPlugin(), wasmInlinePlugin()],
  banner: {
    js: [
      "import { fileURLToPath as __cjsShimFileURLToPath } from 'node:url';",
      "import { dirname as __cjsShimDirname } from 'node:path';",
      'const __filename = __cjsShimFileURLToPath(import.meta.url);',
      'const __dirname = __cjsShimDirname(__filename);',
    ].join('\n'),
  },
  alias: {
    '@cloud-code/agent-core': fileURLToPath(new URL('../agent-core/src/index.ts', import.meta.url)),
    '@cloud-code/kaos': fileURLToPath(new URL('../kaos/src/index.ts', import.meta.url)),
    '@cloud-code/oauth': fileURLToPath(new URL('../oauth/src/index.ts', import.meta.url)),
    '@cloud-code/kosong': fileURLToPath(new URL('../kosong/src/index.ts', import.meta.url)),
  },
  deps: {
    alwaysBundle: [/^@cloud-code\//],
    // Wasm assets resolve from node_modules at runtime — keep the packages
    // external and declared as dependencies.
    neverBundle: ['web-tree-sitter', 'tree-sitter-bash'],
  },
});
