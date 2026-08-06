import { describe, expect, it } from 'vitest';

import type { Agent } from '../../src/agent';
import { GoalMode } from '../../src/agent/goal';
import type { CloudCodeConfig } from '../../src/config';
import { ErrorCodes } from '../../src/errors';
import { compileToolArgsValidator, validateToolArgs } from '../../src/tools/args-validator';
import {
  CreateGoalTool,
  CreateGoalToolInputSchema,
  GetGoalTool,
  SetGoalBudgetTool,
  SetGoalBudgetToolInputSchema,
  UpdateGoalTool,
  UpdateGoalToolInputSchema,
} from '../../src/tools/builtin';
import { testAgent } from '../agent/harness/agent';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function makeStore(opts: { config?: CloudCodeConfig } = {}) {
  return fakeAgent(opts).goal;
}

function fakeAgent(opts: { type?: 'main' | 'sub'; goal?: GoalMode; config?: CloudCodeConfig } = {}): Agent {
  const agent = {
    type: opts.type ?? 'main',
    records: { logRecord: () => {} },
    emitEvent: () => {},
    context: { appendSystemReminder: () => {} },
    permission: { mode: 'manual' },
    cloudCodeConfig: opts.config,
  } as unknown as Agent;
  (agent as { goal: GoalMode }).goal = opts.goal ?? new GoalMode(agent);
  return agent;
}

function ctx<Input>(args: Input) {
  return { turnId: '0', toolCallId: 'call_1', args, signal };
}

describe('CreateGoalTool', () => {
  it('creates a goal through the goal store', async () => {
    const store = makeStore();
    const tool = new CreateGoalTool(fakeAgent({ goal: store }));
    const result = await executeTool(tool, ctx({ objective: 'Ship feature X' }));
    expect(result.isError).toBeFalsy();
    expect(store.getGoal().goal?.objective).toBe('Ship feature X');
    expect(result.structured).toEqual({ status: 'active' });
  });

  it('omits the internal goalId from the model-facing output', async () => {
    const store = makeStore();
    const tool = new CreateGoalTool(fakeAgent({ goal: store }));
    const result = await executeTool(tool, ctx({ objective: 'Ship feature X' }));
    expect(store.getGoal().goal?.goalId).toBeTruthy();
    expect(result.output).not.toContain('goalId');
    expect(result.output).not.toContain(store.getGoal().goal?.goalId ?? 'no-id');
  });

  it('passes completionCriterion and replace', async () => {
    const store = makeStore();
    const tool = new CreateGoalTool(fakeAgent({ goal: store }));
    await executeTool(tool, ctx({ objective: 'first' }));
    await executeTool(
      tool,
      ctx({
        objective: 'second',
        completionCriterion: 'tests pass',
        replace: true,
      }),
    );
    const goal = store.getGoal().goal!;
    expect(goal.objective).toBe('second');
    expect(goal.completionCriterion).toBe('tests pass');
    // P3 tiered budgets: a short objective heuristically tiers `small`, which
    // fills the default token cap (10 turns / 300k tokens) at creation.
    expect(goal.budget.tokenBudget).toBe(300_000);
  });

  it('rejects empty and too-long objectives via the store', async () => {
    const store = makeStore();
    const tool = new CreateGoalTool(fakeAgent({ goal: store }));
    await expect(executeTool(tool, ctx({ objective: '   ' }))).rejects.toMatchObject({
      code: ErrorCodes.GOAL_OBJECTIVE_EMPTY,
    });
    await expect(executeTool(tool, ctx({ objective: 'x'.repeat(4001) }))).rejects.toMatchObject({
      code: ErrorCodes.GOAL_OBJECTIVE_TOO_LONG,
    });
  });

  it('uses the imported markdown description', () => {
    const tool = new CreateGoalTool(fakeAgent());
    expect(tool.description).toContain('Create a durable, structured goal');
    expect(tool.description).not.toContain('SetGoalBudget');
  });

  it('warns that creating fails when a goal already exists', () => {
    const description = new CreateGoalTool(fakeAgent()).description.toLowerCase();
    // agent/goal/index.ts throws "A goal already exists; use replace..." without replace:true.
    expect(description).toContain('already exists');
    expect(description).toContain('replace');
    // The replace param blocks on any persisted goal, including `blocked` (index.ts).
    const replaceDesc =
      ((new CreateGoalTool(fakeAgent()).parameters as {
        properties: Record<string, { description?: string }>;
      }).properties['replace']?.description) ?? '';
    expect(replaceDesc).toContain('blocked');
  });
});

