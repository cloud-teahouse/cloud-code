import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import {
  GoalMode,
  type GoalChange,
  type GoalSnapshot,
} from '../../src/agent/goal';
import type { CloudCodeConfig } from '../../src/config';
import type { AgentRecord, AgentRecordOf } from '../../src/agent/records';
import { TurnFlow } from '../../src/agent/turn';
import type { ExecutableToolResult, FinalizeToolResultContext } from '../../src/loop/index';
import type { AgentReplayRecord } from '../../src/rpc/resumed';
import { ErrorCodes } from '../../src/errors';

function makeGoalMode(opts: { config?: CloudCodeConfig } = {}) {
  const records: AgentRecord[] = [];
  const replay: AgentReplayRecord[] = [];
  const events: Array<{ readonly type: string; readonly snapshot?: GoalSnapshot | null; readonly change?: GoalChange }> = [];
  const reminders: Array<{ readonly content: string; readonly origin: unknown }> = [];
  const agent = {
    records: {
      logRecord: (record: AgentRecord) => {
        records.push(record);
      },
    },
    emitEvent: (event: { readonly type: string; readonly snapshot?: GoalSnapshot | null; readonly change?: GoalChange }) => {
      events.push(event);
    },
    context: {
      appendSystemReminder: (content: string, origin: unknown) => {
        reminders.push({ content, origin });
      },
    },
    replayBuilder: {
      push: (record: AgentReplayRecord) => {
        replay.push(record);
      },
    },
    kimiConfig: opts.config,
  } as unknown as Agent;

  const goals = new GoalMode(agent);
  // Wire the goal module back onto the fake agent so TurnFlow-level feed
  // paths (which reach it via `agent.goal`) work against the same instance.
  (agent as { goal?: GoalMode }).goal = goals;

  return {
    goals,
    agent,
    records,
    replay,
    events,
    reminders,
  };
}

describe('GoalMode creation', () => {
  it('creates a goal and exposes it through getGoal', async () => {
    const { goals } = makeGoalMode();

    const snapshot = await goals.createGoal({ objective: 'Ship feature X' });

    expect(snapshot.objective).toBe('Ship feature X');
    expect(snapshot.status).toBe('active');
    expect(goals.getGoal().goal?.goalId).toBe(snapshot.goalId);
  });

  it('stores a completion criterion when provided', async () => {
    const { goals } = makeGoalMode();

    const snapshot = await goals.createGoal({
      objective: 'Ship feature X',
      completionCriterion: ' tests pass ',
    });

    expect(snapshot.completionCriterion).toBe('tests pass');
    expect(goals.getGoal().goal?.completionCriterion).toBe('tests pass');
  });

  it('truncates an over-long completion criterion instead of failing', async () => {
    const { goals } = makeGoalMode();

    const snapshot = await goals.createGoal({
      objective: 'Ship feature X',
      completionCriterion: 'c'.repeat(4001),
    });

    expect(snapshot.completionCriterion).toBe('c'.repeat(4000));
  });

  it('fills tiered default budgets at creation; wall-clock stays uncapped', async () => {
    const { goals } = makeGoalMode();

    const snapshot = await goals.createGoal({ objective: 'Do work' });

    // Tiered budgets: the short objective heuristically tiers `small`.
    expect(snapshot.budget.turnBudget).toBe(10);
    expect(snapshot.budget.tokenBudget).toBe(300_000);
    expect(snapshot.budget.wallClockBudgetMs).toBeNull();
    expect(snapshot.budget.overBudget).toBe(false);
  });

  it('rejects empty and too-long objectives', async () => {
    const { goals } = makeGoalMode();

    await expect(goals.createGoal({ objective: '   ' })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_OBJECTIVE_EMPTY,
    });
    await expect(goals.createGoal({ objective: 'x'.repeat(4001) })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_OBJECTIVE_TOO_LONG,
    });
  });

  it('rejects duplicate active, paused, and blocked goals without replace', async () => {
    const { goals } = makeGoalMode();

    await goals.createGoal({ objective: 'first' });
    await expect(goals.createGoal({ objective: 'second' })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_ALREADY_EXISTS,
    });
    await goals.pauseGoal();
    await expect(goals.createGoal({ objective: 'second' })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_ALREADY_EXISTS,
    });
    await goals.resumeGoal();
    await goals.markBlocked({ reason: 'stuck' });
    await expect(goals.createGoal({ objective: 'second' })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_ALREADY_EXISTS,
    });
  });

  it('replaces an existing goal when replace is set', async () => {
    const { goals, records } = makeGoalMode();

    const first = await goals.createGoal({ objective: 'first' });
    const second = await goals.createGoal({ objective: 'second', replace: true });

    expect(second.goalId).not.toBe(first.goalId);
    expect(goals.getGoal().goal?.objective).toBe('second');
    // Each creation is followed by its tiered-budget goal.update.
    expect(records.map((record) => record.type)).toEqual([
      'goal.create',
      'goal.update',
      'goal.clear',
      'goal.create',
      'goal.update',
    ]);
  });
});

