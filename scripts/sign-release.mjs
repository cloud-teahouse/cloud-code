#!/usr/bin/env node
/**
 * Sign a release artifact with the minisign secret key held in
 * `MINISIGN_SECRET_KEY` (the whole `.key` file, as published by `minisign -G
 * -W`), writing `<file>.minisig` next to it.
 *
 *   MINISIGN_SECRET_KEY="$(cat cloud-code.key)" node scripts/sign-release.mjs release/sha256sums.txt
 *
 * The output is ordinary minisign: `minisign -Vm <file> -P <public key>`
 * verifies it, and so does the check compiled into the CLI. Signing runs here
 * rather than through the minisign CLI so the release workflow needs no extra
 * binary, and so the signature is immediately re-verified with the very code
 * that will gate installs — a key or format mistake fails the build instead of
 * shipping an unverifiable release.
 *
 * Only password-less keys are accepted: a release job cannot answer a prompt,
 * and a key whose password sat in a second secret would not be better
 * protected than the key itself.
 */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import {
  RELEASE_SIGNING_PUBLIC_KEYS,
  verifyMinisignSignature,
} from '../apps/cloud-code/npm/minisign.mjs';

/** DER header of an Ed25519 PrivateKeyInfo; the raw 32-byte seed follows. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const SECRET_KEY_BYTES = 158;
const UNTRUSTED_COMMENT = 'signature from the Cloud Code CLI release key';

function fail(message) {
  process.stderr.write(`sign-release: ${message}\n`);
  process.exit(1);
}

/**
 * Layout of a minisign `.key` file:
 *   "Ed" | kdf_alg[2] | cksum_alg[2] | salt[32] | opslimit[8] | memlimit[8]
 *       | key_id[8] | secret_key[64] | checksum[32]
 * `kdf_alg` is zero exactly when the key is not password-protected, which is
 * the only case this script handles.
 */
function parseSecretKey(text) {
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const payload = lines.find((line, index) => index > 0 && line.trim().length > 0);
  if (payload === undefined) fail('MINISIGN_SECRET_KEY is not a minisign secret key file');
  const decoded = Buffer.from(payload.trim(), 'base64');
  if (decoded.length !== SECRET_KEY_BYTES) fail('malformed minisign secret key');
  if (decoded.subarray(0, 2).toString('latin1') !== 'Ed') fail('unsupported secret key algorithm');
  if (decoded.readUInt16BE(2) !== 0) {
    fail('the release key is password-protected; re-create it with `minisign -C -W`');
  }
  const keynum = decoded.subarray(54);
  return {
    keyId: keynum.subarray(0, 8),
    // An Ed25519 secret key is seed | public key; node only wants the seed.
    seed: keynum.subarray(8, 40),
  };
}

function signDetached(seed, message) {
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  return sign(null, message, key);
}

const target = process.argv[2];
if (target === undefined) fail('usage: sign-release.mjs <file>');

const secret = process.env['MINISIGN_SECRET_KEY'];
if (secret === undefined || secret.trim().length === 0) {
  fail('MINISIGN_SECRET_KEY is not set');
}

const { keyId, seed } = parseSecretKey(secret);
const content = readFileSync(target);

// `ED` (sign the BLAKE2b-512 hash) is what minisign itself emits by default,
// so a signature produced here is indistinguishable from one it would make.
const signature = signDetached(seed, createHash('blake2b512').update(content).digest());
const trustedComment =
  `timestamp:${Math.floor(Date.now() / 1000)}\tfile:${basename(target)}\thashed`;
const globalSignature = signDetached(
  seed,
  Buffer.concat([signature, Buffer.from(trustedComment, 'utf-8')]),
);

const signatureFile =
  `untrusted comment: ${UNTRUSTED_COMMENT}\n` +
  `${Buffer.concat([Buffer.from('ED', 'latin1'), keyId, signature]).toString('base64')}\n` +
  `trusted comment: ${trustedComment}\n` +
  `${globalSignature.toString('base64')}\n`;

const verdict = verifyMinisignSignature(content, signatureFile, RELEASE_SIGNING_PUBLIC_KEYS);
if (!verdict.ok) {
  fail(`refusing to write a signature the client would reject: ${verdict.reason}`);
}

writeFileSync(`${target}.minisig`, signatureFile);
process.stdout.write(`sign-release: signed ${target} with key ${verdict.keyId}\n`);
