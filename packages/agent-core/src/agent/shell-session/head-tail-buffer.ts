/**
 * HeadTailBuffer — a capped buffer that preserves a stable prefix ("head")
 * and suffix ("tail"), dropping the middle once it exceeds the configured
 * maximum. Direct port of codex
 * `core/src/unified_exec/head_tail_buffer.rs`: the budget is split
 * symmetrically (50% head / 50% tail) and dropped middle bytes are counted
 * so serialization can insert an omission marker.
 *
 * Unlike the background ring buffer (a pure tail), keeping the head matters
 * for interactive sessions: the first screen of a REPL / dev server (banner,
 * port number, prompt shape) is often the part the model needs later.
 *
 * Chunks are strings (PTY output is decoded upstream); "bytes" below means
 * UTF-16 code units, which matches how codex counts bytes for ASCII-heavy
 * terminal output and keeps the budget math allocation-free.
 */

/** Default session buffer capacity: 1 MiB (codex `UNIFIED_EXEC_OUTPUT_MAX_BYTES`). */
export const HEAD_TAIL_BUFFER_DEFAULT_MAX = 1024 * 1024;

/** Marker inserted between head and tail when middle bytes were omitted. */
export function formatOutputOmissionMarker(omittedBytes: number): string {
  return `... ${String(omittedBytes)} bytes omitted ...`;
}

export class HeadTailBuffer {
  private readonly maxBytes: number;
  private readonly headBudget: number;
  private readonly tailBudget: number;
  private head = '';
  private tail = '';
  private omittedBytes = 0;

  constructor(maxBytes: number = HEAD_TAIL_BUFFER_DEFAULT_MAX) {
    this.maxBytes = Math.max(0, Math.trunc(maxBytes));
    this.headBudget = Math.floor(this.maxBytes / 2);
    this.tailBudget = this.maxBytes - this.headBudget;
  }

  /** Total bytes currently retained by the buffer (head + tail). */
  get retainedBytes(): number {
    return this.head.length + this.tail.length;
  }

  /** Total bytes that were dropped from the middle due to the size cap. */
  get omitted(): number {
    return this.omittedBytes;
  }

  /** Total bytes observed by the buffer, including omitted bytes. */
  get totalBytes(): number {
    return this.retainedBytes + this.omittedBytes;
  }

  /**
   * Append a chunk of output. Bytes first fill the head budget; the rest
   * goes to the tail, whose oldest bytes are dropped past the tail budget.
   */
  push(chunk: string): void {
    if (chunk.length === 0) return;
    if (this.maxBytes === 0) {
      this.omittedBytes += chunk.length;
      return;
    }
    const remainingHead = this.headBudget - this.head.length;
    const headLen = Math.min(Math.max(remainingHead, 0), chunk.length);
    if (headLen > 0) {
      this.head += chunk.slice(0, headLen);
    }
    this.pushToTail(chunk.slice(headLen));
  }

  /**
   * Return the retained output with an explicit marker between head and
   * tail when bytes were omitted.
   */
  toStringWithOmissionMarker(): string {
    if (this.omittedBytes === 0) return this.head + this.tail;
    return `${this.head}\n${formatOutputOmissionMarker(this.omitted)}\n${this.tail}`;
  }

  /**
   * Drain the retained output and omission metadata, resetting this
   * buffer's contents while preserving its configured capacity. The
   * returned snapshot renders with an omission marker when bytes were
   * dropped (codex semantics: drain consumes the buffer, so each poll
   * returns only output produced since the previous poll).
   */
  drain(): { readonly output: string; readonly omittedBytes: number; readonly totalBytes: number } {
    const snapshot = {
      output: this.toStringWithOmissionMarker(),
      omittedBytes: this.omittedBytes,
      totalBytes: this.totalBytes,
    };
    this.head = '';
    this.tail = '';
    this.omittedBytes = 0;
    return snapshot;
  }

  private pushToTail(chunk: string): void {
    if (chunk.length === 0) return;
    if (this.tailBudget === 0) {
      this.omittedBytes += chunk.length;
      return;
    }

    if (chunk.length >= this.tailBudget) {
      // This single chunk is larger than the whole tail budget. Keep only
      // the last tailBudget bytes and drop everything else.
      const kept = chunk.slice(chunk.length - this.tailBudget);
      this.omittedBytes += this.tail.length + (chunk.length - kept.length);
      this.tail = kept;
      return;
    }

    this.tail += chunk;
    const excess = this.tail.length - this.tailBudget;
    if (excess > 0) {
      this.tail = this.tail.slice(excess);
      this.omittedBytes += excess;
    }
  }
}
