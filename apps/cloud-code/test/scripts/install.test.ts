import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Tests for scripts/install.sh (repo root). Pure functions are exercised by
 * sourcing the script with INSTALL_SH_SOURCE_ONLY=1 so main() never runs;
 * end-to-end cases only cover paths that finish before any network access
 * (channel refusal, argument errors, --help).
 */
const execFileAsync = promisify(execFile);
const script = resolve(import.meta.dirname, '../../../../scripts/install.sh');

/** Run one of the script's functions: fn followed by its arguments. */
async function runFn(fn: string, ...args: string[]) {
  return execFileAsync('bash', [
    '-c',
    'INSTALL_SH_SOURCE_ONLY=1; source "$1"; shift; "$@"',
    'install-sh-test',
    script,
    fn,
    ...args,
  ]);
}

/** Run the installer end to end; non-zero exits resolve instead of rejecting. */
interface MainResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runMain(...args: string[]): Promise<MainResult> {
  try {
    const ok = await execFileAsync('bash', [script, ...args]);
    return { code: 0, stdout: ok.stdout, stderr: ok.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

describe('install.sh asset_name (platform map)', () => {
  it('maps every supported os/arch pair to its release asset', async () => {
    const cases: readonly [string, string, string][] = [
      ['linux', 'x86_64', 'cloud-code-linux-x64'],
      ['linux', 'amd64', 'cloud-code-linux-x64'],
      ['linux', 'aarch64', 'cloud-code-linux-arm64'],
      ['linux', 'arm64', 'cloud-code-linux-arm64'],
      ['darwin', 'x86_64', 'cloud-code-darwin-x64'],
      ['darwin', 'arm64', 'cloud-code-darwin-arm64'],
      ['darwin', 'aarch64', 'cloud-code-darwin-arm64'],
    ];
    for (const [os, arch, expected] of cases) {
      const { stdout } = await runFn('asset_name', os, arch);
      expect(stdout.trim()).toBe(expected);
    }
  });

  it('fails for unsupported platforms', async () => {
    await expect(runFn('asset_name', 'linux', 'riscv64')).rejects.toMatchObject({ code: 1 });
    await expect(runFn('asset_name', 'mingw64_nt-10.0', 'x86_64')).rejects.toMatchObject({
      code: 1,
    });
  });
});

describe('install.sh release_base_url (channel resolution)', () => {
  it('resolves release to the latest-release download endpoint', async () => {
    const { stdout } = await runFn('release_base_url', 'release');
    expect(stdout.trim()).toBe(
      'https://github.com/cloud-teahouse/cloud-code/releases/latest/download',
    );
  });

  it('resolves beta to the rolling beta tag', async () => {
    const { stdout } = await runFn('release_base_url', 'beta');
    expect(stdout.trim()).toBe(
      'https://github.com/cloud-teahouse/cloud-code/releases/download/beta',
    );
  });

  it('has no URL for dev', async () => {
    await expect(runFn('release_base_url', 'dev')).rejects.toMatchObject({ code: 1 });
  });
});

describe('install.sh main', () => {
  it('politely refuses the dev channel before any download', async () => {
    const result = await runMain('--channel=dev');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('dev builds are internal CI artifacts');
  });

  it('rejects unknown channels and unknown arguments with usage errors', async () => {
    const badChannel = await runMain('--channel=nightly');
    expect(badChannel.code).toBe(2);
    expect(badChannel.stderr).toContain('unknown channel: nightly');

    const badArg = await runMain('--wat');
    expect(badArg.code).toBe(2);
  });

  it('prints usage with --help', async () => {
    const result = await runMain('--help');
    expect(result.stdout).toContain('--channel=release');
    expect(result.stdout).toContain('--channel=beta');
  });
});
