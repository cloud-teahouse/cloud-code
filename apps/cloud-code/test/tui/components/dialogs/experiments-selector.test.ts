import type { ExperimentalFeatureState } from '@cloud-code/sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  ExperimentsSelectorComponent,
  type ExperimentalFeatureDraftChange,
} from '#/tui/components/dialogs/experiments-selector';


const ANSI = /\u001B\[[0-9;]*m/g;
const ESC = String.fromCodePoint(27);
const ENTER = '\r';

function strip(text: string): string {
  return text.replaceAll(ANSI, '');
}

function feature(
  overrides: Partial<ExperimentalFeatureState> = {},
): ExperimentalFeatureState {
  return {
    id: 'micro_compaction',
    title: 'Micro compaction',
    description: 'Trim older tool results.',
    surface: 'core',
    env: 'CLOUD_CODE_EXPERIMENTAL_MICRO_COMPACTION',
    defaultEnabled: true,
    enabled: true,
    source: 'default',
    ...overrides,
  };
}

function text(component: ExperimentsSelectorComponent, width = 120): string {
  return component.render(width).map(strip).join('\n');
}

describe('ExperimentsSelectorComponent', () => {
  it('renders searchable feature toggles with source details', () => {
    const selector = new ExperimentsSelectorComponent({
      features: [
        feature({ enabled: true, source: 'config', configValue: true }),
      ],
      onApply: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = text(selector);

    // The old "(type to search)" title suffix is replaced by the always-visible box.
    expect(out).toContain(' Experimental features');
    expect(out).not.toContain('type to search');
    expect(out).toContain(' ↑↓ navigate · Space toggle · Enter apply · / ↑ search · Esc cancel');
    expect(out).toContain('⌕ Search…');
    expect(out).toContain('  ❯ Micro compaction  enabled');
    expect(out).toContain('    id micro_compaction · config · CLOUD_CODE_EXPERIMENTAL_MICRO_COMPACTION');
    expect(out).toContain('    Trim older tool results.');
    expect(out).toContain(' [ Apply changes and reload ]  no changes');
  });

  it('drafts changes with Space and applies them with Enter', () => {
    const onApply = vi.fn<(changes: readonly ExperimentalFeatureDraftChange[]) => void>();
    const first = feature();
    const selector = new ExperimentsSelectorComponent({
      features: [first],
      onApply,
      onCancel: vi.fn(),
    });

    selector.handleInput(' ');

    expect(onApply).not.toHaveBeenCalled();
    expect(text(selector)).toContain('  ❯ Micro compaction  disabled');
    expect(text(selector)).toContain(
      '    id micro_compaction · default · CLOUD_CODE_EXPERIMENTAL_MICRO_COMPACTION · modified',
    );
    expect(text(selector)).toContain(' [ Apply changes and reload ]  1 change');

    selector.handleInput(ENTER);

    expect(onApply).toHaveBeenCalledWith([
      { id: 'micro_compaction', enabled: false },
    ]);
  });

  it('does not draft changes for env-locked features', () => {
    const onApply = vi.fn<(changes: readonly ExperimentalFeatureDraftChange[]) => void>();
    const selector = new ExperimentsSelectorComponent({
      features: [
        feature({
          enabled: true,
          source: 'env',
        }),
      ],
      onApply,
      onCancel: vi.fn(),
    });

    selector.handleInput(' ');
    selector.handleInput(ENTER);

    expect(text(selector)).toContain('  ❯ Micro compaction  enabled');
    expect(text(selector)).toContain(' [ Apply changes and reload ]  no changes');
    expect(onApply).not.toHaveBeenCalled();
  });

  it('filters by typing once focused, and layers Esc clear → unfocus → cancel', () => {
    const onCancel = vi.fn();
    const selector = new ExperimentsSelectorComponent({
      features: [feature()],
      onApply: vi.fn(),
      onCancel,
    });

    // Typing while unfocused is inert; `/` focuses the box, then typing filters.
    selector.handleInput('m');
    expect(text(selector)).not.toContain('⌕ m');
    selector.handleInput('/');
    selector.handleInput('m');
    selector.handleInput('i');
    selector.handleInput('c');
    expect(text(selector)).toContain('⌕ mic');
    expect(text(selector)).toContain('Micro compaction');
    expect(text(selector)).toContain('Esc back to list');

    // Esc 1 clears the query (box stays focused), Esc 2 unfocuses back to the
    // list, Esc 3 cancels.
    selector.handleInput(ESC);
    expect(text(selector)).not.toContain('⌕ mic');
    expect(onCancel).not.toHaveBeenCalled();
    selector.handleInput(ESC);
    expect(text(selector)).toContain('/ ↑ search');
    expect(onCancel).not.toHaveBeenCalled();
    selector.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('routes Space to the query while the search box is focused, toggles otherwise', () => {
    const selector = new ExperimentsSelectorComponent({
      features: [feature()],
      onApply: vi.fn(),
      onCancel: vi.fn(),
    });

    // Focused search box: Space is a query character, not the toggle —
    // the searchable-dialog idiom every other picker follows.
    selector.handleInput('/');
    selector.handleInput(' ');
    expect(text(selector)).toContain('no changes');

    // Back to the list: Space toggles the draft again.
    selector.handleInput(ESC); // clear the query
    selector.handleInput(ESC); // unfocus the box
    selector.handleInput(' ');
    expect(text(selector)).toContain('1 change');
  });

  describe('click-to-select (left press)', () => {
    // Row layout at width 120: 0 divider, 1 title, 2 hint, 3 blank, 4-6 search
    // box, then each feature occupying label + detail + description rows:
    //   7-9 first   10-12 second   13-15 third   16 blank …
    function makePicker() {
      const onApply = vi.fn();
      const selector = new ExperimentsSelectorComponent({
        features: [
          feature({ id: 'first_feature', title: 'First feature', description: 'First detail.' }),
          feature({ id: 'second_feature', title: 'Second feature', description: 'Second detail.' }),
          feature({ id: 'third_feature', title: 'Third feature', description: 'Third detail.' }),
        ],
        onApply,
        onCancel: vi.fn(),
      });
      selector.render(120); // primes the render width used by the hit test
      const press = (row: number, button = 0): void => {
        selector.handleMouse({ type: 'press', button, col: 1, row, slotRelative: false });
      };
      return { selector, onApply, press };
    }

    it('moves the cursor onto the hit feature and toggles its draft, without applying', () => {
      const { selector, onApply, press } = makePicker();

      press(10); // Second feature label row
      expect(text(selector)).toContain('❯ Second feature');
      // Checkbox semantics: the click toggled the draft (enabled → disabled).
      expect(text(selector)).toContain('❯ Second feature  disabled');

      press(14); // Third feature description row — any row of a feature counts
      expect(text(selector)).toContain('❯ Third feature');
      expect(text(selector)).toContain('❯ Third feature  disabled');

      press(8); // First feature detail row
      expect(text(selector)).toContain('❯ First feature');
      expect(text(selector)).toContain('❯ First feature  disabled');

      // A second click on the same feature toggles it back.
      press(8);
      expect(text(selector)).toContain('❯ First feature  enabled');

      // Clicks never apply — that is Enter / the Apply button.
      expect(onApply).not.toHaveBeenCalled();
    });

    it('applies the pending changes when the Apply button row is clicked', () => {
      const { selector, onApply, press } = makePicker();

      press(10); // toggle Second feature so there is a pending change
      expect(text(selector)).toContain('❯ Second feature  disabled');

      // Layout: features at 7-15, blank 16, Apply button 17, divider 18.
      press(17);
      expect(onApply).toHaveBeenCalledWith([{ id: 'second_feature', enabled: false }]);
    });

    it('ignores presses on the header, below the last feature, and non-left presses', () => {
      const { selector, press } = makePicker();

      press(10); // move to Second feature first
      expect(text(selector)).toContain('❯ Second feature');

      // Rows 4-6 are the search box (they focus the box; see below) — the
      // rest of the header and the overflow rows are inert.
      for (const row of [-1, 0, 1, 2, 3, 16, 17, 18, 20]) {
        press(row);
        expect(text(selector), `row ${String(row)}`).toContain('❯ Second feature');
      }
      press(10, 2); // right button
      expect(text(selector)).toContain('❯ Second feature');
    });

    it('focuses the search box when the box itself is clicked', () => {
      const { selector, press } = makePicker();

      press(5); // middle row of the search box (rows 4-6)
      expect(text(selector)).toContain('Esc back to list'); // focused hint
      expect(text(selector)).toContain('❯ First feature'); // cursor untouched
    });
  });
});
