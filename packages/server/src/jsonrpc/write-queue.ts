import { EVENT_NOTIFICATION, isVolatileEventType } from '@cloud-code/protocol';

import { encodeJsonlFrame } from './framing';

/**
 * Outgoing-frame queue with same-turn delta coalescing (design §6.2).
 *
 * `assistant.delta` bursts can reach thousands of tiny frames per second on
 * stdio. While the queue is not drained, an incoming volatile delta that is
 * adjacent to a compatible tail frame is folded into it (text concatenation
 * — semantically lossless, clients render cumulative text). Durable events
 * are never merged, dropped, or reordered.
 */
export class MergingWriteQueue {
  // Head-index dequeue: sent frames stay in the array until the queue is
  // drained or compacted, so `head === 0` whenever `queue.length === 0`.
  private queue: unknown[] = [];
  private head = 0;
  private flushPromise: Promise<void> | undefined;

  constructor(
    private readonly sink: (frame: string) => Promise<void>,
    private readonly onSinkError?: (error: Error) => void,
    /**
     * Frame encoder; defaults to JSONL (`encodeJsonlFrame`). ws passes plain
     * `JSON.stringify` — a ws message is already a frame, no delimiter needed.
     */
    private readonly encode: (message: unknown) => string = encodeJsonlFrame,
  ) {}

  /** Number of frames waiting to be written. */
  get pendingCount(): number {
    return this.queue.length - this.head;
  }

  write(message: unknown): void {
    const tailIndex = this.queue.length - 1;
    if (tailIndex >= 0) {
      const merged = tryMergeEventMessages(this.queue[tailIndex], message);
      if (merged !== undefined) {
        this.queue[tailIndex] = merged;
        return;
      }
    }
    this.queue.push(message);
    void this.flush();
  }

  /** Resolves once the queue is fully drained. */
  async drain(): Promise<void> {
    for (;;) {
      if (this.queue.length === 0 && this.flushPromise === undefined) return;
      await this.flush();
    }
  }

  private flush(): Promise<void> {
    this.flushPromise ??= this.doFlush().finally(() => {
      this.flushPromise = undefined;
    });
    return this.flushPromise;
  }

  private async doFlush(): Promise<void> {
    try {
      while (this.head < this.queue.length) {
        const message = this.queue[this.head];
        this.head += 1;
        if (this.head === this.queue.length) {
          // Drained: release the array so an idle queue does not pin the
          // capacity a burst grew it to.
          this.queue = [];
          this.head = 0;
        } else if (this.head >= 64 && this.head * 2 >= this.queue.length) {
          // Bound the memory retained by sent frames; the thresholds keep
          // compaction amortized O(1) per dequeue.
          this.queue = this.queue.slice(this.head);
          this.head = 0;
        }
        await this.sink(this.encode(message));
      }
    } catch (error) {
      // A dead sink kills the pending frames; the transport's close path
      // reports the failure to pending RPC callers.
      this.queue = [];
      this.head = 0;
      this.onSinkError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/**
 * Merge `next` into `tail` when both are `event` notifications carrying the
 * same mergeable delta stream. Returns the merged message, or undefined when
 * the pair is not mergeable.
 */
export function tryMergeEventMessages(tail: unknown, next: unknown): unknown {
  if (!isEventNotification(tail) || !isEventNotification(next)) return undefined;
  const tailParams = tail['params'] as Record<string, unknown>;
  const nextParams = next['params'] as Record<string, unknown>;
  const mergedParams = tryMergeEventParams(tailParams, nextParams);
  if (mergedParams === undefined) return undefined;
  return { jsonrpc: tail['jsonrpc'], method: EVENT_NOTIFICATION, params: mergedParams };
}

function isEventNotification(message: unknown): message is Record<string, unknown> {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as Record<string, unknown>)['method'] === EVENT_NOTIFICATION &&
    typeof (message as Record<string, unknown>)['params'] === 'object' &&
    (message as Record<string, unknown>)['params'] !== null
  );
}

function tryMergeEventParams(
  tail: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const type = tail['type'];
  if (typeof type !== 'string' || type !== next['type']) return undefined;
  if (!isVolatileEventType(type)) return undefined;
  if (tail['sessionId'] !== next['sessionId'] || tail['agentId'] !== next['agentId']) {
    return undefined;
  }
  switch (type) {
    case 'assistant.delta':
    case 'thinking.delta': {
      if (tail['turnId'] !== next['turnId']) return undefined;
      const tailDelta = tail['delta'];
      const nextDelta = next['delta'];
      if (typeof tailDelta !== 'string' || typeof nextDelta !== 'string') {
        return undefined;
      }
      return { ...tail, delta: tailDelta + nextDelta };
    }
    case 'tool.call.delta': {
      if (tail['turnId'] !== next['turnId'] || tail['toolCallId'] !== next['toolCallId']) {
        return undefined;
      }
      const tailPart = tail['argumentsPart'];
      const nextPart = next['argumentsPart'];
      if (
        (tailPart !== undefined && typeof tailPart !== 'string') ||
        (nextPart !== undefined && typeof nextPart !== 'string')
      ) {
        return undefined;
      }
      const merged: Record<string, unknown> = { ...tail };
      if (tailPart !== undefined || nextPart !== undefined) {
        merged['argumentsPart'] = (tailPart ?? '') + (nextPart ?? '');
      }
      if (merged['name'] === undefined && next['name'] !== undefined) {
        merged['name'] = next['name'];
      }
      return merged;
    }
    default:
      return undefined;
  }
}
