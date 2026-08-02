import type { Event } from '@cloud-code/agent-core';
import { describe, expect, it } from 'vitest';

import { SDKRpcClientBase } from '#/index';

class StubRpc extends SDKRpcClientBase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async getRpc(): Promise<any> {
    throw new Error('no core calls expected');
  }
}

describe('SDKRpcClientBase.receiveEvent', () => {
  it('isolates a throwing listener: remaining listeners still receive the event', () => {
    const rpc = new StubRpc();
    const received: string[] = [];
    rpc.onEvent(() => {
      throw new Error('render callback exploded');
    });
    rpc.onEvent((event) => {
      received.push(event.type);
    });
    rpc.onEvent((event) => {
      received.push(`again:${event.type}`);
    });

    const event = { type: 'agent.status.updated', status: 'ready' } as unknown as Event;
    // A broken listener must neither take down the transport (uncaught in a
    // stream/socket callback) nor starve the other listeners.
    expect(() => {
      rpc.receiveEvent(event);
    }).not.toThrow();
    expect(received).toEqual(['agent.status.updated', 'again:agent.status.updated']);
  });
});
