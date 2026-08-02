/**
 * Real-Session e2e for the teammate idle keep-alive:
 *  - claim-after-idle: a task posted after the teammate's prompt turn is
 *    picked up inside the SAME run via a nudge turn (claimed and completed
 *    through the real turn loop, identity from the ALS teammate context);
 *  - mailbox wake: an unread message keeps the run alive and is delivered
 *    into the nudge turn by the per-run watcher;
 *  - bounded idle: with nothing to pick up, the run exits cleanly after
 *    `idleTimeoutMs` instead of holding the task open;
 *  - stagnation guard: unclaimed work the model keeps ignoring stops being
 *    nudged after MAX_STAGNANT_NUDGES turns and the run exits.
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
import { MAX_STAGNANT_NUDGES } from '../../src/agent/swarm/teammate-keepalive';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session, type SessionOptions } from '../../src/session';
import { ProviderManager } from '../../src/session/provider-manager';
import { AgentTool } from '../../src/tools/builtin/collaboration/agent';
import { TeamTaskCreateTool } from '../../src/tools/builtin/collaboration/team-task-create';
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

const IDLE_NOTE = 'KEEPALIVE-IDLE';
const DONE_PREFIX = 'KEEPALIVE-DONE: ';
/** The keep-alive nudge prefix (mirrors teammate-keepalive.ts). */
const NUDGE_MARKER = 'Your team has work for you';

/** Summaries below 200 chars trigger a continuation turn; stay above it. */
function longText(note: string): string {
  return `${note} `.repeat(12);
}

function messageText(message: Message | undefined): string | null {
  if (message === undefined) return null;
  return message.content
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : JSON.stringify(part)))
    .join('');
}

interface ProbeState {
  /** Nudge turns the model has seen (last user message = keep-alive nudge). */
  nudgeTurns: number;
  /** Total generate calls (any turn). */
  calls: number;
  /** True between a nudge turn's first call and its final text. */
  inNudgeFlow: boolean;
  /** Set when a turn's history contains a delivered <teammate-message>. */
  sawMailboxDelivery: boolean;
  claimResults: string[];
  updateResults: string[];
  /** When true, the nudge turn claims+completes instead of idling. */
  claimOnNudge: boolean;
}

/**
 * Scripted model. The spawn prompt gets a long idle text. A keep-alive nudge
 * turn (last user message starts with the nudge marker) either claims and
 * completes the task (claimOnNudge) or idles again (stagnation probe); the
 * claim choreography spans several steps of the same nudge turn, tracked via
 * `inNudgeFlow`. Any turn whose history contains a delivered mailbox message
 * records it.
 */
