import type { ContentPart } from '@cloud-code/kosong';

import { parseToolCallArguments } from '../../loop/tool-args-parse';
import type { ExecutableToolOutput, ExecutableToolResult } from '../../loop/types';

import { canonicalArgs } from './canonical-args';

const REMINDER_TEXT_1 =
  '\n\n<system-reminder>\n' +
  'The same tool call has been repeated several times in a row. ' +
  'Before making your next call, write one sentence stating what new information you expect it to produce. ' +
  'Then act on that sentence: if it names something this result does not already give you, choose the action that best provides it; otherwise, continue with the evidence you already have.' +
  '\n</system-reminder>';

function makeReminderText2(repeatCount: number): string {
  return (
    '\n\n<system-reminder>\n' +
    `The same tool call has now been issued ${String(repeatCount)} times in a row. ` +
    'Choose exactly one of the following and state your choice before acting:\n' +
    '(1) Falsification check: run the cheapest test that could conclusively disprove your current approach, if such a test exists.\n' +
    '(2) Missing input: tell the user precisely what information or decision you need to proceed, and ask for it.\n' +
    '(3) Conclude: deliver your best result based on the evidence already gathered, listing anything that remains uncertain.' +
    '\n</system-reminder>'
  );
}

const REMINDER_TEXT_3 =
  '\n\n<system-reminder>\n' +
  'Write your final response now, without any further tool calls. ' +
  'Cover: the current blocker, each approach you have tried and what it established, and the specific information or decision you need from the user to unblock progress. ' +
  'Text only.' +
  '\n</system-reminder>';

const REPEAT_REMINDER_1_START = 3;
const REPEAT_REMINDER_2_START = 5;
const REPEAT_REMINDER_3_START = 8;
const REPEAT_FORCE_STOP_STREAK = 12;

/* ------------------------------------------------------------------ */
/*  Loop guards (B2-2, ported from reasonix applyStormBreaker):       */
/*  three detectors layered on top of same-args dedup.                */
/* ------------------------------------------------------------------ */

/**
 * Same `(tool, normalized error)` outcome this many times in a row rewrites
 * the result into a change-approach directive. Two natural self-corrections
 * are healthy; the third identical failure is a death spiral — the stuck
 * model reworks the *arguments* cosmetically while hitting the same host
 * response, which the same-args ladder above cannot see.
 */
const STORM_BREAK_THRESHOLD = 3;

/**
 * Consecutive steps in which EVERY finalized call was host-blocked
 * (permission deny / approval reject / plan-mode guard / loop guard). The
 * model may rotate tools, reorder batches, or reword arguments and still make
 * zero progress — only a host refusal proves that, so the streak requires
 * blocked outcomes, not plain errors.
 */
const BLOCKED_STREAK_THRESHOLD = 3;

/**
 * Identical write-like successes allowed per turn before the next copy is
 * refused. Two gives the model room for a natural self-correction; the third
 * repeat is usually a no-op write loop.
 */
const REPEAT_SUCCESS_BREAK_THRESHOLD = 2;

/**
 * Write-like builtin tools tracked by the repeat-success guard. Shell-like
 * tools are deliberately excluded (their side effects are too varied for a
 * same-args signature to prove a no-op loop).
 */
const WRITE_LIKE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit']);

/**
 * Marks results produced by this module's own guards. Guard blocks are host
 * refusals (they feed the blocked-turn streak) and already carry a directive,
 * so the reminder ladders must not stack a second nudge on top of them.
 */
const LOOP_GUARD_MARKER = '[loop guard]';

/**
 * Canonical host-block output shapes produced by the permission layer
 * (`agent/permission/index.ts` formatters and the plan-mode guard). Bespoke
 * policy messages (guardian review, free-form hook deny reasons) are
 * deliberately not classified — the streak is a conservative detector.
 *
 * These refusal texts are dual-facing: they are model-facing control
 * signals (they tell the model not to re-attempt) that also render raw in
 * the TUI as ordinary error bodies. Producer and consumer are both
 * agent-core internals, so the English string match stays the contract;
 * localizing them is deferred because the texts embed model instructions
 * and are primarily error-path diagnostics.
 */
const HOST_BLOCK_OUTPUT_PATTERNS: readonly RegExp[] = [
  /^Tool "[^"]+" was not run because /,
  /^Tool "[^"]+" was denied by permission (?:policy|rule)/,
  /^Tool "[^"]+" was denied\./,
  /^Plan mode is active\./,
];

/**
 * True when a tool result's output is a host refusal (permission, plan-mode,
 * or loop-guard block) rather than a plain execution error.
 */
