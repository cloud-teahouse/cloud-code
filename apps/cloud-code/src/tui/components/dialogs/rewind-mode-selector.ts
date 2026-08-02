import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  hitZoneAt,
  type Focusable,
  type HitZone,
  type HitZoneId,
  type MouseEvent,
} from '@cloud-code/pi-tui';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { resolveDescription, t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { HoverState, underlineText } from '#/tui/utils/mouse-hover';
import { SearchableList, type SearchableListView } from '#/tui/utils/searchable-list';

import { DialogFrame, inlineDialogMinSize } from './frame/dialog-frame';

export type RewindMode = 'code' | 'conversation' | 'both';

export interface RewindModeChoice {
  readonly mode: RewindMode;
  /** i18n keys, resolved at render time. */
  readonly label: string;
  readonly hint: string;
}

export const REWIND_MODE_CHOICES: readonly RewindModeChoice[] = [
  {
    mode: 'both',
    label: 'dialogs.rewind.both.label',
    hint: 'dialogs.rewind.both.hint',
  },
  {
    mode: 'conversation',
    label: 'dialogs.rewind.conversation.label',
    hint: 'dialogs.rewind.conversation.hint',
  },
  {
    mode: 'code',
    label: 'dialogs.rewind.code.label',
    hint: 'dialogs.rewind.code.hint',
  },
];

export interface RewindModeSelectorOptions {
  readonly onSelect: (choice: RewindModeChoice) => void;
  readonly onCancel: () => void;
}

/**
 * Second step of the /rewind flow (after the message anchor pick), mirroring
 * Claude Code's rewind mode choice. Focus starts on the first entry
 * ("Restore code and conversation"), the default for a bare Enter.
 */
export class RewindModeSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: RewindModeSelectorOptions;
  private readonly list: SearchableList<RewindModeChoice>;
  private submitted = false;
  /** Hovered choice index (mouse motion); null when the pointer is elsewhere. */
  private readonly hover = new HoverState();
  /** The dialog skeleton owning the chrome (divider/title/hint) and its row
   * math. */
  private readonly frame = new DialogFrame({ titleIndent: ' ', minSize: inlineDialogMinSize() });
  /** Frame-relative hit zones of the last render (the choice rows) — served
   * from hitZones(). */
  private frameZones: HitZone[] = [];
  /** Width of the last render; direct handleMouse calls re-derive the zones
   * from the current state at this width (the TUI's zone dispatch uses the
   * render cache — a render always runs before dispatched input). */
  private lastRenderWidth = 80;

  constructor(opts: RewindModeSelectorOptions) {
    super();
    this.opts = opts;
    this.list = new SearchableList({
      items: REWIND_MODE_CHOICES,
      toSearchText: (choice) => choice.label,
      initialIndex: 0,
    });
  }

  handleInput(data: string): void {
    if (this.submitted) return;

    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }

    if (this.list.handleKey(data)) {
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const selected = this.list.selected();
      if (selected !== undefined) {
        this.submitted = true;
        this.opts.onSelect(selected);
      }
    }
  }

  /** Mouse: the wheel moves the cursor one row per tick, clamped by
   * SearchableList exactly like ↑/↓. Press and hover targeting is declared as
   * hit zones (see renderContent); the TUI dispatches zone presses to
   * {@link onHitZone} and tracks the hovered zone via {@link setHoveredZone}.
   * This handler keeps the wheel behavior and routes presses/motion arriving
   * outside the zone dispatch (e.g. direct component-relative events) through
   * the same zones. Ignored once a selection was submitted. */
  handleMouse(event: MouseEvent): void | boolean {
    if (this.submitted) return false;
    // Re-derived from the current state: direct callers (unit tests) may fire
    // keys without an intervening render, so the render cache can be stale.
    const zones = this.currentZones();
    if (event.type === 'motion') {
      const zone = event.row < 0 ? null : hitZoneAt(zones, event.row, event.col, 'hover');
      return this.setHoveredZone(zone?.id ?? null);
    }
    if (event.type === 'press' && event.button === 0) {
      const zone = hitZoneAt(zones, event.row, event.col, 'action');
      if (zone === null) return false;
      return this.onHitZone(zone.id, event);
    }
    if (event.type !== 'wheel') return false;
    const delta = event.button === 64 ? -1 : event.button === 65 ? 1 : 0;
    if (delta === 0 || this.list.view().items.length === 0) return false;
    if (delta < 0) this.list.moveUp();
    else this.list.moveDown();
    this.invalidate();
  }

  /** The declared zones of the last render. */
  hitZones(): Iterable<HitZone> {
    return this.frameZones;
  }

  /** Zones derived from the current state at the last render width (a
   * discarded render refreshes the cache). The handleMouse fallback consults
   * these so it never acts on a stale layout. */
  private currentZones(): HitZone[] {
    this.render(this.lastRenderWidth);
    return this.frameZones;
  }

  /**
   * Zone press: the hit choice row takes the cursor — a press on the
   * already-selected row confirms it (Enter equivalent — see
   * utils/mouse-hover for the uniform click semantics).
   */
  onHitZone(id: HitZoneId, _event: MouseEvent): void | boolean {
    const hit = typeof id === 'number' ? id : null;
    const view = this.list.view();
    if (hit === null || hit < 0 || hit >= view.items.length) return false;
    if (hit === view.selectedIndex) {
      const selected = this.list.selected();
      if (selected !== undefined) {
        this.submitted = true;
        this.opts.onSelect(selected);
      }
      return;
    }
    this.list.selectIndex(hit);
    this.invalidate();
  }

  /** Zone hover: the hovered choice row underlines; null clears. */
  setHoveredZone(id: HitZoneId | null): void | boolean {
    const changed = this.hover.update(typeof id === 'number' ? id : null);
    if (changed) this.invalidate();
    return changed ? undefined : false;
  }

  override render(width: number): string[] {
    this.lastRenderWidth = width;
    const tooSmall = this.frame.tooSmall(width);
    if (tooSmall !== null) {
      this.frameZones = [];
      return tooSmall;
    }
    const view = this.list.view();
    const hintParts = [t('common.hint.navigate'), t('common.hint.select'), t('common.hint.cancel')];

    const { lines, zones } = this.renderContent(width, view);
    const frameLines = this.frame.render(width, {
      title: t('dialogs.rewind.title'),
      hintParts,
      content: lines,
      footer: [''],
    });
    this.frameZones = this.frame.zones(zones);
    return frameLines.map((line) => truncateToWidth(line, width));
  }

  /**
   * The content region (between the header blank and the footer): every
   * choice on its own row — the list is never paged. Returns the lines plus
   * the content-relative hit zones (row 0 = first content line; one
   * full-width zone per choice). Once a selection was submitted the dialog
   * ignores the mouse, so no zones are declared.
   */
  private renderContent(
    width: number,
    view: SearchableListView<RewindModeChoice>,
  ): { lines: string[]; zones: HitZone[] } {
    const lines: string[] = [];
    const zones: HitZone[] = [];
    if (view.items.length === 0) {
      lines.push(currentTheme.fg('textMuted', `   ${t('dialogs.rewind.empty')}`));
      return { lines, zones };
    }
    for (let i = 0; i < view.items.length; i++) {
      const choice = view.items[i];
      if (choice === undefined) continue;
      const row = lines.length;
      lines.push(
        underlineText(
          this.renderChoiceLine(choice, i === view.selectedIndex, width),
          this.hover.isHovered(i),
        ),
      );
      if (!this.submitted) zones.push({ id: i, row, col: 1, width, height: 1 });
    }
    return { lines, zones };
  }

  private renderChoiceLine(choice: RewindModeChoice, isSelected: boolean, width: number): string {
    const pointer = isSelected ? SELECT_POINTER : ' ';
    const prefix = `  ${pointer} `;
    const labelBudget = Math.max(8, width - visibleWidth(prefix));
    const label = truncateToWidth(
      `${resolveDescription(choice.label)} — ${resolveDescription(choice.hint)}`,
      labelBudget,
      '…',
    );
    let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', prefix);
    line += isSelected
      ? currentTheme.boldFg('primary', label)
      : currentTheme.fg('text', label);
    return line;
  }
}
