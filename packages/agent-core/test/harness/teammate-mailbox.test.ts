/**
 * Real-Session e2e for the mailbox:
 *  - a message sent to a running teammate is delivered mid-run (steered into
 *    its active turn and visible in the next model call), and the teammate's
 *    reply lands in the leader's own turn — the full round trip;
 *  - a leader's shutdown request stops the teammate's task (killed, with the
 *    shutdown reason) and posts shutdown_approved upstream;
 *  - TeamTaskCreate with an owner notifies the assignee through the mailbox.
 * Delivery tuning (`pollIntervalMs`/`shutdownGraceMs`) is shrunk via
 * SessionOptions.mailbox for the test.
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
import { LEADER_INBOX } from '../../src/agent/swarm/mailbox';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { ProviderManager } from '../../src/session/provider-manager';
import { AgentTool } from '../../src/tools/builtin/collaboration/agent';
import { SendMessageTool } from '../../src/tools/builtin/collaboration/send-message';
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

const MARKER = 'MB-PROBE';
const FINAL_PREFIX = 'MB-DONE: ';

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

function historyText(history: readonly Message[]): string {
  return history.map((message) => toolText(message) ?? '').join('\n');
}

interface ProbeState {
  readonly barrier: ControlledPromise<void>;
  /** Captured full history of the teammate turn that saw the mailbox message. */
  seenByTeammate: string | null;
  /** Mailbox turns captured on the leader agent (keyed by last user message). */
  readonly leaderSeen: string[];
  /** Resolves each time the teammate's first (parking) turn starts. */
  readonly parked: ControlledPromise<void>;
}

function createProbeState(): ProbeState {
  return {
    barrier: createControlledPromise<void>(),
    seenByTeammate: null,
    leaderSeen: [],
    parked: createControlledPromise<void>(),
  };
}

function abortablePark(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      reject(signal.reason as unknown);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason as unknown), { once: true });
  });
}

/**
 * Scripted model shared by the leader and every child. Turns are keyed off
 * the FIRST user message (teammate prompts) or, for the leader's mailbox
 * turns, the LAST user message — the leader's history starts with whatever
 * arrived first (often a background-task notification), so a mailbox turn is
 * identified by its tail.
 *  - marker branch (`MB-PROBE:<name>|wait`): park on the test barrier
 *    (turn 1); once a mailbox message is visible (turn 2), answer it with a
 *    SendMessage call; after the tool result (turn 3), finish;
 *  - `MB-PROBE:<name>|park`: park until aborted (shutdown probe);
 *  - mailbox branch (last user message is a `<teammate-message>`): capture
 *    and idle out — this is the leader receiving a reply;
 *  - anything else returns idle text.
 */
