/**
 * ToolGroupComponent renders 2+ consecutive same-tool calls from the same
 * step as one group card — the read-group pattern generalized to tools whose
 * calls compress to a one-line summary (Bash, Glob, Grep).
 *
 * Structure follows `ReadGroupComponent`:
 * - one summary header and a tree body listing each call's key argument and
 *   status tail;
 * - permanently grouped, while the body remains visible;
 * - 200ms throttling, with phase transitions flushed immediately;
 * - state stays in each `ToolCallComponent`; the group only reads snapshots.
 *
 * Header forms:
 *   pending > 0: ● {tool} ×{N} · {M} running…   (bullet blinks, title shimmers,
 *                 matching a standalone in-flight card)
 *   all done:    ● {tool} ×{N}  (+ · {F} failed when some calls failed)
 *   all failed:  ✗ {tool} ×{N} · failed
 *
 * Body rows use the shared tree gutter (DETAIL_TREE_MIDDLE/LAST) in the
 * `textDim` tone; command tools (Bash) use the `$` prompt shape instead:
 *   ├─ foo · 3 matches
 *   └─ bar · 1 match
 *   $ npm test · running…
 *
 * Result bodies are not rendered while folded: the group is the folded form.
 * Ctrl+O expansion toggles standalone cards only (grouped cards are hidden
 * state containers, so the expand pass never reaches them) — same convention
 * as ReadGroup, whose file contents are likewise group-folded. A mouse click
 * on the group unfolds it into its member cards instead
 * (`setClickExpanded`).
 */

import { Container, Spacer, Text } from '@cloud-code/pi-tui';
import type { HitZone, HitZoneId, MouseEvent, TUI } from '@cloud-code/pi-tui';

import {
  COMMAND_BODY_INDENT,
  COMMAND_PROMPT,
  DETAIL_TREE_LAST,
  DETAIL_TREE_MIDDLE,
  STATUS_BULLET,
} from '#/tui/constant/symbols';
import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { shimmerText } from '#/tui/utils/shimmer';

import { applyCardTone, type CardTone } from './card-tone';
import { isCommandCardToolName } from './shell-execution';
import {
  BLINK_HALF_PERIOD_TICKS,
  RUNNING_ANIMATION_INTERVAL_MS,
  type ToolCallComponent,
  type ToolCallGroupSnapshot,
} from './tool-call';

const THROTTLE_MS = 200;

/** Hit-zone id of the group's single whole-card interactive region. */
const GROUP_HIT_ZONE = 'card';

interface ToolGroupEntry {
  readonly toolCallId: string;
  readonly tc: ToolCallComponent;
}

export class ToolGroupComponent extends Container {
  private readonly entries: ToolGroupEntry[] = [];
  private readonly headerText: Text;
  private readonly bodyContainer: Container;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Mouse-click expansion: the group unfolds into its member cards (each
   * keyboard-expanded, so only their content grows) and the whole region is
   * painted white-on-gray by the card tone post-process. Keyboard expansion
   * (ctrl+o) never reaches groups — the group is the folded form.
   */
  private clickExpanded = false;
  /** Pointer hover over the group's zone: the detail body renders white. */
  private hovered = false;
  /** Geometry of the last render, captured for `hitZones()`. */
  private zoneMeta:
    | { width: number; lines: number; spacerRows: number; headerRows: number }
    | undefined;
  /**
   * Tone post-process cache keyed on the per-child rendered line arrays, so
   * an interaction-painted group returns a referentially stable output across
   * frames (the differential renderer skips unchanged rows by identity).
   */
  private toneCache:
    | { refs: string[][]; width: number; tone: CardTone; out: string[] }
    | undefined;
  /**
   * Header animation while any call is in flight: the ● bullet breathes
   * bright/dim and the title carries the shimmer wave, on the same cadence a
   * standalone running card uses. The timer exists only while a snapshot
   * reads pending, so a finished group costs nothing.
   */
  private animationTimer: ReturnType<typeof setInterval> | undefined;
  private animationFrame = 0;
  private lastFlushPhases = new Map<string, ToolCallGroupSnapshot['phase']>();
  private _invalidating = false;

  constructor(
    private readonly toolName: string,
    private readonly ui: TUI | undefined,
  ) {
    super();
    this.addChild(new Spacer(1));
    this.headerText = new Text('', 0, 0);
    this.addChild(this.headerText);
    this.bodyContainer = new Container();
    this.addChild(this.bodyContainer);
  }

  size(): number {
    return this.entries.length;
  }

