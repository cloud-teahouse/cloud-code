import { readFileSync } from 'node:fs';

/**
 * Virtual wasm module ids → the package asset they stand for. Virtual ids
 * are used (instead of `package/file.wasm?base64` specifiers) because
 * tsdown externalizes package.json dependencies by package name before
 * user plugins run, which would leak unresolvable specifiers into dist
 * chunks; a `virtual:` specifier is always routed to this plugin first.
 */
const VIRTUAL_MODULES = {
  'virtual:cloud-code-web-tree-sitter-wasm': 'web-tree-sitter/tree-sitter.wasm',
  'virtual:cloud-code-tree-sitter-bash-wasm': 'tree-sitter-bash/tree-sitter-bash.wasm',
};

const VIRTUAL_PREFIX = '\0wasm-inline:';

/**
 * Bundler plugin that provides wasm assets as base64 string modules:
 *
 *   import bashWasmBase64 from 'virtual:cloud-code-tree-sitter-bash-wasm';
 *
 * Two modes:
 *
 *   - `inline` (SEA single-file native bundle): the wasm file is embedded
 *     into the bundle as a base64 string, because the SEA form has no
 *     node_modules tree to resolve assets from at runtime
 *     (`src/tools/support/shell-ast/parser.ts` consumes the bytes).
 *   - `stub` (default; regular dev/dist builds): emits an empty string so
 *     the module graph stays intact without embedding ~2.2MB of wasm that
 *     the runtime never loads (those builds resolve wasm via createRequire
 *     against node_modules).
 *
 * Dev/test (tsx/vitest) never executes the importing module, so no Vite
 * plugin is needed for the virtual ids.
 */
export function wasmInlinePlugin({ mode = 'stub' } = {}) {
  if (mode !== 'inline' && mode !== 'stub') {
    throw new Error(`wasm-inline: unknown mode "${String(mode)}"`);
  }
  return {
    name: 'wasm-inline',
    enforce: 'pre',
    async resolveId(source, importer) {
      const specifier = VIRTUAL_MODULES[source];
      if (specifier === undefined) return null;
      if (mode === 'stub') return { id: `${VIRTUAL_PREFIX}${source}` };
      const resolved = await this.resolve(specifier, importer, { skipSelf: true });
      if (resolved === null) {
        this.error(`wasm-inline: cannot resolve "${specifier}" imported by ${String(importer)}`);
      }
      return { id: `${VIRTUAL_PREFIX}${resolved.id}` };
    },
    load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;
      if (mode === 'stub') return { code: 'export default "";', map: null };
      const path = id.slice(VIRTUAL_PREFIX.length);
      const base64 = readFileSync(path).toString('base64');
      return { code: `export default ${JSON.stringify(base64)};`, map: null };
    },
  };
}
