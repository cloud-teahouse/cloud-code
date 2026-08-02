import type { ToolCall } from '@cloud-code/kosong';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentRecord } from '../../src/agent';
import {
  InMemoryAgentRecordPersistence,
  type AgentRecordOf,
} from '../../src/agent/records';
import type { Logger } from '../../src/logging';
import { DEFAULT_AGENT_PROFILES } from '../../src/profile';
import { testAgent, type TestAgentContext } from './harness/agent';

function recordsOf<T extends AgentRecord['type']>(
  persistence: InMemoryAgentRecordPersistence,
  type: T,
): AgentRecordOf<T>[] {
  return persistence.records.filter(
    (record): record is AgentRecordOf<T> => record.type === type,
  );
}

async function runTurn(ctx: TestAgentContext, prompt: string): Promise<void> {
  await ctx.rpc.prompt({ input: [{ type: 'text', text: prompt }] });
  await ctx.untilTurnEnd();
}

interface RecordedWarning {
  readonly message: string;
  readonly payload?: unknown;
}

/** A silent logger that captures warn-level entries for diagnostics assertions. */
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

const LOOKUP_CALL: ToolCall = {
  type: 'function',
  id: 'call_lookup',
  name: 'Lookup',
  arguments: '{"query":"moon"}',
};

/** A two-step turn: text + tool call, tool result, then closing text. */
async function runToolTurn(ctx: TestAgentContext): Promise<void> {
  ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, LOOKUP_CALL);
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
  await ctx.untilToolCall({ content: 'moon-result', output: 'moon-result' });
  ctx.mockNextResponse({ type: 'text', text: 'The lookup result is moon-result.' });
  await ctx.untilTurnEnd();
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

describe('prefix stability across adjacent requests', () => {
  it('keeps system/tools hashes identical across the steps of a tool turn and a later plain turn', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence });
    ctx.configure();
    await registerLookup(ctx);

    await runToolTurn(ctx);
    // A plain follow-up turn appends at the tail only.
    ctx.mockNextResponse({ type: 'text', text: 'Anything else?' });
    await runTurn(ctx, 'thanks');

    const requests = recordsOf(persistence, 'llm.request');
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.systemPromptHash).toBe(requests[0]!.systemPromptHash);
      expect(request.toolsHash).toBe(requests[0]!.toolsHash);
      expect(request.prefixDriftReasons).toBeUndefined();
    }
    // The messages only ever grow at the tail.
    expect(requests[1]!.messageCount).toBeGreaterThan(requests[0]!.messageCount);
    expect(requests[2]!.messageCount).toBeGreaterThan(requests[1]!.messageCount);
  });

  it('attributes a tool-table change to the tools dimension and correlates cache counters when diagnostics are on', async () => {
    const { logger, warnings } = mockLogger();
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({
      persistence,
      log: logger,
      initialConfig: { providers: {}, debug: { cacheDiagnostics: true } },
    });
    ctx.configure({ tools: ['Read'] });

    ctx.mockNextResponse({ type: 'text', text: 'one' });
    await runTurn(ctx, 'first');

    await ctx.rpc.setActiveTools({ names: ['Read', 'Glob'] });
    ctx.mockNextResponse({ type: 'text', text: 'two' });
    await runTurn(ctx, 'second');

    // No further change: the next request is stable again.
    ctx.mockNextResponse({ type: 'text', text: 'three' });
    await runTurn(ctx, 'third');

    const requests = recordsOf(persistence, 'llm.request');
    expect(requests).toHaveLength(3);
    expect(requests[0]!.prefixDriftReasons).toBeUndefined();
    expect(requests[1]!.prefixDriftReasons).toEqual(['tools']);
    expect(requests[2]!.prefixDriftReasons).toBeUndefined();

    const driftWarnings = warnings.filter((warning) => warning.message === 'llm prefix drift');
    expect(driftWarnings).toHaveLength(1);
    expect(driftWarnings[0]!.payload).toMatchObject({
      reasons: 'tools',
      cache_read: expect.any(Number),
      cache_creation: expect.any(Number),
    });
  });

  it('lets the CLOUD_CODE_DEBUG_CACHE env var enable diagnostics without config', async () => {
    vi.stubEnv('CLOUD_CODE_DEBUG_CACHE', '1');
    try {
      const { logger, warnings } = mockLogger();
      const persistence = new InMemoryAgentRecordPersistence();
      const ctx = testAgent({ persistence, log: logger });
      ctx.configure({ tools: ['Read'] });

      ctx.mockNextResponse({ type: 'text', text: 'one' });
      await runTurn(ctx, 'first');
      await ctx.rpc.setActiveTools({ names: ['Read', 'Glob'] });
      ctx.mockNextResponse({ type: 'text', text: 'two' });
      await runTurn(ctx, 'second');

      const driftWarnings = warnings.filter((warning) => warning.message === 'llm prefix drift');
      expect(driftWarnings).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps diagnostics quiet by default even when the prefix drifts', async () => {
    const { logger, warnings } = mockLogger();
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence, log: logger });
    ctx.configure({ tools: ['Read'] });

    ctx.mockNextResponse({ type: 'text', text: 'one' });
    await runTurn(ctx, 'first');
    await ctx.rpc.setActiveTools({ names: ['Read', 'Glob'] });
    ctx.mockNextResponse({ type: 'text', text: 'two' });
    await runTurn(ctx, 'second');

    // The wire record always carries the attribution...
    const requests = recordsOf(persistence, 'llm.request');
    expect(requests[1]!.prefixDriftReasons).toEqual(['tools']);
    // ...but the log fan-out is gated on the debug switch.
    expect(warnings.filter((warning) => warning.message === 'llm prefix drift')).toHaveLength(0);
  });

  it('attributes a graduated-compaction arm to graduated_rewrite and re-stabilizes afterwards', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({
      persistence,
      graduatedCompaction: { pinpointClear: { minContentTokens: 1 } },
    });
    ctx.configure({ tools: ['Read'] });
    ctx.appendToolExchange({ key: 'a', resultText: 'a sizeable lookup result' });

    ctx.mockNextResponse({ type: 'text', text: 'one' });
    await runTurn(ctx, 'first');

    // Arm the pinpoint-clear layer: the projection rewrites mid-history tool
    // results, moving the wire prefix without touching system/tools.
    ctx.agent.graduatedCompaction.restoreLayerApply({ layer: 'pinpoint_clear', cutoff: 2 });
    ctx.mockNextResponse({ type: 'text', text: 'two' });
    await runTurn(ctx, 'second');

    // The arm does not advance between requests: stable again.
    ctx.mockNextResponse({ type: 'text', text: 'three' });
    await runTurn(ctx, 'third');

    const requests = recordsOf(persistence, 'llm.request');
    expect(requests).toHaveLength(3);
    expect(requests[0]!.prefixDriftReasons).toBeUndefined();
    expect(requests[1]!.prefixDriftReasons).toContain('graduated_rewrite');
    expect(requests[2]!.prefixDriftReasons).toBeUndefined();
  });
});

