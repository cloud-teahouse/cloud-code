import type { MouseEvent, TUI } from '@cloud-code/pi-tui';
import chalk from 'chalk';
import { afterAll, describe, expect, it, vi, beforeAll } from 'vitest';

import { ReadGroupComponent } from '#/tui/components/messages/read-group';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { currentTheme } from '#/tui/theme';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function stubTui(): TUI {
  return {
    terminal: { rows: 40 },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

const press: MouseEvent = { type: 'press', button: 0, col: 2, row: 2, slotRelative: false };

function makeDoneGroup(): {
  group: ReadGroupComponent;
  a: ToolCallComponent;
  b: ToolCallComponent;
} {
  const ui = stubTui();
  const group = new ReadGroupComponent(ui);
  const a = new ToolCallComponent({ id: 'call_read_1', name: 'Read', args: { path: 'src/a.ts' } }, undefined, ui);
  const b = new ToolCallComponent({ id: 'call_read_2', name: 'Read', args: { path: 'src/b.ts' } }, undefined, ui);
  group.attach('call_read_1', a);
  group.attach('call_read_2', b);
  a.setResult({ tool_call_id: 'call_read_1', output: 'file a content\n', is_error: false });
  b.setResult({ tool_call_id: 'call_read_2', output: 'file b content\n', is_error: false });
  return { group, a, b };
}

describe('ReadGroupComponent hover and click interaction', () => {
  const prevLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 3;
    currentTheme.setPalette(darkColors);
  });
  afterAll(() => {
    chalk.level = prevLevel;
  });

  const SENTINEL = '\u0001';
  const fgOpen = (token: 'text' | 'success'): string => {
    const sampled = currentTheme.fg(token, SENTINEL);
    return sampled.slice(0, sampled.indexOf(SENTINEL));
  };
  // Sampled after chalk.level is forced in beforeAll — sampling earlier (at
  // collection time) would capture the colorless sequences.
  let TEXT_OPEN = '';
  let BG_OPEN = '';
  beforeAll(() => {
    TEXT_OPEN = fgOpen('text');
    const sampled = currentTheme.bg('userMessageBackground', SENTINEL);
    BG_OPEN = sampled.slice(0, sampled.indexOf(SENTINEL));
    if (TEXT_OPEN.length === 0 || BG_OPEN.length === 0) {
      throw new Error('theme sampling produced no SGR sequences');
    }
  });

  it('renders the branch glyphs in the dim detail tone', () => {
    const { group, a, b } = makeDoneGroup();
    const rows = group.render(120);
    const firstBranch = rows.find((l) => l.includes('src/a.ts'));
    const lastBranch = rows.find((l) => l.includes('src/b.ts'));
    expect(firstBranch).toBeDefined();
    expect(lastBranch).toBeDefined();
    expect(firstBranch!).toContain(currentTheme.fg('textDim', '  ├─ src/a.ts · 1 line'));
    expect(lastBranch!).toContain(currentTheme.fg('textDim', '  └─ src/b.ts · 1 line'));
    expect(firstBranch!).not.toContain(currentTheme.fg('text', 'src/a.ts'));
    expect(lastBranch!).not.toContain(currentTheme.fg('text', 'src/b.ts'));
    group.dispose();
    a.dispose();
    b.dispose();
  });

  it('declares one hit zone covering the group below its spacer', () => {
    const { group, a, b } = makeDoneGroup();
    const lines = group.render(120);
    const zones = [...group.hitZones()];
    expect(zones).toHaveLength(1);
    expect(zones[0]).toMatchObject({ row: 1, col: 1, width: 120, height: lines.length - 1 });
    group.dispose();
    a.dispose();
    b.dispose();
  });

  it('click unfolds the file contents on a gray background and re-folds', () => {
    const { group, a, b } = makeDoneGroup();
    const base = group.render(120);
    expect(strip(base.join('\n'))).toContain('Read 2 files');
    expect(strip(base.join('\n'))).not.toContain('file a content');

    group.onHitZone('card', press);
    const expanded = group.render(120);
    const text = strip(expanded.join('\n'));
    expect(text).toContain('file a content');
    expect(text).toContain('file b content');
    expect(text).toContain('Read 2 files');
    // The gray block covers header and member rows; the leading spacer stays
    // plain. The group header keeps its foreground colors.
    expect(expanded[0]).not.toContain(BG_OPEN);
    for (const line of expanded.slice(1)) {
      expect(line).toContain(BG_OPEN);
    }
    expect(strip(expanded[1]!).trimEnd()).toBe(strip(base[1]!).trimEnd());
    expect(expanded[1]).toContain(fgOpen('success'));

    group.onHitZone('card', press);
    expect(group.render(120)).toEqual(base);
    group.dispose();
    a.dispose();
    b.dispose();
  });

  it('hover whitens the summary rows and restores on leave', () => {
    const { group, a, b } = makeDoneGroup();
    const base = group.render(120);

    group.setHoveredZone('card');
    const hovered = group.render(120);
    expect(hovered[0]).toBe(base[0]);
    expect(hovered[1]).toBe(base[1]);
    expect(strip(hovered.join('\n'))).toBe(strip(base.join('\n')));
    const body = hovered.slice(2).join('\n');
    expect(body).toContain(TEXT_OPEN);
    expect(body).not.toContain('\x1b[2m');

    group.setHoveredZone(null);
    expect(group.render(120)).toEqual(base);
    group.dispose();
    a.dispose();
    b.dispose();
  });

  it('setClickExpanded(false) folds an expanded group (collapse-all)', () => {
    const { group, a, b } = makeDoneGroup();
    const base = group.render(120);
    group.setClickExpanded(true);
    expect(strip(group.render(120).join('\n'))).toContain('file a content');
    group.setClickExpanded(false);
    expect(group.render(120)).toEqual(base);
    group.dispose();
    a.dispose();
    b.dispose();
  });
});
