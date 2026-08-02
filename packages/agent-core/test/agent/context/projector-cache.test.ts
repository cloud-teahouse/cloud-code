import type { ContentPart, Message, TextPart, ToolCall } from '@cloud-code/kosong';
import { describe, expect, it } from 'vitest';

import {
  project,
  ProjectionCache,
  type ProjectionAnomaly,
  type ProjectOptions,
} from '../../../src/agent/context/projector';
import type { ContextMessage } from '../../../src/agent/context/types';
import { testAgent } from '../harness';

// ---------------------------------------------------------------------------
// Invariant under test
// ---------------------------------------------------------------------------
//
// The ProjectionCache memoizes the projection's per-message work (tool-result
// rendering, whitespace cleanup, metadata stripping, user-message merging)
// keyed by message object identity. For every history and every option set,
// a cached projection must be indistinguishable from an uncached one: same
// model-visible bytes, same anomaly sequence, on every call — cold, warm, and
// after every history mutation class (append, open-step growth, undo,
// compaction).

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function textPart(text: string): TextPart {
  return { type: 'text', text };
}

function thinkPart(think: string): ContentPart {
  return { type: 'think', think };
}

function imagePart(url: string): ContentPart {
  return { type: 'image_url', imageUrl: { url, id: url } };
}

function textOf(message: Message | undefined): string {
  return (
    message?.content.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? ''
  );
}

function user(text: string): ContextMessage {
  return { role: 'user', content: [textPart(text)], toolCalls: [], origin: { kind: 'user' } };
}

function notification(text: string): ContextMessage {
  return {
    role: 'user',
    content: [textPart(text)],
    toolCalls: [],
    origin: {
      kind: 'background_task',
      taskId: 'task',
      status: 'completed',
      notificationId: 'task:task:completed',
    },
  };
}

function assistant(
  toolCallIds: readonly string[],
  parts: readonly ContentPart[] = [],
): ContextMessage {
  return {
    role: 'assistant',
    content: [...parts],
    toolCalls: toolCallIds.map(
      (id): ToolCall => ({ type: 'function', id, name: 'Run', arguments: '{}' }),
    ),
  };
}

function tool(
  toolCallId: string,
  content: string | readonly ContentPart[] = 'ok',
  extra?: { readonly isError?: boolean; readonly note?: string },
): ContextMessage {
  return {
    role: 'tool',
    content: typeof content === 'string' ? [textPart(content)] : [...content],
    toolCalls: [],
    toolCallId,
    ...extra,
  };
}

function schemaMessage(): ContextMessage {
  return {
    role: 'system',
    content: [],
    toolCalls: [],
    tools: [
      {
        name: 'DynamicTool',
        description: 'dynamically loaded',
        parameters: { type: 'object', properties: {} },
      },
    ],
    origin: { kind: 'injection', variant: 'dynamic_tool_schema' },
  };
}

const OPT_PLAIN: ProjectOptions = {};
const OPT_NORMAL: ProjectOptions = { dropOrphanResults: true };
const OPT_STRICT: ProjectOptions = {
  synthesizeMissing: true,
  dropOrphanResults: true,
  dedupeDuplicateToolCalls: true,
  dropLeadingNonUser: true,
  mergeConsecutiveAssistants: true,
};

