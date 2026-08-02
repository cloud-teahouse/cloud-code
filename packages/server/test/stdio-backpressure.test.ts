import { PassThrough, Writable } from 'node:stream';

import type { Event, CloudCodeCore } from '@cloud-code/agent-core';
import { describe, expect, it } from 'vitest';

import { BridgeConnection, createCoreDispatcher } from '../src/bridge';
import { createStdioConnection } from '../src/transport/stdio';
import { SdkMultiplexer } from '../src/sdk-multiplexer';

function assistantDelta(sessionId: string, delta: string): Event {
  return {
    type: 'assistant.delta',
    sessionId,
    agentId: 'main',
    turnId: 0,
    delta,
  } as Event;
}

describe('stdio backpressure (design §6.2)', () => {
  it('coalesces a same-turn delta flood into fewer frames without losing text', async () => {
    const clientToServer = new PassThrough();
    const frames: string[] = [];
    let releaseWrite: (() => void) | undefined;
    const slowOutput = new Writable({
      write(chunk, _encoding, callback) {
        frames.push(chunk.toString('utf8'));
        if (frames.length === 2) {
          // Hold back everything after the handshake response.
          releaseWrite = () => callback();
          return;
        }
        callback();
      },
    });

    const serverConnection = createStdioConnection({
      input: clientToServer,
      output: slowOutput,
    });
    const multiplexer = new SdkMultiplexer();
    const bridge = new BridgeConnection({
      connection: serverConnection,
      multiplexer,
      dispatch: createCoreDispatcher({
        createSession: () => ({ id: 's1', workDir: '/tmp' }),
      } as unknown as CloudCodeCore),
      serverInfo: { name: 'test-server', version: '0.0.0' },
      homeDir: '/tmp',
    });
    void bridge;

    // Handshake + createSession (claims s1 for this connection).
    clientToServer.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'c', version: '0' }, protocolVersion: 1 },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    clientToServer.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'createSession', params: {} })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const baselineFrames = frames.length;
    const deltas: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const text = `chunk-${i}-`;
      deltas.push(text);
      multiplexer.emitEvent(assistantDelta('s1', text));
    }
    releaseWrite!();
    // Give the queue time to flush the backlog.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const eventFrames = frames
      .slice(baselineFrames)
      .map((frame) => JSON.parse(frame) as Record<string, unknown>)
      .filter((message) => message['method'] === 'event');

    // Far fewer frames than events went out, and every byte survived in order.
    expect(eventFrames.length).toBeGreaterThan(0);
    expect(eventFrames.length).toBeLessThan(10);
    const text = eventFrames
      .map((frame) => String((frame['params'] as Record<string, unknown>)['delta']))
      .join('');
    expect(text).toBe(deltas.join(''));
  }, 15_000);
});