function createProbeGenerate(state: ProbeState): GenerateFn {
  const generate: GenerateFn = async (_chat, _systemPrompt, _tools, history, callbacks, options) => {
    options?.signal?.throwIfAborted();
    options?.onRequestStart?.();
    state.calls += 1;

    if (history.some((message) => (messageText(message) ?? '').includes('<teammate-message'))) {
      state.sawMailboxDelivery = true;
    }

    const lastText = messageText(history.at(-1)) ?? '';
    if (lastText.includes(NUDGE_MARKER)) {
      state.nudgeTurns += 1;
      state.inNudgeFlow = true;
    }

    let parts: StreamedMessagePart[];
    if (state.inNudgeFlow && state.claimOnNudge) {
      if (lastText.includes('Claimed task')) {
        state.claimResults.push(lastText);
        const taskId = /Claimed task #(\d+)/.exec(lastText)?.[1] ?? '0';
        parts = [
          {
            type: 'function',
            id: 'call_keepalive_update',
            name: 'TeamTaskUpdate',
            arguments: JSON.stringify({ task_id: Number(taskId), status: 'completed' }),
          },
        ];
      } else if (lastText.includes('Updated task')) {
        state.updateResults.push(lastText);
        state.inNudgeFlow = false;
        parts = [{ type: 'text', text: longText(`${DONE_PREFIX}claimed after idle`) }];
      } else {
        parts = [
          {
            type: 'function',
            id: 'call_keepalive_claim',
            name: 'TeamTaskClaim',
            arguments: '{}',
          },
        ];
      }
    } else {
      state.inNudgeFlow = false;
      parts = [{ type: 'text', text: longText(IDLE_NOTE) }];
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
  teammateOptions?: SessionOptions['teammate'],
): Promise<{ session: Session; mainAgent: Agent; sessionDir: string }> {
  const sessionDir = await mkdtemp(join(tmpdir(), 'cloud-code-keepalive-e2e-'));
  tempDirs.push(sessionDir);
  const rpc: SDKSessionRPC = {
    emitEvent: vi.fn(async () => {}),
    requestApproval: vi.fn(async () => ({ decision: 'approved', selectedLabel: 'approve' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({ output: '', isError: true })),
  } as unknown as SDKSessionRPC;

  const session = new Session({
    id: 'teammate-keepalive-e2e',
    kaos: testKaos.withCwd(sessionDir),
    homedir: sessionDir,
    rpc,
    mailbox: { pollIntervalMs: 25 },
    teammate: teammateOptions,
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
  return { session, mainAgent, sessionDir };
}

const toolSignal = new AbortController().signal;

async function spawnTeammate(
  mainAgent: Agent,
  name: string,
  teamName: string,
  prompt: string,
): Promise<{ readonly taskId: string; readonly agentId: string }> {
  const tool = new AgentTool(mainAgent.subagentHost!, mainAgent.background);
  const result = await executeTool(tool, {
    turnId: '0',
    toolCallId: 'call_teammate',
    args: { prompt, description: `probe ${name}`, name, team_name: teamName },
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function probeState(claimOnNudge: boolean): ProbeState {
  return {
    nudgeTurns: 0,
    calls: 0,
    inNudgeFlow: false,
    sawMailboxDelivery: false,
    claimResults: [],
    updateResults: [],
    claimOnNudge,
  };
}

describe('teammate idle keep-alive (real Session e2e)', () => {
  it('picks up a task posted after the prompt turn, inside the same run', async () => {
    const state = probeState(true);
    const { session, mainAgent } = await createMainAgent(createProbeGenerate(state), {
      idleTimeoutMs: 500,
      pollIntervalMs: 50,
    });

    const { taskId } = await spawnTeammate(mainAgent, 'researcher', 'core', 'probe: idle first');
    // The task lands while the teammate is already running — before
    // keep-alive the run would have ended with the prompt turn and the task
    // would have waited for a resume.
    const createTool = new TeamTaskCreateTool(session.teamStore);
    const created = await executeTool(createTool, {
      turnId: '0',
      toolCallId: 'call_create',
      args: { team_name: 'core', subject: 'Late-arriving work' },
      signal: toolSignal,
    });
    expect(created.isError).toBeUndefined();

    await mainAgent.background.wait(taskId);

    // The keep-alive nudge drove a real claim → update → completion flow.
    expect(state.nudgeTurns).toBeGreaterThanOrEqual(1);
    expect(state.claimResults.join('\n')).toContain('Claimed task #1');
    expect(state.updateResults.join('\n')).toContain('status: completed');
    const tasks = await session.teamStore.listTasks('core');
    expect(tasks?.[0]).toMatchObject({ id: 1, status: 'completed', owner: 'researcher' });
  });

  it('delivers unread mailbox messages into the wake-up nudge turn', async () => {
    const state = probeState(false);
    const { session, mainAgent } = await createMainAgent(createProbeGenerate(state), {
      idleTimeoutMs: 500,
      pollIntervalMs: 50,
    });

    const { taskId, agentId } = await spawnTeammate(mainAgent, 'researcher', 'core', 'probe: idle first');
    const child = session.getReadyAgent(agentId);
    expect(child).toBeDefined();

    // Wait for the spawn turn to have run and settled, then a beat for the
    // keep-alive loop to enter its poll sleep — the message then stays
    // UNREAD (the teammate watcher only delivers into an active turn) and
    // the keep-alive loop is the path that wakes the teammate up.
    for (let i = 0; i < 400 && state.calls === 0; i += 1) await sleep(5);
    expect(state.calls).toBeGreaterThan(0);
    for (let i = 0; i < 400 && child!.turn.hasActiveTurn; i += 1) await sleep(5);
    expect(child!.turn.hasActiveTurn).toBe(false);
    await sleep(20);

    await session.mailbox.sendMessage('core', 'leader', 'researcher', 'wake up, there is news');

    await mainAgent.background.wait(taskId);

    expect(state.nudgeTurns).toBeGreaterThanOrEqual(1);
    expect(state.sawMailboxDelivery).toBe(true);
    expect(await session.mailbox.store.unread('core', 'researcher')).toHaveLength(0);
  });

  it('exits cleanly after the bounded idle window when truly idle', async () => {
    const state = probeState(false);
    const { mainAgent } = await createMainAgent(createProbeGenerate(state), {
      idleTimeoutMs: 300,
      pollIntervalMs: 50,
    });

    const startedAt = Date.now();
    const { taskId } = await spawnTeammate(mainAgent, 'researcher', 'core', 'probe: idle first');
    const info = await mainAgent.background.wait(taskId);
    const elapsed = Date.now() - startedAt;

    // The run stayed alive for roughly the idle window — nowhere near the
    // 10-minute production default, and not an instant exit either.
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(10_000);
    expect(state.nudgeTurns).toBe(0);
    expect(info?.status).toBe('completed');
  });

  it('stops nudging work the model keeps ignoring (stagnation guard)', async () => {
    const state = probeState(false);
    const { session, mainAgent } = await createMainAgent(createProbeGenerate(state), {
      idleTimeoutMs: 300,
      pollIntervalMs: 50,
    });

    // A claimable task exists from the start, but the scripted model never
    // claims it — the guard must bound the nudge turns, not loop forever.
    await session.teamStore.createTask('core', { subject: 'ignored work', createdBy: 'leader' });
    const { taskId } = await spawnTeammate(mainAgent, 'researcher', 'core', 'probe: idle first');
    const info = await mainAgent.background.wait(taskId);

    expect(state.nudgeTurns).toBe(MAX_STAGNANT_NUDGES);
    expect(info?.status).toBe('completed');
    const tasks = await session.teamStore.listTasks('core');
    expect(tasks?.[0]).toMatchObject({ id: 1, status: 'pending', owner: undefined });
  });
});
