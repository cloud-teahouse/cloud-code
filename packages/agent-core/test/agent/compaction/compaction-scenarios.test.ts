// Compaction scenario + probe tests.
//
// Two kinds of tests live here:
//   * GUARD tests lock in behavior we rely on (so future refactors can't
//     silently regress it).
//   * PROBE tests exercise the high-risk scenarios surfaced in review and in
//     our own audit, asserting the DESIRED behavior. Where the current
//     implementation does NOT meet that bar, the probe is marked `it.fails`:
//     the suite stays green, but the test documents the exact defect and will
//     start failing (forcing its removal) the day the behavior is fixed.
//
// Compaction is a hot path, so these intentionally drive the real
// Agent/ContextMemory/FullCompaction machinery through the test harness rather
// than mocking it.
import type { ContentPart, Message } from '@cloud-code/kosong';
import { describe, expect, it } from 'vitest';

import type { AgentOptions, AgentRecord } from '../../../src/agent';
import { COMPACTION_ELISION_VARIANT, COMPACTION_SUMMARY_PREFIX } from '../../../src/agent/compaction';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  InMemoryAgentRecordPersistence,
} from '../../../src/agent/records';
import type { ContextMessage } from '../../../src/agent/context';
import { testAgent, type TestAgentContext } from '../harness/agent';

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

function textResult(text: string): Awaited<ReturnType<GenerateFn>> {
  return {
    id: 'mock-compaction-summary',
    message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
    usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
    finishReason: 'completed',
    rawFinishReason: 'stop',
  };
}

function historyTexts(ctx: TestAgentContext): string[] {
  return ctx.agent.context.history.map((message) =>
    message.content.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join(''),
  );
}

