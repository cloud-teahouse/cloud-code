import { createKimiCodeUserAgent } from '#/cli/version';

import {
  GITHUB_API_TIMEOUT_MS,
  GITHUB_LATEST_RELEASE_URL,
  RELEASE_CHECK_CACHE_TTL_MS,
  githubReleaseByTagUrl,
} from './constants';
import type { GithubRelease, GithubReleaseAsset, ReleaseCheck } from './types';
import { isNewerVersion, normalizeVersion } from './version';

/**
 * Latest-release responses cached in memory for the process lifetime (one TUI
 * session). Only the `latest` endpoint is cached — pinned-tag fetches are
 * explicit user intent and always hit the network. The 10-minute TTL keeps us
 * far below the unauthenticated GitHub API rate limit (60 requests/hour).
 */
interface LatestReleaseCacheEntry {
  readonly fetchedAt: number;
  readonly release: GithubRelease | null;
}

let latestReleaseCache: LatestReleaseCacheEntry | null = null;

/** Reset the in-memory latest-release cache (test hook). */
export function clearReleaseCheckCache(): void {
  latestReleaseCache = null;
}

export interface ReleaseFetchDeps {
  readonly fetchImpl?: typeof fetch;
  /** Injectable clock (ms since epoch) for cache TTL tests. */
  readonly now?: () => number;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetchImpl(input, {
      signal: controller.signal,
      headers: {
        // GitHub rejects API calls without a User-Agent.
        'User-Agent': createKimiCodeUserAgent(),
        Accept: 'application/vnd.github+json',
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse a release JSON payload leniently: unknown fields are ignored so new
 * GitHub/release-workflow fields never break shipped clients. A missing tag
 * is always a hard error; a non-semver tag is a hard error unless
 * `requireSemver` is disabled — rolling channel tags (e.g. `beta`) are not
 * semver, and their callers compare build commits instead of versions.
 */
export function parseGithubRelease(
  payload: unknown,
  opts: { readonly requireSemver?: boolean } = {},
): GithubRelease {
  const requireSemver = opts.requireSemver ?? true;
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('GitHub release payload is not an object');
  }
  const record = payload as Record<string, unknown>;
  if (typeof record['tag_name'] !== 'string' || record['tag_name'].length === 0) {
    throw new Error('GitHub release payload has no tag_name');
  }
  const tagName = record['tag_name'];
  const version = normalizeVersion(tagName) ?? (requireSemver ? null : tagName.replace(/^v/i, ''));
  if (version === null) {
    throw new Error(`GitHub release tag is not semver: ${tagName}`);
  }
  const publishedAtRaw = record['published_at'];
  const publishedAt =
    typeof publishedAtRaw === 'string' && Number.isFinite(Date.parse(publishedAtRaw))
      ? publishedAtRaw
      : '';
  const body = typeof record['body'] === 'string' ? record['body'] : undefined;
  const assets: GithubReleaseAsset[] = [];
  if (Array.isArray(record['assets'])) {
    for (const asset of record['assets'] as unknown[]) {
      if (typeof asset !== 'object' || asset === null) continue;
      const assetRecord = asset as Record<string, unknown>;
      const name = assetRecord['name'];
      const downloadUrl = assetRecord['browser_download_url'];
      if (
        typeof name === 'string' &&
        typeof downloadUrl === 'string' &&
        downloadUrl.startsWith('https://')
      ) {
        assets.push({ name, downloadUrl });
      }
    }
  }
  return body === undefined
    ? { tag: tagName, version, publishedAt, assets }
    : { tag: tagName, version, publishedAt, assets, body };
}

async function fetchReleaseFromUrl(
  url: string,
  fetchImpl: typeof fetch,
  opts: { readonly requireSemver?: boolean } = {},
): Promise<GithubRelease | null> {
  const response = await fetchWithTimeout(fetchImpl, url, GITHUB_API_TIMEOUT_MS);
  // 404 on both endpoints means "nothing published under that name" — the
  // caller decides whether that is "no releases yet" or an unknown tag.
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`GitHub releases API returned HTTP ${response.status}`);
  }
  return parseGithubRelease(JSON.parse(await response.text()), opts);
}

/**
 * Fetch the newest published release, or `null` when the repository has no
 * releases yet. **Throws** on network errors and non-404 HTTP failures;
 * callers must catch and keep previous state intact.
 */
export async function fetchLatestRelease(
  deps: ReleaseFetchDeps = {},
): Promise<GithubRelease | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  if (
    latestReleaseCache !== null &&
    now() - latestReleaseCache.fetchedAt < RELEASE_CHECK_CACHE_TTL_MS
  ) {
    return latestReleaseCache.release;
  }
  const release = await fetchReleaseFromUrl(GITHUB_LATEST_RELEASE_URL, fetchImpl);
  latestReleaseCache = { fetchedAt: now(), release };
  return release;
}

/**
 * Fetch the release for an exact tag (version pinning). `null` when no such
 * tag exists; throws on network/HTTP failures. Never served from the cache.
 */
export async function fetchReleaseByTag(
  tag: string,
  deps: ReleaseFetchDeps = {},
): Promise<GithubRelease | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return fetchReleaseFromUrl(githubReleaseByTagUrl(tag), fetchImpl);
}

/**
 * Fetch a rolling channel release (e.g. the `beta` tag that CI keeps
 * re-pointing at the newest build). Unlike pinned tags, rolling tags are not
 * semver, so parsing skips the semver check; freshness is determined from the
 * build metadata recorded in the release body, not from version comparison.
 */
export async function fetchRollingRelease(
  tag: string,
  deps: ReleaseFetchDeps = {},
): Promise<GithubRelease | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return fetchReleaseFromUrl(githubReleaseByTagUrl(tag), fetchImpl, { requireSemver: false });
}

/**
 * Compare the latest release against `currentVersion`, reporting whether an
 * update is available. Throws when the check itself failed (see
 * `fetchLatestRelease`).
 */
export async function checkForUpdate(
  currentVersion: string,
  deps: ReleaseFetchDeps = {},
): Promise<ReleaseCheck> {
  const release = await fetchLatestRelease(deps);
  if (release === null) {
    return { kind: 'no-releases' };
  }
  if (normalizeVersion(currentVersion) === null) {
    return { kind: 'unknown-version', release };
  }
  if (isNewerVersion(currentVersion, release.version)) {
    return { kind: 'update-available', release };
  }
  return { kind: 'up-to-date', release };
}
