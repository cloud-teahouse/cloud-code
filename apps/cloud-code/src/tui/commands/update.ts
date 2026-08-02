import { CLOUD_CODE_BUILD_INFO, getChannel, type CloudCodeChannel } from '#/cli/build-info';
import { getVersion } from '#/cli/version';
import { checkBetaForUpdate } from '#/cli/update/github/beta';
import {
  applyBinaryUpdate,
  detectBinaryInstall,
} from '#/cli/update/github/binary';
import { checkForUpdate, fetchReleaseByTag } from '#/cli/update/github/release';
import type { ApplyBinaryUpdateDeps } from '#/cli/update/github/binary';
import type {
  BinaryInstall,
  BinaryUpdateResult,
  GithubRelease,
  ReleaseCheck,
} from '#/cli/update/github/types';
import { isValidVersion, normalizeVersion } from '#/cli/update/github/version';

import { t } from '../i18n';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

/**
 * `/update` — check for a newer Cloud Code and, for bun-compiled binary
 * installs, download + apply it in place. Behavior follows the build channel
 * (see cli/build-info.ts):
 * - `dev`: refused — dev builds are internal CI artifacts with no published
 *   update source;
 * - `beta`: checks the rolling `beta` pre-release and compares build commits;
 * - `release`: checks the latest tagged release and compares semver.
 * Source/dev and package-manager installs get update guidance instead of a
 * failed replace.
 */

type UpdateCommandArgs =
  | { readonly mode: 'check' }
  | { readonly mode: 'apply'; readonly version: string | null }
  | { readonly mode: 'error'; readonly arg: string };

export function parseUpdateArgs(args: string): UpdateCommandArgs {
  const fields = args.trim().split(/\s+/).filter((field) => field.length > 0);
  const [first, second, ...rest] = fields;
  if (first === undefined || first === 'check') {
    return second === undefined
      ? { mode: 'check' }
      : { mode: 'error', arg: args.trim() };
  }
  if (first === 'apply') {
    if (rest.length > 0) return { mode: 'error', arg: args.trim() };
    if (second !== undefined && !isValidVersion(second)) {
      return { mode: 'error', arg: second };
    }
    return { mode: 'apply', version: second ?? null };
  }
  if (second === undefined && isValidVersion(first)) {
    return { mode: 'apply', version: first };
  }
  return { mode: 'error', arg: args.trim() };
}

/** Injectable seams so command tests never touch the network or the binary. */
export interface UpdateCommandDeps {
  readonly channel: () => CloudCodeChannel;
  readonly checkForUpdate: (currentVersion: string) => Promise<ReleaseCheck>;
  readonly checkBetaForUpdate: () => Promise<ReleaseCheck>;
  readonly fetchReleaseByTag: (tag: string) => Promise<GithubRelease | null>;
  readonly detectBinaryInstall: () => BinaryInstall;
  readonly applyBinaryUpdate: (
    release: GithubRelease,
    deps: ApplyBinaryUpdateDeps,
  ) => Promise<BinaryUpdateResult>;
  readonly currentVersion: () => string;
}

function defaultDeps(host: SlashCommandHost): UpdateCommandDeps {
  return {
    channel: () => getChannel(),
    checkForUpdate: (currentVersion) => checkForUpdate(currentVersion),
    checkBetaForUpdate: () => checkBetaForUpdate(CLOUD_CODE_BUILD_INFO.commit),
    fetchReleaseByTag: (tag) => fetchReleaseByTag(tag),
    detectBinaryInstall: () => detectBinaryInstall(),
    applyBinaryUpdate: (release, deps) => applyBinaryUpdate(release, deps),
    currentVersion: () => host.state.appState.version || getVersion(),
  };
}

export async function handleUpdateCommand(
  host: SlashCommandHost,
  args: string,
  overrides: Partial<UpdateCommandDeps> = {},
): Promise<void> {
  const deps = { ...defaultDeps(host), ...overrides };
  const parsed = parseUpdateArgs(args);
  if (parsed.mode === 'error') {
    host.showError(t('commands.update.unknownArg', { arg: parsed.arg }));
    return;
  }
  const channel = deps.channel();
  if (channel === 'dev') {
    host.showNotice(
      t('commands.update.devUnsupported.title'),
      t('commands.update.devUnsupported.detail'),
    );
    return;
  }
  if (parsed.mode === 'check') {
    await runUpdateCheck(host, deps, channel);
    return;
  }
  await runUpdateApply(host, deps, channel, parsed.version);
}

function checkForChannel(
  deps: UpdateCommandDeps,
  channel: CloudCodeChannel,
): Promise<ReleaseCheck> {
  return channel === 'beta'
    ? deps.checkBetaForUpdate()
    : deps.checkForUpdate(deps.currentVersion());
}