/** Histories exercising every per-message transform the cache memoizes. */
const HISTORIES: Readonly<Record<string, readonly ContextMessage[]>> = {
  'text exchange': [user('hi'), assistant([], [textPart('hello')]), user('again'), assistant([], [textPart('sure')])],
  'merge chain': [user('a'), user('b'), user('c'), assistant([], [textPart('ok')])],
  'merge with media': [
    { ...user('look'), content: [textPart('look'), imagePart('ms://img-1')] },
    user('describe it'),
  ],
  'tool exchange': [
    user('run it'),
    assistant(['c1', 'c2'], [textPart('calling')]),
    tool('c1', 'result text'),
    tool('c2', 'second'),
  ],
  'tool result variants': [
    user('run all'),
    assistant(['c1', 'c2', 'c3', 'c4']),
    tool('c1', ''),
    tool('c2', 'failure output', { isError: true }),
    tool('c3', [textPart('rows'), imagePart('ms://img-2')], { note: 'model-only note' }),
    tool('c4', 'output', { note: 'appended note' }),
  ],
  'whitespace parts': [
    user('q'),
    assistant([], [textPart('   '), textPart('real content'), textPart('')]),
    user('next'),
  ],
  'vacuous message': [user('q'), assistant([], [thinkPart('')]), user('again')],
  'signed thinking kept': [
    user('q'),
    assistant([], [{ type: 'think', think: '', encrypted: 'sig' }]),
    user('again'),
  ],
  'partial message': [
    user('q'),
    { role: 'assistant', content: [textPart('streaming')], toolCalls: [], partial: true },
    user('again'),
  ],
  'schema message': [user('q'), schemaMessage(), assistant([], [textPart('done')])],
  'orphan result': [user('q'), tool('ghost'), assistant([], [textPart('hi')])],
  'displaced result': [
    user('q'),
    assistant(['c1'], [textPart('calling')]),
    notification('background done'),
    tool('c1', 'late result'),
  ],
  'missing result mid-history': [
    user('q'),
    assistant(['c1'], [textPart('calling')]),
    user('moved on'),
    assistant([], [textPart('done')]),
  ],
  'trailing missing result': [user('q'), assistant(['c1'], [textPart('calling')])],
  'compaction state': [
    {
      role: 'user',
      content: [textPart('summary of earlier work')],
      toolCalls: [],
      origin: { kind: 'compaction_summary' },
    },
    {
      role: 'user',
      content: [textPart('[... 1200 tokens elided ...]')],
      toolCalls: [],
      origin: { kind: 'injection', variant: 'compaction_elision' },
    },
    user('fresh prompt'),
    assistant(['c1'], [textPart('calling')]),
    tool('c1', 'result'),
  ],
  'strict repairs': [
    assistant(['c1'], [textPart('leading')]),
    assistant(['c1'], [thinkPart('')]),
    tool('c1', 'answered twice'),
    tool('c1', 'duplicate result'),
    user('q'),
  ],
};

const OPTION_SETS: Readonly<Record<string, ProjectOptions>> = {
  plain: OPT_PLAIN,
  normal: OPT_NORMAL,
  strict: OPT_STRICT,
};

function projectCollecting(
  history: readonly ContextMessage[],
  options: ProjectOptions,
  cache?: ProjectionCache,
): { readonly messages: Message[]; readonly anomalies: ProjectionAnomaly[] } {
  const anomalies: ProjectionAnomaly[] = [];
  const messages = project(history, { ...options, onAnomaly: (a) => anomalies.push(a) }, cache);
  return { messages, anomalies };
}

// ---------------------------------------------------------------------------
// Pure projector: cached vs uncached across the matrix
// ---------------------------------------------------------------------------

