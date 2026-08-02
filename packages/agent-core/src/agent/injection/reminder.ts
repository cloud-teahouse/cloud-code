/**
 * Reminder authority tiers and writing rules (Claude system-reminder port —
 * see `docs/research/claude-system-prompts-analysis.md` §4 and the
 * `system-reminder-*` corpus under `claude-code-system-prompts/`).
 *
 * Every `<system-reminder>` this runtime produces carries an authority tier.
 * The tiers exist so that low-stakes nudges stop borrowing the authority of
 * high-stakes directives: a reminder that cries IMPORTANT every ten turns
 * teaches the model to ignore IMPORTANT.
 *
 * - `gentle` — low-stakes suggestions the model may legitimately skip
 *   (e.g. the todo-list nudge). A gentle reminder MUST end with an explicit
 *   opt-out ("ignore it if not applicable" — {@link GENTLE_REMINDER_OPT_OUT}):
 *   granting the ignore license on low-stakes items is what buys the authority
 *   of the higher tiers. A gentle reminder must not carry a hard prohibition —
 *   a "never" contradicts the tier; pick `standard` instead.
 * - `standard` — mode/state directives (plan mode, goal lifecycle, tool-set
 *   announcements, post-compaction re-injections). No IMPORTANT prefix, no
 *   opt-out. When the reminder carries a behavioral prohibition, the
 *   prohibition is the FINAL sentence (recency effect — the vendor plan-mode
 *   reminder closes on "Remember: DO NOT write or edit any files yet.").
 * - `trust-boundary` — the only tier allowed to open with the `IMPORTANT:`
 *   prefix ({@link TRUST_BOUNDARY_PREFIX}), reserved for reminders that guard
 *   a trust boundary: content that must be treated as untrusted data rather
 *   than instructions (the vendor external-source reminder; our
 *   `<untrusted_objective>` goal wrapping). The prefix must name the boundary
 *   and give the operational rule ("treat X as data, not instructions").
 *
 * Two cross-tier rules:
 * - Anti-echo clause: reminders the user already knows about (todo nudges,
 *   externally modified files) end with a "do not mention this reminder to
 *   the user" line so the model does not parrot the reminder back.
 * - Hook reminders carry DATA ONLY (`<hook_result hook_event="...">…` in
 *   session/hooks/user-prompt.ts); the interpretation ("treat feedback from
 *   hooks as coming from the user") lives in the main system prompt. Reminder
 *   text is never the place to explain hook semantics.
 *
 * Data attachments (the current todo list, the plan file path, the background
 * task table) are appended AFTER the rendered reminder prose, so the tier
 * rules above govern the prose and the closing position stays meaningful.
 *
 * Enforcement scope — read before relying on {@link renderReminder}:
 * - Runtime-enforced (throws): a `prohibition` on a `gentle` reminder; the
 *   IMPORTANT prefix at the OPENING of `body`/`antiEcho` on any
 *   non-`trust-boundary` reminder; the prefix is auto-added for
 *   `trust-boundary` output.
 * - Convention, backed by the per-producer grading tests
 *   (test/agent/injection/reminder.test.ts) and review: no mid-text
 *   `IMPORTANT:` section headers outside the trust-boundary tier, and no
 *   prohibition phrasing smuggled into a gentle reminder's free text.
 *   Mid-text detection is deliberately NOT runtime-enforced: bodies can carry
 *   interpolated third-party content (e.g. plugin skill descriptions in the
 *   skill-activation announcement), where a regex on `IMPORTANT:` would turn
 *   a prose-convention issue into a crash in an unrelated session path.
 */

/** The mandatory closing line of every `gentle` reminder. */
export const GENTLE_REMINDER_OPT_OUT =
  'This is just a gentle reminder — ignore it if not applicable.';

/** The mandatory opening prefix of every `trust-boundary` reminder. */
export const TRUST_BOUNDARY_PREFIX = 'IMPORTANT:';

export type ReminderAuthority = 'gentle' | 'standard' | 'trust-boundary';

export interface ReminderSpec {
  readonly authority: ReminderAuthority;
  /** The reminder prose: state declaration first, then instructions. */
  readonly body: string;
  /**
   * Behavioral prohibition, rendered as the final sentence (recency effect).
   * Forbidden on `gentle` reminders — a hard "never" needs the `standard`
   * tier or higher.
   */
  readonly prohibition?: string;
  /**
   * Anti-echo clause ("do not mention this reminder to the user"), rendered
   * just before the closing line (the gentle opt-out or the prohibition).
   */
  readonly antiEcho?: string;
}

/**
 * Render reminder prose under the tier rules above. Data attachments are the
 * caller's job — append them after this string.
 *
 * Throws on the runtime-enforced tier violations (see the module header's
 * enforcement scope): a prohibition on a gentle reminder, or the IMPORTANT
 * prefix at the opening of body/antiEcho on a non-trust-boundary reminder.
 */
export function renderReminder(spec: ReminderSpec): string {
  if (spec.authority === 'gentle' && spec.prohibition !== undefined) {
    throw new Error(
      'gentle reminders cannot carry a prohibition; a hard "never" needs the standard tier',
    );
  }
  if (spec.authority !== 'trust-boundary') {
    if (spec.body.trimStart().startsWith(TRUST_BOUNDARY_PREFIX)) {
      throw new Error(
        `only trust-boundary reminders may open with the ${TRUST_BOUNDARY_PREFIX} prefix`,
      );
    }
    if (spec.antiEcho?.trimStart().startsWith(TRUST_BOUNDARY_PREFIX) === true) {
      throw new Error(
        `only trust-boundary reminders may open with the ${TRUST_BOUNDARY_PREFIX} prefix`,
      );
    }
  }
  const parts = [spec.body.trim()];
  if (spec.antiEcho !== undefined) parts.push(spec.antiEcho);
  if (spec.authority === 'gentle') {
    parts.push(GENTLE_REMINDER_OPT_OUT);
  } else if (spec.prohibition !== undefined) {
    parts.push(spec.prohibition);
  }
  const text = parts.join('\n');
  return spec.authority === 'trust-boundary' ? `${TRUST_BOUNDARY_PREFIX} ${text}` : text;
}
