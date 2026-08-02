import { truncateToWidth, visibleWidth } from '@cloud-code/pi-tui';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderBox } from '#/tui/components/primitives';
import { currentTheme, darkColors } from '#/tui/theme';

describe('renderBox', () => {
  const prevLevel = chalk.level;
  const prevPalette = currentTheme.palette;
  beforeAll(() => {
    currentTheme.setPalette(darkColors);
  });
  afterAll(() => {
    chalk.level = prevLevel;
    currentTheme.setPalette(prevPalette);
  });

  it('frames content in the rounded box with one column of padding', () => {
    chalk.level = 0;
    expect(renderBox(['abc'], { width: 9 })).toEqual(['╭─────╮', '│ abc │', '╰─────╯']);
  });

  it('embeds the title in the top border', () => {
    chalk.level = 0;
    expect(renderBox(['abc'], { width: 12, title: 'T' })).toEqual([
      '╭T────╮',
      '│ abc │',
      '╰─────╯',
    ]);
  });

  it('lets a wide title size the box and truncates it past the interior', () => {
    chalk.level = 0;
    expect(renderBox(['ab'], { width: 12, title: 'LongTitle' })[0]).toBe('╭LongTitle─╮');
    // truncateToWidth guards the ellipsis with reset codes; compare against
    // its own output rather than a naive literal.
    const title = truncateToWidth('LongTitle', 6, '…');
    expect(renderBox(['ab'], { width: 8, title: 'LongTitle' })).toEqual([
      `╭${title}╮`,
      '│ ab   │',
      '╰──────╯',
    ]);
  });

  it('clips content lines wider than the interior', () => {
    chalk.level = 0;
    expect(renderBox(['abcdefgh'], { width: 8 })).toEqual([
      '╭──────╮',
      `│ ${truncateToWidth('abcdefgh', 4, '…')} │`,
      '╰──────╯',
    ]);
    expect(renderBox(['abcdefgh'], { width: 8, ellipsis: '...' })[1]).toBe(
      `│ ${truncateToWidth('abcdefgh', 4, '...')} │`,
    );
  });

  it('collapses to truncated plain lines when the frame cannot fit', () => {
    chalk.level = 0;
    expect(renderBox(['content'], { width: 4, title: ' T ' })).toEqual([
      'T',
      truncateToWidth('content', 4, '…'),
    ]);
  });

  it('renders a single empty line at zero width', () => {
    chalk.level = 0;
    expect(renderBox(['abc'], { width: 0 })).toEqual(['']);
  });

  it('sizes itself to the natural content width when none is given', () => {
    chalk.level = 0;
    expect(renderBox(['abc'], { title: 'T' })).toEqual(['╭T────╮', '│ abc │', '╰─────╯']);
  });

  it('spans the full width when fill is set, instead of hugging the content', () => {
    chalk.level = 0;
    expect(renderBox(['abc'], { width: 9, fill: true })).toEqual([
      '╭───────╮',
      '│ abc   │',
      '╰───────╯',
    ]);
  });

  it('honors the margin and the padding option', () => {
    chalk.level = 0;
    expect(renderBox(['a'], { width: 10, margin: 2 })).toEqual([
      '  ╭───╮',
      '  │ a │',
      '  ╰───╯',
    ]);
    expect(renderBox(['a'], { width: 10, padding: 2 })).toEqual([
      '╭─────╮',
      '│  a  │',
      '╰─────╯',
    ]);
  });

  it('frames CJK content by visible columns', () => {
    chalk.level = 0;
    expect(renderBox(['中文'], { width: 10 })).toEqual(['╭──────╮', '│ 中文 │', '╰──────╯']);
  });

  it('never emits a line wider than the given width', () => {
    chalk.level = 0;
    const lines = ['Session usage', '  kimi  input 2.0k', 'error: ' + 'x'.repeat(200), '中文内容行'];
    for (const width of [39, 24, 20, 10, 4, 1]) {
      for (const line of renderBox(lines, { width, title: 'Usage' })) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('paints the frame with the border token, borderFocus when focused', () => {
    chalk.level = 3;
    const border = (s: string): string => currentTheme.fg('border', s);
    expect(renderBox(['a'], { width: 6 })).toEqual([
      border('╭') + border('─'.repeat(3)) + border('╮'),
      border('│') + ' a ' + border('│'),
      border('╰───╯'),
    ]);
    const focus = (s: string): string => currentTheme.fg('borderFocus', s);
    expect(renderBox(['a'], { width: 6, focused: true })[0]).toBe(
      focus('╭') + focus('─'.repeat(3)) + focus('╮'),
    );
  });
});
