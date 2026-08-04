/**
 * Interaction tone for transcript tool cards — the rendering half of the
 * card hover/click contract:
 *
 *   normal: keyboard-only flow; renders byte-identical to the base lines.
 *   hover:  every gray run in the card turns white, header rows included,
 *           and the diff red/green lift to their Strong variants — the only
 *           state that brightens text. Colored parts (status bullets, tool
 *           names, syntax) keep their tones.
 *   click:  the card region sits on a gray background block (from `bgFrom`
 *           down, so the leading spacer stays unpainted) with the TEXT LEFT
 *           AS-IS — the block marks the expanded state, it is not a
 *           highlight. A click-expanded card under the pointer gets both:
 *           the gray block and the hover whiten.
 *
 * The base lines keep their own styling; the tone is a post-process over the
 * rendered output, so hover never rebuilds child components. The gray family
 * is replaced by sampled theme open sequences (`textDim`/`textMuted` — the
 * diff gutter/meta tokens share those exact hex values and are covered by
 * the same sequences) plus `chalk.dim` (SGR 2) runs, and the diff red/green
 * runs lift to their Strong palette variants so a mostly-diff card still
 * shows a visible hover change. Lines made only from plain text and other
 * inline styles receive the text foreground around their unstyled spans,
 * while nested syntax/link colors remain intact, so every detail row gets a
 * readable hover change without washing its semantic colors away.
 */

import chalk from 'chalk';
import { isImageLine, visibleWidth } from '@cloud-code/pi-tui';

import { currentTheme, type ColorToken } from '#/tui/theme';

export type CardTone = 'normal' | 'hover' | 'click';

export interface CardToneOptions {
  /** Width the card rendered at; background rows are padded out to it. */
  readonly width: number;
  readonly tone: CardTone;
  /** First line index the interaction covers (the leading spacer stays plain). */
  readonly bgFrom: number;
  /**
   * Pointer state, consulted only for the click tone: a click-expanded card
   * whitens its text while hovered (block + whiten), and shows the plain gray
   * block otherwise. Hover tone always whitens regardless of this flag.
   */
  readonly hovered?: boolean;
}

/**
 * Apply the interaction tone to a card's rendered lines. Returns the input
 * array unchanged whenever the tone cannot alter the output (normal tone, or
 * colors disabled), so callers can keep referential stability for the
 * differential renderer.
 */
export function applyCardTone(lines: string[], options: CardToneOptions): string[] {
  const { width, tone, bgFrom } = options;
  if (tone === 'normal' || lines.length === 0) return lines;
  const textFgOpen = sampledFgOpen('text');
  // The gray family whitens; the diff red/green lift to their Strong variants
  // (same-hex tokens like the success bullet share the lift — a subtle raise
  // that reads as one coherent highlight across the card).
  const liftPairs: readonly (readonly [string, string])[] = [
    [sampledFgOpen('textDim'), textFgOpen],
    [sampledFgOpen('textMuted'), textFgOpen],
    [sampledFgOpen('diffAdded'), sampledFgOpen('diffAddedStrong')],
    [sampledFgOpen('diffRemoved'), sampledFgOpen('diffRemovedStrong')],
  ];
  const whiten =
    textFgOpen.length > 0 && (tone === 'hover' || options.hovered === true);
  // Text brightens on hover only — the click block marks expansion, it is
  // not a highlight; a hovered click-expanded card gets both.
  const paint = tone === 'click' && chalk.level > 0;
  if (!whiten && !paint) return lines;
  const out = lines.slice();
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    const image = isImageLine(line);
    // Foreground wrappers, padding, and background escapes would corrupt an
    // inline image's escape payload, so image rows keep their raw form even
    // inside the block.
    if (whiten && i >= bgFrom && !image) {
      line = brightenDetailLine(line, liftPairs, textFgOpen);
    }
    if (paint && i >= bgFrom && !image) {
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
function sampledFgOpen(token: ColorToken): string {
  const sentinel = '\u0001';
  const sampled = currentTheme.fg(token, sentinel);
  const index = sampled.indexOf(sentinel);
  return index < 0 ? '' : sampled.slice(0, index);
}

/**
 * Turn a rendered line's gray runs white and lift the diff red/green: every
 * `from` open sequence swaps to its `to` (straight sequence swaps — the
 * matching close is the shared SGR 39), and `chalk.dim` segments (SGR 2 … 22)
 * take the text foreground. Bold shares the SGR 22 closer with dim, so
 * dim/bold opens are tracked on a stack to pair each close with the
 * attribute it actually ends; chalk reopens the outer style after an inner
 * close, which the stack model absorbs unchanged. If a line has no gray run,
 * its plain spans are wrapped in the text foreground instead, re-opening that
 * foreground after nested color resets.
 */
function brightenDetailLine(
  line: string,
  liftPairs: readonly (readonly [string, string])[],
  textFgOpen: string,
): string {
  let out = line;
  for (const [from, to] of liftPairs) {
    if (from.length > 0) out = out.split(from).join(to);
  }
  if (!out.includes('\x1b[2m')) {
    return out === line ? addHoverForeground(out, textFgOpen) : out;
  }
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

/** Keep inline colors while giving otherwise unstyled spans the hover tone. */
function addHoverForeground(line: string, textFgOpen: string): string {
  if (line.length === 0 || textFgOpen.length === 0) return line;

  const sgr = /\x1b\[[0-9;]*m/g;
  let result = textFgOpen;
  let last = 0;
  for (let match = sgr.exec(line); match !== null; match = sgr.exec(line)) {
    const seq = match[0];
    result += line.slice(last, match.index) + seq;
    if (seq === '\x1b[39m' || seq === '\x1b[0m' || seq === '\x1b[m') {
      result += textFgOpen;
    }
    last = match.index + seq.length;
  }
  result += line.slice(last) + '\x1b[39m';
  return result;
}
