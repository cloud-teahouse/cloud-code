import { describe, expect, it } from 'vitest';

import {
  BETA_ROLLING_TAG,
  checkBetaForUpdate,
  parseBetaBuildCommit,
  parseBetaBuildVersion,
} from '#/cli/update/github/beta';
import { parseGithubRelease } from '#/cli/update/github/release';

const SHA_CURRENT = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3';
const SHA_PUBLISHED = '2fd4e1c67a2d28fced849ee1bb76e7391b93eb12';

function betaPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: BETA_ROLLING_TAG,
    published_at: '2026-08-01T10:00:00Z',
    body: `build-commit: ${SHA_PUBLISHED}\nbuild-version: 2fd4e1c6-beta\n\nRolling beta build.`,
    assets: [
      {
        name: 'cloud-code-linux-x64',
        browser_download_url: 'https://example.com/cloud-code-linux-x64',
      },
      { name: 'sha256sums.txt', browser_download_url: 'https://example.com/sha256sums.txt' },
    ],
    ...overrides,
  };
}

function fetchJson(payload: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status })) as typeof fetch;
}

describe('parseBetaBuildCommit / parseBetaBuildVersion', () => {
  it('extracts the metadata lines the beta workflow writes', () => {
    const body = `build-commit: ${SHA_PUBLISHED}\nbuild-version: 2fd4e1c6-beta\n\nnotes`;
    expect(parseBetaBuildCommit(body)).toBe(SHA_PUBLISHED);
    expect(parseBetaBuildVersion(body)).toBe('2fd4e1c6-beta');
  });

  it('accepts uppercase hex and trailing whitespace', () => {
    expect(parseBetaBuildCommit(`build-commit:  ${SHA_PUBLISHED.toUpperCase()} \n`)).toBe(
      SHA_PUBLISHED,
    );
  });

  it('returns undefined when the body lacks the lines', () => {
    expect(parseBetaBuildCommit(undefined)).toBeUndefined();
    expect(parseBetaBuildCommit('just release notes')).toBeUndefined();
    expect(parseBetaBuildVersion('build-commit: abc1234')).toBeUndefined();
  });
});

describe('rolling release parsing', () => {
  it('keeps the non-semver rolling tag and the body when semver is not required', () => {
    const release = parseGithubRelease(betaPayload(), { requireSemver: false });
    expect(release.tag).toBe('beta');
    expect(release.version).toBe('beta');
    expect(release.body).toContain(`build-commit: ${SHA_PUBLISHED}`);
    expect(release.assets).toHaveLength(2);
  });

  it('still rejects non-semver tags in the strict (tagged-release) path', () => {
    expect(() => parseGithubRelease(betaPayload())).toThrow('not semver');
  });
});

describe('checkBetaForUpdate', () => {
  it('reports no-releases when the rolling beta tag does not exist yet', async () => {
    const check = await checkBetaForUpdate(SHA_CURRENT, {
      fetchImpl: fetchJson({}, 404),
    });
    expect(check).toEqual({ kind: 'no-releases' });
  });

  it('reports update-available when the published commit differs', async () => {
    const check = await checkBetaForUpdate(SHA_CURRENT, {
      fetchImpl: fetchJson(betaPayload()),
    });
    expect(check.kind).toBe('update-available');
    if (check.kind === 'update-available') {
      // Display version comes from the body's build-version, not the tag.
      expect(check.release.version).toBe('2fd4e1c6-beta');
    }
  });

  it('reports up-to-date when the published commit matches', async () => {
    const check = await checkBetaForUpdate(SHA_PUBLISHED, {
      fetchImpl: fetchJson(betaPayload()),
    });
    expect(check.kind).toBe('up-to-date');
  });

  it('reports unknown-version when the running build has no injected commit', async () => {
    const check = await checkBetaForUpdate(undefined, {
      fetchImpl: fetchJson(betaPayload()),
    });
    expect(check.kind).toBe('unknown-version');
  });

  it('reports unknown-version when the release body lacks the commit line', async () => {
    const check = await checkBetaForUpdate(SHA_CURRENT, {
      fetchImpl: fetchJson(betaPayload({ body: 'hand-written notes' })),
    });
    expect(check.kind).toBe('unknown-version');
  });

  it('falls back to the tag as version when the body lacks build-version', async () => {
    const check = await checkBetaForUpdate(SHA_CURRENT, {
      fetchImpl: fetchJson(betaPayload({ body: `build-commit: ${SHA_PUBLISHED}` })),
    });
    expect(check.kind).toBe('update-available');
    if (check.kind === 'update-available') {
      expect(check.release.version).toBe('beta');
    }
  });

  it('queries the rolling beta tag endpoint', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      urls.push(String(input));
      return new Response(JSON.stringify(betaPayload()), { status: 200 });
    }) as typeof fetch;
    await checkBetaForUpdate(SHA_CURRENT, { fetchImpl });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/releases/tags/beta');
  });
});
