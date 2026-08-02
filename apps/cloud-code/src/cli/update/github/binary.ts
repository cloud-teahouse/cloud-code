import { createHash } from 'node:crypto';
import { chmod, copyFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { CLOUD_CODE_BUILD_INFO } from '#/cli/build-info';

import {
  GITHUB_DOWNLOAD_TIMEOUT_MS,
  SHA256SUMS_ASSET_NAME,
  getReleaseAssetName,
} from './constants';
import type { BinaryInstall, BinaryUpdateResult, GithubRelease } from './types';

/**
 * Basenames that mean "we are running inside a runtime", i.e. a dev/source or
 * package-manager install. Anything else is treated as a standalone binary.
 */
const RUNTIME_EXECUTABLE_NAMES = new Set([
  'node',
  'node.exe',
  'bun',
  'bun.exe',
  'tsx',
  'tsx.exe',
]);

export interface DetectBinaryInstallDeps {
  readonly execPath?: string;
  readonly buildTarget?: string | undefined;
}

/**
 * Detect whether this process is a bun-compiled single-file binary.
 *
 * Primary signal: the release build injects `__CLOUD_CODE_BUILD_TARGET__`
 * (see release.yml `--define`), which only exists in compiled artifacts.
 * Fallback heuristic for locally compiled binaries without the define:
 * `process.execPath` is not a Node/Bun/tsx runtime executable.
 */
export function detectBinaryInstall(deps: DetectBinaryInstallDeps = {}): BinaryInstall {
  const execPath = deps.execPath ?? process.execPath;
  const buildTarget = deps.buildTarget === undefined
    ? CLOUD_CODE_BUILD_INFO.buildTarget
    : deps.buildTarget;
  if (typeof buildTarget === 'string' && buildTarget.length > 0) {
    return { kind: 'binary', execPath };
  }
  // Normalize separators so Windows paths classify correctly on any host.
  const executableName = basename(execPath.replaceAll('\\', '/')).toLowerCase();
  if (RUNTIME_EXECUTABLE_NAMES.has(executableName)) {
    return { kind: 'source' };
  }
  return { kind: 'binary', execPath };
}

export interface ApplyBinaryUpdateDeps {
  readonly fetchImpl?: typeof fetch;
  readonly execPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

async function downloadBytes(fetchImpl: typeof fetch, url: string): Promise<Buffer> {
  if (!url.startsWith('https://')) {
    throw new Error(`refusing non-TLS download URL: ${url}`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, GITHUB_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`download failed with HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse `sha256sums.txt` content (`<sha256>  <filename>` lines, the format
 * `sha256sum` emits) and return the digest recorded for `assetName`.
 */
export function findChecksumForAsset(sumsContent: string, assetName: string): string | null {
  for (const line of sumsContent.split('\n')) {
    const match = /^([0-9a-fA-F]{64})[ \t]+\*?(\S+)\s*$/.exec(line.trim());
    if (match !== null && match[2] === assetName) {
      return match[1]!.toLowerCase();
    }
  }
  return null;
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Download `release`'s asset for this platform, verify it against the
 * release's `sha256sums.txt`, then atomically replace the running binary.
 *
 * Safety contract:
 * - the checksum is verified before anything is written near the binary;
 * - the current binary is preserved at `<execPath>.bak` before replacement;
 * - replacement is write-tmp + rename on the same filesystem (atomic);
 * - on replace failure the backup is restored before reporting;
 * - downloaded bytes are never executed.
 */
export async function applyBinaryUpdate(
  release: GithubRelease,
  deps: ApplyBinaryUpdateDeps = {},
): Promise<BinaryUpdateResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const execPath = deps.execPath ?? process.execPath;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;

  const assetName = getReleaseAssetName(platform, arch);
  if (assetName === null) {
    return { kind: 'unsupported-platform', platform, arch };
  }

  const asset = release.assets.find((candidate) => candidate.name === assetName);
  const sumsAsset = release.assets.find((candidate) => candidate.name === SHA256SUMS_ASSET_NAME);
  if (asset === undefined || sumsAsset === undefined) {
    return {
      kind: 'failed',
      stage: 'asset-missing',
      message:
        asset === undefined
          ? `release ${release.tag} has no asset named ${assetName}`
          : `release ${release.tag} has no ${SHA256SUMS_ASSET_NAME} asset`,
      execPath,
      backupPath: null,
    };
  }

  let binaryBytes: Buffer;
  let expectedSha256: string;
  try {
    const sumsBytes = await downloadBytes(fetchImpl, sumsAsset.downloadUrl);
    const checksum = findChecksumForAsset(sumsBytes.toString('utf-8'), assetName);
    if (checksum === null) {
      return {
        kind: 'failed',
        stage: 'checksum',
        message: `${SHA256SUMS_ASSET_NAME} has no entry for ${assetName}`,
        execPath,
        backupPath: null,
      };
    }
    expectedSha256 = checksum;
    binaryBytes = await downloadBytes(fetchImpl, asset.downloadUrl);
  } catch (error) {
    return {
      kind: 'failed',
      stage: 'download',
      message: error instanceof Error ? error.message : String(error),
      execPath,
      backupPath: null,
    };
  }

  const actualSha256 = sha256Hex(binaryBytes);
  if (actualSha256 !== expectedSha256) {
    return {
      kind: 'failed',
      stage: 'checksum',
      message: `sha256 mismatch for ${assetName}: expected ${expectedSha256}, got ${actualSha256}`,
      execPath,
      backupPath: null,
    };
  }

  const backupPath = `${execPath}.bak`;
  const tmpPath = `${execPath}.cloud-code-new-${process.pid}`;
  try {
    // Preserve the current binary's permission bits (fall back to 0755).
    let mode = 0o755;
    try {
      mode = (await stat(execPath)).mode & 0o777;
    } catch {
      // execPath missing or unreadable — the rename below will surface it.
    }
    await writeFile(tmpPath, binaryBytes);
    await chmod(tmpPath, mode);
    await copyFile(execPath, backupPath);
    await rename(tmpPath, execPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    // Best-effort rollback: put the backup back so the install still runs.
    let message = error instanceof Error ? error.message : String(error);
    try {
      await copyFile(backupPath, execPath);
    } catch {
      message += ' (automatic restore from backup also failed)';
    }
    return {
      kind: 'failed',
      stage: 'replace',
      message,
      execPath,
      backupPath,
    };
  }

  return { kind: 'applied', version: release.version, execPath, backupPath };
}
