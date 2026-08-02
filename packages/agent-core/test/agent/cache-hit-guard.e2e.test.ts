import type { ToolCall } from '@cloud-code/kosong';
import { describe, expect, it } from 'vitest';

import type { AgentRecord } from '../../src/agent';
import {
  InMemoryAgentRecordPersistence,
  type AgentRecordOf,
} from '../../src/agent/records';
import { testAgent, type TestAgentContext } from './harness/agent';
import { createMockPrefixCache } from './harness/prefix-cache';

/**
 * Cache hit-rate guard (reasonix `TestReleaseCacheHitGuard` port): run
 * deterministic scenario curves against the mock automatic prefix cache and
 * assert the average hit rate of the last few requests. Where
 * `prefix-stability.test.ts` asserts structural hash equality, this guard
 * prices behavior: a mid-history rewrite that moves the divergence point
 * (graduated arm, projection switch, misplaced injection) shows up here as
 * real cache-creation tokens even when all hashes stay green.
 *
 * The hit rate uses only provider-reported counters —
 * `cache_read / (cache_read + cache_creation)` — the same pair
 * `LlmRequestRecorder.reportUsageSettled` correlates with prefix drift, read
 * back from the durable `usage.record` wire log rather than from the mock.
 *
 * Threshold: 0.85 is the informational bar (reasonix runs strict at 0.90);
 * deliberately not wired to fail CI harder until the curves prove stable.
 */

const GUARD_HIT_RATE = 0.85;
const TAIL_REQUESTS = 3;

/**
 * A system prompt sized like a real one (a few KB of stable guidelines), so
 * the fixed prefix dominates per-turn tail growth the way it does in
 * production, where the prompt and tool table dwarf each turn's increment.
 */
const BIG_SYSTEM_PROMPT = [
  'You are a deterministic test agent.',
  '',
  '## Stable operating guidelines',
  ...Array.from(
    { length: 32 },
    (_, index) =>
      `Guideline ${String(index + 1).padStart(2, '0')}: keep the context append-only; never rewrite earlier messages, tool results, or reasoning blocks mid-history.`,
  ),
].join('\n');

const THINKING_CAPABILITIES = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;

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

/**
 * Provider-reported cache hit rate per settled loop request, in wire order.
 * Turn-scoped records only: compaction summary calls and other session-scoped
 * usages are not part of the scenario curve.
 */
function turnHitRates(persistence: InMemoryAgentRecordPersistence): number[] {
  return recordsOf(persistence, 'usage.record')
    .filter((record) => record.usageScope === 'turn')
    .map((record) => {
      const read = record.usage.inputCacheRead;
      const creation = record.usage.inputCacheCreation;
      const total = read + creation;
      return total === 0 ? 0 : read / total;
    });
}

