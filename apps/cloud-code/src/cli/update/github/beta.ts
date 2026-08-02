import { fetchRollingRelease, type ReleaseFetchDeps } from './release';
import type { GithubRelease, ReleaseCheck } from './types';

/**
 * Beta-channel update checks.
 *
 * CI republishes every beta build into one rolling pre-release under the
 * fixed `beta` tag, overwriting its assets. Arbitrary commit-short8 builds
 * have no semver ordering, so the workflow records what it built in the
 * release body as machine-readable lines:
 *
 *   build-commit: <full SHA>
 *   build-version: <short8>-beta
 *
 * A beta build updates when the rolling release's commit differs from the
 * commit injected into the running binary (`__CLOUD_CODE_COMMIT__`).
 */

/** Tag of the rolling beta pre-release. */
export const BETA_ROLLING_TAG = 'beta';

/** Extract the `build-commit:` line from a rolling beta release body. */
export function parseBetaBuildCommit(body: string | undefined): string | undefined {
  const match = /^build-commit:[ \t]*([0-9a-f]{7,40})[ \t]*$/im.exec(body ?? '');
  return match?.[1]?.toLowerCase();
}

/** Extract the `build-version:` line from a rolling beta release body. */
export function parseBetaBuildVersion(body: string | undefined): string | undefined {
  const match = /^build-version:[ \t]*(\S+?)[ \t]*$/im.exec(body ?? '');
  return match?.[1];
}

/**
 * Compare the rolling beta release against `currentCommit` (the commit
 * injected into this build). `unknown-version` covers both a build without an
 * injected commit and a beta release whose body lacks the metadata lines —
 * in neither case can freshness be established honestly.
 */
export async function checkBetaForUpdate(
  currentCommit: string | undefined,
  deps: ReleaseFetchDeps = {},
): Promise<ReleaseCheck> {
  const release = await fetchRollingRelease(BETA_ROLLING_TAG, deps);
  if (release === null) {
    return { kind: 'no-releases' };
  }
  const buildVersion = parseBetaBuildVersion(release.body);
  const betaRelease: GithubRelease =
    buildVersion === undefined ? release : { ...release, version: buildVersion };
  const buildCommit = parseBetaBuildCommit(release.body);
  if (currentCommit === undefined || buildCommit === undefined) {
    return { kind: 'unknown-version', release: betaRelease };
  }
  if (buildCommit !== currentCommit.toLowerCase()) {
    return { kind: 'update-available', release: betaRelease };
  }
  return { kind: 'up-to-date', release: betaRelease };
}
