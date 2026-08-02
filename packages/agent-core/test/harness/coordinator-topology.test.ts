/**
 * Real-Session e2e for the coordinator-mode topology constraint:
 * a worker spawned while the parent is in coordinator mode is latched as a
 * coordinator worker, and its own Agent/AgentSwarm calls are denied by the
 * permission chain — the agent graph stays two levels deep. A subagent
 * spawned outside coordinator mode keeps plain nesting capabilities.
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

const WORKER_PROBE = 'TOPOLOGY-PROBE worker prompt';
const CHILD_FINAL =
  'TOPOLOGY-DONE: my nested Agent call was denied by the coordinator-worker topology policy; ' +
  'reporting back to the coordinator instead of spawning help.';

function toolText(message: Message | undefined): string | null {
  if (message === undefined) return null;
  return message.content
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : JSON.stringify(part)))
    .join('');
}

interface ProbeState {
  nestedDenied: string | null;
}

/**
 * Scripted model: every worker turn whose latest message is a user prompt
 * attempts a nested Agent call; the turn after (latest message is the tool
 * result) captures that result and finishes. Symmetric across spawn and
 * resume — each resume re-attempts the nested spawn, so the test observes
 * the topology latch as it stands at THAT run's start.
 */
function createProbeGenerate(state: ProbeState): GenerateFn {
  const generate: GenerateFn = async (_chat, _systemPrompt, _tools, history, callbacks, options) => {
    options?.signal?.throwIfAborted();
    options?.onRequestStart?.();

    const firstUserText = toolText(history.find((message) => message.role === 'user')) ?? '';
    const isWorker = firstUserText.includes(WORKER_PROBE);

    let parts: StreamedMessagePart[];
    if (isWorker) {
      const lastMessage = history.at(-1);
      if (lastMessage?.role === 'tool') {
        state.nestedDenied = toolText(lastMessage);
        parts = [{ type: 'text', text: CHILD_FINAL }];
      } else {
        parts = [
          {
            type: 'function',
            id: 'call_nested_agent',
            name: 'Agent',
            arguments: JSON.stringify({
              description: 'nested spawn attempt',
              prompt: 'try to spawn a worker of my own',
            }),
          },
        ];
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
  const sessionDir = await mkdtemp(join(tmpdir(), 'cloud-code-coordinator-topology-e2e-'));
  tempDirs.push(sessionDir);
  const rpc: SDKSessionRPC = {
    emitEvent: vi.fn(async () => {}),
    // auto-approvals must NOT unlock the topology deny: the policy runs above
    // every approve policy, so this approval handler is never even consulted
    // for the nested Agent call.
    requestApproval: vi.fn(async () => ({ decision: 'approved', selectedLabel: 'approve' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({ output: '', isError: true })),
  } as unknown as SDKSessionRPC;

  const session = new Session({
    id: 'coordinator-topology-e2e',
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

function spawnWorker(mainAgent: Agent): Promise<{
  readonly agentId: string;
  readonly completion: Promise<{ result: string }>;
}> {
  const handle = mainAgent.subagentHost!.spawn({
    profileName: 'coder',
    parentToolCallId: 'call_topology_probe',
    prompt: WORKER_PROBE,
    description: 'topology probe worker',
    runInBackground: true,
    signal: new AbortController().signal,
  });
  return handle;
}

function resumeWorker(mainAgent: Agent, agentId: string): Promise<{
  readonly agentId: string;
  readonly completion: Promise<{ result: string }>;
}> {
  return mainAgent.subagentHost!.resume(agentId, {
    parentToolCallId: 'call_topology_resume',
    prompt: `${WORKER_PROBE} — resume turn`,
    description: 'topology probe resume',
    runInBackground: true,
    signal: new AbortController().signal,
  });
}

describe('coordinator mode topology constraint (real Session e2e)', () => {
  it('latches workers spawned under coordinator mode and denies their nested Agent calls', async () => {
    const state: ProbeState = { nestedDenied: null };
    const { session, mainAgent } = await createMainAgent(createProbeGenerate(state));
    mainAgent.coordinatorMode.enter();

    const handle = await spawnWorker(mainAgent);
    const child = await session.ensureAgentResumed(handle.agentId);
    expect(child.isCoordinatorWorker).toBe(true);

    const outcome = await handle.completion;
    expect(outcome.result).toBe(CHILD_FINAL);
    // The nested Agent call was rejected by the deny policy, and the worker
    // saw the topology explanation in the tool result.
    expect(state.nestedDenied).toContain('cannot spawn other workers');
  });

  it('does not latch subagents spawned outside coordinator mode', async () => {
    const state: ProbeState = { nestedDenied: null };
    const { session, mainAgent } = await createMainAgent(createProbeGenerate(state));
    expect(mainAgent.coordinatorMode.isActive).toBe(false);

    const handle = await spawnWorker(mainAgent);
    const child = await session.ensureAgentResumed(handle.agentId);
    expect(child.isCoordinatorWorker).toBe(false);
    // The worker finishes; its nested Agent call was NOT blocked by the
    // coordinator topology policy (it may fail for other reasons in this
    // scripted harness, but never with the topology message).
    await handle.completion;
    expect(state.nestedDenied ?? '').not.toContain('cannot spawn other workers');
  });

  it('re-latches on resume: a worker resumed after the parent left coordinator mode regains plain capabilities', async () => {
    const state: ProbeState = { nestedDenied: null };
    const { session, mainAgent } = await createMainAgent(createProbeGenerate(state));
    mainAgent.coordinatorMode.enter();

    const handle = await spawnWorker(mainAgent);
    await handle.completion;
    const child = await session.ensureAgentResumed(handle.agentId);
    expect(child.isCoordinatorWorker).toBe(true);
    expect(state.nestedDenied).toContain('cannot spawn other workers');

    // Parent exits coordinator mode; the resume re-latch clears the marker,
    // and the resumed run's nested Agent call is no longer topology-denied.
    mainAgent.coordinatorMode.exit();
    const resumed = await resumeWorker(mainAgent, handle.agentId);
    await resumed.completion;
    expect(child.isCoordinatorWorker).toBe(false);
    expect(state.nestedDenied ?? '').not.toContain('cannot spawn other workers');
  });

  it('re-latches on resume: a plain subagent resumed under a coordinator parent is constrained again', async () => {
    const state: ProbeState = { nestedDenied: null };
    const { session, mainAgent } = await createMainAgent(createProbeGenerate(state));

    const handle = await spawnWorker(mainAgent);
    await handle.completion;
    const child = await session.ensureAgentResumed(handle.agentId);
    expect(child.isCoordinatorWorker).toBe(false);
    expect(state.nestedDenied ?? '').not.toContain('cannot spawn other workers');

    // Parent enters coordinator mode; the resume re-latch sets the marker,
    // and the resumed run's nested Agent call is denied by the policy.
    mainAgent.coordinatorMode.enter();
    const resumed = await resumeWorker(mainAgent, handle.agentId);
    await resumed.completion;
    expect(child.isCoordinatorWorker).toBe(true);
    expect(state.nestedDenied).toContain('cannot spawn other workers');
  });
});
