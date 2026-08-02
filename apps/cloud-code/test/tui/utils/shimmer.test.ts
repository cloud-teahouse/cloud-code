import chalk from 'chalk';
import { afterEach, describe, expect, it } from 'vitest';

import { currentTheme } from '#/tui/theme';
import { darkColors, lightColors } from '#/tui/theme/colors';
import { shimmerText } from '#/tui/utils/shimmer';

const ANSI_SGR = /\u001B\[[0-9;]*m/g;
const BOLD_OPEN = '\u001B[1m';

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function colorCodes(text: string): Set<string> {
  return new Set(text.match(/\u001B\[38;2;\d+;\d+;\d+m/g) ?? []);
}

describe('shimmerText', () => {
  const previousChalkLevel = chalk.level;
  const previousPalette = currentTheme.palette;

  afterEach(() => {
    chalk.level = previousChalkLevel;
    currentTheme.setPalette(previousPalette);
  });

  it('preserves the plain text under the colour codes', () => {
    chalk.level = 3;
    const title = 'Using Read (foo.ts)';
    expect(strip(shimmerText(title, 7))).toBe(title);
  });

  it('lerps the foreground per character from textDim up to a bold textStrong peak', () => {
    chalk.level = 3;
    const title = 'Using Read (foo.ts)';
    // Frame 10 puts the wavefront at character 6 of the 19-char title.
    const out = shimmerText(title, 10);
    expect(colorCodes(out).size).toBeGreaterThan(1);
    // The wavefront character (index 6) reaches textStrong, bold.
    expect(out).toContain(chalk.rgb(245, 245, 245).bold('R'));
    // Its immediate neighbours (blend 0.5625) stay inside the bold band…
    expect(out).toContain(chalk.rgb(197, 197, 197).bold('e'));
    // …while characters two off the wavefront (blend 0.25) keep the regular
    // weight — the bold glow stays tight.
    expect(out).toContain(chalk.rgb(163, 163, 163)('a'));
  });

  it('renders every character at the textDim base colour when the wavefront is off-screen', () => {
    chalk.level = 3;
    const title = 'Using Read (foo.ts)';
    // Frame 0 starts the wavefront just left of the first character.
    const out = shimmerText(title, 0);
    expect(colorCodes(out).size).toBe(1);
    expect(out).toContain(chalk.hex(darkColors.textDim)('U'));
    expect(out).not.toContain(BOLD_OPEN);
  });

  it('stays visible in the light palette, where text == textStrong', () => {
    chalk.level = 3;
    // The wave anchors at textDim, so the light palette still gets a real
    // sweep: dim gray (textDim) sinking toward bold near-black (textStrong).
    currentTheme.setPalette(lightColors);
    const title = 'Using Read (foo.ts)';
    const out = shimmerText(title, 10);
    expect(colorCodes(out).size).toBeGreaterThan(1);
    expect(out).toContain(chalk.rgb(26, 26, 26).bold('R'));

    const atRest = shimmerText(title, 0);
    expect(atRest).toContain(chalk.hex(lightColors.textDim)('U'));
    expect(atRest).not.toContain(BOLD_OPEN);
  });

  it('is pure per frame and travels with the frame index', () => {
    chalk.level = 3;
    const title = 'Using Read (foo.ts)';
    expect(shimmerText(title, 10)).toBe(shimmerText(title, 10));
    expect(shimmerText(title, 10)).not.toBe(shimmerText(title, 11));
  });
});
