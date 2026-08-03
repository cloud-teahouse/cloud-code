import { describe, expect, it } from 'vitest';

import type { RPCMethods } from '../../src/rpc/client';
import {
  markLocalRpcMethod,
  materializeRpcPayload,
  wrapRpcPayload,
} from '../../src/rpc/payload';
import { proxyWithExtraPayload } from '../../src/rpc/types';

describe('RPC payload overlays', () => {
  it('materializes nested extra payloads in insertion order', () => {
    const payload = wrapRpcPayload(
      wrapRpcPayload({ value: 1, sessionId: 'caller-value' }, { agentId: 'agent-1' }),
      { sessionId: 'session-1' },
    );

    expect(materializeRpcPayload(payload)).toEqual({
      value: 1,
      sessionId: 'session-1',
      agentId: 'agent-1',
    });
  });

  it('leaves ordinary payloads untouched', () => {
    const payload = { value: 1 };

    expect(materializeRpcPayload(payload)).toBe(payload);
  });

  it('preserves object-spread handling of a __proto__ data property', () => {
    const base = JSON.parse('{"__proto__":{"source":true},"value":1}') as Record<
      string,
      unknown
    >;
    const materialized = materializeRpcPayload(wrapRpcPayload(base, {})) as Record<
      string,
      unknown
    >;

    expect(Object.hasOwn(materialized, '__proto__')).toBe(true);
    expect(materialized['__proto__']).toEqual({ source: true });
    expect(Object.getPrototypeOf(materialized)).toBe(Object.prototype);
  });

  it('keeps direct proxy consumers on the flat payload contract', async () => {
    let received: { value: number; agentId: string } | undefined;
    const methods: RPCMethods<{
      emit(payload: { value: number; agentId: string }): void;
    }> = {
      emit: async (payload) => {
        received = payload;
      },
    };
    const proxied = proxyWithExtraPayload<
      { emit(payload: { value: number }): void },
      { agentId: string }
    >(methods, { agentId: 'agent-1' });

    await proxied.emit({ value: 1 });

    expect(received).toEqual({ value: 1, agentId: 'agent-1' });
  });

  it('composes nested local RPC proxies before materializing one wire payload', async () => {
    let received:
      | { value: number; agentId: string; sessionId: string }
      | undefined;
    const methods: RPCMethods<{
      emit(payload: { value: number; agentId: string; sessionId: string }): void;
    }> = {
      emit: markLocalRpcMethod(async (payload) => {
        received = materializeRpcPayload(payload) as {
          value: number;
          agentId: string;
          sessionId: string;
        };
      }),
    };
    const sessionProxy = proxyWithExtraPayload<
      { emit(payload: { value: number; agentId: string }): void },
      { sessionId: string }
    >(methods, { sessionId: 'session-1' });
    const agentProxy = proxyWithExtraPayload<
      { emit(payload: { value: number }): void },
      { agentId: string }
    >(sessionProxy, { agentId: 'agent-1' });

    await agentProxy.emit({ value: 1 });

    expect(received).toEqual({ value: 1, agentId: 'agent-1', sessionId: 'session-1' });
  });
});
