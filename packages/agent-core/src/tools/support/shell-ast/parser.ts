/**
 * Lazy process-level singleton for the tree-sitter bash parser.
 *
 * Wasm asset resolution covers the three Cloud Code build forms (F2 design
 * doc §1.2):
 *
 *   1. Dev/test (tsx/vitest on src) and bundled dists that keep the two
 *      packages external (`neverBundle` + package `dependencies`):
 *      `createRequire(import.meta.url).resolve(...)` against node_modules.
 *   2. SEA single-file native bundle (`tsdown.native.config.ts` defines
 *      `__CLOUD_CODE_NATIVE_BUNDLE__ = true` and bundles everything): there
 *      is no node_modules tree at runtime, so wasm bytes are embedded at
 *      build time by `build/wasm-inline-plugin.mjs` via `?base64` imports
 *      and passed to emscripten / `Language.load` as `Uint8Array`.
 *
 * Version-drift note: web-tree-sitter 0.26 renames the runtime asset from
 * `tree-sitter.wasm` to `web-tree-sitter.wasm`; the specifiers below must
 * be updated together with any dependency bump.
 */

import { createRequire } from 'node:module';
import type { Language, Parser } from 'web-tree-sitter';

declare const __CLOUD_CODE_NATIVE_BUNDLE__: boolean | undefined;

const TREE_SITTER_WASM_SPECIFIER = 'web-tree-sitter/tree-sitter.wasm';
const BASH_WASM_SPECIFIER = 'tree-sitter-bash/tree-sitter-bash.wasm';

let bashParserPromise: Promise<Parser> | undefined;

/**
 * Returns the shared bash parser, initializing web-tree-sitter on first
 * use (one-time wasm compile, tens of ms). A rejected initialization stays
 * cached: every caller degrades uniformly instead of paying a retry per
 * command.
 */
export function ensureBashParser(): Promise<Parser> {
  bashParserPromise ??= createBashParser();
  return bashParserPromise;
}

/** Test hook: drop the cached parser so the next call re-initializes. */
export function resetBashParserForTests(): void {
  bashParserPromise = undefined;
}

async function createBashParser(): Promise<Parser> {
  const { Parser, Language } = await import('web-tree-sitter');
  const isNativeBundle =
    typeof __CLOUD_CODE_NATIVE_BUNDLE__ === 'boolean' && __CLOUD_CODE_NATIVE_BUNDLE__;
  let language: Language;
  if (isNativeBundle) {
    const { inlineWasmBytes } = await import('./wasm-bytes-inline');
    const bytes = inlineWasmBytes();
    await Parser.init({ wasmBinary: bytes.treeSitter });
    language = await Language.load(bytes.bash);
  } else {
    const require = createRequire(import.meta.url);
    await Parser.init({ locateFile: () => require.resolve(TREE_SITTER_WASM_SPECIFIER) });
    language = await Language.load(require.resolve(BASH_WASM_SPECIFIER));
  }
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}