export function isHostBlockOutput(output: string): boolean {
  return (
    output.includes(LOOP_GUARD_MARKER) ||
    HOST_BLOCK_OUTPUT_PATTERNS.some((pattern) => pattern.test(output))
  );
}

const WHITESPACE_RUN = /\s+/g;
const WINDOWS_ABS_PATH = /[A-Za-z]:\\[^\s"'`:]+/g;
const HOME_PATH = /~\/[^\s"'`]+/g;
const POSIX_ABS_PATH = /(?<![\w.@%:+-])\/(?:[\w.@%:+-]+\/?)+/g;
const HEX_NUMBER = /\b0x[0-9a-fA-F]+\b/g;
const DECIMAL_NUMBER = /\b\d+(?:\.\d+)+\b/g;
const INTEGER = /\b\d+\b/g;

/**
 * Normalize an error/blocker message into a stable signature: whitespace
 * collapsed, absolute paths and numbers replaced by placeholders. Two
 * failures that differ only in volatile parts (file names, line numbers,
 * pids, sizes) map to the same signature, so a model retrying with reworded
 * arguments still registers as the same outcome.
 */
export function normalizeErrorSignature(text: string): string {
  return text
    .replace(WHITESPACE_RUN, ' ')
    .replace(WINDOWS_ABS_PATH, '<path>')
    .replace(HOME_PATH, '<path>')
    .replace(POSIX_ABS_PATH, '<path>')
    .replace(HEX_NUMBER, '<n>')
    .replace(DECIMAL_NUMBER, '<n>')
    .replace(INTEGER, '<n>')
    .trim();
}

const STORM_BLOCKED_ADVICE =
  'Change approach: do not keep retrying a blocked tool by changing the tool, command, or arguments. ' +
  'Respect the permission, plan-mode, hook, or loop-guard blocker; use an already-allowed tool, ' +
  'ask the user for the specific approval or choice if appropriate, or explain the blocker in your final answer.';

const STORM_FAILED_ADVICE =
  'Change approach: if an argument is being truncated, write less in one call and split the work into ' +
  'several smaller calls; otherwise fix the arguments, use a different tool, or explain the blocker in your final answer.';

function makeStormReminderText(toolName: string, count: number, blocked: boolean): string {
  const action = blocked ? 'been blocked or failed' : 'failed';
  const advice = blocked ? STORM_BLOCKED_ADVICE : STORM_FAILED_ADVICE;
  return (
    '\n\n<system-reminder>\n' +
    `${LOOP_GUARD_MARKER} "${toolName}" has now ${action} ${String(count)} times in a row with the same host response. ` +
    'Re-sending it — even with the wording changed — will not help: the calls keep hitting the same outcome. ' +
    advice +
    '\n</system-reminder>'
  );
}

function makeBlockedStreakText(streak: number): string {
  return (
    '\n\n<system-reminder>\n' +
    `${LOOP_GUARD_MARKER} every tool call in the last ${String(streak)} steps has been blocked by the host ` +
    '(permission, plan mode, hook, or loop guard). Switching tools, reordering calls, or rewording arguments ' +
    `will not help while the blockers stand. ${STORM_BLOCKED_ADVICE}` +
    '\n</system-reminder>'
  );
}

function makeRepeatSuccessBlockText(toolName: string, count: number): string {
  return (
    `${LOOP_GUARD_MARKER} "${toolName}" has already succeeded ${String(count)} times with the same ` +
    'write arguments in this turn. Re-running it is unlikely to help and may burn tokens or repeat file writes. ' +
    'Change approach: use Edit for incremental file changes, verify with a read or test command, ' +
    'or explain the blocker in your final answer.'
  );
}

function outputText(output: ExecutableToolOutput): string {
  if (typeof output === 'string') return output;
  return output
    .filter((part): part is Extract<(typeof output)[number], { type: 'text' }> => {
      return typeof part === 'object' && part !== null && part.type === 'text';
    })
    .map((part) => part.text)
    .join('\n');
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeKey(toolName: string, args: unknown): string {
  return `${toolName} ${canonicalArgs(args)}`;
}

function appendReminder(result: ExecutableToolResult, reminderText: string): ExecutableToolResult {
  const output = result.output;
  let newOutput: string | ContentPart[];
  if (typeof output === 'string') {
    newOutput = output + reminderText;
  } else {
    const arr: ContentPart[] = [...output];
    const last = arr.at(-1);
    if (last !== undefined && last.type === 'text') {
      arr[arr.length - 1] = { type: 'text', text: last.text + reminderText };
    } else {
      arr.push({ type: 'text', text: reminderText });
    }
    newOutput = arr;
  }
  return result.isError === true
    ? { ...result, output: newOutput, isError: true }
    : { ...result, output: newOutput };
}

function forceStopResult(
  result: ExecutableToolResult,
  reminderText: string,
): ExecutableToolResult {
  const withReminder = appendReminder(result, reminderText);
  return { ...withReminder, stopTurn: true };
}

/**
 * Placeholder result returned from `checkSameStep` for a duplicate call. Never
 * reaches the model — it is replaced in `finalizeResult` by awaiting the
 * original's deferred result. The loop dispatches `tool.result` events using
 * the finalized value, so this content is purely internal bookkeeping.
 *
 * It must be a non-error result so `toolResultStopsTurn` in tool-call.ts does
 * not short-circuit the batch on the dup's behalf.
 */
const DEDUP_PLACEHOLDER_RESULT: ExecutableToolResult = { output: '' };

/**
 * Detects and suppresses repetitive tool calls within a single turn.
 *
 * Two behaviours are layered:
 * - Same-step dedup: a duplicate `(toolName, args)` issued in the same LLM step
 *   reuses the original call's result instead of executing the tool twice.
 * - Cross-step dedup: when the exact same call is repeated consecutively
 *   across steps, the result returned to the model is suffixed with a system
 *   reminder once the streak hits 3. The reminder escalates as the streak
 *   grows: r1 (expectation-setting nudge) from streak 3, r2 (forced decision
 *   menu) from streak 5, r3 (final hand-off instruction) from streak 8. From streak 12
 *   onward the turn is force-stopped via `{ stopTurn: true }` so the loop
 *   cannot keep spinning on the same call. Force-stop does not flip a
 *   successful tool result into an error — the underlying tool's `isError`
 *   is preserved.
 *
 * Three loop guards (B2-2) layer on top of the same-args ladder, each keyed
 * on something the ladder cannot see:
 * - Storm signature: consecutive `(tool, normalizedError)` outcomes. A stuck
 *   model rewrites arguments while hitting the same host response; at
 *   {@link STORM_BREAK_THRESHOLD} the result is rewritten into a
 *   change-approach directive. Yields to the same-args ladder when that
 *   already fired for the call (no stacked reminders).
 * - Blocked-turn streak: consecutive steps in which every finalized call was
 *   host-blocked (permission deny, approval reject, plan-mode guard, loop
 *   guard). At {@link BLOCKED_STREAK_THRESHOLD} a notice is appended to the
 *   next finalized result. Any non-blocked call resets the streak.
 * - Repeat success: identical write-like (`Write`/`Edit`) successes. After
 *   {@link REPEAT_SUCCESS_BREAK_THRESHOLD} copies the next identical write is
 *   refused at prepare time with a loop-guard block (execution skipped).
 *
 * All guard state is per-turn: the owning turn creates a fresh deduplicator
 * per `runStepLoop`.
 */
export class ToolCallDeduplicator {
  private stepDeferreds = new Map<string, Deferred<ExecutableToolResult>>();
  private stepCalls: string[] = [];
  private originalCallIndex = new Map<string, number>();
  private syntheticCallIds = new Set<string>();
  /**
   * Records the dedup key used at `checkSameStep` time, keyed by `toolCallId`.
   * The loop is allowed to rewrite args between `prepareToolExecution` and
   * `finalizeToolResult` via `PrepareToolExecutionResult.updatedArgs`, so the
   * `(toolName, args)` pair available at finalize may differ from what was
   * registered. We pin the key at registration time and look it up by call id
   * during finalize.
   */
  private callKeyByCallId = new Map<string, string>();
  private consecutiveKey: string | null = null;
  private consecutiveCount = 0;
  /** (a) storm signature: consecutive `(tool, normalizedError)` outcomes. */
  private stormKey: string | null = null;
  private stormCount = 0;
  /** (b) per-step host-block outcomes, in finalize order; consumed by `endStep`. */
  private stepOutcomeBlocked: boolean[] = [];
  private stepBlockedByKey = new Map<string, boolean>();
  private blockedStreak = 0;
  /** Whole-step guard notices drained onto the next finalized result. */
  private pendingNotices: string[] = [];
  /** (c) executed write-like successes this turn, keyed by `(tool, args)`. */
  private readonly repeatSuccessCounts = new Map<string, number>();

  beginStep(): void {
    for (const deferred of this.stepDeferreds.values()) {
      deferred.resolve({
        output: 'Tool call deduplicated but original result was lost',
        isError: true,
      });
    }
    this.stepDeferreds.clear();
    this.stepCalls = [];
    this.originalCallIndex.clear();
    this.syntheticCallIds.clear();
    this.callKeyByCallId.clear();
  }

  endStep(): void {
    for (const key of this.stepCalls) {
      if (key === this.consecutiveKey) {
        this.consecutiveCount += 1;
      } else {
        this.consecutiveKey = key;
        this.consecutiveCount = 1;
      }
    }

    // (b) blocked-turn streak: a step counts only when every finalized call
    // was host-blocked; any success or plain error resets it.
    const outcomes = this.stepOutcomeBlocked;
    this.stepOutcomeBlocked = [];
    this.stepBlockedByKey.clear();
    if (outcomes.length > 0 && outcomes.every(Boolean)) {
      this.blockedStreak += 1;
      if (this.blockedStreak >= BLOCKED_STREAK_THRESHOLD) {
        this.pendingNotices.push(makeBlockedStreakText(this.blockedStreak));
      }
    } else {
      this.blockedStreak = 0;
    }
  }

  /**
   * Called from `prepareToolExecution`. If this `(toolName, args)` was already
   * seen in the current step, returns a placeholder result so the loop can
   * skip executing the tool again; the real result is patched in during
   * `finalizeResult`. Returns `null` for the first occurrence so the normal
   * execution path proceeds.
   *
   * This method is intentionally synchronous to avoid deadlocking the prepare
   * loop on a deferred that only resolves in the finalize phase.
   */
  checkSameStep(toolCallId: string, toolName: string, args: unknown): ExecutableToolResult | null {
    const key = makeKey(toolName, args);
    const index = this.stepCalls.length;
    this.stepCalls.push(key);
    this.callKeyByCallId.set(toolCallId, key);

    const existing = this.stepDeferreds.get(key);
    if (existing !== undefined) {
      this.syntheticCallIds.add(toolCallId);
      return DEDUP_PLACEHOLDER_RESULT;
    }
    this.stepDeferreds.set(key, makeDeferred<ExecutableToolResult>());
    this.originalCallIndex.set(toolCallId, index);

    // (c) repeat-success guard: refuse the Nth identical write-like call once
    // it has already succeeded enough times this turn. Returning a result
    // here makes the loop skip execution (synthetic result); the text carries
    // the loop-guard marker so finalize treats it as a host block without
    // stacking more reminders on it.
    if (WRITE_LIKE_TOOLS.has(toolName)) {
      const succeeded = this.repeatSuccessCounts.get(key) ?? 0;
      if (succeeded >= REPEAT_SUCCESS_BREAK_THRESHOLD) {
        return { output: makeRepeatSuccessBlockText(toolName, succeeded), isError: true };
      }
    }
    return null;
  }

  /**
   * Register a call that bypassed `prepareToolExecution` — e.g. args
   * validation rejected it in preflight, so the prepare hook never ran. Must
   * be called before `finalizeResult` for such calls, otherwise the repeat
   * circuit breaker never counts rejected calls and the model can re-issue
   * the same invalid call without ever tripping the streak. No-op when the
   * call was already registered through the normal prepare path.
   *
   * `rawArguments` is the provider's raw arguments string. Args that failed
   * JSON parsing were normalized to `{}` by the loop, which would key every
   * malformed-but-different attempt identically; those are keyed on the raw
   * text so only true re-issues count as repeats.
   */
  registerSkipped(
    toolCallId: string,
    toolName: string,
    args: unknown,
    rawArguments?: string | null,
  ): void {
    if (this.callKeyByCallId.has(toolCallId)) return;
    const keyArgs =
      rawArguments !== undefined &&
      rawArguments !== null &&
      parseToolCallArguments(rawArguments).parseFailed
        ? rawArguments
        : args;
    this.checkSameStep(toolCallId, toolName, keyArgs);
  }

  /**
   * Called from `finalizeToolResult`, in provider order. For first-occurrence
   * calls, projects the consecutive streak ending at this call and, if the
   * threshold is reached, appends the system reminder, then resolves the
   * deferred so subsequent same-step dups can fetch the real result. For
   * synthetic duplicates, awaits the original's deferred and returns its
   * value, discarding the placeholder.
   */
  async finalizeResult(
    toolCallId: string,
    toolName: string,
    args: unknown,
    result: ExecutableToolResult,
  ): Promise<ExecutableToolResult> {
    // Use the key recorded at registration time, NOT a fresh key from the args
    // passed here — the loop may have rewritten args via updatedArgs.
    const key = this.callKeyByCallId.get(toolCallId);
    if (key === undefined) return result;
    this.callKeyByCallId.delete(toolCallId);

    if (this.syntheticCallIds.delete(toolCallId)) {
      const deferred = this.stepDeferreds.get(key);
      if (deferred === undefined) return result;
      const resolved = await deferred.promise;
      // Same-step dups share the original's outcome class for the
      // blocked-turn streak (the original finalizes first, in provider order).
      const blocked =
        this.stepBlockedByKey.get(key) ??
        (resolved.isError === true && isHostBlockOutput(outputText(resolved.output)));
      this.stepOutcomeBlocked.push(blocked);
      return resolved;
    }
    const index = this.originalCallIndex.get(toolCallId);
    if (index === undefined) return result;
    this.originalCallIndex.delete(toolCallId);

    let lastKey = this.consecutiveKey;
    let streak = this.consecutiveCount;
    for (let i = 0; i <= index; i += 1) {
      const k = this.stepCalls[i]!;
      if (k === lastKey) {
        streak += 1;
      } else {
        lastKey = k;
        streak = 1;
      }
    }

    const rawText = outputText(result.output);
    const succeeded = result.isError !== true;
    const isLoopGuardBlock = !succeeded && rawText.includes(LOOP_GUARD_MARKER);

    // (c) repeat-success accounting: each executed write-like success counts
    // once; prepare-time refusals never reach here as successes.
    if (succeeded && WRITE_LIKE_TOOLS.has(toolName)) {
      this.repeatSuccessCounts.set(key, (this.repeatSuccessCounts.get(key) ?? 0) + 1);
    }

    let finalResult = result;
    let action: 'none' | 'r1' | 'r2' | 'r3' | 'stop' = 'none';
    if (isLoopGuardBlock) {
      // Guard-produced results already carry a directive — the same-args
      // ladder must not stack a second reminder on top of them.
    } else if (streak >= REPEAT_FORCE_STOP_STREAK) {
      finalResult = forceStopResult(result, REMINDER_TEXT_3);
      action = 'stop';
    } else if (streak >= REPEAT_REMINDER_3_START) {
      finalResult = appendReminder(result, REMINDER_TEXT_3);
      action = 'r3';
    } else if (streak >= REPEAT_REMINDER_2_START) {
      finalResult = appendReminder(result, makeReminderText2(streak));
      action = 'r2';
    } else if (streak >= REPEAT_REMINDER_1_START) {
      finalResult = appendReminder(result, REMINDER_TEXT_1);
      action = 'r1';
    }

    // (a) storm signature: any success resets; identical normalized failures
    // accumulate. The rewrite yields to the same-args ladder (above) so a
    // call never carries two reminders.
    if (succeeded) {
      this.stormKey = null;
      this.stormCount = 0;
    } else {
      const sig = `${toolName} ${normalizeErrorSignature(rawText)}`;
      if (sig === this.stormKey) {
        this.stormCount += 1;
      } else {
        this.stormKey = sig;
        this.stormCount = 1;
      }
      if (this.stormCount >= STORM_BREAK_THRESHOLD && action === 'none' && !isLoopGuardBlock) {
        finalResult = appendReminder(
          result,
          makeStormReminderText(toolName, this.stormCount, isHostBlockOutput(rawText)),
        );
      }
    }

    // (b) blocked-turn streak accounting (per-call outcome; the step verdict
    // is computed in endStep).
    const blocked = !succeeded && isHostBlockOutput(rawText);
    this.stepBlockedByKey.set(key, blocked);
    this.stepOutcomeBlocked.push(blocked);

    // Drain whole-step guard notices onto the first finalized call of the
    // step (provider order), before same-step dups resolve from the deferred.
    if (this.pendingNotices.length > 0) {
      finalResult = appendReminder(finalResult, this.pendingNotices.join(''));
      this.pendingNotices = [];
    }

    this.stepDeferreds.get(key)?.resolve(finalResult);
    return finalResult;
  }
}

export const __testing = {
  REMINDER_TEXT_1,
  REMINDER_TEXT_3,
  makeReminderText2,
  REPEAT_REMINDER_1_START,
  REPEAT_REMINDER_2_START,
  REPEAT_REMINDER_3_START,
  REPEAT_FORCE_STOP_STREAK,
  STORM_BREAK_THRESHOLD,
  BLOCKED_STREAK_THRESHOLD,
  REPEAT_SUCCESS_BREAK_THRESHOLD,
  WRITE_LIKE_TOOLS,
  LOOP_GUARD_MARKER,
  makeStormReminderText,
  makeBlockedStreakText,
  makeRepeatSuccessBlockText,
};
