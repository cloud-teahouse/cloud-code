import type { ModelAlias } from '@cloud-code/sdk';
import {
  type Component,
  Container,
  setKittyProtocolActive,
  type Terminal,
  TUI,
  visibleWidth,
} from '@cloud-code/pi-tui';
import chalk from 'chalk';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { EditorSlotContainer } from '#/tui/components/chrome/gutter-container';
import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';
import { CHROME_GUTTER } from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';
import { darkColors, lightColors } from '#/tui/theme/colors';

const ESC = String.fromCodePoint(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replaceAll(SGR, '');
const TAB = '\t';
const RIGHT = `${ESC}[C`;
// chalk.bgHex(colors.primary) → background truecolor for #4FA8FF.
const PRIMARY_BG = '48;2;79;168;255';

function model(displayName: string, provider: string): ModelAlias {
  return {
    provider,
    model: displayName.toLowerCase().replaceAll(' ', '-'),
    maxContextSize: 200_000,
    displayName,
    capabilities: ['thinking'],
  } as unknown as ModelAlias;
}

function make(): {
  component: TabbedModelSelectorComponent;
  onSelect: ReturnType<typeof vi.fn>;
} {
  const onSelect = vi.fn();
  const component = new TabbedModelSelectorComponent({
    models: {
      k2: model('Kimi K2', 'managed:kimi-code'),
      gpt: model('GPT-5', 'openai'),
    },
    currentValue: 'k2',
    currentThinkingEffort: 'off',
    onSelect,
    onCancel: vi.fn(),
  });
  component.focused = true;
  return { component, onSelect };
}

/** Minimal Terminal stub for a real TUI mount: frames are discarded, input
 * is pushed by the test as raw SGR bytes. */
class FakeTerminal implements Terminal {
  readonly columns: number;
  readonly rows: number;
  private inputHandler: ((data: string) => void) | undefined;
  constructor(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
  }
  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.inputHandler = onInput;
  }
  stop(): void {
    this.inputHandler = undefined;
  }
  drainInput(): Promise<void> {
    return Promise.resolve();
  }
  write(_data: string): void {}
  get kittyProtocolActive(): boolean {
    return false;
  }
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
  enterAltScreen(): void {}
  exitAltScreen(): void {}
  setMouseReporting(_enabled: boolean): void {}
  sendInput(data: string): void {
    this.inputHandler?.(data);
  }
}

class StubComponent implements Component {
  readonly lines: string[];
  constructor(lines: string[]) {
    this.lines = lines;
  }
  invalidate(): void {}
  render(): string[] {
    return this.lines;
  }
}

