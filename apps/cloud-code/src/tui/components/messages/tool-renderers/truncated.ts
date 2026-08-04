import { Text, truncateToWidth, type Component } from '@cloud-code/pi-tui';

import { t, tIfKnown } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import type { ToolResultBlockData } from '#/tui/types';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';

import type { CollapsedRowProbe, ResultRenderer } from './types';
import { PREVIEW_LINES } from './types';

/**
 * The user-facing text of a tool result: the localized rendering named by
 * the result's display ref when this TUI knows the key, otherwise the raw
 * (English) output. The raw output stays the fallback for unknown keys
 * (newer agent-core on an older TUI) and for tools without a display ref.
 */
export function toolResultDisplayText(result: ToolResultBlockData): string {
  const display = result.display;
  if (display !== undefined) {
    const localized = tIfKnown(display.key, display.params);
    if (localized !== undefined) return localized;
  }
  return result.output;
}

export function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1];
    if (line === undefined || line.length > 0) break;
    end--;
  }
  return lines.slice(0, end);
}

/**
 * Component that renders tool output with wrap-aware line truncation.
 * Uses pi-tui's Text component to compute actual visual wrapped lines,
 * then caps at PREVIEW_LINES. This handles long single-line output (e.g.
 * JSON blobs) that would otherwise wrap to dozens of visual rows.
 *
 * Renders flush left in the shared `textDim` detail tone (errors in `error`):
 * the tree gutter that indents and connects the body lives in tool-call.ts's
 * DetailTreeComponent wrapper, not here.
 */
export class TruncatedOutputComponent implements Component, CollapsedRowProbe {
  private textComponent: Text;
  private readonly expanded: boolean;
  private readonly maxLines: number;
  private readonly expandHint: boolean;
  private readonly tail: boolean;

  constructor(
    output: string,
    options: {
      expanded: boolean;
      isError: boolean | undefined;
      maxLines?: number;
      // When false, the truncation footer omits the "ctrl+o to expand" promise
      // (for contexts whose output is fixed-truncated and never expands).
      expandHint?: boolean;
      // When true, collapsed rendering keeps the latest visual rows instead of
      // the first rows. This is useful for live output from a running command.
      tail?: boolean;
    },
  ) {
    this.expanded = options.expanded;
    this.maxLines = options.maxLines ?? PREVIEW_LINES;
    this.expandHint = options.expandHint ?? true;
    this.tail = options.tail ?? false;
    const cleaned = trimTrailingEmptyLines(output.split('\n')).join('\n');
    this.textComponent = new Text(
      options.isError
        ? currentTheme.fg('error', cleaned)
        : currentTheme.fg('textDim', cleaned),
      0,
      0,
    );
  }

  invalidate(): void {
    // Text component caches wrapped lines; invalidate on terminal resize.
    this.renderCache = undefined;
    this.textComponent.invalidate();
  }

  /** Rows the collapsed cap hides at `width`; 0 when expanded or all fits. */
  collapsedHiddenRows(width: number): number {
    if (this.expanded) return 0;
    return Math.max(0, this.textComponent.render(Math.max(1, width)).length - this.maxLines);
  }

  private renderHint(width: number, hint: string): string {
    return currentTheme.fg('textDim', truncateToWidth(hint, Math.max(0, width), '…'));
  }

  /**
   * Width-keyed output cache, keyed additionally on the wrapped content's
   * array identity: steady frames return the same array reference instead of
   * re-slicing and re-rendering the hint row on every transcript walk. The
   * remaining options are constructor-fixed, so (width, content) identity is
   * the whole invalidation surface.
   */
  private renderCache: { width: number; contentRef: string[]; lines: string[] } | undefined;

  render(width: number): string[] {
    const contentLines = this.textComponent.render(width);
    const cached = this.renderCache;
    if (
      isRenderCacheEnabled() &&
      cached !== undefined &&
      cached.width === width &&
      cached.contentRef === contentLines
    ) {
      return cached.lines;
    }
    const out = this.renderUncached(width, contentLines);
    if (isRenderCacheEnabled()) {
      this.renderCache = { width, contentRef: contentLines, lines: out };
    }
    return out;
  }

  private renderUncached(width: number, contentLines: string[]): string[] {
    if (this.expanded || contentLines.length <= this.maxLines) {
      return contentLines;
    }

    const remaining = contentLines.length - this.maxLines;
    if (this.tail) {
      const shown = contentLines.slice(contentLines.length - this.maxLines);
      return [
        this.renderHint(width, t('messages.truncated.earlierLines', { count: remaining })),
        ...shown,
      ];
    }

    const shown = contentLines.slice(0, this.maxLines);
    const hint = this.expandHint
      ? t('messages.truncated.moreLinesExpand', { count: remaining })
      : t('messages.truncated.moreLines', { count: remaining });
    return [...shown, this.renderHint(width, hint)];
  }
}

export const renderTruncated: ResultRenderer = (_toolCall, result, ctx) => {
  if (!result.output) return [];
  return [
    new TruncatedOutputComponent(toolResultDisplayText(result), {
      expanded: ctx.expanded,
      isError: result.is_error ?? false,
    }),
  ];
};
