/**
 * Renders thinking content in the transcript.
 * Supports live in-place updates while thinking streams, then finalizes
 * without replacing the component.
 * Supports expand/collapse via Ctrl+O (shared with tool output) and via mouse
 * click on the block — registered only while the folded form hides lines, so
 * a fully-visible block stays click/hover inert, matching the tool cards.
 */

import { Text, truncateToWidth, type Component, type TUI } from '@cloud-code/pi-tui';
import type { HitZone, HitZoneId, MouseEvent } from '@cloud-code/pi-tui';

import {
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_INTERVAL_MS,
  MESSAGE_INDENT,
  THINKING_PREVIEW_LINES,
} from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';
import { shimmerText } from '#/tui/utils/shimmer';

import { applyCardTone, type CardTone } from './card-tone';

export type ThinkingRenderMode = 'live' | 'finalized';

/** Hit-zone id of the block's single whole-region interactive area. */
const THINKING_HIT_ZONE = 'card';

export class ThinkingComponent implements Component {
  private text: string;
  private showMarker: boolean;
  private mode: ThinkingRenderMode;
  private expanded = false;
  private readonly ui: TUI | undefined;
  private spinnerFrame = 0;
  /** Shimmer wavefront position for the live title; advances on the spinner tick. */
  private shimmerFrame = 0;
  private spinnerInterval: ReturnType<typeof setInterval> | undefined;
  /** Pointer hover over the block's zone: the gray text renders white. */
  private hovered = false;
  /** Geometry of the last render, captured for `hitZones()`. */
  private zoneMeta: { width: number; lines: number; expandable: boolean } | undefined;
  /**
   * Tone post-process cache keyed on the base lines' identity, mirroring the
   * tool cards: a hovered block returns a referentially stable line array so
   * the differential renderer keeps skipping its untouched rows.
   */
  private toneCache:
    | { base: string[]; width: number; tone: CardTone; out: string[] }
    | undefined;
  // Hold a single Text instance so pi-tui's (text, width) → lines cache
  // actually survives across renders. Re-constructing per render destroys
  // the cache and forces full re-wrap on every frame, which dominates CPU
  // once the transcript accumulates many finalized thinking blocks.
  private readonly textComponent: Text;

  private renderCache: { width: number; lines: string[] } | undefined;

  constructor(
    text: string,
    showMarker: boolean = true,
    mode: ThinkingRenderMode = 'finalized',
    ui?: TUI,
  ) {
    this.text = text;
    this.showMarker = showMarker;
    this.mode = mode;
    this.ui = ui;
    this.textComponent = new Text(this.styled(text), 0, 0);
    if (mode === 'live') {
      this.startSpinner();
    }
  }

  private markRenderDirty(): void {
    this.renderCache = undefined;
  }

  invalidate(): void {
    this.markRenderDirty();
    this.textComponent.setText(this.styled(this.text));
  }

  setText(text: string): void {
    if (this.text === text) return;
    this.text = text;
    this.markRenderDirty();
    this.textComponent.setText(this.styled(text));
  }

  private styled(text: string): string {
    return currentTheme.italicFg('textDim', text);
  }

  finalize(): void {
    this.mode = 'finalized';
    this.markRenderDirty();
    this.stopSpinner();
  }

  dispose(): void {
    this.stopSpinner();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.markRenderDirty();
  }

  /**
   * The block's single hit zone: its rendered region below the leading blank
   * row. Registered only while the folded form hides lines (or the block is
   * expanded and a click can collapse it back) — the live tail view and
   * short blocks declare nothing.
   */
  hitZones(): Iterable<HitZone> {
    const meta = this.zoneMeta;
    if (meta === undefined || !meta.expandable || meta.lines <= 1) return [];
    return [{ id: THINKING_HIT_ZONE, row: 1, col: 1, width: meta.width, height: meta.lines - 1 }];
  }

  onHitZone(id: HitZoneId, _event: MouseEvent): void | boolean {
    if (id !== THINKING_HIT_ZONE) return false;
    this.setExpanded(!this.expanded);
    this.ui?.requestRender();
  }

  setHoveredZone(id: HitZoneId | null): void | boolean {
    const hovered = id === THINKING_HIT_ZONE;
    if (hovered === this.hovered) return false;
    this.hovered = hovered;
  }

