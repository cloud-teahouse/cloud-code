/**
 * Real-Session e2e for the coordinator-mode `<task-notification>` `<tool_uses>`
 * field: a worker's completion reports how many tool calls THAT worker's agent
 * dispatched — counted at the loop's `tool.call` dispatch point on the child
 * agent's own TurnFlow, so parallel workers and the coordinator itself never
 * leak into each other's counts. The counter is cumulative per worker agent
 * (matching the sibling `<total_tokens>` field's scope), so a resumed worker
 * reports its lifetime total.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import {
  isContentPart,
  isToolCall,
  type FinishReason,
  type Message,
  type ProviderConfig,
  type StreamedMessagePart,
} from '@cloud-code/kosong';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Agent, AgentOptions } from '../../src/agent';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { ProviderManager } from '../../src/session/provider-manager';
import { testKaos } from '../fixtures/test-kaos';

const MOCK_PROVIDER = { type: 'kimi', apiKey: 'test-key', model: 'mock-model' } as const satisfies ProviderConfig;

const tempDirs: string[] = [];
const openSessions: Session[] = [];

afterEach(async () => {
  await Promise.allSettled(openSessions.splice(0).map((s) => s.close()));
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

type GenerateFn = NonNullable<AgentOptions['generate']>;

const WORKER_PROBE = 'TOOL-USES-PROBE worker prompt';
/** Long enough to skip the subagent summary-continuation turn (>= 200 chars). */
const WORKER_FINAL =
  'TOOL-USES-DONE: probe complete. Both nested Agent attempts were denied by the ' +
  'coordinator-worker topology policy as expected, so there is nothing further to ' +
  'report back beyond this deliberately verbose final summary for the coordinator.';
const CALLS_PER_RUN = 2;

function messageText(message: Message | undefined): string | null {
  if (message === undefined) return null;
  return message.content
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : JSON.stringify(part)))
    .join('');
}

/**
 * Scripted model: a worker emits one nested Agent call per step until it has
 * received CALLS_PER_RUN tool results IN THE CURRENT RUN (tool-role messages
 * after the last user-role message — a resume prompt resets the window), then
 * finishes with a long final text. Coordinator mode denies every nested Agent
 * call via the topology policy, so nothing ever executes or spawns; the calls
 * still pass the loop's `tool.call` dispatch point and must be counted.
 */
function createProbeGenerate(): GenerateFn {
  let callSeq = 0;
  const generate: GenerateFn = async (_chat, _systemPrompt, _tools, history, callbacks, options) => {
    options?.signal?.throwIfAborted();
    options?.onRequestStart?.();

    const firstUserText = messageText(history.find((message) => message.role === 'user')) ?? '';
    const isWorker = firstUserText.includes(WORKER_PROBE);

    let parts: StreamedMessagePart[];
    if (isWorker) {
      const lastUserIndex = history.findLastIndex((message) => message.role === 'user');
      const toolResultsThisRun = history.slice(lastUserIndex + 1).filter((m) => m.role === 'tool').length;
      if (toolResultsThisRun < CALLS_PER_RUN) {
        callSeq += 1;
        parts = [
          {
            type: 'function',
            id: `call_probe_${String(callSeq)}`,
            name: 'Agent',
            arguments: JSON.stringify({
              description: 'nested spawn attempt',
              prompt: 'try to spawn a worker of my own',
            }),
          },
        ];
      } else {
        parts = [{ type: 'text', text: WORKER_FINAL }];
      }
    } else {
      parts = [{ type: 'text', text: 'main agent idle text' }];
    }

    for (const part of parts) {
      await callbacks?.onMessagePart?.(structuredClone(part));
      options?.signal?.throwIfAborted();
    }
    options?.onStreamEnd?.();

    const content = parts.filter((part) => isContentPart(part));
    const toolCalls = parts.filter((part) => isToolCall(part));
    const message: Message = {
      role: 'assistant',
      content: structuredClone(content),
      toolCalls: structuredClone(toolCalls),
    };
    const finishReason: FinishReason = toolCalls.length > 0 ? 'tool_calls' : 'completed';
    options?.onTraceId?.(null);
    return {
      id: 'mock-generate',
      message,
      usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
      finishReason,
      rawFinishReason: finishReason === 'completed' ? 'stop' : finishReason,
      traceId: null,
    };
  };
  return generate;
}

