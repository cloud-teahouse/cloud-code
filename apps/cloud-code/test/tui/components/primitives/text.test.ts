import { truncateToWidth, visibleWidth } from '@cloud-code/pi-tui';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fitText, padStartVisible, styleText } from '#/tui/components/primitives';
import { currentTheme, darkColors } from '#/tui/theme';

describe('styleText', () => {
  const prevLevel = chalk.level;
  const prevPalette = currentTheme.palette;
  beforeAll(() => {
    currentTheme.setPalette(darkColors);
  });
  afterAll(() => {
    chalk.level = prevLevel;
    currentTheme.setPalette(prevPalette);
  });

  it('returns plain text when colors are disabled', () => {
    chalk.level = 0;
    expect(styleText('hello', 'error')).toBe('hello');
    expect(styleText('hello', 'error', true)).toBe('hello');
  });

  it('delegates to the live theme palette', () => {
    chalk.level = 3;
    expect(styleText('hello', 'error')).toBe(currentTheme.fg('error', 'hello'));
    expect(styleText('hello', 'primary', true)).toBe(currentTheme.boldFg('primary', 'hello'));
  });
});

describe('padStartVisible', () => {
  it('pads ASCII by visible columns', () => {
    expect(padStartVisible('17', 4)).toBe('  17');
  });

  it('counts CJK text as two columns per character', () => {
    // '标题' is 4 visible columns: 2 padding spaces, not 4.
    expect(padStartVisible('标题', 6)).toBe('  标题');
  });

  it('returns text already at or beyond the width unchanged', () => {
    expect(padStartVisible('abcd', 4)).toBe('abcd');
    expect(padStartVisible('abcdef', 4)).toBe('abcdef');
  });
});

describe('fitText', () => {
  it('pads short text to the exact width', () => {
    expect(fitText('ab', 5)).toBe('ab   ');
  });

  it('truncates long text with the ellipsis', () => {
    // truncateToWidth guards the ellipsis with reset codes; compare against
    // its own output rather than a naive literal.
    expect(fitText('abcdefgh', 5)).toBe(truncateToWidth('abcdefgh', 5, '…'));
    expect(fitText('abcdefgh', 5, '...')).toBe(truncateToWidth('abcdefgh', 5, '...'));
  });

  it('fits CJK text by visible columns', () => {
    const fitted = fitText('标题内容详情', 5);
    expect(visibleWidth(fitted)).toBeLessThanOrEqual(5);
    expect(fitted).toBe(truncateToWidth('标题内容详情', 5, '…'));
  });
});
