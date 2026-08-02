import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { describe, expect, it, vi } from 'vitest';

import type { AgentRecord } from '../../src/agent';
import type { PromptOrigin } from '../../src/agent/context';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  InMemoryAgentRecordPersistence,
} from '../../src/agent/records';
import { limitAgentReplayByTurns } from '../../src/agent/replay/turns';
import { buildReplay } from '../../src/agent/replay/build';
import type { AgentReplayRecord } from '../../src/rpc/resumed';
import { BackgroundTaskPersistence } from '../../src/agent/background';
import type { Logger } from '../../src/logging';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';
import { testAgent } from './harness/agent';
import { DEFAULT_TEST_SYSTEM_PROMPT } from './harness/snapshots';

const MOCK_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'mock-model',
} as const;

describe('Agent resume', () => {
  it('does not append metadata when resuming records that include legacy app version', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
        app_version: '0.0.1-old',
      } as unknown as AgentRecord,
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'old prompt' }],
        origin: { kind: 'user' },
      },
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(persistence.appended).toEqual([]);
    expect(persistence.records.filter((record) => record.type === 'metadata')).toHaveLength(1);
  });

  it('replays persisted records without restarting turns, compactions, plan turns, or tools', async () => {
    const persistence = new RecordingAgentPersistence(resumeHistory());
    const execWithEnv = vi.fn().mockRejectedValue(new Error('Bash should not execute on resume'));
    const ctx = testAgent({
      kaos: createFakeKaos({ execWithEnv }),
      persistence,
    });

    await ctx.agent.resume();

    expect(ctx.agent.planMode.isActive).toBe(true);
    expect(ctx.agent.planMode.planFilePath).toContain('resume-plan');
    expect(ctx.newEvents()).toMatchInlineSnapshot(`[]`);
    expect(ctx.llmCalls).toHaveLength(0);
    expect(execWithEnv).not.toHaveBeenCalled();
    expect(persistence.appended).toEqual([]);
    await ctx.expectResumeMatches();

    ctx.mockNextResponse({ type: 'text', text: 'Fresh response after resume.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Fresh prompt after resume' }] });
    await ctx.untilTurnEnd();

    expect(findRpcEvent(ctx.allEvents, 'turn.started')?.args).toMatchObject({
      turnId: 1,
    });
    expect(findRpcEvent(ctx.allEvents, 'turn.ended')?.args).toMatchObject({
      turnId: 1,
      reason: 'completed',
    });
    expect(findRpcEvent(ctx.allEvents, 'error')).toBeUndefined();
    expect(execWithEnv).not.toHaveBeenCalled();
    expect(ctx.llmInputs()).toMatchInlineSnapshot(`
      call 1:
        system: <system-prompt>
        tools: Bash
        messages:
          user: text "Historical prompt"
          user: text "Historical compacted summary."
          user: text "Fresh prompt after resume"
          user: text <plan-mode-reminder>
    `);
  });

  it('allocates monotonically increasing turnIds across multiple historical turns on resume', async () => {
    const persistence = new RecordingAgentPersistence(multiTurnResumeHistory());
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    // History ran turnId 0 and 1, so the counter must be restored to 1.
    expect(ctx.agent.turn.currentId).toBe(1);

    // After 2 historical turns (turnId 0 and 1), the next fresh turn must be 2.
    ctx.mockNextResponse({ type: 'text', text: 'Fresh response.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Fresh prompt' }] });
    await ctx.untilTurnEnd();

    expect(findRpcEvent(ctx.allEvents, 'turn.started')?.args).toMatchObject({ turnId: 2 });
    expect(findRpcEvent(ctx.allEvents, 'turn.ended')?.args).toMatchObject({
      turnId: 2,
      reason: 'completed',
    });
  });

  it('restores the turn counter past goal-continuation turns that have no turn.prompt record', async () => {
    // A goal drive allocates a fresh turnId per continuation turn but only the
    // first turn has a `turn.prompt` record — the continuations are driven
    // internally. The persisted loop events still carry the real turnId, so the
    // counter must be restored from them, not from the prompt records alone.
    const persistence = new RecordingAgentPersistence(goalContinuationResumeHistory());
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    // History ran turnId 0 (prompted) plus continuation turns 1 and 2.
    expect(ctx.agent.turn.currentId).toBe(2);

    ctx.mockNextResponse({ type: 'text', text: 'Fresh response after goal resume.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Fresh prompt after goal' }] });
    await ctx.untilTurnEnd();

    expect(findRpcEvent(ctx.allEvents, 'turn.started')?.args).toMatchObject({ turnId: 3 });
    expect(findRpcEvent(ctx.allEvents, 'turn.ended')?.args).toMatchObject({
      turnId: 3,
      reason: 'completed',
    });
  });

  it('keeps turnIds monotonic across repeated resume cycles', async () => {
    // Mirrors a real session that was cold-started several times: each resume
    // must continue the counter, never restart it and collide with history.
    const persistence = new RecordingAgentPersistence(multiTurnResumeHistory());
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();
    ctx.mockNextResponse({ type: 'text', text: 'Response in cycle 1.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Prompt in cycle 1' }] });
    await ctx.untilTurnEnd();
    expect(ctx.agent.turn.currentId).toBe(2);

    // Cold-start again from everything persisted so far (history + the turn just
    // run). The fresh agent must restore the counter to 2 and allocate 3 next.
    const persistence2 = new RecordingAgentPersistence(persistence.records);
    const ctx2 = testAgent({ persistence: persistence2 });

    await ctx2.agent.resume();
    expect(ctx2.agent.turn.currentId).toBe(2);

    ctx2.mockNextResponse({ type: 'text', text: 'Response in cycle 2.' });
    await ctx2.rpc.prompt({ input: [{ type: 'text', text: 'Prompt in cycle 2' }] });
    await ctx2.untilTurnEnd();

    expect(findRpcEvent(ctx2.allEvents, 'turn.started')?.args).toMatchObject({ turnId: 3 });
    expect(findRpcEvent(ctx2.allEvents, 'turn.ended')?.args).toMatchObject({
      turnId: 3,
      reason: 'completed',
    });
  });

  it('replays inline skill reminders after pending tool results before the next prompt', async () => {
    const persistence = new RecordingAgentPersistence(resumeDeferredSystemReminderHistory());
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.context.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);
    expect(ctx.agent.context.messages[4]?.content).toEqual([
      {
        type: 'text',
        text: '<system-reminder>\nresume skill body\n</system-reminder>',
      },
    ]);

    ctx.mockNextResponse({ type: 'text', text: 'Fresh response after deferred resume.' });
    await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'Fresh prompt after deferred resume' }],
    });
    await ctx.untilTurnEnd();

    expect(ctx.llmInputs()).toMatchInlineSnapshot(`
      call 1:
        system: <system-prompt>
        tools: []
        messages:
          user: text "Historical prompt before skill"
          assistant: []  calls call_resume_write:Write { "path": "result.txt" }, call_resume_skill:Skill { "skill": "review" }
          tool[call_resume_write]: text "wrote file"
          tool[call_resume_skill]: text "skill loaded"
          user: text "<system-reminder>\\nresume skill body\\n</system-reminder>"
          user: text "Fresh prompt after deferred resume"
    `);
    await ctx.expectResumeMatches();
  });

  it('restores tool store state from persisted records', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'tools.update_store',
        key: 'todo',
        value: [
          { title: 'Inspect resume snapshot', status: 'done' },
          { title: 'Hydrate TUI todo panel', status: 'in_progress' },
        ],
      },
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.tools.storeData()).toEqual({
      todo: [
        { title: 'Inspect resume snapshot', status: 'done' },
        { title: 'Hydrate TUI todo panel', status: 'in_progress' },
      ],
    });
    await ctx.expectResumeMatches();
  });

  it('applies wire migrations while replaying persisted records', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'metadata',
        protocol_version: '1.0',
        created_at: 1,
      },
      {
        type: 'context.append_message',
        message: {
          role: 'assistant',
          content: [],
          toolCalls: [
            {
              type: 'function',
              id: 'call_legacy_bash',
              function: {
                name: 'Bash',
                arguments: '{"command":"pwd"}',
              },
            },
          ],
        },
      } as unknown as AgentRecord,
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    const toolCall = ctx.agent.context.messages[0]?.toolCalls[0] as
      | { name?: string; arguments?: string | null; function?: unknown }
      | undefined;
    expect(toolCall).toMatchObject({
      name: 'Bash',
      arguments: '{"command":"pwd"}',
    });
    expect(toolCall?.function).toBeUndefined();
  });

  it('keeps delivered background notifications indexed after compaction replay', async () => {
    const origin = {
      kind: 'background_task',
      taskId: 'agent-seen0000',
      status: 'completed',
      notificationId: 'task:agent-seen0000:completed',
    } as const;
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'already delivered background notification' }],
          toolCalls: [],
          origin,
        },
      },
      {
        type: 'context.apply_compaction',
        summary: 'Compacted delivered notification.',
        compactedCount: 1,
        tokensBefore: 10,
        tokensAfter: 3,
      },
    ]);
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-resume-delivered-'));
    try {
      const backgroundPersistence = new BackgroundTaskPersistence(sessionDir);
      const ctx = testAgent({ persistence, homedir: sessionDir });
      await backgroundPersistence.writeTask({
        taskId: 'agent-seen0000',
        kind: 'agent',
        description: 'already delivered',
        startedAt: 1_700_000_000,
        endedAt: 1_700_000_010,
        status: 'completed',
      });
      await backgroundPersistence.appendTaskOutput(
        'agent-seen0000',
        'already delivered summary',
      );
      const steer = vi.spyOn(ctx.agent.turn, 'steer');

      await ctx.agent.resume();
      expect(
        ctx.agent.context.history.some((message) => message.origin?.kind === 'background_task'),
      ).toBe(false);

      await ctx.agent.background.loadFromDisk();
      await ctx.agent.background.reconcile();

      expect(steer).not.toHaveBeenCalled();
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('projects restored compactions into replay records', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Historical prompt before compaction' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'full_compaction.begin',
        source: 'manual',
        instruction: 'preserve implementation notes',
      },
      {
        type: 'full_compaction.complete',
      },
      {
        type: 'context.apply_compaction',
        summary: 'Compacted implementation notes.',
        compactedCount: 1,
        tokensBefore: 120,
        tokensAfter: 24,
      },
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.context.history).toEqual([
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'Historical prompt before compaction' }],
      }),
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'Compacted implementation notes.' }],
        origin: { kind: 'compaction_summary' },
      }),
    ]);
    expect(ctx.agent.replayBuilder.buildResult()).toEqual([
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({
          role: 'user',
          content: [{ type: 'text', text: 'Historical prompt before compaction' }],
        }),
      }),
      expect.objectContaining({
        type: 'compaction',
        result: {
          summary: 'Compacted implementation notes.',
          contextSummary: 'Compacted implementation notes.',
          compactedCount: 1,
          tokensBefore: 120,
          tokensAfter: 24,
          keptUserMessageCount: 1,
        },
        instruction: 'preserve implementation notes',
      }),
    ]);
  });

  it('keeps a legacy mid-tool-exchange cut faithful but projects it wire-valid', async () => {
    // A pre-rework compaction record (no `keptUserMessageCount`) restores via the
    // legacy path, which keeps a verbatim tail `history.slice(compactedCount)`.
    // Here the cut (compactedCount=2) lands *between* the assistant `tool_call`
    // and its result, so the retained tail starts with a `tool` message whose
    // assistant was summarized away — a wire-invalid orphan a strict provider
    // (OpenAI / DeepSeek) rejects with "role 'tool' must be a response to a
    // preceding message with 'tool_calls'". The restore keeps the history
    // faithful (so the transcript reducer's fold length stays in sync); the
    // projector drops the orphan at the wire boundary.
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'first prompt' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: 'orphan-step', turnId: '0', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'orphan-call',
          turnId: '0',
          step: 1,
          stepUuid: 'orphan-step',
          toolCallId: 'call_orphaned',
          name: 'Bash',
          args: { command: 'pwd' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          parentUuid: 'orphan-call',
          toolCallId: 'call_orphaned',
          result: { output: 'ok', isError: false },
        },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'second prompt' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'context.apply_compaction',
        summary: 'Compacted the first exchange.',
        compactedCount: 2,
        tokensBefore: 120,
        tokensAfter: 24,
      },
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    // The stored history stays faithful to the wire records: the orphan `tool`
    // result is kept verbatim (not mutated away at restore), so downstream
    // consumers that model the history from the records — e.g. the transcript
    // reducer's fold length — stay in sync.
    expect(ctx.agent.context.history.some((message) => message.role === 'tool')).toBe(true);

    // But the projected wire the provider actually sees has no orphan: every
    // `tool` result is answered by a preceding assistant `tool_calls`.
    const projected = ctx.agent.context.messages;
    const toolCallIds = new Set(
      projected.flatMap((message) =>
        message.role === 'assistant' ? message.toolCalls.map((toolCall) => toolCall.id) : [],
      ),
    );
    const orphanToolResults = projected.filter(
      (message) =>
        message.role === 'tool' &&
        (message.toolCallId === undefined || !toolCallIds.has(message.toolCallId)),
    );
    expect(orphanToolResults).toEqual([]);
  });

  it('projects restored cancelled compactions into replay records', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'full_compaction.begin',
        source: 'manual',
        instruction: 'preserve implementation notes',
      },
      {
        type: 'full_compaction.cancel',
      },
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.replayBuilder.buildResult()).toEqual([
      expect.objectContaining({
        type: 'compaction',
        result: 'cancelled',
        instruction: 'preserve implementation notes',
      }),
    ]);
  });

  it('persists undelivered restored background notifications during resume', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'Historical prompt' }],
        origin: { kind: 'user' },
      },
    ]);
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-resume-undelivered-'));
    try {
      const backgroundPersistence = new BackgroundTaskPersistence(sessionDir);
      const ctx = testAgent({ persistence, homedir: sessionDir });
      await backgroundPersistence.writeTask({
        taskId: 'agent-new00000',
        kind: 'agent',
        description: 'newly delivered',
        startedAt: 1_700_000_000,
        endedAt: 1_700_000_010,
        status: 'completed',
      });
      await backgroundPersistence.appendTaskOutput('agent-new00000', 'newly delivered summary');
      const steer = vi.spyOn(ctx.agent.turn, 'steer');

      await ctx.agent.resume();

      expect(steer).not.toHaveBeenCalled();
      expect(
        ctx.agent.context.history.some(
          (message) =>
            message.origin?.kind === 'background_task' &&
            message.origin.taskId === 'agent-new00000',
        ),
      ).toBe(true);
      expect(persistence.appended).toContainEqual(
        expect.objectContaining({
          type: 'context.append_message',
          message: expect.objectContaining({
            origin: {
              kind: 'background_task',
              taskId: 'agent-new00000',
              status: 'completed',
              notificationId: 'task:agent-new00000:completed',
            },
          }),
        }),
      );
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('preserves failed tool result state in replay messages', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.append_loop_event',
        event: {
          type: 'step.begin',
          uuid: 'failed-step',
          turnId: '0',
          step: 1,
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'failed-call',
          turnId: '0',
          step: 1,
          stepUuid: 'failed-step',
          toolCallId: 'call_failed_bash',
          name: 'Bash',
          args: { command: 'false' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          parentUuid: 'failed-call',
          toolCallId: 'call_failed_bash',
          result: { output: 'failed', isError: true },
        },
      },
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.replayBuilder.buildResult()).toContainEqual(
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({
          role: 'tool',
          toolCallId: 'call_failed_bash',
          isError: true,
        }),
      }),
    );
  });

  it('closes interrupted trailing tool calls with synthetic error results after resume', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'config.update',
        cwd: process.cwd(),
        modelAlias: MOCK_PROVIDER.model,
        systemPrompt: DEFAULT_TEST_SYSTEM_PROMPT,
        thinkingEffort: 'off',
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Run both lookups' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'step.begin',
          uuid: 'interrupted-step',
          turnId: '0',
          step: 1,
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'call-one',
          turnId: '0',
          step: 1,
          stepUuid: 'interrupted-step',
          toolCallId: 'call_interrupted_one',
          name: 'LookupOne',
          args: { query: 'one' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'call-two',
          turnId: '0',
          step: 1,
          stepUuid: 'interrupted-step',
          toolCallId: 'call_interrupted_two',
          name: 'LookupTwo',
          args: { query: 'two' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          parentUuid: 'call-one',
          toolCallId: 'call_interrupted_one',
          result: { output: 'one result' },
        },
      },
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      // The trailing interruption also arms the one-shot resume
      // continuation reminder, appended after the repair closes the exchange.
      'user',
    ]);
    const syntheticResult = ctx.agent.context.history[3];
    expect(syntheticResult).toMatchObject({
      role: 'tool',
      toolCallId: 'call_interrupted_two',
      isError: true,
    });
    expect(textContent(syntheticResult)).toContain(
      'Tool execution was interrupted before its result was recorded',
    );
    expect(ctx.agent.context.history[4]).toMatchObject({
      role: 'user',
      origin: { kind: 'injection', variant: 'resume_continuation' },
    });
    expect(textContent(ctx.agent.context.history[4]!)).toContain(
      'Continue from where you left off',
    );
    const replayMessages = ctx.agent.replayBuilder
      .buildResult()
      .flatMap((record) => (record.type === 'message' ? [record.message] : []));
    expect(replayMessages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);
    expect(replayMessages[3]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_interrupted_two',
      isError: true,
    });
    expect(textContent(replayMessages[3]!)).toContain(
      'Tool execution was interrupted before its result was recorded',
    );
    expect(
      persistence.appended.filter(
        (record) =>
          record.type === 'context.append_loop_event' &&
          record.event.type === 'tool.result' &&
          record.event.toolCallId === 'call_interrupted_two',
      ),
    ).toEqual([
      expect.objectContaining({
        type: 'context.append_loop_event',
        event: expect.objectContaining({
          type: 'tool.result',
          parentUuid: 'call_interrupted_two',
          toolCallId: 'call_interrupted_two',
          result: {
            output:
              'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.',
            isError: true,
          },
        }),
      }),
    ]);

    ctx.mockNextResponse({ type: 'text', text: 'Recovered after resume.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue after resume' }] });
    await ctx.untilTurnEnd();

    const syntheticRecordIndex = persistence.records.findIndex(
      (record) =>
        record.type === 'context.append_loop_event' &&
        record.event.type === 'tool.result' &&
        record.event.toolCallId === 'call_interrupted_two',
    );
    const freshUserRecordIndex = persistence.records.findIndex(
      (record) =>
        record.type === 'context.append_message' &&
        record.message.role === 'user' &&
        textContent(record.message) === 'continue after resume',
    );
    expect(syntheticRecordIndex).toBeGreaterThan(-1);
    expect(freshUserRecordIndex).toBeGreaterThan(-1);
    expect(syntheticRecordIndex).toBeLessThan(freshUserRecordIndex);

    const llmHistory = ctx.llmCalls[0]?.history ?? [];
    expect(llmHistory.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      // The resume continuation reminder rides the context sent to the model.
      'user',
      'user',
    ]);
    expect(textContent(llmHistory[3])).toContain(
      'ERROR: Tool execution failed.',
    );
    expect(textContent(llmHistory[3])).toContain(
      'Tool execution was interrupted before its result was recorded',
    );
    expect(textContent(llmHistory[4])).toContain('Continue from where you left off');
    expect(textContent(llmHistory[5])).toBe('continue after resume');
    expect(
      ctx.agent.context.history.some(
        (message) => message.role === 'user' && textContent(message) === 'continue after resume',
      ),
    ).toBe(true);

    const resumedAgain = testAgent({ persistence });
    await resumedAgain.agent.resume();

    // The persisted synthetic result and continuation reminder replay into
    // history; the dedup scan (and the assistant tail) keeps a second
    // reminder from being appended.
    expect(resumedAgain.agent.context.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
      'user',
      'assistant',
    ]);
    expect(textContent(resumedAgain.agent.context.history[3])).toContain(
      'Tool execution was interrupted before its result was recorded',
    );
    expect(textContent(resumedAgain.agent.context.history[4])).toContain(
      'Continue from where you left off',
    );
    expect(textContent(resumedAgain.agent.context.history[5])).toBe('continue after resume');
    expect(
      resumedAgain.agent.context.history.filter(
        (message) =>
          message.origin?.kind === 'injection' && message.origin.variant === 'resume_continuation',
      ),
    ).toHaveLength(1);
  });

  it('closes an interrupted tool call mid-history so later turns stay aligned', async () => {
    // An interrupted tool call (`call_interrupted`) sits in the MIDDLE of the
    // recorded stream: a later user prompt and a fully-run assistant turn follow
    // it. Without in-place reconciliation the unresolved exchange keeps
    // `hasOpenToolExchange` true, stranding the later user prompt in
    // `deferredMessages` and only aligning the trailing turn.
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Run the lookup' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: 'interrupted-step', turnId: '0', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'call-interrupted',
          turnId: '0',
          step: 1,
          stepUuid: 'interrupted-step',
          toolCallId: 'call_interrupted',
          name: 'Lookup',
          args: { query: 'one' },
        },
      },
      // Recorded while the interrupted exchange was still open, so live deferral
      // captured it after the unresolved tool call.
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'keep going' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      ...loopEventsForTurn('1', 'All done.'),
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
      'assistant',
    ]);
    // The synthetic result is spliced in place (index 2), directly after the
    // interrupted assistant step — not flushed to the tail.
    const synthetic = ctx.agent.context.history[2];
    expect(synthetic).toMatchObject({
      role: 'tool',
      toolCallId: 'call_interrupted',
      isError: true,
    });
    expect(textContent(synthetic)).toContain(
      'Tool execution was interrupted before its result was recorded',
    );
    // The deferred user prompt is restored in its recorded position, between the
    // closed exchange and the following turn.
    expect(textContent(ctx.agent.context.history[3])).toBe('keep going');
    expect(textContent(ctx.agent.context.history[4])).toBe('All done.');

    expect(ctx.agent.context.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
      'assistant',
    ]);

    // The mid-history result is re-derived on every resume and is not
    // persisted as a positioned record (replay logging is suppressed).
    expect(
      persistence.appended.filter(
        (record) =>
          record.type === 'context.append_loop_event' && record.event.type === 'tool.result',
      ),
    ).toEqual([]);

    await ctx.expectResumeMatches();
  });

  it('drops a stale tail interrupted result already closed in place on resume', async () => {
    // Legacy log: an older tail-only finishResume appended the synthetic result
    // for `call_interrupted` at the END of the stream (after the later turn from
    // the deferral avalanche). The new in-place closure handles it at step.begin,
    // so the trailing persisted copy must be dropped rather than duplicated.
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Run the lookup' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: 'interrupted-step', turnId: '0', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'call-interrupted',
          turnId: '0',
          step: 1,
          stepUuid: 'interrupted-step',
          toolCallId: 'call_interrupted',
          name: 'Lookup',
          args: { query: 'one' },
        },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'keep going' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      ...loopEventsForTurn('1', 'All done.'),
      // The stale synthetic result an older resume appended at the tail.
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          parentUuid: 'call_interrupted',
          toolCallId: 'call_interrupted',
          result: {
            output:
              'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.',
            isError: true,
          },
        },
      },
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    // The trailing duplicate is dropped: exactly one synthetic result, in place.
    expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
      'assistant',
    ]);
    expect(ctx.agent.context.history[2]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_interrupted',
      isError: true,
    });
    expect(textContent(ctx.agent.context.history[4])).toBe('All done.');
    await ctx.expectResumeMatches();
  });

  it('closes every open call of a multi-call interrupted step in order', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Run both' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: 'interrupted-step', turnId: '0', step: 1 },
      },
      ...['call_a', 'call_b'].map((toolCallId) => ({
        type: 'context.append_loop_event' as const,
        event: {
          type: 'tool.call' as const,
          uuid: toolCallId,
          turnId: '0',
          step: 1,
          stepUuid: 'interrupted-step',
          toolCallId,
          name: 'Lookup',
          args: {},
        },
      })),
      ...loopEventsForTurn('1', 'All done.'),
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    // Both open calls get a synthetic result, in tool-call order, before the
    // next turn.
    expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ]);
    expect(ctx.agent.context.history[2]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_a',
      isError: true,
    });
    expect(ctx.agent.context.history[3]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_b',
      isError: true,
    });
    await ctx.expectResumeMatches();
  });

  it('synthesizes only the unresolved call when a step is partially resolved', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Run both' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: 'interrupted-step', turnId: '0', step: 1 },
      },
      ...['call_done', 'call_open'].map((toolCallId) => ({
        type: 'context.append_loop_event' as const,
        event: {
          type: 'tool.call' as const,
          uuid: toolCallId,
          turnId: '0',
          step: 1,
          stepUuid: 'interrupted-step',
          toolCallId,
          name: 'Lookup',
          args: {},
        },
      })),
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          parentUuid: 'call_done',
          toolCallId: 'call_done',
          result: { output: 'real result' },
        },
      },
      ...loopEventsForTurn('1', 'All done.'),
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ]);
    // The recorded result is kept verbatim; only the open call is synthesized.
    expect(ctx.agent.context.history[2]).toMatchObject({ toolCallId: 'call_done' });
    expect(textContent(ctx.agent.context.history[2])).toBe('real result');
    expect(ctx.agent.context.history[3]).toMatchObject({
      toolCallId: 'call_open',
      isError: true,
    });
    expect(textContent(ctx.agent.context.history[3])).toContain(
      'Tool execution was interrupted before its result was recorded',
    );
    await ctx.expectResumeMatches();
  });

  it('closes consecutive interrupted steps each at their own boundary', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Go' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      // First interrupted step.
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: 'step-1', turnId: '0', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'call_one',
          turnId: '0',
          step: 1,
          stepUuid: 'step-1',
          toolCallId: 'call_one',
          name: 'Lookup',
          args: {},
        },
      },
      // Second interrupted step (closes the first in place at its step.begin).
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: 'step-2', turnId: '1', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'call_two',
          turnId: '1',
          step: 1,
          stepUuid: 'step-2',
          toolCallId: 'call_two',
          name: 'Lookup',
          args: {},
        },
      },
      // Final fully-run turn (closes the second in place).
      ...loopEventsForTurn('2', 'Done.'),
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(ctx.agent.context.history[2]).toMatchObject({ toolCallId: 'call_one', isError: true });
    expect(ctx.agent.context.history[4]).toMatchObject({ toolCallId: 'call_two', isError: true });
    await ctx.expectResumeMatches();
  });

  it('drops an orphan tool result whose call was never recorded', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Hi' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      ...loopEventsForTurn('0', 'Hello.'),
      // A result with no matching tool.call (e.g. its call was compacted away).
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          parentUuid: 'ghost',
          toolCallId: 'call_ghost',
          result: { output: 'orphaned' },
        },
      },
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(
      ctx.agent.context.history.some((message) => message.role === 'tool'),
    ).toBe(false);
    await ctx.expectResumeMatches();
  });

  it('rebuilds goal completion replay cards without adding model-visible context', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'goal.create',
        goalId: 'goal-1',
        objective: 'ship work',
      },
      {
        type: 'goal.update',
        status: 'complete',
        reason: 'all tests passed',
        turnsUsed: 2,
        tokensUsed: 1200,
        wallClockMs: 65_000,
        actor: 'model',
      },
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.context.history).toHaveLength(0);
    expect(ctx.agent.replayBuilder.buildResult()).toContainEqual(
      expect.objectContaining({
        type: 'goal_updated',
        snapshot: expect.objectContaining({
          status: 'complete',
          terminalReason: 'all tests passed',
          turnsUsed: 2,
          tokensUsed: 1200,
          wallClockMs: 65_000,
        }),
        change: {
          kind: 'completion',
          status: 'complete',
          reason: 'all tests passed',
          stats: { turnsUsed: 2, tokensUsed: 1200, wallClockMs: 65_000 },
          actor: 'model',
        },
      }),
    );
  });

  it('removes replay messages matching undone history', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'first prompt' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'step.begin',
          uuid: 'step-1',
          turnId: '0',
          step: 1,
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          uuid: 'part-1',
          turnId: '0',
          step: 1,
          stepUuid: 'step-1',
          part: { type: 'text', text: 'first response' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'step.end',
          uuid: 'step-1',
          turnId: '0',
          step: 1,
        },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'second prompt' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'step.begin',
          uuid: 'step-2',
          turnId: '1',
          step: 1,
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          uuid: 'part-2',
          turnId: '1',
          step: 1,
          stepUuid: 'step-2',
          part: { type: 'text', text: 'second response' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'step.end',
          uuid: 'step-2',
          turnId: '1',
          step: 1,
        },
      },
      { type: 'context.undo', count: 1 },
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.context.history).toHaveLength(2);
    expect(ctx.agent.context.history[0]?.role).toBe('user');
    expect(ctx.agent.context.history[1]?.role).toBe('assistant');

    const replay = ctx.agent.replayBuilder.buildResult();
    expect(replay).toHaveLength(2);
    expect(replay[0]).toMatchObject({
      type: 'message',
      message: expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'first prompt' }] }),
    });
    expect(replay[1]).toMatchObject({
      type: 'message',
      message: expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: 'first response' }] }),
    });
  });

  it('resumes a wire log poisoned by an undo that raced a streaming step', async () => {
    // Before undoHistory/clearContext had a busy guard, an undo racing a live
    // turn recorded `context.undo` (which clears open steps) followed by the
    // turn's trailing events for the now-unknown step. Replay must skip those
    // orphan records with a warning instead of failing the whole resume.
    const logEntries: Array<{ level: string; message: string }> = [];
    const log: Logger = {
      error: (message) => logEntries.push({ level: 'error', message }),
      warn: (message) => logEntries.push({ level: 'warn', message }),
      info: (message) => logEntries.push({ level: 'info', message }),
      debug: (message) => logEntries.push({ level: 'debug', message }),
      createChild: () => log,
    };
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'prompt' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: 'step-1', turnId: '0', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          uuid: 'part-1',
          turnId: '0',
          step: 1,
          stepUuid: 'step-1',
          part: { type: 'text', text: 'partial' },
        },
      },
      // The racing undo clears openSteps and removes the first exchange.
      { type: 'context.undo', count: 1 },
      // Orphans: step-1 is no longer open. Pre-fix replay threw on the first
      // of these and the session could never resume.
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          uuid: 'part-2',
          turnId: '0',
          step: 1,
          stepUuid: 'step-1',
          part: { type: 'text', text: 'orphan part' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'call-1',
          turnId: '0',
          step: 1,
          stepUuid: 'step-1',
          toolCallId: 'call-1',
          name: 'Lookup',
          args: {},
        },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'later prompt' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
    ]);
    const ctx = testAgent({ persistence, log });

    await expect(ctx.agent.resume()).resolves.toBeDefined();

    // The undo removed the first exchange; the orphans were skipped; the
    // later prompt replayed normally. The trailing unanswered prompt arms the
    // resume continuation reminder (appended after the repair pass).
    expect(ctx.compactHistory()).toEqual([
      { role: 'user', text: 'later prompt' },
      {
        role: 'user',
        text: expect.stringContaining('Continue from where you left off') as unknown as string,
      },
    ]);
    const warnings = logEntries.filter((e) => e.level === 'warn').map((e) => e.message);
    expect(warnings).toContain('skipping content_part for unknown step_uuid during restore');
    expect(warnings).toContain('skipping tool_call for unknown step_uuid during restore');
    expect(logEntries.filter((e) => e.level === 'error')).toEqual([]);
  });

  describe('04i resume graph repair and interruption continuation', () => {
    it('completes a half-finished parallel tool batch with placeholders in call order', async () => {
      // A three-way parallel batch died after only the middle call's result
      // was recorded. Resume must close the other two in place — tool_use
      // without result gets a placeholder, and the wire stays API-valid.
      const persistence = new RecordingAgentPersistence([
        resumeConfigRecord(),
        {
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Run three lookups' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        },
        {
          type: 'context.append_loop_event',
          event: { type: 'step.begin', uuid: 'parallel-step', turnId: '0', step: 1 },
        },
        ...['call_one', 'call_two', 'call_three'].map(
          (toolCallId): AgentRecord => ({
            type: 'context.append_loop_event',
            event: {
              type: 'tool.call',
              uuid: toolCallId,
              turnId: '0',
              step: 1,
              stepUuid: 'parallel-step',
              toolCallId,
              name: 'Lookup',
              args: {},
            },
          }),
        ),
        {
          type: 'context.append_loop_event',
          event: {
            type: 'tool.result',
            parentUuid: 'call_two',
            toolCallId: 'call_two',
            result: { output: 'two result' },
          },
        },
      ]);
      const ctx = testAgent({ persistence });

      await ctx.agent.resume();

      // The recorded result keeps its position right after the assistant; the
      // placeholders for the unfinished calls follow in tool-call order.
      expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'tool',
        'tool',
        // The trailing interruption arms the continuation reminder.
        'user',
      ]);
      expect(ctx.agent.context.history[2]).toMatchObject({
        role: 'tool',
        toolCallId: 'call_two',
      });
      expect(textContent(ctx.agent.context.history[2])).toBe('two result');
      expect(ctx.agent.context.history[3]).toMatchObject({
        role: 'tool',
        toolCallId: 'call_one',
        isError: true,
      });
      expect(ctx.agent.context.history[4]).toMatchObject({
        role: 'tool',
        toolCallId: 'call_three',
        isError: true,
      });

      // The projected wire pairs every call with a result (API-legal).
      const projected = ctx.agent.context.messages;
      expect(projected.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'tool',
        'tool',
        'user',
      ]);

      await ctx.expectResumeMatches();
    });

    it('drops a tool result whose call was never recorded', async () => {
      const persistence = new RecordingAgentPersistence([
        resumeConfigRecord(),
        {
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'question' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        },
        {
          type: 'context.append_loop_event',
          event: { type: 'step.begin', uuid: 'answer-step', turnId: '0', step: 1 },
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'content.part',
            uuid: 'answer-part',
            turnId: '0',
            step: 1,
            stepUuid: 'answer-step',
            part: { type: 'text', text: 'answer' },
          },
        },
        // Orphan: no matching tool.call exists anywhere in the log.
        {
          type: 'context.append_loop_event',
          event: {
            type: 'tool.result',
            parentUuid: 'call_ghost',
            toolCallId: 'call_ghost',
            result: { output: 'ghost result' },
          },
        },
      ]);
      const ctx = testAgent({ persistence });

      await ctx.agent.resume();

      expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
        'user',
        'assistant',
      ]);
      expect(textContent(ctx.agent.context.history[1])).toBe('answer');
      // The turn completed (assistant tail), so no continuation reminder.
      expect(
        ctx.agent.context.history.some(
          (message) =>
            message.origin?.kind === 'injection' &&
            message.origin.variant === 'resume_continuation',
        ),
      ).toBe(false);
      await ctx.expectResumeMatches();
    });

    it('audits structural drift the replay repairs could not fix and warns once', async () => {
      // An assistant message written straight into the log carries a tool
      // call that never produced a result. The step-boundary/trailing repair
      // only covers loop-event exchanges, so this drift survives to the audit.
      const persistence = new RecordingAgentPersistence([
        resumeConfigRecord(),
        {
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'do work' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        },
        {
          type: 'context.append_message',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'working on it' }],
            toolCalls: [
              { type: 'function', id: 'call_dangling', name: 'Bash', arguments: '{}' },
            ],
          },
        },
      ]);
      const ctx = testAgent({ persistence });

      await ctx.agent.resume();

      const warning = findRpcEvent(ctx.allEvents, 'warning');
      // The harness records emitEvent with the `type` field stripped into the
      // entry name; the payload carries code/message only.
      expect(warning?.args).toMatchObject({
        code: 'resume-consistency-drift',
      });
      // The audit is read-only: the history keeps the drifted message.
      expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
        'user',
        'assistant',
      ]);
    });

    it('emits no drift warning for a consistent resume', async () => {
      const persistence = new RecordingAgentPersistence(multiTurnResumeHistory());
      const ctx = testAgent({ persistence });

      await ctx.agent.resume();

      expect(findRpcEvent(ctx.allEvents, 'warning')).toBeUndefined();
    });

    it('injects the continuation reminder for an unanswered tail prompt — once, persisted', async () => {
      const persistence = new RecordingAgentPersistence([
        resumeConfigRecord(),
        {
          type: 'turn.prompt',
          input: [{ type: 'text', text: 'unanswered prompt' }],
          origin: { kind: 'user' },
        },
        {
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'unanswered prompt' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        },
      ]);
      const ctx = testAgent({ persistence });

      await ctx.agent.resume();

      const reminder = ctx.agent.context.history.at(-1);
      expect(reminder).toMatchObject({
        role: 'user',
        origin: { kind: 'injection', variant: 'resume_continuation' },
      });
      const reminderText = textContent(reminder);
      expect(reminderText).toContain('Continue from where you left off');
      // Standard tier: no IMPORTANT prefix, no gentle opt-out; anti-echo line.
      expect(reminderText).not.toContain('IMPORTANT:');
      expect(reminderText).toContain('Do not mention this reminder to the user.');
      // The reminder is persisted so a second resume dedups against it.
      expect(persistence.appended).toContainEqual(
        expect.objectContaining({
          type: 'context.append_message',
          message: expect.objectContaining({
            origin: { kind: 'injection', variant: 'resume_continuation' },
          }),
        }),
      );

      const resumedAgain = testAgent({ persistence });
      await resumedAgain.agent.resume();

      expect(
        resumedAgain.agent.context.history.filter(
          (message) =>
            message.origin?.kind === 'injection' &&
            message.origin.variant === 'resume_continuation',
        ),
      ).toHaveLength(1);
      await ctx.expectResumeMatches();
    });

    it('does not inject the continuation reminder when the trailing turn was cancelled', async () => {
      const persistence = new RecordingAgentPersistence([
        resumeConfigRecord(),
        {
          type: 'turn.prompt',
          input: [{ type: 'text', text: 'stopped prompt' }],
          origin: { kind: 'user' },
        },
        {
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'stopped prompt' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        },
        // The user stopped the turn before any step ran: a deliberate stop,
        // not an interruption.
        { type: 'turn.cancel', turnId: 0 },
      ]);
      const ctx = testAgent({ persistence });

      await ctx.agent.resume();

      expect(ctx.agent.context.history.map((message) => message.role)).toEqual(['user']);
      await ctx.expectResumeMatches();
    });

    it('does not inject the continuation reminder after a compaction tail', async () => {
      // The session compacted after its last completed turn and then closed:
      // the trailing compaction summary settles the interruption scan.
      const persistence = new RecordingAgentPersistence([
        resumeConfigRecord(),
        ...minimalPromptedTurn('0', 'work done here', 'All finished.'),
        {
          type: 'context.apply_compaction',
          summary: 'Compacted summary of finished work.',
          contextSummary: 'Compacted summary of finished work.',
          compactedCount: 2,
          tokensBefore: 10,
          tokensAfter: 4,
          keptUserMessageCount: 1,
        },
      ]);
      const ctx = testAgent({ persistence });

      await ctx.agent.resume();

      expect(
        ctx.agent.context.history.some(
          (message) =>
            message.origin?.kind === 'injection' &&
            message.origin.variant === 'resume_continuation',
        ),
      ).toBe(false);
      await ctx.expectResumeMatches();
    });

    it('never injects the continuation reminder into a replay preview', async () => {
      const records = withMetadata([
        resumeConfigRecord(),
        {
          type: 'turn.prompt',
          input: [{ type: 'text', text: 'unanswered prompt' }],
          origin: { kind: 'user' },
        },
        {
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'unanswered prompt' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        },
      ]);
      const persistence = new InMemoryAgentRecordPersistence(records);
      const recordCountBefore = persistence.records.length;

      const replay = await buildReplay(persistence);

      // Preview replays are transient: no reminder in the replay output and
      // no record appended to the log.
      expect(
        replay.some(
          (record) =>
            record.type === 'message' &&
            record.message.origin?.kind === 'injection' &&
            record.message.origin.variant === 'resume_continuation',
        ),
      ).toBe(false);
      expect(persistence.records.length).toBe(recordCountBefore);
    });

    it('still injects when a restored background notification lands above the unanswered prompt', async () => {
      // Crash shape: the user prompt landed, the first LLM request never
      // completed (no step records). At resume, `background.reconcile()`
      // restores an undelivered completion notification ABOVE that prompt —
      // bookkeeping that must not mask the interruption verdict underneath.
      const persistence = new RecordingAgentPersistence([
        resumeConfigRecord(),
        {
          type: 'turn.prompt',
          input: [{ type: 'text', text: 'died mid first request' }],
          origin: { kind: 'user' },
        },
        {
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'died mid first request' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        },
      ]);
      const sessionDir = await mkdtemp(join(tmpdir(), 'cloud-bg-resume-mask-'));
      try {
        const backgroundPersistence = new BackgroundTaskPersistence(sessionDir);
        const ctx = testAgent({ persistence, homedir: sessionDir });
        await backgroundPersistence.writeTask({
          taskId: 'agent-done0000',
          kind: 'agent',
          description: 'finished in the background',
          startedAt: 1_700_000_000,
          endedAt: 1_700_000_010,
          status: 'completed',
        });
        await backgroundPersistence.appendTaskOutput('agent-done0000', 'background summary');

        await ctx.agent.resume();

        // Reconcile did its job — the notification is in history…
        expect(
          ctx.agent.context.history.some(
            (message) =>
              message.origin?.kind === 'background_task' &&
              message.origin.taskId === 'agent-done0000',
          ),
        ).toBe(true);
        // …and the reminder still fired, appended after the bookkeeping.
        expect(ctx.agent.context.history.at(-1)).toMatchObject({
          role: 'user',
          origin: { kind: 'injection', variant: 'resume_continuation' },
        });
        expect(textContent(ctx.agent.context.history.at(-1))).toContain(
          'Continue from where you left off',
        );
      } finally {
        await rm(sessionDir, { recursive: true, force: true });
      }
    });

    it('documents the accepted misfire: a turn that failed before its first step record also injects', async () => {
      // A clean provider/auth failure raised before `step.begin` leaves the
      // same wire shape as a crash — turn.prompt + user message, no turn-end
      // marker. The append-only wire cannot tell "failed cleanly" from
      // "crashed", so both get the one-shot reminder (same tradeoff as
      // Claude's interrupt heuristic). Pinned so a future change chooses it
      // deliberately rather than discovering it.
      const persistence = new RecordingAgentPersistence([
        resumeConfigRecord(),
        {
          type: 'turn.prompt',
          input: [{ type: 'text', text: 'prompt that failed' }],
          origin: { kind: 'user' },
        },
        {
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'prompt that failed' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        },
        // The observability trail of the failed request — not a verdict
        // message; the scan reads context history only.
        {
          type: 'llm.request',
          kind: 'loop',
          provider: 'test-provider',
          model: 'mock-model',
          toolSelect: false,
          systemPromptHash: 'hash',
          toolsHash: 'tools',
          messageCount: 1,
          attempt: '1',
        },
      ]);
      const ctx = testAgent({ persistence });

      await ctx.agent.resume();

      expect(ctx.agent.context.history.at(-1)).toMatchObject({
        role: 'user',
        origin: { kind: 'injection', variant: 'resume_continuation' },
      });
    });
  });

  describe('04i B-tier: resume repair ledger and late tool_result reattachment', () => {
    it('reattaches a late real tool result over the in-place interrupted placeholder', async () => {
      // A parallel batch's second call was recorded, the next step began
      // (closing `call_a` in place with a synthetic placeholder), and only
      // THEN did `call_a`'s real result land in the log — the
      // recoverOrphanedParallelToolResults shape adapted to the event log.
      const persistence = new RecordingAgentPersistence([
        resumeConfigRecord(),
        userMessageRecord('Run both'),
        loopStepBeginRecord('step-1', '0'),
        loopToolCallRecord('call_a', 'step-1', '0'),
        loopToolCallRecord('call_b', 'step-1', '0'),
        loopToolResultRecord('call_b', 'b real result'),
        loopStepBeginRecord('step-2', '1'),
        loopContentPartRecord('part-2', 'step-2', '1', 'All done.'),
        loopStepEndRecord('step-2', '1'),
        loopToolResultRecord('call_a', 'a real late result'),
      ]);
      const ctx = testAgent({ persistence });

      await ctx.agent.resume();

      expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'tool',
        'assistant',
      ]);
      // The placeholder is replaced in position by the real output — the
      // session no longer claims the result was never observed.
      const recovered = ctx.agent.context.history[3];
      expect(recovered).toMatchObject({ role: 'tool', toolCallId: 'call_a' });
      expect(textContent(recovered)).toBe('a real late result');
      expect(recovered?.isError).toBeFalsy();
      // The recorded result for call_b is untouched.
      expect(textContent(ctx.agent.context.history[2])).toBe('b real result');

      // The ledger tells the whole story: one boundary close, one reattach.
      expect(ctx.agent.context.resumeRepairs).toEqual([
        { kind: 'tool_calls_closed_at_step_boundary', toolCallIds: ['call_a'] },
        { kind: 'late_tool_result_reattached', toolCallId: 'call_a' },
      ]);
      // Fully repaired: no user-facing drift warning.
      expect(findRpcEvent(ctx.allEvents, 'warning')).toBeUndefined();
      // No interruption: the trailing turn completed.
      expect(
        ctx.agent.context.history.some(
          (message) => message.origin?.kind === 'injection',
        ),
      ).toBe(false);

      // The replay carries the same swap, so the resumed transcript view
      // cannot diverge from the model context.
      const replayTool = ctx.agent.replayBuilder
        .buildResult()
        .find(
          (record) =>
            record.type === 'message' &&
            record.message.role === 'tool' &&
            record.message.toolCallId === 'call_a',
        );
      expect(replayTool).toMatchObject({
        message: { content: [{ type: 'text', text: 'a real late result' }] },
      });

      // API-legality: every call of the parallel batch has its result.
      expect(ctx.agent.context.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'tool',
        'assistant',
      ]);

      await ctx.expectResumeMatches();
    });

    it('ledgers a stale persisted placeholder duplicate as dropped, not reattached', async () => {
      // Same shape as the legacy-tail test above: an older resume persisted
      // the synthetic placeholder itself at the tail. The arriving record is
      // content-identical to the in-place placeholder, so it is a duplicate —
      // dropped, and the ledger says so (nothing was recovered).
      const persistence = new RecordingAgentPersistence([
        resumeConfigRecord(),
        userMessageRecord('Run the lookup'),
        loopStepBeginRecord('interrupted-step', '0'),
        loopToolCallRecord('call_interrupted', 'interrupted-step', '0'),
        userMessageRecord('keep going'),
        ...loopEventsForTurn('1', 'All done.'),
        loopToolResultRecord(
          'call_interrupted',
          'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.',
          true,
        ),
      ]);
      const ctx = testAgent({ persistence });

      await ctx.agent.resume();

      expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'user',
        'assistant',
      ]);
      expect(
        ctx.agent.context.history.filter((message) => message.role === 'tool'),
      ).toHaveLength(1);
      expect(ctx.agent.context.resumeRepairs).toEqual([
        { kind: 'tool_calls_closed_at_step_boundary', toolCallIds: ['call_interrupted'] },
        { kind: 'orphan_tool_result_dropped', toolCallId: 'call_interrupted' },
      ]);
      await ctx.expectResumeMatches();
    });

    it('ledgers a true orphan tool result (call never recorded) as dropped', async () => {
      const persistence = new RecordingAgentPersistence([
        resumeConfigRecord(),
        userMessageRecord('Hi'),
        ...loopEventsForTurn('0', 'Hello.'),
        loopToolResultRecord('call_ghost', 'ghost result'),
      ]);
      const ctx = testAgent({ persistence });

      await ctx.agent.resume();

      expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
        'user',
        'assistant',
      ]);
      expect(ctx.agent.context.resumeRepairs).toEqual([
        { kind: 'orphan_tool_result_dropped', toolCallId: 'call_ghost' },
      ]);
      await ctx.expectResumeMatches();
    });

    it('ledgers undo-raced orphan step events and the dead turn’s late result', async () => {
      // The undo removed the racing turn's messages and cleared its open
      // step; the aborted step's trailing events still land afterwards. The
      // content part is skipped and the result has no placeholder to re-hang
      // over — both drops are ledgered, not silent.
      const persistence = new RecordingAgentPersistence([
        resumeConfigRecord(),
        userMessageRecord('do work'),
        loopStepBeginRecord('step-1', '0'),
        loopToolCallRecord('call_raced', 'step-1', '0'),
        { type: 'context.undo', count: 1 },
        loopContentPartRecord('part-raced', 'step-1', '0', 'raced text'),
        loopToolResultRecord('call_raced', 'raced output'),
      ]);
      const ctx = testAgent({ persistence });

      await ctx.agent.resume();

      expect(ctx.agent.context.history).toEqual([]);
      expect(ctx.agent.context.resumeRepairs).toEqual([
        { kind: 'orphan_step_event_skipped', eventType: 'content.part', stepUuid: 'step-1' },
        { kind: 'orphan_tool_result_dropped', toolCallId: 'call_raced' },
      ]);
      expect(findRpcEvent(ctx.allEvents, 'warning')).toBeUndefined();
      await ctx.expectResumeMatches();
    });

    it('ledgers the trailing interruption close at resume end', async () => {
      const persistence = new RecordingAgentPersistence([
        resumeConfigRecord(),
        userMessageRecord('run two'),
        loopStepBeginRecord('step-1', '0'),
        loopToolCallRecord('call_a', 'step-1', '0'),
        loopToolCallRecord('call_b', 'step-1', '0'),
      ]);
      const ctx = testAgent({ persistence });

      await ctx.agent.resume();

      expect(ctx.agent.context.resumeRepairs).toEqual([
        { kind: 'tool_calls_closed_at_resume_end', toolCallIds: ['call_a', 'call_b'] },
      ]);
      // The trailing close arms the continuation reminder.
      expect(ctx.agent.context.history.at(-1)).toMatchObject({
        origin: { kind: 'injection', variant: 'resume_continuation' },
      });
      await ctx.expectResumeMatches();
    });

    it('reports unrepaired drift and performed repairs together', async () => {
      // A hand-written assistant message carries a call that never produced a
      // result (unrepairable — the audit warns), while a trailing loop-event
      // call is closed at resume end (repaired — the ledger records it).
      const persistence = new RecordingAgentPersistence([
        resumeConfigRecord(),
        userMessageRecord('do work'),
        {
          type: 'context.append_message',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'working on it' }],
            toolCalls: [
              { type: 'function', id: 'call_dangling', name: 'Bash', arguments: '{}' },
            ],
          },
        },
        loopStepBeginRecord('step-9', '0'),
        loopToolCallRecord('call_late', 'step-9', '0'),
      ]);
      const ctx = testAgent({ persistence });

      await ctx.agent.resume();

      expect(findRpcEvent(ctx.allEvents, 'warning')?.args).toMatchObject({
        code: 'resume-consistency-drift',
      });
      expect(ctx.agent.context.resumeRepairs).toEqual([
        { kind: 'tool_calls_closed_at_resume_end', toolCallIds: ['call_late'] },
      ]);
      await ctx.expectResumeMatches();
    });

    it('keeps the ledger empty for a clean resume', async () => {
      const persistence = new RecordingAgentPersistence(multiTurnResumeHistory());
      const ctx = testAgent({ persistence });

      await ctx.agent.resume();

      expect(ctx.agent.context.resumeRepairs).toEqual([]);
      await ctx.expectResumeMatches();
    });
  });
});

