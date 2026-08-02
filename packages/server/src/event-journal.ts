import { randomBytes } from 'node:crypto';

import type { Event } from '@cloud-code/agent-core';
import { isVolatileEventType, type SessionCursor } from '@cloud-code/protocol';

/**
 * Sessions retained by default. Each costs a `capacity`-sized array, so this
 * bounds journal memory at roughly `maxSessions * capacity` events for a
 * `serve` process whose clients die without closing their sessions.
 */
const DEFAULT_MAX_SESSIONS = 256;

export interface JournalCursor {
  readonly seq: number;
  readonly epoch: string;
}

export interface JournalEntry {
  readonly seq: number;
  readonly event: Event;
}

export type ReplayResult =
  | { readonly status: 'ok'; readonly entries: readonly JournalEntry[]; readonly cursor: JournalCursor }
  | {
      readonly status: 'resync_required';
      readonly reason: 'epoch_changed' | 'buffer_overflow' | 'session_recreated';
      readonly cursor: JournalCursor;
    };

/**
 * Bounded per-session ring buffer. Overwriting drops the oldest entries;
 * `oldestSeq`/`latestSeq` track the retained window so replay can detect a
 * cursor that fell off the back (buffer_overflow).
 */
class RingBuffer {
  private readonly entries: Array<{ seq: number; event: Event } | undefined>;
  private head = 0;
  private size = 0;
  latestSeq = 0;

  constructor(private readonly capacity: number) {
    this.entries = Array.from({ length: capacity }, () => undefined);
  }

  get oldestSeq(): number {
    return this.size === 0 ? 0 : this.latestSeq - this.size + 1;
  }

  push(seq: number, event: Event): void {
    if (this.size < this.capacity) {
      this.entries[(this.head + this.size) % this.capacity] = { seq, event };
      this.size += 1;
    } else {
      this.entries[this.head] = { seq, event };
      this.head = (this.head + 1) % this.capacity;
    }
    this.latestSeq = seq;
  }

  /** Retained entries with `seq > afterSeq`, oldest first. */
  after(afterSeq: number): JournalEntry[] {
    // Seqs are contiguous and strictly increasing (`append` assigns
    // `latestSeq + 1` and `push` retains insertion order), so ring offset i
    // holds `seq === oldestSeq + i` and the result is a direct suffix of the
    // window; offsets [0, size) are always filled.
    const start = Math.max(0, afterSeq - this.oldestSeq + 1);
    const out: JournalEntry[] = [];
    for (let i = start; i < this.size; i += 1) {
      out.push(this.entries[(this.head + i) % this.capacity] as JournalEntry);
    }
    return out;
  }
}

/**
 * Server-side event journal (design §4 v2 minimal slice): an in-memory,
 * per-session bounded ring buffer of DURABLE events carrying a monotonically
 * increasing `seq` plus a process-scoped `epoch` (ws-control cursor model).
 *
 *  - Volatile events never enter the journal and never advance `seq`
 *    (they are mergeable/disposable under backpressure, §6.2).
 *  - The epoch changes with every journal (i.e. server process) incarnation;
 *    a cursor from another epoch is invalid and triggers
 *    `resync_required(epoch_changed)`.
 *  - A cursor whose seq fell out of the retained window triggers
 *    `resync_required(buffer_overflow)` — the client rebuilds state from a
 *    `resumeSession` snapshot instead.
 *
 * This is NOT a durable journal: nothing survives a server restart.
 */
export class EventJournal {
  /** Identifies this journal incarnation (ws-control `epoch`). */
  readonly epoch: string;
  /**
   * Retained buffers, least-recently-appended first. Map iteration order is
   * insertion order, and {@link append} re-inserts, so the first key is
   * always the eviction candidate.
   */
  private readonly buffers = new Map<string, RingBuffer>();
  private readonly maxSessions: number;

  private readonly capacity: number;

