import { ErrorCodes, CloudCodeError, type Event, type CloudCodeCore } from '@cloud-code/agent-core';
import { JSON_RPC_ERROR } from '@cloud-code/protocol';
import { describe, expect, it } from 'vitest';

import { BridgeConnection, createCoreDispatcher, type CoreDispatcher } from '../src/bridge';
import { EventJournal } from '../src/event-journal';
import { JsonRpcConnection, JsonRpcRemoteError } from '../src/jsonrpc/connection';
import { SdkMultiplexer } from '../src/sdk-multiplexer';

/** In-memory full-duplex connection pair (delivery deferred to microtasks). */
function linkedPair(): [JsonRpcConnection, JsonRpcConnection] {
  let serverSide!: JsonRpcConnection;
  let clientSide!: JsonRpcConnection;
  serverSide = new JsonRpcConnection({
    write: (message) => queueMicrotask(() => clientSide.handleMessage(message)),
  });
  clientSide = new JsonRpcConnection({
    write: (message) => queueMicrotask(() => serverSide.handleMessage(message)),
  });
  return [serverSide, clientSide];
}

interface TestRig {
  readonly bridge: BridgeConnection;
  readonly client: JsonRpcConnection;
  readonly multiplexer: SdkMultiplexer;
  readonly dispatched: Array<{ method: string; params: unknown }>;
}

/**
 * Rig with a fake core: `coreImpl` holds plain method implementations; the
 * dispatch path goes through the real `createCoreDispatcher`, so whitelist
 * and error-mapping behavior match production.
 */
function makeRig(
  coreImpl: Record<string, (params: unknown) => unknown> = {},
  journal?: EventJournal,
): TestRig {
  const [serverSide, clientSide] = linkedPair();
  const multiplexer = new SdkMultiplexer(journal);
  const dispatched: Array<{ method: string; params: unknown }> = [];
  const realDispatch = createCoreDispatcher(coreImpl as unknown as CloudCodeCore);
  const dispatch: CoreDispatcher = async (method, params) => {
    dispatched.push({ method, params });
    return realDispatch(method, params);
  };
  const bridge = new BridgeConnection({
    connection: serverSide,
    multiplexer,
    dispatch,
    serverInfo: { name: 'test-server', version: '0.0.0' },
    homeDir: '/tmp/test-home',
  });
  return { bridge, client: clientSide, multiplexer, dispatched };
}

async function initialize(client: JsonRpcConnection): Promise<unknown> {
  return client.request('initialize', {
    clientInfo: { name: 'test-client', version: '0.0.0' },
    capabilities: {},
    protocolVersion: 1,
  });
}

describe('BridgeConnection handshake', () => {
  it('rejects requests before initialize', async () => {
    const { client } = makeRig();
    await expect(client.request('prompt', {})).rejects.toMatchObject({
      code: JSON_RPC_ERROR.NOT_INITIALIZED,
    });
  });

  it('answers initialize with server info and protocol version', async () => {
    const { client } = makeRig();
    const result = (await initialize(client)) as Record<string, unknown>;
    expect(result['protocolVersion']).toBe(1);
    expect(result['homeDir']).toBe('/tmp/test-home');
    expect(result['serverInfo']).toEqual({ name: 'test-server', version: '0.0.0' });
  });

  it('rejects malformed initialize params', async () => {
    const { client } = makeRig();
    await expect(client.request('initialize', { nope: true })).rejects.toMatchObject({
      code: JSON_RPC_ERROR.INVALID_PARAMS,
    });
  });

  it('rejects an incompatible protocol version', async () => {
    const { client } = makeRig();
    await expect(
      client.request('initialize', {
        clientInfo: { name: 'c', version: '0' },
        protocolVersion: 999,
      }),
    ).rejects.toMatchObject({ code: JSON_RPC_ERROR.INVALID_PARAMS });
  });
});

