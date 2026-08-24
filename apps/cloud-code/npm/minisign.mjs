/**
 * Minisign verification for the npm installer.
 *
 * The bundled CLI has the same check in `src/cli/update/minisign.ts`, but this
 * script runs from the published package before any build output exists, so it
 * cannot import it. `test/cli/update/release-keys.test.ts` fails when the two
 * implementations' trusted keys drift apart.
 *
 * Format (github.com/jedisct1/minisign), base64 payload lines:
 *
 *   public key   line 2 = "Ed" | key_id[8] | public_key[32]
 *   signature    line 2 = alg[2] | key_id[8] | signature[64]
 *                line 3 = "trusted comment: <comment>"
 *                line 4 = global_signature[64]
 *
 * `alg` is `ED` when BLAKE2b-512 of the file was signed (minisign's default)
 * and `Ed` when the file itself was; both come from the same secret key.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';

/**
 * Trust root — keep in sync with `src/cli/update/release-keys.ts` and
 * `scripts/install.sh`.
 */
export const RELEASE_SIGNING_PUBLIC_KEYS = [
  'RWRSCedfeEAUBWZPDn2NRhR1Wgb+c3PvDMQYZOKXwpK37dzjBK+XxeZ+',
];

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const TRUSTED_COMMENT_PREFIX = 'trusted comment: ';

function splitLines(text) {
  return text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** Re-encoding rejects payloads `Buffer.from(…, 'base64')` would silently repair. */
function decodeFixedBase64(line, expectedBytes, what) {
  const trimmed = (line ?? '').trim();
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length !== expectedBytes || decoded.toString('base64') !== trimmed) {
    throw new Error(`malformed ${what}`);
  }
  return decoded;
}

export function parseMinisignPublicKey(text) {
  const lines = splitLines(text).filter((line) => line.trim().length > 0);
  const payload = lines.length > 1 ? lines[1] : lines[0];
  const decoded = decodeFixedBase64(payload, 42, 'public key');
  const algorithm = decoded.subarray(0, 2).toString('latin1');
  if (algorithm !== 'Ed') throw new Error(`unsupported public key algorithm ${algorithm}`);
  return { keyId: decoded.subarray(2, 10).toString('hex'), key: decoded.subarray(10) };
}

export function parseMinisignSignature(text) {
  const lines = splitLines(text);
  if (lines.length < 4) throw new Error('signature file needs four lines');
  const decoded = decodeFixedBase64(lines[1], 74, 'signature');
  const algorithm = decoded.subarray(0, 2).toString('latin1');
  if (algorithm !== 'Ed' && algorithm !== 'ED') {
    throw new Error(`unsupported signature algorithm ${algorithm}`);
  }
  const trustedLine = lines[2];
  if (!trustedLine.startsWith(TRUSTED_COMMENT_PREFIX)) {
    throw new Error('signature file has no trusted comment');
  }
  return {
    algorithm,
    keyId: decoded.subarray(2, 10).toString('hex'),
    signature: decoded.subarray(10),
    trustedComment: trustedLine.slice(TRUSTED_COMMENT_PREFIX.length),
    globalSignature: decodeFixedBase64(lines[3], 64, 'global signature'),
  };
}

/** Returns `{ ok: true, keyId }` or `{ ok: false, reason }`. */
export function verifyMinisignSignature(
  content,
  signatureText,
  trustedPublicKeys = RELEASE_SIGNING_PUBLIC_KEYS,
) {
  let signature;
  let keys;
  try {
    signature = parseMinisignSignature(signatureText);
    keys = trustedPublicKeys.map((key) => parseMinisignPublicKey(key));
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const trusted = keys.find((candidate) => candidate.keyId === signature.keyId);
  if (trusted === undefined) {
    return { ok: false, reason: `signed by untrusted key ${signature.keyId}` };
  }
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, trusted.key]),
      format: 'der',
      type: 'spki',
    });
    const message =
      signature.algorithm === 'ED'
        ? createHash('blake2b512').update(content).digest()
        : content;
    if (!verify(null, message, publicKey, signature.signature)) {
      return { ok: false, reason: 'signature does not match the downloaded file' };
    }
    // The global signature is what makes the trusted comment trustworthy.
    const globalMessage = Buffer.concat([
      signature.signature,
      Buffer.from(signature.trustedComment, 'utf-8'),
    ]);
    if (!verify(null, globalMessage, publicKey, signature.globalSignature)) {
      return { ok: false, reason: 'trusted comment is not signed by the release key' };
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, keyId: signature.keyId, trustedComment: signature.trustedComment };
}
