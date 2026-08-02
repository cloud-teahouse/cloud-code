/**
 * Rate-limit pause → auto-resume integration: a retry wait that
 * breaches the foreground gates ends the turn as a rate-limit pause, and a
 * session-level timer retries it — unless a new prompt cancels it or the
 * consecutive-pause budget runs out. Goal mode resumes through `resumeGoal`.
 * Run with: pnpm --filter @cloud-code/agent-core test -- rate-limit-pause.test.ts
 */

import { setTimeout as delay } from 'node:timers/promises';

import { APIProviderRateLimitError } from '@cloud-code/kosong';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentOptions } from '../../src/agent';
import {
  resolveRetryAutoResume,
  resolveRetryAutoResumeMaxAttempts,
  resolveRetryForegroundMaxDelayMs,
  resolveRetryForegroundMaxTotalWaitMs,
} from '../../src/agent/turn';
import { testAgent, type TestAgentContext } from './harness/agent';
import type { RpcSnapshotEntry } from './harness/snapshots';

type GenerateFn = NonNullable<AgentOptions['generate']>;

const USAGE = { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 } as const;

function textResponse(id: string, text: string) {
  return {
    id,
    message: { role: 'assistant' as const, content: [{ type: 'text' as const, text }], toolCalls: [] },
    usage: { ...USAGE },
    finishReason: 'completed' as const,
    rawFinishReason: 'stop',
    traceId: null,
  };
}

function updateGoalCompleteResponse(id: string) {
  return {
    id,
    message: {
      role: 'assistant' as const,
      content: [],
      toolCalls: [
        {
          type: 'function' as const,
          id: 'call_complete',
          name: 'UpdateGoal',
          arguments: JSON.stringify({ status: 'complete' }),
        },
      ],
    },
    usage: { ...USAGE },
    finishReason: 'tool_calls' as const,
    rawFinishReason: 'tool_calls',
    traceId: null,
  };
}

/** Agent (RPC) events of one type observed by the harness so far. */
function agentEvents(ctx: TestAgentContext, type: string): RpcSnapshotEntry[] {
  return ctx.allEvents.filter(
    (entry): entry is RpcSnapshotEntry => entry.type === '[rpc]' && entry.event === type,
  );
}

const PAUSE_GATE_CONFIG = {
  providers: {},
  loopControl: { retryForegroundMaxDelayMs: 50 },
} as const;

