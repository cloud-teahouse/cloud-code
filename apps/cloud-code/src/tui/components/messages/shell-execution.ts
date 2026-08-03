import type { Component } from '@cloud-code/pi-tui';
import { Container, Text, truncateToWidth, visibleWidth } from '@cloud-code/pi-tui';

import {
  COMMAND_BODY_INDENT,
  COMMAND_OUTPUT_MARK,
  COMMAND_PROMPT,
} from '#/tui/constant/symbols';
import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

import type { CollapsedRowProbe, ResultRenderer } from './tool-renderers/types';
import { collapsedHiddenRows, PREVIEW_LINES } from './tool-renderers/types';
import { TruncatedOutputComponent } from './tool-renderers/truncated';

/**
 * Tools whose cards render the command-card body shape (`$ command` then
 * `⎿ output`) instead of the shared tree gutter.
 */
export function isCommandCardToolName(toolName: string): boolean {
  return toolName === 'Bash' || toolName === 'ExecSession';
}

/**
 * Command-card output rows: a dim `⎿` opens the first row and later rows
 * align under the text after the mark. Rows stay flush left here — tool
 * cards add the command-body indent via `CommandBodyComponent`, while the
 * `!` shell-run card keeps them flush left so the mark sits on the dialog
 * cards' ● bullet column.
 */
export function prefixCommandOutputRows(rows: readonly string[]): string[] {
  const first = currentTheme.fg('textDim', COMMAND_OUTPUT_MARK);
  return rows.map((row, index) => `${index === 0 ? first : '  '}${row}`);
}

/** The explicit note a command card shows when the command produced no output. */
export function commandCardNoOutputRow(): string {
  return currentTheme.fg('textDim', `${COMMAND_OUTPUT_MARK}${t('utils.shellOutput.empty')}`);
}

/**
 * Indents every row of a command-card body one level under the card header.
 * The command-card counterpart of tool-call.ts's DetailTreeComponent: same
 * wrap-then-prefix mechanics, but with a plain indent instead of the tree
 * gutter so the `$`/`⎿` markers own the row shape.
 */
export class CommandBodyComponent implements Component, CollapsedRowProbe {
  constructor(private readonly inners: readonly Component[]) { }

  invalidate(): void {
    for (const inner of this.inners) inner.invalidate?.();
  }

  collapsedHiddenRows(width: number): number {
    const indentWidth = visibleWidth(COMMAND_BODY_INDENT);
    let hidden = 0;
    for (const inner of this.inners) {
      hidden += collapsedHiddenRows(inner, Math.max(1, width - indentWidth));
    }
    return hidden;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    const indentWidth = visibleWidth(COMMAND_BODY_INDENT);
    const lines = this.inners.flatMap((inner) =>
      inner.render(Math.max(1, safeWidth - indentWidth)),
    );
    return lines.map((line) => truncateToWidth(`${COMMAND_BODY_INDENT}${line}`, safeWidth, '…'));
  }
}

/**
 * Output half of the command-card shape: renders the inner output components
 * at the body width and prefixes the rows via `prefixCommandOutputRows`.
 */
class CommandOutputComponent implements Component, CollapsedRowProbe {
  constructor(private readonly inners: readonly Component[]) { }

  invalidate(): void {
    for (const inner of this.inners) inner.invalidate?.();
  }

  collapsedHiddenRows(width: number): number {
    const prefixWidth = visibleWidth(COMMAND_OUTPUT_MARK);
    let hidden = 0;
    for (const inner of this.inners) {
      hidden += collapsedHiddenRows(inner, Math.max(1, width - prefixWidth));
    }
    return hidden;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    const prefixWidth = visibleWidth(COMMAND_OUTPUT_MARK);
    const lines = this.inners.flatMap((inner) =>
      inner.render(Math.max(1, safeWidth - prefixWidth)),
    );
    return prefixCommandOutputRows(lines).map((line) => truncateToWidth(line, safeWidth, '…'));
  }
}

export interface ShellExecutionOptions {
  readonly command?: string;
  readonly result?: ToolResultBlockData;
  readonly expanded?: boolean;
  readonly showCommand?: boolean;
  /**
   * Max command lines to render. `undefined` means no cap — used by the
   * ctrl+o expanded view so the user can see the full multi-line command
   * even when the header preview was truncated.
   */
  readonly commandPreviewLines?: number;
  readonly resultPreviewLines?: number;
  readonly tailOutput?: boolean;
  readonly expandHint?: boolean;
}

export class ShellExecutionComponent extends Container implements CollapsedRowProbe {
  constructor(options: ShellExecutionOptions) {
    super();

    if (options.showCommand === true) {
      this.addCommandPreview(options.command ?? '', options.commandPreviewLines);
    }

    if (options.result !== undefined) {
      this.addResultPreview(
        options.result,
        options.expanded ?? false,
        options.resultPreviewLines ?? PREVIEW_LINES,
        options.tailOutput ?? false,
        options.expandHint ?? true,
      );
    }
  }

  collapsedHiddenRows(width: number): number {
    let hidden = 0;
    for (const child of this.children) {
      hidden += collapsedHiddenRows(child, Math.max(1, width));
    }
    return hidden;
  }

  private addCommandPreview(command: string, previewLines: number | undefined): void {
    if (command.length === 0) return;
    const allLines = command.split('\n');
    const lines = previewLines === undefined ? allLines : allLines.slice(0, previewLines);
    for (const [i, line] of lines.entries()) {
      // Distinguish the command (input) from the result (output) by hue only:
      // the `$` prompt uses the dedicated shell-mode hue while the command
      // body renders in the shared `textDim` detail tone. Continuation rows
      // align under the command text. Rows render flush left — the
      // command-body indent wrapper owns the indentation.
      const text =
        i === 0
          ? currentTheme.fg('shellMode', COMMAND_PROMPT) + currentTheme.fg('textDim', line)
          : `  ${currentTheme.fg('textDim', line)}`;
      this.addChild(new Text(text, 0, 0));
    }
  }

  private addResultPreview(
    result: ToolResultBlockData,
    expanded: boolean,
    previewLines: number,
    tailOutput: boolean,
    expandHint: boolean,
  ): void {
    if (!result.output) return;
    this.addChild(
      new CommandOutputComponent([
        new TruncatedOutputComponent(result.output, {
          expanded,
          isError: result.is_error ?? false,
          maxLines: previewLines,
          tail: tailOutput,
          expandHint,
        }),
      ]),
    );
  }
}

export const shellExecutionResultRenderer: ResultRenderer = (
  _toolCall: ToolCallBlockData,
  result: ToolResultBlockData,
  ctx,
): Component[] => [
  // Result only. The command preview is owned by ToolCallComponent's
  // buildCallPreview across the whole lifecycle (streaming, running, and
  // done); rendering it here too would duplicate the command once the result
  // lands.
  new ShellExecutionComponent({
    result,
    expanded: ctx.expanded,
  }),
];
