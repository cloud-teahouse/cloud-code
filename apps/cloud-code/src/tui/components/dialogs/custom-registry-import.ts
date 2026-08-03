/**
 * CustomRegistryImportDialog — blue rounded box that collects a custom
 * registry URL and a Bearer token before importing the registry's
 * provider entries.
 *
 * Geometry mirrors `ApiKeyInputDialogComponent` so the chrome stays
 * consistent with the API-key login flow. Two fields, switched with
 * Tab / Shift-Tab / Up / Down; Enter advances to the next field (and submits
 * on the last field), Esc cancels. Both fields are required.
 */

import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  hitZoneAt,
  type Focusable,
  type HitZone,
  type HitZoneId,
  type MouseEvent,
} from '@cloud-code/pi-tui';

import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { wrapHintText } from '#/tui/utils/hint';

export interface CustomRegistryImportValue {
  readonly url: string;
  readonly apiKey: string;
}

export type CustomRegistryImportResult =
  | { readonly kind: 'ok'; readonly value: CustomRegistryImportValue }
  | { readonly kind: 'cancel' };

type FieldId = 'url' | 'token';

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
  // while masking every other non-space character (spaces stay visible).
  const parts = content.split(/(\u001B(?:\[[0-9;]*m|_pi:c\u0007))/);
  const maskedContent = parts
    .map((part, index) => {
      if (index % 2 === 1) return part; // ANSI sequence
      return part.replaceAll(/[^ ]/g, '•');
    })
    .join('');

  return prefix + maskedContent + padding;
}

