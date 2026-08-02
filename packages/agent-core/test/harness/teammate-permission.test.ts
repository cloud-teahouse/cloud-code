/**
 * Real-Session e2e for the leader permission bridge:
 *  - primary track: a teammate's approval ask rides the leader's
 *    requestApproval with a `requester` badge (name + team), and the tool
 *    proceeds on approval;
 *  - fallback track: with no interactive handler at all, the request lands
 *    in the leader's inbox, the leader agent answers with a SendMessage
 *    permission_response, and the waiting teammate proceeds — the full
 *    mailbox round trip through two real turn loops.
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
import { LEADER_INBOX } from '../../src/agent/swarm/mailbox';
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

const MARKER = 'PERM-PROBE';
const FINAL_PREFIX = 'PERM-DONE: ';

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
  /** The tool result the teammate saw for its approved Bash call. */
  bashResult: string | null;
  /** The rendered permission_request the leader's mailbox turn saw. */
  leaderSawRequest: string | null;
  /** request_ids the scripted leader already answered (stops re-answering). */
  readonly answeredRequests: Set<string>;
}

function createProbeState(): ProbeState {
  return { bashResult: null, leaderSawRequest: null, answeredRequests: new Set() };
}

/**
 * Scripted model shared by the leader and every child. A `PERM-PROBE:<name>`
 * teammate emits one Bash call (`true` — a no-op on the host) whose approval
 * the test exercises, then captures the tool result. A leader mailbox turn
 * carrying a permission_request answers it with a permission_response
 * (fallback track); any other turn idles out.
 */