  /**
   * Borrows a standalone `ToolCallComponent` into the group as a hidden state
   * container. Snapshot changes trigger throttled refreshes. Re-attaching the
   * same toolCallId is a no-op.
   */
  attach(toolCallId: string, tc: ToolCallComponent): void {
    if (this.entries.some((e) => e.toolCallId === toolCallId)) return;
    this.entries.push({ toolCallId, tc });
    tc.setSnapshotListener(() => {
      this.scheduleRender();
    });
    this.flushRender();
  }

  /**
   * The pending -> done/failed transition is the important visible change, so
   * it refreshes immediately. Other changes are throttled.
   */
  private scheduleRender(): void {
    if (this.detectPhaseTransition()) {
      this.flushRender();
      return;
    }
    if (this.throttleTimer !== null) return;
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      this.flushRender();
    }, THROTTLE_MS);
  }

  private detectPhaseTransition(): boolean {
    for (const e of this.entries) {
      const phase = e.tc.getGroupSnapshot().phase;
      if (this.lastFlushPhases.get(e.toolCallId) !== phase) return true;
    }
    return false;
  }

  private flushRender(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    const snapshots = this.entries.map((e) => e.tc.getGroupSnapshot());
    const { pending, failed } = countPhases(snapshots);
    this.headerText.setText(this.buildHeader(snapshots.length, pending, failed));

    this.bodyContainer.clear();
    if (this.clickExpanded) {
      // Expanded: unfold into the member cards themselves (already switched
      // to their expanded content by setClickExpanded).
      for (const entry of this.entries) {
        this.bodyContainer.addChild(entry.tc);
      }
    } else {
      snapshots.forEach((snap, idx) => {
        const isLast = idx === snapshots.length - 1;
        this.bodyContainer.addChild(new Text(this.buildBodyLine(snap, isLast), 0, 0));
      });
    }

    this.lastFlushPhases.clear();
    this.entries.forEach((entry, i) => {
      const snap = snapshots[i];
      if (snap !== undefined) this.lastFlushPhases.set(entry.toolCallId, snap.phase);
    });

    this.syncAnimationTimer(pending > 0);
    this.invalidate();
    this.ui?.requestRender();
  }

  private buildHeader(total: number, pending: number, failed: number): string {
    const title = t('notices.toolGroup.title', { tool: this.toolName, count: total });

    if (pending > 0) {
      const bullet =
        Math.floor(this.animationFrame / BLINK_HALF_PERIOD_TICKS) % 2 === 0
          ? currentTheme.fg('text', STATUS_BULLET)
          : currentTheme.dimFg('textDim', STATUS_BULLET);
      const running = currentTheme.dim(t('notices.toolGroup.runningSuffix', { count: pending }));
      return `${bullet}${shimmerText(title, this.animationFrame)}${running}`;
    }

    // All calls have finished, either successfully or with failures.
    if (failed === total) {
      const bullet = currentTheme.fg('error', '✗ ');
      const label = currentTheme.boldFg('error', title);
      return `${bullet}${label}${currentTheme.fg('error', t('notices.toolGroup.failedSuffix'))}`;
    }

    const bullet = currentTheme.fg('success', STATUS_BULLET);
    const label = currentTheme.boldFg('primary', title);
    const failPart =
      failed > 0
        ? currentTheme.fg('error', t('notices.toolGroup.failedCount', { count: failed }))
        : '';
    return `${bullet}${label}${failPart}`;
  }

  private buildBodyLine(snap: ToolCallGroupSnapshot, isLast: boolean): string {
    const label =
      snap.keyArg !== undefined && snap.keyArg.length > 0
        ? currentTheme.fg('text', snap.keyArg)
        : currentTheme.dim(this.toolName);

    let tail: string;
    if (snap.phase === 'pending') {
      tail = currentTheme.dim(t('notices.toolGroup.runningTail'));
    } else if (snap.phase === 'failed') {
      tail = currentTheme.fg('error', t('notices.toolGroup.failedSuffix'));
    } else {
      tail = snap.chip !== undefined ? currentTheme.dim(` · ${snap.chip}`) : '';
    }

    // Command rows keep the `$` prompt shape of a standalone command card;
    // other tools render the shared tree gutter (dim) like any detail body.
    if (isCommandCardToolName(this.toolName)) {
      const prompt = currentTheme.fg('shellMode', COMMAND_PROMPT);
      return `${COMMAND_BODY_INDENT}${prompt}${label}${tail}`;
    }
    const branch = currentTheme.fg('textDim', isLast ? DETAIL_TREE_LAST : DETAIL_TREE_MIDDLE);
    return `${branch}${label}${tail}`;
  }

  private syncAnimationTimer(needed: boolean): void {
    if (!needed) {
      this.stopAnimationTimer();
      return;
    }
    if (this.animationTimer !== undefined) return;
    this.animationTimer = setInterval(() => {
      this.animationFrame += 1;
      const snapshots = this.entries.map((e) => e.tc.getGroupSnapshot());
      const { pending, failed } = countPhases(snapshots);
      if (pending === 0) {
        // Phase transitions flush through the snapshot listener, so this is
        // only a safety net for a missed notification.
        this.flushRender();
        return;
      }
      // Only the header text changes on a tick — the body stays cached.
      this.headerText.setText(this.buildHeader(snapshots.length, pending, failed));
      this.ui?.requestRender();
    }, RUNNING_ANIMATION_INTERVAL_MS);
  }

  private stopAnimationTimer(): void {
    if (this.animationTimer === undefined) return;
    clearInterval(this.animationTimer);
    this.animationTimer = undefined;
  }

  override invalidate(): void {
    if (this._invalidating) {
      super.invalidate();
      return;
    }
    this._invalidating = true;
    this.flushRender();
    this._invalidating = false;
  }

  /**
   * Click expansion path: unfold into the member cards (their content
   * expands; the group-level tone paints the region chrome). The keyboard
   * collapse-all pass calls this with false.
   */
  setClickExpanded(expanded: boolean): void {
    if (this.clickExpanded === expanded) return;
    this.clickExpanded = expanded;
    for (const e of this.entries) {
      e.tc.setExpanded(expanded);
    }
    this.flushRender();
  }

  /** The group's single hit zone: its whole region below the leading spacer. */
  hitZones(): Iterable<HitZone> {
    const meta = this.zoneMeta;
    if (meta === undefined || meta.lines <= meta.spacerRows) return [];
    return [
      {
        id: GROUP_HIT_ZONE,
        row: meta.spacerRows,
        col: 1,
        width: meta.width,
        height: meta.lines - meta.spacerRows,
      },
    ];
  }

  onHitZone(id: HitZoneId, _event: MouseEvent): void | boolean {
    if (id !== GROUP_HIT_ZONE) return false;
    this.setClickExpanded(!this.clickExpanded);
  }

  setHoveredZone(id: HitZoneId | null): void | boolean {
    const hovered = id === GROUP_HIT_ZONE;
    if (hovered === this.hovered) return false;
    this.hovered = hovered;
  }

  /**
   * Renders the group's children and applies the interaction tone over the
   * composed lines: a click-expanded group paints white content on the gray
   * region background (member detail bodies included; the group's own header
   * row keeps its colors), a hovered one whitens its summary rows. Child 0 is
   * the leading spacer, child 1 the header — the tone boundaries follow them.
   */
  override render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const childLines = this.children.map((child) => child.render(safeWidth));
    const base = childLines.flat();
    const spacerRows = childLines[0]?.length ?? 0;
    const headerRows = childLines[1]?.length ?? 0;
    this.zoneMeta = { width: safeWidth, lines: base.length, spacerRows, headerRows };
    const tone: CardTone = this.clickExpanded ? 'click' : this.hovered ? 'hover' : 'normal';
    if (tone === 'normal') return base;
    const cached = this.toneCache;
    if (
      cached !== undefined &&
      cached.width === safeWidth &&
      cached.tone === tone &&
      cached.refs.length === childLines.length &&
      cached.refs.every((ref, i) => ref === childLines[i])
    ) {
      return cached.out;
    }
    const out = applyCardTone(base, {
      width: safeWidth,
      tone,
      bgFrom: spacerRows,
      toneFrom: spacerRows + headerRows,
    });
    this.toneCache = { refs: childLines, width: safeWidth, tone, out };
    return out;
  }

  /** Releases timers so destroyed components cannot refresh later. */
  dispose(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.stopAnimationTimer();
    for (const e of this.entries) {
      e.tc.setSnapshotListener(undefined);
    }
  }
}

function countPhases(snapshots: readonly ToolCallGroupSnapshot[]): {
  pending: number;
  failed: number;
} {
  let pending = 0;
  let failed = 0;
  for (const snap of snapshots) {
    if (snap.phase === 'pending') pending += 1;
    else if (snap.phase === 'failed') failed += 1;
  }
  return { pending, failed };
}