describe('CreateGoalTool tiered budgets (completion-gate P3)', () => {
  it('maps sizeHint to the tier default budgets', async () => {
    const store = makeStore();
    const tool = new CreateGoalTool(fakeAgent({ goal: store }));
    const result = await executeTool(
      tool,
      ctx({ objective: 'Refactor the module layout', sizeHint: 'large' }),
    );
    expect(result.isError).toBeFalsy();
    const goal = store.getGoal().goal!;
    expect(goal.budget.turnBudget).toBe(120);
    expect(goal.budget.tokenBudget).toBe(6_000_000);
    // Wall-clock deliberately gets no tiered default.
    expect(goal.budget.wallClockBudgetMs).toBeNull();

    const output = JSON.parse(result.output as string) as {
      goal: { budget: { turnBudget: number; tokenBudget: number } };
    };
    expect(output.goal.budget.turnBudget).toBe(120);
    expect(output.goal.budget.tokenBudget).toBe(6_000_000);
  });

  it.each([
    ['x'.repeat(280), 10, 300_000],
    ['x'.repeat(281), 40, 1_500_000],
    ['x'.repeat(1200), 40, 1_500_000],
    ['x'.repeat(1201), 120, 6_000_000],
  ])(
    'infers the tier from objective length %i chars -> %i turns / %i tokens',
    async (objective, turnBudget, tokenBudget) => {
      const store = makeStore();
      const tool = new CreateGoalTool(fakeAgent({ goal: store }));
      await executeTool(tool, ctx({ objective }));
      expect(store.getGoal().goal?.budget.turnBudget).toBe(turnBudget);
      expect(store.getGoal().goal?.budget.tokenBudget).toBe(tokenBudget);
    },
  );

  it('lets an explicit budget override the tiered default', async () => {
    const store = makeStore();
    const agent = fakeAgent({ goal: store });
    await executeTool(new CreateGoalTool(agent), ctx({ objective: 'work', sizeHint: 'small' }));
    expect(store.getGoal().goal?.budget.turnBudget).toBe(10);

    const result = await executeTool(new SetGoalBudgetTool(agent), ctx({ value: 2, unit: 'turns' }));
    expect(result.isError).toBeFalsy();
    // The explicit turn budget wins; the untouched tiered token cap stays.
    expect(store.getGoal().goal?.budget.turnBudget).toBe(2);
    expect(store.getGoal().goal?.budget.tokenBudget).toBe(300_000);
  });

  it('fills no budgets when tieredBudgets is disabled in config', async () => {
    // The store's own agent carries the config — that is the one GoalMode reads.
    const store = makeStore({ config: { providers: {}, goal: { tieredBudgets: false } } });
    const tool = new CreateGoalTool(fakeAgent({ goal: store }));
    await executeTool(tool, ctx({ objective: 'work', sizeHint: 'large' }));
    const budget = store.getGoal().goal!.budget;
    expect(budget.turnBudget).toBeNull();
    expect(budget.tokenBudget).toBeNull();
    expect(budget.wallClockBudgetMs).toBeNull();
  });
});

