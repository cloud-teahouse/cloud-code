/**
 * `Kaos.ptyExec` tests.
 *
 * - LocalKaos: real node-pty processes on POSIX (skipped on Windows, v1 is
 *   POSIX-first per RFC `docs/rfc/unified-exec-pty.md` §1.3).
 * - SandboxedKaos: argv decoration at the same bwrap point as execWithEnv,
 *   plus a real-bwrap integration check that the sandbox policy holds
 *   inside a PTY session.
 * - SSHKaos: implemented in v2 — covered by `ssh-pty.test.ts` (mock channels).
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KaosPtyProcess } from '#/pty';
import { LocalKaos } from '#/local';
import { BubblewrapBackend } from '#/sandbox/bubblewrap';
import { SandboxManager } from '#/sandbox/manager';
import { SandboxedKaos } from '#/sandbox/sandboxed-kaos';
import type { SandboxBackend, SandboxExecRequest, SandboxProbeResult } from '#/sandbox/types';
import { SSHKaos } from '#/ssh';

const POSIX = process.platform !== 'win32';
const BWRAP = '/usr/bin/bwrap';

/**
 * Accumulate the merged PTY stream in the background and wait for needles.
 * (No async iteration: leaving a `for await` early destroys the stream.)
 *
 * Needles must be chosen to appear only in *executed output*: a PTY echoes
 * typed input, so waiting for a substring of the command line itself races
 * ahead of execution.
 */
