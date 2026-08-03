/**
 * ReadGroupComponent renders 2+ Read tool calls from the same step as one group.
 *
 * It follows the same structure as `AgentGroupComponent`, with a smaller
 * surface:
 * - one summary header and a tree body listing each file path and status;
 * - permanently grouped, while the body remains visible;
 * - a mouse click unfolds the group into its member cards
 *   (`setClickExpanded`); keyboard expansion (ctrl+o) never reaches it;
 * - 200ms throttling, matching AgentGroup;
 * - state stays in each `ToolCallComponent`; the group only reads snapshots.
 *
 * Header forms:
 *   pending > 0: Reading {N} files
 *   all done:    Read {N} files · {L} lines
 *   some failed: append · {F} failed
 *   all failed:  Read {N} files · failed
 *
 * Body lines follow AgentGroup's branch style:
 *   src/main.ts · 51 lines
 *   src/cli.ts · reading
 *   src/missing.ts · failed
 */

import { Container, Spacer, Text } from '@cloud-code/pi-tui';
import type { HitZone, HitZoneId, MouseEvent, TUI } from '@cloud-code/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';

import { applyCardTone, type CardTone } from './card-tone';
import type { ToolCallComponent, ToolCallReadSnapshot } from './tool-call';

const THROTTLE_MS = 200;

/** Hit-zone id of the group's single whole-card interactive region. */
const GROUP_HIT_ZONE = 'card';

interface ReadEntry {
  readonly toolCallId: string;
  readonly tc: ToolCallComponent;
}

export class ReadGroupComponent extends Container {
  private readonly entries: ReadEntry[] = [];
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
  private lastFlushPhases = new Map<string, ToolCallReadSnapshot['phase']>();
  private _invalidating = false;

  constructor(private readonly ui: TUI | undefined) {
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
      const phase = e.tc.getReadSnapshot().phase;
      if (this.lastFlushPhases.get(e.toolCallId) !== phase) return true;
    }
    return false;
  }

  private flushRender(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    const snapshots = this.entries.map((e) => e.tc.getReadSnapshot());
    let pending = 0;
    let failed = 0;
    let totalLines = 0;
    for (const snap of snapshots) {
      if (snap.phase === 'pending') pending += 1;
      else if (snap.phase === 'failed') failed += 1;
      else totalLines += snap.lines;
    }
    this.headerText.setText(this.buildHeader(snapshots.length, pending, failed, totalLines));

    this.bodyContainer.clear();
    if (this.clickExpanded) {
      // Expanded: unfold into the member cards themselves (already switched
      // to their expanded content by setClickExpanded).
      for (const entry of this.entries) {
        this.bodyContainer.addChild(entry.tc);
      }
    } else {
      const visibleSnapshots = snapshots.filter(
        (snap) => snap.filePath !== undefined && snap.filePath.length > 0,
      );
      visibleSnapshots.forEach((snap, idx) => {
        const isLast = idx === visibleSnapshots.length - 1;
        this.bodyContainer.addChild(new Text(this.buildBodyLine(snap, isLast), 0, 0));
      });
    }

    this.lastFlushPhases.clear();
    this.entries.forEach((entry, i) => {
      const snap = snapshots[i];
      if (snap !== undefined) this.lastFlushPhases.set(entry.toolCallId, snap.phase);
    });

    this.invalidate();
    this.ui?.requestRender();
  }

  private buildHeader(total: number, pending: number, failed: number, totalLines: number): string {
    const dim = (text: string): string => currentTheme.dim(text);

    if (pending > 0) {
      const bullet = currentTheme.fg('text', STATUS_BULLET);
      const label = currentTheme.boldFg('primary', t('notices.readGroup.reading', { count: total }));
      return `${bullet}${label}`;
    }

    // All reads have finished, either successfully or with failures.
    if (failed === total) {
      const bullet = currentTheme.fg('error', '✗ ');
      const label = currentTheme.boldFg('error', t('notices.readGroup.read', { count: total }));
      return `${bullet}${label}${currentTheme.fg('error', t('notices.readGroup.failedSuffix'))}`;
    }

    const bullet = currentTheme.fg('success', STATUS_BULLET);
    const label = currentTheme.boldFg('primary', t('notices.readGroup.read', { count: total }));
    const linesPart = dim(
      t(totalLines === 1 ? 'notices.readGroup.lines.one' : 'notices.readGroup.lines.other', {
        count: totalLines,
      }),
    );
    const failPart =
      failed > 0
        ? currentTheme.fg('error', t('notices.readGroup.failedCount', { count: failed }))
        : '';
    return `${bullet}${label}${linesPart}${failPart}`;
  }

  private buildBodyLine(snap: ToolCallReadSnapshot, isLast: boolean): string {
    const branch = isLast ? '└─' : '├─';
    const path = snap.filePath ?? '';
    if (snap.phase === 'failed') {
      return (
        currentTheme.fg('textDim', `  ${branch} ${path}`) +
        currentTheme.fg('error', t('notices.readGroup.failedSuffix'))
      );
    }
    const tail =
      snap.phase === 'pending'
        ? t('notices.readGroup.readingTail')
        : t(snap.lines === 1 ? 'notices.readGroup.lines.one' : 'notices.readGroup.lines.other', {
            count: snap.lines,
          });
    return currentTheme.fg('textDim', `  ${branch} ${path}${tail}`);
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

  /** Releases throttle timers so destroyed components cannot refresh later. */
  dispose(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    for (const e of this.entries) {
      e.tc.setSnapshotListener(undefined);
    }
  }
}
