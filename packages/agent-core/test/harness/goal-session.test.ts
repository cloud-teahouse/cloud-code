import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import {
  APIConnectionError,
  APIStatusError,
  type GenerateResult,
  type ProviderConfig,
} from '@cloud-code/kosong';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderManager } from '../../src/session/provider-manager';
import type { AgentOptions } from '../../src/agent';
import type { CloudCodeConfig } from '../../src/config';
import { ErrorCodes, CloudCodeError } from '../../src/errors';
import type { HookDef } from '../../src/session/hooks';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { SessionAPIImpl } from '../../src/session/rpc';
import { createScriptedGenerate } from '../agent/harness/scripted-generate';
import { testKaos } from '../fixtures/test-kaos';

const MOCK_PROVIDER = { type: 'kimi', apiKey: 'test-key', model: 'mock-model' } as const satisfies ProviderConfig;

const tempDirs: string[] = [];
const openSessions: Session[] = [];

function track(session: Session): Session {
  openSessions.push(session);
  return session;
}

afterEach(async () => {
  // Close sessions first so their async metadata/wire writes settle before the
  // temp dirs are removed (otherwise rm races with a write -> ENOTEMPTY).
  await Promise.allSettled(openSessions.splice(0).map((s) => s.close()));
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-goal-session-'));
  tempDirs.push(dir);
  return dir;
}

function testProviderManager(): ProviderManager {
  return new ProviderManager({
    config: {
      providers: { test: { type: MOCK_PROVIDER.type, apiKey: MOCK_PROVIDER.apiKey } },
      models: { [MOCK_PROVIDER.model]: { provider: 'test', model: MOCK_PROVIDER.model, maxContextSize: 1_000_000 } },
    },
  });
}

function goalProfile(tools: readonly string[]): ResolvedAgentProfile {
  return { name: 'test', systemPrompt: () => '<system-prompt>', tools: [...tools] };
}

function createSessionRpc(events: Array<Record<string, unknown>>): SDKSessionRPC {
  return {
    emitEvent: vi.fn(async (event) => {
      events.push(event);
    }),
    requestApproval: vi.fn(async () => ({ decision: 'approved', selectedLabel: 'approve' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({ output: '', isError: true })),
  } as unknown as SDKSessionRPC;
}

async function readWireRecords(sessionDir: string): Promise<Array<Record<string, unknown>>> {
  const wire = await readFile(join(sessionDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
  return wire
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function setupSession(
  sessionDir: string,
  events: Array<Record<string, unknown>>,
  tools: readonly string[],
  generate?: NonNullable<AgentOptions['generate']>,
  hooks?: readonly HookDef[],
  config?: CloudCodeConfig,
) {
  const scripted = createScriptedGenerate();
  const session = track(
    new Session({
      id: 'goal-session',
      kaos: testKaos.withCwd(sessionDir),
      homedir: sessionDir,
      rpc: createSessionRpc(events),
      skills: { explicitDirs: [join(sessionDir, 'missing')] },
      providerManager: testProviderManager(),
      hooks,
      config,
    }),
  );
  const { agent } = await session.createAgent(
    { type: 'main', generate: generate ?? scripted.generate },
    { profile: goalProfile(tools) },
  );
  agent.config.update({ modelAlias: 'mock-model', thinkingEffort: 'off' });
  agent.permission.setMode('yolo');
  return { session, agent, scripted };
}

describe('goal session end-to-end', () => {
  it('drives a goal across sequential turns until the model marks it complete', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(sessionDir, events, ['GetGoal', 'UpdateGoal']);
    const api = new SessionAPIImpl(session);

    await api.createGoal({ agentId: 'main', objective: 'Ship feature X' });

    // Turn 1 stops without deciding -> the driver runs a second turn. In turn 2
    // the model calls UpdateGoal('complete'), which clears the goal. The turn
    // then gives the model one final step to summarize how it finished.
    scripted.mockNextResponse({ type: 'text', text: 'Working on the objective.' });
    scripted.mockNextResponse({
      type: 'function',
      id: 'c1',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'complete' }),
    });
    scripted.mockNextResponse({
      type: 'text',
      text: 'I completed the goal by updating the feature and running the tests.',
    });

    agent.turn.prompt([{ type: 'text', text: 'Ship feature X' }]);
    // Wait for the whole goal drive (many turns), not just the first turn.ended.
    await agent.turn.waitForCurrentTurn();
    await session.flushMetadata();

    // The goal ran as more than one turn (start/end per continuation).
    const turnStarts = events.filter((e) => e['type'] === 'turn.started').length;
    expect(turnStarts).toBeGreaterThanOrEqual(2);

    // Goal injection reached the model on the first turn.
    const firstHistory = JSON.stringify(scripted.calls[0]?.history ?? []);
    expect(firstHistory).toContain('<untrusted_objective>');

    // Continuation turns should nudge the model to decide obvious terminal cases
    // instead of spending another round over-interpreting the goal.
    const continuationHistory = JSON.stringify(scripted.calls[1]?.history ?? []);
    expect(continuationHistory).toContain('Keep the self-audit brief');
    expect(continuationHistory).toContain('do not run another goal turn');
    expect(continuationHistory).toContain('end the turn normally without calling UpdateGoal');
    expect(continuationHistory).toContain('Completion audit');
    expect(continuationHistory).toContain('Blocked audit');
    expect(continuationHistory).toContain('3 consecutive goal turns');
    expect(continuationHistory).toContain('fresh blocked audit');
    expect(continuationHistory).toContain('impossible, unsafe, or contradictory');
    expect(continuationHistory).toContain('do not run more goal turns just to satisfy the audit');
    expect(continuationHistory).toContain('only for a genuine impasse');

    // Terminal UpdateGoal asks the model for one final user-facing summary.
    expect(scripted.calls).toHaveLength(3);
    const completionToolResult = events.find(
      (event) => event['type'] === 'tool.result' && event['toolCallId'] === 'c1',
    );
    expect(String(completionToolResult?.['output'])).toContain('Goal completed successfully.');
    expect(String(completionToolResult?.['output'])).toContain('Write a concise final message for the user');
    const summaryHistory = JSON.stringify(scripted.calls[2]?.history ?? []);
    expect(summaryHistory).toContain('Goal completed successfully.');
    expect(summaryHistory).toContain('Write a concise final message for the user');
    const lastContextMessage = agent.context.history.at(-1);
    expect(lastContextMessage?.role).toBe('assistant');
    expect(JSON.stringify(lastContextMessage?.content)).toContain(
      'I completed the goal by updating the feature and running the tests.',
    );

    // Completion is transient: it announces, then clears the durable record, so
    // the goal box disappears and nothing is left on disk.
    const raw = await readFile(join(sessionDir, 'state.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { custom: { goal?: { status: string } } };
    expect(parsed.custom.goal).toBeUndefined();
    expect((await api.getGoal({ agentId: 'main' })).goal).toBeNull();

    // Audit trail records the whole run incl. completion — and no evaluator record.
    const records = await readWireRecords(sessionDir);
    const types = new Set(records.map((record) => record['type']));
    for (const t of ['goal.create', 'goal.update', 'goal.clear']) {
      expect(types.has(t)).toBe(true);
    }
    expect(JSON.stringify(records)).not.toContain('goal_completion');
    expect(types.has('goal.evaluate')).toBe(false);
    expect(types.has('goal.account_usage')).toBe(false);
    expect(types.has('goal.continuation')).toBe(false);
    const usageRecords = records.filter(
      (record) => record['type'] === 'goal.update' && typeof record['tokensUsed'] === 'number',
    );
    expect(usageRecords).toHaveLength(2);
    const finalUsage = usageRecords.at(-1)?.['tokensUsed'];
    expect(typeof finalUsage).toBe('number');
    const completion = records.find(
      (record) => record['type'] === 'goal.update' && record['status'] === 'complete',
    );
    expect(completion).toBeDefined();
    expect(finalUsage).toBeGreaterThan(0);
  });

  it('blocks at a turn budget (no wrap-up segment)', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(sessionDir, events, ['GetGoal']);
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'work' });
    await agent.goal.setBudgetLimits({ budgetLimits: { turnBudget: 1 } }, 'model');

    scripted.mockNextResponse({ type: 'text', text: 'step 1' });

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await agent.turn.waitForCurrentTurn();
    await session.flushMetadata();

    // One turn, then the turn budget blocks the goal (resumable) — no second turn.
    expect((await api.getGoal({ agentId: 'main' })).goal?.status).toBe('blocked');
    expect(scripted.calls.length).toBe(1);
  });

  it('blocks at the tiered default turn budget when no explicit budget is set', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(sessionDir, events, ['GetGoal']);
    const api = new SessionAPIImpl(session);
    // P3: the short objective heuristically tiers `small`, whose default caps
    // (10 turns / 300k tokens) are filled at creation — no SetGoalBudget here.
    await api.createGoal({ agentId: 'main', objective: 'work' });
    expect((await api.getGoal({ agentId: 'main' })).goal?.budget.turnBudget).toBe(10);

    // The model never decides, so the driver keeps running continuation turns
    // until the tiered 10-turn default blocks the goal at the drive boundary.
    for (let i = 1; i <= 10; i += 1) {
      scripted.mockNextResponse({ type: 'text', text: `step ${String(i)}` });
    }

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await agent.turn.waitForCurrentTurn();
    await session.flushMetadata();

    const goal = (await api.getGoal({ agentId: 'main' })).goal;
    expect(scripted.calls.length).toBe(10);
    expect(goal?.status).toBe('blocked');
    expect(goal?.turnsUsed).toBe(10);
    expect(goal?.terminalReason).toBe('A configured budget was reached');
  });

  it('continues goal mode after the model resumes a paused goal', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(sessionDir, events, ['GetGoal', 'UpdateGoal']);
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'work' });
    await api.pauseGoal({ agentId: 'main' });

    scripted.mockNextResponse({
      type: 'function',
      id: 'resume',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'active' }),
    });
    scripted.mockNextResponse({ type: 'text', text: 'Resumed the goal.' });
    scripted.mockNextResponse({
      type: 'function',
      id: 'complete',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'complete' }),
    });
    scripted.mockNextResponse({ type: 'text', text: 'I completed the resumed goal.' });

    agent.turn.prompt([{ type: 'text', text: 'Keep working on the goal' }]);
    await agent.turn.waitForCurrentTurn();

    expect(scripted.calls.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(scripted.calls[0]?.history ?? [])).toContain('currently paused');
    expect(JSON.stringify(scripted.calls[2]?.history ?? [])).toContain('Continue working toward the active goal');
    expect(JSON.stringify(scripted.calls[3]?.history ?? [])).toContain('Write a concise final message for the user');
    expect((await api.getGoal({ agentId: 'main' })).goal).toBeNull();
  });

  it('drives a goal the model creates mid-turn with CreateGoal', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(sessionDir, events, [
      'CreateGoal',
      'GetGoal',
      'UpdateGoal',
    ]);
    const api = new SessionAPIImpl(session);

    // No goal exists at launch. The model creates one mid-turn via CreateGoal;
    // the driver must then pursue it across continuation turns instead of
    // stopping after the ordinary turn that merely started it.
    scripted.mockNextResponse({
      type: 'function',
      id: 'create',
      name: 'CreateGoal',
      arguments: JSON.stringify({ objective: 'work' }),
    });
    scripted.mockNextResponse({ type: 'text', text: 'Goal created and active.' });
    scripted.mockNextResponse({
      type: 'function',
      id: 'complete',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'complete' }),
    });
    scripted.mockNextResponse({ type: 'text', text: 'I completed the goal.' });

    agent.turn.prompt([{ type: 'text', text: 'Please start a goal to do the work' }]);
    await agent.turn.waitForCurrentTurn();

    // The driver ran a continuation turn after the goal became active, reaching
    // the UpdateGoal('complete') the standalone turn never would have.
    expect(scripted.calls.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(scripted.calls[2]?.history ?? [])).toContain(
      'Continue working toward the active goal',
    );
    const turnStarts = events.filter((e) => e['type'] === 'turn.started').length;
    expect(turnStarts).toBeGreaterThanOrEqual(2);
    const completionEvent = events.find((event) => {
      const change = event['change'] as Record<string, unknown> | undefined;
      return event['type'] === 'goal.updated' && change?.['kind'] === 'completion';
    });
    expect(completionEvent?.['change']).toMatchObject({
      kind: 'completion',
      stats: expect.objectContaining({ turnsUsed: 2 }),
    });
    expect((await api.getGoal({ agentId: 'main' })).goal).toBeNull();
  });

  it('does not start a synthetic continuation when creating the goal exhausts its turn budget', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(sessionDir, events, [
      'CreateGoal',
      'SetGoalBudget',
    ]);
    const api = new SessionAPIImpl(session);

    scripted.mockNextResponse({
      type: 'function',
      id: 'create',
      name: 'CreateGoal',
      arguments: JSON.stringify({ objective: 'work' }),
    });
    scripted.mockNextResponse({
      type: 'function',
      id: 'budget',
      name: 'SetGoalBudget',
      arguments: JSON.stringify({ value: 1, unit: 'turns' }),
    });
    scripted.mockNextResponse({ type: 'text', text: 'Goal created with a one-turn budget.' });

    agent.turn.prompt([{ type: 'text', text: 'Please start a one-turn goal' }]);
    await agent.turn.waitForCurrentTurn();

    const goal = (await api.getGoal({ agentId: 'main' })).goal;
    expect(goal?.status).toBe('blocked');
    expect(goal?.turnsUsed).toBe(1);
    expect(scripted.calls).toHaveLength(3);
    expect(events.filter((e) => e['type'] === 'turn.started')).toHaveLength(1);
    expect(JSON.stringify(agent.context.history)).not.toContain(
      'Continue working toward the active goal',
    );
  });

  it('keeps the active turn alive (cancelable) while driving a goal created mid-turn', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const scripted = createScriptedGenerate();
    let agentRef: { turn: { readonly hasActiveTurn: boolean } } | undefined;
    const activeDuringCall: boolean[] = [];
    const generate: NonNullable<AgentOptions['generate']> = (...args) => {
      activeDuringCall.push(agentRef?.turn.hasActiveTurn ?? false);
      return scripted.generate(...args);
    };
    const { agent } = await setupSession(
      sessionDir,
      events,
      ['CreateGoal', 'GetGoal', 'UpdateGoal'],
      generate,
    );
    agentRef = agent;

    scripted.mockNextResponse({
      type: 'function',
      id: 'create',
      name: 'CreateGoal',
      arguments: JSON.stringify({ objective: 'work' }),
    });
    scripted.mockNextResponse({ type: 'text', text: 'Goal created and active.' });
    scripted.mockNextResponse({
      type: 'function',
      id: 'complete',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'complete' }),
    });
    scripted.mockNextResponse({ type: 'text', text: 'I completed the goal.' });

    agent.turn.prompt([{ type: 'text', text: 'Please start a goal to do the work' }]);
    await agent.turn.waitForCurrentTurn();

    // Calls 0-1 are the standalone first turn (CreateGoal, then text); calls 2-3
    // are the goal driver's continuation turn. The continuation must run under a
    // live active turn so a user cancel can abort it and no concurrent turn can
    // launch. Before the fix the standalone turn released the active turn the
    // instant it created the goal, leaving calls 2-3 with no active turn.
    expect(activeDuringCall.length).toBeGreaterThanOrEqual(4);
    expect(activeDuringCall[2]).toBe(true);
    expect(activeDuringCall[3]).toBe(true);
  });

  it('asks the model to explain why it marked a goal blocked', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(sessionDir, events, ['GetGoal', 'UpdateGoal']);
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'work' });

    scripted.mockNextResponse({
      type: 'function',
      id: 'blocked',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'blocked' }),
    });
    scripted.mockNextResponse({
      type: 'text',
      text: 'I blocked the goal because credentials are required before I can continue.',
    });

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await agent.turn.waitForCurrentTurn();

    expect(scripted.calls).toHaveLength(2);
    const blockedToolResult = events.find(
      (event) => event['type'] === 'tool.result' && event['toolCallId'] === 'blocked',
    );
    expect(String(blockedToolResult?.['output'])).toContain('Goal blocked.');
    expect(String(blockedToolResult?.['output'])).toContain('concrete blocker');
    const reasonHistory = JSON.stringify(scripted.calls[1]?.history ?? []);
    expect(reasonHistory).toContain('Goal blocked.');
    expect(reasonHistory).toContain('State that the goal is blocked');
    const lastContextMessage = agent.context.history.at(-1);
    expect(lastContextMessage?.role).toBe('assistant');
    expect(JSON.stringify(lastContextMessage?.content)).toContain(
      'I blocked the goal because credentials are required before I can continue.',
    );
    const goal = (await api.getGoal({ agentId: 'main' })).goal;
    expect(goal?.status).toBe('blocked');
    expect(goal?.terminalReason).toBeUndefined();
  });

  it('does not force a goal outcome summary after maxStepsPerTurn is exhausted', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(
      sessionDir,
      events,
      ['GetGoal', 'UpdateGoal'],
      undefined,
      undefined,
      { providers: {}, loopControl: { maxStepsPerTurn: 1 } },
    );
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'work' });

    scripted.mockNextResponse({
      type: 'function',
      id: 'complete',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'complete' }),
    });
    scripted.mockNextResponse({ type: 'text', text: 'This summary should not run.' });

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await agent.turn.waitForCurrentTurn();

    expect(scripted.calls).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'turn.ended',
        reason: 'completed',
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: 'turn.ended',
        reason: 'failed',
        error: expect.objectContaining({ code: ErrorCodes.LOOP_MAX_STEPS_EXCEEDED }),
      }),
    );
    expect((await api.getGoal({ agentId: 'main' })).goal).toBeNull();
    expect(JSON.stringify(agent.context.history)).toContain('Write a concise final message');
    expect(JSON.stringify(agent.context.history)).not.toContain('This summary should not run.');
    expect(agent.context.history.at(-1)?.role).toBe('tool');
  });

  it('continues the goal when a goal turn hits maxStepsPerTurn', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(
      sessionDir,
      events,
      ['GetGoal', 'UpdateGoal'],
      undefined,
      undefined,
      { providers: {}, loopControl: { maxStepsPerTurn: 1 } },
    );
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'work' });

    // Each of the first two turns spends its single allowed step on a tool
    // call and is then cut by the step cap; the goal must keep going. The
    // third turn completes the goal within the cap.
    scripted.mockNextResponse({
      type: 'function',
      id: 'check-1',
      name: 'GetGoal',
      arguments: '{}',
    });
    scripted.mockNextResponse({
      type: 'function',
      id: 'check-2',
      name: 'GetGoal',
      arguments: '{}',
    });
    scripted.mockNextResponse({
      type: 'function',
      id: 'complete',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'complete' }),
    });

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await agent.turn.waitForCurrentTurn();

    expect(scripted.calls).toHaveLength(3);
    const maxStepEnds = events.filter(
      (event) =>
        event['type'] === 'turn.ended' &&
        event['reason'] === 'failed' &&
        (event['error'] as Record<string, unknown> | undefined)?.['code'] ===
          ErrorCodes.LOOP_MAX_STEPS_EXCEEDED,
    );
    expect(maxStepEnds).toHaveLength(2);
    // The cap never pauses or blocks the goal: no stopped status is ever
    // emitted, and the goal completes (record cleared) in the third turn.
    expect(
      events.filter(
        (event) =>
          event['type'] === 'goal.updated' &&
          ['paused', 'blocked'].includes(
            String((event['snapshot'] as Record<string, unknown> | null)?.['status']),
          ),
      ),
    ).toEqual([]);
    expect((await api.getGoal({ agentId: 'main' })).goal).toBeNull();
    const completion = events.find(
      (event) =>
        event['type'] === 'goal.updated' &&
        (event['change'] as Record<string, unknown> | undefined)?.['kind'] === 'completion',
    );
    expect((completion?.['change'] as Record<string, unknown>)?.['stats']).toMatchObject({
      turnsUsed: 3,
    });
    // Capped continuation turns are told why a new turn was started.
    const history = JSON.stringify(agent.context.history);
    expect(history).toContain('per-turn step limit');
    expect(history).toContain('Pick up where that turn stopped');
  });

  it('starts pursuing a goal created mid-turn even when that turn hits maxStepsPerTurn', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(
      sessionDir,
      events,
      ['CreateGoal', 'UpdateGoal'],
      undefined,
      undefined,
      { providers: {}, loopControl: { maxStepsPerTurn: 1 } },
    );
    const api = new SessionAPIImpl(session);

    // No goal at turn start: the model creates one on the only allowed step,
    // the turn is then cut by the cap, and pursuit must still begin — with a
    // continuation turn that explains the cap.
    scripted.mockNextResponse({
      type: 'function',
      id: 'create',
      name: 'CreateGoal',
      arguments: JSON.stringify({ objective: 'work' }),
    });
    scripted.mockNextResponse({
      type: 'function',
      id: 'complete',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'complete' }),
    });

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await agent.turn.waitForCurrentTurn();

    expect(scripted.calls).toHaveLength(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'turn.ended',
        reason: 'failed',
        error: expect.objectContaining({ code: ErrorCodes.LOOP_MAX_STEPS_EXCEEDED }),
      }),
    );
    expect(
      events.filter(
        (event) =>
          event['type'] === 'goal.updated' &&
          ['paused', 'blocked'].includes(
            String((event['snapshot'] as Record<string, unknown> | null)?.['status']),
          ),
      ),
    ).toEqual([]);
    expect((await api.getGoal({ agentId: 'main' })).goal).toBeNull();
    const completion = events.find(
      (event) =>
        event['type'] === 'goal.updated' &&
        (event['change'] as Record<string, unknown> | undefined)?.['kind'] === 'completion',
    );
    expect((completion?.['change'] as Record<string, unknown>)?.['stats']).toMatchObject({
      turnsUsed: 2,
    });
    expect(JSON.stringify(agent.context.history)).toContain('per-turn step limit');
  });

  it('pauses the goal on provider rate limits', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    // Pin the retry budget to 1 attempt: the pause behavior under test does
    // not depend on retries, and the default 10-attempt backoff would blow
    // the test timeout.
    const { session, agent } = await setupSession(
      sessionDir,
      events,
      ['GetGoal'],
      async () => {
        throw new APIStatusError(429, 'Rate limited', 'req-429');
      },
      undefined,
      { providers: {}, loopControl: { maxRetriesPerStep: 1 } },
    );
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'work' });

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await agent.turn.waitForCurrentTurn();

    const goal = (await api.getGoal({ agentId: 'main' })).goal;
    expect(goal?.status).toBe('paused');
    expect(goal?.terminalReason).toBe('Paused after provider rate limit');
  });

  it('pauses the goal on provider connection errors', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    // Pin the retry budget to 1 attempt: the pause behavior under test does
    // not depend on retries, and the default 10-attempt backoff would blow
    // the test timeout.
    const { session, agent } = await setupSession(
      sessionDir,
      events,
      ['GetGoal'],
      async () => {
        throw new APIConnectionError('socket hang up');
      },
      undefined,
      { providers: {}, loopControl: { maxRetriesPerStep: 1 } },
    );
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'work' });

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await agent.turn.waitForCurrentTurn();

    const goal = (await api.getGoal({ agentId: 'main' })).goal;
    expect(goal?.status).toBe('paused');
    expect(goal?.terminalReason).toBe('Paused after provider connection error: socket hang up');
  });

  it('pauses the goal on provider authentication errors', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent } = await setupSession(sessionDir, events, ['GetGoal'], async () => {
      throw new APIStatusError(401, 'Unauthorized', 'req-401');
    });
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'work' });

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await agent.turn.waitForCurrentTurn();

    const goal = (await api.getGoal({ agentId: 'main' })).goal;
    expect(goal?.status).toBe('paused');
    expect(goal?.terminalReason).toBe('Paused after provider authentication error: Unauthorized');
  });

  it('pauses the goal on model configuration errors', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent } = await setupSession(sessionDir, events, ['GetGoal'], async () => {
      throw new CloudCodeError(ErrorCodes.MODEL_NOT_CONFIGURED, 'Model not set');
    });
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'work' });

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await agent.turn.waitForCurrentTurn();

    const goal = (await api.getGoal({ agentId: 'main' })).goal;
    expect(goal?.status).toBe('paused');
    expect(goal?.terminalReason).toBe('Paused after model configuration error: LLM not set, send "/login" to login');
  });

  it('pauses the goal on runtime errors', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent } = await setupSession(sessionDir, events, ['GetGoal'], async () => {
      throw new Error('unexpected failure');
    });
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'work' });

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await agent.turn.waitForCurrentTurn();

    const goal = (await api.getGoal({ agentId: 'main' })).goal;
    expect(goal?.status).toBe('paused');
    expect(goal?.terminalReason).toBe('Paused after runtime error: unexpected failure');
  });

  it('pauses the goal on provider safety policy blocks', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const generate: NonNullable<AgentOptions['generate']> = async () => ({
      id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'filtered' }], toolCalls: [] },
      usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });
    const { session, agent } = await setupSession(sessionDir, events, ['GetGoal'], generate);
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'work' });

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await agent.turn.waitForCurrentTurn();

    const goal = (await api.getGoal({ agentId: 'main' })).goal;
    expect(goal?.status).toBe('paused');
    expect(goal?.terminalReason).toBe('Paused after provider safety policy block');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'turn.ended',
        reason: 'failed',
        error: expect.objectContaining({ code: 'provider.filtered' }),
      }),
    );
  });

  it('blocks the goal when the initial prompt hook blocks the objective', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(
      sessionDir,
      events,
      ['GetGoal', 'UpdateGoal'],
      undefined,
      [
        {
          event: 'UserPromptSubmit',
          matcher: 'blocked objective',
          command: 'node -e "process.stderr.write(\'blocked by policy\'); process.exit(2)"',
        },
      ],
    );
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'blocked objective' });

    agent.turn.prompt([{ type: 'text', text: 'blocked objective' }]);
    await agent.turn.waitForCurrentTurn();

    const goal = (await api.getGoal({ agentId: 'main' })).goal;
    expect(scripted.calls).toHaveLength(0);
    expect(goal?.status).toBe('blocked');
    expect(goal?.terminalReason).toBe('Blocked by UserPromptSubmit hook');
  });

  it('blocks immediately when a resumed goal is already over budget', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(sessionDir, events, ['GetGoal']);
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'work' });
    await agent.goal.setBudgetLimits({ budgetLimits: { turnBudget: 1 } }, 'model');
    await agent.goal.incrementTurn();
    await agent.goal.markBlocked({ reason: 'A configured budget was reached' });
    await api.resumeGoal({ agentId: 'main' });

    scripted.mockNextResponse({ type: 'text', text: 'should not run' });
    agent.turn.prompt([{ type: 'text', text: 'continue' }]);
    await agent.turn.waitForCurrentTurn();

    const goal = (await api.getGoal({ agentId: 'main' })).goal;
    expect(scripted.calls).toHaveLength(0);
    expect(goal?.status).toBe('blocked');
    expect(goal?.turnsUsed).toBe(1);
  });

  it('stops before another model step when a token budget is reached mid-turn', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(sessionDir, events, ['GetGoal']);
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'work' });
    await agent.goal.setBudgetLimits({ budgetLimits: { tokenBudget: 1 } }, 'model');

    scripted.mockNextResponse({
      type: 'function',
      id: 'g1',
      name: 'GetGoal',
      arguments: JSON.stringify({}),
    });
    scripted.mockNextResponse({ type: 'text', text: 'should not run' });

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await agent.turn.waitForCurrentTurn();

    const goal = (await api.getGoal({ agentId: 'main' })).goal;
    expect(scripted.calls).toHaveLength(1);
    expect(goal?.status).toBe('blocked');
    expect(goal?.tokensUsed).toBeGreaterThan(1);
  });

  it('counts only model output tokens against the goal token budget', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const largeInputSmallOutput = {
      inputOther: 10_000,
      inputCacheRead: 20_000,
      inputCacheCreation: 30_000,
      output: 1,
    };
    let calls = 0;
    const responses: GenerateResult[] = [
      {
        id: 'usage-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'working' }],
          toolCalls: [],
        },
        usage: largeInputSmallOutput,
        finishReason: 'completed',
        rawFinishReason: 'stop',
      },
      {
        id: 'usage-2',
        message: {
          role: 'assistant',
          content: [],
          toolCalls: [
            {
              type: 'function',
              id: 'complete',
              name: 'UpdateGoal',
              arguments: JSON.stringify({ status: 'complete' }),
            },
          ],
        },
        usage: largeInputSmallOutput,
        finishReason: 'tool_calls',
        rawFinishReason: 'tool_calls',
      },
      {
        id: 'usage-3',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          toolCalls: [],
        },
        usage: largeInputSmallOutput,
        finishReason: 'completed',
        rawFinishReason: 'stop',
      },
    ];
    const generate: NonNullable<AgentOptions['generate']> = async (
      _provider,
      _systemPrompt,
      _tools,
      _history,
      callbacks,
      options,
    ) => {
      options?.signal?.throwIfAborted();
      options?.onRequestStart?.();
      const response = responses[calls];
      calls += 1;
      if (response === undefined) {
        throw new Error(`Unexpected generate call #${String(calls)}`);
      }
      for (const part of response.message.content) {
        await callbacks?.onMessagePart?.(part);
      }
      for (const toolCall of response.message.toolCalls) {
        await callbacks?.onMessagePart?.(toolCall);
      }
      options?.onStreamEnd?.();
      return response;
    };
    const { session, agent } = await setupSession(sessionDir, events, ['UpdateGoal'], generate);
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'work' });
    await agent.goal.setBudgetLimits({ budgetLimits: { tokenBudget: 3 } }, 'model');

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await agent.turn.waitForCurrentTurn();
    await session.flushMetadata();

    expect(calls).toBe(3);
    expect((await api.getGoal({ agentId: 'main' })).goal).toBeNull();
    const records = await readWireRecords(sessionDir);
    const usageRecords = records
      .filter((record) => record['type'] === 'goal.update' && typeof record['tokensUsed'] === 'number')
      .map((record) => record['tokensUsed']);
    expect(usageRecords).toEqual([1, 2]);
    const completionEvent = events.find((event) => {
      const change = event['change'] as Record<string, unknown> | undefined;
      return event['type'] === 'goal.updated' && change?.['kind'] === 'completion';
    });
    expect(completionEvent?.['change']).toMatchObject({
      kind: 'completion',
      status: 'complete',
      stats: expect.objectContaining({ tokensUsed: 2 }),
    });
  });

  it('does not let a Stop hook continue past a reached goal budget', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    // A Stop hook that always asks to keep going. Without the budget guard it
    // would append its reason and drive another model step past the ceiling.
    const stopHook: HookDef = {
      event: 'Stop',
      command:
        'echo \'{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"keep going"}}\'',
      timeout: 5,
    };
    const { session, agent, scripted } = await setupSession(
      sessionDir,
      events,
      ['GetGoal'],
      undefined,
      [stopHook],
    );
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'work' });
    await agent.goal.setBudgetLimits({ budgetLimits: { tokenBudget: 1 } }, 'model');

    scripted.mockNextResponse({
      type: 'function',
      id: 'g1',
      name: 'GetGoal',
      arguments: JSON.stringify({}),
    });
    scripted.mockNextResponse({ type: 'text', text: 'should not run' });

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await agent.turn.waitForCurrentTurn();

    const goal = (await api.getGoal({ agentId: 'main' })).goal;
    // Only the first step ran; the Stop-hook continuation was suppressed.
    expect(scripted.calls).toHaveLength(1);
    expect(goal?.status).toBe('blocked');
  });

  it('preserves buffered steered input when the goal budget is reached', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    let agentRef: Awaited<ReturnType<typeof setupSession>>['agent'] | undefined;
    let calls = 0;
    const generate: NonNullable<AgentOptions['generate']> = async (
      _provider,
      _systemPrompt,
      _tools,
      _history,
      callbacks,
      options,
    ) => {
      calls += 1;
      if (calls > 1) throw new Error('Budget should stop before another model step');
      options?.signal?.throwIfAborted();
      options?.onRequestStart?.();
      await callbacks?.onMessagePart?.({ type: 'text', text: 'working' });
      agentRef?.turn.steer([{ type: 'text', text: 'urgent user steer' }]);
      options?.onStreamEnd?.();
      return {
        id: 'budget-steer',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'working' }],
          toolCalls: [],
        },
        usage: {
          inputOther: 0,
          inputCacheRead: 0,
          inputCacheCreation: 0,
          output: 1,
        },
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    };
    const { session, agent } = await setupSession(sessionDir, events, ['GetGoal'], generate);
    agentRef = agent;
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'work' });
    await agent.goal.setBudgetLimits({ budgetLimits: { tokenBudget: 1 } }, 'model');

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await agent.turn.waitForCurrentTurn();

    expect(calls).toBe(1);
    expect((await api.getGoal({ agentId: 'main' })).goal?.status).toBe('blocked');
    expect(JSON.stringify(agent.context.history)).toContain('urgent user steer');
  });

  it('preserves terminal status and demotes active goals across resume', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session } = await setupSession(sessionDir, events, ['GetGoal']);
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'resume me' });
    await session.flushMetadata();

    const resumed = track(new Session({
      id: 'goal-session',
      kaos: testKaos.withCwd(sessionDir),
      homedir: sessionDir,
      rpc: createSessionRpc([]),
      skills: { explicitDirs: [join(sessionDir, 'missing')] },
      providerManager: testProviderManager(),
    }));
    await resumed.resume();
    expect((await new SessionAPIImpl(resumed).getGoal({ agentId: 'main' })).goal?.status).toBe('paused');
    await resumed.flushMetadata();
  });

  it('retains terminal blocked reason across resume', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent } = await setupSession(sessionDir, events, ['GetGoal']);
    await new SessionAPIImpl(session).createGoal({ agentId: 'main', objective: 'work' });
    await agent.goal.markBlocked({ reason: 'needs credentials' });
    await session.flushMetadata();

    const resumed = track(new Session({
      id: 'goal-session',
      kaos: testKaos.withCwd(sessionDir),
      homedir: sessionDir,
      rpc: createSessionRpc([]),
      skills: { explicitDirs: [join(sessionDir, 'missing')] },
      providerManager: testProviderManager(),
    }));
    await resumed.resume();
    const goal = (await new SessionAPIImpl(resumed).getGoal({ agentId: 'main' })).goal;
    expect(goal?.status).toBe('blocked');
    expect(goal?.terminalReason).toBe('needs credentials');
    await resumed.flushMetadata();
  });

  it('supports user lifecycle controls without a model turn', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent } = await setupSession(sessionDir, events, ['GetGoal']);
    const api = new SessionAPIImpl(session);

    await api.createGoal({ agentId: 'main', objective: 'work' });
    expect((await api.pauseGoal({ agentId: 'main' })).status).toBe('paused');
    expect((await api.resumeGoal({ agentId: 'main' })).status).toBe('active');
    // cancel discards the goal and returns its prior (active) snapshot.
    expect((await api.cancelGoal({ agentId: 'main' })).status).toBe('active');
    expect((await api.getGoal({ agentId: 'main' })).goal).toBeNull();
    const cancelReminder = agent.context.history.at(-1);
    expect(cancelReminder?.origin).toMatchObject({
      kind: 'system_trigger',
      name: 'goal_cancelled',
    });
    expect(JSON.stringify(cancelReminder?.content)).toContain('Ignore earlier active-goal reminders');

    await api.createGoal({ agentId: 'main', objective: 'again' });
    await api.cancelGoal({ agentId: 'main' });
    expect((await api.getGoal({ agentId: 'main' })).goal).toBeNull();
  });

  it('rejects completion right after an edit until fresh verification is cited', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(sessionDir, events, [
      'Write',
      'Bash',
      'GetGoal',
      'UpdateGoal',
    ]);
    const api = new SessionAPIImpl(session);
    await api.createGoal({ agentId: 'main', objective: 'Ship the change' });

    // The model edits a file, then immediately tries to complete with no
    // evidence — the gate rejects it (a mutation was observed). It re-verifies
    // in the foreground and completes citing the new receipt.
    scripted.mockNextResponse({
      type: 'function',
      id: 'w1',
      name: 'Write',
      arguments: JSON.stringify({ path: join(sessionDir, 'note.txt'), content: 'v1' }),
    });
    scripted.mockNextResponse({
      type: 'function',
      id: 'c1',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'complete' }),
    });
    scripted.mockNextResponse({
      type: 'function',
      id: 'b1',
      name: 'Bash',
      arguments: JSON.stringify({ command: 'echo verified' }),
    });
    scripted.mockNextResponse({
      type: 'function',
      id: 'c2',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'complete', evidence: ['b1'] }),
    });
    scripted.mockNextResponse({ type: 'text', text: 'Verified and completed.' });

    agent.turn.prompt([{ type: 'text', text: 'Ship the change' }]);
    await agent.turn.waitForCurrentTurn();

    const rejected = events.find(
      (event) => event['type'] === 'tool.result' && event['toolCallId'] === 'c1',
    );
    expect(rejected?.['isError']).toBe(true);
    expect(String(rejected?.['output'])).toContain('completion gate');
    expect(String(rejected?.['output'])).toContain('still active');

    // The rejection reached the model in-context before its recovery step.
    const recoveryHistory = JSON.stringify(scripted.calls[2]?.history ?? []);
    expect(recoveryHistory).toContain('completion gate');

    const completed = events.find(
      (event) => event['type'] === 'tool.result' && event['toolCallId'] === 'c2',
    );
    expect(completed?.['isError']).toBeFalsy();
    expect(String(completed?.['output'])).toContain('Goal completed successfully.');
    expect(scripted.calls).toHaveLength(5);
    expect((await api.getGoal({ agentId: 'main' })).goal).toBeNull();
  });

  it('rejects completion citing evidence past the turn lease', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(
      sessionDir,
      events,
      ['Bash', 'GetGoal', 'UpdateGoal'],
      undefined,
      undefined,
      { providers: {}, goal: { evidenceLeaseTurns: 0 } },
    );
    const api = new SessionAPIImpl(session);
    // The RPC payload has no completionCriterion field; create through the
    // agent's goal store directly (same path SetGoalBudget tests use).
    await agent.goal.createGoal({ objective: 'work', completionCriterion: 'run the check' });

    // Goal turn 1 verifies but does not complete, so the receipt is one goal
    // turn old when the continuation turn cites it — past the zero-turn lease.
    scripted.mockNextResponse({
      type: 'function',
      id: 'b1',
      name: 'Bash',
      arguments: JSON.stringify({ command: 'echo check-1' }),
    });
    scripted.mockNextResponse({ type: 'text', text: 'More work remains.' });
    scripted.mockNextResponse({
      type: 'function',
      id: 'c1',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'complete', evidence: ['b1'] }),
    });
    scripted.mockNextResponse({
      type: 'function',
      id: 'b2',
      name: 'Bash',
      arguments: JSON.stringify({ command: 'echo check-2' }),
    });
    scripted.mockNextResponse({
      type: 'function',
      id: 'c2',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'complete', evidence: ['b2'] }),
    });
    scripted.mockNextResponse({ type: 'text', text: 'Done.' });

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await agent.turn.waitForCurrentTurn();

    const rejected = events.find(
      (event) => event['type'] === 'tool.result' && event['toolCallId'] === 'c1',
    );
    expect(rejected?.['isError']).toBe(true);
    expect(String(rejected?.['output'])).toContain('evidence lease');
    const completed = events.find(
      (event) => event['type'] === 'tool.result' && event['toolCallId'] === 'c2',
    );
    expect(String(completed?.['output'])).toContain('Goal completed successfully.');
    expect(scripted.calls).toHaveLength(6);
    expect((await api.getGoal({ agentId: 'main' })).goal).toBeNull();
  });

  it('requires fresh verification after a restart: pre-restart receipts are forgotten', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const { session, agent, scripted } = await setupSession(sessionDir, events, [
      'Bash',
      'GetGoal',
      'UpdateGoal',
    ]);
    // The RPC payload has no completionCriterion field; create through the
    // agent's goal store directly (same path SetGoalBudget tests use).
    await agent.goal.createGoal({ objective: 'work', completionCriterion: 'run the check' });

    // Before the restart the goal runs a verification (receipt `old1`) and the
    // model then blocks the goal so the driver stops instead of completing.
    scripted.mockNextResponse({
      type: 'function',
      id: 'old1',
      name: 'Bash',
      arguments: JSON.stringify({ command: 'echo old-check' }),
    });
    scripted.mockNextResponse({
      type: 'function',
      id: 'block1',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'blocked' }),
    });
    scripted.mockNextResponse({ type: 'text', text: 'Blocked for now.' });

    agent.turn.prompt([{ type: 'text', text: 'work' }]);
    await agent.turn.waitForCurrentTurn();
    await session.flushMetadata();

    // Restart: the goal survives as `blocked`, but the evidence ledger was
    // memory-only and starts empty.
    const resumedEvents: Array<Record<string, unknown>> = [];
    const resumed = track(new Session({
      id: 'goal-session',
      kaos: testKaos.withCwd(sessionDir),
      homedir: sessionDir,
      rpc: createSessionRpc(resumedEvents),
      skills: { explicitDirs: [join(sessionDir, 'missing')] },
      providerManager: testProviderManager(),
    }));
    await resumed.resume();
    const resumedAgent = resumed.getReadyAgent('main');
    if (resumedAgent === undefined) throw new Error('main agent should be ready after resume');
    const resumedScripted = createScriptedGenerate();
    (resumedAgent as unknown as { rawGenerate: typeof resumedScripted.generate }).rawGenerate =
      resumedScripted.generate;
    resumedAgent.useProfile(goalProfile(['Bash', 'GetGoal', 'UpdateGoal']));
    resumedAgent.config.update({ modelAlias: 'mock-model', thinkingEffort: 'off' });
    resumedAgent.permission.setMode('yolo');

    resumedScripted.mockNextResponse({
      type: 'function',
      id: 'resume1',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'active' }),
    });
    resumedScripted.mockNextResponse({
      type: 'function',
      id: 'c1',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'complete', evidence: ['old1'] }),
    });
    resumedScripted.mockNextResponse({
      type: 'function',
      id: 'new1',
      name: 'Bash',
      arguments: JSON.stringify({ command: 'echo fresh-check' }),
    });
    resumedScripted.mockNextResponse({
      type: 'function',
      id: 'c2',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'complete', evidence: ['new1'] }),
    });
    resumedScripted.mockNextResponse({ type: 'text', text: 'Re-verified and done.' });

    resumedAgent.turn.prompt([{ type: 'text', text: 'continue' }]);
    await resumedAgent.turn.waitForCurrentTurn();

    // Citing the pre-restart receipt fails as unknown: the ledger did not
    // survive the restart, so completion requires fresh verification.
    const rejected = resumedEvents.find(
      (event) => event['type'] === 'tool.result' && event['toolCallId'] === 'c1',
    );
    expect(rejected?.['isError']).toBe(true);
    expect(String(rejected?.['output'])).toContain('Receipt "old1" is not in the goal evidence ledger');
    const completed = resumedEvents.find(
      (event) => event['type'] === 'tool.result' && event['toolCallId'] === 'c2',
    );
    expect(String(completed?.['output'])).toContain('Goal completed successfully.');
    expect(resumedScripted.calls).toHaveLength(5);
    expect((await new SessionAPIImpl(resumed).getGoal({ agentId: 'main' })).goal).toBeNull();
  });
});
