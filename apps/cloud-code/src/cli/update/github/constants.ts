/**
 * Release distribution contract for the GitHub Releases binary channel.
 *
 * This module is the single place that knows how release assets are named, so
 * when the release workflow changes its upload layout only this file needs to
 * change. The workflow must publish, for every `v*` tag:
 *
 *   - raw binary assets `cloud-code-<platform>-<arch>[.exe]` (the same names
 *     the bun compile matrix already uses internally),
 *   - a `sha256sums.txt` asset with one `<sha256>  <filename>` line per binary,
 *     and
 *   - a `sha256sums.txt.minisig` detached minisign signature over it.
 *
 * The signature is the trust anchor and the checksums hang off it: one
 * verification against a key pinned in this source tree covers every artifact
 * the release ships. A release missing the signature is refused rather than
 * downgraded to checksums alone, which an attacker who can rewrite assets
 * could satisfy trivially.
 *
 * Download URLs are taken from the release JSON (`browser_download_url`), so
 * only the asset *names* are contractual — not the URL shape.
 */

export const GITHUB_RELEASE_REPO = 'cloud-teahouse/cloud-code';
export const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_RELEASE_REPO}`;
export const GITHUB_LATEST_RELEASE_URL = `${GITHUB_API_BASE}/releases/latest`;

export function githubReleaseByTagUrl(tag: string): string {
  return `${GITHUB_API_BASE}/releases/tags/${encodeURIComponent(tag)}`;
}

/** Asset holding `<sha256>  <filename>` lines for every binary in a release. */
export const SHA256SUMS_ASSET_NAME = 'sha256sums.txt';

/** Detached minisign signature over {@link SHA256SUMS_ASSET_NAME}. */
export const SHA256SUMS_SIGNATURE_ASSET_NAME = `${SHA256SUMS_ASSET_NAME}.minisig`;

/** GitHub API requests are slow enough that the CDN's 3s would false-fail. */
export const GITHUB_API_TIMEOUT_MS = 10_000;

/** Binary payloads are tens of MB; allow real-world download speeds. */
export const GITHUB_DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * How long a `/update` check reuses the previous latest-release response.
 * Keeps unauthenticated API usage far below the 60 requests/hour rate limit.
 */
export const RELEASE_CHECK_CACHE_TTL_MS = 10 * 60_000;

const PLATFORM_ASSET_NAMES: Readonly<Record<string, string>> = {
  'linux-x64': 'cloud-code-linux-x64',
  'linux-arm64': 'cloud-code-linux-arm64',
  'darwin-x64': 'cloud-code-darwin-x64',
  'darwin-arm64': 'cloud-code-darwin-arm64',
  'win32-x64': 'cloud-code-windows-x64.exe',
};

/**
 * Map a Node `platform`/`arch` pair to its release asset name, or `null` when
 * the release workflow does not publish a binary for that combination.
 */
export function getReleaseAssetName(
  platform: NodeJS.Platform,
  arch: string,
): string | null {
  return PLATFORM_ASSET_NAMES[`${platform}-${arch}`] ?? null;
}
