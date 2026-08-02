/**
 * Resume continuation reminder (modeled on Claude Code's "Continue from
 * where you left off" interrupted-turn injection). Appended to the context once per interrupted resume, when
 * the wire log shows the trailing turn never finished — the process died
 * mid-tool (the resume-time close of open tool calls fired) or before the
 * assistant could answer the last prompt.
 *
 * Detection lives in `Agent.resume` (it needs both the context repair result
 * and the turn cancellation trail); this module owns the reminder text and
 * the injection-origin variant used for dedup.
 */

import { renderReminder } from './reminder';

/**
 * Injection-origin variant of the resume continuation reminder. A reminder
 * carrying this variant settles the tail scan (`hasUnansweredTailPrompt`), so
 * a session resumed twice never stacks a second copy.
 */
export const RESUME_CONTINUATION_VARIANT = 'resume_continuation';

/**
 * Standard tier: a state directive about the session's shape — no IMPORTANT
 * prefix, no opt-out. The anti-echo clause keeps the model from parroting the
 * reminder back to the user. The message rides the context sent to the model
 * and is persisted as a normal `context.append_message` record — replay
 * carries it (that persistence is exactly what the dedup scan keys on), and
 * the transcript UI filters `injection`-origin messages at the rendering
 * layer, so the user never sees it in the chat view.
 */
export const RESUME_CONTINUATION_REMINDER = renderReminder({
  authority: 'standard',
  body:
    'The previous turn was interrupted before it finished — the session ended while work was ' +
    'still in progress. Continue from where you left off: pick up the interrupted work directly, ' +
    'without apologizing or recapping what is already done.',
  antiEcho: 'Do not mention this reminder to the user.',
});
