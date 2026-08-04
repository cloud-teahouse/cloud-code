import { Container, Text, truncateToWidth, visibleWidth } from '@cloud-code/pi-tui';
import type { Component, HitZone, HitZoneId, MouseEvent } from '@cloud-code/pi-tui';

import { RESULT_PREVIEW_LINES } from '#/tui/constant/rendering';
import { COMMAND_OUTPUT_MARK } from '#/tui/constant/symbols';
import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';

import { applyCardTone, type CardTone } from '#/tui/components/messages/card-tone';
import { prefixCommandOutputRows } from '#/tui/components/messages/shell-execution';
import { formatBashOutputForDisplay, sanitizeShellOutput } from '#/tui/utils/shell-output';

const RUNNING_TAIL_LINES = 5;
const TIMER_INTERVAL_MS = 1000;
// Cap the live running buffer so a command that spews output for minutes can't
// grow memory without bound or make every render re-strip a multi-MB string.
// Only affects the transient running tail; the final view uses the full
// captured stdout/stderr passed to finish().
const MAX_COMBINED_CHARS = 256 * 1024;
const KEEP_COMBINED_CHARS = 64 * 1024;

/** Hit-zone id of the card's single whole-card interactive region. */
const CARD_HIT_ZONE = 'card';

/**
 * Folded final view of a `!` command: the full captured stdout/stderr, capped
 * to the shared preview height when collapsed (with the same
 * `... (+N more lines, ctrl+o to expand)` hint tool cards use) and rendered
 * whole when expanded. Rows carry the command-card `⎿` shape flush left, so
 * the mark sits on the dialog cards' ● bullet column (aligned with the `$`
 * echo above) and the output text falls on the dialog text column.
 */
class FinishedShellRunBody implements Component {
  private readonly textComponent: Text;
  private expanded = false;

  constructor(coloredOutput: string) {
    this.textComponent = new Text(coloredOutput, 0, 0);
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  invalidate(): void {
    this.textComponent.invalidate();
  }

  /** Rows the collapsed fold hides at `width`; 0 when expanded or all fits. */
  collapsedHiddenRows(width: number): number {
    if (this.expanded) return 0;
    const prefixWidth = visibleWidth(COMMAND_OUTPUT_MARK);
    const contentWidth = Math.max(1, width - prefixWidth);
    return Math.max(0, this.textComponent.render(contentWidth).length - RESULT_PREVIEW_LINES);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    // Folding counts visual rows (wrapped), matching TruncatedOutputComponent
    // on the tool cards — a long single-line blob folds to the same height.
    const prefixWidth = visibleWidth(COMMAND_OUTPUT_MARK);
    const contentWidth = Math.max(1, safeWidth - prefixWidth);
    const contentLines = this.textComponent.render(contentWidth);
    let rows = contentLines;
    if (!this.expanded && contentLines.length > RESULT_PREVIEW_LINES) {
      const remaining = contentLines.length - RESULT_PREVIEW_LINES;
      const hint = currentTheme.fg(
        'textDim',
        truncateToWidth(t('messages.truncated.moreLinesExpand', { count: remaining }), contentWidth, '…'),
      );
      rows = [...contentLines.slice(0, RESULT_PREVIEW_LINES), hint];
    }
    return prefixCommandOutputRows(rows).map((line) => truncateToWidth(line, safeWidth, '…'));
  }
}

/**
 * Live view for a user-initiated `!` shell command. Two phases:
 *
 *  - running: dim, ANSI-stripped tail of the combined output, a `+N lines`
 *    overflow marker, an elapsed `(Xs)` timer that ticks every second, and a
 *    `(ctrl+b to run in background)` hint — matching claude-code's running card
 *    so warnings are grey rather than red while the command works. The tail
 *    window is the running fold; keyboard/click expansion only affects the
 *    finished view.
 *  - finished: the standard `formatBashOutputForDisplay` view (stderr red only
 *    on failure) folded to the preview cap, with the same expansion contract
 *    as tool cards: ctrl+o expands/collapses globally (keyboard state), a
 *    click toggles the individual card (painted with the region background),
 *    and hover whitens the detail body.
 *
 * Hardened so a misbehaving command can never crash the TUI: the running
 * buffer is capped, and every render/render-request path swallows errors.
 */
export class ShellRunComponent extends Container {
  private readonly textComponent: Text;
  private finishedBody: FinishedShellRunBody | undefined;
  private combined = '';
  private running = true;
  private backgrounded = false;
  private disposed = false;
  private readonly startedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | undefined;