describe('CLOUD_CODE_NOW fixed at the first render', () => {
  it('re-renders byte-identical prompts across refreshes', async () => {
    const ctx = testAgent();
    ctx.configure();
    const profile = DEFAULT_AGENT_PROFILES['agent']!;

    ctx.agent.useProfile(profile);
    const first = ctx.agent.config.systemPrompt;
    expect(first).toMatch(/The current date and time in ISO format is `[^`]+`/);

    // Distinct wall-clock instants: a render that took a fresh timestamp
    // would move the prompt bytes.
    await new Promise((resolve) => setTimeout(resolve, 5));
    ctx.agent.useProfile(profile);
    expect(ctx.agent.config.systemPrompt).toBe(first);
  });

  it('latches the session timestamp from a persisted prompt landing in config state', () => {
    const ctx = testAgent();
    ctx.configure();
    const profile = DEFAULT_AGENT_PROFILES['agent']!;

    // A prompt persisted by an earlier session (its CLOUD_CODE_NOW long past).
    const persisted = profile.systemPrompt({
      osEnv: ctx.agent.kaos.osEnv,
      cwd: ctx.agent.config.cwd,
      now: '2020-01-01T00:00:00.000Z',
    });
    ctx.agent.config.update({ systemPrompt: persisted });

    // Re-render (post-resume refresh): the restored timestamp wins, so the
    // prompt is byte-identical to the persisted one.
    ctx.agent.useProfile(profile);
    expect(ctx.agent.config.systemPrompt).toBe(persisted);
    expect(ctx.agent.config.systemPrompt).toContain('2020-01-01T00:00:00.000Z');
  });

  it('keeps the system prompt hash stable across resume', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence });
    ctx.configure();
    const profile = DEFAULT_AGENT_PROFILES['agent']!;
    ctx.agent.useProfile(profile);
    const promptBefore = ctx.agent.config.systemPrompt;

    ctx.mockNextResponse({ type: 'text', text: 'one' });
    await runTurn(ctx, 'first');

    const resumedPersistence = new InMemoryAgentRecordPersistence(
      structuredClone(persistence.records),
    );
    const resumed = testAgent({ persistence: resumedPersistence });
    await resumed.agent.resume();
    // The session re-activates the profile after restore; the re-render must
    // reproduce the persisted prompt byte-for-byte (CLOUD_CODE_NOW restored).
    resumed.agent.useProfile(profile);
    expect(resumed.agent.config.systemPrompt).toBe(promptBefore);

    resumed.mockNextResponse({ type: 'text', text: 'two' });
    await runTurn(resumed, 'second');

    const requestsBefore = recordsOf(persistence, 'llm.request');
    const requestsAfter = recordsOf(resumedPersistence, 'llm.request');
    expect(requestsAfter.at(-1)!.systemPromptHash).toBe(requestsBefore.at(-1)!.systemPromptHash);
    expect(requestsAfter.at(-1)!.prefixDriftReasons).toBeUndefined();
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});
