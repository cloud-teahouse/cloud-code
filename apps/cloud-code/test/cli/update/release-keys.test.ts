import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseMinisignPublicKey } from '#/cli/update/minisign';
import { RELEASE_SIGNING_PUBLIC_KEYS } from '#/cli/update/release-keys';

import { RELEASE_SIGNING_PUBLIC_KEYS as NPM_KEYS } from '../../../npm/minisign.mjs';

/**
 * The release trust root is duplicated across surfaces that cannot import each
 * other: the bundled CLI, the npm installer that runs before any build output
 * exists, the shell installer, and the manual-verification command printed in
 * the release notes. A silent drift between them would leave one install path
 * trusting a key the others reject, so it is pinned here instead.
 */
const repoRoot = join(import.meta.dirname, '../../../../..');

function readFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf-8');
}

describe('release signing key', () => {
  it('is a well-formed Ed25519 minisign key', () => {
    expect(RELEASE_SIGNING_PUBLIC_KEYS.length).toBeGreaterThan(0);
    for (const key of RELEASE_SIGNING_PUBLIC_KEYS) {
      expect(parseMinisignPublicKey(key).key).toHaveLength(32);
    }
  });

  it('matches the copy the npm installer verifies against', () => {
    expect(NPM_KEYS).toEqual([...RELEASE_SIGNING_PUBLIC_KEYS]);
  });

  it('matches the copy embedded in install.sh', () => {
    const script = readFile('scripts/install.sh');
    const embedded = /^RELEASE_SIGNING_PUBLIC_KEY="([^"]+)"$/m.exec(script)?.[1];
    expect(embedded).toBe(RELEASE_SIGNING_PUBLIC_KEYS[0]);
  });

  it('matches every key documented for manual verification', () => {
    const documents = ['.github/workflows/release.yml', 'README.md', 'README.zh-CN.md'];
    for (const document of documents) {
      const printed = [...readFile(document).matchAll(/RW[A-Za-z0-9+/]{54}/g)].map(
        (match) => match[0],
      );
      expect(printed.length, `${document} documents no signing key`).toBeGreaterThan(0);
      for (const key of printed) {
        expect(key, `stale signing key in ${document}`).toBe(RELEASE_SIGNING_PUBLIC_KEYS[0]);
      }
    }
  });
});
