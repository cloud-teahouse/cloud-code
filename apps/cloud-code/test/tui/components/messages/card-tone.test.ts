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
  const fgOpen = (token: 'text' | 'textDim' | 'textMuted'): string => {
    const sampled = currentTheme.fg(token, SENTINEL);
    return sampled.slice(0, sampled.indexOf(SENTINEL));
  };
  let TEXT_OPEN = '';
  let DIM_OPEN = '';
  let BG_OPEN = '';
  let HOVER_BG_OPEN = '';
  beforeAll(() => {
    TEXT_OPEN = fgOpen('text');
    DIM_OPEN = fgOpen('textDim');
    const sampled = currentTheme.bg('userMessageBackground', SENTINEL);
    BG_OPEN = sampled.slice(0, sampled.indexOf(SENTINEL));
    const hoverSampled = currentTheme.bg('hoverBackground', SENTINEL);
    HOVER_BG_OPEN = hoverSampled.slice(0, hoverSampled.indexOf(SENTINEL));
    if (TEXT_OPEN.length === 0 || BG_OPEN.length === 0 || HOVER_BG_OPEN.length === 0) {
      throw new Error('theme sampling produced no SGR sequences');
    }
  });

  it('returns the input array untouched for the normal tone', () => {
    const lines = [currentTheme.fg('textDim', 'gray')];
    expect(applyCardTone(lines, { width: 40, tone: 'normal', bgFrom: 0 })).toBe(lines);
  });

  it('whitens textDim and chalk.dim runs but keeps colors and bold', () => {
    const line =
      currentTheme.fg('textDim', 'gray') + chalk.dim('dim') + chalk.red('red') + chalk.bold('bold');
    const out = applyCardTone([line], { width: 40, tone: 'hover', bgFrom: 0 })[0]!;
    expect(out).toContain(`${TEXT_OPEN}gray\x1b[39m`);
    expect(out).toContain(`${TEXT_OPEN}dim\x1b[39m`);
    expect(out).toContain(chalk.red('red'));
    expect(out).toContain(chalk.bold('bold'));
    // Text content is unchanged — only the gray runs' colors move.
    expect(strip(out).trimEnd()).toBe(strip(line));
  });

  it('keeps diff and syntax colors while whitening the gray gutter/meta runs', () => {
    const palette = currentTheme.palette;
    const line =
      chalk.hex(palette.diffGutter)('   1 ') +
      chalk.hex(palette.diffAdded)('+ added') +
      chalk.hex(palette.diffMeta)(' … meta') +
      '\x1b[34mconst\x1b[39m';
    const out = applyCardTone([line], { width: 40, tone: 'hover', bgFrom: 0 })[0]!;
    // diffGutter equals textMuted and diffMeta equals textDim in the dark
    // palette: both gray-family runs whiten on hover.
    expect(out).toContain(`${TEXT_OPEN}   1 \x1b[39m`);
    expect(out).toContain(`${TEXT_OPEN} … meta\x1b[39m`);
    // The added-run lifts to its Strong variant; syntax colors stay untouched.
    expect(out).toContain(chalk.hex(palette.diffAddedStrong)('+ added'));
    expect(out).toContain('\x1b[34mconst\x1b[39m');
    expect(strip(out).trimEnd()).toBe(strip(line));
  });

  it('hover never paints a background; diff-toned colors lift to their Strong variants', () => {
    const palette = currentTheme.palette;
    const line = chalk.hex(palette.diffAdded)('+ added') + chalk.hex(palette.error)(' error');
    const image = '\u001B_Ga=T,f=100;payload\u001B\\';
    const out = applyCardTone(['', line, image], {
      width: 20,
      tone: 'hover',
      bgFrom: 1,
    });

    expect(out[0]).toBe('');
    expect(out[1]).not.toContain(HOVER_BG_OPEN);
    expect(out[1]).not.toContain(BG_OPEN);
    // diffAdded/error share their hexes with the diff tokens, so both lift.
    expect(out[1]).toContain(chalk.hex(palette.diffAddedStrong)('+ added'));
    expect(out[1]).toContain(chalk.hex(palette.diffRemovedStrong)(' error'));
    expect(strip(out[1]!)).toBe(strip(line));
    expect(out[2]).toBe(image);
  });

  it('brightens every row in a folded block when a continuation has inline color', () => {
    const palette = currentTheme.palette;
    const lines = [
      '',
      currentTheme.fg('textDim', '● The failure is ') +
        chalk.hex(palette.primary)('kaos test/pty.test.ts > …') +
        ' — a known load-sensitive flake…',
      chalk.hex(palette.primary)('kaos test/pty.test.ts > …') + ' continuation',
      chalk.dim('… (还有 3 行，ctrl+o 展开)'),
    ];

    const out = applyCardTone(lines, { width: 80, tone: 'hover', bgFrom: 1 });

    expect(out[1]).not.toBe(lines[1]);
    expect(out[2]).not.toBe(lines[2]);
    expect(out[3]).not.toBe(lines[3]);
    expect(out[2]).toContain(chalk.hex(palette.primary)('kaos test/pty.test.ts > …'));
    expect(strip(out[2]!).trimEnd()).toBe(strip(lines[2]!));
  });

  it('brightens styled continuation rows in an expanded ordered list', () => {
    const palette = currentTheme.palette;
    const lines = [
      '',
      currentTheme.fg('textDim', '1. Alpha release: all checks passed'),
      chalk.bold('2. Beta pre-release: build-commit = ') +
        chalk.hex(palette.primary)('804c590c') +
        chalk.bold(' ✓ (new binaries with all visual'),
      chalk.bold('fixes)'),
      chalk.hex(palette.primary)('3. Publish to npm: …') + ' beta auto-published…',
      chalk.underline('beta auto-published…'),
    ];

    const out = applyCardTone(lines, { width: 80, tone: 'hover', bgFrom: 1 });

    for (let i = 1; i < lines.length; i++) {
      expect(out[i]).not.toBe(lines[i]);
    }
    expect(out[2]).toContain(chalk.hex(palette.primary)('804c590c'));
    expect(out[3]).toContain(chalk.bold('fixes)'));
    expect(strip(out[4]!).trimEnd()).toBe(strip(lines[4]!));
  });

  it('keeps bold intact when nested inside dim', () => {
    const line = chalk.dim(`a${chalk.bold('b')}c`);
    const out = applyCardTone([line], { width: 40, tone: 'hover', bgFrom: 0 })[0]!;
    // The bold open/close pass through; only the dim runs become white.
    expect(out).toContain('\x1b[1mb\x1b[22m');
    expect(out).toContain(`${TEXT_OPEN}a`);
    expect(out).toContain(`${TEXT_OPEN}c\x1b[39m`);
    expect(strip(out).trimEnd()).toBe('abc');
  });

  it('whitens gray runs in the header row as well as the body', () => {
    const header = currentTheme.boldFg('primary', 'header') + chalk.dim(' (args)');
    const spacer = '';
    const out = applyCardTone([spacer, header, chalk.dim('body')], {
      width: 40,
      tone: 'hover',
      bgFrom: 1,
    });
    // The spacer above bgFrom stays untouched.
    expect(out[0]).toBe(spacer);
    // The header's colored label keeps its tone; its gray args whiten.
    expect(out[1]).toContain(currentTheme.boldFg('primary', 'header'));
    expect(out[1]).toContain(`${TEXT_OPEN} (args)\x1b[39m`);
    expect(out[2]).toContain(`${TEXT_OPEN}body\x1b[39m`);
  });

  it('paints the background from bgFrom down and pads rows to the width', () => {
    const out = applyCardTone(['', 'hdr', chalk.dim('body')], {
      width: 10,
      tone: 'click',
      bgFrom: 1,
    });
    expect(out[0]).toBe('');
    expect(out[1]).toContain(BG_OPEN);
    expect(out[1]).toContain(`${TEXT_OPEN}hdr\x1b[39m`);
    expect(visibleWidth(strip(out[1]!))).toBe(10);
    expect(out[2]).toContain(BG_OPEN);
    expect(out[2]).toContain(`${TEXT_OPEN}body`);
    expect(visibleWidth(strip(out[2]!))).toBe(10);
  });

  it('leaves inline image rows untouched during hover and click tones', () => {
    const image = '\u001B_Ga=T,f=100;payload\u001B\\';

    expect(applyCardTone([image], { width: 10, tone: 'hover', bgFrom: 0 })[0]).toBe(
      image,
    );
    expect(applyCardTone([image], { width: 10, tone: 'click', bgFrom: 0 })[0]).toBe(
      image,
    );
  });

  it('is a no-op when colors are disabled', () => {
    chalk.level = 0;
    try {
      const lines = ['plain'];
      expect(applyCardTone(lines, { width: 10, tone: 'click', bgFrom: 0 })).toBe(lines);
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
      const out = applyCardTone([line], { width: 40, tone: 'hover', bgFrom: 0 })[0]!;
      expect(out).not.toContain(DIM_OPEN);
      expect(out).toContain(`${fgOpen('text')}gray\x1b[39m`);
    } finally {
      currentTheme.setPalette(darkColors);
    }
  });
});
