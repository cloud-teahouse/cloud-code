/**
 * MultiChoicePicker — modal multi-select list for slash-command wizards that
 * ask the user to toggle a set of values (e.g. supported thinking efforts or
 * model capabilities for a custom model).
 *
 * Mirrors ChoicePickerComponent's container-replacement pattern: the host
 * mounts it via `mountEditorReplacement`, and the picker invokes `onSubmit`
 * (Enter — always allowed, an empty selection is meaningful) or `onCancel`
 * (Esc); the host tears it down.
 *
 * Keyboard:
 *   - ↑ / ↓     move highlight
 *   - Space     toggle the highlighted option
 *   - Enter     submit the checked values (in option order)
 *   - Esc       `onCancel()`
 */

import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
  type MouseEvent,
} from '@cloud-code/pi-tui';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { wrapHintText } from '#/tui/utils/hint';
import { HoverState, rowHitIndex, trackHover, underlineText } from '#/tui/utils/mouse-hover';
import { printableChar } from '#/tui/utils/printable-key';

export interface MultiChoiceOption {
  /** Value collected into the submitted list (e.g. 'tool_use', 'high'). */
  readonly value: string;
  /** Display text shown in the list. */
  readonly label: string;
  /** Optional explanatory text shown below the label. */
  readonly description?: string;
}

export interface MultiChoicePickerOptions {
  readonly title: string;
  /** Replaces the default key-hint line when provided. */
  readonly hint?: string;
  readonly options: readonly MultiChoiceOption[];
  /** Initially checked values; unknown values are ignored. */
  readonly initialSelected?: readonly string[];
  /**
   * Optional trailing action row (rendered without a checkbox, accent
   * colored): Space/Enter/click on it fires `onTrigger` with the currently
   * checked values instead of toggling or submitting — the host uses it to
   * branch into a sub-dialog (e.g. a free-text "custom value" prompt) and
   * typically re-mounts the picker afterwards with the values preserved.
   */
  readonly customAction?: {
    readonly label: string;
    readonly onTrigger: (values: readonly string[]) => void;
  };
  readonly onSubmit: (values: readonly string[]) => void;
  readonly onCancel: () => void;
}