  constructor(capacity = 1024, maxSessions = DEFAULT_MAX_SESSIONS) {
    this.epoch = randomBytes(8).toString('hex');
    // Clamp: a RingBuffer of capacity 0 silently retains nothing while
    // `oldestSeq` stays 0, so replay() would answer `ok` + no entries to any
    // cursor — a reconnecting client would believe it missed nothing while
    // every durable event was lost. `eventJournalCapacity`'s contract is
    // "small values only make resync more likely", so hold it to that.
    this.capacity = Math.max(1, Math.trunc(capacity));
    this.maxSessions = Math.max(1, Math.trunc(maxSessions));
  }

  /**
   * Drop a session's retained events.
   *
   * Called when a session is closed or deleted: without it the map grows for
   * the lifetime of the `serve` process, each entry pinning a
   * `capacity`-sized array of `Event` objects. A later cursor for a dropped
   * session replays as `resync_required(session_recreated)` rather than a
   * silent empty `ok` — see {@link replay}.
   */
  forgetSession(sessionId: string): void {
    this.buffers.delete(sessionId);
  }

  /** Number of sessions currently retained (diagnostics and tests). */
  get retainedSessionCount(): number {
    return this.buffers.size;
  }

  /**
   * Record an event. Returns the assigned cursor for durable events, or
   * undefined for volatile ones (they carry no cursor on the wire).
   */
  append(event: Event): JournalCursor | undefined {
    if (isVolatileEventType(event.type)) return undefined;
    const buffer = this.bufferFor(event.sessionId);
    const seq = buffer.latestSeq + 1;
    buffer.push(seq, event);
    return { seq, epoch: this.epoch };
  }

  /** Current cursor of a session ({seq: 0} when nothing was journaled yet). */
  cursorOf(sessionId: string): JournalCursor {
    return { seq: this.buffers.get(sessionId)?.latestSeq ?? 0, epoch: this.epoch };
  }

  /**
   * Events newer than `cursor`, in seq order.
   *
   * A cursor from a foreign epoch is invalid; a seq older than the retained
   * window means events were lost to buffer overflow. A cursor that names a
   * session this journal holds nothing for is only "up to date" when it is a
   * fresh cursor (`seq: 0`) — `seq > 0` claims to have seen events that are
   * no longer retained (the session was closed, deleted, or evicted), so it
   * resyncs instead of silently reporting an empty `ok` the client would
   * mistake for "nothing missed".
   *
   * An `epoch`-less cursor is accepted: ws-control defines a fresh cursor as
   * carrying no epoch.
   */
  replay(sessionId: string, cursor: SessionCursor): ReplayResult {
    const current = this.cursorOf(sessionId);
    if (cursor.epoch !== undefined && cursor.epoch !== this.epoch) {
      return { status: 'resync_required', reason: 'epoch_changed', cursor: current };
    }
    const buffer = this.buffers.get(sessionId);
    if (buffer === undefined) {
      return cursor.seq > 0
        ? { status: 'resync_required', reason: 'session_recreated', cursor: current }
        : { status: 'ok', entries: [], cursor: current };
    }
    if (cursor.seq < buffer.oldestSeq - 1) {
      return { status: 'resync_required', reason: 'buffer_overflow', cursor: current };
    }
    return { status: 'ok', entries: buffer.after(cursor.seq), cursor: current };
  }

  /**
   * Buffer for `sessionId`, creating it if needed, and refresh its recency.
   *
   * Sessions that end without an explicit close (a client that dies mid-turn)
   * are never forgotten by {@link forgetSession}, so the map is also capped:
   * past `maxSessions` the least-recently-appended session is evicted. Its
   * cursors then resync, which is the same outcome its events aging out of
   * the ring buffer would produce.
   */
  private bufferFor(sessionId: string): RingBuffer {
    const existing = this.buffers.get(sessionId);
    if (existing !== undefined) {
      // Re-insert so this session becomes the most recent in iteration order.
      this.buffers.delete(sessionId);
      this.buffers.set(sessionId, existing);
      return existing;
    }
    const buffer = new RingBuffer(this.capacity);
    this.buffers.set(sessionId, buffer);
    while (this.buffers.size > this.maxSessions) {
      const oldest = this.buffers.keys().next();
      if (oldest.done) break;
      this.buffers.delete(oldest.value);
    }
    return buffer;
  }
}