describe('BridgeConnection forward dispatch', () => {
  it('passes params through to the dispatcher', async () => {
    const { client, dispatched } = makeRig({ prompt: () => undefined });
    await initialize(client);
    const params = { sessionId: 's1', agentId: 'main', input: [{ type: 'text', text: 'hi' }] };
    await client.request('prompt', params);
    expect(dispatched).toEqual([{ method: 'prompt', params }]);
  });

  it('claims the session on createSession results', async () => {
    const { bridge, client, multiplexer } = makeRig({
      createSession: () => ({ id: 's1', workDir: '/tmp' }),
    });
    await initialize(client);
    await client.request('createSession', { workDir: '/tmp' });
    expect(multiplexer.ownerOf('s1')).toBe(bridge);
  });

  it('forgets the session on closeSession so its journal is not retained', async () => {
    const journal = new EventJournal();
    const { bridge, client, multiplexer } = makeRig(
      {
        createSession: () => ({ id: 's1', workDir: '/tmp' }),
        closeSession: () => undefined,
      },
      journal,
    );
    await initialize(client);
    await client.request('createSession', { workDir: '/tmp' });
    journal.append({ type: 'turn.started', sessionId: 's1', agentId: 'main', turnId: 1 } as Event);
    expect(multiplexer.ownerOf('s1')).toBe(bridge);
    expect(journal.retainedSessionCount).toBe(1);

    await client.request('closeSession', { sessionId: 's1' });

    expect(multiplexer.ownerOf('s1')).toBeUndefined();
    expect(journal.retainedSessionCount).toBe(0);
  });

  it('keeps the session when closeSession fails', async () => {
    const journal = new EventJournal();
    const { client, multiplexer } = makeRig(
      {
        createSession: () => ({ id: 's1', workDir: '/tmp' }),
        closeSession: () => {
          throw new CloudCodeError(ErrorCodes.SESSION_NOT_FOUND, 'Session not found.');
        },
      },
      journal,
    );
    await initialize(client);
    await client.request('createSession', { workDir: '/tmp' });
    journal.append({ type: 'turn.started', sessionId: 's1', agentId: 'main', turnId: 1 } as Event);

    await expect(client.request('closeSession', { sessionId: 's1' })).rejects.toThrow();

    expect(multiplexer.ownerOf('s1')).toBeDefined();
    expect(journal.retainedSessionCount).toBe(1);
  });

  it('maps CloudCodeError codes onto error.data and -32000', async () => {
    const { client } = makeRig({
      resumeSession: () => {
        throw new CloudCodeError(ErrorCodes.SESSION_NOT_FOUND, 'Session not found.');
      },
    });
    await initialize(client);
    try {
      await client.request('resumeSession', { sessionId: 'ghost' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(JsonRpcRemoteError);
      const remote = error as JsonRpcRemoteError;
      expect(remote.code).toBe(JSON_RPC_ERROR.SERVER_ERROR);
      expect(remote.data).toMatchObject({ code: 'session.not_found', retryable: false });
    }
  });

  it('maps parameter-class errors to -32602', async () => {
    const { client } = makeRig({
      createSession: () => {
        throw new CloudCodeError(ErrorCodes.REQUEST_INVALID, 'bad params');
      },
    });
    await initialize(client);
    await expect(client.request('createSession', {})).rejects.toMatchObject({
      code: JSON_RPC_ERROR.INVALID_PARAMS,
      data: { code: 'request.invalid' },
    });
  });

  it('reports method-not-found for unknown methods', async () => {
    const { client } = makeRig();
    await initialize(client);
    await expect(client.request('definitelyNotAMethod', {})).rejects.toMatchObject({
      code: JSON_RPC_ERROR.METHOD_NOT_FOUND,
    });
  });
});

describe('BridgeConnection reverse RPC', () => {
  async function rigWithSession(clientHandlers?: {
    onApproval?: (params: unknown) => Promise<unknown>;
  }): Promise<TestRig> {
    const rig = makeRig({ createSession: () => ({ id: 's1', workDir: '/tmp' }) });
    if (clientHandlers?.onApproval !== undefined) {
      rig.client.onRequest('requestApproval', clientHandlers.onApproval);
    }
    await initialize(rig.client);
    await rig.client.request('createSession', { workDir: '/tmp' });
    return rig;
  }

  it('routes approval requests to the owning connection', async () => {
    const seen: unknown[] = [];
    const { multiplexer } = await rigWithSession({
      onApproval: async (params) => {
        seen.push(params);
        return { decision: 'approved' };
      },
    });
    const result = await multiplexer.requestApproval({
      sessionId: 's1',
      agentId: 'main',
      toolCallId: 'tc1',
      toolName: 'Bash',
      action: 'Bash',
      display: { kind: 'generic', summary: 'echo hi' },
    });
    expect(result).toEqual({ decision: 'approved' });
    expect(seen).toHaveLength(1);
    expect((seen[0] as Record<string, unknown>)['toolCallId']).toBe('tc1');
  });

  it('synthesizes a cancelled approval when the client dies mid-request', async () => {
    const rig = await rigWithSession({
      onApproval: () => new Promise(() => {}), // never resolves
    });
    const pending = rig.multiplexer.requestApproval({
      sessionId: 's1',
      agentId: 'main',
      toolCallId: 'tc1',
      toolName: 'Bash',
      action: 'Bash',
      display: { kind: 'generic', summary: 'echo hi' },
    });
    // Let the request reach the client, then sever the connection.
    await new Promise((resolve) => setTimeout(resolve, 10));
    rig.bridge.connection.close();
    await expect(pending).resolves.toMatchObject({ decision: 'cancelled' });
  });

  it('forwards events to subscribers as `event` notifications', async () => {
    const events: Event[] = [];
    const rig = await rigWithSession();
    rig.client.onNotification('event', (params) => events.push(params as Event));
    rig.multiplexer.emitEvent({
      type: 'turn.started',
      sessionId: 's1',
      agentId: 'main',
      turnId: 1,
    } as Event);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'turn.started', sessionId: 's1' });
  });
});

describe('createCoreDispatcher', () => {
  it('exposes only whitelisted CoreAPI methods', async () => {
    const fakeCore = {
      createSession: (payload: unknown) => ({ id: 's1', payload }),
      resumeSessionWithOverrides: () => ({ id: 'should-not-be-reachable' }),
    } as unknown as CloudCodeCore;
    const dispatch = createCoreDispatcher(fakeCore);

    await expect(dispatch('createSession', { workDir: '/tmp' })).resolves.toMatchObject({
      id: 's1',
    });
    await expect(dispatch('resumeSessionWithOverrides', {})).rejects.toMatchObject({
      code: JSON_RPC_ERROR.METHOD_NOT_FOUND,
    });
    await expect(dispatch('definitelyNotAMethod', {})).rejects.toMatchObject({
      code: JSON_RPC_ERROR.METHOD_NOT_FOUND,
    });
  });
});