  render(width: number): string[] {
    let base: string[] | undefined;
    if (
      isRenderCacheEnabled() &&
      this.renderCache !== undefined &&
      this.renderCache.width === width
    ) {
      base = this.renderCache.lines;
    } else {
      base = this.renderBase(width);
      if (isRenderCacheEnabled()) {
        this.renderCache = { width, lines: base };
      }
    }
    return this.applyTone(base, width);
  }

  private renderBase(width: number): string[] {
    const contentWidth = Math.max(1, width - MESSAGE_INDENT.length);
    const contentLines = this.text.length > 0 ? this.textComponent.render(contentWidth) : [''];

    // Click/hover affordance: only the finalized fold hides lines (the live
    // tail window is not expansion-controlled), and an expanded block keeps
    // its zone so a click can collapse it back.
    this.zoneMeta = {
      width,
      lines: 0, // patched below once the final row count is known
      expandable:
        this.mode === 'finalized' &&
        (this.expanded || contentLines.length > THINKING_PREVIEW_LINES),
    };

    let rendered: string[];
    if (this.mode === 'live') {
      const visibleLines =
        contentLines.length > THINKING_PREVIEW_LINES
          ? contentLines.slice(contentLines.length - THINKING_PREVIEW_LINES)
          : contentLines;
      const spinner = currentTheme.fg(
        'textDim',
        `${BRAILLE_SPINNER_FRAMES[this.spinnerFrame] ?? BRAILLE_SPINNER_FRAMES[0]} `,
      );
      // The live title carries the shimmer wave on the spinner's own tick
      // (the content stays dim italic); finalize() stops the tick, so the
      // wave freezes with the block instead of burning frames forever.
      rendered = [
        '',
        spinner + shimmerText(t('notices.thinking.live'), this.shimmerFrame),
        ...visibleLines.map((line) => MESSAGE_INDENT + line),
      ];
    } else {
      const lines: string[] = [''];
      for (let i = 0; i < contentLines.length; i++) {
        const p = i === 0 && this.showMarker ? currentTheme.fg('textDim', STATUS_BULLET) : MESSAGE_INDENT;
        lines.push(p + contentLines[i]);
      }

      if (this.expanded || contentLines.length <= THINKING_PREVIEW_LINES) {
        rendered = lines;
      } else {
        // Leading blank + first PREVIEW_LINES content lines + hint line.
        const truncated = lines.slice(0, 1 + THINKING_PREVIEW_LINES);
        const remaining = contentLines.length - THINKING_PREVIEW_LINES;
        const hint = t('notices.thinking.moreLines', { count: remaining });
        const indentWidth = Math.min(MESSAGE_INDENT.length, Math.max(0, width));
        const hintWidth = Math.max(0, width - indentWidth);
        truncated.push(
          ' '.repeat(indentWidth) + currentTheme.dim(truncateToWidth(hint, hintWidth, '…')),
        );
        rendered = truncated;
      }
    }

    this.zoneMeta = { ...this.zoneMeta, lines: rendered.length };
    return rendered;
  }

  /**
   * Paint the interaction tone over the rendered base lines, like the tool
   * cards: a hovered block whitens its gray rows (the leading blank row is
   * excluded). Normal tone returns the base array untouched.
   */
  private applyTone(base: string[], width: number): string[] {
    const tone: CardTone = this.hovered ? 'hover' : 'normal';
    if (tone === 'normal') return base;
    const cached = this.toneCache;
    if (cached !== undefined && cached.base === base && cached.width === width && cached.tone === tone) {
      return cached.out;
    }
    const out = applyCardTone(base, { width, tone, bgFrom: 1, toneFrom: 1 });
    this.toneCache = { base, width, tone, out };
    return out;
  }

  private startSpinner(): void {
    if (this.ui === undefined || this.spinnerInterval !== undefined) return;
    this.spinnerInterval = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % BRAILLE_SPINNER_FRAMES.length;
      this.shimmerFrame += 1;
      this.markRenderDirty();
      this.ui?.requestRender();
    }, BRAILLE_SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (this.spinnerInterval === undefined) return;
    clearInterval(this.spinnerInterval);
    this.spinnerInterval = undefined;
  }
}
