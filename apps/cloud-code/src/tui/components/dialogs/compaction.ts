/**
 * Renders a compaction block in the transcript.
 *
 * Lifecycle:
 *   - constructed on `compaction.started` → blinking white bullet +
 *     "Compacting context..." and optional custom instruction
 *   - `markDone()` on `compaction.completed` → solid green bullet +
 *     "Compaction complete (X → Y tokens)"
 *   - `markCanceled()` on `compaction.cancelled` → solid warning bullet +
 *     "Compaction cancelled"
 *
 * Bullet animation mirrors `ToolCallComponent` (500ms blink) so the user
 * reads the same "work in progress" signal across the UI.
 *
 * A completed block with a summary is expandable: ctrl+o (shared with tool
 * output) or a mouse click anywhere on the block; hovering whitens the gray
 * rows, matching the thinking/tool-card affordance.
 */

import {
  Container,
  Text,
  Spacer,
  type HitZone,
  type HitZoneId,
  type MouseEvent,
  type TUI,
} from '@cloud-code/pi-tui';

import { SHIMMER_INTERVAL_MS } from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { applyCardTone, type CardTone } from '#/tui/components/messages/card-tone';
import { blinkPhaseOn, shimmerText } from '#/tui/utils/shimmer';

/** Half-period of the bullet blink; the phase itself is wall-clock derived. */
const BLINK_HALF_PERIOD_MS = 500;

/** Hit-zone id of the block's single whole-region interactive area. */
const COMPACTION_HIT_ZONE = 'card';

/**
 * Placeholder interpolated for the bar so the progress line can be split
 * around it: the bar cells keep their own success/primary styling (glyphs
 * are never shimmered) while the textual tail takes the wave.
 */
const BAR_SENTINEL = '\u0001';

export class CompactionComponent extends Container {
  private readonly ui: TUI | undefined;
  private readonly headerText: Text;
  private progressText: Text | undefined;
  private instructionText: Text | undefined;
  private readonly instruction: string | undefined;
  private readonly tip: string | undefined;
  private readonly tokensBefore: number | undefined;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly estimatedTotalMs: number;
  private animationTimer: ReturnType<typeof setInterval> | null = null;
  private done = false;
  private canceled = false;
  private tokensBeforeDone: number | undefined;
  private tokensAfter: number | undefined;
  private summary: string | undefined;
  private summaryText: Text | undefined;
  private expanded = false;
  /** Set when the expansion came from a click: paints the gray region block. */
  private clickExpanded = false;
  /** Pointer hover over the block's zone: the gray rows render white. */
  private hovered = false;
  /** Geometry of the last render, captured for `hitZones()`. */
  private zoneMeta: { width: number; lines: number } | undefined;

  constructor(ui?: TUI, instruction?: string | undefined, tip?: string, tokensBefore?: number, now?: () => number) {
    super();
    this.ui = ui;
    this.instruction = instruction;
    this.tip = tip;
    this.tokensBefore = tokensBefore;
    this.now = now ?? Date.now;
    this.startedAt = this.now();
    // Bounded guess for the inherently indeterminate summarization wait:
    // ~5s base plus ~0.3ms per context token, clamped to [8s, 120s]. The bar
    // itself is capped at 95% until the real completion event lands.
    this.estimatedTotalMs = Math.min(
      120_000,
      Math.max(8_000, 5_000 + Math.round((tokensBefore ?? 0) * 0.3)),
    );

    // Top margin so the block isn't glued to the previous transcript
    // entry (status line, tool result, etc.).
    this.addChild(new Spacer(1));
    this.headerText = new Text(this.buildHeader(), 0, 0);
    this.addChild(this.headerText);
    this.progressText = new Text(this.buildProgressLine(), 0, 0);
    this.addChild(this.progressText);
    this.addInstructionChild();

    this.startAnimation();
  }

  private addInstructionChild(): void {
    if (this.instruction !== undefined) {
      this.instructionText = new Text(currentTheme.dim(`  ${this.instruction}`), 0, 0);
      this.addChild(this.instructionText);
    }
  }

  private removeInstructionChild(): void {
    if (this.instructionText === undefined) return;
    const index = this.children.indexOf(this.instructionText);
    if (index !== -1) {
      this.children.splice(index, 1);
    }
    this.instructionText = undefined;
  }

