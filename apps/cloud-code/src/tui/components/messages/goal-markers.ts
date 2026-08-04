/**
 * Low-profile transcript markers for the autonomous goal loop.
 *
 * Lifecycle changes (paused / resumed / cancelled) and `no_progress` verdicts
 * render as a single dim line — `◦ Goal paused` — that expands (ctrl+o, shared
 * with tool output, or a mouse click on the marker; hovering whitens the gray
 * text) to show the reason when there is one. Terminal outcomes use the
 * richer completion card (the `/goal` box), not this marker.
 */

import {
  truncateToWidth,
  type Component,
  type HitZone,
  type HitZoneId,
  type MouseEvent,
} from '@cloud-code/pi-tui';
import type { GoalChange } from '@cloud-code/sdk';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import type { ColorToken } from '#/tui/theme';

import { applyCardTone, type CardTone } from './card-tone';
import { goalReasonText } from './goal-reason';

const HEAD_INDENT = '  ';
const DETAIL_INDENT = '    ';

/** Hit-zone id of the marker's single whole-region interactive area. */
const GOAL_MARKER_HIT_ZONE = 'card';

type GoalMarkerActor = 'user' | 'model' | 'runtime' | 'system';

interface GoalMarkerOptions {
  readonly marker?: string;
  readonly textToken?: ColorToken;
  readonly expandable?: boolean;
  readonly indent?: string;
  readonly leadingBlank?: boolean;
}

export class GoalMarkerComponent implements Component {
  private expanded = false;
  private readonly marker: string;
  private readonly textToken: ColorToken;
  private readonly expandable: boolean;
  private readonly indent: string;
  private readonly leadingBlank: boolean;
  /** Set when the expansion came from a click: paints the gray region block. */
  private clickExpanded = false;
  /** Pointer hover over the marker's zone: the gray text renders white. */
  private hovered = false;
  /** Geometry of the last render, captured for `hitZones()`. */
  private zoneMeta: { width: number; lines: number; interactive: boolean } | undefined;

  constructor(
    private readonly headline: string,
    private readonly detail: string | undefined,
    private readonly accentToken: ColorToken,
    options: GoalMarkerOptions = {},
  ) {
    this.marker = options.marker ?? '◦';
    this.textToken = options.textToken ?? 'textDim';
    this.expandable = options.expandable ?? true;
    this.indent = options.indent ?? HEAD_INDENT;
    this.leadingBlank = options.leadingBlank ?? false;
  }

  invalidate(): void {}

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    // The keyboard path (ctrl+o, collapse-all) always lands in the
    // background-free form; a collapse also clears a click expansion's block.
    this.clickExpanded = false;
  }

  /**
   * The marker's single hit zone: its rendered region below the optional
   * leading blank row. Registered only while a detail exists to reveal (or
   * hide again) — a detail-less or non-expandable marker stays click/hover
   * inert, matching the thinking blocks.
   */
  hitZones(): Iterable<HitZone> {
    const meta = this.zoneMeta;
    if (meta === undefined || !meta.interactive) return [];
    const start = this.leadingBlank ? 1 : 0;
    if (meta.lines <= start) return [];
    return [
      { id: GOAL_MARKER_HIT_ZONE, row: start, col: 1, width: meta.width, height: meta.lines - start },
    ];
  }

  onHitZone(id: HitZoneId, _event: MouseEvent): void | boolean {
    if (id !== GOAL_MARKER_HIT_ZONE) return false;
    // Click expansion paints the gray region block (like the tool cards);
    // clicking an expanded marker folds it back, whatever the expansion path.
    if (this.expanded) {
      this.expanded = false;
      this.clickExpanded = false;
    } else {
      this.expanded = true;
      this.clickExpanded = true;
    }
  }

  setHoveredZone(id: HitZoneId | null): void | boolean {
    const hovered = id === GOAL_MARKER_HIT_ZONE;
    if (hovered === this.hovered) return false;
    this.hovered = hovered;
  }

  render(width: number): string[] {
    const base = this.renderBase(width);
    const tone: CardTone = this.clickExpanded ? 'click' : this.hovered ? 'hover' : 'normal';
    if (tone === 'normal') return base;
    const start = this.leadingBlank ? 1 : 0;
    return applyCardTone(base, { width, tone, bgFrom: start, hovered: this.hovered });
  }

  private renderBase(width: number): string[] {
    const dot = currentTheme.fg(this.accentToken, this.marker);
    const head = currentTheme.fg(this.textToken, this.headline);
    const hasDetail = this.detail !== undefined && this.detail.length > 0;
    let lines: string[];
    if (!hasDetail || !this.expandable) {
      lines = [`${this.indent}${dot} ${head}`];
    } else if (!this.expanded) {
      lines = [`${this.indent}${dot} ${head} ${currentTheme.fg('textMuted', '(ctrl+o)')}`];
    } else {
      lines = [`${this.indent}${dot} ${head}`];
      const wrapWidth = Math.max(20, width - DETAIL_INDENT.length);
      for (const line of wrap(this.detail, wrapWidth)) {
        lines.push(DETAIL_INDENT + currentTheme.fg('textDim', line));
      }
    }
    const clamped = this.clampToWidth(lines, width);
    this.zoneMeta = { width, lines: clamped.length, interactive: this.expandable && hasDetail };
    return clamped;
  }

  private clampToWidth(lines: string[], width: number): string[] {
    const withBlank = this.withLeadingBlank(lines);
    if (width <= 0) return withBlank.map(() => '');
    return withBlank.map((line) => truncateToWidth(line, width));
  }

  private withLeadingBlank(lines: string[]): string[] {
    return this.leadingBlank ? ['', ...lines] : lines;
  }
}

