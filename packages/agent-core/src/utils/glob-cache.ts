/**
 * Compiled-glob cache for hot matching paths (permission rules evaluated per
 * tool call, MCP access-pattern checks, rule-subject globbing).
 *
 * picomatch has no compile cache of its own: `picomatch.isMatch(str, p, o)` is
 * literally `picomatch(p, o)(str)` — every call re-parses the glob and builds
 * a fresh RegExp. The compiled matcher closures are stateless (picomatch never
 * emits a /g/ regex, so repeated calls share no `lastIndex`), which makes a
 * compiled-matcher cache a pure drop-in: same pattern + same options in,
 * identical boolean out.
 *
 * Option-shape fidelity: the picomatch entry point resolves its `windows`
 * default differently for an UNDEFINED options argument (POSIX semantics) vs.
 * a defined one (`{...options, windows: isWindows()}`), so the cache key keeps
 * "no options" apart from "defined options", and the stored matcher is built
 * with exactly the caller's option shape.
 *
 * Both caches are bounded; hitting the bound clears them wholesale. Eviction
 * only costs a recompile — never a behavior change.
 */

import picomatch from 'picomatch';

export interface GlobMatchOptions {
  readonly nocase?: boolean;
}

/** Max distinct compiled glob matchers retained before a wholesale clear. */
export const GLOB_MATCHER_CACHE_LIMIT = 512;
/** Max distinct compiled RegExps retained before a wholesale clear. */
export const REGEXP_CACHE_LIMIT = 512;

type GlobMatcher = (value: string) => boolean;

const matcherCache = new Map<string, GlobMatcher>();
const regExpCache = new Map<string, RegExp>();

/**
 * The compiled matcher for `pattern`, built with the caller's exact option
 * shape (see the module header for why undefined-options is keyed separately).
 */
export function cachedGlobMatcher(pattern: string, options?: GlobMatchOptions): GlobMatcher {
  const nocase = options?.nocase === true;
  const key =
    options === undefined ? `0\n${pattern}` : `1${nocase ? 'i' : 's'}\n${pattern}`;
  const cached = matcherCache.get(key);
  if (cached !== undefined) return cached;
  const matcher = (
    options === undefined ? picomatch(pattern) : picomatch(pattern, { nocase })
  ) as GlobMatcher;
  if (matcherCache.size >= GLOB_MATCHER_CACHE_LIMIT) matcherCache.clear();
  matcherCache.set(key, matcher);
  return matcher;
}

/** Drop-in for `picomatch.isMatch(value, pattern, options)` with compile caching. */
export function cachedGlobIsMatch(
  value: string,
  pattern: string,
  options?: GlobMatchOptions,
): boolean {
  return cachedGlobMatcher(pattern, options)(value);
}

/**
 * Bounded cache for call sites that compile a `new RegExp` per call. Keys are
 * caller-namespaced; the compiled regex must be stateless (no /g/ or /y/ flag,
 * so `.test()`/`.exec()` share no `lastIndex`) for sharing to be sound.
 */
export function cachedRegExp(key: string, compile: () => RegExp): RegExp {
  const cached = regExpCache.get(key);
  if (cached !== undefined) return cached;
  const compiled = compile();
  if (regExpCache.size >= REGEXP_CACHE_LIMIT) regExpCache.clear();
  regExpCache.set(key, compiled);
  return compiled;
}

/** Test support: drop every cached matcher/regex (the next call recompiles). */
export function clearCompiledGlobCaches(): void {
  matcherCache.clear();
  regExpCache.clear();
}
