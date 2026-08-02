import type { ModelAlias } from '@cloud-code/sdk';
import { visibleWidth } from '@cloud-code/pi-tui';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ModelSelectorComponent,
  providerDisplayName,
  type ModelSelectorOptions,
} from '#/tui/components/dialogs/model-selector';
import { getActiveLocale, setLocalePreference } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { darkColors } from '#/tui/theme/colors';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');
const ESC = String.fromCodePoint(27);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const LEFT = `${ESC}[D`;
const RIGHT = `${ESC}[C`;

function model(displayName: string, capabilities: string[] = ['thinking']): ModelAlias {
  return {
    provider: 'managed:kimi-code',
    model: displayName.toLowerCase().replaceAll(' ', '-'),
    maxContextSize: 200_000,
    displayName,
    capabilities,
  } as unknown as ModelAlias;
}

function effortModel(
  displayName: string,
  supportEfforts: string[],
  defaultEffort?: string,
  capabilities: string[] = ['thinking'],
): ModelAlias {
  return {
    provider: 'managed:kimi-code',
    model: displayName.toLowerCase().replaceAll(' ', '-'),
    maxContextSize: 200_000,
    displayName,
    capabilities,
    supportEfforts,
    defaultEffort,
  } as unknown as ModelAlias;
}

function text(component: ModelSelectorComponent, width = 120): string {
  return component.render(width).map(strip).join('\n');
}