describe('retry gate config resolution (C1 P2)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers CLOUD_CODE_LOOP_RETRY_FOREGROUND_MAX_DELAY_MS over config and ignores invalid values', () => {
    expect(resolveRetryForegroundMaxDelayMs(30_000)).toBe(30_000);
    expect(resolveRetryForegroundMaxDelayMs()).toBeUndefined();

    vi.stubEnv('CLOUD_CODE_LOOP_RETRY_FOREGROUND_MAX_DELAY_MS', '45000');
    expect(resolveRetryForegroundMaxDelayMs(30_000)).toBe(45_000);
    expect(resolveRetryForegroundMaxDelayMs()).toBe(45_000);

    vi.stubEnv('CLOUD_CODE_LOOP_RETRY_FOREGROUND_MAX_DELAY_MS', '0');
    expect(resolveRetryForegroundMaxDelayMs(30_000)).toBe(30_000);
    vi.stubEnv('CLOUD_CODE_LOOP_RETRY_FOREGROUND_MAX_DELAY_MS', 'abc');
    expect(resolveRetryForegroundMaxDelayMs(30_000)).toBe(30_000);
    vi.stubEnv('CLOUD_CODE_LOOP_RETRY_FOREGROUND_MAX_DELAY_MS', '-5');
    expect(resolveRetryForegroundMaxDelayMs()).toBeUndefined();
  });

  it('prefers CLOUD_CODE_LOOP_RETRY_FOREGROUND_MAX_TOTAL_WAIT_MS over config', () => {
    expect(resolveRetryForegroundMaxTotalWaitMs(90_000)).toBe(90_000);
    expect(resolveRetryForegroundMaxTotalWaitMs()).toBeUndefined();

    vi.stubEnv('CLOUD_CODE_LOOP_RETRY_FOREGROUND_MAX_TOTAL_WAIT_MS', '200000');
    expect(resolveRetryForegroundMaxTotalWaitMs(90_000)).toBe(200_000);

    vi.stubEnv('CLOUD_CODE_LOOP_RETRY_FOREGROUND_MAX_TOTAL_WAIT_MS', '1.5');
    expect(resolveRetryForegroundMaxTotalWaitMs(90_000)).toBe(90_000);
  });

  it('prefers CLOUD_CODE_LOOP_RETRY_AUTO_RESUME over config', () => {
    expect(resolveRetryAutoResume(false)).toBe(false);
    expect(resolveRetryAutoResume()).toBeUndefined();

    vi.stubEnv('CLOUD_CODE_LOOP_RETRY_AUTO_RESUME', 'false');
    expect(resolveRetryAutoResume(true)).toBe(false);
    vi.stubEnv('CLOUD_CODE_LOOP_RETRY_AUTO_RESUME', '1');
    expect(resolveRetryAutoResume(false)).toBe(true);

    vi.stubEnv('CLOUD_CODE_LOOP_RETRY_AUTO_RESUME', 'maybe');
    expect(resolveRetryAutoResume(false)).toBe(false);
  });

  it('prefers CLOUD_CODE_LOOP_RETRY_AUTO_RESUME_MAX_ATTEMPTS over config, defaulting to 3', () => {
    expect(resolveRetryAutoResumeMaxAttempts(5)).toBe(5);
    expect(resolveRetryAutoResumeMaxAttempts()).toBe(3);

    vi.stubEnv('CLOUD_CODE_LOOP_RETRY_AUTO_RESUME_MAX_ATTEMPTS', '7');
    expect(resolveRetryAutoResumeMaxAttempts(5)).toBe(7);

    vi.stubEnv('CLOUD_CODE_LOOP_RETRY_AUTO_RESUME_MAX_ATTEMPTS', '0');
    expect(resolveRetryAutoResumeMaxAttempts(5)).toBe(5);
    vi.stubEnv('CLOUD_CODE_LOOP_RETRY_AUTO_RESUME_MAX_ATTEMPTS', 'nope');
    expect(resolveRetryAutoResumeMaxAttempts()).toBe(3);
  });
});

