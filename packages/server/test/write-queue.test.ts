import { describe, expect, it } from 'vitest';

import { MergingWriteQueue, tryMergeEventMessages } from '../src/jsonrpc/write-queue';

function eventMessage(params: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', method: 'event', params };
}

function assistantDelta(delta: string, turnId = 1): Record<string, unknown> {
  return eventMessage({
    sessionId: 's1',
    agentId: 'main',
    type: 'assistant.delta',
    turnId,
    delta,
  });
}

describe('tryMergeEventMessages', () => {
  it('merges adjacent same-turn assistant deltas', () => {
    const merged = tryMergeEventMessages(assistantDelta('hello '), assistantDelta('world'));
    expect(merged).toEqual(assistantDelta('hello world'));
  });

  it('does not merge deltas from different turns', () => {
    expect(tryMergeEventMessages(assistantDelta('a', 1), assistantDelta('b', 2))).toBeUndefined();
  });

  it('does not merge deltas from different sessions', () => {
    const other = assistantDelta('b');
    (other['params'] as Record<string, unknown>)['sessionId'] = 's2';
    expect(tryMergeEventMessages(assistantDelta('a'), other)).toBeUndefined();
  });

  it('merges adjacent tool.call.delta argument parts with the same toolCallId', () => {
    const tail = eventMessage({
      sessionId: 's1',
      agentId: 'main',
      type: 'tool.call.delta',
      turnId: 1,
      toolCallId: 'tc1',
      name: 'Bash',
      argumentsPart: '{"command":"ec',
    });
    const next = eventMessage({
      sessionId: 's1',
      agentId: 'main',
      type: 'tool.call.delta',
      turnId: 1,
      toolCallId: 'tc1',
      argumentsPart: 'ho hi"}',
    });
    const merged = tryMergeEventMessages(tail, next) as Record<string, unknown>;
    expect((merged['params'] as Record<string, unknown>)['argumentsPart']).toBe(
      '{"command":"echo hi"}',
    );
    expect((merged['params'] as Record<string, unknown>)['name']).toBe('Bash');
  });

  it('does not merge durable events', () => {
    const started = eventMessage({
      sessionId: 's1',
      agentId: 'main',
      type: 'turn.started',
      turnId: 1,
    });
    expect(tryMergeEventMessages(started, started)).toBeUndefined();
  });

  it('does not merge non-event messages', () => {
    const request = { jsonrpc: '2.0', id: 1, method: 'prompt', params: {} };
    expect(tryMergeEventMessages(request, assistantDelta('a'))).toBeUndefined();
  });
});

describe('MergingWriteQueue', () => {
  it('coalesces a delta burst while the sink is backpressured', async () => {
    const frames: string[] = [];
    let releaseSink: (() => void) | undefined;
    const queue = new MergingWriteQueue((frame) => {
      frames.push(frame);
      // The first frame blocks until released; everything queued behind it
      // is subject to merging.
      if (frames.length === 1) {
        return new Promise<void>((resolve) => {
          releaseSink = resolve;
        });
      }
      return Promise.resolve();
    });

    queue.write(assistantDelta('a'));
    queue.write(assistantDelta('b'));
    queue.write(assistantDelta('c'));
    releaseSink!();
    await queue.drain();

    const parsed = frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
    // First frame went out unmerged; b and c folded into one tail frame.
    expect(parsed).toHaveLength(2);
    expect((parsed[0]!['params'] as Record<string, unknown>)['delta']).toBe('a');
    expect((parsed[1]!['params'] as Record<string, unknown>)['delta']).toBe('bc');
  });

  it('keeps durable frames in order after volatile deltas', async () => {
    const frames: string[] = [];
    let releaseSink: (() => void) | undefined;
    const queue = new MergingWriteQueue((frame) => {
      frames.push(frame);
      if (frames.length === 1) {
        return new Promise<void>((resolve) => {
          releaseSink = resolve;
        });
      }
      return Promise.resolve();
    });

    const turnEnded = eventMessage({
      sessionId: 's1',
      agentId: 'main',
      type: 'turn.ended',
      turnId: 1,
      reason: 'completed',
    });
    queue.write(assistantDelta('x'));
    queue.write(assistantDelta('y'));
    queue.write(turnEnded);
    releaseSink!();
    await queue.drain();

    const parsed = frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
    // The first delta was already committed to the sink, so no merge was
    // possible — what matters is that nothing is dropped or reordered and
    // the concatenated text is intact.
    expect(parsed.map((frame) => (frame['params'] as Record<string, unknown>)['type'])).toEqual([
      'assistant.delta',
      'assistant.delta',
      'turn.ended',
    ]);
    const text = parsed
      .filter((frame) => (frame['params'] as Record<string, unknown>)['type'] === 'assistant.delta')
      .map((frame) => (frame['params'] as Record<string, unknown>)['delta'])
      .join('');
    expect(text).toBe('xy');
  });

  it('reports sink errors and drops the backlog', async () => {
    const errors: string[] = [];
    const queue = new MergingWriteQueue(
      () => Promise.reject(new Error('broken pipe')),
      (error) => errors.push(error.message),
    );
    queue.write(assistantDelta('a'));
    await queue.drain();
    expect(errors).toEqual(['broken pipe']);
    expect(queue.pendingCount).toBe(0);
  });
});
