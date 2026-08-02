import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  hitZoneAt,
  type Component,
  type Focusable,
  type HitZone,
  type HitZoneId,
  type MouseEvent,
} from '@cloud-code/pi-tui';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { resolveDescription, t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { wrapHintText } from '#/tui/utils/hint';
import { HoverState, underlineText } from '#/tui/utils/mouse-hover';

import { DialogFrame, inlineDialogMinSize } from './frame/dialog-frame';

export type StartPermissionChoice = 'auto' | 'yolo' | 'manual' | 'cancel';

export interface StartPermissionOption<TChoice extends StartPermissionChoice = StartPermissionChoice> {
  readonly value: TChoice;
  readonly label: string;
  readonly description: string;
}

export interface StartPermissionPromptOptions<
  TChoice extends StartPermissionChoice = StartPermissionChoice,
> {
  readonly title: string;
  readonly noticeLines: readonly string[];
  readonly options: readonly StartPermissionOption<TChoice>[];
  readonly onSelect: (choice: TChoice) => void;
  readonly onCancel: () => void;
}

export class StartPermissionPromptComponent<TChoice extends StartPermissionChoice = StartPermissionChoice>
  implements Component, Focusable
{
  focused = false;
  private selectedIndex = 0;
  /** Hovered option index (mouse motion); null when the pointer is elsewhere. */
  private readonly hover = new HoverState();
  /** The dialog skeleton owning the chrome (divider/title/hint) and its row math. */
  private readonly frame = new DialogFrame({
    titleIndent: ' ',
    hintIndent: '',
    minSize: inlineDialogMinSize(),
    // The hint lines arrive pre-wrapped and pre-styled (see render); the
    // frame must not re-style them.
    formatHintLine: (line) => line,
  });
  /** Frame-relative hit zones of the last render (one per option row) —
   * served from hitZones(). */
  private frameZones: HitZone[] = [];
  /** Width of the last render; direct handleMouse calls re-derive the zones
   * from the current state at this width (the TUI's zone dispatch uses the
   * render cache — a render always runs before dispatched input). */
  private lastRenderWidth = 80;

  constructor(private readonly opts: StartPermissionPromptOptions<TChoice>) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.opts.options.length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      this.opts.onSelect(this.opts.options[this.selectedIndex]!.value);
    }
  }

  /** Mouse: the wheel moves the highlight, clamped like ↑/↓. Left-press
   * highlights the hit option; a press on the already-highlighted option
   * confirms it (Enter equivalent — see utils/mouse-hover). Motion
   * underlines the hovered option's label row.
   *
   * Press and hover targeting is declared as hit zones (one per option row —
   * see renderContent); the TUI dispatches zone presses to {@link onHitZone}
   * and tracks the hovered zone via {@link setHoveredZone}. This handler keeps
   * the wheel behavior and routes presses/motion arriving outside the zone
   * dispatch (e.g. direct component-relative events) through the same zones. */
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
    if (delta === 0 || this.opts.options.length === 0) return false;
    const next = Math.max(0, Math.min(this.opts.options.length - 1, this.selectedIndex + delta));
    if (next === this.selectedIndex) return false;
    this.selectedIndex = next;
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

  /** Zone press: the zone id is the option index — a press highlights, a
   * press on the highlighted option confirms it. */
  onHitZone(id: HitZoneId, _event: MouseEvent): void | boolean {
    const hit = typeof id === 'number' ? id : null;
    if (hit === null || hit < 0 || hit >= this.opts.options.length) return false;
    if (hit === this.selectedIndex) {
      this.opts.onSelect(this.opts.options[this.selectedIndex]!.value);
      return;
    }
    this.selectedIndex = hit;
    this.invalidate();
  }

  /** Zone hover: the hovered option's label row underlines; null clears. */
  setHoveredZone(id: HitZoneId | null): void | boolean {
    const changed = this.hover.update(typeof id === 'number' ? id : null);
    if (changed) this.invalidate();
    return changed ? undefined : false;
  }

  render(width: number): string[] {
    this.lastRenderWidth = width;
    const tooSmall = this.frame.tooSmall(width);
    if (tooSmall !== null) {
      this.frameZones = [];
      return tooSmall;
    }
    const { lines, zones } = this.renderContent(width);
    const frameLines = this.frame.render(width, {
      title: resolveDescription(this.opts.title),
      // Wrap the raw hint at segment boundaries before styling, so narrow
      // widths wrap instead of clipping the tail segments.
      hintLines: wrapHintText(t('approval.startPrompt.hint'), width).map((line) =>
        currentTheme.fg('textMuted', line),
      ),
      content: lines,
    });
    this.frameZones = this.frame.zones(zones);
    return frameLines.map((line) => truncateToWidth(line, width));
  }

  /**
   * The content region (everything between the hint's blank line and the
   * closing divider): the wrapped notice paragraphs, then one label row per
   * option plus its wrapped description and a trailing blank. Returns the
   * lines plus the content-relative hit zones (row 0 = first content line;
   * one zone per option, spanning its label, description, and trailing blank).
   */
  private renderContent(width: number): { lines: string[]; zones: HitZone[] } {
    const lines: string[] = [];
    const zones: HitZone[] = [];

    const textWidth = Math.max(20, width - 2);
    for (const paragraph of this.opts.noticeLines) {
      for (const line of wrapPlain(resolveDescription(paragraph), textWidth)) {
        lines.push(` ${styleModeNames(line, 'textMuted')}`);
      }
      lines.push('');
    }

    for (let i = 0; i < this.opts.options.length; i += 1) {
      const option = this.opts.options[i]!;
      const selected = i === this.selectedIndex;
      const pointer = selected ? SELECT_POINTER : ' ';
      const optionTop = lines.length;
      lines.push(
        underlineText(
          currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `) +
            styleLabel(resolveDescription(option.label), selected),
          this.hover.isHovered(i),
        ),
      );
      for (const line of wrapPlain(resolveDescription(option.description), Math.max(20, width - 4))) {
        lines.push(`    ${styleModeNames(line, 'textMuted')}`);
      }
      lines.push('');
      zones.push({ id: i, row: optionTop, col: 1, width, height: lines.length - optionTop });
    }
    return { lines, zones };
  }
}

function styleLabel(label: string, selected: boolean): string {
  if (selected) return currentTheme.boldFg('primary', label);
  return styleModeNames(label, 'text');
}

function styleModeNames(text: string, baseToken: 'text' | 'textMuted'): string {
  return text
    .split(/(\b(?:Manual|Auto|YOLO)\b)/g)
    .map((part) => {
      if (part === 'Manual' || part === 'Auto' || part === 'YOLO') return currentTheme.boldFg('textStrong', part);
      return currentTheme.fg(baseToken, part);
    })
    .join('');
}

function wrapPlain(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current = visibleWidth(word) <= width ? word : truncateToWidth(word, width, '…');
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [''];
}
