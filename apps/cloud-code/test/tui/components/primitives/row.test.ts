import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { columnWidth, renderRow } from '#/tui/components/primitives';
import { currentTheme, darkColors } from '#/tui/theme';

describe('renderRow', () => {
  const prevLevel = chalk.level;
  const prevPalette = currentTheme.palette;
  beforeAll(() => {
    currentTheme.setPalette(darkColors);
  });
  afterAll(() => {
    chalk.level = prevLevel;
    currentTheme.setPalette(prevPalette);
  });

  it('joins cells with the default two-space gap', () => {
    chalk.level = 0;
    expect(renderRow([{ text: 'a' }, { text: 'b' }])).toBe('a  b');
  });

  it('applies the margin and a custom gap', () => {
    chalk.level = 0;
    expect(renderRow([{ text: 'a' }, { text: 'b' }], { margin: 2, gap: 3 })).toBe('  a   b');
  });

  it('floors a cell at its width without capping wider content', () => {
    chalk.level = 0;
    expect(renderRow([{ text: 'Name', width: 6 }, { text: 'x' }])).toBe('Name    x');
    expect(renderRow([{ text: 'LongName', width: 4 }, { text: 'x' }])).toBe('LongName  x');
  });

  it('right-aligns inside the width', () => {
    chalk.level = 0;
    expect(renderRow([{ text: '17', width: 4, align: 'right' }, { text: 'x' }])).toBe('  17  x');
  });

  it('pads CJK cells by visible columns', () => {
    chalk.level = 0;
    // '标题' is 4 visible columns: 2 padding spaces to reach width 6.
    expect(renderRow([{ text: '标题', width: 6 }, { text: 'x' }])).toBe('标题    x');
  });

  it('wraps the padded cell in the token style, padding included', () => {
    chalk.level = 3;
    expect(renderRow([{ text: 'A', token: 'error', width: 3 }])).toBe(
      currentTheme.fg('error', 'A  '),
    );
    expect(renderRow([{ text: 'A', token: 'primary', bold: true }])).toBe(
      currentTheme.boldFg('primary', 'A'),
    );
  });

  it('passes pre-styled cells through untouched', () => {
    chalk.level = 3;
    const styled = currentTheme.fg('primary', 'bar');
    expect(renderRow([{ text: styled }, { text: 'x' }])).toBe(`${styled}  x`);
  });
});

describe('columnWidth', () => {
  it('is the widest content width, floored at the minimum', () => {
    expect(columnWidth(['ab', 'abcd'])).toBe(4);
    expect(columnWidth(['ab'], 10)).toBe(10);
    expect(columnWidth([], 1)).toBe(1);
  });

  it('measures CJK text in visible columns', () => {
    expect(columnWidth(['标题', 'ab'])).toBe(4);
  });
});
