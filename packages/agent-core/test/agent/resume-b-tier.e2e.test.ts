/**
 * B-tier e2e: resume a REAL wire.jsonl carrying every damage class the
 * resume graph-repair layer owns — an interrupted parallel tool batch, a
 * deleted span (undo racing a live step), an orphaned ghost result, and a
 * late-arriving real result — and assert the rebuilt session is an API-legal,
 * continuable transcript with a complete repair ledger and no drift warning.
 *
 * Complements the in-memory unit coverage in `resume.test.ts` by running the
 * whole pipeline through `FileSystemAgentRecordPersistence`: file → replay →
 * repair → injection → re-resume idempotence.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { describe, expect, it } from 'vitest';

import type { AgentRecord } from '../../src/agent';
import type { ResumeRepairEntry } from '../../src/agent/context';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  FileSystemAgentRecordPersistence,
} from '../../src/agent/records';
import { testAgent } from './harness/agent';
import { DEFAULT_TEST_SYSTEM_PROMPT } from './harness/snapshots';

const MOCK_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'mock-model',
} as const;

describe('04i B-tier e2e: resume a damaged wire file into an API-legal session', () => {
  it('repairs interrupted + deleted + orphaned structure and stays idempotent across resumes', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'resume-b-tier-e2e-'));
    try {
      const wirePath = join(sessionDir, 'wire.jsonl');
      await writeFile(wirePath, damagedWireRecords().map((r) => JSON.stringify(r)).join('\n') + '\n');

      const ctx = testAgent({ persistence: new FileSystemAgentRecordPersistence(wirePath) });
      await ctx.agent.resume();

      const expectedRoles = [
        'user', // turn one prompt
        'assistant', // turn one answer
        'user', // "run three lookups"
        'assistant', // the parallel batch step (3 calls)
        'tool', // call_two's recorded result
        'tool', // call_one: interrupted placeholder (closed at the next step)
        'tool', // call_three: REAL late result, re-attached over its placeholder
        'assistant', // the recovery turn
        'user', // the final unanswered prompt
        'user', // the injected resume-continuation reminder
      ];
      expect(ctx.agent.context.history.map((message) => message.role)).toEqual(expectedRoles);

      // The late real output replaced the placeholder in position.
      const recovered = ctx.agent.context.history[6];
      expect(recovered).toMatchObject({ role: 'tool', toolCallId: 'call_three' });
      expect(textContent(recovered)).toBe('three real result');
      expect(recovered?.isError).toBeFalsy();
      // call_one keeps its interrupted placeholder (no result ever arrived).
      expect(ctx.agent.context.history[5]).toMatchObject({
        toolCallId: 'call_one',
        isError: true,
      });
      expect(textContent(ctx.agent.context.history[5])).toContain(
        'Tool execution was interrupted before its result was recorded',
      );

      // The undo-raced turn is gone entirely (deleted span): no 'undo me'
      // prompt, no raced call, no raced text anywhere in history.
      expect(
        ctx.agent.context.history.some((message) => textContent(message).includes('undo me')),
      ).toBe(false);
      expect(
        ctx.agent.context.history.some(
          (message) => message.role === 'tool' && message.toolCallId === 'call_raced',
        ),
      ).toBe(false);
      // The ghost result was dropped, not re-hung.
      expect(
        ctx.agent.context.history.some(
          (message) => message.role === 'tool' && message.toolCallId === 'call_nine',
        ),
      ).toBe(false);

      // The continuation reminder fired exactly once, at the tail.
      const reminders = ctx.agent.context.history.filter(
        (message) =>
          message.origin?.kind === 'injection' &&
          message.origin.variant === 'resume_continuation',
      );
      expect(reminders).toHaveLength(1);
      expect(textContent(reminders[0])).toContain('Continue from where you left off');

      // The complete repair ledger, in replay order.
      expect(ctx.agent.context.resumeRepairs).toEqual([
        {
          kind: 'tool_calls_closed_at_step_boundary',
          toolCallIds: ['call_one', 'call_three'],
        },
        { kind: 'late_tool_result_reattached', toolCallId: 'call_three' },
        { kind: 'orphan_tool_result_dropped', toolCallId: 'call_nine' },
        { kind: 'orphan_step_event_skipped', eventType: 'content.part', stepUuid: 'u-step' },
        { kind: 'orphan_tool_result_dropped', toolCallId: 'call_raced' },
      ] satisfies ResumeRepairEntry[]);

      // Everything was repairable: no user-facing drift warning.
      expect(findWarning(ctx.allEvents)).toBeUndefined();

      // API-legality of the outgoing projection: the parallel batch's three
      // calls are each answered by exactly one tool message right after it.
      const projected = ctx.agent.context.messages;
      expect(projected.map((message) => message.role)).toEqual(expectedRoles);
      const batch = projected[3];
      expect(batch?.role).toBe('assistant');
      const batchCallIds = (batch?.toolCalls ?? []).map((call) => call.id).toSorted();
      expect(batchCallIds).toEqual(['call_one', 'call_three', 'call_two']);
      const answerIds = projected
        .slice(4, 7)
        .map((message) => (message.role === 'tool' ? message.toolCallId : undefined))
        .toSorted();
      expect(answerIds).toEqual(['call_one', 'call_three', 'call_two']);

      // The repairs are re-derived, never persisted: the only record the
      // resume appended is the continuation reminder.
      await ctx.agent.records.flush();
      const afterFirst = await readWireRecords(wirePath);
      const appended = afterFirst.slice(damagedWireRecords().length);
      expect(appended).toHaveLength(1);
      expect(appended[0]).toMatchObject({
        type: 'context.append_message',
        message: { origin: { kind: 'injection', variant: 'resume_continuation' } },
      });

      await ctx.expectResumeMatches();

      // Second resume over the same file: repairs re-derived identically, the
      // persisted reminder dedups (no stacking), still no drift warning.
      const second = testAgent({ persistence: new FileSystemAgentRecordPersistence(wirePath) });
      await second.agent.resume();

      expect(second.agent.context.history.map((message) => message.role)).toEqual(expectedRoles);
      expect(
        second.agent.context.history.filter(
          (message) =>
            message.origin?.kind === 'injection' &&
            message.origin.variant === 'resume_continuation',
        ),
      ).toHaveLength(1);
      expect(second.agent.context.resumeRepairs).toEqual(ctx.agent.context.resumeRepairs);
      expect(findWarning(second.allEvents)).toBeUndefined();
      expect(textContent(second.agent.context.history[6])).toBe('three real result');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });
});

function damagedWireRecords(): AgentRecord[] {
  return [
    {
      type: 'metadata',
      protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
      created_at: 1,
    },
    {
      type: 'config.update',
      cwd: process.cwd(),
      modelAlias: MOCK_PROVIDER.model,
      systemPrompt: DEFAULT_TEST_SYSTEM_PROMPT,
      thinkingEffort: 'off',
    },
    // Turn one: a clean, fully-run turn.
    ...promptedTurn('0', 'turn one', 'First answer.'),
    // Turn two: a three-way parallel batch interrupted after one result.
    ...promptRecords('1', 'run three lookups'),
    stepBegin('p-step', '1'),
    toolCall('call_one', 'p-step', '1'),
    toolCall('call_two', 'p-step', '1'),
    toolCall('call_three', 'p-step', '1'),
    toolResult('call_two', 'two result'),
    // The recovery turn begins: its step boundary closes call_one/call_three
    // in place with interrupted placeholders.
    stepBegin('r-step', '2'),
    contentPart('r-part', 'r-step', '2', 'Recovered.'),
    stepEnd('r-step', '2'),
    usageRecord(),
    // …and only then does call_three's REAL result land (late parallel
    // result), followed by a ghost result whose call was never recorded.
    toolResult('call_three', 'three real result'),
    toolResult('call_nine', 'ghost output'),
    // Deleted span: a turn the user undid while its step was still streaming.
    ...promptRecords('3', 'undo me'),
    stepBegin('u-step', '3'),
    toolCall('call_raced', 'u-step', '3'),
    { type: 'context.undo', count: 1 },
    contentPart('u-part', 'u-step', '3', 'raced text'),
    toolResult('call_raced', 'raced output'),
    // The final prompt the process died before answering.
    ...promptRecords('4', 'final unanswered'),
  ];
}

async function readWireRecords(wirePath: string): Promise<AgentRecord[]> {
  const raw = await readFile(wirePath, 'utf-8');
  return raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as AgentRecord);
}

function findWarning(
  events: readonly { type: string; event: string; args: unknown }[],
): unknown {
  return events.find((entry) => entry.type === '[rpc]' && entry.event === 'warning');
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

function promptRecords(turnId: string, text: string): AgentRecord[] {
  return [
    {
      type: 'turn.prompt',
      input: [{ type: 'text', text }],
      origin: { kind: 'user' },
    },
    {
      type: 'context.append_message',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    },
  ];
}

function promptedTurn(turnId: string, promptText: string, responseText: string): AgentRecord[] {
  return [
    ...promptRecords(turnId, promptText),
    stepBegin(`step-${turnId}`, turnId),
    contentPart(`content-${turnId}`, `step-${turnId}`, turnId, responseText),
    stepEnd(`step-${turnId}`, turnId),
    usageRecord(),
  ];
}

function stepBegin(uuid: string, turnId: string): AgentRecord {
  return {
    type: 'context.append_loop_event',
    event: { type: 'step.begin', uuid, turnId, step: 1 },
  };
}

function stepEnd(uuid: string, turnId: string): AgentRecord {
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

function contentPart(uuid: string, stepUuid: string, turnId: string, text: string): AgentRecord {
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

function toolCall(toolCallId: string, stepUuid: string, turnId: string): AgentRecord {
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

function toolResult(toolCallId: string, output: string): AgentRecord {
  return {
    type: 'context.append_loop_event',
    event: {
      type: 'tool.result',
      parentUuid: toolCallId,
      toolCallId,
      result: { output },
    },
  };
}

function usageRecord(): AgentRecord {
  return {
    type: 'usage.record',
    model: MOCK_PROVIDER.model,
    usage: { inputOther: 5, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
  };
}
