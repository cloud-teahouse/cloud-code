/**
 * Real-Session e2e for the teammate prompt addendum (CC
 * TEAMMATE_SYSTEM_PROMPT_ADDENDUM port). The addendum is appended in
 * `configureChild` AFTER the profile render, and only for teammates spawned
 * INTO A TEAM — this suite captures the exact system-prompt bytes each
 * child model received and asserts:
 *  - a teamed teammate's prompt = the plain-subagent prompt (same profile,
 *    same session context; only the latched timestamp differs) plus the
 *    addendum tail — a byte-exact prompt diff;
 *  - plain subagents and team-less teammates get no addendum at all, so
 *    their prompts (and the shared profile prefix cache) stay untouched.
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
import { renderTeammatePromptAddendum } from '../../src/agent/swarm/teammate-prompt-addendum';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { ProviderManager } from '../../src/session/provider-manager';
import { AgentTool } from '../../src/tools/builtin/collaboration/agent';
import { testKaos } from '../fixtures/test-kaos';
import { executeTool } from '../tools/fixtures/execute-tool';

const MOCK_PROVIDER = { type: 'kimi', apiKey: 'test-key', model: 'mock-model' } as const satisfies ProviderConfig;

/** Pull the spawned task id out of an Agent tool result, failing loudly when absent. */
function extractTaskId(output: string): string {
  const match = /task_id: (agent-[0-9a-z]{8})/.exec(output);
  if (match === null || match[1] === undefined) {
    throw new Error(`task_id not found in tool output: ${output}`);
  }
  return match[1];
}

const tempDirs: string[] = [];
const openSessions: Session[] = [];

afterEach(async () => {
  await Promise.allSettled(openSessions.splice(0).map((s) => s.close()));
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

type GenerateFn = NonNullable<AgentOptions['generate']>;

const MARKER = 'ADDENDUM-PROBE';
const ADDENDUM_HEADING = '# Agent Teammate Communication';

function toolText(message: Message | undefined): string | null {
  if (message === undefined) return null;
  return message.content
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : JSON.stringify(part)))
    .join('');
}

/** Summaries below 200 chars trigger a continuation turn; stay above it. */
function finalText(note: string): string {
  return `${note} `.repeat(12);
}

/** Scripted model: records the system-prompt bytes of every agent's first call. */
function createProbeGenerate(prompts: Map<string, string>): GenerateFn {
  const generate: GenerateFn = async (_chat, systemPrompt, _tools, history, callbacks, options) => {
    options?.signal?.throwIfAborted();
    options?.onRequestStart?.();

    const firstUserText = toolText(history.find((message) => message.role === 'user')) ?? '';
    const marker = /ADDENDUM-PROBE:[a-z-]+/.exec(firstUserText)?.[0];
    if (marker !== undefined && !prompts.has(marker)) {
      prompts.set(marker, systemPrompt);
    }

    const parts: StreamedMessagePart[] = [{ type: 'text', text: finalText(`${MARKER} idle`) }];
    for (const part of parts) {
      await callbacks?.onMessagePart?.(structuredClone(part));
    }
    options?.onStreamEnd?.();

    const content = parts.filter((part) => isContentPart(part));
    const toolCalls = parts.filter((part) => isToolCall(part));
    const message: Message = {
      role: 'assistant',
      content: structuredClone(content),
      toolCalls: structuredClone(toolCalls),
    };
    const finishReason: FinishReason = 'completed';
    options?.onTraceId?.(null);
    return {
      id: 'mock-generate',
      message,
      usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
      finishReason,
      rawFinishReason: 'stop',
      traceId: null,
    };
  };
  return generate;
}

/** The latched CLOUD_CODE_NOW differs per agent; normalize it for the diff. */
function normalizePrompt(prompt: string): string {
  return (
    prompt
      .replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, 'NOW')
      // The cwd listing is a live tree of the session dir: the plain spawn
      // ran before any agent/team files existed, the teamed spawn after.
      // The addendum contract does not cover this volatile section.
      .replace(
        /(The directory listing of current working directory is:\n\n```\n)[\s\S]*?(```)/,
        '$1LISTING\n$2',
      )
  );
}

