import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';
import { wasmInlinePlugin } from '../../build/wasm-inline-plugin.mjs';

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  plugins: [rawTextPlugin(), wasmInlinePlugin()],
  deps: {
    alwaysBundle: ['picomatch'],
    neverBundle: [
      '@cloud-code/kosong',
      '@cloud-code/kaos',
      '@cloud-code/oauth',
      // Wasm assets are resolved from node_modules at runtime
      // (src/tools/support/shell-ast/parser.ts), so the packages must stay
      // external and installed.
      'web-tree-sitter',
      'tree-sitter-bash',
    ],
  },
});
