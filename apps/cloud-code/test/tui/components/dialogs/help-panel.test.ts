import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  HelpPanelComponent,
  VIM_NORMAL_SHORTCUTS,
} from '#/tui/components/dialogs/help-panel';
import { getLocalePreference, setLocalePreference } from '#/tui/i18n';

const ANSI_SGR = /\u001B\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function makePanel(vimShortcuts?: typeof VIM_NORMAL_SHORTCUTS): HelpPanelComponent {
  return new HelpPanelComponent({
    commands: [{ name: 'help', aliases: [], description: 'Show available commands and shortcuts' }],
    vimShortcuts,
    onClose: vi.fn(),
    maxVisible: 200,
  });
}

const originalPreference = getLocalePreference();

afterEach(() => {
  setLocalePreference(originalPreference);
});

describe('HelpPanelComponent vim section', () => {
  it('renders the global shortcuts without a vim section by default', () => {
    setLocalePreference('en');
    const out = strip(makePanel().render(100).join('\n'));

    expect(out).toContain('Keyboard shortcuts');
    expect(out).toContain('Toggle plan mode');
    expect(out).not.toContain('Vim NORMAL mode');
    expect(out).not.toContain('Enter NORMAL mode');
  });

  it('renders the NORMAL-mode keys between shortcuts and commands when vim is on', () => {
    setLocalePreference('en');
    const out = strip(makePanel(VIM_NORMAL_SHORTCUTS).render(100).join('\n'));

    expect(out).toContain('Vim NORMAL mode');
    expect(out).toContain('Enter NORMAL mode (from INSERT)');
    expect(out).toContain('Delete / change / yank + motion (dd, dw, cw, yy…)');
    expect(out).toContain('Undo / redo');
    expect(out).toContain('Repeat last change');

    // Section order: global shortcuts, vim, slash commands.
    const shortcutsIdx = out.indexOf('Keyboard shortcuts');
    const vimIdx = out.indexOf('Vim NORMAL mode');
    const commandsIdx = out.indexOf('Slash commands');
    expect(shortcutsIdx).toBeLessThan(vimIdx);
    expect(vimIdx).toBeLessThan(commandsIdx);
  });

  it('aligns the key column across both shortcut lists', () => {
    setLocalePreference('en');
    const panel = makePanel(VIM_NORMAL_SHORTCUTS);
    const lines = panel.render(100).map(strip);
    // The widest vim keys entry ('d c y + motion', 15 cols) widens the shared
    // column; every row in both sections starts its description at the same
    // column.
    const rows = lines.filter((line) => line.includes('Enter NORMAL mode') || line.includes('Toggle plan mode'));
    const descColumns = rows.map((line) => line.search(/\S/));
    expect(rows.length).toBe(2);
    // Both rows share the 4-space indent + padded key column.
    const vimRow = rows.find((line) => line.includes('Enter NORMAL mode'))!;
    const globalRow = rows.find((line) => line.includes('Toggle plan mode'))!;
    expect(vimRow.indexOf('Enter NORMAL mode')).toBe(globalRow.indexOf('Toggle plan mode'));
    expect(descColumns.every((col) => col === 4)).toBe(true);
  });

  it('renders the vim section in zh-CN', () => {
    setLocalePreference('zh-CN');
    const out = strip(makePanel(VIM_NORMAL_SHORTCUTS).render(100).join('\n'));

    expect(out).toContain('Vim 普通模式');
    expect(out).toContain('进入普通模式（从插入模式）');
    expect(out).toContain('撤销 / 重做');
  });

  it('an empty vim list renders no vim section', () => {
    setLocalePreference('en');
    const out = strip(makePanel([]).render(100).join('\n'));
    expect(out).not.toContain('Vim NORMAL mode');
  });

  it('keeps the default shortcut list untouched', () => {
    // Guard against the vim rows leaking into the global list.
    expect(DEFAULT_KEYBOARD_SHORTCUTS.some((s) => s.description.startsWith('help.shortcut.vim'))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Hit zones: clickable slash-command rows (onCommandClick), scroll-window
// alignment, wheel regression, hover underline.
// ---------------------------------------------------------------------------

import { hitZoneAt, type MouseEvent } from '@cloud-code/pi-tui';
import chalk from 'chalk';

function makeClickablePanel(
  commands: Array<{ name: string; aliases?: string[]; description: string }>,
  over: { maxVisible?: number } = {},
) {
  const onCommandClick = vi.fn();
  const panel = new HelpPanelComponent({
    commands: commands.map((c) => ({ aliases: [], ...c })),
    onClose: vi.fn(),
    onCommandClick,
    maxVisible: over.maxVisible ?? 200,
  });
  return { panel, onCommandClick };
}

function pressEvent(row: number, col = 1): MouseEvent {
  return { type: 'press', button: 0, col, row, slotRelative: false };
}

/** The dispatch the TUI performs for a left-press at a component-relative cell. */
function dispatchPress(panel: HelpPanelComponent, row: number, col = 1): void | boolean {
  const zone = hitZoneAt(panel.hitZones(), row, col, 'action');
  if (zone === null) return false;
  return panel.onHitZone(zone.id, pressEvent(row, col));
}

describe('HelpPanelComponent command-row hit zones', () => {
  const commands = [
    { name: 'undo', description: 'Undo the last turn' },
    { name: 'help', description: 'Show available commands and shortcuts' },
    { name: 'model', description: 'Pick a model' },
  ];

  it('declares one full-width zone per visible command row, in sorted display order', () => {
    const { panel } = makeClickablePanel(commands);
    const lines = panel.render(80).map(strip);
    const zones = [...panel.hitZones()];
    // Sorted: help, model, undo.
    expect(zones.map((z) => z.id)).toEqual([0, 1, 2]);
    for (const [i, zone] of zones.entries()) {
      expect(zone).toMatchObject({ col: 1, width: 80, height: 1 });
      expect(lines[zone.row]).toContain(`/${['help', 'model', 'undo'][i]!}`);
    }
  });

  it('declares no zones without an onCommandClick handler', () => {
    const panel = makePanel();
    panel.render(80);
    expect([...panel.hitZones()]).toEqual([]);
  });

  it('dispatches a row press to onCommandClick with that row’s command', () => {
    const { panel, onCommandClick } = makeClickablePanel(commands);
    const lines = panel.render(80).map(strip);
    const modelRow = lines.findIndex((line) => line.includes('/model'));
    expect(dispatchPress(panel, modelRow)).not.toBe(false);
    expect(onCommandClick).toHaveBeenCalledTimes(1);
    expect(onCommandClick.mock.calls[0]![0]).toMatchObject({ name: 'model' });
  });

  it('misses zones for presses on the title, greeting, and shortcut rows', () => {
    const { panel, onCommandClick } = makeClickablePanel(commands);
    const lines = panel.render(80).map(strip);
    for (const [i, line] of lines.entries()) {
      if (line.includes('/help') || line.includes('/model') || line.includes('/undo')) continue;
      expect(dispatchPress(panel, i), `row ${i} should miss`).toBe(false);
    }
    expect(onCommandClick).not.toHaveBeenCalled();
  });

  it('tracks the scrolled window: zones follow the visible command rows', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      name: `cmd-${String.fromCharCode(97 + i)}`,
      description: `Command ${i}`,
    }));
    const { panel, onCommandClick } = makeClickablePanel(many, { maxVisible: 8 });
    const initialLines = panel.render(80).map(strip);
    expect(initialLines.some((line) => line.includes('/cmd-a'))).toBe(false);
    expect([...panel.hitZones()]).toEqual([]); // command rows all below the window

    // Wheel-scroll down: five ticks × 3 rows = 15 (wheel must keep working
    // with zones declared).
    for (let i = 0; i < 5; i++) {
      panel.handleMouse({ type: 'wheel', button: 65, col: 1, row: 1, slotRelative: false });
    }
    const lines = panel.render(80).map(strip);
    expect(lines.some((line) => line.includes('/cmd-a'))).toBe(true);

    const zones = [...panel.hitZones()];
    expect(zones.length).toBeGreaterThan(0);
    for (const zone of zones) {
      expect(zone.row).toBeGreaterThanOrEqual(1);
      expect(zone.row).toBeLessThanOrEqual(8);
      expect(lines[zone.row]).toContain('/cmd-');
    }
    // Dispatch through a zone still resolves the correct command.
    const firstZone = zones[0]!;
    expect(dispatchPress(panel, firstZone.row)).not.toBe(false);
    expect(onCommandClick.mock.calls[0]![0]).toMatchObject({ name: 'cmd-a' });
  });

  it('underlines the hovered command row and restores the plain render on leave', () => {
    const prevLevel = chalk.level;
    chalk.level = 1;
    try {
      const { panel } = makeClickablePanel(commands);
      const plain = panel.render(80);
      const zones = [...panel.hitZones()];

      expect(panel.setHoveredZone(zones[1]!.id)).not.toBe(false);
      const hovered = panel.render(80);
      const hoveredRow = hovered[zones[1]!.row]!;
      expect(hoveredRow).toContain('[4m'); // SGR underline on the hovered row
      expect(strip(hoveredRow)).toBe(strip(plain[zones[1]!.row]!));

      expect(panel.setHoveredZone(null)).not.toBe(false);
      expect(panel.render(80)).toEqual(plain); // byte-identical keyboard-only render
      expect(panel.setHoveredZone(null)).toBe(false); // unchanged → skip re-render
    } finally {
      chalk.level = prevLevel;
    }
  });
});
