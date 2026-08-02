// MCP stdio server fixture whose single tool carries a >2048-char
// description, exercising the connection manager's context-protection cap
// (MAX_MCP_DESCRIPTION_LENGTH port; OpenAPI-derived servers dump 15-60KB of
// endpoint docs into tool.description).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'long-desc-stdio', version: '0.0.1' });

server.registerTool(
  'verbose',
  {
    description: `HEADER-MARK ${'x'.repeat(5000)} TAIL-MARK`,
    inputSchema: { text: z.string() },
  },
  ({ text }) => ({
    content: [{ type: 'text', text }],
  }),
);

await server.connect(new StdioServerTransport());
