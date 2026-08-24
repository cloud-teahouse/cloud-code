import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

import { RELEASE_SIGNING_PUBLIC_KEYS } from './release-keys';

/**
 * Minisign signature verification (github.com/jedisct1/minisign).
 *
 * Wire format, base64 payload lines:
 *
 *   public key   line 2 = "Ed" | key_id[8] | public_key[32]
 *   signature    line 2 = alg[2] | key_id[8] | signature[64]
 *                line 3 = "trusted comment: <comment>"
 *                line 4 = global_signature[64]
 *
 * `alg` is `ED` when the signed message is BLAKE2b-512 of the file (minisign's
 * default) and `Ed` when the file itself was signed. Both come from the same
 * secret key, so both are accepted — a release signed with either form by the
 * official CLI verifies here.
 *
 * The global signature covers `signature | trusted_comment`. Verifying it is
 * what keeps the trusted comment trustworthy, so it is never skipped even
 * though nothing here reads the comment back.
 */

/** DER header of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const PUBLIC_KEY_BYTES = 42;
const SIGNATURE_BYTES = 74;
const GLOBAL_SIGNATURE_BYTES = 64;
const TRUSTED_COMMENT_PREFIX = 'trusted comment: ';

export interface MinisignPublicKey {
  readonly keyId: string;
  readonly key: Buffer;
}

export interface MinisignSignature {
  readonly algorithm: 'Ed' | 'ED';
  readonly keyId: string;
  readonly signature: Buffer;
  readonly trustedComment: string;
  readonly globalSignature: Buffer;
}

export type MinisignVerdict =
  | { readonly ok: true; readonly keyId: string; readonly trustedComment: string }
  | { readonly ok: false; readonly reason: string };

export class MinisignFormatError extends Error {}

/**
 * Split on newlines, dropping only a trailing CR. Trusted-comment bytes are
 * covered by the global signature, so their inner whitespace must survive.
 */
function splitLines(text: string): string[] {
  return text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/**
 * `Buffer.from(…, 'base64')` silently skips characters outside the alphabet,
 * which would let a mangled payload decode to something shorter and still
 * plausible. Re-encoding rejects anything that is not exactly this payload.
 */
function decodeFixedBase64(line: string, expectedBytes: number, what: string): Buffer {
  const trimmed = line.trim();
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length !== expectedBytes || decoded.toString('base64') !== trimmed) {
    throw new MinisignFormatError(`malformed ${what}`);
  }
  return decoded;
}

/**
 * Parse a `minisign.pub` file, or just its base64 payload line — the trust
 * root is stored as the bare line, while a file pasted by a user keeps its
 * `untrusted comment:` header.
 */
export function parseMinisignPublicKey(text: string): MinisignPublicKey {
  const lines = splitLines(text).filter((line) => line.trim().length > 0);
  const payload = lines.length > 1 ? lines[1] : lines[0];
  if (payload === undefined) {
    throw new MinisignFormatError('empty public key');
  }
  const decoded = decodeFixedBase64(payload, PUBLIC_KEY_BYTES, 'public key');
  const algorithm = decoded.subarray(0, 2).toString('latin1');
  if (algorithm !== 'Ed') {
    throw new MinisignFormatError(`unsupported public key algorithm ${algorithm}`);
  }
  return {
    keyId: decoded.subarray(2, 10).toString('hex'),
    key: decoded.subarray(10),
  };
}

export function parseMinisignSignature(text: string): MinisignSignature {
  const lines = splitLines(text);
  if (lines.length < 4) {
    throw new MinisignFormatError('signature file needs four lines');
  }
  const decoded = decodeFixedBase64(lines[1]!, SIGNATURE_BYTES, 'signature');
  const algorithm = decoded.subarray(0, 2).toString('latin1');
  if (algorithm !== 'Ed' && algorithm !== 'ED') {
    throw new MinisignFormatError(`unsupported signature algorithm ${algorithm}`);
  }
  const trustedLine = lines[2]!;
  if (!trustedLine.startsWith(TRUSTED_COMMENT_PREFIX)) {
    throw new MinisignFormatError('signature file has no trusted comment');
  }
  return {
    algorithm,
    keyId: decoded.subarray(2, 10).toString('hex'),
    signature: decoded.subarray(10),
    trustedComment: trustedLine.slice(TRUSTED_COMMENT_PREFIX.length),
    globalSignature: decodeFixedBase64(lines[3]!, GLOBAL_SIGNATURE_BYTES, 'global signature'),
  };
}

function toPublicKeyObject(rawKey: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
    format: 'der',
    type: 'spki',
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Verify `signatureText` over `content` against the trusted keys. Returns a
 * verdict instead of throwing so callers can report why an update was refused
 * without inventing wording for each failure.
 */
export function verifyMinisignSignature(
  content: Buffer,
  signatureText: string,
  trustedPublicKeys: readonly string[] = RELEASE_SIGNING_PUBLIC_KEYS,
): MinisignVerdict {
  let signature: MinisignSignature;
  let keys: MinisignPublicKey[];
  try {
    signature = parseMinisignSignature(signatureText);
    keys = trustedPublicKeys.map((key) => parseMinisignPublicKey(key));
  } catch (error) {
    return { ok: false, reason: describeError(error) };
  }
  if (keys.length === 0) {
    return { ok: false, reason: 'no trusted release signing key is configured' };
  }

  const trusted = keys.find((candidate) => candidate.keyId === signature.keyId);
  if (trusted === undefined) {
    return { ok: false, reason: `signed by untrusted key ${signature.keyId}` };
  }

  try {
    const publicKey = toPublicKeyObject(trusted.key);
    const message =
      signature.algorithm === 'ED'
        ? createHash('blake2b512').update(content).digest()
        : content;
    if (!verify(null, message, publicKey, signature.signature)) {
      return { ok: false, reason: 'signature does not match the downloaded file' };
    }
    const globalMessage = Buffer.concat([
      signature.signature,
      Buffer.from(signature.trustedComment, 'utf-8'),
    ]);
    if (!verify(null, globalMessage, publicKey, signature.globalSignature)) {
      return { ok: false, reason: 'trusted comment is not signed by the release key' };
    }
  } catch (error) {
    return { ok: false, reason: describeError(error) };
  }

  return { ok: true, keyId: signature.keyId, trustedComment: signature.trustedComment };
}