function createProbeGenerate(state: ProbeState): GenerateFn {
  const generate: GenerateFn = async (_chat, _systemPrompt, _tools, history, callbacks, options) => {
    options?.signal?.throwIfAborted();
    options?.onRequestStart?.();

    const firstUserText = toolText(history.find((message) => message.role === 'user')) ?? '';
    const lastUserText =
      toolText([...history].reverse().find((message) => message.role === 'user')) ?? '';
    const marker = firstUserText.includes(MARKER)
      ? (firstUserText.match(/MB-PROBE:[a-z-]+/)?.[0] ?? null)
      : null;

    let parts: StreamedMessagePart[];
    if (marker !== null && firstUserText.includes('|wait')) {
      const lastMessage = history.at(-1);
      const lastText = toolText(lastMessage) ?? '';
      if (lastMessage?.role === 'tool') {
        parts = [{ type: 'text', text: finalText(`${marker} answered`) }];
      } else if (lastText.includes('<teammate-message')) {
        state.seenByTeammate = historyText(history);
        parts = [
          {
            type: 'function',
            id: `call_reply_${marker}`,
            name: 'SendMessage',
            arguments: JSON.stringify({ to: 'leader', message: `${marker} says hi back` }),
          },
        ];
      } else {
        state.parked.resolve();
        await Promise.race([state.barrier, abortablePark(options?.signal)]);
        parts = [{ type: 'text', text: finalText(`${marker} first turn`) }];
      }
    } else if (marker !== null && firstUserText.includes('|park')) {
      state.parked.resolve();
      await abortablePark(options?.signal);
      parts = [{ type: 'text', text: finalText(`${marker} unparked`) }];
    } else if (lastUserText.trimStart().startsWith('<teammate-message')) {
      state.leaderSeen.push(lastUserText);
      parts = [{ type: 'text', text: 'main agent idle text' }];
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
  const sessionDir = await mkdtemp(join(tmpdir(), 'cloud-code-teammate-mailbox-e2e-'));
  tempDirs.push(sessionDir);
  const rpc: SDKSessionRPC = {
    emitEvent: vi.fn(async () => {}),
    requestApproval: vi.fn(async () => ({ decision: 'approved', selectedLabel: 'approve' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({ output: '', isError: true })),
  } as unknown as SDKSessionRPC;

  const session = new Session({
    id: 'teammate-mailbox-e2e',
    kaos: testKaos.withCwd(sessionDir),
    homedir: sessionDir,
    rpc,
    mailbox: { pollIntervalMs: 25, shutdownGraceMs: 75 },
    // These suites pin the delivery semantics: one prompt to completion.
    // Keep-alive has its own harness suite.
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

function toolContext<Input>(args: Input) {
  return { turnId: '0', toolCallId: 'call_probe_tool', args, signal: toolSignal };
}

async function spawnTeammate(
  mainAgent: Agent,
  name: string,
  probe: string,
): Promise<{ readonly taskId: string; readonly agentId: string }> {
  const tool = new AgentTool(mainAgent.subagentHost!, mainAgent.background);
  const result = await executeTool(tool, {
    turnId: '0',
    toolCallId: 'call_teammate',
    args: { prompt: probe, description: `probe ${name}`, name, team_name: 'core' },
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

describe('team mailbox (real Session e2e)', () => {
  it('delivers a leader message into the running teammate and its reply back to the leader', async () => {
    const state = createProbeState();
    const { session, mainAgent } = await createMainAgent(createProbeGenerate(state));

    const { taskId } = await spawnTeammate(mainAgent, 'alpha', 'MB-PROBE:alpha|wait');
    await state.parked;

    // The leader talks to the running teammate through the mailbox tool.
    const sendTool = new SendMessageTool(session.mailbox);
    const sent = await executeTool(sendTool,
      toolContext({ to: 'alpha', team_name: 'core', message: 'leader says hi' }),
    );
    expect(sent.isError).toBeUndefined();
    expect(sent.display).toMatchObject({
      key: 'toolResult.sendMessage.sent',
      params: { to: 'alpha', team: 'core' },
    });

    // Let the watcher deliver, then unblock the parked first turn: the
    // steered message lands at the turn boundary and the teammate answers.
    await new Promise((resolve) => setTimeout(resolve, 60));
    state.barrier.resolve();

    await vi.waitFor(() => {
      expect(state.seenByTeammate).not.toBeNull();
    }, { timeout: 5_000 });
    expect(state.seenByTeammate).toContain('leader says hi');
    expect(state.seenByTeammate).toContain('<teammate-message from="leader" team="core" kind="message">');

    // The reply round-trips: the leader's own turn receives it.
    await vi.waitFor(() => {
      expect(state.leaderSeen.some((text) => text.includes('says hi back'))).toBe(true);
    }, { timeout: 5_000 });

    await mainAgent.background.wait(taskId);
    expect(mainAgent.background.getTask(taskId)).toMatchObject({ status: 'completed' });
    // Both inboxes fully consumed.
    expect(await session.mailbox.store.unread('core', 'alpha')).toHaveLength(0);
    expect(await session.mailbox.store.unread('core', LEADER_INBOX)).toHaveLength(0);
  });

  it('stops the teammate task on a shutdown request and acks upstream', async () => {
    const state = createProbeState();
    const { session, mainAgent } = await createMainAgent(createProbeGenerate(state));

    const { taskId } = await spawnTeammate(mainAgent, 'beta', 'MB-PROBE:beta|park');
    await state.parked;

    const sendTool = new SendMessageTool(session.mailbox);
    const sent = await executeTool(sendTool,
      toolContext({
        to: 'beta',
        team_name: 'core',
        message: { type: 'shutdown_request', reason: 'work is done' },
      }),
    );
    expect(sent.isError).toBeUndefined();
    expect(sent.display).toMatchObject({
      key: 'toolResult.sendMessage.shutdownSent',
      params: { to: 'beta', team: 'core' },
    });

    const stopped = await mainAgent.background.wait(taskId, 10_000);
    expect(stopped?.status).toBe('killed');
    expect(stopped?.stopReason).toContain('Shutdown requested by the leader: work is done');

    await vi.waitFor(async () => {
      const inbox = await session.mailbox.store.inbox('core', LEADER_INBOX);
      const acks = inbox.filter((message) => message.kind === 'shutdown_approved');
      expect(acks).toHaveLength(1);
    });
  });

  it('notifies the assignee when TeamTaskCreate sets an owner', async () => {
    const state = createProbeState();
    const { session, mainAgent } = await createMainAgent(createProbeGenerate(state));

    const { taskId } = await spawnTeammate(mainAgent, 'gamma', 'MB-PROBE:gamma|wait');
    await state.parked;

    const createTool = new TeamTaskCreateTool(session.teamStore, session.mailbox);
    const created = await executeTool(createTool,
      toolContext({
        team_name: 'core',
        subject: 'Spec the API surface',
        description: 'Endpoints, shapes, error model.',
        owner: 'gamma',
      }),
    );
    expect(created.isError).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 60));
    state.barrier.resolve();

    await vi.waitFor(() => {
      expect(state.seenByTeammate).not.toBeNull();
    }, { timeout: 5_000 });
    expect(state.seenByTeammate).toContain('kind="task_assignment"');
    expect(state.seenByTeammate).toContain('task #1: Spec the API surface');
    expect(state.seenByTeammate).toContain('Endpoints, shapes, error model.');

    await mainAgent.background.wait(taskId);
    // The assignment does not change task state: still pending for its owner.
    expect(await session.teamStore.getTask('core', 1)).toMatchObject({
      status: 'pending',
      owner: 'gamma',
    });
  });
});
