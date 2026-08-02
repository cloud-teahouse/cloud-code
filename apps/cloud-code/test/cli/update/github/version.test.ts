import { describe, expect, it } from 'vitest';

import {
  isNewerVersion,
  isValidVersion,
  normalizeVersion,
} from '#/cli/update/github/version';

describe('normalizeVersion', () => {
  it('accepts bare semver', () => {
    expect(normalizeVersion('1.2.3')).toBe('1.2.3');
  });

  it('strips a leading v from release tags', () => {
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3');
  });

  it('keeps prerelease and build metadata', () => {
    expect(normalizeVersion('v1.2.3-beta.1')).toBe('1.2.3-beta.1');
  });

  it('returns null for invalid input', () => {
    expect(normalizeVersion('not-a-version')).toBeNull();
    expect(normalizeVersion('')).toBeNull();
    expect(normalizeVersion('v')).toBeNull();
  });
});

describe('isNewerVersion', () => {
  it('detects newer versions', () => {
    expect(isNewerVersion('0.2.0', '0.3.0')).toBe(true);
    expect(isNewerVersion('0.2.0', 'v0.2.1')).toBe(true);
  });

  it('rejects equal and older versions', () => {
    expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false);
    expect(isNewerVersion('0.2.0', 'v0.2.0')).toBe(false);
    expect(isNewerVersion('0.2.0', '0.1.9')).toBe(false);
  });

  it('orders prereleases below their release', () => {
    expect(isNewerVersion('0.2.0-beta.1', '0.2.0')).toBe(true);
    expect(isNewerVersion('0.2.0', '0.2.0-beta.1')).toBe(false);
  });

  it('returns false when either side is not semver', () => {
    expect(isNewerVersion('dev', '0.3.0')).toBe(false);
    expect(isNewerVersion('0.2.0', 'latest')).toBe(false);
  });
});

describe('isValidVersion', () => {
  it('accepts semver with or without v prefix', () => {
    expect(isValidVersion('1.2.3')).toBe(true);
    expect(isValidVersion('v1.2.3')).toBe(true);
  });

  it('rejects non-semver', () => {
    expect(isValidVersion('check')).toBe(false);
  });
});