async function runUpdateCheck(
  host: SlashCommandHost,
  deps: UpdateCommandDeps,
  channel: CloudCodeChannel,
): Promise<void> {
  host.showStatus(t('commands.update.checking'), 'textMuted');
  let check: ReleaseCheck;
  try {
    check = await checkForChannel(deps, channel);
  } catch (error) {
    host.showError(t('commands.update.checkFailed', { error: formatErrorMessage(error) }));
    return;
  }
  reportUpdateCheck(host, check, channel);
}

function reportUpdateCheck(
  host: SlashCommandHost,
  check: ReleaseCheck,
  channel: CloudCodeChannel,
): void {
  const beta = channel === 'beta';
  switch (check.kind) {
    case 'no-releases':
      host.showStatus(
        beta ? t('commands.update.betaNoBuilds') : t('commands.update.noReleases'),
        'textMuted',
      );
      return;
    case 'unknown-version':
      host.showStatus(
        beta
          ? t('commands.update.betaUnknownBuild', { version: check.release.version })
          : t('commands.update.unknownVersion', { version: check.release.version }),
        'warning',
      );
      return;
    case 'up-to-date':
      host.showStatus(
        beta
          ? t('commands.update.betaUpToDate', { version: check.release.version })
          : t('commands.update.upToDate', { version: check.release.version }),
        'success',
      );
      return;
    case 'update-available':
      host.showNotice(
        beta
          ? t('commands.update.betaAvailable', {
              version: check.release.version,
              date: formatReleaseDate(check.release),
            })
          : t('commands.update.available', {
              version: check.release.version,
              date: formatReleaseDate(check.release),
            }),
        t('commands.update.availableHint'),
      );
      return;
  }
}

async function runUpdateApply(
  host: SlashCommandHost,
  deps: UpdateCommandDeps,
  channel: CloudCodeChannel,
  pinnedVersion: string | null,
): Promise<void> {
  const release = await resolveApplyTarget(host, deps, channel, pinnedVersion);
  if (release === null) return;

  // Pinned applies target tagged releases on every channel, so beta wording
  // only applies to the rolling-beta (unpinned) path.
  const beta = channel === 'beta' && pinnedVersion === null;
  const install = deps.detectBinaryInstall();
  if (install.kind === 'source') {
    host.showNotice(
      beta
        ? t('commands.update.betaSourceGuidance.title', { version: release.version })
        : t('commands.update.sourceGuidance.title', { version: release.version }),
      beta
        ? t('commands.update.betaSourceGuidance.detail')
        : t('commands.update.sourceGuidance.detail'),
    );
    return;
  }

  host.showStatus(
    beta
      ? t('commands.update.betaDownloading', { version: release.version })
      : t('commands.update.downloading', { version: release.version }),
    'textMuted',
  );
  const result = await deps.applyBinaryUpdate(release, { execPath: install.execPath });
  switch (result.kind) {
    case 'applied':
      host.showNotice(
        beta
          ? t('commands.update.betaApplied', { version: result.version })
          : t('commands.update.applied', { version: result.version }),
        t('commands.update.appliedDetail', { backup: result.backupPath }),
      );
      return;
    case 'unsupported-platform':
      host.showError(
        t('commands.update.unsupportedPlatform', {
          platform: result.platform,
          arch: result.arch,
        }),
      );
      return;
    case 'failed': {
      const detail =
        result.backupPath !== null
          ? t('commands.update.restoreHint', {
              backup: result.backupPath,
              binary: result.execPath,
            })
          : undefined;
      host.showNotice(t('commands.update.applyFailed', { error: result.message }), detail);
      return;
    }
  }
}

/**
 * Resolve which release to install: the pinned tag when given, otherwise the
 * channel's newest build (only when it is actually newer than the running
 * build). Returns `null` after reporting why there is nothing to install.
 */
async function resolveApplyTarget(
  host: SlashCommandHost,
  deps: UpdateCommandDeps,
  channel: CloudCodeChannel,
  pinnedVersion: string | null,
): Promise<GithubRelease | null> {
  if (pinnedVersion !== null) {
    // The release workflow tags releases `v<semver>`; normalize user input.
    // Pinned installs always target tagged releases, on every channel.
    const tag = `v${normalizeVersion(pinnedVersion) ?? pinnedVersion.replace(/^v/i, '')}`;
    let release: GithubRelease | null;
    try {
      release = await deps.fetchReleaseByTag(tag);
    } catch (error) {
      host.showError(t('commands.update.checkFailed', { error: formatErrorMessage(error) }));
      return null;
    }
    if (release === null) {
      host.showError(t('commands.update.pinnedNotFound', { tag }));
      return null;
    }
    return release;
  }

  host.showStatus(t('commands.update.checking'), 'textMuted');
  let check: ReleaseCheck;
  try {
    check = await checkForChannel(deps, channel);
  } catch (error) {
    host.showError(t('commands.update.checkFailed', { error: formatErrorMessage(error) }));
    return null;
  }
  if (check.kind !== 'update-available') {
    reportUpdateCheck(host, check, channel);
    return null;
  }
  return check.release;
}

function formatReleaseDate(release: GithubRelease): string {
  return release.publishedAt.slice(0, 10) || '?';
}
