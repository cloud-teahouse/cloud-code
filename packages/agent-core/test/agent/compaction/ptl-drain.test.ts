import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { APIContextOverflowError, type Message } from '@cloud-code/kosong';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentOptions } from '../../../src/agent';
import { estimateTokensForMessages } from '../../../src/utils/tokens';
import type { TestAgentContext } from '../harness/agent';
import { testAgent } from '../harness/agent';

type GenerateFn = NonNullable<AgentOptions['generate']>;

const PROVIDER = { type: 'kimi', apiKey: 'test-key', model: 'kimi-code' } as const;
const CAPS = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;

const CLEARED_MARKER = '[Old tool result content cleared]';

const SESSION_DIRS: string[] = [];

function sessionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ptl-drain-'));
  SESSION_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  while (SESSION_DIRS.length > 0) {
    rmSync(SESSION_DIRS.pop()!, { recursive: true, force: true });
  }
});

function textResult(text: string): Awaited<ReturnType<GenerateFn>> {
  return {
    id: 'mock-ptl-drain',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      toolCalls: [],
    },
    usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
    finishReason: 'completed',
    rawFinishReason: 'stop',
    traceId: null,
  };
}

function messageText(message: Message | undefined): string {
  return message?.content.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? '';
}

function countEvents(events: ReturnType<TestAgentContext['newEvents']>, type: string): number {
  return events.filter((event) => {
    if (typeof event !== 'object' || event === null) return false;
    return (event as { readonly event?: unknown }).event === type;
  }).length;
}

/** Append `count` plain user/assistant rounds of (nearly) equal token size. */
function appendPlainRounds(ctx: TestAgentContext, count: number): void {
  for (let i = 0; i < count; i++) {
    ctx.appendExchange(
      i + 1,
      `user ${String(i)} ` + 'u'.repeat(400),
      `assistant ${String(i)} ` + 'a'.repeat(400),
      10,
    );
  }
}

