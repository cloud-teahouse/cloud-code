/**
 * Trust root for release artifacts: the Ed25519 public keys whose signatures
 * `/update` accepts.
 *
 * These live in the source tree on purpose. A checksum file served from the
 * same Release page it describes proves only that a download arrived intact —
 * whoever can rewrite the assets can rewrite the checksums with them. Pinning
 * the key here means a forged release has to also forge a commit in this
 * repository to be accepted.
 *
 * The array is the rotation seam: publish with the new key while the old one
 * is still listed, then drop the old entry once no supported build depends on
 * it. Entries are the base64 payload line of a `minisign.pub` file.
 *
 * The same value is embedded in `scripts/install.sh` and
 * `apps/cloud-code/npm/postinstall.mjs`, which cannot import from here;
 * `test/cli/update/release-keys.test.ts` fails if the three drift apart.
 */
export const RELEASE_SIGNING_PUBLIC_KEYS: readonly string[] = [
  'RWRSCedfeEAUBWZPDn2NRhR1Wgb+c3PvDMQYZOKXwpK37dzjBK+XxeZ+',
];
