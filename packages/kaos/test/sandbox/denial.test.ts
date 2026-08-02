import { describe, expect, it } from 'vitest';

import { isLikelySandboxDenied } from '#/sandbox/denial';

// Mirrors codex `exec_tests.rs` coverage of `is_likely_sandbox_denied`:
// keyword hits (any stream, case-insensitive) → true; bare shell exit codes
// 2/126/127 → false; 128+SIGSYS → true; everything else non-zero → false.

describe('isLikelySandboxDenied', () => {
  it('returns false for exit code 0 even with denial-looking output', () => {
    expect(
      isLikelySandboxDenied({ exitCode: 0, stderr: 'permission denied', stdout: '' }),
    ).toBe(false);
  });

  it.each([
    'Operation not permitted',
    'Permission denied',
    'Read-only file system',
    'seccomp: attempted action blocked',
    'blocked by sandbox',
    'landlock: restricted',
    'failed to write file',
    'Device or resource busy',
  ])('returns true when stderr contains %j (any case)', (fragment) => {
    expect(isLikelySandboxDenied({ exitCode: 1, stderr: fragment, stdout: '' })).toBe(true);
    expect(isLikelySandboxDenied({ exitCode: 1, stderr: fragment.toUpperCase(), stdout: '' })).toBe(
      true,
    );
  });

  it('matches keywords in stdout as well as stderr', () => {
    expect(isLikelySandboxDenied({ exitCode: 1, stdout: 'touch: /etc/x: Permission denied' })).toBe(
      true,
    );
  });

  it('matches keywords in the aggregated output field', () => {
    expect(
      isLikelySandboxDenied({ exitCode: 1, output: 'EACCES: operation not permitted, open' }),
    ).toBe(true);
  });

  it('lets keywords win over quick-reject exit codes', () => {
    // codex checks keywords before the 2/126/127 quick reject.
    expect(isLikelySandboxDenied({ exitCode: 126, stderr: 'permission denied' })).toBe(true);
  });

  it.each([2, 126, 127])('returns false for bare exit code %i without keywords', (exitCode) => {
    expect(isLikelySandboxDenied({ exitCode, stderr: 'some other failure' })).toBe(false);
  });

  it('returns true for 128+SIGSYS (159) without keywords', () => {
    expect(isLikelySandboxDenied({ exitCode: 159, stderr: '' })).toBe(true);
  });

  it('returns false for generic non-zero failures', () => {
    expect(isLikelySandboxDenied({ exitCode: 1, stderr: 'npm ERR! code ERESOLVE' })).toBe(false);
    expect(isLikelySandboxDenied({ exitCode: 42, stdout: 'assertion failed' })).toBe(false);
  });
});
