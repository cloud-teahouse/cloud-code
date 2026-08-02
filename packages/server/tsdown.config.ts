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
  deps: {
    alwaysBundle: [/^@cloud-code\//],
    // Wasm assets resolve from node_modules at runtime (agent-core
    // src/tools/support/shell-ast/parser.ts) — keep the packages external.
    neverBundle: ['web-tree-sitter', 'tree-sitter-bash'],
  },
});
