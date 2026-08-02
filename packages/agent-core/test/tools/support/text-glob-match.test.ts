/**
 * Text-glob semantics for non-path rule subjects (command text, URLs, search
 * patterns): `*` and `?` must cross `/`. Under plain picomatch path semantics
 * `deny Bash(rm *)` silently failed to match `rm -rf /tmp/x` — a fail-open on
 * exactly the deny rules users write for protection.
 */

import { describe, expect, it } from 'vitest';

import { textGlobMatch } from '../../../src/tools/support/path-glob-match';
import {
  escapeRuleSubjectLiteral,
  matchesGlobRuleSubject,
} from '../../../src/tools/support/rule-match';

describe('textGlobMatch', () => {
  it('lets * cross / in command arguments (the deny fail-open)', () => {
    expect(textGlobMatch('rm -rf /tmp/x', 'rm *')).toBe(true);
    expect(textGlobMatch('curl https://evil.example/x', 'curl *')).toBe(true);
    expect(textGlobMatch('git checkout feature/foo', 'git checkout *')).toBe(true);
  });

  it('still rejects commands outside the prefix', () => {
    expect(textGlobMatch('npm test', 'git *')).toBe(false);
    expect(textGlobMatch('git push', 'git checkout *')).toBe(false);
    // A prefix rule requires the separating space: `git *` is not `gitx`.
    expect(textGlobMatch('gitx', 'git *')).toBe(false);
  });

  it('lets ? match any single character, / included', () => {
    expect(textGlobMatch('a/b', 'a?b')).toBe(true);
    expect(textGlobMatch('axb', 'a?b')).toBe(true);
    expect(textGlobMatch('ab', 'a?b')).toBe(false);
  });

  it('keeps picomatch features working (widening union, not replacement)', () => {
    // Brace sets and character classes only exist on the picomatch arm.
    expect(textGlobMatch('git fetch', 'git {fetch,pull}')).toBe(true);
    expect(textGlobMatch('git pull', 'git {fetch,pull}')).toBe(true);
    expect(textGlobMatch('git push', 'git {fetch,pull}')).toBe(false);
    expect(textGlobMatch('ab1', 'ab[0-9]')).toBe(true);
    expect(textGlobMatch('abx', 'ab[0-9]')).toBe(false);
  });

  it('treats backslash-escaped wildcards as literals', () => {
    expect(textGlobMatch('rm *', 'rm \\*')).toBe(true);
    expect(textGlobMatch('rm x', 'rm \\*')).toBe(false);
  });

  it('does not let regex metacharacters in the value or pattern leak', () => {
    expect(textGlobMatch('echo $(whoami)', 'echo $(whoami)')).toBe(true);
    expect(textGlobMatch('echo hi', 'echo .*')).toBe(false);
  });
});

describe('matchesGlobRuleSubject with text semantics', () => {
  it('deny-style subjects with paths now match their rule', () => {
    expect(matchesGlobRuleSubject('rm *', 'rm -rf /tmp/x')).toBe(true);
    expect(matchesGlobRuleSubject('git push *', 'git push origin feature/x')).toBe(true);
  });

  it('negated rules invert across the widened match', () => {
    expect(matchesGlobRuleSubject('!rm *', 'rm -rf /tmp/x')).toBe(false);
    expect(matchesGlobRuleSubject('!rm *', 'ls -la')).toBe(true);
  });

  it('round-trips literals produced by escapeRuleSubjectLiteral', () => {
    const command = 'grep -r "TODO(*)" src/ && echo done';
    expect(matchesGlobRuleSubject(escapeRuleSubjectLiteral(command), command)).toBe(true);
    expect(matchesGlobRuleSubject(escapeRuleSubjectLiteral(command), 'grep -r x')).toBe(false);
  });

  it('URL rules cover whole path suffixes', () => {
    expect(matchesGlobRuleSubject('https://docs.example.com/*', 'https://docs.example.com/a/b/c')).toBe(
      true,
    );
    expect(matchesGlobRuleSubject('https://docs.example.com/*', 'https://evil.example/x')).toBe(false);
  });
});
