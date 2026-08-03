/**
 * Summary-style renderers — produce optional inline-glance content for
 * tools whose raw output is high-volume but low-information (Grep,
 * Glob). The numeric summary (line counts, exit codes, sizes) lives in
 * the header chip (see chip.ts), so most tools intentionally render an
 * empty body and only expose details when the global expand toggle is
 * on.
 *
 * Errors always fall through to the truncated renderer so the user
 * sees the actual error message, not a synthetic summary.
 */

import type { Component } from '@cloud-code/pi-tui';
import { Text } from '@cloud-code/pi-tui';

import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';

import { renderTruncated } from './truncated';
import type { ResultRenderer } from './types';

const GLANCE_SAMPLES = 3;

type GlanceFn = (
  toolCall: Parameters<ResultRenderer>[0],
  result: Parameters<ResultRenderer>[1],
) => string;

// Detail body rows render flush left in the shared `textDim` tone; the tree
// gutter wrapper in tool-call.ts owns indentation.
function withGlance(glance: GlanceFn | null): ResultRenderer {
  const renderer: ResultRenderer = (toolCall, result, ctx) => {
    if (result.is_error) return renderTruncated(toolCall, result, ctx);

    const out: Component[] = [];
    if (glance !== null) {
      const line = glance(toolCall, result);
      if (line.length > 0) {
        out.push(new Text(currentTheme.fg('textDim', line), 0, 0));
      }
    }
    if (ctx.expanded && result.output.length > 0) {
      out.push(new Text(currentTheme.fg('textDim', result.output), 0, 0));
    }
    return out;
  };
  // The collapsed body omits the raw output (at most a glance line shows), so
  // any non-error result with output has something for a click to expand into.
  renderer.hidesContentWhenCollapsed = (result) =>
    result.is_error !== true && result.output.length > 0;
  return renderer;
}

function nonEmptyLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split('\n').filter((line) => line.length > 0);
}

// Strip a trailing `:line:col:text` so the glance shows the file path
// only, even when grep is in `content` mode (`src/foo.ts:42:    foo()`).
function pathFromGrepLine(line: string): string {
  const idx = line.indexOf(':');
  if (idx <= 0) return line;
  const second = line.indexOf(':', idx + 1);
  if (second <= 0) return line;
  return line.slice(0, second);
}

const grepGlance: GlanceFn = (_toolCall, result) => {
  const lines = nonEmptyLines(result.output);
  if (lines.length === 0) return '';
  const samples = lines.slice(0, GLANCE_SAMPLES).map(pathFromGrepLine);
  const remaining = lines.length - samples.length;
  const tail = remaining > 0 ? t('messages.summary.more', { count: remaining }) : '';
  return `${samples.join(', ')}${tail}`;
};

const globGlance: GlanceFn = (_toolCall, result) => {
  const lines = nonEmptyLines(result.output);
  if (lines.length === 0) return '';
  const samples = lines.slice(0, GLANCE_SAMPLES);
  const remaining = lines.length - samples.length;
  const tail = remaining > 0 ? t('messages.summary.more', { count: remaining }) : '';
  return `${samples.join(', ')}${tail}`;
};

// ── Exports ──────────────────────────────────────────────────────────

// Tools whose chip already conveys everything — the body is empty in
// the collapsed state and only the raw output appears when expanded.
export const readSummary: ResultRenderer = withGlance(null);
export const fetchSummary: ResultRenderer = withGlance(null);
export const webSearchSummary: ResultRenderer = withGlance(null);
export const thinkSummary: ResultRenderer = withGlance(null);
export const editSummary: ResultRenderer = withGlance(null);
export const writeSummary: ResultRenderer = withGlance(null);

// Tools that benefit from inline path samples below the chip.
export const grepSummary: ResultRenderer = withGlance(grepGlance);
export const globSummary: ResultRenderer = withGlance(globGlance);
