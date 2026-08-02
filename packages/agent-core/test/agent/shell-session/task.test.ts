/**
 * ShellSessionTask settlement semantics (RFC `docs/rfc/unified-exec-pty.md`
 * v2 acceptance): a session whose transport drops mid-stream — the SSH
 * channel closes without an exit status, so `wait()` rejects — settles
 * `failed` with a *readable* stopReason; a plain non-zero remote exit
 * settles `failed` with the exit code and no stopReason (the TaskOutput
 * contract: ordinary failures are judged by exit_code).
 */

import { PassThrough, Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { KaosPtyProcess } from '@cloud-code/kaos';
import { describe, expect, it, vi } from 'vitest';

import { ShellSessionTask } from '../../../src/agent/shell-session';
import { createBackgroundManager } from '../background/helpers';
import { fakePtyProcess } from './helpers';

/** A PTY process whose connection drops: output ends, then wait() rejects. */
function disconnectPtyProcess(): {
  readonly proc: KaosPtyProcess;
  readonly output: PassThrough;
  drop: (message: string) => void;
} {
  const output = new PassThrough();
  let rejectWait: (error: Error) => void = () => {};
  const waitPromise = new Promise<number>((_resolve, reject) => {
    rejectWait = reject;
  });
  // The rejection is delivered to the registering task; keep a sink so a slow
  // registrar never trips unhandled-rejection detection.
  void waitPromise.catch(() => {});
  const proc: KaosPtyProcess = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: output,
    stderr: Readable.from([]),
    output,
    pid: -1,
    exitCode: null,
    wait: vi.fn(() => waitPromise) as KaosPtyProcess['wait'],
    kill: vi.fn(async () => {}) as KaosPtyProcess['kill'],
    dispose: vi.fn(() => {
      output.destroy();
    }) as KaosPtyProcess['dispose'],
    write: vi.fn(),
    resize: vi.fn(),
  };
  return {
    proc,
    output,
    drop: (message) => {
      output.end();
      rejectWait(new Error(message));
    },
  };
}

function registerSession(manager: ReturnType<typeof createBackgroundManager>['manager'], proc: KaosPtyProcess, command: string): string {
  return manager.registerTask(
    new ShellSessionTask(
      proc,
      command,
      `Session: ${command}`,
      () => {},
      () => {},
    ),
  );
}

describe('ShellSessionTask settlement', () => {
  it('a dropped connection settles failed with a readable stopReason', async () => {
    const { manager } = createBackgroundManager();
    const { proc, output, drop } = disconnectPtyProcess();
    const taskId = registerSession(manager, proc, 'ssh host bash');

    output.write('partial line\n');
    drop('SSH channel closed before the remote command reported an exit status; the connection was lost mid-session.');

    const info = await manager.wait(taskId, 5_000);
    expect(info?.status).toBe('failed');
    expect(info?.stopReason).toContain('connection was lost mid-session');
    // No fabricated exit code: the remote command's fate is unknown.
    expect(info).toMatchObject({ kind: 'pty-session', exitCode: null });
  });

  it('a dropped connection still fires onExit so the manager retires the session', async () => {
    const { manager } = createBackgroundManager();
    const { proc, output, drop } = disconnectPtyProcess();
    const onExit = vi.fn();
    const taskId = manager.registerTask(
      new ShellSessionTask(proc, 'ssh host bash', 'Session: ssh host bash', () => {}, onExit),
    );

    output.write('partial line\n');
    drop('SSH channel closed before the remote command reported an exit status; the connection was lost mid-session.');

    const info = await manager.wait(taskId, 5_000);
    expect(info?.status).toBe('failed');
    // No exit status was ever reported: the best-known code is a generic
    // failure, and the task's own exitCode stays null (no fabrication).
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(1);
    expect(info).toMatchObject({ kind: 'pty-session', exitCode: null });
  });

  it('a plain non-zero exit settles failed with the exit code and no stopReason', async () => {
    const { manager } = createBackgroundManager();
    const fake = fakePtyProcess();
    const taskId = registerSession(manager, fake.proc, 'bash');

    fake.exit(1);
    const info = await manager.wait(taskId, 5_000);
    expect(info?.status).toBe('failed');
    expect(info?.stopReason).toBeUndefined();
    expect(info).toMatchObject({ kind: 'pty-session', exitCode: 1 });
  });

  it('a clean exit settles completed', async () => {
    const { manager } = createBackgroundManager();
    const fake = fakePtyProcess();
    const taskId = registerSession(manager, fake.proc, 'bash');

    fake.exit(0);
    const info = await manager.wait(taskId, 5_000);
    expect(info?.status).toBe('completed');
    expect(info).toMatchObject({ kind: 'pty-session', exitCode: 0 });
  });
});
