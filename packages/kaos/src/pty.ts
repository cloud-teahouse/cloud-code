import type { Readable } from 'node:stream';

import type { KaosProcess } from './process';

/**
 * Options for {@link Kaos.ptyExec}.
 */
export interface PtyExecOptions {
  /** Terminal width in columns. Defaults to 80. */
  readonly cols?: number;
  /** Terminal height in rows. Defaults to 24. */
  readonly rows?: number;
  /**
   * Value of the pty's `TERM` (the terminal type the child believes it is
   * attached to). Callers running agent-driven sessions should pass `dumb`
   * to suppress colour/cursor-addressing escape sequences; interactive
   * terminal UIs pass something like `xterm-256color`.
   */
  readonly term?: string;
}

/**
 * A running process spawned under a pseudo-terminal (PTY).
 *
 * A PTY multiplexes stdout and stderr onto a single byte stream, so instead
 * of separate pipes this interface exposes the merged {@link output} stream
 * (`stdout` aliases it; `stderr` is an already-ended empty stream to keep
 * the {@link KaosProcess} contract). The process's stdin is driven either
 * through the `stdin` Writable or directly via {@link write}.
 */
export interface KaosPtyProcess extends KaosProcess {
  /** Merged stdout+stderr stream — PTYs combine both into one. */
  readonly output: Readable;
  /** Write terminal input to the process (keystrokes, control characters). */
  write(data: string): void;
  /** Resize the pseudo-terminal. */
  resize(cols: number, rows: number): void;
}