describe('GetGoalTool', () => {
  it('returns { goal: null } when no goal exists', async () => {
    const store = makeStore();
    const tool = new GetGoalTool(fakeAgent({ goal: store }));
    const result = await executeTool(tool, ctx({}));
    expect(JSON.parse(result.output as string)).toEqual({ goal: null });
  });

  it('returns active goal state with budgets', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.setBudgetLimits({ budgetLimits: { tokenBudget: 100 } }, 'model');
    const tool = new GetGoalTool(fakeAgent({ goal: store }));
    const result = await executeTool(tool, ctx({}));
    const parsed = JSON.parse(result.output as string);
    expect(parsed.goal.status).toBe('active');
    expect(parsed.goal.budget.tokenBudget).toBe(100);
    expect(parsed.goal.budget.remainingTokens).toBe(100);
  });

  it('returns paused and blocked snapshots', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.pauseGoal();
    const tool = new GetGoalTool(fakeAgent({ goal: store }));
    let parsed = JSON.parse((await executeTool(tool, ctx({}))).output as string);
    expect(parsed.goal.status).toBe('paused');
    await store.resumeGoal();
    await store.markBlocked({ reason: 'stuck' });
    parsed = JSON.parse((await executeTool(tool, ctx({}))).output as string);
    expect(parsed.goal.status).toBe('blocked');
  });

  it('describes only the fields GetGoal actually returns', () => {
    const description = new GetGoalTool(fakeAgent()).description.toLowerCase();
    expect(description).toContain('objective');
    expect(description).toContain('budget');
    // GoalSnapshot has no self-report / evaluator-verdict fields, so the
    // description must not promise them (serialize.ts strips the UI-only
    // fields: goalId and the reason code/detail).
    expect(description).not.toContain('self-report');
    expect(description).not.toContain('evaluator');
  });

  it('carries the status and coded terminal reason in the structured payload', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.pauseActiveGoal({
      reason: 'Paused after provider API error: 400 boom',
      reasonCode: 'provider_api',
      reasonDetail: '400 boom',
    });
    const tool = new GetGoalTool(fakeAgent({ goal: store }));
    const result = await executeTool(tool, ctx({}));
    expect(result.structured).toEqual({
      status: 'paused',
      terminalReason: 'Paused after provider API error: 400 boom',
      terminalReasonCode: 'provider_api',
      terminalReasonDetail: '400 boom',
    });
    // The model-facing JSON keeps the human text but not the UI-only code.
    const parsed = JSON.parse(result.output as string);
    expect(parsed.goal.terminalReason).toBe('Paused after provider API error: 400 boom');
    expect('terminalReasonCode' in parsed.goal).toBe(false);
    expect('terminalReasonDetail' in parsed.goal).toBe(false);
  });

  it('omits the structured payload when there is no goal', async () => {
    const tool = new GetGoalTool(fakeAgent({ goal: makeStore() }));
    const result = await executeTool(tool, ctx({}));
    expect(result.structured).toBeUndefined();
  });
});