class RecordingAgentPersistence extends InMemoryAgentRecordPersistence {
  readonly appended: AgentRecord[] = [];
  rewritten: readonly AgentRecord[] | undefined;

  constructor(events: readonly AgentRecord[]) {
    super(withMetadata(events));
  }

  override append(input: AgentRecord): void {
    this.appended.push(input);
    super.append(input);
  }

  override rewrite(records: readonly AgentRecord[]): void {
    this.rewritten = records;
    super.rewrite(records);
  }
}

function withMetadata(events: readonly AgentRecord[]): readonly AgentRecord[] {
  if (events.length === 0 || events[0]?.type === 'metadata') return events;
  return [
    {
      type: 'metadata',
      protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
      created_at: 1,
    },
    ...events,
  ];
}

function textContent(
  message:
    | { readonly content: readonly { readonly type: string; readonly text?: string }[] }
    | undefined,
): string {
  return (
    message?.content
      .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .join('') ?? ''
  );
}

function resumeHistory(): AgentRecord[] {
  return [
    {
      type: 'config.update',
      cwd: process.cwd(),
      modelAlias: MOCK_PROVIDER.model,
      systemPrompt: DEFAULT_TEST_SYSTEM_PROMPT,
      thinkingEffort: 'off',
    },
    {
      type: 'tools.set_active_tools',
      names: ['Bash'],
    },
    {
      type: 'permission.set_mode',
      mode: 'yolo',
    },
    {
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'Historical prompt' }],
      origin: { kind: 'user' },
    },
    {
      type: 'context.append_message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Historical prompt' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'step.begin',
        uuid: 'resume-step',
        turnId: '0',
        step: 1,
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        uuid: 'resume-content',
        turnId: '0',
        step: 1,
        stepUuid: 'resume-step',
        part: { type: 'text', text: 'Historical assistant text.' },
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        uuid: 'resume-tool-call',
        turnId: '0',
        step: 1,
        stepUuid: 'resume-step',
        toolCallId: 'call_resume_bash',
        name: 'Bash',
        args: { command: 'printf should-not-rerun', timeout: 60 },
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'resume-tool-call',
        toolCallId: 'call_resume_bash',
        result: { output: 'already ran' },
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'step.end',
        uuid: 'resume-step',
        turnId: '0',
        step: 1,
        usage: {
          inputOther: 10,
          output: 2,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
        finishReason: 'tool_use',
      },
    },
    {
      type: 'usage.record',
      model: 'mock-model',
      usage: {
        inputOther: 10,
        output: 2,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
    },
    {
      type: 'full_compaction.begin',
      source: 'auto',
    },
    {
      type: 'full_compaction.complete',
    },
    {
      type: 'context.apply_compaction',
      summary: 'Historical compacted summary.',
      compactedCount: 3,
      tokensBefore: 12,
      tokensAfter: 4,
    },
    {
      type: 'plan_mode.enter',
      id: 'resume-plan',
    },
  ];
}

