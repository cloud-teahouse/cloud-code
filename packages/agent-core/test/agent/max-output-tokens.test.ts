/**
 * Turn-level coverage for the max_output_tokens recovery chain (Claude-Code
 * `query.ts` port): pure-text truncation first escalates the completion cap
 * once per turn and retries; continued truncation then injects a meta resume
 * message, bounded to 3 continuations per turn.
 *
 * The effective request cap is provider-clamped to the remaining context
 * window, so turn-level assertions key off the KosongLLM override method and
 * the injected recovery message rather than raw cap numbers; cap mechanics
 * are covered directly in `kosong-llm.test.ts`.
 */

import {
  isContentPart,
  isToolCall,
  type FinishReason,
  type Message,
  type ModelCapability,
  type StreamedMessagePart,
} from '@cloud-code/kosong';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentOptions } from '../../src/agent';
import { KosongLLM } from '../../src/agent/turn/kosong-llm';
import { testAgent } from './harness/agent';

type GenerateFn = NonNullable<AgentOptions['generate']>;

const RECOVERY_PROMPT_FRAGMENT = 'Output token limit hit. Resume directly';
const ESCALATED_CAP = 64_000;
/** Small context window: the normal cap (8k) is below the escalation target. */
const SMALL_CONTEXT: ModelCapability = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: 8_192,
};

interface CapturedCall {
  readonly history: Message[];
}

interface ScriptedStep {
  readonly parts: StreamedMessagePart[];
  readonly finishReason?: FinishReason | undefined;
}

function createScriptedGenerate(steps: ScriptedStep[]): {
  generate: GenerateFn;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const generate: GenerateFn = async (_provider, _system, _tools, history, callbacks, options) => {
    options?.onRequestStart?.();
    calls.push({ history: structuredClone(history) });
    const step = steps.shift();
    if (step === undefined) {
      throw new Error(`Unexpected generate call #${String(calls.length)}`);
    }
    const content = step.parts.filter((part) => isContentPart(part));
    const toolCalls = step.parts.filter((part) => isToolCall(part));
    const message: Message = {
      role: 'assistant',
      content: structuredClone(content),
      toolCalls: structuredClone(toolCalls),
    };
    for (const part of step.parts) {
      await callbacks?.onMessagePart?.(structuredClone(part));
      options?.signal?.throwIfAborted();
    }
    options?.onStreamEnd?.();
    return {
      id: `mock-${String(calls.length)}`,
      message,
      usage: { inputOther: 10, output: 10, inputCacheRead: 0, inputCacheCreation: 0 },
      finishReason: step.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'completed'),
      rawFinishReason: null,
    };
  };
  return { generate, calls };
}

function textStep(text: string, finishReason: FinishReason): ScriptedStep {
  return { parts: [{ type: 'text', text }], finishReason };
}

function overrideSpy() {
  return vi.spyOn(KosongLLM.prototype, 'setCompletionBudgetHardCapOverride');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('max_output_tokens recovery chain', () => {
  it('escalates the completion cap once and retries without a meta message', async () => {
    const spy = overrideSpy();
    const { generate, calls } = createScriptedGenerate([
      textStep('chunk one, cut off mid', 'truncated'),
      textStep('chunk one, fully written now.', 'completed'),
    ]);
    const ctx = testAgent({ generate });
    ctx.configure({ modelCapabilities: SMALL_CONTEXT });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'write something long' }] });
    const events = await ctx.untilTurnEnd();

    expect(calls).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(ESCALATED_CAP);
    // No meta message is injected for the escalating retry.
    expect(JSON.stringify(calls[1]?.history)).not.toContain(RECOVERY_PROMPT_FRAGMENT);
    expect(JSON.stringify(events)).toContain('"reason":"completed"');
  });

  it('injects a meta recovery message when escalation still truncates', async () => {
    const spy = overrideSpy();
    const { generate, calls } = createScriptedGenerate([
      textStep('chunk one, cut', 'truncated'),
      textStep('chunk one, still cut at 64k', 'truncated'),
      textStep(' and the final piece.', 'completed'),
    ]);
    const ctx = testAgent({ generate });
    ctx.configure({ modelCapabilities: SMALL_CONTEXT });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'write something long' }] });
    await ctx.untilTurnEnd();

    expect(calls).toHaveLength(3);
    // Escalated once, then the override is cleared so continuations run at the
    // configured budget again.
    expect(spy).toHaveBeenNthCalledWith(1, ESCALATED_CAP);
    expect(spy).toHaveBeenNthCalledWith(2, undefined);
    // The recovery continuation request carries the meta resume message.
    const thirdHistory = JSON.stringify(calls[2]?.history);
    expect(thirdHistory).toContain(RECOVERY_PROMPT_FRAGMENT);
    const historyText = JSON.stringify(ctx.agent.context.data().history);
    expect(historyText).toContain('max_output_tokens_recovery');
    expect(historyText.match(/Output token limit hit/g)).toHaveLength(1);
  });

  it('stops recovering after 3 meta continuations and ends the turn', async () => {
    overrideSpy();
    const { generate, calls } = createScriptedGenerate([
      textStep('cut 1', 'truncated'),
      textStep('cut 2', 'truncated'),
      textStep('cut 3', 'truncated'),
      textStep('cut 4', 'truncated'),
      textStep('cut 5', 'truncated'),
    ]);
    const ctx = testAgent({ generate });
    ctx.configure({ modelCapabilities: SMALL_CONTEXT });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'write something endless' }] });
    const events = await ctx.untilTurnEnd();

    // 1 initial + 1 escalation + 3 recovery continuations; no sixth request.
    expect(calls).toHaveLength(5);
    const historyText = JSON.stringify(ctx.agent.context.data().history);
    expect(historyText.match(/Output token limit hit/g)).toHaveLength(3);
    // The turn ends (not fails) once recovery is exhausted; the subagent-host
    // max_tokens special case keys off this same 'max_tokens' stop reason.
    expect(JSON.stringify(events)).toContain('"reason":"completed"');
  });

  it('does not recover a truncation that still carries tool calls', async () => {
    const spy = overrideSpy();
    const { generate, calls } = createScriptedGenerate([
      {
        parts: [
          { type: 'text', text: 'running a tool, then cut' },
          {
            type: 'function',
            id: 'call_bash',
            name: 'Bash',
            arguments: '{"command":"printf hi"}',
          },
        ],
        finishReason: 'truncated',
      },
    ]);
    const ctx = testAgent({ generate });
    ctx.configure({ tools: ['Bash'], modelCapabilities: SMALL_CONTEXT });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run a tool' }] });
    await ctx.untilTurnEnd();

    expect(calls).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify(ctx.agent.context.data().history)).not.toContain(
      RECOVERY_PROMPT_FRAGMENT,
    );
  });

  it('skips escalation when the user explicitly capped completion tokens', async () => {
    vi.stubEnv('KIMI_MODEL_MAX_COMPLETION_TOKENS', '4096');
    const spy = overrideSpy();
    const { generate, calls } = createScriptedGenerate([
      textStep('chunk one, cut', 'truncated'),
      textStep(' and the rest.', 'completed'),
    ]);
    const ctx = testAgent({ generate });
    ctx.configure({ modelCapabilities: SMALL_CONTEXT });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'write something long' }] });
    await ctx.untilTurnEnd();

    // User intent wins: no escalation — the first continuation is already the
    // meta recovery path.
    expect(spy).not.toHaveBeenCalledWith(ESCALATED_CAP);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]?.history)).toContain(RECOVERY_PROMPT_FRAGMENT);
  });
});