async function createMainAgent(
  generate: GenerateFn,
): Promise<{ session: Session; mainAgent: Agent }> {
  const sessionDir = await mkdtemp(join(tmpdir(), 'cloud-code-coordinator-tool-uses-e2e-'));
  tempDirs.push(sessionDir);
  const rpc: SDKSessionRPC = {
    emitEvent: vi.fn(async () => {}),
    requestApproval: vi.fn(async () => ({ decision: 'approved', selectedLabel: 'approve' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({ output: '', isError: true })),
  } as unknown as SDKSessionRPC;

  const session = new Session({
    id: 'coordinator-tool-uses-e2e',
    kaos: testKaos.withCwd(sessionDir),
    homedir: sessionDir,
    rpc,
    providerManager: new ProviderManager({
      config: {
        providers: { test: { type: MOCK_PROVIDER.type, apiKey: MOCK_PROVIDER.apiKey } },
        models: {
          [MOCK_PROVIDER.model]: { provider: 'test', model: MOCK_PROVIDER.model, maxContextSize: 1_000_000 },
        },
      },
    }),
  });
  openSessions.push(session);

  const mainProfile: ResolvedAgentProfile = {
    name: 'agent',
    systemPrompt: () => '<system-prompt>',
    tools: [],
  };
  const { agent: mainAgent } = await session.createAgent(
    { type: 'main', generate },
    { profile: mainProfile },
  );
  mainAgent.config.update({ modelAlias: MOCK_PROVIDER.model, thinkingEffort: 'off' });
  mainAgent.permission.setMode('yolo');
  return { session, mainAgent };
}

function spawnWorker(mainAgent: Agent, description: string) {
  return mainAgent.subagentHost!.spawn({
    profileName: 'coder',
    parentToolCallId: 'call_tool_uses_probe',
    prompt: WORKER_PROBE,
    description,
    runInBackground: true,
    signal: new AbortController().signal,
  });
}

describe('coordinator <tool_uses> accounting (real Session e2e)', () => {
  it('reports each worker’s own tool-call count, cumulative across resumes', async () => {
    const { session, mainAgent } = await createMainAgent(createProbeGenerate());
    mainAgent.coordinatorMode.enter();

    // Worker A's spawn run: two nested Agent calls in two steps.
    const handleA = await spawnWorker(mainAgent, 'tool-uses probe worker A');
    const outcomeA = await handleA.completion;
    expect(outcomeA.result).toBe(WORKER_FINAL);
    expect(outcomeA.toolUses).toBe(CALLS_PER_RUN);
    const childA = await session.ensureAgentResumed(handleA.agentId);
    expect(childA.turn.toolCallCount).toBe(CALLS_PER_RUN);

    // Resuming worker A runs the same two-call script again; the completion
    // reports the worker's cumulative count, like the sibling usage field.
    const resumedA = await mainAgent.subagentHost!.resume(handleA.agentId, {
      parentToolCallId: 'call_tool_uses_resume',
      prompt: `${WORKER_PROBE} — resume turn`,
      description: 'tool-uses probe resume A',
      runInBackground: true,
      signal: new AbortController().signal,
    });
    const outcomeResumedA = await resumedA.completion;
    expect(outcomeResumedA.toolUses).toBe(CALLS_PER_RUN * 2);
    expect(childA.turn.toolCallCount).toBe(CALLS_PER_RUN * 2);

    // Worker B's count is its own: untouched by A's calls or the parent's.
    const handleB = await spawnWorker(mainAgent, 'tool-uses probe worker B');
    const outcomeB = await handleB.completion;
    expect(outcomeB.toolUses).toBe(CALLS_PER_RUN);
    expect(handleB.agentId).not.toBe(handleA.agentId);

    // The coordinator itself never dispatched a tool call.
    expect(mainAgent.turn.toolCallCount).toBe(0);
  });
});
