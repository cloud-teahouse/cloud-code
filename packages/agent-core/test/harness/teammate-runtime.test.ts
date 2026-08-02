/**
 * Real-Session e2e for the in-process teammate runtime and the
 * topology guards:
 *  - a teammate spawned through the Agent tool runs its whole turn inside
 *    the AsyncLocalStorage teammate context, is latched on the child agent,
 *    and surfaces in the leader's BackgroundManager with teammate metadata;
 *  - concurrent teammates stay isolated from each other;
 *  - stopping the task aborts the teammate's run (lifecycle);
 *  - a teammate's own nested teammate spawn and background-agent launch are
 *    denied by the permission chain, while plain foreground subagent spawns
 *    stay allowed;
 *  - resume re-establishes the same identity and guards.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { createControlledPromise, type ControlledPromise } from '@antfu/utils';
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
import {
  getTeammateContext,
  type TeammateContext,
} from '../../src/agent/swarm/teammate-context';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { ProviderManager } from '../../src/session/provider-manager';
import { AgentTool } from '../../src/tools/builtin/collaboration/agent';
import { testKaos } from '../fixtures/test-kaos';
import { executeTool } from '../tools/fixtures/execute-tool';

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

const MARKER_PATTERN = /TEAMMATE-PROBE:[a-z-]+/;
const FINAL_PREFIX = 'TEAMMATE-DONE: ';
const NESTED_TEAMMATE_DENY = 'cannot spawn other teammates';
const BACKGROUND_AGENT_DENY = 'cannot launch background agents';

/** Summaries below 200 chars trigger a continuation turn; stay above it. */
function finalText(note: string): string {
  return `${FINAL_PREFIX}${note} `.repeat(8);
}

function toolText(message: Message | undefined): string | null {
  if (message === undefined) return null;
  return message.content
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : JSON.stringify(part)))
    .join('');
}

interface ProbeState {
  /** Teammate contexts captured inside child turns, keyed by probe marker. */
  readonly contexts: Map<string, TeammateContext | undefined>;
  /** Last tool-result text seen after a nested Agent call, per marker. */
  readonly nestedResults: Map<string, string | null>;
  /** Released by the test to unpark `|wait` teammates. */
  readonly barrier: ControlledPromise<void>;
}

function createProbeState(): ProbeState {
  return {
    contexts: new Map(),
    nestedResults: new Map(),
    barrier: createControlledPromise<void>(),
  };
}

/**
 * Scripted model shared by the leader and every child. Turns are keyed off
 * the FIRST user message, which carries the probe directive as
 * `TEAMMATE-PROBE:<name>[|<directive>]`:
 *  - no directive: capture the teammate context and finish;
 *  - `|wait`: capture the context, park on the test barrier, then finish;
 *  - `|park`: capture the context, then park until the turn aborts
 *    (lifecycle probe);
 *  - `|nested:{...}`: emit an Agent tool call with those arguments; on the
 *    following turn (last message is the tool result) capture the result
 *    text and the live context, then finish (guard probe).
 * Anything else (leader turns, nested grandchildren) returns idle text.
 */
