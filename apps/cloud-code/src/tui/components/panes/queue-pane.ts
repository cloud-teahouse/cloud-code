import { Container, truncateToWidth, visibleWidth } from '@cloud-code/pi-tui';

import { SELECT_POINTER } from '../../constant/symbols';
import type { QueuedMessage } from '../../types';
import { t, type MessageKey } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { wrapHintText } from '#/tui/utils/hint';

export interface QueuePaneOptions {
  readonly messages: readonly QueuedMessage[];
  readonly isCompacting: boolean;
  readonly isStreaming: boolean;
  readonly canSteerImmediately: boolean;
}

const ELLIPSIS = '…';

export class QueuePaneComponent extends Container {
  private readonly messages: readonly QueuedMessage[];
  /** i18n key of the hint line, resolved per render so locale switches repaint. */
  private readonly hintKey: MessageKey | undefined;

  constructor(options: QueuePaneOptions) {
    super();
    this.messages = options.messages;

    if (options.messages.length > 0) {
      // Bash commands (`! …`) are not steerable, so only advertise Ctrl-S when
      // there is at least one plain-text item that steering would actually send.
      const hasSteerable = options.messages.some((m) => m.mode !== 'bash');
      const canSteer = options.canSteerImmediately && hasSteerable;
      this.hintKey =
        options.isCompacting && !options.isStreaming
          ? 'panels.queue.hint.compacting'
          : canSteer
            ? 'panels.queue.hint.steer'
            : 'panels.queue.hint.afterTask';
    }
  }

  override render(width: number): string[] {
    const accent = (text: string) => currentTheme.fg('accent', text);
    const shell = (text: string) => currentTheme.fg('shellMode', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const lines: string[] = [currentTheme.fg('border', '─'.repeat(width))];

    for (const item of this.messages) {
      const singleLine = item.text.replaceAll(/\s+/g, ' ').trim();
      const prefix = `  ${SELECT_POINTER} `;
      if (item.mode === 'bash') {
        // Shell commands get a `$ ` prompt and the shell-mode hue so they read
        // as commands, not as plain text that would be sent to the model.
        const prompt = '$ ';
        const availableWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(prompt));
        const truncated = truncateToWidth(singleLine, availableWidth, ELLIPSIS);
        lines.push(accent(prefix) + shell(prompt + truncated));
      } else {
        const availableWidth = Math.max(1, width - visibleWidth(prefix));
        const truncated = truncateToWidth(singleLine, availableWidth, ELLIPSIS);
        lines.push(accent(prefix + truncated));
      }
    }

    if (this.hintKey !== undefined) {
      // Wrap at segment boundaries: the steer hint's "ctrl-s" tail is the
      // part a narrow layout must not clip.
      for (const hintLine of wrapHintText(t(this.hintKey), width - 2)) {
        lines.push(dim(`  ${hintLine}`));
      }
    }

    return lines;
  }
}