  override invalidate(): void {
    // Repaint the header with the active palette (it caches ANSI codes).
    this.headerText.setText(this.buildHeader());
    // Rebuild instruction and summary text with fresh theme colours, preserving
    // header → instruction → summary child order.
    const expanded = this.expanded;
    this.removeInstructionChild();
    if (expanded) {
      this.removeSummaryChild();
    }
    this.addInstructionChild();
    if (expanded) {
      this.addSummaryChild();
    }
    super.invalidate();
  }

  markDone(tokensBefore?: number, tokensAfter?: number, summary?: string): void {
    if (this.done || this.canceled) return;
    this.done = true;
    this.tokensBeforeDone = tokensBefore;
    this.tokensAfter = tokensAfter;
    this.summary = summary;
    this.stopAnimation();
    this.removeProgressChild();
    this.headerText.setText(this.buildHeader());
    if (this.expanded) {
      this.addSummaryChild();
    }
    this.ui?.requestRender();
  }

  markCanceled(): void {
    if (this.done || this.canceled) return;
    this.canceled = true;
    this.stopAnimation();
    this.removeProgressChild();
    this.headerText.setText(this.buildHeader());
    this.ui?.requestRender();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    // The keyboard path (ctrl+o, collapse-all) always lands in the
    // background-free form; a collapse also clears a click expansion's block.
    this.clickExpanded = false;
    if (expanded) {
      this.addSummaryChild();
    } else {
      this.removeSummaryChild();
    }
    this.headerText.setText(this.buildHeader());
    this.ui?.requestRender();
  }

  private addSummaryChild(): void {
    if (this.summaryText !== undefined || this.summary === undefined || this.summary.length === 0) {
      return;
    }
    const indentedSummary = this.summary
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
    this.summaryText = new Text(currentTheme.dim(indentedSummary), 0, 0);
    this.addChild(this.summaryText);
  }

  private removeSummaryChild(): void {
    if (this.summaryText === undefined) return;
    const index = this.children.indexOf(this.summaryText);
    if (index !== -1) {
      this.children.splice(index, 1);
    }
    this.summaryText = undefined;
  }

  dispose(): void {
    this.stopAnimation();
  }

  private buildHeader(): string {
    if (this.done) {
      const bullet = currentTheme.fg('success', STATUS_BULLET);
      const label = currentTheme.boldFg('success', t('selectors.compaction.complete'));
      const detail =
        this.tokensBeforeDone !== undefined && this.tokensAfter !== undefined
          ? currentTheme.dim(
              t('selectors.compaction.tokens', {
                before: this.tokensBeforeDone,
                after: this.tokensAfter,
              }),
            )
          : '';
      const shortcutHint =
        this.summary !== undefined && this.summary.length > 0
          ? currentTheme.dim(
              this.expanded
                ? t('selectors.compaction.hintHide')
                : t('selectors.compaction.hintShow'),
            )
          : '';
      return `${bullet}${label}${detail}${shortcutHint}`;
    }
    if (this.canceled) {
      const bullet = currentTheme.fg('warning', STATUS_BULLET);
      const label = currentTheme.boldFg('warning', t('selectors.compaction.cancelled'));
      return `${bullet}${label}`;
    }
    const bullet = blinkPhaseOn(this.now(), BLINK_HALF_PERIOD_MS)
      ? currentTheme.fg('text', STATUS_BULLET)
      : '  ';
    const label = shimmerText(t('selectors.compaction.compacting'), this.now());
    const tip = this.tip
      ? currentTheme.fg('textDim', t('selectors.compaction.tip', { tip: this.tip }))
      : '';
    return `${bullet}${label}${tip}`;
  }

  private startAnimation(): void {
    // Tick at the shared shimmer cadence: the bullet phase (500ms) and the
    // shimmer wave (100ms) both derive from wall-clock at build time, so the
    // interval only schedules repaints — timer drift never bends the rhythm,
    // and the wave advances one bucket per frame instead of jumping several.
    this.animationTimer = setInterval(() => {
      this.headerText.setText(this.buildHeader());
      this.progressText?.setText(this.buildProgressLine());
      this.ui?.requestRender();
    }, SHIMMER_INTERVAL_MS);
  }

