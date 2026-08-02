import { truncateToWidth } from '@cloud-code/pi-tui';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderDivider } from '#/tui/components/primitives';
import { currentTheme, darkColors } from '#/tui/theme';

describe('renderDivider', () => {
  const prevLevel = chalk.level;
  const prevPalette = currentTheme.palette;
  beforeAll(() => {
    currentTheme.setPalette(darkColors);
  });
  afterAll(() => {
    chalk.level = prevLevel;
    currentTheme.setPalette(prevPalette);
  });

  it('draws a full-width rule', () => {
    chalk.level = 0;
    expect(renderDivider(10)).toBe('─'.repeat(10));
    expect(renderDivider(0)).toBe('');
  });

  it('embeds a title and keeps the total width', () => {
    chalk.level = 0;
    expect(renderDivider(12, { title: 'Info' })).toBe('─ Info ─────');
  });

  it('measures CJK titles in visible columns', () => {
    chalk.level = 0;
    expect(renderDivider(10, { title: '标题' })).toBe('─ 标题 ───');
  });

  it('truncates a title that cannot fit', () => {
    chalk.level = 0;
    expect(renderDivider(8, { title: 'LongTitle' })).toBe(
      `─ ${truncateToWidth('LongTitle', 4, '…')} ─`,
    );
  });

  it('falls back to a plain rule below four columns', () => {
    chalk.level = 0;
    expect(renderDivider(3, { title: 'X' })).toBe('───');
  });

  it('styles the line with the border token, borderFocus when focused', () => {
    chalk.level = 3;
    expect(renderDivider(5)).toBe(currentTheme.fg('border', '─'.repeat(5)));
    expect(renderDivider(5, { focused: true })).toBe(
      currentTheme.fg('borderFocus', '─'.repeat(5)),
    );
    expect(renderDivider(8, { title: 'AB' })).toBe(currentTheme.fg('border', '─ AB ───'));
    // An explicit token wins over the focused default.
    expect(renderDivider(5, { token: 'primary', focused: true })).toBe(
      currentTheme.fg('primary', '─'.repeat(5)),
    );
  });
});
