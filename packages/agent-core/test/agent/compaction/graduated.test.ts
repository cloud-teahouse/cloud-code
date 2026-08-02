import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { Message } from '@cloud-code/kosong';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';

import type { CompactionStrategy, GraduatedLayerApplyRecord } from '../../../src/agent/compaction';
import { InMemoryAgentRecordPersistence } from '../../../src/agent/records';
import { estimateTokensForMessages } from '../../../src/utils/tokens';
import { testAgent, type TestAgentContext } from '../harness/agent';

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

/** Full-compaction trigger used by these tests: flat token threshold. */
function fixedStrategy(threshold: number): CompactionStrategy {
  return {
    shouldCompact: (usedSize) => usedSize >= threshold,
    shouldBlock: (usedSize) => usedSize >= threshold,
    checkAfterStep: false,
    maxCompactionPerTurn: Infinity,
    maxOverflowCompactionAttempts: 3,
  };
}

const SESSION_DIRS: string[] = [];

function sessionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'graduated-compaction-'));
  SESSION_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  while (SESSION_DIRS.length > 0) {
    rmSync(SESSION_DIRS.pop()!, { recursive: true, force: true });
  }
});

function messageText(message: Message | undefined): string {
  return message?.content.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? '';
}

describe('GraduatedCompaction', () => {
  it('arms the tool-result budget layer and defers full compaction while effective tokens stay under the trigger', async () => {
    const dir = sessionDir();
    const ctx = testAgent({
      homedir: dir,
      compactionStrategy: fixedStrategy(105_000),
      graduatedCompaction: {
        toolResultBudget: {
          triggerRatio: 0.4,
          maxBytes: 1_000,
          keepRecentMessages: 4,
          previewHeadChars: 100,
          previewTailChars: 100,
        },
        pinpointClear: { triggerRatio: 0.45 },
      },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });

    const bigOutputs: string[] = [];
    for (const key of ['one', 'two', 'three', 'four', 'five', 'six']) {
      const output = `output-${key}-` + 'x'.repeat(8_000);
      bigOutputs.push(output);
      ctx.appendToolExchange({ key, resultText: output });
    }
    ctx.agent.context.updateTokenCount(110_000);
    // Raw count is over the full trigger: without the cheap layers, the LLM
    // summary would fire right now.
    expect(ctx.agent.fullCompaction.shouldAutoCompact(110_000)).toBe(true);

    await ctx.agent.graduatedCompaction.beforeStep(new AbortController().signal);

    // The budget layer armed on the four oldest results; the recent tail and
    // the pinpoint/full layers were not needed.
    expect(ctx.agent.graduatedCompaction.stats.toolResultBudget.applications).toBe(1);
    expect(ctx.agent.graduatedCompaction.stats.toolResultBudget.replacedResults).toBe(4);
    expect(ctx.agent.graduatedCompaction.stats.pinpointClear.applications).toBe(0);
    expect(ctx.llmCalls).toHaveLength(0);

    // Old results are replaced by a preview + path; the full text is on disk.
    const projected = ctx.agent.context.messages;
    const firstOld = messageText(projected[2]);
    expect(firstOld).toContain('Tool output exceeded the size limit');
    expect(firstOld).toContain('output_path:');
    const outputPath = /^output_path: (.+)$/m.exec(firstOld)?.[1];
    expect(outputPath).toBeTruthy();
    expect(readFileSync(outputPath!, 'utf8')).toBe(bigOutputs[0]!);
    // Recent results (last 4 history messages) stay verbatim.
    expect(messageText(projected[17])).toBe(bigOutputs[5]!);
    // User messages are untouched by the layer.
    expect(messageText(projected[0])).toBe('lookup something');

    // Every persisted file carries the tool call id and the original content.
    const files = readdirSync(join(dir, 'tool-results'));
    expect(files).toHaveLength(4);
    for (const file of files) {
      expect(file).toContain('call_lookup');
      expect(bigOutputs).toContain(readFileSync(join(dir, 'tool-results', file), 'utf8'));
    }
  });

  it('does not subtract realized savings twice when the covered count is provider-reported', async () => {
    const dir = sessionDir();
    const ctx = testAgent({
      homedir: dir,
      graduatedCompaction: {
        toolResultBudget: {
          triggerRatio: 0.4,
          maxBytes: 1_000,
          keepRecentMessages: 4,
          previewHeadChars: 100,
          previewTailChars: 100,
        },
      },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    for (const key of ['one', 'two', 'three', 'four', 'five', 'six']) {
      ctx.appendToolExchange({ key, resultText: `output-${key}-` + 'x'.repeat(8_000) });
    }
    ctx.agent.context.updateTokenCount(110_000);
    await ctx.agent.graduatedCompaction.beforeStep(new AbortController().signal);
    expect(ctx.agent.graduatedCompaction.stats.toolResultBudget.replacedResults).toBe(4);

    // Estimate-based covered count: the effective count is raw minus all
    // armed savings (the baseline is still zero).
    const rawArmed = ctx.agent.context.tokenCountWithPending;
    const savings = rawArmed - ctx.agent.graduatedCompaction.effectiveTokenCount();
    expect(savings).toBeGreaterThan(0);

    // The provider then reports usage for a request built from the rewritten
    // projection: that number is already net of the armed savings...
    ctx.appendExchange(7, 'next question', 'next answer', 50_000);
    expect(ctx.agent.context.tokenCountWithPending).toBe(50_000);

    // ...so the effective count must stay at the provider number instead of
    // dropping a second time by the same savings.
    expect(ctx.agent.graduatedCompaction.effectiveTokenCount()).toBe(50_000);
  });

  it('escalates layer by layer and runs the LLM summary last when effective tokens still exceed the trigger', async () => {
    const dir = sessionDir();
    const ctx = testAgent({
      homedir: dir,
      compactionStrategy: fixedStrategy(100_000),
      graduatedCompaction: {
        toolResultBudget: {
          triggerRatio: 0.4,
          maxBytes: 1_000,
          keepRecentMessages: 4,
          previewHeadChars: 100,
          previewTailChars: 100,
        },
        pinpointClear: { triggerRatio: 0.4, keepRecentMessages: 4, minContentTokens: 50 },
      },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });

    for (const key of ['one', 'two', 'three', 'four', 'five', 'six']) {
      ctx.appendToolExchange({ key, resultText: `output-${key}-` + 'x'.repeat(8_000) });
    }
    ctx.agent.context.updateTokenCount(110_000);
    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });

    await ctx.agent.graduatedCompaction.beforeStep(new AbortController().signal);

    // Both cheap layers armed (in order) before the LLM summary ran.
    expect(ctx.agent.graduatedCompaction.stats.toolResultBudget.applications).toBe(1);
    expect(ctx.agent.graduatedCompaction.stats.pinpointClear.applications).toBe(1);

    // The summarizer request was built AFTER the cheap rewrites: old results
    // reach the LLM as cleared markers, not as raw output.
    expect(ctx.llmCalls).toHaveLength(1);
    const summarizerHistory = ctx.llmCalls[0]!.history.map(messageText).join('\n');
    expect(summarizerHistory).toContain(CLEARED_MARKER);
    expect(summarizerHistory).not.toContain('output-one-');
    // The full summary replaced the history afterwards.
    expect(
      ctx.agent.context.history.some((message) => message.origin?.kind === 'compaction_summary'),
    ).toBe(true);
  });

  it('pinpoint clear keeps tool_call/tool_result pairing intact and touches neither user messages nor the recent tail', () => {
    const ctx = testAgent({
      graduatedCompaction: { pinpointClear: { minContentTokens: 1 } },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    for (const key of ['one', 'two', 'three', 'four', 'five', 'six']) {
      ctx.appendToolExchange({ key, resultText: `result-${key}` });
    }

    ctx.agent.graduatedCompaction.restoreLayerApply({ layer: 'pinpoint_clear', cutoff: 14 });
    const projected = ctx.agent.context.messages;

    // Pairing integrity: every tool result answers an existing assistant call
    // (no orphans), and every call is answered exactly once.
    const callIds = new Set<string>();
    for (const message of projected) {
      if (message.role !== 'assistant') continue;
      for (const call of message.toolCalls) callIds.add(call.id);
    }
    const answered = new Set<string>();
    for (const message of projected) {
      if (message.role !== 'tool' || message.toolCallId === undefined) continue;
      expect(callIds.has(message.toolCallId)).toBe(true);
      expect(answered.has(message.toolCallId)).toBe(false);
      answered.add(message.toolCallId);
    }
    expect(answered).toEqual(callIds);

    // The four oldest results are cleared; the two newest stay verbatim.
    for (const index of [2, 5, 8, 11]) {
      expect(projected[index]?.role).toBe('tool');
      expect(messageText(projected[index])).toBe(CLEARED_MARKER);
    }
    expect(messageText(projected[14])).toBe('result-five');
    expect(messageText(projected[17])).toBe('result-six');
    // User messages are never rewritten.
    for (const index of [0, 3, 6, 9, 12, 15]) {
      expect(messageText(projected[index])).toBe('lookup something');
    }
    // The stored history still holds the original facts.
    const storedToolTexts = ctx.agent.context.history
      .filter((message) => message.role === 'tool')
      .map((message) => messageText(message));
    expect(storedToolTexts).toContain('result-one');
  });

  it('never persists media-bearing tool results in the budget layer', async () => {
    const dir = sessionDir();
    const ctx = testAgent({
      homedir: dir,
      graduatedCompaction: { toolResultBudget: { maxBytes: 10, keepRecentMessages: 0 } },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });

    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'look at this' }]);
    const stepUuid = 'media-step';
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', uuid: stepUuid, turnId: '', step: 1 },
    });
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        uuid: 'media-call',
        turnId: '',
        step: 1,
        stepUuid,
        toolCallId: 'call_media',
        name: 'ReadMediaFile',
        args: { path: '/tmp/x.png' },
      },
    });
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'step.end',
        uuid: stepUuid,
        turnId: '',
        step: 1,
        finishReason: 'tool_use',
      },
    });
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'media-call',
        toolCallId: 'call_media',
        result: {
          output: [
            { type: 'text', text: 'x'.repeat(5_000) },
            { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      },
    });

    ctx.agent.graduatedCompaction.restoreLayerApply({ layer: 'tool_result_budget', cutoff: 4 });

    const projected = ctx.agent.context.messages;
    const toolMessage = projected.find((message) => message.role === 'tool');
    expect(toolMessage?.content.some((part) => part.type === 'image_url')).toBe(true);
    expect(
      toolMessage?.content.some((part) => part.type === 'text' && part.text.includes('output_path')),
    ).toBe(false);
    expect(existsSync(join(dir, 'tool-results'))).toBe(false);
  });

  it('keeps the original content when persisting fails and still escalates to full compaction', async () => {
    const dir = sessionDir();
    // Make `<sessionDir>/tool-results` a regular file so every persist write
    // underneath it fails with ENOTDIR.
    writeFileSync(join(dir, 'tool-results'), 'not a directory');
    const ctx = testAgent({
      homedir: dir,
      compactionStrategy: fixedStrategy(100_000),
      graduatedCompaction: {
        toolResultBudget: { triggerRatio: 0.4, maxBytes: 1_000, keepRecentMessages: 4 },
        pinpointClear: { enabled: false },
      },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    const bigOutput = 'y'.repeat(8_000);
    for (const key of ['one', 'two', 'three', 'four', 'five', 'six']) {
      ctx.appendToolExchange({ key, resultText: bigOutput });
    }
    ctx.agent.context.updateTokenCount(110_000);
    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });

    await ctx.agent.graduatedCompaction.beforeStep(new AbortController().signal);

    // The failed layer left no replacements behind and did not block
    // escalation: the summarizer request carries the ORIGINAL text, not a
    // preview pointing at a missing file.
    expect(ctx.llmCalls).toHaveLength(1);
    const summarizerHistory = ctx.llmCalls[0]!.history.map(messageText).join('\n');
    expect(summarizerHistory).toContain(bigOutput);
    expect(summarizerHistory).not.toContain('output_path:');
  });

  it('replays armed layers from records on resume', async () => {
    const dir = sessionDir();
    const persistence = new InMemoryAgentRecordPersistence();
    const options = {
      homedir: dir,
      compactionStrategy: fixedStrategy(105_000),
      graduatedCompaction: {
        toolResultBudget: { triggerRatio: 0.4, maxBytes: 1_000, keepRecentMessages: 4 },
        pinpointClear: { triggerRatio: 0.45, keepRecentMessages: 4, minContentTokens: 1 },
      },
    } as const;
    const ctx = testAgent({ ...options, persistence });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    for (const key of ['one', 'two', 'three', 'four', 'five', 'six']) {
      ctx.appendToolExchange({ key, resultText: `result-${key}-` + 'x'.repeat(8_000) });
    }
    ctx.agent.context.updateTokenCount(110_000);
    await ctx.agent.graduatedCompaction.beforeStep(new AbortController().signal);
    expect(ctx.agent.graduatedCompaction.stats.toolResultBudget.applications).toBe(1);

    const resumed = testAgent({
      ...options,
      persistence: new InMemoryAgentRecordPersistence(persistence.records),
    });
    await resumed.agent.resume();

    expect(resumed.agent.graduatedCompaction.stats.toolResultBudget.applications).toBe(0);
    const projected = resumed.agent.context.messages;
    expect(messageText(projected[2])).toContain('output_path:');
    expect(messageText(projected[17])).toContain('result-six-');
  });

  it('returns the input projection unchanged while no layer is armed', () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.appendToolExchange({ key: 'one' });
    const history = ctx.agent.context.history;
    expect(ctx.agent.graduatedCompaction.applyToProjection(history)).toBe(history);
  });
});

