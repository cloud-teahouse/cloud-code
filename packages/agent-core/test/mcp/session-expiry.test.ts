/**
 * MCP session-expiry auto-reconnect: a tool call that fails
 * with HTTP 404 + JSON-RPC -32001 ("Session not found") rebuilds the server
 * connection through the manager's existing `reconnect()` and retries the
 * call exactly once on the fresh client. Concurrent expiries on the same
 * server share one reconnect instead of stampeding the handshake.
 */

import type { Tool } from '@cloud-code/kosong';
import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import { ToolManager } from '../../src/agent/tool';
import type { McpConnectionManager } from '../../src/mcp/connection-manager';
import {
  isMcpSessionExpiredError,
  type MCPClient,
  type MCPToolResult,
} from '../../src/mcp/types';
import { executeTool } from '../tools/fixtures/execute-tool';

function sessionExpiredError(): Error {
  const error = new Error(
    'Error POSTing to endpoint (HTTP 404): {"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"},"id":null}',
  );
  (error as Error & { code?: number }).code = 404;
  return error;
}

describe('isMcpSessionExpiredError', () => {
  it('matches HTTP 404 + JSON-RPC -32001 (both spacings)', () => {
    expect(isMcpSessionExpiredError(sessionExpiredError())).toBe(true);
    const spaced = new Error('HTTP 404: {"error":{"code": -32001,"message":"Session not found"}}');
    (spaced as Error & { code?: number }).code = 404;
    expect(isMcpSessionExpiredError(spaced)).toBe(true);
  });

  it('rejects generic 404s without the JSON-RPC session code', () => {
    const plain = new Error('HTTP 404: not found');
    (plain as Error & { code?: number }).code = 404;
    expect(isMcpSessionExpiredError(plain)).toBe(false);
  });

  it('rejects -32001 payloads without the 404 status', () => {
    const wrongStatus = new Error('{"error":{"code":-32001,"message":"Session not found"}}');
    (wrongStatus as Error & { code?: number }).code = 500;
    expect(isMcpSessionExpiredError(wrongStatus)).toBe(false);
    expect(isMcpSessionExpiredError(new Error('{"code":-32001}'))).toBe(false);
  });
});

interface ManagerStub {
  readonly reconnects: string[];
  readonly manager: McpConnectionManager;
  swapClient(client: MCPClient): void;
}

/**
 * Minimal `agent.mcp` stand-in: one 'connected' entry whose resolved client
 * the test can swap (what a real reconnect would produce).
 */
function managerStub(initial: MCPClient): ManagerStub {
  const state = { client: initial };
  const reconnects: string[] = [];
  const manager = {
    list: () => [],
    onStatusChange: () => () => {},
    get: (name: string) =>
      name === 'srv'
        ? { name: 'srv', transport: 'http', status: 'connected', toolCount: 1 }
        : undefined,
    reconnect: async (name: string) => {
      reconnects.push(name);
    },
    resolved: (name: string) =>
      name === 'srv'
        ? { client: state.client, tools: [], rawTools: [], enabledNames: new Set<string>() }
        : undefined,
  } as unknown as McpConnectionManager;
  return {
    reconnects,
    manager,
    swapClient(client: MCPClient) {
      state.client = client;
    },
  };
}

function fakeAgent(mcp: McpConnectionManager | undefined): Agent {
  return {
    mcp,
    records: { logRecord: () => {} },
    config: { data: () => ({ provider: undefined }) },
    goal: { getGoal: () => ({ goal: null }) },
  } as unknown as Agent;
}

function toolsOf(client: MCPClient): Promise<Tool[]> {
  return client.listTools().then((defs) =>
    defs.map((d) => ({
      name: d.name,
      description: d.description,
      parameters: d.inputSchema as Record<string, unknown>,
    })),
  );
}

