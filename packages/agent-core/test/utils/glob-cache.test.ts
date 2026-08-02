import picomatch from 'picomatch';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  GLOB_MATCHER_CACHE_LIMIT,
  REGEXP_CACHE_LIMIT,
  cachedGlobIsMatch,
  cachedGlobMatcher,
  cachedRegExp,
  clearCompiledGlobCaches,
} from '../../src/utils/glob-cache';

beforeEach(() => {
  clearCompiledGlobCaches();
});

describe('cachedGlobIsMatch', () => {
  it('matches picomatch.isMatch across patterns, values, and option shapes', () => {
    const patterns = [
      'Bash',
      'mcp__github__*',
      'Read',
      '*',
      'src/**/*.ts',
      'rm *',
      'Docker*',
      '?(mcp__)github',
      '@(Write|Edit)',
    ];
    const values = [
      'Bash',
      'bash',
      'mcp__github__create_issue',
      'mcp__gitlab__create_issue',
      'src/a/b.ts',
      'src/a.b',
      'rm -rf /tmp/x',
      'rm',
      'Dockerfile',
      'docker-compose',
      'Write',
    ];
    const optionShapes: ({ nocase?: boolean } | undefined)[] = [
      undefined,
      {},
      { nocase: false },
      { nocase: true },
    ];
    for (const pattern of patterns) {
      for (const value of values) {
        for (const options of optionShapes) {
          expect(
            cachedGlobIsMatch(value, pattern, options),
            `${value} vs ${pattern} (${JSON.stringify(options)})`,
          ).toBe(picomatch.isMatch(value, pattern, options));
        }
      }
    }
  });

  it('returns the identical compiled matcher on repeat calls (cache hit)', () => {
    expect(cachedGlobMatcher('Bash')).toBe(cachedGlobMatcher('Bash'));
    expect(cachedGlobMatcher('Bash')).not.toBe(cachedGlobMatcher('Read'));
    // nocase variants are distinct entries.
    expect(cachedGlobMatcher('Bash', { nocase: true })).toBe(
      cachedGlobMatcher('Bash', { nocase: true }),
    );
    expect(cachedGlobMatcher('Bash', { nocase: true })).not.toBe(
      cachedGlobMatcher('Bash', { nocase: false }),
    );
    // An undefined options argument is keyed apart from a defined one (the
    // picomatch entry point resolves its `windows` default differently).
    expect(cachedGlobMatcher('Bash')).not.toBe(cachedGlobMatcher('Bash', {}));
  });

  it('stays bounded: a full cache clears wholesale and recompiles correctly', () => {
    const first = cachedGlobMatcher('pattern-0');
    for (let i = 1; i < GLOB_MATCHER_CACHE_LIMIT; i++) {
      cachedGlobMatcher(`pattern-${String(i)}`);
    }
    // Still cached at exactly the limit.
    expect(cachedGlobMatcher('pattern-0')).toBe(first);
    // One more distinct pattern overflows the bound and clears the cache.
    cachedGlobMatcher('pattern-overflow');
    const recompiled = cachedGlobMatcher('pattern-0');
    expect(recompiled).not.toBe(first);
    // Eviction costs only a recompile: matching behavior is unchanged.
    expect(recompiled('pattern-0')).toBe(true);
    expect(recompiled('other')).toBe(false);
  });

  it('clearCompiledGlobCaches drops every cached matcher', () => {
    const before = cachedGlobMatcher('Bash');
    clearCompiledGlobCaches();
    expect(cachedGlobMatcher('Bash')).not.toBe(before);
  });
});

describe('cachedRegExp', () => {
  it('compiles once per key and returns the shared instance', () => {
    let compiles = 0;
    const compile = (): RegExp => {
      compiles += 1;
      return /^a+$/;
    };
    const first = cachedRegExp('suite-a', compile);
    expect(cachedRegExp('suite-a', compile)).toBe(first);
    expect(compiles).toBe(1);
  });

  it('shares stateless regexes safely across alternating tests', () => {
    const re = cachedRegExp('suite-stateless', () => /^a+$/);
    expect(re.test('aa')).toBe(true);
    expect(re.test('b')).toBe(false);
    // A /g/ regex would stick on lastIndex here; the cache must not.
    expect(re.test('aa')).toBe(true);
  });

  it('stays bounded and recompiles after eviction', () => {
    let compiles = 0;
    const trackedKey = 'suite-tracked';
    const compileTracked = (): RegExp => {
      compiles += 1;
      return /^x$/;
    };
    cachedRegExp(trackedKey, compileTracked);
    expect(compiles).toBe(1);
    for (let i = 0; i < REGEXP_CACHE_LIMIT; i++) {
      cachedRegExp(`suite-filler-${String(i)}`, () => /filler/);
    }
    cachedRegExp(trackedKey, compileTracked);
    expect(compiles).toBe(2);
  });
});