describe('GraduatedCompaction keep policy + snip hints', () => {
  /** Tool exchange with an explicit tool name and error flag (the harness
   *  helper hardcodes a successful `Lookup`). */
  function appendNamedToolExchange(
    ctx: TestAgentContext,
    options: { key: string; toolName?: string; resultText: string; isError?: boolean },
  ): void {
    const stepUuid = `named-tool-step-${options.key}`;
    ctx.agent.context.appendUserMessage([{ type: 'text', text: `run ${options.key}` }]);
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', uuid: stepUuid, turnId: '', step: 2 },
    });
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        uuid: `named-tool-call-${options.key}`,
        turnId: '',
        step: 2,
        stepUuid,
        toolCallId: `call_${options.key}`,
        name: options.toolName ?? 'Lookup',
        args: {},
      },
    });
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: { type: 'step.end', uuid: stepUuid, turnId: '', step: 2, finishReason: 'tool_use' },
    });
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: `named-tool-call-${options.key}`,
        toolCallId: `call_${options.key}`,
        result: { output: options.resultText, ...(options.isError === true ? { isError: true } : {}) },
      },
    });
  }

  it('keeps error results verbatim in the budget layer while replacing healthy ones', async () => {
    const dir = sessionDir();
    const ctx = testAgent({
      homedir: dir,
      compactionStrategy: fixedStrategy(Infinity),
      graduatedCompaction: {
        toolResultBudget: { triggerRatio: 0.4, maxBytes: 1_000, keepRecentMessages: 0 },
        pinpointClear: { enabled: false },
      },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    const errorText = `error: boom\n${'e'.repeat(8_000)}`;
    appendNamedToolExchange(ctx, { key: 'bad', resultText: errorText, isError: true });
    appendNamedToolExchange(ctx, { key: 'good', resultText: 'ok-' + 'x'.repeat(8_000) });
    ctx.agent.context.updateTokenCount(110_000);

    await ctx.agent.graduatedCompaction.beforeStep(new AbortController().signal);

    const projected = ctx.agent.context.messages;
    const errorResult = projected.find((message) => message.toolCallId === 'call_bad');
    const goodResult = projected.find((message) => message.toolCallId === 'call_good');
    // The error result is never persisted/previewed — its text reaches the
    // projection verbatim (under the usual model-facing error status line).
    expect(messageText(errorResult)).toContain(errorText);
    expect(messageText(errorResult)).not.toContain('output_path:');
    expect(messageText(goodResult)).toContain('output_path:');
    expect(ctx.agent.graduatedCompaction.stats.toolResultBudget.replacedResults).toBe(1);
    // Nothing was persisted for the error call.
    const files = readdirSync(join(dir, 'tool-results'));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('call_good');
  });

  it('never pinpoint-clears error results', async () => {
    const ctx = testAgent({
      compactionStrategy: fixedStrategy(Infinity),
      graduatedCompaction: {
        toolResultBudget: { enabled: false },
        pinpointClear: { triggerRatio: 0.4, keepRecentMessages: 0, minContentTokens: 1 },
      },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    const errorText = 'error: failure facts worth keeping';
    appendNamedToolExchange(ctx, { key: 'bad', resultText: errorText, isError: true });
    appendNamedToolExchange(ctx, { key: 'good', resultText: 'healthy result text' });
    ctx.agent.context.updateTokenCount(110_000);

    await ctx.agent.graduatedCompaction.beforeStep(new AbortController().signal);

    const projected = ctx.agent.context.messages;
    // Verbatim under the model-facing error status line — never the marker.
    const projectedError = messageText(projected.find((message) => message.toolCallId === 'call_bad'));
    expect(projectedError).toContain(errorText);
    expect(projectedError).not.toBe(CLEARED_MARKER);
    expect(messageText(projected.find((message) => message.toolCallId === 'call_good'))).toBe(
      CLEARED_MARKER,
    );
    // Only the healthy result joined the eligible set.
    expect(ctx.agent.graduatedCompaction.stats.pinpointClear.replacedResults).toBe(1);
  });

  it('applies a tool snipHint line geometry to the budget-layer preview', async () => {
    const dir = sessionDir();
    const ctx = testAgent({
      homedir: dir,
      compactionStrategy: fixedStrategy(Infinity),
      graduatedCompaction: {
        toolResultBudget: {
          triggerRatio: 0.4,
          maxBytes: 1_000,
          keepRecentMessages: 0,
          previewHeadChars: 100,
          previewTailChars: 100,
        },
        pinpointClear: { enabled: false },
      },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    // 200 numbered lines: the side-effect tier (Bash) keeps 40 head + 40 tail
    // lines, while a tool without a hint keeps the 100-char window.
    const lines = Array.from({ length: 200 }, (_, i) => `bash-line-${String(i).padStart(3, '0')}`);
    const bashText = lines.join('\n');
    appendNamedToolExchange(ctx, { key: 'bash', toolName: 'Bash', resultText: bashText });
    appendNamedToolExchange(ctx, { key: 'plain', resultText: 'L'.repeat(8_000) });
    ctx.agent.context.updateTokenCount(110_000);

    await ctx.agent.graduatedCompaction.beforeStep(new AbortController().signal);

    const projected = ctx.agent.context.messages;
    const bashPreview = messageText(projected.find((message) => message.toolCallId === 'call_bash'));
    // Archive-path marker semantics are unchanged by the line geometry.
    expect(bashPreview).toContain('output_path:');
    expect(bashPreview).toContain('[preview head]');
    expect(bashPreview).toContain('[preview tail]');
    expect(bashPreview).toContain('bash-line-039');
    expect(bashPreview).not.toContain('bash-line-040');
    expect(bashPreview).toContain('bash-line-160');
    expect(bashPreview).not.toContain('bash-line-159');
    // The persisted file keeps the full facts.
    const outputPath = /^output_path: (.+)$/m.exec(bashPreview)?.[1];
    expect(readFileSync(outputPath!, 'utf8')).toBe(bashText);

    // No hint declared for the unknown tool: the fixed character window.
    const plainPreview = messageText(
      projected.find((message) => message.toolCallId === 'call_plain'),
    );
    const headSection = /\[preview head\]\n([\s\S]*?)\n\n\[preview tail\]/.exec(plainPreview)?.[1];
    expect(headSection).toBe('L'.repeat(100));
  });
});

describe('GraduatedCompaction PTL drain chain', () => {
  /** Append `count` plain user/assistant rounds of (nearly) equal token size. */
  function appendPlainRounds(ctx: TestAgentContext, count: number, size = 400): void {
    for (let i = 0; i < count; i++) {
      ctx.appendExchange(i + 1, `user-r${String(i)}-` + 'u'.repeat(size), `assistant-r${String(i)}-` + 'a'.repeat(size), 10);
    }
  }

  it('armForOverflow arms both cheap layers ignoring their trigger ratios', async () => {
    const dir = sessionDir();
    const ctx = testAgent({
      homedir: dir,
      compactionStrategy: fixedStrategy(Infinity),
      graduatedCompaction: {
        toolResultBudget: {
          triggerRatio: 0.99,
          maxBytes: 1_000,
          keepRecentMessages: 4,
          previewHeadChars: 100,
          previewTailChars: 100,
        },
        pinpointClear: { triggerRatio: 0.99, keepRecentMessages: 4, minContentTokens: 1 },
      },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    for (const key of ['one', 'two', 'three', 'four', 'five', 'six']) {
      ctx.appendToolExchange({ key, resultText: `output-${key}-` + 'x'.repeat(8_000) });
    }
    // Far below both trigger ratios: the ratio-driven step boundary must not arm.
    ctx.agent.context.updateTokenCount(10_000);
    await ctx.agent.graduatedCompaction.beforeStep(new AbortController().signal);
    expect(ctx.agent.graduatedCompaction.stats.toolResultBudget.applications).toBe(0);
    expect(ctx.agent.graduatedCompaction.stats.pinpointClear.applications).toBe(0);

    await ctx.agent.graduatedCompaction.armForOverflow();

    // Both layers armed despite the low token count; the recent tail (4
    // messages) stayed protected.
    expect(ctx.agent.graduatedCompaction.stats.toolResultBudget.applications).toBe(1);
    expect(ctx.agent.graduatedCompaction.stats.toolResultBudget.replacedResults).toBe(4);
    expect(ctx.agent.graduatedCompaction.stats.pinpointClear.applications).toBe(1);
    const projected = ctx.agent.context.messages;
    expect(messageText(projected[2])).toBe(CLEARED_MARKER);
    expect(messageText(projected[17])).toContain('output-six-');
    expect(ctx.llmCalls).toHaveLength(0);
  });

  it('ptl_drain drops leading whole API rounds sized to the gap (round-aligned cut)', () => {
    const ctx = testAgent({
      graduatedCompaction: { ptlDrain: { keepRecentMessages: 2 } },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    appendPlainRounds(ctx, 8);
    const history = ctx.agent.context.history;
    const roundTokens = estimateTokensForMessages(history.slice(0, 2));
    // Target exactly three rounds AFTER the 1.1 safety factor.
    const gap = (roundTokens * 3) / 1.1;

    const armed = ctx.agent.graduatedCompaction.armPtlDrain(gap);

    expect(armed).toBe(true);
    expect(ctx.agent.graduatedCompaction.armedDrainCutoff).toBe(6);
    expect(ctx.agent.graduatedCompaction.stats.ptlDrain).toMatchObject({
      applications: 1,
      droppedRounds: 3,
      droppedTokens: roundTokens * 3,
    });
    // The cut lands on a round boundary: the projection starts at round 3's
    // user message; the stored history keeps the full facts.
    const projected = ctx.agent.context.messages;
    expect(messageText(projected[0])).toContain('user-r3-');
    expect(projected).toHaveLength(10);
    expect(ctx.agent.context.history).toHaveLength(16);
  });

  it('ptl_drain never eats into the keepRecentMessages tail or the most recent round', () => {
    const ctx = testAgent({
      graduatedCompaction: { ptlDrain: { keepRecentMessages: 6 } },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    appendPlainRounds(ctx, 8);
    const history = ctx.agent.context.history;
    const roundTokens = estimateTokensForMessages(history.slice(0, 2));

    // Exactly the droppable range: rounds 0-4 end at index 10, leaving the
    // last 6 messages (3 rounds) untouched.
    const armed = ctx.agent.graduatedCompaction.armPtlDrain((roundTokens * 5) / 1.1);
    expect(armed).toBe(true);
    expect(ctx.agent.graduatedCompaction.armedDrainCutoff).toBe(10);

    // A second drain against the shrunken pool cannot cross the tail: rounds
    // 5-6 sit inside keepRecentMessages, round 7 is the most recent round.
    const again = ctx.agent.graduatedCompaction.armPtlDrain(roundTokens);
    expect(again).toBe(false);
    expect(ctx.agent.graduatedCompaction.armedDrainCutoff).toBe(10);
    expect(ctx.agent.graduatedCompaction.stats.ptlDrain.applications).toBe(1);
  });

  it('ptl_drain falls back to 20% of the request estimate when the gap is unknown', () => {
    const ctx = testAgent({
      graduatedCompaction: { ptlDrain: { keepRecentMessages: 2 } },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    appendPlainRounds(ctx, 8);
    const history = ctx.agent.context.history;
    const roundTokens = estimateTokensForMessages(history.slice(0, 2));
    const expectedTarget = ctx.agent.fullCompaction.estimateCurrentRequestTokens() * 0.2;
    const expectedRounds = Math.ceil(expectedTarget / roundTokens);

    const armed = ctx.agent.graduatedCompaction.armPtlDrain(undefined);

    expect(armed).toBe(true);
    expect(ctx.agent.graduatedCompaction.armedDrainCutoff).toBe(expectedRounds * 2);
  });

  it('ptl_drain gives up on a giant single round without changing state', () => {
    const ctx = testAgent({
      graduatedCompaction: { ptlDrain: { keepRecentMessages: 2 } },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    // One giant round: the only round is the most recent one and must survive.
    ctx.appendExchange(1, 'giant user ' + 'u'.repeat(8_000), 'giant assistant ' + 'a'.repeat(8_000), 10);
    expect(ctx.agent.graduatedCompaction.armPtlDrain(100)).toBe(false);

    // Two rounds, but the gap needs more than the first one alone can cover —
    // draining it would eat into the most recent round.
    ctx.appendExchange(2, 'second user', 'second assistant', 10);
    expect(ctx.agent.graduatedCompaction.armPtlDrain(1_000_000)).toBe(false);

    expect(ctx.agent.graduatedCompaction.armedDrainCutoff).toBe(0);
    expect(ctx.agent.graduatedCompaction.stats.ptlDrain).toMatchObject({
      applications: 0,
      droppedRounds: 0,
      droppedTokens: 0,
    });
    expect(ctx.agent.context.messages).toHaveLength(4);
  });

  it('ptl_drain is inert when disabled', () => {
    const ctx = testAgent({
      graduatedCompaction: { ptlDrain: { enabled: false, keepRecentMessages: 2 } },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    appendPlainRounds(ctx, 8);
    expect(ctx.agent.graduatedCompaction.armPtlDrain(10)).toBe(false);
    expect(ctx.agent.graduatedCompaction.armedDrainCutoff).toBe(0);
  });

  it('keeps the projection wire-valid after a mid-exchange drain cut (orphan/leading repairs)', () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    for (const key of ['one', 'two', 'three', 'four']) {
      ctx.appendToolExchange({ key, resultText: `result-${key}` });
    }

    // A restore-time cut inside an exchange (only record restores or shaping
    // edge cases produce one — live arming is round-aligned): the surviving
    // head starts with an orphan tool result whose call was drained.
    ctx.agent.graduatedCompaction.restoreLayerApply({ layer: 'ptl_drain', cutoff: 2 });
    const projected = ctx.agent.context.messages;
    expect(projected[0]?.role).toBe('user');
    expect(projected.some((message) => message.toolCallId === 'call_lookup_one')).toBe(false);

    // A cut at the assistant: the strict projection drops the leading
    // non-user (and the then-orphaned result) — every surviving result still
    // answers a surviving call.
    const fresh = testAgent();
    fresh.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    for (const key of ['one', 'two', 'three', 'four']) {
      fresh.appendToolExchange({ key, resultText: `result-${key}` });
    }
    fresh.agent.graduatedCompaction.restoreLayerApply({ layer: 'ptl_drain', cutoff: 1 });
    const strict = fresh.agent.context.strictMessages;
    expect(strict[0]?.role).toBe('user');
    const callIds = new Set<string>();
    for (const message of strict) {
      if (message.role !== 'assistant') continue;
      for (const call of message.toolCalls) callIds.add(call.id);
    }
    for (const message of strict) {
      if (message.role !== 'tool' || message.toolCallId === undefined) continue;
      expect(callIds.has(message.toolCallId)).toBe(true);
    }
  });

  it('shrinks the drain cutoff on reset like the other layers', () => {
    const ctx = testAgent({
      graduatedCompaction: { ptlDrain: { keepRecentMessages: 0 } },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    appendPlainRounds(ctx, 8);
    ctx.agent.graduatedCompaction.restoreLayerApply({ layer: 'ptl_drain', cutoff: 6 });
    expect(ctx.agent.graduatedCompaction.armedDrainCutoff).toBe(6);
    expect(messageText(ctx.agent.context.messages[0])).toContain('user-r3-');

    // Undo-style shrink: the cutoff follows the surviving history length.
    ctx.agent.graduatedCompaction.reset(2);
    expect(ctx.agent.graduatedCompaction.armedDrainCutoff).toBe(2);
    expect(messageText(ctx.agent.context.messages[0])).toContain('user-r1-');

    // Compaction-style clear.
    ctx.agent.graduatedCompaction.reset();
    expect(ctx.agent.graduatedCompaction.armedDrainCutoff).toBe(0);
    expect(messageText(ctx.agent.context.messages[0])).toContain('user-r0-');
  });

  it('counts drained rounds toward the effective token count so beforeStep does not escalate after a drain', async () => {
    const ctx = testAgent({
      compactionStrategy: fixedStrategy(1_000),
      graduatedCompaction: { ptlDrain: { keepRecentMessages: 2 } },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    appendPlainRounds(ctx, 8, 4_000);
    const history = ctx.agent.context.history;
    const roundTokens = estimateTokensForMessages(history.slice(0, 2));
    // Recorded count over the strategy trigger: without the drain savings,
    // the step boundary would escalate to the LLM summary.
    ctx.agent.context.updateTokenCount(5_000);
    ctx.mockNextResponse({ type: 'text', text: 'Unwanted summary.' });
    expect(ctx.agent.graduatedCompaction.armPtlDrain((roundTokens * 2) / 1.1)).toBe(true);
    const drainCutoff = ctx.agent.graduatedCompaction.armedDrainCutoff;
    expect(drainCutoff).toBeGreaterThan(0);
    // The drain alone must pull the effective count under the trigger.
    expect(5_000 - estimateTokensForMessages(history.slice(0, drainCutoff))).toBeLessThan(1_000);

    await ctx.agent.graduatedCompaction.beforeStep(new AbortController().signal);
    expect(ctx.llmCalls).toHaveLength(0);

    // Sanity: without the drain the same boundary would have compacted.
    const control = testAgent({ compactionStrategy: fixedStrategy(1_000) });
    control.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    appendPlainRounds(control, 8, 4_000);
    control.agent.context.updateTokenCount(5_000);
    control.mockNextResponse({ type: 'text', text: 'Expected summary.' });
    await control.agent.graduatedCompaction.beforeStep(new AbortController().signal);
    expect(control.llmCalls).toHaveLength(1);
  });

  it('restoreLayerApply fails open on unknown layers instead of arming the budget layer', () => {
    const dir = sessionDir();
    const ctx = testAgent({
      homedir: dir,
      graduatedCompaction: { toolResultBudget: { maxBytes: 1 } },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.appendToolExchange({ key: 'one', resultText: 'result-one-' + 'x'.repeat(8_000) });
    const before = ctx.agent.context.messages.map(messageText);

    // A record written by a newer version must not be mistaken for a budget
    // arm — the previous else-branch did exactly that (with a homedir set,
    // the wrongly-armed budget layer would rewrite the projection).
    ctx.agent.graduatedCompaction.restoreLayerApply(
      { layer: 'tool_result_budget_v3', cutoff: 3 } as unknown as GraduatedLayerApplyRecord,
    );

    expect(ctx.agent.context.messages.map(messageText)).toEqual(before);
    expect(ctx.agent.graduatedCompaction.armedDrainCutoff).toBe(0);
    expect(ctx.agent.graduatedCompaction.stats.toolResultBudget.applications).toBe(0);
  });

  it('replays the armed drain from records on resume', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const options = {
      graduatedCompaction: { ptlDrain: { keepRecentMessages: 2 } },
    } as const;
    const ctx = testAgent({ ...options, persistence });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    appendPlainRounds(ctx, 8);
    const history = ctx.agent.context.history;
    const roundTokens = estimateTokensForMessages(history.slice(0, 2));
    expect(ctx.agent.graduatedCompaction.armPtlDrain((roundTokens * 3) / 1.1)).toBe(true);
    expect(ctx.agent.graduatedCompaction.armedDrainCutoff).toBe(6);

    const resumed = testAgent({
      ...options,
      persistence: new InMemoryAgentRecordPersistence(persistence.records),
    });
    await resumed.agent.resume();

    expect(resumed.agent.graduatedCompaction.armedDrainCutoff).toBe(6);
    expect(resumed.agent.context.messages.map(messageText)).toEqual(
      ctx.agent.context.messages.map(messageText),
    );
  });
});