/** Informational guard: log the full curve, assert the tail average. */
function expectTailHitRate(curve: string, rates: readonly number[]): void {
  expect(rates.length, `${curve}: expected at least ${String(TAIL_REQUESTS)} requests`).toBeGreaterThanOrEqual(
    TAIL_REQUESTS,
  );
  const tail = rates.slice(-TAIL_REQUESTS);
  const average = tail.reduce((sum, rate) => sum + rate, 0) / tail.length;
  console.info(
    `[cache-hit-guard] ${curve}: per-request hit rates = ${rates
      .map((rate) => rate.toFixed(3))
      .join(', ')}; tail-${String(TAIL_REQUESTS)} average = ${average.toFixed(3)}`,
  );
  expect(
    average,
    `${curve}: tail-${String(TAIL_REQUESTS)} average hit rate ${average.toFixed(3)} < ${String(GUARD_HIT_RATE)}`,
  ).toBeGreaterThanOrEqual(GUARD_HIT_RATE);
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

describe('cache hit-rate guard', () => {
  it('curve a: plain multi-turn conversation stays cache-hot', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const cache = createMockPrefixCache();
    const ctx = testAgent({ persistence, wrapGenerate: cache.wrapGenerate });
    ctx.configure();
    ctx.agent.config.update({ systemPrompt: BIG_SYSTEM_PROMPT });

    for (let turn = 1; turn <= 8; turn++) {
      ctx.mockNextResponse({
        type: 'text',
        text: `Answer ${String(turn)}: the cache-friendly approach keeps every earlier message byte-identical.`,
      });
      await runTurn(ctx, `Question ${String(turn)}: how does automatic prefix caching behave?`);
    }

    const rates = turnHitRates(persistence);
    expect(rates).toHaveLength(8);
    // Why 0.85 is a sound lower bound: append-only growth means each request
    // reuses the entire previous body except the closing JSON bytes; only the
    // new user+assistant pair is cache-cold. With a realistic multi-KB stable
    // prefix the reused share sits far above 0.85 after warm-up — production
    // prefixes (system prompt + tool table) are larger still relative to one
    // turn's increment, so anything below 0.85 signals an actual mid-history
    // disturbance, not geometry.
    expectTailHitRate('a/plain-conversation', rates);
  });

  it('curve b: tool-call loop stays cache-hot', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const cache = createMockPrefixCache();
    const ctx = testAgent({ persistence, wrapGenerate: cache.wrapGenerate });
    ctx.configure();
    ctx.agent.config.update({ systemPrompt: BIG_SYSTEM_PROMPT });
    await registerLookup(ctx);

    for (const query of ['moon', 'mars', 'europa', 'titan', 'io']) {
      ctx.mockNextResponse(
        { type: 'text', text: `I will look up ${query}.` },
        lookupCall(`call_${query}`, query),
      );
      await ctx.rpc.prompt({ input: [{ type: 'text', text: `Look up ${query}` }] });
      await ctx.untilToolCall({
        content: `${query} result payload ${'x'.repeat(120)}`,
        output: `${query} result payload ${'x'.repeat(120)}`,
      });
      ctx.mockNextResponse({ type: 'text', text: `The ${query} lookup is complete.` });
      await ctx.untilTurnEnd();
    }

    const rates = turnHitRates(persistence);
    expect(rates).toHaveLength(10);
    // Why 0.85 is a sound lower bound: tool loops are chattier per turn (call
    // step + result + closing step all append), but every byte is still
    // tail-only — the assistant tool-call message and its result never move.
    // The tail-append geometry of curve a applies with a slightly larger
    // per-turn increment, so the same conservative bar holds.
    expectTailHitRate('b/tool-loop', rates);
  });

  it('curve c: thinking keep-all stays cache-hot', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const cache = createMockPrefixCache();
    const ctx = testAgent({ persistence, wrapGenerate: cache.wrapGenerate });
    ctx.configure({ modelCapabilities: THINKING_CAPABILITIES });
    // The mock kimi model declares no concrete efforts, so any requested
    // effort normalizes to 'on' — thinking enabled before the first request.
    ctx.agent.config.update({ systemPrompt: BIG_SYSTEM_PROMPT, thinkingEffort: 'high' });
    expect(ctx.agent.config.thinkingEffort).not.toBe('off');

    for (let turn = 1; turn <= 8; turn++) {
      ctx.mockNextResponse(
        { type: 'think', think: `Reasoning ${String(turn)}: weighing the cached prefix against the new question.` },
        { type: 'text', text: `Answer ${String(turn)}: thinking is preserved, so the prefix stays put.` },
      );
      await runTurn(ctx, `Thinking question ${String(turn)}?`);
    }

    const rates = turnHitRates(persistence);
    expect(rates).toHaveLength(8);
    // Why 0.85 is a sound lower bound: kimi `thinking.keep` resolves to 'all',
    // so reasoning blocks round-trip byte-identically and the history stays
    // append-only exactly like curve a. If thinking were dropped, trimmed, or
    // re-shaped mid-history, this curve would bust on every request — the
    // same bar therefore catches a reasoning round-trip regression.
    expectTailHitRate('c/thinking-keep-all', rates);
  });

  it('curve d: a graduated tool-result-budget arm busts once, then recovers', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const cache = createMockPrefixCache();
    const ctx = testAgent({
      persistence,
      wrapGenerate: cache.wrapGenerate,
      // The budget layer only builds replacements when a session home exists;
      // the restore entry point skips the actual fs writes.
      homedir: '/home/test',
      graduatedCompaction: {
        // maxBytes 1 makes every seeded tool result eligible for rewriting.
        toolResultBudget: { maxBytes: 1, previewHeadChars: 80, previewTailChars: 80 },
        pinpointClear: { enabled: false },
        ptlDrain: { enabled: false },
      },
    });
    ctx.configure({ tools: ['Read'] });
    ctx.agent.config.update({ systemPrompt: BIG_SYSTEM_PROMPT });

    // Seed three tool exchanges (9 history messages; tool results at message
    // indexes 2, 5, 8) before the session's first real request.
    for (const key of ['a', 'b', 'c']) {
      ctx.appendToolExchange({ key, resultText: `${key} lookup result ${'payload '.repeat(48)}` });
    }

    ctx.mockNextResponse({ type: 'text', text: 'first answer' });
    await runTurn(ctx, 'first question');
    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await runTurn(ctx, 'second question');

    // Arm the budget layer over the seeded exchanges: the projection rewrites
    // the three mid-history tool results, so the next request's bytes diverge
    // at the first rewritten result — a one-time bust that hash equality
    // (system/tools unchanged, prefixDriftReasons the only signal) cannot
    // price. The armed cutoff then stays put, so later turns append normally.
    ctx.agent.graduatedCompaction.restoreLayerApply({ layer: 'tool_result_budget', cutoff: 9 });

    ctx.mockNextResponse({ type: 'text', text: 'third answer' });
    await runTurn(ctx, 'third question');
    for (const prompt of ['fourth question', 'fifth question', 'sixth question']) {
      ctx.mockNextResponse({ type: 'text', text: `answer to the ${prompt}` });
      await runTurn(ctx, prompt);
    }

    const rates = turnHitRates(persistence);
    expect(rates).toHaveLength(6);
    // The bust itself: the armed request reuses only the bytes before the
    // first rewritten tool result — far below the steady-state rate of its
    // neighbors. Asserting the dip documents that the scenario actually
    // exercises the rewrite instead of passing vacuously.
    expect(rates[2]).toBeLessThan(0.9);
    // Why 0.85 is a sound lower bound for recovery: an automatic prefix cache
    // re-warms on the busted request itself, so the very next request already
    // reuses the full rewritten body and only pays for its own tail. Three
    // append-only turns after the arm must therefore average ≥0.85; a lower
    // value means the projection kept moving (re-arming every step, unstable
    // replacement text) — the behavioral regression this guard exists for.
    expectTailHitRate('d/graduated-budget-arm', rates);
  });
});
