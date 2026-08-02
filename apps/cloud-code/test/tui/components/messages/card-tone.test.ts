import { visibleWidth } from '@cloud-code/pi-tui';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyCardTone } from '#/tui/components/messages/card-tone';
import { currentTheme } from '#/tui/theme';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('applyCardTone', () => {
  const prevLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 3;
    currentTheme.setPalette(darkColors);
  });
  afterAll(() => {
    chalk.level = prevLevel;
  });

  const SENTINEL = '\u0001';
  const fgOpen = (token: 'text' | 'textDim'): string => {
    const sampled = currentTheme.fg(token, SENTINEL);
    return sampled.slice(0, sampled.indexOf(SENTINEL));
  };
  let TEXT_OPEN = '';
  let DIM_OPEN = '';
  let BG_OPEN = '';
  beforeAll(() => {
    TEXT_OPEN = fgOpen('text');
    DIM_OPEN = fgOpen('textDim');
    const sampled = currentTheme.bg('userMessageBackground', SENTINEL);
    BG_OPEN = sampled.slice(0, sampled.indexOf(SENTINEL));
    if (TEXT_OPEN.length === 0 || BG_OPEN.length === 0) {
      throw new Error('theme sampling produced no SGR sequences');
    }
  });

  it('returns the input array untouched for the normal tone', () => {
    const lines = [currentTheme.fg('textDim', 'gray')];
    expect(applyCardTone(lines, { width: 40, tone: 'normal', bgFrom: 0, toneFrom: 0 })).toBe(lines);
  });

  it('whitens textDim and chalk.dim runs but keeps colors and bold', () => {
    const line =
      currentTheme.fg('textDim', 'gray') + chalk.dim('dim') + chalk.red('red') + chalk.bold('bold');
    const out = applyCardTone([line], { width: 40, tone: 'hover', bgFrom: 0, toneFrom: 0 })[0]!;
    expect(out).toContain(`${TEXT_OPEN}gray\x1b[39m`);
    expect(out).toContain(`${TEXT_OPEN}dim\x1b[39m`);
    expect(out).toContain(chalk.red('red'));
    expect(out).toContain(chalk.bold('bold'));
    expect(strip(out)).toBe(strip(line));
  });

  it('keeps diff and syntax colors while whitening textDim-toned meta', () => {
    const palette = currentTheme.palette;
    const line =
      chalk.hex(palette.diffGutter)('   1 ') +
      chalk.hex(palette.diffAdded)('+ added') +
      chalk.hex(palette.diffMeta)(' … meta') +
      '\x1b[34mconst\x1b[39m';
    const out = applyCardTone([line], { width: 40, tone: 'hover', bgFrom: 0, toneFrom: 0 })[0]!;
    expect(out).toContain(chalk.hex(palette.diffGutter)('   1 '));
    expect(out).toContain(chalk.hex(palette.diffAdded)('+ added'));
    expect(out).toContain('\x1b[34mconst\x1b[39m');
    // diffMeta equals textDim in the dark palette, so the meta run whitens
    // with the rest of the dim detail text.
    expect(out).toContain(`${TEXT_OPEN} … meta\x1b[39m`);
    expect(strip(out)).toBe(strip(line));
  });

  it('keeps bold intact when nested inside dim', () => {
    const line = chalk.dim(`a${chalk.bold('b')}c`);
    const out = applyCardTone([line], { width: 40, tone: 'hover', bgFrom: 0, toneFrom: 0 })[0]!;
    // The bold open/close pass through; only the dim runs become white.
    expect(out).toContain('\x1b[1mb\x1b[22m');
    expect(out).toContain(`${TEXT_OPEN}a`);
    expect(out).toContain(`${TEXT_OPEN}c\x1b[39m`);
    expect(strip(out)).toBe('abc');
  });

  it('leaves lines above toneFrom untouched', () => {
    const header = currentTheme.boldFg('primary', 'header');
    const out = applyCardTone([chalk.dim('gray'), header], {
      width: 40,
      tone: 'hover',
      bgFrom: 0,
      toneFrom: 1,
    });
    expect(out[1]).toBe(header);
  });

  it('paints the background from bgFrom down and pads rows to the width', () => {
    const out = applyCardTone(['', 'hdr', chalk.dim('body')], {
      width: 10,
      tone: 'click',
      bgFrom: 1,
      toneFrom: 2,
    });
    expect(out[0]).toBe('');
    expect(out[1]).toContain(BG_OPEN);
    expect(out[1]).not.toContain(TEXT_OPEN);
    expect(visibleWidth(strip(out[1]!))).toBe(10);
    expect(out[2]).toContain(BG_OPEN);
    expect(out[2]).toContain(`${TEXT_OPEN}body`);
    expect(visibleWidth(strip(out[2]!))).toBe(10);
  });

  it('is a no-op when colors are disabled', () => {
    chalk.level = 0;
    try {
      const lines = ['plain'];
      expect(applyCardTone(lines, { width: 10, tone: 'click', bgFrom: 0, toneFrom: 0 })).toBe(lines);
    } finally {
      chalk.level = 3;
    }
  });

  it('swaps the sampled sequences of a switched palette', () => {
    // The converter samples through the theme at call time, so a palette
    // switch (different textDim hex) is honored without any caching.
    const palette = { ...darkColors, textDim: '#112233' };
    currentTheme.setPalette(palette);
    try {
      const line = currentTheme.fg('textDim', 'gray');
      const out = applyCardTone([line], { width: 40, tone: 'hover', bgFrom: 0, toneFrom: 0 })[0]!;
      expect(out).not.toContain(DIM_OPEN);
      expect(out).toContain(`${fgOpen('text')}gray\x1b[39m`);
    } finally {
      currentTheme.setPalette(darkColors);
    }
  });
});