function recordOutput(proc: KaosPtyProcess): {
  text: () => string;
  waitFor: (needle: string | RegExp, timeoutMs?: number) => Promise<string>;
} {
  let acc = '';
  proc.output.on('data', (chunk: string) => {
    acc += chunk;
  });
  const matches = (needle: string | RegExp): boolean =>
    typeof needle === 'string' ? acc.includes(needle) : needle.test(acc);
  return {
    text: () => acc,
    waitFor: async (needle: string | RegExp, timeoutMs = 10_000): Promise<string> => {
      const deadline = Date.now() + timeoutMs;
      while (!matches(needle)) {
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for ${String(needle)}; got: ${JSON.stringify(acc)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return acc;
    },
  };
}

class FakeBackend implements SandboxBackend {
  readonly name = 'fake';
  readonly requests: SandboxExecRequest[] = [];

  constructor(private readonly probeResult: SandboxProbeResult) {}

  probe(): Promise<SandboxProbeResult> {
    return Promise.resolve(this.probeResult);
  }

  buildCommand(req: SandboxExecRequest): { argv: string[]; env: Record<string, string> } {
    this.requests.push(req);
    return { argv: [...req.argv], env: { ...req.env } };
  }
}

describe.skipIf(!POSIX)('LocalKaos.ptyExec', () => {
  let kaos: LocalKaos;
  const live: KaosPtyProcess[] = [];

  beforeEach(async () => {
    kaos = await LocalKaos.create();
  });

  afterEach(async () => {
    for (const proc of live.splice(0)) {
      try {
        await proc.kill('SIGKILL');
      } catch {
        /* already dead */
      }
      await proc.dispose();
    }
  });

  async function spawnPty(
    args: string[],
    env?: Record<string, string>,
  ): Promise<{ proc: KaosPtyProcess; out: ReturnType<typeof recordOutput> }> {
    const proc = await kaos.ptyExec(args, env);
    live.push(proc);
    return { proc, out: recordOutput(proc) };
  }

  it('runs a command in a pty and merges stdout/stderr into one stream', async () => {
    const { proc, out } = await spawnPty(['/bin/bash', '-c', 'echo out; echo err >&2; echo done']);
    const output = await out.waitFor('done');
    expect(output).toContain('out');
    expect(output).toContain('err');
    expect(await proc.wait()).toBe(0);
    expect(proc.exitCode).toBe(0);
  });

  it('reports isatty() to the child (pty semantics), unlike piped exec', async () => {
    const { proc, out } = await spawnPty(['/bin/bash', '-c', 'test -t 1 && echo ISATTY']);
    await out.waitFor('ISATTY');
    expect(await proc.wait()).toBe(0);
  });

  it('write() drives the process stdin and wait() resolves with the exit code', async () => {
    const { proc, out } = await spawnPty(['/bin/bash']);
    proc.write('echo hello-$((20+22))\n');
    const output = await out.waitFor('hello-42');
    expect(output).toContain('hello-42');
    proc.write('exit 3\n');
    expect(await proc.wait()).toBe(3);
    expect(proc.exitCode).toBe(3);
  });

  it('stdin Writable forwards to the pty', async () => {
    const { proc, out } = await spawnPty(['/bin/bash']);
    proc.stdin.write('echo via-$((3+3))\n');
    // `via-6` only exists post-expansion; the echoed command shows `via-$((3+3))`.
    const output = await out.waitFor('via-6');
    expect(output).toContain('via-6');
    proc.write('exit\n');
    await proc.wait();
  });

  it('passes explicit env to the pty child', async () => {
    const { proc, out } = await spawnPty(['/bin/bash', '-c', 'echo "FOO=$FOO"'], {
      FOO: 'pty-env',
    });
    const output = await out.waitFor('FOO=pty-env');
    expect(output).toContain('FOO=pty-env');
    expect(await proc.wait()).toBe(0);
  });

  it('resize() is accepted', async () => {
    const { proc, out } = await spawnPty(['/bin/bash', '-c', 'echo resized']);
    proc.resize(120, 40);
    await out.waitFor('resized');
    expect(await proc.wait()).toBe(0);
  });

  it('kill() terminates the process and wait() settles', { timeout: 15_000 }, async () => {
    // bash forks a grandchild sleep; the group kill (kill(-pid)) reaps the
    // whole group. Note: node-pty reports WEXITSTATUS on signal death, which
    // is 0 for a SIGKILLed leader — so assert that the process dies (wait
    // resolves, exitCode set), not a specific code.
    const { proc } = await spawnPty(['/bin/bash', '-c', 'sleep 300 & sleep 300']);
    await proc.kill('SIGKILL');
    await proc.wait();
    expect(proc.exitCode).not.toBeNull();
  });

  it('rejects without arguments', async () => {
    await expect(kaos.ptyExec([])).rejects.toThrow(/at least one argument/);
  });
});

describe('SandboxedKaos.ptyExec', () => {
  let root: string;
  let inner: LocalKaos;
  const planBase = {
    network: 'allow' as const,
    workspaceCwd: '/work',
  };
  const available: SandboxProbeResult = { available: true, version: '0.0.test' };

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kaos-pty-sandbox-')));
    inner = (await LocalKaos.create()).withCwd(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('wraps argv through the backend and registers the process as sandboxed', async () => {
    const backend = new FakeBackend(available);
    const manager = new SandboxManager({ backends: [backend] });
    const kaos = new SandboxedKaos(inner, manager, { ...planBase, mode: 'auto' });

    const proc = await kaos.ptyExec(['/bin/bash', '-c', 'echo wrapped-pty'], { FOO: 'bar' });
    expect(kaos.wasSandboxed(proc)).toBe(true);
    expect(backend.requests).toHaveLength(1);
    const req = backend.requests[0]!;
    expect(req.argv).toEqual(['/bin/bash', '-c', 'echo wrapped-pty']);
    expect(req.cwd).toBe(root);
    expect(req.env).toEqual({ FOO: 'bar' });

    const out = recordOutput(proc);
    await out.waitFor('wrapped-pty');
    expect(await proc.wait()).toBe(0);
    await proc.dispose();
  });

  it('falls back to unsandboxed ptyExec with a warning when no backend is available', async () => {
    const onWarning = vi.fn();
    const manager = new SandboxManager({ backends: [], onWarning });
    const kaos = new SandboxedKaos(inner, manager, { ...planBase, mode: 'auto' });

    const proc = await kaos.ptyExec(['/bin/bash', '-c', 'echo plain-pty']);
    expect(kaos.wasSandboxed(proc)).toBe(false);
    const out = recordOutput(proc);
    await out.waitFor('plain-pty');
    expect(await proc.wait()).toBe(0);
    expect(onWarning).toHaveBeenCalled();
    await proc.dispose();
  });

  it('fails closed in enforce mode when no backend is available', async () => {
    const manager = new SandboxManager({ backends: [] });
    const kaos = new SandboxedKaos(inner, manager, { ...planBase, mode: 'enforce' });
    await expect(kaos.ptyExec(['/bin/bash'])).rejects.toThrow(/Refusing to run unsandboxed/);
  });
});

// Real bubblewrap: the sandbox policy must hold inside a PTY session
// (RFC acceptance #4: writableRoots outside writes fail, inside writes work).
describe.skipIf(!POSIX || !existsSync(BWRAP))('SandboxedKaos.ptyExec with real bwrap', () => {
  let root: string;
  let workspace: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kaos-pty-bwrap-')));
    workspace = join(root, 'ws');
    mkdirSync(workspace, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('denies writes outside writableRoots and allows them inside', async () => {
    const inner = (await LocalKaos.create()).withCwd(workspace);
    const manager = new SandboxManager({ backends: [new BubblewrapBackend({ bwrapPath: BWRAP })] });
    const kaos = new SandboxedKaos(inner, manager, {
      mode: 'enforce',
      network: 'allow',
      workspaceCwd: workspace,
      writableRoots: [],
      denyReadPaths: [],
    });

    const proc = await kaos.ptyExec(['/bin/bash']);
    const out = recordOutput(proc);
    try {
      // Inside the sandbox `/` is a read-only bind; the workspace is writable.
      // Markers use `$?` so only post-execution output can match (the pty
      // echoes the typed command line verbatim).
      proc.write('cd / && touch /x-denied 2>&1; echo DENY_RC=$?\n');
      const denyOut = await out.waitFor(/DENY_RC=\d+/);
      expect(denyOut).not.toContain('DENY_RC=0');

      proc.write(`touch ${workspace}/x-allowed; echo ALLOW_RC=$?\n`);
      await out.waitFor(/ALLOW_RC=0/);
      expect(existsSync(join(workspace, 'x-allowed'))).toBe(true);

      proc.write('exit\n');
      await proc.wait();
    } finally {
      await proc.kill('SIGKILL').catch(() => {});
      await proc.dispose();
    }
  });
});

describe('SSHKaos.ptyExec', () => {
  it('is implemented (v2) — full coverage lives in ssh-pty.test.ts', async () => {
    // No live connection needed: the call reaches client.exec, which fails
    // fast against the stub client.
    const ssh = Object.assign(Object.create(SSHKaos.prototype), {
      _client: {
        exec: (_command: string, _options: unknown, cb: (err: Error) => void) => {
          cb(new Error('no connection'));
        },
      },
      _cwd: '/home/user',
      _envLayers: [],
    }) as unknown as SSHKaos;
    await expect(ssh.ptyExec(['/bin/bash'])).rejects.toThrow(/no connection/);
  });
});
