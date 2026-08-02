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

export type ApiKeyInputResult =
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'cancel' };

function maskInputLine(raw: string): string {
  const prefix = '❯ ';
  if (!raw.startsWith(prefix)) return raw;

  // Strip trailing padding spaces so they stay as spaces.
  let end = raw.length;
  while (end > prefix.length && raw[end - 1] === ' ') {
    end--;
  }
  const padding = raw.slice(end);
  const content = raw.slice(prefix.length, end);

  // Protect ANSI escape sequences (reverse-video cursor, IME marker, etc.)
  // while masking every other visible character.
  const parts = content.split(/(\u001B(?:\[[0-9;]*m|_pi:c\u0007))/);
  const maskedContent = parts
    .map((part, index) => {
      if (index % 2 === 1) return part; // ANSI sequence
      return part.replaceAll(/./g, '•');
    })
    .join('');

  return prefix + maskedContent + padding;
}

export interface ApiKeyInputDialogOptions {
  readonly title?: string;
  readonly mask?: boolean;
  readonly emptyHint?: string;
  /** When true, submitting an empty value resolves with `''` instead of
   * showing the empty hint — used for optional fields (e.g. a display name
   * that falls back to a default). */
  readonly allowEmpty?: boolean;
  /** Prefills the input (e.g. a derived suggestion the user can edit). */
  readonly initialValue?: string;
  /** Inline validation: returns the error message to display, or `undefined`
   * when the value is accepted. The input stays open on rejection. */
  readonly validate?: (value: string) => string | undefined;
}

export class ApiKeyInputDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly input = new Input();
  private readonly onDone: (result: ApiKeyInputResult) => void;
  private readonly title: string;
  private readonly subtitleLines: readonly string[];
  private readonly mask: boolean;
  private readonly emptyHint: string;
  private readonly allowEmpty: boolean;
  private readonly validate: ((value: string) => string | undefined) | undefined;
  private done = false;
  /** Transient inline error (empty submit or `validate` rejection); replaces
   * the subtitle until the next keystroke. */
  private hintMessage: string | undefined;

  constructor(
    platformName: string,
    subtitleLines: readonly string[],
    onDone: (result: ApiKeyInputResult) => void,
    options?: ApiKeyInputDialogOptions,
  ) {
    super();
    this.onDone = onDone;
    this.title = options?.title ?? t('selectors.apiKey.title', { platform: platformName });
    this.subtitleLines = subtitleLines;
    this.mask = options?.mask ?? true;
    this.emptyHint = options?.emptyHint ?? t('selectors.apiKey.empty');
    this.allowEmpty = options?.allowEmpty ?? false;
    this.validate = options?.validate;
    if (options?.initialValue !== undefined) {
      this.input.setValue(options.initialValue);
      // setValue leaves the cursor at position 0; a prefill expects typing to
      // append, so move it to the end (Ctrl+E = cursorLineEnd).
      this.input.handleInput('\x05');
    }
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
    if (this.hintMessage !== undefined) {
      this.hintMessage = undefined;
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
    const titleStyled = currentTheme.boldFg('textStrong', this.title);
    const subtitleSource = this.hintMessage !== undefined ? [this.hintMessage] : this.subtitleLines;
    const subtitleLines = subtitleSource.map((line) =>
      truncateToWidth(currentTheme.fg('textDim', line), innerWidth, '…'),
    );
    const footerLines = wrapHintText(t('selectors.inputDialog.footer'), innerWidth, '  ·  ').map(
      (line) => currentTheme.fg('textDim', line),
    );

    const titleLine = truncateToWidth(titleStyled, innerWidth, '…');
    const rawInputLine = this.input.render(innerWidth)[0] ?? '❯ ';
    const inputLine =
      this.mask && this.input.getValue() !== '' ? maskInputLine(rawInputLine) : rawInputLine;

    const contentLines: string[] = [
      titleLine,
      '',
      ...subtitleLines,
      '',
      inputLine,
      '',
      // The footer wraps at segment boundaries inside the box rather than
      // clipping the Esc segment at narrow widths.
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
      if (this.allowEmpty) {
        this.done = true;
        this.onDone({ kind: 'ok', value: '' });
        return;
      }
      this.hintMessage = this.emptyHint;
      return;
    }
    const problem = this.validate?.(trimmed);
    if (problem !== undefined) {
      this.hintMessage = problem;
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
