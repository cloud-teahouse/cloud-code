/** One downloadable file attached to a GitHub release. */
export interface GithubReleaseAsset {
  readonly name: string;
  readonly downloadUrl: string;
}

/**
 * Parsed view of a GitHub release JSON payload. `version` is the tag with any
 * leading `v` stripped — semver-validated for tagged releases, but a rolling
 * channel release (the `beta` tag) keeps its non-semver tag or build version
 * instead. `body` carries the raw release notes when the payload has them
 * (the rolling beta release records its build commit/version there).
 */
export interface GithubRelease {
  readonly tag: string;
  readonly version: string;
  readonly publishedAt: string;
  readonly assets: readonly GithubReleaseAsset[];
  readonly body?: string;
}

export type ReleaseCheck =
  | { readonly kind: 'update-available'; readonly release: GithubRelease }
  | { readonly kind: 'up-to-date'; readonly release: GithubRelease }
  /** The repository has no published releases yet (API answered 404). */
  | { readonly kind: 'no-releases' }
  /** The current version is not valid semver, so no comparison is possible. */
  | { readonly kind: 'unknown-version'; readonly release: GithubRelease };

/** Where the running process executes from, for the binary update path. */
export type BinaryInstall =
  | { readonly kind: 'binary'; readonly execPath: string }
  | { readonly kind: 'source' };

export type BinaryUpdateResult =
  | {
      readonly kind: 'applied';
      readonly version: string;
      readonly execPath: string;
      readonly backupPath: string;
    }
  | { readonly kind: 'unsupported-platform'; readonly platform: string; readonly arch: string }
  | {
      readonly kind: 'failed';
      readonly stage: 'asset-missing' | 'download' | 'signature' | 'checksum' | 'replace';
      readonly message: string;
      readonly execPath: string;
      /** Set once a backup exists so the UI can print a restore hint. */
      readonly backupPath: string | null;
    };
