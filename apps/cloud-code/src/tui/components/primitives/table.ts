/**
 * Table primitive — aligned columns in the chrome dialect: no outer border,
 * a styled header row over one '─' separator spanning the table's own
 * width, and space-separated columns.
 *
 * Column widths come from content, MarkdownTable-style: each column takes
 * its ideal (widest cell) width when everything fits; otherwise columns
 * floor at their minimum (longest word, at least `minColumnWidth`) and
 * share the remaining space in proportion to how far each ideal exceeds
 * its minimum. Cells wrap, never truncate — a row's extra cell lines emit
 * below it, top-aligned.
 *
 * Narrow degradation: when the minimum grid cannot fit the available width,
 * or wrapping would push any row past `maxRowLines`, the table renders as
 * vertical key-value records (`Header: value`, continuations indented two
 * columns, records separated by a short rule).
 */

import { visibleWidth, wrapTextWithAnsi } from '@cloud-code/pi-tui';

import { padEndVisible } from '#/tui/i18n/pad-visible';
import type { ColorToken } from '#/tui/theme';

import { padStartVisible, styleText } from './text';

export interface TableColumn {
  /** Header text (plain; styled with the header token). */
  readonly header: string;
  /** Alignment of the column, header included; defaults to 'left'. */
  readonly align?: 'left' | 'right';
}

export interface TableOptions {
  readonly columns: readonly TableColumn[];
  /** Body rows, one cell per column (missing cells render as ''). */
  readonly rows: readonly (readonly string[])[];
  /** Total available width in visible columns. */
  readonly width: number;
  /** Left margin in spaces; defaults to 0. */
  readonly margin?: number;
  /** Spaces between columns; defaults to 2. */
  readonly gap?: number;
  /** Header text token; defaults to 'textDim'. */
  readonly headerToken?: ColorToken;
  /** Header separator and record rule token; defaults to 'border'. */
  readonly separatorToken?: ColorToken;
  /** Narrowest a column may go; defaults to 3. */
  readonly minColumnWidth?: number;
  /** Wrapped-line budget per row before degrading to records; defaults to 4. */
  readonly maxRowLines?: number;
}

interface TableShape {
  readonly columns: readonly TableColumn[];
  readonly rows: readonly (readonly string[])[];
  readonly available: number;
  readonly indent: string;
  readonly headerToken: ColorToken;
  readonly separatorToken: ColorToken;
  readonly minColumnWidth: number;
}

/** Longest word in `text` (the narrowest wrap that avoids mid-word breaks). */
function minTextWidth(text: string, floor: number): number {
  return text
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .reduce((max, word) => Math.max(max, visibleWidth(word)), floor);
}

function cellAt(row: readonly string[], index: number): string {
  return row[index] ?? '';
}

/** Key-value record rendering for terminals too narrow for the grid. */
function renderRecords(shape: TableShape): string[] {
  const { columns, rows, available, indent, headerToken, separatorToken } = shape;
  const rule = indent + styleText('─'.repeat(Math.max(1, Math.min(available, 40))), separatorToken);
  const out: string[] = [];
  rows.forEach((row, rowIndex) => {
    if (rowIndex > 0) out.push(rule);
    columns.forEach((column, index) => {
      const label = column.header.length > 0 ? column.header : `Column ${String(index + 1)}`;
      // The first value line shares its row with the label; continuations
      // get the full width under a two-column indent, so the value wraps
      // once at the label-shortened width and the remainder re-wraps wider.
      const firstWidth = Math.max(1, available - visibleWidth(label) - 2);
      const firstPass = wrapTextWithAnsi(cellAt(row, index), firstWidth);
      const valueLines =
        firstPass.length <= 1
          ? firstPass
          : [
              firstPass[0]!,
              ...wrapTextWithAnsi(
                firstPass
                  .slice(1)
                  .map((line) => line.trim())
                  .join(' '),
                Math.max(1, available - 2),
              ),
            ];
      out.push(`${indent}${styleText(`${label}:`, headerToken)} ${valueLines[0] ?? ''}`.trimEnd());
      for (const line of valueLines.slice(1)) {
        if (line.trim().length === 0) continue;
        out.push(`${indent}  ${line}`.trimEnd());
      }
    });
  });
  return out;
}