function createProbeGenerate(state: ProbeState): GenerateFn {
  const generate: GenerateFn = async (_chat, _systemPrompt, _tools, history, callbacks, options) => {
    options?.signal?.throwIfAborted();
    options?.onRequestStart?.();

    const firstUserText = toolText(history.find((message) => message.role === 'user')) ?? '';
    const marker = MARKER_PATTERN.exec(firstUserText)?.[0] ?? null;

    let parts: StreamedMessagePart[];
    if (marker !== null) {
      const lastMessage = history.at(-1);
      const directive = firstUserText.split('|')[1] ?? '';
      if (lastMessage?.role === 'tool') {
        state.nestedResults.set(marker, toolText(lastMessage));
        state.contexts.set(marker, getTeammateContext());
        parts = [{ type: 'text', text: finalText(`${marker} nested result observed`) }];
      } else if (directive.startsWith('nested:')) {
        parts = [
          {
            type: 'function',
            id: `call_nested_${marker}`,
            name: 'Agent',
            arguments: directive.slice('nested:'.length),
          },
        ];
      } else {
        state.contexts.set(marker, getTeammateContext());
        if (directive === 'wait') {
          await state.barrier;
        } else if (directive === 'park') {
          const signal = options?.signal;
          if (signal !== undefined) {
            await new Promise<never>((_resolve, reject) => {
              if (signal.aborted) {
                reject(signal.reason as unknown);
                return;
              }
              signal.addEventListener('abort', () => reject(signal.reason as unknown), {
                once: true,
              });
            });
          }
        }
        parts = [{ type: 'text', text: finalText(`${marker} finished`) }];
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
  const sessionDir = await mkdtemp(join(tmpdir(), 'cloud-code-teammate-runtime-e2e-'));
  tempDirs.push(sessionDir);
  const rpc: SDKSessionRPC = {
    emitEvent: vi.fn(async () => {}),
    // auto-approvals must NOT unlock the topology denies: the policy runs
    // above every approve policy, so this handler is never even consulted
    // for the guarded calls.
    requestApproval: vi.fn(async () => ({ decision: 'approved', selectedLabel: 'approve' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({ output: '', isError: true })),
  } as unknown as SDKSessionRPC;

  const session = new Session({
    id: 'teammate-runtime-e2e',
    kaos: testKaos.withCwd(sessionDir),
    homedir: sessionDir,
    rpc,
    // These suites pin the runtime semantics: one prompt to
    // completion. Keep-alive has its own harness suite.
    teammate: { idleTimeoutMs: 0 },
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

const toolSignal = new AbortController().signal;

/**
 * Spawn a teammate through the Agent tool (the production wiring) with the
 * probe directive as its prompt. `probe` is `<name>[|<directive>]`; the
 * teammate's name is the part before `|`.
 */
async function spawnTeammate(
  mainAgent: Agent,
  probe: string,
  options: { readonly teamName?: string } = {},
): Promise<{ readonly taskId: string; readonly agentId: string }> {
  const tool = new AgentTool(mainAgent.subagentHost!, mainAgent.background);
  const result = await executeTool(tool, {
    turnId: '0',
    toolCallId: 'call_teammate',
    args: {
      prompt: `TEAMMATE-PROBE:${probe}`,
      description: `probe ${probe}`,
      name: probe.split('|')[0],
      team_name: options.teamName,
    },
    signal: toolSignal,
  });
  expect(result.isError).toBeUndefined();
  if (typeof result.output !== 'string') throw new TypeError('expected string output');
  const taskId = /task_id: (agent-[0-9a-z]{8})/.exec(result.output)?.[1];
  const agentId = /agent_id: ([\w-]+)/.exec(result.output)?.[1];
  expect(taskId).toBeDefined();
  expect(agentId).toBeDefined();
  return { taskId: taskId!, agentId: agentId! };
}

describe('in-process teammate runtime (real Session e2e)', () => {
  it('runs the teammate turn inside its AsyncLocalStorage context and registers a metadata-carrying task', async () => {
    const state = createProbeState();
    const { session, mainAgent } = await createMainAgent(createProbeGenerate(state));

    const { taskId, agentId } = await spawnTeammate(mainAgent, 'alpha', { teamName: 'core' });
    await mainAgent.background.wait(taskId);

    const ctx = state.contexts.get('TEAMMATE-PROBE:alpha');
    expect(ctx).toMatchObject({
      agentId,
      parentAgentId: 'main',
      name: 'alpha',
      teamName: 'core',
      isInProcess: true,
    });
    // The scope is per-run: nothing leaks into the leader's call stack.
    expect(getTeammateContext()).toBeUndefined();

    const child = await session.ensureAgentResumed(agentId);
    expect(child.isTeammate).toBe(true);
    expect(child.teammate).toEqual({ name: 'alpha', teamName: 'core' });
    expect(session.metadata.agents[agentId]?.teammate).toEqual({ name: 'alpha', teamName: 'core' });

    expect(mainAgent.background.getTask(taskId)).toMatchObject({
      kind: 'agent',
      status: 'completed',
      detached: true,
      agentId,
      teammate: { name: 'alpha', teamName: 'core' },
    });
  });

  it('keeps concurrent teammates isolated', async () => {
    const state = createProbeState();
    const { mainAgent } = await createMainAgent(createProbeGenerate(state));

    // Both teammates park on the barrier inside their first turn, so both
    // are provably mid-run at the same time before either finishes.
    const first = await spawnTeammate(mainAgent, 'one|wait');
    const second = await spawnTeammate(mainAgent, 'two|wait');
    await vi.waitFor(() => {
      expect(state.contexts.size).toBe(2);
    });
    state.barrier.resolve();

    await Promise.all([
      mainAgent.background.wait(first.taskId),
      mainAgent.background.wait(second.taskId),
    ]);

    const one = state.contexts.get('TEAMMATE-PROBE:one');
    const two = state.contexts.get('TEAMMATE-PROBE:two');
    expect(one?.name).toBe('one');
    expect(two?.name).toBe('two');
    expect(one?.agentId).toBe(first.agentId);
    expect(two?.agentId).toBe(second.agentId);
    expect(one?.abortController).not.toBe(two?.abortController);
    expect(getTeammateContext()).toBeUndefined();
  });

  it('aborts the teammate run when its task is stopped', async () => {
    const state = createProbeState();
    const { mainAgent } = await createMainAgent(createProbeGenerate(state));

    const { taskId } = await spawnTeammate(mainAgent, 'parker|park');
    await vi.waitFor(() => {
      expect(state.contexts.has('TEAMMATE-PROBE:parker')).toBe(true);
    });

    const stopped = await mainAgent.background.stop(taskId, 'test stop');
    expect(stopped?.status).toBe('killed');

    const ctx = state.contexts.get('TEAMMATE-PROBE:parker');
    expect(ctx?.abortController.signal.aborted).toBe(true);
  });

  it('denies a nested teammate spawn from inside a teammate', async () => {
    const state = createProbeState();
    const { mainAgent } = await createMainAgent(createProbeGenerate(state));

    const { taskId } = await spawnTeammate(
      mainAgent,
      'nester|nested:{"description":"nested","prompt":"spawn help","name":"helper"}',
    );
    await mainAgent.background.wait(taskId);

    expect(state.nestedResults.get('TEAMMATE-PROBE:nester')).toContain(NESTED_TEAMMATE_DENY);
  });

  it('denies a background agent launch from inside a teammate', async () => {
    const state = createProbeState();
    const { mainAgent } = await createMainAgent(createProbeGenerate(state));

    const { taskId } = await spawnTeammate(
      mainAgent,
      'bger|nested:{"description":"nested","prompt":"detach","run_in_background":true}',
    );
    await mainAgent.background.wait(taskId);

    expect(state.nestedResults.get('TEAMMATE-PROBE:bger')).toContain(BACKGROUND_AGENT_DENY);
  });

  it('allows a plain foreground subagent spawn from inside a teammate', async () => {
    const state = createProbeState();
    const { mainAgent } = await createMainAgent(createProbeGenerate(state));

    const { taskId } = await spawnTeammate(
      mainAgent,
      'plain|nested:{"description":"nested","prompt":"do bounded work"}',
    );
    await mainAgent.background.wait(taskId);

    const nested = state.nestedResults.get('TEAMMATE-PROBE:plain') ?? '';
    expect(nested).not.toContain(NESTED_TEAMMATE_DENY);
    expect(nested).not.toContain(BACKGROUND_AGENT_DENY);
  });

  it('re-establishes identity and guards on resume', async () => {
    const state = createProbeState();
    const { session, mainAgent } = await createMainAgent(createProbeGenerate(state));

    const probe = 'reviver|nested:{"description":"nested","prompt":"spawn help","name":"helper"}';
    const { taskId, agentId } = await spawnTeammate(mainAgent, probe);
    await mainAgent.background.wait(taskId);
    expect(state.nestedResults.get('TEAMMATE-PROBE:reviver')).toContain(NESTED_TEAMMATE_DENY);

    const child = await session.ensureAgentResumed(agentId);
    expect(child.isTeammate).toBe(true);

    state.nestedResults.delete('TEAMMATE-PROBE:reviver');
    state.contexts.delete('TEAMMATE-PROBE:reviver');
    const resumed = await mainAgent.subagentHost!.resume(agentId, {
      parentToolCallId: 'call_teammate_resume',
      prompt: `TEAMMATE-PROBE:${probe}`,
      description: 'probe reviver resume',
      runInBackground: true,
      signal: new AbortController().signal,
    });
    await resumed.completion;

    // The resumed run was scoped and latched again: same identity, same deny.
    expect(child.isTeammate).toBe(true);
    expect(child.teammate).toEqual({ name: 'reviver', teamName: undefined });
    expect(state.contexts.get('TEAMMATE-PROBE:reviver')).toMatchObject({
      agentId,
      name: 'reviver',
      isInProcess: true,
    });
    expect(state.nestedResults.get('TEAMMATE-PROBE:reviver')).toContain(NESTED_TEAMMATE_DENY);
  });

  it('does not latch plain subagents as teammates', async () => {
    const state = createProbeState();
    const { session, mainAgent } = await createMainAgent(createProbeGenerate(state));

    const handle = await mainAgent.subagentHost!.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_plain_sub',
      prompt: 'TEAMMATE-PROBE:drifter',
      description: 'plain subagent probe',
      runInBackground: true,
      signal: new AbortController().signal,
    });
    await handle.completion;

    const child = await session.ensureAgentResumed(handle.agentId);
    expect(child.isTeammate).toBe(false);
    expect(child.teammate).toBeUndefined();
    expect(session.metadata.agents[handle.agentId]?.teammate).toBeUndefined();
    expect(state.contexts.get('TEAMMATE-PROBE:drifter')).toBeUndefined();
  });
});