const toolSignal = new AbortController().signal;

describe('teammate prompt addendum (real Session e2e)', () => {
  it('appends the collaboration addendum for teamed teammates only — byte-exact prompt diff', async () => {
    const prompts = new Map<string, string>();
    const sessionDir = await mkdtemp(join(tmpdir(), 'cloud-code-addendum-e2e-'));
    tempDirs.push(sessionDir);
    const rpc: SDKSessionRPC = {
      emitEvent: vi.fn(async () => {}),
      requestApproval: vi.fn(async () => ({ decision: 'approved', selectedLabel: 'approve' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '', isError: true })),
    } as unknown as SDKSessionRPC;

    const session = new Session({
      id: 'teammate-addendum-e2e',
      kaos: testKaos.withCwd(sessionDir),
      homedir: sessionDir,
      rpc,
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
      { type: 'main', generate: createProbeGenerate(prompts) },
      { profile: mainProfile },
    );
    mainAgent.config.update({ modelAlias: MOCK_PROVIDER.model, thinkingEffort: 'off' });
    mainAgent.permission.setMode('yolo');

    // 1. Plain subagent, same 'coder' profile the teammate spawns use.
    const plain = await mainAgent.subagentHost!.spawn({
      parentToolCallId: 'call_plain',
      prompt: `${MARKER}:plain`,
      description: 'plain probe',
      profileName: 'coder',
      runInBackground: false,
      signal: toolSignal,
    });
    await plain.completion;

    // 2. Team-less teammate (a name but no team): no team tools, no addendum.
    const loneTool = new AgentTool(mainAgent.subagentHost!, mainAgent.background);
    const lone = await executeTool(loneTool, {
      turnId: '0',
      toolCallId: 'call_lone',
      args: { prompt: `${MARKER}:lone`, description: 'lone probe', name: 'lone' },
      signal: toolSignal,
    });
    expect(lone.isError).toBeUndefined();
    const loneTaskId = extractTaskId(lone.output as string);
    await mainAgent.background.wait(loneTaskId);

    // 3. Teamed teammate: the addendum case.
    const teamedTool = new AgentTool(mainAgent.subagentHost!, mainAgent.background);
    const teamed = await executeTool(teamedTool, {
      turnId: '0',
      toolCallId: 'call_teamed',
      args: { prompt: `${MARKER}:teamed`, description: 'teamed probe', name: 'researcher', team_name: 'core' },
      signal: toolSignal,
    });
    expect(teamed.isError).toBeUndefined();
    const teamedTaskId = extractTaskId(teamed.output as string);
    await mainAgent.background.wait(teamedTaskId);

    const plainPrompt = prompts.get(`${MARKER}:plain`);
    const lonePrompt = prompts.get(`${MARKER}:lone`);
    const teamedPrompt = prompts.get(`${MARKER}:teamed`);
    expect(plainPrompt).toBeDefined();
    expect(lonePrompt).toBeDefined();
    expect(teamedPrompt).toBeDefined();

    // Untouched surfaces: no addendum for plain subagents or team-less
    // teammates — their prompts keep the profile bytes (and prefix cache).
    expect(plainPrompt!).not.toContain(ADDENDUM_HEADING);
    expect(lonePrompt!).not.toContain(ADDENDUM_HEADING);

    // The teamed teammate's prompt is the SAME profile render plus the
    // addendum tail (append-bus position: after every profile section).
    const addendum = renderTeammatePromptAddendum({ name: 'researcher', teamName: 'core' });
    expect(teamedPrompt!).toContain(ADDENDUM_HEADING);
    expect(teamedPrompt!).toContain('"researcher"');
    expect(teamedPrompt!).toContain('"core"');
    expect(teamedPrompt!.endsWith(addendum)).toBe(true);
    const expected =
      `${normalizePrompt(plainPrompt!).replace(/\n+$/, '')}\n\n${normalizePrompt(addendum)}`;
    expect(normalizePrompt(teamedPrompt!)).toBe(expected);
  });
});
