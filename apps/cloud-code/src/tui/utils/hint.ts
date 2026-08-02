/**
 * Shared key-hint wrapping for dialog headers.
 *
 * Dialog hint lines are composed of short segments joined by a separator
 * ("↑↓ navigate · Enter select · Esc cancel"). Rendering them as a single
 * line hard-truncates the tail at narrow terminal widths, silently dropping
 * segments — exactly the ones (manage keys, cancel) a user needs to
 * discover. This helper wraps the segments onto as many lines as needed,
 * breaking only at segment boundaries so no segment is ever split
 * mid-token. A single segment wider than the line is the one case that
 * still hard-truncates (there is no good break point inside a token).
 *
 * Wrapping (rather than dropping lower-priority segments) is the chosen
 * strategy: every advertised key stays discoverable, and all dialogs share
 * one code path instead of each owning a priority table.
 */

import { truncateToWidth, visibleWidth } from '@cloud-code/pi-tui';

/** Separator between hint segments; also the wrap break point. */
export const HINT_SEPARATOR = ' · ';

/**
 * Joins `parts` with `separator`, greedily wrapping onto multiple lines so
 * no line exceeds `width` visible columns. Returns at least one line.
 * Wide characters (e.g. zh-CN) count double via visibleWidth.
 */
export function wrapHint(
  parts: readonly string[],
  width: number,
  separator: string = HINT_SEPARATOR,
): string[] {
  const budget = Math.max(1, width);
  const lines: string[] = [];
  let current = '';
  for (const raw of parts) {
    if (raw.length === 0) continue;
    const part = visibleWidth(raw) <= budget ? raw : truncateToWidth(raw, budget, '…');
    const candidate = current.length === 0 ? part : current + separator + part;
    if (visibleWidth(candidate) <= budget) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = part;
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

/**
 * The already-joined counterpart of {@link wrapHint}: splits `text` on the
 * separator and re-wraps the segments. For hint strings composed upstream
 * (e.g. an i18n message with interpolated pieces).
 */
export function wrapHintText(
  text: string,
  width: number,
  separator: string = HINT_SEPARATOR,
): string[] {
  return wrapHint(text.split(separator), width, separator);
}
