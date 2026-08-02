/**
 * FeedbackInputDialog — rounded box (border token) that collects a single line of
 * user feedback before submitting it to the managed Cloud Code platform.
 *
 * Geometry mirrors `DeviceCodeBox` so the chrome stays consistent with
 * the OAuth login flow. The box embeds a `pi-tui` Input for the actual
 * text entry; cursor visibility tracks the dialog's `focused` flag.
 *
 * This is stage 1 of the feedback flow: it collects the free-form text
 * only. Whether to attach diagnostic logs / codebase is decided in a
 * follow-up stage (see `promptFeedbackAttachment`).
 */

import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@cloud-code/pi-tui';
import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { wrapHintText } from '#/tui/utils/hint';

export type FeedbackInputDialogResult =
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'cancel' };

export class FeedbackInputDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly input = new Input();
  private readonly onDone: (result: FeedbackInputDialogResult) => void;
  private done = false;
  private emptyHinted = false;

  constructor(onDone: (result: FeedbackInputDialogResult) => void) {
    super();
    this.onDone = onDone;
    this.input.onSubmit = (value) => {
      this.submit(value);
    };
  }

  handleInput(data: string): void {
    if (this.done) return;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('c')) ||
      matchesKey(data, Key.ctrl('d'))
    ) {
      this.cancel();
      return;
    }
    if (this.emptyHinted) {
      this.emptyHinted = false;
    }
    this.input.handleInput(data);
  }

  override invalidate(): void {
    super.invalidate();
    this.input.invalidate();
  }

  override render(width: number): string[] {
    this.input.focused = this.focused && !this.done;

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';

    const border = (s: string): string => currentTheme.fg('border', s);
    const titleStyled = currentTheme.boldFg('textStrong', t('selectors.feedback.title'));
    const subtitleText = this.emptyHinted
      ? t('selectors.feedback.empty')
      : t('selectors.feedback.subtitle');
    const subtitleStyled = currentTheme.fg('textDim', subtitleText);
    const titleLine = truncateToWidth(titleStyled, innerWidth, '…');
    const subtitleLine = truncateToWidth(subtitleStyled, innerWidth, '…');
    // The footer wraps at segment boundaries inside the box rather than
    // clipping the Esc segment at narrow widths.
    const footerLines = wrapHintText(t('selectors.inputDialog.footer'), innerWidth, '  ·  ').map(
      (line) => currentTheme.fg('textDim', line),
    );
    const inputLine = this.input.render(innerWidth)[0] ?? '❯ ';

    const contentLines: string[] = [
      titleLine,
      '',
      subtitleLine,
      '',
      inputLine,
      '',
      ...footerLines,
    ];

    if (safeWidth < 4) {
      return ['', ...contentLines.map((line) => truncateToWidth(line, safeWidth, '…'))];
    }

    const lines: string[] = [
      '',
      border('╭' + '─'.repeat(safeWidth - 2) + '╮'),
      border('│') + ' '.repeat(safeWidth - 2) + border('│'),
    ];

    for (const content of contentLines) {
      const vis = visibleWidth(content);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(border('│') + pad + content + ' '.repeat(rightPad) + border('│'));
    }

    lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));
    lines.push(border('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');

    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }

  private submit(value: string): void {
    if (this.done) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      this.emptyHinted = true;
      return;
    }
    this.done = true;
    this.onDone({ kind: 'ok', value: trimmed });
  }

  private cancel(): void {
    if (this.done) return;
    this.done = true;
    this.onDone({ kind: 'cancel' });
  }
}
