import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseMinisignPublicKey,
  parseMinisignSignature,
  verifyMinisignSignature,
} from '#/cli/update/minisign';
import { RELEASE_SIGNING_PUBLIC_KEYS } from '#/cli/update/release-keys';

/**
 * The fixtures are a real checksum file signed with the production release
 * key, in both the default (`ED`, prehashed) and legacy (`Ed`) minisign
 * formats. Regenerate after a key rotation with:
 *
 *   MINISIGN_SECRET_KEY="$(cat <key file>)" \
 *     node scripts/sign-release.mjs \
 *       apps/cloud-code/test/fixtures/release-signature/sha256sums.txt
 */
const fixtures = join(import.meta.dirname, '../../fixtures/release-signature');
const SUMS = readFileSync(join(fixtures, 'sha256sums.txt'));
const SIGNATURE = readFileSync(join(fixtures, 'sha256sums.txt.minisig'), 'utf-8');
const LEGACY_SIGNATURE = readFileSync(join(fixtures, 'sha256sums.legacy.minisig'), 'utf-8');

/** Replace one base64 line of a signature file, keeping the others intact. */
function withLine(signature: string, index: number, value: string): string {
  const lines = signature.split('\n');
  lines[index] = value;
  return lines.join('\n');
}

describe('parseMinisignPublicKey', () => {
  it('reads the payload line of a minisign.pub file', () => {
    const parsed = parseMinisignPublicKey(
      `untrusted comment: minisign public key\n${RELEASE_SIGNING_PUBLIC_KEYS[0]!}\n`,
    );
    expect(parsed.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(parsed.key).toHaveLength(32);
  });

  it('accepts a bare payload line, which is how the trust root is stored', () => {
    const withComment = parseMinisignPublicKey(
      `untrusted comment: x\n${RELEASE_SIGNING_PUBLIC_KEYS[0]!}\n`,
    );
    const bare = parseMinisignPublicKey(RELEASE_SIGNING_PUBLIC_KEYS[0]!);
    expect(bare.keyId).toBe(withComment.keyId);
  });

  it('rejects a key that is not Ed25519', () => {
    const decoded = Buffer.from(RELEASE_SIGNING_PUBLIC_KEYS[0]!, 'base64');
    decoded.write('Xx', 0, 'latin1');
    expect(() => parseMinisignPublicKey(decoded.toString('base64'))).toThrow(
      /unsupported public key algorithm/,
    );
  });

  it('rejects a truncated key', () => {
    const decoded = Buffer.from(RELEASE_SIGNING_PUBLIC_KEYS[0]!, 'base64').subarray(0, 40);
    expect(() => parseMinisignPublicKey(decoded.toString('base64'))).toThrow(/malformed/);
  });
});

describe('parseMinisignSignature', () => {
  it('reads algorithm, key id, and trusted comment', () => {
    const parsed = parseMinisignSignature(SIGNATURE);
    expect(parsed.algorithm).toBe('ED');
    expect(parsed.signature).toHaveLength(64);
    expect(parsed.globalSignature).toHaveLength(64);
    expect(parsed.trustedComment).toContain('file:sha256sums.txt');
  });

  it('reads the legacy whole-file format', () => {
    expect(parseMinisignSignature(LEGACY_SIGNATURE).algorithm).toBe('Ed');
  });

  it('rejects a file that is missing the trusted comment line', () => {
    expect(() => parseMinisignSignature(withLine(SIGNATURE, 2, 'comment: nope'))).toThrow(
      /no trusted comment/,
    );
  });

  it('rejects a file with too few lines', () => {
    expect(() => parseMinisignSignature(SIGNATURE.split('\n').slice(0, 2).join('\n'))).toThrow(
      /four lines/,
    );
  });
});

describe('verifyMinisignSignature', () => {
  it('accepts the release key over its checksum file', () => {
    const verdict = verifyMinisignSignature(SUMS, SIGNATURE);
    expect(verdict).toMatchObject({ ok: true });
  });

  it('accepts the legacy signature format from the same key', () => {
    expect(verifyMinisignSignature(SUMS, LEGACY_SIGNATURE)).toMatchObject({ ok: true });
  });

  it('rejects content that changed after signing', () => {
    const tampered = Buffer.from(SUMS.toString('utf-8').replace('a6da', 'b6da'));
    expect(verifyMinisignSignature(tampered, SIGNATURE)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('does not match'),
    });
  });

  it('rejects a forged trusted comment even when the payload signature is intact', () => {
    const forged = withLine(SIGNATURE, 2, 'trusted comment: file:innocent.txt');
    expect(verifyMinisignSignature(SUMS, forged)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('trusted comment'),
    });
  });

  it('rejects a signature from a key that is not trusted', () => {
    // Same signature, different key id — the swap must not be papered over by
    // trying every trusted key in turn.
    const decoded = Buffer.from(SIGNATURE.split('\n')[1]!, 'base64');
    decoded.write('ffffffffffffffff', 2, 'hex');
    expect(verifyMinisignSignature(SUMS, withLine(SIGNATURE, 1, decoded.toString('base64')))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('untrusted key'),
    });
  });

  it('rejects everything when no trusted key is configured', () => {
    expect(verifyMinisignSignature(SUMS, SIGNATURE, [])).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no trusted release signing key'),
    });
  });

  it('rejects a signature whose base64 was mangled rather than repairing it', () => {
    const mangled = withLine(SIGNATURE, 1, `${SIGNATURE.split('\n')[1]!.slice(0, 40)}!!!`);
    expect(verifyMinisignSignature(SUMS, mangled)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('malformed'),
    });
  });

  it('rejects a signature whose global signature was replaced', () => {
    const swapped = withLine(SIGNATURE, 3, Buffer.alloc(64).toString('base64'));
    expect(verifyMinisignSignature(SUMS, swapped)).toMatchObject({ ok: false });
  });
});
