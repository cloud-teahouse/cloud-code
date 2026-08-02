import { describe, expect, it } from 'vitest';

import { toMcpToolDefinition } from '../../src/mcp/client-shared';
import {
  isAlwaysLoadMcpTool,
  MCP_ALWAYS_LOAD_META_KEY,
  type MCPToolDefinition,
} from '../../src/mcp/types';

describe('MCP tool _meta passthrough', () => {
  it('carries _meta from the SDK listing into the tool definition', () => {
    const def = toMcpToolDefinition({
      name: 'send_message',
      description: 'Send a message',
      inputSchema: { type: 'object' },
      _meta: { [MCP_ALWAYS_LOAD_META_KEY]: true },
    });
    expect(def._meta).toEqual({ [MCP_ALWAYS_LOAD_META_KEY]: true });
    expect(isAlwaysLoadMcpTool(def)).toBe(true);
  });

  it('omits _meta when the server did not send any', () => {
    const def = toMcpToolDefinition({
      name: 'send_message',
      inputSchema: { type: 'object' },
    });
    expect(def._meta).toBeUndefined();
    expect(isAlwaysLoadMcpTool(def)).toBe(false);
  });
});

describe('isAlwaysLoadMcpTool', () => {
  it('accepts only a literal true under anthropic/alwaysLoad', () => {
    const withMeta = (meta: MCPToolDefinition['_meta']): MCPToolDefinition => ({
      name: 't',
      description: '',
      inputSchema: {},
      ...(meta === undefined ? {} : { _meta: meta }),
    });
    expect(isAlwaysLoadMcpTool(withMeta({ 'anthropic/alwaysLoad': true }))).toBe(true);
    expect(isAlwaysLoadMcpTool(withMeta({ 'anthropic/alwaysLoad': false }))).toBe(false);
    expect(isAlwaysLoadMcpTool(withMeta({ 'anthropic/alwaysLoad': 'true' }))).toBe(false);
    expect(isAlwaysLoadMcpTool(withMeta({}))).toBe(false);
    expect(isAlwaysLoadMcpTool(withMeta(undefined))).toBe(false);
  });
});
