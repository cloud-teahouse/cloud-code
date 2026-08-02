import { EventEmitter } from 'node:events';

import type { Event, CloudCodeCore } from '@cloud-code/agent-core';
import { describe, expect, it } from 'vitest';
import type WebSocket from 'ws';

import { BridgeConnection, createCoreDispatcher } from '../src/bridge';
import { createWsConnection } from '../src/transport/ws';
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

/**
 * Fake WebSocket: `send` captures frames and holds the flush callback while
 * armed, simulating a slow consumer so the write queue backs up.
 */
class FakeSocket extends EventEmitter {
  readonly frames: string[] = [];
  readyState = 1; // OPEN
  private releaseHeld: (() => void) | undefined;

  holdNextFlush(): void {
    this.releaseHeld = undefined;
    this.armed = true;
  }

  private armed = false;

  send(frame: string, callback?: (error?: Error | null) => void): void {
    this.frames.push(frame);
    // ws@8 invokes the send callback with `null` on success — mirror that so
    // the fake exercises the same sink code path as a real socket.
    if (this.armed) {
      this.armed = false;
      this.releaseHeld = () => callback?.(null);
      return;
    }
    callback?.(null);
  }

  release(): void {
    this.releaseHeld?.();
    this.releaseHeld = undefined;
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

function tick(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ws backpressure (design §6.2)', () => {
  it('coalesces a same-turn delta flood into fewer ws messages without losing text', async () => {
    const socket = new FakeSocket();
    const serverConnection = createWsConnection(socket as unknown as WebSocket);
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
    serverConnection.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'c', version: '0' }, protocolVersion: 1 },
    });
    serverConnection.handleMessage({ jsonrpc: '2.0', id: 2, method: 'createSession', params: {} });
    // Wait until both response frames have been flushed.
    for (let i = 0; i < 100 && socket.frames.length < 2; i += 1) await tick(5);
    expect(socket.frames.length).toBe(2);

    // Hold the next flush: the flood then piles up in the write queue.
    socket.holdNextFlush();
    const deltas: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const text = `chunk-${i}-`;
      deltas.push(text);
      multiplexer.emitEvent(assistantDelta('s1', text));
    }
    await tick(50);
    socket.release();
    await tick(100);

    const eventFrames = socket.frames
      .slice(2)
      .map((frame) => JSON.parse(frame) as Record<string, unknown>)
      .filter((message) => message['method'] === 'event');

    // Far fewer messages than events went out, and every byte survived.
    expect(eventFrames.length).toBeGreaterThan(0);
    expect(eventFrames.length).toBeLessThan(10);
    const text = eventFrames
      .map((frame) => String((frame['params'] as Record<string, unknown>)['delta']))
      .join('');
    expect(text).toBe(deltas.join(''));
  }, 15_000);
});