describe('SetGoalBudgetTool', () => {
  it('states the 1-second to 24-hour time-budget band', () => {
    const description = new SetGoalBudgetTool(fakeAgent()).description;
    // set-goal-budget.ts rejects time budgets < 1s or > 24h (MIN/MAX_REASONABLE_TIME_BUDGET_MS).
    expect(description).toContain('1 second');
    expect(description).toContain('24 hours');
    // turn/token budgets are floored at 1 and rounded to the nearest whole number
    // (Math.max(1, Math.round(value))) — the description must not claim "rounded up".
    expect(description).toContain('rounded to the nearest whole number');
    expect(description).not.toContain('rounded up');
  });

  it('advertises an object parameter schema for OpenAI-compatible providers', () => {
    const parameters = new SetGoalBudgetTool(fakeAgent()).parameters;

    expect(parameters).toMatchObject({
      type: 'object',
      required: ['value', 'unit'],
      additionalProperties: false,
      properties: {
        value: expect.objectContaining({ type: 'number', exclusiveMinimum: 0 }),
        unit: expect.objectContaining({
          type: 'string',
          enum: ['turns', 'tokens', 'milliseconds', 'seconds', 'minutes', 'hours'],
        }),
      },
    });
    expect(parameters).not.toHaveProperty('oneOf');
    expect(parameters).not.toHaveProperty('anyOf');

    const validator = compileToolArgsValidator(parameters);
    expect(validateToolArgs(validator, { value: 1.5, unit: 'turns' })).toBeNull();
    expect(validateToolArgs(validator, { value: 1.5, unit: 'hours' })).toBeNull();
  });

  it('accepts a value with a supported budget unit', () => {
    for (const unit of ['turns', 'tokens', 'milliseconds', 'seconds', 'minutes', 'hours']) {
      expect(SetGoalBudgetToolInputSchema.safeParse({ value: 20, unit }).success).toBe(true);
    }
    expect(SetGoalBudgetToolInputSchema.safeParse({ value: 0, unit: 'turns' }).success).toBe(false);
    expect(SetGoalBudgetToolInputSchema.safeParse({ value: 1, unit: 'years' }).success).toBe(false);
    expect(SetGoalBudgetToolInputSchema.safeParse({ value: 1.5, unit: 'turns' }).success).toBe(true);
    expect(SetGoalBudgetToolInputSchema.safeParse({ value: 1.5, unit: 'hours' }).success).toBe(true);
  });

  it('sets turn, token, and time budgets on the current goal', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const tool = new SetGoalBudgetTool(fakeAgent({ goal: store }));

    expect((await executeTool(tool, ctx({ value: 20, unit: 'turns' }))).output).toBe(
      'Goal budget set: 20 turns.',
    );
    expect(store.getGoal().goal?.budget.turnBudget).toBe(20);

    expect((await executeTool(tool, ctx({ value: 500_000, unit: 'tokens' }))).output).toBe(
      'Goal budget set: 500000 tokens.',
    );
    expect(store.getGoal().goal?.budget.tokenBudget).toBe(500_000);

    expect((await executeTool(tool, ctx({ value: 30, unit: 'minutes' }))).output).toBe(
      'Goal budget set: 30 minutes.',
    );
    expect(store.getGoal().goal?.budget.wallClockBudgetMs).toBe(30 * 60 * 1000);
  });

  it('reports no current goal instead of throwing when no goal exists', async () => {
    const tool = new SetGoalBudgetTool(fakeAgent());

    const result = await executeTool(tool, ctx({ value: 20, unit: 'turns' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('Goal budget not set: no current goal.');
  });

  it('rounds fractional turn and token budgets before setting them', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const tool = new SetGoalBudgetTool(fakeAgent({ goal: store }));

    expect((await executeTool(tool, ctx({ value: 1.5, unit: 'turns' }))).output).toBe(
      'Goal budget set: 2 turns.',
    );
    expect(store.getGoal().goal?.budget.turnBudget).toBe(2);

    expect((await executeTool(tool, ctx({ value: 0.4, unit: 'tokens' }))).output).toBe(
      'Goal budget set: 1 token.',
    );
    expect(store.getGoal().goal?.budget.tokenBudget).toBe(1);
  });

  it('ignores unreasonable time budgets and tells the model why', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const tool = new SetGoalBudgetTool(fakeAgent({ goal: store }));

    const tiny = await executeTool(tool, ctx({ value: 1, unit: 'milliseconds' }));
    expect(tiny.isError).toBeFalsy();
    expect(tiny.output).toContain('not a reasonable goal budget');
    expect(store.getGoal().goal?.budget.wallClockBudgetMs).toBeNull();

    const huge = await executeTool(tool, ctx({ value: 8760, unit: 'hours' }));
    expect(huge.isError).toBeFalsy();
    expect(huge.output).toContain('not a reasonable goal budget');
    expect(store.getGoal().goal?.budget.wallClockBudgetMs).toBeNull();
  });

  it('stops the batch and turn when the new budget is already exhausted', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.incrementTurn(); // turnsUsed = 1
    const tool = new SetGoalBudgetTool(fakeAgent({ goal: store }));

    const execution = tool.resolveExecution({ value: 1, unit: 'turns' });
    if (execution.isError === true) throw new Error('execution should not be an error');
    expect(execution.stopBatchAfterThis).toBe(true);

    const result = await execution.execute({ turnId: '0', toolCallId: 'call_1', signal });
    expect(result.stopTurn).toBe(true);
    expect(result.output).toContain('will stop now');
    expect(store.getGoal().goal?.budget.overBudget).toBe(true);
  });

  it('does not stop when the new budget leaves room', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.incrementTurn(); // turnsUsed = 1
    const tool = new SetGoalBudgetTool(fakeAgent({ goal: store }));

    const execution = tool.resolveExecution({ value: 5, unit: 'turns' });
    if (execution.isError === true) throw new Error('execution should not be an error');
    expect(execution.stopBatchAfterThis).toBeFalsy();

    const result = await execution.execute({ turnId: '0', toolCallId: 'call_1', signal });
    expect(result.stopTurn).toBeFalsy();
    expect(result.output).toBe('Goal budget set: 5 turns.');
  });
});

