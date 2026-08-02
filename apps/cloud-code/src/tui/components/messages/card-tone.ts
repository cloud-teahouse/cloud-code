/**
 * Interaction tone for transcript tool cards — the rendering half of the
 * card hover/click contract:
 *
 *   normal: keyboard-only flow; renders byte-identical to the base lines.
 *   hover:  gray detail text turns white (the detail body; the header row
 *           sits below `toneFrom` and keeps its colors).
 *   click:  additionally the card region sits on a gray background block
 *           (from `bgFrom` down, so the leading spacer stays unpainted and
 *           the block reads as separated from surrounding content).
 *
 * The base lines keep their own styling; the tone is a post-process over the
 * rendered output, so hover never rebuilds child components and colored
 * content survives untouched: syntax highlighting and the diff add/remove/
 * gutter colors carry their own SGR sequences, which the dim→white swap does
 * not match. Only the theme's exact `textDim` sequence and `chalk.dim`
 * (SGR 2) runs whiten — which also catches content painted in a color equal
 * to `textDim` (the dark palette's `diffMeta`), by design: it reads as dim
 * detail text.
 */

import chalk from 'chalk';
import { isImageLine, visibleWidth } from '@cloud-code/pi-tui';

import { currentTheme } from '#/tui/theme';

export type CardTone = 'normal' | 'hover' | 'click';

export interface CardToneOptions {
  /** Width the card rendered at; background rows are padded out to it. */
  readonly width: number;
  readonly tone: CardTone;
  /** First line index the gray background covers (the header row). */
  readonly bgFrom: number;
  /** First line index whose gray detail text whitens (the first body row). */
  readonly toneFrom: number;
}

/**
 * Apply the interaction tone to a card's rendered lines. Returns the input
 * array unchanged whenever the tone cannot alter the output (normal tone, or
 * colors disabled), so callers can keep referential stability for the
 * differential renderer.
 */
export function applyCardTone(lines: string[], options: CardToneOptions): string[] {
  const { width, tone, bgFrom, toneFrom } = options;
  if (tone === 'normal' || lines.length === 0) return lines;
  const dimFgOpen = sampledFgOpen('textDim');
  const textFgOpen = sampledFgOpen('text');
  const whiten = textFgOpen.length > 0;
  const paint = tone === 'click' && chalk.level > 0;
  if (!whiten && !paint) return lines;
  const out = lines.slice();
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (whiten && i >= toneFrom) {
      line = brightenDetailLine(line, dimFgOpen, textFgOpen);
    }
    // Padding and background escapes would corrupt an inline image's escape
    // payload, so image rows keep their raw form even inside the block.
    if (paint && i >= bgFrom && !isImageLine(line)) {
      line = paintBackground(line, width);
    }
    out[i] = line;
  }
  return out;
}

/** Pad a row to the card width and wrap it in the gray block background. */
function paintBackground(line: string, width: number): string {
  const pad = ' '.repeat(Math.max(0, width - visibleWidth(line)));
  return currentTheme.bg('userMessageBackground', line + pad);
}

/**
 * The exact SGR open sequence the theme produces for a foreground token,
 * sampled through the theme itself so any palette and any chalk color level
 * (truecolor/256/16/none) is matched verbatim. Empty when colors are off.
 */
function sampledFgOpen(token: 'textDim' | 'text'): string {
  const sentinel = '\u0001';
  const sampled = currentTheme.fg(token, sentinel);
  const index = sampled.indexOf(sentinel);
  return index < 0 ? '' : sampled.slice(0, index);
}

/**
 * Turn a rendered line's gray runs white: the theme's `textDim` foreground
 * (a straight sequence swap — the matching close is the shared SGR 39) and
 * `chalk.dim` segments (SGR 2 … 22). Bold shares the SGR 22 closer with dim,
 * so dim/bold opens are tracked on a stack to pair each close with the
 * attribute it actually ends; chalk reopens the outer style after an inner
 * close, which the stack model absorbs unchanged.
 */
function brightenDetailLine(line: string, dimFgOpen: string, textFgOpen: string): string {
  let out = dimFgOpen.length > 0 ? line.split(dimFgOpen).join(textFgOpen) : line;
  if (!out.includes('\x1b[2m')) return out;
  const stack: ('dim' | 'bold')[] = [];
  const sgr = /\x1b\[[0-9;]*m/g;
  let result = '';
  let last = 0;
  for (let match = sgr.exec(out); match !== null; match = sgr.exec(out)) {
    const seq = match[0];
    result += out.slice(last, match.index);
    if (seq === '\x1b[2m') {
      stack.push('dim');
      result += textFgOpen;
    } else if (seq === '\x1b[1m') {
      stack.push('bold');
      result += seq;
    } else if (seq === '\x1b[22m') {
      result += stack.pop() === 'dim' ? '\x1b[39m' : seq;
    } else {
      if (seq === '\x1b[0m' || seq === '\x1b[m') stack.length = 0;
      result += seq;
    }
    last = match.index + seq.length;
  }
  result += out.slice(last);
  return result;
}
