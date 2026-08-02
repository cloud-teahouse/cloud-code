/**
 * ShellSessionTask — adapts a persistent PTY session to the BackgroundManager
 * contract. Parasitising the background machinery buys the session: `/tasks`
 * panel visibility, automatic terminal notifications, `output.log` on-disk
 * persistence (from creation — sessions register already-detached),
 * `stopAll('Session closed')` cleanup, and lost-ghost reconcile after a CLI
 * restart. See RFC `docs/rfc/unified-exec-pty.md` §3.6.
 *
 * Unlike `ProcessBackgroundTask` the streams are a single merged PTY output
 * (a PTY has no separate stderr), and the task never carries a foreground
 * waiter: sessions are registered detached and are polled through the
 * `WriteStdin` tool, not through foreground release.
 */

import type { KaosPtyProcess } from '@cloud-code/kaos';

import { errorMessage } from '../../loop/errors';
import type {
  BackgroundTask,
  BackgroundTaskInfoBase,
  BackgroundTaskSink,
  BackgroundTaskSettlement,
} from '../background/task';

export interface ShellSessionBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'pty-session';
  readonly command: string;
  readonly pid: number;
  readonly exitCode: number | null;
}

const STREAM_DRAIN_GRACE_MS = 250;

export class ShellSessionTask implements BackgroundTask {
  readonly kind = 'pty-session' as const;
  readonly idPrefix = 'pty';
  private exitCode: number | null = null;

  constructor(
    readonly proc: KaosPtyProcess,
    readonly command: string,
    readonly description: string,
    /** Live chunk forward into the owning session's head/tail buffer. */
    private readonly onOutput: (text: string) => void,
    /**
     * Fired once the process exit code is known and output has drained — and
     * also when wait() rejects (transport lost), with the best-known code, so
     * the manager always retires the session.
     */
    private readonly onExit: (exitCode: number) => void,
  ) {}

  async start(sink: BackgroundTaskSink): Promise<void> {
    const streamDrained = observePtyOutput(this.proc, sink, this.onOutput);
    // Attach a rejection handler immediately; start() still awaits the same
    // promise after proc.wait() so stream errors keep failing the task.
    void streamDrained.catch(() => {});

    const requestStop = (): void => {
      void this.proc.kill('SIGTERM').catch(() => {});
    };
    if (sink.signal.aborted) {
      requestStop();
    } else {
      sink.signal.addEventListener('abort', requestStop, { once: true });
    }

    let settlement: BackgroundTaskSettlement;
    try {
      const exitCode = await this.proc.wait();
      await waitForStreamDrain(streamDrained);
      this.exitCode = exitCode;
      this.onExit(exitCode);
      settlement = {
        status: sink.signal.aborted ? 'killed' : exitCode === 0 ? 'completed' : 'failed',
      };
    } catch (error: unknown) {
      await waitForStreamDrainSettled(streamDrained);
      this.exitCode = this.proc.exitCode;
      // A rejected wait() (e.g. an SSH channel that closed without an exit
      // status) must still fire onExit — otherwise the session manager never
      // retires the session: it stays "running" in the live registry, leaves
      // no shell_session.exit record, and every poll resets its idle timer,
      // so the zombie is never reclaimed. The transport gave us no code, so
      // report the best-known one (generic failure when unknown).
      this.onExit(this.exitCode ?? 1);
      settlement = {
        status: sink.signal.aborted ? 'killed' : 'failed',
        stopReason: sink.signal.aborted ? undefined : errorMessage(error),
      };
    } finally {
      sink.signal.removeEventListener('abort', requestStop);
      await this.disposeProcess();
    }
    await sink.settle(settlement);
  }

  async forceStop(): Promise<void> {
    try {
      if (this.proc.exitCode === null) {
        await this.proc.kill('SIGKILL');
      }
    } finally {
      await this.disposeProcess();
    }
  }

  toInfo(base: BackgroundTaskInfoBase): ShellSessionBackgroundTaskInfo {
    return {
      ...base,
      kind: 'pty-session',
      command: this.command,
      pid: this.proc.pid,
      exitCode: this.exitCode,
    };
  }

  private async disposeProcess(): Promise<void> {
    try {
      await this.proc.dispose();
    } catch {
      /* best-effort cleanup */
    }
  }
}

async function waitForStreamDrain(streamDrained: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      streamDrained,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, STREAM_DRAIN_GRACE_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForStreamDrainSettled(streamDrained: Promise<void>): Promise<void> {
  try {
    await waitForStreamDrain(streamDrained);
  } catch {
    /* original process/stream error wins */
  }
}

function observePtyOutput(
  proc: KaosPtyProcess,
  sink: BackgroundTaskSink,
  onOutput: (text: string) => void,
): Promise<void> {
  const stream = proc.output;
  stream.setEncoding('utf8');
  const onData = (chunk: string): void => {
    if (chunk.length === 0) return;
    sink.appendOutput(chunk);
    // Keep feeding the session buffer even after the manager began stopping
    // the task: unlike a one-shot command, a session's final screen is still
    // useful for the last poll that reports the exit code.
    onOutput(chunk);
  };
  stream.on('data', onData);

  return new Promise<void>((resolve, reject) => {
    let ended = false;
    const settle = (callback: () => void): void => {
      cleanup();
      callback();
    };
    const done = (): void => {
      settle(resolve);
    };
    const fail = (error: unknown): void => {
      settle(() => reject(error));
    };
    const onEnd = (): void => {
      ended = true;
      done();
    };
    const onClose = (): void => {
      if (ended || sink.signal.aborted) {
        done();
        return;
      }
      fail(createPrematureCloseError());
    };
    const onError = (error: Error): void => {
      // When the task is aborted we intentionally destroy the streams, which
      // can emit errors. Swallow those expected errors; surface anything else.
      if (sink.signal.aborted) {
        done();
      } else {
        fail(error);
      }
    };
    const cleanup = (): void => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onClose);
      stream.removeListener('error', onError);
    };
    stream.once('end', onEnd);
    stream.once('close', onClose);
    stream.once('error', onError);
  });
}

function createPrematureCloseError(): Error {
  const error = new Error('Premature close') as NodeJS.ErrnoException;
  error.code = 'ERR_STREAM_PREMATURE_CLOSE';
  return error;
}
