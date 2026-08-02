import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import {
  BEHAVIOR_REMINDERS_INTERVAL_TURNS_DEFAULT,
  BEHAVIOR_REMINDERS_VARIANT,
} from '../../../src/agent/injection/behavior-reminders';
import {
  GENTLE_REMINDER_OPT_OUT,
  TRUST_BOUNDARY_PREFIX,
} from '../../../src/agent/injection/reminder';
import { testAgent } from '../harness/agent';

function behaviorReminderTexts(agent: Agent): string[] {
  return agent.context.history
    .filter(
      (message) =>
        message.origin?.kind === 'injection' &&
        message.origin.variant === BEHAVIOR_REMINDERS_VARIANT,
    )
    .map((message) =>
      message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
    );
}

describe('BehaviorRemindersInjector — content (standard tier)', () => {
  it('restates the standing rules and closes on the destructive-action prohibition', async () => {
    const ctx = testAgent();
    ctx.configure();

    await ctx.agent.injection.injectAfterCompaction();

    const texts = behaviorReminderTexts(ctx.agent);
    expect(texts).toHaveLength(1);
    const text = texts[0]!;
    expect(text).toContain('restated below');
    expect(text).toContain('Verify before declaring done');
    expect(text).toContain("user's language");
    expect(text).toContain('minimal and scoped');
    // Standard tier: no IMPORTANT prefix (not a trust boundary), no gentle
    // opt-out; the destructive-action prohibition is the closing line (the
    // message text still carries the <system-reminder> wrapper).
    expect(text).not.toContain(TRUST_BOUNDARY_PREFIX);
    expect(text).not.toContain(GENTLE_REMINDER_OPT_OUT);
    expect(text).toMatch(/no matter how long ago those rules were stated\.\n<\/system-reminder>$/);
  });
});

describe('BehaviorRemindersInjector — trigger timing', () => {
  it('always re-injects after compaction, without stacking on a repeat call', async () => {
    const ctx = testAgent();
    ctx.configure();

    await ctx.agent.injection.injectAfterCompaction();
    expect(behaviorReminderTexts(ctx.agent)).toHaveLength(1);

    // A back-to-back injectAfterCompaction with nothing in between must not
    // stack a second copy (the tail already is the reminder).
    await ctx.agent.injection.injectAfterCompaction();
    expect(behaviorReminderTexts(ctx.agent)).toHaveLength(1);
  });

  it('does not inject at a turn boundary before the interval has passed', async () => {
    const ctx = testAgent({
      initialConfig: { providers: {}, behaviorReminders: { intervalTurns: 2 } },
    });
    ctx.configure();

    ctx.appendAssistantText(1, 'step one');
    ctx.agent.injection.injectBehaviorReminders();

    expect(behaviorReminderTexts(ctx.agent)).toHaveLength(0);
  });

  it('injects at a turn boundary once the interval has passed, then re-arms', async () => {
    const ctx = testAgent({
      initialConfig: { providers: {}, behaviorReminders: { intervalTurns: 2 } },
    });
    ctx.configure();

    ctx.appendAssistantText(1, 'step one');
    ctx.appendAssistantText(2, 'step two');
    ctx.agent.injection.injectBehaviorReminders();
    expect(behaviorReminderTexts(ctx.agent)).toHaveLength(1);

    // The fresh reminder re-arms the counter: an immediate boundary is quiet.
    ctx.agent.injection.injectBehaviorReminders();
    expect(behaviorReminderTexts(ctx.agent)).toHaveLength(1);

    ctx.appendAssistantText(3, 'step three');
    ctx.appendAssistantText(4, 'step four');
    ctx.agent.injection.injectBehaviorReminders();
    expect(behaviorReminderTexts(ctx.agent)).toHaveLength(2);
  });

  it('stays quiet over a handful of turns at the default interval', async () => {
    const ctx = testAgent();
    ctx.configure();

    expect(BEHAVIOR_REMINDERS_INTERVAL_TURNS_DEFAULT).toBe(25);
    for (let step = 1; step <= 5; step += 1) {
      ctx.appendAssistantText(step, `step ${String(step)}`);
      ctx.agent.injection.injectBehaviorReminders();
    }

    expect(behaviorReminderTexts(ctx.agent)).toHaveLength(0);
  });

  it('the post-compaction copy re-arms the interval counter', async () => {
    const ctx = testAgent({
      initialConfig: { providers: {}, behaviorReminders: { intervalTurns: 1 } },
    });
    ctx.configure();

    await ctx.agent.injection.injectAfterCompaction();
    expect(behaviorReminderTexts(ctx.agent)).toHaveLength(1);

    // intervalTurns: 1 would fire on any assistant message — but none has
    // happened since the reminder, so the boundary stays quiet.
    ctx.agent.injection.injectBehaviorReminders();
    expect(behaviorReminderTexts(ctx.agent)).toHaveLength(1);
  });
});

