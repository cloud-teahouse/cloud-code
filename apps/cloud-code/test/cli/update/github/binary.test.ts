import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyBinaryUpdate,
  detectBinaryInstall,
  findChecksumForAsset,
} from '#/cli/update/github/binary';
import { SHA256SUMS_ASSET_NAME } from '#/cli/update/github/constants';
import type { GithubRelease } from '#/cli/update/github/types';

// Mutable flag so one test can force the atomic replace to fail (simulating a
// locked running executable, e.g. on Windows) while every other fs op stays
// real — that keeps the rollback path honest.
const renameControl = { fail: false };

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (renameControl.fail) {
        throw new Error('EPERM: operation not permitted, rename');
      }
      return actual.rename(...args);
    },
  };
});

const NEW_BINARY_BYTES = Buffer.from('new-cloud-code-binary-bytes');
const NEW_BINARY_SHA256 = createHash('sha256').update(NEW_BINARY_BYTES).digest('hex');

function sumsContent(sha256: string, assetName = 'cloud-code-linux-x64'): string {
  return `${sha256}  ${assetName}\n${'0'.repeat(64)}  cloud-code-darwin-arm64\n`;
}

function makeRelease(overrides: Partial<GithubRelease> = {}): GithubRelease {
  return {
    tag: 'v0.3.0',
    version: '0.3.0',
    publishedAt: '2026-07-15T08:30:00Z',
    assets: [
      { name: 'cloud-code-linux-x64', downloadUrl: 'https://example.test/cloud-code-linux-x64' },
      { name: SHA256SUMS_ASSET_NAME, downloadUrl: 'https://example.test/sha256sums.txt' },
    ],
    ...overrides,
  };
}

/** URL-routed download mock: serves the sums file and the binary payload. */
function mockDownloadFetch(routes: Record<string, Buffer>): typeof fetch {
  return vi.fn(async (input: string | URL) => {
    const body = routes[String(input)];
    if (body === undefined) {
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  }) as unknown as typeof fetch;
}

let workDir: string;
let execPath: string;

beforeEach(async () => {
  renameControl.fail = false;
  workDir = await mkdtemp(join(tmpdir(), 'cloud-code-update-test-'));
  execPath = join(workDir, 'cloud-code');
  await writeFile(execPath, 'old-binary-bytes', { mode: 0o755 });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('detectBinaryInstall', () => {
  it('treats a build-target-injected release binary as binary', () => {
    expect(
      detectBinaryInstall({ execPath: '/usr/local/bin/cloud-code', buildTarget: 'bun-linux-x64' }),
    ).toEqual({ kind: 'binary', execPath: '/usr/local/bin/cloud-code' });
  });

  it('treats node/bun/tsx runtimes as source installs', () => {
    for (const runtime of ['/usr/bin/node', 'C:\\node\\node.exe', '/home/u/.bun/bin/bun', 'tsx']) {
      expect(detectBinaryInstall({ execPath: runtime, buildTarget: undefined }).kind).toBe(
        'source',
      );
    }
  });

  it('treats a non-runtime execPath as a compiled binary', () => {
    expect(
      detectBinaryInstall({ execPath: '/home/u/bin/cloud-code', buildTarget: undefined }),
    ).toEqual({ kind: 'binary', execPath: '/home/u/bin/cloud-code' });
  });
});

describe('findChecksumForAsset', () => {
  it('finds the digest line for the requested asset', () => {
    expect(findChecksumForAsset(sumsContent(NEW_BINARY_SHA256), 'cloud-code-linux-x64')).toBe(
      NEW_BINARY_SHA256,
    );
  });

  it('returns null when the asset has no entry', () => {
    expect(findChecksumForAsset(sumsContent(NEW_BINARY_SHA256), 'cloud-code-windows-x64.exe')).toBeNull();
  });
});

describe('applyBinaryUpdate', () => {
  const baseDeps = { platform: 'linux' as const, arch: 'x64' };

  it('downloads, verifies, backs up, and atomically replaces the binary', async () => {
    const fetchImpl = mockDownloadFetch({
      'https://example.test/sha256sums.txt': Buffer.from(sumsContent(NEW_BINARY_SHA256)),
      'https://example.test/cloud-code-linux-x64': NEW_BINARY_BYTES,
    });

    const result = await applyBinaryUpdate(makeRelease(), { ...baseDeps, execPath, fetchImpl });

    expect(result).toEqual({
      kind: 'applied',
      version: '0.3.0',
      execPath,
      backupPath: `${execPath}.bak`,
    });
    expect(await readFile(execPath)).toEqual(NEW_BINARY_BYTES);
    expect(await readFile(`${execPath}.bak`, 'utf-8')).toBe('old-binary-bytes');
    // Permission bits survive the replacement.
    expect((await stat(execPath)).mode & 0o777).toBe(0o755);
    // No temp files are left behind.
    await expect(readdir(workDir)).resolves.toEqual(
      expect.arrayContaining(['cloud-code', 'cloud-code.bak']),
    );
    expect((await readdir(workDir)).filter((name) => name.includes('.cloud-code-new-'))).toEqual(
      [],
    );
  });

  it('rejects a corrupt download and leaves the binary untouched', async () => {
    const fetchImpl = mockDownloadFetch({
      'https://example.test/sha256sums.txt': Buffer.from(sumsContent(NEW_BINARY_SHA256)),
      'https://example.test/cloud-code-linux-x64': Buffer.from('tampered-bytes'),
    });

    const result = await applyBinaryUpdate(makeRelease(), { ...baseDeps, execPath, fetchImpl });

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.stage).toBe('checksum');
      expect(result.message).toMatch(/sha256 mismatch/);
    }
    expect(await readFile(execPath, 'utf-8')).toBe('old-binary-bytes');
  });

  it('fails when the release has no asset for this platform', async () => {
    const result = await applyBinaryUpdate(makeRelease({ assets: [] }), {
      ...baseDeps,
      execPath,
      fetchImpl: mockDownloadFetch({}),
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.stage).toBe('asset-missing');
  });

  it('reports unsupported platforms before any download', async () => {
    const fetchImpl = mockDownloadFetch({});
    const result = await applyBinaryUpdate(makeRelease(), {
      platform: 'win32',
      arch: 'arm64',
      execPath,
      fetchImpl,
    });
    expect(result).toEqual({ kind: 'unsupported-platform', platform: 'win32', arch: 'arm64' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails cleanly when the download errors', async () => {
    const fetchImpl = mockDownloadFetch({
      'https://example.test/sha256sums.txt': Buffer.from(sumsContent(NEW_BINARY_SHA256)),
      // Binary URL intentionally unrouted → 404.
    });
    const result = await applyBinaryUpdate(makeRelease(), { ...baseDeps, execPath, fetchImpl });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.stage).toBe('download');
    expect(await readFile(execPath, 'utf-8')).toBe('old-binary-bytes');
  });

  it('restores the backup when the atomic replace fails', async () => {
    renameControl.fail = true;
    const fetchImpl = mockDownloadFetch({
      'https://example.test/sha256sums.txt': Buffer.from(sumsContent(NEW_BINARY_SHA256)),
      'https://example.test/cloud-code-linux-x64': NEW_BINARY_BYTES,
    });

    const result = await applyBinaryUpdate(makeRelease(), { ...baseDeps, execPath, fetchImpl });

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.stage).toBe('replace');
      expect(result.backupPath).toBe(`${execPath}.bak`);
      expect(result.message).toMatch(/EPERM/);
    }
    // Original binary still runs (restored from the backup).
    expect(await readFile(execPath, 'utf-8')).toBe('old-binary-bytes');
  });
});