  /**
   * Expansion state of the card, same contract as ToolCallComponent:
   *   collapsed: folded preview form.
   *   keyboard:  full content via the global ctrl+o toggle — gray text, no
   *              background.
   *   click:     full content via an individual mouse click — white content
   *              on the gray region background.
   */
  private expansion: 'collapsed' | 'keyboard' | 'click' = 'collapsed';
  /** Pointer hover over the card's zone: the dim body renders white. */
  private hovered = false;
  /** Geometry of the last render, captured for `hitZones()`. */
  private zoneMeta: { width: number; lines: number; expandable: boolean } | undefined;
  private renderCache: { width: number; lines: string[] } | undefined;
  private toneCache:
    | { base: string[]; width: number; tone: CardTone; out: string[] }
    | undefined;

  constructor(private readonly requestRender: () => void) {
    super();
    this.textComponent = new Text(this.renderText(), 0, 0);
    this.addChild(this.textComponent);
    this.timer = setInterval(() => this.tick(), TIMER_INTERVAL_MS);
  }

  append(text: string): void {
    if (this.disposed || !this.running || text.length === 0) return;
    this.combined += text;
    if (this.combined.length > MAX_COMBINED_CHARS) {
      this.combined = this.combined.slice(-KEEP_COMBINED_CHARS);
    }
    this.flush();
  }

  finish(stdout: string, stderr: string, isError?: boolean): void {
    if (this.disposed || !this.running) return;
    this.running = false;
    this.clearTimer();
    // Swap the live tail for the folded final view; the running Text child is
    // dropped so the finished body owns every rendered row.
    this.finishedBody = new FinishedShellRunBody(
      formatBashOutputForDisplay(stdout, stderr, isError),
    );
    this.finishedBody.setExpanded(this.expansion !== 'collapsed');
    this.clear();
    this.addChild(this.finishedBody);
    this.flush();
  }