describe('GoalMode lifecycle', () => {
  it('emits typed lifecycle and completion changes', async () => {
    const { goals, events } = makeGoalMode();

    await goals.createGoal({ objective: 'work', completionCriterion: 'tests pass' });
    expect(events.at(-1)?.change).toBeUndefined();

    await goals.pauseGoal();
    expect(events.at(-1)?.change).toMatchObject({ kind: 'lifecycle', status: 'paused' });

    await goals.resumeGoal();
    expect(events.at(-1)?.change).toMatchObject({ kind: 'lifecycle', status: 'active' });

    await goals.markComplete({ reason: 'done' }, 'model');
    const completion = events.find((event) => event.change?.kind === 'completion')?.change;
    expect(completion).toMatchObject({ kind: 'completion', status: 'complete', reason: 'done' });
    expect(goals.getGoal().goal).toBeNull();
    expect(events.at(-1)?.snapshot).toBeNull();
  });

  it('keeps blocked goals resumable', async () => {
    const { goals } = makeGoalMode();

    await goals.createGoal({ objective: 'work', completionCriterion: 'tests pass' });
    const blocked = await goals.markBlocked({ reason: 'need creds' });
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.terminalReason).toBe('need creds');

    const resumed = await goals.resumeGoal();
    expect(resumed.status).toBe('active');
    expect(resumed.terminalReason).toBeUndefined();
  });

  it('pauseOnInterrupt parks active goals and no-ops for stopped goals', async () => {
    const { goals } = makeGoalMode();

    await goals.createGoal({ objective: 'work', completionCriterion: 'tests pass' });
    const paused = await goals.pauseOnInterrupt({ reason: 'Paused after interruption' });
    expect(paused?.status).toBe('paused');
    expect(paused?.terminalReason).toBe('Paused after interruption');

    expect(await goals.pauseOnInterrupt({ reason: 'again' })).toBeNull();
    expect(goals.getGoal().goal?.status).toBe('paused');
  });

  it('cancelGoal discards the goal and throws when missing', async () => {
    const { goals, reminders } = makeGoalMode();

    await goals.createGoal({ objective: 'work' });
    const removed = await goals.cancelGoal();
    expect(removed.status).toBe('active');
    expect(goals.getGoal()).toEqual({ goal: null });
    expect(reminders).toEqual([
      expect.objectContaining({
        content: expect.stringContaining('Ignore earlier active-goal reminders'),
        origin: { kind: 'system_trigger', name: 'goal_cancelled' },
      }),
    ]);
    await expect(goals.cancelGoal()).rejects.toMatchObject({ code: ErrorCodes.GOAL_NOT_FOUND });
  });
});

describe('GoalMode accounting and budgets', () => {
  it('counts tokens and turns only while active', async () => {
    const { goals } = makeGoalMode();

    await goals.createGoal({ objective: 'work' });
    await goals.recordTokenUsage(30);
    await goals.incrementTurn();
    expect(goals.getGoal().goal).toMatchObject({ tokensUsed: 30, turnsUsed: 1 });

    await goals.pauseGoal();
    await goals.recordTokenUsage(12);
    await goals.incrementTurn();
    expect(goals.getGoal().goal).toMatchObject({ tokensUsed: 30, turnsUsed: 1 });
  });

  it('sets budget limits through SetGoalBudget-style updates', async () => {
    const { goals } = makeGoalMode();

    await goals.createGoal({ objective: 'work' });
    const snapshot = await goals.setBudgetLimits({
      budgetLimits: { tokenBudget: 100, turnBudget: 2, wallClockBudgetMs: 1000 },
    }, 'model');

    expect(snapshot.budget.tokenBudget).toBe(100);
    expect(snapshot.budget.turnBudget).toBe(2);
    expect(snapshot.budget.wallClockBudgetMs).toBe(1000);
  });
});

