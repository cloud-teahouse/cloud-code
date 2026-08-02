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

import type { ThinkingEffort } from '@cloud-code/sdk';

import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { normalizeLegacyMetaKey } from '#/tui/utils/legacy-meta-key';
import { HoverState, underlineText } from '#/tui/utils/mouse-hover';

import { DialogFrame, inlineDialogMinSize } from './frame/dialog-frame';
import { effortLabel } from './model-selector';

export interface EffortSelectorOptions {
  readonly title?: string;
  /** Selectable thinking efforts for the current model (e.g. ["off","low","high","max"]). */
  readonly efforts: readonly ThinkingEffort[];
  /** Currently active effort (highlighted). */
  readonly currentValue: ThinkingEffort;
  readonly onSelect: (effort: ThinkingEffort) => void;
  /** When provided, Alt+S applies the choice to the current session only. */
  readonly onSessionOnlySelect?: (effort: ThinkingEffort) => void;
  readonly onCancel: () => void;
  /** When set, rendered as warning-colored lines directly below the key-hint
   * line; wraps instead of truncating when it exceeds the width (e.g. the
   * mid-conversation switch cost notice). */
  readonly warning?: string;
}

/**
 * Horizontal segmented picker for the `/effort` command.
 *
 * Mirrors the thinking control rendered under `/model` (see
 * `renderThinkingControl` in model-selector.ts): a single row of segments,
 * the active one wrapped in `[ ]`. ←/→ step the active segment, Enter
 * commits, and Alt+S (when provided) applies session-only.
 *
 * Mouse: the wheel steps the active segment like ←/→; a press activates the
 * hit segment, and a press on the already-active segment commits it (Enter
 * equivalent — see utils/mouse-hover); motion underlines the hovered
 * segment.
 */
export class EffortSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: EffortSelectorOptions;
  private activeIndex: number;
  /** Hovered segment index (mouse motion); null when the pointer is elsewhere. */
  private readonly hover = new HoverState();
  /** The dialog skeleton owning the chrome (divider/title/hint/warning) and
   * its row math. */
  private readonly frame = new DialogFrame({ titleIndent: ' ', minSize: inlineDialogMinSize() });
  /** Frame-relative hit zones of the last render (the effort segments) —
   * served from hitZones(). */
  private frameZones: HitZone[] = [];
  /** Width of the last render; direct handleMouse calls re-derive the zones
   * from the current state at this width (the TUI's zone dispatch uses the
   * render cache — a render always runs before dispatched input). */
  private lastRenderWidth = 80;

  constructor(opts: EffortSelectorOptions) {
    super();
    this.opts = opts;
    const idx = opts.efforts.indexOf(opts.currentValue);
    this.activeIndex = Math.max(idx, 0);
  }

  handleInput(data: string): void {
    // Legacy ESC-prefixed Alt bytes → CSI-u when Kitty is active (see
    // utils/legacy-meta-key); everything else passes through untouched.
    const normalized = normalizeLegacyMetaKey(data);
    if (matchesKey(normalized, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(normalized, Key.left)) {
      this.activeIndex = Math.max(0, this.activeIndex - 1);
      return;
    }
    if (matchesKey(normalized, Key.right)) {
      this.activeIndex = Math.min(this.opts.efforts.length - 1, this.activeIndex + 1);
      return;
    }
    if (matchesKey(normalized, Key.alt('s')) && this.opts.onSessionOnlySelect !== undefined) {
      this.opts.onSessionOnlySelect(this.opts.efforts[this.activeIndex]!);
      return;
    }
    if (matchesKey(normalized, Key.enter)) {
      this.opts.onSelect(this.opts.efforts[this.activeIndex]!);
      return;
    }
  }

  /** Mouse: the wheel steps the active segment like ←/→. Press and hover
   * targeting is declared as hit zones (see renderContent); the TUI
   * dispatches zone presses to {@link onHitZone} and tracks the hovered zone
   * via {@link setHoveredZone}. This handler keeps the wheel behavior and
   * routes presses/motion arriving outside the zone dispatch (e.g. direct
   * component-relative events) through the same zones. */
  handleMouse(event: MouseEvent): void | boolean {
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
    if (delta === 0 || this.opts.efforts.length === 0) return false;
    const next = Math.max(0, Math.min(this.opts.efforts.length - 1, this.activeIndex + delta));
    if (next === this.activeIndex) return false;
    this.activeIndex = next;
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
   * Zone press: the hit segment takes the active state — a press on the
   * already-active segment commits it (Enter equivalent — see
   * utils/mouse-hover for the uniform click semantics).
   */
  onHitZone(id: HitZoneId, _event: MouseEvent): void | boolean {
    if (typeof id !== 'number' || id < 0 || id >= this.opts.efforts.length) return false;
    if (id === this.activeIndex) {
      this.opts.onSelect(this.opts.efforts[this.activeIndex]!);
      return;
    }
    this.activeIndex = id;
    this.invalidate();
  }

  /** Zone hover: the hovered segment underlines; null clears. */
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
    const hintParts = [t('selectors.effort.hintSwitch'), t('common.hint.select')];
    if (this.opts.onSessionOnlySelect !== undefined) {
      hintParts.push(t('dialogs.model.hint.sessionOnly'));
    }
    hintParts.push(t('common.hint.cancel'));

    const { lines, zones } = this.renderContent();
    const frameLines = this.frame.render(width, {
      title: this.opts.title ?? t('selectors.effort.title'),
      hintParts,
      ...(this.opts.warning !== undefined
        ? { notice: { text: this.opts.warning, tone: 'warning' as const, wrap: 'ansi' as const } }
        : {}),
      content: lines,
      footer: [''],
    });
    this.frameZones = this.frame.zones(zones);
    return frameLines.map((line) => truncateToWidth(line, width));
  }

  /**
   * The content region (between the header blank and the footer): the single
   * segments row. Returns the line plus its content-relative hit zones (row 0
   * = the segments row) — one zone per segment, laid out with the same
   * two-space indent and two-space gaps as the rendered cells.
   */
  private renderContent(): { lines: string[]; zones: HitZone[] } {
    const segments = this.opts.efforts.map((effort, index) => {
      const label = effortLabel(effort);
      const styled =
        index === this.activeIndex
          ? currentTheme.boldFg('primary', `[ ${label} ]`)
          : currentTheme.fg('text', `  ${label}  `);
      return underlineText(styled, this.hover.isHovered(index));
    });
    const zones: HitZone[] = [];
    let col = 3; // the segments row starts with two spaces
    for (const [index, effort] of this.opts.efforts.entries()) {
      const width = visibleWidth(effortLabel(effort)) + 4;
      zones.push({ id: index, row: 0, col, width, height: 1 });
      col += width + 2;
    }
    return { lines: [`  ${segments.join('  ')}`], zones };
  }
}