describe('compaction — guard tests', () => {
  it('pins prior summaries verbatim and summarizes only the new range on repeated compaction', async () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.appendExchange(1, 'user one', 'assistant one', 40);

    ctx.mockNextResponse({ type: 'text', text: 'First summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    const afterFirst = ctx.agent.context.history;
    const pinnedLength =
      afterFirst.findIndex((message) => message.origin?.kind === 'compaction_summary') + 1;

    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'user two' }]);
    ctx.appendExchange(2, 'user three', 'assistant three', 40);
    ctx.mockNextResponse({ type: 'text', text: 'Second summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    // Digest pinning: BOTH summaries survive, verbatim and in order — the
    // first was carried, not re-summarized.
    const summaries = ctx.agent.context.history.filter(
      (message) => message.origin?.kind === 'compaction_summary',
    );
    expect(summaries).toHaveLength(2);
    const texts = historyTexts(ctx).join('\n');
    expect(texts).toContain('First summary.');
    expect(texts).toContain('Second summary.');

    // The pinned prefix (everything up to and including the first summary) is
    // byte-identical to the post-first-compaction history — repeated
    // compaction no longer re-truncates the prefix.
    const afterSecond = ctx.agent.context.history;
    expect(afterSecond.slice(0, pinnedLength)).toEqual([...afterFirst.slice(0, pinnedLength)]);

    // The second summarizer input covers only the new range: the first
    // summary never enters it, while post-summary messages do.
    const secondInput = ctx.llmCalls[1]!.history.map((message) =>
      message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
    );
    expect(secondInput.join('\n')).not.toContain('First summary.');
    expect(secondInput.join('\n')).toContain('user two');
    expect(secondInput.join('\n')).toContain('user three');

    // The second compaction record reports the pinned prefix it carried.
    const completedEvents = ctx.allEvents.filter((entry) => entry.event === 'compaction.completed');
    expect(completedEvents.at(-1)?.args).toEqual({
      result: expect.objectContaining({ pinnedPrefixCount: pinnedLength }),
    });

    await ctx.expectResumeMatches();
  });

  it('records exactly one projection drift across two consecutive full compactions', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({
      persistence,
      graduatedCompaction: { pinpointClear: { minContentTokens: 1 } },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.appendToolExchange({ key: 'one' });
    ctx.appendToolExchange({ key: 'two' });

    // Arm the pinpoint-clear layer BEFORE the first request: with no baseline
    // shape the first request never reports drift, so the arm itself stays
    // invisible and only the compaction-side rewrite can show up.
    ctx.agent.graduatedCompaction.restoreLayerApply({ layer: 'pinpoint_clear', cutoff: 4 });

    ctx.mockNextResponse({ type: 'text', text: 'First summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    ctx.appendExchange(2, 'user two', 'assistant two', 40);
    ctx.mockNextResponse({ type: 'text', text: 'Second summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    const requests = persistence.records.filter((record) => record.type === 'llm.request');
    expect(requests).toHaveLength(2);
    expect(requests[0]!.prefixDriftReasons).toBeUndefined();
    // The first compaction reset the armed graduated layers; the second
    // summarizer request — the next request after that reset — carries the
    // one and only projection rewrite of the whole sequence. The pinned
    // digest itself adds no further drift.
    expect(requests[1]!.prefixDriftReasons).toEqual(['graduated_rewrite']);

    // And the second summarizer input excludes the first summary (digest
    // pinning: only the new range is summarized).
    const secondInput = ctx.llmCalls[1]!.history.map((message) =>
      message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
    );
    expect(secondInput.join('\n')).not.toContain('First summary.');

    await ctx.expectResumeMatches();
  });

  it('closes a dangling tool_use in the compaction summary request via synthesizeMissing', async () => {
    // Full compaction projects its summarizer input with { synthesizeMissing: true }
    // so an unresolved tool_use (whose result is sliced out / not yet recorded)
    // is answered by a synthetic tool_result — keeping the summary request
    // well-formed for strict providers instead of 400-ing on a dangling call.
    let summarizerMessages: Message[] | undefined;
    const capture: GenerateFn = async (_provider, _system, _tools, messages) => {
      summarizerMessages = messages;
      return textResult('Compacted summary.');
    };
    const ctx = testAgent({ generate: capture });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.appendUnresolvedToolExchange(0); // assistant with 2 tool calls, no results

    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    const msgs = summarizerMessages ?? [];
    const assistantIndex = msgs.findIndex(
      (message) => message.role === 'assistant' && message.toolCalls.length > 0,
    );
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    for (const toolCall of msgs[assistantIndex]!.toolCalls) {
      const answered = msgs
        .slice(assistantIndex + 1)
        .some((message) => message.role === 'tool' && message.toolCallId === toolCall.id);
      expect(answered).toBe(true);
    }
  });

  // Mutual exclusion: compaction and turn processing must not run concurrently,
  // or a turn mutating the context mid-summary loses output. Auto compaction is
  // structurally safe (it runs while the turn blocks at a step boundary); the
  // manual/SDK path is guarded explicitly here.
  it('rejects a manual compaction while a turn is active', async () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'seed' }], { kind: 'user' });
    ctx.mockNextResponse({ type: 'text', text: 'turn done' });

    // launch() sets the active turn synchronously, so a turn is active before the
    // worker yields — exactly the window an SDK beginCompaction could land in.
    ctx.agent.turn.prompt([{ type: 'text', text: 'go' }]);
    expect(ctx.agent.turn.hasActiveTurn).toBe(true);

    await expect(ctx.rpc.beginCompaction({})).rejects.toThrow(/turn/i);

    await ctx.agent.turn.waitForCurrentTurn();
  });

  it('defers a prompt submitted during compaction and runs it afterward', async () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.appendExchange(1, 'user one', 'assistant one', 40);
    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    ctx.mockNextResponse({ type: 'text', text: 'answer to the deferred prompt' });

    // begin() sets the compacting flag synchronously before the summarizer yields.
    void ctx.rpc.beginCompaction({});
    expect(ctx.agent.fullCompaction.isCompacting).toBe(true);

    // A prompt arriving mid-compaction is buffered (deferred), not rejected: null
    // means "not launched now", and it must run once compaction finishes.
    const turnId = ctx.agent.turn.prompt([{ type: 'text', text: 'DEFERRED-PROMPT' }]);
    expect(turnId).toBeNull();

    await ctx.once('compaction.completed');
    await ctx.agent.turn.waitForCurrentTurn();

    // Ran after compaction — neither lost nor stuck.
    expect(historyTexts(ctx).join('\n')).toContain('DEFERRED-PROMPT');
  });

  it('defers a steer arriving during compaction and delivers it afterward', async () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.appendExchange(1, 'user one', 'assistant one', 40);
    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    ctx.mockNextResponse({ type: 'text', text: 'handled the steer' });

    void ctx.rpc.beginCompaction({});
    expect(ctx.agent.fullCompaction.isCompacting).toBe(true);

    // A background-task/cron steer mid-compaction must be buffered (null = buffered,
    // which is exactly what those fire-and-forget callers assume), not dropped.
    const turnId = ctx.agent.turn.steer([{ type: 'text', text: 'DEFERRED-STEER' }], {
      kind: 'background_task',
      taskId: 't',
      status: 'completed',
      notificationId: 'n',
    });
    expect(turnId).toBeNull();

    await ctx.once('compaction.completed');
    await ctx.agent.turn.waitForCurrentTurn();

    expect(historyTexts(ctx).join('\n')).toContain('DEFERRED-STEER');
  });
});