describe('GoalMode records', () => {
  it('records only replay-relevant create/update/clear fields', async () => {
    const { goals, records } = makeGoalMode();

    await goals.createGoal({ objective: 'work', completionCriterion: 'tests pass' });
    await goals.recordTokenUsage(5);
    await goals.incrementTurn();
    await goals.setBudgetLimits({ budgetLimits: { turnBudget: 2 } }, 'model');
    await goals.markBlocked({ reason: 'stuck' });
    await goals.cancelGoal();

    expect(records).toEqual([
      expect.objectContaining({
        type: 'goal.create',
        goalId: expect.any(String),
        objective: 'work',
        completionCriterion: 'tests pass',
      }),
      // The tiered default budget (small tier for a short objective) is
      // recorded right after creation as a plain budgetLimits goal.update.
      expect.objectContaining({
        type: 'goal.update',
        budgetLimits: { turnBudget: 10, tokenBudget: 300_000 },
      }),
      expect.objectContaining({ type: 'goal.update', tokensUsed: 5 }),
      expect.objectContaining({ type: 'goal.update', turnsUsed: 1 }),
      expect.objectContaining({
        type: 'goal.update',
        budgetLimits: { turnBudget: 2, tokenBudget: 300_000 },
      }),
      expect.objectContaining({
        type: 'goal.update',
        status: 'blocked',
        reason: 'stuck',
        actor: 'runtime',
      }),
      expect.objectContaining({ type: 'goal.clear' }),
    ]);
    expect(records[0]).toMatchObject({ actor: 'user' });
    expect(records[0]).not.toHaveProperty('budgetLimits');
    expect(records[1]).not.toHaveProperty('goalId');
    expect(records[1]).not.toHaveProperty('status');
    expect(records.at(-1)).not.toHaveProperty('goalId');
    expect(records.at(-1)).not.toHaveProperty('reason');
  });

  it('restores state from patch records', () => {
    const { goals } = makeGoalMode();

    goals.restoreCreate({
      type: 'goal.create',
      goalId: 'g1',
      objective: 'work',
      completionCriterion: 'tests pass',
      time: Date.parse('2026-01-01T00:00:00.000Z'),
    });
    goals.restoreUpdate({ type: 'goal.update', tokensUsed: 5 });
    goals.restoreUpdate({ type: 'goal.update', turnsUsed: 1 });
    goals.restoreUpdate({ type: 'goal.update', budgetLimits: { turnBudget: 2 } });
    goals.restoreUpdate({ type: 'goal.update', status: 'blocked', reason: 'stuck' });

    expect(goals.getGoal().goal).toMatchObject({
      objective: 'work',
      completionCriterion: 'tests pass',
      status: 'blocked',
      terminalReason: 'stuck',
      tokensUsed: 5,
      turnsUsed: 1,
    });
    expect(goals.getGoal().goal?.budget.turnBudget).toBe(2);
  });

  it('projects restored goal status changes into replay records', () => {
    const { goals, replay } = makeGoalMode();

    goals.restoreCreate({
      type: 'goal.create',
      goalId: 'g1',
      objective: 'work',
      completionCriterion: 'tests pass',
      time: Date.parse('2026-01-01T00:00:00.000Z'),
    });
    goals.restoreUpdate({ type: 'goal.update', tokensUsed: 5 });
    goals.restoreUpdate({ type: 'goal.update', turnsUsed: 1 });
    goals.restoreUpdate({
      type: 'goal.update',
      status: 'paused',
      reason: 'break',
      actor: 'runtime',
    });
    goals.restoreUpdate({ type: 'goal.update', status: 'active', actor: 'user' });
    goals.restoreUpdate({
      type: 'goal.update',
      status: 'complete',
      reason: 'done',
      actor: 'model',
    });

    expect(replay).toEqual([
      expect.objectContaining({
        type: 'goal_updated',
        snapshot: expect.objectContaining({ objective: 'work', status: 'active' }),
        change: { kind: 'created' },
      }),
      expect.objectContaining({
        type: 'goal_updated',
        snapshot: expect.objectContaining({ status: 'paused', terminalReason: 'break' }),
        change: { kind: 'lifecycle', status: 'paused', reason: 'break', actor: 'runtime' },
      }),
      expect.objectContaining({
        type: 'goal_updated',
        snapshot: expect.objectContaining({ status: 'active' }),
        change: { kind: 'lifecycle', status: 'active', reason: undefined, actor: 'user' },
      }),
      expect.objectContaining({
        type: 'goal_updated',
        snapshot: expect.objectContaining({
          status: 'complete',
          terminalReason: 'done',
          turnsUsed: 1,
          tokensUsed: 5,
        }),
        change: {
          kind: 'completion',
          status: 'complete',
          reason: 'done',
          stats: { turnsUsed: 1, tokensUsed: 5, wallClockMs: 0 },
          actor: 'model',
        },
      }),
    ]);
  });

  it('keeps resume-normalization pauses in core replay records', () => {
    const { goals, replay } = makeGoalMode();

    goals.restoreCreate({
      type: 'goal.create',
      goalId: 'g1',
      objective: 'work',
      time: Date.parse('2026-01-01T00:00:00.000Z'),
    });
    goals.restoreUpdate({
      type: 'goal.update',
      status: 'paused',
      reason: 'Paused after agent resume',
    });

    expect(replay.at(-1)).toMatchObject({
      type: 'goal_updated',
      snapshot: { status: 'paused', terminalReason: 'Paused after agent resume' },
      change: {
        kind: 'lifecycle',
        status: 'paused',
        reason: 'Paused after agent resume',
        actor: undefined,
      },
    });
  });

  it('normalizes active replayed goals to paused', async () => {
    const { goals, records } = makeGoalMode();

    await goals.createGoal({ objective: 'resume me' });
    records.length = 0;
    goals.normalizeAfterReplay();

    expect(goals.getGoal().goal).toMatchObject({
      status: 'paused',
      terminalReason: 'Paused after agent resume',
    });
    expect(records).toEqual([
      expect.objectContaining({
        type: 'goal.update',
        status: 'paused',
        reason: 'Paused after agent resume',
      }),
    ]);
  });
});

