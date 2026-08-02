/**
 * TaskOutputViewer — full-screen pi-tui rendered output viewer for
 * a single background task. Replaces the previous "shell out to less"
 * approach so the experience stays inside the TUI: same colors, same
 * fonts, same redraw cycle, no alt-screen flip-flop.
 *
 * Mounted by `cloud-code-tui.ts` via nested container swap on top of the
 * TasksBrowserApp. Snapshot view (no live tail) — content is fetched
 * once when the viewer opens.
 */

import {
  Container,
  drawScrollbar,
  Key,
  matchesKey,
  type MouseEvent,
  Scrollbar,
  scrollbarThumb,
  type ScrollbarMetrics,
  type Terminal,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@cloud-code/pi-tui';
import type { BackgroundTaskInfo, BackgroundTaskStatus } from '@cloud-code/sdk';

import { resolveDescription, t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';

const ELLIPSIS = '…';

/** Scrollbar glyphs: muted track, primary thumb — the same chrome pairing
 * the transcript bar uses (see theme/pi-tui-theme createScrollbarStyle). */
const SCROLLBAR_STYLE = {
  track: (glyph: string): string => currentTheme.fg('textMuted', glyph),
  thumb: (glyph: string): string => currentTheme.fg('primary', glyph),
};

export interface TaskOutputViewerProps {
  readonly taskId: string;
  readonly info: BackgroundTaskInfo | undefined;
  readonly output: string;
  readonly onClose: () => void;
}

/** Status labels are i18n keys, resolved at render time via resolveDescription. */
const STATUS_LABEL: Record<BackgroundTaskStatus, string> = {
  running: 'selectors.taskOutput.status.running',
  completed: 'selectors.taskOutput.status.completed',
  failed: 'selectors.taskOutput.status.failed',
  timed_out: 'selectors.taskOutput.status.timedOut',
  killed: 'selectors.taskOutput.status.killed',
  lost: 'selectors.taskOutput.status.lost',
};

function statusColor(status: BackgroundTaskStatus): 'success' | 'textMuted' | 'error' {
  switch (status) {
    case 'running':
      return 'success';
    case 'completed':
      return 'textMuted';
    case 'failed':
    case 'timed_out':
    case 'killed':
    case 'lost':
      return 'error';
  }
}

function padToWidth(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w === width) return line;
  if (w > width) return truncateToWidth(line, width, ELLIPSIS);
  return line + ' '.repeat(width - w);
}

function fitExactly(line: string, width: number): string {
  let s = line;
  if (visibleWidth(s) > width) s = truncateToWidth(s, width, ELLIPSIS);
  return padToWidth(s, width);
}

export class TaskOutputViewer extends Container implements Focusable {
  focused = false;

  private props: TaskOutputViewerProps;
  private readonly terminal: Terminal;
  /** Output split on '\n'. Replaced on `setProps` when `output` changes. */
  private lines: string[];
  /** Index of the topmost visible line. */
  private scrollTop = 0;
  /** Hover-revealed scrollbar on the right body border (last column). */
  private readonly scrollbar = new Scrollbar();
  /** Width of the last render; mouse hit-tests the right border against it. */
  private lastRenderWidth = 80;

  constructor(props: TaskOutputViewerProps, terminal: Terminal) {
    super();
    this.props = props;
    this.terminal = terminal;
    this.lines = this.splitOutput(props.output);
  }

  /**
   * Update viewer props. When `output` grows (the watched task wrote
   * new content), follow the tail like `less +F` if the user is parked
   * at the bottom; otherwise keep the user's current scroll position
   * so they can read history without being yanked around.
   */
  setProps(next: TaskOutputViewerProps): void {
    const previousOutput = this.props.output;
    const wasAtBottom = this.scrollTop >= this.maxScroll();
    this.props = next;
    if (next.output !== previousOutput) {
      this.lines = this.splitOutput(next.output);
      if (wasAtBottom) this.scrollTop = this.maxScroll();
      else this.scrollTop = Math.min(this.scrollTop, this.maxScroll());
    }
    this.invalidate();
  }

  private splitOutput(output: string): string[] {
    return (output.length > 0 ? output : t('selectors.taskOutput.noOutput')).split('\n');
  }

  // ── input ──────────────────────────────────────────────────────────

  handleInput(data: string): void {
    const visible = this.viewableRows();
    const k = printableChar(data);

    if (matchesKey(data, Key.escape) || k === 'q' || k === 'Q') {
      this.props.onClose();
      return;
    }
    if (matchesKey(data, Key.up) || k === 'k') {
      this.scrollBy(-1);
      return;
    }
    if (matchesKey(data, Key.down) || k === 'j') {
      this.scrollBy(1);
      return;
    }
    if (
      matchesKey(data, Key.pageUp) ||
      matchesKey(data, Key.ctrl('u')) ||
      k === ' ' ||
      data === '\u0002' /* C-b */
    ) {
      this.scrollBy(-Math.max(1, visible - 1));
      return;
    }
    if (
      matchesKey(data, Key.pageDown) ||
      matchesKey(data, Key.ctrl('d')) ||
      data === '\u0006' /* C-f */
    ) {
      this.scrollBy(Math.max(1, visible - 1));
      return;
    }
    if (matchesKey(data, Key.home) || k === 'g') {
      this.scrollTo(0);
      return;
    }
    if (matchesKey(data, Key.end) || k === 'G') {
      this.scrollTo(this.maxScroll());
      return;
    }
  }

  private scrollBy(delta: number): void {
    this.scrollTo(this.scrollTop + delta);
  }

  /**
   * Mouse: the wheel pans the viewer three rows per tick (hover-to-scroll).
   * The right body border doubles as a hover-revealed scrollbar: a press on
   * the thumb anchors it to the pointer (grab delta), a press on the bare
   * track jumps to the pointed fraction, and a drag scrolls from there (the
   * release ends it). The bar shares the wheel's metrics — the body window
   * is the viewport, the output lines the content.
   */
  handleMouse(event: MouseEvent): void | boolean {
    if (event.type === 'wheel') {
      const delta = event.button === 64 ? -3 : event.button === 65 ? 3 : 0;
      if (delta === 0) return false;
      this.scrollBy(delta);
      return;
    }
    // A scrollbar drag owns the pointer until the release and maps against
    // the session the press captured (no metrics re-derived per motion).
    if (event.type === 'motion' && this.scrollbar.dragging) {
      if (event.button === 0) {
        this.scrollTo(this.scrollbar.drag(event.row - 2));
        return;
      }
      // Defensive: a button-free motion without a release ends the drag.
      this.scrollbar.release();
      this.invalidate();
      return;
    }
    if (event.type === 'release' && this.scrollbar.dragging) {
      this.scrollbar.release();
      this.invalidate();
      return;
    }
    const metrics = this.scrollbarMetrics();
    const track = this.viewableRows();
    if (event.type === 'press' && event.button === 0) {
      const trackRow = this.trackRowFor(event);
      if (trackRow === null || scrollbarThumb(metrics, track) === null) return false;
      this.scrollTo(this.scrollbar.press(trackRow, metrics, track));
      return;
    }
    if (event.type === 'motion') {
      const onTrack = this.trackRowFor(event) !== null && scrollbarThumb(metrics, track) !== null;
      const changed = this.scrollbar.hover(onTrack);
      if (changed) this.invalidate();
      return changed ? undefined : false;
    }
    return false;
  }

  /** Scroll metrics over the body window (the same clamp render derives). */
  private scrollbarMetrics(): ScrollbarMetrics {
    const viewport = this.viewableRows();
    return {
      scrollTop: Math.max(0, Math.min(this.scrollTop, this.maxScroll())),
      viewport,
      content: this.lines.length,
    };
  }

  /** 0-based row within the scrollbar track, or null off the right border. */
  private trackRowFor(event: MouseEvent): number | null {
    if (event.col !== this.lastRenderWidth) return null;
    const row = event.row - 2; // header(1) + top border(1)
    return row >= 0 && row < this.viewableRows() ? row : null;
  }

  private scrollTo(target: number): void {
    this.scrollTop = Math.max(0, Math.min(target, this.maxScroll()));
    this.invalidate();
  }

  private maxScroll(): number {
    return Math.max(0, this.lines.length - this.viewableRows());
  }

  /**
   * Number of content rows visible inside the body frame: total terminal
   * rows minus header(1) + footer(1) + top border(1) + bottom border(1).
   */
  private viewableRows(): number {
    return Math.max(1, this.terminal.rows - 4);
  }

  // ── render ─────────────────────────────────────────────────────────

  override render(width: number): string[] {
    this.lastRenderWidth = width;
    const rows = Math.max(3, this.terminal.rows);
    const bodyHeight = rows - 2;

    const header = this.renderHeader(width);
    const body = this.renderBody(width, bodyHeight);
    const footer = this.renderFooter(width, bodyHeight);

    // The hover-revealed scrollbar replaces the right border of the body's
    // inner rows (its track) while engaged; the ┌/└ corners stay.
    const viewRows = Math.max(0, bodyHeight - 2);
    const thumb = this.scrollbar.engaged
      ? scrollbarThumb(this.scrollbarMetrics(), viewRows)
      : null;
    const bodyLines =
      thumb === null
        ? body
        : [body[0]!, ...drawScrollbar(body.slice(1, 1 + viewRows), width, thumb, SCROLLBAR_STYLE), body.at(-1)!];

    const out: string[] = [header];
    for (const line of bodyLines) out.push(line);
    out.push(footer);
    return out;
  }

  private renderHeader(width: number): string {
    const title = currentTheme.boldFg('primary', ` ${t('selectors.taskOutput.title')} `);
    const id = currentTheme.boldFg('text', this.props.taskId);
    const info = this.props.info;
    const segments: string[] = [];
    if (info !== undefined) {
      segments.push(
        currentTheme.fg(statusColor(info.status), resolveDescription(STATUS_LABEL[info.status])),
      );
      if (info.kind === 'process' && info.exitCode !== null) {
        segments.push(
          currentTheme.fg('textMuted', t('selectors.taskOutput.exitCode', { code: info.exitCode })),
        );
      }
      if (info.description && info.description.length > 0) {
        segments.push(currentTheme.fg('textMuted', info.description));
      }
    }
    const composed = title + id + (segments.length > 0 ? '  ' + segments.join('  ') : '');
    return fitExactly(composed, width);
  }

  private renderBody(width: number, bodyHeight: number): string[] {
    // Reserve 1 col for left/right border each, 1 col for left padding.
    const innerWidth = Math.max(1, width - 4);

    // Pure: the clamped position is derived locally, never stored back — the
    // input handlers own the stored scrollTop (their scrollTo clamps against
    // the same bound). A stale position can only linger after a shrink
    // resize that arrives without input, and the window derived here is the
    // same one the render clamp used to produce.
    const scrollTop = Math.max(0, Math.min(this.scrollTop, this.maxScroll()));

    const viewRows = bodyHeight - 2; // inside top + bottom border
    const top = currentTheme.fg('primary', '┌' + '─'.repeat(Math.max(0, width - 2)) + '┐');
    const bottom = currentTheme.fg('primary', '└' + '─'.repeat(Math.max(0, width - 2)) + '┘');

    const out: string[] = [top];
    for (let i = 0; i < viewRows; i++) {
      const lineIndex = scrollTop + i;
      const raw = this.lines[lineIndex] ?? '';
      const inner = fitExactly(currentTheme.fg('text', raw), innerWidth);
      out.push(currentTheme.fg('primary', '│ ') + inner + currentTheme.fg('primary', ' │'));
    }
    out.push(bottom);
    return out;
  }

  private renderFooter(width: number, bodyHeight: number): string {
    const key = (text: string): string => currentTheme.boldFg('primary', text);
    const dim = (text: string): string => currentTheme.fg('textMuted', text);

    const total = this.lines.length;
    const viewRows = Math.max(1, bodyHeight - 2);
    const maxScroll = Math.max(0, total - viewRows);
    // Same locally-derived clamp as renderBody (render is pure — the stored
    // scrollTop belongs to the input handlers).
    const scrollTop = Math.max(0, Math.min(this.scrollTop, maxScroll));
    const percent =
      maxScroll === 0 ? 100 : Math.round((scrollTop / maxScroll) * 100);
    const lineFrom = scrollTop + 1;
    const lineTo = Math.min(total, scrollTop + viewRows);

    const position = currentTheme.fg(
      'textMuted',
      ` ${String(lineFrom)}-${String(lineTo)} / ${String(total)} (${String(percent)}%) `,
    );
    const keys =
      `${key('↑↓')} ${dim(t('selectors.taskOutput.key.line'))}  ` +
      `${key('PgUp/PgDn/Ctrl+U/D')} ${dim(t('selectors.taskOutput.key.page'))}  ` +
      `${key('g/G')} ${dim(t('selectors.taskOutput.key.topBot'))}  ` +
      `${key('Q/Esc')} ${dim(t('selectors.taskOutput.key.cancel'))}`;
    const left = ` ${keys}`;
    const leftW = visibleWidth(left);
    const rightW = visibleWidth(position);
    if (leftW + 2 + rightW <= width) {
      return left + ' '.repeat(width - leftW - rightW) + position;
    }
    return fitExactly(left, width);
  }
}