describe('ProjectionCache', () => {
  for (const [historyName, history] of Object.entries(HISTORIES)) {
    for (const [optionsName, options] of Object.entries(OPTION_SETS)) {
      it(`matches the uncached projection: ${historyName} / ${optionsName}`, () => {
        const expected = projectCollecting(history, options);
        const cache = new ProjectionCache();
        const cold = projectCollecting(history, options, cache);
        const warm = projectCollecting(history, options, cache);

        expect(cold.messages).toEqual(expected.messages);
        expect(JSON.stringify(cold.messages)).toBe(JSON.stringify(expected.messages));
        expect(cold.anomalies).toEqual(expected.anomalies);

        expect(warm.messages).toEqual(expected.messages);
        expect(JSON.stringify(warm.messages)).toBe(JSON.stringify(expected.messages));
        // The anomaly sequence must be replayed identically on every call.
        expect(warm.anomalies).toEqual(expected.anomalies);
      });
    }
  }

  it('returns the same message objects on a warm cache (memo actually engaged)', () => {
    const history = HISTORIES['tool result variants']!;
    const cache = new ProjectionCache();
    const cold = project(history, OPT_NORMAL, cache);
    const warm = project(history, OPT_NORMAL, cache);

    expect(warm.length).toBe(cold.length);
    warm.forEach((message, index) => {
      expect(message).toBe(cold[index]);
    });
    // Down to the content-part level: no per-part re-cloning on warm calls.
    const coldMerged = project(HISTORIES['merge chain']!, OPT_NORMAL, cache);
    const warmMerged = project(HISTORIES['merge chain']!, OPT_NORMAL, cache);
    expect(warmMerged.length).toBe(coldMerged.length);
    warmMerged.forEach((message, index) => {
      expect(message).toBe(coldMerged[index]);
      message.content.forEach((part, partIndex) => {
        expect(part).toBe(coldMerged[index]!.content[partIndex]);
      });
    });
  });

  it('shares prepared entries across option sets without cross-talk', () => {
    const history = HISTORIES['strict repairs']!;
    const cache = new ProjectionCache();
    for (const options of Object.values(OPTION_SETS)) {
      const expected = projectCollecting(history, options);
      const cached = projectCollecting(history, options, cache);
      expect(cached.messages).toEqual(expected.messages);
      expect(cached.anomalies).toEqual(expected.anomalies);
      // A second pass over the warm cache must not drift.
      const rewarmed = projectCollecting(history, options, cache);
      expect(rewarmed.messages).toEqual(expected.messages);
      expect(rewarmed.anomalies).toEqual(expected.anomalies);
    }
  });

  it('invalidate() drops the prepared wrapper of a tool message', () => {
    const result = tool('c1', 'output text');
    const history = [user('q'), assistant(['c1']), result];
    const cache = new ProjectionCache();
    const before = project(history, OPT_NORMAL, cache);
    expect(textOf(before.at(-1))).toBe('output text');

    // Simulate the open-step mutation contract on a message whose prepared
    // form is a wrapper object (rendered tool result), not the source itself.
    cache.invalidate(result);
    (result as { isError?: boolean }).isError = true;
    const after = project(history, OPT_NORMAL, cache);
    expect(textOf(after.at(-1))).toBe(
      '<system>ERROR: Tool execution failed.</system>\noutput text',
    );
    expect(after).toEqual(project(history, OPT_NORMAL));
  });

  it('invalidate() handles the empty-then-grown open-step shape', () => {
    const openStep: ContextMessage = { role: 'assistant', content: [], toolCalls: [] };
    const history = [user('q'), openStep];
    const cache = new ProjectionCache();

    // Empty open step is dropped from the projection (cached as null).
    expect(project(history, OPT_NORMAL, cache).map((m) => m.role)).toEqual(['user']);

    cache.invalidate(openStep);
    openStep.content.push(textPart('partial answer'));
    const grown = project(history, OPT_NORMAL, cache);
    expect(grown.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(textOf(grown.at(-1))).toBe('partial answer');

    cache.invalidate(openStep);
    openStep.toolCalls.push({ type: 'function', id: 'c1', name: 'Run', arguments: '{}' });
    const withCall = project(history, OPT_NORMAL, cache);
    expect(withCall.at(-1)?.toolCalls.map((tc) => tc.id)).toEqual(['c1']);
    expect(withCall).toEqual(project(history, OPT_NORMAL));
  });

  it('never aliases content-identical but distinct message objects', () => {
    // Identity keying: two messages with equal content are cached under their
    // own identities; mutating one (with invalidation) must not leak into the
    // projection of the other.
    const original = tool('c1', 'shared text');
    const twin = tool('c1', 'shared text');
    const cache = new ProjectionCache();

    const first = project([user('q'), assistant(['c1']), original], OPT_NORMAL, cache);
    expect(textOf(first.at(-1))).toBe('shared text');

    cache.invalidate(original);
    (original as { isError?: boolean }).isError = true;

    const second = project([user('q'), assistant(['c1']), twin], OPT_NORMAL, cache);
    expect(textOf(second.at(-1))).toBe('shared text');
    // Invalidating an object that was never cached is a harmless no-op.
    cache.invalidate(user('never seen'));
    expect(project([user('q'), assistant(['c1']), twin], OPT_NORMAL, cache)).toEqual(second);
  });
});

// ---------------------------------------------------------------------------
// ContextMemory integration: cached per-step projections vs pure projection
// ---------------------------------------------------------------------------

describe('ContextMemory projection cache', () => {
  function pureMessages(ctx: ReturnType<typeof testAgent>['agent']): Message[] {
    return project(ctx.context.history, OPT_NORMAL);
  }

  it('repeated per-step projections are byte-identical and share message objects', () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.appendExchange(1, 'first prompt', 'first answer', 100);
    ctx.appendToolExchange({ key: 'a' });
    ctx.appendRichToolExchange();

    const first = ctx.agent.context.messages;
    const second = ctx.agent.context.messages;

    expect(second).toEqual(first);
    expect(second.length).toBe(first.length);
    second.forEach((message, index) => {
      expect(message).toBe(first[index]);
    });
    // And identical to the uncached pure projection of the same history.
    expect(first).toEqual(pureMessages(ctx.agent));
  });

  it('never serves a stale open step mid-stream', () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.agent.context.appendUserMessage([textPart('question')]);
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', uuid: 'stream-step', turnId: '', step: 1 },
    });

    // Empty open step: dropped from the projection.
    expect(ctx.agent.context.messages.map((m) => m.role)).toEqual(['user']);
    expect(ctx.agent.context.messages).toEqual(pureMessages(ctx.agent));

    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        uuid: 'part-1',
        turnId: '',
        step: 1,
        stepUuid: 'stream-step',
        part: textPart('partial '),
      },
    });
    expect(textOf(ctx.agent.context.messages.at(-1))).toBe('partial ');
    expect(ctx.agent.context.messages).toEqual(pureMessages(ctx.agent));

    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        uuid: 'part-2',
        turnId: '',
        step: 1,
        stepUuid: 'stream-step',
        part: textPart('answer'),
      },
    });
    expect(textOf(ctx.agent.context.messages.at(-1))).toBe('partial answer');

    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        uuid: 'call-1',
        turnId: '',
        step: 1,
        stepUuid: 'stream-step',
        toolCallId: 'call_stream',
        name: 'Lookup',
        args: { query: 'moon' },
      },
    });
    // Trailing in-flight call: visible, left open on the normal projection…
    const open = ctx.agent.context.messages;
    expect(open.at(-1)?.toolCalls.map((tc) => tc.id)).toEqual(['call_stream']);
    expect(open).toEqual(pureMessages(ctx.agent));
    // …and closed synthetically on the strict resend projection — the
    // mid-open-step strict path that motivated explicit invalidation.
    const strict = ctx.agent.context.strictMessages;
    expect(strict.at(-1)?.role).toBe('tool');
    expect(strict).toEqual(project(ctx.agent.context.history, OPT_STRICT));

    ctx.dispatch({
      type: 'context.append_loop_event',
      event: { type: 'step.end', uuid: 'stream-step', turnId: '', step: 1, finishReason: 'tool_use' },
    });
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call-1',
        toolCallId: 'call_stream',
        result: { output: 'stream result' },
      },
    });
    const closed = ctx.agent.context.messages;
    expect(textOf(closed.at(-1))).toBe('stream result');
    expect(closed).toEqual(pureMessages(ctx.agent));
    expect(ctx.agent.context.messages).toEqual(closed);
  });

  it('stays exact across undo', () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.appendExchange(1, 'first prompt', 'first answer', 100);
    ctx.appendExchange(2, 'second prompt', 'second answer', 200);
    // Warm the cache on the pre-undo history.
    const before = ctx.agent.context.messages;
    expect(before.at(-1)?.content).toEqual([textPart('second answer')]);

    ctx.agent.context.undo(1);

    const after = ctx.agent.context.messages;
    expect(after).toEqual(pureMessages(ctx.agent));
    expect(textOf(after.at(-1))).toBe('first answer');
    // A warm re-projection must not drift either.
    expect(ctx.agent.context.messages).toEqual(after);
  });

  it('stays exact across compaction', () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.appendExchange(1, 'old prompt', 'old answer', 100);
    ctx.appendToolExchange({ key: 'b' });
    // Warm the cache on the pre-compaction history.
    const before = ctx.agent.context.messages;
    expect(before.length).toBeGreaterThan(0);

    ctx.agent.context.applyCompaction({
      summary: 'summary of earlier work',
      compactedCount: 3,
      tokensBefore: 500,
    });

    const after = ctx.agent.context.messages;
    expect(after).toEqual(pureMessages(ctx.agent));
    // Kept messages survive compaction as the same objects, so a second
    // projection is warm and identical again.
    const rewarmed = ctx.agent.context.messages;
    expect(rewarmed).toEqual(after);
    rewarmed.forEach((message, index) => {
      expect(message).toBe(after[index]);
    });
  });

  it('replays projection anomalies identically on every cached call', () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.agent.context.appendUserMessage([textPart('question')]);
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', uuid: 'blank-step', turnId: '', step: 1 },
    });
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        uuid: 'blank-part',
        turnId: '',
        step: 1,
        stepUuid: 'blank-step',
        part: textPart('   '),
      },
    });
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: { type: 'step.end', uuid: 'blank-step', turnId: '', step: 1, finishReason: 'end_turn' },
    });

    const collect = (): { messages: Message[]; anomalies: ProjectionAnomaly[] } => {
      const anomalies: ProjectionAnomaly[] = [];
      const messages = ctx.agent.context.project(ctx.agent.context.history, {
        dropOrphanResults: true,
        onAnomaly: (anomaly) => anomalies.push(anomaly),
      });
      return { messages, anomalies };
    };

    const first = collect();
    const second = collect();
    expect(first.anomalies).toEqual([{ kind: 'whitespace_text_dropped', role: 'assistant' }]);
    expect(second.anomalies).toEqual(first.anomalies);
    expect(second.messages).toEqual(first.messages);

    // Same anomalies the uncached pure projection reports.
    const pureAnomalies: ProjectionAnomaly[] = [];
    const pure = project(ctx.agent.context.history, {
      dropOrphanResults: true,
      onAnomaly: (anomaly) => pureAnomalies.push(anomaly),
    });
    expect(first.anomalies).toEqual(pureAnomalies);
    expect(first.messages).toEqual(pure);
  });
});