function createProbeGenerate(state: ProbeState): GenerateFn {
  const generate: GenerateFn = async (_chat, _systemPrompt, _tools, history, callbacks, options) => {
    options?.signal?.throwIfAborted();
    options?.onRequestStart?.();

    const firstUserText = toolText(history.find((message) => message.role === 'user')) ?? '';
    const lastUserText =
      toolText([...history].reverse().find((message) => message.role === 'user')) ?? '';
    const marker = firstUserText.includes(MARKER)
      ? (firstUserText.match(/PERM-PROBE:[a-z-]+/)?.[0] ?? null)
      : null;

    let parts: StreamedMessagePart[];
    if (marker !== null) {
      const lastMessage = history.at(-1);
      if (lastMessage?.role === 'tool') {
        state.bashResult = toolText(lastMessage);
        parts = [{ type: 'text', text: finalText(`${marker} observed bash result`) }];
      } else {
        parts = [
          {
            type: 'function',
            id: `call_bash_${marker}`,
            name: 'Bash',
            arguments: JSON.stringify({ command: 'true', description: 'permission probe' }),
          },
        ];
      }
    } else if (
      lastUserText.includes('kind="permission_request"') &&
      lastUserText.includes('request_id: preq_')
    ) {
      const requestId = /request_id: (preq_[0-9a-z]{8})/.exec(lastUserText)?.[1] ?? '';
      // Answer each request once: after the tool result lands, the request
      // message is still the last USER message — without this latch the
      // scripted leader would answer the same request forever.
      if (state.answeredRequests.has(requestId)) {
        parts = [{ type: 'text', text: 'main agent idle text' }];
      } else {
        state.leaderSawRequest = lastUserText;
        state.answeredRequests.add(requestId);
        const from = /from="([\w-]+)"/.exec(lastUserText)?.[1] ?? '';
        parts = [
          {
            type: 'function',
            id: 'call_perm_response',
            name: 'SendMessage',
            arguments: JSON.stringify({
              to: from,
              team_name: 'core',
              message: { type: 'permission_response', request_id: requestId, approve: true },
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
  options: { readonly withApprovalRpc: boolean },
): Promise<{ session: Session; mainAgent: Agent; approvalPayloads: Array<Record<string, unknown>> }> {
  const sessionDir = await mkdtemp(join(tmpdir(), 'cloud-code-teammate-permission-e2e-'));
  tempDirs.push(sessionDir);
  const approvalPayloads: Array<Record<string, unknown>> = [];
  const rpc: SDKSessionRPC = {
    emitEvent: vi.fn(async () => {}),
    ...(options.withApprovalRpc
      ? {
          requestApproval: vi.fn(async (payload: Record<string, unknown>) => {
            approvalPayloads.push(payload);
            return { decision: 'approved', selectedLabel: 'approve' };
          }),
        }
      : {}),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({ output: '', isError: true })),
  } as unknown as SDKSessionRPC;

  const session = new Session({
    id: 'teammate-permission-e2e',
    kaos: testKaos.withCwd(sessionDir),
    homedir: sessionDir,
    rpc,
    mailbox: { pollIntervalMs: 25, shutdownGraceMs: 75, permissionRequestTimeoutMs: 10_000 },
    // These suites pin the bridge semantics: one prompt to completion.
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
    // The fallback-track leader answers permission requests with a real
    // SendMessage call — the tool must be enabled for the main agent.
    tools: ['SendMessage'],
  };
  const { agent: mainAgent } = await session.createAgent(
    { type: 'main', generate },
    { profile: mainProfile },
  );
  mainAgent.config.update({ modelAlias: MOCK_PROVIDER.model, thinkingEffort: 'off' });
  // Manual mode: unmatched tool calls take the interactive `ask` path the
  // bridge intercepts (children inherit the mode through the parent chain).
  mainAgent.permission.setMode('manual');
  return { session, mainAgent, approvalPayloads };
}

const toolSignal = new AbortController().signal;

async function spawnTeammate(
  mainAgent: Agent,
  name: string,
): Promise<{ readonly taskId: string; readonly agentId: string }> {
  const tool = new AgentTool(mainAgent.subagentHost!, mainAgent.background);
  const result = await executeTool(tool, {
    turnId: '0',
    toolCallId: 'call_teammate',
    args: { prompt: `PERM-PROBE:${name}`, description: `probe ${name}`, name, team_name: 'core' },
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

describe('leader permission bridge (real Session e2e)', () => {
  it('primary track: the teammate ask reaches the leader queue with the badge and proceeds', async () => {
    const state = createProbeState();
    const { mainAgent, approvalPayloads } = await createMainAgent(createProbeGenerate(state), {
      withApprovalRpc: true,
    });

    const { taskId } = await spawnTeammate(mainAgent, 'delta');
    const info = await mainAgent.background.wait(taskId, 10_000);
    expect(info?.status).toBe('completed');

    // The ask surfaced exactly once, badged with the teammate identity.
    expect(approvalPayloads).toHaveLength(1);
    expect(approvalPayloads[0]).toMatchObject({
      toolName: 'Bash',
      requester: { name: 'delta', teamName: 'core' },
    });

    // Approved → the no-op command ran; the teammate saw a clean result.
    expect(state.bashResult).not.toBeNull();
    expect(state.bashResult).not.toContain('reject');
    expect(state.bashResult).not.toContain('denied');
    expect(state.leaderSawRequest).toBeNull();
  });

  it('fallback track: no interactive handler — leader agent answers via mailbox and the teammate proceeds', async () => {
    const state = createProbeState();
    const { session, mainAgent, approvalPayloads } = await createMainAgent(createProbeGenerate(state), {
      withApprovalRpc: false,
    });

    const { taskId } = await spawnTeammate(mainAgent, 'epsilon');

    // Condition waits on the round trip's milestones instead of one long
    // wall-clock wait: under full-suite load the event loop stretches, and a
    // single 20s background.wait cap was what flaked. Each leg is fast when
    // the mailbox machinery is healthy; the 10s caps match the session's
    // permissionRequestTimeoutMs backstop.
    await vi.waitFor(
      () => {
        expect(state.leaderSawRequest).not.toBeNull();
      },
      { timeout: 10_000, interval: 25 },
    );
    await vi.waitFor(
      () => {
        expect(state.bashResult).not.toBeNull();
      },
      { timeout: 10_000, interval: 25 },
    );
    const info = await mainAgent.background.wait(taskId, 10_000);
    expect(info?.status).toBe('completed');

    // Nothing touched an interactive queue (there is none in this session).
    expect(approvalPayloads).toHaveLength(0);

    // The leader's mailbox turn saw the rendered request with the request id
    // and answered it; the teammate's Bash call then ran.
    expect(state.leaderSawRequest).not.toBeNull();
    expect(state.leaderSawRequest).toContain('kind="permission_request"');
    expect(state.leaderSawRequest).toContain('Bash');
    expect(state.leaderSawRequest).toMatch(/request_id: preq_[0-9a-z]{8}/);
    expect(state.bashResult).not.toBeNull();
    expect(state.bashResult).not.toContain('reject');
    // The approval must have arrived through the mailbox — not via the
    // permission wait timing out (its denial feedback contains no 'reject',
    // so the assertions above cannot tell the two paths apart).
    expect(state.bashResult).not.toContain('timed out');

    // The round trip is fully consumed on both sides.
    expect(await session.mailbox.store.unread('core', 'epsilon')).toHaveLength(0);
    expect(await session.mailbox.store.unread('core', LEADER_INBOX)).toHaveLength(0);
  });
});