function resumeDeferredSystemReminderHistory(): AgentRecord[] {
  return [
    {
      type: 'config.update',
      cwd: process.cwd(),
      modelAlias: MOCK_PROVIDER.model,
      systemPrompt: DEFAULT_TEST_SYSTEM_PROMPT,
      thinkingEffort: 'off',
    },
    {
      type: 'context.append_message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Historical prompt before skill' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'step.begin',
        uuid: 'resume-skill-step',
        turnId: '0',
        step: 1,
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        uuid: 'call_resume_write',
        turnId: '0',
        step: 1,
        stepUuid: 'resume-skill-step',
        toolCallId: 'call_resume_write',
        name: 'Write',
        args: { path: 'result.txt' },
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        uuid: 'call_resume_skill',
        turnId: '0',
        step: 1,
        stepUuid: 'resume-skill-step',
        toolCallId: 'call_resume_skill',
        name: 'Skill',
        args: { skill: 'review' },
      },
    },
    {
      type: 'context.append_message',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<system-reminder>\nresume skill body\n</system-reminder>',
          },
        ],
        toolCalls: [],
        origin: {
          kind: 'skill_activation',
          activationId: 'act_resume_skill',
          skillName: 'review',
          trigger: 'model-tool',
        },
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_resume_write',
        toolCallId: 'call_resume_write',
        result: { output: 'wrote file' },
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_resume_skill',
        toolCallId: 'call_resume_skill',
        result: { output: 'skill loaded' },
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'step.end',
        uuid: 'resume-skill-step',
        turnId: '0',
        step: 1,
        usage: {
          inputOther: 10,
          output: 2,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
        finishReason: 'tool_use',
      },
    },
  ];
}