describe('TabbedModelSelectorComponent', () => {
  let previousLevel: typeof chalk.level;
  const previousPalette = currentTheme.palette;
  beforeAll(() => {
    previousLevel = chalk.level;
    chalk.level = 3;
    currentTheme.setPalette(darkColors);
  });
  afterAll(() => {
    chalk.level = previousLevel;
    currentTheme.setPalette(previousPalette);
  });

  it('renders an "All" + per-provider tab strip', () => {
    const out = strip(make().component.render(120).join('\n'));
    expect(out).toContain('All');
    expect(out).toContain('Kimi Code');
    expect(out).toContain('openai');
  });

  it('highlights the active tab with a filled background (AskUserQuestion style)', () => {
    // currentValue k2 → the active tab is "Kimi Code"; its cell carries the
    // primary background SGR.
    const raw = make().component.render(120).join('\n');
    expect(raw).toContain(PRIMARY_BG);
  });

  it('repaints the tab strip from the current theme palette without remounting', () => {
    const { component } = make();
    const stripLine = (lines: string[]): string =>
      lines.find((l) => l.includes('All') && l.includes('openai')) ?? '';
    const previous = currentTheme.palette;
    try {
      currentTheme.setPalette(darkColors);
      const darkStrip = stripLine(component.render(120));
      currentTheme.setPalette(lightColors);
      const lightStrip = stripLine(component.render(120));
      // The strip is drawn from currentTheme.palette at render time; a
      // construction-time palette snapshot would render the same strip after
      // the switch.
      expect(darkStrip).not.toBe(lightStrip);
    } finally {
      currentTheme.setPalette(previous);
    }
  });

  it('opens on the All tab by default (showing every provider\'s models)', () => {
    const out = strip(make().component.render(120).join('\n'));
    expect(out).toContain('Kimi K2');
    expect(out).toContain('GPT-5');
  });

  it('cycles provider tabs with Tab', () => {
    const { component } = make();
    // tabs = [All, kimi, openai]; active starts on All.
    // Two Tabs → openai, whose list shows GPT-5 and not Kimi K2.
    component.handleInput(TAB);
    component.handleInput(TAB);
    const out = strip(component.render(120).join('\n'));
    expect(out).toContain('GPT-5');
    expect(out).not.toContain('Kimi K2');
  });

  it('forwards thinking toggle (←/→) and selection (Enter) to the active tab', () => {
    const { component, onSelect } = make();
    component.handleInput(RIGHT); // toggle thinking on for k2
    component.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith({ alias: 'k2', thinking: 'on' });
  });

  it('frames the tab strip with a blank line above and below it', () => {
    const lines = make().component.render(120).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('navigate') && l.includes('Esc cancel'));
    const stripIdx = lines.findIndex((l) => l.includes('All') && l.includes('openai'));
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    expect(lines[hintIdx + 1]).toBe(''); // blank between hint and tabs
    expect(stripIdx).toBe(hintIdx + 2);
    expect(lines[stripIdx + 1]).toBe(''); // blank between tabs and list
  });

  it('mentions the Tab provider switch first in the hint line', () => {
    const lines = make().component.render(120).map(strip);
    const hint = lines.find((l) => l.includes('navigate') && l.includes('Esc cancel'));
    expect(hint).toBeDefined();
    expect(hint).toContain('Tab toggle provider');
    // It comes first, before the navigation hint.
    expect(hint!.indexOf('Tab toggle provider')).toBeLessThan(hint!.indexOf('↑↓ navigate'));
  });

  it('renders the default title, and a custom title when provided', () => {
    expect(strip(make().component.render(120).join('\n'))).toContain('Select a model');

    const titled = new TabbedModelSelectorComponent({
      models: { k2: model('Kimi K2', 'managed:kimi-code') },
      currentValue: 'k2',
      currentThinkingEffort: 'off',
      title: ' Select a secondary model (subagents)',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const out = strip(titled.render(120).join('\n'));
    expect(out).toContain('Select a secondary model (subagents)');
  });

  it('keeps the tab strip between hint and list when a warning line is present', () => {
    const component = new TabbedModelSelectorComponent({
      models: {
        k2: model('Kimi K2', 'managed:kimi-code'),
        gpt: model('GPT-5', 'openai'),
      },
      currentValue: 'k2',
      currentThinkingEffort: 'off',
      warning: 'Switching may increase token usage.',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const lines = component.render(120).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('navigate') && l.includes('Esc cancel'));
    expect(lines[hintIdx + 1]).toContain('Switching may increase token usage.');
    expect(lines[hintIdx + 2]).toBe(''); // blank between warning and tabs
    const stripIdx = lines.findIndex((l) => l.includes('All') && l.includes('openai'));
    expect(stripIdx).toBe(hintIdx + 3);
    expect(lines[stripIdx + 1]).toBe(''); // blank between tabs and list
    expect(lines.findIndex((l) => l.includes('Kimi K2'))).toBeGreaterThan(stripIdx);
  });

  describe('click-to-select (left press)', () => {
    // Row layout with multiple tabs: 0 divider, 1 title, 2 hint, 3 blank,
    // 4 tab strip, 5 blank, 6-8 search box, then the active tab's model rows
    // (9 Kimi K2, 10 GPT-5). The strip + blank shift the inner selector's
    // rows down by 2.
    it('translates press rows past the tab strip before forwarding', () => {
      const { component, onSelect } = make();
      component.render(120); // primes the render width used by the hit test
      const press = (row: number, button = 0): void => {
        component.handleMouse({ type: 'press', button, col: 1, row, slotRelative: false });
      };
      const text = (): string => strip(component.render(120).join('\n'));

      expect(text()).toContain('❯ Kimi K2');

      press(10); // GPT-5 row
      expect(text()).toContain('❯ GPT-5');

      press(9); // Kimi K2 row
      expect(text()).toContain('❯ Kimi K2');

      // Click only moves the cursor; it never confirms.
      expect(onSelect).not.toHaveBeenCalled();

      // The tab strip, the blanks, the search box, and the header are not
      // model rows.
      for (const row of [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8]) {
        press(row);
        expect(text(), `row ${String(row)}`).toContain('❯ Kimi K2');
      }
      press(10, 2); // right button
      expect(text()).toContain('❯ Kimi K2');
    });

    it('switches tabs when a tab cell is clicked', () => {
      const { component } = make();
      const lines = component.render(120).map(strip);
      const stripRow = lines.findIndex((l) => l.includes('All') && l.includes('openai'));
      expect(stripRow).toBeGreaterThanOrEqual(0);
      const openaiCol = lines[stripRow]!.indexOf('openai') + 1;

      component.handleMouse({ type: 'press', button: 0, col: openaiCol, row: stripRow, slotRelative: false });
      const text = (): string => strip(component.render(120).join('\n'));
      // The openai tab is now active: only its model is listed.
      expect(text()).toContain('❯ GPT-5');
      expect(text()).not.toContain('Kimi K2');

      // Clicking the All tab brings both models back.
      const allCol = strip(component.render(120).map(strip)[stripRow]!).indexOf('All') + 1;
      component.handleMouse({ type: 'press', button: 0, col: allCol, row: stripRow, slotRelative: false });
      expect(text()).toContain('Kimi K2');
      expect(text()).toContain('GPT-5');
    });

    it('underlines the hovered tab on motion and clears on leave', () => {
      const { component } = make();
      const baseline = component.render(120).join('\n');
      const lines = component.render(120).map(strip);
      const stripRow = lines.findIndex((l) => l.includes('All') && l.includes('openai'));
      const openaiCol = lines[stripRow]!.indexOf('openai') + 1;

      const motion = (row: number, col: number): void | boolean =>
        component.handleMouse({ type: 'motion', button: 3, col, row, slotRelative: false });

      expect(motion(stripRow, openaiCol)).not.toBe(false);
      expect(component.render(120).join('\n')).toContain('[4m');
      expect(motion(stripRow, openaiCol)).toBe(false); // unchanged → frame skipped

      motion(0, 1); // header: off the strip → cleared
      expect(component.render(120).join('\n')).toBe(baseline);

      // Motion over a model row hovers the inner list (underline there).
      const gptRow = component.render(120).map(strip).findIndex((l) => l.includes('GPT-5'));
      expect(motion(gptRow, 3)).not.toBe(false);
      const hovered = component.render(120).join('\n');
      expect(hovered).toContain('[4m');
    });
  });

  describe('updateModels (live refresh)', () => {
    const text = (component: TabbedModelSelectorComponent): string =>
      strip(component.render(120).join('\n'));

    it('adds and removes rows in place without resetting the cursor', () => {
      const { component } = make();
      // Move the cursor onto GPT-5 on the All tab.
      component.handleInput(`${ESC}[B`);
      expect(text(component)).toContain('❯ GPT-5');

      component.updateModels({
        gpt: model('GPT-5', 'openai'),
        k2: model('Kimi K2', 'managed:kimi-code'),
        turbo: model('Kimi Turbo', 'managed:kimi-code'),
      });

      const out = text(component);
      expect(out).toContain('Kimi Turbo'); // new row landed
      // The cursor followed the GPT-5 row to its new position.
      expect(out).toContain('❯ GPT-5');
    });

    it('preserves the search query across a refresh', () => {
      const { component } = make();
      component.handleInput('/'); // focus the search box, then type
      for (const ch of 'GPT') component.handleInput(ch);
      expect(text(component)).toContain('1 / 2'); // filtered to one of two

      component.updateModels({
        k2: model('Kimi K2', 'managed:kimi-code'),
        gpt: model('GPT-5', 'openai'),
        turbo: model('Kimi Turbo', 'managed:kimi-code'),
      });

      const out = text(component);
      expect(out).toContain('1 / 3'); // query intact, total grew
      expect(out).toContain('❯ GPT-5');
      expect(out).not.toContain('Kimi Turbo'); // filtered out by the query
    });

    it('keeps the active provider tab when it survives, and drops vanished ones', () => {
      const { component } = make();
      component.handleInput(TAB); // → kimi tab
      expect(text(component)).not.toContain('GPT-5');

      // kimi survives, openai vanishes, a new provider appears.
      component.updateModels({
        k2: model('Kimi K2', 'managed:kimi-code'),
        claude: model('Claude', 'anthropic'),
      });

      let out = text(component);
      expect(out).toContain('Kimi K2'); // still on the kimi tab
      expect(out).not.toContain('GPT-5');
      expect(out).not.toContain('Claude'); // anthropic tab exists but is not active
      expect(out).toContain('anthropic'); // new tab on the strip
      expect(out).not.toContain('openai'); // vanished tab is gone

      // Tab cycling reflects the new tab set: All → kimi → anthropic.
      component.handleInput(TAB);
      out = text(component);
      expect(out).toContain('Claude');
    });

    it('falls back to the All tab when the active provider vanishes', () => {
      const { component } = make();
      component.handleInput(TAB); // → kimi tab
      component.handleInput(TAB); // → openai tab
      expect(text(component)).toContain('❯ GPT-5');

      component.updateModels({ k2: model('Kimi K2', 'managed:kimi-code') });

      const out = text(component);
      expect(out).toContain('❯ Kimi K2'); // back on All with the surviving model
      expect(out).not.toContain('openai');
    });
  });

  describe('manage keys (Alt+E/Alt+D/Alt+S) through the tab wrapper', () => {
    afterEach(() => {
      setKittyProtocolActive(false);
    });

    function makeManaged() {
      const manage = {
        isCustom: (alias: string) => alias.startsWith('acme/'),
        onEdit: vi.fn(),
        onDelete: vi.fn(),
        onGuard: vi.fn(),
      };
      const onSessionOnlySelect = vi.fn();
      const component = new TabbedModelSelectorComponent({
        models: {
          'acme/m1': model('M1', 'acme'),
          k2: model('Kimi K2', 'managed:kimi-code'),
        },
        currentValue: 'acme/m1',
        currentThinkingEffort: 'off',
        onSelect: vi.fn(),
        onSessionOnlySelect,
        manage,
        onCancel: vi.fn(),
      });
      component.focused = true;
      return { component, manage, onSessionOnlySelect };
    }

    it('Alt+E edits a custom row and guards a managed row (legacy encoding)', () => {
      const { component, manage } = makeManaged();
      component.handleInput(`${ESC}e`); // acme/m1 selected (current)
      expect(manage.onEdit).toHaveBeenCalledWith('acme/m1');

      component.handleInput(`${ESC}[B`); // managed row
      component.handleInput(`${ESC}e`);
      expect(manage.onGuard).toHaveBeenCalledWith('k2');
      expect(manage.onEdit).toHaveBeenCalledTimes(1);
    });

    it('Alt+D arms the inline delete on a custom row and guards a managed row', () => {
      const { component, manage } = makeManaged();
      component.handleInput(`${ESC}d`);
      const out = strip(component.render(120).join('\n'));
      expect(out).toContain('Delete model "acme/m1"? [y/N]');

      component.handleInput('n'); // disarm
      component.handleInput(`${ESC}[B`); // managed row
      component.handleInput(`${ESC}d`);
      expect(manage.onGuard).toHaveBeenCalledWith('k2');
      expect(strip(component.render(120).join('\n'))).not.toContain('Delete model');
    });

    it('Alt+S applies session-only on the selected row', () => {
      const { component, onSessionOnlySelect } = makeManaged();
      component.handleInput(`${ESC}s`);
      expect(onSessionOnlySelect).toHaveBeenCalledWith({ alias: 'acme/m1', thinking: 'off' });
    });

    // Regression: terminals that answer the Kitty keyboard query yet deliver
    // Alt+letter as legacy ESC-prefixed bytes silently killed the manage keys
    // (pi-tui's matchesKey gates the legacy form on the protocol being off).
    it('Alt+E/Alt+D/Alt+S still work when Kitty is active but bytes are legacy', () => {
      setKittyProtocolActive(true);
      const { component, manage, onSessionOnlySelect } = makeManaged();

      component.handleInput(`${ESC}e`);
      expect(manage.onEdit).toHaveBeenCalledWith('acme/m1');

      component.handleInput(`${ESC}d`);
      expect(strip(component.render(120).join('\n'))).toContain('Delete model "acme/m1"?');
      component.handleInput('n');

      component.handleInput(`${ESC}s`);
      expect(onSessionOnlySelect).toHaveBeenCalled();

      component.handleInput(`${ESC}[B`); // managed row
      component.handleInput(`${ESC}e`);
      expect(manage.onGuard).toHaveBeenCalledWith('k2');
    });

    it('CSI-u Alt encodings work with Kitty active', () => {
      setKittyProtocolActive(true);
      const { component, manage } = makeManaged();
      component.handleInput(`${ESC}[101;3u`); // alt+e
      expect(manage.onEdit).toHaveBeenCalledWith('acme/m1');
      component.handleInput(`${ESC}[100;3u`); // alt+d
      expect(strip(component.render(120).join('\n'))).toContain('Delete model "acme/m1"?');
    });

    it('leaves plain Escape and typing untouched when Kitty is active', () => {
      setKittyProtocolActive(true);
      const onCancel = vi.fn();
      const component = new TabbedModelSelectorComponent({
        models: { k2: model('Kimi K2', 'managed:kimi-code') },
        currentValue: 'k2',
        currentThinkingEffort: 'off',
        onSelect: vi.fn(),
        onCancel,
      });
      component.focused = true;
      component.handleInput(ESC);
      expect(onCancel).toHaveBeenCalled();
    });
  });

  describe('tab-strip clicks through the real TUI mount (gutter inset)', () => {
    it('hits a tab cell from its first to its last terminal column', async () => {
      const COLS = 40;
      const ROWS = 24;
      const terminal = new FakeTerminal(COLS, ROWS);
      const tui = new TUI(terminal);
      const scroll = new StubComponent(['msg-1', 'msg-2', 'msg-3']);
      const { component } = make();
      // Mirror mountIntoEditorSlot: the dialog replaces the editor inside the
      // EditorSlotContainer (gutter on both sides), with the panel-style top
      // separator on.
      const editorContainer = new EditorSlotContainer(CHROME_GUTTER, CHROME_GUTTER);
      editorContainer.topSeparator = true;
      editorContainer.addChild(component);
      const slot = new Container();
      slot.addChild(editorContainer);
      const root = new Container();
      root.addChild(scroll);
      root.addChild(slot);
      tui.addChild(root);
      tui.setFullscreen(true);
      tui.setLayoutRegions({ scroll, slot });
      tui.setFocus(component);
      tui.start();

      const flush = async (): Promise<void> => {
        tui.requestRender(true);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      };
      await flush();

      const innerWidth = COLS - CHROME_GUTTER * 2;
      /** Strip geometry in terminal-absolute cells, derived from the
       * component's own render at the mounted width (the separator row sits
       * above it inside the slot). */
      const stripGeometry = (): { row: number; line: string } => {
        const lines = component.render(innerWidth).map(strip);
        const stripIdx = lines.findIndex((l) => l.includes('All') && l.includes('openai'));
        expect(stripIdx).toBeGreaterThanOrEqual(0);
        const slotRows = 1 + lines.length; // top separator + dialog
        expect(slotRows).toBeLessThan(ROWS); // this fixture never clips the slot
        const viewportHeight = ROWS - slotRows;
        return { row: viewportHeight + 1 + 1 + stripIdx, line: lines[stripIdx]! };
      };
      /** First terminal column of the tab cell carrying `label`. */
      const cellFirstCol = (line: string, label: string): number =>
        CHROME_GUTTER + line.indexOf(` ${label}`) + 1;
      const text = (): string => strip(component.render(innerWidth).join('\n'));
      const click = (col: number, row: number): void => {
        terminal.sendInput(`${ESC}[<0;${String(col)};${String(row)}M`);
      };

      // The FIRST terminal column of the openai cell switches to openai.
      let geo = stripGeometry();
      click(cellFirstCol(geo.line, 'openai'), geo.row);
      expect(text()).toContain('❯ GPT-5');
      expect(text()).not.toContain('Kimi K2');

      // The LAST terminal column of the Kimi Code cell switches to it. While
      // cols arrived terminal-absolute this column was dead: it translated
      // one cell right, onto the separator past the cell.
      await flush();
      geo = stripGeometry();
      const kimiFirst = cellFirstCol(geo.line, 'Kimi Code');
      click(kimiFirst + visibleWidth(' Kimi Code ') - 1, geo.row);
      expect(text()).toContain('Kimi K2');
      expect(text()).not.toContain('GPT-5');

      // The strip's leading space (one terminal column left of the first
      // cell) is chrome, not a tab: it must not switch.
      await flush();
      geo = stripGeometry();
      click(cellFirstCol(geo.line, 'All') - 1, geo.row);
      expect(text()).toContain('Kimi K2');
      expect(text()).not.toContain('GPT-5');

      tui.stop();
    });
  });
});

describe('TabbedModelSelectorComponent subagent assignment', () => {
  it('renders the subagent badge through the wrapper and forwards Alt+A', () => {
    const onAssign = vi.fn();
    const component = new TabbedModelSelectorComponent({
      models: {
        k2: model('Kimi K2', 'managed:kimi-code'),
        gpt: model('GPT-5', 'openai'),
      },
      currentValue: 'k2',
      currentThinkingEffort: 'off',
      onSelect: vi.fn(),
      subagent: { current: () => ({ alias: 'gpt' }), onAssign },
      onCancel: vi.fn(),
    });
    component.focused = true;

    const out = component.render(100).map(strip).join('\n');
    expect(out).toContain('← subagent');
    expect(out).toContain('Alt+A subagent');

    // Alt+A on the cursor row (k2) assigns it with the committed draft effort.
    component.handleInput(`${ESC}a`);
    expect(onAssign).toHaveBeenCalledWith({ alias: 'k2', thinking: 'off' });
  });
});