describe('BehaviorRemindersInjector — disabled is a strict no-op', () => {
  it('appends nothing on any path when enabled = false', async () => {
    const ctx = testAgent({
      initialConfig: { providers: {}, behaviorReminders: { enabled: false, intervalTurns: 1 } },
    });
    ctx.configure();

    await ctx.agent.injection.injectAfterCompaction();
    ctx.appendAssistantText(1, 'step one');
    ctx.appendAssistantText(2, 'step two');
    ctx.agent.injection.injectBehaviorReminders();

    expect(behaviorReminderTexts(ctx.agent)).toHaveLength(0);
    // Zero behavior change means zero appended messages of any kind here: the
    // only history entries are the harness user/assistant exchanges.
    expect(
      ctx.agent.context.history.filter((message) => message.origin?.kind === 'injection'),
    ).toHaveLength(0);
  });
});

describe('BehaviorRemindersInjector — undo self-heal (history is the ledger)', () => {
  it('re-derives the interval count from surviving history after an undo', () => {
    const ctx = testAgent({
      initialConfig: { providers: {}, behaviorReminders: { intervalTurns: 2 } },
    });
    ctx.configure();

    // Two exchanges → first reminder.
    ctx.appendAssistantText(1, 'step one');
    ctx.appendAssistantText(2, 'step two');
    ctx.agent.injection.injectBehaviorReminders();
    expect(behaviorReminderTexts(ctx.agent)).toHaveLength(1);

    // Two more exchanges → second reminder.
    ctx.appendAssistantText(3, 'step three');
    ctx.appendAssistantText(4, 'step four');
    ctx.agent.injection.injectBehaviorReminders();
    expect(behaviorReminderTexts(ctx.agent)).toHaveLength(2);

    // One more exchange: 1 assistant message since the last reminder (< 2).
    ctx.appendAssistantText(5, 'step five');
    ctx.agent.injection.injectBehaviorReminders();
    expect(behaviorReminderTexts(ctx.agent)).toHaveLength(2);

    // Undo the last prompt: the exchange is removed while the (injection-origin)
    // reminder survives, so the ledger count shrinks back to 0.
    ctx.agent.context.undo(1);
    ctx.agent.injection.injectBehaviorReminders();
    expect(behaviorReminderTexts(ctx.agent)).toHaveLength(2);

    // One fresh exchange is NOT enough to re-fire — the undone message no
    // longer counts. The interval must re-accumulate from surviving history.
    ctx.appendAssistantText(6, 'step six');
    ctx.agent.injection.injectBehaviorReminders();
    expect(behaviorReminderTexts(ctx.agent)).toHaveLength(2);

    ctx.appendAssistantText(7, 'step seven');
    ctx.agent.injection.injectBehaviorReminders();
    expect(behaviorReminderTexts(ctx.agent)).toHaveLength(3);
  });
});

describe('BehaviorRemindersInjector — prefix-shape and section cooperation', () => {  it('never touches the system prompt (systemHash stays put) or the append bus', async () => {
    const ctx = testAgent({
      initialConfig: { providers: {}, behaviorReminders: { intervalTurns: 1 } },
    });
    ctx.configure();
    const systemPromptBefore = ctx.agent.config.systemPrompt;

    await ctx.agent.injection.injectAfterCompaction();
    ctx.appendAssistantText(1, 'step one');
    ctx.agent.injection.injectBehaviorReminders();

    expect(behaviorReminderTexts(ctx.agent).length).toBeGreaterThan(0);
    // The system prompt bytes are untouched — dynamic injection rides the
    // history tail, so prefix-shape attribution sees no `system` drift.
    expect(ctx.agent.config.systemPrompt).toBe(systemPromptBefore);
    // … and nothing went through the sectioned assembly's append bus.
    expect(ctx.agent.systemPromptSections.addendaCount).toBe(0);
    // The reminder is a history-tail user message with an `injection` origin.
    const tail = ctx.agent.context.history.at(-1);
    expect(tail?.role).toBe('user');
    expect(tail?.origin).toEqual({ kind: 'injection', variant: BEHAVIOR_REMINDERS_VARIANT });
  });
});
