import { visibleWidth } from '@cloud-code/pi-tui';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderTable } from '#/tui/components/primitives';
import { currentTheme, darkColors } from '#/tui/theme';

describe('renderTable', () => {
  const prevLevel = chalk.level;
  const prevPalette = currentTheme.palette;
  beforeAll(() => {
    currentTheme.setPalette(darkColors);
  });
  afterAll(() => {
    chalk.level = prevLevel;
    currentTheme.setPalette(prevPalette);
  });

  it('renders the chrome dialect: styled header, ─ separator, spaced columns', () => {
    chalk.level = 0;
    const lines = renderTable({
      columns: [{ header: 'Name' }, { header: 'Age', align: 'right' }],
      rows: [
        ['Alice', '17'],
        ['Bo', '3'],
      ],
      width: 40,
    });
    expect(lines).toEqual(['Name   Age', '─'.repeat(10), 'Alice   17', 'Bo       3']);
  });

  it('shrinks columns proportionally toward their longest word', () => {
    chalk.level = 0;
    // Column 0 floors at 5 ('alpha'/'gamma') and gets the two spare columns;
    // its cells wrap onto extra lines, top-aligned.
    const lines = renderTable({
      columns: [{ header: 'H1' }, { header: 'H2' }],
      rows: [
        ['alpha beta', 'x'],
        ['gamma', 'y z'],
      ],
      width: 12,
    });
    expect(lines).toEqual([
      'H1       H2',
      '─'.repeat(12),
      'alpha    x',
      'beta',
      'gamma    y z',
    ]);
  });

  it('degrades to key-value records when the minimum grid cannot fit', () => {
    chalk.level = 0;
    const lines = renderTable({
      columns: [{ header: 'Path' }, { header: 'Note' }],
      rows: [['/a/very/long/path', 'ok']],
      width: 16,
    });
    expect(lines).toEqual(['Path: /a/very/', '  long/pat h', 'Note: ok']);
  });

  it('degrades to records when a row would grow past the line budget', () => {
    chalk.level = 0;
    const options = {
      columns: [{ header: 'A' }, { header: 'B' }],
      rows: [['one two three four five six seven eight nine ten', 'x']],
      width: 14,
    } as const;
    // With a generous budget the same table stays a grid.
    expect(renderTable({ ...options, maxRowLines: 99 })[1]).toBe('─'.repeat(14));
    expect(renderTable(options)).toEqual([
      'A: one two',
      '  three four',
      '  five six',
      '  seven',
      '  eight nine',
      '  ten',
      'B: x',
    ]);
  });

  it('separates records with a short rule', () => {
    chalk.level = 0;
    const lines = renderTable({
      columns: [{ header: 'Path' }, { header: 'Note' }],
      rows: [
        ['/a/very/long/path', 'ok'],
        ['/another/long/path', 'fine'],
      ],
      width: 16,
    });
    expect(lines).toEqual([
      'Path: /a/very/',
      '  long/pat h',
      'Note: ok',
      '─'.repeat(14),
      'Path: /another',
      '  /long/pa th',
      'Note: fine',
    ]);
  });

  it('falls back to Column N labels for empty headers in record mode', () => {
    chalk.level = 0;
    const lines = renderTable({
      columns: [{ header: '' }, { header: 'B' }, { header: 'C' }, { header: 'D' }, { header: 'E' }],
      rows: [['x', 'v2', 'v3', 'v4', 'v5']],
      width: 20,
    });
    expect(lines).toEqual(['Column 1: x', 'B: v2', 'C: v3', 'D: v4', 'E: v5']);
  });

  it('aligns CJK content by visible columns', () => {
    chalk.level = 0;
    const lines = renderTable({
      columns: [{ header: '名称' }, { header: '值' }],
      rows: [
        ['甲', '22'],
        ['乙丙丁', '3'],
      ],
      width: 30,
    });
    expect(lines).toEqual(['名称    值', '─'.repeat(11), '甲      22', '乙丙丁  3']);
  });

  it('honors the margin and gap options', () => {
    chalk.level = 0;
    const lines = renderTable({
      columns: [{ header: 'Name' }, { header: 'Age', align: 'right' }],
      rows: [['Alice', '17']],
      width: 40,
      margin: 2,
      gap: 3,
    });
    expect(lines).toEqual(['  Name    Age', '  ' + '─'.repeat(11), '  Alice    17']);
  });

  it('renders only the header and separator for an empty body', () => {
    chalk.level = 0;
    expect(
      renderTable({
        columns: [{ header: 'Name' }, { header: 'Age', align: 'right' }],
        rows: [],
        width: 40,
      }),
    ).toEqual(['Name  Age', '─'.repeat(9)]);
  });

  it('treats missing cells as empty', () => {
    chalk.level = 0;
    const lines = renderTable({
      columns: [{ header: 'Name' }, { header: 'Age', align: 'right' }],
      rows: [['only']],
      width: 40,
    });
    expect(lines[2]).toBe('only');
  });

  it('leaves no trailing whitespace on any line', () => {
    chalk.level = 0;
    for (const width of [12, 16, 30, 40]) {
      const lines = renderTable({
        columns: [{ header: 'Name' }, { header: 'Note' }],
        rows: [
          ['Alice', 'short'],
          ['Bob', 'a somewhat longer note that wraps'],
        ],
        width,
      });
      for (const line of lines) {
        expect(line).toBe(line.trimEnd());
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('styles the header and separator with their tokens', () => {
    chalk.level = 3;
    const lines = renderTable({
      columns: [{ header: 'Name' }, { header: 'Age', align: 'right' }],
      rows: [['Alice', '17']],
      width: 40,
    });
    expect(lines[0]).toBe(
      `${currentTheme.fg('textDim', 'Name ')}  ${currentTheme.fg('textDim', 'Age')}`,
    );
    expect(lines[1]).toBe(currentTheme.fg('border', '─'.repeat(10)));
    expect(lines[2]).toBe('Alice   17');
  });

  it('supports custom header and separator tokens', () => {
    chalk.level = 3;
    const lines = renderTable({
      columns: [{ header: 'Name' }],
      rows: [['Alice']],
      width: 20,
      headerToken: 'primary',
      separatorToken: 'borderFocus',
    });
    expect(lines[0]).toBe(currentTheme.fg('primary', 'Name'));
    expect(lines[1]).toBe(currentTheme.fg('borderFocus', '─'.repeat(5)));
  });
});
