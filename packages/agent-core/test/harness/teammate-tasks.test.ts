/**
 * Real-Session e2e for the team work queue:
 *  - the leader files tasks into a team's shared list and a teammate claims
 *    the next one through its real turn loop (identity from the
 *    AsyncLocalStorage teammate context, claim serialized at the store),
 *    then completes it;
 *  - teammate names stay unique per team at spawn time;
 *  - the team file and the session metadata (the roster authority) both
 *    survive a restart: a fresh TeamStore over the same session dir sees
 *    the same tasks, and state.json still carries the teammate identities.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
import { TeamStore } from '../../src/agent/swarm/team-store';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
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

const MARKER = 'TEAMTASK-PROBE';
const CLAIM_AND_FINISH = 'claim-and-finish';
const FINAL_PREFIX = 'TEAMTASK-DONE: ';

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
  readonly claimResults: Map<string, string | null>;
  readonly updateResults: Map<string, string | null>;
}

/**
 * Scripted model shared by the leader and every child. A teammate whose
 * prompt is `TEAMTASK-PROBE:<name>|claim-and-finish` runs a three-turn
 * choreography: TeamTaskClaim → TeamTaskUpdate(completed) → final summary.
 * Anything else (leader turns) returns idle text.
 */
function createProbeGenerate(state: ProbeState): GenerateFn {
  const generate: GenerateFn = async (_chat, _systemPrompt, _tools, history, callbacks, options) => {
    options?.signal?.throwIfAborted();
    options?.onRequestStart?.();

    const firstUserText = toolText(history.find((message) => message.role === 'user')) ?? '';
    const marker = firstUserText.includes(MARKER)
      ? (firstUserText.match(/TEAMTASK-PROBE:[a-z-]+/)?.[0] ?? null)
      : null;

    let parts: StreamedMessagePart[];
    if (marker !== null && firstUserText.includes(CLAIM_AND_FINISH)) {
      const lastText = toolText(history.at(-1)) ?? '';
      if (lastText.includes('Claimed task')) {
        state.claimResults.set(marker, lastText);
        const taskId = /Claimed task #(\d+)/.exec(lastText)?.[1] ?? '0';
        parts = [
          {
            type: 'function',
            id: `call_update_${marker}`,
            name: 'TeamTaskUpdate',
            arguments: JSON.stringify({ task_id: Number(taskId), status: 'completed' }),
          },
        ];
      } else if (lastText.includes('Updated task')) {
        state.updateResults.set(marker, lastText);
        parts = [{ type: 'text', text: finalText(`${marker} claimed and completed`) }];
      } else {
        parts = [
          {
            type: 'function',
            id: `call_claim_${marker}`,
            name: 'TeamTaskClaim',
            arguments: '{}',
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
): Promise<{ session: Session; mainAgent: Agent; sessionDir: string }> {
  const sessionDir = await mkdtemp(join(tmpdir(), 'cloud-code-teammate-tasks-e2e-'));
  tempDirs.push(sessionDir);
  const rpc: SDKSessionRPC = {
    emitEvent: vi.fn(async () => {}),
    requestApproval: vi.fn(async () => ({ decision: 'approved', selectedLabel: 'approve' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({ output: '', isError: true })),
  } as unknown as SDKSessionRPC;

  const session = new Session({
    id: 'teammate-tasks-e2e',
    kaos: testKaos.withCwd(sessionDir),
    homedir: sessionDir,
    rpc,
    // These suites pin the work-queue semantics: one prompt to
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
  return { session, mainAgent, sessionDir };
}

const toolSignal = new AbortController().signal;

function toolContext<Input>(args: Input) {
  return { turnId: '0', toolCallId: 'call_team_task', args, signal: toolSignal };
}

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

describe('team work queue (real Session e2e)', () => {
  it('leader files tasks; a teammate claims the oldest and completes it through its real turn loop', async () => {
    const state: ProbeState = { claimResults: new Map(), updateResults: new Map() };
    const { session, mainAgent } = await createMainAgent(createProbeGenerate(state));

    // The leader seeds the shared queue BEFORE the teammate starts. Team
    // creation is implicit: the first write creates the team file.
    const createTool = new TeamTaskCreateTool(session.teamStore);
    const first = await executeTool(createTool,
      toolContext({ team_name: 'core', subject: 'Map the ingestion surface', description: 'Find every ingestion entry point.' }),
    );
    const second = await executeTool(createTool,
      toolContext({ team_name: 'core', subject: 'Profile the hot path' }),
    );
    expect(first.isError).toBeUndefined();
    expect(second.isError).toBeUndefined();
    expect(first.display).toEqual({
      key: 'toolResult.teamTask.created',
      params: { id: 1, team: 'core', subject: 'Map the ingestion surface' },
    });
    expect(second.display).toEqual({
      key: 'toolResult.teamTask.created',
      params: { id: 2, team: 'core', subject: 'Profile the hot path' },
    });

    const { taskId } = await spawnTeammate(
      mainAgent,
      'researcher',
      'core',
      `TEAMTASK-PROBE:researcher|${CLAIM_AND_FINISH}`,
    );
    await mainAgent.background.wait(taskId);

    // The teammate claimed task #1 (the oldest pending unowned one) with the
    // identity from its runtime context, then completed it.
    expect(state.claimResults.get('TEAMTASK-PROBE:researcher')).toContain('Claimed task #1');
    expect(state.claimResults.get('TEAMTASK-PROBE:researcher')).toContain('ingestion');
    expect(state.updateResults.get('TEAMTASK-PROBE:researcher')).toContain('status: completed');

    const tasks = await session.teamStore.listTasks('core');
    expect(tasks).toHaveLength(2);
    expect(tasks?.[0]).toMatchObject({ id: 1, status: 'completed', owner: 'researcher' });
    expect(tasks?.[1]).toMatchObject({ id: 2, status: 'pending', owner: undefined });
  });

  it('keeps teammate names unique per team at spawn time', async () => {
    const state: ProbeState = { claimResults: new Map(), updateResults: new Map() };
    const { mainAgent } = await createMainAgent(createProbeGenerate(state));

    const first = await spawnTeammate(mainAgent, 'researcher', 'core', 'TEAMTASK-PROBE:researcher|idle');

    // Same team + same name → rejected before any spawn side effects.
    const tool = new AgentTool(mainAgent.subagentHost!, mainAgent.background);
    const duplicate = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_teammate_dup',
      args: { prompt: 'dup', description: 'dup', name: 'researcher', team_name: 'core' },
      signal: toolSignal,
    });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.output).toContain('already exists in team "core"');
    expect(duplicate.output).toContain('Agent(resume=');

    // Same name in a DIFFERENT team is fine.
    const other = await spawnTeammate(mainAgent, 'researcher', 'infra', 'TEAMTASK-PROBE:researcher|idle');
    expect(other.agentId).not.toBe(first.agentId);

    await mainAgent.background.stopAll('test cleanup');
  });

  it('reconstructs the team file and the roster from disk after a restart', async () => {
    const state: ProbeState = { claimResults: new Map(), updateResults: new Map() };
    const { session, mainAgent, sessionDir } = await createMainAgent(createProbeGenerate(state));

    await session.teamStore.createTask('core', { subject: 'durable', createdBy: 'leader' });
    const { taskId, agentId } = await spawnTeammate(
      mainAgent,
      'writer',
      'core',
      'TEAMTASK-PROBE:writer|idle',
    );
    await session.flushMetadata();
    await mainAgent.background.stopAll('test cleanup');

    // A fresh TeamStore over the same session dir (a CLI restart) sees the
    // same team state; the id counter continues without reuse.
    const reopened = new TeamStore(sessionDir);
    expect(await reopened.listTasks('core')).toHaveLength(1);
    const next = await reopened.createTask('core', { subject: 'after restart', createdBy: 'leader' });
    expect(next.id).toBe(2);

    // The roster authority — session metadata on disk — still carries the
    // teammate identity, so a resumed session re-derives membership.
    const rawMeta = JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf-8')) as {
      agents: Record<string, { teammate?: { name: string; teamName?: string } }>;
    };
    expect(rawMeta.agents[agentId]?.teammate).toEqual({ name: 'writer', teamName: 'core' });
  });
});
