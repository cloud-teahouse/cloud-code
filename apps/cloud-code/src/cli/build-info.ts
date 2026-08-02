declare const __CLOUD_CODE_VERSION__: string | undefined;
declare const __CLOUD_CODE_CHANNEL__: string | undefined;
declare const __CLOUD_CODE_COMMIT__: string | undefined;
declare const __CLOUD_CODE_BUILD_TARGET__: string | undefined;

export interface CloudCodeBuildInfo {
  readonly version?: string;
  readonly channel?: string;
  readonly commit?: string;
  readonly buildTarget?: string;
}

function optionalBuildString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export const CLOUD_CODE_BUILD_INFO: CloudCodeBuildInfo = {
  version:
    typeof __CLOUD_CODE_VERSION__ === 'string'
      ? optionalBuildString(__CLOUD_CODE_VERSION__)
      : undefined,
  channel:
    typeof __CLOUD_CODE_CHANNEL__ === 'string'
      ? optionalBuildString(__CLOUD_CODE_CHANNEL__)
      : undefined,
  commit:
    typeof __CLOUD_CODE_COMMIT__ === 'string'
      ? optionalBuildString(__CLOUD_CODE_COMMIT__)
      : undefined,
  buildTarget:
    typeof __CLOUD_CODE_BUILD_TARGET__ === 'string'
      ? optionalBuildString(__CLOUD_CODE_BUILD_TARGET__)
      : undefined,
};

/**
 * Distribution channel of a build:
 * - `dev` — private-repo CI artifact (`<short8>-dev`); no self-update.
 * - `beta` — public-repo rolling pre-release (`<short8>-beta`); /update
 *   compares the build commit against the rolling `beta` tag.
 * - `release` — tagged `vX.Y.Z` releases; /update compares semver.
 */
export type CloudCodeChannel = 'dev' | 'beta' | 'release';

/**
 * The channel this build belongs to. Injected at compile time via
 * `--define __CLOUD_CODE_CHANNEL__` (see ci.yml / dev-ci.yml / release.yml).
 * A missing or unrecognized value falls back to `'release'`: source runs then
 * keep the historical latest-release check, and a mislabeled build fails
 * toward the safest update path rather than toward silence.
 */
export function getChannel(
  buildInfo: CloudCodeBuildInfo = CLOUD_CODE_BUILD_INFO,
): CloudCodeChannel {
  switch (buildInfo.channel) {
    case 'dev':
    case 'beta':
      return buildInfo.channel;
    default:
      return 'release';
  }
}