/**
 * Completion-gate P1: the evidence ledger and mutation index record data only
 * — nothing enforces yet. `feedGoalEvidence` is a private TurnFlow method; the
 * feeder cast below reaches it the same way other tests reach internals.
 */
type EvidenceFeeder = {
  feedGoalEvidence(
    turnId: number,
    ctx: FinalizeToolResultContext,
    result: ExecutableToolResult,
  ): void;
};

function makeEvidenceFeeder(agent: Agent): EvidenceFeeder {
  return new TurnFlow(agent) as unknown as EvidenceFeeder;
}

function finalizeCtx(
  toolName: string,
  toolCallId: string,
  args: unknown,
  stepNumber = 1,
): FinalizeToolResultContext {
  return {
    turnId: '1',
    stepNumber,
    signal: new AbortController().signal,
    toolCall: { id: toolCallId, name: toolName, arguments: JSON.stringify(args) },
    toolCalls: [],
    args,
  } as unknown as FinalizeToolResultContext;
}

const okToolResult = (output = 'done'): ExecutableToolResult => ({ output });
const errorToolResult = (output = 'boom'): ExecutableToolResult => ({ output, isError: true });

describe('GoalMode evidence ledger (completion-gate P1)', () => {
  it('captures receipts with goal-turn and mutation-index anchors', async () => {
    const { goals } = makeGoalMode();
    await goals.createGoal({ objective: 'work' });
    await goals.incrementTurn();
    goals.recordMutation();

    goals.recordEvidence({
      receiptId: 'tc_1',
      toolName: 'Bash',
      turnId: 7,
      step: 2,
      ok: true,
      summary: 'pnpm test',
    });

    const receipts = goals.getEvidenceReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      receiptId: 'tc_1',
      toolName: 'Bash',
      turnId: 7,
      goalTurnAtCapture: 1,
      mutationIndexAtCapture: 1,
      ok: true,
      summary: 'pnpm test',
    });
    expect(receipts[0]?.treeAtCapture).toBeUndefined();
    expect(typeof receipts[0]?.capturedAtMs).toBe('number');
  });

  it('caps the ledger at 50 receipts with FIFO eviction', async () => {
    const { goals } = makeGoalMode();
    await goals.createGoal({ objective: 'work' });

    for (let i = 1; i <= 55; i += 1) {
      goals.recordEvidence({
        receiptId: `r${String(i)}`,
        toolName: 'Bash',
        turnId: 1,
        step: 1,
        ok: true,
        summary: `cmd ${String(i)}`,
      });
    }

    const receipts = goals.getEvidenceReceipts();
    expect(receipts).toHaveLength(50);
    expect(receipts[0]?.receiptId).toBe('r6');
    expect(receipts.at(-1)?.receiptId).toBe('r55');
  });

  it('bumps the mutation index for successful Edit/Write and never for failures', async () => {
    const { goals, agent } = makeGoalMode();
    await goals.createGoal({ objective: 'work' });
    const feeder = makeEvidenceFeeder(agent);

    feeder.feedGoalEvidence(1, finalizeCtx('Edit', 'e1', { file_path: '/x' }), okToolResult());
    feeder.feedGoalEvidence(1, finalizeCtx('Write', 'w1', { file_path: '/y' }), okToolResult());
    expect(goals.getMutationState().index).toBe(2);
    // Mutation tools never leave receipts of their own.
    expect(goals.getEvidenceReceipts()).toHaveLength(0);

    feeder.feedGoalEvidence(1, finalizeCtx('Edit', 'e2', { file_path: '/x' }), errorToolResult());
    feeder.feedGoalEvidence(1, finalizeCtx('Write', 'w2', { file_path: '/y' }), errorToolResult());
    expect(goals.getMutationState().index).toBe(2);
    expect(goals.getEvidenceReceipts()).toHaveLength(0);
  });

  it('records the goal turn of the latest mutation', async () => {
    const { goals, agent } = makeGoalMode();
    await goals.createGoal({ objective: 'work' });
    const feeder = makeEvidenceFeeder(agent);

    expect(goals.getMutationState()).toEqual({ index: 0, lastMutationGoalTurn: undefined });
    await goals.incrementTurn();
    feeder.feedGoalEvidence(1, finalizeCtx('Edit', 'e1', {}), okToolResult());
    expect(goals.getMutationState()).toEqual({ index: 1, lastMutationGoalTurn: 1 });
  });

  it('excludes goal-management tools and summarizes ordinary receipts', async () => {
    const { goals, agent } = makeGoalMode();
    await goals.createGoal({ objective: 'work' });
    const feeder = makeEvidenceFeeder(agent);

    for (const [name, args] of [
      ['CreateGoal', { objective: 'x' }],
      ['UpdateGoal', { status: 'complete' }],
      ['GetGoal', {}],
      ['SetGoalBudget', { turnBudget: 3 }],
    ] as const) {
      feeder.feedGoalEvidence(1, finalizeCtx(name, `${name}_1`, args), okToolResult());
    }
    expect(goals.getEvidenceReceipts()).toHaveLength(0);
    expect(goals.getMutationState().index).toBe(0);

    // Bash receipts are summarized by the command's first line; other tools
    // fall back to the first output line; summaries are capped at 80 chars.
    feeder.feedGoalEvidence(1, finalizeCtx('Bash', 'b1', { command: 'pnpm test\n--run' }), okToolResult());
    feeder.feedGoalEvidence(1, finalizeCtx('Grep', 'g1', { pattern: 'x' }), okToolResult('hit one\nhit two'));
    feeder.feedGoalEvidence(1, finalizeCtx('Bash', 'b2', { command: `echo ${'x'.repeat(120)}` }), okToolResult());

    const receipts = goals.getEvidenceReceipts();
    expect(receipts.map((receipt) => receipt.receiptId)).toEqual(['b1', 'g1', 'b2']);
    expect(receipts[0]?.summary).toBe('pnpm test');
    expect(receipts[1]?.summary).toBe('hit one');
    expect(receipts[2]?.summary).toBe(`echo ${'x'.repeat(75)}`);
    expect(receipts[2]?.summary).toHaveLength(80);
  });

  it('keeps failed tool results as non-ok receipts for audit', async () => {
    const { goals, agent } = makeGoalMode();
    await goals.createGoal({ objective: 'work' });
    const feeder = makeEvidenceFeeder(agent);

    feeder.feedGoalEvidence(
      1,
      finalizeCtx('Bash', 'b1', { command: 'false' }),
      errorToolResult('Command failed with exit code: 1.'),
    );

    const [receipt] = goals.getEvidenceReceipts();
    expect(receipt?.ok).toBe(false);
    expect(receipt?.summary).toBe('false');
  });

  it('stamps same-step receipts with the step-end tree, including same-step edits', async () => {
    const { goals, agent } = makeGoalMode();
    await goals.createGoal({ objective: 'work' });
    const feeder = makeEvidenceFeeder(agent);

    // The canonical batch: Edit first, then a verification Bash in the same
    // step — its receipt must anchor the edit and receive the step-end tree.
    feeder.feedGoalEvidence(3, finalizeCtx('Edit', 'e1', { file_path: '/x' }, 1), okToolResult());
    feeder.feedGoalEvidence(3, finalizeCtx('Bash', 'b1', { command: 'pnpm test' }, 1), okToolResult());
    goals.stampReceiptTrees('tree-abc', 3, 1);

    const [receipt] = goals.getEvidenceReceipts();
    expect(receipt?.receiptId).toBe('b1');
    expect(receipt?.mutationIndexAtCapture).toBe(1);
    expect(receipt?.treeAtCapture).toBe('tree-abc');
  });

  it('never stamps receipts with another step or turn tree', async () => {
    const { goals, agent } = makeGoalMode();
    await goals.createGoal({ objective: 'work' });
    const feeder = makeEvidenceFeeder(agent);

    // Shadow-git off: the tree axis stays empty.
    feeder.feedGoalEvidence(3, finalizeCtx('Bash', 'b1', { command: 'a' }, 1), okToolResult());
    goals.stampReceiptTrees(undefined, 3, 1);
    // A step whose afterStep ran normally stamps its own receipts.
    feeder.feedGoalEvidence(3, finalizeCtx('Bash', 'b2', { command: 'b' }, 2), okToolResult());
    goals.stampReceiptTrees('tree-2', 3, 2);
    // A step whose afterStep was skipped (abort edge): the receipt is dropped
    // from the pending list rather than stamped with a later step's tree...
    feeder.feedGoalEvidence(3, finalizeCtx('Bash', 'b3', { command: 'c' }, 3), okToolResult());
    goals.stampReceiptTrees('tree-3', 3, 99);
    // ...same for a stamp carrying a different turn id...
    feeder.feedGoalEvidence(3, finalizeCtx('Bash', 'b4', { command: 'd' }, 4), okToolResult());
    goals.stampReceiptTrees('tree-4', 4, 4);
    // ...and neither is retroactively stamped by the next good stamp.
    feeder.feedGoalEvidence(3, finalizeCtx('Bash', 'b5', { command: 'e' }, 5), okToolResult());
    goals.stampReceiptTrees('tree-5', 3, 5);

    const receipts = goals.getEvidenceReceipts();
    expect(receipts.map((receipt) => [receipt.receiptId, receipt.treeAtCapture])).toEqual([
      ['b1', undefined],
      ['b2', 'tree-2'],
      ['b3', undefined],
      ['b4', undefined],
      ['b5', 'tree-5'],
    ]);
  });

  it('destroys the ledger when the goal is cleared', async () => {
    const { goals, agent } = makeGoalMode();
    const feeder = makeEvidenceFeeder(agent);
    await goals.createGoal({ objective: 'work' });
    feeder.feedGoalEvidence(1, finalizeCtx('Edit', 'e1', {}), okToolResult());
    feeder.feedGoalEvidence(1, finalizeCtx('Bash', 'b1', { command: 't' }), okToolResult());
    expect(goals.getEvidenceReceipts()).toHaveLength(1);
    expect(goals.getMutationState().index).toBe(1);

    await goals.cancelGoal();
    expect(goals.getEvidenceReceipts()).toEqual([]);
    expect(goals.getMutationState()).toEqual({ index: 0, lastMutationGoalTurn: undefined });
  });

  it('destroys the ledger on completion and on replace, starting fresh each time', async () => {
    const { goals, agent } = makeGoalMode();
    const feeder = makeEvidenceFeeder(agent);

    await goals.createGoal({ objective: 'first' });
    feeder.feedGoalEvidence(1, finalizeCtx('Edit', 'e1', {}), okToolResult());
    feeder.feedGoalEvidence(1, finalizeCtx('Bash', 'b1', { command: 't' }), okToolResult());
    await goals.markComplete({ reason: 'done' }, 'model');
    expect(goals.getEvidenceReceipts()).toEqual([]);
    expect(goals.getMutationState().index).toBe(0);

    await goals.createGoal({ objective: 'second' });
    feeder.feedGoalEvidence(2, finalizeCtx('Bash', 'b2', { command: 't' }), okToolResult());
    await goals.createGoal({ objective: 'third', replace: true });
    expect(goals.getEvidenceReceipts()).toEqual([]);
    expect(goals.getMutationState().index).toBe(0);

    // The replacement goal starts a fresh ledger.
    feeder.feedGoalEvidence(3, finalizeCtx('Bash', 'b3', { command: 't' }), okToolResult());
    expect(goals.getEvidenceReceipts().map((receipt) => receipt.receiptId)).toEqual(['b3']);
  });

  it('feeds nothing while no goal is active', async () => {
    const { goals, agent } = makeGoalMode();
    const feeder = makeEvidenceFeeder(agent);

    // No goal at all: every feed path is a no-op.
    feeder.feedGoalEvidence(1, finalizeCtx('Bash', 'b0', { command: 't' }), okToolResult());
    feeder.feedGoalEvidence(1, finalizeCtx('Edit', 'e0', {}), okToolResult());
    goals.recordEvidence({ receiptId: 'x', toolName: 'Bash', turnId: 1, step: 1, ok: true, summary: 't' });
    goals.recordMutation();
    goals.stampReceiptTrees('tree', 1, 1);
    expect(goals.getEvidenceReceipts()).toEqual([]);
    expect(goals.getMutationState().index).toBe(0);

    // Paused goal: intact but not active — still no feeding.
    await goals.createGoal({ objective: 'work' });
    await goals.pauseGoal();
    feeder.feedGoalEvidence(1, finalizeCtx('Bash', 'b1', { command: 't' }), okToolResult());
    feeder.feedGoalEvidence(1, finalizeCtx('Edit', 'e1', {}), okToolResult());
    goals.recordEvidence({ receiptId: 'y', toolName: 'Bash', turnId: 1, step: 1, ok: true, summary: 't' });
    goals.recordMutation();
    goals.stampReceiptTrees('tree', 1, 1);
    expect(goals.getEvidenceReceipts()).toEqual([]);
    expect(goals.getMutationState().index).toBe(0);
  });
});

