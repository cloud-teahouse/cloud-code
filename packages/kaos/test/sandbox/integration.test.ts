import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalKaos } from '#/local';
import type { KaosProcess } from '#/process';
import { BubblewrapBackend } from '#/sandbox/bubblewrap';
import { isLikelySandboxDenied } from '#/sandbox/denial';
import { SandboxManager } from '#/sandbox/manager';
import { SandboxedKaos } from '#/sandbox/sandboxed-kaos';
import type { SandboxNetworkMode } from '#/sandbox/types';

// Real bubblewrap integration. Gate on a real smoke run (not just binary
// presence) so distros with user namespaces disabled skip cleanly — the
// same failure the backend probe reports at runtime.
const BWRAP_SMOKE =
  process.platform === 'linux' &&
  spawnSync('bwrap', ['--ro-bind', '/', '/', '--', 'true'], { stdio: 'ignore' }).status === 0;

async function collect(proc: KaosProcess): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const [exitCode, stdoutBuf, stderrBuf] = await Promise.all([
    proc.wait(),
    (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of proc.stdout) chunks.push(Buffer.from(chunk as Buffer));
      return Buffer.concat(chunks);
    })(),
    (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of proc.stderr) chunks.push(Buffer.from(chunk as Buffer));
      return Buffer.concat(chunks);
    })(),
  ]);
  return { exitCode, stdout: stdoutBuf.toString('utf-8'), stderr: stderrBuf.toString('utf-8') };
}

describe.skipIf(!BWRAP_SMOKE)('sandbox integration (real bwrap)', () => {
  let root: string;
  let workspace: string;
  let inner: LocalKaos;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kaos-bwrap-it-')));
    workspace = join(root, 'ws');
    mkdirSync(workspace, { recursive: true });
    inner = (await LocalKaos.create()).withCwd(workspace);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function sandboxed(options?: {
    network?: SandboxNetworkMode;
    denyReadPaths?: readonly string[];
  }): SandboxedKaos {
    const manager = new SandboxManager({ backends: [new BubblewrapBackend()] });
    return new SandboxedKaos(inner, manager, {
      mode: 'enforce',
      network: options?.network ?? 'allow',
      workspaceCwd: workspace,
      denyReadPaths: options?.denyReadPaths ?? [],
    });
  }

  it('probes the local bwrap as available with a version', async () => {
    const probe = await new BubblewrapBackend().probe();
    expect(probe.available).toBe(true);
    if (probe.available) expect(probe.version).toMatch(/^\d+\.\d+/);
  });

  it('reports a missing bwrap binary as unavailable', async () => {
    const probe = await new BubblewrapBackend({ bwrapPath: '/nonexistent/bwrap' }).probe();
    expect(probe.available).toBe(false);
    if (!probe.available) expect(probe.reason).toContain('/nonexistent/bwrap');
  });

  it('allows writes inside the workspace but denies /etc (read-only root)', async () => {
    const kaos = sandboxed();

    const ok = await collect(await kaos.exec('sh', '-c', 'touch "$1" && echo done', 'sh', join(workspace, 'created')));
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.trim()).toBe('done');
    expect(existsSync(join(workspace, 'created'))).toBe(true);

    const target = join('/etc', `cloud-code-bwrap-it-${String(process.pid)}`);
    const denied = await collect(await kaos.exec('touch', target));
    expect(denied.exitCode).not.toBe(0);
    expect(existsSync(target)).toBe(false);
    // The denial heuristic must recognize this as a sandbox denial so the
    // escalation flow would trigger for it.
    expect(isLikelySandboxDenied(denied)).toBe(true);
  });

  it('blocks outbound connections when network is denied', async () => {
    const kaos = sandboxed({ network: 'deny' });
    // bash /dev/tcp: no external binary required; a fresh net namespace has
    // no route (and no loopback listener), so the connect fails fast.
    const result = await collect(await kaos.exec('bash', '-c', 'echo x > /dev/tcp/127.0.0.1/9'));
    expect(result.exitCode).not.toBe(0);
  });

  it('masks deny-read directories (tmpfs) and files (/dev/null)', async () => {
    const secretDir = join(root, 'secret-dir');
    mkdirSync(secretDir);
    writeFileSync(join(secretDir, 'key'), 'dir-secret');
    const secretFile = join(root, 'secret-file');
    writeFileSync(secretFile, 'file-secret');

    const kaos = sandboxed({ denyReadPaths: [secretDir, secretFile] });

    // Directory mask: tmpfs overlay hides the real contents entirely.
    const dir = await collect(await kaos.exec('cat', join(secretDir, 'key')));
    expect(dir.exitCode).not.toBe(0);
    expect(dir.stdout).not.toContain('dir-secret');

    // File mask: /dev/null bound over the file. On kernels that restrict
    // opening device nodes inside unprivileged user namespaces the read
    // fails with EACCES; elsewhere it reads as empty. Either way the
    // contents must not leak.
    const file = await collect(await kaos.exec('cat', secretFile));
    expect(file.stdout).not.toContain('file-secret');
    expect(file.exitCode !== 0 || file.stdout === '').toBe(true);
  });

  it('kills the whole sandboxed process group without residue', async () => {
    const marker = `cloud-code-bwrap-it-${String(process.pid)}-${String(Date.now())}`;
    const kaos = sandboxed();
    const proc = await kaos.exec(
      'bash',
      '-c',
      `exec -a ${marker} sleep 60 & exec -a ${marker} sleep 60`,
    );
    // Give the children a moment to exec, then kill the group.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await proc.kill('SIGKILL');
    await proc.wait().catch(() => -1);
    // The bwrap parent and both sleeps share the detached process group;
    // nothing may survive.
    const ps = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf-8' });
    const survivors = (ps.stdout ?? '')
      .split('\n')
      .filter((line) => line.includes(marker))
      .filter((line) => !line.includes('grep'));
    expect(survivors).toEqual([]);
  });
});
