/**
 * Turn completion line.
 *
 * Mounted straight into the transcript flow when a turn (or a long task node
 * such as compaction) completes: one blank line, then a dim
 * `✻ Cogitated for 10s`-style flavor line. The line starts flush left so its
 * leading symbol sits on the dialog cards' ● bullet column and the text falls
 * on the dialog text column right after it. It carries no functional status —
 * cancel hints, retry countdowns, and compaction progress stay in their own
 * surfaces — so the line is a plain transcript component, not a slot element,
 * and is never part of the persisted transcript entries (export/replay skip
 * it, like the other flavor-only markers).
 */

import { Container, Spacer, Text } from '@cloud-code/pi-tui';

import { currentTheme } from '#/tui/theme';

export class TurnCompletionComponent extends Container {
  private readonly textComponent: Text;
  private readonly content: string;

  constructor(content: string) {
    super();
    this.content = content;
    this.addChild(new Spacer(1));
    this.textComponent = new Text(this.renderText(), 0, 0);
    this.addChild(this.textComponent);
  }

  override invalidate(): void {
    this.textComponent.setText(this.renderText());
    super.invalidate();
  }

  // No leading indent: the content already opens with its symbol followed by
  // one space, so flush-left rendering lands the symbol on the bullet column
  // and the text on the message text column.
  private renderText(): string {
    return currentTheme.fg('textDim', this.content);
  }
}
