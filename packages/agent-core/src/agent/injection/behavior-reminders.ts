/**
 * BehaviorRemindersInjector — long-conversation behavioral-rule re-injection
 * (Anthropic's `<long_conversation_reminder>` pattern, ported per
 * `docs/research/vendor-prompts-cl4r1t4s.md` §"行为规则运行时重注入").
 *
 * Compaction preserves task state but nothing preserves BEHAVIOR: rules
 * stated once at the top of the system prompt (destructive-action discipline,
 * verify-before-done, language matching, minimal changes) fade over long
 * conversations and across compactions. This injector re-states them as a
 * `<system-reminder>` at the message-stream tail:
 *
 * - after every compaction (forced — the folded history dropped every copy);
 * - at turn boundaries once `intervalTurns` assistant messages have passed
 *   since the last reminder (default 25; `[behavior_reminders]` in
 *   config.toml).
 *
 * Design notes:
 * - Append-only at the history tail, like every dynamic announcement: the
 *   system prompt (and its `systemHash`) is never touched, so the prompt-cache
 *   prefix survives. The mechanism's declaration lives in the static system
 *   prompt instead (`profile/default/system.md`, Context Management), mirroring
 *   how Sonnet 4.5 declares `<long_conversation_reminder>` up front.
 * - The history IS the ledger (same pattern as ToolsDiffInjector): turns are
 *   counted by scanning backwards from the tail, so undo, compaction, and
 *   resume self-heal without any in-memory state.
 * - Not main-only: subagent contexts compact and drift too, and every bundled
 *   profile renders the same declaration.
 * - `enabled = false` is a strict zero-behavior-change escape hatch: no
 *   reminder is appended on any path.
 * - The content restates rules already in the system prompt (standard tier —
 *   see injection/reminder.ts), closing on the destructive-action prohibition
 *   (recency position). It introduces no new obligations.
 */

import type { Agent } from '..';
import type { ContextMessage } from '../context/types';
import { renderReminder } from './reminder';

export const BEHAVIOR_REMINDERS_VARIANT = 'behavior_reminders';

/** Default assistant-message interval between re-injections. */
export const BEHAVIOR_REMINDERS_INTERVAL_TURNS_DEFAULT = 25;

const BEHAVIOR_REMINDERS_TEXT = renderReminder({
  authority: 'standard',
  body: `This conversation has grown long or was just compacted, so key behavioral rules from your system prompt are restated below. Nothing here is new, and nothing here overrides the current system prompt, tool schemas, permission rules, or the user's latest request.

- Verify before declaring done: run the tests and checks that cover your change and look at the results. Never report unverified work as complete.
- Keep writing in the user's language, even after long stretches of English tool output.
- Keep changes minimal and scoped to what was asked; leave unrelated refactors, reformatting, and cleanups alone.`,
  prohibition:
    'Destructive, hard-to-reverse, or outward-facing actions (rm -rf, dropping database ' +
    'tables, killing processes, force-pushing, git reset --hard, amending published commits, ' +
    'pushing, opening or commenting on PRs or issues, sending messages, uploading to ' +
    'third-party services) still require explicit user confirmation first, and git mutations ' +
    '(commit, push, reset, rebase) run only when the user explicitly asked — no matter how ' +
    'long ago those rules were stated.',
});

interface BehaviorRemindersResolution {
  readonly enabled: boolean;
  readonly intervalTurns: number;
}

function resolveBehaviorReminders(agent: Agent): BehaviorRemindersResolution {
  const config = agent.kimiConfig?.behaviorReminders;
  return {
    enabled: config?.enabled ?? true,
    intervalTurns: config?.intervalTurns ?? BEHAVIOR_REMINDERS_INTERVAL_TURNS_DEFAULT,
  };
}

/** Assistant messages since the latest behavior reminder (0 when it is the tail). */
function assistantTurnsSinceLastReminder(history: readonly ContextMessage[]): number {
  let turns = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message === undefined) continue;
    if (
      message.origin?.kind === 'injection' &&
      message.origin.variant === BEHAVIOR_REMINDERS_VARIANT
    ) {
      break;
    }
    if (message.role === 'assistant') turns += 1;
  }
  return turns;
}

export class BehaviorRemindersInjector {
  constructor(protected readonly agent: Agent) {}

  /**
   * Turn-boundary cadence (next to injectGoal/injectToolsDiff): append one
   * reminder once `intervalTurns` assistant messages passed since the last
   * one. Most boundaries append nothing, keeping the prompt cache warm.
   */
  injectAtTurnBoundary(): void {
    const { enabled, intervalTurns } = resolveBehaviorReminders(this.agent);
    if (!enabled) return;
    if (assistantTurnsSinceLastReminder(this.agent.context.history) < intervalTurns) return;
    this.announce();
  }

  /**
   * Post-compaction cadence (forced): the folded history dropped every copy,
   * so a fresh one always goes back in. Skips only when the tail already is
   * the reminder (a back-to-back `injectAfterCompaction` with nothing in
   * between), so the reminder never stacks.
   */
  injectAfterCompaction(): void {
    const { enabled } = resolveBehaviorReminders(this.agent);
    if (!enabled) return;
    const history = this.agent.context.history;
    const tail = history.at(-1);
    if (
      tail?.origin?.kind === 'injection' &&
      tail.origin.variant === BEHAVIOR_REMINDERS_VARIANT
    ) {
      return;
    }
    this.announce();
  }

  private announce(): void {
    this.agent.context.appendSystemReminder(BEHAVIOR_REMINDERS_TEXT, {
      kind: 'injection',
      variant: BEHAVIOR_REMINDERS_VARIANT,
    });
  }
}