export function renderTable(options: TableOptions): string[] {
  const columns = options.columns;
  if (columns.length === 0) return [];
  const gap = options.gap ?? 2;
  const margin = options.margin ?? 0;
  const minColumnWidth = options.minColumnWidth ?? 3;
  const maxRowLines = options.maxRowLines ?? 4;
  const headerToken = options.headerToken ?? 'textDim';
  const separatorToken = options.separatorToken ?? 'border';
  const indent = ' '.repeat(margin);
  const available = Math.max(0, options.width - margin - gap * (columns.length - 1));
  const shape: TableShape = {
    columns,
    rows: options.rows,
    available,
    indent,
    headerToken,
    separatorToken,
    minColumnWidth,
  };

  const minWidths = columns.map((column, index) =>
    options.rows.reduce(
      (max, row) => Math.max(max, minTextWidth(cellAt(row, index), minColumnWidth)),
      minTextWidth(column.header, minColumnWidth),
    ),
  );
  const idealWidths = columns.map((column, index) =>
    options.rows.reduce(
      (max, row) => Math.max(max, visibleWidth(cellAt(row, index))),
      Math.max(minColumnWidth, visibleWidth(column.header)),
    ),
  );

  const sum = (ns: readonly number[]): number => ns.reduce((a, b) => a + b, 0);
  const totalMin = sum(minWidths);
  if (totalMin > available) return renderRecords(shape);

  let widths: readonly number[];
  if (sum(idealWidths) <= available) {
    widths = idealWidths;
  } else {
    // Each column keeps its minimum; the spare columns are shared in
    // proportion to how much each ideal overshoots its minimum.
    const extra = available - totalMin;
    const overflows = idealWidths.map((ideal, index) => ideal - minWidths[index]!);
    const totalOverflow = sum(overflows);
    widths = minWidths.map((min, index) =>
      totalOverflow === 0 ? min : min + Math.floor((overflows[index]! / totalOverflow) * extra),
    );
  }

  const wrapColumn = (text: string, index: number): string[] =>
    wrapTextWithAnsi(text, widths[index]!);
  const wrappedHeader = columns.map((column, index) => wrapColumn(column.header, index));
  const wrappedRows = options.rows.map((row) =>
    columns.map((_, index) => wrapColumn(cellAt(row, index), index)),
  );
  const tallest = Math.max(
    1,
    ...wrappedHeader.map((cell) => cell.length),
    ...wrappedRows.flatMap((row) => row.map((cell) => cell.length)),
  );
  if (tallest > maxRowLines) return renderRecords(shape);

  const emitRow = (
    cells: readonly (readonly string[])[],
    token?: ColorToken,
  ): string[] => {
    const height = Math.max(...cells.map((cell) => cell.length));
    const lines: string[] = [];
    for (let line = 0; line < height; line++) {
      const parts: string[] = [];
      for (const [index, cell] of cells.entries()) {
        const content = cell[line] ?? '';
        // The trailing column is never left-padded: its padding would only
        // add invisible trailing columns to a borderless table.
        const padded =
          columns[index]!.align === 'right'
            ? padStartVisible(content, widths[index]!)
            : index === cells.length - 1
              ? content
              : padEndVisible(content, widths[index]!);
        parts.push(token === undefined ? padded : styleText(padded, token));
      }
      lines.push((indent + parts.join(' '.repeat(gap))).trimEnd());
    }
    return lines;
  };

  const tableWidth = sum(widths) + gap * (columns.length - 1);
  return [
    ...emitRow(wrappedHeader, headerToken),
    indent + styleText('─'.repeat(tableWidth), separatorToken),
    ...wrappedRows.flatMap((row) => emitRow(row)),
  ];
}
