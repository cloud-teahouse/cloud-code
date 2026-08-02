/**
 * Running-title shimmer for in-flight tool calls.
 *
 * A per-character brightness wave sweeps left→right across the title text:
 * each frame a character's foreground lerps between the `textDim` (base) and
 * `textStrong` (peak) theme tokens by its distance from the wavefront, and
 * the peak band renders bold (Claude Code's spinner shimmer, made
 * continuous). Anchoring the base at `textDim` keeps the sweep visible in
 * every palette — dark lifts dim gray toward bright white, light sinks dim
 * gray toward bold near-black, where the old `text` → `textStrong` lerp was
 * a no-op (`text` == `textStrong` in the light palette). The caller advances
 * `frame` on its animation tick and re-renders; while the tool is finished
 * the shimmer is simply not applied, so a completed title freezes with no
 * per-frame cost. Palette reads go through `currentTheme` at call time, so a
 * theme switch is picked up on the next frame.
 */

import chalk from 'chalk';

import { currentTheme } from '#/tui/theme';

/** Reach of the bright band to either side of the wavefront, in characters. */
const WAVE_HALF_WIDTH = 4;

/**
 * Blend at which a character flips to bold. With the quadratic falloff and
 * half-width 4 this bolds the wavefront plus its immediate neighbours — a
 * tight glow rather than a half-title of heavy text.
 */
const BOLD_BLEND_THRESHOLD = 0.5;

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function shimmerText(text: string, frame: number): string {
  // Grapheme clusters, so a composed emoji or CJK glyph never splits across
  // two colour codes.
  const chars = [...GRAPHEME_SEGMENTER.segment(text)].map(({ segment }) => segment);
  if (chars.length === 0) return text;
  const base = parseHexColor(currentTheme.color('textDim'));
  const peak = parseHexColor(currentTheme.color('textStrong'));
  // The wavefront enters at -WAVE_HALF_WIDTH and leaves at length + half
  // width, so the sweep wraps seamlessly with a brief all-base beat between
  // passes.
  const cycle = chars.length + WAVE_HALF_WIDTH * 2;
  const wavefront = (frame % cycle) - WAVE_HALF_WIDTH;
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    // A space shows no foreground — skip its escape codes entirely.
    if (char === ' ') {
      out += char;
      continue;
    }
    const proximity = Math.max(0, 1 - Math.abs(i - wavefront) / WAVE_HALF_WIDTH);
    // Quadratic easing: the band fades out at the edges instead of stepping.
    const blend = proximity * proximity;
    const style = chalk.rgb(
      Math.round(base[0] + (peak[0] - base[0]) * blend),
      Math.round(base[1] + (peak[1] - base[1]) * blend),
      Math.round(base[2] + (peak[2] - base[2]) * blend),
    );
    out += blend >= BOLD_BLEND_THRESHOLD ? style.bold(char) : style(char);
  }
  return out;
}

function parseHexColor(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}
