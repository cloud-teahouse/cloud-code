/**
 * Streaming tool execution — tool calls whose arguments provably complete
 * mid-stream are prepared (and, when read-only, started) before the provider
 * finishes, while every recorded event stays in strict provider order.
 *
 * The harness LLMs fire `params.onToolCallReady` mid-`chat`, mirroring how
 * the kosong adapter reports merge-boundary completions, and hold the stream
 * open so tests can observe what ran before the response completed.
 */

import { describe, expect, it } from 'vitest';

import type {
  ExecutableTool,
  LLM,
  LLMChatParams,
  LLMChatResponse,
  LoopHooks,
  RunTurnInput,
  TurnResult,
} from '../../src/loop/index';
import { createLoopEventDispatcher, runTurn } from '../../src/loop/index';
import { CollectingSink } from './fixtures/collecting-sink';
import { makeToolCall, zeroUsage } from './fixtures/fake-llm';
import { RecordingContext } from './fixtures/recording-context';
import { EchoTool, GatedTool, markReadFileAccesses, SlowTool } from './fixtures/tools';

/** Drives `chat()` from a per-call script so tests control mid-stream timing. */
class ScriptedStreamLLM implements LLM {
  readonly systemPrompt = 'streaming tool execution system prompt';
  readonly modelName = 'stream-ready-model';
  readonly isRetryableError?: (error: unknown) => boolean;

  private index = 0;

  constructor(
    private readonly scripts: ReadonlyArray<(params: LLMChatParams) => Promise<LLMChatResponse>>,
    opts?: { readonly retryableErrors?: boolean },
  ) {
    if (opts?.retryableErrors === true) {
      this.isRetryableError = () => true;
    }
  }

  async chat(params: LLMChatParams): Promise<LLMChatResponse> {
    const script = this.scripts[this.index];
    this.index += 1;
    if (script === undefined) {
      throw new Error(`ScriptedStreamLLM ran out of scripts at call ${String(this.index)}`);
    }
    return script(params);
  }
}

interface DriveOptions {
  readonly tools?: readonly ExecutableTool[] | undefined;
  readonly hooks?: LoopHooks | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly streamingToolExecution?: boolean | undefined;
}

async function drive(
  llm: LLM,
  opts: DriveOptions = {},
): Promise<{
  result: TurnResult;
  context: RecordingContext;
  sink: CollectingSink;
}> {
  const context = new RecordingContext();
  const sink = new CollectingSink();
  const input: RunTurnInput = {
    turnId: 'turn-1',
    signal: opts.signal ?? new AbortController().signal,
    llm,
    buildMessages: context.buildMessages,
    dispatchEvent: createLoopEventDispatcher({
      appendTranscriptRecord: context.appendTranscriptRecord,
      emitLiveEvent: sink.emit,
    }),
    tools: opts.tools,
    hooks: opts.hooks,
    streamingToolExecution: opts.streamingToolExecution,
  };
  const result = await runTurn(input);
  return { result, context, sink };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll a condition; reject (fail the test) when it does not hold in time. */
async function waitFor(condition: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`waitFor timed out: ${label}`);
    }
    await sleep(5);
  }
}

function endTurnScript(): (params: LLMChatParams) => Promise<LLMChatResponse> {
  return async () => ({
    toolCalls: [],
    providerFinishReason: 'completed',
    usage: zeroUsage(),
  });
}

function expectTextOutput(output: unknown): string {
  expect(typeof output).toBe('string');
  return output as string;
}