describe('GoalMode completion gate (P2)', () => {
  function recordReceipt(
    goals: GoalMode,
    receiptId: string,
    opts: { ok?: boolean; step?: number; summary?: string } = {},
  ): void {
    goals.recordEvidence({
      receiptId,
      toolName: 'Bash',
      turnId: 1,
      step: opts.step ?? 1,
      ok: opts.ok ?? true,
      summary: opts.summary ?? 'pnpm test',
    });
  }

  it('lets pure Q&A goals through untouched, citations or not', async () => {
    const { goals } = makeGoalMode();
    await goals.createGoal({ objective: 'answer a question' });

    expect(goals.evaluateCompletionGate([])).toMatchObject({
      allowed: true,
      basis: 'not_required',
    });
    expect(goals.evaluateCompletionGate(['anything']).allowed).toBe(true);
  });

  it('requires evidence once a mutation is observed and rejects empty citations', async () => {
    const { goals } = makeGoalMode();
    await goals.createGoal({ objective: 'work' });
    goals.recordMutation();

    const verdict = goals.evaluateCompletionGate([]);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('no_evidence');
    expect(verdict.rejections).toEqual([]);
    expect(verdict.usableReceipts).toEqual([]);
  });

  it('requires evidence when the goal carries a completion criterion', async () => {
    const { goals } = makeGoalMode();
    await goals.createGoal({ objective: 'work', completionCriterion: 'tests pass' });

    expect(goals.evaluateCompletionGate([])).toMatchObject({
      allowed: false,
      reason: 'no_evidence',
    });
  });

  it('rejects unknown receipt ids and lists the usable receipts to re-cite', async () => {
    const { goals } = makeGoalMode();
    await goals.createGoal({ objective: 'work' });
    goals.recordMutation();
    recordReceipt(goals, 'b1');

    const verdict = goals.evaluateCompletionGate(['nope']);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('unknown_receipt');
    expect(verdict.rejections).toHaveLength(1);
    expect(verdict.rejections[0]).toMatchObject({ receiptId: 'nope', code: 'unknown_receipt' });
    expect(verdict.usableReceipts).toEqual([
      { receiptId: 'b1', toolName: 'Bash', summary: 'pnpm test' },
    ]);
  });

  it('never accepts failed receipts', async () => {
    const { goals } = makeGoalMode();
    await goals.createGoal({ objective: 'work' });
    goals.recordMutation();
    recordReceipt(goals, 'b1', { ok: false });

    const verdict = goals.evaluateCompletionGate(['b1']);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('receipt_failed');
    expect(verdict.usableReceipts).toEqual([]);
  });

  it('enforces the tool axis: evidence must be captured at or after the latest mutation', async () => {
    const { goals } = makeGoalMode();
    await goals.createGoal({ objective: 'work' });
    recordReceipt(goals, 'b1'); // captured at mutation index 0
    goals.recordMutation(); // mutation index 1

    const stale = goals.evaluateCompletionGate(['b1']);
    expect(stale.allowed).toBe(false);
    expect(stale.reason).toBe('stale_after_mutation');

    // Evidence captured after the mutation passes; one passing citation is
    // enough even alongside rejected ones.
    recordReceipt(goals, 'b2');
    const verdict = goals.evaluateCompletionGate(['b1', 'b2']);
    expect(verdict).toMatchObject({ allowed: true, basis: 'evidence_passed' });
  });

  it('enforces the tree axis against the latest sealed step tree', async () => {
    const { goals } = makeGoalMode();
    await goals.createGoal({ objective: 'work' });
    goals.recordMutation();
    recordReceipt(goals, 'b1', { step: 1 });
    goals.stampReceiptTrees('tree-a', 1, 1);

    // The receipt's capture tree still is the latest tree.
    expect(goals.evaluateCompletionGate(['b1']).allowed).toBe(true);

    // A later step seals a different tree: the workspace moved past b1.
    recordReceipt(goals, 'b2', { step: 2 });
    goals.stampReceiptTrees('tree-b', 1, 2);
    const stale = goals.evaluateCompletionGate(['b1']);
    expect(stale.allowed).toBe(false);
    expect(stale.reason).toBe('stale_tree');
    // ...while the receipt stamped with the latest tree stays valid.
    expect(goals.evaluateCompletionGate(['b2']).allowed).toBe(true);

    // A receipt without a tree (shadow-git off for its step) skips the axis.
    recordReceipt(goals, 'b3', { step: 3 });
    goals.stampReceiptTrees(undefined, 1, 3);
    expect(goals.evaluateCompletionGate(['b3']).allowed).toBe(true);
  });

  it('expires receipts past the turn lease', async () => {
    const { goals } = makeGoalMode({
      config: { providers: {}, goal: { evidenceLeaseTurns: 1 } },
    });
    await goals.createGoal({ objective: 'work' });
    goals.recordMutation();
    await goals.incrementTurn(); // turnsUsed = 1
    recordReceipt(goals, 'b1'); // goalTurnAtCapture = 1

    await goals.incrementTurn(); // turnsUsed = 2, age 1 — within the lease
    expect(goals.evaluateCompletionGate(['b1']).allowed).toBe(true);

    await goals.incrementTurn(); // turnsUsed = 3, age 2 > 1 — expired
    const verdict = goals.evaluateCompletionGate(['b1']);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('lease_expired_turns');
    expect(verdict.usableReceipts).toEqual([]);
  });

  it('expires receipts past the wall-clock lease', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_000_000);
      const { goals } = makeGoalMode(); // default lease: 1_800_000ms
      await goals.createGoal({ objective: 'work' });
      goals.recordMutation();
      recordReceipt(goals, 'b1');

      // Exactly at the lease boundary the receipt is still valid (> comparison).
      nowSpy.mockReturnValue(1_000_000 + 1_800_000);
      expect(goals.evaluateCompletionGate(['b1']).allowed).toBe(true);

      nowSpy.mockReturnValue(1_000_000 + 1_800_001);
      const verdict = goals.evaluateCompletionGate(['b1']);
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe('lease_expired_wall_clock');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('passes unconditionally when the gate is disabled in config', async () => {
    const { goals } = makeGoalMode({
      config: { providers: {}, goal: { completionGate: false } },
    });
    await goals.createGoal({ objective: 'work', completionCriterion: 'tests pass' });
    goals.recordMutation();

    expect(goals.evaluateCompletionGate([])).toMatchObject({
      allowed: true,
      basis: 'gate_disabled',
    });
  });

  it('treats a restored goal as an empty ledger: pre-restart receipts are unknown', async () => {
    const { goals } = makeGoalMode();
    goals.restoreCreate({
      type: 'goal.create',
      goalId: 'g1',
      objective: 'work',
      completionCriterion: 'tests pass',
      time: Date.parse('2026-01-01T00:00:00.000Z'),
    });

    const verdict = goals.evaluateCompletionGate(['pre-restart-receipt']);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('unknown_receipt');
    expect(verdict.usableReceipts).toEqual([]);
  });

  it('projects gate state into the snapshot only while the gate enforces', async () => {
    const { goals } = makeGoalMode();
    await goals.createGoal({ objective: 'work' });
    // Pure Q&A: no gate state in the snapshot.
    expect(goals.getGoal().goal?.completionGate).toBeUndefined();

    goals.recordMutation();
    recordReceipt(goals, 'b1');
    recordReceipt(goals, 'b2', { ok: false });
    expect(goals.getGoal().goal?.completionGate).toEqual({
      mutationsObserved: 1,
      usableReceipts: 1,
      staleReceipts: 1,
      lastMutationGoalTurn: 0,
    });
  });

  it('omits snapshot gate state when the gate is disabled', async () => {
    const { goals } = makeGoalMode({
      config: { providers: {}, goal: { completionGate: false } },
    });
    await goals.createGoal({ objective: 'work', completionCriterion: 'tests pass' });
    goals.recordMutation();
    expect(goals.getGoal().goal?.completionGate).toBeUndefined();
  });
});