export class CustomRegistryImportDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly urlInput = new Input();
  private readonly tokenInput = new Input();
  private readonly onDone: (result: CustomRegistryImportResult) => void;
  private activeField: FieldId = 'url';
  private done = false;
  private hint: 'none' | 'url-empty' | 'token-empty' = 'none';
  /** Hit zones of the last render (one per field input row) — served from
   * hitZones(). */
  private frameZones: HitZone[] = [];
  /** Width of the last render; direct handleMouse calls re-derive the zones
   * from the current state at this width (the TUI's zone dispatch uses the
   * render cache — a render always runs before dispatched input). */
  private lastRenderWidth = 80;

  constructor(
    onDone: (result: CustomRegistryImportResult) => void,
    defaultUrl: string = '',
  ) {
    super();
    this.onDone = onDone;
    if (defaultUrl.length > 0) this.urlInput.setValue(defaultUrl);
    // Enter on the URL field advances to the token field; Enter on the token
    // (last) field submits.
    this.urlInput.onSubmit = () => {
      this.focusField('token');
    };
    this.tokenInput.onSubmit = () => {
      this.handleSubmit();
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

    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift('tab'))) {
      this.toggleField();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.focusField('token');
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.focusField('url');
      return;
    }

    if (this.hint !== 'none') {
      this.hint = 'none';
    }

    if (this.activeField === 'url') {
      this.urlInput.handleInput(data);
    } else {
      this.tokenInput.handleInput(data);
    }
  }

  /** Mouse: a left-press on a field's input row focuses that field (the mouse
   * counterpart of Tab / ↑ / ↓). Everything else is ignored — the dialog has
   * no scrollable content and the fields show no hover affordance. */
  handleMouse(event: MouseEvent): void | boolean {
    if (event.type !== 'press' || event.button !== 0) return false;
    // Re-derived from the current state: direct callers (unit tests) may fire
    // keys without an intervening render, so the render cache can be stale.
    const zone = hitZoneAt(this.currentZones(), event.row, event.col, 'action');
    if (zone === null) return false;
    return this.onHitZone(zone.id, event);
  }

  /** The declared zones of the last render. */
  hitZones(): Iterable<HitZone> {
    return this.frameZones;
  }

  /** Zones derived from the current state at the last render width (a
   * discarded render refreshes the cache). The handleMouse fallback consults
   * these so it never acts on a stale layout. */
  private currentZones(): HitZone[] {
    this.render(this.lastRenderWidth);
    return this.frameZones;
  }

  /** Zone press: focus the pressed field's input row. */
  onHitZone(id: HitZoneId, _event: MouseEvent): void | boolean {
    if (this.done) return false;
    if (id !== 'url' && id !== 'token') return false;
    const field: FieldId = id === 'token' ? 'token' : 'url';
    this.focusField(field);
    this.invalidate();
  }

  override invalidate(): void {
    super.invalidate();
    this.urlInput.invalidate();
    this.tokenInput.invalidate();
  }

  override render(width: number): string[] {
    this.lastRenderWidth = width;
    const dialogActive = this.focused && !this.done;
    this.urlInput.focused = dialogActive && this.activeField === 'url';
    this.tokenInput.focused = dialogActive && this.activeField === 'token';

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';

    const border = (s: string): string => currentTheme.fg('border', s);
    const titleStyled = currentTheme.boldFg('textStrong', t('selectors.registryImport.title'));
    const subtitleText =
      this.hint === 'url-empty'
        ? t('selectors.registryImport.urlEmpty')
        : this.hint === 'token-empty'
          ? t('selectors.registryImport.tokenEmpty')
          : t('selectors.registryImport.subtitle');
    const subtitleStyled = currentTheme.fg('textDim', subtitleText);
    const footerText =
      this.activeField === 'url'
        ? t('selectors.registryImport.footerNext')
        : t('selectors.registryImport.footerSubmit');

    const urlLabelText = t('selectors.registryImport.urlLabel');
    const tokenLabelText = t('selectors.registryImport.tokenLabel');
    const urlLabelStyled =
      this.activeField === 'url'
        ? currentTheme.boldFg('accent', urlLabelText)
        : currentTheme.fg('textDim', urlLabelText);
    const tokenLabelStyled =
      this.activeField === 'token'
        ? currentTheme.boldFg('accent', tokenLabelText)
        : currentTheme.fg('textDim', tokenLabelText);

    const titleLine = truncateToWidth(titleStyled, innerWidth, '…');
    const subtitleLine = truncateToWidth(subtitleStyled, innerWidth, '…');
    // The footer wraps at segment boundaries inside the box rather than
    // clipping the Esc segment at narrow widths.
    const footerLines = wrapHintText(footerText, innerWidth, '  ·  ').map((line) =>
      currentTheme.fg('textDim', line),
    );
    const urlLabelLine = truncateToWidth(urlLabelStyled, innerWidth, '…');
    const tokenLabelLine = truncateToWidth(tokenLabelStyled, innerWidth, '…');
    const urlInputLine = this.urlInput.render(innerWidth)[0] ?? '❯ ';
    const rawTokenInputLine = this.tokenInput.render(innerWidth)[0] ?? '❯ ';
    const tokenInputLine = maskInputLine(rawTokenInputLine);

    const contentLines: { readonly text: string; readonly field?: FieldId }[] = [
      { text: titleLine },
      { text: '' },
      { text: subtitleLine },
      { text: '' },
      { text: urlLabelLine },
      { text: urlInputLine, field: 'url' },
      { text: '' },
      { text: tokenLabelLine },
      { text: tokenInputLine, field: 'token' },
      { text: '' },
      ...footerLines.map((line) => ({ text: line })),
    ];

    // Click target for each field's input row (action-only — the fields show
    // no hover affordance), recorded while composing so the zones never
    // re-derive the layout.
    const zones: HitZone[] = [];
    const fieldZone = (field: FieldId | undefined, row: number): void => {
      if (field === undefined) return;
      zones.push({
        id: field,
        row,
        col: 1,
        width: Math.max(1, safeWidth),
        height: 1,
        semantics: { hover: false },
      });
    };

    if (safeWidth < 4) {
      const lines = [''];
      for (const content of contentLines) {
        fieldZone(content.field, lines.length);
        lines.push(truncateToWidth(content.text, safeWidth, '…'));
      }
      this.frameZones = zones;
      return lines;
    }

    const lines: string[] = [
      '',
      border('╭' + '─'.repeat(safeWidth - 2) + '╮'),
      border('│') + ' '.repeat(safeWidth - 2) + border('│'),
    ];

    for (const content of contentLines) {
      fieldZone(content.field, lines.length);
      const vis = visibleWidth(content.text);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(border('│') + pad + content.text + ' '.repeat(rightPad) + border('│'));
    }

    lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));
    lines.push(border('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');

    this.frameZones = zones;
    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }

  private toggleField(): void {
    this.focusField(this.activeField === 'url' ? 'token' : 'url');
  }

  private focusField(field: FieldId): void {
    this.hint = 'none';
    this.activeField = field;
  }

  private handleSubmit(): void {
    if (this.done) return;

    const urlValue = this.urlInput.getValue().trim();
    const tokenValue = this.tokenInput.getValue().trim();

    if (urlValue.length === 0) {
      this.hint = 'url-empty';
      this.activeField = 'url';
      return;
    }
    if (tokenValue.length === 0) {
      this.hint = 'token-empty';
      this.activeField = 'token';
      return;
    }

    this.done = true;
    this.onDone({ kind: 'ok', value: { url: urlValue, apiKey: tokenValue } });
  }

  private cancel(): void {
    if (this.done) return;
    this.done = true;
    this.onDone({ kind: 'cancel' });
  }
}