describe('UpdateGoalTool', () => {
  it('guards against premature blocked status', () => {
    const description = new UpdateGoalTool(fakeAgent()).description.toLowerCase();
    // Reserve blocked for genuine impasses, not ordinary unfinished work.
    expect(description).toContain('genuine impasse');
    expect(description).toContain('3 consecutive goal turns');
    expect(description).toContain('fresh blocked audit');
    expect(description).toContain('impossible, unsafe, or contradictory');
    expect(description).toContain('same turn instead of running more goal turns');
    expect(description).toContain('hard, slow');
    expect(description).toContain('needs more goal turns');
    // UpdateGoal also injects the completion/blocked outcome prompt, so it does
    // more than "only record the status".
    expect(description).not.toContain('only records the status');
  });

  it('exposes the blocked-audit rule in the status parameter schema', () => {
    const statusDescription =
      ((new UpdateGoalTool(fakeAgent()).parameters as {
        properties: Record<string, { description?: string }>;
      }).properties['status']?.description) ?? '';
    expect(statusDescription).toContain('3 consecutive goal turns');
    expect(statusDescription).toContain('impossible, unsafe, or contradictory objectives');
  });

  it('discourages calling UpdateGoal after a non-terminal work slice', () => {
    const description = new UpdateGoalTool(fakeAgent()).description;
    expect(description).toContain('Most active goal turns should not call this tool');
    expect(description).toContain('end the turn normally without calling UpdateGoal');
    expect(description).toContain('actual objective and every explicit requirement');
    expect(description).toContain('weak or indirect evidence');
    expect(description).toContain('budget is nearly exhausted');
  });

  // Keep a capturing context here to prove terminal paths no longer append a
  // separate reminder; the outcome prompt is returned as the tool result.
  function agentWithContext(
    store: GoalMode,
    reminders: Array<{ readonly content: string; readonly origin: unknown }> = [],
  ): Agent {
    return {
      type: 'main',
      goal: store,
      context: {
        appendSystemReminder: (content: string, origin: unknown) => {
          reminders.push({ content, origin });
        },
      },
    } as unknown as Agent;
  }

  it('accepts only active / complete / blocked', () => {
    for (const status of ['active', 'complete', 'blocked']) {
      expect(UpdateGoalToolInputSchema.safeParse({ status }).success).toBe(true);
    }
    expect(UpdateGoalToolInputSchema.safeParse({ status: 'blocked', reason: 'x' }).success).toBe(false);
    for (const status of ['paused', 'impossible', 'cancelled', '']) {
      expect(UpdateGoalToolInputSchema.safeParse({ status }).success).toBe(false);
    }
  });

  it('forbids model-driven goal pauses', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const tool = new UpdateGoalTool(agentWithContext(store));
    const validator = compileToolArgsValidator(tool.parameters);

    expect(validateToolArgs(validator, { status: 'paused' })).not.toBeNull();

    const execution = tool.resolveExecution({ status: 'paused' } as never);
    expect(execution).toMatchObject({
      isError: true,
      output: 'Invalid goal status. Use `active`, `complete`, or `blocked`.',
      display: { key: 'toolResult.goal.invalidStatus' },
    });
    expect(store.getGoal().goal?.status).toBe('active');
  });

  it('`complete` marks the goal complete and clears it (transient)', async () => {
    const store = makeStore();
    const reminders: Array<{ readonly content: string; readonly origin: unknown }> = [];
    await store.createGoal({ objective: 'work' });
    const result = await executeTool(
      new UpdateGoalTool(agentWithContext(store, reminders)),
      ctx({ status: 'complete' }),
    );
    expect(result.isError).toBeFalsy();
    expect(result.stopTurn).toBe(true);
    expect(result.output).toContain('Goal completed successfully.');
    expect(result.output).toContain('Write a concise final message for the user');
    expect(store.getGoal().goal).toBeNull();
    expect(reminders).toHaveLength(0);
  });

  it('`blocked` marks the goal blocked (resumable) and asks for a blocker reason', async () => {
    const store = makeStore();
    const reminders: Array<{ readonly content: string; readonly origin: unknown }> = [];
    await store.createGoal({ objective: 'work' });
    const result = await executeTool(
      new UpdateGoalTool(agentWithContext(store, reminders)),
      ctx({ status: 'blocked' }),
    );
    expect(result.stopTurn).toBe(true);
    expect(result.output).toContain('Goal blocked.');
    expect(result.output).toContain('concrete blocker');
    expect(store.getGoal().goal?.status).toBe('blocked');
    expect(store.getGoal().goal?.terminalReason).toBeUndefined();
    expect(reminders).toHaveLength(0);
  });

  it('`active` resumes a paused goal', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.pauseGoal();
    const result = await executeTool(new UpdateGoalTool(agentWithContext(store)), ctx({ status: 'active' }));
    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('Goal resumed.');
    expect(store.getGoal().goal?.status).toBe('active');
  });

  it.each([
    ['active', 'Goal not resumed: no current goal.'],
    ['complete', 'Goal not completed: no active goal.'],
    ['blocked', 'Goal not blocked: no active goal.'],
  ] as const)('reports a no-goal result for `%s` without stopping the turn', async (status, output) => {
    const tool = new UpdateGoalTool(agentWithContext(makeStore()));
    const execution = tool.resolveExecution({ status });
    if (execution.isError === true) throw new Error('execution should not be an error');

    expect(execution.stopBatchAfterThis).toBeFalsy();
    const result = await execution.execute({ turnId: '0', toolCallId: 'call_1', signal });

    expect(result.isError).toBeFalsy();
    expect(result.stopTurn).toBeFalsy();
    expect(result.output).toBe(output);
  });

  it('accepts an optional evidence list of tool call ids in the schema', () => {
    expect(UpdateGoalToolInputSchema.safeParse({ status: 'complete' }).success).toBe(true);
    expect(UpdateGoalToolInputSchema.safeParse({ status: 'complete', evidence: ['a', 'b'] }).success).toBe(true);
    expect(UpdateGoalToolInputSchema.safeParse({ status: 'blocked', evidence: [] }).success).toBe(true);
    expect(UpdateGoalToolInputSchema.safeParse({ status: 'complete', evidence: 'a' }).success).toBe(false);
    expect(UpdateGoalToolInputSchema.safeParse({ status: 'complete', evidence: [1] }).success).toBe(false);

    const parameters = new UpdateGoalTool(fakeAgent()).parameters as {
      properties: Record<string, { type?: string; items?: { type?: string } }>;
    };
    expect(parameters.properties['evidence']).toMatchObject({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('documents the complete-time evidence requirement in the description', () => {
    const description = new UpdateGoalTool(fakeAgent()).description;
    expect(description).toContain('`evidence`');
    expect(description).toContain('captured after your latest code change');
    expect(description).toContain('rejected with a tool error');
    expect(description).toContain('background task results are not recorded as evidence');
  });

  it('rejects evidence-free completion once a mutation was observed; the goal stays active', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    store.recordMutation();
    const result = await executeTool(
      new UpdateGoalTool(agentWithContext(store)),
      ctx({ status: 'complete' }),
    );

    expect(result.isError).toBe(true);
    expect(result.stopTurn).toBeFalsy();
    expect(result.output as string).toContain('completion gate');
    expect(result.output as string).toContain('still active');
    expect(result.output as string).toContain('no usable receipts');
    expect(store.getGoal().goal?.status).toBe('active');
  });

  it('rejects unknown citations with per-id reasons and the usable receipt list', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    store.recordMutation();
    store.recordEvidence({
      receiptId: 'b1',
      toolName: 'Bash',
      turnId: 1,
      step: 1,
      ok: true,
      summary: 'pnpm test',
    });

    const rejected = await executeTool(
      new UpdateGoalTool(agentWithContext(store)),
      ctx({ status: 'complete', evidence: ['nope'] }),
    );
    expect(rejected.isError).toBe(true);
    expect(rejected.output as string).toContain('Receipt "nope" is not in the goal evidence ledger');
    expect(rejected.output as string).toContain('b1 (Bash: pnpm test)');
    expect(store.getGoal().goal?.status).toBe('active');

    // Citing the usable receipt then completes through the normal path.
    const passed = await executeTool(
      new UpdateGoalTool(agentWithContext(store)),
      ctx({ status: 'complete', evidence: ['b1'] }),
    );
    expect(passed.isError).toBeFalsy();
    expect(passed.stopTurn).toBe(true);
    expect(passed.output as string).toContain('Goal completed successfully.');
    expect(store.getGoal().goal).toBeNull();
  });

  it('completes without evidence when the gate is disabled in config', async () => {
    const store = makeStore({ config: { providers: {}, goal: { completionGate: false } } });
    await store.createGoal({ objective: 'work' });
    store.recordMutation();
    const result = await executeTool(
      new UpdateGoalTool(agentWithContext(store)),
      ctx({ status: 'complete' }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.output as string).toContain('Goal completed successfully.');
    expect(store.getGoal().goal).toBeNull();
  });
});

describe('ToolManager goal tool registration', () => {
  function loopToolNames(type: 'main' | 'sub'): readonly string[] {
    const ctxAgent = testAgent({
      type,
    });
    // configure() gives the agent a provider so builtin tools can initialize.
    ctxAgent.configure({ tools: ['Read', 'CreateGoal', 'GetGoal', 'SetGoalBudget', 'UpdateGoal'] });
    // Re-run registration so the gate reads the scoped flag resolver state.
    ctxAgent.agent.tools.initializeBuiltinTools();
    return ctxAgent.agent.tools.loopTools.map((tool) => tool.name);
  }

  it('exposes goal tools to the main agent', () => {
    const names = loopToolNames('main');
    expect(names).toEqual(
      expect.arrayContaining(['CreateGoal', 'GetGoal', 'SetGoalBudget', 'UpdateGoal']),
    );
  });

  it('does not expose goal tools to subagents even when enabled', () => {
    const names = loopToolNames('sub');
    expect(names).not.toContain('CreateGoal');
    expect(names).not.toContain('GetGoal');
    expect(names).not.toContain('SetGoalBudget');
    expect(names).not.toContain('UpdateGoal');
  });

  it('keeps goal mutation tools visible across goal lifecycle states', async () => {
    const store = makeStore();
    const ctxAgent = testAgent({
      type: 'main',
      goal: store,
    });
    ctxAgent.configure({ tools: ['Read', 'CreateGoal', 'GetGoal', 'SetGoalBudget', 'UpdateGoal'] });
    ctxAgent.agent.tools.initializeBuiltinTools();
    expect(ctxAgent.agent.tools.loopTools.map((t) => t.name)).toContain('UpdateGoal');
    expect(ctxAgent.agent.tools.loopTools.map((t) => t.name)).toContain('SetGoalBudget');

    await store.createGoal({ objective: 'work' });
    expect(ctxAgent.agent.tools.loopTools.map((t) => t.name)).toContain('UpdateGoal');
    expect(ctxAgent.agent.tools.loopTools.map((t) => t.name)).toContain('SetGoalBudget');

    await store.markComplete({}, 'model');
    expect(ctxAgent.agent.tools.loopTools.map((t) => t.name)).toContain('UpdateGoal');
    expect(ctxAgent.agent.tools.loopTools.map((t) => t.name)).toContain('SetGoalBudget');
  });
});

describe('CreateGoalToolInputSchema', () => {
  it('accepts a minimal objective and a full payload', () => {
    expect(CreateGoalToolInputSchema.safeParse({ objective: 'x' }).success).toBe(true);
    expect(
      CreateGoalToolInputSchema.safeParse({
        objective: 'x',
        completionCriterion: 'done',
        replace: true,
      }).success,
    ).toBe(true);
    expect(
      CreateGoalToolInputSchema.safeParse({
        objective: 'x',
        budgetLimits: { tokenBudget: 1 },
      }).success,
    ).toBe(false);
  });

  it('accepts a sizeHint tier and rejects unknown tiers', () => {
    for (const sizeHint of ['small', 'medium', 'large']) {
      expect(CreateGoalToolInputSchema.safeParse({ objective: 'x', sizeHint }).success).toBe(true);
    }
    expect(CreateGoalToolInputSchema.safeParse({ objective: 'x', sizeHint: 'tiny' }).success).toBe(false);
    expect(CreateGoalToolInputSchema.safeParse({ objective: 'x', sizeHint: 1 }).success).toBe(false);
  });
});