export class MultiChoicePickerComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: MultiChoicePickerOptions;
  private readonly checked: Set<string>;
  private selectedIndex = 0;
  /** Hovered row index (mouse motion; options.length = the custom action row). */
  private readonly hover = new HoverState();
  /** Hint lines of the last render; the header height the mouse-row mapping
   * subtracts grows when the hint wraps at narrow widths. */
  private hintRowCount = 1;

  constructor(opts: MultiChoicePickerOptions) {
    super();
    this.opts = opts;
    const known = new Set(opts.options.map((option) => option.value));
    this.checked = new Set((opts.initialSelected ?? []).filter((value) => known.has(value)));
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.rowCount() - 1, this.selectedIndex + 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.space) || printableChar(data) === ' ') {
      if (this.isCustomRow(this.selectedIndex)) {
        this.fireCustomAction();
        return;
      }
      const option = this.opts.options[this.selectedIndex];
      if (option !== undefined) {
        if (this.checked.has(option.value)) this.checked.delete(option.value);
        else this.checked.add(option.value);
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.isCustomRow(this.selectedIndex)) {
        this.fireCustomAction();
        return;
      }
      // Submit in option order (not toggle order) so the persisted list is
      // stable regardless of how the user toggled.
      this.opts.onSubmit(
        this.opts.options.filter((option) => this.checked.has(option.value)).map((o) => o.value),
      );
    }
  }

  private isCustomRow(index: number): boolean {
    return this.opts.customAction !== undefined && index === this.opts.options.length;
  }

  private fireCustomAction(): void {
    this.opts.customAction?.onTrigger(
      this.opts.options.filter((option) => this.checked.has(option.value)).map((o) => o.value),
    );
  }

  /** Mouse: the wheel moves the highlight one row per tick, clamped like ↑/↓.
   * Left-press on a checkbox row moves the highlight there and toggles it
   * (GUI checkbox semantics — toggling IS the row action, like Space); a
   * press on the trailing custom action row fires it. Motion underlines the
   * hovered row. */
  handleMouse(event: MouseEvent): void | boolean {
    if (event.type === 'motion') {
      const changed = trackHover(event, this.hover, (row) => this.rowIndexAtRow(row));
      if (changed) this.invalidate();
      return changed ? undefined : false;
    }
    if (event.type === 'press' && event.button === 0) {
      this.handlePress(event.row);
      return;
    }
    if (event.type !== 'wheel') return false;
    const delta = event.button === 64 ? -1 : event.button === 65 ? 1 : 0;
    if (delta === 0 || this.opts.options.length === 0) return false;
    const next = Math.max(0, Math.min(this.rowCount() - 1, this.selectedIndex + delta));
    if (next === this.selectedIndex) return false;
    this.selectedIndex = next;
    this.invalidate();
  }

  private rowCount(): number {
    return this.opts.options.length + (this.opts.customAction === undefined ? 0 : 1);
  }

  /**
   * Maps a component-relative row onto a row index. Row layout (see render):
   * divider, title, hint (1+ rows, wrapping), blank — then each option
   * occupying a checkbox row plus its optional description row, and finally
   * the optional custom action row (index === options.length). Header and
   * trailing rows map to null. Shared by the press handler and hover tracking.
   */
  private rowIndexAtRow(row: number): number | null {
    const heights = this.opts.options.map(
      (option) => 1 + (option.description !== undefined && option.description.length > 0 ? 1 : 0),
    );
    if (this.opts.customAction !== undefined) heights.push(1);
    const hit = rowHitIndex(heights, row - (3 + this.hintRowCount));
    return hit === null || hit >= this.rowCount() ? null : hit;
  }

  /** Press: toggle the hit checkbox row (moving the highlight onto it), or
   * fire the trailing custom action row. */
  private handlePress(row: number): void {
    const hit = this.rowIndexAtRow(row);
    if (hit === null) return;
    if (this.isCustomRow(hit)) {
      this.fireCustomAction();
      return;
    }
    this.selectedIndex = hit;
    const option = this.opts.options[hit]!;
    if (this.checked.has(option.value)) this.checked.delete(option.value);
    else this.checked.add(option.value);
    this.invalidate();
  }

  override render(width: number): string[] {
    const hint =
      this.opts.hint ??
      [
        t('common.hint.navigate'),
        t('common.hint.toggle'),
        t('common.hint.confirm'),
        t('common.hint.cancel'),
      ].join(' · ');

    // Wrap at segment boundaries so narrow widths keep every key segment.
    const hintLines = wrapHintText(hint, width - 1);
    this.hintRowCount = hintLines.length;

    const lines: string[] = [
      currentTheme.fg('border', '─'.repeat(width)),
      currentTheme.boldFg('border', ` ${this.opts.title}`),
      ...hintLines.map((line) => currentTheme.fg('textMuted', ` ${line}`)),
      '',
    ];

    for (let i = 0; i < this.opts.options.length; i++) {
      const option = this.opts.options[i]!;
      const isSelected = i === this.selectedIndex;
      const pointer = isSelected ? SELECT_POINTER : ' ';
      const checkbox = this.checked.has(option.value) ? '[x]' : '[ ]';
      let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `);
      line += currentTheme.fg(this.checked.has(option.value) ? 'success' : 'textDim', checkbox);
      line += ' ';
      line += isSelected
        ? currentTheme.boldFg('primary', option.label)
        : currentTheme.fg('text', option.label);
      lines.push(underlineText(line, this.hover.isHovered(i)));
      if (option.description !== undefined && option.description.length > 0) {
        lines.push(currentTheme.fg('textMuted', `      ${option.description}`));
      }
    }

    if (this.opts.customAction !== undefined) {
      const isSelected = this.isCustomRow(this.selectedIndex);
      const pointer = isSelected ? SELECT_POINTER : ' ';
      let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `);
      line += isSelected
        ? currentTheme.boldFg('accent', this.opts.customAction.label)
        : currentTheme.fg('accent', this.opts.customAction.label);
      lines.push(underlineText(line, this.hover.isHovered(this.opts.options.length)));
    }

    lines.push('');
    lines.push(currentTheme.fg('border', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }
}
