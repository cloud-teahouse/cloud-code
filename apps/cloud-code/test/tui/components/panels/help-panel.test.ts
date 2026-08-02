import { describe, it, expect, vi } from 'vitest';

import type { CloudCodeSlashCommand } from '#/tui/commands/index';
import { HelpPanelComponent } from '#/tui/components/dialogs/help-panel';

function cmd(name: string, description: string, aliases: string[] = []): CloudCodeSlashCommand {
  return {
    name,
    aliases,
    description,
  };
}

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('HelpPanelComponent', () => {
  it('renders keyboard shortcuts + slash commands sections', () => {
    const panel = new HelpPanelComponent({
      commands: [cmd('exit', 'Exit', ['quit', 'q'])],
      onClose: () => {},
    });
    const out = strip(panel.render(80).join('\n'));
    expect(out).toMatch(/help/);
    expect(out).toMatch(/Keyboard shortcuts/);
    expect(out).toMatch(/Shift-Tab/);
    expect(out).toMatch(/Ctrl-O/);
    expect(out).toMatch(/Shift-Enter \/ Ctrl-J/);
    expect(out).toMatch(/Slash commands/);
    expect(out).toMatch(/\/exit \(\/quit, \/q\)/);
    expect(out).toMatch(/Exit/);
  });

  it('sorts unprefixed commands before skill commands and by name within each group', () => {
    const panel = new HelpPanelComponent({
      commands: [
        cmd('zebra', 'Z'),
        cmd('skill:bravo', 'B'),
        cmd('alpha', 'A'),
        cmd('mcp-config', 'M'),
      ],
      onClose: () => {},
      // Sorting is asserted over the whole list, so opt out of scroll
      // windowing (the fallback window is 24 rows).
      maxVisible: 200,
    });
    const out = strip(panel.render(80).join('\n'));
    const alphaIdx = out.indexOf('/alpha');
    const mcpConfigIdx = out.indexOf('/mcp-config');
    const zebraIdx = out.indexOf('/zebra');
    const skillBravoIdx = out.indexOf('/skill:bravo');
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeLessThan(mcpConfigIdx);
    expect(mcpConfigIdx).toBeLessThan(zebraIdx);
    expect(zebraIdx).toBeLessThan(skillBravoIdx);
  });

  it('Escape fires onClose', () => {
    const onClose = vi.fn();
    const panel = new HelpPanelComponent({
      commands: [],
      onClose,
    });
    panel.handleInput('\u001B'); // Esc
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('q / Enter also close the panel', () => {
    const onClose = vi.fn();
    const panel = new HelpPanelComponent({
      commands: [],
      onClose,
    });
    panel.handleInput('q');
    panel.handleInput('\r');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('Backspace closes the panel (return-to-editing for the `?` shortcut flow)', () => {
    const onClose = vi.fn();
    const panel = new HelpPanelComponent({
      commands: [],
      onClose,
    });
    panel.handleInput('\u007F'); // Backspace
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clips to maxVisible with a "showing X-Y of Z" tail', () => {
    const many = Array.from({ length: 30 }, (_, i) => cmd(`cmd${String(i)}`, `Desc ${String(i)}`));
    const panel = new HelpPanelComponent({
      commands: many,
      onClose: () => {},
      maxVisible: 6,
    });
    const out = strip(panel.render(80).join('\n'));
    expect(out).toMatch(/showing 1-6 of/);
  });

  it('arrow keys shift the scroll window', () => {
    const many = Array.from({ length: 30 }, (_, i) => cmd(`cmd${String(i)}`, 'd'));
    const panel = new HelpPanelComponent({
      commands: many,
      onClose: () => {},
      maxVisible: 6,
    });
    panel.handleInput('\u001B[B'); // ↓
    panel.handleInput('\u001B[B'); // ↓
    const out = strip(panel.render(80).join('\n'));
    expect(out).toMatch(/showing 3-8 of/);
    panel.handleInput('\u001B[A'); // ↑
    const out2 = strip(panel.render(80).join('\n'));
    expect(out2).toMatch(/showing 2-7 of/);
  });

  it('mouse wheel scrolls the window (hover-to-scroll)', () => {
    const many = Array.from({ length: 30 }, (_, i) => cmd(`cmd${String(i)}`, 'd'));
    const panel = new HelpPanelComponent({
      commands: many,
      onClose: () => {},
      maxVisible: 6,
    });
    const wheel = (button: 64 | 65) => ({ type: 'wheel' as const, button, col: 5, row: 3, slotRelative: true });
    panel.handleMouse(wheel(65)); // +3
    const out = strip(panel.render(80).join('\n'));
    expect(out).toMatch(/showing 4-9 of/);
    panel.handleMouse(wheel(64)); // -3
    const out2 = strip(panel.render(80).join('\n'));
    expect(out2).toMatch(/showing 1-6 of/);
    // Clamps at the top.
    panel.handleMouse(wheel(64));
    expect(strip(panel.render(80).join('\n'))).toMatch(/showing 1-6 of/);
  });

  it('caps the list at terminal rows minus chrome so the title and borders stay visible', () => {
    const many = Array.from({ length: 30 }, (_, i) => cmd(`cmd${String(i)}`, `Desc ${String(i)}`));
    const panel = new HelpPanelComponent({
      commands: many,
      onClose: () => {},
      terminalRows: () => 15,
    });
    const lines = panel.render(80);
    // maxVisible = 15 - 6 (borders + scroll tail here, slot separator +
    // footer in the host) = 9 list rows, +3 panel chrome rows. The host
    // chrome (3 more) then fills the 15-row viewport exactly — nothing
    // spills over the top.
    expect(lines.length).toBe(9 + 3);
    const out = strip(lines.join('\n'));
    expect(out).toMatch(/showing 1-9 of/);
    // Title, greeting and section headers are at the top of the scrollable
    // content — at scrollTop 0 they must survive windowing.
    expect(out).toMatch(/help/);
    expect(out).toMatch(/Keyboard shortcuts/);
    // Borders bracket the window instead of being pushed off-screen.
    expect(strip(lines[0] ?? '')).toMatch(/^─+$/);
    expect(strip(lines.at(-1) ?? '')).toMatch(/^─+$/);
  });

  it('re-caps the window live when the terminal shrinks while the panel is open', () => {
    const many = Array.from({ length: 30 }, (_, i) => cmd(`cmd${String(i)}`, 'd'));
    let rows = 40;
    const panel = new HelpPanelComponent({
      commands: many,
      onClose: () => {},
      terminalRows: () => rows,
    });
    // Scroll deep into the list at the large window (40 - 6 = 34 rows;
    // the ~50 content rows still overflow it, so windowing is active).
    for (let i = 0; i < 20; i++) panel.handleInput('\u001B[B'); // ↓
    rows = 12; // resize while open
    const lines = panel.render(80);
    const out = strip(lines.join('\n'));
    const m = /showing (\d+)-(\d+) of (\d+)/.exec(out);
    expect(m).not.toBeNull();
    const from = Number(m?.[1]);
    const to = Number(m?.[2]);
    const total = Number(m?.[3]);
    // Window shrank to 12 - 6 = 6 rows and scrollTop clamped inside content.
    expect(to - from + 1).toBe(6);
    expect(to).toBeLessThanOrEqual(total);
    expect(lines.length).toBe(6 + 3);
  });

  it('explicit maxVisible wins over terminalRows', () => {
    const many = Array.from({ length: 30 }, (_, i) => cmd(`cmd${String(i)}`, 'd'));
    const panel = new HelpPanelComponent({
      commands: many,
      onClose: () => {},
      maxVisible: 6,
      terminalRows: () => 40,
    });
    expect(strip(panel.render(80).join('\n'))).toMatch(/showing 1-6 of/);
  });

  it('falls back to 24 visible rows when no terminal height is provided', () => {
    const many = Array.from({ length: 40 }, (_, i) => cmd(`cmd${String(i)}`, 'd'));
    const panel = new HelpPanelComponent({
      commands: many,
      onClose: () => {},
    });
    expect(strip(panel.render(80).join('\n'))).toMatch(/showing 1-24 of/);
  });

  it('wheel scrolling still works with a terminal-rows-derived window', () => {
    const many = Array.from({ length: 30 }, (_, i) => cmd(`cmd${String(i)}`, 'd'));
    const panel = new HelpPanelComponent({
      commands: many,
      onClose: () => {},
      terminalRows: () => 15, // window = 9
    });
    panel.handleMouse({ type: 'wheel', button: 65, col: 5, row: 3, slotRelative: true }); // +3
    expect(strip(panel.render(80).join('\n'))).toMatch(/showing 4-12 of/);
  });
});
