/**
 * SSH PTY tests (RFC `docs/rfc/unified-exec-pty.md` v2).
 *
 * - `SSHKaos.ptyExec`: channel opened through the single `clientExec` point
 *   with ssh2 pty options; the remote command string keeps the exec-family
 *   shape (cd + POSIX inline env assignments, bypassing sshd AcceptEnv).
 * - `SSHPtyProcess`: merged output stream, write/resize/kill wire encoding,
 *   and the exit semantics that distinguish a normal remote exit from a
 *   dropped connection (close without an exit status → wait() rejects with a
 *   readable connection-lost error so session tasks settle failed with a
 *   human-readable stopReason).
 *
 * Channels are scripted fakes (PassThrough + captured lifecycle listeners),
 * the same pattern as `ssh-process.test.ts` — no live SSH server needed.
 */

import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { KaosConnectionError, SSHKaos, SSHPtyProcess } from '#/ssh';

interface FakeChannel {
  readonly channel: unknown;
  readonly writeCalls: string[];
  readonly signalCalls: string[];
  readonly setWindowCalls: number[][];
  emitOutput: (text: string) => void;
  emitExit: (code: number | null) => void;
  emitClose: (code?: number) => void;
  emitError: (err: Error) => void;
}

function createFakeChannel(): FakeChannel {
  const stream = new PassThrough();
  const realWrite = stream.write.bind(stream);
  const writeCalls: string[] = [];
  const signalCalls: string[] = [];
  const setWindowCalls: number[][] = [];

  // Lifecycle listeners captured so the test decides when they fire; stream
  // events ('data', 'end', ...) delegate to the PassThrough.
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  const channel = Object.assign(stream, {
    stderr: new PassThrough(),
    write(chunk: unknown): boolean {
      writeCalls.push(String(chunk));
      return true;
    },
    signal(name: string): void {
      signalCalls.push(name);
    },
    setWindow(rows: number, cols: number, height: number, width: number): void {
      setWindowCalls.push([rows, cols, height, width]);
    },
    on(event: string, cb: (...args: unknown[]) => void): unknown {
      if (event === 'close' || event === 'exit' || event === 'error') {
        let arr = listeners.get(event);
        if (arr === undefined) {
          arr = [];
          listeners.set(event, arr);
        }
        arr.push(cb);
        return channel;
      }
      return PassThrough.prototype.on.call(stream, event, cb);
    },
  });

  const emit = (event: string, ...args: unknown[]): void => {
    for (const cb of listeners.get(event) ?? []) {
      cb(...args);
    }
  };

  return {
    channel,
    writeCalls,
    signalCalls,
    setWindowCalls,
    emitOutput: (text) => {
      realWrite(text);
    },
    emitExit: (code) => {
      emit('exit', code);
    },
    emitClose: (code) => {
      emit('close', code);
    },
    emitError: (err) => {
      emit('error', err);
    },
  };
}

function createSshKaos(execImpl: (command: string, options: unknown) => unknown): {
  kaos: SSHKaos;
  execSpy: ReturnType<typeof vi.fn>;
} {
  const execSpy = vi.fn((command: string, options: unknown, cb: (err: Error | undefined, channel: unknown) => void) => {
    const channel = execImpl(command, options);
    if (channel instanceof Error) {
      cb(channel, undefined);
    } else {
      cb(undefined, channel);
    }
  });
  const kaos = Object.assign(Object.create(SSHKaos.prototype) as SSHKaos, {
    _client: { exec: execSpy },
    _cwd: '/home/user',
    _envLayers: [],
  });
  return { kaos, execSpy };
}