describe('runTurn — streaming tool execution', () => {
  it('starts a completed read-only call before the stream ends', async () => {
    const echo = markReadFileAccesses(new EchoTool());
    const tc = makeToolCall('echo', { text: 'hi' }, 'tc-1');
    const hookOrder: string[] = [];
    const hooks: LoopHooks = {
      prepareToolExecution: async () => {
        hookOrder.push('prepare');
        return undefined;
      },
      authorizeToolExecution: async () => {
        hookOrder.push('authorize');
        return undefined;
      },
    };

    const llm = new ScriptedStreamLLM([
      async (params) => {
        void params.onToolCallReady?.(tc);
        // The model is still streaming here. Preparation and the read-only
        // execution must complete before this chat() returns.
        await waitFor(() => echo.calls.length === 1, 'echo started mid-stream');
        expect(hookOrder).toEqual(['prepare', 'authorize']);
        return { toolCalls: [tc], providerFinishReason: 'tool_calls', usage: zeroUsage() };
      },
      endTurnScript(),
    ]);

    const { result, context, sink } = await drive(llm, { tools: [echo], hooks });
    expect(result.stopReason).toBe('end_turn');
    expect(echo.calls.length).toBe(1);
    expect(sink.byType('tool.call').map((e) => e.toolCallId)).toEqual(['tc-1']);
    const results = context.toolResults();
    expect(results.map((r) => r.toolCallId)).toEqual(['tc-1']);
    expect(results[0]?.result.output).toBe('hi');
  });

  it('records results in provider order even when early executions finish out of order', async () => {
    const a = markReadFileAccesses(new GatedTool('gated-a'));
    const b = markReadFileAccesses(new GatedTool('gated-b'));
    const tcA = makeToolCall('gated-a', {}, 'tc-a');
    const tcB = makeToolCall('gated-b', {}, 'tc-b');

    const llm = new ScriptedStreamLLM([
      async (params) => {
        void params.onToolCallReady?.(tcA);
        void params.onToolCallReady?.(tcB);
        return {
          toolCalls: [tcA, tcB],
          providerFinishReason: 'tool_calls',
          usage: zeroUsage(),
        };
      },
      endTurnScript(),
    ]);

    const turnPromise = drive(llm, { tools: [a, b] });
    // Both read-only executions overlap; complete them in reverse order.
    await Promise.all([a.started, b.started]);
    b.release();
    await sleep(20);
    a.release();
    const { context, sink } = await turnPromise;

    expect(context.toolCalls().map((e) => e.toolCallId)).toEqual(['tc-a', 'tc-b']);
    expect(context.toolResults().map((e) => e.toolCallId)).toEqual(['tc-a', 'tc-b']);
    expect(context.toolResults().map((e) => e.result.output)).toEqual([
      'gated-a done',
      'gated-b done',
    ]);
    expect(sink.byType('tool.result').map((e) => e.toolCallId)).toEqual(['tc-a', 'tc-b']);
  });

  it('does not start non-read-only calls before the stream ends', async () => {
    const echo = new EchoTool(); // undeclared accesses default to `all` — exclusive
    const tc = makeToolCall('echo', { text: 'later' }, 'tc-1');

    const llm = new ScriptedStreamLLM([
      async (params) => {
        void params.onToolCallReady?.(tc);
        // Give any (incorrect) early start a chance to happen while the
        // stream is still open.
        await sleep(30);
        expect(echo.calls.length).toBe(0);
        return { toolCalls: [tc], providerFinishReason: 'tool_calls', usage: zeroUsage() };
      },
      endTurnScript(),
    ]);

    const { context } = await drive(llm, { tools: [echo] });
    expect(echo.calls.length).toBe(1);
    expect(context.toolResults()[0]?.result.output).toBe('later');
  });

  it('serializes mid-stream approvals in provider order', async () => {
    const a = markReadFileAccesses(new EchoTool());
    Object.defineProperty(a, 'name', { value: 'echo-a' });
    const b = markReadFileAccesses(new EchoTool());
    Object.defineProperty(b, 'name', { value: 'echo-b' });
    const tcA = makeToolCall('echo-a', { text: 'a' }, 'tc-a');
    const tcB = makeToolCall('echo-b', { text: 'b' }, 'tc-b');
    const authLog: string[] = [];
    const hooks: LoopHooks = {
      authorizeToolExecution: async ({ toolCall }) => {
        authLog.push(`begin:${toolCall.id}`);
        await sleep(10);
        authLog.push(`end:${toolCall.id}`);
        return undefined;
      },
    };

    const llm = new ScriptedStreamLLM([
      async (params) => {
        void params.onToolCallReady?.(tcA);
        void params.onToolCallReady?.(tcB);
        await waitFor(() => b.calls.length === 1, 'echo-b started mid-stream');
        return {
          toolCalls: [tcA, tcB],
          providerFinishReason: 'tool_calls',
          usage: zeroUsage(),
        };
      },
      endTurnScript(),
    ]);

    const { context } = await drive(llm, { tools: [a, b], hooks });
    // Approvals never overlap: each one finishes before the next begins.
    expect(authLog).toEqual(['begin:tc-a', 'end:tc-a', 'begin:tc-b', 'end:tc-b']);
    expect(context.toolResults().map((e) => e.toolCallId)).toEqual(['tc-a', 'tc-b']);
  });

  it('drains started calls with real results and closes the rest when the stream breaks off', async () => {
    const echo = markReadFileAccesses(new EchoTool());
    const tc1 = makeToolCall('echo', { text: 'real-result' }, 'tc-1');
    const tc2 = makeToolCall('echo', { text: 'never-arrived' }, 'tc-2');

    const llm = new ScriptedStreamLLM([
      async (params) => {
        // Only tc-1 provably completes; the stream then "breaks off" with a
        // paused finish while tc-2 is still mid-arguments.
        void params.onToolCallReady?.(tc1);
        await waitFor(() => echo.calls.length === 1, 'echo started mid-stream');
        return {
          toolCalls: [tc1, tc2],
          providerFinishReason: 'paused',
          usage: zeroUsage(),
        };
      },
    ]);

    const { result, context } = await drive(llm, { tools: [echo] });
    expect(result.stopReason).toBe('paused');
    const results = context.toolResults();
    expect(results.map((r) => r.toolCallId)).toEqual(['tc-1', 'tc-2']);
    // The started call keeps its real result; the unstarted one is closed
    // with the synthetic interrupted output. No dangling tool_use.
    expect(results[0]?.result.output).toBe('real-result');
    expect(results[0]?.result.isError).toBeUndefined();
    expect(results[1]?.result.isError).toBe(true);
    expect(expectTextOutput(results[1]?.result.output)).toContain('not executed');
  });

  it('cancels an in-flight early execution on abort without recording a dangling call', async () => {
    const slow = markReadFileAccesses(new SlowTool());
    const controller = new AbortController();
    const tc = makeToolCall('slow', {}, 'tc-1');

    const llm = new ScriptedStreamLLM([
      async (params) => {
        void params.onToolCallReady?.(tc);
        await slow.started.promise;
        controller.abort();
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    ]);

    const { result, context } = await drive(llm, {
      tools: [slow],
      signal: controller.signal,
    });
    expect(result.stopReason).toBe('aborted');
    // The call was never announced: nothing dangles in the transcript.
    expect(context.toolCalls()).toHaveLength(0);
    expect(context.toolResults()).toHaveLength(0);
  });

  it('records the cancellation result when abort lands after the response completed', async () => {
    const slow = markReadFileAccesses(new SlowTool());
    const controller = new AbortController();
    const tc = makeToolCall('slow', {}, 'tc-1');

    const llm = new ScriptedStreamLLM([
      async (params) => {
        void params.onToolCallReady?.(tc);
        // Abort lands while the started execution is being drained.
        void slow.started.promise.then(() => {
          controller.abort();
        });
        return { toolCalls: [tc], providerFinishReason: 'tool_calls', usage: zeroUsage() };
      },
    ]);

    const { result, context } = await drive(llm, {
      tools: [slow],
      signal: controller.signal,
    });
    expect(result.stopReason).toBe('aborted');
    expect(context.toolCalls().map((e) => e.toolCallId)).toEqual(['tc-1']);
    const results = context.toolResults();
    expect(results.map((r) => r.toolCallId)).toEqual(['tc-1']);
    expect(results[0]?.result.isError).toBe(true);
    expect(expectTextOutput(results[0]?.result.output)).toContain('abort');
  });

  it('restores pure batch behavior when the switch is off', async () => {
    const echo = markReadFileAccesses(new EchoTool());
    const tc = makeToolCall('echo', { text: 'batch' }, 'tc-1');

    const llm = new ScriptedStreamLLM([
      async (params) => {
        void params.onToolCallReady?.(tc);
        await sleep(30);
        // Even a read-only call must not start while the stream is open.
        expect(echo.calls.length).toBe(0);
        return { toolCalls: [tc], providerFinishReason: 'tool_calls', usage: zeroUsage() };
      },
      endTurnScript(),
    ]);

    const { result, context } = await drive(llm, {
      tools: [echo],
      streamingToolExecution: false,
    });
    expect(result.stopReason).toBe('end_turn');
    expect(echo.calls.length).toBe(1);
    expect(context.toolResults().map((r) => r.toolCallId)).toEqual(['tc-1']);
    expect(context.toolResults()[0]?.result.output).toBe('batch');
  });

  it('discards a failed attempt’s preparations and records only the retried response’s calls', async () => {
    const echo = markReadFileAccesses(new EchoTool());
    const tcOld = makeToolCall('echo', { text: 'old-attempt' }, 'tc-old');
    const tcNew = makeToolCall('echo', { text: 'new-attempt' }, 'tc-new');

    const llm = new ScriptedStreamLLM(
      [
        async (params) => {
          void params.onToolCallReady?.(tcOld);
          throw new Error('stream dropped mid-response');
        },
        async () => ({
          toolCalls: [tcNew],
          providerFinishReason: 'tool_calls',
          usage: zeroUsage(),
        }),
        endTurnScript(),
      ],
      { retryableErrors: true },
    );

    const { context, sink } = await drive(llm, { tools: [echo] });
    // The orphan preparation may have executed (read-only, harmless), but no
    // event from the failed attempt reaches the transcript.
    expect(sink.byType('tool.call').map((e) => e.toolCallId)).toEqual(['tc-new']);
    expect(context.toolResults().map((r) => r.toolCallId)).toEqual(['tc-new']);
    expect(context.toolResults()[0]?.result.output).toBe('new-attempt');
  });

  it('keeps batch semantics for calls that stop the batch mid-stream', async () => {
    const echo = markReadFileAccesses(new EchoTool());
    const stop = markReadFileAccesses(new EchoTool());
    Object.defineProperty(stop, 'name', { value: 'stop-echo' });
    const stopExecution = stop.resolveExecution.bind(stop);
    stop.resolveExecution = (async (args: unknown) => {
      const execution = await Promise.resolve(stopExecution(args as { text: string }));
      return { ...execution, stopBatchAfterThis: true };
    }) as unknown as typeof stop.resolveExecution;
    const tcStop = makeToolCall('stop-echo', { text: 'halt' }, 'tc-stop');
    const tcEcho = makeToolCall('echo', { text: 'must not run' }, 'tc-echo');

    const llm = new ScriptedStreamLLM([
      async (params) => {
        void params.onToolCallReady?.(tcStop);
        void params.onToolCallReady?.(tcEcho);
        await sleep(30);
        // The batch-stopping call is not eligible for early start; the call
        // after it must be skipped exactly like the batch path does.
        expect(stop.calls.length).toBe(0);
        expect(echo.calls.length).toBe(0);
        return {
          toolCalls: [tcStop, tcEcho],
          providerFinishReason: 'tool_calls',
          usage: zeroUsage(),
        };
      },
    ]);

    const { result, context } = await drive(llm, { tools: [stop, echo] });
    expect(result.stopReason).toBe('end_turn');
    expect(stop.calls.length).toBe(1);
    expect(echo.calls.length).toBe(0);
    expect(context.toolResults().map((r) => r.toolCallId)).toEqual(['tc-stop', 'tc-echo']);
    expect(expectTextOutput(context.toolResults()[1]?.result.output)).toContain('skipped');
  });
});
