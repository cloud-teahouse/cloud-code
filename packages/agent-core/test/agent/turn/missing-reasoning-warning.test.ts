import type { ToolCall } from '@cloud-code/kosong';
import { describe, expect, it } from 'vitest';

import type { Logger } from '../../../src/logging';
import { testAgent, type TestAgentContext } from '../harness/agent';

interface RecordedWarning {
  readonly message: string;
  readonly payload?: unknown;
}

/** A silent logger that captures warn-level entries for assertions. */
function mockLogger(): { logger: Logger; warnings: RecordedWarning[] } {
  const warnings: RecordedWarning[] = [];
  const logger: Logger = {
    error: () => {},
    warn: (message, payload) => {
      warnings.push({ message, payload });
    },
    info: () => {},
    debug: () => {},
    createChild: () => logger,
  };
  return { logger, warnings };
}

function lookupCall(id: string, query: string): ToolCall {
  return {
    type: 'function',
    id,
    name: 'Lookup',
    arguments: JSON.stringify({ query }),
  };
}

async function registerLookup(ctx: TestAgentContext): Promise<void> {
  await ctx.rpc.setPermission({ mode: 'auto' });
  await ctx.rpc.registerTool({
    name: 'Lookup',
    description: 'Look up a short test value.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  });
}

const THINKING_CAPABILITIES = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;

/** Configure an agent whose resolved thinking effort is on. */
function configureThinkingAgent(ctx: TestAgentContext): void {
  ctx.configure({ modelCapabilities: THINKING_CAPABILITIES });
  // The mock kimi model declares no concrete efforts, so any requested effort
  // normalizes to 'on' — thinking enabled.
  ctx.agent.config.update({ thinkingEffort: 'high' });
  expect(ctx.agent.config.thinkingEffort).not.toBe('off');
}

/** Drive a single tool-call step and the closing text step of one turn. */
async function runToolTurn(ctx: TestAgentContext, query: string): Promise<void> {
  ctx.mockNextResponse({ type: 'text', text: 'calling' }, lookupCall(`call_${query}`, query));
  ctx.mockNextResponse({ type: 'text', text: 'done' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: `look up ${query}` }] });
  await ctx.untilToolCall({ content: `${query}-result`, output: `${query}-result` });
  await ctx.untilTurnEnd();
}

function warningEvents(ctx: TestAgentContext): Array<Record<string, unknown>> {
  return ctx.allEvents
    .filter((entry) => entry.type === '[rpc]' && entry.event === 'warning')
    .map((entry) => entry.args as Record<string, unknown>);
}

describe('missing tool-call reasoning warning', () => {
  it('warns once per session across reasoning-less tool-call steps and turns when thinking is on', async () => {
    const { logger, warnings } = mockLogger();
    const ctx = testAgent({ log: logger });
    configureThinkingAgent(ctx);
    await registerLookup(ctx);

    // Turn 1: two consecutive tool-call steps, neither carries reasoning.
    ctx.mockNextResponse({ type: 'text', text: 'calling' }, lookupCall('call_moon', 'moon'));
    ctx.mockNextResponse({ type: 'text', text: 'calling again' }, lookupCall('call_sun', 'sun'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'look up moon then sun' }] });
    await ctx.untilToolCall({ content: 'moon-result', output: 'moon-result' });
    await ctx.untilToolCall({ content: 'sun-result', output: 'sun-result' });
    await ctx.untilTurnEnd();

    // Turn 2: one more reasoning-less tool-call step — still no second warning.
    await runToolTurn(ctx, 'mars');

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('without reasoning');
    const events = warningEvents(ctx);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ code: 'missing-tool-call-reasoning' });
  });

  it('does not warn when thinking is off', async () => {
    const { logger, warnings } = mockLogger();
    const ctx = testAgent({ log: logger });
    ctx.configure({ modelCapabilities: THINKING_CAPABILITIES });
    await registerLookup(ctx);

    await runToolTurn(ctx, 'moon');

    expect(warnings).toHaveLength(0);
    expect(warningEvents(ctx)).toHaveLength(0);
  });

  it('does not warn when the tool-call step carries reasoning', async () => {
    const { logger, warnings } = mockLogger();
    const ctx = testAgent({ log: logger });
    configureThinkingAgent(ctx);
    await registerLookup(ctx);

    ctx.mockNextResponse(
      { type: 'think', think: 'deciding which tool to call' },
      lookupCall('call_moon', 'moon'),
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'look up moon' }] });
    await ctx.untilToolCall({ content: 'moon-result', output: 'moon-result' });
    await ctx.untilTurnEnd();

    expect(warnings).toHaveLength(0);
    expect(warningEvents(ctx)).toHaveLength(0);
  });

  it('warns when the tool-call step carries only an empty reasoning string', async () => {
    const { logger, warnings } = mockLogger();
    const ctx = testAgent({ log: logger });
    configureThinkingAgent(ctx);
    await registerLookup(ctx);

    ctx.mockNextResponse({ type: 'think', think: '' }, lookupCall('call_moon', 'moon'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'look up moon' }] });
    await ctx.untilToolCall({ content: 'moon-result', output: 'moon-result' });
    await ctx.untilTurnEnd();

    expect(warnings).toHaveLength(1);
    expect(warningEvents(ctx)).toHaveLength(1);
  });

  it('does not warn when the tool-call step carries an encrypted signature block', async () => {
    const { logger, warnings } = mockLogger();
    const ctx = testAgent({ log: logger });
    configureThinkingAgent(ctx);
    await registerLookup(ctx);

    // Anthropic redacted/signed thinking: no readable text, but the block
    // itself round-trips — that counts as reasoning present.
    ctx.mockNextResponse(
      { type: 'think', think: '', encrypted: 'sig-abc' },
      lookupCall('call_moon', 'moon'),
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'look up moon' }] });
    await ctx.untilToolCall({ content: 'moon-result', output: 'moon-result' });
    await ctx.untilTurnEnd();

    expect(warnings).toHaveLength(0);
    expect(warningEvents(ctx)).toHaveLength(0);
  });

  it('does not warn for reasoning-less text-only steps', async () => {
    const { logger, warnings } = mockLogger();
    const ctx = testAgent({ log: logger });
    configureThinkingAgent(ctx);

    ctx.mockNextResponse({ type: 'text', text: 'plain answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

    expect(warnings).toHaveLength(0);
    expect(warningEvents(ctx)).toHaveLength(0);
  });
});
