/**
 * Test helpers for shell-session tests: a scripted KaosPtyProcess whose
 * output/exit the test drives by hand, plus an output accumulator.
 */

import { PassThrough, Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { KaosPtyProcess } from '@cloud-code/kaos';
import { vi, type Mock } from 'vitest';

export interface FakePtyProcess {
  readonly proc: KaosPtyProcess;
  /** Push bytes into the merged PTY output stream. */
  emit: (text: string) => void;
  /** End output and resolve wait() with the exit code. */
  exit: (code: number) => void;
  readonly killSpy: Mock<(signal?: NodeJS.Signals) => Promise<void>>;
  readonly writeSpy: ReturnType<typeof vi.fn>;
}

/**
 * A PTY process that stays alive until `exit(code)` is called. `wait()`
 * resolves only after the output stream has fully drained, mirroring the
 * ordering the ShellSessionTask relies on (final chunks before onExit).
 */
export function fakePtyProcess(pid = 4321): FakePtyProcess {
  const output = new PassThrough();
  let exitCode: number | null = null;
  let resolveWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  const drained = new Promise<void>((resolve) => {
    output.once('end', resolve);
  });
  const killSpy = vi.fn(async () => {});
  const writeSpy = vi.fn((_: string) => {});
  const proc: KaosPtyProcess = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: output,
    stderr: Readable.from([]),
    output,
    pid,
    get exitCode() {
      return exitCode;
    },
    wait: vi.fn(async () => {
      await waitPromise;
      await drained;
      return exitCode ?? 0;
    }) as KaosPtyProcess['wait'],
    kill: killSpy as KaosPtyProcess['kill'],
    dispose: vi.fn(() => {
      output.destroy();
    }) as KaosPtyProcess['dispose'],
    write: writeSpy as KaosPtyProcess['write'],
    resize: vi.fn(),
  };
  return {
    proc,
    emit: (text) => {
      output.write(text);
    },
    exit: (code) => {
      exitCode = code;
      output.end();
      resolveWait(code);
    },
    killSpy,
    writeSpy,
  };
}

export interface RejectingPtyProcess {
  readonly proc: KaosPtyProcess;
  /** Push bytes into the merged PTY output stream. */
  emit: (text: string) => void;
  /** End output, then reject wait() — a transport lost mid-session. */
  drop: (message: string) => void;
}

/**
 * A PTY process whose transport drops mid-session (SSHPtyProcess semantics):
 * the output stream ends and wait() rejects; no exit status was ever
 * reported, so `exitCode` stays null.
 */
export function rejectingPtyProcess(pid = 4321): RejectingPtyProcess {
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
    pid,
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
    emit: (text) => {
      output.write(text);
    },
    drop: (message) => {
      output.end();
      rejectWait(new Error(message));
    },
  };
}

/** Accumulate a stream's data and wait for a needle (see pty echo caveat). */
export function recordStream(stream: Readable): {
  text: () => string;
  waitFor: (needle: string | RegExp, timeoutMs?: number) => Promise<string>;
} {
  let acc = '';
  stream.on('data', (chunk: string | Buffer) => {
    acc += chunk.toString();
  });
  const matches = (needle: string | RegExp): boolean =>
    typeof needle === 'string' ? acc.includes(needle) : needle.test(acc);
  return {
    text: () => acc,
    waitFor: async (needle: string | RegExp, timeoutMs = 10_000): Promise<string> => {
      const deadline = Date.now() + timeoutMs;
      while (!matches(needle)) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${String(needle)}; got: ${JSON.stringify(acc)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return acc;
    },
  };
}

/** Wait until `predicate` holds, polling on a short interval. */
export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 10_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