describe('GoalMode tiered budgets (completion-gate P3)', () => {
  it('maps sizeHint to the tier default budgets', async () => {
    const { goals } = makeGoalMode();

    const snapshot = await goals.createGoal({ objective: 'work', sizeHint: 'large' });

    expect(snapshot.budget.turnBudget).toBe(120);
    expect(snapshot.budget.tokenBudget).toBe(6_000_000);
    expect(snapshot.budget.wallClockBudgetMs).toBeNull();
  });

  it.each([
    ['x'.repeat(280), 'small', 10, 300_000],
    ['x'.repeat(281), 'medium', 40, 1_500_000],
    ['x'.repeat(1200), 'medium', 40, 1_500_000],
    ['x'.repeat(1201), 'large', 120, 6_000_000],
  ])(
    'heuristically tiers a %i-char objective as %s',
    async (objective, _tier, turnBudget, tokenBudget) => {
      const { goals } = makeGoalMode();

      const snapshot = await goals.createGoal({ objective });

      expect(snapshot.budget.turnBudget).toBe(turnBudget);
      expect(snapshot.budget.tokenBudget).toBe(tokenBudget);
    },
  );

  it('lets [goal.tiers] config override each slot of the built-in defaults', async () => {
    const { goals } = makeGoalMode({
      config: { providers: {}, goal: { tiers: { small: { turns: 3 } } } },
    });

    const snapshot = await goals.createGoal({ objective: 'work' });

    // The configured turn cap wins; the unconfigured token cap falls back to
    // the built-in small-tier default.
    expect(snapshot.budget.turnBudget).toBe(3);
    expect(snapshot.budget.tokenBudget).toBe(300_000);
  });

  it('records the tiered budget as a goal.update that replay restores', async () => {
    const { goals, records } = makeGoalMode();

    await goals.createGoal({ objective: 'work', sizeHint: 'medium' });

    const create = records.find((record) => record.type === 'goal.create');
    const tieredUpdate = records.find(
      (record) => record.type === 'goal.update' && 'budgetLimits' in record,
    );
    expect(create).toBeDefined();
    expect(tieredUpdate).toMatchObject({
      budgetLimits: { turnBudget: 40, tokenBudget: 1_500_000 },
    });

    // Replay the same records into a fresh GoalMode: the tiered budget comes
    // back without any new record type or migration.
    const { goals: restored } = makeGoalMode();
    restored.restoreCreate(create as AgentRecordOf<'goal.create'>);
    restored.restoreUpdate(tieredUpdate as AgentRecordOf<'goal.update'>);
    expect(restored.getGoal().goal?.budget.turnBudget).toBe(40);
    expect(restored.getGoal().goal?.budget.tokenBudget).toBe(1_500_000);
  });

  it('lets an explicit setBudgetLimits merge-override the tiered default', async () => {
    const { goals } = makeGoalMode();

    await goals.createGoal({ objective: 'work' }); // small: 10 turns / 300k tokens
    const snapshot = await goals.setBudgetLimits({ budgetLimits: { turnBudget: 2 } }, 'model');

    expect(snapshot.budget.turnBudget).toBe(2);
    expect(snapshot.budget.tokenBudget).toBe(300_000);
  });

  it('fills nothing when tieredBudgets is disabled', async () => {
    const { goals, records } = makeGoalMode({
      config: { providers: {}, goal: { tieredBudgets: false } },
    });

    const snapshot = await goals.createGoal({ objective: 'work', sizeHint: 'large' });

    expect(snapshot.budget.turnBudget).toBeNull();
    expect(snapshot.budget.tokenBudget).toBeNull();
    expect(snapshot.budget.wallClockBudgetMs).toBeNull();
    expect(records.filter((record) => record.type === 'goal.update')).toEqual([]);
  });
});