describe('SSHKaos.ptyExec', () => {
  it('opens the channel with pty options through client.exec', async () => {
    const fake = createFakeChannel();
    const { kaos, execSpy } = createSshKaos(() => fake.channel);

    const proc = await kaos.ptyExec(['/bin/bash', '-l'], undefined, {
      term: 'dumb',
      cols: 120,
      rows: 40,
    });

    expect(proc).toBeInstanceOf(SSHPtyProcess);
    expect(execSpy).toHaveBeenCalledTimes(1);
    const [command, options] = execSpy.mock.calls[0] as [string, { pty: Record<string, unknown> }];
    expect(command).toContain('/bin/bash');
    expect(options.pty).toEqual({ term: 'dumb', cols: 120, rows: 40 });
  });

  it('builds the remote command with cd and inline env assignments (AcceptEnv bypass)', async () => {
    const fake = createFakeChannel();
    const { kaos, execSpy } = createSshKaos(() => fake.channel);

    await kaos.ptyExec(['python3'], { FOO: 'bar baz', TERM: 'dumb' });

    const [command] = execSpy.mock.calls[0] as [string];
    expect(command).toBe(`cd /home/user && FOO='bar baz' TERM=dumb python3`);
  });

  it('merges kaos env layers into the inline assignments', async () => {
    const fake = createFakeChannel();
    const { kaos, execSpy } = createSshKaos(() => fake.channel);

    await kaos.withEnv({ LAYER: '1' }).ptyExec(['bash'], { LOCAL: '2' });

    const [command] = execSpy.mock.calls[0] as [string];
    expect(command).toBe(`cd /home/user && LOCAL=2 LAYER=1 bash`);
  });

  it('rejects invalid env names before touching the connection', async () => {
    const fake = createFakeChannel();
    const { kaos, execSpy } = createSshKaos(() => fake.channel);

    await expect(kaos.ptyExec(['bash'], { 'BAD-NAME': 'x' })).rejects.toThrow(
      /invalid env variable name/,
    );
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('rejects without arguments', async () => {
    const { kaos } = createSshKaos(() => createFakeChannel().channel);
    await expect(kaos.ptyExec([])).rejects.toThrow(/at least one argument/);
  });

  it('propagates exec failures (e.g. pty request refused)', async () => {
    const { kaos } = createSshKaos(() => new Error('Unable to request a pseudo-terminal'));
    await expect(kaos.ptyExec(['bash'])).rejects.toThrow(/pseudo-terminal/);
  });
});

describe('SSHPtyProcess', () => {
  it('delivers the merged output stream and an empty, ended stderr', async () => {
    const fake = createFakeChannel();
    const proc = new SSHPtyProcess(fake.channel as never);

    let acc = '';
    proc.output.on('data', (chunk: string | Buffer) => {
      acc += chunk.toString();
    });
    fake.emitOutput('out\nerr\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(acc).toBe('out\nerr\n');
    expect(proc.stdout).toBe(proc.output);

    const stderrChunks: unknown[] = [];
    for await (const chunk of proc.stderr) {
      stderrChunks.push(chunk);
    }
    expect(stderrChunks).toEqual([]);

    fake.emitExit(0);
    fake.emitClose();
    await proc.wait();
    proc.dispose();
  });

  it('write() forwards terminal input to the channel verbatim', () => {
    const fake = createFakeChannel();
    const proc = new SSHPtyProcess(fake.channel as never);

    proc.write('ls\n');
    expect(fake.writeCalls).toEqual(['ls\n']);
    proc.dispose();
  });

  it('resize(cols, rows) maps to setWindow(rows, cols) — swapped order', () => {
    const fake = createFakeChannel();
    const proc = new SSHPtyProcess(fake.channel as never);

    proc.resize(120, 40);
    expect(fake.setWindowCalls).toEqual([[40, 120, 0, 0]]);
    proc.dispose();
  });

  it('kill() strips the SIG prefix and defaults to SIGTERM', async () => {
    const fake = createFakeChannel();
    const proc = new SSHPtyProcess(fake.channel as never);

    await proc.kill();
    await proc.kill('SIGKILL');
    await proc.kill('SIGINT');
    expect(fake.signalCalls).toEqual(['TERM', 'KILL', 'INT']);
    proc.dispose();
  });

  it('wait() resolves with the exit code once output has drained (exit then close)', async () => {
    const fake = createFakeChannel();
    const proc = new SSHPtyProcess(fake.channel as never);

    fake.emitOutput('final\n');
    fake.emitExit(3);
    fake.emitClose();
    expect(await proc.wait()).toBe(3);
    expect(proc.exitCode).toBe(3);
    proc.dispose();
  });

  it('wait() resolves with a close-only exit code (backend quirk)', async () => {
    const fake = createFakeChannel();
    const proc = new SSHPtyProcess(fake.channel as never);

    fake.emitClose(1);
    expect(await proc.wait()).toBe(1);
    expect(proc.exitCode).toBe(1);
    proc.dispose();
  });

  it('a channel error rejects wait()', async () => {
    const fake = createFakeChannel();
    const proc = new SSHPtyProcess(fake.channel as never);
    // Real consumers observe the output stream (its error mirrors the
    // channel's); attach a sink so the assertion stays on wait().
    proc.output.on('error', () => {});

    fake.emitError(new Error('socket hang up'));
    await expect(proc.wait()).rejects.toThrow(/socket hang up/);
    proc.dispose();
  });

  it('disconnect (close without an exit status) rejects wait() with a readable cause', async () => {
    const fake = createFakeChannel();
    const proc = new SSHPtyProcess(fake.channel as never);

    fake.emitOutput('half a line');
    fake.emitClose();
    await expect(proc.wait()).rejects.toThrow(KaosConnectionError);
    await expect(proc.wait()).rejects.toThrow(/connection was lost mid-session/);
    // No fabricated exit code: the remote command's fate is unknown.
    expect(proc.exitCode).toBeNull();
    proc.dispose();
  });

  it('an early disconnect does not surface as an unhandled rejection', async () => {
    const fake = createFakeChannel();
    const proc = new SSHPtyProcess(fake.channel as never);

    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      fake.emitClose();
      // Let the microtask queue and the rejection-sink settle without any
      // caller awaiting wait().
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(rejections).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
      // Attach late: wait() still reports the stored rejection.
      await expect(proc.wait()).rejects.toThrow(/connection was lost/);
      proc.dispose();
    }
  });
});
