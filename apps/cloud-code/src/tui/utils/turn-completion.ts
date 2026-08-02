/**
 * Turn completion line ("✻ Cogitated for 10s") — a quiet gray one-liner
 * appended to the transcript flow when a turn (or a long task node such as
 * compaction) completes successfully. Verbs come from the active locale
 * (`session.turn.completionVerbs`, comma-separated past-tense set) so the
 * line reads naturally in both English and Chinese.
 */

import { t } from '../i18n';

/**
 * Leading glyphs for the completion line, ported from Claude Code's
 * Ghostty-safe spinner set — all render at a consistent width/offset in
 * every terminal the TUI supports.
 */
export const TURN_COMPLETION_SYMBOLS = ['✢', '✳', '✶', '✻', '✽', '✦'] as const;

export function pickTurnCompletionSymbol(random: () => number = Math.random): string {
  const symbol = TURN_COMPLETION_SYMBOLS[Math.floor(random() * TURN_COMPLETION_SYMBOLS.length)];
  return symbol ?? TURN_COMPLETION_SYMBOLS[0];
}

export function pickTurnCompletionVerb(random: () => number = Math.random): string {
  const verbs = t('session.turn.completionVerbs')
    .split(',')
    .map((verb) => verb.trim())
    .filter((verb) => verb.length > 0);
  if (verbs.length === 0) return t('session.turn.completionVerbFallback');
  return verbs[Math.floor(random() * verbs.length)] ?? verbs[0]!;
}

export function formatTurnDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return t('session.turn.durationSeconds', { seconds: totalSeconds });
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return t('session.turn.durationMinutes', { minutes, seconds });
}

/**
 * Full completion-line body: a random symbol, a random locale verb, and the
 * elapsed duration in the locale's word order ("✻ Cogitated for 10s" /
 * "✻ 捣鼓了 10 秒").
 */
export function formatTurnCompletionLine(
  durationMs: number,
  random: () => number = Math.random,
): string {
  const body = t('session.turn.completed', {
    verb: pickTurnCompletionVerb(random),
    duration: formatTurnDuration(durationMs),
  });
  return `${pickTurnCompletionSymbol(random)} ${body}`;
}

/**
 * Countdown text for the rate-limit pause line: mm:ss with both
 * fields zero-padded, rounding UP so the display never promises a resume
 * earlier than the parked timer (e.g. 90.2s → "01:31", 45s → "00:45").
 */
export function formatCountdownMmSs(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