/**
 * Builds a marker for a lifecycle change (paused / resumed / blocked), or `null`
 * when the change should be silent (a `completion` change posts its own message,
 * not a marker). `expanded` seeds the initial ctrl+o state.
 */
export function buildGoalMarker(
  change: GoalChange,
  expanded: boolean,
  actor?: GoalMarkerActor,
): GoalMarkerComponent | null {
  const spec = markerSpec(change, actor);
  if (spec === null) return null;
  const marker = new GoalMarkerComponent(
    spec.headline,
    spec.detail ?? change.reason,
    spec.accentToken,
    spec.options,
  );
  marker.setExpanded(expanded);
  return marker;
}

function markerSpec(
  change: GoalChange,
  actor?: GoalMarkerActor,
): {
  headline: string;
  accentToken: ColorToken;
  detail?: string | undefined;
  options?: GoalMarkerOptions | undefined;
} | null {
  if (change.kind === 'lifecycle') {
    switch (change.status) {
      case 'paused':
        return prominentMarker(pausedHeadline(change, actor), 'warning');
      case 'active':
        return prominentMarker(resumedHeadline(actor), 'primary');
      case 'blocked':
        // The system stopped pursuing the goal; resumable via `/goal resume`.
        return { headline: t('panels.goal.marker.blocked'), accentToken: 'warning' };
      default:
        return null;
    }
  }
  return null; // completion -> posts its own message, not a marker
}

function prominentMarker(headline: string, accentToken: ColorToken) {
  return {
    headline,
    accentToken,
    detail: undefined,
    options: {
      marker: STATUS_BULLET.trimEnd(),
      textToken: accentToken,
      expandable: false,
      indent: '',
      leadingBlank: true,
    },
  };
}

function pausedHeadline(change: GoalChange, actor: GoalMarkerActor | undefined): string {
  // New sessions carry the machine reason code; the English reason string
  // branches below are the fallback for older sessions' records.
  const codedReason = goalReasonText(change.reasonCode, change.reasonDetail);
  if (codedReason !== undefined) {
    return t('panels.goal.marker.pausedCodedReason', { reason: codedReason });
  }
  if (change.reasonCode === 'interruption') return t('panels.goal.marker.pausedInterruption');
  const reason = change.reason;
  if (reason === 'Paused after interruption') return t('panels.goal.marker.pausedInterruption');
  if (actor === 'user') return t('panels.goal.marker.pausedByUser');
  if (reason?.startsWith('Paused ') === true) {
    return t('panels.goal.marker.pausedFromReason', { reason: lowercaseFirst(reason) });
  }
  if (reason !== undefined && reason.length > 0) {
    return t('panels.goal.marker.pausedReason', { reason });
  }
  if (actor === 'model') return t('panels.goal.marker.pausedByAgent');
  return t('panels.goal.marker.paused');
}

function resumedHeadline(actor: GoalMarkerActor | undefined): string {
  if (actor === 'user') return t('panels.goal.marker.resumedByUser');
  if (actor === 'model') return t('panels.goal.marker.resumedByAgent');
  return t('panels.goal.marker.resumed');
}

function lowercaseFirst(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toLowerCase()}${text.slice(1)}`;
}

function wrap(text: string, width: number): string[] {
  const words = text.replaceAll(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length > width && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [''];
}