function oneToolClient(callTool: () => Promise<MCPToolResult>): MCPClient {
  return {
    async listTools() {
      return [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object' } }];
    },
    callTool,
  };
}

const OK_RESULT: MCPToolResult = { content: [{ type: 'text', text: 'pong' }], isError: false };

describe('ToolManager MCP session-expiry reconnect', () => {
  it('reconnects and retries once on 404 + -32001, returning the fresh result', async () => {
    let callsOnOld = 0;
    const oldClient = oneToolClient(() => {
      callsOnOld += 1;
      return Promise.reject(sessionExpiredError());
    });
    const stub = managerStub(oldClient);
    let callsOnNew = 0;
    const freshClient = oneToolClient(() => {
      callsOnNew += 1;
      return Promise.resolve(OK_RESULT);
    });

    const tm = new ToolManager(fakeAgent(stub.manager));
    tm.setActiveTools(['mcp__*']);
    tm.registerMcpServer('srv', oldClient, await toolsOf(oldClient));
    // The reconnect swaps the resolved client, like a real reconnect would.
    stub.swapClient(freshClient);

    const tool = tm.loopTools.find((t) => t.name === 'mcp__srv__ping');
    expect(tool).toBeDefined();
    const result = await executeTool(tool!, {
      turnId: '0',
      toolCallId: 'call_1',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result.isError).not.toBe(true);
    expect(stub.reconnects).toEqual(['srv']);
    expect(callsOnOld).toBe(1);
    expect(callsOnNew).toBe(1);
    const output = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
    expect(output).toContain('pong');
  });

  it('propagates the original error when the retry also fails', async () => {
    const oldClient = oneToolClient(() => Promise.reject(sessionExpiredError()));
    const stub = managerStub(oldClient);
    const stillExpired = oneToolClient(() => Promise.reject(sessionExpiredError()));

    const tm = new ToolManager(fakeAgent(stub.manager));
    tm.setActiveTools(['mcp__*']);
    tm.registerMcpServer('srv', oldClient, await toolsOf(oldClient));
    stub.swapClient(stillExpired);

    const tool = tm.loopTools.find((t) => t.name === 'mcp__srv__ping');
    await expect(
      executeTool(tool!, {
        turnId: '0',
        toolCallId: 'call_2',
        args: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/HTTP 404/);
    // One reconnect, one retry — never a reconnect loop.
    expect(stub.reconnects).toEqual(['srv']);
  });

  it('does not reconnect for non-session errors', async () => {
    const oldClient = oneToolClient(() => Promise.reject(new Error('boom')));
    const stub = managerStub(oldClient);

    const tm = new ToolManager(fakeAgent(stub.manager));
    tm.setActiveTools(['mcp__*']);
    tm.registerMcpServer('srv', oldClient, await toolsOf(oldClient));

    const tool = tm.loopTools.find((t) => t.name === 'mcp__srv__ping');
    await expect(
      executeTool(tool!, {
        turnId: '0',
        toolCallId: 'call_3',
        args: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('boom');
    expect(stub.reconnects).toEqual([]);
  });

  it('shares one reconnect across concurrent expiring calls on the same server', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let callsOnOld = 0;
    const oldClient = oneToolClient(async () => {
      callsOnOld += 1;
      await gate;
      throw sessionExpiredError();
    });
    const reconnect = vi.fn(async () => {
      // Slow reconnect: both calls must be waiting on it concurrently.
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const freshClient = oneToolClient(() => Promise.resolve(OK_RESULT));
    const state = { client: oldClient as MCPClient };
    const manager = {
      list: () => [],
      onStatusChange: () => () => {},
      get: () => ({ name: 'srv', transport: 'http', status: 'connected', toolCount: 1 }),
      reconnect,
      resolved: () => ({
        client: state.client,
        tools: [],
        rawTools: [],
        enabledNames: new Set<string>(),
      }),
    } as unknown as McpConnectionManager;

    const tm = new ToolManager(fakeAgent(manager));
    tm.setActiveTools(['mcp__*']);
    tm.registerMcpServer('srv', oldClient, await toolsOf(oldClient));
    state.client = freshClient;

    const tool = tm.loopTools.find((t) => t.name === 'mcp__srv__ping');
    const ctx = {
      turnId: '0',
      args: {},
      signal: new AbortController().signal,
    };
    const first = executeTool(tool!, { ...ctx, toolCallId: 'call_a' });
    const second = executeTool(tool!, { ...ctx, toolCallId: 'call_b' });
    release();
    const [r1, r2] = await Promise.all([first, second]);

    expect(callsOnOld).toBe(2);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(r1.isError).not.toBe(true);
    expect(r2.isError).not.toBe(true);
  });

  it('propagates the error without a reconnect when the server is no longer connected', async () => {
    const oldClient = oneToolClient(() => Promise.reject(sessionExpiredError()));
    const manager = {
      list: () => [],
      onStatusChange: () => () => {},
      get: () => ({ name: 'srv', transport: 'http', status: 'failed', toolCount: 0 }),
      reconnect: vi.fn(),
      resolved: () => undefined,
    } as unknown as McpConnectionManager;

    const tm = new ToolManager(fakeAgent(manager));
    tm.setActiveTools(['mcp__*']);
    tm.registerMcpServer('srv', oldClient, await toolsOf(oldClient));

    const tool = tm.loopTools.find((t) => t.name === 'mcp__srv__ping');
    await expect(
      executeTool(tool!, {
        turnId: '0',
        toolCallId: 'call_4',
        args: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/HTTP 404/);
    expect(manager.reconnect).not.toHaveBeenCalled();
  });
});