describe('ModelSelectorComponent', () => {
  it('lays out the provider as a right column and marks the current model', () => {
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2') },
      currentValue: 'kimi',
      currentThinkingEffort: 'on',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = text(picker);
    // Model name on the left, provider on the right, with the current marker.
    expect(out).toMatch(/❯ Kimi K2\s+Kimi Code ← current/);
    // Provider is no longer inlined in parentheses next to the name.
    expect(out).not.toContain('Kimi K2 (Cloud Code)');
  });

  it('toggles thinking with Left/Right (not with "/")', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2', ['thinking']) },
      currentValue: 'kimi',
      currentThinkingEffort: 'on',
      onSelect,
      onCancel: vi.fn(),
    });

    // "/" no longer toggles thinking (it used to); here it is simply ignored.
    picker.handleInput('/');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'kimi', thinking: 'on' });

    // Right arrow flips the draft (true -> false).
    picker.handleInput(RIGHT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'kimi', thinking: 'off' });

    // Left arrow flips it back.
    picker.handleInput(LEFT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'kimi', thinking: 'on' });
  });

  it('shows the Left/Right thinking hint only for toggleable models', () => {
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2', ['thinking']) },
      currentValue: 'kimi',
      currentThinkingEffort: 'off',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    expect(text(picker)).toContain('Thinking  (←→ to switch)');
  });

  it('forces always-thinking models on and unsupported models off', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        always: model('Kimi Thinking', ['always_thinking']),
        plain: model('Kimi Plain', ['tool_use']),
      },
      currentValue: 'always',
      currentThinkingEffort: 'off',
      onSelect,
      onCancel: vi.fn(),
    });

    // Always-on: On selected, Off greyed out with an explanation.
    const alwaysOut = text(picker);
    expect(alwaysOut).toContain('[ On ]');
    expect(alwaysOut).toContain('Off (Unsupported)');
    expect(alwaysOut).not.toContain('Always on');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'always', thinking: 'on' });

    // Unsupported: Off selected, On greyed out — same style, mirrored.
    picker.handleInput(DOWN);
    const plainOut = text(picker);
    expect(plainOut).toContain('On (Unsupported)');
    expect(plainOut).toContain('[ Off ]');
    expect(plainOut).not.toContain('] unsupported');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'plain', thinking: 'off' });
  });

  it('ignores Left/Right on always-on and unsupported models', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        always: model('Kimi Thinking', ['always_thinking']),
        plain: model('Kimi Plain', ['tool_use']),
      },
      currentValue: 'always',
      currentThinkingEffort: 'on',
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput(RIGHT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'always', thinking: 'on' });

    picker.handleInput(DOWN);
    picker.handleInput(LEFT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'plain', thinking: 'off' });
  });

  it('renders the unavailable thinking segment muted', () => {
    const picker = new ModelSelectorComponent({
      models: { always: model('Kimi Thinking', ['always_thinking']) },
      currentValue: 'always',
      currentThinkingEffort: 'on',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const raw = picker.render(120).join('\n');
    expect(raw).toContain(currentTheme.fg('textMuted', '  Off (Unsupported)  '));
  });

  it('keeps the thinking draft when moving across models', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        plain: model('Kimi Plain', ['tool_use']),
        thinking: model('Kimi Thinking', ['thinking']),
      },
      currentValue: 'plain',
      currentThinkingEffort: 'off',
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput(DOWN); // -> thinking model (defaults On)
    picker.handleInput(RIGHT); // toggle -> Off
    picker.handleInput(UP); // -> plain
    picker.handleInput(DOWN); // -> thinking (the Off override persists)
    picker.handleInput('\r');

    expect(onSelect).toHaveBeenCalledWith({ alias: 'thinking', thinking: 'off' });
  });

  it('defaults a thinking-capable model to On but keeps the current model state', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        current: model('Kimi Current', ['thinking']),
        other: model('Kimi Other', ['thinking']),
      },
      currentValue: 'current',
      currentThinkingEffort: 'off', // thinking deliberately off on the active model
      onSelect,
      onCancel: vi.fn(),
    });

    // The active model reflects its live (off) state.
    expect(text(picker)).toContain('[ Off ]');
    picker.handleInput(DOWN); // -> the other thinking-capable model
    // A capable, non-active model defaults to On without any toggle.
    expect(text(picker)).toContain('[ On ]');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith({ alias: 'other', thinking: 'on' });
  });

  it('fuzzy-filters by typing and reports a match count', () => {
    const onCancel = vi.fn();
    const picker = new ModelSelectorComponent({
      models: { k2: model('Kimi K2'), turbo: model('Kimi Turbo') },
      currentValue: 'k2',
      currentThinkingEffort: 'off',
      searchable: true,
      onSelect: vi.fn(),
      onCancel,
    });

    picker.handleInput('/'); // focus the search box, then type the query
    picker.handleInput('t');
    picker.handleInput('u');
    const out = text(picker);
    expect(out).toContain('⌕ tu');
    expect(out).toContain('Kimi Turbo');
    expect(out).not.toContain('Kimi K2');
    expect(out).toContain('1 / 2');
    // The focused box documents the Esc exit back to the list.
    expect(out).toContain('Esc back to list');

    // Layered Esc: clear the query, then unfocus the box, then cancel.
    picker.handleInput(ESC);
    expect(onCancel).not.toHaveBeenCalled();
    expect(text(picker)).toContain('Esc back to list');
    picker.handleInput(ESC);
    expect(onCancel).not.toHaveBeenCalled();
    expect(text(picker)).toContain('/ ↑ search');
    picker.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders the always-visible search box; `/` focuses it without seeding a query', () => {
    const picker = new ModelSelectorComponent({
      models: { k2: model('Kimi K2') },
      currentValue: 'k2',
      currentThinkingEffort: 'off',
      searchable: true,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    // Unfocused: rounded box with the dim placeholder, hint advertises the
    // `/` (and ↑) focus keys.
    let out = text(picker);
    expect(out).toContain('╭');
    expect(out).toContain('⌕ Search…');
    expect(out).toContain('╰');
    expect(out).toContain('/ ↑ search');
    expect(out).toContain('Esc cancel');

    // `/` focuses the box (border highlights, query stays empty).
    picker.handleInput('/');
    out = text(picker);
    expect(out).toContain('⌕ Search…');
    expect(out).toContain('Esc back to list');
    expect(out).not.toContain('/ ↑ search');
    // The list still renders below the box.
    expect(out).toContain('Kimi K2');
  });

  it('shows a "more" indicator when the list overflows a page', () => {
    const models: Record<string, ModelAlias> = {};
    for (let i = 0; i < 12; i++) models[`m${String(i)}`] = model(`Model ${String(i)}`);
    const picker = new ModelSelectorComponent({
      models,
      currentValue: 'm0',
      currentThinkingEffort: 'off',
      searchable: true,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    // Default page size is 8, so 4 of the 12 models sit below the fold.
    expect(text(picker)).toContain('▼ 4 more');
  });

  it('never renders a line wider than the terminal', () => {
    const picker = new ModelSelectorComponent({
      models: {
        long: model('A Very Long Model Display Name That Should Be Truncated Hard'),
        cjk: model('超长的中文模型名称需要被正确截断处理'),
      },
      currentValue: 'long',
      currentThinkingEffort: 'off',
      searchable: true,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    for (const width of [20, 40, 80, 120]) {
      for (const line of picker.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('invokes onSessionOnlySelect on Alt+S with the effective thinking state', () => {
    const onSelect = vi.fn();
    const onSessionOnlySelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2', ['thinking']) },
      currentValue: 'kimi',
      currentThinkingEffort: 'on',
      onSelect,
      onSessionOnlySelect,
      onCancel: vi.fn(),
    });

    // Toggle thinking Off, then Alt+S applies the choice to the session only.
    picker.handleInput(RIGHT);
    picker.handleInput(`${ESC}s`);
    expect(onSessionOnlySelect).toHaveBeenCalledWith({ alias: 'kimi', thinking: 'off' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ignores Alt+S and hides its hint when onSessionOnlySelect is not provided', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2') },
      currentValue: 'kimi',
      currentThinkingEffort: 'on',
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput(`${ESC}s`);
    expect(onSelect).not.toHaveBeenCalled();
    expect(text(picker)).not.toContain('Alt+S session-only');
  });

  it('shows the Alt+S session-only hint when onSessionOnlySelect is provided', () => {
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2') },
      currentValue: 'kimi',
      currentThinkingEffort: 'on',
      onSelect: vi.fn(),
      onSessionOnlySelect: vi.fn(),
      onCancel: vi.fn(),
    });
    expect(text(picker)).toContain('Alt+S session-only');
  });

  it('renders effort segments with the default effort highlighted', () => {
    const picker = new ModelSelectorComponent({
      models: { kimi: effortModel('Kimi K2', ['low', 'high', 'max'], 'high') },
      currentValue: 'kimi',
      currentThinkingEffort: 'high',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = text(picker);
    // The default effort (high) is the active segment.
    expect(out).toContain('[ High ]');
    // All declared efforts plus the Off entry are present.
    expect(out).toContain('Low');
    expect(out).toContain('Max');
    expect(out).toContain('Off');
    // Multi-segment control advertises the switch hint.
    expect(out).toContain('Thinking  (←→ to switch)');
  });

  it('derives official Anthropic effort segments from the model name', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        opus: {
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          maxContextSize: 200000,
        },
      },
      currentValue: 'opus',
      currentThinkingEffort: 'high',
      onSelect,
      onCancel: vi.fn(),
    });

    const out = text(picker);
    expect(out).toContain('Low');
    expect(out).toContain('[ High ]');
    expect(out).toContain('Max');
    expect(out).toContain('Off');
    expect(out).not.toContain('Xhigh');

    picker.handleInput(RIGHT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith({ alias: 'opus', thinking: 'max' });
  });

  it('derives official always-on Anthropic models without an Off segment', () => {
    const picker = new ModelSelectorComponent({
      models: {
        fable: {
          provider: 'anthropic',
          model: 'claude-fable-5',
          maxContextSize: 200000,
        },
      },
      currentValue: 'fable',
      currentThinkingEffort: 'high',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = text(picker);
    expect(out).toContain('Xhigh');
    expect(out).toContain('Max');
    expect(out).not.toContain('Off');
  });

  it('cycles efforts with Left/Right and clamps at the ends', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: { kimi: effortModel('Kimi K2', ['low', 'high', 'max'], 'high') },
      currentValue: 'kimi',
      currentThinkingEffort: 'high',
      onSelect,
      onCancel: vi.fn(),
    });

    // high -> max (Right), then clamp on a second Right.
    picker.handleInput(RIGHT);
    picker.handleInput(RIGHT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'kimi', thinking: 'max' });

    // max -> high -> low -> off (Left x3), then clamp on another Left.
    picker.handleInput(LEFT);
    picker.handleInput(LEFT);
    picker.handleInput(LEFT);
    picker.handleInput(LEFT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'kimi', thinking: 'off' });
  });

  it('always-on effort models hide Off and clamp selection at the last effort', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        kimi: effortModel('Kimi K2', ['low', 'high', 'max'], 'high', ['always_thinking']),
      },
      currentValue: 'kimi',
      currentThinkingEffort: 'high',
      onSelect,
      onCancel: vi.fn(),
    });

    const raw = picker.render(120).join('\n');
    // Off is not surfaced at all — the selectable segments are effort-only.
    expect(raw).not.toContain('Off (Unsupported)');
    // The active effort is still highlighted.
    expect(strip(raw)).toContain('[ High ]');

    // Cycling clamps at the last effort and never reaches Off.
    picker.handleInput(RIGHT); // high -> max
    picker.handleInput(RIGHT); // clamp at max
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'kimi', thinking: 'max' });
  });

  it('defaults an effort model without a current level to its defaultEffort', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        other: effortModel('Kimi Other', ['low', 'high', 'max'], 'max'),
      },
      currentValue: 'current',
      currentThinkingEffort: 'off',
      onSelect,
      onCancel: vi.fn(),
    });

    // Non-current effort model falls back to its declared defaultEffort.
    expect(text(picker)).toContain('[ Max ]');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith({ alias: 'other', thinking: 'max' });
  });

  it('falls back to the middle effort when an effort model has no defaultEffort', () => {
    const picker = new ModelSelectorComponent({
      models: {
        other: effortModel('Kimi Other', ['low', 'medium', 'high']),
      },
      currentValue: 'current',
      currentThinkingEffort: 'off',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    // support_efforts present but default_effort absent -> default to the
    // middle entry (medium), not a hardcoded level.
    expect(text(picker)).toContain('[ Medium ]');
  });

  it('renders the warning line directly below the key-hint line when provided', () => {
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2') },
      currentValue: 'kimi',
      currentThinkingEffort: 'on',
      warning: 'Switching may increase token usage.',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const lines = picker.render(120).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('↑↓ navigate'));
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    expect(lines[hintIdx + 1]).toContain('Switching may increase token usage.');
    // Model list is pushed below the inserted warning line, not overlapped.
    expect(lines.findIndex((l) => l.includes('Kimi K2'))).toBeGreaterThan(hintIdx + 1);
  });

  it('wraps a warning longer than the width instead of truncating it', () => {
    const warning =
      'Note: Switching models invalidates the existing prompt cache. Use /new to avoid extra token costs.';
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2') },
      currentValue: 'kimi',
      currentThinkingEffort: 'on',
      warning,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const lines = picker.render(50).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('↑↓ navigate'));
    expect(lines[hintIdx + 1]).not.toBe('');
    expect(lines[hintIdx + 2]).not.toBe('');
    // Word-wrapped: nothing dropped — the full warning survives across lines.
    const squashed = lines.join('').replaceAll(/\s+/g, '');
    expect(squashed).toContain(warning.replaceAll(/\s+/g, ''));
  });

  it('wraps the hint onto continuation lines at narrow widths instead of truncating', () => {
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2') },
      currentValue: 'kimi',
      currentThinkingEffort: 'on',
      providerSwitchHint: true,
      onSessionOnlySelect: vi.fn(),
      manage: { isCustom: () => false, onEdit: vi.fn(), onDelete: vi.fn(), onGuard: vi.fn() },
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const lines = picker.render(40).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('↑↓ navigate'));
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    // All segments survive: the tail wraps onto the next line(s).
    const hintBlock = lines.slice(hintIdx, hintIdx + 3).join(' ');
    expect(hintBlock).toContain('Tab toggle provider');
    expect(hintBlock).toContain('Enter select');
    expect(hintBlock).toContain('Alt+S session-only');
    expect(hintBlock).toContain('Alt+E edit');
    expect(hintBlock).toContain('Alt+D delete');
    expect(hintBlock).toContain('Esc cancel');
  });

  it('moves the selection with the mouse wheel, clamped at both ends', () => {
    const picker = new ModelSelectorComponent({
      models: { a: model('Alpha'), b: model('Beta'), c: model('Gamma') },
      currentValue: 'a',
      currentThinkingEffort: 'on',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const wheel = (button: number): void => {
      picker.handleMouse({ type: 'wheel', button, col: 1, row: 1, slotRelative: false });
    };

    // Wheel down moves the pointer onto the next model.
    wheel(65);
    expect(text(picker)).toContain('❯ Beta');

    // The bottom end clamps instead of wrapping back to the top.
    wheel(65);
    wheel(65);
    expect(text(picker)).toContain('❯ Gamma');

    // The top end clamps too.
    wheel(64);
    wheel(64);
    wheel(64);
    const out = text(picker);
    expect(out).toContain('❯ Alpha');
    expect(out).not.toContain('❯ Beta');
  });

  describe('click-to-select (left press)', () => {
    // Row layout with no warning and no query: 0 divider, 1 title, 2 hint,
    // 3 blank, then one row per model in page order.
    function makePicker(over: Partial<ModelSelectorOptions> = {}) {
      const onSelect = vi.fn();
      const picker = new ModelSelectorComponent({
        models: { a: model('Alpha'), b: model('Beta'), c: model('Gamma') },
        currentValue: 'a',
        currentThinkingEffort: 'on',
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

    it('selects the model row that is hit without confirming', () => {
      const { picker, onSelect, press } = makePicker();

      press(5); // Beta row
      expect(text(picker)).toContain('❯ Beta');

      press(6); // Gamma row
      expect(text(picker)).toContain('❯ Gamma');

      press(4); // Alpha row
      expect(text(picker)).toContain('❯ Alpha');

      // Click only moves the cursor; it never confirms a selection.
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('ignores presses on the header, below the list, and non-left presses', () => {
      const { picker, press } = makePicker();

      press(6); // move to Gamma first
      expect(text(picker)).toContain('❯ Gamma');

      // Header rows, negative rows, the blank/thinking-control/divider rows
      // below the list, and a right-button press all leave the cursor alone.
      for (const row of [-1, 0, 1, 2, 3, 7, 8, 9, 10, 11, 20]) {
        press(row);
        expect(text(picker), `row ${String(row)}`).toContain('❯ Gamma');
      }
      press(4, 2);
      expect(text(picker)).toContain('❯ Gamma');
    });

    it('maps rows through the current page window', () => {
      const { picker, press } = makePicker({
        models: {
          a: model('Alpha'),
          b: model('Beta'),
          c: model('Gamma'),
          d: model('Delta'),
          e: model('Epsilon'),
        },
        pageSize: 2,
      });

      // Page 0: rows 4-5 are Alpha/Beta.
      press(5);
      expect(text(picker)).toContain('❯ Beta');

      // Page 1: row 4 is now Gamma — the row is offset by page.start.
      picker.handleInput(`${ESC}[6~`);
      press(4);
      expect(text(picker)).toContain('❯ Gamma');
    });

    it('shifts the list down by the wrapped warning rows', () => {
      const { picker, press } = makePicker({
        currentValue: 'b',
        warning: 'Switching models mid-conversation re-reads the context.',
      });

      // 0 divider, 1 title, 2 hint, 3 warning, 4 blank, 5 first model row.
      press(5);
      expect(text(picker)).toContain('❯ Alpha');

      // The warning row itself is not a list row.
      press(3);
      expect(text(picker)).toContain('❯ Alpha');
    });

    it('shifts the list down by the search box rows', () => {
      const { picker, press } = makePicker({
        models: { a: model('Kimi K2'), b: model('Kimi K2 Pro') },
        searchable: true,
      });

      // 0 divider, 1 title, 2 hint, 3 blank, 4-6 search box, 7-8 model rows.
      press(8);
      expect(text(picker)).toContain('❯ Kimi K2 Pro');

      // The search box itself is not a list row.
      press(5);
      expect(text(picker)).toContain('❯ Kimi K2 Pro');
    });

    it('focuses the search box on a click into the box', () => {
      const { picker, press } = makePicker({
        models: { a: model('Kimi K2'), b: model('Kimi K2 Pro') },
        searchable: true,
      });
      const focused = (): boolean =>
        picker.render(120).map(strip).some((l) => l.includes('Esc back to list'));

      expect(focused()).toBe(false);
      // Rows: 0 divider, 1 title, 2 hint, 3 blank, 4-6 search box — a press
      // inside the box focuses it (the mouse counterpart of `/`).
      press(5);
      expect(focused()).toBe(true);

      // Typing now lands in the query.
      picker.handleInput('P');
      expect(text(picker)).toContain('⌕ P');
    });

    it('keeps the hit math in sync with a wrapped hint at narrow width', () => {
      const { picker, press } = makePicker({
        models: { a: model('Alpha'), b: model('Beta'), c: model('Gamma') },
        searchable: true,
      });
      const rows = (): string[] => picker.render(40).map(strip);
      const pressCol = (row: number, col: number): void => {
        picker.handleMouse({ type: 'press', button: 0, col, row, slotRelative: false });
      };

      // Sanity: at this width the hint wraps, pushing the list down a row.
      const hintIdx = rows().findIndex((l) => l.includes('↑↓ navigate'));
      expect(rows()[hintIdx + 1]).toContain('Esc cancel');

      // A press on a model row (derived from the render) moves the cursor.
      const betaRow = rows().findIndex((l) => l.includes('Beta'));
      expect(betaRow).toBeGreaterThan(-1);
      press(betaRow);
      expect(rows().join('\n')).toContain('❯ Beta');

      // The thinking control row is shifted by the extra hint line too: a
      // press on its Off segment applies the effort.
      const controlRow = rows().findIndex((l) => l.includes('[ On ]'));
      expect(controlRow).toBeGreaterThan(-1);
      pressCol(controlRow, rows()[controlRow]!.indexOf('Off') + 1);
      expect(rows().join('\n')).toContain('[ Off ]');
    });
  });
});

describe('ModelSelectorComponent search box as the selected option', () => {
  function makeSearchable(over: Partial<ModelSelectorOptions> = {}) {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: { a: model('Alpha'), b: model('Beta'), c: model('Gamma') },
      currentValue: 'a',
      currentThinkingEffort: 'on',
      searchable: true,
      onSelect,
      onCancel: vi.fn(),
      ...over,
    });
    picker.render(120); // primes the render width used by the hit test
    const press = (row: number): void => {
      picker.handleMouse({ type: 'press', button: 0, col: 1, row, slotRelative: false });
    };
    return { picker, onSelect, press };
  }

  it('keeps the list highlight put on arrows while the box is selected', () => {
    const { picker } = makeSearchable();

    picker.handleInput('/'); // select the box
    expect(text(picker)).toContain('Esc back to list');
    expect(text(picker)).toContain('❯ Alpha');

    // ↑/↓-class keys never move the list highlight out from under the box.
    for (const key of [UP, `${ESC}[5~`, `${ESC}[6~`, `${ESC}[H`, `${ESC}[F`]) {
      picker.handleInput(key);
      expect(text(picker)).toContain('❯ Alpha');
      expect(text(picker)).toContain('Esc back to list'); // box still selected
    }
  });

  it('↓ from the selected box drops onto the first list option; typing filters', () => {
    const { picker } = makeSearchable();

    picker.handleInput(DOWN); // cursor onto Beta
    picker.handleInput('/'); // select the box mid-list
    picker.handleInput('G');
    picker.handleInput('a');
    let out = text(picker);
    expect(out).toContain('⌕ Ga');
    expect(out).toContain('❯ Gamma'); // the filter reset the highlight
    expect(out).not.toContain('Beta');

    // Esc clears the query but keeps the box selected; ↓ then selects the
    // first list option (not the pre-search cursor row) and drops the box.
    picker.handleInput(ESC);
    picker.handleInput(DOWN);
    out = text(picker);
    expect(out).toContain('❯ Alpha');
    expect(out).toContain('/ ↑ search');
  });

  it('selects a clicked row (dropping the box) and confirms only on the second click', () => {
    const { picker, onSelect, press } = makeSearchable();
    const rows = (): string[] => picker.render(120).map(strip);

    press(5); // inside the search box (rows 4-6): selects it
    expect(rows().some((l) => l.includes('Esc back to list'))).toBe(true);

    // A click on the row under the resting cursor only selects it — while
    // the box is the selected option no row is active, so nothing confirms.
    const alphaRow = rows().findIndex((l) => l.includes('Alpha'));
    press(alphaRow);
    expect(onSelect).not.toHaveBeenCalled();
    expect(rows().some((l) => l.includes('/ ↑ search'))).toBe(true); // box dropped

    // Re-clicking the now-selected row confirms it like Enter.
    press(alphaRow);
    expect(onSelect).toHaveBeenCalledWith({ alias: 'a', thinking: 'on' });
  });
});

describe('providerDisplayName', () => {
  it('maps the two service-real-name exceptions and leaves everything else alone', () => {
    expect(providerDisplayName('managed:kimi-code')).toBe('Kimi Code');
    expect(providerDisplayName('kimi')).toBe('Kimi Code');
    expect(providerDisplayName('chatgpt-codex')).toBe('ChatGPT Codex');
    // No exception: managed ids strip their prefix, bare ids render as-is.
    expect(providerDisplayName('managed:acme')).toBe('acme');
    expect(providerDisplayName('moonshot-cn')).toBe('moonshot-cn');
  });

  it('labels the provider column with the service names in the picker', () => {
    const codex = {
      provider: 'chatgpt-codex',
      model: 'gpt-5-codex',
      maxContextSize: 200_000,
      displayName: 'GPT-5 Codex',
      capabilities: ['thinking'],
    } as unknown as ModelAlias;
    const picker = new ModelSelectorComponent({
      models: { k2: model('Kimi K2'), codex },
      currentValue: 'k2',
      currentThinkingEffort: 'off',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const out = text(picker);
    expect(out).toContain('Kimi Code');
    expect(out).toContain('ChatGPT Codex');
  });
});

describe('ModelSelectorComponent current mark localization', () => {
  it('renders the current marker localized in en and zh-CN', () => {
    const original = getActiveLocale();
    try {
      setLocalePreference('en');
      const en = new ModelSelectorComponent({
        models: { kimi: model('Kimi K2') },
        currentValue: 'kimi',
        currentThinkingEffort: 'off',
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      });
      expect(text(en)).toContain('← current');

      setLocalePreference('zh-CN');
      const zh = new ModelSelectorComponent({
        models: { kimi: model('Kimi K2') },
        currentValue: 'kimi',
        currentThinkingEffort: 'off',
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      });
      const out = text(zh);
      expect(out).toContain('← 当前');
      expect(out).not.toContain('← current');
    } finally {
      setLocalePreference(original);
    }
  });
});

describe('ModelSelectorComponent overrides', () => {
  it('uses overridden support_efforts for selectable efforts', () => {
    const picker = new ModelSelectorComponent({
      models: {
        kimi: {
          ...effortModel('Kimi K2', ['low', 'high', 'max'], 'max'),
          overrides: { supportEfforts: ['low', 'high'] },
        },
      },
      currentValue: 'kimi',
      currentThinkingEffort: 'max',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = text(picker);
    expect(out).toContain('Low');
    expect(out).toContain('High');
    expect(out).not.toContain('Max');
  });
});

describe('ModelSelectorComponent add-custom row', () => {
  function addRowPicker(overrides: Partial<ModelSelectorOptions> = {}) {
    const onSelect = vi.fn();
    const onSessionOnlySelect = vi.fn();
    const onAddCustom = vi.fn();
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2') },
      currentValue: 'kimi',
      currentThinkingEffort: 'on',
      onSelect,
      onSessionOnlySelect,
      onAddCustom,
      onCancel: vi.fn(),
      ...overrides,
    });
    return { picker, onSelect, onSessionOnlySelect, onAddCustom };
  }

  it('appends the synthetic row and renders it without a provider column', () => {
    const { picker } = addRowPicker();
    const out = text(picker);
    expect(out).toContain('[ Add custom model ]');
  });

  it('enter on the row invokes onAddCustom instead of onSelect', () => {
    const { picker, onSelect, onAddCustom } = addRowPicker();
    picker.handleInput(DOWN); // move past the single model row
    picker.handleInput('\r');
    expect(onAddCustom).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('hides the thinking control while the row is highlighted', () => {
    const { picker } = addRowPicker();
    picker.handleInput(DOWN);
    expect(text(picker)).not.toContain('Thinking');
  });

  it('Alt+S on the row does not fire onSessionOnlySelect', () => {
    const { picker, onSessionOnlySelect } = addRowPicker();
    picker.handleInput(DOWN);
    picker.handleInput(`${ESC}s`);
    expect(onSessionOnlySelect).not.toHaveBeenCalled();
  });

  it('omits the row entirely without onAddCustom', () => {
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2') },
      currentValue: 'kimi',
      currentThinkingEffort: 'on',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    expect(text(picker)).not.toContain('Add custom model');
  });
});

describe('ModelSelectorComponent manage actions', () => {
  const ALT_E = `${ESC}e`;
  const ALT_D = `${ESC}d`;

  function customModel(displayName: string): ModelAlias {
    return {
      provider: 'acme',
      model: displayName.toLowerCase(),
      maxContextSize: 128_000,
      displayName,
      capabilities: ['tool_use'],
    } as unknown as ModelAlias;
  }

  function managePicker(overrides: Partial<ModelSelectorOptions> = {}) {
    const manage = {
      isCustom: (alias: string) => alias.startsWith('acme/'),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onGuard: vi.fn(),
      deleteImpact: (alias: string) =>
        alias === 'acme/m1' ? ['It is the current model — you will be switched to M2.'] : [],
    };
    const picker = new ModelSelectorComponent({
      models: {
        'acme/m1': customModel('M1'),
        'managed:kimi-code/k2': model('Kimi K2'),
      },
      currentValue: 'acme/m1',
      currentThinkingEffort: 'off',
      onSelect: vi.fn(),
      manage,
      onCancel: vi.fn(),
      ...overrides,
    });
    return { picker, manage };
  }

  it('badges custom rows only and advertises the manage keys in the hint', () => {
    const { picker } = managePicker();
    const out = text(picker);
    expect(out).toContain('Alt+E edit');
    expect(out).toContain('Alt+D delete');
    const m1Line = out.split('\n').find((line) => line.includes('M1'));
    expect(m1Line).toContain('[custom]');
    const k2Line = out.split('\n').find((line) => line.includes('Kimi K2'));
    expect(k2Line).toBeDefined();
    expect(k2Line).not.toContain('[custom]');
  });

  it('omits badge and hints without the manage option', () => {
    const picker = new ModelSelectorComponent({
      models: { 'acme/m1': customModel('M1') },
      currentValue: 'acme/m1',
      currentThinkingEffort: 'off',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const out = text(picker);
    expect(out).not.toContain('[custom]');
    expect(out).not.toContain('Alt+E');
  });

  it('Alt+E edits a custom row and guards a managed row', () => {
    const { picker, manage } = managePicker();
    picker.handleInput(ALT_E); // acme/m1 is selected (current)
    expect(manage.onEdit).toHaveBeenCalledWith('acme/m1');

    picker.handleInput(DOWN); // managed row
    picker.handleInput(ALT_E);
    expect(manage.onGuard).toHaveBeenCalledWith('managed:kimi-code/k2');
    expect(manage.onEdit).toHaveBeenCalledTimes(1);
  });

  it('Alt+D arms an inline confirm with the host-provided impact lines', () => {
    const { picker } = managePicker();
    picker.handleInput(ALT_D);
    const out = text(picker);
    expect(out).toContain('Delete model "acme/m1"? [y/N]');
    expect(out).toContain('It is the current model — you will be switched to M2.');
    // The thinking control is replaced while the confirm is armed.
    expect(out).not.toContain('Thinking');
  });

  it('y confirms the delete, n and Esc disarm without deleting', () => {
    const { picker, manage } = managePicker();
    picker.handleInput(ALT_D);
    // Navigation is swallowed while armed.
    picker.handleInput(DOWN);
    expect(text(picker)).toContain('Delete model "acme/m1"?');
    picker.handleInput('y');
    expect(manage.onDelete).toHaveBeenCalledWith('acme/m1');

    picker.handleInput(ALT_D);
    picker.handleInput('n');
    expect(text(picker)).not.toContain('Delete model');
    expect(manage.onDelete).toHaveBeenCalledTimes(1);

    picker.handleInput(ALT_D);
    picker.handleInput(ESC);
    expect(text(picker)).not.toContain('Delete model');
    expect(manage.onDelete).toHaveBeenCalledTimes(1);
  });

  it('Alt+D on a managed row routes to the guard instead of confirming', () => {
    const { picker, manage } = managePicker();
    picker.handleInput(DOWN); // managed row
    picker.handleInput(ALT_D);
    expect(manage.onGuard).toHaveBeenCalledWith('managed:kimi-code/k2');
    expect(text(picker)).not.toContain('Delete model');
  });

  it('ignores the manage keys on the add-custom row', () => {
    const { picker, manage } = managePicker({ onAddCustom: vi.fn() });
    picker.handleInput(DOWN); // managed row
    picker.handleInput(DOWN); // add-custom row
    picker.handleInput(ALT_D);
    picker.handleInput(ALT_E);
    expect(manage.onDelete).not.toHaveBeenCalled();
    expect(manage.onEdit).not.toHaveBeenCalled();
    expect(manage.onGuard).not.toHaveBeenCalled();
  });

  it('updateModels clears an armed delete confirm when its alias vanishes', () => {
    const { picker } = managePicker();
    picker.handleInput(ALT_D);
    expect(text(picker)).toContain('Delete model "acme/m1"?');

    picker.updateModels({ 'managed:kimi-code/k2': model('Kimi K2') });
    const out = text(picker);
    expect(out).not.toContain('Delete model');
    expect(out).toContain('Kimi K2');
    expect(out).not.toContain('M1');
  });

  it('updateModels keeps the cursor and thinking override on a surviving alias', () => {
    const picker = new ModelSelectorComponent({
      models: {
        a: effortModel('Alpha', ['low', 'high'], 'low'),
        b: effortModel('Beta', ['low', 'high'], 'low'),
      },
      currentValue: 'a',
      currentThinkingEffort: 'off',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    picker.handleInput(DOWN); // → b
    picker.handleInput(RIGHT); // b: low → high

    picker.updateModels({
      c: effortModel('Gamma', ['low', 'high'], 'low'),
      b: effortModel('Beta', ['low', 'high'], 'low'),
    });

    const out = text(picker);
    expect(out).toContain('❯ Beta'); // cursor followed the alias
    expect(out).toContain('Gamma'); // new row landed
    // The ←/→ override on b survived the refresh.
    expect(out).toMatch(/\[ High \]/);
  });
});

describe('ModelSelectorComponent mouse hover underline', () => {
  // chalk auto-disables without a TTY; force colors on so the hover
  // assertions observe real SGR sequences.
  const prevLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 1;
  });
  afterAll(() => {
    chalk.level = prevLevel;
  });

  const stripSgr = (s: string): string => s.replaceAll(/\u001b\[[0-9;]*m/g, '');
  /** Visible text of the underlined run (between SGR 4 and SGR 24). */
  const underlinedRun = (line: string): string =>
    stripSgr(/\x1b\[4m([\s\S]*?)\x1b\[24m/.exec(line)?.[1] ?? '');
  const motion = (picker: ModelSelectorComponent, row: number, col: number): void => {
    picker.handleMouse({ type: 'motion', button: 3, col, row, slotRelative: false });
  };
  /** 1-based visual column at which `marker` starts on the row containing it. */
  const colOf = (picker: ModelSelectorComponent, rowHint: string, marker: string): number => {
    for (const line of picker.render(120)) {
      const plain = stripSgr(line);
      if (!plain.includes(rowHint)) continue;
      const idx = plain.indexOf(marker);
      if (idx >= 0) return visibleWidth(plain.slice(0, idx)) + 1;
    }
    throw new Error(`marker not rendered: ${marker}`);
  };
  const hoveredLine = (picker: ModelSelectorComponent): string => {
    const line = picker.render(120).find((l) => l.includes('\x1b[4m'));
    if (line === undefined) throw new Error('no underlined line rendered');
    return line;
  };
  const makePicker = (): ModelSelectorComponent => {
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2', ['thinking']) },
      currentValue: 'kimi',
      currentThinkingEffort: 'on',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    picker.render(120); // primes lastRenderWidth
    return picker;
  };

  // Layout without warning/search: 0 divider, 1 title, 2 hint, 3 blank,
  // 4 first model row, …, 7 thinking control (single-model list).
  it('underlines the row text from the pointer through the current mark, in one color', () => {
    const picker = makePicker();
    motion(picker, 4, 10); // the model row
    const line = hoveredLine(picker);
    // Extent: from the ❯ pointer through the provider + current mark — the
    // row's whole text (the whole row is clickable); the two-space left
    // margin stays plain.
    expect(underlinedRun(line)).toBe('❯ Kimi K2  Kimi Code ← current');
    expect(stripSgr(line.slice(0, line.indexOf('\x1b[58;')))).toBe('  ');
    // The row mixes primary / text / textMuted / success segments, yet the
    // underline is a single run in a single color (the theme text token,
    // #E0E0E0 → 58;2;224;224;224).
    expect(line.match(/\x1b\[4m/g)).toHaveLength(1);
    expect(line.match(/\x1b\[24m/g)).toHaveLength(1);
    expect(line.match(/\x1b\[58;2;224;224;224m/g)).toHaveLength(1);
    expect(line.match(/\x1b\[59m/g)).toHaveLength(1);
  });

  it('underlines the thinking segment text — plain when inactive, bracketed when active', () => {
    const picker = makePicker();
    // Hover the inactive Off cell (`  Off  `): only its label underlines —
    // not the cell padding that matches the active `[ Off ]` width.
    motion(picker, 7, colOf(picker, 'Off', 'Off'));
    expect(underlinedRun(hoveredLine(picker))).toBe('Off');
    // Hover the active On cell (`[ On ]`): the brackets are on-screen text.
    motion(picker, 7, colOf(picker, '[ On ]', '[ On ]'));
    expect(underlinedRun(hoveredLine(picker))).toBe('[ On ]');
  });

  it('underlines exactly the wide-char segment text under the zh-CN locale', () => {
    setLocalePreference('zh-CN');
    try {
      const picker = makePicker();
      // The thinking control renders 开/关 in zh-CN; both sit on one row.
      const control = picker.render(120).find((l) => {
        const plain = stripSgr(l);
        return plain.includes('开') && plain.includes('关');
      });
      expect(control).toBeDefined();
      motion(picker, 7, colOf(picker, '关', '关'));
      const run = underlinedRun(hoveredLine(picker));
      expect(run).toBe('关');
      expect(visibleWidth(run)).toBe(2); // wide char: two cells, one run
    } finally {
      setLocalePreference('en');
    }
  });
});

describe('ModelSelectorComponent subagent assignment', () => {
  const ALT_A = `${ESC}a`;

  function subagentPicker(
    current: { alias: string; effort?: string } | undefined,
    overrides: Partial<ModelSelectorOptions> = {},
  ) {
    const onSelect = vi.fn();
    const onAssign = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        kimi: model('Kimi K2', ['thinking']),
        k1: effortModel('Kimi K1', ['low', 'high', 'max'], 'low'),
      },
      currentValue: 'kimi',
      currentThinkingEffort: 'on',
      onSelect,
      subagent: { current: () => current, onAssign },
      onCancel: vi.fn(),
      ...overrides,
    });
    return { picker, onSelect, onAssign };
  }

  it('Alt+A assigns the highlighted row with the committed draft effort', () => {
    const { picker, onSelect, onAssign } = subagentPicker(undefined);
    picker.handleInput(DOWN); // Kimi K1
    picker.handleInput(RIGHT); // draft low -> high
    picker.handleInput(ALT_A);
    expect(onAssign).toHaveBeenCalledWith({ alias: 'k1', thinking: 'high' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('Alt+A on the row that already is the subagent default clears it', () => {
    const { picker, onAssign } = subagentPicker({ alias: 'k1', effort: 'high' });
    picker.handleInput(DOWN); // Kimi K1 — the current subagent default
    picker.handleInput(ALT_A);
    expect(onAssign).toHaveBeenCalledWith(undefined);
  });

  it('badges the subagent default row, alongside ← current when both scopes match', () => {
    const { picker } = subagentPicker({ alias: 'k1' });
    const out = text(picker);
    const k1Row = out.split('\n').find((line) => line.includes('Kimi K1'));
    expect(k1Row).toContain('← subagent');
    expect(k1Row).not.toContain('← current');

    const both = subagentPicker({ alias: 'kimi' });
    const kimiRow = text(both.picker)
      .split('\n')
      .find((line) => line.includes('Kimi K2'));
    expect(kimiRow).toContain('← current');
    expect(kimiRow).toContain('← subagent');
  });

  it('shows the Alt+A hint only when the subagent option is provided', () => {
    expect(text(subagentPicker(undefined).picker)).toContain('Alt+A subagent');

    const bare = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2') },
      currentValue: 'kimi',
      currentThinkingEffort: 'on',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    bare.handleInput(ALT_A); // ignored without the option
    expect(text(bare)).not.toContain('Alt+A subagent');
  });

  it('seeds the thinking draft from the persisted subagent effort', () => {
    // Without a subagent effort the K1 draft would be its default 'low'.
    const { picker, onAssign } = subagentPicker({ alias: 'k1', effort: 'high' });
    picker.handleInput(DOWN);
    expect(text(picker)).toContain('[ High ]');
    picker.handleInput(ALT_A); // would clear (k1 is the default) — draft check only
    expect(onAssign).toHaveBeenCalledWith(undefined);
  });

  it('Alt+A on the add-custom row does not fire onAssign', () => {
    const onAssign = vi.fn();
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2') },
      currentValue: 'kimi',
      currentThinkingEffort: 'on',
      onSelect: vi.fn(),
      onAddCustom: vi.fn(),
      subagent: { current: () => undefined, onAssign },
      onCancel: vi.fn(),
    });
    picker.handleInput(DOWN); // the synthetic add-custom row
    picker.handleInput(ALT_A);
    expect(onAssign).not.toHaveBeenCalled();
  });

  it('renders the badge and hint in zh-CN', () => {
    setLocalePreference('zh-CN');
    try {
      const { picker } = subagentPicker({ alias: 'k1' });
      const out = text(picker);
      expect(out).toContain('← 子代理');
      expect(out).toContain('Alt+A 子代理');
    } finally {
      setLocalePreference('en');
    }
  });
});
