// Virtual wasm-bytes modules provided by build/wasm-inline-plugin.mjs.
// Only the SEA native bundle loads these at runtime; regular tsdown builds
// stub them to empty strings and dev/test (tsx/vitest) never imports the
// module that uses them. See src/tools/support/shell-ast/parser.ts.

declare module 'virtual:cloud-code-web-tree-sitter-wasm' {
  const content: string;
  export default content;
}

declare module 'virtual:cloud-code-tree-sitter-bash-wasm' {
  const content: string;
  export default content;
}