describe('compaction — probe tests (high-risk scenarios)', () => {
  // PROBE #1 / CMP-02 — messages appended while the summarizer request is in
  // flight (a live step racing a manual/SDK compaction). The summary only covers
  // the pre-compaction snapshot, and the all-user rebuild would drop the appended
  // assistant/tool tail — so compaction detects the changed history and cancels,
  // leaving the appended turn intact for a later clean-boundary compaction.
  it('preserves an assistant turn appended while the summarizer call is in flight', async () => {
    let ctx!: TestAgentContext;
    const appendDuringGenerate: GenerateFn = async () => {
      // Simulate the turn loop completing a step while compaction awaits.
      ctx.agent.context.appendLoopEvent({
        type: 'step.begin',
        uuid: 'race-step',
        turnId: '',
        step: 9,
      });
      ctx.agent.context.appendLoopEvent({
        type: 'content.part',
        uuid: 'race-part',
        turnId: '',
        step: 9,
        stepUuid: 'race-step',
        part: { type: 'text', text: 'RACE-ASSISTANT-OUTPUT' },
      });
      ctx.agent.context.appendLoopEvent({
        type: 'step.end',
        uuid: 'race-step',
        turnId: '',
        step: 9,
        finishReason: 'end_turn',
      });
      return textResult('Compacted summary.');
    };
    ctx = testAgent({ generate: appendDuringGenerate });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.appendExchange(1, 'user one', 'assistant one', 40);

    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.cancelled');

    expect(historyTexts(ctx).join('\n')).toContain('RACE-ASSISTANT-OUTPUT');
  });

  // PROBE #1b — a user-ROLE message that compaction would drop (background-task
  // notification, hook/cron reminder, shell output) appended mid-summary. It is
  // neither summarized (added after the snapshot) nor kept (applyCompaction keeps
  // only real user input), so it would silently vanish; the race guard must cancel
  // on any tail compaction would drop, not just non-user roles.
  it('cancels compaction when a droppable user-role tail is appended mid-summary', async () => {
    let ctx!: TestAgentContext;
    const appendDuringGenerate: GenerateFn = async () => {
      ctx.agent.context.appendUserMessage([{ type: 'text', text: 'BG-NOTIFY-OUTPUT' }], {
        kind: 'background_task',
        taskId: 't',
        status: 'completed',
        notificationId: 'n',
      });
      return textResult('Compacted summary.');
    };
    ctx = testAgent({ generate: appendDuringGenerate });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.appendExchange(1, 'user one', 'assistant one', 40);

    await ctx.rpc.beginCompaction({});
    await Promise.race([ctx.once('compaction.completed'), ctx.once('compaction.cancelled')]);

    // Cancelled, so the notification survives in history rather than being dropped.
    expect(historyTexts(ctx).join('\n')).toContain('BG-NOTIFY-OUTPUT');
  });

  // PROBE #2 — empty/truncated summarizer responses drop one oldest message and
  // retry. A dedicated shrink counter, bounded by MAX_COMPACTION_RETRY_ATTEMPTS,
  // keeps a model that always returns empty from issuing ~one call per message.
  it('bounds summarizer calls by the retry limit when the model keeps returning empty', async () => {
    let calls = 0;
    // Empty 7 times, then a valid summary. The bounded shrink counter gives up by
    // ~call 6, so compaction errors out before ever reaching the 8th (valid)
    // response; an unbounded impl would tolerate all 7 and complete on the 8th.
    const flakyEmpty: GenerateFn = async () => {
      calls += 1;
      return calls <= 7 ? textResult('') : textResult('Compacted summary.');
    };
    const ctx = testAgent({ generate: flakyEmpty });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    for (let i = 1; i <= 5; i++) {
      ctx.appendExchange(i, `user ${String(i)}`, `assistant ${String(i)}`, 40);
    }

    await ctx.rpc.beginCompaction({});
    await Promise.race([ctx.once('compaction.completed'), ctx.once('error')]);

    // A retry budget of MAX_COMPACTION_RETRY_ATTEMPTS(5) should bound calls.
    expect(calls).toBeLessThanOrEqual(6);
  });

  // PROBE #3 / CMP-08 — the kept-user budget is a fixed 20k and ignores the
  // model window, so on a small-window model the post-compaction context can
  // still exceed the trigger, re-compacting every turn without converging.
  it.fails('keeps the post-compaction context below the auto-compaction trigger on a small window', async () => {
    const SMALL_WINDOW = 16_000;
    const ctx = testAgent();
    ctx.configure({
      provider: PROVIDER,
      modelCapabilities: { ...CAPS, max_context_tokens: SMALL_WINDOW },
    });
    // ~7.5k tokens of user text per message (30k ascii chars / 4).
    for (let i = 1; i <= 3; i++) {
      ctx.appendExchange(i, 'u'.repeat(30_000), `assistant ${String(i)}`, 40);
    }

    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    // tokenCount after compaction should leave headroom below the 85% trigger,
    // otherwise the next turn immediately re-compacts and never converges.
    expect(ctx.agent.context.tokenCount).toBeLessThan(SMALL_WINDOW * 0.85);
  });

  // PROBE #4 / CMP-01 — compaction started while a tool exchange is still open
  // (SDK/REST caller mid-tool) clears pendingToolResultIds, so the tool.result
  // that arrives afterwards is treated as an orphan and silently dropped.
  it.fails('does not drop a tool result that arrives after a compaction started mid-exchange', async () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.appendUnresolvedToolExchange(0); // assistant with 2 tool calls, no results yet

    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    // The tool finishes after compaction; its result must not vanish.
    ctx.agent.context.appendLoopEvent({
      type: 'tool.result',
      parentUuid: 'call_unresolved_one',
      toolCallId: 'call_unresolved_one',
      result: { output: 'LATE-TOOL-RESULT' },
    });

    expect(historyTexts(ctx).join('\n')).toContain('LATE-TOOL-RESULT');
  });

  // CMP-12 fix — restoring a legacy `context.apply_compaction` record (pre-rework:
  // no keptUserMessageCount; the old `[summary, ...history.slice(compactedCount)]`
  // semantics kept a verbatim recent tail). On restore we reproduce that shape so
  // an upgraded session does not lose its recent assistant/tool tail.
  it('preserves the verbatim tail when restoring a legacy compaction record', () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.appendExchange(1, 'summarized user', 'TAIL-ASSISTANT', 40);

    // Goes through the real restore path so `records.restoring` gates the legacy
    // reconstruction. No keptUserMessageCount + compactedCount < length marks the
    // pre-rework record that kept history.slice(compactedCount) as a tail.
    ctx.agent.records.restore({
      type: 'context.apply_compaction',
      summary: 'Legacy summary.',
      compactedCount: 1,
      tokensBefore: 100,
      tokensAfter: 50,
    });

    expect(historyTexts(ctx).join('\n')).toContain('TAIL-ASSISTANT');
  });

  // PROBE #6 — when the summarizer request overflows, historyForModel is shrunk
  // to a recent suffix. The removed MicroCompaction applied an absolute index
  // cutoff to the shifted suffix, clearing recent tool results the summary
  // needed. The graduated chain keys armed eligibility by tool_call id instead
  // of history index, so a shifted (or sliced) projection cannot pull a recent
  // result into the armed range.
  it('does not clear recent tool results when projecting a shrunk suffix under an armed pinpoint-clear', () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });

    const bigToolOutput = 'TOOL-OUTPUT-CONTENT '.repeat(60); // > minContentTokens(100)
    const full: ContextMessage[] = [];
    for (let i = 0; i < 20; i++) {
      if (i === 15) {
        full.push({
          role: 'tool',
          content: [{ type: 'text', text: bigToolOutput } satisfies ContentPart],
          toolCalls: [],
          toolCallId: `tool-${String(i)}`,
        });
      } else {
        full.push({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: [{ type: 'text', text: `m${String(i)}` }],
          toolCalls: [],
          origin: i % 2 === 0 ? { kind: 'user' } : undefined,
        });
      }
    }
    for (const message of full) ctx.agent.context.appendMessage(message);

    // Arm as the live chain would: keep the recent 10 (indices >= 10).
    ctx.agent.graduatedCompaction.restoreLayerApply({ layer: 'pinpoint_clear', cutoff: 10 });

    // In the full history the tool result is at index 15 (>= cutoff) -> kept.
    const projectedFull = ctx.agent.context.project(full);
    const fullToolText = projectedFull
      .map((m) => m.content.map((p) => (p.type === 'text' ? p.text : '')).join(''))
      .join('\n');
    expect(fullToolText).toContain('TOOL-OUTPUT-CONTENT');

    // After an overflow shrink drops the oldest 10, the SAME tool result sits at
    // suffix index 5. Eligibility is keyed by tool_call id, not position, so it
    // is still preserved (it is a recent result the summary depends on).
    const shrunkSuffix = full.slice(10);
    const projectedSuffix = ctx.agent.context.project(shrunkSuffix);
    const suffixToolText = projectedSuffix
      .map((m) => m.content.map((p) => (p.type === 'text' ? p.text : '')).join(''))
      .join('\n');
    expect(suffixToolText).toContain('TOOL-OUTPUT-CONTENT');
  });

  // PROBE #7 / CMP-07 — when the oldest kept user message overflows the budget it
  // is truncated to text only, dropping any image/audio/video it carried: media
  // can't be partially truncated, and keeping it whole would overshoot the
  // budget. Recent messages that fit keep their media; only this boundary message
  // loses its attachments. Documented as an accepted limitation rather than fixed.
  it.fails('keeps media on the oldest kept user message instead of dropping it on truncation', () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    // Oldest user message: an image + long text that will overflow the budget.
    ctx.agent.context.appendUserMessage(
      [
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
        { type: 'text', text: 'x'.repeat(120_000) }, // ~30k tokens of text
      ],
      { kind: 'user' },
    );
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'recent user' }], { kind: 'user' });

    ctx.agent.context.applyCompaction({
      summary: 'Summary.',
      compactedCount: 2,
      tokensBefore: 100,
    });

    const keptParts = ctx.agent.context.history.flatMap((message) => message.content);
    expect(keptParts.some((part) => part.type === 'image_url')).toBe(true);
  });
});

