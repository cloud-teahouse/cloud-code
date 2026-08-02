/**
 * Shared types for the persistent shell-session manager (RFC
 * `docs/rfc/unified-exec-pty.md` §3.2).
 */

/** Live-config slice resolved per operation so config reloads apply. */
export interface ShellSessionManagerConfig {
  /** Max concurrent sessions per agent (LRU eviction beyond this). */
  readonly maxSessions?: number;
  /** Idle reclamation delay in seconds; `0` disables the idle reaper. */
  readonly idleTimeoutS?: number;
}

export type ShellSessionStatus = 'running' | 'exited';

/** Result of one write/poll round-trip against a session. */
export interface ShellSessionPollResult {
  readonly sessionId: string;
  readonly status: ShellSessionStatus;
  /** Exit code once the process has terminated; `null` while running. */
  readonly exitCode: number | null;
  /**
   * Output produced since the previous poll (drain semantics), head/tail
   * truncated with an omission marker when the middle was dropped.
   */
  readonly output: string;
  /** Bytes dropped from the middle of this chunk by head/tail capping. */
  readonly omittedBytes: number;
  /** Monotonic chunk identifier (`<sessionId>:<n>`) for dedup/reference. */
  readonly chunkId: string;
  readonly wallTimeMs: number;
  /** True when the tool call was aborted mid-wait; the session keeps running. */
  readonly interrupted: boolean;
  /** Consecutive empty polls (zero output, process still running). */
  readonly consecutiveEmptyPolls: number;
}
