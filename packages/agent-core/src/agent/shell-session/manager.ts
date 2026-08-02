/**
 * ShellSessionManager — per-agent registry of persistent PTY sessions
 * (RFC `docs/rfc/unified-exec-pty.md` §3.2, codex `process_manager.rs`).
 *
 * Responsibilities:
 *   - registry keyed by session id (the session id IS the background task
 *     id, `pty-<8 base36>` — visually同源 with task ids by design);
 *   - capacity: LRU eviction past `maxSessions` (codex protects the newest
 *     8; with the default cap of 16 that always leaves evictable entries);
 *   - idle reclamation: a per-session resettable timer (every write/poll
 *     resets it) stops the session after `idleTimeoutS` without interaction;
 *   - a per-session async mutex so write/poll calls against the same session
 *     never interleave (they share the drain-in-progress output buffer);
 *   - exit tracking: an exited session leaves the live registry but keeps a
 *     bounded record so one last poll can report the exit code and any final
 *     output; polls against entirely unknown ids fail with a structured
 *     "does not exist" error (sessions never survive a CLI restart).
 *
 * Session lifetime deliberately outlives individual turns (a dev server is
 * started in one turn and polled in later ones) but not the agent: sessions
 * ride on BackgroundManager tasks, so `stopAll('Session closed')` kills them
 * through the shared SIGTERM → grace → SIGKILL path, and persisted
 * still-running records reconcile to `lost` ghosts on restart.
 */

import { createControlledPromise, type ControlledPromise } from '@antfu/utils';
import type { KaosPtyProcess } from '@cloud-code/kaos';

import { resettableTimeoutOutcome, timeoutOutcome } from '../../utils/promise';
import type { BackgroundManager } from '../background';
import type { AgentRecordOf } from '../records';
import { HeadTailBuffer } from './head-tail-buffer';
import { ShellSessionTask } from './task';
import type { ShellSessionManagerConfig, ShellSessionPollResult } from './types';

/** Observability wire records emitted on session lifecycle transitions (RFC §3.5 v2). */
export type ShellSessionRecord = AgentRecordOf<'shell_session.start' | 'shell_session.exit'>;

/** Defaults from RFC §3.2 (resolves 遗留歧义②). */
export const DEFAULT_MAX_SHELL_SESSIONS = 16;
export const DEFAULT_IDLE_TIMEOUT_S = 30 * 60;
/** Newest sessions protected from LRU eviction (codex parity). */
const LRU_PROTECTED_SESSIONS = 8;
/** Bounded history of exited sessions kept for last-poll exit-code reports. */
const MAX_EXITED_SESSION_RECORDS = 8;

const NEVER = new Promise<never>(() => {});

interface LiveSession {
  sessionId: string;
  readonly command: string;
  readonly proc: KaosPtyProcess;
  readonly buffer: HeadTailBuffer;
  readonly exited: ControlledPromise<number>;
  exitCode: number | null;
  idleTimer: { reset(ms: number | undefined): void; clear(): void } | undefined;
  lock: Promise<unknown>;
  chunkCounter: number;
  consecutiveEmptyPolls: number;
}

interface ExitedSessionRecord {
  readonly command: string;
  readonly exitCode: number;
  /** Final drained output, returned by the first poll after exit. */
  output: string;
  omittedBytes: number;
  polled: boolean;
}