function resumeConfigRecord(): AgentRecord {
  return {
    type: 'config.update',
    cwd: process.cwd(),
    modelAlias: MOCK_PROVIDER.model,
    systemPrompt: DEFAULT_TEST_SYSTEM_PROMPT,
    thinkingEffort: 'off',
  };
}

// Compact record builders for the B-tier ledger/reattachment tests.

function userMessageRecord(text: string): AgentRecord {
  return {
    type: 'context.append_message',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'user' },
    },
  };
}

function loopStepBeginRecord(uuid: string, turnId: string): AgentRecord {
  return {
    type: 'context.append_loop_event',
    event: { type: 'step.begin', uuid, turnId, step: 1 },
  };
}

function loopStepEndRecord(uuid: string, turnId: string): AgentRecord {
  return {
    type: 'context.append_loop_event',
    event: {
      type: 'step.end',
      uuid,
      turnId,
      step: 1,
      usage: { inputOther: 5, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
      finishReason: 'end_turn',
    },
  };
}

function loopContentPartRecord(
  uuid: string,
  stepUuid: string,
  turnId: string,
  text: string,
): AgentRecord {
  return {
    type: 'context.append_loop_event',
    event: {
      type: 'content.part',
      uuid,
      turnId,
      step: 1,
      stepUuid,
      part: { type: 'text', text },
    },
  };
}

function loopToolCallRecord(toolCallId: string, stepUuid: string, turnId: string): AgentRecord {
  return {
    type: 'context.append_loop_event',
    event: {
      type: 'tool.call',
      uuid: `uuid-${toolCallId}`,
      turnId,
      step: 1,
      stepUuid,
      toolCallId,
      name: 'Lookup',
      args: {},
    },
  };
}

function loopToolResultRecord(
  toolCallId: string,
  output: string,
  isError?: boolean,
): AgentRecord {
  return {
    type: 'context.append_loop_event',
    event: {
      type: 'tool.result',
      parentUuid: toolCallId,
      toolCallId,
      result: { output, ...(isError === true ? { isError: true } : {}) },
    },
  };
}

// Loop events for one fully-run turn: a single step that emits text and ends.
// Used to represent both prompted turns and internal (goal-continuation) turns.
function loopEventsForTurn(turnId: string, responseText: string): AgentRecord[] {
  return [
    {
      type: 'context.append_loop_event',
      event: { type: 'step.begin', uuid: `step-${turnId}`, turnId, step: 1 },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        uuid: `content-${turnId}`,
        turnId,
        step: 1,
        stepUuid: `step-${turnId}`,
        part: { type: 'text', text: responseText },
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'step.end',
        uuid: `step-${turnId}`,
        turnId,
        step: 1,
        usage: { inputOther: 5, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
        finishReason: 'end_turn',
      },
    },
    {
      type: 'usage.record',
      model: MOCK_PROVIDER.model,
      usage: { inputOther: 5, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
    },
  ];
}

// A prompted turn: the `turn.prompt` record + the appended user message + the
// loop events the turn produced.
function minimalPromptedTurn(turnId: string, promptText: string, responseText: string): AgentRecord[] {
  return [
    {
      type: 'turn.prompt',
      input: [{ type: 'text', text: promptText }],
      origin: { kind: 'user' },
    },
    {
      type: 'context.append_message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: promptText }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    },
    ...loopEventsForTurn(turnId, responseText),
  ];
}

function multiTurnResumeHistory(): AgentRecord[] {
  return [
    resumeConfigRecord(),
    ...minimalPromptedTurn('0', 'First historical prompt', 'First historical response.'),
    ...minimalPromptedTurn('1', 'Second historical prompt', 'Second historical response.'),
  ];
}

// One prompted turn (turnId 0) followed by two goal-continuation turns (1, 2)
// that have NO turn.prompt record — only loop events carry their turnId.
function goalContinuationResumeHistory(): AgentRecord[] {
  return [
    resumeConfigRecord(),
    ...minimalPromptedTurn('0', 'Goal prompt', 'Starting the goal.'),
    ...loopEventsForTurn('1', 'Continuation turn one.'),
    ...loopEventsForTurn('2', 'Continuation turn two.'),
  ];
}


function findRpcEvent(
  ctxEvents: readonly { type: string; event: string; args: unknown }[],
  event: string,
) {
  return ctxEvents.find((entry) => entry.type === '[rpc]' && entry.event === event);
}

describe('limitAgentReplayByTurns', () => {
  const replayMessage = (
    role: 'user' | 'assistant',
    text: string,
    origin?: PromptOrigin,
  ): AgentReplayRecord =>
    ({
      time: 0,
      type: 'message',
      message: { role, content: [{ type: 'text', text }], ...(origin ? { origin } : {}) },
    }) as AgentReplayRecord;

  it('returns the full replay when maxTurns is undefined', () => {
    const records = [replayMessage('user', 'a'), replayMessage('assistant', 'b')];
    expect(limitAgentReplayByTurns(records, undefined)).toBe(records);
  });

  it('returns an empty replay when maxTurns is zero', () => {
    expect(limitAgentReplayByTurns([replayMessage('user', 'a')], 0)).toEqual([]);
  });

  it('keeps the most recent user turns, treating system-triggered user messages as continuations', () => {
    const records = [
      replayMessage('user', 'first', { kind: 'user' }),
      replayMessage('assistant', 'one'),
      replayMessage('user', 'second', { kind: 'user' }),
      replayMessage('user', 'goal continuation', { kind: 'system_trigger', name: 'goal' }),
      replayMessage('assistant', 'two'),
      replayMessage('user', 'third', { kind: 'user' }),
      replayMessage('assistant', 'three'),
    ];
    expect(limitAgentReplayByTurns(records, 2)).toEqual(records.slice(2));
  });

  it('treats user-slash activations and shell command inputs as boundaries, but not their outputs', () => {
    const records = [
      replayMessage('user', 't1', { kind: 'user' }),
      replayMessage('user', '/skill', {
        kind: 'skill_activation',
        activationId: 'act-1',
        skillName: 'demo',
        trigger: 'user-slash',
      }),
      replayMessage('user', '!ls', { kind: 'shell_command', phase: 'input' }),
      replayMessage('user', 'ls output', { kind: 'shell_command', phase: 'output' }),
      replayMessage('user', 't2', { kind: 'user' }),
    ];
    expect(limitAgentReplayByTurns(records, 2)).toEqual(records.slice(2));
  });

  it('treats goal continuation prompts as turn boundaries, but not other system triggers', () => {
    const rounds = (n: number): AgentReplayRecord[] =>
      Array.from({ length: n }, (_, i) => [
        replayMessage('user', 'Resume the active goal.', {
          kind: 'system_trigger',
          name: 'goal_continuation',
        }),
        replayMessage('assistant', `round ${i}`),
      ]).flat();
    const records = [
      replayMessage('user', '/goal ship it', { kind: 'user' }),
      ...rounds(15),
      replayMessage('user', 'cancelled reminder', {
        kind: 'system_trigger',
        name: 'goal_cancelled',
      }),
    ];
    const limited = limitAgentReplayByTurns(records, 10);
    // The /goal prompt and the first five continuation rounds fall away; the
    // trailing reminder stays attached to the last kept turn.
    expect(limited).toEqual(records.slice(11));
  });
});
