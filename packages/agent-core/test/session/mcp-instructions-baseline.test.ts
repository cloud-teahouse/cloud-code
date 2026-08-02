import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_PROFILES, formatMcpServerInstructions } from '../../src/profile';
import { extractMcpInstructionsBlock } from '../../src/session';

const promptContext = {
  osEnv: {
    osKind: 'Linux',
    osArch: 'x86_64',
    osVersion: 'test',
    shellName: 'bash',
    shellPath: '/bin/bash',
  },
  cwd: '/workspace',
  now: '2026-05-09T00:00:00.000Z',
} as const;

describe('extractMcpInstructionsBlock', () => {
  it('round-trips the aggregate rendered into the default system prompt', () => {
    const block = formatMcpServerInstructions([
      { name: 'github', instructions: 'Use the GitHub tools for PRs.' },
      { name: 'grafana', instructions: 'Always pass dates in ISO 8601 format.' },
    ]);
    const prompt =
      DEFAULT_AGENT_PROFILES['agent']?.systemPrompt({ ...promptContext, mcpInstructions: block }) ??
      '';
    expect(prompt).toContain('# MCP Server Instructions');

    expect(extractMcpInstructionsBlock(prompt)).toBe(block);
  });

  it('returns undefined when the prompt has no MCP section', () => {
    const prompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt({ ...promptContext }) ?? '';
    expect(prompt).not.toContain('# MCP Server Instructions');
    expect(extractMcpInstructionsBlock(prompt)).toBeUndefined();
  });

  it('strips exactly the one template newline after the block', () => {
    const block = '## server\nline one\nline two';
    const prompt =
      DEFAULT_AGENT_PROFILES['agent']?.systemPrompt({ ...promptContext, mcpInstructions: block }) ??
      '';
    expect(extractMcpInstructionsBlock(prompt)).toBe(block);
  });
});