  override render(width: number): string[] {
    // The progress line is time-derived — refresh it at render time, not only
    // on the animation tick, so every repaint shows the current estimate.
    this.progressText?.setText(this.buildProgressLine());
    const base = super.render(width);
    this.zoneMeta = { width, lines: base.length };
    const tone: CardTone = this.clickExpanded ? 'click' : this.hovered ? 'hover' : 'normal';
    if (tone === 'normal') return base;
    // Child 0 is the leading spacer — the tone starts at the header.
    return applyCardTone(base, { width, tone, bgFrom: 1 });
  }

  private stopAnimation(): void {
    if (this.animationTimer !== null) {
      clearInterval(this.animationTimer);
      this.animationTimer = null;
    }
  }

  /** The block is mouse-expandable once a completed compaction has a summary. */
  private isSummaryExpandable(): boolean {
    return this.done && this.summary !== undefined && this.summary.length > 0;
  }

  /**
   * The block's single hit zone: its rendered region below the leading
   * spacer. Registered only while a finished block hides (or shows, so a
   * click can fold it back) the summary — a running or summary-less block
   * stays click/hover inert, matching the thinking blocks.
   */
  hitZones(): Iterable<HitZone> {
    const meta = this.zoneMeta;
    if (meta === undefined || !this.isSummaryExpandable() || meta.lines <= 1) return [];
    return [{ id: COMPACTION_HIT_ZONE, row: 1, col: 1, width: meta.width, height: meta.lines - 1 }];
  }

  onHitZone(id: HitZoneId, _event: MouseEvent): void | boolean {
    if (id !== COMPACTION_HIT_ZONE) return false;
    // Click expansion paints the gray region block (like the tool cards);
    // clicking an expanded block folds it back, whatever the expansion path.
    if (this.expanded) {
      this.setExpanded(false);
    } else {
      this.expanded = true;
      this.clickExpanded = true;
      this.addSummaryChild();
      this.headerText.setText(this.buildHeader());
      this.ui?.requestRender();
    }
  }

  setHoveredZone(id: HitZoneId | null): void | boolean {
    const hovered = id === COMPACTION_HIT_ZONE;
    if (hovered === this.hovered) return false;
    this.hovered = hovered;
  }

  /**
   * Estimated progress of the summarization wait, capped at 95% — the real
   * completion event (markDone) is what takes it to 100%. The estimate is
   * time-based off `estimatedTotalMs`; the phases are cosmetic bands of it.
   * Styled after the Agent Swarm status bar: `━` line, filled part green,
   * the rest blue.
   */
  private buildProgressLine(): string {
    const elapsedMs = Math.max(0, this.now() - this.startedAt);
    const ratio = Math.min(elapsedMs / this.estimatedTotalMs, 0.95);
    const cells = 12;
    const filled = Math.min(cells, Math.round(ratio * cells));
    const bar =
      currentTheme.fg('success', '━'.repeat(filled)) +
      currentTheme.fg('primary', '━'.repeat(cells - filled));
    const percent = Math.floor(ratio * 100);
    const phaseKey =
      ratio < 0.15
        ? 'selectors.compaction.phase.building'
        : ratio < 0.95
          ? 'selectors.compaction.phase.summarizing'
          : 'selectors.compaction.phase.finishing';
    // The bar glyphs keep their fill styling; the textual tail (percent,
    // phase, elapsed) takes the shimmer wave while the wait is in flight.
    const composed = t('selectors.compaction.progressLine', {
      bar: BAR_SENTINEL,
      percent,
      phase: t(phaseKey),
      seconds: Math.floor(elapsedMs / 1000),
    });
    const splitAt = composed.indexOf(BAR_SENTINEL);
    if (splitAt === -1) return currentTheme.dim(composed);
    const before = composed.slice(0, splitAt);
    const after = composed.slice(splitAt + BAR_SENTINEL.length);
    return currentTheme.dim(before) + bar + shimmerText(after, this.now());
  }

  private removeProgressChild(): void {
    if (this.progressText === undefined) return;
    const index = this.children.indexOf(this.progressText);
    if (index !== -1) {
      this.children.splice(index, 1);
    }
    this.progressText = undefined;
  }
}
