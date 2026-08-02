/**
 * MCP description truncation: descriptions and server
 * instructions are capped at MAX_MCP_DESCRIPTION_LENGTH (2048) before they
 * reach the model, so an OpenAPI-derived server dumping tens of KB of docs
 * into one field cannot flood the context window. rawTools stay verbatim
 * for the discovery record.
 */

import { join } from 'pathe';

import { describe, expect, it } from 'vitest';

import { McpConnectionManager } from '../../src/mcp/connection-manager';
import {
  MAX_MCP_DESCRIPTION_LENGTH,
  truncateMcpDescription,
} from '../../src/mcp/types';

const here = import.meta.dirname;
const longDescFixture = join(here, 'fixtures', 'long-desc-stdio-server.mjs');

describe('truncateMcpDescription', () => {
  it('passes through descriptions at or under the cap unchanged', () => {
    expect(truncateMcpDescription('')).toBe('');
    expect(truncateMcpDescription('short')).toBe('short');
    const atCap = 'a'.repeat(MAX_MCP_DESCRIPTION_LENGTH);
    expect(truncateMcpDescription(atCap)).toBe(atCap);
    const justUnder = 'a'.repeat(MAX_MCP_DESCRIPTION_LENGTH - 1);
    expect(truncateMcpDescription(justUnder)).toBe(justUnder);
  });

  it('hard-truncates one character past the cap', () => {
    const over = 'a'.repeat(MAX_MCP_DESCRIPTION_LENGTH + 1);
    const truncated = truncateMcpDescription(over);
    expect(truncated).toHaveLength(MAX_MCP_DESCRIPTION_LENGTH);
    expect(truncated).toBe('a'.repeat(MAX_MCP_DESCRIPTION_LENGTH));
  });

  it('cuts a huge OpenAPI-style dump down to the cap', () => {
    const huge = 'docs '.repeat(20_000);
    expect(truncateMcpDescription(huge)).toHaveLength(MAX_MCP_DESCRIPTION_LENGTH);
  });

  it('never splits a surrogate pair at the cut boundary', () => {
    // 2047 ASCII chars + one astral character (2 code units) + tail: the
    // naive cut lands between the surrogate halves.
    const astral = '\u{1F600}'; // 😀
    const input = `${'a'.repeat(MAX_MCP_DESCRIPTION_LENGTH - 1)}${astral}tail`;
    expect(input.length).toBeGreaterThan(MAX_MCP_DESCRIPTION_LENGTH);
    const truncated = truncateMcpDescription(input);
    expect(truncated).toHaveLength(MAX_MCP_DESCRIPTION_LENGTH - 1);
    expect(truncated.endsWith('a')).toBe(true);
    expect(truncated.replaceAll('a', '')).toHaveLength(0);
  });

  it('keeps an astral character that fits exactly under the cap', () => {
    const astral = '\u{1F600}';
    const input = 'a'.repeat(MAX_MCP_DESCRIPTION_LENGTH - 2) + astral;
    expect(input.length).toBe(MAX_MCP_DESCRIPTION_LENGTH);
    expect(truncateMcpDescription(input)).toBe(input);
  });
});

describe('McpConnectionManager description cap', () => {
  it('truncates tool descriptions from tools/list to 2048 chars', async () => {
    const cm = new McpConnectionManager();
    try {
      await cm.connectAll({
        verbose: {
          transport: 'stdio',
          command: process.execPath,
          args: [longDescFixture],
          startupTimeoutMs: 10_000,
        },
      });
      const resolved = cm.resolved('verbose');
      expect(resolved).toBeDefined();
      const tool = resolved?.tools.find((t) => t.name === 'verbose');
      expect(tool).toBeDefined();
      expect(tool?.description).toHaveLength(MAX_MCP_DESCRIPTION_LENGTH);
      expect(tool?.description.startsWith('HEADER-MARK ')).toBe(true);
      expect(tool?.description.endsWith('TAIL-MARK')).toBe(false);
      // The verbatim record keeps the full server-supplied description.
      const raw = resolved?.rawTools.find((t) => t.name === 'verbose');
      expect(raw?.description.length).toBeGreaterThan(MAX_MCP_DESCRIPTION_LENGTH);
      expect(raw?.description.endsWith('TAIL-MARK')).toBe(true);
    } finally {
      await cm.shutdown();
    }
  }, 20000);
});
