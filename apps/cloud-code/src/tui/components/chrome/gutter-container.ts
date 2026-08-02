/**
 * Container that reserves left/right gutter columns around its children,
 * so the chrome (statusline, transcript, panels) lines up with the input
 * box's inner content area instead of butting up against the terminal edge.
 *
 * Children are rendered at `width - left - right` and each emitted line is
 * prefixed with `left` plain spaces. Right padding is logical only — we
 * never emit trailing spaces, since terminals already paint background to
 * the edge and adding them would just churn the diff renderer.
 *
 * The render cache below validates per child (component identity + the
 * identity of its rendered line array), so structural child-list changes —
 * append, splice-removal, in-place replacement — are picked up correctly
 * without a tree-wide `invalidate()`. Reserve `invalidate()` for global
 * style changes that genuinely dirty every child (e.g. theme switches).
 */

import { Container } from '@cloud-code/pi-tui';
import type { Component } from '@cloud-code/pi-tui';

import { currentTheme } from '#/tui/theme';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';

interface TranscriptRenderCache {
  width: number;
  childRefs: Component[];
  childRenderRefs: string[][];
  prefixed: string[][];
  out: string[];
}

export class GutterContainer extends Container {
  private renderCache: TranscriptRenderCache | undefined;
  constructor(
    protected readonly leftPad: number,
    protected readonly rightPad: number,
  ) {
    super();
  }

  override invalidate(): void {
    this.renderCache = undefined;
    super.invalidate();
  }

  // The leading pad shifts every child column right: the TUI's mouse column
  // translation subtracts this so children receive component-relative cols.
  override leftInset(): number {
    return this.leftPad;
  }

  // The trailing pad reserves columns children never paint into: the TUI's
  // transcript hit-test subtracts it (with the left inset) to compute the
  // width children actually render at.
  override rightInset(): number {
    return this.rightPad;
  }

  override render(width: number): string[] {
    const inner = Math.max(1, width - this.leftPad - this.rightPad);
    const lead = ' '.repeat(this.leftPad);

    const cache = this.renderCache;
    const cacheValid =
      isRenderCacheEnabled() &&
      cache !== undefined &&
      cache.width === width &&
      cache.childRefs.length === this.children.length;

    const childRefs: Component[] = [];
    const childRenderRefs: string[][] = [];
    const prefixed: string[][] = [];
    let allReused = cacheValid;

    let i = 0;
    for (const child of this.children) {
      const lines = child.render(inner);
      childRefs.push(child);
      childRenderRefs.push(lines);
      const reused = cacheValid && cache.childRefs[i] === child && cache.childRenderRefs[i] === lines;
      if (reused) {
        prefixed.push(cache.prefixed[i]!);
      } else {
        allReused = false;
        prefixed.push(lines.map((line) => lead + line));
      }
      i++;
    }

    let out: string[];
    if (allReused) {
      out = cache!.out;
    } else {
      out = [];
      for (const lines of prefixed) {
        for (const line of lines) out.push(line);
      }
    }

    if (isRenderCacheEnabled()) {
      this.renderCache = { width, childRefs, childRenderRefs, prefixed, out };
    }

    return out;
  }
}

/**
 * Editor-slot container: same gutter behaviour as GutterContainer, plus an
 * optional `▔` separator row rendered above the children while a panel-style
 * dialog replaces the editor (Claude's modal top-divider analogue, painted in
 * the attention-border colour). The editor's own bordered box needs no
 * separator, so the flag flips on for panel mounts only. Kept out of the
 * child list so `children[0]` stays the mounted panel/editor.
 */
export class EditorSlotContainer extends GutterContainer {
  topSeparator = false;

  // The separator row sits above the children: mouse row translation must
  // count it, or click-to-select lands one row high.
  override rowsBeforeChild(_child: Component): number {
    return this.topSeparator ? 1 : 0;
  }

  override render(width: number): string[] {
    const out = super.render(width);
    if (!this.topSeparator) return out;
    const inner = Math.max(1, width - this.leftPad - this.rightPad);
    const separator =
      ' '.repeat(this.leftPad) + currentTheme.fg('borderFocus', '▔'.repeat(inner));
    return [separator, ...out];
  }
}