describe('PTL drain chain (TurnFlow)', () => {
  it('L0: force-arms the cheap layers and recovers without any LLM compaction call', async () => {
    let callCount = 0;
    const inputs: string[][] = [];
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      callCount += 1;
      inputs.push(history.map((message) => `${message.role}: ${messageText(message)}`));
      if (callCount === 1) {
        throw new APIContextOverflowError(400, 'prompt is too long', 'req-ptl-l0');
      }
      return textResult('Recovered at L0.');
    };
    const ctx = testAgent({
      homedir: sessionDir(),
      generate,
      graduatedCompaction: {
        toolResultBudget: {
          maxBytes: 1_000,
          keepRecentMessages: 4,
          previewHeadChars: 100,
          previewTailChars: 100,
        },
        pinpointClear: { keepRecentMessages: 4, minContentTokens: 50 },
      },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    for (let i = 0; i < 8; i++) {
      ctx.appendToolExchange({ key: `k${String(i)}`, resultText: `output-${String(i)}-` + 'x'.repeat(8_000) });
    }

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });
    const events = await ctx.untilTurnEnd();

    // PTL → L0 armed the cheap layers → the very next attempt fit: no
    // summarizer call, no compaction at all.
    expect(callCount).toBe(2);
    expect(countEvents(events, 'compaction.started')).toBe(0);
    expect(ctx.agent.graduatedCompaction.stats.toolResultBudget.applications).toBe(1);
    expect(ctx.agent.graduatedCompaction.stats.pinpointClear.applications).toBe(1);
    // The retried request carried the rewritten projection.
    const retried = inputs[1]!.join('\n');
    expect(retried).toContain(CLEARED_MARKER);
    expect(retried).not.toContain('output-0-');
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
    await ctx.expectResumeMatches();
  });

  it('L1: drains leading API rounds sized to the provider gap and recovers without compaction', async () => {
    let callCount = 0;
    const inputs: string[][] = [];
    // Computed after the history is built, read by the generate closure when
    // the first request runs (see below for the sizing).
    let gap = 0;
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      callCount += 1;
      inputs.push(history.map((message) => `${message.role}: ${messageText(message)}`));
      if (callCount === 1) {
        throw new APIContextOverflowError(
          400,
          'prompt is too long',
          'req-ptl-l1',
          null,
          null,
          100_000 + Math.ceil(gap),
          100_000,
        );
      }
      return textResult('Recovered at L1.');
    };
    const ctx = testAgent({
      generate,
      graduatedCompaction: { ptlDrain: { keepRecentMessages: 4 } },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    appendPlainRounds(ctx, 10);
    const roundTokens = estimateTokensForMessages(ctx.agent.context.history.slice(0, 2));
    // Any gap whose ×1.1 target lands strictly between one and two rounds
    // drains exactly two; 1.5 stays clear of float rounding at the boundary.
    gap = roundTokens * 1.5;

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'drain me' }] });
    const events = await ctx.untilTurnEnd();

    expect(callCount).toBe(2);
    expect(countEvents(events, 'compaction.started')).toBe(0);
    expect(ctx.agent.graduatedCompaction.stats.ptlDrain).toMatchObject({
      applications: 1,
      droppedRounds: 2,
    });
    // The retried request starts at round 2 — rounds 0-1 were drained.
    expect(inputs[1]![0]).toMatch(/^user: user 2 /);
    expect(inputs[1]!.some((line) => line.startsWith('user: user 0 '))).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
    await ctx.expectResumeMatches();
  });

  it('L2: escalates to full compaction when the drain cannot cover the gap', async () => {
    let callCount = 0;
    const inputs: string[][] = [];
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      callCount += 1;
      inputs.push(history.map((message) => `${message.role}: ${messageText(message)}`));
      if (callCount === 1) {
        // A gap no head-drop can cover: draining everything droppable still
        // falls short, so L1 gives up without touching the projection.
        throw new APIContextOverflowError(
          400,
          'prompt is too long',
          'req-ptl-l2',
          null,
          null,
          1_000_000,
          1_000,
        );
      }
      if (callCount === 2) {
        return textResult('Escalated summary.');
      }
      return textResult('Recovered at L2.');
    };
    const ctx = testAgent({
      generate,
      graduatedCompaction: { ptlDrain: { keepRecentMessages: 4 } },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    appendPlainRounds(ctx, 10);

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'compact me' }] });
    const events = await ctx.untilTurnEnd();

    expect(callCount).toBe(3);
    expect(countEvents(events, 'compaction.started')).toBe(1);
    // L1 gave up cleanly: no drain was armed, and the summarizer still saw
    // the full (undrained) history.
    expect(ctx.agent.graduatedCompaction.armedDrainCutoff).toBe(0);
    expect(inputs[1]![0]).toMatch(/^user: user 0 /);
    expect(inputs[2]!.join('\n')).toContain('Escalated summary.');
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
    await ctx.expectResumeMatches();
  });

  it('goes straight to full compaction when ptlDrain is disabled', async () => {
    let callCount = 0;
    const generate: GenerateFn = async (_provider, _system, _tools, _history) => {
      callCount += 1;
      if (callCount === 1) {
        throw new APIContextOverflowError(400, 'prompt is too long', 'req-ptl-off');
      }
      if (callCount === 2) {
        return textResult('Disabled-chain summary.');
      }
      return textResult('Recovered with the chain disabled.');
    };
    const ctx = testAgent({
      generate,
      graduatedCompaction: { ptlDrain: { enabled: false, keepRecentMessages: 4 } },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    appendPlainRounds(ctx, 10);

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'compact me' }] });
    const events = await ctx.untilTurnEnd();

    // Same shape as the pre-drain-chain behavior: overflow → compact → retry.
    expect(callCount).toBe(3);
    expect(countEvents(events, 'compaction.started')).toBe(1);
    expect(ctx.agent.graduatedCompaction.stats.toolResultBudget.applications).toBe(0);
    expect(ctx.agent.graduatedCompaction.armedDrainCutoff).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
    await ctx.expectResumeMatches();
  });
});
