import { gt, valid } from 'semver';

/**
 * Strip an optional leading `v`/`=` from a tag and return the semver version,
 * or `null` when the input is not valid semver. Accepts the `v1.2.3` tag
 * format the release workflow publishes as well as bare `1.2.3`.
 */
export function normalizeVersion(tag: string): string | null {
  const trimmed = tag.trim().replace(/^[v=]/i, '');
  return valid(trimmed);
}

/** True when `candidate` is a strictly newer semver version than `current`. */
export function isNewerVersion(current: string, candidate: string): boolean {
  const currentValid = valid(current.trim().replace(/^[v=]/i, ''));
  const candidateValid = valid(candidate.trim().replace(/^[v=]/i, ''));
  if (currentValid === null || candidateValid === null) return false;
  return gt(candidateValid, currentValid);
}

/** True when the input parses as a semver version (with optional `v` prefix). */
export function isValidVersion(input: string): boolean {
  return normalizeVersion(input) !== null;
}
