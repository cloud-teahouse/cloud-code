/**
 * Box primitive — the framed level of the two-level chrome system: the one
 * sanctioned rounded box (╭─╮│╰─╯) in the `border` token (`borderFocus` on
 * focused surfaces), with uniform interior padding and an optional title
 * embedded in the top border.
 *
 * A pure line builder in the `build*TabLines` style (not a Component, no
 * input handling): pre-composed content lines in, framed lines out.
 *
 * Narrow degradation: when `width` cannot fit the frame plus a single
 * content column, the box collapses to the truncated title followed by the
 * truncated content lines — no half-drawn borders.
 */

import { truncateToWidth, visibleWidth } from '@cloud-code/pi-tui';

import { padEndVisible } from '#/tui/i18n/pad-visible';
import type { ColorToken } from '#/tui/theme';

import { styleText } from './text';

export interface BoxOptions {
  /** Total width including margin and borders; defaults to the natural
   * width (widest content line or title, plus padding and borders). */
  readonly width?: number;
  /** Title embedded in the top border (`╭Title───╮`); truncated to fit. */
  readonly title?: string;
  /** Border and title token; defaults to 'border' ('borderFocus' when
   * `focused`). */
  readonly token?: ColorToken;
  readonly focused?: boolean;
  /** Interior horizontal padding per side; defaults to 1. */
  readonly padding?: number;
  /** Left margin in spaces; defaults to 0. */
  readonly margin?: number;
  /** When true with an explicit `width`, the box always spans the full width
   * instead of hugging the natural content width — for boxes whose frame is
   * pinned to the render width (e.g. the transcript plan box). */
  readonly fill?: boolean;
  /** Ellipsis for clipped content lines; defaults to '…'. */
  readonly ellipsis?: string;
}

export function renderBox(lines: readonly string[], options?: BoxOptions): string[] {
  const padding = options?.padding ?? 1;
  const margin = options?.margin ?? 0;
  const token = options?.token ?? (options?.focused === true ? 'borderFocus' : 'border');
  const paint = (s: string): string => styleText(s, token);
  const indent = ' '.repeat(margin);
  const ellipsis = options?.ellipsis ?? '…';

  const natural = Math.max(
    0,
    ...lines.map((line) => visibleWidth(line)),
    ...(options?.title !== undefined ? [visibleWidth(options.title)] : []),
  );
  const width =
    options?.width !== undefined
      ? Math.max(0, options.width)
      : margin + natural + 2 * padding + 2;
  if (width <= 0) return [''];

  const availableInterior = width - margin - 2 - 2 * padding;
  if (availableInterior < 1) {
    const titleLine =
      options?.title !== undefined ? [truncateToWidth(options.title.trim(), width, '…')] : [];
    return [...titleLine, ...lines.map((line) => truncateToWidth(line, width, '…'))];
  }

  const contentWidth =
    options?.fill === true
      ? availableInterior
      : Math.max(1, Math.min(availableInterior, natural));
  const horzLen = contentWidth + 2 * padding;

  const title = truncateToWidth(options?.title ?? '', horzLen, '…');
  const top =
    indent +
    paint('╭') +
    paint(title) +
    paint('─'.repeat(Math.max(0, horzLen - visibleWidth(title)))) +
    paint('╮');
  const bottom = indent + paint('╰' + '─'.repeat(horzLen) + '╯');

  const out: string[] = [top];
  for (const line of lines) {
    const clipped =
      visibleWidth(line) > contentWidth ? truncateToWidth(line, contentWidth, ellipsis) : line;
    out.push(
      indent +
        paint('│') +
        ' '.repeat(padding) +
        padEndVisible(clipped, contentWidth) +
        ' '.repeat(padding) +
        paint('│'),
    );
  }
  out.push(bottom);
  // Constructed to fit; the final clamp only guards callers that combine a
  // large margin with a small width.
  return out.map((line) => truncateToWidth(line, width, '…'));
}
