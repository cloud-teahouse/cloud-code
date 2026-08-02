/**
 * SEA-native-bundle wasm bytes.
 *
 * This module is only imported when `__CLOUD_CODE_NATIVE_BUNDLE__` is true
 * (see `./parser.ts`). The virtual imports are provided at build time by
 * `build/wasm-inline-plugin.mjs`: `inline` mode (SEA build) embeds the
 * wasm files as base64 strings; `stub` mode (regular builds) emits empty
 * strings so the module graph stays intact without embedding ~2.2MB of
 * wasm that the createRequire path never uses.
 */

import bashWasmBase64 from 'virtual:cloud-code-tree-sitter-bash-wasm';
import treeSitterWasmBase64 from 'virtual:cloud-code-web-tree-sitter-wasm';

export interface InlineWasmBytes {
  readonly treeSitter: Uint8Array;
  readonly bash: Uint8Array;
}

export function inlineWasmBytes(): InlineWasmBytes {
  return {
    treeSitter: base64ToUint8Array(treeSitterWasmBase64),
    bash: base64ToUint8Array(bashWasmBase64),
  };
}

function base64ToUint8Array(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}
