import { describe, expect, it, vi, beforeAll, afterAll, afterEach } from 'vitest';
import chalk from 'chalk';
import { setKittyProtocolActive } from '@cloud-code/pi-tui';

import {
  ChoicePickerComponent,
  type ChoiceOption,
  type ChoicePickerOptions,
} from '#/tui/components/dialogs/choice-picker';
import { EditorSelectorComponent } from '#/tui/components/dialogs/editor-selector';
import { PermissionSelectorComponent } from '#/tui/components/dialogs/permission-selector';
import { SettingsSelectorComponent } from '#/tui/components/dialogs/settings-selector';
import { ThemeSelectorComponent } from '#/tui/components/dialogs/theme-selector';
import { UpdatePreferenceSelectorComponent } from '#/tui/components/dialogs/update-preference-selector';
import { getActiveLocale, setLocalePreference } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { darkColors } from '#/tui/theme/colors';

const ANSI_SGR = /\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

describe('ChoicePickerComponent', () => {
  it('uses the model-dialog header vocabulary (capitalized keys, visible search box)', () => {
    const picker = new ChoicePickerComponent({
      title: 'Add provider',
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
      searchable: true,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const lines = picker.render(120).map(strip);

    const titleIdx = lines.findIndex((l) => l.includes('Add provider'));
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    // The old "(type to search)" title suffix is replaced by the box itself.
    expect(lines[titleIdx]).not.toContain('type to search');
    // Hint sits directly under the title and uses lowercase key vocabulary.
    const hint = lines[titleIdx + 1];
    expect(hint).toContain('↑↓ navigate');
    expect(hint).toContain('Enter select');
    expect(hint).toContain('/ ↑ search');
    expect(hint).toContain('Esc cancel');
    expect(hint).not.toContain('enter select');
    expect(hint).not.toContain('esc cancel');
    // Blank line separates the hint from the search box, like the model dialog.
    expect(lines[titleIdx + 2]).toBe('');
    // The always-visible search box shows the placeholder while unfocused.
    expect(lines[titleIdx + 3]).toContain('╭');
    expect(lines[titleIdx + 4]).toContain('⌕ Search…');
    expect(lines[titleIdx + 5]).toContain('╰');
  });

  it('focuses the search box on `/` (typing stays inert until focused), and layers Esc clear → unfocus → cancel', () => {
    const onCancel = vi.fn();
    const picker = new ChoicePickerComponent({
      title: 'Add provider',
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
      searchable: true,
      onSelect: vi.fn(),
      onCancel,
    });
    const ESC = String.fromCodePoint(27);

    // Typing while the box is unfocused neither seeds the query nor focuses.
    picker.handleInput('z');
    let lines = picker.render(120).map(strip);
    expect(lines.some((l) => l.includes('⌕ z'))).toBe(false);
    expect(lines.some((l) => l.includes('❯ Alpha'))).toBe(true);

    // `/` focuses without seeding a query.
    picker.handleInput('/');
    lines = picker.render(120).map(strip);
    expect(lines.find((l) => l.includes('/ ↑ search'))).toBeUndefined();
    expect(lines.some((l) => l.includes('Esc back to list'))).toBe(true);
    expect(lines.some((l) => l.includes('⌕ Search…'))).toBe(true);

    // Typing filters the list once focused.
    picker.handleInput('a');
    picker.handleInput('l');
    lines = picker.render(120).map(strip);
    expect(lines.some((l) => l.includes('⌕ al'))).toBe(true);
    expect(lines.some((l) => l.includes('❯ Alpha'))).toBe(true);
    expect(lines.some((l) => l.includes('Beta'))).toBe(false);

    // Esc 1 clears the query (box stays focused), Esc 2 unfocuses back to the
    // list, Esc 3 cancels.
    picker.handleInput(ESC);
    lines = picker.render(120).map(strip);
    expect(lines.some((l) => l.includes('⌕ al'))).toBe(false);
    expect(lines.some((l) => l.includes('Esc back to list'))).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();
    picker.handleInput(ESC);
    lines = picker.render(120).map(strip);
    expect(lines.some((l) => l.includes('/ ↑ search'))).toBe(true);
    expect(lines.some((l) => l.includes('Esc cancel'))).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();
    picker.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('focuses the search box on ↑ from the first option and on a click into the box', () => {
    const picker = new ChoicePickerComponent({
      title: 'Add provider',
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
      searchable: true,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const ESC = String.fromCodePoint(27);
    const focused = (): boolean =>
      picker.render(120).map(strip).some((l) => l.includes('Esc back to list'));

    // ↑ from the first option moves input focus into the box.
    picker.handleInput(`${ESC}[A`);
    expect(focused()).toBe(true);

    // Esc unfocuses back to the list.
    picker.handleInput(ESC);
    expect(focused()).toBe(false);

    // A press inside the search box focuses it (rows: 0 divider, 1 title,
    // 2 hint, 3 blank, 4-6 search box).
    picker.render(120); // prime the hit-test width
    picker.handleMouse({ type: 'press', button: 0, col: 3, row: 5, slotRelative: false });
    expect(focused()).toBe(true);
  });

  it('wraps the hint onto continuation lines at narrow widths instead of truncating', () => {
    const picker = new ChoicePickerComponent({
      title: 'Add provider',
      options: [{ value: 'a', label: 'Alpha' }],
      searchable: true,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const lines = picker.render(34).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('navigate'));
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    // All segments survive: the tail wraps onto the next line(s).
    const hintBlock = lines.slice(hintIdx, hintIdx + 3).join(' ');
    expect(hintBlock).toContain('Enter select');
    expect(hintBlock).toContain('/ ↑ search');
    expect(hintBlock).toContain('Esc cancel');
  });

  it('renders the search box placeholder and hints in zh-CN', () => {
    // Restore the concrete locale, not the preference: 'auto' re-runs system
    // detection, which may resolve to zh-CN on a Chinese-language machine.
    const original = getActiveLocale();
    setLocalePreference('zh-CN');
    try {
      const picker = new ChoicePickerComponent({
        title: 'Add provider',
        options: [{ value: 'a', label: 'Alpha' }],
        searchable: true,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      });
      const out = picker.render(120).map(strip).join('\n');
      expect(out).toContain('搜索…');
      expect(out).toContain('/ ↑ 搜索');

      picker.handleInput('/');
      const focused = picker.render(120).map(strip).join('\n');
      expect(focused).toContain('Esc 返回列表');
    } finally {
      setLocalePreference(original);
    }
  });

  it('renders optional descriptions below choice labels', () => {
    const picker = new ChoicePickerComponent({
      title: 'Select permission mode',
      options: [
        {
          value: 'manual',
          label: 'Manual',
          description: 'Ask before commands, edits, and other risky actions.',
        },
        {
          value: 'auto',
          label: 'Auto',
          description: 'Automatically approve tool actions and plan transitions.',
        },
      ],
      currentValue: 'manual',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = picker.render(120).map(strip);

    expect(out).toContain('  ❯ Manual ← current');
    expect(out).toContain('    Ask before commands, edits, and other risky actions.');
    expect(out).toContain('    Automatically approve tool actions and plan transitions.');
  });

  it('renders domain selector wrappers with their configured options', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();

    const editor = new EditorSelectorComponent({
      currentValue: 'vim',
      onSelect,
      onCancel,
    });
    expect(editor.render(120).map(strip)).toContain('  ❯ Vim ← current');

    const theme = new ThemeSelectorComponent({
      currentValue: 'light',
      onSelect,
      onCancel,
    });
    expect(theme.render(120).map(strip)).toContain('  ❯ Light ← current');

    const permission = new PermissionSelectorComponent({
      currentValue: 'manual',
      onSelect,
      onCancel,
    });
    expect(permission.render(120).map(strip)).toContain('  ❯ Manual ← current');

    const settings = new SettingsSelectorComponent({
      onSelect,
      onCancel,
    });
    const settingsOutput = settings.render(120).map(strip);
    expect(settingsOutput).toContain('  ❯ Model');
    expect(settingsOutput).toContain('    Switch the active model and thinking mode.');
    expect(settingsOutput).toContain('    Turn automatic CLI updates on or off.');

    const upgradePreference = new UpdatePreferenceSelectorComponent({
      currentValue: true,
      onSelect,
      onCancel,
    });
    const upgradePreferenceOutput = upgradePreference.render(120).map(strip);
    expect(upgradePreferenceOutput).toContain('  ❯ On ← current');
    expect(upgradePreferenceOutput).toContain('    Install new versions in the background.');
  });

  it('keeps Left/Right paging inert while the search box is the selected option', () => {
    const picker = new ChoicePickerComponent({
      title: 'Pick one',
      options: Array.from({ length: 12 }, (_, i) => ({
        value: `v${String(i)}`,
        label: `Option ${String(i)}`,
      })),
      searchable: true,
      pageSize: 4,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const ESC = String.fromCodePoint(27);
    const out = (): string => picker.render(120).map(strip).join('\n');

    // ←/→ page the list while the box is unselected.
    picker.handleInput(`${ESC}[C`);
    expect(out()).toContain('❯ Option 4');

    // With the box selected, arrows never move the list highlight; ↓ drops
    // back onto the first option, and ←/→ page again from there.
    picker.handleInput('/');
    picker.handleInput(`${ESC}[D`);
    picker.handleInput(`${ESC}[C`);
    expect(out()).toContain('❯ Option 4');
    expect(out()).toContain('Esc back to list');
    picker.handleInput(`${ESC}[B`);
    expect(out()).toContain('❯ Option 0');
    picker.handleInput(`${ESC}[C`);
    expect(out()).toContain('❯ Option 4');
  });

  it('keeps Space inert while the box is unfocused and routes it into the query once focused', () => {
    const onSelect = vi.fn();
    const picker = new ChoicePickerComponent({
      title: 'Select a provider',
      options: [
        { value: 'openai', label: 'OpenAI' },
        { value: 'azure', label: 'Azure OpenAI' },
      ],
      searchable: true,
      onSelect,
      onCancel: vi.fn(),
    });

    // Unfocused: Space neither selects nor seeds the query.
    picker.handleInput(' ');
    expect(onSelect).not.toHaveBeenCalled();
    let lines = picker.render(120).map(strip);
    expect(lines.some((l) => l.includes('❯ OpenAI'))).toBe(true);

    // Focused: Space is ordinary query text (the placeholder is replaced by
    // the query; a whitespace-only query keeps every option listed).
    picker.handleInput('/');
    picker.handleInput(' ');
    expect(onSelect).not.toHaveBeenCalled();
    lines = picker.render(120).map(strip);
    expect(lines.some((l) => l.includes('⌕ Search…'))).toBe(false); // query live in the box
    expect(lines.some((l) => l.includes('OpenAI'))).toBe(true);
    expect(lines.some((l) => l.includes('Azure OpenAI'))).toBe(true);
  });

  it('selects on Space when the list is not searchable', () => {
    const onSelect = vi.fn();
    const picker = new ChoicePickerComponent({
      title: 'Pick one',
      options: [{ value: 'a', label: 'Alpha' }],
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput(' ');
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('renders the selected option description in descriptionTone, others in textMuted', () => {
    const options: ChoiceOption[] = [
      { value: 'none', label: 'No attachment', description: 'Text feedback only' },
      {
        value: 'logs+codebase',
        label: 'Logs + codebase',
        description: 'Include your codebase for deeper diagnosis.',
        descriptionTone: 'warning',
      },
    ];

    const renderDescLine = (currentValue: string): string | undefined => {
      const picker = new ChoicePickerComponent({
        title: 'Share diagnostic info?',
        options,
        currentValue,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      });
      return picker.render(120).find((line) => strip(line).includes('Include your codebase'));
    };

    const warningLine = currentTheme.fg('warning', '    Include your codebase for deeper diagnosis.');
    const mutedLine = currentTheme.fg('textMuted', '    Include your codebase for deeper diagnosis.');

    // Selected option: description uses the configured tone.
    expect(renderDescLine('logs+codebase')).toBe(warningLine);
    // Unselected option: description falls back to textMuted.
    expect(renderDescLine('none')).toBe(mutedLine);
  });

  describe('click-to-select (left press)', () => {
    // Row layout at width 120 with no notice and no query: 0 divider,
    // 1 title, 2 hint, 3 blank, then each option occupying its label row plus
    // wrapped description rows:
    //   4-5 Alpha (label + description)   6 Beta (label only)
    //   7-8 Gamma (label + description)   9 blank   10 divider
    function makePicker(over: Partial<ChoicePickerOptions> = {}) {
      const onSelect = vi.fn();
      const picker = new ChoicePickerComponent({
        title: 'Pick one',
        options: [
          { value: 'a', label: 'Alpha', description: 'First option description.' },
          { value: 'b', label: 'Beta' },
          { value: 'c', label: 'Gamma', description: 'Third option description.' },
        ],
        onSelect,
        onCancel: vi.fn(),
        ...over,
      });
      picker.render(120); // primes the render width used by the hit test
      const press = (row: number, button = 0): void => {
        picker.handleMouse({ type: 'press', button, col: 1, row, slotRelative: false });
      };
      return { picker, onSelect, press };
    }

    it('selects the option whose row is hit, description rows included', () => {
      const { picker, onSelect, press } = makePicker();

      press(6); // Beta label row
      expect(picker.render(120).map(strip).join('\n')).toContain('❯ Beta');

      press(8); // Gamma description row — any row of an option counts
      expect(picker.render(120).map(strip).join('\n')).toContain('❯ Gamma');

      press(5); // Alpha description row
      expect(picker.render(120).map(strip).join('\n')).toContain('❯ Alpha');

      // Click only moves the cursor; it never confirms.
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('ignores presses on the header, below the last option, and non-left presses', () => {
      const { picker, press } = makePicker();

      press(6); // move to Beta first
      expect(picker.render(120).map(strip).join('\n')).toContain('❯ Beta');

      for (const row of [-1, 0, 1, 2, 3, 9, 10, 20]) {
        press(row);
        expect(picker.render(120).map(strip).join('\n'), `row ${String(row)}`).toContain('❯ Beta');
      }
      press(4, 2); // right button
      expect(picker.render(120).map(strip).join('\n')).toContain('❯ Beta');
    });

    it('shifts the list down by the notice rows', () => {
      const { picker, press } = makePicker({
        currentValue: 'b',
        notice: 'Careful now',
      });

      // 0 divider, 1 title, 2 hint, 3 notice, 4 blank, 5 Alpha label row.
      expect(picker.render(120).map(strip).join('\n')).toContain('❯ Beta');
      press(5);
      expect(picker.render(120).map(strip).join('\n')).toContain('❯ Alpha');

      // The notice row itself is not an option row.
      press(3);
      expect(picker.render(120).map(strip).join('\n')).toContain('❯ Alpha');
    });

    it('confirms the option when its already-selected row is clicked again', () => {
      const { picker, onSelect, press } = makePicker();

      press(6); // Beta label row: selects
      expect(onSelect).not.toHaveBeenCalled();
      press(6); // same row again: confirms like Enter
      expect(onSelect).toHaveBeenCalledWith('b');
    });

    it('confirms via a description row of the selected option too', () => {
      const { picker, onSelect, press } = makePicker({ currentValue: 'c' });

      // Gamma starts selected; any of its rows (label or description) confirms.
      press(8);
      expect(onSelect).toHaveBeenCalledWith('c');
    });
  });

  describe('hover underline (motion)', () => {
    // chalk auto-disables without a TTY; force colors on so the assertions
    // observe real SGR sequences.
    const prevLevel = chalk.level;
    beforeAll(() => {
      chalk.level = 1;
    });
    afterAll(() => {
      chalk.level = prevLevel;
    });

    // Same row layout as the click tests above.
    function makePicker(over: Partial<ChoicePickerOptions> = {}) {
      const onSelect = vi.fn();
      const picker = new ChoicePickerComponent({
        title: 'Pick one',
        options: [
          { value: 'a', label: 'Alpha', description: 'First option description.' },
          { value: 'b', label: 'Beta' },
          { value: 'c', label: 'Gamma', description: 'Third option description.' },
        ],
        onSelect,
        onCancel: vi.fn(),
        ...over,
      });
      picker.render(120);
      const motion = (row: number): void | boolean =>
        picker.handleMouse({ type: 'motion', button: 3, col: 1, row, slotRelative: false });
      return { picker, onSelect, motion };
    }

    it('underlines the hovered option and clears when the pointer leaves', () => {
      const { picker, motion } = makePicker();
      const rendered = (): string => picker.render(120).join('\n');
      const baseline = rendered();

      expect(motion(6)).not.toBe(false); // hover changed → re-render
      expect(rendered()).toContain('[4m'); // SGR underline on Beta's row

      // Same row again: nothing changed, the frame is skipped.
      expect(motion(6)).toBe(false);

      // Hover follows the pointer to another option (description row counts).
      expect(motion(8)).not.toBe(false);
      const gammaLine = rendered()
        .split('\n')
        .find((line) => line.includes('Gamma'));
      expect(gammaLine).toContain('[4m');
      const betaLine = rendered()
        .split('\n')
        .find((line) => line.includes('Beta'));
      expect(betaLine).not.toContain('[4m');

      // Moving onto the header clears the underline entirely.
      expect(motion(1)).not.toBe(false);
      expect(rendered()).toBe(baseline);

      // Row -1 (pointer left the component) also clears.
      motion(6);
      expect(rendered()).toContain('[4m');
      motion(-1);
      expect(rendered()).toBe(baseline);
    });

    it('keeps the keyboard-only render byte-identical when no mouse is used', () => {
      const { picker } = makePicker();
      const first = picker.render(120);
      const second = picker.render(120);
      expect(second).toEqual(first);
      expect(second.join('\n')).not.toContain('[4m');
    });

    it('does not move the cursor or confirm on motion', () => {
      const { picker, onSelect, motion } = makePicker();
      motion(6);
      expect(picker.render(120).map(strip).join('\n')).toContain('❯ Alpha');
      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  describe('Alt+S encoding (kitty-active legacy bytes)', () => {
    const ESC = String.fromCodePoint(27);
    afterEach(() => {
      setKittyProtocolActive(false);
    });

    function makeSessionOnlyPicker() {
      const onSelect = vi.fn();
      const onSessionOnlySelect = vi.fn();
      const onCancel = vi.fn();
      const picker = new ChoicePickerComponent({
        title: 'Pick one',
        options: [
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
        ],
        currentValue: 'a',
        onSelect,
        onSessionOnlySelect,
        onCancel,
      });
      return { picker, onSelect, onSessionOnlySelect, onCancel };
    }

    // Regression: terminals that answer the Kitty keyboard query yet deliver
    // Alt+letter as legacy ESC-prefixed bytes silently killed Alt+S (pi-tui's
    // matchesKey gates the legacy form on the protocol being off).
    it('Alt+S works when Kitty is active but bytes are legacy', () => {
      setKittyProtocolActive(true);
      const { picker, onSelect, onSessionOnlySelect } = makeSessionOnlyPicker();
      picker.handleInput(`${ESC}s`);
      expect(onSessionOnlySelect).toHaveBeenCalledWith('a');
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('CSI-u Alt+S works with Kitty active', () => {
      setKittyProtocolActive(true);
      const { picker, onSessionOnlySelect } = makeSessionOnlyPicker();
      picker.handleInput(`${ESC}[115;3u`); // alt+s
      expect(onSessionOnlySelect).toHaveBeenCalledWith('a');
    });

    it('leaves plain Escape untouched when Kitty is active', () => {
      setKittyProtocolActive(true);
      const { picker, onCancel } = makeSessionOnlyPicker();
      picker.handleInput(ESC);
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });
});
