import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

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

/**
 * Signature checking is the one part of the installer with no Node in reach,
 * so it is exercised against the same signed fixture the CLI's own verifier
 * uses. On this machine the python3 branch is what runs; a host with minisign
 * installed takes the other branch and must reach the same verdicts.
 */
describe('install.sh verify_signature', () => {
  const fixtures = resolve(import.meta.dirname, '../fixtures/release-signature');
  const workDir = mkdtempSync(join(tmpdir(), 'install-sh-signature-'));

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  /** Copy the fixture pair into the temp dir, optionally rewriting either half. */
  function stage(
    name: string,
    edit: { content?: string; signature?: (text: string) => string } = {},
  ): [string, string] {
    const contentPath = join(workDir, `${name}.txt`);
    const signaturePath = join(workDir, `${name}.txt.minisig`);
    const signature = readFileSync(join(fixtures, 'sha256sums.txt.minisig'), 'utf-8');
    writeFileSync(
      contentPath,
      edit.content ?? readFileSync(join(fixtures, 'sha256sums.txt'), 'utf-8'),
    );
    writeFileSync(signaturePath, edit.signature === undefined ? signature : edit.signature(signature));
    return [contentPath, signaturePath];
  }

  it('accepts a checksum file signed by the release key', async () => {
    const [content, signature] = stage('valid');
    await expect(runFn('verify_signature', content, signature)).resolves.toBeDefined();
  });

  it('accepts the legacy minisign format from the same key', async () => {
    const contentPath = join(workDir, 'legacy.txt');
    const signaturePath = join(workDir, 'legacy.txt.minisig');
    writeFileSync(contentPath, readFileSync(join(fixtures, 'sha256sums.txt')));
    writeFileSync(signaturePath, readFileSync(join(fixtures, 'sha256sums.legacy.minisig')));
    await expect(runFn('verify_signature', contentPath, signaturePath)).resolves.toBeDefined();
  });

  it('rejects checksums edited after signing', async () => {
    const original = readFileSync(join(fixtures, 'sha256sums.txt'), 'utf-8');
    const [content, signature] = stage('tampered', {
      content: original.replace(/^./, 'b'),
    });
    await expect(runFn('verify_signature', content, signature)).rejects.toMatchObject({ code: 1 });
  });

  it('rejects a forged trusted comment', async () => {
    const [content, signature] = stage('forged-comment', {
      signature: (text) => {
        const lines = text.split('\n');
        lines[2] = 'trusted comment: file:innocent.txt';
        return lines.join('\n');
      },
    });
    await expect(runFn('verify_signature', content, signature)).rejects.toMatchObject({ code: 1 });
  });

  it('rejects a signature from an untrusted key', async () => {
    const [content, signature] = stage('wrong-key', {
      signature: (text) => {
        const lines = text.split('\n');
        const decoded = Buffer.from(lines[1]!, 'base64');
        decoded.write('ffffffffffffffff', 2, 'hex');
        lines[1] = decoded.toString('base64');
        return lines.join('\n');
      },
    });
    await expect(runFn('verify_signature', content, signature)).rejects.toMatchObject({ code: 1 });
  });

  it('refuses to pass when no verifier is available rather than skipping the check', async () => {
    const [content, signature] = stage('no-verifier');
    // PATH is emptied after sourcing so bash itself still resolves, but no
    // verifier does.
    await expect(
      execFileAsync('bash', [
        '-c',
        'INSTALL_SH_SOURCE_ONLY=1; source "$1"; shift; PATH=/nonexistent; "$@"',
        'install-sh-test',
        script,
        'verify_signature',
        content,
        signature,
      ]),
    ).rejects.toMatchObject({ code: 1 });
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
