/**
 * Root layout container that bottom-anchors the chrome (editor + footer).
 *
 * INLINE MODE ONLY (tui.toml `fullscreen = false`): when the whole UI is
 * shorter than the terminal viewport, it inserts blank "filler" lines right
 * after an anchor child (the transcript), so the editor and footer pin to the
 * bottom viewport rows instead of floating directly under the last message.
 * Once the content reaches a full screen the filler degrades to zero lines.
 *
 * Fullscreen mode (the default) never calls this container's render() — the
 * TUI renders the registered scroll/slot regions directly — so the filler
 * cannot leak into the fullscreen frame. Takeover frames (children swapped
 * out) don't reach it either.
 *
 * Accepted trade-offs, by design:
 * - The filler lines are real terminal output. When content later grows past
 *   one screen they scroll into scrollback as blank lines. Cosmetic only, and
 *   only reachable from the short-content phase of inline mode.
 * - No forced redraws are introduced. Growth replaces filler lines in place
 *   (the total stays == rows until the filler is exhausted), and the
 *   height-change paths that could yank the viewport already force full
 *   renders on their own: CloudCodeTUI.clearTranscriptAndRedraw (/clear, session
 *   switch) and restoreEditor (dialog close, skipped inside tmux where reflow
 *   handles the shrink). Terminal resize triggers pi-tui's height-change full
 *   render, which simply recomputes the filler.
 */
import { Container } from '@cloud-code/pi-tui';
import type { Component } from '@cloud-code/pi-tui';

export class BottomAnchorContainer extends Container {
  private contentLineCount = 0;

  constructor(
    private readonly getViewportRows: () => number,
    private readonly anchorChild: Component,
  ) {
    super();
  }

  /**
   * Rendered height of all children WITHOUT the anchor gap, captured during
   * the last render(). restoreEditor measures overflow against this instead
   * of the padded output: the gap pads short sessions to exactly one screen,
   * so the padded length would always report `>= rows` and every dialog close
   * in a short session would take the destructive full clear (scrollback
   * wipe) that restoreEditor gates on real overflow.
   */
  get contentLines(): number {
    return this.contentLineCount;
  }

  override render(width: number): string[] {
    width = Math.max(1, width);
    const rendered = this.children.map((child) => child.render(width));
    let total = 0;
    for (const lines of rendered) total += lines.length;
    this.contentLineCount = total;
    // Full screen or worse: filler degenerates to zero lines.
    const gap = Math.max(0, this.getViewportRows() - total);
    const out: string[] = [];
    let gapInserted = false;
    for (let i = 0; i < rendered.length; i++) {
      out.push(...rendered[i]!);
      if (!gapInserted && gap > 0 && this.children[i] === this.anchorChild) {
        gapInserted = true;
        for (let j = 0; j < gap; j++) out.push('');
      }
    }
    return out;
  }
}
