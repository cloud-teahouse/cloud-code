import { isAbsolute, join, parse } from 'pathe';

import { cachedGlobIsMatch, cachedRegExp } from '../../utils/glob-cache';
import { canonicalizePath, type PathClass } from '../policies/path-access';

export interface PermissionPathMatchOptions {
  readonly cwd?: string;
  readonly pathClass?: PathClass;
  readonly homeDir?: string;
  readonly caseInsensitivePaths?: boolean;
}

interface PathMatchSemantics {
  readonly pathClass: PathClass;
}

/**
 * Match with picomatch's path-glob semantics: `*` stops at `/`, `**` crosses
 * whole segments. This is the right reading for file paths — it is what
 * {@link pathGlobMatch} builds on. For non-path text use
 * {@link textGlobMatch}.
 */
export function globMatch(value: string, pattern: string, options?: { nocase?: boolean }): boolean {
  if (cachedGlobIsMatch(value, pattern, options)) return true;

  const normalizedValue = stripLeadingDotSlash(value);
  const normalizedPattern = stripLeadingDotSlash(pattern);
  if (normalizedValue === value && normalizedPattern === pattern) return false;
  return cachedGlobIsMatch(normalizedValue, normalizedPattern, options);
}

/**
 * Match ordinary string fields — command text, URLs, search patterns — where
 * the value is NOT a file path and `*` must cross `/` like any other
 * character.
 *
 * Under plain picomatch semantics `deny Bash(rm *)` silently failed to match
 * `rm -rf /tmp/x` (the `/` in the argument stopped the `*`), so deny/ask
 * rules whose subject contains a path or URL were fail-open, and allow rules
 * like `FetchUrl(https://docs.example.com/*)` covered exactly one path
 * segment. The picomatch attempt is kept and the loose interpretation is a
 * widening union: every pattern that matched before still matches (brace
 * sets, character classes and `**` keep their picomatch meaning), and `*`/`?`
 * additionally match across `/`.
 */
export function textGlobMatch(
  value: string,
  pattern: string,
  options?: { nocase?: boolean },
): boolean {
  if (globMatch(value, pattern, options)) return true;
  const nocase = options?.nocase === true;
  return cachedRegExp(`loose-text-glob\n${nocase ? 'i' : 's'}\n${pattern}`, () =>
    looseTextGlobToRegExp(pattern, nocase),
  ).test(value);
}

/**
 * Compile a glob into a RegExp where `*`/`?` match any character (newlines
 * and `/` included). Backslash escapes make the next character literal —
 * matching the escaping applied by `escapeRuleSubjectLiteral` — and every
 * other character is literal. Deliberately no braces/classes here: those
 * still work through the picomatch arm of {@link textGlobMatch}.
 */
function looseTextGlobToRegExp(pattern: string, nocase: boolean): RegExp {
  let source = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === '\\' && i + 1 < pattern.length) {
      source += escapeRegExpChar(pattern.charAt(i + 1));
      i += 1;
    } else if (ch === '*') {
      source += '[\\s\\S]*';
    } else if (ch === '?') {
      source += '[\\s\\S]';
    } else {
      source += escapeRegExpChar(ch);
    }
  }
  source += '$';
  return new RegExp(source, nocase ? 'i' : '');
}

function escapeRegExpChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function stripLeadingDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

/**
 * Match file path fields, like Read/Write/Edit `path`.
 * Also compares normalized forms, so `./a`, `dir/../a`, and Windows
 * separator or case variants can match the same rule.
 */
export function pathGlobMatch(
  value: string,
  pattern: string,
  pathOptions?: PermissionPathMatchOptions,
): boolean {
  const semantics = pathMatchSemantics(value, pattern, pathOptions);
  const nocase = pathOptions?.caseInsensitivePaths ?? true;

  if (globMatch(value, pattern, { nocase })) return true;

  for (const valueVariant of pathVariants(value, semantics, pathOptions)) {
    for (const patternVariant of pathVariants(pattern, semantics, pathOptions)) {
      if (globMatch(valueVariant, patternVariant, { nocase })) return true;
    }
  }
  return false;
}

/**
 * Build equivalent spellings for one path string before glob matching:
 * the original text, a leading `./` or `.\` form without that prefix,
 * the canonical absolute path when possible, and slash-form Windows paths.
 *
 * Example: with cwd `/repo`, `./src/../secret.txt` adds both
 * `src/../secret.txt` and `/repo/secret.txt`. On Windows,
 * `C:\repo\secret.txt` also adds `C:/repo/secret.txt`.
 */
function pathVariants(
  value: string,
  semantics: PathMatchSemantics,
  pathOptions: PermissionPathMatchOptions | undefined,
): string[] {
  const variants = new Set<string>();
  addPathVariant(variants, value, semantics.pathClass);
  addPathVariant(variants, stripLeadingDotPath(value, semantics.pathClass), semantics.pathClass);

  const canonical = canonicalizePathPattern(value, semantics, pathOptions);
  if (canonical !== undefined) addPathVariant(variants, canonical, semantics.pathClass);
  return Array.from(variants);
}

function canonicalizePathPattern(
  value: string,
  semantics: PathMatchSemantics,
  pathOptions: PermissionPathMatchOptions | undefined,
): string | undefined {
  const expanded = expandUserPath(value, semantics.pathClass, pathOptions?.homeDir);
  const cwd = pathOptions?.cwd ?? defaultCwdForPath(expanded);
  if (cwd === undefined) return undefined;
  try {
    return canonicalizePath(expanded, cwd, semantics.pathClass);
  } catch {
    return undefined;
  }
}

function expandUserPath(
  value: string,
  pathClass: PathClass,
  homeDir: string | undefined,
): string {
  if (homeDir === undefined) return value;
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || (pathClass === 'win32' && value.startsWith('~\\'))) {
    return join(homeDir, value.slice(2));
  }
  return value;
}

function defaultCwdForPath(value: string): string | undefined {
  if (!isAbsolute(value)) return undefined;
  return parse(value).root;
}

function pathMatchSemantics(
  value: string,
  pattern: string,
  pathOptions: PermissionPathMatchOptions | undefined,
): PathMatchSemantics {
  // Production callers pass the active Kaos path class. The fallback keeps
  // the pure matcher useful for tests and direct helper calls.
  const pathClass =
    pathOptions?.pathClass ??
    ([value, pattern].some((candidate) => {
      return (
        /^[A-Za-z]:(?:[\\/]|$)/.test(candidate) ||
        candidate.startsWith('\\\\') ||
        candidate.includes('\\')
      );
    })
      ? 'win32'
      : 'posix');
  return { pathClass };
}

function addPathVariant(variants: Set<string>, value: string, pathClass: PathClass): void {
  variants.add(value);
  // Picomatch treats backslashes as escape syntax in some cases; add a
  // slash-separated Win32 variant so nocase and globs behave predictably.
  if (pathClass === 'win32') variants.add(value.replaceAll('\\', '/'));
}

function stripLeadingDotPath(value: string, pathClass: PathClass): string {
  if (value.startsWith('./')) return value.slice(2);
  if (pathClass === 'win32' && value.startsWith('.\\')) return value.slice(2);
  return value;
}