  finishBackgrounded(): void {
    if (this.disposed || !this.running) return;
    this.running = false;
    this.backgrounded = true;
    this.clearTimer();
    this.flush();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  /**
   * Keyboard/global expansion path (ctrl+o): expanding maps to the 'keyboard'
   * state, collapsing always lands in 'collapsed'. A click-expanded card keeps
   * its click state (and its background) through an expand pass.
   */
  setExpanded(expanded: boolean): void {
    const next = expanded
      ? this.expansion === 'click'
        ? 'click'
        : 'keyboard'
      : 'collapsed';
    this.setExpansionState(next);
  }

  /** Click expansion path: painted with the region background. */
  setClickExpanded(expanded: boolean): void {
    this.setExpansionState(expanded ? 'click' : this.expansion === 'click' ? 'collapsed' : this.expansion);
  }

  /**
   * Mouse toggle: a collapsed card click-expands; an expanded one collapses —
   * including keyboard-expanded cards, which collapse individually.
   */
  private toggleClickExpansion(): void {
    this.setExpansionState(this.expansion === 'collapsed' ? 'click' : 'collapsed');
  }

  private setExpansionState(next: 'collapsed' | 'keyboard' | 'click'): void {
    if (this.expansion === next) return;
    this.expansion = next;
    this.finishedBody?.setExpanded(next !== 'collapsed');
    this.flush();
  }

  /**
   * The card's single hit zone: its whole rendered region. Registered only
   * once the finished view has folded rows to expand into (or is expanded
   * and can collapse back) — the running tail and short outputs stay inert.
   */
  hitZones(): Iterable<HitZone> {
    const meta = this.zoneMeta;
    if (meta === undefined || meta.lines <= 0 || !meta.expandable) return [];
    return [{ id: CARD_HIT_ZONE, row: 0, col: 1, width: meta.width, height: meta.lines }];
  }

  onHitZone(id: HitZoneId, _event: MouseEvent): void | boolean {
    if (id !== CARD_HIT_ZONE) return false;
    this.toggleClickExpansion();
  }

  setHoveredZone(id: HitZoneId | null): void | boolean {
    const hovered = id === CARD_HIT_ZONE;
    if (hovered === this.hovered) return false;
    this.hovered = hovered;
  }

  private tick(): void {
    if (!this.running) return;
    this.flush();
  }

  private flush(): void {
    if (this.disposed) return;
    try {
      this.renderCache = undefined;
      if (this.finishedBody === undefined) {
        this.textComponent.setText(this.renderText());
      }
      this.requestRender();
    } catch {
      // Never let a render/render-request error escape into a timer or event
      // handler — an uncaught exception there can take down the whole TUI.
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    let base: string[] | undefined;
    if (
      isRenderCacheEnabled() &&
      this.renderCache !== undefined &&
      this.renderCache.width === safeWidth
    ) {
      base = this.renderCache.lines;
    } else {
      base = super.render(safeWidth);
      if (isRenderCacheEnabled()) {
        this.renderCache = { width: safeWidth, lines: base };
      }
    }
    // The card is interactive only once the finished view has folded rows a
    // click/ctrl+o can reveal (or while expanded, so a click collapses back).
    const expandable =
      !this.running &&
      (this.expansion !== 'collapsed' ||
        (this.finishedBody?.collapsedHiddenRows(safeWidth) ?? 0) > 0);
    this.zoneMeta = { width: safeWidth, lines: base.length, expandable };
    return this.applyTone(base, safeWidth);
  }

  override invalidate(): void {
    this.renderCache = undefined;
    super.invalidate();
  }

  /**
   * Paint the interaction tone over the rendered base lines, like the tool
   * cards: a click-expanded card gets white content on the gray region
   * background, a hovered one just whitens its detail body. The card has no
   * leading spacer or header, so the tone covers every row.
   */
  private applyTone(base: string[], width: number): string[] {
    const tone: CardTone =
      this.expansion === 'click' ? 'click' : this.hovered ? 'hover' : 'normal';
    if (tone === 'normal') return base;
    const cached = this.toneCache;
    if (cached !== undefined && cached.base === base && cached.width === width && cached.tone === tone) {
      return cached.out;
    }
    const out = applyCardTone(base, { width, tone, bgFrom: 0 });
    this.toneCache = { base, width, tone, out };
    return out;
  }

  private renderText(): string {
    try {
      // Every row carries the command-card output shape flush left: a `⎿` on
      // the first row at the dialog cards' ● bullet column (aligned with the
      // `$` of the command echo above), continuation rows under the text —
      // the same shape Bash tool cards use, without their extra body indent.
      return prefixCommandOutputRows(this.bodyRows()).join('\n');
    } catch {
      return `${COMMAND_OUTPUT_MARK}${t('notices.shellRun.outputUnavailable')}`;
    }
  }

  private bodyRows(): string[] {
    const dim = (s: string): string => currentTheme.fg('textDim', s);
    if (this.backgrounded) {
      return [dim(t('status.detach.moved'))];
    }
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const trimmed = sanitizeShellOutput(this.combined).trimEnd();
    const rows: string[] = [];
    let extra = 0;
    if (trimmed.length === 0) {
      rows.push(dim(t('notices.shellRun.running')));
    } else {
      const lines = trimmed.split('\n');
      const tail = lines.slice(-RUNNING_TAIL_LINES);
      extra = Math.max(0, lines.length - RUNNING_TAIL_LINES);
      for (const line of tail) rows.push(dim(line));
    }
    rows.push(dim(`${extra > 0 ? t('notices.shellRun.overflow', { count: extra }) : ''}(${elapsed}s)`));
    rows.push(dim(t('notices.shellRun.backgroundHint')));
    return rows;
  }
}
