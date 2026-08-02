import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GITHUB_API_BASE,
  GITHUB_LATEST_RELEASE_URL,
  RELEASE_CHECK_CACHE_TTL_MS,
  SHA256SUMS_ASSET_NAME,
  getReleaseAssetName,
  githubReleaseByTagUrl,
} from '#/cli/update/github/constants';
import {
  checkForUpdate,
  clearReleaseCheckCache,
  fetchLatestRelease,
  fetchReleaseByTag,
  parseGithubRelease,
} from '#/cli/update/github/release';

const RELEASE_BODY = JSON.stringify({
  tag_name: 'v0.3.0',
  published_at: '2026-07-15T08:30:00Z',
  assets: [
    {
      name: 'cloud-code-linux-x64',
      browser_download_url:
        'https://github.com/cloud-teahouse/cloud-code/releases/download/v0.3.0/cloud-code-linux-x64',
    },
    {
      name: SHA256SUMS_ASSET_NAME,
      browser_download_url:
        'https://github.com/cloud-teahouse/cloud-code/releases/download/v0.3.0/sha256sums.txt',
    },
  ],
  // Unknown fields must be ignored so future payloads never break clients.
  future_field: { nested: true },
});

function mockFetchOk(body: string): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => body,
  })) as unknown as typeof fetch;
}

function mockFetchStatus(status: number): typeof fetch {
  return vi.fn(async () => ({
    ok: false,
    status,
    text: async () => '',
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  clearReleaseCheckCache();
});

describe('getReleaseAssetName', () => {
  it('maps every platform/arch the release workflow publishes', () => {
    expect(getReleaseAssetName('linux', 'x64')).toBe('cloud-code-linux-x64');
    expect(getReleaseAssetName('linux', 'arm64')).toBe('cloud-code-linux-arm64');
    expect(getReleaseAssetName('darwin', 'x64')).toBe('cloud-code-darwin-x64');
    expect(getReleaseAssetName('darwin', 'arm64')).toBe('cloud-code-darwin-arm64');
    expect(getReleaseAssetName('win32', 'x64')).toBe('cloud-code-windows-x64.exe');
  });

  it('returns null for combinations without a published binary', () => {
    expect(getReleaseAssetName('win32', 'arm64')).toBeNull();
    expect(getReleaseAssetName('freebsd', 'x64')).toBeNull();
    expect(getReleaseAssetName('linux', 'ia32')).toBeNull();
  });
});

describe('parseGithubRelease', () => {
  it('parses tag, version, date, and https assets', () => {
    const release = parseGithubRelease(JSON.parse(RELEASE_BODY));
    expect(release.tag).toBe('v0.3.0');
    expect(release.version).toBe('0.3.0');
    expect(release.publishedAt).toBe('2026-07-15T08:30:00Z');
    expect(release.assets.map((asset) => asset.name)).toEqual([
      'cloud-code-linux-x64',
      SHA256SUMS_ASSET_NAME,
    ]);
  });

  it('throws when the tag is missing or not semver', () => {
    expect(() => parseGithubRelease({})).toThrow(/tag_name/);
    expect(() => parseGithubRelease({ tag_name: 'nightly' })).toThrow(/not semver/);
  });

  it('drops non-https asset URLs', () => {
    const release = parseGithubRelease({
      tag_name: 'v1.0.0',
      assets: [{ name: 'evil', browser_download_url: 'http://example.com/evil' }],
    });
    expect(release.assets).toEqual([]);
  });
});

describe('fetchLatestRelease', () => {
  it('fetches the latest release with User-Agent and Accept headers', async () => {
    const f = mockFetchOk(RELEASE_BODY);
    const release = await fetchLatestRelease({ fetchImpl: f });
    expect(release?.version).toBe('0.3.0');
    expect(f).toHaveBeenCalledWith(
      GITHUB_LATEST_RELEASE_URL,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          'User-Agent': expect.stringMatching(/^cloud-code-cli\//),
          Accept: 'application/vnd.github+json',
        }),
      }),
    );
  });

  it('returns null when the repository has no releases yet (404)', async () => {
    await expect(
      fetchLatestRelease({ fetchImpl: mockFetchStatus(404) }),
    ).resolves.toBeNull();
  });

  it('throws on other HTTP failures', async () => {
    await expect(fetchLatestRelease({ fetchImpl: mockFetchStatus(500) })).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it('propagates network errors', async () => {
    const f = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(fetchLatestRelease({ fetchImpl: f })).rejects.toThrow(/network down/);
  });

  it('serves repeat checks from the cache within the TTL', async () => {
    const f = mockFetchOk(RELEASE_BODY);
    let clock = 1_000_000;
    const now = () => clock;
    await fetchLatestRelease({ fetchImpl: f, now });
    await fetchLatestRelease({ fetchImpl: f, now });
    expect(f).toHaveBeenCalledTimes(1);

    clock += RELEASE_CHECK_CACHE_TTL_MS + 1;
    await fetchLatestRelease({ fetchImpl: f, now });
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('fetchReleaseByTag', () => {
  it('fetches the tag endpoint and never touches the cache', async () => {
    const f = mockFetchOk(RELEASE_BODY);
    const release = await fetchReleaseByTag('v0.3.0', { fetchImpl: f });
    expect(release?.version).toBe('0.3.0');
    expect(f).toHaveBeenCalledWith(
      `${GITHUB_API_BASE}/releases/tags/v0.3.0`,
      expect.anything(),
    );
    // A second call must hit the network again (pinning is explicit intent).
    await fetchReleaseByTag('v0.3.0', { fetchImpl: f });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('encodes the tag and returns null for unknown tags', async () => {
    const f = mockFetchStatus(404);
    await expect(fetchReleaseByTag('v9.9.9', { fetchImpl: f })).resolves.toBeNull();
    expect(f).toHaveBeenCalledWith(githubReleaseByTagUrl('v9.9.9'), expect.anything());
  });
});

describe('checkForUpdate', () => {
  it('reports update-available with the release', async () => {
    const check = await checkForUpdate('0.2.0', { fetchImpl: mockFetchOk(RELEASE_BODY) });
    expect(check.kind).toBe('update-available');
    if (check.kind === 'update-available') {
      expect(check.release.version).toBe('0.3.0');
    }
  });

  it('reports up-to-date for equal and newer current versions', async () => {
    const f = mockFetchOk(RELEASE_BODY);
    expect((await checkForUpdate('0.3.0', { fetchImpl: f })).kind).toBe('up-to-date');
    clearReleaseCheckCache();
    expect((await checkForUpdate('0.4.0', { fetchImpl: f })).kind).toBe('up-to-date');
  });

  it('reports no-releases on 404', async () => {
    const check = await checkForUpdate('0.2.0', { fetchImpl: mockFetchStatus(404) });
    expect(check.kind).toBe('no-releases');
  });

  it('reports unknown-version when the current version is not semver', async () => {
    const check = await checkForUpdate('dev-build', { fetchImpl: mockFetchOk(RELEASE_BODY) });
    expect(check.kind).toBe('unknown-version');
  });

  it('propagates check failures so callers keep previous state', async () => {
    const f = vi.fn(async () => {
      throw new Error('DNS failure');
    }) as unknown as typeof fetch;
    await expect(checkForUpdate('0.2.0', { fetchImpl: f })).rejects.toThrow(/DNS failure/);
  });
});
