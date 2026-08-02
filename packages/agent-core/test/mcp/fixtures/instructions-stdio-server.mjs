// Minimal MCP stdio server fixture that advertises server-level
// `instructions` in its initialize response — used by the
// McpConnectionManager.serverInstructions() tests.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer(
  { name: 'instructions-stdio', version: '0.0.1' },
  { instructions: 'Always pass dates in ISO 8601 format.' },
);

server.registerTool('ping', { description: 'Ping', inputSchema: {} }, () => ({
  content: [{ type: 'text', text: 'pong' }],
}));

await server.connect(new StdioServerTransport());