describe('compaction — summarizer request media handling', () => {
  // GUARD — the first summarizer attempt sends media as-is: a multimodal
  // summarizer can still read an image nobody narrated. Media is only
  // replaced with text markers when the provider rejects the request body
  // as too large (see full.test.ts "request too large" cases).
  it('keeps media parts in the summarizer request when it is not rejected', async () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.agent.context.appendUserMessage(
      [
        { type: 'text', text: '<image path="/workspace/shot.png">' },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
        { type: 'text', text: '</image>' },
      ],
      { kind: 'user' },
    );

    ctx.mockNextResponse({ type: 'text', text: 'Summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    const request = ctx.llmCalls.at(-1)!;
    const parts = request.history.flatMap((message) => message.content);
    expect(parts.some((part) => part.type === 'image_url')).toBe(true);
  });
});

describe('compaction — head/tail user-message retention', () => {
  const FIRST = `FIRST ${'a'.repeat(4_000)}`; // ~1k tokens
  const MIDDLE = 'b'.repeat(88_000); // ~22k tokens, over the 20k budget on its own
  const LAST = `LAST ${'c'.repeat(4_000)}`; // ~1k tokens

  async function compactedOversizedPool() {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    for (const text of [FIRST, MIDDLE, LAST]) {
      ctx.agent.context.appendUserMessage([{ type: 'text', text }]);
    }
    ctx.mockNextResponse({ type: 'text', text: 'Summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');
    return ctx;
  }

  it('splits an oversized user pool into head + elision marker + tail', async () => {
    const ctx = await compactedOversizedPool();

    const history = ctx.agent.context.history;
    const texts = historyTexts(ctx);
    // [FIRST, head slice of MIDDLE, marker, tail slice of MIDDLE, LAST, summary,
    // behavior-rules reminder (default-on post-compaction re-injection)]
    expect(history).toHaveLength(7);
    expect(texts[0]).toBe(FIRST);
    expect(/^b+$/.test(texts[1]!)).toBe(true);
    expect(MIDDLE.startsWith(texts[1]!)).toBe(true);
    expect(history[2]!.origin).toEqual({ kind: 'injection', variant: COMPACTION_ELISION_VARIANT });
    expect(texts[2]).toContain('<system-reminder>');
    expect(texts[2]).toContain('omitted');
    expect(/^b+$/.test(texts[3]!)).toBe(true);
    expect(MIDDLE.endsWith(texts[3]!)).toBe(true);
    expect(texts[4]).toBe(LAST);
    expect(history[5]!.origin?.kind).toBe('compaction_summary');
    expect(history[6]!.origin).toEqual({ kind: 'injection', variant: 'behavior_reminders' });

    const completedEvent = ctx.allEvents.find((entry) => entry.event === 'compaction.completed');
    expect(completedEvent?.args).toEqual({
      result: expect.objectContaining({
        keptUserMessageCount: 4,
        keptHeadUserMessageCount: 2,
      }),
    });

    await ctx.expectResumeMatches();
  });

  it('never elides a [[keep]]-marked user message, even inside the dropped middle', async () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    const MARKED = `PINNED [[keep]] ${'p'.repeat(8_000)}`; // ~2k tokens, mid-pool
    for (const text of [FIRST, MARKED, MIDDLE, LAST]) {
      ctx.agent.context.appendUserMessage([{ type: 'text', text }]);
    }
    ctx.mockNextResponse({ type: 'text', text: 'Summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    const texts = historyTexts(ctx);
    // The marked message survives verbatim; the unmarked oversized MIDDLE
    // still elides around it (head slice + marker + tail slice).
    expect(texts).toContain(MARKED);
    expect(texts).toContain(FIRST);
    expect(texts).toContain(LAST);
    expect(texts.join('\n')).not.toContain(MIDDLE);
    expect(
      ctx.agent.context.history.some(
        (message) =>
          message.origin?.kind === 'injection' &&
          message.origin.variant === COMPACTION_ELISION_VARIANT,
      ),
    ).toBe(true);
    // Order is the original one: FIRST, the pinned message, the head slice of
    // MIDDLE, the marker, the tail slice, LAST, then the summary.
    const history = ctx.agent.context.history;
    expect(texts[0]).toBe(FIRST);
    expect(texts[1]).toBe(MARKED);
    expect(/^b+$/.test(texts[2]!)).toBe(true);
    expect(history[3]!.origin).toEqual({ kind: 'injection', variant: COMPACTION_ELISION_VARIANT });
    expect(/^b+$/.test(texts[4]!)).toBe(true);
    expect(texts[5]).toBe(LAST);
    expect(history[6]!.origin?.kind).toBe('compaction_summary');

    await ctx.expectResumeMatches();
  });

  it('does not stack elision markers or re-summarize them across repeated compactions', async () => {
    const ctx = await compactedOversizedPool();

    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'd'.repeat(8_000) }]);
    ctx.mockNextResponse({ type: 'text', text: 'Second summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    // The first compaction's marker sits inside the pinned digest prefix —
    // carried verbatim, never re-summarized — and the small new range needs
    // no marker of its own, so exactly one marker exists.
    const markers = ctx.agent.context.history.filter(
      (message) =>
        message.origin?.kind === 'injection' && message.origin.variant === COMPACTION_ELISION_VARIANT,
    );
    expect(markers).toHaveLength(1);
    // Digest pinning: both summaries accumulate verbatim.
    const summaries = ctx.agent.context.history.filter(
      (message) => message.origin?.kind === 'compaction_summary',
    );
    expect(summaries).toHaveLength(2);
    const texts = historyTexts(ctx).join('\n');
    expect(texts).toContain('Summary.');
    expect(texts).toContain('Second summary.');
    // The second summarizer input covered only the new range: no elision
    // marker and no pinned first summary enters it.
    const secondInput = ctx.llmCalls[1]!.history.map((message) =>
      message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
    );
    expect(secondInput.join('\n')).not.toContain('were omitted here during compaction');
    expect(secondInput.join('\n')).not.toContain('The conversation so far has been compacted');
    expect(secondInput.join('\n')).toContain('d'.repeat(100));
  });

  it('keeps everything verbatim (no marker) when the user pool fits the budget', async () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'small question' }]);
    ctx.mockNextResponse({ type: 'text', text: 'Summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    expect(historyTexts(ctx)[0]).toBe('small question');
    expect(
      ctx.agent.context.history.some(
        (message) =>
          message.origin?.kind === 'injection' &&
          message.origin.variant === COMPACTION_ELISION_VARIANT,
      ),
    ).toBe(false);

    const completedEvent = ctx.allEvents.find((entry) => entry.event === 'compaction.completed');
    expect(completedEvent?.args).toEqual({
      result: expect.not.objectContaining({ keptHeadUserMessageCount: expect.anything() }),
    });
  });

  it('restores a pre-split wire record with the tail-only selection and no marker', async () => {
    // A record written before the head/tail split (no `keptHeadUserMessageCount`)
    // must restore with the original tail-only selection, or the rebuilt live
    // history would diverge from the persisted keptUserMessageCount that the
    // wire-transcript reducer uses for its folded length.
    const big = 'x'.repeat(88_000); // ~22k tokens: over budget under the old algorithm too
    const records = [
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: big }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'recent question' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'context.apply_compaction',
        summary: 'OLD SUMMARY',
        contextSummary: 'OLD SUMMARY',
        compactedCount: 2,
        tokensBefore: 22_007,
        tokensAfter: 20_005,
        keptUserMessageCount: 2,
      },
    ] as unknown as AgentRecord[];
    const ctx = testAgent({ persistence: new InMemoryAgentRecordPersistence(records) });
    await ctx.agent.resume();

    const history = ctx.agent.context.history;
    const texts = historyTexts(ctx);
    // Old tail-only shape: [truncated big message, recent question, summary].
    expect(history).toHaveLength(3);
    expect(
      history.some(
        (message) =>
          message.origin?.kind === 'injection' &&
          message.origin.variant === COMPACTION_ELISION_VARIANT,
      ),
    ).toBe(false);
    // The legacy truncation keeps the boundary message's beginning.
    expect(texts[0]!.length).toBeGreaterThan(0);
    expect(big.startsWith(texts[0]!)).toBe(true);
    expect(texts[1]).toBe('recent question');
    expect(history.at(-1)!.origin?.kind).toBe('compaction_summary');
  });
});
