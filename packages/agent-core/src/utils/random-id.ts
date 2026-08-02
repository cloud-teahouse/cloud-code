import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * `{prefix}{8 base36 chars}`.
 *
 * `randomBytes(8) % 36` has a modest modulo bias (256 % 36 = 4) but over an
 * 8-char suffix yields ~36^8 ≈ 2.8e12 distinct ids, which is more than
 * enough uniqueness for per-session task/message ids.
 */
export function generateBase36Id(prefix: string): string {
  const bytes = randomBytes(8);
  let suffix = '';
  for (let i = 0; i < 8; i++) {
    suffix += ALPHABET[bytes[i]! % 36];
  }
  return `${prefix}${suffix}`;
}