describe('rate-limit pause → auto-resume (C1 P2)', () => {
  it('pauses on an over-long Retry-After, auto-resumes on the timer, and completes', async () => {
    let calls = 0;
    const generate: GenerateFn = async () => {
      calls += 1;
      if (calls === 1) {
        // 80ms server wait against a 50ms single-wait gate: the first attempt
        // trips the gate and the turn parks for those 80ms.
        throw new APIProviderRateLimitError('rate limited', 'req-rl-1', 80);
      }
      return textResponse(`mock-ok-${String(calls)}`, 'recovered');
    };
    const ctx = testAgent({ generate, initialConfig: PAUSE_GATE_CONFIG });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    const pauseEvents = await ctx.untilTurnEnd();

    // The turn ends failed with a provider.rate_limit payload carrying the
    // pause details, and the pause event precedes it (emitted on schedule).
    expect(pauseEvents).toContainEqual(
      expect.objectContaining({
        event: 'turn.rate_limit_paused',
        args: expect.objectContaining({ turnId: 0, attempt: 1 }),
      }),
    );
    expect(pauseEvents).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: 'provider.rate_limit',
            details: expect.objectContaining({ resumeAfterMs: 80, autoResume: true }),
          }),
        }),
      }),
    );
    expect(calls).toBe(1);

    // The parked timer fires: the turn is retried and completes.
    const resumeEvents = await ctx.untilTurnEnd();
    expect(resumeEvents).toContainEqual(
      expect.objectContaining({
        event: 'turn.rate_limit_resuming',
        args: expect.objectContaining({ turnId: 0, attempt: 1 }),
      }),
    );
    expect(resumeEvents).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ turnId: 1, reason: 'completed' }),
      }),
    );
    expect(calls).toBe(2);

    // Pause/resume bookkeeping is in-memory only: replaying the records
    // produces the identical session state.
    await ctx.expectResumeMatches();
  });

  it('cancels the pending auto-resume when a new prompt arrives', async () => {
    let calls = 0;
    const generate: GenerateFn = async () => {
      calls += 1;
      if (calls === 1) {
        throw new APIProviderRateLimitError('rate limited', 'req-rl-1', 300);
      }
      return textResponse(`mock-ok-${String(calls)}`, 'user took over');
    };
    const ctx = testAgent({ generate, initialConfig: PAUSE_GATE_CONFIG });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();
    expect(agentEvents(ctx, 'turn.rate_limit_paused')).toHaveLength(1);

    // A new prompt supersedes the parked 300ms resume.
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'never mind, do this' }] });
    await ctx.untilTurnEnd();

    await delay(400);
    expect(calls).toBe(2);
    expect(agentEvents(ctx, 'turn.rate_limit_resuming')).toHaveLength(0);
    expect(agentEvents(ctx, 'turn.ended')).toHaveLength(2);
  });

  it('gives up auto-resuming after 3 consecutive pauses', async () => {
    let calls = 0;
    const generate: GenerateFn = async () => {
      calls += 1;
      throw new APIProviderRateLimitError('rate limited', `req-rl-${String(calls)}`, 60);
    };
    const ctx = testAgent({ generate, initialConfig: PAUSE_GATE_CONFIG });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    // Pause 1 → resume → pause 2 → resume → pause 3 → the budget
    // (retryAutoResumeMaxAttempts, default 3) is spent: no third resume.
    await ctx.untilTurnEnd();
    await ctx.untilTurnEnd();
    await ctx.untilTurnEnd();

    await delay(200);
    expect(calls).toBe(3);
    const paused = agentEvents(ctx, 'turn.rate_limit_paused');
    expect(paused).toHaveLength(3);
    expect(paused.map((entry) => (entry.args as { attempt: number }).attempt)).toEqual([1, 2, 3]);
    expect(agentEvents(ctx, 'turn.rate_limit_resuming')).toHaveLength(2);
    expect(agentEvents(ctx, 'turn.ended')).toHaveLength(3);
  });

  it('resumes a goal paused by the rate-limit pause through resumeGoal', async () => {
    let calls = 0;
    const generate: GenerateFn = async () => {
      calls += 1;
      if (calls === 1) {
        throw new APIProviderRateLimitError('rate limited', 'req-rl-1', 80);
      }
      if (calls === 2) return updateGoalCompleteResponse('mock-goal-complete');
      return textResponse('mock-goal-done', 'goal wrapped up');
    };
    const ctx = testAgent({ generate, initialConfig: PAUSE_GATE_CONFIG });
    ctx.configure({ tools: ['GetGoal', 'UpdateGoal'] });
    await ctx.rpc.createGoal({ objective: 'work' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'work' }] });
    await ctx.untilTurnEnd();

    // The failed turn parked the goal through the driver's existing pause path.
    const pausedGoal = ctx.agent.goal.getGoal().goal;
    expect(pausedGoal?.status).toBe('paused');
    expect(pausedGoal?.terminalReason).toBe('Paused after provider rate limit');

    // The timer resumes the goal and the driver completes it.
    await ctx.untilTurnEnd();
    expect(agentEvents(ctx, 'turn.rate_limit_resuming')).toHaveLength(1);
    expect(ctx.agent.goal.getGoal().goal).toBeNull();
    expect(agentEvents(ctx, 'turn.ended')).toHaveLength(2);
    expect(calls).toBe(3);
  });
});
