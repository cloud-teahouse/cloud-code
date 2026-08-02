import { visibleWidth } from '@cloud-code/pi-tui';

/**
 * Display-width-aware `String.prototype.padEnd`. Plain `.padEnd()` counts
 * UTF-16 code units, so CJK labels (2 columns each) get under-padded and
 * column alignment drifts; this pads by *visible columns* instead. ANSI
 * escapes in `text` are excluded from the count by `visibleWidth`.
 *
 * Like `padEnd`, strings already at or beyond `width` are returned unchanged
 * (no truncation).
 */
export function padEndVisible(text: string, width: number, fill = ' '): string {
  const padding = width - visibleWidth(text);
  return padding <= 0 ? text : text + fill.repeat(padding);
}