export class ShellSessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly exitedSessions = new Map<string, ExitedSessionRecord>();

  constructor(
    private readonly background: BackgroundManager,
    private readonly resolveConfig: () => ShellSessionManagerConfig = () => ({}),
    /**
     * Sink for the `shell_session.start` / `shell_session.exit` observability
     * records (wired to `agent.records.logRecord`; the records layer already
     * gates writes during replay). Optional so detached managers and tests
     * can run without a wire log.
     */
    private readonly logRecord?: (record: ShellSessionRecord) => void,
  ) {}

  /** Number of live sessions (exited records are not counted). */
  get size(): number {
    return this.sessions.size;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Ids of live sessions, least-recently-used first. */
  liveSessionIds(): readonly string[] {
    return [...this.sessions.keys()];
  }

  /**
   * Register an already-spawned PTY process as a session. The ExecSession
   * tool owns spawning (permission + sandbox escalation) and hands the
   * process over immediately after spawn so a turn interruption cannot lose
   * the last reference (codex process_manager.rs:456-478 lesson).
   *
   * The session registers detached with no manager-owned deadline: it is
   * polled via WriteStdin, never awaited by a foreground caller, and idle
   * reclamation is handled by our own resettable timer below.
   */
  createSession(params: {
    readonly proc: KaosPtyProcess;
    readonly command: string;
    readonly description: string;
  }): { readonly sessionId: string } {
    const session: LiveSession = {
      sessionId: '',
      command: params.command,
      proc: params.proc,
      buffer: new HeadTailBuffer(),
      exited: createControlledPromise<number>(),
      exitCode: null,
      idleTimer: undefined,
      lock: Promise.resolve(),
      chunkCounter: 0,
      consecutiveEmptyPolls: 0,
    };
    const task = new ShellSessionTask(
      params.proc,
      params.command,
      params.description,
      (text) => {
        session.buffer.push(text);
      },
      (exitCode) => {
        this.handleExit(session.sessionId, exitCode);
      },
    );
    // `start()` runs on a microtask inside registerTask, so assigning the id
    // synchronously here is race-free against the earliest possible onExit.
    session.sessionId = this.background.registerTask(task, { detached: true });
    this.sessions.set(session.sessionId, session);
    this.logRecord?.({
      type: 'shell_session.start',
      sessionId: session.sessionId,
      command: params.command,
      pid: params.proc.pid,
    });
    this.armIdleTimer(session);
    this.evictIfNeeded();
    return { sessionId: session.sessionId };
  }

  /**
   * Write `chars` (may be empty = pure poll), wait up to `yieldMs` for
   * output/exit/abort, then drain the buffer. Serialized per session.
   *
   * Throws when the id is unknown AND not a recently-exited session — the
   * resume semantics: sessions never survive a CLI restart, so a stale id
   * from earlier context gets a structured "does not exist" error.
   */
  async interact(
    sessionId: string,
    params: {
      readonly chars?: string;
      readonly yieldMs: number;
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<ShellSessionPollResult> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return this.pollExited(sessionId);
    return this.enqueue(session, () => this.interactLocked(session, params));
  }

  /** Stop and deregister a live session (idle reaper, LRU eviction). */
  async destroySession(sessionId: string, reason: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.sessions.delete(sessionId);
    session.idleTimer?.clear();
    // Wake any in-flight poll before killing: the kill fires handleExit,
    // which no-ops on the already-removed id, so without this a poll parked
    // in waitForYield would hang until its yield deadline.
    session.exited.resolve(session.proc.exitCode ?? -1);
    // Destroyed before the exit was observed: no exit code, the reason says
    // why. The kill below fires handleExit, which no-ops on the removed id —
    // this is the session's single exit record.
    this.logRecord?.({
      type: 'shell_session.exit',
      sessionId,
      command: session.command,
      exitCode: null,
      reason,
    });
    // The shared stop path: SIGTERM → 5s grace → SIGKILL (forceStop).
    await this.background.stop(sessionId, reason);
  }

  /**
   * Delegate to the background task's output snapshot so tools can render
   * the `[Full output saved]` reference without touching BackgroundManager
   * directly. The session id IS the background task id.
   */
  async outputSnapshot(sessionId: string, maxPreviewBytes: number) {
    return this.background.getOutputSnapshot(sessionId, maxPreviewBytes);
  }

  /** Full persisted output of a session task (delegates to BackgroundManager). */
  async readOutput(sessionId: string): Promise<string> {
    return this.background.readOutput(sessionId);
  }

  // ── internals ──────────────────────────────────────────────────────

  private async interactLocked(
    session: LiveSession,
    params: { readonly chars?: string; readonly yieldMs: number; readonly signal?: AbortSignal | undefined },
  ): Promise<ShellSessionPollResult> {
    const startedAt = Date.now();
    this.touch(session);
    const chars = params.chars ?? '';
    if (chars.length > 0) {
      session.proc.write(chars);
    }
    const outcome = await this.waitForYield(session, params.yieldMs, params.signal);
    const drained = session.buffer.drain();
    if (drained.output.length > 0 || chars.length > 0) {
      session.consecutiveEmptyPolls = 0;
    } else if (session.proc.exitCode === null) {
      session.consecutiveEmptyPolls += 1;
    }
    session.chunkCounter += 1;
    const exitCode = session.proc.exitCode;
    return {
      sessionId: session.sessionId,
      status: exitCode === null ? 'running' : 'exited',
      exitCode,
      output: drained.output,
      omittedBytes: drained.omittedBytes,
      chunkId: `${session.sessionId}:${String(session.chunkCounter)}`,
      wallTimeMs: Date.now() - startedAt,
      interrupted: outcome === 'aborted',
      consecutiveEmptyPolls: session.consecutiveEmptyPolls,
    };
  }

  /**
   * Wait for the yield deadline, the process exit, or the caller's abort —
   * whichever comes first. An abort cancels the wait only; the session
   * process keeps running (codex parity: turn cancellation must not kill
   * sessions).
   */
  private async waitForYield(
    session: LiveSession,
    yieldMs: number,
    signal: AbortSignal | undefined,
  ): Promise<'yield' | 'exited' | 'aborted'> {
    const timeout = timeoutOutcome(yieldMs, 'yield' as const);
    const aborted =
      signal === undefined
        ? NEVER
        : new Promise<'aborted'>((resolve) => {
            if (signal.aborted) {
              resolve('aborted');
              return;
            }
            signal.addEventListener('abort', () => {
              resolve('aborted');
            }, { once: true });
          });
    try {
      return await Promise.race([
        timeout,
        session.exited.then(() => 'exited' as const),
        aborted,
      ]);
    } finally {
      timeout.clear();
    }
  }

  private pollExited(sessionId: string): ShellSessionPollResult {
    const record = this.exitedSessions.get(sessionId);
    if (record !== undefined) {
      // The final drained output is returned once; later polls still report
      // the exit code but with empty output (drain semantics preserved).
      const output = record.polled ? '' : record.output;
      const omittedBytes = record.polled ? 0 : record.omittedBytes;
      record.polled = true;
      return {
        sessionId,
        status: 'exited',
        exitCode: record.exitCode,
        output,
        omittedBytes,
        chunkId: `${sessionId}:final`,
        wallTimeMs: 0,
        interrupted: false,
        consecutiveEmptyPolls: 0,
      };
    }
    throw new Error(
      `Shell session "${sessionId}" does not exist (it exited, was evicted, or died with a ` +
        'previous CLI process — sessions do not survive resume). Start a new one with ' +
        `ExecSession and rebuild any env/cwd state. Live sessions: ${
          this.sessions.size === 0 ? 'none' : [...this.sessions.keys()].join(', ')
        }.`,
    );
  }

  private handleExit(sessionId: string, exitCode: number): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return; // already destroyed via the stop path
    session.exitCode = exitCode;
    session.idleTimer?.clear();
    this.sessions.delete(sessionId);
    this.logRecord?.({
      type: 'shell_session.exit',
      sessionId,
      command: session.command,
      exitCode,
    });
    const drained = session.buffer.drain();
    this.exitedSessions.set(sessionId, {
      command: session.command,
      exitCode,
      output: drained.output,
      omittedBytes: drained.omittedBytes,
      polled: false,
    });
    // Resolve AFTER draining: an in-flight poll wakes on this promise and
    // must observe a fully-drained buffer (its own drain then returns '').
    session.exited.resolve(exitCode);
    // Bound the exited history: drop oldest beyond the cap.
    while (this.exitedSessions.size > MAX_EXITED_SESSION_RECORDS) {
      const oldest = this.exitedSessions.keys().next();
      if (oldest.done) break;
      this.exitedSessions.delete(oldest.value);
    }
  }

  /** Refresh LRU recency and restart the idle clock on every interaction. */
  private touch(session: LiveSession): void {
    this.sessions.delete(session.sessionId);
    this.sessions.set(session.sessionId, session);
    session.idleTimer?.reset(this.idleTimeoutMs());
  }

  private armIdleTimer(session: LiveSession): void {
    const idleMs = this.idleTimeoutMs();
    if (idleMs === undefined) return;
    const timer = resettableTimeoutOutcome(idleMs, 'idle' as const);
    session.idleTimer = timer;
    const idleS = Math.round(idleMs / 1000);
    void timer
      .then(() =>
        this.destroySession(
          session.sessionId,
          `idle timeout: no interaction for ${String(idleS)}s`,
        ),
      )
      .catch(() => {});
  }

  private evictIfNeeded(): void {
    const max = this.maxSessions();
    const excess = this.sessions.size - max;
    if (excess <= 0) return;
    const ids = [...this.sessions.keys()]; // least-recently-used first
    const protectedCount = Math.min(LRU_PROTECTED_SESSIONS, Math.max(0, max - 1));
    const evictable = ids.slice(0, Math.max(0, ids.length - protectedCount));
    for (const sessionId of evictable.slice(0, excess)) {
      void this.destroySession(
        sessionId,
        `evicted: shell session limit (${String(max)}) reached; close sessions you no longer need`,
      ).catch(() => {});
    }
  }

  private enqueue<T>(session: LiveSession, fn: () => Promise<T>): Promise<T> {
    const next = session.lock.then(fn, fn);
    // The chain itself never rejects, so one failed call cannot wedge the mutex.
    session.lock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private maxSessions(): number {
    const configured = this.resolveConfig().maxSessions;
    return configured !== undefined && configured >= 1
      ? Math.trunc(configured)
      : DEFAULT_MAX_SHELL_SESSIONS;
  }

  private idleTimeoutMs(): number | undefined {
    const configured = this.resolveConfig().idleTimeoutS;
    if (configured === 0) return undefined;
    return configured !== undefined && configured > 0
      ? configured * 1000
      : DEFAULT_IDLE_TIMEOUT_S * 1000;
  }
}
